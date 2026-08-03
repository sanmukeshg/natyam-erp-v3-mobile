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
import { formatMoney, formatMoneyShort, formatNumber } from '../../utils/money.js';
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
    allowed(action) {
        if (action.link === '#/fees') return session.can('fee.view');
        if (action.link === '#/students') return session.can('student.view');
        if (action.link === '#/attendance') return session.can('attendance.view');
        return true;
    }

    /* ========================================================= OWNER VARIANT */

    ownerView(data) {
        return html`
            ${this.kpiStrip(data.headline)}
            ${this.attention(data.attention)}
            ${this.insights(data)}
            ${this.activity(data.activity)}
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

    attention(items) {
        if (panelFailed(items)) return '';

        return html`
            <h2 class="m-section-label">Needs attention</h2>
            <div class="m-stack">
                ${items?.length ? items.map((item) => html`
                    <div class="m-card m-attn">
                        <div class="m-attn-head">
                            <span class="m-dot" data-severity="${item.severity}"></span>
                            <div style="flex:1;min-width:0;">
                                <div class="m-attn-title">${item.title}</div>
                                <div class="m-attn-detail">${item.detail}</div>
                            </div>
                        </div>
                        <a class="m-btn m-btn-ghost m-btn-block" href="${item.link}">${item.action}</a>
                    </div>
                `) : html`<div class="m-card m-empty">Nothing needs attention.</div>`}
            </div>
        `;
    }

    /**
     * The design's 2×2 insight tiles. Assembled from panels the service
     * already returned rather than a second round of queries.
     */
    insights(data) {
        const money = panelFailed(data.money) ? null : data.money;
        const roll = panelFailed(data.roll) ? null : data.roll;
        const today = panelFailed(data.today) ? null : data.today;
        const attendanceKpi = Array.isArray(data.headline)
            ? data.headline.find((kpi) => kpi.key === 'attendance') : null;

        const tiles = [
            { label: 'This month', value: money ? formatMoneyShort(money.collectedThisMonth || 0) : '—',
              foot: 'collected', link: '#/fees' },
            { label: 'Attendance', value: attendanceKpi ? `${attendanceKpi.value}${attendanceKpi.unit || ''}` : '—',
              foot: 'last 30 days', link: '#/attendance' },
            { label: 'Registers', value: today ? `${today.registersDone ?? 0}/${today.total ?? 0}` : '—',
              foot: 'marked today', link: '#/attendance' },
            { label: 'Roll', value: roll ? formatNumber(roll.total || 0) : '—',
              foot: roll?.capacity?.occupancy != null ? `${roll.capacity.occupancy}% of seats` : 'active students',
              link: '#/students' }
        ];

        return html`
            <h2 class="m-section-label">Insights</h2>
            <div class="m-grid-2">
                ${tiles.map((tile) => html`
                    <a class="m-card m-insight" href="${tile.link}">
                        <span class="m-insight-label">${tile.label}</span>
                        <span class="m-insight-value" style="display:block;">${tile.value}</span>
                        <span class="m-insight-foot" style="display:block;">${tile.foot}</span>
                    </a>
                `)}
            </div>
        `;
    }

    activity(rows) {
        if (panelFailed(rows) || !rows?.length) return '';

        return html`
            <h2 class="m-section-label">Recent activity</h2>
            <div class="m-stack">
                ${rows.slice(0, 6).map((entry) => html`
                    <div class="m-card m-activity">
                        <span class="m-dot"></span>
                        <div style="flex:1;min-width:0;">
                            <div class="m-activity-text">${entry.summary}</div>
                            <div class="m-activity-meta">${entry.ago}</div>
                        </div>
                    </div>
                `)}
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
