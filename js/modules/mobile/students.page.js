/**
 * Natyam ERP v3 — Mobile — Students
 *
 * Built from the approved design ("Students.dc.html", mobile half). Where the
 * desktop app shows a compact roll inside one card and opens a centred modal,
 * mobile shows **full-width tappable cards** and opens a **near-full-screen
 * sheet** — not the same component at a different width.
 *
 * Differences from the desktop page, all from the design:
 *   - Search is always visible in the sticky sub-header, not hidden behind a
 *     Filter toggle. On a phone, finding one child is the primary task.
 *   - Filters are horizontally scrolled pills, revealed by the filter button.
 *   - A floating action button sits above the tab bar for "add student".
 *   - Each row shows one badge (fees), not two. Status rides as text under the
 *     name instead, because two badges do not fit a 375px row without
 *     truncating the name — which is the one thing the row exists to show.
 *
 * As everywhere in v3, this computes nothing: listStudents(), listFilters()
 * and profile() come from students.service.js, carried over unmodified.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort } from '../../utils/money.js';
import { formatDateLong } from '../../utils/date.js';
import { listStudents, listFilters, profile, enrol } from '../../services/students.service.js';
import { listBatches } from '../../services/batches.service.js';
import { listBranches, listFeePlans } from '../../services/settings.service.js';
import { curriculum, CAPABILITIES } from '../../config/app.config.js';
import { formModal } from '../../ui/form.js';
import { localDate } from '../../utils/date.js';

const QUICK_FILTERS = [
    { key: null, label: 'All' },
    { key: 'unplaced', label: 'No batch' },
    { key: 'overdue', label: 'Fees overdue' },
    { key: 'at-risk', label: 'At risk' }
];

const PROFILE_TABS = ['Overview', 'Fees', 'Attendance', 'People', 'Records', 'History'];

export default class MobileStudentsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Students';
        this.rows = [];
        this.filters = null;
        this.search = '';
        this.quick = this.query.filter || null;
        this.filtersOpen = Boolean(this.quick);
        this.profile = null;
        this.profileTab = 'Overview';
    }

    async render(container) {
        this.container = container;

        render(container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">Search the roll</span>
                        <input type="search" data-role="search" placeholder="Search name, guardian, phone…">
                    </label>
                    <button class="m-icon-btn" data-action="toggle-filters" aria-label="Filter"
                            aria-expanded="${this.filtersOpen ? 'true' : 'false'}">
                        ${raw(icon('filter', { size: 16 }))}
                    </button>
                </div>
                <p class="m-subhead-note" data-role="count">Loading the roll…</p>
                <div data-role="chips"></div>
            </div>

            <div data-role="list"><div class="m-skeleton">Loading students…</div></div>

            ${session.can(CAPABILITIES.STUDENT_EDIT) ? html`
                <button class="m-fab" data-action="add" aria-label="Add a student">
                    ${raw(icon('plus', { size: 24 }))}
                </button>
            ` : ''}

            <div data-role="sheet"></div>
        `);

        this.bind();
        await this.load();

        [EVENTS.STUDENT_CREATED, EVENTS.STUDENT_UPDATED, EVENTS.STUDENT_REMOVED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const branchId = session.branch();
            const [rows, filters] = await Promise.all([
                listStudents(branchId, { filter: this.quick }),
                this.filters ? Promise.resolve(this.filters) : listFilters(branchId)
            ]);
            if (this.disposed) return;
            this.rows = rows;
            this.filters = filters;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Students failed to load', err);
            render(this.container.querySelector('[data-role="list"]'), html`
                <div class="m-error">The roll could not be loaded — ${err.message}</div>
            `);
        }
    }

    visibleRows() {
        const term = this.search.trim().toLowerCase();
        if (!term) return this.rows;
        return this.rows.filter((row) =>
            [row.name, row.admissionNo, row.batchName, row.guardianName, row.guardianPhone]
                .some((value) => String(value || '').toLowerCase().includes(term)));
    }

    paint() {
        const rows = this.visibleRows();

        render(this.container.querySelector('[data-role="count"]'),
            `${rows.length} of ${this.rows.length} student${this.rows.length === 1 ? '' : 's'}`);

        render(this.container.querySelector('[data-role="chips"]'), this.filtersOpen ? html`
            <div class="m-chip-scroll">
                ${QUICK_FILTERS.map((item) => html`
                    <button class="m-pill" data-action="quick" data-key="${item.key || ''}"
                            aria-pressed="${this.quick === item.key ? 'true' : 'false'}">${item.label}</button>
                `)}
            </div>
        ` : '');

        render(this.container.querySelector('[data-role="list"]'), rows.length ? html`
            <div class="m-stack" style="margin-bottom:0;">
                ${rows.map((row, index) => html`
                    <button class="m-card m-student" data-action="open" data-id="${row.id}">
                        <span class="m-student-index">${index + 1}</span>
                        <span class="m-student-main">
                            <span class="m-student-name">${row.name}</span>
                            <span class="m-student-meta">
                                ${row.batchName || 'Not in a batch'}${row.status !== 'active' ? ` · ${statusLabel(row.status)}` : ''}
                            </span>
                        </span>
                        <span class="m-badge" data-fee="${row.feeState}">${feeLabel(row)}</span>
                    </button>
                `)}
            </div>
        ` : html`<div class="m-card m-empty">No student matches that.</div>`);
    }

    /* ---------------------------------------------------------- PROFILE */

    async openProfile(studentId) {
        try {
            this.profile = await profile(studentId);
            this.profileTab = 'Overview';
            if (this.disposed) return;
            this.paintSheet();
        } catch (err) {
            toast.error(`Could not open that student — ${err.message}`);
        }
    }

    closeProfile() {
        this.profile = null;
        render(this.container.querySelector('[data-role="sheet"]'), '');
    }

    paintSheet() {
        const target = this.container.querySelector('[data-role="sheet"]');
        if (!this.profile) { render(target, ''); return; }

        const { student, batch, fees, attendance, guardian, level } = this.profile;
        const tenureMonths = Math.max(0, Math.round((this.profile.tenureDays || 0) / 30));

        render(target, html`
            <div class="m-sheet-scrim" data-action="close-profile"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${student.name}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${student.name}</h2>
                        <p class="m-profile-sub">
                            ${student.admissionNo || '—'}${batch ? ` · ${batch.name}` : ' · No batch'}
                        </p>
                    </div>
                    <button class="m-icon-btn" data-action="close-profile" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-tabs" role="tablist">
                    ${PROFILE_TABS.map((tab) => html`
                        <button class="m-profile-tab" data-action="tab" data-tab="${tab}" role="tab"
                                aria-selected="${this.profileTab === tab ? 'true' : 'false'}">${tab}</button>
                    `)}
                </div>

                <div class="m-profile-body">
                    ${this.profileTab === 'Overview' ? html`
                        <div class="m-metrics">
                            ${metric('Attend.', attendance.recentRate === null ? '—' : `${attendance.recentRate}%`)}
                            ${metric('Fees due', formatMoneyShort(fees?.outstanding || 0))}
                            ${metric('Tenure', `${tenureMonths}mo`)}
                        </div>
                        ${!student.batchId ? html`
                            <div class="m-notice" data-tone="caution">Not in a batch — appears on no register.</div>
                        ` : ''}
                        ${student.medicalNotes ? html`
                            <div class="m-notice" data-tone="info"><strong>Medical:</strong> ${student.medicalNotes}</div>
                        ` : ''}
                        <dl class="m-facts">
                            ${fact('Level', level?.label || '—')}
                            ${fact('Batch', batch?.name || 'Not in a batch')}
                            ${fact('Status', statusLabel(student.status))}
                            ${fact('Joined', student.joinedOn ? formatDateLong(student.joinedOn) : '—')}
                        </dl>
                    ` : ''}

                    ${this.profileTab === 'Fees' ? html`
                        <dl class="m-facts">
                            ${fact('Billed', formatMoney(fees?.billed || 0))}
                            ${fact('Collected', formatMoney(fees?.collected || 0))}
                            ${fact('Outstanding', formatMoney(fees?.outstanding || 0))}
                        </dl>
                    ` : ''}

                    ${this.profileTab === 'Attendance' ? html`
                        <dl class="m-facts">
                            ${fact('All time', attendance.rate === null ? '—' : `${attendance.rate}%`)}
                            ${fact('Last 90 days', attendance.recentRate === null ? '—' : `${attendance.recentRate}%`)}
                            ${fact('Last seen', attendance.lastSeen ? formatDateLong(attendance.lastSeen) : '—')}
                        </dl>
                    ` : ''}

                    ${this.profileTab === 'People' ? html`
                        <dl class="m-facts">
                            ${fact('Guardian', guardian?.name || '—')}
                            ${fact('Relationship', guardian?.relation || '—')}
                            ${fact('Phone', guardian?.phone || '—')}
                        </dl>
                        ${guardian?.phone ? html`
                            <a class="m-btn m-btn-block" href="tel:${guardian.phone}">
                                ${raw(icon('phone', { size: 16 }))} Call guardian
                            </a>
                        ` : ''}
                    ` : ''}

                    ${this.profileTab === 'Records' ? (this.profile.certificates?.length ? html`
                        <dl class="m-facts">
                            ${this.profile.certificates.map((cert) => fact(cert.title || 'Certificate', cert.serial || ''))}
                        </dl>
                    ` : html`<p class="m-profile-note">No certificates issued yet.</p>`) : ''}

                    ${this.profileTab === 'History' ? (this.profile.timeline?.length ? html`
                        ${this.profile.timeline.map((event) => html`
                            <div class="m-activity" style="padding:10px 0;">
                                <span class="m-dot"></span>
                                <div style="flex:1;min-width:0;">
                                    <div class="m-activity-text">${event.title}</div>
                                    <div class="m-activity-meta">
                                        ${formatDateLong(event.at)}${event.detail ? ` · ${event.detail}` : ''}
                                    </div>
                                </div>
                            </div>
                        `)}
                    ` : html`<p class="m-profile-note">Nothing recorded yet.</p>`) : ''}
                </div>
            </div>
        `);
    }

    /* ----------------------------------------------------------- EVENTS */

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="toggle-filters"]', () => {
            this.filtersOpen = !this.filtersOpen;
            this.paint();
        }));

        this.onDispose(on(root, 'click', '[data-action="quick"]', (_e, target) => {
            const key = target.dataset.key || null;
            this.quick = this.quick === key ? null : key;
            this.load();
        }));

        this.onDispose(on(root, 'input', '[data-role="search"]', debounce((_e, target) => {
            this.search = target.value;
            this.paint();
        }, 180)));

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, target) => this.openProfile(target.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="close-profile"]', () => this.closeProfile()));
        this.onDispose(on(root, 'click', '.m-profile', (event) => event.stopPropagation()));

        this.onDispose(on(root, 'click', '[data-action="tab"]', (_e, target) => {
            this.profileTab = target.dataset.tab;
            this.paintSheet();
        }));

        this.onDispose(on(root, 'click', '[data-action="add"]', () => this.newStudent()));

        this.onKey = (event) => { if (event.key === 'Escape' && this.profile) this.closeProfile(); };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }

    /* -------------------------------------------------------------- ENROL */

    /**
     * The same enrolment the desktop takes, asked for on a phone.
     *
     * The field list is deliberately identical to natyam-admin's — `enrol()`
     * needs what it needs, and a phone-shortened version would just produce
     * half-complete records that someone has to finish at a desk later. What
     * changes is the presentation: js/ui/form.js here renders a full-height
     * sheet with its actions in the header, because the keyboard covers the
     * bottom of a phone screen the whole time a field has focus.
     */
    async newStudent() {
        session.require(CAPABILITIES.STUDENT_EDIT, 'add a student');

        const [batches, plans, branches] = await Promise.all([
            listBatches(session.branch()), listFeePlans(), listBranches()
        ]);
        const open = batches.filter((b) => b.status !== 'closed');
        const defaultBranchId = session.branch() || (branches.length === 1 ? branches[0].id : '');

        const fields = [
            { type: 'divider', label: 'Student' },
            { name: 'name', label: 'Full name', required: true },
            { name: 'dateOfBirth', label: 'Date of birth', type: 'date' },
            { name: 'gender', label: 'Gender', type: 'select', placeholder: 'Not recorded',
              options: [
                  { value: 'female', label: 'Female' },
                  { value: 'male', label: 'Male' },
                  { value: 'other', label: 'Other' }
              ] },
            { name: 'branchId', label: 'Branch', type: 'select', required: true,
              placeholder: branches.length > 1 ? 'Choose a branch' : null,
              options: branches.map((b) => ({ value: b.id, label: b.name })) },
            { name: 'level', label: 'Level', type: 'select', required: true, placeholder: 'Choose a level',
              options: curriculum().map((l) => ({ value: l.value, label: l.label })) },
            { name: 'batchId', label: 'Batch', type: 'select', placeholder: 'Place later',
              options: open.map((b) => ({
                  value: b.id,
                  label: `${b.name} — ${b.enrolled}/${b.capacity || '∞'}`
                       + (b.capacity && b.enrolled >= b.capacity ? ' (full)' : '')
              })),
              help: 'A student with no batch appears on no register.' },
            { name: 'feePlanId', label: 'Fee plan', type: 'select', placeholder: 'No plan',
              options: plans.map((p) => ({ value: p.id, label: `${p.name} — ${formatMoney(p.amount)}` })),
              help: 'Choosing one raises the fee schedule immediately.' },
            { name: 'joinedOn', label: 'Joined on', type: 'date' },

            { type: 'divider', label: 'Guardian' },
            { name: 'guardianName', label: 'Guardian name', required: true },
            { name: 'guardianRelation', label: 'Relationship', type: 'select',
              options: ['Mother', 'Father', 'Grandparent', 'Guardian', 'Sibling']
                  .map((r) => ({ value: r, label: r })) },
            { name: 'guardianPhone', label: 'Phone', type: 'tel', required: true },
            { name: 'guardianEmail', label: 'Email', type: 'email' },
            { name: 'address', label: 'Address', type: 'textarea', rows: 2 },

            { type: 'divider', label: 'Health and notes' },
            { name: 'medicalNotes', label: 'Medical notes', type: 'textarea', rows: 2,
              help: 'Anything a teacher must know before class.' },
            { name: 'notes', label: 'Other notes', type: 'textarea', rows: 2 }
        ];

        const result = await formModal({
            title: 'Add a student',
            description: 'Enrols directly, without an application.',
            submitLabel: 'Enrol',
            fields,
            values: {
                ...Object.fromEntries(fields.filter((f) => f.type !== 'divider').map((f) => [f.name, ''])),
                branchId: defaultBranchId,
                guardianRelation: 'Mother',
                joinedOn: localDate()
            },
            onSubmit: (values) => enrol(values)
        });

        if (!result) return;
        toast.success(`${result.student.name} is on the roll.`);
        if (result.billing?.invoices?.length) {
            toast.info(`${result.billing.invoices.length} fee${result.billing.invoices.length === 1 ? '' : 's'} raised.`);
        }
        await this.load();
        this.openProfile(result.student.id);
    }
}

/* ------------------------------------------------------------------ HELPERS */

function metric(label, value) {
    return html`<div class="m-metric"><div class="m-metric-label">${label}</div><div class="m-metric-value">${value}</div></div>`;
}

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function feeLabel(row) {
    if (row.overdue > 0) return `${formatMoneyShort(row.overdue)} overdue`;
    if (row.outstanding > 0) return `${formatMoneyShort(row.outstanding)} due`;
    return 'Paid up';
}

function statusLabel(status) {
    return String(status || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
