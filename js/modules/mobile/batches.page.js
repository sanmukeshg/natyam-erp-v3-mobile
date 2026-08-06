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
 * EDITING (UAT BUG-601). An owner standing in the studio does need to fix a
 * room, a time or a teacher without walking to a desktop, so the sheet carries
 * an Edit action. It uses the same field list, the same service call and the
 * same clash-override confirmation the desktop app does — a phone is a smaller
 * screen, not a laxer one.
 *
 * Creating, closing and reopening batches are still desktop-only: closing asks
 * where the enrolled students go, which is not a decision to make between
 * sessions. This screen offers no disabled buttons for them — an action a phone
 * user should not be starting is better absent than greyed out.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { listBatches, batchDetail, updateBatch, WEEK } from '../../services/batches.service.js';
import { availableTeachers } from '../../services/staff.service.js';
import { listBranches } from '../../services/settings.service.js';
import { curriculum, levelsOf, CAPABILITIES } from '../../config/app.config.js';
import { formModal, confirmModal } from '../../ui/form.js';
import { filterBar, renderFilterPanel, bindFilterToggle } from '../../ui/filterBar.js';
import { localDate } from '../../utils/date.js';
import { showLoadError } from '../../ui/loadState.js';

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
            showLoadError(this.container, { what: 'Batches', error: err, onRetry: () => this.load() });
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
        const filterPanel = html`
            <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
        `;

        const rows = this.visibleRows();

        render(this.container, html`
            ${filterBar({
                placeholder: 'Search name, teacher, level…',
                label: 'Search batches',
                open: this.filtersOpen,
                note: html`${rows.length} of ${this.rows.length} batches`
            })}

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

        renderFilterPanel(this.container, this.filtersOpen, filterPanel);
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

                    ${session.can(CAPABILITIES.STUDENT_EDIT) ? html`
                        <div class="m-actions">
                            <button class="m-btn" data-action="edit-batch">
                                ${raw(icon('edit', { size: 15 }))} Edit batch
                            </button>
                        </div>
                    ` : ''}

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

    /* ----------------------------------------------------------------- EDIT */

    /**
     * The batch form's fields, seeded from the batch being edited.
     *
     * Teachers come from availableTeachers() rather than a plain staff list so
     * a fully-booked teacher is *shown* as busy instead of being offered and
     * then rejected by the clash check a moment later. `excludeBatchId` stops
     * the batch clashing with itself.
     */
    async batchFields(existing) {
        const [teachers, branches] = await Promise.all([
            availableTeachers({ branchId: session.branch(), excludeBatchId: existing.id }),
            listBranches()
        ]);

        return [
            { name: 'name', label: 'Batch name', required: true },
            { name: 'code', label: 'Code', required: true, maxLength: 20,
              help: 'Short label used on registers and reports.' },
            { name: 'branchId', label: 'Branch', type: 'select', required: true,
              options: branches.map((b) => ({ value: b.id, label: b.name })) },
            { name: 'levels', label: 'Levels', type: 'checks', required: true, itemNoun: 'level',
              options: curriculum().map((l) => ({ value: l.value, label: l.label })),
              help: 'Students at any of these levels can be placed here.' },
            { name: 'teacherId', label: 'Teacher', type: 'select', placeholder: 'Not assigned yet',
              options: teachers.map((t) => ({
                  value: t.id,
                  label: t.available
                      ? `${t.name} — ${t.load} batch${t.load === 1 ? '' : 'es'}`
                      : `${t.name} — busy (${t.clashWith})`
              })) },
            { name: 'days', label: 'Days', type: 'checks', required: true, itemNoun: 'day',
              options: WEEK.map((d) => ({ value: d, label: d })),
              help: 'The register only exists on these days.' },
            { name: 'startTime', label: 'Starts', type: 'time', required: true },
            { name: 'endTime', label: 'Ends', type: 'time', required: true,
              validate: (v, all) => (all.startTime && v <= all.startTime)
                  ? 'The batch cannot end before it starts.' : null },
            { name: 'room', label: 'Room or hall' },
            { name: 'capacity', label: 'Capacity', type: 'number', min: 0, max: 200,
              help: 'Leave blank for no limit.' },
            { name: 'startsOn', label: 'Running since', type: 'date' },
            { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }
        ].map((f) => ({
            ...f,
            value: f.name === 'levels'   ? levelsOf(existing)
                 : f.name === 'startsOn' ? (existing.startsOn || localDate())
                 : existing[f.name]
        }));
    }

    /**
     * `updateBatch()` refuses a clashing slot unless told otherwise. A clash is
     * a question for a person, not an error to swallow, so it is put to them —
     * the same wording and the same second attempt the desktop app makes.
     */
    async saveWithConflictCheck(attempt) {
        try {
            return await attempt(false);
        } catch (err) {
            if (!err.conflicts?.length) throw err;

            const proceed = await confirmModal({
                title: 'This clashes with another batch',
                message: err.conflicts.map((c) => c.message).join(' '),
                confirmLabel: 'Schedule it anyway',
                tone: 'negative'
            });

            if (!proceed) throw err;
            return attempt(true);
        }
    }

    async editBatch() {
        const batch = this.detail?.batch;
        if (!batch) return;
        session.require(CAPABILITIES.STUDENT_EDIT, 'edit a batch');

        const fields = await this.batchFields(batch);

        const saved = await formModal({
            title: `Edit ${batch.name}`,
            submitLabel: 'Save changes',
            fields,
            values: Object.fromEntries(fields.map((f) =>
                [f.name, f.value ?? (f.type === 'checks' ? [] : '')])),
            onSubmit: (values) => this.saveWithConflictCheck(
                (allowConflicts) => updateBatch(batch.id, values, { allowConflicts }))
        });

        if (!saved) return;
        toast.success('Batch updated', batch.name);
        await this.open(batch.id);
        await this.load();
    }

    bind() {
        const root = this.container;

        bindFilterToggle(this, () => this.paint());

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
        this.onDispose(on(root, 'click', '[data-action="edit-batch"]', () => this.editBatch()));
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

function metric(label, value, tone = null) {
    return html`<div class="m-metric"${tone ? raw(` data-tone="${tone}"`) : ''}>
        <span class="m-metric-value">${value}</span>
        <span class="m-metric-label">${label}</span>
    </div>`;
}

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
