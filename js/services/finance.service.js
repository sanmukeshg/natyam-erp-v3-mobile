/**
 * NATYAM ERP 2.0 — Finance service
 *
 * Income, expenditure, payroll and the reports built on them. Deliberately
 * separate from fee collection, and the separation is worth restating because
 * it is the largest structural change from 1.0:
 *
 *   Fee collection answers "what does this family owe and what have they paid".
 *   Finance answers "what did the school earn and spend".
 *
 * They meet at exactly one point: a cleared payment posts an income entry to
 * the ledger. That posting happens inside the fee service's own atomic
 * transaction, so the ledger cannot drift from the receipts. This module
 * never reaches back into invoices to recompute income — if it did, the two
 * would eventually disagree and there would be no way to say which was right.
 *
 * Every amount here is integer paise. There is no floating point anywhere in
 * this file, which is why the P&L adds up.
 *
 * Expense and payroll postings that touch both their own store and the
 * ledger together (recordExpense, updateExpense, removeExpense, paySalaries)
 * used to be a single IndexedDB `db.unit()`. Milestone 21 moved the
 * mechanics of that atomic write to postExpenseCreate()/postExpenseUpdate()/
 * postExpenseRemove()/postPayroll() (js/data/ledger.repository.firestore.js,
 * re-exported from repositories.js) — Firestore SDK access is reserved to
 * the repository layer. This service still owns every validation decision;
 * it just hands the repository layer fully-formed data to write atomically.
 *
 * MIGRATED IN STAGE 23, ahead of the Finance *module* — because
 * programs.service.js needs postEntry(): completing a programme posts its
 * income and expenditure to the ledger, and a programme that quietly failed to
 * do so would leave the books wrong in a way nobody would notice until the
 * month closed. The Finance screens follow in their own stage; this is the
 * dependency arriving when it is actually required, not speculatively.
 *
 * ⚠ THIS FILE DIVERGES FROM THE REFERENCE PROJECT — approved, Stage 25.
 *
 * profitAndLoss() and monthlySeries() now exclude BOTH sides of a reversal.
 * The reference keeps the contra entry, which put a reversed ₹42,000 salary
 * into the INCOME column and reported a ₹13,795 profit for a month that in
 * fact lost ₹28,205. See the comments on those two functions.
 *
 * ledgerView() is deliberately NOT filtered: the ledger is the audit trail and
 * must keep showing the original and its reversal.
 *
 * The reference project still carries the bug. If it is ever fixed there, this
 * note is what says the two are meant to differ.
 */

import { bus, EVENTS } from '../core/bus.js';
import { session } from '../core/session.js';
import { localDate, nowISO, monthKey, lastMonths, startOfMonth, endOfMonth, formatMonth } from '../utils/date.js';
import { expenseCategories } from '../config/app.config.js';
import {
    ledger$, expenses$, salaries$, staff$, branches$, settings$,
    LedgerMath, ExpenseMath,
    postExpenseCreate, postExpenseUpdate, postExpenseRemove, postPayroll
} from '../data/repositories.js';
import { recordAuditEntry } from '../data/auditLog.repository.firestore.js';
import { notify } from './notifications.service.js';

/** Ledger accounts. Income accounts first, then expenditure. */
export const ACCOUNTS = Object.freeze({
    income: ['Tuition fees', 'Registration fees', 'Costume sales', 'Programme tickets', 'Workshop fees', 'Donations', 'Other income'],
    expense: ['Salaries', ...expenseCategories().filter((c) => c !== 'Salaries')]
});

/* ==========================================================================
   LEDGER POSTING
   ========================================================================== */

/**
 * Posts a manual ledger entry — a donation, a ticket sale, a correction.
 *
 * Entries produced automatically by another module (a fee payment, a salary
 * run) carry a `sourceType` and are written inside that module's transaction.
 * A manual entry has no source, and that distinction is what lets the audit
 * view separate "the system recorded this" from "a person typed this".
 */
export async function postEntry({ date, account, type, amount, narration, branchId = null, sourceType = null, sourceId = null }) {
    session.require('finance.edit', 'post a ledger entry');

    const value = Math.round(Number(amount) || 0);
    const when = date || localDate();

    if (!['income', 'expense'].includes(type)) throw new Error('An entry is either income or expenditure.');
    if (!account) throw new Error('Choose an account.');
    if (!ACCOUNTS[type].includes(account)) throw new Error(`"${account}" is not an ${type} account.`);
    if (value <= 0) throw new Error('The amount must be more than zero.');
    if (!narration?.trim()) throw new Error('Describe what this entry is for.');
    if (when > localDate()) throw new Error('A ledger entry cannot be dated in the future.');

    const entry = await ledger$.create({
        date: when,
        period: monthKey(when),
        account,
        type,
        amount: value,
        narration: narration.trim(),
        branchId: branchId || session.activeBranchId,
        sourceType,
        sourceId,
        manual: !sourceType
    });

    bus.emit(EVENTS.LEDGER_POSTED, { entry });
    return entry;
}

/**
 * Edits a hand-typed ledger entry.
 *
 * MANUAL ENTRIES ONLY, and the restriction is the whole point. An entry with a
 * sourceType is the shadow of another record — a payment, an expense, a payroll
 * run — and editing it here would put the ledger out of step with the thing it
 * describes, silently. Those are corrected from their own record: an expense
 * through updateExpense(), which rewrites its ledger line in the same
 * transaction; a payment through refundPayment().
 *
 * A hand-typed entry has no such twin. It answers to nobody, so it can be
 * corrected in place — which is what the school asked for: a mistyped donation
 * or ticket sale should be fixable, not reversed and re-entered.
 */
export async function updateEntry(id, changes) {
    session.require('finance.edit', 'edit a ledger entry');

    const existing = await ledger$.findOrFail(id);
    if (existing.sourceType) {
        throw new Error('This entry was posted by another module. Correct it from that record instead.');
    }

    const amount = changes.amount !== undefined ? Math.round(Number(changes.amount) || 0) : existing.amount;
    if (amount <= 0) throw new Error('The amount must be more than zero.');

    const date = changes.date || existing.date;
    if (date > localDate()) throw new Error('A ledger entry cannot be dated in the future.');

    const updated = await ledger$.update(id, {
        ...changes,
        amount,
        date,
        period: monthKey(date)
    });

    bus.emit(EVENTS.LEDGER_POSTED, { entry: updated });
    return updated;
}

/**
 * Deletes a hand-typed ledger entry outright.
 *
 * Same restriction and the same reasoning as updateEntry(). This is a real
 * delete, not a contra — the school's decision, for entries they typed
 * themselves. Anything posted by another module keeps the audit trail: it is
 * reversed, or corrected from its source.
 */
export async function deleteEntry(id, { reason }) {
    session.require('finance.edit', 'delete a ledger entry');

    const existing = await ledger$.findOrFail(id);
    if (existing.sourceType) {
        throw new Error('This entry was posted by another module. Reverse it, or correct it from that record.');
    }
    if (!reason?.trim()) throw new Error('Say why this entry is being deleted.');

    await recordAuditEntry('Ledger', 'delete', id, {
        narration: existing.narration,
        amount: existing.amount,
        type: existing.type,
        account: existing.account,
        reason: reason.trim()
    });

    await ledger$.remove(id);
    bus.emit(EVENTS.LEDGER_POSTED, { entry: null });
    return true;
}

/**
 * Reverses an entry with a contra rather than deleting it. A ledger you can
 * delete from is not a ledger.
 */
export async function reverseEntry(id, { reason }) {
    session.require('finance.edit', 'reverse a ledger entry');

    const original = await ledger$.findOrFail(id);
    if (original.reversedBy) throw new Error('This entry has already been reversed.');
    if (!reason?.trim()) throw new Error('A reversal needs a reason.');

    /*
     * Opposite type, positive amount — reversing income posts an expense.
     *
     * This was briefly changed to a same-type negative (contra) entry, on the
     * grounds that reversing income should reduce income rather than invent an
     * expense. The school's decision is the other way: money going back out is
     * expenditure, and they want to see it there. Reverted deliberately, not
     * by accident — if the argument comes up again, that is the reason, and it
     * is theirs to make.
     *
     * `reversalOf` stays from that change. It is the audit link back to the
     * entry being undone, pairing with the `reversedBy` pointer written onto
     * that entry below so the two are navigable from either end.
     */
    const contra = await ledger$.create({
        date: localDate(),
        period: monthKey(localDate()),
        account: original.account,
        type: original.type === 'income' ? 'expense' : 'income',
        amount: Math.abs(original.amount),
        narration: `Reversal of ${original.narration} — ${reason.trim()}`,
        branchId: original.branchId,
        sourceType: 'reversal',
        sourceId: original.id,
        reversalOf: original.id
    });

    await ledger$.update(id, { reversedBy: contra.id, reversedOn: localDate(), reversalReason: reason.trim() });
    bus.emit(EVENTS.LEDGER_POSTED, { entry: contra });
    return contra;
}

/* ==========================================================================
   EXPENSES
   ========================================================================== */

/**
 * Records an expense and posts it to the ledger atomically.
 *
 * 1.0 could not record expenses at all — the finance page showed income only,
 * which meant the "profit" figure it displayed was revenue with a different
 * label. The two rows are written together so an expense can never exist
 * without its ledger counterpart.
 */
export async function recordExpense(data) {
    session.require('finance.edit', 'record an expense');

    const amount = Math.round(Number(data.amount) || 0);
    const date = data.date || localDate();

    if (!data.category) throw new Error('Choose an expense category.');
    if (!expenseCategories().includes(data.category)) throw new Error(`"${data.category}" is not a recognised category.`);
    if (!data.description?.trim()) throw new Error('Describe what this expense was for.');
    if (amount <= 0) throw new Error('The amount must be more than zero.');
    if (date > localDate()) throw new Error('An expense cannot be dated in the future.');

    const branchId = data.branchId || session.activeBranchId;
    if (!branchId) throw new Error('Choose which branch this expense belongs to.');

    const at = nowISO();
    const actor = session.actorId();

    const expenseFields = {
        branchId,
        date,
        period: monthKey(date),
        category: data.category,
        amount,
        description: data.description.trim(),
        paidTo: data.paidTo?.trim() || null,
        mode: data.mode || 'cash',
        reference: data.reference?.trim() || null,
        status: data.status || 'paid',
        searchKey: [data.description, data.category, data.paidTo].filter(Boolean).join(' ').toLowerCase(),
        createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor, deletedAt: null
    };

    const ledgerFields = {
        branchId,
        date,
        period: monthKey(date),
        account: data.category,
        type: 'expense',
        amount,
        narration: [expenseFields.description, expenseFields.paidTo].filter(Boolean).join(' — '),
        sourceType: 'expense',
        createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor
    };

    const { expense, ledgerEntry } = await postExpenseCreate({ expenseFields, ledgerFields });

    bus.emit(EVENTS.EXPENSE_RECORDED, { expense });
    bus.emit(EVENTS.LEDGER_POSTED, { entry: ledgerEntry });

    // Returns the expense itself, like every other create in the service layer.
    // It previously returned { expense, entry }, which meant callers reaching
    // for `.id` got undefined and the failure surfaced much later as an opaque
    // database error. The ledger entry is reachable from the expense id.
    return expense;
}

/**
 * Edits an expense. The ledger entry is rewritten in the same atomic write, so
 * correcting an amount cannot leave the books quoting the old one.
 */
/** One expense by id — the Ledger row needs it to open the edit form. */
export async function getExpense(id) {
    return expenses$.find(id);
}

export async function updateExpense(id, changes) {
    session.require('finance.edit', 'edit an expense');

    const existing = await expenses$.findOrFail(id);
    const amount = changes.amount !== undefined ? Math.round(Number(changes.amount) || 0) : existing.amount;
    const date = changes.date || existing.date;

    if (amount <= 0) throw new Error('The amount must be more than zero.');
    if (date > localDate()) throw new Error('An expense cannot be dated in the future.');

    const { id: existingId, ...existingData } = existing;
    void existingId;
    const next = {
        ...existingData, ...changes,
        amount, date,
        period: monthKey(date),
        updatedAt: nowISO(),
        updatedBy: session.actorId()
    };

    const linked = (await ledger$.bySource(id))[0] || null;
    const nextEntry = linked ? {
        date, period: monthKey(date), amount,
        account: next.category,
        narration: [next.description, next.paidTo].filter(Boolean).join(' — '),
        updatedAt: nowISO(), updatedBy: session.actorId()
    } : null;

    await postExpenseUpdate({
        expenseId: id,
        expenseFields: next,
        ledgerEntryId: linked?.id || null,
        ledgerFields: nextEntry
    });

    const updated = { id, ...next };
    bus.emit(EVENTS.EXPENSE_RECORDED, { expense: updated });
    return updated;
}

/** Removes an expense and its ledger entry together. */
export async function removeExpense(id, { reason }) {
    session.require('finance.edit', 'remove an expense');
    if (!reason?.trim()) throw new Error('Say why this expense is being removed.');

    await expenses$.findOrFail(id);
    const linked = (await ledger$.bySource(id))[0] || null;
    const at = nowISO();

    await postExpenseRemove({
        expenseId: id,
        expenseFields: { deletedAt: at, deletedBy: session.actorId(), deleteReason: reason.trim() },
        ledgerEntryId: linked?.id || null
    });

    return true;
}

/* ==========================================================================
   PAYROLL
   ========================================================================== */

/**
 * Prepares the month's salary lines without paying anything.
 *
 * Split from payment deliberately: the school's owner reviews the run, adjusts
 * a deduction or a bonus, and only then releases it. A single "run payroll"
 * button that both computes and disburses gives nobody a chance to catch a
 * wrong figure before it is in the ledger.
 */
export async function preparePayroll(period = monthKey(), { branchId = null } = {}) {
    session.require('finance.edit', 'prepare payroll');

    if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('The pay period must be a month, e.g. 2026-07.');
    if (period > monthKey()) throw new Error('Payroll cannot be prepared for a future month.');

    const [team, existing] = await Promise.all([
        staff$.activeStaff(branchId),
        salaries$.forPeriod(period)
    ]);

    const already = new Map(existing.map((s) => [s.staffId, s]));
    const lines = [];

    for (const member of team) {
        if (already.has(member.staffId || member.id)) {
            lines.push(already.get(member.id));
            continue;
        }
        if (!member.monthlySalary) continue;

        lines.push(await salaries$.create({
            staffId: member.id,
            staffName: member.name,
            branchId: member.branchId,
            period,
            gross: member.monthlySalary,
            deductions: 0,
            allowances: 0,
            note: null,
            status: 'pending'
        }));
    }

    return {
        period,
        lines: lines.sort((a, b) => a.staffName.localeCompare(b.staffName)),
        gross: lines.reduce((s, l) => s + l.gross, 0),
        net: lines.reduce((s, l) => s + l.net, 0),
        alreadyPrepared: existing.length > 0
    };
}

/** Adjusts one salary line before it is paid. */
export async function adjustSalary(id, { gross, deductions, allowances, note }) {
    session.require('finance.edit', 'adjust a salary');

    const line = await salaries$.findOrFail(id);
    if (line.status === 'paid') throw new Error('This salary has already been paid. Post an adjustment entry instead.');

    const nextGross = gross !== undefined ? Math.round(Number(gross) || 0) : line.gross;
    const nextDeductions = deductions !== undefined ? Math.round(Number(deductions) || 0) : line.deductions;
    const nextAllowances = allowances !== undefined ? Math.round(Number(allowances) || 0) : (line.allowances || 0);

    if (nextDeductions > nextGross + nextAllowances) throw new Error('Deductions cannot exceed the total pay.');
    if ((nextDeductions !== line.deductions || nextAllowances !== (line.allowances || 0)) && !note?.trim()) {
        throw new Error('An adjustment needs a note explaining it.');
    }

    return salaries$.update(id, {
        gross: nextGross,
        deductions: nextDeductions,
        allowances: nextAllowances,
        net: nextGross + nextAllowances - nextDeductions,
        note: note?.trim() || line.note
    });
}

/**
 * Disburses prepared salary lines. Each line's payment and its ledger entry go
 * in together; the whole run is one transaction so a partial payroll cannot
 * exist in the books.
 */
export async function paySalaries(salaryIds, { paidOn = null, mode = 'bank' } = {}) {
    session.require('finance.edit', 'pay salaries');

    const date = paidOn || localDate();
    if (date > localDate()) throw new Error('Salaries cannot be dated in the future.');

    const lines = await Promise.all(salaryIds.map((id) => salaries$.findOrFail(id)));
    const unpaid = lines.filter((l) => l.status !== 'paid');
    if (!unpaid.length) throw new Error('Every selected salary has already been paid.');

    const at = nowISO();
    const actor = session.actorId();

    const changes = {
        status: 'paid',
        paidOn: date,
        mode,
        paidBy: actor,
        updatedAt: at,
        updatedBy: actor
    };

    const entryFields = unpaid.map((line) => ({
        branchId: line.branchId,
        date,
        period: monthKey(date),
        account: 'Salaries',
        type: 'expense',
        amount: line.net,
        narration: `Salary ${formatMonth(line.period)} — ${line.staffName}`,
        sourceType: 'salary',
        sourceId: line.id,
        createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor
    }));

    const createdEntries = await postPayroll({
        lines: unpaid.map((line) => ({ id: line.id, changes })),
        entries: entryFields
    });

    const paid = unpaid.map((line) => ({ ...line, ...changes }));
    const total = paid.reduce((sum, l) => sum + l.net, 0);
    bus.emit(EVENTS.SALARY_PROCESSED, { period: paid[0].period, count: paid.length, total });
    for (const entry of createdEntries) bus.emit(EVENTS.LEDGER_POSTED, { entry });

    return { count: paid.length, total, lines: paid };
}

/* ==========================================================================
   REPORTS
   ========================================================================== */

/**
 * Profit and loss for a period.
 *
 * Built entirely from ledger entries. Nothing here reads invoices or payments,
 * which is what guarantees the statement reconciles: there is one source of
 * truth for what the school earned, and it is the ledger.
 */
export async function profitAndLoss({ from, to, branchId = null }) {
    /*
     * v3 FIX — DIVERGES FROM THE REFERENCE PROJECT. Approved in Stage 25.
     *
     * The reference filter is:
     *
     *     .filter((e) => !e.reversedBy || e.sourceType === 'reversal')
     *
     * which drops a reversed entry but KEEPS its contra. Since reverseEntry()
     * correctly writes the contra as the opposite type, that leaves the
     * reversal sitting on the wrong side of the books instead of cancelling:
     * on the real July 2026 data, reversing a ₹42,000 salary made "Salaries"
     * appear as an INCOME account of ₹42,000, and turned a genuine ₹28,205
     * loss into a reported ₹13,795 profit.
     *
     * A reversal and its original exist to cancel each other. Both leave the
     * statement; neither is counted once on opposite sides. The ledger keeps
     * showing both — that is the audit trail's job, and ledgerView() is
     * deliberately left unfiltered.
     */
    const entries = (await ledger$.between(from, to, branchId))
        .filter((e) => !e.reversedBy && e.sourceType !== 'reversal');

    const income = LedgerMath.byAccount(entries, 'income');
    const expense = LedgerMath.byAccount(entries, 'expense');
    const totals = LedgerMath.summarise(entries);

    return {
        from, to,
        income,
        expense,
        totalIncome: totals.income,
        totalExpense: totals.expense,
        net: totals.net,
        margin: totals.income ? Math.round((totals.net / totals.income) * 100) : null,
        entryCount: entries.length
    };
}

/**
 * Month-by-month income, expenditure and net — the finance trend chart and the
 * basis of the cash-flow view.
 */
export async function monthlySeries(months = 6, branchId = null) {
    const keys = lastMonths(months);
    const from = `${keys[0]}-01`;
    /*
     * v3 FIX — same divergence as profitAndLoss() above, and the same reason.
     *
     * The reference reads the ledger unfiltered here. The *net* survives that
     * (both sides of a reversal cancel in the subtraction) but the income and
     * expenditure figures do not: each is inflated by the full reversed amount,
     * so the trend bars overstate both. Worse, the chart then disagreed with
     * the P&L sitting directly above it on the same screen.
     */
    const entries = (await ledger$.between(from, localDate(), branchId))
        .filter((e) => !e.reversedBy && e.sourceType !== 'reversal');

    let running = 0;
    return keys.map((period) => {
        const slice = entries.filter((e) => e.period === period);
        const { income, expense, net } = LedgerMath.summarise(slice);
        running += net;
        return { period, label: formatMonth(period), income, expense, net, cumulative: running };
    });
}

/**
 * Cash flow: opening balance, movement, closing balance per month.
 *
 * The opening balance is a setting rather than a derived figure, because the
 * school existed before this software did and the ledger does not go back to
 * 2016. Pretending the opening balance is zero would make every cash-flow
 * statement wrong by a constant, which is worse than asking for the number.
 */
export async function cashFlow(months = 6, branchId = null) {
    const opening = await settings$.get('openingBalance', 0);
    const series = await monthlySeries(months, branchId);

    let balance = Number(opening) || 0;
    return {
        opening: balance,
        months: series.map((row) => {
            const start = balance;
            balance += row.net;
            return { ...row, opening: start, closing: balance };
        }),
        closing: balance
    };
}

/**
 * The ledger view: entries in date order with a running balance, filterable by
 * account and type. This is the cash book and the bank book — the same data,
 * filtered by payment mode rather than duplicated into two stores.
 */
export async function ledgerView({ from, to, branchId = null, type = null, account = null }) {
    let entries = await ledger$.between(from, to, branchId);
    if (type) entries = entries.filter((e) => e.type === type);
    if (account) entries = entries.filter((e) => e.account === account);

    entries.sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || '').localeCompare(b.createdAt || ''));

    let balance = 0;
    const rows = entries.map((entry) => {
        balance += entry.type === 'income' ? entry.amount : -entry.amount;
        return { ...entry, balance };
    });

    return {
        rows,
        totals: LedgerMath.summarise(entries),
        accounts: [...new Set(entries.map((e) => e.account))].sort()
    };
}

/** Expenditure broken down by category, for the donut on the finance page. */
export async function expenseBreakdown({ from, to, branchId = null }) {
    const rows = await expenses$.between(from, to, branchId);
    const byCategory = ExpenseMath.byCategory(rows);
    const total = byCategory.reduce((s, c) => s + c.amount, 0);

    return {
        total,
        count: rows.length,
        categories: byCategory.map((c) => ({ ...c, share: total ? Math.round((c.amount / total) * 100) : 0 }))
    };
}

/**
 * The individual expenses behind the breakdown.
 *
 * Added because the expenses screen could aggregate spending but never show
 * the rows themselves, which meant a mistyped amount was visible only as a
 * category total that looked slightly wrong and could not be corrected. An
 * accounting screen that cannot show you the entry cannot be reconciled.
 */
export async function listExpenses({ from, to, branchId = null, category = null } = {}) {
    session.require('finance.view', 'view expenses');

    let rows = await expenses$.between(from, to, branchId);
    if (category) rows = rows.filter((row) => row.category === category);

    return rows
        .filter((row) => !row.deletedAt)
        .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** Per-branch profitability — the branch comparison on the dashboard. */
export async function branchPerformance({ from, to }) {
    const all = await branches$.active();
    const results = await Promise.all(all.map(async (branch) => {
        const pl = await profitAndLoss({ from, to, branchId: branch.id });
        return {
            branch,
            income: pl.totalIncome,
            expense: pl.totalExpense,
            net: pl.net,
            margin: pl.margin
        };
    }));
    return results.sort((a, b) => b.net - a.net);
}

/**
 * The headline finance figures for the current month, with the previous month
 * alongside. A number without a comparison is decoration.
 */
export async function currentMonthPosition(branchId = null) {
    const thisMonth = monthKey();
    const previous = lastMonths(2)[0];

    const [current, prior] = await Promise.all([
        profitAndLoss({ from: `${thisMonth}-01`, to: localDate(), branchId }),
        profitAndLoss({ from: `${previous}-01`, to: endOfMonth(new Date(`${previous}-01T00:00:00`)), branchId })
    ]);

    return {
        period: thisMonth,
        income: current.totalIncome,
        expense: current.totalExpense,
        net: current.net,
        change: {
            income: delta(current.totalIncome, prior.totalIncome),
            expense: delta(current.totalExpense, prior.totalExpense),
            net: delta(current.net, prior.net)
        },
        previous: { income: prior.totalIncome, expense: prior.totalExpense, net: prior.net }
    };
}

/**
 * Flags a month whose expenditure exceeded its income. Written as an alert
 * rather than left for someone to notice on a chart.
 */
export async function reviewMonth(period = monthKey(), branchId = null) {
    const from = `${period}-01`;
    const to = endOfMonth(new Date(`${from}T00:00:00`));
    const pl = await profitAndLoss({ from, to, branchId });

    if (pl.net < 0) {
        await notify({
            kind: 'system',
            key: `finance:loss:${period}`,
            title: `${formatMonth(period)} ran at a loss`,
            body: `Expenditure exceeded income by ₹${Math.abs(pl.net / 100).toLocaleString('en-IN')}.`,
            link: '#/finance'
        });
    }
    return pl;
}

/* ------------------------------------------------------------------ HELPERS */

function delta(current, previous) {
    if (!previous) return null;
    return Math.round(((current - previous) / Math.abs(previous)) * 100);
}


export { startOfMonth, endOfMonth };
