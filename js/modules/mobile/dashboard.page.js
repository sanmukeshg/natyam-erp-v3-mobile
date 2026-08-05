/**
 * Natyam ERP v3 — Mobile — Dashboard
 *
 * Built from the approved design ("Dashboard.dc.html", mobile half). This is
 * a mobile-first screen, not the desktop dashboard reflowed: card lists and
 * a horizontally scrolled KPI strip instead of a grid, full-width tap
 * targets instead of inline links, and the two most common actions promoted
 * to a quick-action grid.
 *
 * TWO VARIANTS, BOTH REQUIRED. Unlike natyam-admin — which serves only
 * Owner & Accountant, Administrator and Viewer — this app also serves
 * Teacher & Reception, and the design draws a genuinely different screen for
 * them:
 *
 *   - Teacher & Reception: "what do I have to do today" — classes today,
 *     registers still to mark, and quick actions. No collection figures; a
 *     teacher should not have to read the school's revenue to find out which
 *     register is outstanding.
 *   - Owner & Accountant: the full picture — KPI strip, what needs
 *     attention, insights, recent activity.
 *
 * As on desktop, this page computes nothing. Every figure comes from
 * dashboard.service.js — carried over from the reference project byte for
 * byte — and this file only decides what a number should look like.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoneyShort, formatNumber } from '../../utils/money.js';
import { overview, forTeacher } from '../../services/dashboard.service.js';

const STATE_LABEL = {
    marked: 'Marked',
    running: 'In progress',
    missed: 'Not marked',
    upcoming: 'Later today'
};

/** The design's quick-action tiles, with their own icon tints. */
const QUICK_ACTIONS = [
    { label: 'Collect fee', icon: 'receipt', link: '#/fees', color: '#B45B34', bg: 'rgba(180,91,52,0.22)' },
    { label: 'Students', icon: 'users', link: '#/students', color: '#5A6FA8', bg: 'rgba(90,111,168,0.2)' },
    { label: 'Timetable', icon: 'calendar', link: '#/timetable', color: '#3E7DBF', bg: 'rgba(62,125,191,0.2)' },
    { label: 'Attendance', icon: 'check-square', link: '#/attendance', color: '#3E6B31', bg: 'rgba(62,107,49,0.2)' }
];

/* ENH-301 — the Owner's Quick Access Workspace.
 *
 * The split is by HOW OFTEN, not by what the modules are. Daily operations is
 * what gets opened most days; Management is what gets opened most months. That
 * ordering is the whole point of the grouping — putting Finance next to
 * Attendance because both are "modules" would tell the owner nothing about
 * which one she is about to want.
 *
 * Attendance, Fees and Students are deliberately NOT repeated here: they are
 * already in Quick actions above, and repeating them is the duplication this
 * ticket asks to remove. */
const DAILY_OPERATIONS = [
    { label: 'Admissions', icon: 'inbox', link: '#/admissions', color: '#8C4A28', bg: 'rgba(140,74,40,0.2)' },
    { label: 'Batches', icon: 'grid', link: '#/batches', color: '#5A6FA8', bg: 'rgba(90,111,168,0.2)' },
    { label: 'Parents', icon: 'phone', link: '#/parents', color: '#3E6B31', bg: 'rgba(62,107,49,0.2)' },
    { label: 'Notifications', icon: 'bell', link: '#/notifications', color: '#B45B34', bg: 'rgba(180,91,52,0.22)' }
];

const MANAGEMENT = [
    { label: 'Staff', icon: 'briefcase', link: '#/staff', color: '#5A6FA8', bg: 'rgba(90,111,168,0.2)' },
    { label: 'Programmes', icon: 'star', link: '#/programs', color: '#B45B34', bg: 'rgba(180,91,52,0.22)' },
    { label: 'Certificates', icon: 'award', link: '#/certificates', color: '#3E7DBF', bg: 'rgba(62,125,191,0.2)' },
    { label: 'Finance', icon: 'trending-up', link: '#/finance', color: '#3E6B31', bg: 'rgba(62,107,49,0.2)' },
    { label: 'Analytics', icon: 'bar-chart', link: '#/analytics', color: '#5A6FA8', bg: 'rgba(90,111,168,0.2)' },
    { label: 'Settings', icon: 'settings', link: '#/settings', color: '#8C4A28', bg: 'rgba(140,74,40,0.2)' }
];

export default class MobileDashboardPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Dashboard';
        // Teacher & Reception get the task-first screen. Owner & Accountant —
        // who can reach both apps — get the full one, same as on desktop.
        this.teacherMode = session.role() === 'teacher_reception';
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton" data-role="body">Loading…</div>`);

        await this.load();

        [EVENTS.BRANCH_CHANGED, EVENTS.PAYMENT_RECORDED, EVENTS.ATTENDANCE_SAVED,
         EVENTS.ADMISSION_ENROLLED, EVENTS.STUDENT_CREATED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        const body = this.container?.querySelector('[data-role="body"]') || this.container;
        if (!body) return;

        try {
            const view = this.teacherMode
                // forTeacher() is passed the signed-in actor's id, exactly as
                // the reference app does — behaviour preserved, not revised.
                ? this.teacherView(await forTeacher(session.actorId()))
                : this.ownerView(await overview({ branchId: session.branch() }));

            if (this.disposed) return;
            render(this.container, html`<div data-role="body">${view}</div>`);
        } catch (err) {
            if (this.disposed) return;
            console.error('Dashboard failed to load', err);
            render(this.container, html`
                <div data-role="body">
                    <div class="m-error">The dashboard could not be loaded — ${err.message}</div>
                </div>
            `);
        }
    }

    /* ======================================================= TEACHER VARIANT */

    teacherView(data) {
        const classes = data?.classesToday || [];
        const pending = data?.registersPending ?? 0;

        return html`
            <div class="m-stat-row">
                <div class="m-card m-stat">
                    <div class="m-stat-value">${classes.length}</div>
                    <div class="m-stat-label">Class${classes.length === 1 ? '' : 'es'} today</div>
                </div>
                <div class="m-card m-stat">
                    <div class="m-stat-value">${pending}</div>
                    <div class="m-stat-label">Register${pending === 1 ? '' : 's'} pending</div>
                </div>
            </div>

            <h2 class="m-section-label">Your classes today</h2>
            <div class="m-stack">
                ${classes.length ? classes.map((cls) => html`
                    <div class="m-card m-class">
                        <div class="m-class-main">
                            <div class="m-class-name">${cls.name}</div>
                            <div class="m-class-time">${cls.startTime}–${cls.endTime}</div>
                        </div>
                        <a class="m-btn ${cls.done ? 'm-btn-ghost' : ''}" href="#/attendance">
                            ${cls.done ? 'View register' : 'Mark register'}
                        </a>
                    </div>
                `) : html`<div class="m-card m-empty">No classes scheduled for you today.</div>`}
            </div>

            ${data?.missing?.length ? html`
                <h2 class="m-section-label">Registers still missing</h2>
                <div class="m-stack">
                    ${data.missing.slice(0, 5).map((row) => html`
                        <div class="m-card m-attn">
                            <div class="m-attn-head">
                                <span class="m-dot" data-severity="medium"></span>
                                <div style="flex:1;min-width:0;">
                                    <div class="m-attn-title">${row.batch?.name || 'A class'}</div>
                                    <div class="m-attn-detail">${row.date}</div>
                                </div>
                            </div>
                            <a class="m-btn m-btn-block" href="#/attendance">Mark attendance</a>
                        </div>
                    `)}
                </div>
            ` : ''}

            <h2 class="m-section-label">Quick actions</h2>
            <div class="m-grid-2">
                ${QUICK_ACTIONS.filter((action) => this.allowed(action)).map((action) => html`
                    <a class="m-card m-quick" href="${action.link}">
                        <span class="m-quick-icon" style="background:${action.bg};color:${action.color};">
                            ${raw(icon(action.icon, { size: 18 }))}
                        </span>
                        <span class="m-quick-label">${action.label}</span>
                    </a>
                `)}
            </div>
        `;
    }

    /** A quick action is only offered if the person could actually use it. */
    /**
     * Whether this tile should be shown at all.
     *
     * Gating here as well as in the router is not belt-and-braces for its own
     * sake: a tile that navigates to a "not available to your role" screen is
     * worse than no tile, because it looks like the app is broken rather than
     * like the permission is absent. The router still refuses independently.
     *
     * Anything without an entry is open to every role that reaches this
     * dashboard — the same default the original four had.
     */
    allowed(action) {
        const needs = {
            '#/fees': 'fee.view',
            '#/students': 'student.view',
            '#/attendance': 'attendance.view',
            '#/admissions': 'admission.view',
            '#/batches': 'student.view',
            '#/parents': 'student.view',
            '#/staff': 'staff.view',
            '#/programs': 'program.view',
            '#/certificates': 'program.view',
            '#/finance': 'finance.view',
            '#/analytics': 'report.view',
            '#/settings': 'settings.view'
        }[action.link];

        return needs ? session.can(needs) : true;
    }

    /* ========================================================= OWNER VARIANT */

    /**
     * ENH-301 — the Owner dashboard as a Quick Access Workspace.
     *
     * It was four stacked blocks of READING — KPIs, attention, insights,
     * activity — with no navigation of its own, so the one screen the owner
     * opens most often was the one screen that could not take her anywhere.
     * Everything went through the tab bar and the More sheet.
     *
     * ORDER FOLLOWS THE THUMB. Today's Summary is read-only, so it sits at the
     * top where the eye lands and no finger has to reach. Everything tappable
     * is below it, filling the lower half of the screen a thumb actually
     * covers: glance at the numbers, then act.
     *
     * INSIGHTS AND RECENT ACTIVITY ARE GONE. Both were browsing material that
     * largely restated the KPIs above them, and between them they pushed every
     * navigation target off the first screen — exactly the clutter this ticket
     * exists to remove. Needs attention stays, because it is actionable rather
     * than informational: overdue invoices, unmarked registers, applicants
     * approved but not enrolled. Without it the owner would have to go hunting
     * module by module for problems.
     */
    ownerView(data) {
        return html`
            ${this.todaySummary(data.headline)}
            ${this.attention(data.attention)}
            ${this.workspaceGroup('Quick actions', QUICK_ACTIONS)}
            ${this.workspaceGroup('Daily operations', DAILY_OPERATIONS)}
            ${this.workspaceGroup('Management', MANAGEMENT)}
        `;
    }

    /**
     * The numbers. Deliberately reuses kpiStrip() rather than inventing a
     * "summary" component — it already scrolls horizontally, already links
     * each figure to the module behind it, and already handles a failed
     * panel. The heading was the entire difference.
     */
    todaySummary(headline) {
        return this.kpiStrip(headline);
    }

    /**
     * One navigation group, built from .m-quick — the same card Quick actions
     * already used — so the workspace is one visual idea repeated three times
     * rather than three new ones.
     *
     * A group whose every entry is barred by capability renders nothing at
     * all, heading included: an empty "Management" heading tells the reader
     * only that something exists which they cannot have.
     */
    workspaceGroup(title, actions) {
        const visible = actions.filter((action) => this.allowed(action));
        if (!visible.length) return '';

        return html`
            <h2 class="m-section-label" style="margin-top:20px;">${title}</h2>
            <div class="m-actions m-actions-grid">
                ${visible.map((action) => html`
                    <a class="m-card m-quick" href="${action.link}">
                        <span class="m-quick-icon" style="background:${action.bg};color:${action.color};">
                            ${raw(icon(action.icon, { size: 17 }))}
                        </span>
                        <span class="m-quick-label">${action.label}</span>
                    </a>
                `)}
            </div>
        `;
    }

    kpiStrip(headline) {
        if (panelFailed(headline) || !headline?.length) return '';

        return html`
            <div class="m-kpi-strip">
                ${headline.map((kpi) => html`
                    <a class="m-card m-kpi" data-tone="${kpi.tone || 'neutral'}" href="${kpi.link || '#/'}">
                        <span class="m-kpi-bar"></span>
                        <span class="m-kpi-body">
                            <span class="m-kpi-label">${kpi.label}</span>
                            <span class="m-kpi-value" style="display:block;">${kpiValue(kpi)}</span>
                            ${kpi.delta ? html`
                                <span class="m-kpi-delta" data-tone="${kpi.delta.tone || 'neutral'}" style="display:block;">
                                    ${kpi.delta.value}
                                </span>
                            ` : ''}
                        </span>
                    </a>
                `)}
            </div>
        `;
    }

    /**
     * Each item is one tappable card rather than a card wrapping a button.
     *
     * The button underneath was the taller half of every item, and it led
     * exactly where the card above it was already about — four of them stacked
     * pushed the whole workspace past the fold on a phone. Dropping it halves
     * the block and makes the target bigger, since the whole card now takes
     * the tap instead of a strip inside it.
     *
     * The action wording stays, as a label under the detail. It is the only
     * part that says WHERE the card goes — "154 overdue invoices" alone does
     * not promise Chase payments — so it survives the button that used to
     * carry it.
     */
    attention(items) {
        if (panelFailed(items)) return '';

        return html`
            <h2 class="m-section-label">Needs attention</h2>
            <div class="m-stack">
                ${items?.length ? items.map((item) => html`
                    <a class="m-card m-attn" href="${item.link}">
                        <span class="m-dot" data-severity="${item.severity}"></span>
                        <div style="flex:1;min-width:0;">
                            <div class="m-attn-title">${item.title}</div>
                            <div class="m-attn-detail">${item.detail}</div>
                            <div class="m-attn-action">${item.action}</div>
                        </div>
                        <span class="m-attn-chev">${raw(icon('chevron-right', { size: 16 }))}</span>
                    </a>
                `) : html`<div class="m-card m-empty">Nothing needs attention.</div>`}
            </div>
        `;
    }

}

/* ------------------------------------------------------------------ HELPERS */

/** A panel the service failure-isolated into `{ error }` rather than data. */
function panelFailed(panel) {
    return Boolean(panel && !Array.isArray(panel) && panel.error);
}

function kpiValue(kpi) {
    if (kpi.money) return formatMoneyShort(kpi.value || 0);
    if (typeof kpi.value === 'number') return `${formatNumber(kpi.value)}${kpi.unit || ''}`;
    return `${kpi.value ?? '—'}${kpi.unit || ''}`;
}
