# IAM Role Model — NATYAM ERP

**Status:** current as of v2.23.0 (30 July 2026), incorporating the same-day refinement round: account-scoped escalation guard (§3), the Business/System Settings split (§2a), and the explicit application-maintenance enumeration under `system.maintain` (§3).
**Supersedes:** the role summaries in `ADR-014`, `docs/migrations/STUDENT_MODULE_MIGRATION.md` §6 and `docs/migrations/ADMISSIONS_MODULE_MIGRATION.md` §6, which record the model as it stood at their own milestones.

This is the single authoritative description of who can do what in NATYAM ERP.
Two files implement it and must be edited together:

| File | What it governs |
|---|---|
| `js/config/app.config.js` — `CAPABILITIES`, `ROLES`, `ADMINISTRATOR_ONLY_CAPABILITIES` | What the application offers a signed-in person: which screens appear, which buttons render, which service calls are refused |
| `firestore.rules` | What the database will actually accept, for any caller, from any client |

A capability granted in the first and denied in the second is not a locked
button — it is a "Missing or insufficient permissions" crash at the moment
someone tries to do their job.

---

## 1. The hierarchy

```
Administrator          highest SYSTEM authority
      ↓
Owner & Accountant     highest BUSINESS authority
      ↓
Teacher & Reception    academic and front-office operations
      ↓
Viewer                 read-only
```

The top two are a split of authority, not of seniority. The Administrator
configures the software; the Owner runs the academy. Neither outranks the other
within the other's domain, and they are not expected to be the same person.

**Why the Owner is nearly all-powerful.** At NATYAM the owner is also the
accountant, teaches classes, handles admissions and staffs reception. A role
scoped to "finance oversight" described the software's idea of an owner rather
than the academy's, and forced the one person doing all of those jobs to ask
someone else for permission to do them. Since v2.23.0 the Owner holds every
capability except the reserved ones in §3.

**Future teachers** get Teacher & Reception. **Viewer** is for someone who needs
visibility without the ability to change anything.

---

## 2. The matrix

Generated from `roleCapabilities()`; regenerate rather than hand-edit.
Settings → Roles shows the same table inside the application.

| Capability | Admin | Owner | Teacher & Reception | Viewer |
|---|:--:|:--:|:--:|:--:|
| `student.view` | Yes | Yes | Yes | Yes |
| `student.edit` | Yes | Yes | Yes | — |
| `student.delete` | Yes | Yes | — | — |
| `admission.view` | Yes | Yes | Yes | Yes |
| `admission.edit` | Yes | Yes | Yes | — |
| `admission.approve` | Yes | Yes | Yes | — |
| `attendance.view` | Yes | Yes | Yes | Yes |
| `attendance.mark` | Yes | Yes | Yes | — |
| `fee.view` | Yes | Yes | Yes | Yes |
| `fee.collect` | Yes | Yes | Yes | — |
| `fee.refund` | Yes | Yes | — | — |
| `fee.waive` | Yes | Yes | — | — |
| `finance.view` | Yes | Yes | — | Yes |
| `finance.edit` | Yes | Yes | — | — |
| `staff.view` | Yes | Yes | Yes | Yes |
| `staff.edit` | Yes | Yes | — | — |
| `program.view` | Yes | Yes | Yes | Yes |
| `program.edit` | Yes | Yes | Yes | — |
| `certificate.issue` | Yes | Yes | — | — |
| `report.view` | Yes | Yes | Yes | Yes |
| `report.export` | Yes | Yes | Yes | — |
| `settings.view` | Yes | Yes | — | Yes |
| `settings.edit` | Yes | Yes | — | — |
| `audit.view` | Yes | Yes | — | — |
| `audit.purge` **(reserved)** | Yes | — | — | — |
| `backup.create` | Yes | Yes | — | — |
| `data.export` | Yes | Yes | — | — |
| `data.restore` **(reserved)** | Yes | — | — | — |
| `system.configure` **(reserved)** | Yes | — | — | — |
| `system.maintain` **(reserved)** | Yes | — | — | — |
| `role.manage` **(reserved)** | Yes | — | — | — |
| `security.manage` **(reserved)** | Yes | — | — | — |
| `user.view` | Yes | Yes | — | — |
| `user.create` | Yes | Yes | — | — |
| `user.edit` | Yes | Yes | — | — |
| `user.activate` | Yes | Yes | — | — |
| `user.deactivate` | Yes | Yes | — | — |
| `user.archive` | Yes | Yes | — | — |
| `user.changeRole` | Yes | Yes | — | — |

39 capabilities; Administrator 39, Owner 33, Teacher & Reception 14, Viewer 9.

Several modules have no capability of their own and are gated by one they
piggyback on. The Owner holds every one of those, so every one of those modules
is fully hers:

| Module | Gated by |
|---|---|
| Dashboard | nothing — reachable by every signed-in user |
| Batches, Timetable | `student.view` to see, `student.edit` to change |
| Calendar | there is no separate Calendar screen; Timetable is it, and Holidays are read-only everywhere |
| Notifications | `student.view` to see; `settings.edit` to post or remove an announcement |
| Documents | `student.view` to see (via a student's profile); `student.delete` to remove one |
| Curriculum | `settings.edit` |
| Fee structure (fee plans) | `settings.edit` |
| Spreadsheet import | `student.edit` |

### 2a. The Business Settings / System Settings split

`settings.edit` was always one capability covering everything under the Settings
tab. The refinement round made explicit what was previously only implied: it
is the **Business Settings** capability — institute details, branches,
academic years, fee plans, curriculum, master data, announcements — and it is
not, and has never been, a path to system configuration. **System Settings**
(Firebase, API and environment configuration) is `system.configure`, already
declared and already reserved (§3) — reused rather than duplicated, since the
"do not duplicate permission definitions" rule applies here as much as
anywhere else. `SETTINGS_GROUPS` in `app.config.js` names both halves of the
split so a reader (or the Roles screen) can find them by name instead of
piecing the distinction together from comments:

```js
SETTINGS_GROUPS = {
    business: { label: 'Business Settings', capability: 'settings.edit' },
    system:   { label: 'System Settings',   capability: 'system.configure' }
}
```

No screen currently exercises `system.configure` — there is no Firebase/
environment configuration UI in the application today — so this split has no
behavioural effect yet. It exists so the day such a screen is built, it has
somewhere correct to attach, without another audit of `settings.edit`'s call
sites to see whether Owner access needs narrowing.

---

## 3. Reserved to Administrator

Six capabilities, listed once in `ADMINISTRATOR_ONLY_CAPABILITIES`. Everything
else reaches the Owner automatically — which is the correct default for an
operational permission, and the reason a new **system-level** permission must be
added to that list at the same time it is added to `CAPABILITIES`.

| Capability | Covers |
|---|---|
| `system.configure` | Firebase configuration, API configuration, environment configuration, application configuration, system constants. Also the "System Settings" half of the settings.edit split — see §2a. |
| `system.maintain` | Application maintenance: database maintenance, migration utilities, developer tools, debug mode, performance tools, version updates, deployment operations, system upgrades. None of it is an academy operating decision, so all of it stays off the Owner's grant regardless of how the application grows. |
| `role.manage` | The permission matrix, creating and deleting roles, editing role definitions |
| `security.manage` | Security policies, password policies, MFA policies, session policies |
| `data.restore` | Restore database, reset/erase database |
| `audit.purge` | Deleting audit entries, clearing audit history |

Four of those six gate no screen today — no part of the application exposes
Firebase configuration, role editing, security policy or maintenance tooling.
They are declared anyway so that the reservation is a fact about the model
rather than an intention, and so the features that eventually need them have a
gate to hang on instead of reaching for `settings.edit` and quietly widening it.

**The Owner can read the audit log and can never delete from it.** That
asymmetry is deliberate and is the point of an audit trail: the highest business
authority is accountable to a record she cannot edit.

### The escalation guardrail

The Owner holds `user.create`, `user.edit`, `user.deactivate` and
`user.changeRole` — she staffs the academy, in full. She may create, edit and
deactivate as many Owner, Teacher & Reception and Viewer accounts as the
academy needs, exactly as an Administrator could.

**The guard is scoped to the account, never to the actor.** The one thing
closed off is anything where an *Administrator account* is on the other end:
she may not create one, may not change anyone's role *to* Administrator, and
may not edit or deactivate an existing Administrator account. Every check
below tests `role == 'administrator'` on the account being touched — never
`isOwnerAccountant()` gating the *actor* more broadly, which would have
(incorrectly) also blocked her from managing other Owner accounts. Without the
narrower, account-scoped version, every reserved capability in §3 would be one
self-granted account away and the reservation would be decoration; with a
broader, actor-scoped version, the Owner's `user.*` grant would be hollow —
technically held, practically unusable for the accounts she actually needs to
manage day to day.

Enforced in two places, which is one place too few to be an accident and the
right number to be a boundary:

- `js/services/settings.service.js` — `requireRoleManagement()` / `requireRoleAssignable()`, called from `createUser()`, `updateUser()` and `deactivateUser()`, each keyed on the *account's* role (`data.role`, `existing.role`, `user.role`), not `session.role()`
- `firestore.rules` — the `/users` `create` and `update` rules, keyed on `request.resource.data.role` / `resource.data.role`, the account being written, not the caller's own role beyond `isOwnerAccountant()` establishing that she holds `user.*` at all

---

## 4. Where enforcement actually happens

| Layer | Strength |
|---|---|
| Navigation and buttons (`session.can`) | Cosmetic. Keeps people out of screens that are not their job. |
| Service calls (`session.require`) | Application-level. Produces a readable refusal, bypassable from devtools. |
| `firestore.rules` | Real. Server-side, applies to every client, cannot be bypassed from the browser. |

Only the third is a security boundary. The other two exist so that a person
sees a coherent application rather than a wall of errors — and so the rules
layer is never the *first* thing that tells someone they can't do their job.

In the rules file, `canAdminister()` is "holds every operational capability" —
Administrator or Owner — and is what a rule uses where it needs the full-access
set. A bare `isAdministrator()` in that file now means one thing only: this gate
is standing in for a reserved capability from §3.

---

## 5. Changing the model

- **Grant the Owner something new:** add it to `CAPABILITIES` and nothing else. She gets it.
- **Reserve something to Administrator:** add it to `CAPABILITIES` *and* to `ADMINISTRATOR_ONLY_CAPABILITIES`.
- **Either way:** check whether a `firestore.rules` block gates the same data, and update it in the same commit.
- **Retiring a capability string:** add it to `CAPABILITY_ALIASES` mapped to its replacements. A role matrix stored in the database (`roles.override`) or carried inside an older backup file can still name the old string; the alias keeps such a matrix granting what it always granted instead of silently granting nothing. `backup.manage` — which used to bundle `backup.create`, `data.export` and `data.restore` — is the first entry.

### Multi-academy

The hierarchy is designed to extend to several academies without a fifth role:
Administrator stays global (one technical authority across all of them), and
Owner becomes per-academy, scoped by the branch mechanism that already exists
(`session.branch()`, every repository's `branchId`). An Owner would then hold
these same 33 capabilities over her own academy's records. Nothing in the
current model needs to change for that; the work is scoping, not permissions.

### Existing accounts

No migration, ever, for a change of this kind. A user document stores a role
*key* (`owner_accountant`), never a capability list — capabilities are resolved
at sign-in by `session.hydrate()` calling `roleCapabilities()`. The existing
Owner account receives the upgraded grant the next time she signs in.

---

## 6. Future: an editable role matrix

Deferred deliberately, 2026-07-30, after review. Settings → Roles stays
read-only until this is done properly, and the screen now says so in as many
words rather than leaving an Administrator to discover it by clicking.

**Why it is not simply a UI feature.** The client half already exists and is
already wired: `configureRoles()` installs a database-sourced matrix,
`roleTable()`/`roleCapabilities()` resolve through it, `roles.override` is the
reserved settings key, and `applyStructuralOverrides()` loads it at boot
(`js/app.js`). Writing an editor would make the matrix editable *in the
browser* tomorrow.

The blocker is `firestore.rules`. It derives permission from the role's
**name**, hardcoded across roughly twenty helper functions —
`myRole() == 'administrator'`, `canManageStudents() { canAdminister() ||
isTeacherReception() }` — and has no representation of a capability anywhere.
Granting `student.edit` to Viewer through a client-side editor would light up
every edit button for that role and then fail every write with *"Missing or
insufficient permissions."* An interface that lies about authority is worse
than one that admits its limits.

**What doing it properly requires, together, in one change:**

1. Resolve each user's capability array at write time and store it on their
   `users` document, so a rule can read it without a second lookup.
2. Rewrite `firestore.rules` to test capabilities (`myCaps().hasAny([...])`)
   instead of role names — all ~20 helpers and every block that calls them.
3. A backfill re-stamping capabilities onto every existing account, and a
   re-stamp triggered whenever the matrix is edited afterward.
4. **A rules test harness first.** These rules are hand-written and have never
   been under automated test (ADR-014 discloses this as a known risk). A
   mistake in a rewrite this size locks every user out of the database with no
   client-side appeal. The harness is not optional scope; it is the thing that
   makes the rest safe to attempt.

**Meanwhile** the model is not rigid in the way that matters day to day: role
*assignment* is fully editable per user in Settings → Users, and adding a
capability to the Owner's grant is a one-line change to `CAPABILITIES` (§5).
What is fixed is the set of four role names and the capability list attached to
each — and the Owner upgrade already moved those to where the academy needs
them for normal operation.
