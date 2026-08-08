/**
 * Natyam ERP v3 — Cloud Functions (UAT5 ENH-510, sender half)
 *
 * The half the client could never do. `push.service.js` in the app registers a
 * device and stores its preferences; nothing there can decide a class starts in
 * thirty minutes, and nothing there may read another person's subscription —
 * firestore.rules forbids listing that collection, deliberately. Both problems
 * need something running with admin credentials on a clock, which is this.
 *
 * WHAT LIVES WHERE
 *   lib/push.js   who to send to, how to send, and pruning dead tokens
 *   lib/time.js   Asia/Kolkata date arithmetic, because a function runs in UTC
 *   jobs.js       the four time-based scenarios (scheduled)
 *   triggers.js   the three event-based ones (Firestore)
 *   this file     nothing but wiring — no logic, so the schedule and the work
 *                 can be read separately
 *
 * REGION. `asia-south1`, confirmed from the live project rather than assumed:
 * Firestore's own location is asia-south1 (Mumbai), and a function in another
 * region pays a cross-continent round trip on every read. These jobs read whole
 * collections, so that is not a rounding error.
 *
 * EVERY SCHEDULE IS Asia/Kolkata. Cloud Scheduler defaults to UTC, which would
 * put the "9am" fee reminder at 2:30pm for the school and the "8pm" attendance
 * sweep at 1:30am.
 *
 * ⚠ THESE SEND REAL NOTIFICATIONS TO REAL PARENTS. Test against the emulator
 * (`npm run serve`) before deploying. See RESUME.md.
 */

import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';

import {
    classReminders as runClassReminders,
    ownerDailyDigest as runOwnerDailyDigest,
    attendanceNudge as runAttendanceNudge,
    attendanceEveningSweep as runAttendanceEveningSweep,
    feeReminders as runFeeReminders,
    payrollReminder as runPayrollReminder,
    holidayReminders as runHolidayReminders,
    eventReminders as runEventReminders
} from './jobs.js';

import {
    onPaymentRecorded as handlePayment,
    onAdmissionCreated as handleAdmissionCreated,
    onAdmissionStatusChanged as handleAdmissionStatus,
    onSessionStatusChanged as handleSessionStatus,
    onAnnouncementPosted as handleAnnouncement
} from './triggers.js';

initializeApp();

setGlobalOptions({
    region: 'asia-south1',
    // One instance is plenty for a school of this size, and capping it is the
    // one line that stops a runaway trigger loop becoming a bill. Raise it when
    // there is evidence it is needed, not before.
    maxInstances: 3,
    memory: '256MiB',
    timeoutSeconds: 120
});

const TZ = 'Asia/Kolkata';

/**
 * Runs a job and never lets it throw.
 *
 * A thrown error makes Cloud Functions RETRY, which for a notification means
 * sending it a second time — worse than not sending it. Failures are logged
 * and swallowed; the next scheduled run is the retry.
 */
const guard = (name, job) => async () => {
    try {
        const result = await job();
        logger.info(`${name} ok`, result || {});
    } catch (err) {
        logger.error(`${name} failed`, { message: err.message, stack: err.stack });
    }
};

/* ==========================================================================
   SCHEDULED
   ========================================================================== */

/**
 * Every five minutes, and the interval is load-bearing.
 *
 * classReminders() matches a five-minute WINDOW — a batch is reminded when it
 * starts between `lead` and `lead + 5` minutes away — so each window is hit by
 * exactly one run. Change this cadence and you change the window with it, or
 * reminders start arriving twice or not at all. See the note in jobs.js.
 */
export const classReminders = onSchedule(
    { schedule: 'every 5 minutes', timeZone: TZ },
    guard('classReminders', runClassReminders)
);

/** Before the working day, so the owner reads it over breakfast. */
export const ownerDailyDigest = onSchedule(
    { schedule: '0 7 * * *', timeZone: TZ },
    guard('ownerDailyDigest', runOwnerDailyDigest)
);

/** Hourly. The job itself only looks at classes that ended 45+ minutes ago. */
export const attendanceNudge = onSchedule(
    { schedule: '0 * * * *', timeZone: TZ },
    guard('attendanceNudge', runAttendanceNudge)
);

/** After the last class, one summary to owners rather than one per batch. */
export const attendanceEveningSweep = onSchedule(
    { schedule: '0 20 * * *', timeZone: TZ },
    guard('attendanceEveningSweep', runAttendanceEveningSweep)
);

/** Morning, once. Deduped on the invoice, so a re-run replaces rather than stacks. */
export const feeReminders = onSchedule(
    { schedule: '0 9 * * *', timeZone: TZ },
    guard('feeReminders', runFeeReminders)
);

/** First of the month. Silent if a salary line already exists for the period. */
export const payrollReminder = onSchedule(
    { schedule: '0 10 1 * *', timeZone: TZ },
    guard('payrollReminder', runPayrollReminder)
);

/**
 * Early evening, the day BEFORE. A closure announced on the morning of the
 * holiday reaches a parent who has already put a child in the car.
 */
export const holidayReminders = onSchedule(
    { schedule: '0 18 * * *', timeZone: TZ },
    guard('holidayReminders', runHolidayReminders)
);

/** Programmes three days out — long enough to arrange a costume. */
export const eventReminders = onSchedule(
    { schedule: '0 18 * * *', timeZone: TZ },
    guard('eventReminders', runEventReminders)
);

/* ==========================================================================
   FIRESTORE TRIGGERS
   ========================================================================== */

/**
 * Same swallow-and-log rule as the jobs, and it matters more here: a retry on
 * a document trigger re-runs the handler against the same write, so a thrown
 * error means the family is thanked for their payment twice.
 */
const guardEvent = (name, handler) => async (event) => {
    try {
        await handler(event);
    } catch (err) {
        logger.error(`${name} failed`, { message: err.message, stack: err.stack });
    }
};

export const onPaymentRecorded = onDocumentCreated(
    'payments/{paymentId}',
    guardEvent('onPaymentRecorded', (event) => {
        const data = event.data?.data();
        return handlePayment({ id: event.params.paymentId, ...data });
    })
);

export const onAdmissionCreated = onDocumentCreated(
    'admissions/{admissionId}',
    guardEvent('onAdmissionCreated', (event) => {
        const data = event.data?.data();
        return handleAdmissionCreated({ id: event.params.admissionId, ...data });
    })
);

export const onAdmissionStatusChanged = onDocumentUpdated(
    'admissions/{admissionId}',
    guardEvent('onAdmissionStatusChanged', (event) => {
        const before = event.data?.before?.data();
        const after = event.data?.after?.data();
        // The handler exits on its own when the status has not moved — an
        // application is updated for many reasons and most are not news.
        return handleAdmissionStatus(before, { id: event.params.admissionId, ...after });
    })
);

/**
 * A class postponed or cancelled — the most time-critical push here, and the
 * one with the clearest cost of not sending: a family drives to a lesson that
 * is not happening. Fires on the write itself rather than on a schedule.
 *
 * `postpone()` updates the original AND creates a replacement in one
 * transaction, so this also sees the replacement's creation — the handler
 * ignores it, because only the status change is news.
 */
export const onSessionStatusChanged = onDocumentUpdated(
    'classSessions/{sessionId}',
    guardEvent('onSessionStatusChanged', (event) => {
        const before = event.data?.before?.data();
        const after = event.data?.after?.data();
        return handleSessionStatus(before, { id: event.params.sessionId, ...after });
    })
);

/**
 * Announcements ride on the notification row `announce()` already writes, so
 * the trigger is on /notifications rather than a collection of its own. The
 * handler ignores every row without `announcement: true`, which is all of the
 * ordinary ones — including the rows these very functions write, so a push
 * cannot trigger a push.
 */
export const onAnnouncementPosted = onDocumentCreated(
    'notifications/{notificationId}',
    guardEvent('onAnnouncementPosted', (event) => {
        const data = event.data?.data();
        return handleAnnouncement({ id: event.params.notificationId, ...data });
    })
);
