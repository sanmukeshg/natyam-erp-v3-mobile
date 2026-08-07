/**
 * Natyam ERP v3 — Mobile — Finance
 *
 * A DIGITAL CASHBOOK, not an accounting application — UAT5 ENH-504/ENH-508.
 *
 * The shape is what an owner standing in the studio actually needs, in the
 * order she needs it:
 *
 *   1. Where the month stands — Net, then Money In, Money Out, Margin.
 *   2. Where the money went, by category — Payroll included, at last.
 *   3. Every transaction, newest first, editable where it may be edited.
 *   4. One tap to add money in or money out.
 *
 * WHAT LEFT THIS SCREEN, and where it went:
 *
 *   - The six-month trend. Three numbers repeated six times is a report, not a
 *     dashboard, and it pushed the transaction list — the thing this screen is
 *     for — below the fold. It is on Analytics now, filterable over 30 days to
 *     12 months and any custom range, which is more than it could ever say
 *     here. The link below is the whole of what remains.
 *   - The apology. "Recorded expenses only — payroll and direct ledger entries
 *     are not counted here" was an accurate note about a wrong figure. Both are
 *     counted now (moneyOutBreakdown reads the ledger), so the note is gone
 *     rather than reworded.
 *
 * WHAT DID NOT CHANGE: the books. Every figure still comes from the ledger
 * through finance.service.js, double entry and all, and reconciles with the
 * desktop's to the rupee. Posting, reversing and the audit view remain the
 * desktop's Advanced accounting section — a reversal is a correction someone
 * reads later, and it is not a thing to do between classes.
 *
 * PAYROLL STAYS ON DESKTOP for the same reason it always did: it pays real
 * people and cannot be undone by deleting anything. Its spending shows up here
 * as Money Out, which is Part 4 of the enhancement and the point of it.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort } from '../../utils/money.js';
import { localDate, monthKey, formatDate, formatDateLong } from '../../utils/date.js';
import { CAPABILITIES, expenseCategories } from '../../config/app.config.js';
import {
    ACCOUNTS, profitAndLoss, moneyOutBreakdown,
    transactions, recordTransaction, updateTransaction, deleteTransaction
} from '../../services/finance.service.js';
import { listBranches } from '../../services/settings.service.js';
import { formModal } from '../../ui/form.js';
import { showLoadError } from '../../ui/loadState.js';

/** The three views of the same list. Money In / Money Out, in the owner's words. */
const FLOWS = [
    { key: null, label: 'Everything' },
    { key: 'income', label: 'Money in' },
    { key: 'expense', label: 'Money out' }
];

/**
 * Where a transaction came from, said plainly.
 *
 * The service's `source` is a sourceType — 'payment', 'waiver', 'manual' — which
 * is the right word in the ledger and the wrong one on a phone. Only shown on
 * the detail sheet; the list has no room for it and does not need it.
 */
const SOURCE_LABEL = {
    manual:  'Typed in by hand',
    expense: 'Recorded spending',
    payment: 'A fee payment',
    refund:  'A fee refund',
    waiver:  'A fee waiver',
    salary:  'A salary payment',
    program: 'Posted by a programme'
};

export default class MobileFinancePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Finance';
        this.period = this.query.period || monthKey();
        this.flow = null;       // null | 'income' | 'expense'
        this.category = null;   // set when drilled into one
        this.selected = null;   // the transaction whose detail sheet is open
        this.data = {};
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading the books…</div>`);
        this.bind();
        await this.load();

        [EVENTS.EXPENSE_RECORDED, EVENTS.LEDGER_POSTED, EVENTS.SALARY_PROCESSED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    /** The month being looked at, as `{from,to}`. */
    range() {
        const from = `${this.period}-01`;
        const end = new Date(`${this.period}-01T00:00:00`);
        end.setMonth(end.getMonth() + 1);
        end.setDate(0);
        const to = this.period === monthKey() ? localDate() : end.toISOString().slice(0, 10);
        return { from, to };
    }

    async load() {
        const branchId = session.branch();
        const { from, to } = this.range();
        try {
            // Three queries where there were four: the six-month series is
            // Analytics' job now, and it was the widest read on this screen.
            const [pl, breakdown, ledger] = await Promise.all([
                profitAndLoss({ from, to, branchId }),
                moneyOutBreakdown({ from, to, branchId }),
                transactions({ from, to, branchId })
            ]);
            if (this.disposed) return;
            this.data = { pl, breakdown, ledger };
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Finance failed to load', err);
            showLoadError(this.container, { what: 'The books', error: err, onRetry: () => this.load() });
        }
    }

    /** The rows the current flow and category filters leave standing. */
    visibleRows() {
        let rows = this.data.ledger?.rows || [];
        if (this.flow) rows = rows.filter((row) => row.type === this.flow);
        if (this.category) rows = rows.filter((row) => row.category === this.category);
        return rows;
    }

    paint() {
        const { pl, breakdown } = this.data;
        if (!pl) return;

        const rows = this.visibleRows();
        const canEdit = session.can(CAPABILITIES.FINANCE_EDIT);

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <input class="m-input" type="month" data-role="period" value="${this.period}"
                           max="${monthKey()}" aria-label="Month">
                </div>
                <p class="m-subhead-note">
                    ${formatDateLong(this.range().from)} to ${formatDateLong(this.range().to)}
                </p>
            </div>

            <!-- Net first and largest: it is the one number somebody opens this
                 screen on a phone to see. The three beside it are the whole of
                 the summary the enhancement asks to keep. -->
            <section class="m-card" style="padding:16px;margin-bottom:10px;">
                <div class="m-subhead-note">Net this month</div>
                <div style="font-size:28px;font-weight:var(--weight-bold);
                            color:${pl.net >= 0 ? 'var(--v3-positive)' : 'var(--v3-negative)'};">
                    ${formatMoney(pl.net)}
                </div>
                <div class="m-metrics" style="margin-top:12px;">
                    ${metric('Money in', formatMoneyShort(pl.totalIncome), 'in')}
                    ${metric('Money out', formatMoneyShort(pl.totalExpense), 'out')}
                    ${metric('Margin', pl.margin === null ? '—' : `${pl.margin}%`, 'margin')}
                </div>
            </section>

            <!-- All the trend this screen keeps: a way to the screen that does
                 trends properly. Deep-linked to the money series so the tap
                 lands on what was just being read, not on a default. -->
            ${session.can('report.view') ? html`
                <a class="m-btn m-btn-ghost m-btn-block" href="#/analytics?series=money&months=6"
                   style="margin-bottom:14px;">
                    ${raw(icon('trending-up', { size: 16 }))} View trends
                </a>
            ` : ''}

            <p class="m-section-label">Where it went</p>
            ${breakdown?.categories?.length ? html`
                <div class="m-chip-scroll">
                    <button class="m-pill" data-action="category" data-key=""
                            aria-pressed="${this.category ? 'false' : 'true'}">
                        All · ${formatMoneyShort(breakdown.total)}
                    </button>
                    ${breakdown.categories.map((c) => html`
                        <button class="m-pill" data-action="category" data-key="${c.category}"
                                aria-pressed="${this.category === c.category ? 'true' : 'false'}">
                            ${c.category} · ${formatMoneyShort(c.amount)}
                        </button>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty" style="margin-bottom:10px;">Nothing has gone out this month.</div>
            `}

            <p class="m-section-label" style="margin-top:16px;">
                Transactions${this.category ? ` · ${this.category}` : ''}
            </p>
            <div class="m-chip-scroll">
                ${FLOWS.map((f) => html`
                    <button class="m-pill" data-action="flow" data-key="${f.key || ''}"
                            aria-pressed="${this.flow === f.key ? 'true' : 'false'}">${f.label}</button>
                `)}
            </div>

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((row) => this.transactionRow(row))}
                </div>
            ` : html`
                <div class="m-card m-empty">
                    ${this.flow || this.category ? 'Nothing matches that.' : 'Nothing recorded this month.'}
                </div>
            `}

            ${canEdit ? html`
                <button class="m-fab" data-action="add" aria-label="Record a transaction">
                    ${raw(icon('plus', { size: 24 }))}
                </button>
            ` : ''}
        `);

        this.paintDetail();
    }

    /**
     * One transaction, as a line — three facts and an amount.
     *
     * IT WAS THREE LINES TALL. Every row carried its Edit/Delete pair or, worse,
     * a full sentence explaining why it had neither ("This is a fee payment.
     * Correct it from the student's invoice."). Five transactions filled the
     * screen, and the reason — the least urgent thing on the row — was the
     * loudest part of it.
     *
     * A list is for scanning. What it needs to answer is *what, when, how much*;
     * everything else belongs to the one row you stopped at, which is what the
     * sheet behind this tap is for. The desktop keeps its inline buttons: it has
     * the width, and a mouse makes a two-step edit worse rather than better.
     *
     * Reuses `.m-card.m-student`, the row the whole app already scans with —
     * Students, Admissions and Fees all use it — so this list looks like a list
     * rather than like a fifth invention of one.
     */
    transactionRow(row) {
        const out = row.type === 'expense';

        return html`
            <button class="m-card m-student" data-action="open" data-id="${row.id}">
                <span class="m-student-main">
                    <span class="m-student-name">${row.description || row.category}</span>
                    <span class="m-student-meta">${row.category} · ${formatDate(row.date)}</span>
                </span>
                <span class="m-badge" data-fee="${out ? 'overdue' : 'clear'}">
                    ${out ? '−' : '+'}${formatMoneyShort(row.amount)}
                </span>
            </button>
        `;
    }

    /* --------------------------------------------------------------- DETAIL */

    /**
     * The one transaction you stopped at — everything the row no longer says.
     *
     * The same centred-dialog shape the Admissions detail uses, and for the
     * reason recorded there (UAT4-BUG-003): a bottom sheet puts its action row
     * exactly where the tab bar sits, and on iPhone the two collide. This is
     * inset from every edge by the scrim's own padding.
     *
     * Edit and Delete sit in the footer only when the service would actually
     * allow them. Where it would not, the reason takes their place — here, in
     * the one view someone opened deliberately, rather than shouted on every
     * row of the list.
     */
    paintDetail() {
        let host = this.container.querySelector('[data-role="sheet"]');
        if (!host) {
            host = document.createElement('div');
            host.setAttribute('data-role', 'sheet');
            this.container.append(host);
        }

        const row = this.selected;
        if (!row) { render(host, ''); return; }

        const out = row.type === 'expense';
        const canEdit = session.can(CAPABILITIES.FINANCE_EDIT);

        render(host, html`
            <div class="m-modal-scrim" data-action="close-detail">
                <div class="m-modal" role="dialog" aria-modal="true"
                     aria-label="${row.description || row.category}">
                    <div class="m-modal-head">
                        <div style="min-width:0;">
                            <h2 class="m-modal-title">${row.description || row.category}</h2>
                            <p class="m-modal-sub">${out ? 'Money out' : 'Money in'}</p>
                        </div>
                        <button class="m-modal-close" data-action="close-detail" aria-label="Close">
                            ${raw(icon('x', { size: 16 }))}
                        </button>
                    </div>

                    <div class="m-modal-body">
                        <div style="font-size:26px;font-weight:var(--weight-bold);
                                    color:${out ? 'var(--v3-negative)' : 'var(--v3-positive)'};">
                            ${out ? '−' : '+'}${formatMoney(row.amount)}
                        </div>

                        <dl class="m-facts">
                            ${fact('Date', formatDateLong(row.date))}
                            ${fact('Category', row.category)}
                            ${fact('Kind', out ? 'Money out' : 'Money in')}
                            ${fact('Recorded as', SOURCE_LABEL[row.source] || row.source)}
                        </dl>

                        ${row.editable ? '' : html`
                            <div class="m-notice" data-tone="info">${row.lockedReason}</div>
                        `}
                    </div>

                    <div class="m-modal-foot">
                        ${canEdit && row.editable ? html`
                            <button class="m-btn m-btn-ghost" style="flex:1;" data-action="delete" data-id="${row.id}">
                                ${raw(icon('trash', { size: 15 }))} Delete
                            </button>
                            <button class="m-btn" style="flex:1;" data-action="edit" data-id="${row.id}">
                                ${raw(icon('edit', { size: 15 }))} Edit
                            </button>
                        ` : html`
                            <button class="m-btn m-btn-ghost" style="flex:1;" data-action="close-detail">Close</button>
                        `}
                    </div>
                </div>
            </div>
        `);
    }

    openDetail(id) {
        this.selected = (this.data.ledger?.rows || []).find((r) => r.id === id) || null;
        this.paintDetail();
    }

    closeDetail() {
        this.selected = null;
        this.paintDetail();
    }

    /* --------------------------------------------------------------- WRITES */

    /**
     * The category list for a kind of transaction, in the owner's words.
     *
     * SALARIES IS NOT OFFERED FOR MONEY OUT, and this is the one place the
     * cashbook narrows what the service would accept. `expenseCategories()`
     * contains "Salaries" and `recordExpense()` takes it happily — nothing in
     * the service layer stops a wage being typed in by hand. But payroll
     * already posts every salary it pays (ENH-504 Part 4, and the reason
     * Salaries now appears in the breakdown at all), so a hand-typed one is a
     * second copy of money that has already gone out, and the books would
     * overstate the wage bill with no way to tell the duplicate from the real
     * entry.
     *
     * It stays visible everywhere it is a fact — the breakdown, the transaction
     * list, the reports. It is only absent from the place that would create a
     * new one.
     */
    categoriesFor(type) {
        if (type === 'income') return ACCOUNTS.income;
        return expenseCategories().filter((category) => category !== 'Salaries');
    }

    /**
     * Quick entry — one dialog, the fields the enhancement lists, and the
     * branch the service requires.
     *
     * ONE FORM, NOT TWO. The category list depends on the kind, and the
     * temptation is to ask the kind first and then open the real form; that
     * makes "quick entry" two dialogs deep. Both lists are rendered instead and
     * `showIf` hides the one that does not apply — the same arrangement the
     * desktop ledger form uses, for the same reason: a single merged list could
     * offer Rent as income, and the service would rightly refuse it after the
     * person had already typed everything else.
     *
     * Money out leads. Income almost always reaches the books through fee
     * collection; what gets typed on a phone is a costume, a taxi, a repair.
     */
    async addTransaction() {
        session.require(CAPABILITIES.FINANCE_EDIT, 'record a transaction');
        const branches = await listBranches();

        const saved = await formModal({
            title: 'Record a transaction',
            description: 'Money out is anything the school paid for. Money in is income it received.',
            submitLabel: 'Record',
            fields: [
                { name: 'type', label: 'Kind', type: 'select', required: true,
                  options: [
                      { value: 'expense', label: 'Money out — the school paid' },
                      { value: 'income', label: 'Money in — the school received' }
                  ] },
                { name: 'date', label: 'Date', type: 'date',
                  validate: (v) => v && v > localDate() ? 'A transaction cannot be dated in the future.' : null },
                { name: 'expenseCategory', label: 'Category', type: 'select', required: true,
                  placeholder: 'Choose a category',
                  options: this.categoriesFor('expense').map((c) => ({ value: c, label: c })),
                  showIf: (v) => v.type === 'expense' },
                { name: 'incomeCategory', label: 'Category', type: 'select', required: true,
                  placeholder: 'Choose a category',
                  options: this.categoriesFor('income').map((c) => ({ value: c, label: c })),
                  showIf: (v) => v.type === 'income' },
                { name: 'description', label: 'What for', required: true,
                  placeholder: 'Costume hire for Annual Day' },
                { name: 'amount', label: 'Amount', type: 'money', required: true, min: 1 },
                { name: 'paidTo', label: 'Paid to', showIf: (v) => v.type === 'expense' },
                { name: 'branchId', label: 'Branch', type: 'select', required: true,
                  placeholder: 'Choose a branch',
                  options: branches.map((b) => ({ value: b.id, label: b.name })) }
            ],
            values: {
                type: 'expense', date: localDate(),
                expenseCategory: '', incomeCategory: '',
                description: '', amount: '', paidTo: '',
                branchId: session.branch() || (branches.length === 1 ? branches[0].id : '')
            },
            onSubmit: (v) => recordTransaction({
                type: v.type,
                category: v.type === 'income' ? v.incomeCategory : v.expenseCategory,
                amount: v.amount,
                description: v.description,
                date: v.date || null,
                branchId: v.branchId,
                paidTo: v.type === 'expense' ? v.paidTo : null
            })
        });

        if (!saved) return;
        toast.success('Transaction recorded');
        await this.load();
    }

    async editTransaction(id) {
        const row = (this.data.ledger?.rows || []).find((r) => r.id === id);
        if (!row) return;
        if (!row.editable) { toast.error('Cannot be edited here', row.lockedReason); return; }

        const out = row.type === 'expense';

        const saved = await formModal({
            title: 'Edit transaction',
            description: out
                ? 'The expense and its ledger entry are rewritten together.'
                : 'The ledger entry is corrected in place.',
            submitLabel: 'Save',
            fields: [
                { name: 'date', label: 'Date', type: 'date',
                  validate: (v) => v && v > localDate() ? 'A transaction cannot be dated in the future.' : null },
                // The row's own category is forced into the list. Money out
                // hides Salaries so a wage cannot be typed in (see
                // categoriesFor), but an entry ALREADY on that account —
                // hand-posted from the desktop — must not silently lose it just
                // because someone opened this form to fix a typo.
                { name: 'category', label: 'Category', type: 'select', required: true,
                  options: [...new Set([row.category, ...this.categoriesFor(row.type)])]
                      .map((c) => ({ value: c, label: c })) },
                { name: 'description', label: 'What for', required: true },
                { name: 'amount', label: 'Amount', type: 'money', required: true, min: 1 }
            ],
            values: {
                date: row.date,
                category: row.category,
                description: row.description || '',
                amount: row.amount
            },
            onSubmit: (v) => updateTransaction(row, v)
        });

        if (!saved) return;
        toast.success('Transaction updated');
        // The sheet held a copy of the row that is now stale, and the change is
        // already visible in the list behind it. Closing is the honest outcome.
        this.selected = null;
        await this.load();
    }

    /**
     * Deleting asks for a reason, because the service does.
     *
     * Not a confirmModal: both paths behind this — deleteEntry() and
     * removeExpense() — refuse without one, and they refuse for the same
     * reason the audit log exists. A yes/no dialog would only be able to
     * discover that after the fact.
     */
    async deleteTransaction(id) {
        const row = (this.data.ledger?.rows || []).find((r) => r.id === id);
        if (!row) return;
        if (!row.editable) { toast.error('Cannot be deleted here', row.lockedReason); return; }

        const done = await formModal({
            title: 'Delete this transaction?',
            description: `${row.description || row.category} — ${formatMoney(row.amount)}. It is recorded in the audit log.`,
            submitLabel: 'Delete',
            fields: [
                { name: 'reason', label: 'Why', type: 'textarea', rows: 2, required: true,
                  help: 'Kept in the audit log — someone will read it.' }
            ],
            values: { reason: '' },
            onSubmit: (v) => deleteTransaction(row, { reason: v.reason })
        });

        if (!done) return;
        toast.success('Transaction deleted');
        this.selected = null;       // the row it described no longer exists
        await this.load();
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'change', '[data-role="period"]', (_e, t) => {
            if (!t.value) return;
            this.period = t.value;
            this.category = null;
            this.load();
        }));
        this.onDispose(on(root, 'click', '[data-action="category"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.category = this.category === key ? null : key;
            this.paint();
        }));
        this.onDispose(on(root, 'click', '[data-action="flow"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.flow = this.flow === key ? null : key;
            this.paint();
        }));
        this.onDispose(on(root, 'click', '[data-action="add"]', () => this.addTransaction()));
        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.openDetail(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="edit"]', (_e, t) => this.editTransaction(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="delete"]', (_e, t) => this.deleteTransaction(t.dataset.id)));

        /*
         * The scrim WRAPS the dialog, so a click inside the box bubbles up to
         * the scrim's own data-action. `event.target !== target` is the guard
         * formModal and the Admissions sheet both use for exactly this: close
         * only on a click that landed on the scrim itself. The close button and
         * the Close footer button carry the same action and pass that test.
         */
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', (event, target) => {
            if (target.classList.contains('m-modal-scrim') && event.target !== target) return;
            this.closeDetail();
        }));

        this.onKey = (event) => { if (event.key === 'Escape' && this.selected) this.closeDetail(); };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function metric(label, value, tone = null) {
    return html`<div class="m-metric"${tone ? raw(` data-tone="${tone}"`) : ''}>
        <span class="m-metric-value">${value}</span>
        <span class="m-metric-label">${label}</span>
    </div>`;
}

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
