/**
 * Natyam ERP v3 — Mobile — Parent self-service admissions
 *
 * A prospective parent applying for their own child, from the public app,
 * signed in with Google and holding no staff account.
 *
 * WHY THIS IS A SEPARATE FILE rather than more functions in
 * admissions.service.js: that file is byte-identical in natyam-admin and
 * natyam-mobile, and nothing in it may assume an unprivileged caller. Every
 * function here is mobile-only and would be dead weight in the Desktop ERP.
 * The pipeline logic is NOT duplicated — validateStep() and the step
 * definitions are imported from that file and reused as they are.
 *
 * WHAT A PARENT CANNOT DO, AND WHY EACH IS HANDLED DIFFERENTLY FROM STAFF:
 *
 *   applicationNo   Allocated from /settings sequences, which is staff-gated.
 *                   Left null; the ERP assigns NAT/APP at review.
 *   branchId        /branches is staff-gated and the public Branches page is
 *                   hand-written content with no branch ids. The parent picks
 *                   a branch by NAME from the published Website Content list
 *                   (branchOptions() below); Reception maps that name to the
 *                   real Branch record at review. No ERP id is ever exposed
 *                   during the public process.
 *   feePlanId       A family should not be picking their own fee plan, and
 *                   /feePlans is staff-gated anyway. Omitted from the parent
 *                   step set entirely.
 *   duplicate check admissions$.findLikeness() reads the whole collection,
 *                   which a parent cannot and must not do. Reception sees
 *                   duplicates in the ERP queue, where the existing
 *                   possibleDuplicates surfacing already lives.
 *   notify()        Writes /notifications behind a staff gate. The
 *                   application appears in the Admissions queue regardless;
 *                   Stage 4 adds the "From parents" filter that surfaces it.
 *
 * Everything a parent CAN establish — who the child is, when they were born,
 * who the guardian is, how to reach them, which level and which branch they
 * would like — is collected, validated with the same rules the desktop wizard
 * uses, and handed to Reception.
 */

import { admissions$ } from '../data/repositories.js';
import { validateStep, nextActionFor } from './admissions.service.js';
import { content } from './publicContent.service.js';
import { recordParentEngagement } from './parent.service.js';
import { ADMISSION_STATUS, LEVELS, levelLabel } from '../config/app.config.js';
import { localDate } from '../utils/date.js';

/**
 * The parent-facing form, deliberately shorter than ADMISSION_STEPS.
 *
 * `applicant` reuses that file's own required-field list verbatim via
 * validateStep(), so the age limits, the phone-length rule and the email
 * format check are the ones the school already applies — one definition, two
 * surfaces.
 *
 * `placement` is where the two diverge: the desktop step requires branchId
 * and level; this one requires level alone, because a parent cannot resolve a
 * branch id (see the header). Fee plan is absent entirely.
 */
export const PARENT_STEPS = Object.freeze([
    Object.freeze({ key: 'applicant', label: 'Your child', shared: true }),
    Object.freeze({ key: 'placement', label: 'Class', shared: false }),
    Object.freeze({ key: 'review', label: 'Confirm', shared: false })
]);

/**
 * The signed-in applicant, for the screens that need to know who they are.
 *
 * Deliberately not js/core/session.js, which is shaped around a staff role,
 * capabilities and branches that do not apply — and deliberately not
 * guardianSession either, which is shaped around having children on file.
 * An applicant's entire identity is the verified Google account, so this
 * holds exactly that and nothing else. It mirrors guardianSession's placement
 * (state for an identity type lives beside the service that resolves it).
 *
 * Hydrated once by app.js's enterApplicantApp(). The router does not pass
 * identity through page context, so pages import this instead.
 */
export const applicantSession = {
    email: '',
    name: '',

    hydrate({ email, name }) {
        this.email = String(email || '').toLowerCase();
        this.name = name || '';
        return this;
    },

    /** The shape submitSelfApplication() and myApplications() both take. */
    identity() {
        return { email: this.email, name: this.name };
    }
};

/** Levels a parent may choose from — the shipped ladder, client-side only. */
export function levelOptions() {
    return LEVELS.map((l) => ({ value: l.value, label: l.label }));
}

/**
 * Branches a parent may choose from: the ones published in the Desktop ERP's
 * Website Content module, by name.
 *
 * Deliberately NOT free text, and deliberately not /branches. The published
 * Branches page is the list the school has decided to show the public — the
 * same list the parent is reading two taps away — so offering anything else
 * would let them apply to a branch the school does not advertise, or mistype
 * one that exists. And /branches stays closed: a prospective parent has no
 * account, and rules cannot hide the operational fields on those records.
 *
 * Only the NAME crosses into the application. No ERP branch id is exposed
 * during the public process; Reception maps the name to the real Branch
 * record when they review, exactly as they allocate the NAT/APP number.
 *
 * An empty list is a real state — the school has not published its branches
 * yet — and the form treats it as such rather than blocking the application.
 *
 * @returns {Promise<string[]>} published branch names, in the published order.
 */
export async function branchOptions() {
    const branches = await content('branches');
    return (branches.items || [])
        .map((item) => String(item.title || '').trim())
        .filter(Boolean);
}

/**
 * Validates one parent step.
 *
 * The `applicant` step delegates to admissions.service.js so its rules cannot
 * drift from the desktop wizard's. The others are checked here because their
 * required fields genuinely differ.
 */
export function validateParentStep(stepKey, data) {
    if (stepKey === 'applicant') return validateStep('applicant', data);

    const errors = {};

    if (stepKey === 'placement') {
        if (!data.level) errors.level = 'Choose the level you would like to start at.';
        else if (!LEVELS.some((l) => l.value === data.level)) errors.level = 'Choose a level from the list.';
        if (!String(data.preferredBranch || '').trim()) {
            errors.preferredBranch = 'Tell us which branch you would like to attend.';
        }
    }

    return { ok: Object.keys(errors).length === 0, errors };
}

/** Validates the whole parent application, returning the first bad step. */
export function validateParentApplication(data) {
    for (const step of PARENT_STEPS) {
        const result = validateParentStep(step.key, data);
        if (!result.ok) return { ok: false, step: step.key, errors: result.errors };
    }
    return { ok: true, step: null, errors: {} };
}

/**
 * Submits the application.
 *
 * No draft handling, unlike the desktop wizard: /admissionDrafts is
 * staff-gated, and this form is three short steps rather than nine — a parent
 * finishes it in one sitting or starts again.
 *
 * @param {object} data
 * @param {{email: string}} identity  The signed-in Google account.
 * @returns {Promise<object>} the created application, including its Firestore
 *   id — which is the only tracking reference that exists until the ERP
 *   allocates NAT/APP at review.
 */
export async function submitSelfApplication(data, identity) {
    const email = String(identity?.email || '').toLowerCase();
    if (!email) throw new Error('Sign in again before submitting — we could not confirm your account.');

    const check = validateParentApplication(data);
    if (!check.ok) throw new Error(Object.values(check.errors)[0]);

    const created = await admissions$.createSelfSubmitted({
        name: String(data.name || '').trim(),
        dateOfBirth: data.dateOfBirth || null,
        gender: data.gender || null,
        level: data.level,

        guardianName: String(data.guardianName || '').trim(),
        guardianRelation: data.guardianRelation || 'Guardian',
        guardianPhone: String(data.guardianPhone || '').trim(),
        guardianEmail: String(data.guardianEmail || email).trim(),

        // The published branch NAME the parent selected. Reception maps it to
        // a real Branch record at review; no ERP id crosses the public
        // boundary in either direction.
        preferredBranch: String(data.preferredBranch || '').trim(),
        branchId: null,
        feePlanId: null,

        previousExperience: String(data.previousExperience || '').trim() || null,
        appliedOn: localDate()
    }, email);

    // The parent has now done something real, so they stop being a first-time
    // visitor. Written AFTER the application, deliberately: the application is
    // what they came to do, and recordParentEngagement() swallows its own
    // failures so a profile that does not save costs one extra Welcome screen
    // rather than turning a successful submission into an error.
    await recordParentEngagement(identity, 'application');

    return created;
}

/**
 * The applications this parent has submitted, shaped for the status screen.
 *
 * `nextActionFor()` is reused from admissions.service.js but is NOT shown to
 * the parent — it describes what STAFF do next, and a parent being told to
 * "Begin review" would be misleading. It is mapped to a family-facing
 * sentence instead.
 */
export async function myApplications(identity) {
    const email = String(identity?.email || '').toLowerCase();
    const rows = await admissions$.mine(email);

    return rows.map((application) => ({
        ...application,
        levelLabel: levelLabel(application.level),
        // Until the ERP allocates NAT/APP this is all a family has to quote.
        reference: application.applicationNo || application.id,
        numbered: Boolean(application.applicationNo),
        statusLabel: parentStatusLabel(application.status),
        statusNote: parentStatusNote(application.status),
        staffNextAction: nextActionFor(application.status)
    }));
}

/**
 * Status in a family's language rather than the pipeline's.
 *
 * "Reviewing" is deliberately not exposed as a distinct state — from outside
 * the school, submitted and under-review feel identical and a parent watching
 * a status change from one to the other learns nothing. Approved and enrolled
 * are the moments that matter.
 */
function parentStatusLabel(status) {
    return {
        [ADMISSION_STATUS.SUBMITTED]: 'Received',
        [ADMISSION_STATUS.REVIEWING]: 'Received',
        [ADMISSION_STATUS.APPROVED]: 'Approved',
        [ADMISSION_STATUS.ENROLLED]: 'Enrolled',
        [ADMISSION_STATUS.REJECTED]: 'Not proceeding'
    }[status] || 'Received';
}

function parentStatusNote(status) {
    return {
        [ADMISSION_STATUS.SUBMITTED]: 'We have your application. The school will call you shortly.',
        [ADMISSION_STATUS.REVIEWING]: 'We have your application. The school will call you shortly.',
        [ADMISSION_STATUS.APPROVED]: 'A place has been offered. The school will be in touch about joining.',
        [ADMISSION_STATUS.ENROLLED]: 'Your child is enrolled. Sign in again to see their classes.',
        [ADMISSION_STATUS.REJECTED]: 'We are not able to offer a place at the moment. Please do contact the school.'
    }[status] || '';
}
