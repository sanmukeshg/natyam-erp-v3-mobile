/**
 * NATYAM ERP 2.0 — Router
 *
 * Hash-based, because the deployment target is GitHub Pages: there is no server
 * to rewrite deep links, so `/students/STU-123` would 404 on refresh while
 * `#/students/STU-123` will not.
 *
 * Over 1.0 this adds:
 *   - Lazy module loading. A page is downloaded and parsed the first time it is
 *     opened, not on boot. Boot goes from "parse every module" to "parse the
 *     shell and the dashboard".
 *   - Path parameters and query strings, so a student detail view is a real
 *     URL that can be bookmarked and shared between tabs.
 *   - Guards, so an unauthorised route redirects rather than rendering and then
 *     erroring.
 *   - Deterministic teardown, and cancellation of a navigation the user has
 *     already moved on from.
 */

import { bus, EVENTS } from './bus.js';
import { session } from './session.js';
import { html, render, raw } from '../utils/dom.js';
import { icon } from '../ui/icons.js';
import { expireSession } from '../services/auth.service.js';
import { users$ } from '../data/repositories.js';

/**
 * The staff router's own live-status re-check — re-reads the caller's
 * `users` doc on every navigation so a deactivation/archive elsewhere ends
 * an open session immediately (see resolve()'s own comment). Extracted so a
 * second Router instance (Milestone P1's Parent/Student Portal) can supply
 * its own revalidation instead — a guardian has no `users` doc at all, so
 * this exact check would fail every navigation for that session type.
 */
async function defaultRevalidate() {
    const current = await users$.find(session.user.id).catch(() => null);
    return Boolean(current && current.status === 'active');
}

class Router {
    /**
     * @param {object} [options]
     * @param {Function} [options.revalidate]  async () => boolean, re-checked
     *   on every navigation. Defaults to the staff users-doc live-status
     *   check so the existing `router` singleton below is unchanged.
     * @param {Function} [options.isAuthenticated]  () => boolean, checked at
     *   the top of every navigation. Defaults to the shared staff `session`
     *   singleton — the same object `revalidate` was already made pluggable
     *   for, but this check itself was missed when the Parent/Student Portal
     *   (Milestone P1) added a second Router instance: a guardian session
     *   lives entirely in `guardianSession` (js/services/portal/
     *   guardianAuth.service.js), never in this staff-only `session` — so
     *   `session.isAuthenticated()` is permanently false for a guardian,
     *   and every single portal navigation, including the very first one
     *   `enterPortal()` triggers, was silently treated as "not signed in,"
     *   signing the guardian back out and reloading straight to the login
     *   screen. Confirmed 2026-07-28 against a real guardian sign-in that
     *   got all the way through resolveGuardianIdentity() and enterPortal()
     *   only to bounce straight back.
     */
    constructor({ revalidate = defaultRevalidate, isAuthenticated = () => session.isAuthenticated() } = {}) {
        this.routes = [];
        this.viewport = null;
        this.current = null;
        this.currentPage = null;
        this.navigationId = 0;
        this.scrollPositions = new Map();
        this.returningToList = false;
        this.notFound = null;
        this.revalidate = revalidate;
        this.isAuthenticated = isAuthenticated;
    }

    /**
     * @param {string} pattern  e.g. '/students' or '/students/:id'
     * @param {object} options
     * @param {Function} options.load       Dynamic import returning { default } or a page factory.
     * @param {string}  [options.cap]       Capability required to enter.
     * @param {string}  [options.title]
     */
    register(pattern, options) {
        this.routes.push({
            pattern,
            ...options,
            matcher: compile(pattern),
            shape: shapeOf(pattern)
        });

        // Kept in specificity order so matching never depends on the order
        // routes happened to be registered in. A single misplaced ':param'
        // route used to shadow every static route registered after it, and the
        // failure was invisible: the shadowing route rendered perfectly well,
        // just for the wrong URL. Sorting here makes that impossible rather
        // than merely unlikely.
        this.routes.sort(bySpecificity);
        return this;
    }

    mount(viewport) {
        this.viewport = viewport;
        window.addEventListener('hashchange', () => this.resolve());
        // A browser Back or Forward is the one case where the previous scroll
        // position is what the reader expects to see again.
        window.addEventListener('popstate', () => { this.returningToList = true; });
        return this;
    }

    /** Programmatic navigation. `replace` avoids polluting history on redirect. */
    go(path, { replace = false } = {}) {
        const target = `#${path.startsWith('/') ? path : `/${path}`}`;
        if (window.location.hash === target) return this.resolve();
        if (replace) window.location.replace(target);
        else window.location.hash = target;
        return undefined;
    }

    start() {
        if (!window.location.hash) window.location.replace('#/');
        return this.resolve();
    }

    /** Current path without the query string. */
    path() {
        return (window.location.hash.slice(1) || '/').split('?')[0];
    }

    async resolve() {
        // Claimed BEFORE the first await, not after it.
        //
        // This used to sit below the revalidate() call, which meant two quick
        // taps both got past that await before either had claimed an id: both
        // then read the same (latest) hash and both built and fetched the same
        // page, doubling the reads for that screen. Claiming the id first
        // means the older navigation is already superseded by the time its
        // revalidate returns, and it stops there.
        this.navigationId += 1;
        const navigation = this.navigationId;
        const superseded = () => navigation !== this.navigationId;

        // A session can lapse while the app sits open in a tab — idle
        // timeout, or local storage cleared from another tab. The idle
        // watch in app.js catches that reactively every 60s; this catches
        // it immediately the moment the person tries to go anywhere.
        // Reloading is what actually gets them back to the login screen —
        // see js/app.js's own use of the same pattern.
        if (!this.isAuthenticated()) {
            await expireSession();
            location.reload();
            return;
        }

        // A user's own account can be deactivated or archived by an admin
        // while they still have the app open elsewhere — Document 6 §10
        // wants that to end their session, not just block their next
        // sign-in (already true via auth.service.js's provisioning check).
        // Re-checking the live Firestore record on every navigation is how
        // a same-browser session actually notices. Pluggable per Router
        // instance (see defaultRevalidate() above) — a guardian session
        // supplies its own check instead of this staff-specific one.
        const stillValid = await this.revalidate().catch(() => false);
        if (superseded()) return;
        if (!stillValid) {
            await expireSession();
            location.reload();
            return;
        }

        session.touch();

        const raw = window.location.hash.slice(1) || '/';
        const [path, queryString = ''] = raw.split('?');
        const query = Object.fromEntries(new URLSearchParams(queryString));

        if (this.current) this.scrollPositions.set(this.current, window.scrollY);

        bus.emit(EVENTS.ROUTE_START, { path, query });

        const match = this.match(path);

        if (!match) {
            this.teardown();
            this.current = path;
            this.renderNotFound(path);
            bus.emit(EVENTS.ROUTE_DONE, { path, query, found: false });
            return;
        }

        if (match.route.cap && !session.can(match.route.cap)) {
            this.teardown();
            this.current = path;
            this.renderDenied(match.route);
            bus.emit(EVENTS.ROUTE_DONE, { path, query, denied: true });
            return;
        }

        this.renderLoading();

        let PageClass;
        try {
            const loaded = await match.route.load();
            if (superseded()) return;
            PageClass = loaded.default || loaded.Page || loaded;
        } catch (err) {
            console.error('Failed to load module for', path, err);
            if (superseded()) return;
            this.renderLoadFailure(path, err);
            bus.emit(EVENTS.ROUTE_FAILED, { path, error: err });
            return;
        }

        this.teardown();

        const context = { path, params: match.params, query, router: this };

        try {
            const page = typeof PageClass === 'function' && PageClass.prototype?.render
                ? new PageClass(context)
                : PageClass(context);

            this.currentPage = page;
            this.current = path;

            await page.render(this.viewport, context);
            if (superseded()) return;

            document.title = `${match.route.title || page.title || 'Natyam'} — Natyam ERP`;

            // Restore the list position only when returning to a detail view's
            // parent, so coming back from a student lands where you left off.
            // Opening a screen from the navigation always starts at the top —
            // otherwise a page opened once while scrolled reopens scrolled, and
            // its heading looks missing.
            const remembered = this.returningToList ? this.scrollPositions.get(path) : 0;
            window.scrollTo?.({ top: remembered ?? 0, behavior: 'instant' });
            this.returningToList = false;

            // Move focus to the new page region so a keyboard or screen-reader
            // user is not left at the bottom of the previous page's DOM.
            // preventScroll stops focus() from nudging the page after the
            // scroll reset above has just set it to 0.
            this.viewport.focus?.({ preventScroll: true });

            bus.emit(EVENTS.ROUTE_DONE, { path, query, params: match.params });
        } catch (err) {
            console.error('Route render failed:', path, err);
            if (superseded()) return;
            this.renderError(err);
            bus.emit(EVENTS.ROUTE_FAILED, { path, error: err });
        }
    }

    match(path) {
        for (const route of this.routes) {
            const params = route.matcher(path);
            if (params) return { route, params };
        }
        return null;
    }

    teardown() {
        if (this.currentPage?.destroy) {
            try { this.currentPage.destroy(); } catch (err) { console.error('destroy failed', err); }
        }
        this.currentPage = null;
    }

    /* -------------------------------------------------------- FALLBACK VIEWS */

    renderLoading() {
        render(this.viewport, html`
            <div class="page-header">
                <div class="page-header-text">
                    <div class="skeleton skeleton-title" style="width:200px;height:22px"></div>
                </div>
            </div>
            <div class="page-body">
                <div class="grid grid-4">
                    ${[1, 2, 3, 4].map(() => html`<div class="skeleton skeleton-kpi"></div>`)}
                </div>
                <div class="skeleton skeleton-chart"></div>
            </div>
        `);
    }

    renderNotFound(path) {
        render(this.viewport, html`
            <div class="page-body">
                <div class="card"><div class="card-body">
                    <div class="empty">
                        <div class="empty-glyph">${raw(icon('compass'))}</div>
                        <h2 class="empty-title">There is no page at ${path}</h2>
                        <p class="empty-text">The link may be from an older version of Natyam ERP,
                        or the record it pointed to has been removed.</p>
                        <div class="empty-actions">
                            <a class="btn btn-primary" href="#/">Go to dashboard</a>
                        </div>
                    </div>
                </div></div>
            </div>
        `);
    }

    renderDenied(route) {
        render(this.viewport, html`
            <div class="page-body">
                <div class="card"><div class="card-body">
                    <div class="empty">
                        <div class="empty-glyph">${raw(icon('lock'))}</div>
                        <h2 class="empty-title">${route.title || 'This module'} is not available to your role</h2>
                        <p class="empty-text">You are signed in as ${session.roleLabel()}.
                        An Administrator can grant access in Settings → Roles.</p>
                        <div class="empty-actions">
                            <a class="btn btn-secondary" href="#/">Back to dashboard</a>
                        </div>
                    </div>
                </div></div>
            </div>
        `);
    }

    renderLoadFailure(path, err) {
        render(this.viewport, html`
            <div class="page-body">
                <div class="card"><div class="card-body">
                    <div class="empty">
                        <div class="empty-glyph">${raw(icon('cloud-off'))}</div>
                        <h2 class="empty-title">This module could not be loaded</h2>
                        <p class="empty-text">Natyam ERP loads each module the first time you open it.
                        This one did not arrive — usually because the app files are still downloading,
                        or the browser cache holds a partial copy.</p>
                        <p class="type-mono type-caption">${err.message}</p>
                        <div class="empty-actions">
                            <button class="btn btn-primary" onclick="location.reload()">Reload the app</button>
                            <a class="btn btn-secondary" href="#/">Back to dashboard</a>
                        </div>
                    </div>
                </div></div>
            </div>
        `);
    }

    renderError(err) {
        render(this.viewport, html`
            <div class="page-body">
                <div class="card"><div class="card-body">
                    <div class="empty">
                        <div class="empty-glyph">${raw(icon('alert-triangle'))}</div>
                        <h2 class="empty-title">This page hit an error</h2>
                        <p class="empty-text">Your data is unaffected — nothing was written.</p>
                        <p class="type-mono type-caption">${err.message}</p>
                        <div class="empty-actions">
                            <button class="btn btn-primary" onclick="location.reload()">Reload</button>
                        </div>
                    </div>
                </div></div>
            </div>
        `);
    }
}

/**
 * Compiles '/students/:id' into a matcher returning { id } or null.
 * Deliberately tiny: this app has fewer than thirty routes and none of them
 * need optional segments or wildcards.
 */
/**
 * A route's shape: 0 for a literal segment, 1 for a parameter. '/students/:id'
 * is [0, 1]. Used to rank routes, since a literal is always more specific than
 * a parameter at the same position.
 */
function shapeOf(pattern) {
    return pattern.split('/').filter(Boolean).map((s) => (s.startsWith(':') ? 1 : 0));
}

/**
 * Longer patterns first, then literals before parameters position by position,
 * so '/students/new' wins over '/students/:id' and '/students' can never be
 * captured by '/:anything'.
 */
function bySpecificity(a, b) {
    if (a.shape.length !== b.shape.length) return b.shape.length - a.shape.length;
    for (let i = 0; i < a.shape.length; i += 1) {
        if (a.shape[i] !== b.shape[i]) return a.shape[i] - b.shape[i];
    }
    return 0;
}

function compile(pattern) {
    const segments = pattern.split('/').filter(Boolean);

    return (path) => {
        const parts = path.split('/').filter(Boolean);
        if (parts.length !== segments.length) return null;

        const params = {};
        for (let i = 0; i < segments.length; i += 1) {
            const segment = segments[i];
            if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
            else if (segment !== parts[i]) return null;
        }
        return params;
    };
}

export const router = new Router();

// Exported so the Parent/Student Portal (Milestone P1) can create its own
// second Router instance with a guardian-appropriate `revalidate` — the
// staff `router` singleton above is unaffected, since its own constructor
// call still gets defaultRevalidate() implicitly.
export { Router };

/**
 * Base class for pages. Provides a disposal scope so a page can subscribe to
 * events and attach delegated listeners without having to remember to remove
 * each one — `destroy()` handles all of them.
 */
export class Page {
    constructor(context = {}) {
        this.context = context;
        this.params = context.params || {};
        this.query = context.query || {};
        this.events = bus.scope();
        this.disposers = [];
        this.container = null;

        /**
         * Set once the router has moved on. A page's in-flight work outlives
         * the page — a slow query started before the user clicked away will
         * still resolve — and anything user-visible it does at that point
         * belongs to a screen nobody is looking at. DOM writes discard
         * themselves harmlessly, but a toast or a redirect would not, so
         * long-running handlers should check this before acting.
         */
        this.disposed = false;
    }

    /** Registers a teardown function. */
    onDispose(fn) { this.disposers.push(fn); }

    async render(_container) {
        throw new Error('Page subclasses must implement render()');
    }

    destroy() {
        this.disposed = true;
        this.events.dispose();
        this.disposers.forEach((fn) => {
            try { fn(); } catch (err) { console.error('disposer failed', err); }
        });
        this.disposers.length = 0;
    }
}
