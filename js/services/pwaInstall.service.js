/**
 * Natyam ERP v3 — Mobile — PWA installation
 *
 * Everything the app knows about being installed lives here. No screen, shell
 * or page touches `beforeinstallprompt`, `navigator.standalone` or the
 * service-worker registration API directly — the brief is explicit that "UI
 * must never directly communicate with browser installation APIs", and the
 * practical reason is that those APIs behave differently on every platform.
 * Keeping the differences in one file means a screen asks two questions —
 * should I offer this, and what happened when they said yes — and gets the
 * same answers everywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE PLATFORMS, AND WHY THEY CANNOT SHARE ONE PATH
 *
 *   Android / Chrome   Fires `beforeinstallprompt`, which can be captured and
 *                      replayed later. Real, native installation. Requires a
 *                      service worker with a fetch handler (see sw.js) — this
 *                      event never fires without one.
 *
 *   iOS / Safari       Has no install API at all. Nothing can be triggered
 *                      programmatically; the only route is the user tapping
 *                      Share → Add to Home Screen themselves. So on iOS the
 *                      "Add to Home Screen" button cannot install anything —
 *                      it can only show instructions, which is what the brief
 *                      asks for.
 *
 *   Desktop / other    Chrome desktop fires the event too and installs fine;
 *                      everything else silently does neither, and is treated
 *                      as "not offerable" rather than shown a dialog that
 *                      leads nowhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE EVENT IS CAPTURED AT BOOT, NOT AT SIGN-IN
 *
 * `beforeinstallprompt` fires when the browser decides the app is
 * installable, which is typically within a second or two of load — long
 * before anyone has signed in. It fires ONCE. If nothing is listening at that
 * moment the opportunity is gone for that page load, and calling prompt()
 * later throws. So init() runs at boot and parks the event; the dialog shown
 * after sign-in replays it.
 */

/** How long a "Not now" is respected before the offer may return. */
const REMIND_AFTER_DAYS = 30;

const DISMISSED_KEY = 'natyam.pwa.dismissedAt';
const INSTALLED_KEY = 'natyam.pwa.installed';
/** Session-scoped, so one "Not now" silences it until the app is reopened. */
const SESSION_KEY = 'natyam.pwa.silencedThisSession';

/** The parked `beforeinstallprompt` event, or null. */
let deferredPrompt = null;

/* ==========================================================================
   PLATFORM
   ========================================================================== */

export const PLATFORMS = Object.freeze({ ANDROID: 'android', IOS: 'ios', OTHER: 'other' });

/**
 * iOS detection includes the iPad-on-desktop-UA case: iPadOS 13+ reports
 * itself as a Mac, and the only reliable tell is that a Mac does not have a
 * touch screen. Getting this wrong would show an iPad user a native install
 * button that can never work.
 */
export function platform() {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua)
        || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (iOS) return PLATFORMS.IOS;
    if (/Android/.test(ua)) return PLATFORMS.ANDROID;
    return PLATFORMS.OTHER;
}

/**
 * Is the app already running as an installed app?
 *
 * Two checks because the platforms disagree: `display-mode: standalone` is the
 * standard and works on Android and desktop, while iOS Safari implements only
 * the non-standard `navigator.standalone`. The localStorage flag covers a
 * third case neither reports — an Android user who installed from our own
 * dialog and is still in the browser tab they installed from, where
 * display-mode does not change until they reopen from the home screen.
 */
export function isInstalled() {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (window.matchMedia?.('(display-mode: fullscreen)').matches) return true;
    if (navigator.standalone === true) return true;
    return localStorage.getItem(INSTALLED_KEY) === 'true';
}

/* ==========================================================================
   REMEMBERING THE ANSWER
   ========================================================================== */

function silencedThisSession() {
    return sessionStorage.getItem(SESSION_KEY) === 'true';
}

function dismissedRecently() {
    const at = Number(localStorage.getItem(DISMISSED_KEY) || 0);
    if (!at) return false;
    return (Date.now() - at) < REMIND_AFTER_DAYS * 86400000;
}

/**
 * Records "Not now": silent for the rest of this session, and for
 * REMIND_AFTER_DAYS afterwards.
 *
 * Two layers rather than one because they answer different questions. The
 * session flag stops the dialog reappearing if someone signs out and back in
 * while still using the app, which would read as nagging. The timestamp is
 * what the brief means by "remember the user's choice so it is not displayed
 * on every login" — and it expires, because "not now" is not "never", and a
 * parent's answer in March may differ from their answer in September.
 */
export function remindLater() {
    sessionStorage.setItem(SESSION_KEY, 'true');
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
}

/** Records a completed installation, so nothing is ever offered again. */
export function markInstalled() {
    localStorage.setItem(INSTALLED_KEY, 'true');
    deferredPrompt = null;
}

/* ==========================================================================
   THE DECISION
   ========================================================================== */

/**
 * Should the install dialog be offered right now?
 *
 * Every reason to say no, in the order the brief lists them: already
 * installed, dismissed this session, dismissed recently — plus one the brief
 * does not mention but which matters more than any of them: on Android and
 * desktop, there is nothing to offer unless the browser actually gave us a
 * prompt to replay. Showing "Add to Home Screen" on a browser that cannot
 * install is a button that does nothing.
 *
 * iOS is the deliberate exception: there is never a captured event there, and
 * offering instructions is the only thing that CAN be done, so it is allowed
 * through on platform alone.
 */
export function shouldOffer() {
    if (isInstalled()) return false;
    if (silencedThisSession()) return false;
    if (dismissedRecently()) return false;

    if (platform() === PLATFORMS.IOS) return true;
    return Boolean(deferredPrompt);
}

/**
 * What the "Add to Home Screen" button should actually do — asked by the
 * dialog so it never inspects the platform itself.
 *
 * @returns {'native'|'instructions'}
 */
export function installMethod() {
    return deferredPrompt ? 'native' : 'instructions';
}

/**
 * The iOS steps, as data rather than markup, so the dialog renders them and
 * this file stays free of UI.
 */
export const IOS_STEPS = Object.freeze([
    'Tap the Share button at the bottom of Safari.',
    'Scroll down and choose "Add to Home Screen".',
    'Tap "Add".'
]);

/* ==========================================================================
   ACTIONS
   ========================================================================== */

/**
 * Replays the captured prompt. Only meaningful when installMethod() is
 * 'native'.
 *
 * The event is discarded either way: `beforeinstallprompt` may be replayed
 * exactly once, and calling prompt() on a spent event throws. Clearing it
 * means a second attempt correctly falls back to instructions instead of
 * crashing.
 *
 * @returns {Promise<'accepted'|'dismissed'|'unavailable'>}
 */
export async function promptInstall() {
    if (!deferredPrompt) return 'unavailable';

    const event = deferredPrompt;
    deferredPrompt = null;

    try {
        event.prompt();
        const { outcome } = await event.userChoice;
        if (outcome === 'accepted') markInstalled();
        else remindLater();
        return outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch (err) {
        console.error('The install prompt could not be shown', err);
        return 'unavailable';
    }
}

/* ==========================================================================
   BOOT
   ========================================================================== */

/**
 * Registers the service worker and starts listening for the install event.
 * Called once from app.js at boot — see the header for why this cannot wait
 * until sign-in.
 *
 * Every part of this is best-effort. A failed service-worker registration
 * costs installability and nothing else; it must never stop the app booting,
 * and on an unsupported browser or an insecure origin it will simply not be
 * available.
 */
export function initPWA() {
    window.addEventListener('beforeinstallprompt', (event) => {
        // Without this the browser shows its own mini-infobar, and the app
        // loses the ability to choose when to ask — which is the whole point
        // of waiting until after sign-in.
        event.preventDefault();
        deferredPrompt = event;
    });

    // Fired when installation completes by any route, including the browser's
    // own menu. Recorded so the app never offers something already done.
    window.addEventListener('appinstalled', () => markInstalled());

    if (!('serviceWorker' in navigator)) return;

    // After load, so registration never competes with the app's own boot
    // requests on a slow connection.
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => {
            console.warn('Service worker registration failed — the app will still work, '
                + 'but it will not be installable.', err);
        });
    });
}
