/**
 * Natyam ERP v3 — Mobile — Admissions
 *
 * The application pipeline on a phone. Typically used at the front desk: a
 * parent is standing there, and reception needs to see where the application
 * has got to and move it on.
 *
 * NO APPROVED v3 DESIGN EXISTS FOR THIS SCREEN. `Admissions.dc.html` was lost
 * with the design project and could not be regenerated (see
 * docs/design/README.md). Built directly on the user's instruction, from the
 * two things that are settled: the **workflow is the service's** —
 * `nextActionFor()` defines exactly one next step per status, and this page
 * renders that ladder rather than deciding it — and the **visual language is
 * the implemented v3 mobile system**.
 *
 * Differences from the desktop page, all because a phone is not a desk:
 *   - The pipeline is a horizontally scrolled stat strip, not a six-up grid.
 *   - The detail is a near-full-screen sheet, not a centred modal.
 *   - The next action is a full-width button pinned at the foot of the sheet,
 *     so it is reachable with a thumb without scrolling the record.
 *   - Guardian phone is tap-to-call — the single most useful thing reception
 *     can do with an application that is stuck.
 *
 * **New applications are not taken here.** Intake is a multi-step wizard that
 * deserves its own stage, and a phone is the worst place to start one.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatDate, formatDateLong } from '../../utils/date.js';
import { ADMISSION_STATUS, curriculum, CAPABILITIES } from '../../config/app.config.js';
import { formatMoney } from '../../utils/money.js';
import {
    pipeline, listApplications, applicationDetail,
    beginReview, approve, reject, reopen, enrolApplicant,
    submit as submitApplication, validateStep, ADMISSION_STEPS
} from '../../services/admissions.service.js';
import { listBranches, listFeePlans } from '../../services/settings.service.js';
import { formModal } from '../../ui/form.js';
import { filterBar, renderFilterPanel, bindFilterToggle } from '../../ui/filterBar.js';

const FILTERS = [
    { key: null, label: 'All' },
    // Parent Portal Stage 4. A SOURCE, not a status — handled separately in
    // visibleRows() rather than passed to listApplications(). Second in the
    // list because a self-service application is the one kind nobody is
    // standing at the desk to chase: a walk-in announces itself, this only
    // exists in the queue.
    //
    // Recognition only. Mapping a parent's preferred branch to an ERP branch
    // is Desktop-only by decision — that is an administrative task, and this
    // page deliberately offers no branch editing.
    { key: 'source:parent', label: 'From parents' },
    { key: ADMISSION_STATUS.SUBMITTED, label: 'Submitted' },
    { key: ADMISSION_STATUS.REVIEWING, label: 'Reviewing' },
    { key: ADMISSION_STATUS.APPROVED, label: 'Approved' },
    { key: ADMISSION_STATUS.ENROLLED, label: 'Enrolled' },
    { key: ADMISSION_STATUS.REJECTED, label: 'Rejected' }
];

export default class MobileAdmissionsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Admissions';
        this.stats = null;
        this.rows = [];
        this.filter = this.query.filter || null;
        this.search = '';
        // Open only when arriving on a filtered link, so the panel explains
        // why the list is already narrowed — the same rule Students uses.
        this.filtersOpen = Boolean(this.filter);
        this.detail = null;
        this.busy = false;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading…</div>`);
        this.bind();
        await this.load();

        [EVENTS.ADMISSION_SUBMITTED, EVENTS.ADMISSION_APPROVED, EVENTS.ADMISSION_ENROLLED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const branchId = session.branch();
            const [stats, rows] = await Promise.all([
                pipeline(branchId),
                // "From parents" is a source, not a status — passing it to the
                // service's status filter would match nothing and silently
                // empty the list. Applied in visibleRows() instead, so the
                // query here asks for everything.
                listApplications(branchId, {
                    status: this.filter === 'source:parent' ? null : this.filter
                })
            ]);
            if (this.disposed) return;
            this.stats = stats;
            this.rows = rows;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Admissions failed to load', err);
            render(this.container, html`
                <div class="m-error">Applications could not be loaded — ${err.message}</div>
            `);
        }
    }

    visibleRows() {
        // Source filter applied here rather than in the service query, for the
        // reason load() documents. `preferredBranch` joins the search fields
        // because it may be the only branch a parent application carries —
        // searching "Kondapur" should find one.
        const bySource = this.filter === 'source:parent'
            ? this.rows.filter((row) => row.source === 'parent_portal')
            : this.rows;

        const term = this.search.trim().toLowerCase();
        if (!term) return bySource;
        return bySource.filter((row) =>
            [row.name, row.guardianName, row.guardianPhone, row.applicationNo, row.preferredBranch]
                .some((value) => String(value || '').toLowerCase().includes(term)));
    }

    paint() {
        const rows = this.visibleRows();
        const stats = this.stats;

        // Painted after the main render below, because filterBar() leaves an
        // empty [data-role="filter-panel"] for it to fill.
        const panel = html`
            <div class="m-chip-scroll">
                ${FILTERS.map((item) => html`
                    <button class="m-pill" data-action="filter" data-key="${item.key || ''}"
                            aria-pressed="${this.filter === item.key ? 'true' : 'false'}">${item.label}</button>
                `)}
            </div>
        `;

        render(this.container, html`
            <!--
              ENH-304/306 — the standard filter bar, shared with every other
              module (js/ui/filterBar.js). Admissions previously had a search
              field with no funnel and its status pills always on show; they
              now hide behind the funnel like everywhere else.
            -->
            ${filterBar({
                placeholder: 'Search name, guardian, phone…',
                label: 'Search applications',
                open: this.filtersOpen,
                note: stats ? `${stats.awaitingAction} awaiting action · ${rows.length} shown` : ''
            })}

            ${stats ? html`
                <div class="m-kpi-strip" style="margin-top:12px;">
                    ${stat('Awaiting', stats.awaitingAction, stats.awaitingAction ? 'caution' : 'positive')}
                    ${stat('Submitted', stats.submitted, 'neutral')}
                    ${stat('Reviewing', stats.reviewing, 'neutral')}
                    ${stat('Approved', stats.approved, stats.approved ? 'caution' : 'neutral')}
                    ${stat('Enrolled', stats.enrolled, 'positive')}
                </div>
            ` : ''}

            <div class="m-stack">
                ${rows.length ? rows.map((row) => html`
                    <button class="m-card m-student" data-action="open" data-id="${row.id}">
                        <span class="m-student-main">
                            <span class="m-student-name">${row.name}</span>
                            <span class="m-student-meta">
                                ${
                                    // Leads the meta line rather than sitting as a second
                                    // trailing badge beside the status one. Two badges do
                                    // not fit a 375px row — the same constraint that made
                                    // the stalled signal replace the applied date below
                                    // rather than join it — and .m-student-name is
                                    // nowrap+ellipsis, so an inline chip there gets clipped
                                    // by a long child's name. First in the meta line is the
                                    // one place it is always readable.
                                    row.source === 'parent_portal' ? 'From parent · ' : ''
                                }${row.levelLabel || '—'}${
                                    // A stalled application shows how long it has waited
                                    // *instead of* when it arrived, not as well as: both
                                    // together overflow a 375px row and the ellipsis ate
                                    // the waiting time — the one signal that row exists to
                                    // raise. The applied date is still on the detail sheet.
                                    row.stalled
                                        ? ` · waiting ${row.waitingDays}d`
                                        : row.appliedOn ? ` · ${formatDate(row.appliedOn)}` : ''
                                }
                            </span>
                        </span>
                        <span class="m-badge" data-admission="${row.status}">${row.statusLabel}</span>
                    </button>
                `) : html`<div class="m-card m-empty">No application matches that.</div>`}
            </div>

            ${session.can(CAPABILITIES.ADMISSION_EDIT) ? html`
                <button class="m-fab" data-action="new" aria-label="Take a new application">
                    ${raw(icon('plus', { size: 24 }))}
                </button>
            ` : ''}
        `);

        renderFilterPanel(this.container, this.filtersOpen, panel);
    }

    /* --------------------------------------------------------------- DETAIL */

    async open(id) {
        try {
            this.detail = await applicationDetail(id);
            if (this.disposed) return;
            this.paintDetail();
        } catch (err) {
            toast.error(`Could not open that application — ${err.message}`);
        }
    }

    close() {
        this.detail = null;
        const host = this.container.querySelector('[data-role="sheet"]');
        if (host) render(host, '');
        else this.paint();
    }

    paintDetail() {
        let host = this.container.querySelector('[data-role="sheet"]');
        if (!host) {
            host = document.createElement('div');
            host.setAttribute('data-role', 'sheet');
            this.container.append(host);
        }
        if (!this.detail) { render(host, ''); return; }

        const { application: app, levelLabel: level, statusLabel, nextAction, eligibleBatches, possibleDuplicates } = this.detail;
        const canEdit = session.can('admission.edit');
        const canApprove = session.can('admission.approve');
        const enrolling = nextAction?.key === 'enrol';
        const allowed = nextAction ? this.canDo(nextAction.key, canEdit, canApprove) : false;

        render(host, html`
            <div class="m-sheet-scrim" data-action="close-detail"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${app.name}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${app.name}</h2>
                        <p class="m-profile-sub">
                            ${app.applicationNo || '—'} · ${level || '—'}
                        </p>
                    </div>
                    <button class="m-icon-btn" data-action="close-detail" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    <div><span class="m-badge" data-admission="${app.status}">${statusLabel}</span></div>

                    ${app.source === 'parent_portal' ? html`
                        <div class="m-notice" data-tone="info">
                            Submitted by the family through the Natyam app.${
                                app.applicationNo ? '' : ' A NAT/APP number is issued when review begins.'
                            }${
                                // Recognition only — there is no branch picker on mobile by
                                // decision. Naming the preference here is what lets whoever
                                // opens this on a phone know the application is unassigned
                                // and why, without offering an edit that belongs at a desk.
                                app.preferredBranch && !app.branchId
                                    ? ` The family asked for ${app.preferredBranch}; assign a branch in the Desktop ERP.`
                                    : ''
                            }
                        </div>
                    ` : ''}

                    ${possibleDuplicates?.length ? html`
                        <div class="m-notice" data-tone="caution">
                            ${possibleDuplicates.length} similar application${possibleDuplicates.length === 1 ? '' : 's'} already
                            exist${possibleDuplicates.length === 1 ? 's' : ''} — check before enrolling.
                        </div>
                    ` : ''}

                    <dl class="m-facts">
                        ${fact('Applied on', app.appliedOn ? formatDateLong(app.appliedOn) : '—')}
                        ${fact('Level', level || '—')}
                        ${fact('Guardian', app.guardianName || '—')}
                        ${fact('Phone', app.guardianPhone || '—')}
                    </dl>

                    ${app.guardianPhone ? html`
                        <a class="m-btn m-btn-ghost m-btn-block" href="tel:${app.guardianPhone}">
                            ${raw(icon('phone', { size: 16 }))} Call guardian
                        </a>
                    ` : ''}

                    ${app.notes ? html`<div class="m-notice" data-tone="info">${app.notes}</div>` : ''}
                    ${app.rejectionReason ? html`
                        <div class="m-notice" data-tone="caution"><strong>Rejected:</strong> ${app.rejectionReason}</div>
                    ` : ''}

                    ${enrolling ? html`
                        <label class="m-facts" style="gap:8px;">
                            <span style="color:var(--v3-muted);font-size:11.5px;">Enrol into which batch?</span>
                            <select data-role="batch"
                                    style="width:100%;min-height:var(--v3-tap);background:rgba(255,255,255,0.08);color:var(--v3-name);border:1px solid var(--v3-card-border);border-radius:10px;font:inherit;padding:0 10px;">
                                <option value="">Choose a batch…</option>
                                ${(eligibleBatches || []).map((batch) => html`
                                    <option value="${batch.id}">
                                        ${batch.name}${batch.seatsLeft != null ? ` — ${batch.seatsLeft} left` : ''}
                                    </option>
                                `)}
                            </select>
                        </label>
                        ${eligibleBatches?.length ? '' : html`
                            <div class="m-notice" data-tone="caution">
                                No batch matches this level yet.
                            </div>
                        `}
                    ` : ''}
                </div>

                <div class="m-sheet-foot">
                    ${app.status === ADMISSION_STATUS.REVIEWING || app.status === ADMISSION_STATUS.SUBMITTED ? html`
                        <button class="m-btn m-btn-ghost" data-action="reject"
                                ${canApprove && !this.busy ? '' : 'disabled'}>Reject</button>
                    ` : ''}
                    ${nextAction ? html`
                        <button class="m-btn" style="flex:1;" data-action="advance" data-key="${nextAction.key}"
                                ${allowed && !this.busy ? '' : 'disabled'}>
                            ${this.busy ? 'Working…' : nextAction.label}
                        </button>
                    ` : html`<span class="m-profile-note" style="flex:1;">No further action — this application is closed.</span>`}
                </div>
            </div>
        `);
    }

    /** Mirrors the service's own session.require() calls. */
    canDo(key, canEdit, canApprove) {
        if (key === 'review' || key === 'submit') return canEdit;
        return canApprove;
    }

    /* -------------------------------------------------------------- ACTIONS */

    async advance(key) {
        const app = this.detail?.application;
        if (!app || this.busy) return;
        if (key === 'enrol') return this.enrol(app);

        this.busy = true;
        this.paintDetail();
        try {
            if (key === 'review') await beginReview(app.id);
            else if (key === 'approve') await approve(app.id);
            else if (key === 'reopen') await reopen(app.id);
            else throw new Error(`"${key}" is not something this screen can do yet.`);

            toast.success('Application updated', app.name);
            this.busy = false;
            this.detail = null;
            await this.load();
        } catch (err) {
            this.busy = false;
            if (this.disposed) return;
            toast.error(err.message);
            this.paintDetail();
        }
    }

    async enrol(app) {
        const batchId = this.container.querySelector('[data-role="batch"]')?.value;
        if (!batchId) {
            toast.error('Choose a batch', 'An applicant is enrolled into a batch, so one has to be picked first.');
            return;
        }
        this.busy = true;
        this.paintDetail();
        try {
            await enrolApplicant(app.id, { batchId });
            toast.success('Enrolled', `${app.name} is now a student.`);
            this.busy = false;
            this.detail = null;
            await this.load();
        } catch (err) {
            this.busy = false;
            if (this.disposed) return;
            toast.error(`Could not enrol — ${err.message}`);
            this.paintDetail();
        }
    }

    async doReject() {
        const app = this.detail?.application;
        if (!app || this.busy) return;

        // ENH-305. The desktop screen uses window.prompt() here and calls that
        // deliberate — "a bespoke dialog for one field is not worth the surface
        // area". That reasoning does not carry to a phone: formModal is already
        // imported and used in this same file, so there is no surface area to
        // save, and a native prompt in an installed PWA is an OS dialog that
        // looks nothing like the app it interrupts.
        //
        // The reason is required by reject() itself, so an empty one is refused
        // by the service rather than only by this form.
        const done = await formModal({
            title: `Reject ${app.name}'s application?`,
            description: 'The family will be told. It stays on record and can be reopened later.',
            submitLabel: 'Reject application',
            fields: [
                { name: 'reason', label: 'Why', type: 'textarea', rows: 3, required: true,
                  help: 'Kept on the application — the family will ask.' }
            ],
            values: { reason: '' },
            onSubmit: (v) => reject(app.id, { reason: v.reason })
        });

        // formModal resolves only once onSubmit has succeeded, and shows any
        // error from reject() inside the dialog itself — so there is nothing
        // left to catch here, and no busy flag to manage: the dialog owns that
        // while it is open.
        if (!done) return;

        toast.success('Application rejected', app.name);
        this.detail = null;
        await this.load();
    }

    bind() {
        const root = this.container;

        bindFilterToggle(this, () => this.paint());

        this.onDispose(on(root, 'click', '[data-action="filter"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.filter = this.filter === key ? null : key;
            this.load();
        }));
        this.onDispose(on(root, 'input', '[data-role="search"]', debounce((_e, t) => {
            this.search = t.value;
            this.paint();
        }, 180)));
        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.open(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', () => this.close()));
        this.onDispose(on(root, 'click', '.m-profile', (event) => event.stopPropagation()));
        this.onDispose(on(root, 'click', '[data-action="advance"]', (_e, t) => this.advance(t.dataset.key)));
        this.onDispose(on(root, 'click', '[data-action="reject"]', () => this.doReject()));

        this.onDispose(on(root, 'click', '[data-action="new"]', () => this.newApplication()));

        this.onKey = (event) => { if (event.key === 'Escape' && this.detail) this.close(); };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }

    /* --------------------------------------------------------------- INTAKE */

    /**
     * Taking an application on a phone — the reception desk's actual case.
     *
     * Same single grouped form as natyam-admin, for the same reason: the steps
     * in `ADMISSION_STEPS` are a validation structure, and they stay one. They
     * are the dividers here, and every step is still checked by the service's
     * own `validateStep()` through `validateAll` — so none of the rules (age 4
     * and up, ten-digit contact number, no future date of birth) is restated
     * in this file or in the desktop one.
     */
    async newApplication() {
        session.require(CAPABILITIES.ADMISSION_EDIT, 'take an application');

        const [branches, plans] = await Promise.all([listBranches(), listFeePlans()]);
        const defaultBranchId = session.branch() || (branches.length === 1 ? branches[0].id : '');

        const fields = [
            { type: 'divider', label: 'Applicant' },
            { name: 'name', label: 'Applicant name', required: true },
            { name: 'dateOfBirth', label: 'Date of birth', type: 'date', required: true },
            { name: 'gender', label: 'Gender', type: 'select', required: true, placeholder: 'Choose',
              options: [
                  { value: 'female', label: 'Female' },
                  { value: 'male', label: 'Male' },
                  { value: 'other', label: 'Other' }
              ] },
            { name: 'guardianName', label: 'Parent or guardian', required: true },
            { name: 'guardianRelation', label: 'Relationship', type: 'select', required: true,
              options: ['Mother', 'Father', 'Grandparent', 'Guardian', 'Sibling']
                  .map((r) => ({ value: r, label: r })) },
            { name: 'guardianPhone', label: 'Contact number', type: 'tel', required: true },
            { name: 'guardianEmail', label: 'Email', type: 'email' },
            { name: 'address', label: 'Address', type: 'textarea', rows: 2 },

            { type: 'divider', label: 'Placement' },
            { name: 'branchId', label: 'Branch', type: 'select', required: true,
              placeholder: branches.length > 1 ? 'Choose a branch' : null,
              options: branches.map((b) => ({ value: b.id, label: b.name })) },
            { name: 'level', label: 'Starting level', type: 'select', required: true, placeholder: 'Choose a level',
              options: curriculum().map((l) => ({ value: l.value, label: l.label })) },

            { type: 'divider', label: 'Experience' },
            { name: 'priorExperience', label: 'Previous training', type: 'select',
              options: [
                  { value: 'none', label: 'None — complete beginner' },
                  { value: 'kuchipudi', label: 'Kuchipudi elsewhere' },
                  { value: 'bharatanatyam', label: 'Bharatanatyam' },
                  { value: 'other-classical', label: 'Another classical form' },
                  { value: 'other', label: 'Other dance' }
              ] },
            { name: 'yearsOfPractice', label: 'Years of practice', type: 'number', min: 0, max: 40 },

            { type: 'divider', label: 'Fee plan' },
            { name: 'feePlanId', label: 'Fee plan', type: 'select', required: true, placeholder: 'Choose a plan',
              options: plans.map((p) => ({ value: p.id, label: `${p.name} — ${formatMoney(p.amount)}` })) },
            { name: 'feeNotes', label: 'Concession or note', type: 'textarea', rows: 2 }
        ];

        const created = await formModal({
            title: 'New application',
            description: 'Taken at the desk. It enters the pipeline as submitted.',
            submitLabel: 'Submit',
            fields,
            values: {
                ...Object.fromEntries(fields.filter((f) => f.type !== 'divider').map((f) => [f.name, ''])),
                branchId: defaultBranchId,
                guardianRelation: 'Mother',
                priorExperience: 'none'
            },
            validateAll: (values) => {
                const all = {};
                for (const step of ADMISSION_STEPS) {
                    Object.assign(all, validateStep(step.key, values).errors);
                }
                return all;
            },
            onSubmit: (values) => submitApplication(values)
        });

        if (!created) return;
        toast.success('Application taken', `${created.name} — ${created.applicationNo}`);
        await this.load();
        this.open(created.id);
    }
}

/* ------------------------------------------------------------------ HELPERS */

function stat(label, value, tone) {
    return html`
        <div class="m-card m-kpi" data-tone="${tone}">
            <span class="m-kpi-bar"></span>
            <span class="m-kpi-body">
                <span class="m-kpi-label">${label}</span>
                <span class="m-kpi-value" style="display:block;">${value}</span>
            </span>
        </div>
    `;
}

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
