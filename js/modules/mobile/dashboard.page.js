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
import { showLoadError } from '../../ui/loadState.js';
import { overview, forTeacher } from '../../services/dashboard.service.js';
import { sparkline, pairedBars, donut, deltaChip } from '../../ui/charts.js';

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
                /*
                 * session.staffId, NOT actorId() — UAT5 ENH-512.
                 *
                 * forTeacher() ends at batches$.byTeacher(), which matches
                 * `batch.teacherId` — a staff document id like STF-SUREKHA.
                 * actorId() is the `users` document id, which is an email. The
                 * two never matched, so this screen showed a teacher zero
                 * classes and zero pending registers on a day they were
                 * teaching five batches. Verified against live data before
                 * changing it: five found by staff id, none by email.
                 *
                 * A teacher with no staff record resolves to null and gets the
                 * empty state, which is honest — there is nothing to link them
                 * to a class.
                 */
                ? this.teacherView(await forTeacher(session.staffId))
                // Only the two panels ownerView() renders. The workspace
                // redesign (ENH-301) stopped showing the other eight; asking
                // for them anyway spent half this screen's load time building
                // data that went straight in the bin.
                : this.ownerView(await overview({
                    branchId: session.branch(),
                    panels: ['headline', 'attention']
                }));

            if (this.disposed) return;
            render(this.container, html`<div data-role="body">${view}</div>`);

            // Current Trends comes second, on purpose — see loadTrends().
            if (!this.teacherMode) this.loadTrends();
        } catch (err) {
            if (this.disposed) return;
            console.error('Dashboard failed to load', err);
            // The data-role wrapper is rebuilt first: load() locates its own
            // target through it, so a retry from inside the error view needs
            // it present or the second attempt paints over the whole page.
            render(this.container, html`<div data-role="body"></div>`);
            showLoadError(this.container.querySelector('[data-role="body"]'), {
                what: 'The dashboard', error: err, onRetry: () => this.load()
            });
        }
    }

    /**
     * The charts, fetched AFTER the screen is already usable — ENH-506.
     *
     * A second request where there was one, and it is the right trade. The
     * `trends` panel reads every invoice and every student to draw six months
     * of four series (see dashboard.service.js, which says so at greater
     * length); putting it in the first `Promise.all` would have made the most
     * opened screen in the app wait on the heaviest query it has, for pictures
     * that are the last thing the eye reaches.
     *
     * So the figures and Needs attention paint immediately, the trends section
     * shows its own skeleton, and the charts drop in when they arrive. A
     * failure here removes one section and says so, rather than costing anyone
     * their dashboard — the same failure-isolation rule the service applies
     * between panels, extended across the two requests.
     */
    async loadTrends() {
        const host = this.container?.querySelector('[data-role="trends"]');
        if (!host) return;

        try {
            const { trends } = await overview({ branchId: session.branch(), panels: ['trends'] });
            if (this.disposed) return;
            if (panelFailed(trends)) throw new Error(trends.error);
            render(host, this.trends(trends));
        } catch (err) {
            if (this.disposed) return;
            console.error('Dashboard trends failed to load', err);
            render(host, html`
                <div class="m-card m-empty">
                    The trend charts could not be built. Everything else on this screen is complete.
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
            <!--
                UAT5 ENH-506 — filled by loadTrends() once the heavy query
                returns. Rendered as a placeholder rather than appended later so
                the section keeps its place in the order: the charts must land
                between the figures and Needs attention, not after whatever
                happened to paint by then.
            -->
            <div data-role="trends">
                <h2 class="m-section-label" style="margin-top:18px;">Current trends</h2>
                <div class="m-card m-skeleton">Drawing six months…</div>
            </div>
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

    /* ========================================================= CURRENT TRENDS */

    /**
     * Current Trends as visual analytics — UAT5 ENH-506.
     *
     * WHAT THIS REPLACED: five stat cards with an icon and a number each. The
     * figures were right and they are still here, in the strip above; what they
     * could not do was answer "is that good?". ₹1.4L collected means nothing
     * without last month beside it, and a rate of 78% means nothing without the
     * five months that led to it.
     *
     * FIVE CHARTS, ONE SCREEN'S WORTH.
     *   - Money in against money out, six months, paired bars — the one chart
     *     that shows whether the school is actually ahead.
     *   - This month's split as a donut, with the net in the middle.
     *   - Students, attendance and collection as sparklines, three across.
     *
     * EVERY CHART CARRIES ITS NUMBER. A sparkline is a shape, not a value, and
     * a dashboard that makes someone estimate a figure off a 32-pixel line has
     * replaced information with decoration. The current value is printed beside
     * each one and the direction is a chip, so the charts can be ignored
     * entirely and the section still reads.
     *
     * WHAT DID NOT CHANGE, and was asked not to: Needs attention keeps its
     * business logic and its alert cards, and the three workspace groups are
     * untouched. This section sits between them.
     */
    trends(t) {
        if (!t) return '';

        const money = t.money || [];
        const growth = t.growth || [];
        const attendance = t.attendance || [];
        const collection = t.collection || [];
        const split = t.split || { income: 0, expense: 0, net: 0 };

        return html`
            <h2 class="m-section-label" style="margin-top:18px;">Current trends</h2>

            ${money.length ? html`
                <section class="m-card" style="padding:14px;margin-bottom:10px;">
                    <div class="m-subhead-row" style="justify-content:space-between;">
                        <span class="m-kpi-label">Money in and out</span>
                        <span class="m-student-meta">Last ${money.length} months</span>
                    </div>
                    ${raw(pairedBars(money, {
                        label: `Money in against money out over ${money.length} months`
                    }))}
                    <div class="m-chart-axis">
                        ${money.map((m) => html`<span>${shortMonth(m.label)}</span>`)}
                    </div>
                    <div class="m-chart-key">
                        <span data-tone="positive">In ${formatMoneyShort(sumOf(money, 'income'))}</span>
                        <span data-tone="negative">Out ${formatMoneyShort(sumOf(money, 'expense'))}</span>
                    </div>
                </section>
            ` : ''}

            <section class="m-card m-split" style="padding:14px;margin-bottom:10px;">
                ${raw(donut(
                    [
                        { value: split.income, tone: 'positive' },
                        { value: split.expense, tone: 'negative' }
                    ],
                    {
                        label: `This month: ${formatMoneyShort(split.income)} in, ${formatMoneyShort(split.expense)} out`,
                        centre: split.income || split.expense
                            ? `${Math.round((split.income / Math.max(1, split.income + split.expense)) * 100)}%`
                            : ''
                    }
                ))}
                <div style="flex:1;min-width:0;">
                    <div class="m-kpi-label">This month</div>
                    <div class="m-metrics" style="margin-top:8px;grid-template-columns:repeat(3,1fr);">
                        ${trendMetric('In', formatMoneyShort(split.income), 'in')}
                        ${trendMetric('Out', formatMoneyShort(split.expense), 'out')}
                        ${trendMetric('Net', formatMoneyShort(split.net), split.net >= 0 ? 'in' : 'out')}
                    </div>
                </div>
            </section>

            <div class="m-trend-grid">
                ${miniTrend({
                    label: 'Students',
                    series: growth,
                    valueOf: (row) => row.total ?? 0,
                    display: (row) => formatNumber(row.total ?? 0),
                    // Growth is good; shrinking is not. Judged from the series
                    // rather than from the caller so the arrow and the colour
                    // cannot disagree.
                    higherIsBetter: true,
                    link: '#/students'
                })}
                ${miniTrend({
                    label: 'Attendance',
                    series: attendance,
                    valueOf: (row) => row.rate ?? 0,
                    display: (row) => (row.rate === null || row.rate === undefined ? '—' : `${row.rate}%`),
                    higherIsBetter: true,
                    link: '#/timetable'
                })}
                ${miniTrend({
                    label: 'Collected',
                    series: collection,
                    valueOf: (row) => row.collected ?? 0,
                    display: (row) => formatMoneyShort(row.collected ?? 0),
                    higherIsBetter: true,
                    link: '#/fees'
                })}
            </div>

            ${session.can('report.view') ? html`
                <a class="m-btn m-btn-ghost m-btn-block" href="#/analytics?series=money&months=6"
                   style="margin-bottom:4px;">
                    ${raw(icon('bar-chart', { size: 16 }))} All analytics
                </a>
            ` : ''}
        `;
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

/* ------------------------------------------------------- CURRENT TRENDS */

/**
 * One sparkline card: the current value, its direction, and the shape behind
 * it — ENH-506.
 *
 * THE DIRECTION IS THE LAST MONTH AGAINST THE ONE BEFORE, not against the start
 * of the series. "12% up on last month" is a sentence someone can act on; "12%
 * up on six months ago" is a fact about February.
 *
 * A card whose series is empty renders as an em dash rather than disappearing.
 * A missing chart reads as "the school has no students"; an em dash reads as
 * "no figure", which is what it means.
 */
function miniTrend({ label, series, valueOf, display, higherIsBetter, link }) {
    const rows = Array.isArray(series) ? series : [];
    const last = rows[rows.length - 1];
    const previous = rows[rows.length - 2];

    const current = last ? valueOf(last) : null;
    const before = previous ? valueOf(previous) : null;

    // No previous month, or a previous month of zero, means there is no
    // percentage to state — a change from nothing is not "infinity per cent".
    const percent = before ? ((current - before) / Math.abs(before)) * 100 : null;
    const good = percent === null ? null : (percent >= 0) === Boolean(higherIsBetter);

    return html`
        <a class="m-card m-mini-trend" href="${link}">
            <span class="m-kpi-label">${label}</span>
            <span class="m-mini-trend-value">${last ? display(last) : '—'}</span>
            ${raw(deltaChip(percent, { good, suffix: ' on last month' }))}
            ${rows.length > 1 ? raw(sparkline(rows.map(valueOf), {
                tone: good === false ? 'negative' : 'positive',
                label: `${label} over ${rows.length} months`
            })) : ''}
        </a>
    `;
}

/** A figure inside the income/expense split card. */
function trendMetric(label, value, tone) {
    return html`
        <div class="m-metric" data-tone="${tone}">
            <span class="m-metric-value">${value}</span>
            <span class="m-metric-label">${label}</span>
        </div>
    `;
}

/** "Aug 2026" → "Aug". Six full labels do not fit under a 350px chart. */
function shortMonth(label) {
    return String(label || '').split(' ')[0];
}

function sumOf(rows, key) {
    return (rows || []).reduce((total, row) => total + (row[key] || 0), 0);
}

function kpiValue(kpi) {
    if (kpi.money) return formatMoneyShort(kpi.value || 0);
    if (typeof kpi.value === 'number') return `${formatNumber(kpi.value)}${kpi.unit || ''}`;
    return `${kpi.value ?? '—'}${kpi.unit || ''}`;
}
