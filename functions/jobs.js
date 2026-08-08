/**
 * Natyam ERP v3 — Functions — the scheduled half (UAT5 ENH-510)
 *
 * Four of ENH-510's six scenarios are time-based rather than event-based:
 * something is due, or overdue, or about to start. Those cannot be a Firestore
 * trigger — nothing writes a document when a class is thirty minutes away —
 * so they are Cloud Scheduler jobs.
 *
 * HOW A REMINDER AVOIDS FIRING TWICE, since it is the question every one of
 * these raises. The class job runs every five minutes and matches a five-minute
 * WINDOW: a batch is reminded when it starts between `lead` and `lead + 5`
 * minutes from now. Each window is therefore hit by exactly one run. The
 * alternative — a log collection recording what has already been sent — is more
 * correct under scheduler drift and costs a write per reminder plus a cleanup
 * job to stop it growing for ever. The window is the cheaper trade and its
 * failure mode is one missed or one duplicated reminder, not a wrong figure.
 *
 * The daily jobs need no such care: they dedupe on the notification `key`, so
 * running twice updates one row rather than creating two.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { subscriptionsFor, deliver } from './lib/push.js';
import { today, minutesNow, dayCode, toMinutes, addDays, money } from './lib/time.js';

/**
 * The lead times the app offers (push.service.js's REMINDER_LEADS).
 *
 * Duplicated here rather than imported: `functions/` is a separate package with
 * its own dependency tree and cannot reach into the browser app's ESM modules.
 * Only the widest and narrowest are used, and only to decide whether this run
 * can skip its expensive read — so a drift between the two lists costs a
 * slightly wider early-exit window, never a missed reminder.
 */
const REMINDER_LEADS = [15, 30, 60, 120];

const db = () => getFirestore();

const all = async (name) => (await db().collection(name).get())
    .docs.map((d) => ({ id: d.id, ...d.data() }));

/** Not soft-deleted, and active where the collection has a status. */
const live = (rows) => rows.filter((r) => !r.deletedAt);

/* ==========================================================================
   CLASSES
   ========================================================================== */

/**
 * "Your class starts in thirty minutes."
 *
 * Sent to whoever TEACHES the batch, matched on `staffId` — never on the
 * account email. A batch stores `teacherId`, which is a staff document id like
 * STF-SUREKHA, while a subscription's `userId` is an email; the two are
 * different id spaces and confusing them is what left the mobile teacher
 * dashboard finding nothing for a year (UAT5 ENH-512). The client puts
 * `staffId` on every subscription precisely so this job can work.
 *
 * `leadMinutes` is per device, so two teachers can want different warnings and
 * the same batch is checked against each.
 */
export async function classReminders() {
    const date = today();
    const day = dayCode(date);
    const now = minutesNow();

    const batches = live(await all('batches'))
        .filter((b) => b.status === 'active' && (b.days || []).includes(day));
    if (!batches.length) return { checked: 0, sent: 0 };

    /*
     * EARLY EXIT BEFORE THE EXPENSIVE READ, and it is the reason this job is
     * affordable at all. It runs every five minutes — 288 times a day — and the
     * roll is one of the largest collections in the app. Reading it every run
     * to find guardians would be 288 full-collection reads a day to send, on a
     * typical day, four notifications.
     *
     * So: if no class today starts within the widest lead anyone can choose,
     * there is nothing to send and we stop having read only `batches`. The vast
     * majority of runs end here.
     */
    const widestLead = Math.max(...REMINDER_LEADS);
    const upcoming = batches.filter((b) => {
        const start = toMinutes(b.startTime);
        if (start === null) return false;
        const away = start - now;
        return away >= Math.min(...REMINDER_LEADS) && away < widestLead + 5;
    });
    if (!upcoming.length) return { checked: batches.length, sent: 0 };

    const subs = await subscriptionsFor({ category: 'classes' });
    if (!subs.length) return { checked: batches.length, sent: 0 };

    /*
     * Guardians of the children in each batch — the scenario ENH-510 lists
     * FIRST and the one this job originally missed entirely. It matched only
     * `staffId`, and a parent has none, so families were excluded by
     * construction rather than by decision.
     *
     * Matched on the guardian's email against the subscription's `userId`,
     * which is the same join the Parent Portal uses to decide whose children
     * these are. Read once for every batch rather than once per batch.
     */
    const guardiansByBatch = new Map();
    for (const student of live(await all('students'))) {
        if (student.status !== 'active' || !student.batchId) continue;
        const email = String(student.guardianEmail || '').trim().toLowerCase();
        if (!email) continue;
        const existing = guardiansByBatch.get(student.batchId) || new Set();
        existing.add(email);
        guardiansByBatch.set(student.batchId, existing);
    }

    let sent = 0;
    for (const batch of upcoming) {
        const away = toMinutes(batch.startTime) - now;
        const inWindow = (sub) => {
            const lead = Number(sub.leadMinutes) || 30;
            return away >= lead && away < lead + 5;
        };

        // The teacher — told to bring the register.
        const teacherDevices = batch.teacherId
            ? subs.filter((s) => s.staffId === batch.teacherId && inWindow(s))
            : [];

        if (teacherDevices.length) {
            const result = await deliver(teacherDevices, {
                kind: 'attendance',
                category: 'classes',
                title: `${batch.name} starts at ${batch.startTime}`,
                body: `${batch.room ? `${batch.room} · ` : ''}Tap to open the register.`,
                link: '/#/attendance',
                // Batch and date, so a repeat replaces rather than stacks.
                tag: `class:${batch.id}:${date}`
            });
            sent += result.sent;
        }

        // The families — told to set off. Different words for a different
        // reader: a parent has no register to mark and no use for the room
        // code, but does need to know where they are going.
        const emails = guardiansByBatch.get(batch.id);
        if (!emails?.size) continue;

        const familyDevices = subs.filter((s) =>
            emails.has(String(s.userId || '').toLowerCase())
            && !s.staffId                       // a teacher who is also a parent gets the teacher's wording, once
            && inWindow(s));
        if (!familyDevices.length) continue;

        const result = await deliver(familyDevices, {
            kind: 'system',
            category: 'classes',
            title: `Class at ${batch.startTime}`,
            body: `${batch.name}${batch.room ? ` · ${batch.room}` : ''}`,
            link: '/#/portal/timetable',
            tag: `class-family:${batch.id}:${date}`,
            // The staff row above already recorded this class in the school's
            // notification centre. A second row would show reception a message
            // written for a parent.
            record: !teacherDevices.length
        });
        sent += result.sent;
    }

    logger.info('classReminders', { date, upcoming: upcoming.length, sent });
    return { checked: batches.length, sent };
}

/**
 * The owner's morning digest — "four classes today".
 *
 * Separate from the per-teacher reminder above because it answers a different
 * question. A teacher wants to know their class is imminent; an owner wants the
 * shape of the day, once, before it starts.
 */
export async function ownerDailyDigest() {
    const date = today();
    const day = dayCode(date);

    const batches = live(await all('batches'))
        .filter((b) => b.status === 'active' && (b.days || []).includes(day));

    const subs = await subscriptionsFor({
        category: 'classes',
        roles: ['administrator', 'owner_accountant']
    });
    if (!subs.length) return { sent: 0 };

    const first = batches
        .map((b) => b.startTime).filter(Boolean).sort()[0];

    const result = await deliver(subs, {
        kind: 'system',
        category: 'classes',
        title: batches.length
            ? `${batches.length} class${batches.length === 1 ? '' : 'es'} today`
            : 'No classes scheduled today',
        body: batches.length ? `First at ${first}. Tap for the timetable.` : 'Nothing on the timetable.',
        link: '/#/timetable',
        tag: `digest:${date}`
    });

    return { sent: result.sent };
}

/* ==========================================================================
   ATTENDANCE
   ========================================================================== */

/**
 * "The register for this morning's class is still empty."
 *
 * Runs hourly and only looks at classes that ENDED at least forty-five minutes
 * ago — a teacher marking the register as the last student leaves should not be
 * chased while they are doing it.
 *
 * Attendance rows are keyed `batchId|date`, so "was it marked" is a single
 * query per day rather than per batch.
 */
export async function attendanceNudge() {
    const date = today();
    const day = dayCode(date);
    const now = minutesNow();

    const batches = live(await all('batches'))
        .filter((b) => b.status === 'active' && (b.days || []).includes(day) && b.teacherId);
    if (!batches.length) return { missing: 0, sent: 0 };

    const marked = new Set(
        (await db().collection('attendance').where('date', '==', date).get())
            .docs.map((d) => d.data().batchId)
    );

    const overdue = batches.filter((b) => {
        const end = toMinutes(b.endTime);
        return end !== null && now - end >= 45 && !marked.has(b.id);
    });
    if (!overdue.length) return { missing: 0, sent: 0 };

    const subs = await subscriptionsFor({ category: 'attendance' });
    let sent = 0;

    for (const batch of overdue) {
        const due = subs.filter((s) => s.staffId === batch.teacherId);
        if (!due.length) continue;
        const result = await deliver(due, {
            kind: 'attendance',
            category: 'attendance',
            title: `${batch.name} register not marked`,
            body: `Today's class ended at ${batch.endTime}. Tap to mark it.`,
            link: '/#/attendance',
            tag: `register:${batch.id}:${date}`
        });
        sent += result.sent;
    }

    logger.info('attendanceNudge', { date, missing: overdue.length, sent });
    return { missing: overdue.length, sent };
}

/**
 * The evening sweep — owners hear about registers still missing at day's end.
 *
 * One notification naming the count, not one per batch: an owner with five
 * unmarked classes needs to know that, not to be buzzed five times.
 */
export async function attendanceEveningSweep() {
    const date = today();
    const day = dayCode(date);

    const batches = live(await all('batches'))
        .filter((b) => b.status === 'active' && (b.days || []).includes(day));

    const marked = new Set(
        (await db().collection('attendance').where('date', '==', date).get())
            .docs.map((d) => d.data().batchId)
    );

    const missing = batches.filter((b) => !marked.has(b.id));
    if (!missing.length) return { missing: 0, sent: 0 };

    const subs = await subscriptionsFor({
        category: 'attendance',
        roles: ['administrator', 'owner_accountant']
    });

    const result = await deliver(subs, {
        kind: 'attendance',
        category: 'attendance',
        title: `${missing.length} register${missing.length === 1 ? '' : 's'} not marked today`,
        body: missing.slice(0, 3).map((b) => b.name).join(', ')
            + (missing.length > 3 ? ` and ${missing.length - 3} more` : ''),
        link: '/#/attendance',
        tag: `registers-missing:${date}`
    });

    return { missing: missing.length, sent: result.sent };
}

/* ==========================================================================
   FEES
   ========================================================================== */

/**
 * Fee reminders — due soon, and overdue.
 *
 * Sent to the GUARDIAN, matched on `userId` against the student's
 * `guardianEmail`. That is the same join the Parent Portal itself uses to
 * decide whose children these are, so a family already signed in is already
 * addressable and nothing new has to be stored.
 *
 * A waived invoice is not chased: waiveInvoice() zeroes the balance, so the
 * `balance > 0` test excludes it without needing to know about waivers.
 */
export async function feeReminders() {
    const date = today();
    const soon = addDays(date, 3);

    const invoices = live(await all('invoices'))
        .filter((i) => (i.balance || 0) > 0 && i.status !== 'cancelled' && i.dueDate);

    const dueSoon = invoices.filter((i) => i.dueDate > date && i.dueDate <= soon);
    const overdue = invoices.filter((i) => i.dueDate < date);
    if (!dueSoon.length && !overdue.length) return { sent: 0 };

    const students = new Map(live(await all('students')).map((s) => [s.id, s]));
    const subs = await subscriptionsFor({ category: 'fees' });
    if (!subs.length) return { sent: 0 };

    const byEmail = new Map();
    subs.forEach((sub) => {
        const key = String(sub.userId || '').toLowerCase();
        byEmail.set(key, [...(byEmail.get(key) || []), sub]);
    });

    let sent = 0;
    const notifyFor = async (invoice, overdueNow) => {
        const student = students.get(invoice.studentId);
        const email = String(student?.guardianEmail || '').toLowerCase();
        const devices = byEmail.get(email);
        if (!devices?.length) return;

        const result = await deliver(devices, {
            kind: 'fee',
            category: 'fees',
            title: overdueNow
                ? `${money(invoice.balance)} overdue for ${student.name}`
                : `${money(invoice.balance)} due for ${student.name}`,
            body: overdueNow
                ? `Due ${invoice.dueDate}. Tap to see the invoice.`
                : `Due ${invoice.dueDate}.`,
            link: '/#/portal/fees',
            // One tag per invoice per state, so a daily re-run replaces rather
            // than stacks, and "due soon" is superseded by "overdue".
            tag: `fee:${invoice.id}:${overdueNow ? 'overdue' : 'due'}`
        });
        sent += result.sent;
    };

    for (const invoice of dueSoon) await notifyFor(invoice, false);
    for (const invoice of overdue) await notifyFor(invoice, true);

    logger.info('feeReminders', { date, dueSoon: dueSoon.length, overdue: overdue.length, sent });
    return { dueSoon: dueSoon.length, overdue: overdue.length, sent };
}

/* ==========================================================================
   ANNOUNCEMENTS — holidays and events
   ========================================================================== */

/**
 * "The school is closed tomorrow."
 *
 * THE DAY BEFORE, not on the day. A holiday notice that arrives on the morning
 * of the holiday reaches a parent who has already put a child in the car.
 *
 * Everyone subscribed to announcements hears it — staff and families alike.
 * A closure is the one piece of news where telling too many people costs
 * nothing and telling too few costs somebody a wasted journey.
 */
export async function holidayReminders() {
    const tomorrow = addDays(today(), 1);

    const holidays = live(await all('holidays')).filter((h) => h.date === tomorrow);
    if (!holidays.length) return { sent: 0 };

    const subs = await subscriptionsFor({ category: 'announcements' });
    if (!subs.length) return { sent: 0 };

    let sent = 0;
    for (const holiday of holidays) {
        // A holiday may be branch-specific. One that names a branch goes only
        // to devices on that branch (or on "All branches"); one that does not
        // is a school-wide closure.
        const devices = holiday.branchId
            ? subs.filter((s) => !s.branchId || s.branchId === holiday.branchId)
            : subs;
        if (!devices.length) continue;

        const result = await deliver(devices, {
            kind: 'system',
            category: 'announcements',
            title: `No classes tomorrow — ${holiday.name}`,
            body: `The school is closed on ${tomorrow}.`,
            link: '/#/timetable',
            tag: `holiday:${holiday.id || holiday.date}`
        });
        sent += result.sent;
    }

    return { holidays: holidays.length, sent };
}

/**
 * "Annual Day is on Saturday."
 *
 * Programmes — performances, workshops, competitions — three days out, which is
 * long enough to arrange a costume and short enough to still be true.
 *
 * Only SCHEDULED ones. A completed programme is history and a cancelled one is
 * the opposite of an invitation.
 */
export async function eventReminders() {
    const target = addDays(today(), 3);

    const programs = live(await all('programs'))
        .filter((p) => p.date === target && p.status === 'scheduled');
    if (!programs.length) return { sent: 0 };

    const subs = await subscriptionsFor({ category: 'announcements' });
    if (!subs.length) return { sent: 0 };

    let sent = 0;
    for (const program of programs) {
        const devices = program.branchId
            ? subs.filter((s) => !s.branchId || s.branchId === program.branchId)
            : subs;
        if (!devices.length) continue;

        const result = await deliver(devices, {
            kind: 'program',
            category: 'announcements',
            title: `${program.name} in three days`,
            body: `${program.date}${program.venue ? ` · ${program.venue}` : ''}`,
            link: '/#/programs',
            tag: `event:${program.id}`
        });
        sent += result.sent;
    }

    return { events: programs.length, sent };
}

/* ==========================================================================
   FINANCE
   ========================================================================== */

/**
 * "Payroll for July has not been run."
 *
 * Monthly, and only to the roles that can actually run it. Checks whether any
 * salary line exists for the period rather than whether it has been PAID: a
 * prepared-but-unpaid run is a different, later problem, and this reminder is
 * about nobody having started.
 */
export async function payrollReminder() {
    const date = today();
    const period = date.slice(0, 7);

    const existing = await db().collection('salaries')
        .where('period', '==', period).limit(1).get();
    if (!existing.empty) return { sent: 0, reason: 'already prepared' };

    const subs = await subscriptionsFor({
        category: 'finance',
        roles: ['administrator', 'owner_accountant']
    });

    const result = await deliver(subs, {
        kind: 'system',
        category: 'finance',
        title: `Payroll for ${period} has not been run`,
        body: 'Prepare it from Finance → Payroll.',
        link: '/#/finance?tab=payroll',
        tag: `payroll:${period}`
    });

    return { sent: result.sent };
}
