/**
 * Natyam ERP v3 — Mobile — Public shell
 *
 * The chrome around the Public Experience: what a prospective parent sees
 * when they open the app having never signed in. Third shell in this app,
 * alongside MobileShell (staff) and PortalShell (guardians), and like those
 * two it is its own component rather than a variant — the audiences do not
 * overlap and neither does the chrome.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each one:
 *
 *   No bottom tab bar.   MobileShell's five tabs are for someone returning to
 *                        the same handful of screens all day. A visitor is
 *                        reading a short set of pages once, in order, so a
 *                        persistent tab bar would spend 64px of a phone
 *                        screen on navigation nobody uses twice.
 *   No avatar, no More.  There is no session to belong to.
 *   No branch switcher.  Branches are content here, not scope.
 *
 * WHAT IT ADDS: a back affordance, because this is the only shell in the app
 * where every screen is one level below Home and the browser's own Back
 * button is the only alternative — which on an installed PWA is not visible
 * at all.
 *
 * The visual language is v3.css's, reused as-is (.m-shell, .m-appbar,
 * .m-content, .m-card, .m-btn). public.css adds only what has no equivalent
 * there: the home hero and the two primary action buttons.
 */

import { html, render, raw, on } from '../utils/dom.js';
import { icon } from './icons.js';
import { PUBLIC_MODULES } from '../config/publicContent.config.js';

/**
 * The public route table. Home first, then the two things the brief puts
 * ahead of everything else — "The goal is to let parents immediately enquire
 * or apply while still learning about the academy" — then the informational
 * modules, whose paths and labels come from the registry rather than being
 * restated here.
 *
 * `/apply` and `/enquiry` are registered now and filled in by Stages 3 and 2.
 * They are real routes from the start so the navigation shape is the finished
 * one and nothing has to be rearranged around them later.
 */
export const PUBLIC_ROUTES = Object.freeze([
    Object.freeze({
        path: '/', label: 'Natyam',
        load: () => import('../modules/public/home.page.js')
    }),
    Object.freeze({
        path: '/apply', label: 'Apply Now',
        load: () => import('../modules/public/apply.page.js')
    }),
    Object.freeze({
        path: '/enquiry', label: 'Enquiry',
        load: () => import('../modules/public/enquiry.page.js')
    }),
    ...PUBLIC_MODULES.map((m) => Object.freeze({
        path: m.path, label: m.label,
        load: () => import('../modules/public/content.page.js')
    }))
]);

export class PublicShell {
    /**
     * @param {HTMLElement} root
     * @param {object} options
     * @param {Router} options.router     The public Router instance.
     * @param {Function} options.onSignIn Called when someone taps Sign in —
     *   app.js swaps the whole public app for the login screen. The shell
     *   does not import the login page itself: which screen replaces this one
     *   is a bootstrap decision, and app.js is where every other one is made.
     */
    constructor(root, { router, onSignIn } = {}) {
        this.root = root;
        this.router = router;
        this.onSignIn = onSignIn;
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
                        <span class="m-appbar-sub" data-role="subtitle">School of Kuchipudi</span>
                    </span>

                    <button class="m-btn m-btn-ghost m-btn-sm" data-action="signin">Sign in</button>
                </header>

                <main class="m-content" id="main" data-role="viewport" tabindex="-1"></main>
            </div>
        `);

        // Cached before any page renders, for the reason MobileShell.mount()
        // documents at length: `data-role` is not a namespace the shell owns,
        // and a page rendering its own [data-role="title"] would otherwise be
        // found first by a document-order querySelector.
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

    /**
     * Home shows the school's name; every other screen shows where you are
     * and offers a way back. Called by app.js on each completed navigation
     * rather than subscribed here, so the shell has no opinion about routing
     * events it does not own.
     */
    paintFor(path) {
        const route = PUBLIC_ROUTES.find((r) => r.path === path);
        const home = path === '/';

        render(this.nodes.title, home ? 'Natyam' : (route?.label || 'Natyam'));
        render(this.nodes.subtitle, home ? 'School of Kuchipudi' : '');
        this.nodes.back.hidden = home;
    }

    bind() {
        on(this.root, 'click', '[data-action="back"]', () => {
            // Home rather than history.back(): a visitor may have arrived on
            // a deep link (a shared Courses URL), where "back" would leave
            // the app entirely. Home is always the right destination from one
            // level down, and this hierarchy is exactly one level deep.
            this.router.go('/');
        });

        on(this.root, 'click', '[data-action="signin"]', () => this.onSignIn?.());
    }
}
