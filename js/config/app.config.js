/**
 * Natyam ERP v3 — Mobile — Application configuration
 *
 * Everything environment-shaped or business-shaped that other modules need to
 * agree on lives here. Modules import from this file; they never hard-code a
 * store name, a status string, a route or a role.
 *
 * Trimmed from the reference project's version: NAVIGATION and ROUTES are not
 * here, because the two v3 apps do not share a navigation structure. This
 * app's tables (bottom tab bar + More sheet) live in js/config/navigation.js.
 * Everything else — the domain enums, CAPABILITIES, ROLES and the
 * reference-data resolution seam — is shared verbatim with natyam-admin, so
 * permission logic cannot drift between the two apps.
 */

export const APP = Object.freeze({
    name: 'Natyam ERP v3',
    // Which of the two v3 apps this is. The product is one thing; the surface
    // is not — natyam-admin and natyam-mobile ship separately, from separate
    // repositories, against the same Firebase project.
    edition: 'Mobile',
    // 3.0.0, not a continuation of 2.26.5: v3 is a new application built by
    // splitting the reference project in two, with a mobile-first staff
    // experience. See CHANGELOG.md and MIGRATION_CHECKLIST.md.
    version: '3.6.0',
    organisation: 'NATYAM — School of Kuchipudi',
    locale: 'en-IN',
    currency: 'INR',
    timezone: 'Asia/Kolkata'
});

/**
 * Session. Identity itself is verified by Firebase Authentication now — see
 * js/core/session.js for what that does and does not cover. `idleTimeoutMs`
 * has no source-of-truth value in the IAM specs; 30 minutes is a sensible
 * default for a front-desk device and is safe to change in one place.
 */
export const SESSION = Object.freeze({
    idleTimeoutMs: 30 * 60 * 1000
});

/* ==========================================================================
   DATABASE SCHEMA
   --------------------------------------------------------------------------
   Declarative, versioned migrations. Each entry runs once, in order, for any
   install below that version. 1.0 bumped a single version number and hoped
   onupgradeneeded would sort it out; that works for adding stores and breaks
   the moment data has to be reshaped.
   ========================================================================== */

export const SCHEMA = Object.freeze({
    // Distinct from the older Natyam-ERP-UAT deployment's database name. Both
    // apps can end up served from the same GitHub Pages origin
    // (username.github.io), and IndexedDB is scoped to the origin, not the
    // path — sharing a name meant this app silently inherited that one's
    // already-seeded (password-less) user records instead of seeding its own.
    name: 'natyam_erp_login_uat',
    version: 6,

    stores: {
        branches:       { keyPath: 'id', indexes: [['code', 'code', { unique: true }], ['status', 'status']] },
        academicYears:  { keyPath: 'id', indexes: [['isCurrent', 'isCurrent']] },

        students:       { keyPath: 'id', indexes: [
            ['branchId', 'branchId'], ['status', 'status'], ['batchId', 'batchId'],
            ['admissionNo', 'admissionNo', { unique: true }], ['level', 'level'],
            ['curriculumId', 'curriculumId'],
            ['searchKey', 'searchKey'], ['createdAt', 'createdAt']
        ]},

        admissions:     { keyPath: 'id', indexes: [
            ['branchId', 'branchId'], ['status', 'status'], ['appliedOn', 'appliedOn'], ['searchKey', 'searchKey']
        ]},

        admissionDrafts:{ keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },

        batches:        { keyPath: 'id', indexes: [
            ['branchId', 'branchId'], ['status', 'status'], ['teacherId', 'teacherId'],
            ['level', 'level'], ['code', 'code', { unique: true }]
        ]},

        staff:          { keyPath: 'id', indexes: [
            ['branchId', 'branchId'], ['status', 'status'], ['role', 'role'], ['searchKey', 'searchKey']
        ]},

        attendance:     { keyPath: 'id', indexes: [
            ['branchId', 'branchId'], ['batchId', 'batchId'], ['date', 'date'],
            ['studentId', 'studentId'], ['batchDate', 'batchDate', { unique: true }], ['status', 'status']
        ]},

        holidays:       { keyPath: 'id', indexes: [['date', 'date'], ['branchId', 'branchId']] },

        feePlans:       { keyPath: 'id', indexes: [['level', 'level'], ['status', 'status'], ['academicYearId', 'academicYearId']] },

        invoices:       { keyPath: 'id', indexes: [
            ['studentId', 'studentId'], ['branchId', 'branchId'], ['status', 'status'],
            ['dueDate', 'dueDate'], ['number', 'number', { unique: true }]
        ]},

        payments:       { keyPath: 'id', indexes: [
            ['studentId', 'studentId'], ['invoiceId', 'invoiceId'], ['branchId', 'branchId'],
            ['paidOn', 'paidOn'], ['mode', 'mode'], ['receiptNo', 'receiptNo', { unique: true }],
            ['status', 'status']
        ]},

        /* Finance is double-entry-shaped and deliberately separate from fee
           collection. Collections record what a family owes and has paid;
           finance records what the school earned and spent. Conflating them
           was the largest structural flaw in 1.0. */
        ledgerEntries:  { keyPath: 'id', indexes: [
            ['branchId', 'branchId'], ['date', 'date'], ['account', 'account'],
            ['type', 'type'], ['sourceId', 'sourceId'], ['period', 'period']
        ]},
        expenses:       { keyPath: 'id', indexes: [['branchId', 'branchId'], ['date', 'date'], ['category', 'category'], ['status', 'status']] },
        salaries:       { keyPath: 'id', indexes: [['staffId', 'staffId'], ['period', 'period'], ['status', 'status']] },

        programs:       { keyPath: 'id', indexes: [['branchId', 'branchId'], ['type', 'type'], ['date', 'date'], ['status', 'status']] },
        certificates:   { keyPath: 'id', indexes: [['studentId', 'studentId'], ['programId', 'programId'], ['serial', 'serial', { unique: true }], ['issuedOn', 'issuedOn']] },
        documents:      { keyPath: 'id', indexes: [['ownerId', 'ownerId'], ['ownerType', 'ownerType'], ['kind', 'kind']] },

        notifications:  { keyPath: 'id', indexes: [['read', 'read'], ['createdAt', 'createdAt'], ['kind', 'kind']] },
        auditLog:       { keyPath: 'id', indexes: [['entity', 'entity'], ['action', 'action'], ['at', 'at'], ['actorId', 'actorId']] },
        settings:       { keyPath: 'key' },
        users:          { keyPath: 'id', indexes: [['role', 'role'], ['status', 'status']] },

        /* Curriculum & academic structure (Phase 2). Independent of batches —
           a student's curriculum and their batch are separate assignments.
           `curricula` carries its Level → Stage → Lesson tree in `structure`,
           edited as one document; `curriculumLevels` is the reusable, editable
           level vocabulary (Beginner / Intermediate / Advanced, extensible). */
        curricula:       { keyPath: 'id', indexes: [
            ['code', 'code', { unique: true }], ['status', 'status'],
            ['sortOrder', 'sortOrder'], ['searchKey', 'searchKey']
        ]},
        curriculumLevels:{ keyPath: 'id', indexes: [['status', 'status'], ['sortOrder', 'sortOrder']] }
    },

    /**
     * Ordered migrations. `to` is the schema version each one produces.
     * `upgrade(db, tx)` runs inside the versionchange transaction; `seed(api)`
     * runs afterwards, once, with normal read/write access.
     */
    migrations: [
        {
            to: 1,
            note: 'Initial 2.0 schema. Imports any 1.0 data found on the device.'
        },
        {
            to: 2,
            note: 'Curriculum & academic structure. Seeds the default, editable level vocabulary.',
            /* Runs inside the version-change transaction, after the store
               reconciliation loop has created curriculumLevels. Deterministic
               ids make this idempotent: a device that somehow re-runs it simply
               overwrites the same three rows rather than duplicating them. The
               school is free to rename, reorder, retire or add to these. */
            upgrade(db, tx) {
                const at = new Date().toISOString();
                const store = tx.objectStore('curriculumLevels');
                [
                    { code: 'BEGINNER', name: 'Beginner', sortOrder: 1 },
                    { code: 'INTERMEDIATE', name: 'Intermediate', sortOrder: 2 },
                    { code: 'ADVANCED', name: 'Advanced', sortOrder: 3 }
                ].forEach((level) => {
                    store.put({
                        id: `CLV-${level.code}`,
                        code: level.code,
                        name: level.name,
                        sortOrder: level.sortOrder,
                        status: 'active',
                        createdAt: at,
                        updatedAt: at,
                        deletedAt: null
                    });
                });
            }
        },
        {
            to: 3,
            note: 'Replaces the placeholder level vocabulary with the approved Level / Qualification list.',
            /* v2.2.0 seeded three placeholder levels (Beginner / Intermediate /
               Advanced) that were never the approved list. This installs the
               approved defaults on every device — new and existing — and
               removes the placeholders so they do not linger in the picker.
               Deterministic ids keep it idempotent. A level the school has
               already renamed is left alone: only the untouched placeholders
               are removed, and a curriculum that referenced one keeps working
               because the structure caches the level name it was added under. */
            upgrade(db, tx) {
                const at = new Date().toISOString();
                const store = tx.objectStore('curriculumLevels');

                DEFAULT_CURRICULUM_LEVELS.forEach((level, index) => {
                    store.put({
                        id: `CLV-${level.code}`,
                        code: level.code,
                        name: level.name,
                        sortOrder: index + 1,
                        status: 'active',
                        createdAt: at,
                        updatedAt: at,
                        deletedAt: null
                    });
                });

                // Drop the placeholders only where they are still exactly as
                // seeded — anything the school edited is their data, not ours.
                [
                    { id: 'CLV-BEGINNER', name: 'Beginner' },
                    { id: 'CLV-INTERMEDIATE', name: 'Intermediate' },
                    { id: 'CLV-ADVANCED', name: 'Advanced' }
                ].forEach((placeholder) => {
                    const request = store.get(placeholder.id);
                    request.onsuccess = () => {
                        const existing = request.result;
                        if (existing && existing.name === placeholder.name) store.delete(placeholder.id);
                    };
                });
            }
        },
        {
            to: 4,
            note: 'Fee plans move from a yearly amount split into instalments to a monthly amount.',
            /* NATYAM collects monthly. A plan previously stored the whole year
               and how many instalments to split it into; it now stores what is
               due each period plus the period itself. Existing plans convert by
               dividing the year by twelve, so a school upgrading keeps working
               fee plans without re-entering them. The original annual figure is
               retained on the record for reference and reporting history. */
            upgrade(db, tx) {
                const store = tx.objectStore('feePlans');
                const request = store.openCursor();
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) return;
                    const plan = cursor.value;
                    if (plan && plan.amount == null) {
                        const annual = Number(plan.annualAmount) || 0;
                        cursor.update({
                            ...plan,
                            amount: Math.round(annual / 12),
                            frequency: 'monthly',
                            legacyAnnualAmount: annual,
                            updatedAt: new Date().toISOString()
                        });
                    }
                    cursor.continue();
                };
            }
        },
        {
            to: 5,
            note: 'Monetary amounts move from scaled paise to whole rupees.',
            /* Amounts were stored as paise but entered and shown as rupees, and
               a saved form re-scaled its own value — ₹1,500 became ₹150,000 and
               then ₹15,00,000. Storage is now the same whole number the user
               types, which removes the factor entirely. Existing rows are
               divided by a hundred once. `moneyMigratedAt` marks a record so a
               re-run can never divide it twice. */
            upgrade(db, tx) {
                const MONEY_FIELDS = {
                    feePlans:     ['amount', 'registrationFee', 'costumeFee', 'legacyAnnualAmount'],
                    invoices:     ['amount', 'paidAmount', 'balance', 'discount'],
                    payments:     ['amount'],
                    ledgerEntries:['amount', 'debit', 'credit'],
                    expenses:     ['amount'],
                    salaries:     ['amount', 'gross', 'net', 'allowances', 'deductions', 'monthlySalary'],
                    staff:        ['monthlySalary', 'allowances', 'deductions'],
                    admissions:   ['registrationFee', 'amount'],
                    programs:     ['totalCost', 'budget', 'fee']
                };
                const at = new Date().toISOString();

                Object.entries(MONEY_FIELDS).forEach(([storeName, fields]) => {
                    if (!db.objectStoreNames.contains(storeName)) return;
                    const store = tx.objectStore(storeName);
                    const request = store.openCursor();
                    request.onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (!cursor) return;
                        const row = cursor.value;
                        if (row && !row.moneyMigratedAt) {
                            const next = { ...row, moneyMigratedAt: at };
                            let touched = false;
                            fields.forEach((f) => {
                                if (typeof next[f] === 'number' && Number.isFinite(next[f])) {
                                    next[f] = Math.round(next[f] / 100);
                                    touched = true;
                                }
                            });
                            if (touched) cursor.update(next);
                        }
                        cursor.continue();
                    };
                });
            }
        },
        {
            to: 6,
            note: 'Dance levels move to the approved Foundation / Intermediate / Advanced ladder.',
            /* The five Sanskrit grades are replaced by the school's actual
               qualification ladder. Existing students, batches, admissions and
               plans are mapped onto the equivalent rung so nobody loses their
               placement; anything unrecognised is left untouched rather than
               guessed at, and shows as-is until someone corrects it. */
            upgrade(db, tx) {
                const MAP = {
                    prarambhika: 'foundation-1',
                    praveshika:  'foundation-5',
                    madhyama:    'intermediate-certificate',
                    visharada:   'intermediate-diploma',
                    alankara:    'advanced-masters'
                };
                ['students', 'batches', 'admissions', 'feePlans', 'certificates'].forEach((storeName) => {
                    if (!db.objectStoreNames.contains(storeName)) return;
                    const store = tx.objectStore(storeName);
                    const request = store.openCursor();
                    request.onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (!cursor) return;
                        const row = cursor.value;
                        if (row && MAP[row.level]) {
                            cursor.update({ ...row, level: MAP[row.level], updatedAt: new Date().toISOString() });
                        }
                        cursor.continue();
                    };
                });
            }
        }
    ]
});

/* ==========================================================================
   DOMAIN CONSTANTS
   Status values are frozen objects, not loose strings. 1.0 compared
   'Pending Approval' against 'Pending approval' in two files and silently
   returned zero.
   ========================================================================== */

export const STUDENT_STATUS = Object.freeze({
    ACTIVE:    'active',
    ON_LEAVE:  'on_leave',
    GRADUATED: 'graduated',
    INACTIVE:  'inactive'
});

export const ADMISSION_STATUS = Object.freeze({
    DRAFT:     'draft',
    SUBMITTED: 'submitted',
    REVIEWING: 'reviewing',
    APPROVED:  'approved',
    ENROLLED:  'enrolled',
    REJECTED:  'rejected'
});

/* An enquiry is the stage before an admission: a prospective parent who has
   asked to be contacted but has not applied, and who has no account of any
   kind. Kept separate from ADMISSION_STATUS above rather than folded into it
   — the two pipelines are followed up by the same desk but are not the same
   record, and an enquiry that never converts is a normal outcome, not a
   rejected application.

   CONVERTED means an Admission was raised from it. The enquiry stays as it is
   afterwards; nothing is moved or deleted. */
export const ENQUIRY_STATUS = Object.freeze({
    NEW:       'new',
    CONTACTED: 'contacted',
    CONVERTED: 'converted',
    CLOSED:    'closed'
});

/* NATYAM has no Leave concept and no Holiday-in-attendance handling
   (Milestone 6) — attendance is recorded as one of exactly two states. */
export const ATTENDANCE_STATUS = Object.freeze({
    PRESENT: 'present',
    ABSENT:  'absent'
});

/* Curriculum & academic structure (Phase 2). Curricula and curriculum levels
   share the same simple active/inactive lifecycle; retiring one keeps its
   history and any student assignments intact while hiding it from new use. */
export const CURRICULUM_STATUS = Object.freeze({
    ACTIVE:   'active',
    INACTIVE: 'inactive'
});

export const DURATION_UNITS = Object.freeze([
    { value: 'months', label: 'Months' },
    { value: 'years',  label: 'Years' }
]);

/* Fee collection frequency. NATYAM collects monthly, which is the only option
   offered in the UI. The others are declared so a future release can expose one
   without reshaping fee plans, invoices or the schedule generator: everything
   downstream reads periodsPerYear and dayGap from this table rather than
   assuming a cadence. Set `exposed: true` to surface one in the form. */
const FEE_FREQUENCIES = Object.freeze([
    { value: 'monthly',     label: 'Monthly',     periodsPerYear: 12, months: 1,  exposed: true },
    { value: 'quarterly',   label: 'Quarterly',   periodsPerYear: 4,  months: 3,  exposed: true },
    { value: 'half_yearly', label: 'Half-yearly', periodsPerYear: 2,  months: 6,  exposed: true },
    { value: 'annual',      label: 'Annual',      periodsPerYear: 1,  months: 12, exposed: true },
    { value: 'one_time',    label: 'One-time',    periodsPerYear: 1,  months: 0,  exposed: true }
]);

export const DEFAULT_FEE_FREQUENCY = 'monthly';

/** Resolves a frequency, falling back to monthly for unknown or legacy values. */
export function feeFrequency(value) {
    return FEE_FREQUENCIES.find((f) => f.value === value)
        || FEE_FREQUENCIES.find((f) => f.value === DEFAULT_FEE_FREQUENCY);
}

/** Only the frequencies a user may currently choose. */
export function exposedFeeFrequencies() {
    return FEE_FREQUENCIES.filter((f) => f.exposed);
}

/* The default Level / Qualification vocabulary. "Foundation", "Intermediate"
   and "Advanced" are display prefixes inside a single flat list — not separate
   fields, groups or selectors. These are seed values only: the school edits,
   reorders, retires and extends the list from the Curriculum module, and
   nothing in the application branches on these names or codes. */
const DEFAULT_CURRICULUM_LEVELS = Object.freeze([
    { code: 'FND-1',    name: 'Foundation - Level 1' },
    { code: 'FND-2',    name: 'Foundation - Level 2' },
    { code: 'FND-3',    name: 'Foundation - Level 3' },
    { code: 'FND-4',    name: 'Foundation - Level 4' },
    { code: 'FND-5',    name: 'Foundation - Level 5' },
    { code: 'FND-6',    name: 'Foundation - Level 6' },
    { code: 'FND-7',    name: 'Foundation - Level 7' },
    { code: 'FND-8',    name: 'Foundation - Level 8' },
    { code: 'INT-CERT', name: 'Intermediate - Certificate' },
    { code: 'INT-DIP',  name: 'Intermediate - Diploma' },
    { code: 'ADV-MAS',  name: 'Advanced - Masters' },
    { code: 'ADV-THY',  name: 'Advanced - Theory' },
    { code: 'ADV-PRC',  name: 'Advanced - Practical' }
]);

export const INVOICE_STATUS = Object.freeze({
    DRAFT:    'draft',
    OPEN:     'open',
    PARTIAL:  'partial',
    PAID:     'paid',
    OVERDUE:  'overdue',
    WAIVED:   'waived',
    CANCELLED:'cancelled'
});

export const PAYMENT_STATUS = Object.freeze({
    CLEARED:  'cleared',
    PENDING:  'pending',
    BOUNCED:  'bounced',
    REFUNDED: 'refunded'
});

export const PAYMENT_MODES = Object.freeze([
    { value: 'upi',      label: 'UPI',           needsReference: true },
    { value: 'cash',     label: 'Cash',          needsReference: false },
    { value: 'bank',     label: 'Bank transfer', needsReference: true },
    { value: 'cheque',   label: 'Cheque',        needsReference: true },
    { value: 'card',     label: 'Card',          needsReference: true }
]);

/**
 * The Kuchipudi curriculum ladder. Order matters — promotion, certificate
 * eligibility and fee banding all read this sequence.
 */
/* The school's Level / Qualification ladder.
   "Foundation", "Intermediate" and "Advanced" are part of each name, not
   separate fields or a second selector — a student holds exactly one of these
   values. The list is the default; a school can override it (see
   configureCurriculum) without any code change. */
export const LEVELS = Object.freeze([
    { value: 'foundation-1', label: 'Foundation Level 1', order: 1,  years: 1, description: 'Foundation — first year exam' },
    { value: 'foundation-2', label: 'Foundation Level 2', order: 2,  years: 1, description: 'Foundation — second year exam' },
    { value: 'foundation-3', label: 'Foundation Level 3', order: 3,  years: 1, description: 'Foundation — third year exam' },
    { value: 'foundation-4', label: 'Foundation Level 4', order: 4,  years: 1, description: 'Foundation — fourth year exam' },
    { value: 'foundation-5', label: 'Foundation Level 5', order: 5,  years: 1, description: 'Foundation — fifth year exam' },
    { value: 'foundation-6', label: 'Foundation Level 6', order: 6,  years: 1, description: 'Foundation — sixth year exam' },
    { value: 'foundation-7', label: 'Foundation Level 7', order: 7,  years: 1, description: 'Foundation — seventh year exam' },
    { value: 'foundation-8', label: 'Foundation Level 8', order: 8,  years: 1, description: 'Foundation — eighth year exam' },
    { value: 'intermediate-certificate', label: 'Intermediate Certificate', order: 9,  years: 1, description: 'Intermediate — certificate' },
    { value: 'intermediate-diploma',     label: 'Intermediate Diploma',     order: 10, years: 1, description: 'Intermediate — diploma' },
    { value: 'advanced-masters',   label: 'Advanced Masters',   order: 11, years: 1, description: 'Advanced — masters' },
    { value: 'advanced-theory',    label: 'Advanced Theory',    order: 12, years: 1, description: 'Advanced — theory course' },
    { value: 'advanced-practical', label: 'Advanced Practical', order: 13, years: 1, description: 'Advanced — practical course' }
]);

export const EXPENSE_CATEGORIES = Object.freeze([
    'Rent', 'Salaries', 'Utilities', 'Costumes', 'Instruments', 'Musicians',
    'Travel', 'Venue hire', 'Marketing', 'Maintenance', 'Stationery', 'Other'
]);

/**
 * Staff roles, and which of them may take a batch — UAT5 ENH-512.
 *
 * `teaches` is the whole point of this table. It existed before, in
 * staff.service.js, and nothing read it: batch assignment asked
 * `staff$.teachers()`, which filtered on `role == 'teacher'` literally, so the
 * flag and the behaviour said different things and only the literal one
 * counted. staff.repository reads TEACHING_ROLES now, and this is the single
 * place deciding who may be put in front of a class.
 *
 * IT LIVES HERE, NOT IN staff.service.js, because the repository needs it and
 * cannot import that service — repositories.js re-exports `staff$` from the
 * repository, so the arrow would close an import cycle (that file's own header
 * calls the hazard out). staff.service.js re-exports both names, so every
 * existing importer is unchanged.
 *
 * `owner` is new. An academy's owner very often teaches — that is ENH-512's
 * whole premise — and the workaround was a second, fictional Teacher account
 * for the same person, so attendance was marked by an identity that was not
 * theirs. An Owner is a staff member who happens to own the school; saying so
 * once here lets every consumer (batches, timetable, attendance, certificates,
 * conflict detection) follow without learning anything new.
 *
 * PAYROLL IS UNAFFECTED, which is the thing to check before adding a role
 * here: preparePayroll() walks activeStaff() and skips anyone with no
 * `monthlySalary`, so an Owner who does not draw a salary through the system
 * never appears in a pay run. One who does is presumably meant to.
 */
export const STAFF_ROLES = Object.freeze([
    { value: 'teacher',  label: 'Teacher',        teaches: true },
    { value: 'owner',    label: 'Owner',          teaches: true },
    { value: 'musician', label: 'Musician',       teaches: false },
    { value: 'admin',    label: 'Administration', teaches: false },
    { value: 'support',  label: 'Support',        teaches: false }
]);

/** The roles a batch may be assigned to. Derived, never listed by hand. */
export const TEACHING_ROLES = Object.freeze(
    STAFF_ROLES.filter((role) => role.teaches).map((role) => role.value)
);

const PROGRAM_TYPES = Object.freeze([
    { value: 'performance', label: 'Performance' },
    { value: 'workshop',    label: 'Workshop' },
    { value: 'competition', label: 'Competition' },
    { value: 'examination', label: 'Examination' },
    { value: 'rehearsal',   label: 'Rehearsal' }
]);

/* ==========================================================================
   ROLES & PERMISSIONS
   Capability strings, not role checks scattered through the UI. A view asks
   "can I do X", never "am I an admin".
   ========================================================================== */

export const CAPABILITIES = Object.freeze({
    STUDENT_VIEW: 'student.view',   STUDENT_EDIT: 'student.edit',   STUDENT_DELETE: 'student.delete',
    ADMISSION_VIEW: 'admission.view', ADMISSION_EDIT: 'admission.edit', ADMISSION_APPROVE: 'admission.approve',
    ATTENDANCE_VIEW: 'attendance.view', ATTENDANCE_MARK: 'attendance.mark',
    FEE_VIEW: 'fee.view', FEE_COLLECT: 'fee.collect', FEE_REFUND: 'fee.refund', FEE_WAIVE: 'fee.waive',
    FINANCE_VIEW: 'finance.view', FINANCE_EDIT: 'finance.edit',
    STAFF_VIEW: 'staff.view', STAFF_EDIT: 'staff.edit',
    PROGRAM_VIEW: 'program.view', PROGRAM_EDIT: 'program.edit',
    CERTIFICATE_ISSUE: 'certificate.issue',
    REPORT_VIEW: 'report.view', REPORT_EXPORT: 'report.export',

    // settings.edit is the **Business Settings** capability — institute
    // details, branches, academic years, fee plans, curriculum, master data,
    // announcements. Owner + Administrator. It is deliberately scoped to the
    // academy's own configuration and never to the system's: Firebase/API/
    // environment/system configuration is a separate, Administrator-only
    // capability (SYSTEM_CONFIGURE below, the "System Settings" half of this
    // split) rather than a second value bolted onto this one. See
    // SETTINGS_GROUPS below and docs/architecture/IAM_ROLE_MODEL.md §2a.
    SETTINGS_VIEW: 'settings.view', SETTINGS_EDIT: 'settings.edit',
    AUDIT_VIEW: 'audit.view', AUDIT_PURGE: 'audit.purge',

    // Data movement. These three were one capability (`backup.manage`) until
    // the Owner role upgrade, which needed the boundary drawn between them:
    // the Owner takes backups and exports data as a matter of routine; only
    // an Administrator may replace or erase the database.
    BACKUP_CREATE: 'backup.create', DATA_EXPORT: 'data.export', DATA_RESTORE: 'data.restore',

    // System-level concerns, reserved to Administrator (ADMINISTRATOR_ONLY
    // below). No screen grants any of these today — they are declared so the
    // reservation is expressed in the model rather than left implicit, and so
    // the features that will eventually need them have a gate to hang on
    // instead of reaching for settings.edit and quietly widening it.
    //
    // SYSTEM_CONFIGURE is "System Settings" — the other half of the
    // settings.edit split above: Firebase configuration, API configuration,
    // environment configuration, application configuration, system
    // constants. Nothing in the Settings module exercises it today (there is
    // no Firebase/environment screen); reused rather than duplicated the
    // moment one exists.
    SYSTEM_CONFIGURE: 'system.configure',
    // Application maintenance — database maintenance, migration utilities,
    // developer tools, debug mode, performance tools, version updates,
    // deployment operations, system upgrades. All of it Administrator-only:
    // none of it is an academy operating decision.
    SYSTEM_MAINTAIN: 'system.maintain',
    ROLE_MANAGE: 'role.manage',             // create/delete roles, edit role definitions, the permission matrix
    SECURITY_MANAGE: 'security.manage',     // security, password, MFA and session policies

    // Action-level permissions inside the Users tab — settings.view still
    // gates whether the tab is reachable at all; these gate which of its
    // buttons a given role actually sees (Doc 6 §22).
    USER_VIEW: 'user.view', USER_CREATE: 'user.create', USER_EDIT: 'user.edit',
    USER_ACTIVATE: 'user.activate', USER_DEACTIVATE: 'user.deactivate',
    USER_ARCHIVE: 'user.archive', USER_CHANGE_ROLE: 'user.changeRole'
});

const ALL_CAPS = Object.values(CAPABILITIES);

/**
 * Retired capability strings, mapped to what replaced them.
 *
 * `backup.manage` bundled three separable things — take a backup, export a
 * section, replace/erase the database — and the Owner upgrade had to draw a
 * line straight through the middle of it. Nothing in the application names it
 * any more, but a role matrix stored in the database (`roles.override`, see
 * the resolution seam below) or one travelling inside an older backup file
 * still can. Expanding it here means such a matrix keeps granting what it
 * always granted, instead of silently granting nothing.
 */
const CAPABILITY_ALIASES = Object.freeze({
    'backup.manage': [CAPABILITIES.BACKUP_CREATE, CAPABILITIES.DATA_EXPORT, CAPABILITIES.DATA_RESTORE]
});

/**
 * The permissions reserved to Administrator — the whole of the difference
 * between Administrator and Owner, in one list.
 *
 * Written as the *exclusions* rather than enumerating what the Owner holds,
 * because that is the business rule as stated: the Owner does everything
 * except these. A capability added to CAPABILITIES later therefore reaches
 * the Owner automatically, which is the right default for an operational
 * permission and the wrong one only for a system-level permission — and a
 * system-level permission is exactly the kind whose author is already
 * looking at this list.
 */
export const ADMINISTRATOR_ONLY_CAPABILITIES = Object.freeze([
    CAPABILITIES.SYSTEM_CONFIGURE,
    CAPABILITIES.SYSTEM_MAINTAIN,
    CAPABILITIES.ROLE_MANAGE,
    CAPABILITIES.SECURITY_MANAGE,
    CAPABILITIES.DATA_RESTORE,
    CAPABILITIES.AUDIT_PURGE
]);

/**
 * The Owner's grant: everything the application can do, less the reserved
 * list above. Exported so the Roles screen, the documentation and any future
 * test can assert the relationship rather than re-derive it by hand.
 */
export const OWNER_CAPABILITIES = Object.freeze(
    ALL_CAPS.filter((cap) => !ADMINISTRATOR_ONLY_CAPABILITIES.includes(cap))
);

/**
 * Named split of what used to be discussed as one undifferentiated "settings"
 * concern. Not two independent capabilities — SYSTEM_CONFIGURE was already
 * declared and already reserved (ADMINISTRATOR_ONLY_CAPABILITIES above);
 * this constant exists so "Business Settings" and "System Settings" are
 * things a reader of this file can find by name, rather than a distinction
 * that only lives in a comment. The Roles screen and settings.page.js read
 * through this rather than the two capability strings directly, so the
 * grouping stays correct if either side is ever renamed.
 */
export const SETTINGS_GROUPS = Object.freeze({
    business: { label: 'Business Settings', capability: CAPABILITIES.SETTINGS_EDIT },
    system: { label: 'System Settings', capability: CAPABILITIES.SYSTEM_CONFIGURE }
});

/**
 * Four roles, per the IAM Security Policy (Document 10 §8) and this
 * project's approved combined role model — not five. `owner` + `accountant`
 * merge into `owner_accountant`; `registrar` + `teacher` merge into
 * `teacher_reception` (a registrar's admissions/students/attendance/fee
 * work is front-office "reception" work in this model); and `viewer` is new
 * — read-only across every module, for someone who needs visibility without
 * being able to change anything.
 *
 * The hierarchy is
 *
 *     Administrator  →  Owner  →  Teacher & Reception  →  Viewer
 *
 * with a deliberate distinction at the top: Administrator is the highest
 * *system* authority, Owner the highest *business* authority. They are not
 * the same person and the split is not about seniority.
 *
 * `owner_accountant` was originally a narrow, largely read-only finance role.
 * That never matched the academy: the owner is also its accountant, teaches
 * classes, runs admissions and staffs reception, and a role that made her
 * switch accounts to do her own job was a description of the software, not of
 * the business. The Owner now holds every capability except the system-level
 * ones in ADMINISTRATOR_ONLY_CAPABILITIES — configuration, role definitions,
 * security policy, database restore/erase and audit-log destruction. She can
 * read the audit log; she cannot rewrite it. This is a business-rule change,
 * approved as such, not a fix.
 *
 * The Owner's `user.*` grant is not "every account except Administrator's
 * data" — it is specifically **account-scoped**: she may create, edit and
 * deactivate Owner, Teacher & Reception and Viewer accounts freely, exactly
 * as an Administrator could. The one thing she may not do is touch anything
 * where an *Administrator account* is on the other end — create one, promote
 * someone into the role, or edit/deactivate an existing one. The restriction
 * is keyed on the account's role, never on the actor's own role being Owner;
 * see requireRoleAssignable()/requireRoleManagement() in settings.service.js
 * and the /users rules in firestore.rules, both of which test
 * `role == 'administrator'` and nothing broader.
 *
 * `teacher_reception` and `viewer` are untouched by that change, and are the
 * roles future teachers and observers get.
 */
export const ROLES = Object.freeze({
    administrator: {
        label: 'Administrator',
        description: 'Highest system authority — configuration, role definitions, security policy, database restore and every module.',
        capabilities: ALL_CAPS
    },
    owner_accountant: {
        label: 'Owner & Accountant',
        description: 'Highest business authority — runs the academy day to day: students, teaching, admissions, money, staff, users, reports, backups and Business Settings. Not System Settings, and never an Administrator account.',
        capabilities: OWNER_CAPABILITIES
    },
    teacher_reception: {
        label: 'Teacher & Reception',
        description: 'Academic operations: admissions, students, attendance, fee collection, batches and programmes.',
        capabilities: [
            CAPABILITIES.STUDENT_VIEW, CAPABILITIES.STUDENT_EDIT,
            CAPABILITIES.ADMISSION_VIEW, CAPABILITIES.ADMISSION_EDIT, CAPABILITIES.ADMISSION_APPROVE,
            CAPABILITIES.ATTENDANCE_VIEW, CAPABILITIES.ATTENDANCE_MARK,
            CAPABILITIES.FEE_VIEW, CAPABILITIES.FEE_COLLECT,
            CAPABILITIES.PROGRAM_VIEW, CAPABILITIES.PROGRAM_EDIT,
            CAPABILITIES.REPORT_VIEW, CAPABILITIES.REPORT_EXPORT
            /*
             * NO staff.view — UAT6 ENH-601.
             *
             * Staff management is an administrative function. A teacher or a
             * receptionist has no business opening the roll of employees,
             * their wage bill or their end-of-employment history, and the
             * screen offered all three. Dropping the capability is the whole
             * fix: js/config/navigation.js gates the entry on it, so the item
             * disappears from the menu, and router.js checks the same string
             * before it loads a page, so typing /staff into the address bar is
             * refused too.
             *
             * This does NOT take teacher NAMES away from them. Batches,
             * Timetable, Attendance and Programmes read staff through
             * staff.service.js, which requires staff.edit for writes and
             * nothing at all for reads — so the teacher picker on a batch and
             * the teacher dashboard both keep working. The Firestore rule for
             * /staff is unchanged and deliberately so, for the same reason.
             */
        ]
    },
    viewer: {
        label: 'Viewer',
        description: 'Read-only across the operational modules — students, admissions, attendance, fees, finance, programmes and reports. No edits, approvals, collections or exports, and no Staff (UAT6 ENH-601).',
        capabilities: [
            CAPABILITIES.STUDENT_VIEW, CAPABILITIES.ADMISSION_VIEW, CAPABILITIES.ATTENDANCE_VIEW,
            CAPABILITIES.FEE_VIEW, CAPABILITIES.FINANCE_VIEW,
            CAPABILITIES.PROGRAM_VIEW, CAPABILITIES.REPORT_VIEW, CAPABILITIES.SETTINGS_VIEW
        ]
    }
});

/* ==========================================================================
   NAVIGATION
   --------------------------------------------------------------------------
   Deliberately NOT defined here. Each app (natyam-admin / natyam-mobile) has
   its own navigation/route table in js/config/navigation.js, tailored to
   its own module set and navigation pattern (grouped sidebar vs. bottom
   nav + more-menu) rather than sharing one array — see MIGRATION_CHECKLIST.md.
   Every item in either app's navigation.js still gates through the shared
   CAPABILITIES strings declared above, so permission logic stays identical.
   ========================================================================== */

/* ==========================================================================
   REFERENCE-DATA RESOLUTION SEAM
   --------------------------------------------------------------------------
   Two pieces of structural reference data — the curriculum ladder (LEVELS) and
   the role → capability matrix (ROLES) — are defined above as frozen defaults.
   A confirmed business decision makes both of these editable by the school in a
   later phase, with the edits persisted to the database.

   Rather than have that later change hunt down every reader of LEVELS and ROLES,
   all resolution now flows through the accessors below. Today they return the
   frozen defaults unchanged, so behaviour is identical; when a later phase loads
   overrides from the database it calls configureCurriculum()/configureRoles()
   once at boot and every consumer follows without further edits.

   The frozen tables remain the source of truth until an override is installed,
   and remain the fallback if one is ever cleared. Nothing mutates the frozen
   objects themselves — the overrides are held in these private slots.
   ========================================================================== */

let _curriculumOverride = null;
let _rolesOverride = null;
let _programTypesOverride = null;
let _expenseCategoriesOverride = null;

/** Install a database-sourced curriculum. Pass null/empty to fall back to LEVELS. */
export function configureCurriculum(levels) {
    _curriculumOverride = Array.isArray(levels) && levels.length ? levels : null;
}

/** Install a database-sourced role matrix. Pass null/empty to fall back to ROLES. */
export function configureRoles(roles) {
    _rolesOverride = roles && typeof roles === 'object' && Object.keys(roles).length ? roles : null;
}

/** Install school-defined programme types. Pass null/empty to fall back. */
export function configureProgramTypes(types) {
    _programTypesOverride = Array.isArray(types) && types.length ? types : null;
}

/** Install school-defined expense categories. Pass null/empty to fall back. */
export function configureExpenseCategories(categories) {
    _expenseCategoriesOverride = Array.isArray(categories) && categories.length ? categories : null;
}

/** The active programme types — Settings when configured, otherwise the defaults. */
export function programTypes() {
    return _programTypesOverride || PROGRAM_TYPES;
}

/** The active expense categories — Settings when configured, otherwise the defaults. */
export function expenseCategories() {
    return _expenseCategoriesOverride || EXPENSE_CATEGORIES;
}

/** The active curriculum ladder — the override when present, otherwise the frozen default. */
export function curriculum() {
    return _curriculumOverride || LEVELS;
}

/** The active role matrix — the override when present, otherwise the frozen default. */
export function roleTable() {
    return _rolesOverride || ROLES;
}

/**
 * Capabilities granted to a role, resolved through the active matrix and with
 * any retired capability string expanded to its replacements
 * (CAPABILITY_ALIASES). The built-in table never contains an alias, so this
 * only ever does work for a database-stored or restored matrix.
 */
export function roleCapabilities(roleKey) {
    const granted = roleTable()[roleKey]?.capabilities || [];
    if (!granted.some((cap) => cap in CAPABILITY_ALIASES)) return granted;

    return [...new Set(granted.flatMap((cap) => CAPABILITY_ALIASES[cap] || [cap]))];
}

/** Display label for a role, resolved through the active matrix. */
export function roleLabel(roleKey) {
    return roleTable()[roleKey]?.label || null;
}

/**
 * The display name for a level value.
 *
 * Six services had defined this privately against the same LEVELS table two
 * imports away, and they had already drifted: three different fallbacks for an
 * unrecognised value ('—', the raw value, and 'an unknown level'), so the same
 * missing level read differently depending on which screen showed it. The
 * fallback is now an argument, because a table cell and a sentence genuinely
 * want different things.
 *
 * Resolves through curriculum() rather than the frozen LEVELS directly, so a
 * later editable-curriculum phase relabels every screen through this one point.
 */
export function levelLabel(value, fallback = null) {
    return curriculum().find((l) => l.value === value)?.label || value || fallback;
}

/** Milestone B1 (multi-level batches) — a batch's levelsOf() array, joined for display. */
export function levelsLabel(values) {
    return (values || []).map((v) => levelLabel(v)).join(', ');
}

/**
 * Milestone B1 — a batch now teaches a *set* of levels, not one. Reads
 * defensively: a batch document saved before this milestone still only
 * carries the old single `level` field, and keeps working as a one-level
 * batch until it's next edited and saved (which writes `levels` going
 * forward) — no forced data migration for the handful of existing batches.
 * Lives here, not in batches.service.js, so both batches.service.js and
 * students.service.js can import it without creating a cycle between them
 * (batches.service.js already imports batchScheduleOf() from
 * students.service.js).
 */
export function levelsOf(batch) {
    if (Array.isArray(batch?.levels)) return batch.levels;
    return batch?.level ? [batch.level] : [];
}

/**
 * Every store name, derived from SCHEMA rather than written out again.
 * Kept even though js/core/db.js (IndexedDB) is not part of this app —
 * still read by anything that iterates "every entity" generically.
 */
export const STORE_NAMES = Object.freeze(Object.keys(SCHEMA.stores));

export const PREFERENCE_DEFAULTS = Object.freeze({
    theme: 'system',          // system | light | dark
    density: 'comfortable',   // compact | comfortable | spacious
    sidebar: 'expanded',      // expanded | collapsed
    pageSize: 25,
    activeBranchId: null
});
