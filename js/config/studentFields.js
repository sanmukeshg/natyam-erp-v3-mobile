/**
 * Natyam ERP v3 — What a student record requires
 *
 * ONE DEFINITION OF THE STUDENT FORM, SHARED BY EVERY WORKFLOW THAT CREATES OR
 * CHANGES A STUDENT — UAT6 ENH-602.
 *
 * There were three of them before this file, and they disagreed:
 *
 *   - natyam-admin's Add/Edit student made Batch, Fee plan and Guardian email
 *     all optional ("Place later", "No plan"), and offered every batch in the
 *     school regardless of the branch chosen two fields above;
 *   - natyam-mobile's Add/Edit made the same three required and narrowed the
 *     batch list to the chosen branch;
 *   - Admissions' enrol step asked for a batch, a fee plan and a branch and
 *     nothing else at all, so a family application became a student with no
 *     address, no emergency contact and no medical note, and somebody had to
 *     open Edit student afterwards to finish the job (UAT6 BUG-601).
 *
 * The same child therefore ended up with a different record depending on which
 * screen they were entered on. This file is the single answer: every workflow
 * that creates or changes a student builds its form from `studentFormFields()`
 * and is checked by `assertMandatoryStudentFields()`, so a field that is
 * mandatory is mandatory everywhere and the message a person reads when they
 * leave it blank is the same sentence on a phone and at a desk.
 *
 * **CHANGING THE MANDATORY SET IS A ONE-LINE CHANGE — edit
 * `MANDATORY_STUDENT_FIELDS` below and nothing else.** Every `required` flag in
 * the field list is derived from that array, and so is the service's own check,
 * so no form and no service has a second opinion to keep in step. Adding a
 * name to it makes the field required on Desktop Add, Desktop Edit, Mobile Add,
 * Mobile Edit and Parent Enrolment in the same commit; a new field needs a
 * label in `FIELD_LABELS` so the service can name it in an error, and the file
 * says so out loud if you forget.
 *
 * **The form is not the only guard.** students.service.js calls
 * `assertMandatoryStudentFields()` itself on every write, so a workflow that
 * never renders a form — a bulk operation, a future import, a screen written
 * next year — cannot get past it either. The service remains the authority for
 * everything this file cannot see: a full batch, a batch that does not teach
 * the student's level, a branch that does not exist.
 *
 * Byte-identical in natyam-mobile and natyam-admin — `node tools/verify-shared.cjs`
 * checks that. Change it in both.
 */

import { curriculum, exposedFeeFrequencies } from './app.config.js';
import { formatMoney } from '../utils/money.js';
import { localDate } from '../utils/date.js';

/**
 * THE MANDATORY SET. The one place it is decided.
 *
 * `dateOfBirth` and `gender` are NOT here, and that is a decision rather than
 * an oversight — asked directly during UAT Round 6 and answered "No" on
 * 2026-08-08. Both admission forms require them, so a student who arrives
 * through Admissions has both anyway; requiring them *here* would additionally
 * block an unrelated edit (a corrected phone number) on every student already
 * on the roll who has neither. Do not add them back without asking again.
 */
export const MANDATORY_STUDENT_FIELDS = Object.freeze([
    'name', 'branchId', 'level', 'batchId', 'feePlanId',
    'guardianName', 'guardianPhone', 'guardianEmail'
]);

/**
 * How each field is named to a person. Used by the form's labels AND by the
 * service's error messages, so "Fee plan is required." reads the same whether
 * a form caught it or a service did.
 */
export const FIELD_LABELS = Object.freeze({
    name: 'Full name',
    dateOfBirth: 'Date of birth',
    gender: 'Gender',
    branchId: 'Branch',
    level: 'Level',
    batchId: 'Batch',
    feePlanId: 'Fee plan',
    billingFrequency: 'Billing frequency',
    joinedOn: 'Joined on',
    guardianName: 'Guardian name',
    guardianRelation: 'Relationship',
    guardianPhone: 'Phone',
    guardianEmail: 'Email',
    alternatePhone: 'Emergency contact',
    address: 'Address',
    medicalNotes: 'Medical notes',
    notes: 'Other notes'
});

/** Whether this field must be filled in. Ask this; never re-read the array. */
export function isMandatoryStudentField(name) {
    return MANDATORY_STUDENT_FIELDS.includes(name);
}

/** A blank is `''`, null, undefined, whitespace, or an empty array. */
function isBlank(value) {
    if (Array.isArray(value)) return value.length === 0;
    if (value === null || value === undefined) return true;
    return String(value).trim() === '';
}

/**
 * Which mandatory fields a record is missing.
 *
 * `partial: true` is for an edit, where the caller sends only the fields it is
 * changing: a field that is absent from `values` entirely is being left alone
 * and is not missing, but one that is present and blank is being cleared and
 * is. A create sends the whole record, so absent and blank mean the same thing.
 *
 * @param {object} values
 * @param {object} [options]
 * @param {boolean} [options.partial=false]
 * @returns {string[]} field names, in MANDATORY_STUDENT_FIELDS order.
 */
export function missingMandatoryStudentFields(values, { partial = false } = {}) {
    const record = values || {};
    return MANDATORY_STUDENT_FIELDS.filter((name) => {
        if (partial && !(name in record)) return false;
        return isBlank(record[name]);
    });
}

/**
 * Throws unless every mandatory field is present — the service-side half of
 * the same rule the form applies, so no path into a student record can skip it.
 *
 * The sentence is written to be shown to a person, in the same words and the
 * same field names the form uses.
 */
export function assertMandatoryStudentFields(values, { partial = false } = {}) {
    const missing = missingMandatoryStudentFields(values, { partial });
    if (!missing.length) return;

    const named = missing.map((name) => FIELD_LABELS[name] || name);
    throw new Error(named.length === 1
        ? `${named[0]} is required.`
        : `These are required: ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}.`);
}

const GENDERS = Object.freeze([
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
    { value: 'other', label: 'Other' }
]);

const GUARDIAN_RELATIONS = Object.freeze(
    ['Mother', 'Father', 'Grandparent', 'Guardian', 'Sibling'].map((r) => ({ value: r, label: r }))
);

/** The batch label both apps show — name, occupancy, and "(full)" when it is. */
function batchLabel(batch) {
    return `${batch.name} — ${batch.enrolled}/${batch.capacity || '∞'}`
         + (batch.capacity && batch.enrolled >= batch.capacity ? ' (full)' : '');
}

/**
 * The student form, in one declaration.
 *
 * @param {object}  config
 * @param {'add'|'edit'|'enrol'} [config.mode]
 *        Only three things vary by mode, and all three are wording rather than
 *        rules: the fee plan's help sentence, the batch placeholder, and
 *        whether "Joined on" defaults to today.
 * @param {object|null} [config.existing]
 *        The student being edited, or — for `enrol` — the applicant mapped
 *        through `applicantSeed()`. Seeds every field's value.
 * @param {Array}  [config.branches]  Branches to offer.
 * @param {Array}  [config.batches]   Every batch that could be offered; this
 *        function narrows them to the branch chosen in the form itself.
 * @param {Array}  [config.feePlans]
 * @param {string} [config.defaultBranchId]
 *        Used when `existing` carries no branch — the session's branch, or the
 *        only branch the school has.
 * @returns {Array} formModal field definitions, values already seeded.
 */
export function studentFormFields({
    mode = 'add',
    existing = null,
    branches = [],
    batches = [],
    feePlans = [],
    defaultBranchId = ''
} = {}) {
    const editing = mode === 'edit';
    const open = batches.filter((b) => b.status !== 'closed');

    /*
     * Retired plans are hidden — EXCEPT the one this student is already on.
     *
     * Fee plan is mandatory, and a plan can be retired while students are still
     * billed on it. Offering only active plans meant that the moment a plan was
     * retired, every student on it became un-editable: their own plan was not in
     * the list, so the select fell back to the placeholder and the form demanded
     * a new one before it would save a corrected phone number. Keeping their
     * current plan visible and marked lets an unrelated edit go through
     * untouched, while still steering every new choice to a live plan.
     */
    const offerablePlans = feePlans.filter((p) =>
        !p.status || p.status === 'active' || p.id === existing?.feePlanId);

    // Every student must belong to a branch — the repository enforces it. One
    // created against a batch inherits the batch's branch, but one without a
    // batch had no way to supply it and the save was rejected with no field to
    // correct.
    const branchId = existing?.branchId || defaultBranchId
        || (branches.length === 1 ? branches[0].id : '');

    const fields = [
        { type: 'divider', label: 'Student' },
        { name: 'name' },
        { name: 'dateOfBirth', type: 'date' },
        { name: 'gender', type: 'select', placeholder: 'Not recorded', options: GENDERS },

        /*
         * Reactive — the batch field below is a function of this one.
         *
         * UAT6 BUG-602: changing a student's branch and saving left them in the
         * new branch still attached to a batch at the old one, because nothing
         * connected the two fields and Batch was optional on edit. Both halves
         * of that are fixed here: the batch list rebuilds against whatever
         * branch is chosen, and the batch is required.
         */
        { name: 'branchId', type: 'select', reactive: true,
          placeholder: branches.length > 1 ? 'Choose a branch' : null,
          options: branches.map((b) => ({ value: b.id, label: b.name })) },

        { name: 'level', type: 'select', placeholder: 'Choose a level',
          options: curriculum().map((l) => ({ value: l.value, label: l.label })),
          help: 'A student sits at their own level; a batch may teach several.' },

        /*
         * Batch — required in every workflow, and only ever from the branch
         * chosen above.
         *
         * It used to read "Place later" on natyam-admin, and its own help text
         * said what that cost: a student with no batch appears on no register,
         * so they were enrolled and then invisible to Attendance. Editing kept
         * it optional on both apps on the grounds that moving somebody out of a
         * batch temporarily is a real thing to do — but the way to do that is
         * the Move batch action, which says so, not a silent blank in a form
         * about something else.
         *
         * The `validate` is not a duplicate of the option filter. The filter
         * decides what is offered; this decides what is accepted. Between the
         * two sits a repaint — change the branch and the previously chosen
         * batch is still in `current` for an instant — and this is what stops
         * that stale value reaching the service.
         */
        { name: 'batchId', type: 'select', placeholder: 'Choose a batch',
          options: (values) => open
              .filter((b) => !values.branchId || b.branchId === values.branchId)
              .map((b) => ({ value: b.id, label: batchLabel(b) })),
          validate: (value, values) => {
              const batch = open.find((b) => b.id === value);
              if (!batch) return 'Choose a batch from the list.';
              if (values.branchId && batch.branchId !== values.branchId) {
                  return 'That batch is at another branch. Choose one at the branch above.';
              }
              return null;
          },
          help: 'Only batches at the chosen branch. A student with no batch appears on no register.' },

        /*
         * Fee plan — required, including on edit.
         *
         * A student created without one is never billed at all, silently:
         * raiseSchedule() is only ever reached when a plan exists. Changing it
         * on an existing student is quiet but real, and the help text says so —
         * updateStudent() writes the field and stops, then
         * runBillingScheduler() reads student.feePlanId on its next run, so the
         * change lands on the next cycle. Cycles already raised keep their own
         * periodKey and are never re-billed.
         */
        { name: 'feePlanId', type: 'select', placeholder: 'Choose a fee plan',
          options: offerablePlans.map((p) => ({
              value: p.id,
              label: `${p.name} — ${formatMoney(p.amount)}`
                   + (p.status && p.status !== 'active' ? ' (retired)' : '')
          })),
          help: editing
              ? 'Applies from the next billing cycle. Fees already raised are not changed.'
              : 'Raises the fee schedule immediately.' },

        { name: 'billingFrequency', type: 'select',
          placeholder: 'Use the fee plan default',
          options: exposedFeeFrequencies().map((f) => ({ value: f.value, label: f.label })) },

        { name: 'joinedOn', type: 'date' },

        { type: 'divider', label: 'Guardian' },
        { name: 'guardianName' },
        { name: 'guardianRelation', type: 'select', options: GUARDIAN_RELATIONS },
        { name: 'guardianPhone', type: 'tel' },
        /* Required. It is the guardian's sign-in identity for the Parent
           Portal — students.repository matches a portal account by
           guardianEmail — so a student saved without one has a family that
           cannot reach the app at all. */
        { name: 'guardianEmail', type: 'email' },
        { name: 'alternatePhone', type: 'tel',
          help: 'Called when the guardian cannot be reached.' },
        { name: 'address', type: 'textarea', rows: 2 },

        { type: 'divider', label: 'Health and notes' },
        { name: 'medicalNotes', type: 'textarea', rows: 2,
          help: 'Injuries, allergies, anything a teacher must know before class.' },
        { name: 'notes', type: 'textarea', rows: 2 }
    ];

    /*
     * `label` and `required` are DERIVED, never written on a field above.
     *
     * That is the whole point of the ENH-602 rework: adding or removing a name
     * in MANDATORY_STUDENT_FIELDS changes what every form on both apps demands,
     * with nothing else to edit and nothing that can disagree with it. A field
     * literal that carried its own `required: true` would be a second opinion,
     * and the two would eventually drift — which is exactly how Desktop and
     * Mobile came to disagree in the first place.
     *
     * A missing label is thrown rather than defaulted. Falling back to the
     * field name would ship "batchId is required." to a parent's screen, and
     * the failure would be invisible until somebody read it there.
     */
    return fields.map((f) => {
        if (f.type === 'divider') return f;
        const label = FIELD_LABELS[f.name];
        if (!label) throw new Error(`studentFields: no FIELD_LABELS entry for "${f.name}".`);

        return {
            ...f,
            label,
            required: isMandatoryStudentField(f.name),
            value: f.name === 'branchId' ? branchId
                 : f.name === 'joinedOn' ? (existing?.joinedOn || localDate())
                 : f.name === 'guardianRelation' ? (existing?.guardianRelation || 'Mother')
                 : (existing?.[f.name] ?? '')
        };
    });
}

/** Turns the field list into the `values` map formModal seeds itself from. */
export function seedStudentValues(fields) {
    return Object.fromEntries(fields
        .filter((f) => f.type !== 'divider')
        .map((f) => [f.name, f.value ?? '']));
}

/**
 * An admission application, in the shape `studentFormFields()` seeds from —
 * UAT6 BUG-601.
 *
 * Everything the family or the front desk already answered is carried across
 * so the Owner confirms it rather than retypes it; everything a student record
 * needs and an application does not carry (emergency contact, address, medical
 * notes on a self-submitted one) is left blank for them to fill in *before* the
 * student exists.
 *
 * `branchId` is the caller's, not the application's, on purpose: a family
 * application arrives with a branch NAME and no id, and each app resolves that
 * to a suggestion its own way before calling this.
 */
export function applicantSeed(application, { branchId = '' } = {}) {
    if (!application) return null;
    return {
        name: application.name || '',
        dateOfBirth: application.dateOfBirth || '',
        gender: application.gender || '',
        branchId: application.branchId || branchId || '',
        level: application.level || '',
        batchId: '',
        feePlanId: application.feePlanId || '',
        billingFrequency: application.billingFrequency || '',
        joinedOn: localDate(),
        guardianName: application.guardianName || '',
        guardianRelation: application.guardianRelation || 'Mother',
        guardianPhone: application.guardianPhone || '',
        guardianEmail: application.guardianEmail || '',
        alternatePhone: application.alternatePhone || application.emergencyContact || '',
        address: application.address || '',
        medicalNotes: application.medicalNotes || '',
        notes: application.notes || ''
    };
}
