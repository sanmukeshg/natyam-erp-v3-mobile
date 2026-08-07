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
/* beginReview and approve are deliberately NOT imported here any more: Begin
   review and Approve are gone from the flow (see nextActionFor) and nothing on
   this screen calls them. Both remain exported by the service, for records
   still parked in those states from before the change. */
import {
    pipeline, listApplications, applicationDetail,
    reject, reopen, enrolApplicant,
    submit as submitApplication, validateStep, ADMISSION_STEPS
} from '../../services/admissions.service.js';
import { listBranches, listFeePlans } from '../../services/settings.service.js';
import { listBatches } from '../../services/batches.service.js';
import { studentFormFields, seedStudentValues, applicantSeed } from '../../config/studentFields.js';
import { formModal, confirmModal } from '../../ui/form.js';
import { filterBar, renderFilterPanel, bindFilterToggle } from '../../ui/filterBar.js';
import { showLoadError } from '../../ui/loadState.js';

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
            showLoadError(this.container, { what: 'Applications', error: err, onRetry: () => this.load() });
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
            // Fee plans and branches come along with the detail because the
            // enrol step needs them and cannot ask for them mid-render. Fetched
            // in parallel, and failing softly: a list that could not load must
            // not stop someone opening an application to read it.
            //
            // Branches joined this call for UAT5-BUG-506. The branch used to be
            // asked for in a pop-up AFTER Enrol was tapped, which is what made
            // that pop-up look like a second, contradictory branch step; it is
            // now a field in the sheet alongside batch and fee plan, so the
            // list has to be here by the time the sheet paints.
            const [detail, plans, branches] = await Promise.all([
                applicationDetail(id),
                listFeePlans().catch(() => []),
                listBranches().catch(() => [])
            ]);
            if (this.disposed) return;
            this.detail = detail;
            this.feePlans = plans;
            this.branches = branches;
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

    /**
     * The application, read-only.
     *
     * The three enrolment selects that used to live at the foot of this sheet
     * (branch, batch, fee plan) are gone — UAT6 BUG-601. They were the only
     * things asked before a student was created, so everything else about that
     * student was copied off the application, and a family-submitted one
     * carries no address, no emergency contact and no medical note. The
     * enrolment finished and the Owner then had to open Edit student to
     * complete a record they had just made.
     *
     * Enrol now opens the full student form instead, seeded from this
     * application. What survives here is the pre-flight: the two conditions
     * that would make that form unanswerable, said before it opens rather than
     * discovered inside it.
     */
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

        /*
         * A centred dialog, not a bottom sheet — UAT4-BUG-003.
         *
         * This was .m-sheet-scrim + .m-profile: a sheet anchored to bottom:0,
         * its action row sitting exactly where the tab bar sits. Raising the
         * sheet above the bar by z-index was the obvious fix and it did not
         * hold on iPhone, so this removes the collision instead of re-arguing
         * the stacking order — the box is inset from every edge by the scrim's
         * own padding (which already includes the safe-area inset), so nothing
         * of it can reach the tab bar's strip at all.
         *
         * The classes are formModal's, reused verbatim rather than copied into
         * a new variant: this is the same shape as the Add student dialog, so
         * it should be the same markup, and any future change to that dialog's
         * geometry lands here for free. No new CSS was written for this.
         */
        render(host, html`
            <div class="m-modal-scrim" data-action="close-detail">
                <div class="m-modal" role="dialog" aria-modal="true" aria-label="${app.name}">
                    <div class="m-modal-head">
                        <div style="min-width:0;">
                            <h2 class="m-modal-title">${app.name}</h2>
                            <p class="m-modal-sub">
                                ${app.applicationNo || '—'} · ${level || '—'}
                            </p>
                        </div>
                        <button class="m-modal-close" data-action="close-detail" aria-label="Close">
                            ${raw(icon('x', { size: 16 }))}
                        </button>
                    </div>

                <div class="m-modal-body">
                    <div><span class="m-badge" data-admission="${app.status}">${statusLabel}</span></div>

                    ${app.source === 'parent_portal' ? html`
                        <div class="m-notice" data-tone="info">
                            Submitted by the family through the Natyam app.${
                                app.applicationNo ? '' : ' A NAT/APP number is issued when review begins.'
                            }${
                                // Names the preference so whoever opens this knows the
                                // application is still unassigned and what the family
                                // asked for. It used to send them to the Desktop ERP to
                                // fix it; the branch is now asked for here
                                // (UAT4-BUG-001), so it says where that happens instead
                                // of pointing at another machine — and since UAT5-BUG-506
                                // that place is the Branch field below, not a pop-up.
                                app.preferredBranch && !app.branchId
                                    ? ` The family asked for ${app.preferredBranch} — confirm the branch below before enrolling.`
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
                        <!--
                          UAT6 BUG-601 — branch, batch and fee plan are no longer
                          asked HERE, because they were never enough on their own.

                          They were the only three questions between an
                          application and a student record, so everything else
                          about that student came off the application — and a
                          family-submitted one carries no address, no emergency
                          contact and no medical note. Enrol now opens the full
                          student form, seeded from this application, with these
                          three among its fields; the read-only summary that
                          follows (UAT5-BUG-506) still restates all three before
                          anything is written.
                        -->
                        <div class="m-notice" data-tone="info">
                            Enrol asks for the whole student record — branch, batch, fee plan,
                            guardian and contact details — in one step, filled in from this
                            application. Nothing is written until you confirm.
                            ${app.branchId || !app.preferredBranch ? '' : html`
                                The form starts on the closest match to ${app.preferredBranch};
                                check it before enrolling.
                            `}
                        </div>
                        ${eligibleBatches?.length ? '' : html`
                            <div class="m-notice" data-tone="caution">
                                No batch is open yet. Create or reopen one before enrolling.
                            </div>
                        `}
                        ${this.feePlans?.length ? '' : html`
                            <div class="m-notice" data-tone="caution">
                                No fee plans are set up yet — add one in Settings before enrolling.
                            </div>
                        `}
                    ` : ''}
                </div>

                    <div class="m-modal-foot">
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
            </div>
        `);
    }

    /** Mirrors the service's own session.require() calls. */
    canDo(key, canEdit, canApprove) {
        if (key === 'review' || key === 'submit') return canEdit;
        return canApprove;
    }

    /* -------------------------------------------------------------- ACTIONS */

    /**
     * Which branch the Branch field should start on — UAT4-BUG-001.
     *
     * A parent applying through the public site never supplies a branch id:
     * /branches is staff-gated, and the public Branches page is hand-written
     * Website Content carrying names only, so they name the branch they want as
     * free text (`preferredBranch`). createSelfSubmitted() therefore skips the
     * branchId check that update() enforces, and the gap has to be filled before
     * the applicant can be enrolled.
     *
     * The service's own suggestBranchFor() runs first — it already arrives with
     * the detail, and it matches by containment, which is what catches an ERP
     * record simply called "Kondapur". Its comparison is otherwise literal, so
     * a second, dash-normalised pass follows: the CMS carries "Natyam -
     * Kondapur" (hyphen) where the Branch record is "Natyam – Kondapur" (en
     * dash), and neither string contains the other. A single branch is the
     * answer by elimination.
     *
     * A DEFAULT, NOT A DECISION. The field stays editable and the confirmation
     * dialog restates it, so a wrong guess costs one tap to correct.
     */
    suggestedBranchId(app) {
        if (this.detail?.suggestedBranch?.id) return this.detail.suggestedBranch.id;

        const branches = this.branches || [];
        if (branches.length === 1) return branches[0].id;

        const flatten = (s) => String(s || '').toLowerCase().replace(/[‐-―-]/g, '-').replace(/\s+/g, ' ').trim();
        const asked = flatten(app.preferredBranch);
        const matched = asked ? branches.find((b) => flatten(b.name) === asked)?.id : null;

        return matched || session.branch() || '';
    }

    /**
     * The confirmation before an applicant becomes a student — UAT5-BUG-506.
     *
     * READ-ONLY BY DESIGN. This dialog exists to be checked, not filled in:
     * every value on it was chosen on the form behind it, and repeating any of
     * them as a live control is what made the old version read as a second,
     * disagreeing branch step. So the three choices are restated as facts, and
     * the negative button says what it does — Edit returns to the form with
     * every answer intact, because nothing has been written yet.
     *
     * Batch and fee plan join the branch even though only the branch was
     * reported: "Edit" promises the Owner can change any of the three, and a
     * dialog that shows one of them cannot honour that promise.
     *
     * The three lists are passed in rather than read off `this` — UAT6
     * BUG-601. The batch now comes from the whole school's list, narrowed by
     * the branch chosen on the form, and `this.detail.eligibleBatches` (which
     * is keyed to the application's own, possibly absent, branch) can no
     * longer name it. Identical to natyam-admin's.
     *
     * @returns {Promise<boolean>} true to go ahead, false to go back and edit.
     */
    confirmEnrolment(app, values, { branches, batches, feePlans }) {
        const branch = branches.find((b) => b.id === (app.branchId || values.branchId));
        const batch = batches.find((b) => b.id === values.batchId);
        const plan = feePlans.find((p) => p.id === values.feePlanId);
        const branchName = branch?.name || '—';

        return confirmModal({
            title: `Enrol ${values.name || app.name}?`,
            // No tone: this is a summary, not a warning, and a caution-coloured
            // panel would read as "something is wrong with these choices".
            tone: null,
            message: html`
                ${app.preferredBranch ? html`
                    <p class="m-profile-note" style="margin:0 0 12px;">
                        The family asked for ${app.preferredBranch}. Check the branch below matches.
                    </p>
                ` : ''}
                <dl class="m-facts">
                    ${fact('Branch', branchName)}
                    ${fact('Batch', batch?.name || '—')}
                    ${fact('Fee plan', plan ? `${plan.name} — ${formatMoney(plan.amount)}` : '—')}
                </dl>
            `,
            cancelLabel: 'Edit',
            confirmLabel: 'Confirm'
        });
    }

    async advance(key) {
        const app = this.detail?.application;
        if (!app || this.busy) return;
        if (key === 'enrol') return this.enrol(app);

        this.busy = true;
        this.paintDetail();
        try {
            // 'review' and 'approve' are no longer reachable — nextActionFor()
            // sends every submitted application straight to Enrol. The service
            // still exports both for records parked in those states under the
            // old flow, but nothing on this screen offers them.
            if (key === 'reopen') await reopen(app.id);
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

    /**
     * Enrolment, in one step — UAT6 BUG-601.
     *
     * The whole student record is collected here, from the same field list the
     * Students screen uses (js/config/studentFields.js), seeded from the
     * application. Everything the family already answered is carried across to
     * be confirmed rather than retyped; everything a student record needs and
     * an application does not carry — emergency contact, address, medical note
     * — is asked for now, while the record can still be created complete
     * instead of finished off in Edit student afterwards.
     *
     * Batches are fetched for EVERY branch, not this application's: a
     * family-submitted one has no branch at all until the form's Branch field
     * answers for it, and the batch list follows that field.
     */
    async enrol(app) {
        // Three round trips before the form can open, so the button that
        // started them is disabled meanwhile — otherwise a second tap during
        // the fetch opens a second enrolment form over the first.
        this.busy = true;
        this.paintDetail();

        let batches, feePlans, branches;
        try {
            [batches, feePlans, branches] = await Promise.all([
                listBatches(null),
                listFeePlans().catch(() => this.feePlans || []),
                listBranches().catch(() => this.branches || [])
            ]);
        } catch (err) {
            this.busy = false;
            if (this.disposed) return;
            toast.error(`Could not open the enrolment form — ${err.message}`);
            this.paintDetail();
            return;
        }
        this.feePlans = feePlans;
        this.branches = branches;
        this.busy = false;
        if (this.disposed) return;
        this.paintDetail();

        const fields = studentFormFields({
            mode: 'enrol',
            existing: applicantSeed(app, { branchId: this.suggestedBranchId(app) }),
            branches,
            batches,
            feePlans,
            defaultBranchId: session.branch() || ''
        });

        const enrolled = await formModal({
            title: `Enrol ${app.name}`,
            description: 'Everything the student record needs, in one step. Nothing is written until you confirm.',
            submitLabel: 'Enrol student',
            fields,
            values: seedStudentValues(fields),
            onSubmit: async (values) => {
                const go = await this.confirmEnrolment(app, values, { branches, batches, feePlans });
                // Thrown rather than returned: the form stays open with every
                // answer intact, which is exactly what "Edit" promised.
                if (!go) throw new Error('Nothing has been written yet — change what you need to, then enrol again.');

                const { batchId, feePlanId, branchId, ...student } = values;
                return enrolApplicant(app.id, {
                    batchId,
                    feePlanId,
                    // enrolApplicant() only ever fills a gap with this and can
                    // never overwrite a branch the application already has.
                    branchId: branchId || null,
                    joinedOn: values.joinedOn || null,
                    student
                });
            }
        });

        if (!enrolled) return;
        toast.success('Enrolled', `${app.name} is now a student.`);
        this.detail = null;
        await this.load();
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
        /*
         * The scrim now WRAPS the dialog rather than sitting beside it
         * (UAT4-BUG-003), so a click anywhere inside the box bubbles up to the
         * scrim's own data-action. `event.target !== target` is the guard
         * formModal already uses for exactly this: close only on a click that
         * landed on the scrim itself, not on something within it. The close
         * button carries the same data-action and is handled below, where its
         * own target check passes.
         */
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', (event, target) => {
            if (target.classList.contains('m-modal-scrim') && event.target !== target) return;
            this.close();
        }));
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
