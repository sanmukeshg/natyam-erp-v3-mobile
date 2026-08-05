/**
 * Natyam ERP v3 — Mobile — Fee collection
 *
 * NO APPROVED v3 DESIGN EXISTS FOR THIS SCREEN — Fees was never part of the
 * Claude Design project at all (see docs/design/README.md). Built from the v3
 * mobile system already proven across five screens.
 *
 * Same model as desktop, and for the same reason: **student-centric, not
 * invoice-centric.** Money is collected from a person standing at a desk. On a
 * phone that is even more literal — reception is holding the device while the
 * parent is in front of them — so the whole screen is built around "find this
 * person, see what they owe, take it".
 *
 * Differences from the desktop page, all because a phone is not a desk:
 *   - Search is always visible, not behind a filter toggle. Finding one parent
 *     fast is the entire job.
 *   - The month summary is a horizontally scrolled strip, not a three-up grid.
 *   - The ledger is a near-full-screen sheet, and the collect form **replaces**
 *     the sheet's body rather than expanding inside it — a phone has no room
 *     to show both a ledger and a form, and splitting attention over a payment
 *     is how the wrong invoice gets settled.
 *   - Tap-to-call the guardian, straight from the ledger.
 *
 * The form mirrors the service's validation where it is cheap (max = balance,
 * mode list, conditional reference, no future date) but **never replaces it**:
 * `recordPayment()` re-validates everything and is the authority.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce, formData } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort } from '../../utils/money.js';
import { formatDate, formatDateLong, localDate, startOfMonth } from '../../utils/date.js';
import { PAYMENT_MODES } from '../../config/app.config.js';
import { listStudents } from '../../services/students.service.js';
import { collectionSummary, studentFeeSummary, recordPayment, waiveInvoice } from '../../services/fees.service.js';
import { formModal } from '../../ui/form.js';

const FILTERS = [
    { key: null, label: 'Everyone' },
    { key: 'due', label: 'Has dues' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'clear', label: 'Paid up' }
];

export default class MobileFeesPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Fees';
        this.rows = [];
        this.summary = null;
        const incoming = this.query.filter || null;
        this.filter = incoming === 'outstanding' ? 'due' : incoming;
        this.search = '';
        this.detail = null;           // { student, fees }
        this.payingInvoice = null;    // the invoice the form is collecting against
        this.busy = false;
        // Arriving from a student profile’s "Collect fee" (UAT BUG-602): that
        // student’s ledger opens straight away, so the hand-off lands on the
        // invoice list rather than on a search box that has to be retyped.
        this.openStudentId = this.query.student || null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading…</div>`);
        this.bind();
        await this.load();

        [EVENTS.PAYMENT_RECORDED, EVENTS.PAYMENT_REFUNDED, EVENTS.INVOICE_CREATED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    /**
     * ENH-309 — writing off an invoice, from a phone.
     *
     * Identical in behaviour to the desktop screen's own waiver, and calling
     * the same waiveInvoice(): the reason is mandatory in the service rather
     * than only in this form, so a waiver taken on a phone carries the same
     * record as one taken at a desk.
     *
     * The whole outstanding balance goes — no partial waiver, by decision.
     */
    async waive(invoiceId) {
        const invoice = (this.detail?.fees?.invoices || []).find((i) => i.id === invoiceId);
        if (!invoice) return;

        const done = await formModal({
            title: `Waive ${invoice.number}?`,
            description: `${formatMoney(invoice.balance)} is outstanding. Waiving writes that balance `
                + 'off — the invoice stays on record with the reason attached.',
            submitLabel: 'Waive invoice',
            fields: [
                { name: 'reason', label: 'Reason', type: 'textarea', rows: 3, required: true,
                  help: 'Scholarship, hardship, goodwill — someone will ask later.' }
            ],
            values: { reason: '' },
            onSubmit: (v) => waiveInvoice(invoice.id, { reason: v.reason })
        });

        if (!done) return;
        toast.success('Invoice waived', invoice.number);
        await this.load();
    }

    async load() {
        try {
            const branchId = session.branch();
            const [rows, summary] = await Promise.all([
                listStudents(branchId, { status: 'all' }),
                collectionSummary({ from: startOfMonth(), to: localDate(), branchId })
            ]);
            if (this.disposed) return;
            this.rows = rows;
            this.summary = summary;
            this.paint();

            if (this.openStudentId) {
                const wanted = this.openStudentId;
                this.openStudentId = null;
                await this.open(wanted);
            }
        } catch (err) {
            if (this.disposed) return;
            console.error('Fees failed to load', err);
            render(this.container, html`<div class="m-error">Fees could not be loaded — ${err.message}</div>`);
        }
    }

    visibleRows() {
        const term = this.search.trim().toLowerCase();
        let rows = this.rows;

        if (this.filter === 'due') rows = rows.filter((r) => r.outstanding > 0);
        else if (this.filter === 'overdue') rows = rows.filter((r) => r.overdue > 0);
        else if (this.filter === 'clear') rows = rows.filter((r) => !r.outstanding);

        if (term) {
            rows = rows.filter((r) =>
                [r.name, r.admissionNo, r.guardianName, r.guardianPhone]
                    .some((v) => String(v || '').toLowerCase().includes(term)));
        }
        // Whoever owes most, and longest, first — this is a worklist.
        return [...rows].sort((a, b) => (b.overdue - a.overdue) || (b.outstanding - a.outstanding));
    }

    paint() {
        const rows = this.visibleRows();
        const s = this.summary;

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">Search students</span>
                        <input type="search" data-role="search" placeholder="Search name, guardian, phone…">
                    </label>
                </div>
                <p class="m-subhead-note">
                    ${s ? `${formatMoney(s.collected)} collected this month · ${rows.length} shown` : ''}
                </p>
                <div class="m-chip-scroll">
                    ${FILTERS.map((item) => html`
                        <button class="m-pill" data-action="filter" data-key="${item.key || ''}"
                                aria-pressed="${this.filter === item.key ? 'true' : 'false'}">${item.label}</button>
                    `)}
                </div>
            </div>

            ${s ? html`
                <div class="m-kpi-strip" style="margin-top:12px;">
                    ${stat('Collected', formatMoneyShort(s.collected), 'positive', `${s.receiptCount} receipt${s.receiptCount === 1 ? '' : 's'}`)}
                    ${stat('Outstanding', formatMoneyShort(s.outstanding), s.outstanding ? 'caution' : 'positive', `${s.outstandingCount} invoice${s.outstandingCount === 1 ? '' : 's'}`)}
                    ${stat('Overdue', formatMoneyShort(s.overdue), s.overdueCount ? 'negative' : 'positive', `${s.overdueCount} invoice${s.overdueCount === 1 ? '' : 's'}`)}
                </div>
            ` : ''}

            <div class="m-stack">
                ${rows.length ? rows.map((row) => html`
                    <button class="m-card m-student" data-action="open" data-id="${row.id}">
                        <span class="m-student-main">
                            <span class="m-student-name">${row.name}</span>
                            <span class="m-student-meta">${row.batchName || 'Not in a batch'}</span>
                        </span>
                        ${row.outstanding > 0 ? html`
                            <span class="m-badge" data-fee="${row.overdue > 0 ? 'overdue' : 'due'}">
                                ${formatMoneyShort(row.overdue > 0 ? row.overdue : row.outstanding)}
                            </span>
                        ` : html`<span class="m-badge" data-fee="clear">Paid</span>`}
                    </button>
                `) : html`<div class="m-card m-empty">Nobody matches that.</div>`}
            </div>
        `);
    }

    /* --------------------------------------------------------------- LEDGER */

    async open(studentId) {
        try {
            const student = this.rows.find((r) => r.id === studentId);
            const fees = await studentFeeSummary(studentId);
            if (this.disposed) return;
            this.detail = { student, fees };
            this.payingInvoice = null;
            this.paintSheet();
        } catch (err) {
            toast.error(`Could not open that ledger — ${err.message}`);
        }
    }

    close() {
        this.detail = null;
        this.payingInvoice = null;
        const host = this.container.querySelector('[data-role="sheet"]');
        if (host) render(host, '');
    }

    sheetHost() {
        let host = this.container.querySelector('[data-role="sheet"]');
        if (!host) {
            host = document.createElement('div');
            host.setAttribute('data-role', 'sheet');
            this.container.append(host);
        }
        return host;
    }

    paintSheet() {
        const host = this.sheetHost();
        if (!this.detail) { render(host, ''); return; }
        // The collect form takes over the sheet rather than sharing it.
        if (this.payingInvoice) { this.paintPayForm(host); return; }

        const { student, fees } = this.detail;
        const canCollect = session.can('fee.collect');
        const open = (fees.invoices || [])
            .filter((i) => i.status !== 'cancelled' && i.balance > 0)
            .sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));

        render(host, html`
            <div class="m-sheet-scrim" data-action="close-detail"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${student?.name || 'Fees'}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${student?.name || 'Student'}</h2>
                        <p class="m-profile-sub">
                            ${student?.admissionNo || '—'}${student?.batchName ? ` · ${student.batchName}` : ''}
                        </p>
                    </div>
                    <button class="m-icon-btn" data-action="close-detail" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    <div class="m-metrics">
                        ${metric('Billed', formatMoneyShort(fees.billed))}
                        ${metric('Paid', formatMoneyShort(fees.collected))}
                        ${metric('Due', formatMoneyShort(fees.outstanding))}
                    </div>

                    ${fees.overdue > 0 ? html`
                        <div class="m-notice" data-tone="caution">
                            ${formatMoney(fees.overdue)} past due${fees.oldestDue ? `, oldest since ${formatDate(fees.oldestDue)}` : ''}.
                        </div>
                    ` : fees.onTrack ? html`
                        <div class="m-notice" data-tone="info">Paid up — nothing outstanding.</div>
                    ` : ''}

                    ${student?.guardianPhone ? html`
                        <a class="m-btn m-btn-ghost m-btn-block" href="tel:${student.guardianPhone}">
                            ${raw(icon('phone', { size: 16 }))} Call ${student.guardianName || 'guardian'}
                        </a>
                    ` : ''}

                    ${open.length ? html`
                        <p class="m-section-label" style="margin:6px 0 0;color:var(--v3-muted);text-shadow:none;">Open invoices</p>
                        ${open.map((invoice) => {
                            const overdue = invoice.balance > 0 && invoice.dueDate < localDate();
                            return html`
                                <div class="m-invoice" data-overdue="${overdue ? 'true' : 'false'}">
                                    <div class="m-invoice-main">
                                        <div class="m-invoice-no">${invoice.number || 'Invoice'}</div>
                                        <div class="m-invoice-due">Due ${invoice.dueDate ? formatDate(invoice.dueDate) : '—'}</div>
                                    </div>
                                    <div class="m-invoice-right">
                                        <span class="m-badge" data-fee="${overdue ? 'overdue' : 'due'}">${formatMoney(invoice.balance)}</span>
                                        ${canCollect ? html`
                                            <button class="m-btn m-btn-sm" data-action="collect" data-id="${invoice.id}">Collect</button>
                                        ` : ''}
                                        <!--
                                          ENH-309. fee.waive, not fee.collect —
                                          different capabilities, and only
                                          Administrator and Owner hold this one,
                                          so Reception never sees a button the
                                          service would refuse.
                                        -->
                                        ${session.can('fee.waive') && invoice.balance > 0 ? html`
                                            <button class="m-btn m-btn-sm m-btn-ghost"
                                                    data-action="waive" data-id="${invoice.id}">Waive</button>
                                        ` : ''}
                                    </div>
                                </div>
                            `;
                        })}
                    ` : ''}

                    ${fees.receipts?.length ? html`
                        <p class="m-section-label" style="margin:6px 0 0;color:var(--v3-muted);text-shadow:none;">Recent receipts</p>
                        <dl class="m-facts">
                            ${fees.receipts.slice(0, 5).map((r) => html`
                                <div class="m-fact">
                                    <dt>${r.receiptNo || 'Receipt'} · ${formatDate(r.paidOn)}</dt>
                                    <dd>${formatMoney(r.amount)}</dd>
                                </div>
                            `)}
                        </dl>
                    ` : ''}

                    ${!open.length && !fees.receipts?.length
                        ? html`<p class="m-profile-note">No invoices raised for this student yet.</p>` : ''}
                </div>
            </div>
        `);
    }

    /**
     * The collect form (UAT ENH-616).
     *
     * A centred modal, matching every other dialog in the app rather than being
     * the one bottom sheet — and, critically, nothing here is auto-focused. The
     * amount arrives pre-filled with the outstanding balance; the sequence
     * somebody actually follows is *verify the amount, pick the date, pick the
     * method, record* — none of which starts with typing, so the keyboard
     * appears only if they choose to change the figure.
     *
     * It still replaces the ledger rather than sitting beside it: on a 375px
     * screen a form and a list of invoices cannot both be read, and a
     * half-visible ledger is how somebody settles the wrong invoice.
     */
    paintPayForm(host) {
        const invoice = this.payingInvoice;
        const { student } = this.detail;

        render(host, html`
            <div class="m-modal-scrim" data-role="pay-scrim">
                <div class="m-modal" role="dialog" aria-modal="true" aria-label="Collect payment" tabindex="-1">
                <div class="m-modal-head">
                    <div style="min-width:0;">
                        <h2 class="m-modal-title">Collect from ${student?.name || 'student'}</h2>
                        <p class="m-modal-sub">
                            ${invoice.number || 'Invoice'} · ${formatMoney(invoice.balance)} outstanding
                        </p>
                    </div>
                    <button class="m-modal-close" data-action="cancel-pay" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <form class="m-modal-body" data-role="pay-form" data-id="${invoice.id}">
                    <label class="m-field">
                        <span>Amount</span>
                        <input class="m-input m-input-amount" type="number" name="amount" required
                               min="1" max="${invoice.balance}" step="1" value="${invoice.balance}"
                               inputmode="numeric">
                    </label>

                    <div>
                        <span class="m-field-label">How was it paid?</span>
                        <div class="m-modes">
                            ${PAYMENT_MODES.map((m, i) => html`
                                <label class="m-mode">
                                    <input type="radio" name="mode" value="${m.value}" ${i === 0 ? 'checked' : ''}>
                                    <span>${m.label}</span>
                                </label>
                            `)}
                        </div>
                    </div>

                    <label class="m-field" data-role="reference-field">
                        <span>Reference</span>
                        <input class="m-input" type="text" name="reference" placeholder="UPI / txn / cheque no">
                    </label>

                    <label class="m-field">
                        <span>Received on</span>
                        <input class="m-input" type="date" name="paidOn" value="${localDate()}" max="${localDate()}">
                    </label>

                    <p class="m-profile-note">
                        Balance after this: <strong data-role="after">${formatMoney(0)}</strong>
                    </p>
                </form>

                <div class="m-modal-foot">
                    <button class="m-form-cancel" data-action="cancel-pay">Cancel</button>
                    <button class="m-form-save" data-action="submit-pay" ${this.busy ? 'disabled' : ''}>
                        ${this.busy ? 'Recording…' : 'Record payment'}
                    </button>
                </div>
                </div>
            </div>
        `);

        this.syncReferenceField();
        this.syncRemaining();
    }

    /** Reference is only required for modes that reconcile against a bank statement. */
    syncReferenceField() {
        const form = this.container.querySelector('[data-role="pay-form"]');
        if (!form) return;
        const chosen = form.querySelector('[name="mode"]:checked')?.value;
        const mode = PAYMENT_MODES.find((m) => m.value === chosen);
        const field = form.querySelector('[data-role="reference-field"]');
        field.hidden = !mode?.needsReference;
        field.querySelector('input').required = Boolean(mode?.needsReference);
    }

    syncRemaining() {
        const form = this.container.querySelector('[data-role="pay-form"]');
        if (!form || !this.payingInvoice) return;
        const entered = Number(form.querySelector('[name="amount"]').value) || 0;
        render(form.querySelector('[data-role="after"]'),
            formatMoney(Math.max(0, this.payingInvoice.balance - entered)));
    }

    async submitPayment() {
        const form = this.container.querySelector('[data-role="pay-form"]');
        if (!form || this.busy) return;
        if (!form.reportValidity()) return;

        const { amount, mode, reference, paidOn } = formData(form);
        this.busy = true;
        this.paintSheet();

        try {
            await recordPayment({
                invoiceId: this.payingInvoice.id,
                amount: Number(amount),
                mode,
                reference: reference || null,
                paidOn: paidOn || null
            });
            toast.success('Payment recorded', `${formatMoney(Number(amount))} received.`);
            const studentId = this.detail?.student?.id;
            this.busy = false;
            this.payingInvoice = null;
            await this.load();
            if (studentId && !this.disposed) await this.open(studentId);
        } catch (err) {
            this.busy = false;
            if (this.disposed) return;
            toast.error(err.message);
            this.paintSheet();
        }
    }

    /* --------------------------------------------------------------- EVENTS */

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="filter"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.filter = this.filter === key ? null : key;
            this.paint();
        }));

        this.onDispose(on(root, 'input', '[data-role="search"]', debounce((_e, t) => {
            this.search = t.value;
            this.paint();
        }, 180)));

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.open(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', () => this.close()));
        this.onDispose(on(root, 'click', '.m-profile', (event) => event.stopPropagation()));

        this.onDispose(on(root, 'click', '[data-action="waive"]', (_e, t) => this.waive(t.dataset.id)));

        this.onDispose(on(root, 'click', '[data-action="collect"]', (_e, t) => {
            this.payingInvoice = this.detail?.fees.invoices.find((i) => i.id === t.dataset.id) || null;
            this.paintSheet();
            // The dialog takes focus, not the amount — see paintPayForm().
            this.container.querySelector('.m-modal')?.focus();
        }));

        this.onDispose(on(root, 'click', '[data-action="cancel-pay"]', () => {
            this.payingInvoice = null;
            this.paintSheet();
        }));

        /*
         * UAT BUG-203 — only a DIRECT hit on the backdrop dismisses.
         *
         * The backdrop is the dialog's parent, so a delegated closest() match
         * treated every click inside the form as a click on the backdrop:
         * tapping the amount field closed the popup and dropped you back on the
         * student list. `on()` binds one listener per selector on the same root
         * element, so a stopPropagation() in a sibling handler could never have
         * prevented it either — it does not stop listeners on the same node.
         *
         * This is the rule js/ui/form.js already applies to its own scrim; the
         * hand-rolled dialog here was the one that did not.
         */
        this.onDispose(on(root, 'click', '[data-role="pay-scrim"]', (event, target) => {
            if (event.target !== target || this.busy) return;
            this.payingInvoice = null;
            this.paintSheet();
        }));

        this.onDispose(on(root, 'change', '[name="mode"]', () => this.syncReferenceField()));
        this.onDispose(on(root, 'input', '[name="amount"]', () => this.syncRemaining()));
        this.onDispose(on(root, 'click', '[data-action="submit-pay"]', () => this.submitPayment()));
        this.onDispose(on(root, 'submit', '[data-role="pay-form"]', (event) => {
            event.preventDefault();
            this.submitPayment();
        }));

        this.onKey = (event) => {
            if (event.key !== 'Escape') return;
            if (this.payingInvoice) { this.payingInvoice = null; this.paintSheet(); }
            else if (this.detail) this.close();
        };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function stat(label, value, tone, note) {
    return html`
        <div class="m-card m-kpi" data-tone="${tone}">
            <span class="m-kpi-bar"></span>
            <span class="m-kpi-body">
                <span class="m-kpi-label">${label}</span>
                <span class="m-kpi-value" style="display:block;">${value}</span>
                ${note ? html`<span class="m-kpi-delta" data-tone="${tone}" style="display:block;">${note}</span>` : ''}
            </span>
        </div>
    `;
}

function metric(label, value, tone = null) {
    return html`<div class="m-metric"${tone ? raw(` data-tone="${tone}"`) : ''}>
        <span class="m-metric-value">${value}</span>
        <span class="m-metric-label">${label}</span>
    </div>`;
}
