/**
 * Natyam ERP v3 — Mobile — Staff
 *
 * Owner & Accountant runs the academy from both surfaces, so Staff exists on
 * both. What differs is what a phone is *for* here.
 *
 * READ AND REACH, NOT ADMINISTER. This screen answers "who is teaching, how
 * loaded are they, and what is their number" — the questions that come up while
 * standing in a studio. Hiring, editing, ending employment and reassigning
 * batches all stay on natyam-admin: `deactivate()` can hand a departing
 * teacher's batches to someone else in the same call, and choosing who inherits
 * a class is not a decision to make on a 375px screen between sessions.
 *
 * That is a deliberate split, not an unfinished one, so the screen says so
 * rather than leaving the absence of an edit button to be puzzled over.
 *
 * The teaching-load figures come from `listStaff()`, which already attaches
 * batch count, head count and weekly sessions — no second query, and the same
 * numbers the desktop shows.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort, formatNumber } from '../../utils/money.js';
import { formatDateLong } from '../../utils/date.js';
import { listStaff, staffSummary, teacherDashboard } from '../../services/staff.service.js';

const FILTERS = [
    { key: null, label: 'All' },
    { key: 'teacher', label: 'Teachers' },
    { key: 'unassigned', label: 'No batches' }
];

export default class MobileStaffPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Staff';
        this.filter = this.query.filter || null;
        this.search = '';
        this.rows = [];
        this.stats = null;
        this.detail = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading staff…</div>`);
        this.bind();
        await this.load();

        [EVENTS.STAFF_CREATED, EVENTS.STAFF_UPDATED, EVENTS.BATCH_UPDATED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const [rows, stats] = await Promise.all([
                listStaff(session.branch()),
                staffSummary(session.branch())
            ]);
            if (this.disposed) return;
            this.rows = rows;
            this.stats = stats;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Staff failed to load', err);
            render(this.container, html`<div class="m-error">Staff could not be loaded — ${err.message}</div>`);
        }
    }

    visibleRows() {
        let rows = this.rows.filter((s) => {
            if (this.filter === 'teacher') return s.role === 'teacher';
            if (this.filter === 'unassigned') return s.role === 'teacher' && s.batchCount === 0;
            return true;
        });

        const term = this.search.trim().toLowerCase();
        if (term) {
            rows = rows.filter((s) =>
                [s.name, s.roleLabel, s.specialisation, s.phone]
                    .some((v) => String(v || '').toLowerCase().includes(term)));
        }
        return rows;
    }

    paint() {
        const rows = this.visibleRows();
        const s = this.stats || {};

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">Search staff</span>
                        <input type="search" data-role="search" placeholder="Search name, role…">
                    </label>
                </div>
                <p class="m-subhead-note">
                    ${rows.length} of ${this.rows.length} on staff
                    ${s.teachers ? ` · ${formatNumber(s.teachers)} teaching` : ''}
                    ${s.monthlyWageBill ? ` · ${formatMoneyShort(s.monthlyWageBill)} a month` : ''}
                </p>
                <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
            </div>

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((m) => html`
                        <button class="m-card m-student" data-action="open" data-id="${m.id}">
                            <span class="m-student-main">
                                <span class="m-student-name">${m.name}</span>
                                <span class="m-student-meta">
                                    ${m.roleLabel}${m.specialisation ? ` · ${m.specialisation}` : ''}
                                    ${m.role === 'teacher'
                                        ? ` · ${m.batchCount} batch${m.batchCount === 1 ? '' : 'es'}, `
                                          + `${formatNumber(m.studentCount)} student${m.studentCount === 1 ? '' : 's'}`
                                        : ''}
                                </span>
                            </span>
                            ${m.role === 'teacher' && !m.batchCount ? html`
                                <span class="m-badge" data-fee="overdue">Free</span>
                            ` : html`
                                <span class="m-badge" data-fee="clear">${m.weeklySessions || 0}/wk</span>
                            `}
                        </button>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty">
                    ${this.rows.length ? 'Nobody matches that.' : 'No staff on the books yet.'}
                </div>
            `}

            <div data-role="sheet"></div>
        `);

        this.paintSheet();
    }

    /* ---------------------------------------------------------------- SHEET */

    async open(id) {
        try {
            this.detail = await teacherDashboard(id);
            if (this.disposed) return;
            this.paintSheet();
        } catch (err) {
            toast.error(err.message);
        }
    }

    paintSheet() {
        const target = this.container.querySelector('[data-role="sheet"]');
        if (!target) return;
        const d = this.detail;
        if (!d) { render(target, ''); return; }

        const m = d.staff;
        const row = this.rows.find((r) => r.id === m.id) || {};

        render(target, html`
            <div class="m-sheet-scrim" data-action="close-detail"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${m.name}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${m.name}</h2>
                        <p class="m-profile-sub">
                            ${row.roleLabel || m.role}${m.employeeNo ? ` · ${m.employeeNo}` : ''}
                        </p>
                    </div>
                    <button class="m-icon-btn" data-action="close-detail" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    ${m.phone ? html`
                        <div class="m-subhead-row" style="margin-bottom:12px;">
                            <a class="m-btn" href="tel:${m.phone}" style="flex:1;justify-content:center;">
                                ${raw(icon('phone', { size: 15 }))} Call
                            </a>
                            <a class="m-btn m-btn-ghost" href="sms:${m.phone}" style="flex:1;justify-content:center;">
                                Message
                            </a>
                        </div>
                    ` : ''}

                    <div class="m-metrics">
                        ${metric('Batches', formatNumber(row.batchCount || 0))}
                        ${metric('Students', formatNumber(row.studentCount || 0))}
                        ${metric('Per week', `${row.weeklySessions || 0}`)}
                    </div>

                    <dl class="m-facts">
                        ${fact('Phone', m.phone || '—')}
                        ${fact('Email', m.email || '—')}
                        ${fact('Based at', row.branchNames || '—')}
                        ${fact('Joined', m.joinedOn ? formatDateLong(m.joinedOn) : '—')}
                        ${fact('Specialisation', m.specialisation || '—')}
                    </dl>

                    ${d.batches?.length ? html`
                        <p class="m-section-label" style="margin-top:16px;">Batches</p>
                        <div class="m-stack">
                            ${d.batches.map((b) => html`
                                <a class="m-card m-student" href="#/batches?batch=${b.batch.id}">
                                    <span class="m-student-main">
                                        <span class="m-student-name">${b.batch.name}</span>
                                        <span class="m-student-meta">
                                            ${formatNumber(b.enrolled)} enrolled ·
                                            ${b.sessionsMarked} register${b.sessionsMarked === 1 ? '' : 's'} in 60 days
                                        </span>
                                    </span>
                                    <span class="m-badge"
                                          data-fee="${b.attendanceRate === null ? '' : (b.attendanceRate >= 75 ? 'clear' : 'overdue')}">
                                        ${b.attendanceRate === null ? '—' : `${b.attendanceRate}%`}
                                    </span>
                                </a>
                            `)}
                        </div>
                    ` : html`
                        <p class="m-subhead-note" style="margin-top:12px;">
                            ${m.role === 'teacher'
                                ? 'Not teaching any batch right now.'
                                : 'This role does not take batches.'}
                        </p>
                    `}

                    <p class="m-subhead-note" style="margin-top:16px;">
                        Hiring, edits and ending employment are done on the desktop app —
                        handing a departing teacher's batches to someone else is part of the
                        same step.
                    </p>
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
            const field = root.querySelector('[data-role="search"]');
            if (field && document.activeElement !== field) {
                field.focus();
                field.setSelectionRange(field.value.length, field.value.length);
            }
        }, 180)));

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.open(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', () => {
            this.detail = null;
            this.paintSheet();
        }));

        this.onKey = (event) => {
            if (event.key === 'Escape' && this.detail) { this.detail = null; this.paintSheet(); }
        };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function metric(label, value, tone = null) {
    return html`<div class="m-metric"${tone ? raw(` data-tone="${tone}"`) : ''}>
        <span class="m-metric-value">${value}</span>
        <span class="m-metric-label">${label}</span>
    </div>`;
}

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
