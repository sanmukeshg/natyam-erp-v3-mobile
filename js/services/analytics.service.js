/**
 * NATYAM ERP 2.0 — Analytics service
 *
 * Trends and comparisons, for the analytics dashboard.
 *
 * This service is almost entirely composition: it asks finance for its monthly
 * series, attendance for its trend, fees for its collection summary, and joins
 * the answers. It deliberately does not recompute any of those from the raw
 * stores. If analytics derived revenue its own way, the school would have two
 * revenue numbers that differed by rounding and a fortnight of arguments about
 * which screen was lying.
 *
 * The one thing genuinely computed here is student growth, because no other
 * module needs "how did the roll move month by month" and there was nowhere
 * honest to put it.
 */

import { session } from '../core/session.js';
import { localDate, lastMonths, monthKey, formatMonth, addMonths, startOfMonth, endOfMonth } from '../utils/date.js';
import { students$, admissions$, batches$, invoices$ } from '../data/repositories.js';
import { STUDENT_STATUS, ADMISSION_STATUS, TEACHING_ROLES } from '../config/app.config.js';

// moneyInBreakdown/moneyOutBreakdown are the ledger-derived category splits
// (UAT5 ENH-504 Part 3), reused here for ENH-505's two pies rather than
// recounting the same entries — so a pie and the Finance page can never
// disagree about where the money went.
import {
    monthlySeries, profitAndLoss, branchPerformance as financeByBranch,
    moneyInBreakdown, moneyOutBreakdown
} from './finance.service.js';
import { trend as attendanceTrend, teacherCompliance } from './attendance.service.js';
import { collectionSummary } from './fees.service.js';
import { programSummary, listPrograms } from './programs.service.js';
import { listStaff } from './staff.service.js';
import { listBranches } from './settings.service.js';

/* ==========================================================================
   EXECUTIVE SUMMARY
   ========================================================================== */

/**
 * The half-dozen numbers an owner actually wants, each with the direction of
 * travel. A KPI without a comparison is a number without meaning — "82%
 * attendance" only matters next to last month's 76%.
 */
export async function executiveKPIs(branchId = null, cohort = null) {
    session.require('report.view', 'view analytics');

    const thisMonth = monthKey();
    const lastMonth = monthKey(addMonths(localDate(), -1));

    const [everyoneActive, everyoneEver, growth, revenue, attendance, collection, previousCollection, applications] = await Promise.all([
        students$.active(branchId),
        // ENH-505 asks for Total AND Active students as separate figures. They
        // differ by everyone archived, graduated or left — which for a school
        // in its second year is most of the difference between "how big are we"
        // and "how big have we ever been".
        students$.all(),
        studentGrowth(2, branchId, cohort),
        monthlySeries(2, branchId),
        attendanceTrend(2, branchId),
        collectionSummary({
            from: startOfMonth(localDate()), to: localDate(), branchId
        }),
        collectionSummary({
            from: startOfMonth(addMonths(localDate(), -1)),
            to: endOfMonth(addMonths(localDate(), -1)),
            branchId
        }),
        admissions$.all()
    ]);

    const current = revenue.find((r) => r.period === thisMonth) || { income: 0, net: 0 };
    const previous = revenue.find((r) => r.period === lastMonth) || { income: 0, net: 0 };
    const attendanceNow = attendance.find((a) => a.period === thisMonth)?.rate ?? null;
    const attendanceThen = attendance.find((a) => a.period === lastMonth)?.rate ?? null;
    const joinedNow = growth.at(-1)?.joined ?? 0;
    const joinedThen = growth.at(-2)?.joined ?? 0;

    // Applications received this month and last, dated by when they were made.
    // "New admissions" in ENH-505's wording is the flow into the school, which
    // is applications — enrolments from them land in `joined` above.
    const inMonth = (period) => applications
        .filter((a) => !branchId || a.branchId === branchId)
        // Level narrows an application; batch cannot — see admissionsByMonth().
        .filter((a) => !cohort?.level || a.level === cohort.level)
        .filter((a) => (a.appliedOn || '').startsWith(period)).length;
    const admissionsNow = inMonth(thisMonth);
    const admissionsThen = inMonth(lastMonth);

    // The two student counts follow the cohort; the money ones below cannot,
    // because the ledger has no batch or level on it. resolveCohort()'s note
    // explains why, and the page labels the money panels school-wide.
    const roll = inCohort(cohort, everyoneActive);
    const totalStudents = inCohort(cohort,
        everyoneEver.filter((s) => !branchId || s.branchId === branchId)).length;

    return {
        // ENH-505's eight executive figures, in reading order: how big, how
        // busy, what came in, what went out, what is left, what is owed, who
        // turned up, who is joining.
        total: kpi('Total students', totalStudents, null),
        students: kpi('Active students', roll.length, roll.length - (growth.at(-1)?.opening ?? roll.length)),
        revenue: kpi('Income this month', current.income, current.income - previous.income, 'money'),
        expenses: kpi('Expenses this month', current.expense || 0,
            (current.expense || 0) - (previous.expense || 0), 'money', true),
        net: kpi('Net this month', current.net, current.net - previous.net, 'money'),
        collected: kpi('Collected this month', collection.collected,
            collection.collected - previousCollection.collected, 'money'),
        outstanding: kpi('Outstanding', collection.outstanding,
            collection.outstanding - previousCollection.outstanding, 'money', true),
        attendance: kpi('Attendance this month', attendanceNow,
            attendanceNow === null || attendanceThen === null ? null : attendanceNow - attendanceThen, 'percent'),
        admissions: kpi('New admissions', admissionsNow, admissionsNow - admissionsThen),
        joined: kpi('Joined this month', joinedNow, joinedNow - joinedThen)
    };
}

function kpi(label, value, delta, format = 'number', lowerIsBetter = false) {
    const direction = delta === null || delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down';
    const good = direction === 'flat'
        ? null
        : lowerIsBetter ? direction === 'down' : direction === 'up';

    return { label, value, delta, direction, good, format };
}

/* ==========================================================================
   TRENDS
   ========================================================================== */

/**
 * The roll month by month: who joined, who left, and where the total stood at
 * the end. Leavers are inferred from a status that is no longer active rather
 * than from a deletion, because archiving is a soft delete and a hard-deleted
 * student would silently vanish from history.
 */
export async function studentGrowth(months = 12, branchId = null, cohort = null) {
    const keys = lastMonths(months);
    const all = inCohort(cohort,
        (await students$.all()).filter((s) => !branchId || s.branchId === branchId));

    let running = all.filter((student) => {
        const joined = student.joinedOn || student.createdAt?.slice(0, 10);
        return joined && joined < `${keys[0]}-01`
            && !(student.leftOn && student.leftOn < `${keys[0]}-01`);
    }).length;

    return keys.map((period) => {
        const opening = running;

        const joined = all.filter((s) => (s.joinedOn || s.createdAt?.slice(0, 10) || '').startsWith(period)).length;
        const left = all.filter((s) => (s.leftOn || '').startsWith(period)).length;

        running = opening + joined - left;

        return {
            period,
            label: formatMonth(period),
            opening,
            joined,
            left,
            total: running,
            netChange: joined - left
        };
    });
}

/** Income, expenditure and net by month — read straight from the ledger. */
export async function revenueTrend(months = 12, branchId = null) {
    return monthlySeries(months, branchId);
}

/** Attendance rate by month. */
export async function attendanceTrendSeries(months = 12, branchId = null) {
    const rows = await attendanceTrend(months, branchId);
    return rows.map((row) => ({ ...row, label: formatMonth(row.period) }));
}

/**
 * Billed against collected, month by month. The gap between the two lines is
 * the arrears the school is carrying, which is a more useful thing to look at
 * than either line alone.
 */
export async function collectionTrend(months = 12, branchId = null) {
    const keys = lastMonths(months);
    const invoices = (await invoices$.all()).filter((i) => !branchId || i.branchId === branchId);

    return Promise.all(keys.map(async (period) => {
        const billed = invoices
            .filter((invoice) => (invoice.issuedOn || invoice.dueDate || '').startsWith(period))
            .filter((invoice) => invoice.status !== 'cancelled')
            .reduce((sum, invoice) => sum + (invoice.amount || 0), 0);

        const summary = await collectionSummary({
            from: `${period}-01`,
            to: endOfMonth(`${period}-01`),
            branchId
        });

        return {
            period,
            label: formatMonth(period),
            billed,
            collected: summary.collected,
            gap: billed - summary.collected,
            rate: billed ? Math.round((summary.collected / billed) * 100) : null
        };
    }));
}

/* ==========================================================================
   COMPARISONS
   ========================================================================== */

/** Every branch side by side. */
export async function branchComparison({ from, to }) {
    const [branches, financials] = await Promise.all([
        listBranches(),
        financeByBranch({ from, to })
    ]);

    const byId = new Map(financials.map((row) => [row.branch.id, row]));

    return Promise.all(branches.map(async (branch) => {
        const [roll, batchRows, collection] = await Promise.all([
            students$.active(branch.id),
            batches$.active(branch.id),
            collectionSummary({ from, to, branchId: branch.id })
        ]);

        const financial = byId.get(branch.id) || { income: 0, expense: 0, net: 0, margin: null };

        return {
            branch,
            students: roll.length,
            batches: batchRows.length,
            capacity: batchRows.reduce((sum, b) => sum + (b.capacity || 0), 0),
            occupancy: batchRows.reduce((sum, b) => sum + (b.capacity || 0), 0)
                ? Math.round((roll.length / batchRows.reduce((sum, b) => sum + (b.capacity || 0), 0)) * 100)
                : null,
            collected: collection.collected,
            outstanding: collection.outstanding,
            income: financial.income,
            expense: financial.expense,
            net: financial.net,
            margin: financial.margin
        };
    }));
}

/**
 * Teacher performance, which needs stating carefully: this measures register
 * compliance and the attendance of the classes they teach. It does not measure
 * teaching. A guru with the school's hardest batch will look worse than one
 * with the keenest, and the numbers are presented as prompts for a
 * conversation rather than a ranking.
 */
export async function teacherPerformance({ from, to, branchId = null }) {
    const [staff, compliance] = await Promise.all([
        listStaff(branchId),
        teacherCompliance({ from, to, branchId })
    ]);

    const byTeacher = new Map(compliance.map((row) => [row.teacher.id, row]));

    return staff
        // TEACHING_ROLES — UAT5 ENH-512. Teacher performance is about whoever
        // stands in front of a class, and in this academy that includes the
        // Owner. Literal, she taught every batch and appeared in no comparison.
        .filter((member) => TEACHING_ROLES.includes(member.role))
        .map((member) => {
            const record = byTeacher.get(member.id) || {};
            return {
                staff: member,
                name: member.name,
                batches: member.batchCount,
                students: member.studentCount,
                weeklySessions: member.weeklySessions,
                expected: record.expected ?? 0,
                marked: record.marked ?? 0,
                compliance: record.compliance ?? null
            };
        })
        .sort((a, b) => (b.compliance ?? -1) - (a.compliance ?? -1));
}

/** Programmes by type, participation and financial result. */
export async function programAnalytics(branchId = null, { from = null, to = null } = {}) {
    const [summary, rows] = await Promise.all([
        programSummary(branchId),
        listPrograms(branchId, { from, to })
    ]);

    const completed = rows.filter((program) => program.status === 'completed');

    return {
        ...summary,
        held: completed.length,
        totalIncome: completed.reduce((sum, p) => sum + (p.income || 0), 0),
        totalCost: completed.reduce((sum, p) => sum + (p.expenditure || 0), 0),
        net: completed.reduce((sum, p) => sum + ((p.income || 0) - (p.expenditure || 0)), 0),
        averageCast: completed.length
            ? Math.round(completed.reduce((sum, p) => sum + (p.participantCount || 0), 0) / completed.length)
            : 0,
        byType: summary.byType.map((entry) => {
            const ofType = completed.filter((p) => p.type === entry.type);
            return {
                ...entry,
                net: ofType.reduce((sum, p) => sum + ((p.income || 0) - (p.expenditure || 0)), 0),
                participants: ofType.reduce((sum, p) => sum + (p.participantCount || 0), 0)
            };
        }),
        mostAttended: [...completed]
            .sort((a, b) => (b.participantCount || 0) - (a.participantCount || 0))
            .slice(0, 5)
    };
}

/* ==========================================================================
   FUNNEL
   ========================================================================== */

/**
 * Application to enrolment, as a funnel. The number worth watching is not the
 * conversion rate but the count sitting at "approved" — those are families who
 * have been told yes and are not yet on any register.
 */
export async function admissionFunnel(branchId = null, { months = 6 } = {}) {
    const since = `${lastMonths(months)[0]}-01`;
    const all = (await admissions$.all())
        .filter((a) => !branchId || a.branchId === branchId)
        .filter((a) => (a.appliedOn || '') >= since);

    const count = (status) => all.filter((a) => a.status === status).length;

    const applied = all.length;
    const enrolled = count(ADMISSION_STATUS.ENROLLED);
    const decided = enrolled + count(ADMISSION_STATUS.REJECTED);

    return {
        stages: [
            { key: 'applied', label: 'Applied', value: applied },
            { key: 'reviewing', label: 'In review', value: count(ADMISSION_STATUS.SUBMITTED) + count(ADMISSION_STATUS.REVIEWING) },
            { key: 'approved', label: 'Approved', value: count(ADMISSION_STATUS.APPROVED) },
            { key: 'enrolled', label: 'Enrolled', value: enrolled }
        ],
        conversionRate: decided ? Math.round((enrolled / decided) * 100) : null,
        awaitingEnrolment: count(ADMISSION_STATUS.APPROVED)
    };
}

/* ==========================================================================
   COHORT  (UAT5 ENH-505 filters)
   ========================================================================== */

/**
 * WHICH FILTERS CAN REACH WHICH PANELS, and why it is not all of them.
 *
 * ENH-505 asks for five filters. Two are dimensions every collection carries —
 * Branch is on every document, and a Date Range is just a window — so those
 * narrow the whole page and always did.
 *
 * The other three are not equal:
 *
 *   ACADEMIC YEAR is not a dimension at all. An academic year record is a
 *   `startsOn`/`endsOn` pair, so choosing one IS choosing a date range. It is
 *   offered as a range preset rather than a fourth filter, which means it
 *   reaches every panel for free and cannot disagree with the dates beside it.
 *
 *   BATCH and COURSE are properties of a STUDENT, and the ledger has none.
 *   A ledger entry carries a date, an account, an amount and a branch — there
 *   is no batchId on it and no level, because money arrives against an invoice
 *   or as a bill from a shop, not from a class. So income, expenses, net and
 *   both category splits genuinely cannot be narrowed to one batch.
 *
 * The honest answer is to narrow what can be narrowed and SAY SO for the rest.
 * The alternative — quietly applying the filter to the student panels while
 * the money panels keep showing school-wide totals — produces a page where
 * "Kondapur Senior Batch" sits above ₹26,500 of Utilities, and a reader would
 * be right to conclude that one class spent it.
 *
 * Returns null when nothing is filtered, which every caller treats as "all".
 */
async function resolveCohort({ branchId = null, batchId = null, level = null } = {}) {
    if (!batchId && !level) return null;

    const roll = (await students$.all())
        .filter((s) => !branchId || s.branchId === branchId)
        .filter((s) => !batchId || s.batchId === batchId)
        .filter((s) => !level || s.level === level);

    return {
        batchId,
        level,
        ids: new Set(roll.map((s) => s.id)),
        size: roll.length
    };
}

/** Narrows a list of students to the cohort, or leaves it alone when there is none. */
const inCohort = (cohort, rows, idOf = (r) => r.id) =>
    (cohort ? rows.filter((row) => cohort.ids.has(idOf(row))) : rows);

/* ==========================================================================
   DISTRIBUTION  (UAT5 ENH-505)
   ========================================================================== */

/**
 * Students per batch — the "batch-wise distribution" chart.
 *
 * Counts the ROLL, not the register: a batch's occupancy is who is enrolled in
 * it, and a term of poor attendance must not make a full class look empty.
 * `batches$.withOccupancy()` already computes exactly this for the Batches
 * screen, so this reshapes that rather than counting students again.
 *
 * Unplaced students are a row, not a footnote. A school with thirty students
 * and eleven of them in no batch has a problem the chart should show, and
 * dropping them silently makes the bars add up to a total nobody recognises.
 */
export async function batchDistribution(branchId = null, cohort = null) {
    const [batches, everyone] = await Promise.all([
        batches$.withOccupancy(branchId),
        students$.active(branchId)
    ]);

    const roll = inCohort(cohort, everyone);

    // A cohort recounts the bars from the roll rather than trusting the
    // batch's own `enrolled`: filtered to one level, "Kondapur Senior — 12"
    // must mean twelve students AT THAT LEVEL, not the batch's whole register.
    const countInBatch = (id) => (cohort
        ? roll.filter((s) => s.batchId === id).length
        : null);

    const rows = batches
        .filter((batch) => batch.status === 'active')
        .filter((batch) => !cohort?.batchId || batch.id === cohort.batchId)
        .map((batch) => {
            const count = countInBatch(batch.id) ?? (batch.enrolled || 0);
            return {
                key: batch.id,
                label: batch.name,
                value: count,
                capacity: batch.capacity || null,
                occupancy: batch.capacity ? Math.round((count / batch.capacity) * 100) : null
            };
        })
        .sort((a, b) => b.value - a.value);

    const unplaced = roll.filter((student) => !student.batchId).length;
    if (unplaced) {
        rows.push({ key: 'unplaced', label: 'Not in a batch', value: unplaced, capacity: null, occupancy: null });
    }

    return { rows, total: roll.length, unplaced };
}

/**
 * Applications per month — the "admissions by month" chart.
 *
 * Split by outcome rather than totalled, because the total answers nothing on
 * its own: twelve applications in a month is good news or bad depending on how
 * many became students. `enrolled` counts applications that reached enrolment,
 * dated by when they APPLIED, so a bar says "of the twelve who applied in
 * June, nine enrolled" rather than mixing two months together.
 */
export async function admissionsByMonth(months = 6, branchId = null, cohort = null) {
    const keys = lastMonths(months);
    const since = `${keys[0]}-01`;

    const all = (await admissions$.all())
        .filter((a) => !branchId || a.branchId === branchId)
        .filter((a) => (a.appliedOn || '') >= since)
        // A LEVEL filter applies; a BATCH filter cannot. An application names
        // the level a family is applying for, but no batch — placement happens
        // at enrolment, after this chart's subject has stopped being an
        // application. Filtering by batch here would return nothing and read
        // as "no one applied", which is false.
        .filter((a) => !cohort?.level || a.level === cohort.level);

    return keys.map((period) => {
        const inMonth = all.filter((a) => (a.appliedOn || '').startsWith(period));
        const enrolled = inMonth.filter((a) => a.status === ADMISSION_STATUS.ENROLLED).length;

        return {
            period,
            label: formatMonth(period),
            applied: inMonth.length,
            enrolled,
            rejected: inMonth.filter((a) => a.status === ADMISSION_STATUS.REJECTED).length,
            conversion: inMonth.length ? Math.round((enrolled / inMonth.length) * 100) : null
        };
    });
}

/* ==========================================================================
   INSIGHTS  (UAT5 ENH-505)
   ========================================================================== */

/**
 * The sentences a reader would have had to work out for themselves.
 *
 * COSTS NOTHING. Every insight is derived from panels analyticsOverview() has
 * already fetched — this function issues no query of its own, and that is the
 * design constraint rather than an accident. An "insights" panel that doubled
 * the page's read count to restate figures already on screen would be the most
 * expensive decoration in the app.
 *
 * Each entry carries a `tone` so the page can colour it without re-deciding
 * what is good news, and a `link` where there is somewhere useful to go. An
 * insight nobody can act on is a fact, and facts are what the charts are for.
 */
export function businessInsights({ incomeMix, expenseMix, batches, teachers, growth, collection, kpis }) {
    const out = [];
    const topIncome = incomeMix?.categories?.[0];
    const topExpense = expenseMix?.categories?.[0];

    if (topIncome?.amount) {
        out.push({
            key: 'top-income',
            tone: 'positive',
            title: `${topIncome.category} brings in most of the income`,
            detail: `${topIncome.share}% of everything received in this range.`,
            link: '#/finance'
        });
    }

    if (topExpense?.amount) {
        out.push({
            key: 'top-expense',
            tone: 'neutral',
            title: `${topExpense.category} is the largest cost`,
            detail: `${topExpense.share}% of everything paid out.`,
            link: '#/finance'
        });
    }

    // Fullest batch by occupancy, not by headcount: a class of eight with eight
    // seats is doing better than one of twelve with thirty.
    const fullest = (batches?.rows || [])
        .filter((b) => b.key !== 'unplaced' && b.occupancy !== null)
        .sort((a, b) => b.occupancy - a.occupancy)[0];
    if (fullest) {
        out.push({
            key: 'best-batch',
            tone: 'positive',
            title: `${fullest.label} is the fullest class`,
            detail: `${fullest.value} of ${fullest.capacity} seats taken — ${fullest.occupancy}%.`,
            link: '#/batches'
        });
    }

    if (batches?.unplaced) {
        out.push({
            key: 'unplaced',
            tone: 'caution',
            title: `${batches.unplaced} student${batches.unplaced === 1 ? ' is' : 's are'} in no batch`,
            detail: 'They appear on no register, so their attendance is never taken.',
            link: '#/students'
        });
    }

    // Teachers whose classes are poorly attended. Named as batches to look at
    // rather than as people to blame — the compliance figure beside it is the
    // one that is about the teacher.
    const weak = (teachers || []).filter((t) => (t.attendanceRate ?? 100) < 70);
    if (weak.length) {
        out.push({
            key: 'low-attendance',
            tone: 'caution',
            title: `${weak.length} class group${weak.length === 1 ? '' : 's'} below 70% attendance`,
            detail: weak.slice(0, 3).map((t) => `${t.name} ${t.attendanceRate}%`).join(' · '),
            link: '#/attendance'
        });
    }

    const outstanding = kpis?.outstanding?.value || 0;
    if (outstanding > 0) {
        out.push({
            key: 'outstanding',
            tone: 'caution',
            title: `${formatMoneyPlain(outstanding)} is still to be collected`,
            detail: collection?.at(-1)?.rate !== null && collection?.at(-1)?.rate !== undefined
                ? `Last month ${collection.at(-1).rate}% of what was billed came in.`
                : 'Chase the overdue invoices from Fee collection.',
            link: '#/fees?filter=overdue'
        });
    }

    const last = growth?.at(-1);
    const previous = growth?.at(-2);
    if (last && previous) {
        const change = (last.total || 0) - (previous.total || 0);
        out.push({
            key: 'growth',
            tone: change > 0 ? 'positive' : change < 0 ? 'caution' : 'neutral',
            title: change === 0
                ? 'The roll is level with last month'
                : `The roll is ${change > 0 ? 'up' : 'down'} ${Math.abs(change)} on last month`,
            detail: `${last.joined || 0} joined, ${last.left || 0} left.`,
            link: '#/students'
        });
    }

    return out;
}

/**
 * Paise to a plain rupee string, for insight sentences.
 *
 * utils/money.js is deliberately not imported: this service is byte-identical
 * across both apps and formatting belongs to the view layer everywhere else in
 * it. One sentence needing an inline amount does not justify inverting that.
 */
function formatMoneyPlain(paise) {
    return `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`;
}

/* ==========================================================================
   COMPOSITE
   ========================================================================== */

/**
 * Everything the analytics page needs, resolved in parallel with each panel
 * isolated: one slow or broken panel must not blank the whole dashboard.
 */
export async function analyticsOverview({
    branchId = null, months = 12, from = null, to = null, batchId = null, level = null
} = {}) {
    session.require('report.view', 'view analytics');

    const range = {
        from: from || `${lastMonths(months)[0]}-01`,
        to: to || localDate()
    };

    // Resolved ONCE and handed down — UAT5 ENH-505. Every panel that can
    // honour a batch or course filter needs the same set of student ids, and
    // reading the roll per panel would multiply the app's largest query by
    // four. Null when nothing is filtered, which every callee treats as "all".
    const cohort = await resolveCohort({ branchId, batchId, level });

    const panels = await Promise.allSettled([
        executiveKPIs(branchId, cohort),
        studentGrowth(months, branchId, cohort),
        revenueTrend(months, branchId),
        attendanceTrendSeries(months, branchId),
        collectionTrend(months, branchId),
        branchComparison(range),
        teacherPerformance({ ...range, branchId }),
        programAnalytics(branchId, range),
        admissionFunnel(branchId, { months: 6 }),
        profitAndLoss({ ...range, branchId }),
        // UAT5 ENH-505. The two pies, the batch bars and the admissions bars.
        // Every one of them is a panel of its own so a failure costs one chart
        // rather than the page — the rule this function was already built on.
        moneyInBreakdown({ ...range, branchId }),
        moneyOutBreakdown({ ...range, branchId }),
        batchDistribution(branchId, cohort),
        admissionsByMonth(months, branchId, cohort)
    ]);

    const [
        kpis, growth, revenue, attendance, collection, branches, teachers, programs, funnel, pl,
        incomeMix, expenseMix, batches, admissionsMonthly
    ] = panels.map((panel) => (panel.status === 'fulfilled' ? panel.value : null));

    const failed = panels
        .map((panel, index) => (panel.status === 'rejected' ? PANEL_NAMES[index] : null))
        .filter(Boolean);

    return {
        range, months,
        /*
         * What the cohort filter reached, for the page to declare — ENH-505.
         *
         * `moneyIsSchoolWide` is the important field and it is deliberately
         * not a guess: the ledger has no batch or level, so whenever a cohort
         * is active the money panels below are showing the whole school and
         * the page must say so beside them. See resolveCohort().
         */
        cohort: cohort && {
            batchId: cohort.batchId,
            level: cohort.level,
            size: cohort.size,
            moneyIsSchoolWide: true
        },
        kpis, growth, revenue, attendance, collection,
        branches, teachers, programs, funnel, profitAndLoss: pl,
        incomeMix, expenseMix, batches, admissionsMonthly,
        // Derived, not fetched — see businessInsights(). It reads only what is
        // already in hand, so the sentences cost nothing beyond the charts.
        insights: businessInsights({ incomeMix, expenseMix, batches, teachers, growth, collection, kpis }),
        failed
    };
}

const PANEL_NAMES = [
    'headline figures', 'student growth', 'revenue', 'attendance', 'collection',
    'branches', 'teachers', 'programmes', 'admissions', 'profit and loss',
    'income by category', 'expenses by category', 'batch sizes', 'admissions by month'
];

export { STUDENT_STATUS };
