/*
 * Natyam ERP v3 — Mobile — Firebase Cloud Messaging worker (UAT5 ENH-510)
 *
 * Handles a push that arrives while the app is CLOSED or in the background.
 * Foreground messages never reach here — Firebase hands those to the page, and
 * push.service.js raises the app's own toast for them instead.
 *
 * WHY THIS IS NOT sw.js. That worker exists solely to make the app installable
 * and caches nothing on purpose, with a header explaining at length why adding
 * anything to it would be a mistake. Firebase's background handler needs the
 * compat SDK loaded with importScripts and its own registration scope, and
 * putting a CDN dependency inside the one file whose value is having none would
 * undo that reasoning. Two workers, two jobs, neither surprising.
 *
 * THE COMPAT BUILD, NOT THE MODULAR ONE. A service worker registered without
 * `type: 'module'` cannot use `import`, and registering it as a module is not
 * supported everywhere this app runs. `firebase-app-compat` is what the
 * modular SDK's own documentation uses here, and it is loaded only inside this
 * worker — the app itself is modular throughout.
 *
 * ⚠ THE CONFIG BELOW IS DUPLICATED from js/config/firebase.config.js and has to
 * be. A service worker starts before any application code and cannot import an
 * ES module, so there is nowhere to read it from. These values are public (see
 * that file's header) and change only if the Firebase project itself changes;
 * if they ever do, both copies move together.
 */

/* eslint-env serviceworker */
/* global importScripts, firebase */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: 'AIzaSyBe9j-coHJiOdUI13vLh7qbhRUVRFtPTx4',
    authDomain: 'natyam-erp.firebaseapp.com',
    projectId: 'natyam-erp',
    storageBucket: 'natyam-erp.firebasestorage.app',
    messagingSenderId: '121454206538',
    appId: '1:121454206538:web:61367aba482a677554d0b3'
});

const messaging = firebase.messaging();

/**
 * A background push.
 *
 * The sender is expected to use a DATA payload rather than `notification`, and
 * the difference matters: a `notification` payload makes the browser draw the
 * banner itself, ignoring everything below — the icon, the tag, and the link
 * that makes tapping it useful. With data only, this handler owns the
 * presentation and the app stays consistent with itself.
 *
 * `tag` collapses repeats. Three overdue-fee reminders for the same invoice
 * should replace one another rather than stack into a wall of identical
 * banners; the sender controls that by reusing a tag.
 */
messaging.onBackgroundMessage((payload) => {
    const data = payload?.data || {};
    const title = data.title || payload?.notification?.title || 'Natyam';

    self.registration.showNotification(title, {
        body: data.body || payload?.notification?.body || '',
        // The manifest's own 192px icon — the one already installed on the
        // home screen, so a banner looks like the app it came from.
        icon: '/assets/icons/icon-192.png',
        badge: '/assets/icons/icon-48.png',
        tag: data.tag || data.category || 'natyam',
        // The route to open, carried through the tap below. Relative, so the
        // same payload works on both hosting domains.
        data: { link: data.link || '/' }
    });
});

/**
 * Tapping a notification.
 *
 * FOCUSES AN OPEN TAB RATHER THAN OPENING A SECOND ONE. A parent tapping a fee
 * reminder while the app is already open in the background should land in the
 * app they have, mid-session, not in a fresh copy that has to sign in again.
 * Only when nothing is open does this open a window.
 */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const link = event.notification?.data?.link || '/';

    event.waitUntil((async () => {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

        for (const client of clientList) {
            if ('focus' in client) {
                // navigate() can reject on a cross-origin client; focusing is
                // the part that matters and must not be lost to that.
                await client.navigate(link).catch(() => {});
                return client.focus();
            }
        }
        return self.clients.openWindow(link);
    })());
});
