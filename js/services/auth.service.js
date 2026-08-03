/**
 * NATYAM ERP 2.0 — AuthenticationService
 *
 * UI → AuthenticationService → AuthenticationProvider → Firebase
 * Authentication → Session Service → Storage. This file is the
 * "Authentication Service" step: it knows *that* a sign-in happened and
 * what to do about it — provisioning, audit, the Firestore session
 * record — but not *how* one happens. That mechanics lives in
 * js/services/auth/providers/, one file per method (Google, Password,
 * Mobile OTP), each returning the same normalised identity shape
 * (`{ email, name, provider }` — Mobile OTP carries `phoneNumber` instead
 * of `email`, see resolveProvisionedUser()). A future provider is a new
 * file and a registry entry below, not a change anywhere else in this file.
 *
 * Every provider proves *identity* — Firebase Authentication verifies it
 * for real (a Google account, a password Firebase itself checks, an SMS
 * code), a genuine security boundary. Proving identity does not by itself
 * prove *authorization*: whether that identity is allowed into NATYAM at
 * all, and whether it was allowed in *this particular way*, is decided by
 * `resolveProvisionedUser()` against the Firestore `users` collection,
 * matching the IAM workflow spec (§7, §19) and Document 6 §22 ("only an
 * Administrator creates users") — a signed-in identity with no matching,
 * active user record is turned away with the same message whether the
 * record doesn't exist, was archived, or was deactivated, except where
 * the spec allows a status to say more (Account Disabled / Account
 * Unavailable are statuses, not an identity leak). Authentication and
 * authorization are kept strictly separate: a role decides what a
 * signed-in person may do; `users.authMethods` decides how they were
 * allowed to sign in at all — two independent questions, never conflated.
 */

import { session } from '../core/session.js';
import { bus, EVENTS } from '../core/bus.js';
import { users$, authMethodsOf } from '../data/repositories.js';
import { sessions$ } from '../data/sessions.repository.firestore.js';
import { recordAuditEntry } from '../data/auditLog.repository.firestore.js';
import { googleProvider } from './auth/providers/googleProvider.js';
import { passwordProvider } from './auth/providers/passwordProvider.js';
import { mobileOtpProvider } from './auth/providers/mobileOtpProvider.js';

/** Every AuthenticationProvider this app knows about, keyed by id. */
const PROVIDERS = {
    [googleProvider.id]: googleProvider,
    [passwordProvider.id]: passwordProvider,
    [mobileOtpProvider.id]: mobileOtpProvider
};

// The active Firestore session document and which provider opened it,
// carried in sessionStorage (not localStorage) so a same-tab refresh keeps
// pointing at the same record, but closing the tab does not leave a
// reference lying around for a later, unrelated tab to pick up.
const SESSION_RECORD_KEY = 'natyam.sessionRecordId';
const SESSION_PROVIDER_KEY = 'natyam.sessionProviderId';

/**
 * Calls into the shared auditLog writer with an explicit `actor` override —
 * sign-in runs before (or instead of) a session existing, so the row can't
 * always be attributed via `session.actorId()` the way every other
 * repository's writeAuditRow() does.
 */
async function writeAuditRow(entityId, action, detail, actor = null) {
    await recordAuditEntry('Auth', action, entityId, detail, actor);
}

/**
 * Audit logging is a side effect, never the authorization decision itself.
 * `auditLog`'s own create rule requires isProvisionedActiveUser() — which
 * is false for exactly the callers resolveProvisionedUser()'s rejection
 * branches run for (an archived/inactive/unrecognised identity), and is
 * *always* false for a phone-only (Mobile OTP) session regardless of
 * account status, since that token carries no email claim at all.
 * Unwrapped, a write here throws before the real rejection message (or,
 * for the not_provisioned case, the err.code the guardian portal fallback
 * in app.js depends on) is ever set — confirmed 2026-07-28 against a real
 * guardian sign-in and a real Mobile OTP staff sign-in, both masked by
 * this exact "Missing or insufficient permissions" instead of their real
 * outcome. Failure here is logged, never thrown.
 */
async function safeAuditRow(...args) {
    try {
        await writeAuditRow(...args);
    } catch (err) {
        console.error('[auth] audit log write failed (non-fatal)', err);
    }
}

/** The provider id an identity came from — our own providers set `.provider`; a restored Firebase User is asked directly. */
function providerIdOf(identity) {
    if (identity.provider) return identity.provider;
    const raw = identity.providerData?.[0]?.providerId || '';
    if (raw.includes('google')) return 'google';
    if (raw === 'password') return 'password';
    if (raw === 'phone') return 'mobile';
    return 'unknown';
}

/**
 * Ensures the current browser tab has a Firestore session record: reuses
 * one already tracked for this tab (a refresh), or opens a new one. Not
 * written on every idle-timeout touch — only here, at the moments a
 * session actually starts.
 */
async function ensureSessionRecord(user, providerId) {
    if (sessionStorage.getItem(SESSION_RECORD_KEY)) return;
    const id = await sessions$.create({ userId: user.id, provider: providerId });
    sessionStorage.setItem(SESSION_RECORD_KEY, id);
    sessionStorage.setItem(SESSION_PROVIDER_KEY, providerId);
}

/**
 * Clears this tab's own sessionStorage pointer and, if it held one, soft-ends
 * the Firestore session record — the bookkeeping half of ending a session.
 * Split out from endActiveSession() so acknowledgeRemoteSignOut() (below) can
 * do just this much, without also calling a provider's signOut() a second
 * time when Firebase has already reported this tab signed out.
 * @param {'logout'|'idle_timeout'|'cross_tab_signout'} reason
 * @returns {string} the providerId this tab's session was using, for callers that still need it
 */
async function endLocalSessionRecord(reason) {
    const recordId = sessionStorage.getItem(SESSION_RECORD_KEY);
    const providerId = sessionStorage.getItem(SESSION_PROVIDER_KEY) || googleProvider.id;
    sessionStorage.removeItem(SESSION_RECORD_KEY);
    sessionStorage.removeItem(SESSION_PROVIDER_KEY);

    if (recordId) {
        await sessions$.end(recordId, reason).catch((err) => console.error('Could not end session record', err));
    }
    return providerId;
}

/** @param {'logout'|'idle_timeout'} reason */
async function endActiveSession(reason) {
    const providerId = await endLocalSessionRecord(reason);
    await (PROVIDERS[providerId] || googleProvider).signOut();
}

/**
 * Signs in through the named provider and runs the resulting identity
 * through the same provisioning check every provider shares.
 * @param {'google'|'password'|'mobile'} providerId
 * @param {object} [payload] Forwarded to the provider's own signIn() —
 *   `{email, password}` for `password`; ignored by `google` (and unused by
 *   `mobile`, which is two-step — see sendMobileCode()/confirmMobileCode()
 *   below, not this function).
 * @returns {Promise<object>} the app's own provisioned user record
 */
export async function signIn(providerId, payload) {
    const provider = PROVIDERS[providerId];
    if (!provider) throw new Error(`Unknown sign-in method "${providerId}".`);

    const identity = await provider.signIn(payload);
    return resolveProvisionedUser(identity);
}

/**
 * First step of Mobile OTP — sends the code, returns the confirmation
 * handle confirmMobileCode() needs. Not routed through signIn() since OTP
 * is two-step, unlike every other provider.
 * @param {string} phoneNumber E.164 format.
 */
export async function sendMobileCode(phoneNumber) {
    return mobileOtpProvider.sendCode(phoneNumber);
}

/**
 * Second step of Mobile OTP — verifies the code, then runs the same
 * provisioning check every provider shares.
 * @param {import('firebase/auth').ConfirmationResult} confirmation
 * @param {string} code
 */
export async function confirmMobileCode(confirmation, code) {
    const identity = await mobileOtpProvider.confirmCode(confirmation, code);
    return resolveProvisionedUser(identity);
}

/** "Forgot password?" — Firebase emails a reset link; this app never sees or handles the new password itself. */
export async function requestPasswordReset(email) {
    await passwordProvider.sendReset(email);
}

/**
 * Administrator-only — creates the Firebase Auth credential for a new
 * Email/Password user via passwordProvider's isolated secondary-App flow,
 * then a Firebase-generated reset email so the person's first real action
 * is choosing their own password. Does not write the Firestore `users`
 * document itself — settings.service.js's createUser() calls this first,
 * then writes that document, so a failed Auth creation never leaves an
 * orphaned Firestore record.
 * @param {{email: string, password: string}} account
 */
export async function provisionEmailPasswordUser({ email, password }) {
    await passwordProvider.provisionAccount({ email, password });
}

/**
 * Self-service — lets the currently signed-in person add Email & Password
 * as a sign-in method for their OWN account, via passwordProvider's
 * linkPassword() (Firebase's linkWithCredential(), not the admin-creation
 * flow above — that one fails for an email that already has an account,
 * which every existing Google user's does). Not usable by an
 * Administrator on someone else's behalf; there is no `email`/`userId`
 * parameter here on purpose, since it can only ever target whoever is
 * actually signed in right now. Updates that person's own `authMethods`
 * afterward so the new credential is actually permitted, not merely
 * created but rejected by the next sign-in attempt.
 */
export async function setOwnPassword(password) {
    await passwordProvider.linkPassword(password);
    const own = await users$.find(session.actorId());
    const methods = new Set(authMethodsOf(own));
    methods.add('password');
    await users$.update(own.id, { authMethods: [...methods] });
}

/**
 * Decides whether a verified identity is actually let into NATYAM. Called
 * both by signIn() (a fresh sign-in) and by app.js's onAuthStateChanged
 * (restoring an existing Firebase session on reload) — the same decision
 * either way, so there is exactly one place that makes it.
 *
 * @param {{email?: string, phoneNumber?: string, name?: string, displayName?: string, provider?: string}} identity
 *   Either a provider's normalised identity or a raw Firebase User. Google
 *   and Password identities carry `email`; Mobile OTP carries only
 *   `phoneNumber` — see the email/phone branch below.
 * @returns {Promise<object>} the app's own user record (Firestore `users` doc)
 * @throws {Error} with a message safe to show on the login screen — the
 *   caller must sign back out of the underlying provider when this throws,
 *   since it now considers this identity authenticated even though this
 *   app does not consider it authorized. (signIn()'s provider does this on
 *   its own popup-level errors; app.js's restore path calls expireSession().)
 */
export async function resolveProvisionedUser(identity) {
    const email = identity.email || null;
    const name = identity.name || identity.displayName || email || identity.phoneNumber;
    const providerId = providerIdOf(identity);

    // Google and Password identities carry an email, matched against the
    // email-keyed `users` doc exactly as before. Mobile OTP carries only a
    // phone number — resolved via the `mobile` field on that same kind of
    // doc instead (see users.repository.firestore.js's findByMobile()).
    // Every account this resolves is still email-keyed; a phone number is
    // a second way into an existing account, never a new identity model —
    // see that method's own doc comment for the scope boundary.
    const existing = email ? await users$.findByEmail(email) : await users$.findByMobile(identity.phoneNumber);

    if (existing) {
        if (existing.deletedAt) {
            await safeAuditRow(existing.id, 'login_failed', { reason: 'archived' }, existing);
            bus.emit(EVENTS.LOGIN_FAILED, { email, reason: 'archived' });
            throw new Error('Account unavailable. This account has been archived.');
        }
        if (existing.status !== 'active') {
            await safeAuditRow(existing.id, 'login_failed', { reason: 'inactive' }, existing);
            bus.emit(EVENTS.LOGIN_FAILED, { email, reason: 'inactive' });
            throw new Error('Account disabled. Ask an administrator to reactivate your account.');
        }

        // Authentication and authorization stay separate: Firebase already
        // proved this identity; this decides whether *this account* was
        // ever configured to sign in *this way*. Administrator-controlled
        // (authMethodsOf() has no fallback — a missing array denies every
        // method, never assumes one), not a role check — a role decides
        // what someone may do once in, not how they may get in.
        if (!authMethodsOf(existing).includes(providerId)) {
            await safeAuditRow(existing.id, 'login_failed', { reason: 'method_not_permitted', method: providerId }, existing);
            bus.emit(EVENTS.LOGIN_FAILED, { email, reason: 'method_not_permitted' });
            throw new Error('This authentication method is not enabled for your account. Please use one of your permitted sign-in methods or contact your Administrator.');
        }

        await safeAuditRow(existing.id, 'login_succeeded', null, existing);
        bus.emit(EVENTS.LOGIN_SUCCEEDED, { userId: existing.id });
        await ensureSessionRecord(existing, providerId);
        return existing;
    }

    // No record at all. The only way in is the one-time bootstrap: the
    // very first sign-in this school ever makes becomes Administrator.
    // Every sign-in after that fails the same way an unknown identity
    // always would. Bootstrap requires an email (see
    // bootstrapAdministrator()'s validate()) — a phone-only identity with
    // no matching account simply falls through to the rejection below,
    // same as any other unrecognised sign-in.
    if (email) {
        try {
            // `loginType` is deprecated (see users.repository.firestore.js) —
            // deliberately not set from providerId here; authMethods is the
            // one field that decides anything, for a bootstrap account same
            // as any other.
            const admin = await users$.bootstrapAdministrator({ name, email, authMethods: [providerId] });
            await safeAuditRow(admin.id, 'login_succeeded', { bootstrap: true }, admin);
            bus.emit(EVENTS.LOGIN_SUCCEEDED, { userId: admin.id, bootstrap: true });
            await ensureSessionRecord(admin, providerId);
            return admin;
        } catch { /* falls through to the standard rejection below */ }
    }

    await safeAuditRow(email || identity.phoneNumber, 'login_failed', { email, reason: 'not_provisioned' });
    bus.emit(EVENTS.LOGIN_FAILED, { email, reason: 'not_provisioned' });
    // Marked (not just message-matched) so app.js can safely try the
    // Parent/Student Portal's guardian fallback (Milestone P1) only for
    // this specific case — a genuinely unrecognised identity — and never
    // for an archived/inactive/method-not-permitted rejection above, which
    // is a real staff account being correctly turned away.
    const err = new Error('Your account is not set up yet. Ask an administrator to add you as a user.');
    err.code = 'not_provisioned';
    throw err;
}

/** Ends the current session. Safe to call even if nothing is signed in. */
export async function logout() {
    const actor = session.user ? { id: session.actorId(), name: session.actorName() } : null;
    if (actor) await writeAuditRow(actor.id, 'logout_completed', null, actor);
    bus.emit(EVENTS.LOGOUT_COMPLETED, {});
    await endActiveSession('logout');
}

/**
 * Ends the session because it lapsed (idle timeout, or a provisioning
 * rejection during restore) rather than because the person chose to sign
 * out — a distinct security event per the IAM workflow spec (§18).
 */
export async function expireSession() {
    const actor = session.user ? { id: session.actorId(), name: session.actorName() } : null;
    if (actor) await writeAuditRow(actor.id, 'session_expired', null, actor);
    bus.emit(EVENTS.SESSION_EXPIRED, {});
    await endActiveSession('idle_timeout');
}

/**
 * Called when this tab observes a sign-out it did not initiate itself — a
 * different tab called logout(), so Firebase's shared auth persistence has
 * already fired onAuthStateChanged(null) here too. That other tab already
 * signed the provider out; doing it again here would be redundant. All that's
 * left is this tab's own bookkeeping: its Firestore session record (tracked
 * only in this tab's sessionStorage) would otherwise sit open forever.
 */
export async function acknowledgeRemoteSignOut() {
    await endLocalSessionRecord('cross_tab_signout');
}
