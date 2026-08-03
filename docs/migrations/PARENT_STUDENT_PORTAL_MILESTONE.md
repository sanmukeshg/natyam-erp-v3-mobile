# Milestone Record — Parent/Student Portal

**Milestone:** P1 (Phase 2)
**Version:** 2.17.0
**Date:** 2026-07-26
**Status:** Implemented, pending manual UAT and Firebase Rules Emulator verification (not committed, merged, or deployed)
**Related:** [AUTHENTICATION_PROVIDERS.md](../architecture/AUTHENTICATION_PROVIDERS.md) §6, `firestore.rules`

---

## 1. Requirement Summary

A signed-in parent or student should see, read-only, exactly their own child's own batch, timetable, attendance rate (week/month), programmes, certificates, and fee dues — never another family's data, never any staff/finance/admin screen, and no payment-collection UI anywhere. This must not weaken any existing staff-facing rule or behaviour.

## 2. Architecture

A guardian is **not** a new role and **not** a `users` document. It is simply an authenticated Firebase identity (Mobile OTP, Google, or Email/Password — all three already built) whose phone or email token claim matches a `guardianPhone`/`guardianEmail` field already on file for one or more active `students` records. No admin provisioning step exists or is needed — the moment a guardian's contact is entered while enrolling a student, that guardian can sign in.

- **Resolution order** (`js/app.js`'s `handleAuthStateChange()`): the existing staff `resolveProvisionedUser()` is tried first, unchanged. Only if it rejects the identity as genuinely unrecognised (`err.code === 'not_provisioned'`, a new marker added to that specific throw in `auth.service.js` — never set for an archived/inactive/method-not-permitted rejection) does `js/services/portal/guardianAuth.service.js`'s `resolveGuardianIdentity()` run. This ordering also guarantees the one-time bootstrap-Administrator path (which succeeds without throwing) is never intercepted.
- **Server-side enforcement** — the real security boundary — lives entirely in `firestore.rules`: `hasEmailClaim()`, `isGuardianOfStudent()`, `isGuardianOfStudentId()`. Every change there is an additive `||` branch on an existing `allow read` clause (`students`, `attendance`, `certificates`, `invoices`, `payments`); no write rule and no other collection's rules were touched.
- **Two collections have no reverse index from student to record** — `batches` (a student has a `batchId`, but a batch has no student list) and `programs` (participation is a `participants` array on the *programme*, not a foreign key on the *student*). Firestore rules cannot express "is any of my children referenced by this document" for either shape. Solved by denormalizing a small, read-only snapshot onto the student document itself (`batchSchedule`, `programmes`), kept in sync by the service layer — the same style already used throughout this codebase (`searchKey`, `participantCount`), not a new pattern.
- **Separate Shell and Router, same login screen.** `js/ui/portalShell.js` and a second `Router` instance (the `Router` class is now exported from `js/core/router.js`, with a pluggable `revalidate` check — the shared staff `router` singleton's own behaviour is unchanged, since its constructor still gets the same default check it always had). No new login page.

## 3. Files Created

- `js/services/portal/guardianAuth.service.js` — `resolveGuardianIdentity()`, built on an internal `guardianChildren()` query (a from-scratch, permission-scoped query — deliberately not `students.service.js`'s `households()`, which is a whole-school, unscoped scan), and the `guardianSession` singleton (phone/email/students, active-child tracking, `stillValid()` for the portal router's revalidation).
- `js/ui/portalShell.js` — minimal chrome; child switcher only when a household has more than one enrolled student.
- `js/modules/portal/overview.page.js`, `timetable.page.js`, `attendance.page.js`, `programmes.page.js`, `certificates.page.js`, `fees.page.js` — six read-only pages.
- `docs/migrations/PARENT_STUDENT_PORTAL_MILESTONE.md` — this document.

## 4. Files Modified

| File | Change |
|---|---|
| `js/data/students.repository.firestore.js` | `normalisePhone()` now defaults to `+91` (matching `users.repository.firestore.js`); documented the new `batchSchedule`/`programmes` fields (system-written, no `validate()` change). |
| `js/services/students.service.js` | `enrol()`/`assignToBatch()` write `batchSchedule` via new exported `batchScheduleOf()`. |
| `js/services/batches.service.js` | `updateBatch()` refreshes `batchSchedule` on every current roster member (`students$.byBatch(id)`) after a successful update — isolated, best-effort, logged on failure. |
| `js/services/programs.service.js` | `setParticipants()` writes/removes the `programmes` snapshot on every added/removed student — isolated, best-effort, logged on failure. |
| `firestore.rules` | `hasEmailClaim()` guard; `callerPhone()`, `isGuardianOfStudent()`, `isGuardianOfStudentId()`; extended `allow read` on 5 collections. |
| `js/core/router.js` | Exported `Router` class; pluggable `revalidate` (defaults to the exact prior behaviour). |
| `js/services/auth.service.js` | The final "not provisioned" rejection now carries `err.code = 'not_provisioned'`. |
| `js/app.js` | Guardian fallback in `handleAuthStateChange()`; new `enterPortal()`. |
| `js/config/app.config.js` | Version bump to 2.17.0. |
| `CHANGELOG.md`, `RELEASE_NOTES.md`, `docs/architecture/AUTHENTICATION_PROVIDERS.md` | Documented. |

## 5. Business Impact

Families gain self-service visibility into attendance, fees, timetable, programmes and certificates without calling or visiting the school — while the school does zero extra admin work (no account creation step). No existing staff workflow changes.

## 6. Regression Analysis

- **Staff sign-in and every existing capability/role check**: unaffected — `resolveProvisionedUser()`, `session`, `Shell`, `router` (the staff singleton), and every staff page are untouched in behaviour. The only new code path in `handleAuthStateChange()` runs strictly *after* a staff rejection.
- **`firestore.rules`**: every change is an additive `||` on a read rule; no existing `allow` clause was narrowed or removed, and the closing catch-all is unchanged.
- **`batches.service.js`'s `updateBatch()`** and **`programs.service.js`'s `setParticipants()`**: both wrap the new denormalization write-back in try/catch, isolated from the primary operation — a roster-refresh failure logs to console but never blocks the batch update or participant-list change itself from succeeding, matching `app.js`'s own `maintenance()` pattern.
- **`students.repository.firestore.js`'s `normalisePhone()` fix**: changes behaviour only for a bare-digit input (previously stored as-is, now defaults to `+91`) — an input that already starts with `+` is unaffected, so no existing correctly-formatted number changes.

## 7. Manual UAT Checklist

See `RELEASE_NOTES.md`'s Manual UAT checklist — reproduced there in full, including the required Firebase Rules Emulator pass.

## 8. Backfill: existing `guardianPhone` values saved without `+91`

No dedicated migration script was built for this — the same precedent v2.16.1 already set for the identical class of fix on `users.mobile`. The remedy is the same: open the affected student's record in Settings → Students and re-save the mobile number field once; `beforeSave()`'s corrected `normalisePhone()` applies the `+91` prefix automatically on that save. Do this before relying on Mobile OTP for that family's guardian sign-in.

## 9. Readiness Assessment

Implemented and statically verified (no import cycles, all imports resolve, no undefined identifiers). **Not yet verified**: a live guardian sign-in end-to-end, and the `firestore.rules` changes in the Firebase Rules Emulator — both require a live Firebase project and are the two items this milestone most needs a real pass on before being relied upon. Recommend the Rules Emulator pass specifically before republishing rules to production, given this file is hand-written with no automated test suite.

No commit/push/deploy performed — implementation and validation only, per standing instruction.
