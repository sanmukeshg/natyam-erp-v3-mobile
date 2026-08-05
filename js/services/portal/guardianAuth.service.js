/**
 * NATYAM ERP 2.0 — Guardian (Parent/Student Portal) identity resolution
 *
 * A guardian has no `users` document and no role at all — their identity is
 * simply an authenticated Firebase user whose phone or email matches a
 * `guardianPhone`/`guardianEmail` already on file for one or more active
 * students. This is the deliberate design choice this milestone builds on:
 * see js/services/students.service.js's own header comment on why no
 * separate parent/guardian entity exists, and firestore.rules'
 * isGuardianOfStudent()/isGuardianOfStudentId() for the server-side
 * enforcement this mirrors — that file is the real security boundary; this
 * one only decides which UI (staff app vs. portal) a signed-in Firebase
 * user sees.
 *
 * Tried only as a fallback in js/app.js, after resolveProvisionedUser()
 * rejects an identity with `.code === 'not_provisioned'` (see
 * auth.service.js) — an archived/deactivated/method-not-permitted staff
 * account is a different, real rejection and must never be reinterpreted
 * as "maybe a guardian."
 */

import { students$ } from '../../data/repositories.js';
import { bus, EVENTS } from '../../core/bus.js';

/**
 * Every ACTIVE student whose guardianPhone/guardianEmail matches. Deliberately
 * not students.service.js's households() — that is a whole-school, unscoped
 * scan with no permission boundary. This queries only the caller's own
 * matching students, the same shape firestore.rules' guardian rules expect
 * (a single-field equality query on the exact field the rule compares).
 *
 * @param {string|null} phone  E.164, matching students.repository.firestore.js's normalisePhone().
 * @param {string|null} email
 * @returns {Promise<object[]>} matching, active student records (siblings included).
 */
async function guardianChildren(phone, email) {
    const [byPhone, byEmail] = await Promise.all([
        phone ? students$.whereActive('guardianPhone', phone) : Promise.resolve([]),
        email ? students$.whereActive('guardianEmail', email) : Promise.resolve([])
    ]);

    const seen = new Map();
    for (const student of [...byPhone, ...byEmail]) seen.set(student.id, student);
    return [...seen.values()];
}

/**
 * Resolves a verified Firebase identity to a guardian's own children, or
 * `null` if it matches no active student's guardian contact at all — the
 * caller (app.js) treats `null` the same as any other unrecognised
 * identity, not as an error.
 *
 * @param {{email?: string, phoneNumber?: string}} identity  Same normalised
 *   shape resolveProvisionedUser() takes — Google/Password identities carry
 *   `email`, Mobile OTP carries `phoneNumber`.
 */
export async function resolveGuardianIdentity(identity) {
    const phone = identity.phoneNumber || null;
    const email = identity.email || null;
    const students = await guardianChildren(phone, email);
    if (!students.length) return null;
    return { phone, email, students };
}

/**
 * Lightweight session state for a signed-in guardian — deliberately not
 * js/core/session.js's Session class, which is shaped entirely around a
 * staff role, capabilities and branches that don't apply here. Holds just
 * enough for PortalShell (whose children to show) and PortalRouter (whether
 * to keep letting them navigate).
 */
class GuardianSession {
    /**
     * The sentinel `activeChildId` meaning "all children at once". A string
     * rather than null so it can never collide with a real Firestore document
     * id, and so an unset session (null) stays distinguishable from a
     * deliberate All.
     */
    static ALL = '__all__';

    constructor() {
        this.phone = null;
        this.email = null;
        this.students = [];
        this.activeChildId = null;
    }

    hydrate({ phone, email, students }) {
        this.phone = phone || null;
        this.email = email || null;
        this.students = students || [];
        // A household with more than one child opens on "All": a parent of
        // four signing in wants the whole picture first, not whichever child
        // happened to sort first. A single-child family has nothing to
        // aggregate, so it opens on that child and the switcher is hidden.
        this.activeChildId = this.students.length > 1
            ? GuardianSession.ALL
            : (this.students[0]?.id || null);
    }

    isAuthenticated() {
        return this.students.length > 0;
    }

    destroySession() {
        this.phone = null;
        this.email = null;
        this.students = [];
        this.activeChildId = null;
    }

    child(studentId) {
        return this.students.find((s) => s.id === studentId) || null;
    }

    /** The single-child-scoped view every portal page reads from — every
     * page imports this instead of re-deriving "which child" itself, the
     * same way every staff page reads session.branch() rather than each
     * tracking its own copy.
     *
     * Returns null while "All children" is selected. Callers that genuinely
     * need one child should use selectedChildren() instead, which covers both
     * cases without a special branch. */
    activeChild() {
        if (this.showingAll()) return null;
        return this.child(this.activeChildId) || this.students[0] || null;
    }

    /**
     * "All children" — a real selection, not the absence of one.
     *
     * `activeChildId === ALL` rather than null, because null is also what a
     * freshly-hydrated session holds before anything is chosen, and the two
     * mean different things: one is "show me everyone", the other is "nothing
     * chosen yet, fall back to the first child". Conflating them made the
     * switcher unable to tell a deliberate All from a default.
     */
    showingAll() {
        return this.activeChildId === GuardianSession.ALL;
    }

    /**
     * The children every page should render — one, or all of them.
     *
     * This is the API the v3 portal pages read. A page that shows a single
     * child's record renders an array of one; a page showing All renders the
     * same markup per child. Neither has to ask which mode it is in, which is
     * what keeps "All" from becoming a branch in six different files.
     */
    selectedChildren() {
        if (this.showingAll()) return this.students;
        const one = this.activeChild();
        return one ? [one] : this.students;
    }

    setActiveChild(studentId) {
        if (studentId === this.activeChildId) return;
        // ALL is always valid; a specific id must belong to this guardian.
        if (studentId !== GuardianSession.ALL
            && !this.students.some((s) => s.id === studentId)) return;
        this.activeChildId = studentId;
        bus.emit(EVENTS.PORTAL_CHILD_CHANGED, { studentId });
    }

    /**
     * Re-checked by PortalRouter on every navigation (see js/core/router.js's
     * pluggable `revalidate`) — mirrors the staff router's own live-status
     * re-check, but re-confirms guardianship rather than looking up a
     * `users` doc that doesn't exist for this identity type. A student
     * graduating, being archived, or a guardian contact being corrected all
     * end an open portal session the same way a deactivated staff account
     * ends one.
     */
    async stillValid() {
        if (!this.isAuthenticated()) return false;
        const fresh = await guardianChildren(this.phone, this.email);
        if (!fresh.length) return false;
        this.students = fresh;
        return true;
    }
}

export const guardianSession = new GuardianSession();
