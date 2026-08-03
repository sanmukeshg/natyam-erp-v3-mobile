# ADR-014 — Firebase Authentication and Cloud Firestore for Auth & Users

**Status:** Accepted
**Date:** 2026-07-24
**Deciders:** NATYAM ERP project owner
**Scope:** Authentication and the `users` / `sessions` data only. No other module is affected by this decision.

---

## 1. Decision

NATYAM ERP replaces its local, client-only authentication (email/password, hashed and verified entirely in the browser against an IndexedDB `users` store) with **Firebase Authentication**, using **Google Sign-In** as the first identity provider, and migrates the **Users** and **Sessions** data to **Cloud Firestore**.

This is the first slice of a broader, explicitly phased move to the Google ecosystem as NATYAM ERP's primary platform. Every module other than Authentication and Users — Students, Admissions, Attendance, Batches, Fees, Finance, Expenses, Staff, Programs, Certificates, Curriculum, Reports, Dashboard, Notifications, Settings, Audit — is unaffected by this decision and continues to run on the existing IndexedDB local database until its own, separately-decided migration phase.

Authentication itself is built as a pluggable **AuthenticationService → AuthenticationProvider** architecture (`js/services/auth.service.js` delegating to `js/services/auth/providers/*.js`), so that a second identity provider — Mobile + OTP — can be added later as a new provider file rather than a redesign.

## 2. Context

NATYAM ERP was built as a 100%-client-side, offline-first single-page application: no server, all data in the browser's IndexedDB, deployed as static files to GitHub Pages. An initial authentication milestone added a local login screen — email and password, hashed client-side with PBKDF2 and checked against an IndexedDB `users` record — explicitly documented at the time as *"a UI gate, not a real security boundary"*, since there was no server anywhere in the architecture capable of verifying a credential in a way a determined user with DevTools open couldn't see or bypass.

The project owner subsequently issued a standing architectural decision: NATYAM ERP adopts the Google ecosystem — Firebase Authentication, Cloud Firestore, Firebase Storage, Firebase Cloud Messaging, Firebase Analytics, and (later) Firebase Hosting — as its primary platform going forward, migrated **incrementally, module by module**, not as a single rewrite. This ADR records that decision as it applies to the first two things actually migrated: Authentication and the Users collection (which Sessions naturally travels with, since a session is meaningless without the identity it belongs to).

A related, smaller architectural request — replacing five ad hoc roles (Owner, Administrator, Registrar, Teacher, Accountant) with four combined roles (Administrator, Owner & Accountant, Teacher & Reception, Viewer) matching the IAM Security Policy specification — was folded into this same milestone, since the role model is part of what Authentication and the Users collection carry.

## 3. Alternatives considered

- **Keep local password authentication (status quo).** Rejected: never a real security boundary by the original design's own admission; ties every account to one browser profile with no way to reach it from a second device or branch; has no credible path to the parent/student portals already on the roadmap, which need identity that works outside the school's own machines.
- **A self-hosted custom backend** (e.g. Node/Express plus a hosted relational or document database). Rejected: requires standing up, securing, and paying for server infrastructure that does not exist today; abandons the zero-maintenance static-hosting deployment model (GitHub Pages, `git push` to publish) that the rest of this project depends on; materially larger engineering and operational lift for a single-school application.
- **A spreadsheet- or Apps-Script-backed approach** (Google Sheets as the data store, Google Apps Script as the API layer). Considered and rejected: weak and awkward security primitives for real authentication and row-level authorization, poor concurrent-write behaviour under multi-user load, and a data model that fights rather than fits an entity-relational domain like admissions, fees and attendance. This option is explicitly excluded from NATYAM ERP's roadmap.
- **A different Backend-as-a-Service** (e.g. Supabase). Not pursued in depth: no material advantage over Firebase for this project's needs was identified, and Firebase was already the project owner's stated direction for Storage, Messaging and Analytics — using one vendor across all of those avoids integrating four separate platforms for one small application.
- **Firebase Authentication + Cloud Firestore.** **Chosen** — see §4.

## 4. Reasons for choosing Firebase

- **A real, managed identity provider with nothing to build or operate.** Google Sign-In via Firebase Authentication verifies identity against an actual Google account; NATYAM ERP never sees or stores a password.
- **Fits the existing zero-build deployment model.** The Firebase JS SDK (v10+, modular) is consumable directly via `gstatic.com` ESM URLs — no bundler, no build step, no change to how this app is written or deployed. GitHub Pages continues to serve the static assets; Firebase supplies backend services only.
- **A real, server-enforced security boundary for the first time.** Firestore Security Rules run on Google's infrastructure, not in the visiting browser — the first part of this application a determined user at the keyboard cannot simply edit around.
- **Incremental, collection-by-collection migration is natural.** A Firestore project can hold one collection (`users`) while every other module stays on IndexedDB; nothing about adopting Firestore forces an all-at-once cutover, which matches the project owner's explicit phased-rollout instruction.
- **Free tier fits this project's scale.** A single school's authentication and user-record traffic comfortably fits Firebase's Spark (no-cost) plan.
- **One platform for the whole Google-ecosystem roadmap.** Storage, Cloud Messaging and Analytics — all separately planned — are the same platform, the same project, the same billing account, and the same security-rules mental model as what this ADR adopts for Auth and Users.

## 5. Security implications

- **Identity is now genuinely verified.** Firebase Authentication performs real OAuth against Google; this application never handles or stores a credential.
- **Identity is not the same as authorization.** A verified Google account is only let into NATYAM ERP if it matches an existing, active Firestore `users` record — provisioning stays administrator-controlled (Document 6 §22: *"only an Administrator creates users"*), not self-service. An unrecognised account, an archived account, and a deactivated account are all rejected, with messaging that does not reveal which case applies for an unrecognised vs. wrong-credential-shaped failure (an archived/deactivated account *is* told its specific status, since that is a status, not an identity leak).
- **A narrow, one-time bootstrap exception.** On a brand-new Firestore project with no users at all, the first person to sign in is automatically granted the Administrator role, inside an atomic transaction that also sets a `meta/bootstrapped` flag — so exactly one account can ever claim this path, and every later observer (both the application and `firestore.rules` itself) can prove the exception has already been used.
- **`firestore.rules` is the enforcement point, not client code.** Every rule in the `users`, `sessions`, and supporting `meta` collections denies by default; only the specific `allow` clauses documented in the rules file itself grant access. Client-side capability checks (`session.can(...)`) remain a UI convenience layered on top, not the security boundary, for Auth and Users just as for everything else.
- **The `firebaseConfig` values are intentionally public.** Firebase's own design places no security weight on hiding `apiKey`/`projectId`/etc. — they are safe to commit, which this project does.
- **Everything not yet migrated is unchanged, and that is a known limitation, not an oversight.** Every module still on IndexedDB is still only protected by client-side capability checks, exactly as before this ADR — a determined user at the keyboard can still edit around role gating for Students, Fees, Attendance and the rest, until each of those modules migrates in its own future phase.
- **No server-side compute exists yet.** Without Cloud Functions or the Admin SDK (both explicitly out of scope for this phase), some capabilities a traditional backend would offer — server-initiated session revocation chief among them — are approximated client-side instead: the router re-reads a signed-in user's live Firestore status on every navigation and ends their session locally the moment it finds them deactivated or archived, but this cannot reach a *different* device's already-open session the way a real server-side revoke could.

## 6. Migration strategy

Migration is **incremental and module-scoped**, in an order the project owner has already specified: Users/Auth (this ADR) → Students → Attendance → Fees → Finance → Curriculum → Notifications → Parent Portal → Student Portal.

Each phase follows the same repeatable pattern, demonstrated here with Users:

1. Design the Firestore collection's document shape and its `firestore.rules` entry before writing any application code against it.
2. Build a new `<module>.repository.firestore.js` that implements the **exact same external interface** the IndexedDB repository it replaces already has (`find`, `findOrFail`, `all`, `create`, `update`, `remove`, and whatever module-specific query methods existed) — callers should not need to change beyond an import.
3. Swap the export in `js/data/repositories.js` to point at the new Firestore-backed implementation; delete the old IndexedDB-backed class once nothing references it.
4. Verify every Service and UI file that used the old repository needed no changes beyond that one swapped import — if it did, the interface wasn't preserved precisely enough and needs revisiting before the swap, not after.

The old IndexedDB store for a migrated module is **left declared but unused** in `SCHEMA` rather than removed — harmless, and it means nothing about the local database's shape needs to change (no version bump, no migration script) as part of a Firestore cutover.

## 7. Future roadmap

- **Mobile + OTP sign-in**, via Firebase Phone Authentication, behind the `mobileOtpProvider.js` seam already built and currently a placeholder.
- **Firebase Storage** for student photos, certificates, and general document/media uploads.
- **Firebase Cloud Messaging** for parent notifications, fee reminders, and attendance alerts.
- **Firebase Analytics**, once there is a concrete question it needs to answer.
- **Firebase Hosting**, evaluated only after authentication has stabilised in production — GitHub Pages continues to serve this application until and unless that evaluation concludes otherwise.
- **An "active sessions" admin view**, reading the `sessions` collection this ADR introduces, which nothing currently surfaces in the UI.
- **Cloud Functions / the Admin SDK**, evaluated if and when a genuine server-side compute need arises (e.g. true remote session revocation, scheduled server-side jobs) — not adopted speculatively ahead of that need.
- **Every subsequent module migration** in the order given in §6, each repeating the same Repository-swap pattern.

## 8. Impact on existing modules

**Functionally affected: Authentication and Users only.** Every other module — Students, Admissions, Attendance, Batches, Fees, Finance, Expenses, Staff, Programs, Certificates, Curriculum, Reports, Dashboard, Notifications, Settings, Audit — has an unchanged data model, unchanged persistence (IndexedDB), and unchanged behaviour. No schema version bump, no data migration, and no UI change was made to any of them as part of this decision.

**One cross-cutting, backward-compatible change:** every one of those unaffected modules stamps records with `session.actorId()` / `session.actorName()` for audit purposes. Those now resolve from a Firestore-backed identity instead of a local one, but the shape those modules depend on (`{ id, name, role }`) is unchanged, so this flows through invisibly — no calling code needed to change.

**A related, bundled change:** the role model used everywhere capability checks are made (`session.can(...)`, `session.role()`) moved from five roles to four (§2). Every module gates on capability strings, not raw role names, with the sole exception of a small number of direct role checks (the "cannot lock the school out of Administrator" guard, and the Dashboard's teacher-view switch) — all of which were updated as part of this same change and are enumerated in the corresponding session's validation record, not repeated here.

## 9. Risks

- **Vendor lock-in.** Authentication and Users now depend on a single vendor's platform; migrating away from Firebase later would be a real project, not a configuration change.
- **Firestore usage cost at scale.** Currently comfortably inside the free Spark plan; worth monitoring as usage grows, particularly the router's per-navigation read of the signed-in user's live status, which is one Firestore read per page navigation for every signed-in person.
- **Authentication now requires network connectivity.** A genuine regression from the offline-first design for this one slice: Auth and Users need a live connection to Firebase; every other module remains fully usable offline via IndexedDB, unchanged.
- **Security rules are hand-written and not yet under automated test.** The Firebase Local Emulator Suite, which would allow rules to be exercised in a test harness, is not yet part of this project's tooling. Today's confidence in `firestore.rules` rests on manual review and manual verification, not an automated regression suite.
- **A split architecture is inherently harder to reason about than either pure model.** Part of the application's data lives in Firestore, part in IndexedDB, for the duration of the phased migration in §6. This is a deliberate, accepted trade-off in exchange for a working application at every intermediate step, not an oversight.
- **No fallback identity provider exists today.** If Firebase Authentication is unreachable (an outage, a billing or account problem), there is currently no alternative way to sign in — a real, current limitation worth the project owner's awareness rather than a hidden gap.

## 10. Rollback strategy

- **No runtime toggle exists between local and Firebase authentication.** The local-password implementation (`js/utils/crypto.js`, the IndexedDB `UserRepository`, the seeded demo accounts) was removed rather than deprecated behind a flag. A rollback today means reverting to the git commit(s) before this migration, not flipping a configuration switch.
- **Process recommendation for future phases:** each subsequent module migration in §6 should keep its predecessor IndexedDB repository importable behind a simple config flag for at least one release before deletion, so that a future rollback can be a configuration change rather than a code revert. This was not retrofitted onto the Users migration already completed, but should apply starting with the next phase.
- **No data-loss exposure from rolling back Users specifically.** The IndexedDB `users` store this migration leaves behind held only local seed/demo accounts, never real production credentials — nothing of value would be lost by reverting, though any real accounts created in Firestore since this migration shipped would need to be re-entered into the local-password model's shape if a rollback were ever executed.
- **Firestore data itself is not deleted by a rollback.** Reverting the application code does not delete the Firestore project or its data; a rolled-back deployment simply stops reading from it. Firestore data would remain available for a forward-fix or a later re-attempt without needing to be recreated.

---

## Related decisions

- Superseded local decision: PBKDF2-hashed, client-verified password authentication (this project's first authentication milestone, prior to this ADR).
- Bundled with this ADR: consolidation of the role model from five roles to four (Administrator, Owner & Accountant, Teacher & Reception, Viewer), per the IAM Security Policy specification, Document 10 §8.
