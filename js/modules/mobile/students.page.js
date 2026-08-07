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
import { curriculum, levelsOf, levelLabel, CAPABILITIES, STUDENT_STATUS } from '../../config/app.config.js';
import { studentFormFields, seedStudentValues } from '../../config/studentFields.js';
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
     * The student form's fields, shared by enrolment and editing.
     *
     * THE FIELDS THEMSELVES ARE NOT DECLARED HERE ANY MORE — UAT6 ENH-602.
     * `js/config/studentFields.js` owns them, and natyam-admin's Students
     * screen and both apps' Admissions enrol step build from the same call, so
     * the mandatory set and the wording of every validation message are one
     * thing rather than three that drifted. The guardian fields seed off the
     * student record, which is where `guardianOf()` reads them from too.
     *
     * Batches are fetched for EVERY branch, not `session.branch()`: the form's
     * own Branch field narrows them (UAT BUG-208, tightened by UAT6 BUG-602),
     * and a session filtered to one branch must not stop somebody moving a
     * student to another.
     */
    async studentFields(existing = null) {
        const [batches, feePlans, branches] = await Promise.all([
            listBatches(null), listFeePlans({ includeInactive: true }), listBranches()
        ]);

        return studentFormFields({
            mode: existing ? 'edit' : 'add',
            existing,
            branches,
            batches,
            feePlans,
            defaultBranchId: session.branch() || ''
        });
    }

    async newStudent() {
        session.require(CAPABILITIES.STUDENT_EDIT, 'add a student');
        const fields = await this.studentFields();

        const result = await formModal({
            title: 'Add a student',
            description: 'Enrols directly, without an application.',
            submitLabel: 'Enrol',
            fields,
            values: seedStudentValues(fields),
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
            // Named here rather than left to the Batch field's own help text:
            // changing the branch is the one edit that forces a second answer,
            // and it is better said before somebody discovers it (UAT6 BUG-602).
            description: 'Changing the branch means choosing a batch at the new one.',
            submitLabel: 'Save changes',
            fields,
            values: seedStudentValues(fields),
            onSubmit: (values) => updateStudent(student.id, values)
        });

        if (!saved) return;
        toast.success('Student updated', student.name);
        await this.refreshAfterOperation(student.id);
    }

    /**
     * Moves a student between batches.
     *
     * "Take them off every batch" is gone from the placeholder — UAT6. It was
     * the shortest route to the record BUG-602 forbids: a student attending and
     * billed, on no register. `assignToBatch()` now refuses it for an active
     * student outright, so offering it here would only produce a rejection.
     * Somebody who has stopped attending is handled by Change status, which
     * clears the batch itself, and the help text says so.
     *
     * Identical to natyam-admin's, including the branch filter (UAT BUG-208):
     * only this student's own branch, so a move cannot silently relocate them.
     */
    async moveBatch() {
        const student = this.profile?.student;
        if (!student) return;

        const batches = (await listBatches(null))
            .filter((b) => b.status !== 'closed')
            .filter((b) => !student.branchId || b.branchId === student.branchId);

        const moved = await formModal({
            title: `Move ${student.name}`,
            description: 'A student with no batch appears on no register, so a batch has to be chosen.',
            submitLabel: 'Move',
            fields: [
                { name: 'batchId', label: 'Batch', type: 'select', required: true,
                  placeholder: 'Choose a batch',
                  options: batches.map((b) => ({
                      value: b.id,
                      label: `${b.name} — ${b.enrolled}/${b.capacity || '∞'}`
                           + (b.capacity && b.enrolled >= b.capacity ? ' (full)' : '')
                  })),
                  help: 'Only batches at this student’s branch. The service refuses one that is '
                      + 'full or that does not teach their level. To take them off the register '
                      + 'altogether, use Change status instead.' }
            ],
            values: { batchId: student.batchId || '' },
            onSubmit: (v) => assignToBatch(student.id, v.batchId)
        });

        if (!moved) return;
        toast.success('Batch updated', student.name);
        await this.refreshAfterOperation(student.id);
    }

    /**
     * Moves a student up one level, and into the class that teaches it.
     *
     * THE NEW BATCH IS PART OF THE PROMOTION — UAT6. `promote()` used to clear
     * the batch and leave the student active, which is precisely the record
     * BUG-602 says must not exist, and it produced one on every promotion. The
     * destination is asked for here instead, filtered to batches that actually
     * teach the next level, so the student never spends a moment unplaced.
     *
     * When nothing teaches the next level the dialog does not open: there is no
     * answer to give it, and the honest thing to say is that the class has to
     * exist first.
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

        const destinations = (await listBatches(null))
            .filter((b) => b.status !== 'closed')
            .filter((b) => !student.branchId || b.branchId === student.branchId)
            .filter((b) => levelsOf(b).includes(next.value));

        if (!destinations.length) {
            toast.error(`No batch teaches ${next.label} yet`,
                `${student.name} cannot be promoted into a class that is not running. `
                + `Create or reopen a ${next.label} batch at their branch first.`);
            return;
        }

        const done = await formModal({
            title: `Promote ${student.name}`,
            description: `${ladder[index].label} → ${next.label}. They move straight into the batch `
                       + 'chosen below, so they are never off a register.',
            submitLabel: 'Promote',
            fields: [
                { name: 'batchId', label: `Batch at ${next.label}`, type: 'select', required: true,
                  placeholder: 'Choose a batch',
                  options: destinations.map((b) => ({
                      value: b.id,
                      label: `${b.name} — ${b.enrolled}/${b.capacity || '∞'}`
                           + (b.capacity && b.enrolled >= b.capacity ? ' (full)' : '')
                  })),
                  help: `Only batches teaching ${next.label} at this student’s branch.` },
                { name: 'note', label: 'Note', type: 'textarea', rows: 2,
                  help: 'Optional. Kept on the record as the reason for the promotion.' }
            ],
            values: { batchId: '', note: '' },
            onSubmit: (v) => promote(student.id, { batchId: v.batchId, note: v.note })
        });

        if (!done) return;
        toast.success('Promoted', `${student.name} is now at ${done.to.label}, in ${done.batch.name}.`);
        await this.refreshAfterOperation(student.id);
    }

    /**
     * Leaving (Inactive or Graduated) requires a reason — the service insists,
     * because it is the only history of why — and also clears their batch.
     * `setStatus()` reports any outstanding balance back rather than cancelling
     * it: whether a leaver still owes money is a decision for a person, so the
     * figure is surfaced instead of swallowed.
     *
     * COMING BACK asks for the batch they are returning to — UAT6, the other
     * half of the invariant. A leaver's batch was cleared when they left, so
     * setting them Active again would otherwise put an attending student on no
     * register. Only asked when there is genuinely nothing to go back to: a
     * student On leave keeps their batch and is never asked.
     */
    async changeStatus() {
        const student = this.profile?.student;
        if (!student) return;

        const leaving = (st) => st === STUDENT_STATUS.INACTIVE || st === STUDENT_STATUS.GRADUATED;
        const returning = (st) => st === STUDENT_STATUS.ACTIVE && !student.batchId;

        const batches = student.batchId ? [] : (await listBatches(null))
            .filter((b) => b.status !== 'closed')
            .filter((b) => !student.branchId || b.branchId === student.branchId)
            .filter((b) => levelsOf(b).includes(student.level));

        const result = await formModal({
            title: `${student.name}'s status`,
            description: `Currently ${statusLabel(student.status)}.`,
            submitLabel: 'Save status',
            fields: [
                { name: 'status', label: 'Status', type: 'select', required: true, reactive: true,
                  options: Object.values(STUDENT_STATUS)
                      .map((st) => ({ value: st, label: statusLabel(st) })) },
                { name: 'reason', label: 'Why', type: 'textarea', rows: 2,
                  showIf: (v) => leaving(v.status),
                  help: 'Required when someone leaves — it is the only record of why. '
                      + 'They also come off their batch.' },
                { name: 'batchId', label: 'Returning to which batch?', type: 'select',
                  placeholder: 'Choose a batch',
                  showIf: (v) => returning(v.status),
                  options: batches.map((b) => ({
                      value: b.id,
                      label: `${b.name} — ${b.enrolled}/${b.capacity || '∞'}`
                           + (b.capacity && b.enrolled >= b.capacity ? ' (full)' : '')
                  })),
                  help: 'They came off their batch when they left. Only batches teaching '
                      + `${levelLabel(student.level) || 'their level'} at their branch.` }
            ],
            values: { status: student.status || STUDENT_STATUS.ACTIVE, reason: '', batchId: '' },
            validateAll: (v) => {
                if (leaving(v.status) && !String(v.reason || '').trim()) {
                    return { reason: 'Record why the student is leaving.' };
                }
                if (returning(v.status) && !v.batchId) {
                    return batches.length
                        ? { batchId: 'Choose the batch they are returning to.' }
                        : { status: `No batch at their branch teaches ${levelLabel(student.level) || 'their level'}. `
                                  + 'Open one before bringing them back.' };
                }
                return null;
            },
            onSubmit: (v) => setStatus(student.id, v.status, { reason: v.reason, batchId: v.batchId || null })
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
