/**
 * Natyam ERP v3 — Mobile — Bootstrap
 *
 * Start-up order, each step depending on the last:
 *
 *   1. Paint the theme before anything else, so the first frame is correct.
 *   2. Subscribe once to Firebase's onAuthStateChanged. Its callback is the
 *      single place that decides what a signed-in (or signed-out) Firebase
 *      user means for this app — it runs identically whether a session was
 *      just restored on reload or a sign-in just completed, so there is one
 *      path rather than two that could drift apart.
 *   3. Route the identity to the right experience.
 *
 * THIS APP HAS TWO AUDIENCES, and they are not variants of one another:
 *
 *   - **Staff** — Owner & Accountant and Teacher & Reception — get
 *     MobileShell (bottom tab bar) and the Phase-1 staff modules.
 *     Administrator is turned away: desktop is their surface.
 *   - **Guardians** — parents, and students in a later phase — have no
 *     `users` document at all. They are resolved by a separate identity
 *     lookup and get PortalShell on its own Router instance, because the
 *     staff router's live-status re-check (users$.find) would fail on every
 *     navigation for a session type that has no such record.
 *
 * The guardian half is not wired yet — js/modules/portal/ has not been
 * migrated (see MIGRATION_CHECKLIST.md). The seam where it attaches is
 * marked below so it drops in without reshaping this file.
 *
 * There is no local-database step: v3 is Firestore-only, so nothing needs
 * opening or migrating before sign-in.
 */

import { session } from './core/session.js';
import { router, Router } from './core/router.js';
import { bus, EVENTS } from './core/bus.js';
import { SESSION } from './config/app.config.js';
import { ROUTES } from './config/navigation.js';
import { MobileShell, applyTheme, applyDensity } from './ui/mobileShell.js';
import { PortalShell, PORTAL_NAVIGATION } from './ui/portalShell.js';
import { toast } from './ui/toast.js';
import { watchAuthState } from './core/firebase.js';
import { branches$ } from './data/repositories.js';
import { renderLogin } from './modules/auth/login.page.js';
import { pendingPage } from './modules/system/pending.page.js';
import { resolveProvisionedUser, expireSession, acknowledgeRemoteSignOut } from './services/auth.service.js';
import { resolveGuardianIdentity, guardianSession } from './services/portal/guardianAuth.service.js';

/**
 * The guardian portal's six read-only pages, lazily imported the same way the
 * staff routes are — so a guardian's tab never downloads a staff module and
 * vice versa.
 */
const PORTAL_PAGES = {
    '/portal': () => import('./modules/portal/overview.page.js'),
    '/portal/timetable': () => import('./modules/portal/timetable.page.js'),
    '/portal/attendance': () => import('./modules/portal/attendance.page.js'),
    '/portal/programmes': () => import('./modules/portal/programmes.page.js'),
    '/portal/certificates': () => import('./modules/portal/certificates.page.js'),
    '/portal/fees': () => import('./modules/portal/fees.page.js')
};

/**
 * The portal is carried over from the reference app unchanged (already
 * mobile-first, already read-only), which means it is styled against v2's
 * shell.css / components.css / modules.css rather than v3's glass layer.
 *
 * Those three stylesheets are therefore loaded **only when a guardian session
 * actually starts**, not from index.html. Two reasons: a staff session should
 * not download ~2,800 lines of CSS it never uses, and the two design systems
 * never coexist in one document, so neither can bleed into the other. The
 * cost is one extra round trip at guardian sign-in, which is once per session.
 */
function loadPortalStyles() {
    return Promise.all(['shell', 'components', 'modules'].map((name) => new Promise((resolve) => {
        const href = `assets/css/${name}.css`;
        if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        // Resolve either way: a missing stylesheet should degrade the portal's
        // appearance, never prevent a parent from reading their child's record.
        link.onload = resolve;
        link.onerror = () => { console.error(`Could not load ${href}`); resolve(); };
        document.head.append(link);
    })));
}

/** Staff roles this app serves. Administrator belongs to natyam-admin. */
const MOBILE_STAFF_ROLES = new Set(['owner_accountant', 'teacher_reception']);

const LOGOUT_REASON_KEY = 'natyam.logoutReason';

let appEntered = false;
let pendingLoginMessage = null;

function boot() {
    const prefs = session.prefs();
    applyTheme(prefs.theme);
    applyDensity(prefs.density);

    watchAuthState(handleAuthStateChange);
}

async function handleAuthStateChange(firebaseUser) {
    if (!firebaseUser) {
        if (appEntered) {
            acknowledgeRemoteSignOut().catch(() => {});
            location.reload();
            return;
        }
        session.destroySession();
        showLoginScreen();
        return;
    }

    try {
        const user = await resolveProvisionedUser(firebaseUser);

        if (!MOBILE_STAFF_ROLES.has(user.role)) {
            pendingLoginMessage =
                'Administrator accounts use the Natyam ERP desktop app, not the mobile app. Open the desktop app to sign in.';
            await expireSession().catch(() => {});
            return;
        }

        await hydrateSession(user);
        appEntered = true;
        enterStaffApp();
    } catch (err) {
        // Tried only for a genuinely unrecognised identity (`not_provisioned`,
        // set by auth.service.js) — never for an archived / inactive /
        // method-not-permitted rejection, which is a real staff account being
        // correctly turned away, not "maybe a guardian".
        if (err.code === 'not_provisioned') {
            const guardian = await resolveGuardianIdentity(firebaseUser).catch(() => null);
            if (guardian) {
                guardianSession.hydrate(guardian);
                appEntered = true;
                await enterPortal();
                return;
            }
        }

        // Not provisioned, inactive or archived — and not a guardian either.
        pendingLoginMessage = err.message;
        await expireSession().catch(() => {});
    }
}

function showLoginScreen() {
    document.querySelector('#boot')?.remove();

    const message = pendingLoginMessage;
    pendingLoginMessage = null;
    renderLogin(document.querySelector('#app'), { initialError: message });

    const reason = sessionStorage.getItem(LOGOUT_REASON_KEY);
    if (reason) {
        sessionStorage.removeItem(LOGOUT_REASON_KEY);
        if (reason === 'idle') toast.info('Signed out', 'You were signed out after a period of inactivity.');
    }
}

function enterStaffApp() {
    const root = document.querySelector('#app');
    const shell = new MobileShell(root);
    const viewport = shell.mount();

    registerRoutes();
    router.mount(viewport).start();

    document.querySelector('#boot')?.remove();
    bus.emit(EVENTS.APP_READY);

    bus.on(EVENTS.PREFS_CHANGED, ({ key, value }) => {
        if (key === 'theme') applyTheme(value);
        if (key === 'density') applyDensity(value);
    });

    watchIdleSession();
}

/**
 * The guardian half. Mirrors enterStaffApp()'s structure but mounts
 * PortalShell on a **fresh Router instance** rather than the shared staff
 * `router` singleton — a guardian has no `users` document, so the staff
 * router's own live-status re-check (users$.find) would fail on every single
 * navigation, including the first one, and bounce them straight back to the
 * login screen. This Router supplies guardianSession's own checks instead
 * (see js/core/router.js's pluggable `isAuthenticated` / `revalidate`).
 *
 * No idle-timer and no maintenance sweep: those are staff/ops concerns the
 * portal has no need of.
 */
async function enterPortal() {
    await loadPortalStyles();

    const root = document.querySelector('#app');
    const portalRouter = new Router({
        isAuthenticated: () => guardianSession.isAuthenticated(),
        revalidate: () => guardianSession.stillValid()
    });
    const shell = new PortalShell(root, { router: portalRouter });
    const viewport = shell.mount();

    for (const item of PORTAL_NAVIGATION) {
        portalRouter.register(item.path, { load: PORTAL_PAGES[item.path], title: item.label });
    }

    portalRouter.mount(viewport).start();

    document.querySelector('#boot')?.remove();
    bus.emit(EVENTS.APP_READY);
}

function registerRoutes() {
    for (const route of ROUTES) {
        const load = route.load || (async () => ({ default: pendingPage(route.label) }));

        router.register(route.path, { load, cap: route.cap, title: route.label });

        // Detail routes ride alongside their list route so one page can own
        // both /students and /students/:id. The root is excluded: appending
        // '/:id' to '/' yields a single-segment catch-all that would swallow
        // every top-level path.
        if (route.path !== '/') {
            router.register(`${route.path}/:id`, { load, cap: route.cap, title: route.label });
        }
    }
}

function watchIdleSession() {
    let lastTouch = 0;
    const markActivity = () => {
        const now = Date.now();
        if (now - lastTouch < 15000) return;
        lastTouch = now;
        session.touch();
    };
    // `touchstart` matters here in a way it does not on desktop: a phone user
    // scrolling and tapping generates no mousemove at all, and without it a
    // genuinely active session would time out under their hands.
    ['click', 'keydown', 'touchstart', 'scroll'].forEach((type) =>
        window.addEventListener(type, markActivity, { passive: true }));

    setInterval(() => {
        if (session.isIdleFor(SESSION.idleTimeoutMs)) {
            sessionStorage.setItem(LOGOUT_REASON_KEY, 'idle');
            expireSession().catch((err) => console.error('Idle sign-out failed', err));
        }
    }, 60000);
}

/**
 * @param {object} user  The provisioned Firestore user record (see auth.service.js).
 */
async function hydrateSession(user) {
    // Isolated from resolveProvisionedUser()'s own failure mode on purpose:
    // the caller's catch treats any error as a provisioning rejection, which
    // is wrong for a branches read that merely failed. `user` is known-good
    // here; the person should see the app, degraded, and be told what happened.
    let branches = [];
    try {
        branches = await branches$.active();
    } catch (err) {
        console.error('Could not load branches at sign-in', err);
        toast.error(`Could not load your branches — ${err.message}. Reload to try again.`);
    }

    session.hydrate({ user, branches, activeBranchId: null });
}

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection', event.reason);
    toast?.error?.(event.reason?.message || 'Something failed unexpectedly.');
});

boot();
