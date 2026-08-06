/**
 * Natyam ERP v3 — Mobile — Analytics
 *
 * The headline figures and their direction, then the trends behind them. Not
 * the desktop's ten panels stacked — four of those are wide comparison tables
 * (branches, teachers) that would need horizontal scrolling to say anything,
 * and a table you have to drag sideways teaches nobody anything on a phone.
 *
 * So: **KPIs first, trends underneath, one tap to switch what is being
 * trended.** One chart at a time, full width, rather than four squeezed into a
 * column.
 *
 * The failed-panel notice is carried over from the desktop page and matters
 * more here, not less: `analyticsOverview()` uses `Promise.allSettled`, so a
 * broken query silently costs you a panel. On a screen where panels are already
 * behind a toggle, an unnamed missing one would be invisible.
 *
 * Read-only, in full. There is nothing to write on an analytics screen.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort, formatNumber } from '../../utils/money.js';
import { formatDateLong } from '../../utils/date.js';
import { analyticsOverview } from '../../services/analytics.service.js';
import { showLoadError } from '../../ui/loadState.js';

const RANGES = [
    { months: 6, label: '6m' },
    { months: 12, label: '12m' },
    { months: 24, label: '24m' }
];

/**
 * The four series, behind a toggle.
 *
 * Each names its own accessor because the five source services do not agree on
 * field names (`total` vs `closing`, `income` vs `value`) — the same tolerance
 * the desktop page needs, for the same reason.
 */
const SERIES = [
    { key: 'growth', label: 'Students',
      valueOf: (m) => m.total ?? m.closing ?? 0,
      labelOf: (m) => formatNumber(m.total ?? m.closing ?? 0) },
    { key: 'revenue', label: 'Income',
      valueOf: (m) => m.income ?? m.value ?? 0,
      labelOf: (m) => formatMoneyShort(m.income ?? m.value ?? 0) },
    { key: 'attendance', label: 'Attendance',
      valueOf: (m) => m.rate ?? 0,
      labelOf: (m) => (m.rate === null || m.rate === undefined ? '—' : `${m.rate}%`) },
    { key: 'collection', label: 'Collected',
      valueOf: (m) => m.collected ?? 0,
      labelOf: (m) => formatMoneyShort(m.collected ?? 0) }
];

export default class MobileAnalyticsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Analytics';
        this.months = Number(this.query.months) || 12;
        this.series = this.query.series || 'growth';
        this.data = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Gathering the numbers…</div>`);
        this.bind();
        await this.load();
        this.events.on(EVENTS.BRANCH_CHANGED, () => this.load());
    }

    async load() {
        try {
            this.data = await analyticsOverview({ branchId: session.branch(), months: this.months });
            if (this.disposed) return;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Analytics failed to load', err);
            showLoadError(this.container, { what: 'Analytics', error: err, onRetry: () => this.load() });
        }
    }

    paint() {
        const d = this.data;
        if (!d) return;

        const chosen = SERIES.find((s) => s.key === this.series) || SERIES[0];
        const rows = Array.isArray(d[chosen.key]) ? d[chosen.key] : [];
        const peak = Math.max(1, ...rows.map((m) => Math.abs(chosen.valueOf(m) || 0)));

        render(this.container, html`
            <div class="m-subhead">
                <p class="m-subhead-note">
                    ${formatDateLong(d.range.from)} to ${formatDateLong(d.range.to)}
                </p>
                <div class="m-chip-scroll">
                    ${RANGES.map((r) => html`
                        <button class="m-pill" data-action="range" data-months="${r.months}"
                                aria-pressed="${this.months === r.months ? 'true' : 'false'}">${r.label}</button>
                    `)}
                </div>
            </div>

            ${d.failed?.length ? html`
                <div class="m-notice" data-tone="caution" style="margin-bottom:10px;">
                    ${d.failed.length} of 10 panels could not be built: ${d.failed.join(', ')}.
                    Read the rest knowing those are missing.
                </div>
            ` : ''}

            ${d.kpis ? html`
                <div class="m-stack">
                    ${Object.values(d.kpis).map((k) => kpiRow(k))}
                </div>
            ` : ''}

            <p class="m-section-label" style="margin-top:16px;">Trend</p>
            <div class="m-chip-scroll">
                ${SERIES.map((s) => html`
                    <button class="m-pill" data-action="series" data-key="${s.key}"
                            aria-pressed="${this.series === s.key ? 'true' : 'false'}">${s.label}</button>
                `)}
            </div>

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((m) => html`
                        <div class="m-card" style="padding:12px 14px;">
                            <div class="m-subhead-row" style="justify-content:space-between;">
                                <span class="m-student-name">${m.label || m.period || m.month}</span>
                                <span class="m-badge">${chosen.labelOf(m)}</span>
                            </div>
                            <div class="m-trend" style="margin-top:8px;">
                                <span class="m-trend-bar" data-tone="positive"
                                      style="width:${Math.round((Math.abs(chosen.valueOf(m) || 0) / peak) * 100)}%"></span>
                            </div>
                        </div>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty">That trend is not available.</div>
            `}

            <p class="m-subhead-note" style="margin-top:16px;">
                Branch and teacher comparisons are on the desktop app — they are wide tables that
                only mean anything read side by side.
            </p>
        `);
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="range"]', (_e, t) => {
            const months = Number(t.dataset.months);
            if (months === this.months) return;
            this.months = months;
            render(root, html`<div class="m-skeleton">Rebuilding…</div>`);
            this.load();
        }));

        // Switching series is a repaint, not a refetch — every series is
        // already in the overview payload.
        this.onDispose(on(root, 'click', '[data-action="series"]', (_e, t) => {
            this.series = t.dataset.key;
            this.paint();
        }));
    }
}

/* ------------------------------------------------------------------ HELPERS */

/** One `kpi()` record from analytics.service, as a full-width row. */
function kpiRow(k) {
    if (!k) return '';
    const value = k.format === 'money' ? formatMoney(k.value || 0)
        : k.format === 'percent' ? (k.value === null ? '—' : `${k.value}%`)
        : formatNumber(k.value || 0);

    // `good` is the service's judgement — it already knows a rising outstanding
    // balance is bad while rising income is good, so it is not re-derived here
    // from the sign of the delta.
    const tone = k.good === null || k.good === undefined ? '' : (k.good ? 'clear' : 'overdue');

    const delta = k.delta === null || k.delta === undefined ? null
        : k.format === 'money' ? formatMoneyShort(Math.abs(k.delta))
        : k.format === 'percent' ? `${Math.abs(k.delta)}%`
        : formatNumber(Math.abs(k.delta));
    const arrow = k.direction === 'up' ? '↑' : k.direction === 'down' ? '↓' : '→';

    return html`
        <div class="m-card m-student">
            <span class="m-student-main">
                <span class="m-student-name">${value}</span>
                <span class="m-student-meta">${k.label}</span>
            </span>
            ${delta !== null ? html`
                <span class="m-badge" data-fee="${tone}">${arrow} ${delta}</span>
            ` : ''}
        </div>
    `;
}
