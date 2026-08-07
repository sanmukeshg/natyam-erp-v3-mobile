/**
 * Natyam ERP v3 — Mobile — Web push (UAT5 ENH-510, client half)
 *
 * ⚠ THIS HALF CANNOT DELIVER A NOTIFICATION ON ITS OWN, and that is the agreed
 * scope rather than an unfinished job. Web push has two sides:
 *
 *   THIS FILE            asks the browser for permission, obtains an FCM
 *                        registration token for the device, stores it with the
 *                        person's category and timing preferences, and handles
 *                        a message that arrives while the app is open.
 *
 *   A SENDER, NOT BUILT  something server-side that decides a notification is
 *                        due and calls FCM with these tokens. Class reminders
 *                        need a schedule ("thirty minutes before"), which no
 *                        client can honour while closed — that is the whole
 *                        point of push. See docs/push-notifications.md for the
 *                        exact contract the Cloud Function has to meet.
 *
 * So: enabling push here is real and durable — the token is stored, the
 * preferences are stored, and the moment a sender exists every device already
 * enabled starts receiving. Until then a message only arrives if something
 * sends one, which today means a manual test from the Firebase Console.
 *
 * The in-app Notifications module is untouched and remains the thing that
 * actually works: notifications.service.js writes to /notifications and the
 * bell shows them. Push is an additional delivery channel for the same events,
 * never a replacement for the record.
 *
 * EVERY FAILURE PATH IS NON-FATAL. A browser without push, a user who declines,
 * an unconfigured VAPID key, a token request that times out — none of these may
 * break a screen. The app worked before push existed and must keep working for
 * everyone who never turns it on.
 */

import { session } from '../core/session.js';
import { pushSubscriptions$ } from '../data/repositories.js';
import { firebaseConfig, vapidKey } from '../config/firebase.config.js';
import { nowISO } from '../utils/date.js';

/**
 * The notification categories a person may choose between — ENH-510's list,
 * grouped the way someone thinks about their own day rather than by which
 * module emits them.
 *
 * `key` is the contract with the sender: a Cloud Function decides a fee
 * reminder is due, and delivers it only to subscriptions whose `categories`
 * include 'fees'. Adding a category here is half a change; the other half is
 * the sender learning to emit it.
 *
 * `roles` narrows who is even offered the choice. A Teacher & Reception has no
 * business being asked whether they want payroll reminders, and an empty list
 * means everyone.
 */
export const PUSH_CATEGORIES = Object.freeze([
    { key: 'classes',      label: 'Class reminders',
      help: 'Before a class you are teaching, and the day’s classes for owners.', roles: [] },
    { key: 'attendance',   label: 'Attendance',
      help: 'A reminder to mark the register, and a nudge when one is still missing.', roles: [] },
    { key: 'fees',         label: 'Fees',
      help: 'Due and overdue reminders, and confirmation when a payment lands.', roles: [] },
    { key: 'admissions',   label: 'Admissions',
      help: 'A new application, and when one is approved or enrolled.', roles: [] },
    { key: 'finance',      label: 'Finance and payroll',
      help: 'Payroll due, and anything needing approval.',
      roles: ['administrator', 'owner_accountant'] },
    { key: 'announcements', label: 'Announcements',
      help: 'Academy notices, holidays, schedule changes and events.', roles: [] }
]);

/** How far ahead a class reminder arrives. */
export const REMINDER_LEADS = Object.freeze([
    { value: 15, label: '15 minutes before' },
    { value: 30, label: '30 minutes before' },
    { value: 60, label: '1 hour before' },
    { value: 120, label: '2 hours before' }
]);

const DEFAULTS = Object.freeze({
    categories: ['classes', 'attendance', 'fees', 'admissions', 'announcements'],
    leadMinutes: 30
});

/* ==========================================================================
   CAPABILITY
   ========================================================================== */

/**
 * Whether this browser can do web push at all.
 *
 * Three separate requirements, and they genuinely differ by platform: iOS
 * Safari gained `PushManager` only in 16.4 and only for an app added to the
 * Home Screen, so a perfectly modern iPhone in the browser reports false here.
 * The settings screen says which one is missing rather than a flat "not
 * supported", because "install the app first" is an instruction and "not
 * supported" is a dead end.
 */
export function pushSupport() {
    const hasServiceWorker = 'serviceWorker' in navigator;
    const hasPush = 'PushManager' in window;
    const hasNotification = 'Notification' in window;

    // iOS only exposes PushManager to an installed PWA. Detecting the platform
    // is unreliable; detecting the capability is not — if PushManager is
    // missing but the other two are present on a touch device, standalone mode
    // is the thing that changes the answer.
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches
        || window.navigator.standalone === true;

    return {
        supported: hasServiceWorker && hasPush && hasNotification,
        hasServiceWorker,
        hasPush,
        hasNotification,
        standalone,
        configured: Boolean(vapidKey),
        permission: hasNotification ? Notification.permission : 'unsupported',
        // The one sentence the UI shows when it cannot offer the switch.
        reason: !hasNotification || !hasServiceWorker
            ? 'This browser does not support notifications.'
            : !hasPush
                ? (standalone
                    ? 'This browser does not support push notifications.'
                    : 'Add Natyam to your Home Screen first — iPhone only allows notifications for an installed app.')
                : !vapidKey
                    ? 'Push is not configured for this school yet.'
                    : null
    };
}

/* ==========================================================================
   SUBSCRIPTION
   ========================================================================== */

let messagingPromise = null;

/**
 * The Firebase Messaging SDK, imported only when someone actually enables push.
 *
 * A dynamic import, not a top-level one: this is another CDN module on a cold
 * start, and the overwhelming majority of sessions never touch push. Nobody
 * pays for a feature they have not switched on.
 */
async function messaging() {
    if (!messagingPromise) {
        messagingPromise = import('https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging.js')
            .then(async (sdk) => {
                const supported = await sdk.isSupported().catch(() => false);
                if (!supported) return null;
                const { app } = await import('../core/firebase.js');
                return { sdk, instance: sdk.getMessaging(app) };
            })
            .catch((err) => {
                console.error('Firebase Messaging could not be loaded', err);
                return null;
            });
    }
    return messagingPromise;
}

/**
 * Registers the messaging service worker.
 *
 * SEPARATE FROM sw.js, and deliberately. That worker exists to make the app
 * installable and caches nothing on purpose (see its header); Firebase's
 * background handler needs its own scope and its own compat imports, and
 * merging the two would put a CDN dependency inside the file whose entire
 * value is that it has none.
 */
async function messagingWorker() {
    return navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' });
}

/**
 * Turns push on for this device.
 *
 * Asks the browser, gets a token, stores it against the signed-in account.
 * Returns `{ ok, reason }` rather than throwing — declining a permission
 * prompt is a normal answer, not an error, and the caller renders it as one.
 */
export async function enablePush({ categories = DEFAULTS.categories, leadMinutes = DEFAULTS.leadMinutes } = {}) {
    const support = pushSupport();
    if (!support.supported || !support.configured) {
        return { ok: false, reason: support.reason || 'Push is not available here.' };
    }
    if (!session.isAuthenticated()) {
        return { ok: false, reason: 'Sign in before turning on notifications.' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        return {
            ok: false,
            reason: permission === 'denied'
                // A denied permission cannot be re-prompted; only the browser's
                // own site settings can undo it, so say that rather than
                // offering a button that will silently do nothing.
                ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
                : 'Notifications were not enabled.'
        };
    }

    const fcm = await messaging();
    if (!fcm) return { ok: false, reason: 'This browser cannot receive push notifications.' };

    try {
        const registration = await messagingWorker();
        const token = await fcm.sdk.getToken(fcm.instance, {
            vapidKey,
            serviceWorkerRegistration: registration
        });
        if (!token) return { ok: false, reason: 'No notification token was issued. Try again.' };

        await pushSubscriptions$.save(token, {
            userId: session.actorId(),
            userName: session.actorName(),
            role: session.role(),
            branchId: session.branch(),
            // Which staff record, where there is one — a class reminder is for
            // the person teaching the batch, and the batch names a staff id
            // (see ENH-512). Without this a sender cannot tell whose class it is.
            staffId: session.staffId || null,
            categories: [...categories],
            leadMinutes,
            enabled: true,
            userAgent: navigator.userAgent.slice(0, 200),
            updatedAt: nowISO()
        });

        listenInForeground(fcm);
        return { ok: true, token };
    } catch (err) {
        console.error('Could not enable push notifications', err);
        return { ok: false, reason: `Notifications could not be enabled — ${err.message}` };
    }
}

/**
 * Turns push off for this device, and only this device.
 *
 * The token is deleted rather than flagged: a stale token that a sender still
 * holds is how someone who switched notifications off keeps receiving them,
 * and "enabled: false" left in the database is a filter every future sender
 * has to remember. Deleting removes the possibility.
 */
export async function disablePush() {
    const fcm = await messaging();
    if (!fcm) return { ok: true };

    try {
        const registration = await navigator.serviceWorker.getRegistration('/firebase-cloud-messaging-push-scope');
        const token = await fcm.sdk.getToken(fcm.instance, { vapidKey, serviceWorkerRegistration: registration })
            .catch(() => null);

        if (token) {
            await pushSubscriptions$.remove(token).catch((err) =>
                console.error('The push token was revoked locally but not removed from the database', err));
            await fcm.sdk.deleteToken(fcm.instance).catch(() => {});
        }
        return { ok: true };
    } catch (err) {
        console.error('Could not fully disable push', err);
        return { ok: false, reason: `Could not turn notifications off — ${err.message}` };
    }
}

/** Changes categories or timing without re-asking permission. */
export async function updatePushPreferences({ categories, leadMinutes }) {
    const current = await currentSubscription();
    if (!current) return { ok: false, reason: 'Notifications are not on for this device.' };

    await pushSubscriptions$.save(current.id, {
        ...current,
        categories: categories ? [...categories] : current.categories,
        leadMinutes: leadMinutes ?? current.leadMinutes,
        updatedAt: nowISO()
    });
    return { ok: true };
}

/**
 * This device's subscription, if it has one.
 *
 * Asks the browser for its token and looks that up, rather than listing the
 * account's subscriptions and guessing which is "this one" — a person may have
 * the app on a phone, a tablet and a desktop, and the settings screen must
 * describe the device in front of them.
 */
export async function currentSubscription() {
    if (!pushSupport().supported || Notification.permission !== 'granted') return null;

    const fcm = await messaging();
    if (!fcm) return null;

    try {
        const registration = await navigator.serviceWorker.getRegistration('/firebase-cloud-messaging-push-scope');
        if (!registration) return null;

        const token = await fcm.sdk.getToken(fcm.instance, { vapidKey, serviceWorkerRegistration: registration });
        if (!token) return null;

        const row = await pushSubscriptions$.find(token);
        return row ? { ...row, id: token } : null;
    } catch {
        return null;
    }
}

/**
 * Messages that arrive while the app is open.
 *
 * The browser does NOT show a notification for these — a foreground push is
 * handed to the page instead, on the reasonable grounds that interrupting
 * someone with a banner for something already on their screen is rude. So this
 * raises the app's own toast, which is also what makes a push feel like part of
 * the app rather than an OS artefact.
 */
let foregroundBound = false;
function listenInForeground(fcm) {
    if (foregroundBound) return;
    foregroundBound = true;

    fcm.sdk.onMessage(fcm.instance, (payload) => {
        const { title, body } = payload?.notification || {};
        if (!title) return;
        // Imported lazily: this module is loaded by the settings screen, and a
        // static import would drag the toast host into that graph for a
        // callback that may never fire.
        import('../ui/toast.js').then(({ toast }) => toast.info(title, body || ''));
    });
}

/**
 * Re-attaches the foreground listener on boot for a device already enabled.
 *
 * Cheap and silent: it does nothing at all unless permission is already
 * granted and a token already exists, so a person who has never enabled push
 * pays one synchronous property read.
 */
export async function resumePush() {
    if (!pushSupport().supported || Notification.permission !== 'granted') return;
    const fcm = await messaging();
    if (fcm) listenInForeground(fcm);
}

export { DEFAULTS as PUSH_DEFAULTS };
