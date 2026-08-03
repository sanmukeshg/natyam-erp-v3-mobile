/**
 * Session.
 *
 * Holds who is using the app and which branch they are looking at. Both are
 * needed synchronously in a great many places — every repository write stamps
 * an actor, every query scopes to a branch — so this is a plain synchronous
 * object hydrated once at boot.
 *
 * Identity is real now: Firebase Authentication (Google Sign-In) verifies
 * who is signing in, and firestore.rules enforces who may read or write a
 * `users` document server-side — not just this object's in-memory checks.
 * That said, role-based capability gating (`can()`, below) is still only
 * enforced *here*, client-side, for every module still on IndexedDB — a
 * teacher's screen has no Finance link, but nothing stops a determined
 * person from editing this object in devtools for those modules. As more of
 * the app moves to Firestore, its rules become the real boundary for that
 * data too; until then, this remains an operational convenience for
 * anything not yet migrated, not a security guarantee for it.
 */

import { roleCapabilities, roleLabel as resolveRoleLabel, PREFERENCE_DEFAULTS } from '../config/app.config.js';
import { bus, EVENTS } from './bus.js';

const STORAGE_KEY = 'natyam.session';

class Session {
    constructor() {
        this.user = null;
        this.branches = [];
        this.activeBranchId = null;
        this._capabilities = new Set();
        this._lastActivityAt = 0;
    }

    /** Called once during boot, after branches and users are loaded. */
    hydrate({ user, branches, activeBranchId }) {
        this.user = user;
        this.branches = branches || [];

        // No explicit or remembered choice, or a remembered branch that no
        // longer exists (e.g. after a restore changed the branch set), lands
        // on null — "All branches" — never silently narrows to branches[0].
        // Every role can already choose "All branches" from the switcher
        // (shell.js) — defaulting away from it here was a real, user-visible
        // bug: a fresh session (or one after "Erase everything"/a restore
        // clears the stored choice) always looked scoped to whichever
        // branch happened to sort first, not "all of them."
        const remembered = this._readStored().activeBranchId;
        const candidate = activeBranchId || remembered || null;
        this.activeBranchId = candidate && this.branches.some((b) => b.id === candidate) ? candidate : null;

        this._capabilities = new Set(roleCapabilities(user?.role));
        this._lastActivityAt = Date.now();
        this._persist();
    }

    /* ----------------------------------------------------- AUTHENTICATION */

    /**
     * Whether someone is currently signed in. Firebase Authentication owns
     * the actual session — its own persisted, auto-refreshing token — so
     * this is just "has hydrate() run for a real user". app.js sets this by
     * calling hydrate() when Firebase reports a signed-in, provisioned user,
     * and destroySession() when it reports signed-out or an idle timeout.
     */
    isAuthenticated() {
        return this.user !== null;
    }

    /**
     * Idle timeout is an app-level feature layered on top of Firebase Auth
     * (which has no built-in idle expiry). Kept in memory only — closing and
     * reopening the tab resumes Firebase's own session and starts a fresh
     * idle window, which is the behaviour a returning user expects.
     */
    touch() {
        if (this.isAuthenticated()) this._lastActivityAt = Date.now();
    }

    isIdleFor(timeoutMs) {
        return this.isAuthenticated() && (Date.now() - this._lastActivityAt) > timeoutMs;
    }

    /** Clears local identity. Preferences (theme, density, …) are left alone. */
    destroySession() {
        this.user = null;
        this.branches = [];
        this.activeBranchId = null;
        this._capabilities = new Set();
    }

    /* ------------------------------------------------------------- IDENTITY */

    actorId()   { return this.user?.id || 'system'; }
    actorName() { return this.user?.name || 'System'; }
    // Fails secure: no hydrated user means no role, not the most-privileged
    // one. can() never depended on this and already fails closed on its own;
    // this only matters to code that reads role() directly (roleLabel()
    // below, and dashboard.page.js's teacher-mode check), and null cannot be
    // mistaken for any real role by either.
    role()      { return this.user?.role || null; }
    roleLabel() { return resolveRoleLabel(this.role()) || 'User'; }

    /* ----------------------------------------------------------- CAPABILITY */

    /** `can('fee.collect')`. A null or undefined capability is always allowed. */
    can(capability) {
        if (!capability) return true;
        return this._capabilities.has(capability);
    }

    canAny(...capabilities) { return capabilities.some((c) => this.can(c)); }
    canAll(...capabilities) { return capabilities.every((c) => this.can(c)); }

    /** Throws with a message meant for a person, not a log. */
    require(capability, action = 'do that') {
        if (this.can(capability)) return;
        throw new Error(`Your role (${this.roleLabel()}) cannot ${action}. Ask an administrator for access.`);
    }

    /* --------------------------------------------------------------- BRANCH */

    /**
     * The active branch **id**, or null for "all branches".
     *
     * This returns the id rather than the record because that is what every
     * caller needs: services take a branchId, and the whole application passes
     * this straight through as a scope argument. An earlier version returned
     * the record, which meant every call site wrote `session.branch().id` and
     * crashed the moment "all branches" was selected and the record was null.
     */
    branch() {
        return this.activeBranchId;
    }

    /** The active branch record, when the name or address is actually needed. */
    branchRecord() {
        return this.branches.find((b) => b.id === this.activeBranchId) || null;
    }

    branchName() { return this.branchRecord()?.name || 'All branches'; }

    setBranch(branchId) {
        if (branchId === this.activeBranchId) return;
        if (branchId !== null && !this.branches.some((b) => b.id === branchId)) return;
        this.activeBranchId = branchId;
        this._persist();
        bus.emit(EVENTS.BRANCH_CHANGED, { branchId, branch: this.branchRecord() });
    }

    /**
     * Standard scope predicate. A branch of null means "all branches" — who
     * may select that is a capability check elsewhere (shell.js), not a
     * role check here.
     */
    scopeFilter() {
        const id = this.activeBranchId;
        return (record) => id === null || record.branchId === id;
    }

    /* ---------------------------------------------------------- PERSISTENCE */

    /**
     * Preferences live in localStorage rather than IndexedDB deliberately:
     * they are needed to paint the first frame (theme, density, sidebar), and
     * waiting on an async database open there causes a visible flash of the
     * wrong theme.
     */
    prefs() {
        return { ...PREFERENCE_DEFAULTS, ...this._readStored().prefs };
    }

    setPref(key, value) {
        const stored = this._readStored();
        stored.prefs = { ...stored.prefs, [key]: value };
        this._write(stored);
        bus.emit(EVENTS.PREFS_CHANGED, { key, value });
    }

    _readStored() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    _write(value) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        } catch {
            // Private mode or a full quota. Preferences are a convenience;
            // losing them must never stop the app.
        }
    }

    _persist() {
        const stored = this._readStored();
        stored.activeBranchId = this.activeBranchId;
        stored.userId = this.user?.id || null;
        this._write(stored);
    }
}

export const session = new Session();
