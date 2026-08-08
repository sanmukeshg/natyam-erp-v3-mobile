/**
 * Natyam ERP v3 — Functions — the push sender (UAT5 ENH-510, server half)
 *
 * The client half stores a subscription per device; this is the thing that
 * decides a notification is due and calls FCM with it. Between them they are
 * the whole feature — neither does anything alone.
 *
 * THE CONTRACT IS docs/push-notifications.md, and this file implements it
 * rather than reinventing it. Three obligations from that document are load-
 * bearing and each has a function here:
 *
 *   1. Honour `categories`. A device that unticked Fees must never be sent one.
 *   2. Delete tokens FCM rejects. A token nobody prunes is a permanent failed
 *      send on every subsequent run, for ever.
 *   3. Write the in-app notification too. Push is a delivery channel, not the
 *      record — a push with no matching row vanishes when it is dismissed.
 */

// FieldValue is deliberately not imported: serverTimestamp() is the only
// thing it was used for here, and writing one into /notifications is what
// broke the feed. See the note on `createdAt` in record().
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions';

const db = () => getFirestore();

/**
 * Devices that should receive one kind of notification.
 *
 * ONE `array-contains` AND NOTHING ELSE, then filtering in memory. The
 * temptation is to add `.where('branchId', '==', …)` and let Firestore do it,
 * and that would need a composite index per combination — one for
 * category+branch, another for category+role, another for all three — each of
 * which fails at runtime with a console link the first time it is hit, in
 * production, at 7am when the class reminders run.
 *
 * `pushSubscriptions` holds one document per DEVICE, so it is bounded by how
 * many phones the school has, not by students or invoices. Reading the matching
 * slice and filtering it here costs nothing worth an index.
 *
 * @param {object} filter
 * @param {string} filter.category   one of PUSH_CATEGORIES' keys.
 * @param {string[]} [filter.userIds]  match these account emails.
 * @param {string[]} [filter.staffIds] match these staff records — for anything
 *   about a CLASS, which names a staff id and never an email (see ENH-512).
 * @param {string[]} [filter.roles]    match these account roles.
 * @param {string} [filter.branchId]   match this branch, or a device with none.
 */
export async function subscriptionsFor({ category, userIds, staffIds, roles, branchId } = {}) {
    if (!category) throw new Error('A push needs a category.');

    const snap = await db().collection('pushSubscriptions')
        .where('categories', 'array-contains', category)
        .get();

    const wantedUsers = userIds && new Set(userIds.filter(Boolean).map((e) => String(e).toLowerCase()));
    const wantedStaff = staffIds && new Set(staffIds.filter(Boolean));
    const wantedRoles = roles && new Set(roles);

    return snap.docs
        .map((doc) => ({ token: doc.id, ...doc.data() }))
        .filter((sub) => {
            if (wantedUsers && !wantedUsers.has(String(sub.userId || '').toLowerCase())) return false;
            if (wantedStaff && !wantedStaff.has(sub.staffId)) return false;
            if (wantedRoles && !wantedRoles.has(sub.role)) return false;
            // A device on "All branches" (branchId null) hears about every
            // branch — that is what choosing All means, and an owner watching
            // the whole school must not be filtered out of half of it.
            if (branchId && sub.branchId && sub.branchId !== branchId) return false;
            return true;
        });
}

/**
 * Sends to a set of subscriptions and prunes whatever FCM rejects.
 *
 * DATA-ONLY, never a `notification` payload. A `notification` payload makes the
 * browser draw the banner itself and ignore firebase-messaging-sw.js entirely,
 * which loses the icon, the collapse tag and — the one that matters — the deep
 * link that makes tapping it useful.
 *
 * Returns a small summary rather than throwing on partial failure: one dead
 * token must not stop the other nine devices being told their class starts in
 * half an hour.
 */
export async function send(subscriptions, { title, body = '', link = '/', tag, category }) {
    const targets = (subscriptions || []).filter((s) => s.token);
    if (!targets.length) return { sent: 0, failed: 0, pruned: 0 };

    const message = {
        data: {
            title: String(title),
            body: String(body || ''),
            link: String(link || '/'),
            tag: String(tag || category || 'natyam'),
            category: String(category || '')
        },
        webpush: {
            // Survives a closed browser on Android for a day rather than being
            // dropped when the device is offline at the moment of sending.
            headers: { TTL: '86400', Urgency: 'normal' },
            fcmOptions: { link: String(link || '/') }
        }
    };

    let sent = 0;
    let failed = 0;
    const dead = [];

    // sendEach caps at 500 messages per call.
    for (let i = 0; i < targets.length; i += 500) {
        const slice = targets.slice(i, i + 500);
        const response = await getMessaging().sendEach(
            slice.map((sub) => ({ ...message, token: sub.token }))
        );

        response.responses.forEach((result, index) => {
            if (result.success) { sent += 1; return; }
            failed += 1;

            const code = result.error?.code || '';
            // The app was uninstalled, or the token rotated. Anything else —
            // a quota blip, a transient network error — is worth retrying next
            // run and must NOT cost the device its subscription.
            if (code.includes('registration-token-not-registered')
                || code.includes('invalid-registration-token')
                || code.includes('invalid-argument')) {
                dead.push(slice[index].token);
            } else {
                logger.warn('Push failed, token kept', { code, token: slice[index].token.slice(0, 12) });
            }
        });
    }

    if (dead.length) {
        const batch = db().batch();
        dead.forEach((token) => batch.delete(db().collection('pushSubscriptions').doc(token)));
        await batch.commit();
    }

    logger.info('push', { category, tag, sent, failed, pruned: dead.length });
    return { sent, failed, pruned: dead.length };
}

/**
 * The in-app row that outlives the banner.
 *
 * Mirrors notifications.service.js's notify() field for field — same `key`
 * dedupe, same `read: 0`, same shape — because the bell reads these and a row
 * shaped differently by the server would render wrong or not at all. The
 * client's version cannot be reused: it imports the browser SDK and a session.
 *
 * Deduped on `key`, so a reminder that fires twice updates one row instead of
 * stacking two identical ones.
 */
export async function record({ kind = 'system', title, body = null, link = null, key }) {
    const dedupeKey = key || `${kind}:${title}`;
    const existing = await db().collection('notifications')
        .where('key', '==', dedupeKey).limit(1).get();

    if (!existing.empty) {
        const doc = existing.docs[0];
        const changed = doc.data().title !== title || doc.data().body !== body;
        await doc.ref.update({
            title, body, link,
            ...(changed ? { read: 0 } : {}),
            repeatedAt: new Date().toISOString()
        });
        return doc.id;
    }

    const created = await db().collection('notifications').add({
        kind, title, body, link, key: dedupeKey, read: 0,
        at: new Date().toISOString(),
        /*
         * An ISO string, NOT FieldValue.serverTimestamp().
         *
         * serverTimestamp() was the reflex — it is the better clock — and it
         * took the Notifications screen down in both apps. Every other writer
         * of this collection stores `createdAt` as an ISO string and the
         * clients sort it with localeCompare(). A Timestamp reads back as an
         * object, is truthy so the `|| ''` guard never fired, and has no
         * localeCompare — so ONE row written here threw inside Array.sort and
         * took the entire feed down for everyone, not just that row.
         *
         * A more accurate clock is worth nothing against a consistent shape.
         * `at` on the line above is already this process's own time as ISO,
         * and the two have to agree in any case.
         */
        createdAt: new Date().toISOString(),
        createdBy: 'system'
    });
    return created.id;
}

/**
 * The usual pairing: tell the devices, and leave a record behind.
 *
 * Every job and trigger goes through this rather than calling send() alone, so
 * "push is a channel, not the record" is enforced by there being one door
 * rather than by everyone remembering.
 */
export async function deliver(subscriptions, payload) {
    const [result] = await Promise.all([
        send(subscriptions, payload),
        payload.record === false
            ? Promise.resolve(null)
            : record({
                kind: payload.kind || 'system',
                title: payload.title,
                body: payload.body,
                link: payload.link,
                key: payload.tag
            })
    ]);
    return result;
}
