# Authentication Providers — NATYAM ERP

**Status:** Living reference (updated as providers are added; unlike an ADR,
this document is expected to change as the roadmap below is delivered)
**Last updated:** 2026-07-26 (v2.16.1 — self-service account linking + India phone default, follow-up to Milestone A1)
**Related:** [ADR-014](adr/ADR-014-Firebase-Authentication-and-Firestore.md) (the decision that introduced this architecture), [firestore-data-model.md](firestore-data-model.md), [AUTHENTICATION_ARCHITECTURE_AUDIT.md](../audits/AUTHENTICATION_ARCHITECTURE_AUDIT.md)

This document exists to answer one question precisely: **which sign-in
methods actually work today, which are planned, and why adding one never
requires touching the rest of the system.** ADR-014 records the decision
to adopt Firebase Authentication; this document tracks the provider
roster itself, which is expected to grow.

---

## 1. Implemented Providers

**Three production authentication providers, all via Firebase
Authentication, all sharing one `AuthenticationProvider` contract.**

| | Google | Email & Password | Mobile OTP |
|---|---|---|---|
| Provider file | `js/services/auth/providers/googleProvider.js` | `js/services/auth/providers/passwordProvider.js` | `js/services/auth/providers/mobileOtpProvider.js` |
| Provider id | `'google'` | `'password'` | `'mobile'` |
| Mechanism | Firebase `signInWithPopup` against Google OAuth | Firebase `signInWithEmailAndPassword` | Firebase `signInWithPhoneNumber` (SMS + reCAPTCHA) |
| Identity carries | `email` | `email` | `phoneNumber` (no email) |
| Shape | One-shot `signIn()` | One-shot `signIn({email, password})` | Two-step: `sendCode()` then `confirmCode()` — see §3 |
| Status | Implemented, in production use | Implemented | Implemented |

Password verification and OTP verification both happen on Firebase's own
servers — this application never sees, stores, hashes, or compares a
credential, the same trust model Google Sign-In already had. This is
deliberately not a repeat of the local, client-verified password
authentication ADR-014 §2 records as removed (PBKDF2 against IndexedDB,
"a UI gate, not a real security boundary").

## 2. Per-Account Sign-In Method Permissions

**Authentication and authorization are two separate questions, answered
by two separate mechanisms.** A `users` document's `role` field decides
*authorization* — what a signed-in person may do (unchanged by this
milestone). The `authMethods` array field on that same document — **the
single source of truth for authentication permission** — decides which
of the three providers above that specific account is allowed to sign in
with at all.

- Configured by an Administrator, per account, in Settings → Users (the
  same Add/Edit User form every user record already goes through).
- Enforced in exactly one place: `resolveProvisionedUser()` in
  `auth.service.js`, *after* Firebase has already verified the identity
  and *after* the existing `status`/`deletedAt` checks, via
  `authMethodsOf(existing).includes(providerId)`. A rejection here is a
  distinct, audited event (`login_failed`, reason `method_not_permitted`)
  — the identity was real, the account exists and is active, but this
  particular door wasn't open to it. The message shown is fixed and
  non-technical: *"This authentication method is not enabled for your
  account. Please use one of your permitted sign-in methods or contact
  your Administrator."* Raw Firebase SDK error codes are never shown to
  a person — `js/modules/auth/login.page.js`'s `friendlyAuthError()`
  translates every code this screen can produce into plain language.
- **No runtime fallback for a missing `authMethods` array.** `authMethodsOf()`
  returns an empty array (not `['google']`, not "every method") for any
  record that genuinely has none — failing closed, permitting nothing,
  never assuming a default. Every account is expected to carry a real
  array; see §2a for how that's guaranteed.
- **Validation, enforced in `settings.service.js`'s `createUser()`/`updateUser()`:**
  - `authMethods.length >= 1` — an Administrator can never save a user
    with zero enabled sign-in methods. There is no fallback method to
    fall back to.
  - The currently signed-in Administrator specifically cannot reduce
    their *own* account to zero methods — same underlying rule as above,
    with a message naming their own situation ("...must remain enabled
    for your own account") rather than the general one.
  - Every value must be one of the three known provider ids
    (`KNOWN_AUTH_METHODS`) — an unrecognised value is rejected outright,
    not silently accepted.
- Nothing here is hardcoded by role. A Viewer and an Administrator can be
  configured identically, or differently — `authMethods` is purely a
  per-account setting.

## 2a. `loginType` is Deprecated

Every `users` document still carries a `loginType` string field, a
leftover from before `authMethods` existed. **It is retained only so
existing records/exports keep their shape — no code reads it for any
decision anymore.** `authMethods` is the single source of truth for
authentication permission; nothing new should ever be built against
`loginType`. Deriving `loginType` dynamically from whichever provider
signed someone in was considered and explicitly rejected, even for the
bootstrap path — deriving one deprecated field from the field that
replaced it is exactly the kind of new logic the deprecation exists to
stop accumulating.

**Migrating existing accounts is a one-time job, not a runtime guess.**
`js/migrations/authMethodsMigration.js` — a by-hand utility, same
category as the two data-migration tools this project already has, no
route or UI button — backfills `authMethods: ['google']` onto every
`users` document that predates this field (every account provisioned
before Milestone A1 only ever had Google available, so this is a
factual backfill, not an assumption). Run it once, from a signed-in
Administrator's browser console:

```js
import('./js/migrations/authMethodsMigration.js')
    .then(m => m.migrateAuthMethods({ dryRun: true }))   // inspect first
    .then(console.log);
// then re-run with { dryRun: false } (the default) to actually write
```

After it runs, every account has a real `authMethods` array, and the
"no runtime fallback" rule in §2 holds without exception.

## 2b. Mobile Numbers Are Unique Across the System

Mobile OTP resolves an incoming identity by phone number alone
(`findByMobile()` — there is no email in that identity to resolve by
instead). Two active accounts sharing one mobile number would make that
resolution ambiguous, not just untidy, so `settings.service.js`'s
`createUser()`/`updateUser()` both reject a mobile number already in use
by another active account, with a clear "`<name>` already uses that
mobile number" error — the same shape as the existing email-uniqueness
check.

## 3. The Provider Contract — and Why Mobile OTP Extends It

Every provider is a plain object `{ id, signIn(), signOut() }` — no base
class, duck-typed. Google and Password both fit this exactly: one call
in, one identity out.

**Mobile OTP is inherently two-step** (a code must be sent, then
separately verified), so it extends the shape rather than forcing OTP
into a one-shot call it doesn't fit:

- `sendCode(phoneNumber)` → triggers the SMS via an invisible reCAPTCHA,
  returns a `ConfirmationResult` handle.
- `confirmCode(confirmation, code)` → verifies what the person typed,
  returns the normalised identity.
- `signIn()` still exists (throws, pointing at the two real methods) so
  the `{id, signIn, signOut}` shape every other provider has still
  resolves if something generic ever reaches for it.

`auth.service.js` exposes both steps directly (`sendMobileCode()`,
`confirmMobileCode()`), alongside the shared `signIn(providerId, payload)`
that Google and Password both use.

## 4. Architecture

**Confirmed: the `AuthenticationProvider` abstraction supports adding a
new provider without requiring changes to Session Service, IAM, Route
Guards, or Firestore Security Rules — verified directly against the code
below for all three providers, not just asserted.**

| Layer | File | Why it doesn't need to change per provider |
|---|---|---|
| **Session Service** | `js/core/session.js` | `hydrate({ user, ... })` takes the app's own provisioned user record — `{ id, name, role, ... }` — the same shape regardless of which provider produced the identity behind it. Nothing in this file reads a provider id. |
| **IAM** | `js/config/app.config.js` (`ROLES`/`CAPABILITIES`), `session.can()` | Capability grants are keyed by the user's `role` field, resolved once at hydration. A role is a property of a `users` document, not of how its owner happened to sign in. |
| **Route Guards** | `js/core/router.js` | Every navigation checks `session.isAuthenticated()`, a live Firestore user-status re-read, and `session.can(...)`. None of these three checks reads or branches on a provider id. |
| **User Service** | `js/data/users.repository.firestore.js`, `resolveProvisionedUser()` in `auth.service.js` | Google/Password identities are found by email (`findByEmail`); Mobile OTP identities (no email) by phone (`findByMobile`, querying the same `mobile` field every account already carries). Either way, the *rest* of provisioning — status checks, the new `authMethods` permission gate, session-record creation — runs identically. |
| **Firestore Security Rules** | `firestore.rules` | Unchanged by this milestone — confirmed by direct re-read. Every rule keys off `request.auth.token.email` and the caller's `users` document (role, status); `authMethods` is just another field on that same document, already covered by the existing `allow update: if isAdministrator();`. Enabling/disabling a sign-in method in Firebase Authentication itself is a separate Console setting, outside `firestore.rules`' jurisdiction entirely. |

The one place a provider id is *ever* threaded through deliberately is the
`sessions` collection (`js/data/sessions.repository.firestore.js`), which
records which provider opened a given session record — an audit detail —
and, as of this milestone, the `authMethods` permission gate in §2, which
is a new decision point but lives in the one place `resolveProvisionedUser()`
already made every other identity decision.

## 5. Administrator Provisioning

Google accounts self-provision their own Firebase Auth identity on first
sign-in — an Administrator only ever creates the Firestore authorization
document in advance (`createUser()`, unchanged). Email/Password accounts
need their Firebase Auth *credential* created too, and
`createUserWithEmailAndPassword` signs in as the newly created user in
whatever Auth instance it's called against — calling it on the app's own
shared instance would hijack the Administrator's own active session.

`passwordProvider.js`'s `provisionAccount()` isolates this in a second,
throwaway Firebase App instance (same project/config, independent Auth
state), used once and discarded, then sends a Firebase password-reset
email so the new person's first real action is choosing their own
password. `settings.service.js`'s `createUser()` calls this *before*
writing the Firestore document, so a failed Auth creation never leaves an
orphaned authorization record with no way to actually sign in.

Existing Google-only accounts are untouched by provisioning — no
migration, no forced re-authentication. **Account linking is implemented**
(v2.16.1, added as a direct follow-up once real-world use surfaced the
need): `passwordProvider.js`'s `linkPassword()` calls Firebase's
`linkWithCredential()` against `auth.currentUser`, self-service only —
`auth.service.js`'s `setOwnPassword(password)` is reachable from Settings
→ Users → **Set a password**, visible only on the signed-in person's own
row. This is deliberately *not* something an Administrator can trigger on
someone else's account: `createUserWithEmailAndPassword` (the
provisioning flow above) fails with `auth/email-already-in-use` for an
email that already has a Firebase Auth identity from another provider —
`linkWithCredential` is the only correct way to attach a second method to
an *existing* identity, and it only works while signed in as that
identity. After linking, `setOwnPassword()` also adds `'password'` to
that account's own `authMethods` so the new credential is actually
permitted, not just created.

## 5a. Mobile Numbers Default to +91

Firebase's `signInWithPhoneNumber` requires full E.164 (a leading `+` and
country code). Since NATYAM's users are all Indian today, nobody should
have to type `+91` on every sign-in. `login.page.js`'s `toIndianE164()`
prepends `+91` to whatever's typed unless it already starts with `+`
(someone deliberately using a different country code). Since v2.17.4 the
login screen has one merged "Email or Mobile Number" field rather than a
separate dedicated Mobile Number input (see §5b below) — `toIndianE164()`
is only ever applied to that field's value once it's been detected as a
phone number, not to whatever's typed in general. The same `+91` default
is applied on the *storage* side —
`users.repository.firestore.js`'s `normalisePhone()` — so a number an
Administrator types into Settings → Users without a `+91` prefix
normalises to the exact same canonical form Firebase hands back at
sign-in time. Getting these two out of sync would silently break Mobile
OTP for that account (a stored bare `9618007074` would never match a
verified `+919618007074`), so both call the same rule rather than two
independently-written ones that could drift.

## 5b. One Merged Email/Mobile Field (v2.17.4)

The login screen no longer has two separate identifier inputs (an Email
field for Email & Password, and a dedicated Mobile Number field for
Mobile OTP) — it has one, labelled "Email or Mobile Number". `login.page.js`'s
`detectMode(value)` decides, live as the person types, which of the two
methods applies: a value containing `@` is unambiguously an email; a value
that reduces (after stripping spaces/dashes) to `/^\+?\d{8,15}$/` is
unambiguously a phone number; anything else (empty, or a partial value
like `"98"` or `"sanmuk"`) stays in email mode, the safer default. The
Password field, "Login" button label, and "Forgot password?" link are
shown only in email mode; in mobile mode they hide and the same button
becomes "Send OTP", calling the exact same `sendMobileCode()`/
`toIndianE164()` path as before. Nothing about the provider layer,
`resolveProvisionedUser()`, or `firestore.rules` changed for this — it is
a login-screen-only change to which of two already-existing flows a
single field routes into. Google's button is untouched, a third and
independent option below.

## 6. Roadmap

- ~~**Parent/Student Portal authentication**~~ — **built, Milestone P1**
  (v2.17.0). A guardian is not a `users` document at all — no role, no
  Administrator provisioning step — just an authenticated Firebase user
  (Mobile OTP, Google, or Email/Password) whose phone/email token claim
  matches a `guardianPhone`/`guardianEmail` already on file for one or
  more active students. Resolved by
  `js/services/portal/guardianAuth.service.js`'s `resolveGuardianIdentity()`,
  tried only as a fallback in `app.js` after the staff
  `resolveProvisionedUser()` path rejects an identity as genuinely
  unrecognised (`err.code === 'not_provisioned'`) — an
  archived/inactive/method-not-permitted staff account is never
  reinterpreted as "maybe a guardian." Enforced server-side by
  `firestore.rules`' `isGuardianOfStudent()`/`isGuardianOfStudentId()`.
  See `docs/migrations/PARENT_STUDENT_PORTAL_MILESTONE.md`.
- **Displaying `authMethods`/sign-in history in the Users table** —
  cosmetic, not yet added; today it's only visible/editable inside the
  Add/Edit User form.

---

## Summary

| Question | Answer |
|---|---|
| What works today? | Google, Email & Password, and Mobile OTP — all three, for any account an Administrator has configured to use them. |
| What decides *authorization*? | `role`, exactly as before — unchanged. |
| What decides *authentication permission*? | `authMethods` — the single source of truth, Administrator-configured per account, enforced once in `resolveProvisionedUser()`. No runtime fallback for a missing array. |
| What happened to `loginType`? | Deprecated (§2a) — retained on the document for shape/backward-compatibility only, read by no logic. |
| How do pre-existing accounts get an `authMethods` array? | A one-time migration (§2a), not a runtime guess — `js/migrations/authMethodsMigration.js`. |
| Can a mobile number be reused across accounts? | No — enforced unique on create and update (§2b), since Mobile OTP resolves an identity by phone number alone. |
| Does a mobile number need a country code typed in? | No — defaults to +91 automatically, on both the login screen and in Settings → Users (§5a). |
| Can an existing Google-only account add a password? | Yes — self-service, via Settings → Users → **Set a password** on your own row (§5). Not something an Administrator can do to someone else's account. |
| Does adding a provider require a redesign? | No — by construction, and verified in §4 above for all three. |
| What's planned but not built? | Nothing outstanding from this list — the Parent/Student Portal (true phone-only identities) shipped in Milestone P1. |
