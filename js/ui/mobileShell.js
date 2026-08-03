/**
 * Natyam ERP v3 — Mobile — Staff application shell
 *
 * The chrome around every staff page on mobile, built from the approved
 * design ("Dashboard.dc.html", mobile half): a top app bar carrying identity
 * and the day, a scrolling content column, and a five-slot bottom tab bar.
 *
 * This is deliberately NOT a narrowed copy of natyam-admin's sidebar shell.
 * The split spec is explicit — "Do not reuse desktop layouts" — so this is
 * its own component with its own navigation model (js/config/navigation.js),
 * sharing only the services and repositories underneath.
 *
 * Distinct from js/ui/portalShell.js, which serves guardians (parents and,
 * later, students) and stays exactly as it is. Two audiences, two shells;
 * they are not variants of each other.
 *
 * WHERE THINGS LIVE, AND WHY
 * A phone has no room for a header full of controls, so the things
 * natyam-admin puts in its header live in the More sheet here: branch
 * switcher, theme, sign out. The design mocks a screen rather than a working
 * session and does not draw these — they are placed in the same visual
 * language rather than dropped, since the app genuinely needs them.
 *
 * The app bar shows the greeting and date on the dashboard, exactly as
 * designed, and the page title elsewhere — a phone user needs to know which
 * screen they are on far more than they need the date repeated.
 */

import { html, render, raw, on, initials } from '../utils/dom.js';
import { icon } from './icons.js';
import { session } from '../core/session.js';
import { bus, EVENTS } from '../core/bus.js';
import { router } from '../core/router.js';
import { TABS, MORE_ITEMS } from '../config/navigation.js';
import { formatDateLong } from '../utils/date.js';
import { logout } from '../services/auth.service.js';

export class MobileShell {
    constructor(root) {
        this.root = root;
        this.sheetOpen = false;
    }

    mount() {
        render(this.root, html`
            <div class="m-shell" data-role="shell">
                <header class="m-appbar">
                    <span class="m-appbar-mark" aria-hidden="true">
                        <img src="assets/icons/icon.svg" alt="">
                    </span>
                    <span class="m-appbar-text">
                        <span class="m-appbar-title" data-role="title"></span>
                        <span class="m-appbar-sub" data-role="subtitle"></span>
                    </span>
                    <button class="m-avatar-btn" data-action="profile" aria-label="My account">
                        <span class="m-avatar" data-role="avatar"></span>
                    </button>
                </header>

                <main class="m-content" id="main" data-role="viewport" tabindex="-1"></main>

                <nav class="m-tabbar" aria-label="Main" data-role="tabs"></nav>
            </div>
            <div data-role="sheet-host"></div>
        `);

        /*
         * Cache the chrome's own nodes NOW, before any page has rendered.
         *
         * `data-role` is not a namespace the shell owns — pages use it too, and
         * `this.root.querySelector()` returns the first match in document
         * order, which puts every page's markup *ahead* of the tab bar (pages
         * render into `.m-content`, which precedes `<nav>`).
         *
         * That was a live bug, not a hypothetical: settings.page.js labels its
         * section switcher `data-role="tabs"`, so once Settings was open the
         * ROUTE_DONE handler's paintTabs() found the switcher instead of the
         * tab bar and rendered the five main tabs over it — the six Settings
         * sections vanished, taking every route to School/Branches/Fee plans/
         * Curriculum/About with them, and the real tab bar stopped updating its
         * active state because it was no longer the thing being repainted.
         *
         * Holding references removes the ambiguity for good rather than
         * renaming one attribute and leaving the next collision to be found in
         * a screenshot.
         */
        const shell = this.root.querySelector('[data-role="shell"]');
        this.nodes = {
            viewport:  shell.querySelector('[data-role="viewport"]'),
            tabs:      shell.querySelector('nav.m-tabbar'),
            title:     shell.querySelector('[data-role="title"]'),
            subtitle:  shell.querySelector('[data-role="subtitle"]'),
            avatar:    shell.querySelector('[data-role="avatar"]'),
            sheetHost: this.root.querySelector('[data-role="sheet-host"]')
        };

        this.paintTabs();
        this.paintIdentity();
        this.paintTitle();
        this.bind();

        return this.nodes.viewport;
    }

    /* ------------------------------------------------------------------ BAR */

    paintIdentity() {
        render(this.nodes.avatar, initials(session.actorName()));
    }

    /**
     * Greeting + date on the dashboard (as designed); the page's own name
     * everywhere else, since knowing which screen you are on matters more.
     */
    paintTitle() {
        const path = router.path();
        const titleNode = this.nodes.title;
        const subNode = this.nodes.subtitle;
        if (!titleNode) return;

        if (path === '/') {
            render(titleNode, greeting());
            render(subNode, formatDateLong(new Date()));
            return;
        }

        const match = [...TABS, ...MORE_ITEMS].find((item) =>
            item.path !== '/' && (path === item.path || path.startsWith(`${item.path}/`)));

        render(titleNode, match?.label || 'Natyam ERP');
        render(subNode, session.branchName?.() || session.roleLabel());
    }

    /* ----------------------------------------------------------------- TABS */

    visibleTabs() {
        return TABS.filter((tab) => !tab.cap || session.can(tab.cap));
    }

    paintTabs() {
        render(this.nodes.tabs, html`
            ${this.visibleTabs().map((tab) => {
                // "More" is a sheet toggle, not a destination — a button, so
                // it is never announced as a link to a page that doesn't exist.
                if (tab.sheet) {
                    return html`
                        <button class="m-tab" data-action="more" aria-expanded="${this.sheetOpen ? 'true' : 'false'}">
                            ${raw(icon(tab.icon, { size: 22 }))}
                            <span class="m-tab-label">${tab.label}</span>
                        </button>
                    `;
                }

                return html`
                    <a class="m-tab" href="#${tab.path}" data-path="${tab.path}"
                       data-pending="${tab.load ? 'false' : 'true'}">
                        ${raw(icon(tab.icon, { size: 22 }))}
                        <span class="m-tab-label">${tab.label}</span>
                    </a>
                `;
            })}
        `);

        this.markActive();
    }

    /**
     * Marks the current tab, matching on prefix so /students/:id still lights
     * up Students. Set through the DOM rather than interpolated into the
     * template above: html`` escapes its values, so a conditional
     * `aria-current="page"` string would render as visible text instead of
     * becoming an attribute — and the tab bar would silently never show a
     * selected state. `aria-current` is also what the stylesheet keys on,
     * which keeps the visual and accessible states impossible to separate.
     */
    markActive() {
        const current = router.path();

        this.nodes.tabs.querySelectorAll('.m-tab[data-path]').forEach((node) => {
            const path = node.dataset.path;
            const active = path === '/'
                ? current === '/'
                : current === path || current.startsWith(`${path}/`);

            if (active) node.setAttribute('aria-current', 'page');
            else node.removeAttribute('aria-current');
        });
    }

    /* ---------------------------------------------------------- MORE SHEET */

    paintSheet() {
        const host = this.nodes.sheetHost;

        if (!this.sheetOpen) {
            render(host, '');
            return;
        }

        const items = MORE_ITEMS.filter((item) => !item.cap || session.can(item.cap));
        const branches = session.branches || [];
        const dark = document.documentElement.dataset.theme === 'dark';

        render(host, html`
            <div class="m-sheet-scrim" data-action="close-sheet"></div>
            <div class="m-sheet" role="dialog" aria-label="More">
                <div class="m-sheet-grip"></div>

                ${items.map((item) => html`
                    <a class="m-sheet-item" href="#${item.path}"
                       data-pending="${item.load ? 'false' : 'true'}">
                        ${raw(icon(item.icon, { size: 20 }))}
                        <span>${item.label}</span>
                    </a>
                `)}

                <div class="m-sheet-sep"></div>

                ${branches.length ? html`
                    <label class="m-sheet-item" style="gap:14px;">
                        ${raw(icon('map-pin', { size: 20 }))}
                        <span class="sr-only">Active branch</span>
                        <select class="m-sheet-branch" data-role="branch-select"
                                style="flex:1;background:none;border:none;color:inherit;font:inherit;min-height:44px;">
                            ${session.canAny('settings.view', 'report.view') ? html`
                                <option value="" ${session.branch() === null ? 'selected' : ''}>All branches</option>
                            ` : ''}
                            ${branches.map((branch) => html`
                                <option value="${branch.id}" ${session.branch() === branch.id ? 'selected' : ''}>
                                    ${branch.name}
                                </option>
                            `)}
                        </select>
                    </label>
                ` : ''}

                <button class="m-sheet-item" data-action="theme" style="width:100%;background:none;border:none;text-align:left;cursor:pointer;">
                    ${raw(icon(dark ? 'sun' : 'moon', { size: 20 }))}
                    <span>${dark ? 'Light appearance' : 'Dark appearance'}</span>
                </button>

                <button class="m-sheet-item m-sheet-danger" data-action="logout" style="width:100%;background:none;border:none;text-align:left;cursor:pointer;">
                    ${raw(icon('log-out', { size: 20 }))}
                    <span>Sign out</span>
                </button>
            </div>
        `);
    }

    toggleSheet(open) {
        this.sheetOpen = open ?? !this.sheetOpen;
        this.paintSheet();
        this.paintTabs();
    }

    /* --------------------------------------------------------------- EVENTS */

    bind() {
        on(this.root, 'click', '[data-action="more"]', () => this.toggleSheet());
        on(this.root, 'click', '[data-action="close-sheet"]', () => this.toggleSheet(false));

        // A tab or sheet entry whose module has not been migrated yet has no
        // page to open — say nothing happens rather than navigate nowhere.
        on(this.root, 'click', '.m-tab[data-pending="true"]', (event) => event.preventDefault());
        on(this.root, 'click', '.m-sheet-item[data-pending="true"]', (event) => event.preventDefault());

        // Any real navigation from inside the sheet closes it.
        on(this.root, 'click', '.m-sheet-item[data-pending="false"]', () => this.toggleSheet(false));

        on(this.root, 'click', '[data-action="profile"]', () => router.go('/profile'));

        on(this.root, 'click', '[data-action="theme"]', () => {
            const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
            applyTheme(next);
            session.setPref('theme', next);
            this.paintSheet();
        });

        on(this.root, 'click', '[data-action="logout"]', () => {
            // Firebase's own auth-state change (not this handler) returns to
            // the login screen — see app.js's handleAuthStateChange().
            logout().catch((err) => console.error('Sign out failed', err));
        });

        on(this.root, 'change', '[data-role="branch-select"]', (_e, target) => {
            session.setBranch(target.value || null);
            this.toggleSheet(false);
        });

        // Escape closes the sheet, the same as tapping the scrim.
        this.onKey = (event) => { if (event.key === 'Escape' && this.sheetOpen) this.toggleSheet(false); };
        window.addEventListener('keydown', this.onKey);

        bus.on(EVENTS.ROUTE_DONE, () => {
            this.paintTabs();
            this.paintTitle();
            this.nodes.viewport?.focus?.();
        });

        bus.on(EVENTS.BRANCH_CHANGED, () => this.paintTitle());
    }
}

/* ------------------------------------------------------------------ THEME */

/**
 * Applied to <html> so the first paint is already correct. "system" follows
 * the device and keeps following it.
 */
export function applyTheme(preference) {
    const resolved = preference === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : preference;

    document.documentElement.dataset.theme = resolved || 'light';
    bus.emit(EVENTS.THEME_CHANGED, { theme: resolved });
}

export function applyDensity(density) {
    document.documentElement.dataset.density = density || 'comfortable';
}

function greeting() {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const first = (session.actorName() || '').trim().split(/\s+/)[0];
    return first ? `${part}, ${first}` : part;
}
