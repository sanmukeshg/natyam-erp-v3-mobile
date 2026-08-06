/**
 * NATYAM ERP 2.0 — Fee collection service
 *
 * Scope, stated once so it is not eroded later: this module manages what a
 * family owes and what they have paid. It is not the accounting system. It
 * emits an event that finance listens to; it never decides how the school's
 * books are structured.
 *
 * Every write that touches money is atomic — the invoice, the payment row
 * and the ledger entry either all land or none do. 1.0 wrote them as
 * separate calls, which meant a failure between the second and third
 * silently left an invoice marked paid with no receipt behind it and no
 * ledger income. Milestone 21 moved this from a single IndexedDB
 * `db.unit()` to a Firestore transaction — the mechanics now live in
 * `postPayment()`/`postRefund()` (js/data/ledger.repository.firestore.js,
 * re-exported from repositories.js), since Firestore SDK access is
 * reserved to the repository layer. This service still owns every
 * validation decision; the sequence counter (still IndexedDB, via
 * `settings$.nextSequence()`) is still allocated before the transaction
 * starts, for the same reason as before — nesting it inside would deadlock
 * the settings store against itself.
 */

import { bus, EVENTS } from '../core/bus.js';
import { session } from '../core/session.js';
import { formatMoney } from '../utils/money.js';
import { sequenceNumber } from '../utils/id.js';
import { localDate, addDays, academicYearOf, monthKey } from '../utils/date.js';
import {
    INVOICE_STATUS, PAYMENT_STATUS, PAYMENT_MODES, STUDENT_STATUS, feeFrequency
} from '../config/app.config.js';
import {
    invoices$, payments$, students$, feePlans$, settings$, ledger$, reconcile, postPayment, postRefund
} from '../data/repositories.js';

/* ==========================================================================
   BILLING
   ========================================================================== */

/**
 * Raises the full instalment schedule for a student against their fee plan.
 *
 * Idempotent by design: it refuses to bill a plan that has already been billed
 * for the same academic year rather than quietly doubling a family's fees,
 * which is the single most damaging mistake this module could make.
 *
 * @returns {Promise<{invoices: object[], skipped: boolean}>}
 */
/* ==========================================================================
   BILLING ENGINE

   The academy bills a cycle at a time. Enrolling a student raises the invoice
   for the cycle they join in — nothing further. Every later cycle is raised by
   the scheduler on the day it falls due, so a student who leaves in September
   was never billed for October, and "outstanding" only ever means invoices
   that genuinely exist.

   A cycle is identified by a period key (2026-07, 2026-Q3, 2026-H1, 2026,
   once). The key is stored on the invoice, which is what makes the scheduler
   safe to run repeatedly: an invoice already carrying that key is never raised
   twice. Invoices written before this change have no key; they are matched on
   their due date falling inside the period instead, so historical billing is
   recognised and never duplicated.
   ========================================================================== */

/**
 * The date cycle-based billing took over. Recorded once, the first time the
 * scheduler runs, so an existing school's past invoices are never rebuilt.
 */
async function billingStartDate() {
    const stored = await settings$.get('billing.startsOn', null);
    if (stored) return stored;
    const today = localDate();
    await settings$.set('billing.startsOn', today);
    return today;
}

/** The frequency in force for a student — their override, else the plan's. */
function billingFrequencyFor(student, plan) {
    return feeFrequency(student?.billingFrequency || plan?.frequency);
}

/**
 * The billing period containing `onDate`, counted from the joining date so a
 * student who joins mid-month is billed for their own cycle rather than the
 * calendar's.
 */
function billingPeriod(joinedOn, frequency, onDate = localDate()) {
    const cadence = feeFrequency(frequency);
    const start = new Date(`${joinedOn}T00:00:00`);
    const at = new Date(`${onDate}T00:00:00`);

    if (cadence.months === 0) {
        // One-time: a single period that never repeats.
        return { key: 'once', index: 0, startsOn: joinedOn, endsOn: null, label: 'One-time fee' };
    }

    const monthsElapsed = (at.getFullYear() - start.getFullYear()) * 12 + (at.getMonth() - start.getMonth())
        - (at.getDate() < start.getDate() ? 1 : 0);
    const index = Math.max(0, Math.floor(monthsElapsed / cadence.months));

    const periodStart = new Date(start);
    periodStart.setMonth(periodStart.getMonth() + index * cadence.months);
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + cadence.months);
    periodEnd.setDate(periodEnd.getDate() - 1);

    return {
        key: periodKeyFor(periodStart, cadence),
        index,
        startsOn: isoDate(periodStart),
        endsOn: isoDate(periodEnd),
        label: periodLabel(periodStart, cadence)
    };
}

function isoDate(date) { return date.toISOString().slice(0, 10); }

function periodKeyFor(start, cadence) {
    const y = start.getFullYear();
    const m = start.getMonth();
    if (cadence.months === 12) return String(y);
    if (cadence.months === 6) return `${y}-H${Math.floor(m / 6) + 1}`;
    if (cadence.months === 3) return `${y}-Q${Math.floor(m / 3) + 1}`;
    return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function periodLabel(start, cadence) {
    const month = start.toLocaleString('en-IN', { month: 'short' });
    const y = start.getFullYear();
    if (cadence.months === 12) return `Year from ${month} ${y}`;
    if (cadence.months === 6) return `Half-year from ${month} ${y}`;
    if (cadence.months === 3) return `Quarter from ${month} ${y}`;
    return `${month} ${y}`;
}

/** Has this exact cycle already been billed? Tolerates pre-existing invoices. */
function alreadyBilled(existing, plan, period) {
    return existing.some((invoice) => {
        if (invoice.status === INVOICE_STATUS.CANCELLED) return false;
        if (invoice.periodKey) return invoice.periodKey === period.key && invoice.feePlanId === plan.id;
        // Older invoices carry no key — treat one falling inside the period as
        // this cycle's bill so history is never billed a second time.
        if (invoice.feePlanId !== plan.id || !invoice.dueDate) return false;
        return period.endsOn
            ? invoice.dueDate >= period.startsOn && invoice.dueDate <= period.endsOn
            : true;
    });
}

/**
 * Raises the invoice for one billing cycle, if it is due and not already
 * raised. Returns the invoice, or null with a reason when nothing was needed.
 */
async function raiseCycle(studentId, { feePlanId = null, asOf = localDate() } = {}) {
    const student = await students$.findOrFail(studentId);
    const plan = await feePlans$.findOrFail(feePlanId || student.feePlanId);

    if (student.status !== STUDENT_STATUS.ACTIVE) {
        return { invoice: null, reason: `${student.name} is not active.` };
    }

    const joinedOn = student.joinedOn || localDate();
    if (asOf < joinedOn) return { invoice: null, reason: 'Before the joining date.' };

    const cadence = billingFrequencyFor(student, plan);
    const period = billingPeriod(joinedOn, cadence.value, asOf);
    const existing = await invoices$.forStudent(studentId);

    if (alreadyBilled(existing, plan, period)) {
        return { invoice: null, reason: `${period.label} is already billed.` };
    }
    // One-time plans bill once, ever.
    if (cadence.months === 0 && existing.some((i) => i.feePlanId === plan.id && i.status !== INVOICE_STATUS.CANCELLED)) {
        return { invoice: null, reason: 'A one-time fee has already been raised.' };
    }

    const lines = [{
        amount: Number(plan.amount) || 0,
        description: `${plan.name} — ${period.label}`,
        dueDate: period.startsOn
    }];

    const raised = await writeInvoices(student, plan, lines, { periodKey: period.key });
    return { invoice: raised[0] || null, invoices: raised, period, reason: null };
}

/**
 * Brings a student's billing up to date: raises every cycle that has fallen
 * due since they joined and has not been billed, and never a cycle in the
 * future. Safe to run repeatedly.
 */
async function catchUpStudent(studentId, { asOf = localDate(), since = null } = {}) {
    const student = await students$.findOrFail(studentId);
    if (student.status !== STUDENT_STATUS.ACTIVE || !student.feePlanId) return { raised: [] };

    const plan = await feePlans$.find(student.feePlanId);
    if (!plan || plan.status !== 'active') return { raised: [] };

    const cadence = billingFrequencyFor(student, plan);
    const joinedOn = student.joinedOn || localDate();
    const raised = [];

    // Billing starts at the changeover, never before it. Cycles that fall
    // earlier belong to the old scheme and are left exactly as they are —
    // the scheduler exists to raise what becomes due from now on, not to
    // reconstruct a history the school has already invoiced and collected.
    const floor = since || await billingStartDate();
    let cursor = joinedOn > floor ? joinedOn : floor;
    let safety = 0;
    while (cursor <= asOf && safety < 240) {
        safety += 1;
        const result = await raiseCycle(studentId, { feePlanId: plan.id, asOf: cursor });
        if (result.invoice) raised.push(result.invoice);
        if (cadence.months === 0) break;
        const period = billingPeriod(joinedOn, cadence.value, cursor);
        if (!period.endsOn) break;
        cursor = addDays(period.endsOn, 1);
    }
    return { raised, student };
}

/**
 * The automatic scheduler. Run at boot and on demand; it raises only invoices
 * that have become due, for active students on an active plan.
 */
export async function runBillingScheduler({ asOf = localDate(), branchId = null } = {}) {
    const roster = await students$.active(branchId);
    const since = await billingStartDate();
    const summary = { checked: 0, raised: 0, students: 0, invoices: [], since };

    for (const student of roster) {
        if (!student.feePlanId) continue;
        summary.checked += 1;
        const { raised } = await catchUpStudent(student.id, { asOf, since });
        if (raised.length) {
            summary.students += 1;
            summary.raised += raised.length;
            summary.invoices.push(...raised);
        }
    }

    if (summary.raised) bus.emit(EVENTS.INVOICE_CREATED, { count: summary.raised, scheduled: true });
    return summary;
}

/**
 * Kept for the enrolment path and the "raise fees" action, now meaning "bill
 * the cycle they are in" rather than the whole year.
 */
export async function raiseSchedule(studentId, { feePlanId = null, startDate = null } = {}) {
    session.require('fee.collect', 'raise invoices');
    const result = await raiseCycle(studentId, { feePlanId, asOf: startDate || localDate() });
    return {
        invoices: result.invoices || [],
        skipped: !result.invoice,
        reason: result.reason
    };
}


/** Persists the lines of one billing cycle, stamping the period key. */
async function writeInvoices(student, plan, lines, { periodKey = null } = {}) {
    const raised = [];
    for (const line of lines) {
        const invoice = await createInvoice({
            studentId: student.id,
            branchId: student.branchId,
            feePlanId: plan.id,
            amount: line.amount,
            description: line.description,
            dueDate: line.dueDate
        });
        if (periodKey) {
            raised.push(await invoices$.update(invoice.id, { periodKey }));
        } else {
            raised.push(invoice);
        }
    }
    return raised;
}

/**
 * A single invoice. The number is allocated from the settings counter inside
 * the same transaction as the row itself, so two invoices raised in the same
 * tick cannot share a number.
 */
export async function createInvoice({ studentId, branchId, feePlanId = null, amount, description, dueDate, discount = 0, discountReason = null }) {
    session.require('fee.collect', 'raise invoices');

    const student = await students$.findOrFail(studentId);
    const gross = Math.round(Number(amount) || 0);
    const reduction = Math.round(Number(discount) || 0);

    if (gross <= 0) throw new Error('An invoice must be for more than zero.');
    if (reduction < 0) throw new Error('A discount cannot be negative.');
    if (reduction > gross) throw new Error('A discount cannot exceed the invoice amount.');
    if (reduction > 0 && !discountReason?.trim()) {
        throw new Error('A discount needs a reason — it is the only record of why the family paid less.');
    }
    if (!dueDate) throw new Error('An invoice needs a due date.');
    if (!description?.trim()) throw new Error('Describe what is being billed.');

    const year = academicYearOf().start;
    const seq = await settings$.nextSequence('invoice');

    const candidate = reconcile({
        number: sequenceNumber('NAT/INV', year, seq),
        studentId: student.id,
        studentName: student.name,
        guardianPhone: student.guardianPhone || null,
        guardianEmail: student.guardianEmail || null,
        branchId: branchId || student.branchId,
        feePlanId,
        academicYear: year,
        description: description.trim(),
        grossAmount: gross,
        discount: reduction,
        discountReason: reduction > 0 ? discountReason.trim() : null,
        amount: gross - reduction,
        paidAmount: 0,
        dueDate,
        issuedOn: localDate(),
        status: INVOICE_STATUS.OPEN
    });

    const invoice = await invoices$.create(candidate);
    bus.emit(EVENTS.INVOICE_CREATED, { invoice });
    return invoice;
}

/* ==========================================================================
   COLLECTION
   ========================================================================== */

/**
 * Records money received against an invoice.
 *
 * The whole operation — invoice update, payment row, ledger income entry —
 * happens in one transaction. The receipt number is allocated first, outside
 * the transaction, because the sequence counter lives in its own unit of work
 * and nesting the two would deadlock the settings store against itself.
 *
 * @returns {Promise<{payment: object, invoice: object}>}
 */
export async function recordPayment({ invoiceId, amount, mode, reference = null, paidOn = null, note = null }) {
    session.require('fee.collect', 'collect fees');

    const invoice = await invoices$.findOrFail(invoiceId);
    const value = Math.round(Number(amount) || 0);
    const date = paidOn || localDate();

    /* -------- Validation, in the order a person would notice a problem ---- */
    if (value <= 0) throw new Error('Enter an amount greater than zero.');
    if (invoice.status === INVOICE_STATUS.CANCELLED) throw new Error('This invoice was cancelled. Raise a new one.');
    if (invoice.status === INVOICE_STATUS.WAIVED) throw new Error('This invoice was waived, so there is nothing to collect.');
    if (invoice.balance <= 0) throw new Error(`Invoice ${invoice.number} is already settled.`);
    if (value > invoice.balance) {
        // v3 FIX — a leftover from the paise era. utils/money.js records that
        // scaled-integer paise were removed ("What is typed, what is stored and
        // what is displayed are now the same whole number"), but this one
        // message still divided by 100: a ₹2,000 balance was reported as
        // "more than the ₹20.00 outstanding", which reads as though the
        // person had massively overpaid. Uses formatMoney() now, so it cannot
        // drift from every other amount on screen. See MIGRATION_CHECKLIST.md.
        throw new Error(`That is more than the ${formatMoney(invoice.balance)} outstanding on this invoice. Split it across invoices instead.`);
    }
    if (date > localDate()) throw new Error('A payment cannot be dated in the future.');

    const modeDef = PAYMENT_MODES.find((m) => m.value === mode);
    if (!modeDef) throw new Error('Choose how the payment was made.');
    if (modeDef.needsReference && !reference?.trim()) {
        throw new Error(`A ${modeDef.label.toLowerCase()} payment needs a reference number — it is what reconciles the bank statement.`);
    }

    const year = academicYearOf().start;
    const seq = await settings$.nextSequence('receipt');
    const receiptNo = sequenceNumber('NAT/RCP', year, seq);

    const { payment, invoice: nextInvoice, ledgerEntry } = await postPayment({
        invoiceId: invoice.id,
        amount: value,
        mode,
        reference: reference?.trim() || null,
        note: note?.trim() || null,
        paidOn: date,
        receiptNo,
        actor: session.actorId(),
        actorName: session.actorName()
    });

    bus.emit(EVENTS.PAYMENT_RECORDED, { payment, invoice: nextInvoice });
    bus.emit(EVENTS.LEDGER_POSTED, { entry: ledgerEntry });
    return { payment, invoice: nextInvoice };
}

/**
 * Reverses a payment. The original row is kept and marked refunded rather than
 * deleted, and a contra ledger entry is posted rather than the income entry
 * being removed: a receipt handed to a parent must remain findable, and an
 * auditor needs to see the reversal, not an absence.
 */
export async function refundPayment(paymentId, { reason, refundedOn = null }) {
    session.require('fee.refund', 'refund a payment');

    const payment = await payments$.findOrFail(paymentId);
    if (payment.status === PAYMENT_STATUS.REFUNDED) throw new Error('This payment has already been refunded.');
    if (!reason?.trim()) throw new Error('A refund needs a reason.');

    const date = refundedOn || localDate();

    const { payment: nextPayment, invoice: nextInvoice } = await postRefund({
        paymentId,
        reason: reason.trim(),
        refundedOn: date,
        actor: session.actorId()
    });

    bus.emit(EVENTS.PAYMENT_REFUNDED, { payment: nextPayment, invoice: nextInvoice });
    return { payment: nextPayment, invoice: nextInvoice };
}

/**
 * Writes off an invoice — scholarship, hardship, goodwill. Distinct from a
 * discount, which reduces the amount before billing; a waiver forgives money
 * already owed and therefore always needs a reason on record.
 */
export async function waiveInvoice(invoiceId, { reason }) {
    session.require('fee.waive', 'waive fees');

    const invoice = await invoices$.findOrFail(invoiceId);
    if (!reason?.trim()) throw new Error('A waiver needs a reason.');
    if (invoice.status === INVOICE_STATUS.PAID) throw new Error('This invoice is already paid in full.');
    if (invoice.status === INVOICE_STATUS.CANCELLED) throw new Error('This invoice was cancelled.');

    const waived = invoice.balance;

    const updated = await invoices$.update(invoiceId, {
        status: INVOICE_STATUS.WAIVED,
        waivedAmount: waived,
        waiverReason: reason.trim(),
        waivedOn: localDate(),
        waivedBy: session.actorId(),
        balance: 0
    });

    /*
     * A waiver posts an EXPENSE, on the school's instruction.
     *
     * Worth being honest about what that does. This ledger recognises income
     * when money arrives, not when an invoice is raised — so a waived fee was
     * never counted as income in the first place. Posting the write-off as an
     * expense therefore records a cost against income that was never there: the
     * books show -1500 for a fee simply not collected, rather than 0. That is
     * the school's decision, stated twice and explicitly, and it is written
     * down here so nobody later reads it as an oversight and "corrects" it.
     *
     * Posted after the invoice is updated and deliberately not fatal — the
     * waiver is what matters to the family, and a ledger that refuses the
     * posting must not leave an invoice half-waived.
     */
    try {
        // ledger$.create, not finance.service's postEntry(): that requires
        // finance.edit, which a Teacher & Reception holding fee.waive does not
        // have — routing through it would fail the ledger posting for exactly
        // the people most likely to take a waiver. The waive permission checked
        // at the top of this function is the authority here.
        await ledger$.create({
            type: 'expense',
            account: 'Other',
            amount: waived,
            date: localDate(),
            period: monthKey(localDate()),
            narration: `Fee waived — ${invoice.number || 'invoice'} — ${reason.trim()}`,
            branchId: invoice.branchId || null,
            sourceType: 'waiver',
            sourceId: invoiceId
        });
    } catch (err) {
        console.error('The waiver saved, but its ledger entry did not', err);
    }

    return updated;
}

/** Cancels an unpaid invoice raised in error. Paid invoices must be refunded. */
export async function cancelInvoice(invoiceId, { reason }) {
    session.require('fee.collect', 'cancel an invoice');

    const invoice = await invoices$.findOrFail(invoiceId);
    if ((invoice.paidAmount || 0) > 0) {
        throw new Error('Money has been received against this invoice. Refund the receipt first, then cancel.');
    }
    if (!reason?.trim()) throw new Error('Say why this invoice is being cancelled.');

    return invoices$.update(invoiceId, {
        status: INVOICE_STATUS.CANCELLED,
        balance: 0,
        cancelReason: reason.trim(),
        cancelledOn: localDate()
    });

    return next;
}

/* ==========================================================================
   MAINTENANCE & REPORTING READS
   ========================================================================== */

/**
 * Moves open invoices past their due date to overdue. Run at boot rather than
 * on a timer: the app may be closed for a fortnight, and a book that only ages
 * while someone is watching it is wrong every Monday morning.
 */
export async function sweepOverdue() {
    const stale = await invoices$.needingOverdueSweep();
    if (!stale.length) return 0;

    for (const invoice of stale) {
        await invoices$.update(invoice.id, { status: INVOICE_STATUS.OVERDUE });
    }
    return stale.length;
}

/** Shared by studentFeeSummary() and guardianFeeSummary() below — the only difference between the two is how `invoices`/`receipts` were fetched. */
async function summarizeFees(student, invoices, receipts) {
    // Which cycle the student is being billed on, and the one they are in.
    // Outstanding only ever counts invoices that exist, so stating the cycle
    // makes it obvious that nothing ahead has been charged.
    const plan = student?.feePlanId ? await feePlans$.find(student.feePlanId) : null;
    const cadence = billingFrequencyFor(student, plan);
    const currentPeriod = student?.joinedOn
        ? billingPeriod(student.joinedOn, cadence.value, localDate())
        : null;

    const live = invoices.filter((i) => i.status !== INVOICE_STATUS.CANCELLED);
    const billed = live.reduce((s, i) => s + (i.amount || 0), 0);
    const collected = live.reduce((s, i) => s + (i.paidAmount || 0), 0);
    const outstanding = live.reduce((s, i) => s + (i.balance || 0), 0);
    const overdue = live
        .filter((i) => i.balance > 0 && i.dueDate < localDate())
        .reduce((s, i) => s + i.balance, 0);

    const oldest = live
        .filter((i) => i.balance > 0)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] || null;

    const billingCycle = currentPeriod
        ? { label: currentPeriod.label, frequency: cadence.label, key: currentPeriod.key }
        : null;

    return {
        invoices, receipts, billed, collected, outstanding, overdue, billingCycle,
        oldestDue: oldest?.dueDate || null,
        onTrack: outstanding === 0,
        timeline: buildTimeline(live, receipts)
    };
}

/** The complete fee position for one student, as the profile page shows it. */
export async function studentFeeSummary(studentId) {
    const [invoices, receipts, student] = await Promise.all([
        invoices$.forStudent(studentId),
        payments$.forStudent(studentId),
        students$.find(studentId)
    ]);
    return summarizeFees(student, invoices, receipts);
}

/**
 * Milestone P2 (Parent/Student Portal). Same computation as
 * studentFeeSummary(), but sourced from invoices$/payments$'s
 * guardian-scoped forGuardian() (queries by guardianPhone/guardianEmail
 * directly on the invoice/payment documents) rather than a
 * studentId-filtered query — required for firestore.rules to authorize the
 * query at all (see isGuardianOfRecord()'s own comment in firestore.rules).
 * `student` is passed in already-loaded (guardianSession.activeChild()),
 * not re-fetched — the portal never needs a fresh students$ read here.
 */
export async function guardianFeeSummary(phone, email, student) {
    const [allInvoices, allReceipts] = await Promise.all([
        invoices$.forGuardian(phone, email),
        payments$.forGuardian(phone, email)
    ]);
    const invoices = allInvoices.filter((i) => i.studentId === student.id);
    const receipts = allReceipts.filter((p) => p.studentId === student.id);
    return summarizeFees(student, invoices, receipts);
}

/** Invoices and receipts interleaved, newest first — the payment timeline. */
function buildTimeline(invoices, receipts) {
    const events = [
        ...invoices.map((i) => ({
            at: i.issuedOn, kind: 'invoice', title: i.description,
            detail: i.number, amount: i.amount, status: i.status, id: i.id
        })),
        ...receipts.map((p) => ({
            at: p.paidOn,
            kind: p.status === PAYMENT_STATUS.REFUNDED ? 'refund' : 'payment',
            title: p.status === PAYMENT_STATUS.REFUNDED ? `Refunded — ${p.refundReason}` : `Received by ${p.mode}`,
            detail: p.receiptNo, amount: p.amount, status: p.status, id: p.id
        }))
    ];
    return events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

/**
 * Collection position across a date range — the numbers behind the fee
 * dashboard and the collections report.
 */
export async function collectionSummary({ from, to, branchId = null }) {
    const [receipts, outstanding] = await Promise.all([
        payments$.between(from, to, branchId),
        invoices$.outstanding(branchId)
    ]);

    const cleared = receipts.filter((p) => p.status === PAYMENT_STATUS.CLEARED);
    const refunded = receipts.filter((p) => p.status === PAYMENT_STATUS.REFUNDED);
    const today = localDate();

    const ageBuckets = [
        { label: 'Not yet due', test: (i) => i.dueDate >= today },
        { label: '1–30 days',   test: (i) => i.dueDate < today && i.dueDate >= addDays(today, -30) },
        { label: '31–60 days',  test: (i) => i.dueDate < addDays(today, -30) && i.dueDate >= addDays(today, -60) },
        { label: 'Over 60 days',test: (i) => i.dueDate < addDays(today, -60) }
    ].map((bucket) => {
        const rows = outstanding.filter(bucket.test);
        return { label: bucket.label, count: rows.length, amount: rows.reduce((s, i) => s + i.balance, 0) };
    });

    // ---------------------------------------------------------------------
    // v3 FIX — diverges from the reference project on purpose.
    //
    // dashboard.service.js reads `collections.overdueCount` (headline KPI) and
    // `collections.overdue` (money panel). This function never returned
    // either, so both evaluated to `undefined` — falsy — and the dashboard
    // rendered a green "nothing overdue" while every outstanding invoice was
    // past its due date. Confirmed against live data on 2026-08-02: 157
    // overdue invoices totalling Rs 2,83,500, reported as nothing overdue.
    //
    // This is precisely the failure dashboard.service.js's own header warns
    // about — "the dashboard read zero, forever, and nobody noticed for
    // months because a zero looks like an answer."
    //
    // Fixed at the source rather than in the dashboard, because two separate
    // call sites read these fields. `overdue` is defined the same way the
    // ageing buckets already define it (outstanding AND past due), so this
    // figure agrees with `ageing` and with invoices$.overdue() by
    // construction rather than by coincidence.
    //
    // The reference project still carries this bug; see MIGRATION_CHECKLIST.md.
    // ---------------------------------------------------------------------
    const overdueRows = outstanding.filter((i) => i.dueDate < today);

    return {
        collected: cleared.reduce((s, p) => s + p.amount, 0),
        refunded: refunded.reduce((s, p) => s + p.amount, 0),
        receiptCount: cleared.length,
        outstanding: outstanding.reduce((s, i) => s + i.balance, 0),
        outstandingCount: outstanding.length,
        overdue: overdueRows.reduce((s, i) => s + i.balance, 0),
        overdueCount: overdueRows.length,
        byMode: modeBreakdown(cleared),
        ageing: ageBuckets
    };
}

function modeBreakdown(payments) {
    return PAYMENT_MODES
        .map((m) => ({
            mode: m.value,
            label: m.label,
            amount: payments.filter((p) => p.mode === m.value).reduce((s, p) => s + p.amount, 0)
        }))
        .filter((row) => row.amount > 0)
        .sort((a, b) => b.amount - a.amount);
}

/**
 * Everything a printed receipt needs, resolved in one call so the print view
 * has no queries of its own.
 */
export async function receiptData(paymentId) {
    const payment = await payments$.findOrFail(paymentId);
    const [invoice, student, institute] = await Promise.all([
        invoices$.find(payment.invoiceId),
        students$.find(payment.studentId),
        settings$.get('institute', {})
    ]);
    return { payment, invoice, student, institute };
}

/* ------------------------------------------------------------------ HELPERS */

