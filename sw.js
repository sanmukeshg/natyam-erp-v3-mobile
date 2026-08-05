/**
 * Natyam ERP v3 — Mobile — Service worker
 *
 * THIS FILE EXISTS TO MAKE THE APP INSTALLABLE, and does deliberately little
 * else. Chrome will not fire `beforeinstallprompt` — and so will never offer
 * "Add to Home Screen" — unless the page controls a service worker with a
 * `fetch` handler. That requirement is the entire reason this file was added
 * in Stage 5; without it, PWAInstallService has nothing to work with on
 * Android.
 *
 * IT CACHES NOTHING, ON PURPOSE.
 *
 * The obvious next step — precache the shell, serve cache-first — would be
 * actively harmful here, and the reasons are specific rather than
 * precautionary:
 *
 *  - firebase.json sends `Cache-Control: no-cache` for every .js, .css and
 *    index.html in this app. That is a deliberate choice by this project: the
 *    school deploys often and a stale bundle in a parent's browser is a
 *    support call nobody can reproduce. A cache-first worker would override
 *    that decision from inside the browser, which is exactly where it is
 *    hardest to notice and hardest to clear.
 *
 *  - Every screen in this app reads live Firestore data behind security
 *    rules. An offline shell that renders with no data is not a working app;
 *    it is a blank app that looks broken, and it would hide the honest
 *    "could not load" states the services already produce.
 *
 * So the fetch handler passes everything straight through to the network. It
 * is a no-op by design, not an unfinished implementation. If genuine offline
 * support is ever wanted it belongs in its own milestone, with a versioned
 * cache, an explicit update flow and a decision about which data may be
 * shown stale — none of which should be improvised inside an install feature.
 *
 * skipWaiting + clients.claim so a newly deployed worker takes over
 * immediately rather than waiting for every tab to close. Safe precisely
 * because nothing is cached: there is no old bundle for a new worker to keep
 * serving.
 */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

/**
 * Required for installability, intentionally transparent. `respondWith` is
 * not called at all — returning nothing lets the browser handle the request
 * exactly as it would with no worker registered, which is the cheapest
 * possible pass-through and avoids the classic bug of proxying every request
 * through fetch() and breaking range requests, redirects and streaming.
 */
self.addEventListener('fetch', () => {
    // Deliberately empty. See the header.
});
