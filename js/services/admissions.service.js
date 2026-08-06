/**
 * NATYAM ERP 2.0 — Admissions service
 *
 * The admissions pipeline and, at the end of it, the single most consequential
 * operation in the product: turning an approved application into a student.
 *
 * 1.0's version of that conversion is the bug this whole rebuild was shaped
 * around. It copied the application's fields onto a new student record but
 * never set `batchId`, because the application form had no batch field. The
 * student was created successfully, the toast said so, and they then appeared
 * on no roll call, in no batch roster and in no attendance report — visible
 * only in the students table, apparently enrolled, silently untaught. Here,
 * conversion refuses to proceed without a batch, and the wizard collects one.
 */

import { bus, EVENTS } from '../core/bus.js';
import { session } from '../core/session.js';
import { sequenceNumber } from '../utils/id.js';
import { localDate, academicYearOf, ageFrom } from '../utils/date.js';
import { ADMISSION_STATUS, STUDENT_STATUS, LEVELS, levelLabel, levelsLabel, levelsOf } from '../config/app.config.js';
import {
    admissions$, drafts$, students$, batches$, feePlans$, branches$, settings$
} from '../data/repositories.js';
import { recordAuditEntry } from '../data/auditLog.repository.firestore.js';
import { raiseSchedule } from './fees.service.js';
import { notify } from './notifications.service.js';

/* ==========================================================================
   THE WIZARD'S STEPS
   Declared here, not in the page, because the service validates step by step
   and the page renders step by step — both need the same definition or the
   progress bar will disagree with what is actually required.
   ========================================================================== */

export const ADMISSION_STEPS = Object.freeze([
    // Milestone: Applicant+Parent merged into one step, and Placement+Batch
    // merged into one step; Medical and Documents removed outright — NATYAM
    // does not collect either, with no replacement planned.
    { key: 'applicant',  label: 'Applicant',   required: ['name', 'dateOfBirth', 'gender', 'guardianName', 'guardianRelation', 'guardianPhone'] },
    { key: 'placement',  label: 'Placement',   required: ['branchId', 'level'] },
    { key: 'experience', label: 'Experience',  required: [] },
    { key: 'fees',       label: 'Fee plan',    required: ['feePlanId'] },
    { key: 'review',     label: 'Confirm',     required: [] }
]);

const FIELD_LABELS = {
    name: 'the applicant’s name',
    dateOfBirth: 'date of birth',
    gender: 'gender',
    guardianName: 'the parent or guardian’s name',
    guardianRelation: 'the relationship to the applicant',
    guardianPhone: 'a contact number',
    branchId: 'a branch',
    level: 'a starting level',
    feePlanId: 'a fee plan'
};

/**
 * Validates one step in isolation. Returns problems rather than throwing,
 * because a wizard needs to mark three fields at once, not stop at the first.
 *
 * @returns {{ok: boolean, errors: Object<string,string>}}
 */
export function validateStep(stepKey, data) {
    const step = ADMISSION_STEPS.find((s) => s.key === stepKey);
    if (!step) throw new Error(`Unknown admission step "${stepKey}".`);

    const errors = {};
    for (const field of step.required) {
        const value = data[field];
        if (value === null || value === undefined || String(value).trim() === '') {
            errors[field] = `Please provide ${FIELD_LABELS[field] || field}.`;
        }
    }

    if (stepKey === 'applicant' && data.dateOfBirth) {
        if (data.dateOfBirth > localDate()) {
            errors.dateOfBirth = 'Date of birth cannot be in the future.';
        } else {
            const age = ageFrom(data.dateOfBirth);
            if (age < 4) errors.dateOfBirth = `The applicant would be ${age}. The school takes students from age 4.`;
            if (age > 75) errors.dateOfBirth = 'Please check the date of birth.';
        }
    }

    if (stepKey === 'applicant' && data.guardianPhone) {
        const digits = String(data.guardianPhone).replace(/\D/g, '');
        if (digits.length < 10) errors.guardianPhone = 'A contact number needs at least 10 digits.';
    }
    if (stepKey === 'applicant' && data.guardianEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.guardianEmail)) {
        errors.guardianEmail = 'That email address does not look right.';
    }

    if (stepKey === 'placement' && data.level && !LEVELS.some((l) => l.value === data.level)) {
        errors.level = 'Choose a level from the list.';
    }

    return { ok: Object.keys(errors).length === 0, errors };
}

/** Validates the whole application, returning the first incomplete step. */
export function validateApplication(data) {
    for (const step of ADMISSION_STEPS) {
        const result = validateStep(step.key, data);
        if (!result.ok) return { ok: false, step: step.key, errors: result.errors };
    }
    return { ok: true, step: null, errors: {} };
}

/* ==========================================================================
   DRAFTS
   --------------------------------------------------------------------------
   A nine-step form is long enough that a phone call, a closed tab or a flat
   battery in the middle of it is normal, not exceptional. Drafts are written
   on every step change and debounced during typing by the page.
   ========================================================================== */

export async function saveDraft(draftId, data, { step = 0 } = {}) {
    const fields = {
        data,
        step,
        label: data.name?.trim() || 'Untitled application',
        branchId: data.branchId || null
    };

    if (draftId) {
        const existing = await drafts$.find(draftId);
        if (existing) return drafts$.update(draftId, fields);
    }

    return drafts$.create({ id: draftId || undefined, ...fields });
}

export async function listDrafts() {
    return drafts$.mine();
}

export async function loadDraft(draftId) {
    const draft = await drafts$.find(draftId);
    if (!draft) throw new Error('That draft is no longer available. It may have been submitted or cleared.');
    return draft;
}

export async function discardDraft(draftId) {
    await drafts$.remove(draftId);
    return true;
}

/* ==========================================================================
   THE PIPELINE
   ========================================================================== */

/**
 * Submits an application. If it came from a draft, the draft is removed in the
 * same unit of work — an application that exists twice, once as a draft and
 * once as a submission, is a duplicate waiting to be enrolled twice.
 */
export async function submit(data, { draftId = null } = {}) {
    session.require('admission.edit', 'submit an application');

    const check = validateApplication(data);
    if (!check.ok) {
        const first = Object.values(check.errors)[0];
        throw new Error(`The application is not complete: ${first}`);
    }

    const duplicate = await admissions$.findLikeness(data);
    if (duplicate) {
        throw new Error(
            `An application for ${duplicate.name} on this number is already ${statusLabel(duplicate.status)} ` +
            `(${duplicate.applicationNo}). Open that one instead of creating a second.`
        );
    }

    const year = academicYearOf().start;
    const seq = await settings$.nextSequence('application');

    const admission = await admissions$.create({
        ...data,
        applicationNo: sequenceNumber('NAT/APP', year, seq),
        status: ADMISSION_STATUS.SUBMITTED,
        appliedOn: data.appliedOn || localDate(),
        submittedBy: session.actorId()
    });

    if (draftId) await discardDraft(draftId);

    await notify({
        kind: 'admission',
        title: `New application — ${admission.name}`,
        body: `${levelLabel(admission.level)} at ${await branchName(admission.branchId)}.`,
        link: `#/admissions/${admission.id}`
    });

    bus.emit(EVENTS.ADMISSION_SUBMITTED, { admission });
    return admission;
}

export async function updateApplication(id, changes) {
    session.require('admission.edit', 'edit an application');

    const existing = await admissions$.findOrFail(id);
    if (existing.status === ADMISSION_STATUS.ENROLLED) {
        throw new Error('This application has already been enrolled. Edit the student record instead.');
    }
    return admissions$.update(id, changes);
}

/**
 * Moves an application into review. Records who picked it up.
 *
 * ALSO THE SINGLE PLACE A PARENT-SUBMITTED APPLICATION IS NORMALISED into
 * something the rest of the pipeline can work with. A self-service
 * application (Parent Portal Stage 3) arrives deliberately incomplete in two
 * ways, and both are closed here — at the first moment a member of staff
 * touches it, which is the earliest point either can be decided:
 *
 *  - `applicationNo` is null. The official NAT/APP number comes from the
 *    staff-gated /settings sequence, which a parent cannot and must not
 *    allocate. It is issued here so there is exactly ONE numbering mechanism
 *    in the product, and no way to claim a number from outside.
 *
 *  - `branchId` is null, with only a `preferredBranch` NAME the parent chose
 *    from the published Website Content branches. Reception maps that to a
 *    real Branch record.
 *
 * NEITHER IS ALLOWED TO BLOCK THE REVIEW. The branch is optional: if the
 * caller supplies none, or the parent's preference matches no ERP branch, the
 * application still moves to `reviewing` and the branch is settled later —
 * enrolApplicant() already requires a real batch (and takes its branch from
 * that batch), so nothing downstream can quietly proceed without one. A
 * review that refused to start because a family typed a branch name the
 * school no longer uses would be a worse failure than an unassigned row.
 *
 * Idempotent on numbering: an application that already has a number keeps it,
 * so a walk-in taken at the desk is untouched by any of this.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.branchId]  The ERP branch Reception mapped the
 *   parent's `preferredBranch` to. Optional by design.
 */
export async function beginReview(id, { branchId = null } = {}) {
    session.require('admission.edit', 'review an application');

    const admission = await admissions$.findOrFail(id);
    if (admission.status !== ADMISSION_STATUS.SUBMITTED) {
        throw new Error(`This application is ${statusLabel(admission.status)}, not awaiting review.`);
    }

    const changes = {
        status: ADMISSION_STATUS.REVIEWING,
        reviewStartedOn: localDate(),
        reviewedBy: session.actorId()
    };

    // Only when missing. Allocating a second number for an application that
    // already has one would burn a sequence value and change a reference a
    // family may already have been given.
    if (!admission.applicationNo) {
        const year = academicYearOf().start;
        const seq = await settings$.nextSequence('application');
        changes.applicationNo = sequenceNumber('NAT/APP', year, seq);
    }

    // Only fills a gap; never overwrites a branch already on the record.
    if (branchId && !admission.branchId) changes.branchId = branchId;

    return admissions$.update(id, changes);
}

/**
 * Suggests the ERP branch a parent's free-chosen `preferredBranch` name most
 * likely means, so Reception confirms a pre-filled answer rather than reading
 * the name and hunting for it in a list.
 *
 * A SUGGESTION, NOT A RESOLUTION. It never assigns anything by itself — the
 * name came from hand-maintained Website Content that is deliberately
 * decoupled from Branch Management, so the two lists can legitimately differ
 * and a confident automatic match would eventually be confidently wrong.
 * Returns null when nothing matches, which is a normal outcome and must not
 * block the review.
 *
 * @param {string} preferredBranch  The published branch name the parent chose.
 * @returns {Promise<object|null>} the matching active branch, or null.
 */
export async function suggestBranchFor(preferredBranch) {
    const wanted = String(preferredBranch || '').trim().toLowerCase();
    if (!wanted) return null;

    const branches = await branches$.active().catch(() => []);

    // Exact name first, then a containment match in either direction — the
    // public list says "Natyam — Kondapur" where the ERP record may simply be
    // "Kondapur", and vice versa.
    return branches.find((b) => String(b.name || '').trim().toLowerCase() === wanted)
        || branches.find((b) => {
            const name = String(b.name || '').trim().toLowerCase();
            return name && (name.includes(wanted) || wanted.includes(name));
        })
        || null;
}

/**
 * Approves an application. Approval is a decision, not an enrolment — the
 * student record is created separately, because approving on the phone and
 * enrolling when the family pays are two different moments.
 */
export async function approve(id, { note = null } = {}) {
    session.require('admission.approve', 'approve an application');

    const admission = await admissions$.findOrFail(id);
    if (admission.status === ADMISSION_STATUS.ENROLLED) throw new Error('This applicant is already enrolled.');
    if (admission.status === ADMISSION_STATUS.REJECTED) throw new Error('This application was rejected. Reopen it first.');
    if (admission.status === ADMISSION_STATUS.APPROVED) return admission;

    const updated = await admissions$.update(id, {
        status: ADMISSION_STATUS.APPROVED,
        approvedOn: localDate(),
        approvedBy: session.actorId(),
        approvalNote: note?.trim() || null
    });

    bus.emit(EVENTS.ADMISSION_APPROVED, { admission: updated });
    return updated;
}

export async function reject(id, { reason }) {
    session.require('admission.approve', 'reject an application');

    if (!reason?.trim()) throw new Error('Record why the application was declined — the family will ask.');
    const admission = await admissions$.findOrFail(id);
    if (admission.status === ADMISSION_STATUS.ENROLLED) throw new Error('This applicant is already enrolled and cannot be rejected.');

    return admissions$.update(id, {
        status: ADMISSION_STATUS.REJECTED,
        rejectedOn: localDate(),
        rejectedBy: session.actorId(),
        rejectionReason: reason.trim()
    });
}

/** Puts a rejected application back in the queue. */
export async function reopen(id) {
    session.require('admission.approve', 'reopen an application');

    const admission = await admissions$.findOrFail(id);
    if (admission.status !== ADMISSION_STATUS.REJECTED) throw new Error('Only a rejected application can be reopened.');
    return admissions$.update(id, {
        status: ADMISSION_STATUS.SUBMITTED,
        rejectedOn: null, rejectedBy: null, rejectionReason: null,
        reopenedOn: localDate()
    });
}

/* ==========================================================================
   CONVERSION — application to student
   ========================================================================== */

/**
 * Creates the student record for an approved application.
 *
 * Everything about this function is arranged around not repeating 1.0's
 * failure. In particular:
 *
 *  - a batch is mandatory, and it is checked for capacity and level before
 *    anything is written;
 *  - the application row and the student row are written in the *same*
 *    transaction, so an application can never be marked enrolled without a
 *    student existing, nor a student created twice by a double-click;
 *  - the fee schedule is raised afterwards, deliberately outside that
 *    transaction, because billing failing is recoverable and must not roll
 *    back an enrolment the family has already been told about.
 *
 * @param {string} admissionId
 * @param {object} options
 * @param {string} options.batchId          Required.
 * @param {string} [options.feePlanId]      Defaults to the application's plan.
 * @param {string} [options.joinedOn]       Defaults to today.
 * @param {boolean} [options.raiseFees=true]
 */
export async function enrolApplicant(admissionId, {
    batchId, feePlanId = null, branchId = null, joinedOn = null, raiseFees = true
} = {}) {
    session.require('admission.approve', 'enrol an applicant');

    const admission = await admissions$.findOrFail(admissionId);

    if (admission.status === ADMISSION_STATUS.ENROLLED) {
        throw new Error(`${admission.name} has already been enrolled.`);
    }
    /*
     * Enrolling straight from `submitted` is the normal path now.
     *
     * Begin review and Approve were two separate confirmations before this one,
     * and the school does not work that way: the person reading the application
     * is the person deciding, in one sitting. Both stages are gone from the UI,
     * so requiring `approved` here would have made every application
     * un-enrollable. REVIEWING and APPROVED stay accepted rather than being
     * dropped, because records already sitting in those states from the old
     * flow must still be completable — this loosens the gate, it does not move
     * it. DRAFT is still refused (nobody has submitted it yet) and so is
     * REJECTED, which has to be reopened first.
     */
    const enrollable = [
        ADMISSION_STATUS.SUBMITTED,
        ADMISSION_STATUS.REVIEWING,
        ADMISSION_STATUS.APPROVED
    ];
    if (!enrollable.includes(admission.status)) {
        throw new Error(`This application is ${statusLabel(admission.status)} and cannot be enrolled.`);
    }
    // Every enrolled student belongs to a batch. The picker offers every active
    // batch at the branch — ranked so the applicant's own level comes first —
    // so this can always be satisfied as long as one batch is running.
    if (!batchId) {
        throw new Error('Choose the batch this student will attend. A student without a batch appears on no roll call.');
    }

    const batch = await batches$.findOrFail(batchId);
    if (batch.status !== 'active') throw new Error(`${batch.name} is closed and cannot take students.`);

    const roster = await students$.byBatch(batchId);
    if (batch.capacity && roster.length >= batch.capacity) {
        throw new Error(`${batch.name} is full — ${roster.length} of ${batch.capacity} seats taken. Choose another batch or raise its capacity.`);
    }

    const planId = feePlanId || admission.feePlanId;
    const plan = planId ? await feePlans$.find(planId) : null;
    if (planId && !plan) throw new Error('The chosen fee plan no longer exists. Pick another.');

    /*
     * The branch, and the NAT/APP number, both used to be beginReview()'s job.
     * With that stage gone this is the first and only moment a member of staff
     * touches a self-submitted application, so the two things it closed have to
     * close here or not at all.
     *
     * A parent supplies `preferredBranch` as a NAME and never a branchId —
     * /branches is staff-gated and the public Branches page carries no ids by
     * design — so the caller passes the real one and it fills the gap. Never
     * overwrites: an application that already has a branch keeps it.
     */
    const resolvedBranchId = admission.branchId || branchId || null;
    if (!resolvedBranchId) {
        throw new Error('Choose the branch being applied to before enrolling.');
    }

    const year = academicYearOf().start;
    const seq = await settings$.nextSequence('admission');
    const actor = session.actorId();

    /*
     * NAT/APP, only when missing. A staff-taken application is numbered at
     * creation; a self-submitted one arrives with `applicationNo: null`,
     * because the sequence lives behind staff-gated /settings and a parent
     * cannot allocate from it. beginReview() issued it — so without this, every
     * family application would reach enrolment unnumbered and stay that way,
     * and the product would have lost one of its two numbering guarantees.
     * Allocating only when absent means no application ever burns a second
     * sequence value or changes a reference a family has already been given.
     */
    const applicationNo = admission.applicationNo
        || sequenceNumber('NAT/APP', year, await settings$.nextSequence('application'));

    // Persisted through the Students repository (students$.create()) rather
    // than a hand-rolled write, so this goes wherever `students$` actually
    // points — IndexedDB before Milestone 3, Firestore since. This does mean
    // the student record and the application's ENROLLED status can no longer
    // land in one atomic transaction (they are two different databases now)
    // — the student is created first, deliberately, so a failure in the step
    // below leaves an enrolled student with a stale application rather than
    // an "enrolled" application pointing at a student that doesn't exist.
    const student = await students$.create({
        admissionNo: sequenceNumber('NAT/ADM', year, seq),
        name: admission.name,
        level: admission.level,
        // Branch follows the batch, not the application: if the family was
        // offered a place at the other campus, the batch is the truth.
        branchId: batch.branchId,
        batchId: batch.id,
        feePlanId: planId || null,
        status: STUDENT_STATUS.ACTIVE,
        gender: admission.gender || null,
        dateOfBirth: admission.dateOfBirth || null,
        joinedOn: joinedOn || localDate(),
        guardianName: admission.guardianName || null,
        guardianRelation: admission.guardianRelation || 'Guardian',
        guardianPhone: admission.guardianPhone || null,
        guardianEmail: admission.guardianEmail || null,
        alternatePhone: admission.alternatePhone || null,
        address: admission.address || null,
        bloodGroup: admission.bloodGroup || null,
        medicalNotes: admission.medicalNotes || null,
        emergencyContact: admission.emergencyContact || admission.guardianPhone || null,
        previousExperience: admission.previousExperience || null,
        photo: admission.photo || null,
        admissionId: admission.id
    });

    // Persisted through the Admissions repository (admissions$.update())
    // rather than a hand-rolled write, for the same reason as the student
    // write above — this goes wherever `admissions$` actually points,
    // IndexedDB before Milestone 5, Firestore since. The admission update
    // and the audit row below are two sequential Firestore writes, not one
    // atomic transaction — the admission is closed first, so a failure
    // writing the audit row leaves an enrolled application without an
    // audit entry rather than an application stuck mid-enrolment.
    const closedApplication = await admissions$.update(admission.id, {
        status: ADMISSION_STATUS.ENROLLED,
        enrolledOn: localDate(),
        enrolledBy: actor,
        studentId: student.id,
        // Both written back so the closed application is a complete record of
        // what was decided — and because admissions$.update() validates
        // branchId, which a self-submitted application does not yet carry.
        branchId: resolvedBranchId,
        applicationNo
    });

    await recordAuditEntry('Admission', 'enrol', admission.id,
        { studentId: student.id, admissionNo: student.admissionNo, batchId: batch.id });

    bus.emit(EVENTS.ADMISSION_ENROLLED, { admission: closedApplication, student });
    bus.emit(EVENTS.STUDENT_CREATED, { student });

    /* Billing, outside the transaction and reported separately. If the fee
       plan is misconfigured the registrar needs to know — but the child is
       enrolled either way, and rolling that back would be worse. */
    let billing = null;
    let billingError = null;
    if (raiseFees && planId) {
        try {
            billing = await raiseSchedule(student.id, { feePlanId: planId, startDate: student.joinedOn });
        } catch (err) {
            billingError = err.message;
        }
    }

    await notify({
        kind: 'admission',
        title: `${student.name} enrolled`,
        body: `${batch.name} · ${student.admissionNo}`,
        link: `#/students/${student.id}`
    });

    return { student, admission: closedApplication, billing, billingError };
}

/**
 * Batches a student could join, annotated with why they can or cannot — so the
 * wizard shows "Full (18/18)" next to a disabled option rather than hiding it
 * and leaving the registrar wondering where the batch went.
 */
export async function eligibleBatches(admissionOrLevel, branchId = null) {
    const level = typeof admissionOrLevel === 'string' ? admissionOrLevel : admissionOrLevel?.level;
    const branch = branchId || (typeof admissionOrLevel === 'object' ? admissionOrLevel?.branchId : null);

    // Every active batch at the branch is offered, not only those teaching the
    // applicant's exact level. Restricting to an exact match left the picker
    // empty whenever no class happened to run at that rung, and a mandatory
    // field with nothing in it cannot be answered. Matching batches sort first
    // and the rest carry a note, so the right choice is still the obvious one.
    const batches = await batches$.withOccupancy(branch);
    return batches
        .map((b) => {
            const full = Boolean(b.capacity) && b.enrolled >= b.capacity;
            const closed = b.status !== 'active';
            // Milestone B1: a batch teaches a *set* of levels now — this was
            // already just a sort/label hint (every active batch with room
            // was already offered regardless), so it only gets more accurate.
            const sameLevel = levelsOf(b).includes(level);
            return {
                ...b,
                sameLevel,
                selectable: !closed && !full,
                reason: closed ? 'Closed'
                    : full ? `Full (${b.enrolled}/${b.capacity})`
                    : sameLevel ? `${b.seatsLeft} seat${b.seatsLeft === 1 ? '' : 's'} left`
                    : `${levelsLabel(levelsOf(b))} · ${b.seatsLeft} seat${b.seatsLeft === 1 ? '' : 's'} left`
            };
        })
        .sort((a, b) => Number(b.selectable) - Number(a.selectable)
            || Number(b.sameLevel) - Number(a.sameLevel)
            || a.name.localeCompare(b.name));
}

/* ==========================================================================
   PIPELINE ANALYTICS
   ========================================================================== */

/** Counts by stage, plus conversion rate — the admissions page header. */
/**
 * Is this application in scope for the branch currently being viewed?
 *
 * THE UNASSIGNED CASE IS THE POINT. A parent applying from natyam-mobile
 * cannot supply a branchId — /branches is staff-gated and the public Branches
 * page is hand-written Website Content carrying no ids — so a self-submitted
 * application arrives with `branchId: null` and only a `preferredBranch`
 * name. A plain equality filter would therefore hide every parent application
 * the moment anyone selected a branch, which for an Owner who works with one
 * branch selected means never seeing them at all.
 *
 * So an unassigned application is visible at EVERY branch until Reception
 * assigns one. That is deliberately the safe direction to fail: an
 * application shown to the wrong branch is noticed and reassigned; one shown
 * to nobody is a family waiting for a call that never comes.
 */
function atBranch(application, branchId) {
    if (!branchId) return true;
    if (!application.branchId) return true;
    return application.branchId === branchId;
}

export async function pipeline(branchId = null) {
    const all = (await admissions$.all()).filter((a) => atBranch(a, branchId));
    const count = (status) => all.filter((a) => a.status === status).length;

    const decided = count(ADMISSION_STATUS.ENROLLED) + count(ADMISSION_STATUS.REJECTED);
    const thisMonth = localDate().slice(0, 7);

    return {
        total: all.length,
        submitted: count(ADMISSION_STATUS.SUBMITTED),
        reviewing: count(ADMISSION_STATUS.REVIEWING),
        approved: count(ADMISSION_STATUS.APPROVED),
        enrolled: count(ADMISSION_STATUS.ENROLLED),
        rejected: count(ADMISSION_STATUS.REJECTED),
        awaitingAction: count(ADMISSION_STATUS.SUBMITTED) + count(ADMISSION_STATUS.REVIEWING) + count(ADMISSION_STATUS.APPROVED),
        // Parent Portal Stage 4. Applications that came in through
        // natyam-mobile rather than being taken at the desk. Surfaced as its
        // own count because nobody is standing in front of Reception for
        // these — a walk-in announces itself, a self-service application only
        // exists in this queue.
        fromParents: all.filter((a) => a.source === 'parent_portal').length,
        unassignedBranch: all.filter((a) => !a.branchId).length,
        thisMonth: all.filter((a) => (a.appliedOn || '').startsWith(thisMonth)).length,
        conversionRate: decided ? Math.round((count(ADMISSION_STATUS.ENROLLED) / decided) * 100) : null,
        byLevel: LEVELS.map((l) => ({
            level: l.value, label: l.label,
            count: all.filter((a) => a.level === l.value).length
        })).filter((row) => row.count > 0)
    };
}

/**
 * Applications that have been sitting too long. An approved application nobody
 * enrolled is a family who thinks they have a place and does not.
 */
export async function stalled({ days = 7 } = {}) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return (await admissions$.pending())
        .concat(await admissions$.byStatus(ADMISSION_STATUS.APPROVED))
        .filter((a) => (a.appliedOn || '') < cutoff)
        .sort((a, b) => (a.appliedOn || '').localeCompare(b.appliedOn || ''));
}

/* ------------------------------------------------------------------ HELPERS */

function statusLabel(status) {
    return {
        [ADMISSION_STATUS.DRAFT]: 'a draft',
        [ADMISSION_STATUS.SUBMITTED]: 'awaiting review',
        [ADMISSION_STATUS.REVIEWING]: 'under review',
        [ADMISSION_STATUS.APPROVED]: 'approved',
        [ADMISSION_STATUS.ENROLLED]: 'enrolled',
        [ADMISSION_STATUS.REJECTED]: 'rejected'
    }[status] || status;
}


async function branchName(branchId) {
    const branch = branchId ? await branches$.find(branchId) : null;
    return branch?.name || 'the school';
}

/* ==========================================================================
   LISTING
   ========================================================================== */

/**
 * Applications shaped for the list page: status, age, and whether the next
 * action is available. "Waiting days" is computed here rather than in the page
 * so the dashboard's stalled count and the list's amber row always agree.
 */
export async function listApplications(branchId = null, { status = null } = {}) {
    const all = (await admissions$.all()).filter((a) => atBranch(a, branchId));
    const rows = status && status !== 'all' ? all.filter((a) => a.status === status) : all;

    return rows
        .map((application) => ({
            ...application,
            levelLabel: levelLabel(application.level),
            waitingDays: application.appliedOn
                ? Math.max(0, Math.round((Date.now() - new Date(`${application.appliedOn}T00:00:00`).getTime()) / 86400000))
                : null,
            stalled: application.appliedOn
                && [ADMISSION_STATUS.SUBMITTED, ADMISSION_STATUS.REVIEWING, ADMISSION_STATUS.APPROVED].includes(application.status)
                && (Date.now() - new Date(`${application.appliedOn}T00:00:00`).getTime()) / 86400000 > 7,
            statusLabel: statusLabel(application.status),
            nextAction: nextActionFor(application.status)
        }))
        .sort((a, b) => (b.appliedOn || '').localeCompare(a.appliedOn || ''));
}

/** One application with everything the detail drawer shows. */
export async function applicationDetail(id) {
    const application = await admissions$.findOrFail(id);
    const [batches, likeness, suggestedBranch] = await Promise.all([
        eligibleBatches(application),
        admissions$.findAllLikeness ? admissions$.findAllLikeness(application) : Promise.resolve([]),
        // Only worth asking when the application has no branch yet and the
        // parent expressed a preference — which is exactly the self-submitted
        // case. A walk-in already carries a real branchId.
        !application.branchId && application.preferredBranch
            ? suggestBranchFor(application.preferredBranch)
            : Promise.resolve(null)
    ]);

    return {
        application,
        levelLabel: levelLabel(application.level),
        statusLabel: statusLabel(application.status),
        nextAction: nextActionFor(application.status),
        eligibleBatches: batches,
        possibleDuplicates: likeness || [],

        // Parent Portal Stage 4 — everything the review screen needs to
        // handle a self-service application without special-casing it.
        fromParent: application.source === 'parent_portal',
        preferredBranch: application.preferredBranch || null,
        suggestedBranch,
        needsBranch: !application.branchId
    };
}

/** What a person can do next with an application in this state. */
/*
 * One step from submitted to enrolled.
 *
 * This was submitted -> Begin review -> Approve -> Enrol: three taps and two
 * intermediate states before a child was on a register. The school does not
 * work that way — the person reading the application is the person deciding,
 * in one sitting — so Begin review and Approve are gone and `submitted` offers
 * Enrol directly.
 *
 * REVIEWING and APPROVED still map to Enrol rather than being removed.
 * Applications parked in those states under the old flow have to remain
 * completable; dropping them would have left real records with no action at
 * all and no way to reach one.
 *
 * beginReview() and approve() are deliberately still exported. Nothing in
 * either app calls them now, but they are the audited, sequence-allocating
 * paths those states were reached by, and deleting them would strand any
 * record still in them.
 */
export function nextActionFor(status) {
    return {
        [ADMISSION_STATUS.DRAFT]: { key: 'submit', label: 'Submit application' },
        [ADMISSION_STATUS.SUBMITTED]: { key: 'enrol', label: 'Enrol' },
        [ADMISSION_STATUS.REVIEWING]: { key: 'enrol', label: 'Enrol' },
        [ADMISSION_STATUS.APPROVED]: { key: 'enrol', label: 'Enrol' },
        [ADMISSION_STATUS.ENROLLED]: null,
        [ADMISSION_STATUS.REJECTED]: { key: 'reopen', label: 'Reopen' }
    }[status] || null;
}
