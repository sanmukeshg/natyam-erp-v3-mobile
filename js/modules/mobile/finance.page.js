/**
 * Natyam ERP v3 — Mobile — Finance
 *
 * NOT the desktop's four tabs shrunk. A twelve-column ledger on a 375px screen
 * is worse than no ledger, so this is the shape the approved plan asked for:
 * **summary, then drill-down**.
 *
 *   1. Where the month stands — income, spending, net.
 *   2. Six months of the same three numbers, so a bad month is visible as a
 *      trend rather than a single figure with no context.
 *   3. Where the money went, by category, tappable into the actual rows.
 *
 * ONE WRITE, AND ONLY ONE: recording spending. That genuinely happens away
 * from a desk — costumes are bought at a shop, a taxi is paid for at a venue —
 * and `recordExpense()` writes the expense and its ledger entry together in one
 * transaction, so there is no half-finished state to leave behind.
 *
 * POSTING LEDGER ENTRIES, REVERSING AND PAYROLL STAY ON DESKTOP. A reversal is
 * a correction to the books that someone will read later; payroll pays real
 * people and cannot be undone by deleting anything. Neither belongs on a phone
 * between classes, and the screen says so rather than leaving the absence to be
 * puzzled over.
 *
 * The reversal-accounting fix (Stage 25) lives in finance.service.js, shared by
 * both apps — so the figures here are the corrected ones, and match the
 * desktop's exactly.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort, formatNumber } from '../../utils/money.js';
import { localDate, monthKey, formatDateLong } from '../../utils/date.js';
import { CAPABILITIES, expenseCategories } from '../../config/app.config.js';
import {
    profitAndLoss, monthlySeries, expenseBreakdown, listExpenses, recordExpense
} from '../../services/finance.service.js';
import { listBranches } from '../../services/settings.service.js';
import { formModal } from '../../ui/form.js';
import { showLoadError } from '../../ui/loadState.js';

export default class MobileFinancePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Finance';
        this.period = this.query.period || monthKey();
        this.category = null;   // set when drilled into one
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
            const [pl, series, breakdown, expenses] = await Promise.all([
                profitAndLoss({ from, to, branchId }),
                monthlySeries(6, branchId),
                expenseBreakdown({ from, to, branchId }),
                listExpenses({ from, to, branchId })
            ]);
            if (this.disposed) return;
            this.data = { pl, series, breakdown, expenses };
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Finance failed to load', err);
            showLoadError(this.container, { what: 'The books', error: err, onRetry: () => this.load() });
        }
    }

    paint() {
        const { pl, series, breakdown, expenses } = this.data;
        if (!pl) return;

        const peak = Math.max(1, ...(series || []).map((m) => Math.max(m.income, m.expense)));
        const rows = this.category
            ? (expenses || []).filter((e) => e.category === this.category)
            : (expenses || []);

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
                 screen on a phone to see. -->
            <section class="m-card" style="padding:16px;margin-bottom:10px;">
                <div class="m-subhead-note">Net this month</div>
                <div style="font-size:28px;font-weight:var(--weight-bold);
                            color:${pl.net >= 0 ? 'var(--v3-positive)' : 'var(--v3-negative)'};">
                    ${formatMoney(pl.net)}
                </div>
                <div class="m-metrics" style="margin-top:12px;">
                    ${metric('In', formatMoneyShort(pl.totalIncome), 'in')}
                    ${metric('Out', formatMoneyShort(pl.totalExpense), 'out')}
                    ${metric('Margin', pl.margin === null ? '—' : `${pl.margin}%`, 'margin')}
                </div>
            </section>

            ${series?.length ? html`
                <p class="m-section-label">Last six months</p>
                <div class="m-stack">
                    ${series.map((m) => html`
                        <div class="m-card" style="padding:12px 14px;">
                            <div class="m-subhead-row" style="justify-content:space-between;">
                                <span class="m-student-name">${m.label}</span>
                                <span class="m-badge" data-fee="${m.net >= 0 ? 'clear' : 'overdue'}">
                                    ${formatMoneyShort(m.net)}
                                </span>
                            </div>
                            <div class="m-trend" style="margin-top:8px;">
                                <span class="m-trend-bar" data-tone="positive"
                                      style="width:${Math.round((m.income / peak) * 100)}%"></span>
                                <span class="m-trend-bar" data-tone="negative"
                                      style="width:${Math.round((m.expense / peak) * 100)}%"></span>
                            </div>
                        </div>
                    `)}
                </div>
            ` : ''}

            <p class="m-section-label">
                Where it went${this.category ? ` · ${this.category}` : ''}
            </p>
            <!-- Recorded expenses only — the ledger also carries payroll and anything
                 posted straight to it, which is why "Out" above is the larger figure. -->
            <p class="m-subhead-note" style="margin:-4px 0 8px;">
                Recorded expenses only — payroll and direct ledger entries are not counted here.
            </p>
            ${this.category ? html`
                <button class="m-btn m-btn-ghost m-btn-block" data-action="clear-category"
                        style="margin-bottom:10px;">
                    ← All categories
                </button>
            ` : html`
                <div class="m-chip-scroll">
                    ${(breakdown?.categories || []).map((c) => html`
                        <button class="m-pill" data-action="category" data-key="${c.category}">
                            ${c.category} · ${formatMoneyShort(c.amount)}
                        </button>
                    `)}
                </div>
            `}

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((e) => html`
                        <div class="m-card m-student">
                            <span class="m-student-main">
                                <span class="m-student-name">${e.description || e.category}</span>
                                <span class="m-student-meta">
                                    ${e.category} · ${formatDateLong(e.date)}${e.paidTo ? ` · ${e.paidTo}` : ''}
                                </span>
                            </span>
                            <span class="m-badge">${formatMoneyShort(e.amount)}</span>
                        </div>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty">
                    ${this.category ? 'Nothing in this category.' : 'Nothing recorded this month.'}
                </div>
            `}

            <p class="m-subhead-note" style="margin-top:16px;">
                Posting ledger entries, reversing them and running payroll are done on the
                desktop app — a reversal is a correction someone reads later, and payroll pays
                real people.
            </p>

            ${session.can(CAPABILITIES.FINANCE_EDIT) ? html`
                <button class="m-fab" data-action="add-expense" aria-label="Record spending">
                    ${raw(icon('plus', { size: 24 }))}
                </button>
            ` : ''}
        `);
    }

    /**
     * Recording spending — the one write this screen carries.
     *
     * `recordExpense()` writes the expense and its ledger entry in one
     * transaction, so there is no state where one exists without the other.
     * It offers `expenseCategories()`, not `ACCOUNTS.expense`: the two differ
     * by "Salaries", which the service rejects here because salaries are paid
     * through payroll rather than typed in as an ad-hoc expense.
     */
    async addExpense() {
        session.require(CAPABILITIES.FINANCE_EDIT, 'record an expense');
        const branches = await listBranches();

        const saved = await formModal({
            title: 'Record spending',
            description: 'The expense and its ledger entry are written together.',
            submitLabel: 'Record',
            fields: [
                { name: 'category', label: 'Category', type: 'select', required: true,
                  placeholder: 'Choose a category',
                  options: expenseCategories().map((c) => ({ value: c, label: c })) },
                { name: 'amount', label: 'Amount', type: 'money', required: true, min: 1 },
                { name: 'description', label: 'What for', required: true,
                  placeholder: 'Costume hire for Annual Day' },
                { name: 'paidTo', label: 'Paid to' },
                { name: 'date', label: 'Date', type: 'date',
                  validate: (v) => v && v > localDate() ? 'Spending cannot be dated in the future.' : null },
                // Required — recordExpense() refuses an expense with no branch.
                { name: 'branchId', label: 'Branch', type: 'select', required: true,
                  placeholder: 'Choose a branch',
                  options: branches.map((b) => ({ value: b.id, label: b.name })) }
            ],
            values: {
                category: '', amount: '', description: '', paidTo: '',
                date: localDate(), branchId: session.branch() || ''
            },
            onSubmit: (v) => recordExpense(v)
        });

        if (!saved) return;
        toast.success('Spending recorded');
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
            this.category = t.dataset.key;
            this.paint();
        }));
        this.onDispose(on(root, 'click', '[data-action="clear-category"]', () => {
            this.category = null;
            this.paint();
        }));
        this.onDispose(on(root, 'click', '[data-action="add-expense"]', () => this.addExpense()));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function metric(label, value, tone = null) {
    return html`<div class="m-metric"${tone ? raw(` data-tone="${tone}"`) : ''}>
        <span class="m-metric-value">${value}</span>
        <span class="m-metric-label">${label}</span>
    </div>`;
}
