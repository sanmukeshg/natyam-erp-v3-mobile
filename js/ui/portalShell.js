/**
 * NATYAM ERP 2.0 — Parent/Student Portal shell (Milestone P1)
 *
 * The guardian-facing counterpart to js/ui/shell.js's staff Shell — same
 * markup contract (shell.css's .app-shell/.app-sidebar/.app-header/
 * .nav-item/.viewport classes are reused as-is, not reinvented), but
 * deliberately smaller: no branch switcher (a guardian's session has no
 * concept of a branch), no capability-filtered nav (the portal's own fixed
 * route list is the only nav — access is already fully scoped by
 * firestore.rules, not by capability strings), no storage/backup footer, no
 * search palette, no notification bell, and the profile action signs out
 * rather than opening Settings. A household with more than one child gets a
 * simple switcher in the same header slot the staff shell uses for its
 * branch switcher, since it is visually and structurally the same kind of
 * control — "which of several things am I currently looking at."
 */

import { html, render, raw, on, initials } from '../utils/dom.js';
import { icon } from './icons.js';
import { guardianSession } from '../services/portal/guardianAuth.service.js';
import { logout } from '../services/auth.service.js';
import { bus, EVENTS } from '../core/bus.js';

export const PORTAL_NAVIGATION = Object.freeze([
    { path: '/portal', label: 'Overview', icon: 'home' },
    { path: '/portal/timetable', label: 'Timetable', icon: 'calendar' },
    { path: '/portal/attendance', label: 'Attendance', icon: 'check-square' },
    { path: '/portal/programmes', label: 'Programmes', icon: 'star' },
    { path: '/portal/certificates', label: 'Certificates', icon: 'award' },
    { path: '/portal/fees', label: 'Fees', icon: 'receipt' }
]);

export class PortalShell {
    constructor(root, { router } = {}) {
        this.root = root;
        this.router = router;
    }

    mount() {
        render(this.root, html`
            <a class="skip-link" href="#main">Skip to content</a>

            <div class="app-shell" data-role="shell" data-sidebar="expanded">
                <aside class="app-sidebar" data-role="sidebar">
                    <div class="sidebar-brand">
                        <span class="brand-mark" aria-hidden="true">${raw(icon('feather', { size: 20 }))}</span>
                        <span class="brand-text">
                            <span class="brand-name">NATYAM</span>
                            <span class="brand-sub">Family Portal</span>
                        </span>
                    </div>

                    <nav class="sidebar-nav" aria-label="Main">
                        <div class="nav-group">
                            <ul class="nav-list">
                                ${PORTAL_NAVIGATION.map((item) => html`
                                    <li>
                                        <a class="nav-item" href="#${item.path}" data-path="${item.path}">
                                            ${raw(icon(item.icon, { size: 17 }))}
                                            <span class="nav-item-label">${item.label}</span>
                                        </a>
                                    </li>
                                `)}
                            </ul>
                        </div>
                    </nav>
                </aside>

                <div class="app-main">
                    <header class="app-header">
                        <button class="header-btn header-nav-toggle" data-action="menu" aria-label="Open navigation">
                            ${raw(icon('menu', { size: 18 }))}
                        </button>

                        <div class="header-actions">
                            <div data-role="child"></div>

                            <button class="header-btn" data-action="theme" aria-label="Switch between light and dark">
                                ${raw(icon('moon', { size: 18 }))}
                            </button>

                            <button class="profile-btn" data-action="logout">
                                <span class="avatar avatar-sm" aria-hidden="true">${initials(guardianSession.students[0]?.guardianName || 'Family')}</span>
                                <span class="brand-text">
                                    <span class="type-strong">${guardianSession.students[0]?.guardianName || 'Family'}</span>
                                    <span class="type-caption type-muted">Sign out</span>
                                </span>
                            </button>
                        </div>
                    </header>

                    <main class="viewport" id="main" data-role="viewport" tabindex="-1"></main>

                    <footer class="app-footer">
                        <span class="type-caption type-muted">You're seeing only ${guardianSession.students.length === 1 ? "your child's" : "your children's"} own records.</span>
                    </footer>
                </div>

                <div class="scrim" data-action="close-menu" hidden></div>
            </div>
        `);

        this.paintChildSwitcher();
        this.bind();

        return this.root.querySelector('[data-role="viewport"]');
    }

    paintChildSwitcher() {
        const target = this.root.querySelector('[data-role="child"]');
        const students = guardianSession.students;

        // A single-child household has nothing to switch between — the
        // control would be information-free, so it's simply not rendered,
        // same reasoning shell.js's own branch switcher documents.
        if (students.length <= 1) {
            render(target, '');
            return;
        }

        render(target, html`
            <label class="branch-select">
                ${raw(icon('users', { size: 15 }))}
                <span class="sr-only">Viewing</span>
                <select class="select select-sm" data-role="child-select">
                    ${students.map((s) => html`
                        <option value="${s.id}" ${guardianSession.activeChildId === s.id ? 'selected' : ''}>${s.name}</option>
                    `)}
                </select>
            </label>
        `);
    }

    markActive() {
        const current = this.router?.path() || '/portal';
        this.root.querySelectorAll('[data-path]').forEach((node) => {
            const path = node.dataset.path;
            const active = path === '/portal' ? current === '/portal' : current.startsWith(path);
            if (active) node.setAttribute('aria-current', 'page');
            else node.removeAttribute('aria-current');
        });
    }

    bind() {
        on(this.root, 'click', '[data-action="menu"]', () => this.toggleMobileNav(true));
        on(this.root, 'click', '[data-action="close-menu"]', () => this.toggleMobileNav(false));
        on(this.root, 'click', '.nav-item', () => this.toggleMobileNav(false));

        on(this.root, 'click', '[data-action="theme"]', () => {
            const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
            document.documentElement.dataset.theme = next;
        });

        on(this.root, 'click', '[data-action="logout"]', () => {
            logout().catch((err) => console.error('Sign out failed', err));
        });

        on(this.root, 'change', '[data-role="child-select"]', (_e, target) => {
            guardianSession.setActiveChild(target.value);
        });

        bus.on(EVENTS.ROUTE_DONE, () => {
            this.markActive();
            this.root.querySelector('[data-role="viewport"]')?.focus?.();
        });
    }

    toggleMobileNav(open) {
        const shell = this.root.querySelector('[data-role="shell"]');
        const scrim = this.root.querySelector('.scrim');
        shell.setAttribute('data-nav', open ? 'open' : 'closed');
        scrim.hidden = !open;
    }
}
