/**
 * Natyam ERP v3 — Mobile — Batches
 *
 * NO APPROVED v3 DESIGN EXISTS FOR THIS SCREEN — Batches was never part of the
 * Claude Design project (see docs/design/README.md). Built from the v3 mobile
 * system.
 *
 * On a phone this is a reference screen far more than a management one: a
 * teacher or receptionist wants to know who is in a batch, when it meets, and
 * whether anyone in it is slipping. So the list is compact, and the sheet
 * leads with the **roster, weakest attendance first** — the order
 * `batchDetail()` already returns and the order that answers the question
 * being asked.
 *
 * Creating, editing, closing and reopening batches are **not** here. They need
 * a form plus a conflict-override decision, and a phone is the wrong place to
 * make one; the desktop app owns that. This screen deliberately offers no
 * disabled buttons for them either — an action a phone user should not be
 * starting is better absent than greyed out.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { listBatches, batchDetail } from '../../services/batches.service.js';

const FILTERS = [
    { key: null, label: 'All' },
    { key: 'mine', label: 'Mine' },
    { key: 'full', label: 'Full' },
    { key: 'weak', label: 'Weak' }
];

export default class MobileBatchesPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Batches';
        this.rows = [];
        this.filter = this.query.filter || null;
        this.search = '';
        this.detail = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading batches…</div>`);
        this.bind();
        await this.load();

        [EVENTS.BATCH_CREATED, EVENTS.BATCH_UPDATED, EVENTS.BATCH_CLOSED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const rows = await listBatches(session.branch());
            if (this.disposed) return;
            this.rows = rows;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Batches failed to load', err);
            render(this.container, html`<div class="m-error">Batches could not be loaded — ${err.message}</div>`);
        }
    }

    visibleRows() {
        const term = this.search.trim().toLowerCase();
        let rows = this.rows;

        // "Mine" is only meaningful for a teacher, and it matches on the staff
        // record's own id — the same `teacherId` the timetable and register
        // use, not a name comparison.
        if (this.filter === 'mine') rows = rows.filter((b) => b.teacherId && b.teacherId === session.actorId());
        else if (this.filter === 'full') rows = rows.filter((b) => b.capacity && b.seatsLeft === 0);
        else if (this.filter === 'weak') rows = rows.filter((b) => b.attendanceRate !== null && b.attendanceRate < 70);

        if (term) {
            rows = rows.filter((b) =>
                [b.name, b.code, b.teacherName, b.levelLabel, b.room]
                    .some((v) => String(v || '').toLowerCase().includes(term)));
        }
        return rows;
    }

    paint() {
        const rows = this.visibleRows();

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">Search batches</span>
                        <input type="search" data-role="search" placeholder="Search name, teacher, level…">
                    </label>
                </div>
                <p class="m-subhead-note">${rows.length} of ${this.rows.length} batches</p>
                <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
            </div>

            <div class="m-stack">
                ${rows.length ? rows.map((b) => html`
                    <button class="m-card m-student" data-action="open" data-id="${b.id}">
                        <span class="m-student-main">
                            <span class="m-student-name">${b.name}</span>
                            <span class="m-student-meta">
                                ${b.schedule || 'No schedule'} · ${b.teacherName}
                            </span>
                        </span>
                        <span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
                            <span class="m-badge" data-seats="${seatTone(b)}">${b.enrolled}${b.capacity ? `/${b.capacity}` : ''}</span>
                            ${b.attendanceRate !== null ? html`
                                <span class="m-badge" data-fee="${b.attendanceRate >= 80 ? 'clear' : b.attendanceRate >= 65 ? 'due' : 'overdue'}">
                                    ${b.attendanceRate}%
                                </span>
                            ` : ''}
                        </span>
                    </button>
                `) : html`<div class="m-card m-empty">No batch matches that.</div>`}
            </div>
        `);
    }

    /* --------------------------------------------------------------- DETAIL */

    async open(id) {
        try {
            this.detail = await batchDetail(id);
            if (this.disposed) return;
            this.paintSheet();
        } catch (err) {
            toast.error(`Could not open that batch — ${err.message}`);
        }
    }

    close() {
        this.detail = null;
        const host = this.container.querySelector('[data-role="sheet"]');
        if (host) render(host, '');
    }

    paintSheet() {
        let host = this.container.querySelector('[data-role="sheet"]');
        if (!host) {
            host = document.createElement('div');
            host.setAttribute('data-role', 'sheet');
            this.container.append(host);
        }
        if (!this.detail) { render(host, ''); return; }

        const { batch, teacher, conflicts, attendanceRate, roster } = this.detail;

        render(host, html`
            <div class="m-sheet-scrim" data-action="close-detail"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${batch.name}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${batch.name}</h2>
                        <p class="m-profile-sub">${batch.schedule || 'No schedule'} · ${teacher?.name || 'Unassigned'}</p>
                    </div>
                    <button class="m-icon-btn" data-action="close-detail" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    ${conflicts?.length ? html`
                        <div class="m-notice" data-tone="caution">
                            ${conflicts.length} scheduling conflict${conflicts.length === 1 ? '' : 's'} on this batch.
                        </div>
                    ` : ''}
                    ${!batch.teacherId ? html`
                        <div class="m-notice" data-tone="caution">No teacher assigned.</div>
                    ` : ''}

                    <div class="m-metrics">
                        ${metric('Enrolled', `${batch.enrolled}${batch.capacity ? `/${batch.capacity}` : ''}`)}
                        ${metric('Free', batch.seatsLeft === null ? '—' : String(batch.seatsLeft))}
                        ${metric('Attend.', attendanceRate === null ? '—' : `${attendanceRate}%`)}
                    </div>

                    <dl class="m-facts">
                        ${fact('Level', batch.levelLabel || '—')}
                        ${fact('Time', batch.startTime && batch.endTime ? `${batch.startTime}–${batch.endTime}` : '—')}
                        ${fact('Room', batch.room || '—')}
                    </dl>

                    <p class="m-section-label" style="margin:6px 0 0;color:var(--v3-muted);text-shadow:none;">
                        Roster — weakest attendance first
                    </p>
                    ${roster.length ? roster.map((s) => html`
                        <div class="m-invoice" style="border-left-color:${s.attendanceRate === null ? 'var(--v3-tone-neutral)' : s.attendanceRate >= 80 ? 'var(--v3-positive)' : s.attendanceRate >= 65 ? 'var(--v3-caution)' : 'var(--v3-negative)'};">
                            <div class="m-invoice-main">
                                <div class="m-invoice-no">${s.name}</div>
                                <div class="m-invoice-due">${s.admissionNo || ''}</div>
                            </div>
                            <span class="m-badge" data-fee="${s.attendanceRate === null ? '' : s.attendanceRate >= 80 ? 'clear' : s.attendanceRate >= 65 ? 'due' : 'overdue'}">
                                ${s.attendanceRate === null ? '—' : `${s.attendanceRate}%`}
                            </span>
                        </div>
                    `) : html`<p class="m-profile-note">Nobody is placed in this batch yet.</p>`}
                </div>
            </div>
        `);
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="filter"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.filter = this.filter === key ? null : key;
            this.paint();
        }));

        this.onDispose(on(root, 'input', '[data-role="search"]', debounce((_e, t) => {
            this.search = t.value;
            this.paint();
        }, 180)));

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.open(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', () => this.close()));
        this.onDispose(on(root, 'click', '.m-profile', (event) => event.stopPropagation()));

        this.onKey = (event) => { if (event.key === 'Escape' && this.detail) this.close(); };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function seatTone(b) {
    if (!b.enrolled) return 'empty';
    if (b.capacity && b.seatsLeft === 0) return 'full';
    return 'open';
}

function metric(label, value) {
    return html`<div class="m-metric"><div class="m-metric-label">${label}</div><div class="m-metric-value">${value}</div></div>`;
}

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
