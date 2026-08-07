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
import { toast } from '../../ui/toast.js';
import { formatMoneyShort, formatNumber } from '../../utils/money.js';
import { formatDateLong, localDate, addDays } from '../../utils/date.js';
import { analyticsOverview } from '../../services/analytics.service.js';
import { showLoadError } from '../../ui/loadState.js';
// The same primitives the owner dashboard's Current Trends uses (ENH-506), so
// a donut means the same thing on both screens.
import { donut, pairedBars } from '../../ui/charts.js';
// UAT5 ENH-505 filters. curriculum() is the Course list — a student is placed
// at a curriculum level, and that is what 'course' means in this school.
import { curriculum } from '../../config/app.config.js';
import { listAcademicYears } from '../../services/settings.service.js';
import { listBatches } from '../../services/batches.service.js';

/*
 * UAT5 ENH-504 Part 2 — the ranges the Finance trend came here to get.
 *
 * `days` drives the SUMMARY window exactly: analyticsOverview() passes from/to
 * straight to profitAndLoss() and the comparisons, so "Last 30 days" really is
 * the last thirty days. `months` is how many monthly buckets the TREND draws
 * underneath, and it has to be whole months because every series in the
 * service is bucketed by `period` — a thirty-day window that straddles a month
 * boundary touches two of them, which is why 30d asks for 2 and not 1.
 *
 * The subhead prints the resolved window, so the two are never left to be
 * inferred from a chip label.
 */
const RANGES = [
    { key: '30d', label: '30 days', days: 30, months: 2 },
    { key: '3m',  label: '3 months', months: 3 },
    { key: '6m',  label: '6 months', months: 6 },
    { key: '12m', label: '12 months', months: 12 },
    { key: 'custom', label: 'Custom', custom: true }
];

/**
 * The five series, behind a toggle.
 *
 * Each names its own accessor because the five source services do not agree on
 * field names (`total` vs `closing`, `income` vs `value`) — the same tolerance
 * the desktop page needs, for the same reason.
 *
 * `money` is the Finance page's old "Last six months" block, moved here whole
 * (ENH-504 Part 2). It reads the same `revenue` payload as Income — both come
 * from monthlySeries() — but draws money in AND money out against a shared
 * scale, which is the comparison the block existed for and the one a single
 * income bar cannot make. Income stays as its own entry because a revenue line
 * on its own is still worth seeing.
 */
const SERIES = [
    { key: 'growth', label: 'Students',
      valueOf: (m) => m.total ?? m.closing ?? 0,
      labelOf: (m) => formatNumber(m.total ?? m.closing ?? 0) },
    { key: 'money', label: 'Money', from: 'revenue',
      valueOf: (m) => Math.max(m.income ?? 0, m.expense ?? 0),
      labelOf: (m) => formatMoneyShort(m.net ?? 0),
      toneOf: (m) => ((m.net ?? 0) >= 0 ? 'clear' : 'overdue'),
      // Two bars on one scale: what came in, what went out.
      barsOf: (m) => [
          { tone: 'positive', value: m.income ?? 0 },
          { tone: 'negative', value: m.expense ?? 0 }
      ] },
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

        // `months` in the URL is still honoured — Finance links here with
        // ?series=money&months=6, and older bookmarks carry it too. It picks
        // the matching chip rather than being kept as a separate piece of
        // state, so the two can never disagree.
        const months = Number(this.query.months) || 12;
        this.range = RANGES.find((r) => r.months === months && !r.custom) || RANGES[3];
        this.custom = { from: '', to: '' };
        this.series = this.query.series || 'growth';

        /*
         * UAT5 ENH-505 filters, matching natyam-admin exactly.
         *
         * `year` is a RANGE rather than a dimension — an academic year is a
         * startsOn/endsOn pair — so it reaches every panel. `batchId` and
         * `level` are the cohort and narrow the student-shaped panels only;
         * the money panels cannot follow, and the page says so.
         */
        this.year = null;
        this.batchId = null;
        this.level = null;
        this.options = { years: [], batches: [] };
        this.filtersOpen = false;
        this.data = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Gathering the numbers…</div>`);
        this.bind();
        await this.loadOptions();
        await this.load();
        this.events.on(EVENTS.BRANCH_CHANGED, () => this.load());
    }

    /**
     * The chosen range as the service wants it: whole months for the trend
     * buckets, and an explicit from/to for everything that measures a window.
     */
    resolveRange() {
        const to = localDate();

        // An academic year IS a range — ENH-505. Capped at today, because a
        // year running to next March must not draw eight empty months.
        if (this.year) {
            const until = this.year.endsOn < to ? this.year.endsOn : to;
            return { months: monthsBetween(this.year.startsOn), from: this.year.startsOn, to: until };
        }

        if (this.range.custom) {
            const { from, to: until } = this.custom;
            if (!from || !until) return { months: 12 };     // nothing chosen yet
            return { months: monthsBetween(from), from, to: until };
        }

        if (this.range.days) {
            return { months: this.range.months, from: addDays(to, -(this.range.days - 1)), to };
        }

        return { months: this.range.months };
    }

    /** Everything the filter panel offers. Fetched once — it rarely changes. */
    async loadOptions() {
        const [years, batches] = await Promise.all([
            listAcademicYears().catch(() => []),
            listBatches(session.branch()).catch(() => [])
        ]);
        this.options = { years, batches: batches.filter((b) => b.status !== 'closed') };
    }

    async load() {
        try {
            this.data = await analyticsOverview({
                branchId: session.branch(),
                batchId: this.batchId,
                level: this.level,
                ...this.resolveRange()
            });
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
        // A series may read a payload it does not own — `money` and `revenue`
        // are two readings of the same monthlySeries() result.
        const source = Array.isArray(d[chosen.from || chosen.key]) ? d[chosen.from || chosen.key] : [];

        /*
         * Trim the buckets to the window in the subhead.
         *
         * The series always count BACK from today — lastMonths() cannot be
         * asked for a window ending in the past — so a custom range of 15 May
         * to 20 July arrived with an August bucket attached, under a heading
         * that stopped in July. A bucket survives if its month overlaps the
         * range, which for the fixed ranges is all of them and changes nothing.
         */
        const rows = source.filter((m) => !m.period
            || (m.period >= d.range.from.slice(0, 7) && m.period <= d.range.to.slice(0, 7)));

        const peak = Math.max(1, ...rows.map((m) => Math.abs(chosen.valueOf(m) || 0)));

        render(this.container, html`
            <div class="m-subhead">
                <p class="m-subhead-note">
                    ${formatDateLong(d.range.from)} to ${formatDateLong(d.range.to)}
                </p>
                <div class="m-chip-scroll">
                    ${RANGES.map((r) => html`
                        <button class="m-pill" data-action="range" data-key="${r.key}"
                                aria-pressed="${this.range.key === r.key && !this.year ? 'true' : 'false'}">${r.label}</button>
                    `)}
                    <!--
                      UAT5 ENH-505 — the other three filters, behind a toggle.

                      Three selects cannot share a 375px header with five range
                      chips, and they are the rarer choice: most visits want a
                      range and the whole school. The pill carries a count so an
                      active filter is never hidden by the thing hiding it.
                    -->
                    <button class="m-pill" data-action="toggle-filters"
                            aria-pressed="${this.filtersOpen ? 'true' : 'false'}">
                        ${raw(icon('filter', { size: 13 }))} ${
                            [this.year, this.level, this.batchId].filter(Boolean).length || ''
                        }
                    </button>
                </div>

                ${this.filtersOpen ? html`
                    <div class="m-stack" style="margin-top:8px;gap:8px;">
                        ${this.options.years.length ? html`
                            <select class="m-input" data-role="year" aria-label="Academic year">
                                <option value="">Any academic year</option>
                                ${this.options.years.map((y) => html`
                                    <option value="${y.id}" ${this.year?.id === y.id ? 'selected' : ''}>
                                        ${y.name || y.label || y.id}
                                    </option>
                                `)}
                            </select>
                        ` : ''}
                        <select class="m-input" data-role="level" aria-label="Course">
                            <option value="">Any course</option>
                            ${curriculum().map((l) => html`
                                <option value="${l.value}" ${this.level === l.value ? 'selected' : ''}>${l.label}</option>
                            `)}
                        </select>
                        <select class="m-input" data-role="batch" aria-label="Batch">
                            <option value="">Any batch</option>
                            ${this.options.batches.map((b) => html`
                                <option value="${b.id}" ${this.batchId === b.id ? 'selected' : ''}>${b.name}</option>
                            `)}
                        </select>
                    </div>
                ` : ''}

                ${this.range.custom && !this.year ? html`
                    <div class="m-subhead-row" style="gap:8px;margin-top:8px;">
                        <input class="m-input" type="date" data-role="from" value="${this.custom.from}"
                               max="${localDate()}" aria-label="From">
                        <input class="m-input" type="date" data-role="to" value="${this.custom.to}"
                               max="${localDate()}" aria-label="To">
                    </div>
                    ${this.custom.from && this.custom.to ? '' : html`
                        <p class="m-subhead-note" style="margin-top:6px;">
                            Pick both dates. Until then these are the last twelve months.
                        </p>
                    `}
                ` : ''}
            </div>

            ${d.failed?.length ? html`
                <div class="m-notice" data-tone="caution" style="margin-bottom:10px;">
                    ${d.failed.length} panel${d.failed.length === 1 ? '' : 's'} could not be built: ${d.failed.join(', ')}.
                    Read the rest knowing those are missing.
                </div>
            ` : ''}

            <!--
                UAT5 ENH-505 — executive KPI cards, not a list of rows.

                The eight figures the enhancement names, two across, each with
                its direction. They were full-width rows before: eight of them
                filled two screens and buried the charts, which is the "long
                scrolling list of statistics" the ticket is about. A card is
                narrower than a row, so the ARROW does the work the words used
                to and the value stays the largest thing on it.
            -->
            <!--
              UAT5 ENH-505 — what the cohort filter does NOT reach.

              Said out loud, above the figures, because the alternative is a
              page that lies by omission: a batch named in the filter bar over
              ₹26,500 of Utilities, and a reader would be right to think one
              class spent it. The ledger carries a branch and nothing finer.
            -->
            ${d.cohort ? html`
                <div class="m-notice" data-tone="info" style="margin-bottom:10px;">
                    Filtered to ${d.cohort.size} student${d.cohort.size === 1 ? '' : 's'}. Students,
                    attendance, batches and admissions follow it.${
                        d.cohort.moneyIsSchoolWide
                            ? ' Money is school-wide — it is recorded against a branch, never a batch or course.'
                            : ''
                    }
                </div>
            ` : ''}

            ${d.kpis ? html`
                <div class="m-kpi-grid">
                    ${Object.values(d.kpis).map((k) => kpiCard(k))}
                </div>
            ` : ''}

            ${d.insights?.length ? html`
                <p class="m-section-label" style="margin-top:16px;">What this says</p>
                <div class="m-stack">
                    ${d.insights.map((insight) => html`
                        <a class="m-card m-attn" href="${insight.link}">
                            <span class="m-dot" data-severity="${
                                insight.tone === 'caution' ? 'medium' : insight.tone === 'positive' ? 'low' : 'info'
                            }"></span>
                            <div style="flex:1;min-width:0;">
                                <div class="m-attn-title">${insight.title}</div>
                                <div class="m-attn-detail">${insight.detail}</div>
                            </div>
                            <span class="m-attn-chev">${raw(icon('chevron-right', { size: 16 }))}</span>
                        </a>
                    `)}
                </div>
            ` : ''}

            ${this.mixSection(d)}
            ${this.batchSection(d)}

            <p class="m-section-label" style="margin-top:16px;">Trend</p>
            <div class="m-chip-scroll">
                ${SERIES.map((s) => html`
                    <button class="m-pill" data-action="series" data-key="${s.key}"
                            aria-pressed="${this.series === s.key ? 'true' : 'false'}">${s.label}</button>
                `)}
            </div>

            ${chosen.key === 'money' ? html`
                <p class="m-subhead-note" style="margin:-2px 0 8px;">
                    Money in above, money out below, on one scale. The badge is the month’s net.
                </p>
            ` : ''}

            <!--
              Four months tall, the rest behind a scroll — asked for directly,
              and the same cap natyam-admin's trend cards use.

              Twelve months of cards is most of a phone screen per series, and
              on this school's data most of them read zero. The list starts at
              its NEWEST end (scrollTrendsToLatest) because the rows are
              chronological and a plain cap would have shown four empty months
              while hiding the only one with figures in it.
            -->
            ${rows.length ? html`
                <div class="m-stack m-trend-cap" data-role="trend-list">
                    ${rows.map((m) => html`
                        <div class="m-card" style="padding:12px 14px;">
                            <div class="m-subhead-row" style="justify-content:space-between;">
                                <span class="m-student-name">${m.label || m.period || m.month}</span>
                                <span class="m-badge" data-fee="${chosen.toneOf ? chosen.toneOf(m) : ''}">
                                    ${chosen.labelOf(m)}
                                </span>
                            </div>
                            <div class="m-trend" style="margin-top:8px;">
                                ${(chosen.barsOf
                                    ? chosen.barsOf(m)
                                    : [{ tone: 'positive', value: Math.abs(chosen.valueOf(m) || 0) }]
                                ).map((bar) => html`
                                    <span class="m-trend-bar" data-tone="${bar.tone}"
                                          style="width:${Math.round((Math.abs(bar.value || 0) / peak) * 100)}%"></span>
                                `)}
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

        this.scrollTrendsToLatest();
    }

    /**
     * Start the capped trend list at its NEWEST end.
     *
     * The rows are chronological — a trend has to read in time order — so the
     * months worth seeing are the last ones. Capping the height alone would
     * park the view on the oldest four, which for this school is four months
     * of zeroes with the only real figures scrolled out of sight.
     *
     * Done here rather than by reversing the data, because reversing would put
     * the trend backwards while the bars beside it still read forwards. The
     * scroll still goes up for anyone wanting the history.
     */
    scrollTrendsToLatest() {
        this.container.querySelectorAll('[data-role="trend-list"]').forEach((list) => {
            list.scrollTop = list.scrollHeight;
        });
    }

    /**
     * The two pies — where income came from, where it went (ENH-505).
     *
     * A donut plus a ranked list, not a donut alone. Six slices of similar size
     * are indistinguishable at 74px and the legend is where the answer actually
     * is; the ring is there to show concentration at a glance — one dominant
     * account looks different from six even ones — and the list carries the
     * figures.
     *
     * Top five, then "everything else". A category worth 2% is a sliver nobody
     * can point at, and a legend of fourteen rows is the list this ticket exists
     * to remove.
     */
    mixSection(d) {
        const pie = (title, mix, tone) => {
            const rows = mix?.categories || [];
            if (!rows.length) return '';

            const top = rows.slice(0, 5);
            const rest = rows.slice(5);
            const other = rest.reduce((sum, r) => sum + r.amount, 0);
            const slices = [
                ...top.map((r, i) => ({ value: r.amount, tone: i === 0 ? tone : 'neutral' })),
                ...(other ? [{ value: other, tone: 'neutral' }] : [])
            ];

            return html`
                <section class="m-card m-split" style="padding:14px;margin-bottom:10px;">
                    ${raw(donut(slices, {
                        label: `${title}: ${top.map((r) => `${r.category} ${r.share}%`).join(', ')}`,
                        centre: top[0] ? `${top[0].share}%` : ''
                    }))}
                    <div style="flex:1;min-width:0;">
                        <div class="m-kpi-label">${title}</div>
                        <dl class="m-facts" style="margin-top:8px;">
                            ${top.map((r) => html`
                                <div class="m-fact">
                                    <dt>${r.category}</dt>
                                    <dd>${formatMoneyShort(r.amount)} · ${r.share}%</dd>
                                </div>
                            `)}
                            ${other ? html`
                                <div class="m-fact">
                                    <dt>${rest.length} more</dt>
                                    <dd>${formatMoneyShort(other)}</dd>
                                </div>
                            ` : ''}
                        </dl>
                    </div>
                </section>
            `;
        };

        const income = pie('Income by category', d.incomeMix, 'positive');
        const expense = pie('Expenses by category', d.expenseMix, 'negative');
        if (!income && !expense) return '';

        return html`
            <p class="m-section-label" style="margin-top:16px;">Where the money is</p>
            ${income}
            ${expense}
        `;
    }

    /**
     * Batch sizes and admissions by month (ENH-505).
     *
     * Meters rather than a bar chart for the batches: the label is as important
     * as the length — "Kondapur Senior" means something, a bar at x=3 does not —
     * and a horizontal meter carries both on a 375px screen where a vertical bar
     * chart would need rotated text.
     */
    batchSection(d) {
        const batches = d.batches?.rows || [];
        const admissions = d.admissionsMonthly || [];
        if (!batches.length && !admissions.length) return '';

        const peak = Math.max(1, ...batches.map((b) => b.value));
        const appliedPeak = Math.max(1, ...admissions.map((m) => m.applied));

        return html`
            ${batches.length ? html`
                <p class="m-section-label" style="margin-top:16px;">Students by batch</p>
                <section class="m-card" style="padding:14px;margin-bottom:10px;">
                    ${batches.map((batch) => html`
                        <div class="m-meter">
                            <div class="m-meter-head">
                                <span>${batch.label}</span>
                                <span>${batch.value}${batch.capacity ? `/${batch.capacity}` : ''}</span>
                            </div>
                            <div class="m-meter-track">
                                <div class="m-meter-fill"
                                     data-tone="${batch.key === 'unplaced' ? 'caution' : 'accent'}"
                                     style="width:${Math.round((batch.value / peak) * 100)}%;"></div>
                            </div>
                        </div>
                    `)}
                </section>
            ` : ''}

            ${admissions.length ? html`
                <p class="m-section-label" style="margin-top:16px;">Admissions by month</p>
                <section class="m-card" style="padding:14px;margin-bottom:10px;">
                    <p class="m-subhead-note" style="margin:0 0 4px;">
                        Applied against enrolled, dated by when the family applied.
                    </p>
                    ${raw(pairedBars(
                        admissions.map((m) => ({ income: m.applied, expense: m.enrolled })),
                        { label: 'Applications against enrolments by month' }
                    ))}
                    <div class="m-chart-axis">
                        ${admissions.map((m) => html`<span>${String(m.label).split(' ')[0]}</span>`)}
                    </div>
                    <div class="m-chart-key">
                        <span data-tone="positive">Applied ${admissions.reduce((s, m) => s + m.applied, 0)}</span>
                        <span data-tone="negative">Enrolled ${admissions.reduce((s, m) => s + m.enrolled, 0)}</span>
                    </div>
                    ${appliedPeak ? '' : html`<p class="m-subhead-note">No applications in this range.</p>`}
                </section>
            ` : ''}
        `;
    }

    bind() {
        const root = this.container;

        // UAT5 ENH-505 — the three filters. Each reloads; none is a repaint,
        // because every one changes what the service is asked for.
        const rebuild = () => {
            render(root, html`<div class="m-skeleton">Rebuilding…</div>`);
            this.load();
        };

        this.onDispose(on(root, 'click', '[data-action="toggle-filters"]', () => {
            this.filtersOpen = !this.filtersOpen;
            this.paint();
        }));
        this.onDispose(on(root, 'change', '[data-role="year"]', (_e, t) => {
            this.year = this.options.years.find((y) => y.id === t.value) || null;
            rebuild();
        }));
        this.onDispose(on(root, 'change', '[data-role="level"]', (_e, t) => {
            this.level = t.value || null;
            rebuild();
        }));
        this.onDispose(on(root, 'change', '[data-role="batch"]', (_e, t) => {
            this.batchId = t.value || null;
            rebuild();
        }));

        this.onDispose(on(root, 'click', '[data-action="range"]', (_e, t) => {
            const next = RANGES.find((r) => r.key === t.dataset.key);
            if (!next || (next.key === this.range.key && !this.year)) return;
            // A range chip clears an academic year — two ways of saying the
            // same thing, and both must not be lit at once.
            this.year = null;
            this.range = next;

            // Opening the custom pickers refetches nothing — there is no window
            // yet. Repaint so the two date fields appear.
            if (next.custom && !(this.custom.from && this.custom.to)) { this.paint(); return; }

            render(root, html`<div class="m-skeleton">Rebuilding…</div>`);
            this.load();
        }));

        // A custom range is only queried once both ends are set; a half-open
        // window would silently report the last twelve months under a heading
        // that says otherwise.
        this.onDispose(on(root, 'change', '[data-role="from"], [data-role="to"]', (_e, t) => {
            this.custom[t.dataset.role] = t.value;
            if (!(this.custom.from && this.custom.to)) return;
            if (this.custom.from > this.custom.to) {
                toast.error('Check the dates', 'The start of the range is after its end.');
                return;
            }
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

/**
 * How many monthly buckets a custom window touches, inclusive of both ends.
 *
 * The trend series are bucketed by `period` and always count BACK from today,
 * so a window ending in the past needs enough buckets to reach it — which is
 * why this measures from the start of the range to now rather than to the
 * range's own end. Capped at ten years: a mistyped year should cost one odd
 * chart, not a hundred and twenty queries.
 */
function monthsBetween(from) {
    const start = new Date(`${from}T00:00:00`);
    const now = new Date();
    const span = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
    return Math.min(120, Math.max(1, span));
}

/**
 * One `kpi()` record from analytics.service, as an executive card — ENH-505.
 *
 * Was a full-width row with the value on the left and the delta as a badge on
 * the right. Eight of those is the long list of statistics the ticket is
 * about, so this is half the width and stacks label → value → change, which is
 * also the order they are read in.
 *
 * `good` is the SERVICE's judgement and is never re-derived here from the sign
 * of the delta. It already knows a rising outstanding balance is bad while
 * rising income is good; deciding that twice is how the two end up disagreeing.
 * A KPI with no comparison (Total students) renders no chip at all rather than
 * a grey zero.
 */
function kpiCard(k) {
    if (!k) return '';

    const value = k.format === 'money' ? formatMoneyShort(k.value || 0)
        : k.format === 'percent' ? (k.value === null ? '—' : `${k.value}%`)
        : formatNumber(k.value || 0);

    const tone = k.good === null || k.good === undefined ? 'neutral' : (k.good ? 'positive' : 'negative');

    const delta = k.delta === null || k.delta === undefined || k.delta === 0 ? null
        : k.format === 'money' ? formatMoneyShort(Math.abs(k.delta))
        : k.format === 'percent' ? `${Math.abs(k.delta)}%`
        : formatNumber(Math.abs(k.delta));
    const arrow = k.direction === 'up' ? '▲' : k.direction === 'down' ? '▼' : '■';

    return html`
        <div class="m-card m-kpi-card">
            <span class="m-kpi-label">${k.label}</span>
            <span class="m-kpi-card-value">${value}</span>
            ${delta !== null ? html`
                <span class="m-delta" data-tone="${tone}">
                    <span aria-hidden="true">${arrow}</span> ${delta}
                </span>
            ` : html`<span class="m-delta" data-tone="neutral">&nbsp;</span>`}
        </div>
    `;
}
