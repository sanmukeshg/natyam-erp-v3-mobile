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
import { PublicShell, PUBLIC_ROUTES } from './ui/publicShell.js';
import { ApplicantShell, APPLICANT_ROUTES } from './ui/applicantShell.js';
import { applicantSession } from './services/admissions.parent.service.js';
import { hasParentProfile } from './services/parent.service.js';
import { initPWA, shouldOffer } from './services/pwaInstall.service.js';
import { toast } from './ui/toast.js';
import { watchAuthState } from './core/firebase.js';
import { branches$, staff$ } from './data/repositories.js';
import { renderLogin } from './modules/auth/login.page.js';
import { pendingPage } from './modules/system/pending.page.js';
import { resolveProvisionedUser, expireSession, acknowledgeRemoteSignOut } from './services/auth.service.js';
import { resolveGuardianIdentity, guardianSession } from './services/portal/guardianAuth.service.js';
import { isReadTimeout } from './data/firestoreRead.js';

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
    '/portal/fees': () => import('./modules/portal/fees.page.js'),
    '/portal/profile': () => import('./modules/portal/profile.page.js')
};


/** Staff roles this app serves. Administrator belongs to natyam-admin. */
const MOBILE_STAFF_ROLES = new Set(['owner_accountant', 'teacher_reception']);

const LOGOUT_REASON_KEY = 'natyam.logoutReason';

let appEntered = false;
let pendingLoginMessage = null;

function boot() {
    const prefs = session.prefs();
    applyTheme(prefs.theme);
    applyDensity(prefs.density);

    // Registers the service worker and starts listening for
    // `beforeinstallprompt`. It has to happen HERE rather than after sign-in:
    // the browser fires that event once, within a second or two of load, and
    // if nothing is listening at that moment the chance to install is gone for
    // the whole page load. The dialog shown after sign-in replays what this
    // captured. See pwaInstall.service.js.
    initPWA();

    // Subscribed once, here, rather than called from each of the three
    // signed-in shells (staff, portal, applicant) — they all emit APP_READY
    // when they finish mounting, and `appEntered` is what distinguishes a
    // real session from the login screen. One subscription means a fourth
    // experience added later gets this for free and cannot forget it.
    bus.on(EVENTS.APP_READY, () => {
        if (appEntered) offerInstallAfterSignIn();
    });

    watchAuthState(handleAuthStateChange);
}

/**
 * Offers the install dialog once, shortly after someone signs in.
 *
 * AFTER sign-in, not at boot, because the brief asks for it there and the
 * reasoning holds: a stranger who has not signed in has no reason to want the
 * app on their home screen, and an unprompted dialog on first contact is the
 * kind of thing people dismiss reflexively — spending the one good chance to
 * ask. Someone who has just signed in has demonstrated they intend to come
 * back.
 *
 * The one-second delay lets the shell paint first, so the dialog arrives over
 * a recognisable app rather than a loading screen.
 *
 * Every reason not to show it — already installed, dismissed this session,
 * dismissed recently, or a browser that cannot install at all — is decided by
 * shouldOffer(), not here. This function only chooses the moment.
 *
 * Deliberately not awaited by its caller: whether a dialog appears must never
 * gate mounting the app.
 */
function offerInstallAfterSignIn() {
    setTimeout(async () => {
        if (!shouldOffer()) return;
        try {
            const { showInstallPrompt } = await import('./ui/installPrompt.js');
            await showInstallPrompt();
        } catch (err) {
            console.error('The install prompt could not be shown', err);
        }
    }, 1000);
}

async function handleAuthStateChange(firebaseUser) {
    if (!firebaseUser) {
        if (appEntered) {
            acknowledgeRemoteSignOut().catch(() => {});
            // Someone who was signed in and now is not should come back to
            // the login screen, not to the public home page — signing out of
            // the staff app is not the same act as arriving as a visitor, and
            // Stage 1 must not change what signing out does. The reload below
            // loses every in-memory flag, so the reason has to survive in
            // sessionStorage; an existing one is left alone because the idle
            // watch sets its own ('idle') just before triggering this path,
            // and it carries a message this one does not.
            if (!sessionStorage.getItem(LOGOUT_REASON_KEY)) {
                sessionStorage.setItem(LOGOUT_REASON_KEY, 'signed_out');
            }
            location.reload();
            return;
        }
        session.destroySession();

        // Stage 1: a signed-out visitor now lands on the Public Experience
        // rather than straight on the login screen — that screen is reached
        // from the shell's "Sign in", or shown directly below when there is
        // something to say.
        //
        // The exception is deliberate and load-bearing. A `pendingLoginMessage`
        // means a real identity was just turned away (an Administrator on
        // mobile, an archived or deactivated account, a method not permitted
        // for that user), and expireSession() has brought us back here to say
        // so. Dropping that person on a marketing home page would silently
        // swallow the only explanation they get for why they cannot get in.
        // The sign-in screen is the app's front door, for everyone.
        //
        // Stage 1 briefly made the Public Experience the default landing for a
        // signed-out visitor, with the login screen behind a "Sign in" button.
        // Reverted 2026-08-05 on the school's instruction: the approved
        // navigation is Splash → Landing → Get Started → Login, and dropping
        // people onto an Apply/Enquiry screen before they had signed in was
        // not what they wanted a returning parent or a staff member to meet.
        //
        // The public informational screens (About, Courses, Branches, Batch
        // Timings, Founder) are still built and still routable — they are just
        // no longer the entry point, and nothing links to them at present. See
        // enterPublicApp() below, which is retained deliberately rather than
        // deleted, pending a decision on where that content should hang.
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

            // Stage 3's third identity, and the last one this app recognises:
            // signed in with Google, no `users` document, and matching no
            // active student's guardian contact. That is a PROSPECTIVE parent
            // — someone who tapped Apply Now — not a rejection.
            //
            // Order matters and is not arbitrary. The guardian check runs
            // first because an existing parent who applies again must land on
            // their own dashboard, which is exactly what the brief's decision
            // flow asks ("Is Parent Linked To Student? YES → Open Existing
            // Parent Dashboard"). Only once that has failed is the identity
            // genuinely new to the school.
            //
            // Nothing is hydrated into `session` or `guardianSession`: an
            // applicant has neither a role nor a child, and borrowing either
            // of those session objects would give them a shape the rest of the
            // app would misread. The Firebase user is all the identity there
            // is, and it is passed straight to the shell.
            appEntered = true;
            await enterApplicantApp(firebaseUser);
            return;
        }

        // Not provisioned, inactive or archived — and not a guardian either.
        pendingLoginMessage = err.message;
        await expireSession().catch(() => {});
    }
}

/**
 * The Public Experience — the app's front door for anyone not signed in.
 *
 * Mounts PublicShell on its OWN Router instance, for the same reason
 * enterPortal() does: the shared staff `router` singleton re-checks a `users`
 * document on every navigation, which a visitor with no Firebase identity at
 * all does not have. Both of that Router's pluggable checks are supplied as
 * constants here — a public route needs no session to enter and no session to
 * stay in, so there is genuinely nothing to re-validate.
 *
 * No idle timer either: there is no session to expire.
 */
function enterPublicApp() {
    const root = document.querySelector('#app');
    const publicRouter = new Router({
        isAuthenticated: () => true,
        revalidate: () => Promise.resolve(true)
    });

    const shell = new PublicShell(root, {
        router: publicRouter,
        // Which screen replaces the public app is a bootstrap decision, so it
        // is made here rather than inside the shell — same division every
        // other shell in this file keeps.
        onSignIn: () => showLoginScreen({ fromPublic: true })
    });
    const viewport = shell.mount();

    for (const route of PUBLIC_ROUTES) {
        publicRouter.register(route.path, { load: route.load, title: route.label });
    }

    // The app bar's title and back affordance follow the route. Subscribed
    // here rather than inside the shell so the shell stays a rendering
    // component with no opinion about routing events it does not own.
    bus.on(EVENTS.ROUTE_DONE, ({ path }) => shell.paintFor(path));

    publicRouter.mount(viewport).start();
    shell.paintFor(publicRouter.path());

    document.querySelector('#boot')?.remove();
    bus.emit(EVENTS.APP_READY);
}

/**
 * The prospective-parent experience (Stage 3). Mounts ApplicantShell on its
 * own Router, for the same reason enterPortal() and enterPublicApp() do: the
 * staff router re-reads a `users` document on every navigation, and this
 * identity has none.
 *
 * `isAuthenticated` asks Firebase directly rather than consulting a session
 * object, because there isn't one — an applicant's whole identity is the
 * signed-in Firebase user. `revalidate` is constant: there is no role to lose
 * and no child to be unlinked from, so nothing can invalidate this session
 * except signing out, which Firebase's own listener already handles.
 *
 * @param {object} firebaseUser
 */
async function enterApplicantApp(firebaseUser) {
    const root = document.querySelector('#app');

    // Hydrated before any page mounts. The router does not carry identity in
    // page context, so the applicant screens read it from here — the same
    // arrangement guardianSession has for the portal.
    const identity = applicantSession.hydrate({
        email: firebaseUser.email,
        name: firebaseUser.displayName
    }).identity();

    const applicantRouter = new Router({
        isAuthenticated: () => Boolean(firebaseUser),
        revalidate: () => Promise.resolve(true)
    });

    const shell = new ApplicantShell(root, { router: applicantRouter, identity });
    const viewport = shell.mount();

    for (const route of APPLICANT_ROUTES) {
        applicantRouter.register(route.path, { load: route.load, title: route.label });
    }

    bus.on(EVENTS.ROUTE_DONE, ({ path }) => shell.paintFor(path));

    // Welcome-vs-straight-in is decided HERE, once, before the first render —
    // not inside a page, and not by the shell. It is the same principle the
    // identity chain follows: one place decides, everything downstream just
    // renders.
    //
    // Note what this does NOT do. It does not choose which EXPERIENCE the
    // person gets; that was already settled above by staff → guardian →
    // applicant. Anyone reaching this function has no linked student, so a
    // parent profile here means "we have met before" and nothing more — see
    // parent.service.js for why a profile is deliberately not a key to the
    // Parent Dashboard.
    //
    // Only ever redirects from the root. A parent who followed a link
    // straight to /apply keeps going there; interrupting a deliberate
    // destination with a greeting would be worse than skipping it.
    const known = await hasParentProfile(identity);
    if (!known && (!window.location.hash || applicantRouter.path() === '/')) {
        applicantRouter.go('/welcome', { replace: true });
    }

    applicantRouter.mount(viewport).start();
    shell.paintFor(applicantRouter.path());

    document.querySelector('#boot')?.remove();
    bus.emit(EVENTS.APP_READY);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.fromPublic]  True when the visitor chose "Sign in"
 *   from the public shell — they came from somewhere and need a way back, so
 *   the login screen offers one. A rejection or a sign-out reaches this screen
 *   with nothing behind it and gets no such link.
 */
function showLoginScreen({ fromPublic = false } = {}) {
    document.querySelector('#boot')?.remove();

    const message = pendingLoginMessage;
    pendingLoginMessage = null;
    renderLogin(document.querySelector('#app'), {
        initialError: message,
        onBack: fromPublic ? () => enterPublicApp() : null
    });

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

    /*
     * Re-attach the push listener for a device already enabled — UAT5 ENH-510.
     *
     * AFTER the app is on screen, and unawaited. A foreground push handler is
     * worth having and worth nothing at boot time, so it must not sit in front
     * of the first paint; the dynamic import inside it also means the Messaging
     * SDK is fetched only on a device that has actually turned push on.
     * resumePush() returns immediately for everyone else.
     */
    import('./services/push.service.js')
        .then(({ resumePush }) => resumePush())
        .catch((err) => console.error('Push could not resume', err));

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
    // loadPortalStyles() is gone (Stage 7). The portal was the last thing in
    // this app pulling v2's shell.css/components.css/modules.css, and it now
    // renders in the same v3 language as every other shell — so there is
    // nothing left to lazily fetch, and no way for those stylesheets to creep
    // back in behind one screen.
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

    // Every portal route is under /portal — there is deliberately nothing
    // registered at '/'. But Router.start() replaces an empty hash with '#/',
    // so a guardian signing in resolved a path no route matched and met
    // "There is no page at /" instead of their child's overview. On every
    // single sign-in.
    //
    // Redirecting before start() rather than registering a second route at
    // '/': the portal's own navigation, its back behaviour and every link it
    // renders all assume the /portal prefix, and adding a duplicate root entry
    // would give the overview two addresses that behave subtly differently.
    //
    // Only from the root, so a guardian following a deep link to
    // /portal/fees still lands on fees.
    if (!window.location.hash || portalRouter.path() === '/') {
        portalRouter.go('/portal', { replace: true });
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
        // Two sentences were being glued into one. A timed-out read now carries
        // a full sentence of its own ("This is taking longer than expected —
        // branches did not respond."), and dropping that inside this one gave a
        // second em-dash clause and a doubled full stop. A stall gets its own
        // short wording; anything else keeps its detail, minus the trailing
        // stop it may already have.
        toast.error(isReadTimeout(err)
            ? 'Could not load your branches — the connection stalled. Reload to try again.'
            : `Could not load your branches — ${String(err.message || 'unexpected error').replace(/\.\s*$/, '')}. Reload to try again.`);
    }

    /*
     * The staff record behind this account — UAT5 ENH-512.
     *
     * Resolved HERE, once, for the same reason every other identity question
     * is: one place decides, everything downstream just reads. `users` are
     * keyed by email and `staff` by a business code (STF-SUREKHA), and a batch
     * stores the staff code — so nothing holding only session.actorId() could
     * ever find the batches a person teaches. Not hypothetical: on this
     * school's live data the mobile teacher dashboard asked
     * byTeacher('…@gmail.com') and got zero of five batches back, so a teacher
     * signing in saw no classes and no pending registers at all.
     *
     * Failure is swallowed on purpose. An Administrator has no staff record and
     * never will, which is normal; and a lookup that fails should cost someone
     * their class list, not their sign-in.
     */
    let staffId = null;
    try {
        staffId = (await staff$.byUserEmail(user?.id))?.id || null;
    } catch (err) {
        console.error('Could not resolve the staff record for this account', err);
    }

    session.hydrate({ user, branches, activeBranchId: null, staffId });
}

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection', event.reason);
    toast?.error?.(event.reason?.message || 'Something failed unexpectedly.');
});

boot();
