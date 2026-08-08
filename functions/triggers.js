/**
 * Natyam ERP v3 — Functions — the event-driven half (UAT5 ENH-510)
 *
 * The remaining scenarios happen because a document was written, so they are
 * Firestore triggers rather than scheduled jobs: a payment lands, an
 * application arrives, an announcement is posted.
 *
 * WHY THESE ARE NOT DONE IN THE APP. The client could fire a push at the moment
 * it records a payment, and it would be wrong three ways: the browser can be
 * closed before it finishes, a payment recorded from the desktop would need the
 * same code again, and — decisively — sending to another person's device means
 * reading their subscription, which firestore.rules forbids and should. A
 * trigger runs with admin credentials, once, wherever the write came from.
 *
 * EVERY HANDLER SWALLOWS ITS OWN FAILURE. A push that cannot be sent must never
 * fail the write that triggered it — the receipt matters, the banner does not.
 * Cloud Functions retries a thrown error, which for a notification means
 * sending it twice rather than not at all.
 */

import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { subscriptionsFor, deliver } from './lib/push.js';
import { money } from './lib/time.js';

const db = () => getFirestore();

/* ==========================================================================
   FEES — a payment lands
   ========================================================================== */

/**
 * "We have received ₹1,500."
 *
 * Confirmation to the family, which is the one push in this file they will be
 * pleased to get. Matched to the guardian the same way the reminders are.
 *
 * A refund is deliberately NOT announced this way. Money going back is a
 * conversation someone is already having with the school, and a banner
 * arriving mid-conversation helps nobody.
 */
export async function onPaymentRecorded(payment) {
    if (!payment?.studentId || !(payment.amount > 0)) return;
    if (payment.status === 'refunded') return;

    const studentDoc = await db().collection('students').doc(payment.studentId).get();
    const student = studentDoc.data();
    const email = String(student?.guardianEmail || '').toLowerCase();
    if (!email) return;

    const subs = await subscriptionsFor({ category: 'fees', userIds: [email] });
    if (!subs.length) return;

    await deliver(subs, {
        kind: 'fee',
        category: 'fees',
        title: `Payment received — ${money(payment.amount)}`,
        body: `Thank you. Receipt ${payment.receiptNo || ''} for ${student.name}.`.trim(),
        link: '/#/portal/fees',
        tag: `receipt:${payment.receiptNo || payment.id}`
    });
}

/* ==========================================================================
   ADMISSIONS
   ========================================================================== */

/**
 * A new application reaches the school.
 *
 * Staff only. The family already knows they applied — they pressed the button
 * — and telling them so is the kind of notification that teaches people to
 * ignore notifications.
 */
export async function onAdmissionCreated(admission) {
    if (!admission?.name) return;

    const subs = await subscriptionsFor({
        category: 'admissions',
        branchId: admission.branchId || null
    });
    if (!subs.length) return;

    const fromParent = admission.source === 'parent_portal';

    await deliver(subs, {
        kind: 'admission',
        category: 'admissions',
        title: `New application — ${admission.name}`,
        body: fromParent
            ? `Submitted by the family${admission.preferredBranch ? ` for ${admission.preferredBranch}` : ''}.`
            : 'Taken at the desk.',
        link: '/#/admissions',
        tag: `admission:${admission.id}`
    });
}

/**
 * An application's status moves.
 *
 * TWO AUDIENCES, DIFFERENT WORDS. Staff get the pipeline's own vocabulary;
 * the family gets a sentence about their child. `parentStatusLabel()` in
 * admissions.parent.service.js makes the same distinction on screen and for the
 * same reason — "Reviewing" means nothing from outside the school.
 *
 * Only the two transitions a family should hear about are announced. Moving
 * from submitted to reviewing is internal bookkeeping.
 */
export async function onAdmissionStatusChanged(before, after) {
    if (!after || before?.status === after.status) return;

    const staffSubs = await subscriptionsFor({
        category: 'admissions',
        branchId: after.branchId || null
    });

    if (staffSubs.length) {
        await deliver(staffSubs, {
            kind: 'admission',
            category: 'admissions',
            title: `${after.name} — ${after.status}`,
            body: `Application ${after.applicationNo || ''} moved to ${after.status}.`.trim(),
            link: '/#/admissions',
            tag: `admission-status:${after.id}:${after.status}`
        });
    }

    /*
     * The family, in their own language, and only for outcomes.
     *
     * `approved` is here because ENH-510 asks for "approved/rejected" and it
     * was missed on the first pass. It is a real moment for a family — a place
     * has been offered — even though the pipeline treats it as an intermediate
     * state and the mobile flow now usually skips straight to enrolled.
     *
     * `submitted` and `reviewing` are deliberately absent: from outside the
     * school those two feel identical, and a parent watching a status move
     * between them learns nothing. parentStatusLabel() in
     * admissions.parent.service.js collapses them for the same reason.
     */
    const familyWording = {
        approved: {
            title: `A place has been offered for ${after.name}`,
            body: 'The school will be in touch about joining.'
        },
        enrolled: {
            title: `${after.name} is enrolled`,
            body: 'Sign in to see their classes and fees.'
        },
        rejected: {
            title: `About ${after.name}'s application`,
            body: 'The school has been in touch. Please do contact them.'
        }
    }[after.status];

    const email = String(after.submittedByEmail || '').toLowerCase();
    if (!familyWording || !email) return;

    const familySubs = await subscriptionsFor({ category: 'admissions', userIds: [email] });
    if (!familySubs.length) return;

    await deliver(familySubs, {
        kind: 'admission',
        category: 'admissions',
        ...familyWording,
        link: '/#/',
        tag: `application:${after.id}:${after.status}`,
        // The in-app row belongs to STAFF's notification centre, and the branch
        // above already wrote it. A second copy would show the school a message
        // written for a parent.
        record: false
    });
}

/* ==========================================================================
   SCHEDULE CHANGES
   ========================================================================== */

/**
 * A class is postponed or cancelled.
 *
 * THE MOST TIME-CRITICAL NOTIFICATION IN THE SYSTEM, and the one with the
 * clearest cost of not sending: a family drives to a class that is not
 * happening. It goes to the guardians of the children in that batch and to the
 * teacher, immediately, on the write itself.
 *
 * Both halves of a postponement are covered by one handler. postpone() updates
 * the original to `postponed` AND creates a replacement in the same
 * transaction; only the update is announced, because the replacement's date is
 * on the original's record and one message reading "moved to Saturday" beats
 * two reading "cancelled" and "scheduled".
 *
 * Announcements category, not classes: this is news about the school's
 * schedule, and someone who muted routine class reminders still needs to know
 * their child's lesson is off.
 */
export async function onSessionStatusChanged(before, after) {
    const from = before?.status;
    const to = after?.status;
    if (!to || from === to) return;
    if (to !== 'cancelled' && to !== 'postponed') return;

    const batchDoc = await db().collection('batches').doc(after.batchId || '').get();
    const batch = batchDoc.data();
    if (!batch) return;

    // Where it moved to, for a postponement. Read from the replacement the
    // transaction created, so the message can name the new date rather than
    // telling a parent to go and look.
    let movedTo = null;
    if (to === 'postponed' && after.replacementSessionId) {
        const replacement = await db().collection('classSessions')
            .doc(after.replacementSessionId).get();
        movedTo = replacement.data()?.date || null;
    }

    const cancelled = to === 'cancelled';
    const title = cancelled
        ? `${batch.name} on ${after.date} is cancelled`
        : `${batch.name} moved${movedTo ? ` to ${movedTo}` : ''}`;
    const body = after.reason
        ? String(after.reason)
        : cancelled ? 'There is no class.' : `The class on ${after.date} has been rescheduled.`;

    // The families of the children in that batch.
    const roster = await db().collection('students')
        .where('batchId', '==', after.batchId).get();
    const emails = new Set(
        roster.docs
            .map((d) => d.data())
            .filter((s) => s.status === 'active')
            .map((s) => String(s.guardianEmail || '').trim().toLowerCase())
            .filter(Boolean)
    );

    const subs = await subscriptionsFor({ category: 'announcements' });
    const audience = subs.filter((s) =>
        emails.has(String(s.userId || '').toLowerCase())
        || (batch.teacherId && s.staffId === batch.teacherId));

    if (!audience.length) return;

    await deliver(audience, {
        kind: 'system',
        category: 'announcements',
        title,
        body,
        link: '/#/timetable',
        // Session and the state it reached — a class cancelled then reinstated
        // then cancelled again is three genuinely different pieces of news.
        tag: `session:${after.id || after.batchId}:${after.date}:${to}`
    });
}

/* ==========================================================================
   ANNOUNCEMENTS
   ========================================================================== */

/**
 * An announcement posted from Settings reaches every subscribed device.
 *
 * Triggered on the notification row itself, which announce() has already
 * written — so this one must NOT write another (`record: false`). It is the
 * only handler in this file where the record exists before the push, and the
 * flag exists for exactly this case.
 */
export async function onAnnouncementPosted(row) {
    if (!row?.announcement || !row.title) return;

    const subs = await subscriptionsFor({ category: 'announcements' });
    if (!subs.length) return;

    await deliver(subs, {
        category: 'announcements',
        title: row.title,
        body: row.body || '',
        link: row.link || '/#/notifications',
        tag: `announcement:${row.key || row.id}`,
        record: false
    });

    logger.info('announcement pushed', { devices: subs.length });
}
