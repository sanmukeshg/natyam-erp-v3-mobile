/**
 * NATYAM ERP 2.0 — Users repository (Firestore)
 *
 * The first store to move off IndexedDB. Deliberately keeps the exact
 * external shape the old IndexedDB-backed UserRepository had
 * (find/findOrFail/all/create/update/remove/findByEmail) so every existing
 * caller — settings.service.js, audit.service.js, auth.service.js, app.js —
 * needed no changes beyond what was already planned.
 *
 * Documents are keyed by the person's normalised email address, not an
 * opaque id and not the Firebase Auth uid. Two reasons:
 *   - An administrator provisions a user by email before that person has
 *     ever signed in, so their future Firebase uid can't be known yet.
 *   - firestore.rules needs a *direct path* to "the caller's own document"
 *     to decide read/write access efficiently — Firestore rules can't run
 *     an arbitrary "find where email = X" query the way client code can.
 *     Keying by email (available on every request via
 *     request.auth.token.email) makes that path always `users/{their email}`.
 */

import {
    collection, doc, getDoc, getDocs, setDoc, updateDoc, query, where, runTransaction
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { nowISO } from '../utils/date.js';
import { nextCode } from './sequenceGenerator.firestore.js';

const COLLECTION_NAME = 'users';
const usersCollection = collection(firestore, COLLECTION_NAME);

/** Soft-delete convention, same as the IndexedDB Repository base class. */
function visible(record) {
    return record && !record.deletedAt;
}

/** The doc-id form of an email: trimmed and lowercased, matching firestore.rules' `.lower()`. */
function emailId(email) {
    return String(email || '').trim().toLowerCase();
}

/**
 * Collapses whitespace and keeps only digits and a leading +, same as
 * students/staff repositories — but this one additionally defaults to
 * India's +91 when no country code is given, since NATYAM's users are all
 * Indian and Mobile OTP sign-in resolves an identity by this field alone
 * (findByMobile()). Firebase always hands back a fully-qualified E.164
 * number (e.g. +919618007074) for a verified sign-in; a stored value of
 * bare digits would never match it, silently breaking Mobile OTP for that
 * account. This mirrors login.page.js's own toIndianE164() exactly, so a
 * number typed in Settings and a number typed at sign-in normalise to the
 * same canonical form.
 */
function normalisePhone(value) {
    if (!value) return null;
    const digits = String(value).replace(/[^\d+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    return `+91${digits.replace(/^0+/, '')}`;
}

/**
 * Which sign-in methods this account may use — the single source of
 * truth for authentication permission (see resolveProvisionedUser() in
 * auth.service.js). `authMethods` is expected to be present on every
 * account: js/migrations/authMethodsMigration.js is the one-time,
 * by-hand utility that backfills it for every record that predates this
 * field, so this accessor deliberately does NOT default a missing array
 * to `['google']` or anything else — that would be exactly the kind of
 * runtime fallback this design avoids. A record with no array here
 * returns an empty one and is therefore permitted *no* sign-in method
 * until it's migrated — failing closed, never open.
 */
export function authMethodsOf(user) {
    return Array.isArray(user?.authMethods) ? user.authMethods : [];
}

class FirestoreUserRepository {
    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        if (!snap.exists()) return null;
        const record = { id: snap.id, ...snap.data() };
        return visible(record) ? record : null;
    }

    async findOrFail(id) {
        if (!id) throw new Error('No user was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`User ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(usersCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async activeUsers() {
        return (await this.all()).filter((u) => u.status === 'active');
    }

    /** Direct doc lookup — the id *is* the (lowercased) email. */
    async findByEmail(email) {
        return this.find(emailId(email));
    }

    /**
     * Phone-only identities (Mobile OTP) carry no email — resolved by the
     * `mobile` field instead. Single equality query, no composite index
     * needed, same shape as every other repository's findByX(). Every
     * account this resolves is still an email-keyed `users` doc; Mobile
     * OTP is a second way into an existing account, not a new identity
     * model (see js/services/auth.service.js's resolveProvisionedUser()).
     */
    async findByMobile(mobile) {
        const normalised = normalisePhone(mobile);
        if (!normalised) return null;
        const snap = await getDocs(query(usersCollection, where('mobile', '==', normalised)));
        if (snap.empty) return null;
        const row = { id: snap.docs[0].id, ...snap.docs[0].data() };
        return visible(row) ? row : null;
    }

    async findByCode(code) {
        const q = String(code || '').trim().toUpperCase();
        if (!q) return null;
        const snap = await getDocs(query(usersCollection, where('userCode', '==', q)));
        if (snap.empty) return null;
        const row = { id: snap.docs[0].id, ...snap.docs[0].data() };
        return visible(row) ? row : null;
    }

    /* --------------------------------------------------------------- WRITES */

    validate(record) {
        if (!record.name?.trim()) throw new Error('A user needs a name.');
        if (!record.email?.trim()) throw new Error('A user needs an email address.');
        if (!record.role) throw new Error('Choose a role.');
    }

    async create(data) {
        this.validate(data);
        const id = emailId(data.email);
        const at = nowISO();
        const actor = session.actorId();

        const record = {
            ...data,
            email: id,
            status: data.status || 'active',
            mobile: normalisePhone(data.mobile),
            // DEPRECATED — retained only so older records/exports keep their
            // shape; no code reads this field for any decision anymore.
            // `authMethods` is the single source of truth (see
            // authMethodsOf()). Not derived from `authMethods` here on
            // purpose — deriving one deprecated field from the field that
            // replaced it is exactly the kind of "new logic" the
            // deprecation is meant to stop accumulating.
            loginType: data.loginType || 'Google',
            // No default injected here — settings.service.js's createUser()
            // already rejects a missing/empty array before this is ever
            // reached (see KNOWN_AUTH_METHODS validation there); the
            // repository trusts that validation rather than re-deciding it.
            authMethods: Array.isArray(data.authMethods) ? data.authMethods : [],
            createdAt: at, createdBy: actor,
            updatedAt: at, updatedBy: actor,
            deletedAt: null
        };
        delete record.id;

        await setDoc(doc(firestore, COLLECTION_NAME, id), record);
        return { id, ...record };
    }

    /**
     * A user's email is their document id, so it cannot be changed in
     * place — Firestore has no document rename. `changes.email` is ignored
     * here rather than silently accepted and then not actually applied.
     */
    async update(id, changes) {
        const existing = await this.findOrFail(id);
        const patch = { ...changes, updatedAt: nowISO(), updatedBy: session.actorId() };
        delete patch.id;
        delete patch.email;
        if ('mobile' in patch) patch.mobile = normalisePhone(patch.mobile);

        await updateDoc(doc(firestore, COLLECTION_NAME, id), patch);
        return { ...existing, ...patch, id };
    }

    /** Soft delete, same convention as every other module. */
    async remove(id) {
        await this.findOrFail(id);
        await updateDoc(doc(firestore, COLLECTION_NAME, id), {
            deletedAt: nowISO(),
            deletedBy: session.actorId()
        });
        return true;
    }

    /**
     * One-time exception: if nobody has ever been provisioned, the first
     * person to sign in becomes Administrator — the sole full-access role
     * in the combined role model (Doc 10 §8), not Owner & Accountant, which
     * is deliberately scoped to business/finance only. `meta/bootstrapped`
     * is what firestore.rules checks for the same exception — written
     * inside the same transaction as the user record so two people signing
     * in at the same instant cannot both become Administrator.
     *
     * @throws if a school already has an administrator account (someone
     *   else's sign-in already claimed the bootstrap slot). auth.service.js
     *   treats that exactly like "no matching user record" — the standard
     *   "contact your administrator" rejection.
     */
    async bootstrapAdministrator(data) {
        const id = emailId(data.email);
        const at = nowISO();

        const record = {
            ...data,
            email: id,
            role: 'administrator',
            status: 'active',
            mobile: normalisePhone(data.mobile),
            loginType: data.loginType || 'Google', // DEPRECATED — see create()'s comment; authMethods is the source of truth.
            authMethods: Array.isArray(data.authMethods) ? data.authMethods : [],
            createdAt: at, createdBy: id,
            updatedAt: at, updatedBy: id,
            deletedAt: null
        };
        delete record.id;

        // Validated against the fully-assembled record, not the raw input —
        // `role` is assigned above, internally, never supplied by the caller
        // (unlike create(), where the caller picks a role and validating the
        // raw input first is correct). Validating too early here made this
        // check ("Choose a role.") fail on every bootstrap attempt, since
        // the input never carries a role at all.
        this.validate(record);

        const flagRef = doc(firestore, 'meta', 'bootstrapped');
        const userRef = doc(firestore, COLLECTION_NAME, id);

        await runTransaction(firestore, async (tx) => {
            const flagSnap = await tx.get(flagRef);
            if (flagSnap.exists()) {
                throw new Error('This school already has an administrator account.');
            }
            tx.set(userRef, record);
            tx.set(flagRef, { at, by: id });
        });

        return { id, ...record };
    }

    /**
     * Writes accounts from a backup file. Restore-only.
     *
     * Deliberately *not* named `replaceAll()`, and deliberately not shaped
     * like the delete-all-then-write method every other repository has. An
     * account is not a record of something the school did — it is somebody's
     * access. Clearing the collection first would delete every account the
     * backup happens not to mention, including accounts created since it was
     * taken, and there is no server-side way to undo that.
     *
     * `skipIds` exists for one specific account: the administrator running
     * the restore. Overwriting their own document mid-operation can change
     * their role, deactivate them, or soft-delete them outright — and the
     * router re-checks the live user record on every navigation, so the
     * effect is immediate lockout part-way through their own restore.
     *
     * @param {Array<object>} rows      Account records from a backup's `users` section.
     * @param {object}  [options]
     * @param {string[]} [options.skipIds=[]]  Document ids left exactly as they are.
     */
    async restoreAll(rows, { skipIds = [] } = {}) {
        const skip = new Set(skipIds.map(emailId).filter(Boolean));
        let written = 0;
        let skipped = 0;

        for (const row of rows || []) {
            const id = emailId(row.id || row.email);
            if (!id) continue;
            if (skip.has(id)) { skipped += 1; continue; }

            const record = { ...row };
            delete record.id;
            await setDoc(doc(firestore, COLLECTION_NAME, id), record);
            written += 1;
        }

        return { written, skipped };
    }

    /** `USR000001`-style code, via the centralized sequence generator (see sequenceGenerator.firestore.js). */
    async nextUserCode() {
        return nextCode('userCode', 'USR');
    }
}

export const users$ = new FirestoreUserRepository();
