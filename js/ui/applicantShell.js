/**
 * Natyam ERP v3 — Mobile — Applicant shell
 *
 * The chrome for a prospective parent: signed in with Google, no staff
 * account, and not yet linked to any student. Fourth and last shell in this
 * app, alongside MobileShell (staff), PortalShell (guardians) and PublicShell
 * (visitors).
 *
 * WHAT IS DELIBERATELY ABSENT is the whole point of this file. The brief is
 * explicit that this audience must NOT see My Child, Attendance, Fees,
 * Homework, Announcements, Events, Progress or Certificates — not greyed out,
 * not empty, not present. None of those routes is registered here, so they do
 * not exist for this session rather than merely being hidden from a menu. A
 * family gets them the moment their child is enrolled, at which point
 * app.js's guardian check resolves first and they land on the real Parent
 * Dashboard instead — which this stage does not touch at all.
 *
 * What remains is the short list the brief does allow: apply, track, profile.
 * Three destinations is too few for a tab bar to earn its 64px, so this shell
 * uses the same back-affordance pattern PublicShell does, with the identity
 * and sign-out in the app bar.
 */

import { html, render, raw, on } from '../utils/dom.js';
import { icon } from './icons.js';
import { logout } from '../services/auth.service.js';
import { PUBLIC_MODULES } from '../config/publicContent.config.js';

/**
 * The applicant's entire route table. Anything not listed here is genuinely
 * unreachable for this identity.
 */
export const APPLICANT_ROUTES = Object.freeze([
    Object.freeze({
        path: '/', label: 'My applications',
        load: () => import('../modules/applicant/applications.page.js')
    }),
    // Shown only on a first visit. app.js decides that — it reads the parent
    // profile once at sign-in and redirects here — rather than this page or
    // the shell deciding, so "have they been here before?" is answered in one
    // place, the same way identity is.
    Object.freeze({
        path: '/welcome', label: 'Welcome',
        load: () => import('../modules/applicant/welcome.page.js')
    }),
    // The Welcome screen's second door. Registered on THIS router as well as
    // the public one because an applicant is signed in and therefore no
    // longer on the public router — without it, "Make an Enquiry" would land
    // on a 404 for exactly the people the screen was built for.
    Object.freeze({
        path: '/enquiry', label: 'Enquiry',
        load: () => import('../modules/public/enquiry.page.js')
    }),
    Object.freeze({
        path: '/apply', label: 'Admission application',
        load: () => import('../modules/applicant/apply.page.js')
    }),
    Object.freeze({
        path: '/profile', label: 'My account',
        load: () => import('../modules/applicant/profile.page.js')
    }),

    /*
     * The informational screens — About Natyam, Courses, Branches, Batch
     * Timings, Founder — registered here as well as on the public router.
     *
     * Someone deciding whether to apply needs these more than anyone: they
     * are mid-decision, and the answer to "should I?" is in Courses and Batch
     * Timings. Before this they were reachable only to signed-OUT visitors,
     * which meant signing in to apply lost you the very pages that would tell
     * you whether to.
     *
     * Same paths, same registry, same single content.page.js renderer — it
     * resolves which section to show from the route, so nothing is duplicated
     * to make this work.
     */
    ...PUBLIC_MODULES.map((m) => Object.freeze({
        path: m.path, label: m.label,
        load: () => import('../modules/public/content.page.js')
    }))
]);

export class ApplicantShell {
    /**
     * @param {HTMLElement} root
     * @param {object} options
     * @param {Router} options.router
     * @param {{email: string, name: string}} options.identity  The signed-in
     *   Google account — this session's entire identity. There is no `session`
     *   or `guardianSession` to read from, by design (see app.js).
     */
    constructor(root, { router, identity } = {}) {
        this.root = root;
        this.router = router;
        this.identity = identity || { email: '', name: '' };
    }

    mount() {
        render(this.root, html`
            <a class="skip-link" href="#main">Skip to content</a>

            <div class="m-shell p-shell" data-role="shell">
                <header class="m-appbar p-appbar">
                    <button class="m-icon-btn p-back" data-action="back" aria-label="Back" hidden>
                        ${raw(icon('chevron-left', { size: 20 }))}
                    </button>

                    <span class="m-appbar-text">
                        <span class="m-appbar-title" data-role="title">Natyam</span>
                        <span class="m-appbar-sub" data-role="subtitle"></span>
                    </span>

                    <button class="m-btn m-btn-ghost m-btn-sm" data-action="profile">
                        ${raw(icon('user', { size: 15 }))}
                    </button>
                </header>

                <main class="m-content" id="main" data-role="viewport" tabindex="-1"></main>
            </div>
        `);

        // Cached before any page renders — same reasoning MobileShell.mount()
        // documents: `data-role` is not a namespace the shell owns.
        const shell = this.root.querySelector('[data-role="shell"]');
        this.nodes = {
            viewport: shell.querySelector('[data-role="viewport"]'),
            title:    shell.querySelector('[data-role="title"]'),
            subtitle: shell.querySelector('[data-role="subtitle"]'),
            back:     shell.querySelector('[data-action="back"]')
        };

        this.bind();
        return this.nodes.viewport;
    }

    paintFor(path) {
        const route = APPLICANT_ROUTES.find((r) => r.path === path);
        const home = path === '/';

        render(this.nodes.title, home ? 'Natyam' : (route?.label || 'Natyam'));
        render(this.nodes.subtitle, home ? (this.identity.name || this.identity.email) : '');
        this.nodes.back.hidden = home;
    }

    bind() {
        // Home rather than history.back(), for the same reason PublicShell
        // gives: this hierarchy is exactly one level deep, and a deep link
        // would otherwise send someone out of the app entirely.
        on(this.root, 'click', '[data-action="back"]', () => this.router.go('/'));
        on(this.root, 'click', '[data-action="profile"]', () => this.router.go('/profile'));
        on(this.root, 'click', '[data-action="sign-out"]', () => logout());
    }
}
