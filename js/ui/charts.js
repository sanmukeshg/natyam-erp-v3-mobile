/**
 * Natyam ERP v3 — Mobile — chart primitives
 *
 * Four small inline-SVG charts for the owner dashboard's Current Trends
 * section (UAT5 ENH-506). Nothing here is a charting library and nothing here
 * should grow into one — if a screen needs axes, tooltips and zoom, that screen
 * is Analytics on a desktop.
 *
 * NO DEPENDENCY, AND THAT IS THE DESIGN.
 *
 *   - This is an installed PWA with a service worker. A CDN chart library is a
 *     network request on a screen people open in a studio with one bar of
 *     signal, and a cache entry to version.
 *   - Every chart here is one <path> or a handful of <rect>s. The smallest
 *     serious library is fifty kilobytes to draw a six-point line.
 *   - `js/ui/chart.js` in v2 was the previous attempt and belonged to a
 *     stylesheet this app never loads. natyam-admin's finance page already says
 *     the same thing in its own comment about drawing bars as divs.
 *
 * COLOUR COMES FROM CSS, NOT FROM HERE. Every fill and stroke is a v3 token or
 * `currentColor`, so light and dark are the stylesheet's business and a chart
 * cannot end up the one element on screen that ignored a theme switch.
 *
 * Each function returns an HTML STRING, for `raw()` at the call site — the same
 * contract `icon()` already uses, so charts and icons compose the same way.
 *
 * ACCESSIBILITY: every chart takes a `label` and renders it as the SVG's
 * accessible name, because a line with no words is nothing to a screen reader.
 * The caller is still expected to print the numbers somewhere visible; these
 * are illustrations of figures, never the only copy of them.
 */

import { escapeHtml } from '../utils/dom.js';

const TONES = {
    positive: 'var(--v3-positive)',
    negative: 'var(--v3-negative)',
    caution:  'var(--v3-caution)',
    neutral:  'var(--v3-tone-neutral)',
    accent:   'var(--v3-terracotta)'
};

const colour = (tone) => TONES[tone] || TONES.accent;

/**
 * A sparkline: one series as a line over a soft fill.
 *
 * Drawn in a fixed 100×32 user space and stretched by CSS
 * (`preserveAspectRatio="none"`), so the caller sizes it in the layout rather
 * than passing pixel dimensions that would then need to match a container.
 * Stroke width is compensated with `vector-effect` so the stretch cannot make
 * the line thicker horizontally than vertically.
 *
 * A FLAT SERIES IS DRAWN FLAT, not as a full-height line. When every value is
 * equal there is no shape to show, and scaling to the peak would draw a
 * dramatic ceiling for a month where nothing changed — the most misleading
 * chart in the set. It sits on the midline instead.
 */
export function sparkline(values, { tone = 'accent', label = '' } = {}) {
    const points = (values || []).map((v) => Number(v) || 0);
    if (points.length < 2) return '';

    const high = Math.max(...points);
    const low = Math.min(...points);
    const span = high - low;

    const x = (i) => (i / (points.length - 1)) * 100;
    const y = (v) => (span === 0 ? 16 : 30 - ((v - low) / span) * 28);

    const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const area = `${line} L100,32 L0,32 Z`;
    const stroke = colour(tone);

    return `
        <svg class="m-spark" viewBox="0 0 100 32" preserveAspectRatio="none"
             role="img" aria-label="${escapeHtml(label)}" focusable="false">
            <path d="${area}" fill="${stroke}" opacity="0.16"></path>
            <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  vector-effect="non-scaling-stroke"></path>
        </svg>
    `;
}

/**
 * Paired bars, one column per period: what came in against what went out.
 *
 * Both series share one scale — that is the entire point of the chart, and
 * scaling them separately would draw a month that lost money as though it had
 * broken even.
 */
export function pairedBars(rows, { label = '' } = {}) {
    const data = rows || [];
    if (!data.length) return '';

    const peak = Math.max(1, ...data.map((r) => Math.max(r.income || 0, r.expense || 0)));
    const slot = 100 / data.length;
    const width = Math.min(6, slot * 0.3);
    const gap = width * 0.35;

    const bars = data.map((row, i) => {
        const centre = slot * i + slot / 2;
        const inH = ((row.income || 0) / peak) * 40;
        const outH = ((row.expense || 0) / peak) * 40;

        return `
            <rect x="${(centre - width - gap / 2).toFixed(2)}" y="${(40 - inH).toFixed(2)}"
                  width="${width.toFixed(2)}" height="${Math.max(0.6, inH).toFixed(2)}"
                  rx="1" fill="${TONES.positive}"></rect>
            <rect x="${(centre + gap / 2).toFixed(2)}" y="${(40 - outH).toFixed(2)}"
                  width="${width.toFixed(2)}" height="${Math.max(0.6, outH).toFixed(2)}"
                  rx="1" fill="${TONES.negative}"></rect>
        `;
    }).join('');

    return `
        <svg class="m-chart" viewBox="0 0 100 40" preserveAspectRatio="none"
             role="img" aria-label="${escapeHtml(label)}" focusable="false">${bars}</svg>
    `;
}

/**
 * A donut: two or three parts of one whole.
 *
 * Built from stroked circle arcs rather than pie wedges, because a stroke's
 * `stroke-dasharray` needs no trigonometry and no path arithmetic — the whole
 * chart is a circumference and a running offset, which is far less to get
 * wrong than an arc-flag.
 *
 * A whole of zero draws the empty track and nothing else. The alternative —
 * dividing by zero and rendering NaN into an attribute — silently produces an
 * invisible chart with no clue as to why.
 */
export function donut(slices, { label = '', centre = '' } = {}) {
    const parts = (slices || []).filter((s) => (s.value || 0) > 0);
    const total = parts.reduce((sum, s) => sum + (s.value || 0), 0);

    const RADIUS = 15.9155;               // circumference ≈ 100, so a share IS a percentage
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

    let offset = 0;
    const arcs = parts.map((slice) => {
        const share = (slice.value / total) * CIRCUMFERENCE;
        const arc = `
            <circle cx="21" cy="21" r="${RADIUS}" fill="none"
                    stroke="${colour(slice.tone)}" stroke-width="5"
                    stroke-dasharray="${share.toFixed(3)} ${(CIRCUMFERENCE - share).toFixed(3)}"
                    stroke-dashoffset="${(-offset).toFixed(3)}"
                    transform="rotate(-90 21 21)"></circle>
        `;
        offset += share;
        return arc;
    }).join('');

    return `
        <svg class="m-donut" viewBox="0 0 42 42" role="img"
             aria-label="${escapeHtml(label)}" focusable="false">
            <circle cx="21" cy="21" r="${RADIUS}" fill="none"
                    stroke="var(--v3-row-border)" stroke-width="5"></circle>
            ${total ? arcs : ''}
            ${centre ? `
                <text x="21" y="21" text-anchor="middle" dominant-baseline="central"
                      fill="var(--v3-name)" font-size="6" font-weight="700">${escapeHtml(centre)}</text>
            ` : ''}
        </svg>
    `;
}

/**
 * The up/down indicator beside a KPI — "▲ 12%".
 *
 * `good` is the caller's judgement, not this function's, and the distinction
 * matters: a rising outstanding balance goes UP and is BAD. Direction sets the
 * arrow; `good` sets the colour. Conflating them is how a dashboard ends up
 * congratulating a school on its growing debt.
 */
export function deltaChip(percent, { good = null, suffix = '' } = {}) {
    if (percent === null || percent === undefined || !Number.isFinite(percent)) return '';

    const rounded = Math.round(percent);
    const arrow = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '■';
    const tone = good === null ? 'neutral' : good ? 'positive' : 'negative';

    return `
        <span class="m-delta" data-tone="${tone}">
            <span aria-hidden="true">${arrow}</span> ${Math.abs(rounded)}%${escapeHtml(suffix)}
        </span>
    `;
}
