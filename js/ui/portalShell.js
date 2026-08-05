/**
 * Natyam ERP v3 — Mobile — Parent/Student Portal shell
 *
 * The chrome around every screen a guardian sees. Rewritten for v3 (Stage 7):
 * it was previously a narrowed copy of the v2 desktop shell — a navy sidebar
 * and slide-out drawer built on shell.css/components.css — which meant a
 * family moved from the warm v3 applicant screens straight into what looked
 * like a different product the moment their child enrolled. Same information,
 * same order, same copy; different chrome.
 *
 * This now shares the v3 mobile language with MobileShell and ApplicantShell:
 * `.m-shell`, `.m-appbar`, `.m-tabbar`, `.m-card`. Nothing here loads a v2
 * stylesheet, and app.js's loadPortalStyles() goes with it — the portal was
 * the last thing in the app pulling components.css, so removing this
 * dependency is what stops it drifting back.
 *
 * FIVE TABS, SIX SCREENS. The tab bar holds five; Programmes and Certificates
 * live in the More sheet, because they are read a few times a year while
 * Overview, Attendance, Fees and Timetable answer the recurring questions.
 * Same reasoning and same 44px floor as js/config/navigation.js.
 *
 * THE CHILD SWITCHER STAYS IN THE APP BAR rather than moving to the sheet.
 * The staff shell keeps its branch switcher in More because a staff member
 * changes branch rarely; a parent of four changes child constantly, and
 * putting that two taps deep would be the most irritating thing in the
 * portal. It carries an "All children" option — see guardianAuth.service.js's
 * selectedChildren(), which is what lets every page render one child or all
 * of them without branching on the mode itself.
 */

import { html, render, raw, on } from '../utils/dom.js';
import { icon } from './icons.js';
import { guardianSession } from '../services/portal/guardianAuth.service.js';
import { logout } from '../services/auth.service.js';
import { bus, EVENTS } from '../core/bus.js';

/** The five tab-bar slots. `sheet: true` opens More rather than routing. */
export const PORTAL_TABS = Object.freeze([
    { path: '/portal', label: 'Home', icon: 'home' },
    { path: '/portal/attendance', label: 'Attendance', icon: 'check-square' },
    { path: '/portal/fees', label: 'Fees', icon: 'receipt' },
    { path: '/portal/timetable', label: 'Timetable', icon: 'calendar' },
    { path: '/more', label: 'More', icon: 'menu', sheet: true }
]);

/** Everything reachable from the More sheet. */
export const PORTAL_MORE = Object.freeze([
    { path: '/portal/programmes', label: 'Programmes', icon: 'star' },
    { path: '/portal/certificates', label: 'Certificates', icon: 'award' },
    // Also reachable from the avatar in the app bar. Listed here too because
    // the sheet is where someone looks when the avatar is not obvious, and a
    // second door to a read-only screen costs nothing.
    { path: '/portal/profile', label: 'My account', icon: 'user' }
]);

/**
 * The routes app.js registers. `/more` is excluded deliberately — it is a
 * sheet toggle, not a page, and registering it would leave an empty entry in
 * the history.
 */
export const PORTAL_NAVIGATION = Object.freeze([
    ...PORTAL_TABS.filter((t) => !t.sheet),
    ...PORTAL_MORE
]);

export class PortalShell {
    constructor(root, { router } = {}) {
        this.root = root;
        this.router = router;
        this.sheetOpen = false;
    }

    mount() {
        render(this.root, html`
            <a class="skip-link" href="#main">Skip to content</a>

            <div class="m-shell p-shell" data-role="shell">
                <header class="m-appbar">
                    <span class="m-appbar-text">
                        <span class="m-appbar-title" data-role="title">Natyam</span>
                        <span class="m-appbar-sub" data-role="subtitle"></span>
                    </span>

                    <div data-role="child-switcher"></div>

                    <button class="p-portal-account" data-action="account" aria-label="My account">
                        ${raw(icon('user', { size: 16 }))}
                    </button>
                </header>

                <main class="m-content" id="main" data-role="viewport" tabindex="-1"></main>

                <nav class="m-tabbar" aria-label="Main" data-role="tabs"></nav>
            </div>
            <div data-role="sheet-host"></div>
        `);

        // Cached before any page renders — `data-role` is not a namespace this
        // shell owns, and a page rendering its own [data-role="tabs"] would
        // otherwise be found first by a document-order querySelector. See
        // MobileShell.mount(), where exactly that was a live bug.
        const shell = this.root.querySelector('[data-role="shell"]');
        this.nodes = {
            viewport:  shell.querySelector('[data-role="viewport"]'),
            tabs:      shell.querySelector('nav.m-tabbar'),
            title:     shell.querySelector('[data-role="title"]'),
            subtitle:  shell.querySelector('[data-role="subtitle"]'),
            switcher:  shell.querySelector('[data-role="child-switcher"]'),
            sheetHost: this.root.querySelector('[data-role="sheet-host"]')
        };

        this.paintTabs();
        this.paintSwitcher();
        this.paintTitle();
        this.bind();

        return this.nodes.viewport;
    }

    /* ------------------------------------------------------------------ BAR */

    paintTitle() {
        const path = this.router?.path() || '/portal';
        const item = PORTAL_NAVIGATION.find((n) => n.path === path);
        const home = path === '/portal';

        render(this.nodes.title, home ? 'Natyam' : (item?.label || 'Natyam'));
        render(this.nodes.subtitle, scopeLabel());
    }

    /**
     * A native `<select>` rather than a custom control: this is the one place
     * in the app where the platform picker is genuinely better — reachable by
     * default, scrolls properly with many children, and opens the OS wheel a
     * parent already knows.
     *
     * Hidden entirely for a single-child family. There is nothing to switch
     * between, and an "All children" option covering one child is noise.
     */
    paintSwitcher() {
        const students = guardianSession.students;
        if (students.length < 2) { render(this.nodes.switcher, ''); return; }

        const current = guardianSession.showingAll() ? ALL : guardianSession.activeChildId;

        render(this.nodes.switcher, html`
            <select class="m-input m-child-select" data-role="child" aria-label="Which child">
                <option value="${ALL}" ${current === ALL ? 'selected' : ''}>All children</option>
                ${students.map((s) => html`
                    <option value="${s.id}" ${current === s.id ? 'selected' : ''}>${s.name}</option>
                `)}
            </select>
        `);
    }

    paintTabs() {
        const path = this.router?.path() || '/portal';

        render(this.nodes.tabs, html`
            ${PORTAL_TABS.map((tab) => {
                const active = tab.sheet ? this.sheetOpen : path === tab.path;
                return tab.sheet
                    ? html`
                        <button class="m-tab" data-action="more" aria-pressed="${active}">
                            ${raw(icon(tab.icon, { size: 19 }))}
                            <span class="m-tab-label">${tab.label}</span>
                        </button>`
                    : html`
                        <a class="m-tab" href="#${tab.path}" aria-current="${active ? 'page' : 'false'}">
                            ${raw(icon(tab.icon, { size: 19 }))}
                            <span class="m-tab-label">${tab.label}</span>
                        </a>`;
            })}
        `);
    }

    /* ---------------------------------------------------------------- SHEET */

    toggleSheet(open) {
        this.sheetOpen = open ?? !this.sheetOpen;
        if (!this.sheetOpen) { render(this.nodes.sheetHost, ''); this.paintTabs(); return; }

        render(this.nodes.sheetHost, html`
            <div class="m-sheet-scrim" data-role="sheet-scrim">
                <div class="m-sheet" role="dialog" aria-modal="true" aria-label="More">
                    <div class="m-sheet-grip" aria-hidden="true"></div>

                    ${PORTAL_MORE.map((item) => html`
                        <a class="m-sheet-item" href="#${item.path}" data-action="sheet-link">
                            ${raw(icon(item.icon, { size: 17 }))}
                            <span>${item.label}</span>
                        </a>
                    `)}

                    <div class="m-sheet-sep"></div>

                    <button class="m-sheet-item" data-action="theme"
                            style="width:100%;background:none;border:none;text-align:left;cursor:pointer;">
                        ${raw(icon('moon', { size: 17 }))}
                        <span>Switch theme</span>
                    </button>

                    <div class="m-sheet-sep"></div>

                    <p style="margin:10px 14px;font-size:12px;opacity:.75;">
                        You’re seeing only ${guardianSession.students.length === 1
                            ? 'your child’s' : 'your children’s'} own records.
                    </p>

                    <button class="m-sheet-item m-sheet-danger" data-action="logout"
                            style="width:100%;background:none;border:none;text-align:left;cursor:pointer;">
                        ${raw(icon('log-out', { size: 17 }))}
                        <span>Sign out</span>
                    </button>
                </div>
            </div>
        `);
        this.paintTabs();
    }

    /* ----------------------------------------------------------------- BIND */

    bind() {
        on(this.root, 'click', '[data-action="account"]', () => this.router?.go('/portal/profile'));
        on(this.root, 'click', '[data-action="more"]', () => this.toggleSheet());
        on(this.root, 'click', '[data-action="sheet-link"]', () => this.toggleSheet(false));

        on(this.root, 'click', '[data-role="sheet-scrim"]', (event, target) => {
            if (event.target === target) this.toggleSheet(false);
        });

        on(this.root, 'change', '[data-role="child"]', (_e, target) => {
            // setActiveChild emits PORTAL_CHILD_CHANGED, which every page
            // already listens for — so the pages re-render themselves and
            // this handler only has to update the bar.
            guardianSession.setActiveChild(target.value);
            this.paintTitle();
        });

        on(this.root, 'click', '[data-action="theme"]', () => {
            const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
            this.toggleSheet(false);
        });

        on(this.root, 'click', '[data-action="logout"]', () => {
            // Firebase's own auth-state change (not this handler) returns to
            // the login screen — see app.js's handleAuthStateChange().
            logout().catch((err) => console.error('Sign out failed', err));
        });

        this.onKey = (event) => { if (event.key === 'Escape' && this.sheetOpen) this.toggleSheet(false); };
        window.addEventListener('keydown', this.onKey);

        bus.on(EVENTS.ROUTE_DONE, () => {
            this.paintTabs();
            this.paintTitle();
        });

        bus.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.paintTitle());
    }
}

/** Mirrors GuardianSession.ALL without importing the class itself. */
const ALL = '__all__';

/** "All 4 children" / "Ayaan Iyer" — what the app bar says you are viewing. */
function scopeLabel() {
    if (guardianSession.showingAll()) {
        const n = guardianSession.students.length;
        return `All ${n} ${n === 1 ? 'child' : 'children'}`;
    }
    return guardianSession.activeChild()?.name || '';
}
