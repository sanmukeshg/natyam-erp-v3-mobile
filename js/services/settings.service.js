/**
 * NATYAM ERP 2.0 — Settings service
 *
 * Institute details, branches, academic years, fee plans, users and roles.
 * These are the records everything else points at, which makes them the ones
 * where a careless delete does the most damage — so almost every operation
 * here is a check that something is not still in use before allowing it to
 * change.
 *
 * Branch administration lives in this module rather than in a service of its
 * own. A branch has three operations — create, rename, deactivate — and one
 * interesting rule (you cannot close a branch with active students). A
 * separate file for that would be an empty ceremony; what matters is that the
 * rule exists and lives in the service layer.
 */

import { bus, EVENTS } from '../core/bus.js';
import { session } from '../core/session.js';
import { localDate } from '../utils/date.js';
import { toAmount } from '../utils/money.js';
import { CAPABILITIES, ADMINISTRATOR_ONLY_CAPABILITIES, PREFERENCE_DEFAULTS, curriculum, levelLabel, levelsOf, roleTable, roleCapabilities, roleLabel, configureCurriculum, configureRoles, configureProgramTypes, configureExpenseCategories, programTypes, expenseCategories, DEFAULT_FEE_FREQUENCY, feeFrequency } from '../config/app.config.js';
import {
    settings$, branches$, academicYears$, feePlans$, users$, students$, staff$, batches$, invoices$,
    programs$, expenses$, branchIdsOf
} from '../data/repositories.js';
import { provisionEmailPasswordUser } from './auth.service.js';

/** The only sign-in methods NATYAM knows about — kept in one place so a typo in a form value fails loudly, not silently. */
const KNOWN_AUTH_METHODS = ['password', 'google', 'mobile'];

/* ==========================================================================
   INSTITUTE
   ========================================================================== */

const INSTITUTE_DEFAULTS = {
    name: 'NATYAM — School of Kuchipudi',
    tagline: 'Classical Kuchipudi, taught in the traditional guru-shishya parampara',
    principal: '',
    email: '',
    phone: '',
    address: '',
    website: '',
    gstin: '',
    logo: null
};

export async function institute() {
    const stored = await settings$.get('institute', {});
    return { ...INSTITUTE_DEFAULTS, ...stored };
}

export async function updateInstitute(changes) {
    session.require('settings.edit', 'change the institute details');

    const current = await institute();
    const next = { ...current, ...changes };

    if (!next.name?.trim()) throw new Error('The school needs a name — it appears on every receipt and certificate.');
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(next.email)) throw new Error('That email address does not look right.');

    await settings$.set('institute', next);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'institute', value: next });
    return next;
}

/** Arbitrary key/value settings — opening balance, fee reminders, and so on. */
export async function getSetting(key, fallback = null) {
    return settings$.get(key, fallback);
}

export async function setSetting(key, value) {
    session.require('settings.edit', 'change a setting');
    await settings$.set(key, value);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key, value });
    return value;
}

/**
 * Settings keys under which the school's edited curriculum ladder and role
 * matrix are stored once those editors exist. Named here so the future editor
 * and this loader can never disagree on the key.
 */
const STRUCTURAL_OVERRIDE_KEYS = Object.freeze({
    curriculum: 'curriculum.override',
    roles: 'roles.override',
    programTypes: 'programTypes.override',
    expenseCategories: 'expenseCategories.override'
});

/**
 * Installs any database-stored curriculum/role overrides into the resolution
 * seam in app.config, once, at boot — before the session hydrates, so a
 * customised matrix already governs capability gating.
 *
 * No override has been written yet, so both reads return null and this is a
 * genuine no-op that leaves the frozen defaults in force. A malformed override
 * must never brick start-up, so failures fall back to defaults with a warning
 * rather than propagating.
 */
export async function applyStructuralOverrides() {
    try {
        const [levels, roles, types, categories] = await Promise.all([
            getSetting(STRUCTURAL_OVERRIDE_KEYS.curriculum, null),
            getSetting(STRUCTURAL_OVERRIDE_KEYS.roles, null),
            getSetting(STRUCTURAL_OVERRIDE_KEYS.programTypes, null),
            getSetting(STRUCTURAL_OVERRIDE_KEYS.expenseCategories, null)
        ]);
        configureCurriculum(levels);
        configureRoles(roles);
        configureProgramTypes(types);
        configureExpenseCategories(categories);
    } catch (err) {
        console.warn('Could not load structural overrides; using built-in defaults.', err);
        configureCurriculum(null);
        configureRoles(null);
        configureProgramTypes(null);
        configureExpenseCategories(null);
    }
}

/* ==========================================================================
   MASTER DATA
   Settings is the single source of truth for the values the rest of the
   application offers in its pickers. Each set is stored as an ordered list of
   { value, label, status }; readers resolve through the config accessors, so a
   module never needs to know whether a value came from Settings or the shipped
   default. Nothing here is hardcoded in a module.
   ========================================================================== */

/** The four sets an administrator maintains, and how each is persisted. */
export const MASTER_SETS = Object.freeze({
    levels:            { key: STRUCTURAL_OVERRIDE_KEYS.curriculum,        label: 'Levels / Qualifications' },
    programTypes:      { key: STRUCTURAL_OVERRIDE_KEYS.programTypes,      label: 'Programme types' },
    expenseCategories: { key: STRUCTURAL_OVERRIDE_KEYS.expenseCategories, label: 'Expense categories' }
});

/** Normalises whatever shape a set is stored in into { value, label, status, order }. */
function asEntries(list) {
    return (list || []).map((item, index) => (typeof item === 'string'
        ? { value: item, label: item, status: 'active', order: index + 1 }
        : {
            value: item.value ?? item.label,
            label: item.label ?? item.value,
            status: item.status || 'active',
            order: item.order ?? index + 1,
            ...(item.years !== undefined ? { years: item.years } : {}),
            ...(item.description !== undefined ? { description: item.description } : {})
        }))
        .sort((a, b) => a.order - b.order);
}

/** Current entries for a set, falling back to the shipped defaults. */
export async function listMasterSet(setName, { includeInactive = true } = {}) {
    const config = MASTER_SETS[setName];
    if (!config) throw new Error(`Unknown master data set: ${setName}`);

    const stored = await getSetting(config.key, null);
    const fallback = setName === 'levels' ? curriculum()
        : setName === 'programTypes' ? programTypes()
        : expenseCategories();

    const entries = asEntries(stored || fallback);
    return includeInactive ? entries : entries.filter((e) => e.status === 'active');
}

/** Writes a set back and re-installs it so every reader sees it immediately. */
async function saveMasterSet(setName, entries) {
    session.require('settings.edit', 'edit master data');
    const config = MASTER_SETS[setName];
    const ordered = entries.map((entry, index) => ({ ...entry, order: index + 1 }));

    await setSetting(config.key, ordered);
    await applyStructuralOverrides();
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: config.key, value: ordered });
    return ordered;
}

export async function addMasterEntry(setName, { value, label }) {
    const entries = await listMasterSet(setName);
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) throw new Error('A name is required.');
    const cleanValue = String(value || cleanLabel).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (entries.some((e) => e.value === cleanValue)) throw new Error(`"${cleanLabel}" is already on the list.`);
    return saveMasterSet(setName, [...entries, { value: cleanValue, label: cleanLabel, status: 'active' }]);
}

export async function updateMasterEntry(setName, value, changes) {
    const entries = await listMasterSet(setName);
    if (!entries.some((e) => e.value === value)) throw new Error('That entry no longer exists.');
    return saveMasterSet(setName, entries.map((entry) => (entry.value === value
        ? { ...entry, ...changes, value: entry.value }   // the stored value never changes
        : entry)));
}

export async function setMasterEntryStatus(setName, value, status) {
    return updateMasterEntry(setName, value, { status });
}

/**
 * Removes an entry. Refuses when records still carry the value, because
 * deleting it would leave those records pointing at something that no longer
 * exists — deactivating hides it from new use while keeping history readable.
 */
export async function deleteMasterEntry(setName, value) {
    const inUse = await masterEntryUsage(setName, value);
    if (inUse > 0) {
        throw new Error(`${inUse} record${inUse === 1 ? '' : 's'} still use this. Deactivate it instead — `
            + 'it will stop being offered but existing records stay readable.');
    }
    const entries = await listMasterSet(setName);
    return saveMasterSet(setName, entries.filter((entry) => entry.value !== value));
}

export async function moveMasterEntry(setName, value, direction) {
    const entries = await listMasterSet(setName);
    const index = entries.findIndex((e) => e.value === value);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= entries.length) return entries;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    return saveMasterSet(setName, next);
}

/** How many live records depend on a master value. */
export async function masterEntryUsage(setName, value) {
    if (setName === 'levels') {
        const [studentRows, batchRows] = await Promise.all([students$.all(), batches$.all()]);
        return studentRows.filter((r) => r.level === value).length
            + batchRows.filter((r) => levelsOf(r).includes(value)).length;
    }
    if (setName === 'programTypes') {
        return (await programs$.all()).filter((p) => p.type === value).length;
    }
    if (setName === 'expenseCategories') {
        return (await expenses$.all()).filter((e) => e.category === value).length;
    }
    return 0;
}

/* ==========================================================================
   BRANCHES
   ========================================================================== */

export async function listBranches({ includeInactive = false } = {}) {
    const rows = includeInactive ? await branches$.all() : await branches$.active();
    const [students, staffRows, batchRows] = await Promise.all([
        students$.active(), staff$.activeStaff(), batches$.active()
    ]);

    return rows.map((branch) => ({
        ...branch,
        studentCount: students.filter((s) => s.branchId === branch.id).length,
        staffCount: staffRows.filter((s) => branchIdsOf(s).includes(branch.id)).length,
        batchCount: batchRows.filter((b) => b.branchId === branch.id).length
    }));
}

export async function createBranch(data) {
    session.require('settings.edit', 'add a branch');

    const record = {
        ...data,
        name: String(data.name || '').trim(),
        code: String(data.code || '').trim().toUpperCase(),
        status: 'active'
    };

    if (!record.name) throw new Error('A branch needs a name.');
    if (!record.code) throw new Error('A branch needs a short code, e.g. HYD-C.');

    const clash = (await branches$.all()).find((b) => b.code === record.code);
    if (clash) throw new Error(`The code ${record.code} is already used by ${clash.name}.`);

    const branch = await branches$.create(record);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'branches', value: branch });
    return branch;
}

export async function updateBranch(id, changes) {
    session.require('settings.edit', 'edit a branch');
    const branch = await branches$.update(id, changes);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'branches', value: branch });
    return branch;
}

/**
 * Closes a branch. Refuses while anything still points at it — a branch with
 * active students is a branch that is still open, whatever the record says.
 */
export async function closeBranch(id, { reason }) {
    session.require('settings.edit', 'close a branch');

    if (!reason?.trim()) throw new Error('Record why the branch is closing.');
    const branch = await branches$.findOrFail(id);

    const [students, staffRows, batchRows] = await Promise.all([
        students$.active(id), staff$.activeStaff(id), batches$.active(id)
    ]);

    const blockers = [];
    if (students.length) blockers.push(`${students.length} active student${students.length === 1 ? '' : 's'}`);
    if (staffRows.length) blockers.push(`${staffRows.length} staff member${staffRows.length === 1 ? '' : 's'}`);
    if (batchRows.length) blockers.push(`${batchRows.length} active batch${batchRows.length === 1 ? '' : 'es'}`);

    if (blockers.length) {
        throw new Error(`${branch.name} still has ${blockers.join(', ')}. Move or close them before closing the branch.`);
    }

    const closed = await branches$.update(id, { status: 'inactive', closedOn: localDate(), closeReason: reason.trim() });
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'branches', value: closed });
    return closed;
}

/* ==========================================================================
   ACADEMIC YEARS
   ========================================================================== */

/**
 * Academic years, newest first.
 *
 * The field names here are `label`, `startsOn`, `endsOn` and `isCurrent`,
 * which is what the schema indexes, the repository queries and the seed writes.
 * This service had been reading `startDate`/`endDate` and writing `name`/
 * `current` — three different vocabularies for one record — so listing the
 * years threw on a field that never existed and the whole screen was dead.
 */
export async function listAcademicYears() {
    return (await academicYears$.all())
        .sort((a, b) => (b.startsOn || '').localeCompare(a.startsOn || ''));
}

export async function createAcademicYear(data) {
    session.require('settings.edit', 'add an academic year');

    if (!data.label?.trim()) throw new Error('Name the academic year, e.g. 2026–27.');
    if (!data.startsOn || !data.endsOn) throw new Error('Give the start and end dates.');
    if (data.endsOn <= data.startsOn) throw new Error('The year cannot end before it starts.');

    const overlapping = (await academicYears$.all()).find((y) =>
        data.startsOn <= y.endsOn && y.startsOn <= data.endsOn);
    if (overlapping) throw new Error(`That overlaps with ${overlapping.label}.`);

    const created = await academicYears$.create({
        ...data,
        label: data.label.trim(),
        isCurrent: 0
    });

    // The switch on the form is a request to make it current, and that has to
    // go through makeCurrent so exactly one year holds the flag.
    if (data.makeCurrent) return academicYears$.makeCurrent(created.id);
    return created;
}

/** Makes a year current. The repository does the swap atomically. */
export async function setCurrentYear(id) {
    session.require('settings.edit', 'change the current academic year');
    const year = await academicYears$.makeCurrent(id);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'academicYear', value: year });
    return year;
}

/* ==========================================================================
   FEE PLANS
   --------------------------------------------------------------------------
   1.0 could create fee structures but never edit them, so a price rise meant
   creating a parallel plan and hoping the right one got picked. Editing is
   allowed here, with the one guard that matters: changing a plan does not
   touch invoices already raised from it.
   ========================================================================== */

export async function listFeePlans({ includeInactive = false } = {}) {
    const rows = includeInactive ? await feePlans$.all() : await feePlans$.active();
    const counts = await Promise.all(rows.map((plan) => feePlans$.usageCount(plan.id)));

    return rows.map((plan, i) => ({
        ...plan,
        levelLabel: levelLabel(plan.level, 'Any level'),
        inUse: counts[i],
        frequencyLabel: feeFrequency(plan.frequency).label
        // No yearly figure is derived — the academy bills per cycle only, and a
        // projected annual total was being read as money owed.
    })).sort((a, b) => (a.levelOrder || 0) - (b.levelOrder || 0) || a.name.localeCompare(b.name));
}

export async function createFeePlan(data) {
    session.require('settings.edit', 'create a fee plan');
    return feePlans$.create(normalisePlan(data));
}

/**
 * Edits a fee plan. Invoices already raised keep the amounts they were raised
 * with — a bill the family has already been given does not change because the
 * price list did. The caller is told how many students are affected going
 * forward.
 */
export async function updateFeePlan(id, changes) {
    session.require('settings.edit', 'edit a fee plan');

    const existing = await feePlans$.findOrFail(id);
    const plan = await feePlans$.update(id, normalisePlan({ ...existing, ...changes }));
    const affected = await feePlans$.usageCount(id);

    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'feePlans', value: plan });
    return { plan, affected };
}

/** Retires a plan. Students already on it keep their existing invoices. */
/**
 * Removes a fee plan outright. Retiring left inactive plans cluttering the
 * list with no way to clear them; a plan that was created by mistake should be
 * gone. Invoices already raised are untouched — they carry their own amounts —
 * and any student still pointing at the plan is unlinked so nothing references
 * a row that no longer exists.
 */
export async function deleteFeePlan(id) {
    session.require('settings.edit', 'delete a fee plan');

    const plan = await feePlans$.findOrFail(id);
    // students has no feePlanId index, so scan rather than index-lookup.
    const assigned = (await students$.all()).filter((student) => student.feePlanId === id);
    for (const student of assigned) {
        await students$.update(student.id, { feePlanId: null });
    }
    await feePlans$.remove(id, { hard: true });

    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'feePlans', value: null });
    return { plan, unlinked: assigned.length };
}

function normalisePlan(data) {
    // The form supplies `amount` in paise. A plan written before the monthly
    // change is read through its yearly figure so an edit never zeroes it.
    const supplied = data.amount != null
        ? data.amount
        : (data.annualAmount != null ? Math.round(Number(data.annualAmount) / 12) : 0);
    const amount = toAmount(supplied);
    const record = {
        ...data,
        name: String(data.name || '').trim(),
        frequency: data.frequency || DEFAULT_FEE_FREQUENCY,
        amount: Math.round(amount),
        registrationFee: Math.round(Number(data.registrationFee) || 0),
        costumeFee: Math.round(Number(data.costumeFee) || 0),
        levelOrder: curriculum().find((l) => l.value === data.level)?.order || 0,
        status: data.status || 'active'
    };

    if (!record.name) throw new Error('A fee plan needs a name.');
    if (record.amount <= 0) throw new Error('The monthly fee must be more than zero.');
    if (!feeFrequency(record.frequency)) throw new Error('That fee frequency is not recognised.');
    return record;
}

/* ==========================================================================
   USERS AND ROLES
   --------------------------------------------------------------------------
   Worth being honest about what this is. There is no server, so these roles
   are an *operational* boundary, not a security one: they decide which
   buttons a receptionist sees, and they stop an accountant from accidentally
   deleting a student. Anyone with the browser's developer tools can bypass
   them entirely. Presenting them as security would be a lie that leads a
   school to store things here it should not.
   ========================================================================== */

export async function listUsers() {
    const rows = await users$.all();
    return rows.map((user) => ({
        ...user,
        roleLabel: roleLabel(user.role) || user.role,
        capabilities: roleCapabilities(user.role)
    }));
}

/**
 * The one guardrail that makes ADMINISTRATOR_ONLY_CAPABILITIES mean anything.
 *
 * The Owner may create users and assign existing roles — but if she could
 * assign `administrator`, every permission reserved to Administrator would be
 * one click away from being self-granted, and the reservation would be
 * decoration. Minting or altering an Administrator therefore needs
 * `role.manage`: Administrator alone. Enforced again server-side in
 * firestore.rules (the /users create and update rules).
 */
function requireRoleManagement(action) {
    if (session.can(CAPABILITIES.ROLE_MANAGE)) return;
    throw new Error(`Your role (${session.roleLabel()}) cannot ${action}. Only an Administrator can.`);
}

/** Assigning `administrator` is itself an Administrator-only act. */
function requireRoleAssignable(role) {
    if (role === 'administrator') requireRoleManagement('grant the Administrator role');
}

export async function createUser(data) {
    session.require(CAPABILITIES.USER_CREATE, 'add a user');
    requireRoleAssignable(data.role);

    // No default injected here — an Administrator must explicitly choose at
    // least one sign-in method for every account; there is no "assume
    // Google" fallback anywhere in this milestone (see
    // js/migrations/authMethodsMigration.js's header for why).
    const authMethods = Array.isArray(data.authMethods) ? data.authMethods : [];
    if (!authMethods.length) throw new Error('Choose at least one sign-in method.');
    const unknown = authMethods.find((m) => !KNOWN_AUTH_METHODS.includes(m));
    if (unknown) throw new Error(`"${unknown}" is not a recognised sign-in method.`);

    const record = {
        ...data,
        name: String(data.name || '').trim(),
        email: data.email?.trim().toLowerCase() || null,
        role: data.role,
        status: 'active',
        authMethods
    };
    delete record.password;

    if (!record.name) throw new Error('A user needs a name.');
    if (!record.role || !roleTable()[record.role]) throw new Error('Choose a valid role.');

    const clash = record.email && (await users$.all()).find((u) => u.email === record.email);
    if (clash) throw new Error(`${clash.name} already uses that email address.`);

    if (authMethods.includes('mobile') && !record.mobile) {
        throw new Error('A mobile number is required for Mobile OTP sign-in.');
    }

    // Mobile numbers are unique across the whole system — Mobile OTP
    // resolves an incoming identity by phone number alone (findByMobile()),
    // so two active accounts sharing one number would make that resolution
    // ambiguous, not just untidy.
    if (record.mobile) {
        const mobileClash = await users$.findByMobile(record.mobile);
        if (mobileClash) throw new Error(`${mobileClash.name} already uses that mobile number.`);
    }

    // Google self-provisions its own Firebase Auth identity on first sign-in
    // (nothing to create here). Email/Password needs its Firebase Auth
    // credential created explicitly, and before the Firestore document
    // below — a failed Auth creation must never leave an orphaned
    // authorization record with no way to actually sign in.
    if (authMethods.includes('password')) {
        if (!data.password) throw new Error('Set an initial password for this user.');
        if (!record.email) throw new Error('An email address is required for Email & Password sign-in.');
        await provisionEmailPasswordUser({ email: record.email, password: data.password });
    }

    return users$.create(record);
}

export async function updateUser(id, changes) {
    session.require(CAPABILITIES.USER_EDIT, 'edit a user');

    const existing = await users$.findOrFail(id);
    if (changes.role && !roleTable()[changes.role]) throw new Error('Choose a valid role.');

    if (changes.role && changes.role !== existing.role) {
        session.require(CAPABILITIES.USER_CHANGE_ROLE, 'change a user’s role');
        requireRoleAssignable(changes.role);
    }
    // Editing anything at all on an existing Administrator's account is
    // Administrator-only, for the same reason as above — otherwise the role
    // could be left alone and the sign-in methods or email changed instead.
    if (existing.role === 'administrator') requireRoleManagement('edit an Administrator account');

    // Toggling which methods are *permitted* only — this never creates or
    // links a Firebase Auth credential. Adding "password" here to an
    // existing Google-only account permits it once a credential exists for
    // that email (created at initial provisioning, or via account linking,
    // which is a future milestone, not this one) — it does not create one.
    if (changes.authMethods) {
        const unknown = changes.authMethods.find((m) => !KNOWN_AUTH_METHODS.includes(m));
        if (unknown) throw new Error(`"${unknown}" is not a recognised sign-in method.`);

        if (!changes.authMethods.length) {
            // The signed-in Administrator editing their own account gets a
            // message naming their own situation specifically — everyone
            // else gets the general rule. Both are the same underlying
            // "an account may never have zero sign-in methods" rule; only
            // the wording differs.
            if (id === session.actorId()) {
                throw new Error('At least one authentication method must remain enabled for your own account.');
            }
            throw new Error('Choose at least one sign-in method.');
        }

        if (changes.authMethods.includes('mobile') && !changes.mobile) {
            throw new Error('A mobile number is required for Mobile OTP sign-in.');
        }
    }

    // Same uniqueness rule as createUser() — checked here too since mobile
    // can change on an existing account, not just at creation.
    if ('mobile' in changes && changes.mobile) {
        const mobileClash = await users$.findByMobile(changes.mobile);
        if (mobileClash && mobileClash.id !== id) throw new Error(`${mobileClash.name} already uses that mobile number.`);
    }

    // The school must not be able to lock itself out of administration —
    // Administrator is the sole full-access role in the combined model
    // (Doc 10 §8), so it is the one role that can never drop to zero.
    if (existing.role === 'administrator' && changes.role && changes.role !== 'administrator') {
        const admins = (await users$.activeUsers()).filter((u) => u.role === 'administrator');
        if (admins.length <= 1) throw new Error('There must always be at least one Administrator.');
    }

    /*
     * Switching an account off through the EDIT FORM is still a deactivation.
     *
     * The form carries a Status field, so this path could set `inactive` while
     * knowing none of the rules the Deactivate button enforces — the last
     * Administrator could be switched off from here, locking everyone out, and
     * someone could sign themselves out permanently mid-session. Same
     * assertion, same wording, one definition.
     *
     * Only a real transition is checked. Re-saving an account that is already
     * inactive changes nothing and must not be refused, or an inactive user's
     * name could never be corrected.
     */
    if ('status' in changes && changes.status !== 'active' && existing.status === 'active') {
        await assertMayDeactivate(existing);
    }

    return users$.update(id, changes);
}

/**
 * The two rules that make an account safe to switch off.
 *
 * EXTRACTED SO BOTH PATHS SHARE THEM. They lived inside deactivateUser() and
 * guarded only the dedicated Deactivate action — but the Edit dialog also sets
 * `status`, routes through updateUser(), and knew nothing about either rule.
 * So an Administrator could set the only Administrator account to Inactive
 * from the edit form and lock the school out of its own system; the button
 * six inches away refused exactly that.
 *
 * One definition, called from both, is the only arrangement where they cannot
 * drift apart again — which is how this gap opened in the first place.
 *
 * @param {object} user  the account being switched off, already loaded.
 */
async function assertMayDeactivate(user) {
    session.require(CAPABILITIES.USER_DEACTIVATE, 'deactivate a user');

    if (user.role === 'administrator') {
        requireRoleManagement('deactivate an Administrator account');
        // Administrator is the sole full-access role, so it can never reach
        // zero — there would be no way back in.
        const admins = (await users$.activeUsers()).filter((u) => u.role === 'administrator');
        if (admins.length <= 1) throw new Error('The last Administrator account cannot be deactivated.');
    }

    if (user.id === session.actorId()) {
        throw new Error('You cannot deactivate the account you are signed in with.');
    }
}

export async function deactivateUser(id) {
    const user = await users$.findOrFail(id);
    await assertMayDeactivate(user);

    return users$.update(id, { status: 'inactive', deactivatedOn: localDate() });
}

/**
 * The role matrix, for the permissions screen.
 *
 * `key` is the constant name (STUDENT_VIEW), `label` the capability string
 * (student.view) — and the grant test has to compare against the *string*,
 * since that is what a role's `capabilities` array holds. It compared against
 * the constant name, so every cell in the matrix read "not allowed" for every
 * role, including Administrator. Found while verifying the Owner upgrade on
 * this very screen.
 *
 * `administratorOnly` marks the rows that are the whole difference between
 * Administrator and Owner, so the screen can say why rather than leaving a
 * reader to diff two columns of ticks by eye.
 */
export function roleMatrix() {
    const capabilities = Object.entries(CAPABILITIES).map(([key, label]) => ({
        key,
        label,
        administratorOnly: ADMINISTRATOR_ONLY_CAPABILITIES.includes(label)
    }));

    return {
        capabilities,
        roles: Object.entries(roleTable()).map(([value, role]) => ({
            value,
            label: role.label,
            description: role.description,
            grants: Object.fromEntries(capabilities.map((c) => [
                c.key,
                role.capabilities.includes('*') || roleCapabilities(value).includes(c.label)
            ]))
        }))
    };
}

/* ==========================================================================
   PREFERENCES
   ========================================================================== */

export function preferences() {
    return { ...PREFERENCE_DEFAULTS, ...session.prefs() };
}

export function setPreference(key, value) {
    if (!(key in PREFERENCE_DEFAULTS)) throw new Error(`"${key}" is not a known preference.`);
    session.setPref(key, value);
    return preferences();
}

/* Local browser-storage reporting (storageStatus/requestPersistence) was
   removed once every collection had moved to Firestore: a quota reading and
   a "the browser has promised to keep this data" prompt described an
   architecture the app no longer has, and the Settings > Data tab was
   presenting it as fact. The underlying db.usage()/db.requestPersistence()
   helpers went with them (js/core/db.js). */
