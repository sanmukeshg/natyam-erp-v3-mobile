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
import {
    listStudents, listFilters, profile, enrol,
    updateStudent, assignToBatch, promote, setStatus
} from '../../services/students.service.js';
import { TEMPLATES, checkEligibility, issue } from '../../services/certificates.service.js';
import { listPrograms, PROGRAM_STATUS } from '../../services/programs.service.js';
import { listBatches } from '../../services/batches.service.js';
import { listBranches, listFeePlans } from '../../services/settings.service.js';
import { curriculum, CAPABILITIES, STUDENT_STATUS } from '../../config/app.config.js';
import { formModal, confirmModal } from '../../ui/form.js';
import { router } from '../../core/router.js';
import { localDate } from '../../utils/date.js';
import { showLoadError } from '../../ui/loadState.js';

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
            showLoadError(this.container.querySelector('[data-role="list"]'), { what: 'The roll', error: err, onRetry: () => this.load() });
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

                        ${this.actionRow()}
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
        this.onDispose(on(root, 'click', '[data-action="op"]', (_e, target) => {
            this.operation(target.dataset.op);
        }));

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
    /**
     * The student form's fields, shared by enrolment and editing (UAT BUG-602).
     *
     * `existing` seeds them for an edit and drops the fee plan: choosing one
     * *raises a schedule*, which is an enrolment act, not an edit — changing an
     * existing student's billing is done on the Fees screen where the invoices
     * it would touch are visible.
     */
    async studentFields(existing = null) {
        const [batches, plans, branches] = await Promise.all([
            listBatches(session.branch()), listFeePlans(), listBranches()
        ]);
        const open = batches.filter((b) => b.status !== 'closed');
        const defaultBranchId = existing?.branchId
            || session.branch()
            || (branches.length === 1 ? branches[0].id : '');

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
            { name: 'branchId', label: 'Branch', type: 'select', required: true, reactive: true,
              placeholder: branches.length > 1 ? 'Choose a branch' : null,
              options: branches.map((b) => ({ value: b.id, label: b.name })) },
            { name: 'level', label: 'Level', type: 'select', required: true, placeholder: 'Choose a level',
              options: curriculum().map((l) => ({ value: l.value, label: l.label })) },
            /*
             * UAT BUG-208 — the batch list follows the branch chosen ABOVE, not
             * the session's branch filter. `listBatches(session.branch())`
             * returns every batch when the session is on "All branches", so
             * picking Kondapur still offered Hafeezpet's classes and the service
             * would have accepted the mismatch.
             */
            /*
             * Required on create, optional when editing.
             *
             * "Place later" was the old placeholder, and its own help text says
             * what that costs: a student with no batch appears on no register,
             * so they are enrolled and then invisible to attendance. Required
             * here for the same reason the fee plan below is — the unbilled,
             * unregistered student is never what anyone intended.
             *
             * Editing keeps it optional: moving a student out of a batch
             * temporarily is a real thing to do, and blocking it would make
             * every unrelated edit impossible for a student between batches.
             */
            { name: 'batchId', label: 'Batch', type: 'select',
              required: !existing,
              placeholder: existing ? 'Not placed' : 'Choose a batch',
              options: (v) => open
                  .filter((b) => !v.branchId || b.branchId === v.branchId)
                  .map((b) => ({
                      value: b.id,
                      label: `${b.name} — ${b.enrolled}/${b.capacity || '∞'}`
                           + (b.capacity && b.enrolled >= b.capacity ? ' (full)' : '')
                  })),
              help: 'Only batches at the chosen branch. A student with no batch appears on no register.' },
            /*
             * Required, and now shown when EDITING too — UAT5-BUG-504.
             *
             * It was optional and defaulting to "No plan", and a student created
             * without one is never billed at all, silently: raiseSchedule() is
             * only ever reached when a plan exists. Nobody picks that on
             * purpose, so it is required on create.
             *
             * It was then hidden on edit, on the grounds that "choosing a plan
             * raises the schedule immediately, which is wrong as a side effect
             * of correcting a phone number". THE PREMISE WAS FALSE, which is
             * why this is a bug and not a preference: raising happens in
             * enrol(), which calls raiseSchedule() itself. updateStudent() does
             * not — it writes the field and stops. So editing never billed
             * anything, and hiding the field bought nothing while making a
             * student's plan unchangeable from a phone.
             *
             * What a change DOES do is real but quiet, and the help text says
             * it: runBillingScheduler() reads student.feePlanId on every run,
             * so the next cycle bills on the new plan. Cycles already raised
             * keep their own periodKey and are never re-billed, so nothing
             * behind the change moves.
             */
            { name: 'feePlanId', label: 'Fee plan', type: 'select', required: true,
              placeholder: 'Choose a fee plan',
              options: plans.map((p) => ({ value: p.id, label: `${p.name} — ${formatMoney(p.amount)}` })),
              help: existing
                  ? 'Applies from the next billing cycle. Fees already raised are not changed.'
                  : 'Raises the fee schedule immediately.' },
            { name: 'joinedOn', label: 'Joined on', type: 'date' },

            { type: 'divider', label: 'Guardian' },
            { name: 'guardianName', label: 'Guardian name', required: true },
            { name: 'guardianRelation', label: 'Relationship', type: 'select',
              options: ['Mother', 'Father', 'Grandparent', 'Guardian', 'Sibling']
                  .map((r) => ({ value: r, label: r })) },
            { name: 'guardianPhone', label: 'Phone', type: 'tel', required: true },
            /* Required. It is the guardian's sign-in identity for the Parent
               Portal — students.repository matches a portal account by
               guardianEmail — so a student saved without one has a family that
               cannot reach the app at all. */
            { name: 'guardianEmail', label: 'Email', type: 'email', required: true },
            { name: 'address', label: 'Address', type: 'textarea', rows: 2 },

            { type: 'divider', label: 'Health and notes' },
            { name: 'medicalNotes', label: 'Medical notes', type: 'textarea', rows: 2,
              help: 'Anything a teacher must know before class.' },
            { name: 'notes', label: 'Other notes', type: 'textarea', rows: 2 }
        ];

        // The guardian's own fields live on the guardian record, so an edit
        // reads them back off the profile rather than off the student.
        const guardian = existing ? (this.profile?.guardian || {}) : {};

        return fields.map((f) => (f.type === 'divider' ? f : {
            ...f,
            value: f.name === 'branchId' ? defaultBranchId
                 : f.name === 'joinedOn' ? (existing?.joinedOn || localDate())
                 : f.name === 'guardianRelation' ? (guardian.relation || 'Mother')
                 : f.name === 'guardianName' ? (guardian.name || '')
                 : f.name === 'guardianPhone' ? (guardian.phone || '')
                 : f.name === 'guardianEmail' ? (guardian.email || '')
                 : (existing?.[f.name] ?? '')
        }));
    }

    /** Turns the field list into the `values` map formModal seeds itself from. */
    static seed(fields) {
        return Object.fromEntries(fields
            .filter((f) => f.type !== 'divider')
            .map((f) => [f.name, f.value ?? '']));
    }

    async newStudent() {
        session.require(CAPABILITIES.STUDENT_EDIT, 'add a student');
        const fields = await this.studentFields();

        const result = await formModal({
            title: 'Add a student',
            description: 'Enrols directly, without an application.',
            submitLabel: 'Enrol',
            fields,
            values: MobileStudentsPage.seed(fields),
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

    /* ------------------------------------------------------------ OPERATIONS */
    /*
     * UAT BUG-602. Opening a student showed the record but offered nothing to
     * do with it — every management action was desktop-only. These are the same
     * six a desktop user has, driven through the same services, so the rules
     * (a full batch is refused, a leaver must have a reason recorded, a
     * certificate's eligibility is checked) are identical on both surfaces.
     *
     * Collect Fee hands off to the Fees screen rather than re-implementing the
     * ledger: which invoice a payment settles is the decision being made, and
     * that screen already presents it.
     */

    actionRow() {
        const student = this.profile?.student;
        if (!student) return '';

        const may = {
            edit: session.can(CAPABILITIES.STUDENT_EDIT),
            fee: session.can(CAPABILITIES.FEE_COLLECT),
            cert: session.can(CAPABILITIES.CERTIFICATE_ISSUE)
        };
        if (!may.edit && !may.fee && !may.cert) return '';

        const action = (op, iconName, label) => html`
            <button class="m-btn m-btn-ghost" data-action="op" data-op="${op}">
                ${raw(icon(iconName, { size: 15 }))} ${label}
            </button>
        `;

        return html`
            <p class="m-section-label" style="margin:4px 0 0;">Actions</p>
            <div class="m-actions">
                ${may.edit ? action('edit', 'edit', 'Edit student') : ''}
                ${may.edit ? action('move-batch', 'grid', 'Move batch') : ''}
                ${may.edit ? action('promote', 'star', 'Promote') : ''}
                ${may.edit ? action('set-status', 'user', 'Change status') : ''}
                ${may.fee ? action('collect-fee', 'receipt', 'Collect fee') : ''}
                ${may.cert ? action('issue-certificate', 'award', 'Issue certificate') : ''}
            </div>
        `;
    }

    operation(key) {
        if (key === 'edit') return this.editStudent();
        if (key === 'move-batch') return this.moveBatch();
        if (key === 'promote') return this.promoteStudent();
        if (key === 'set-status') return this.changeStatus();
        if (key === 'collect-fee') return this.collectFee();
        if (key === 'issue-certificate') return this.issueCertificate();
    }

    /**
     * Refreshes the open profile and the list behind it after any write.
     *
     * paintSheet(), not paintProfile() — there has never been a paintProfile()
     * on this page. Every one of the five operations that routes through here
     * (edit, move batch, promote, change status, issue certificate) wrote
     * successfully, showed its success toast, then threw "this.paintProfile is
     * not a function" on the very next line — so the change was saved while the
     * screen said it had failed, and `await this.load()` below never ran,
     * leaving the list stale behind the error too.
     */
    async refreshAfterOperation(studentId) {
        this.profile = await profile(studentId);
        this.paintSheet();
        await this.load();
    }

    async editStudent() {
        const student = this.profile?.student;
        if (!student) return;
        const fields = await this.studentFields(student);

        const saved = await formModal({
            title: `Edit ${student.name}`,
            submitLabel: 'Save changes',
            fields,
            values: MobileStudentsPage.seed(fields),
            onSubmit: (values) => updateStudent(student.id, values)
        });

        if (!saved) return;
        toast.success('Student updated', student.name);
        await this.refreshAfterOperation(student.id);
    }

    async moveBatch() {
        const student = this.profile?.student;
        if (!student) return;

        // Same rule as the enrol form (UAT BUG-208): only this student's own
        // branch, so a move cannot silently relocate them to another site.
        const batches = (await listBatches(session.branch()))
            .filter((b) => b.status !== 'closed')
            .filter((b) => !student.branchId || b.branchId === student.branchId);

        const moved = await formModal({
            title: `Move ${student.name}`,
            description: 'A student with no batch appears on no register.',
            submitLabel: 'Move',
            fields: [
                { name: 'batchId', label: 'Batch', type: 'select', placeholder: 'Take them off every batch',
                  options: batches.map((b) => ({
                      value: b.id,
                      label: `${b.name} — ${b.enrolled}/${b.capacity || '∞'}`
                           + (b.capacity && b.enrolled >= b.capacity ? ' (full)' : '')
                  })),
                  help: 'The service refuses a batch that is already full.' }
            ],
            values: { batchId: student.batchId || '' },
            // assignToBatch() treats a null batch as "take them off every
            // batch", which is the placeholder above — so an empty value is a
            // real choice, not a missing one, and the field is not required.
            onSubmit: (v) => assignToBatch(student.id, v.batchId || null)
        });

        if (!moved) return;
        toast.success('Batch updated', student.name);
        await this.refreshAfterOperation(student.id);
    }

    /**
     * Moves a student up one level. `promote()` also clears their batch —
     * someone who has moved up is no longer in the right class — and the dialog
     * says so, because otherwise they quietly vanish off a register overnight.
     */
    async promoteStudent() {
        const student = this.profile?.student;
        if (!student) return;

        const ladder = curriculum();
        const index = ladder.findIndex((l) => l.value === student.level);
        const next = index >= 0 ? ladder[index + 1] : null;

        // The service throws for both of these. Checking first turns a rejected
        // submit into a dialog that never opens with a pointless form in it.
        if (!next) {
            toast.error(
                index === -1 ? 'Unrecognised level' : 'Already at the final level',
                index === -1
                    ? `${student.name} is at a level that is no longer in the curriculum.`
                    : `${student.name} has completed ${ladder[index].label}. Issue a diploma instead.`);
            return;
        }

        const done = await formModal({
            title: `Promote ${student.name}`,
            description: `${ladder[index].label} → ${next.label}. This also takes them off `
                       + `${student.batchId ? 'their current batch' : 'any batch'}, so they can be `
                       + 'placed in one that teaches the new level.',
            submitLabel: 'Promote',
            fields: [
                { name: 'note', label: 'Note', type: 'textarea', rows: 2,
                  help: 'Optional. Kept on the record as the reason for the promotion.' }
            ],
            values: { note: '' },
            onSubmit: (v) => promote(student.id, { note: v.note })
        });

        if (!done) return;
        toast.success('Promoted', `${student.name} is now at ${done.to.label}.`);
        await this.refreshAfterOperation(student.id);
    }

    /**
     * Leaving (Inactive or Graduated) requires a reason — the service insists,
     * because it is the only history of why — and also clears their batch.
     * `setStatus()` reports any outstanding balance back rather than cancelling
     * it: whether a leaver still owes money is a decision for a person, so the
     * figure is surfaced instead of swallowed.
     */
    async changeStatus() {
        const student = this.profile?.student;
        if (!student) return;

        const leaving = (st) => st === STUDENT_STATUS.INACTIVE || st === STUDENT_STATUS.GRADUATED;

        const result = await formModal({
            title: `${student.name}'s status`,
            description: `Currently ${statusLabel(student.status)}.`,
            submitLabel: 'Save status',
            fields: [
                { name: 'status', label: 'Status', type: 'select', required: true,
                  options: Object.values(STUDENT_STATUS)
                      .map((st) => ({ value: st, label: statusLabel(st) })) },
                { name: 'reason', label: 'Why', type: 'textarea', rows: 2,
                  showIf: (v) => leaving(v.status),
                  help: 'Required when someone leaves — it is the only record of why. '
                      + 'They also come off their batch.' }
            ],
            values: { status: student.status || STUDENT_STATUS.ACTIVE, reason: '' },
            validateAll: (v) => (leaving(v.status) && !String(v.reason || '').trim())
                ? { reason: 'Record why the student is leaving.' } : null,
            onSubmit: (v) => setStatus(student.id, v.status, { reason: v.reason })
        });

        if (!result) return;
        toast.success('Status updated', statusLabel(result.student.status));
        if (result.outstanding > 0) {
            toast.info(
                `${formatMoney(result.outstanding)} still outstanding`,
                'Their invoices were left alone — settle or waive them on the Fees screen.');
        }
        await this.refreshAfterOperation(student.id);
    }

    /**
     * Hands off to the Fees screen with this student already open.
     *
     * Collecting a payment means choosing which invoice it settles, and that
     * ledger — with each invoice's balance, age and due date — already exists
     * there. Rebuilding it inside this sheet would be a second copy of the same
     * screen that could drift from the first.
     */
    collectFee() {
        const student = this.profile?.student;
        if (!student) return;
        this.closeProfile();
        router.go(`/fees?student=${encodeURIComponent(student.id)}`);
    }

    /**
     * Issuing a certificate.
     *
     * Eligibility is asked of the service, never guessed here. When it refuses,
     * the refusal is shown and an override is offered — but the reason is then
     * required and stored on the certificate itself, where every future
     * verification will show it.
     */
    async issueCertificate() {
        const student = this.profile?.student;
        if (!student) return;
        session.require(CAPABILITIES.CERTIFICATE_ISSUE, 'issue a certificate');

        const programs = await listPrograms(session.branch(), { status: PROGRAM_STATUS.COMPLETED })
            .catch(() => []);

        const issued = await formModal({
            title: `Certificate for ${student.name}`,
            description: 'The serial is allocated when it is issued and never reused.',
            submitLabel: 'Check and issue',
            fields: [
                { name: 'templateId', label: 'Kind', type: 'select', required: true,
                  placeholder: 'Choose a kind',
                  options: TEMPLATES.map((t) => ({ value: t.id, label: t.name })) },
                // Only the participation template needs a programme, and only
                // completed programmes can be certified against.
                { name: 'programId', label: 'Programme', type: 'select',
                  placeholder: programs.length ? 'Choose a programme' : 'No completed programme yet',
                  options: programs.map((pr) => ({
                      value: pr.id, label: `${pr.name} — ${formatDateLong(pr.date)}`
                  })),
                  showIf: (v) => v.templateId === 'participation',
                  help: 'A participation certificate is issued against a completed programme.' },
                { name: 'citation', label: 'Citation', type: 'textarea', rows: 2,
                  showIf: (v) => v.templateId === 'merit',
                  help: 'What is being recognised. It is printed on the certificate.' },
                { name: 'issuedOn', label: 'Issued on', type: 'date' }
            ],
            values: { templateId: '', programId: '', citation: '', issuedOn: localDate() },
            onSubmit: async (v) => {
                const payload = {
                    studentId: student.id,
                    templateId: v.templateId,
                    programId: v.programId || null,
                    citation: v.citation || null
                };

                const check = await checkEligibility(payload);
                if (check.ok) return issue({ ...payload, issuedOn: v.issuedOn || null });

                const reasons = check.reasons.join(' ');
                const proceed = await confirmModal({
                    title: 'This does not meet the rules',
                    message: `${reasons} A certificate can still be issued, but the override is `
                           + 'recorded on it permanently and shows on every verification.',
                    confirmLabel: 'Issue on override',
                    tone: 'negative'
                });
                if (!proceed) throw new Error(reasons);

                const overrideReason = await formModal({
                    title: 'Why is this being overridden?',
                    description: 'Stored on the certificate itself, not just in a log.',
                    submitLabel: 'Issue',
                    fields: [{ name: 'overrideReason', label: 'Reason', required: true }],
                    values: { overrideReason: '' },
                    onSubmit: (r) => r.overrideReason
                });
                if (!overrideReason) throw new Error('Not issued. Nothing has changed.');

                return issue({ ...payload, issuedOn: v.issuedOn || null,
                               force: true, overrideReason });
            }
        });

        if (!issued) return;
        toast.success('Certificate issued', issued.serial);
        await this.refreshAfterOperation(student.id);
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

function feeLabel(row) {
    if (row.overdue > 0) return `${formatMoneyShort(row.overdue)} overdue`;
    if (row.outstanding > 0) return `${formatMoneyShort(row.outstanding)} due`;
    return 'Paid up';
}

function statusLabel(status) {
    return String(status || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
