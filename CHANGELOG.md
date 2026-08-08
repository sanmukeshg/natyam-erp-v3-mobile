# Changelog — Natyam ERP v3 (Mobile)

All notable changes to the mobile application.

This changelog starts at **3.0.0**, not at the reference project's 2.26.5. v3 is not a
continuation of that codebase in place — it is a new application, built by splitting
`Natyam-ERP-UAT` into two independent repositories, with a mobile-first staff experience that
did not exist before. The reference project's own history remains where it is; nothing was
moved out of it.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning is
[semantic](https://semver.org/).

---

## [3.5.1] — unreleased

Two follow-ups, both raised after Round 6 was already live.

### Added

- **A global icon standard** (ENH-7XX). Coloured icon chips are now tinted through four
  semantic tones — `positive`, `negative`, `caution`, `info` — set with a `data-tone`
  attribute and resolved entirely from theme tokens. Three chip classes had solved the same
  problem privately before this (`.m-quick-icon` took a hex pair from JavaScript,
  `.m-announce-icon` hardcoded one blue, `.m-note-icon` had the right idea already), and the
  dashboard carried **14 one-off colour literals** as a result.
- **`--v3-info` / `--v3-tone-bg-info`, in both themes.** There was no token for "neither good
  nor bad", which is why individual screens kept inventing a blue. `#9BD2F0` was chosen by
  measurement: 4.53:1 on a chip, inside the band the other three tones already occupied.

### Changed

- **Icon chips now meet WCAG 2.1 SC 1.4.11.** They ran **1.42–2.06:1** against a 3:1 floor for
  non-text contrast, while the analytics palette on the same screen ran 3.72–6.21:1 — which is
  why the two halves of the dashboard looked like different products. They now measure
  **7.29–8.33:1 dark** and **4.76–6.27:1 light**. Buttons, the tab bar, More-sheet rows and the
  FAB were audited at the same time and already passed at 4.68–15.06:1; they are unchanged.
- **Chip icons stroke at 2.1**, not 2. At 17px a 2px stroke lands on roughly 1.4 device pixels,
  and that thinness read as "dim" before colour entered it.
- **No navigation tile is red.** `negative` is defined and measured, but a permanent tile is
  never in an error state — coluring Admissions red teaches people to ignore red, which then
  fails where it has to work. Operational tiles take amber instead.
- **Guardian email is mandatory on the mobile New student and Admission application forms.**
  It was already required by `studentFields.js` on desktop and on mobile Add student; the
  applicant step of the admission form and the parent self-service form still treated it as
  optional, so an application could be approved into a student record that then failed its own
  validation on the next edit. The parent form pre-fills the signed-in Google address, so
  requiring it costs the family nothing — it was a placeholder before, which is grey text that
  looks like an answer and is not one.

---

## [3.5.0] — 2026-08-08

UAT Round 6, plus the server half of ENH-510. All four items — BUG-601, BUG-602, ENH-601 and ENH-602 — land in both apps,
because all four change a workflow rather than a screen.

### Added

- **`functions/` — the push sender** (ENH-510). Thirteen Cloud Functions in `asia-south1`:
  eight scheduled (class reminders, owner daily digest, attendance nudge and evening sweep,
  fee reminders, payroll reminder, holiday and event reminders) and five Firestore triggers
  (payment recorded, admission created, admission status changed, session status changed,
  announcement posted). The client half shipped in 3.4.0 and had nothing sending to it until
  now. All scheduling is `Asia/Kolkata`; failures are swallowed rather than thrown, because a
  retry on a notification job means the same person is told twice.
- **`js/config/studentFields.js` — one definition of the student record** (ENH-602). The
  student form's fields, and which of them are mandatory, are declared once and built from
  three places: Add student, Edit student, and the Admissions enrol step. Byte-identical in
  `natyam-mobile` and `natyam-admin`. There were three separate declarations before this, and
  they disagreed — the same child got a different record depending on which screen they were
  entered on.
- **The mandatory set, stated in one place**: name, branch, level, batch, fee plan, guardian
  name, guardian phone, guardian email. Enforced identically on Add, Edit and Enrolment, with
  the same wording on every message.
- **`enrolApplicant()` accepts the collected student record** (`options.student`), applied
  through a named whitelist (`ENROLLED_STUDENT_DETAILS`). Called without it, it behaves
  exactly as before.

### Changed

- **Enrolling a parent application collects the whole student record, in one step**
  (BUG-601). Enrol used to ask three questions — branch, batch, fee plan — and copy
  everything else off the application. A family application carries no address, no emergency
  contact and no medical note, so the student was created incomplete and the Owner had to open
  Student Management → Edit student immediately afterwards to finish it. Enrol now opens the
  full student form, pre-filled from the application, and the read-only confirmation still
  restates branch, batch and fee plan before anything is written.
- **Changing a student's branch now requires a batch at the new branch** (BUG-602). The batch
  list follows the Branch field, and a batch belonging to another branch is refused by name
  ("That batch is at another branch"). Saving is blocked until a valid one is chosen, so a
  student can no longer end up in one branch attached to a class in another.
- **Batch is mandatory when editing a student**, not only when adding one (BUG-602). It was
  optional on edit on both apps, which is how a branch change could clear it silently. Taking
  an attending student off every batch is no longer possible from any screen — see the
  invariant below.
- **The Staff module is Owner and Administrator only** (ENH-601). `staff.view` is no longer
  granted to Teacher & Reception or to Viewer, so the Staff entry disappears from the menu and
  the dashboard, and the router refuses `/staff` typed into the address bar. Teacher names on
  Batches, Timetable, Attendance and Programmes are unaffected — those read a name, not the
  staff module, and the Firestore read rule is deliberately unchanged for that reason.

### Fixed

- **A guardian's email typed at enrolment is stored lowercase and trimmed**, as it already was
  on every other path into a student record. `guardianAuth.service.js` matches a signed-in
  parent with an exact-equality query against the lowercase address Firebase returns, so
  "Priya@Gmail.com" would have signed in and been told she had no children at the school.

### Added — the invariant

- **`MANDATORY_STUDENT_FIELDS` is now the authority, not documentation** (ENH-602, revised).
  No field declaration carries its own `required:` or `label:` any more — both are derived from
  that one array and from `FIELD_LABELS`. Changing what the ERP demands of a student record is
  a one-line edit that lands on Desktop Add, Desktop Edit, Mobile Add, Mobile Edit and Parent
  Enrolment in the same commit, with nothing else able to hold a second opinion.
- **`assertMandatoryStudentFields()` — the same rule enforced in the service layer.**
  `enrol()`, `updateStudent()` and `enrolApplicant()` all call it, so a workflow that renders
  no form — a bulk operation, an import, a screen written next year — cannot get past it
  either. The message is the same sentence a form would have shown.
- **`tools/verify-shared.cjs`** — checks the byte-identical shared files (the student field
  config, four services, `firestore.rules`) against the sibling repository, so "identical by
  convention" is checkable in one command rather than by memory. Compares content with line
  endings normalised, and skips cleanly when no sibling checkout exists.

### Changed — no active student without a batch

The rule behind BUG-602 ("a student must never exist without a valid batch") was only ever
enforced by whichever form happened to be open. Four service paths could break it with no form
involved, and one of them did so on **every** use:

- **Promotion now includes the destination batch.** `promote()` cleared the batch and left the
  student active — which is exactly the forbidden record, produced every single time somebody
  was promoted. It now takes a batch that teaches the *new* level and moves them straight into
  it. Where no batch teaches that level yet, the promotion is refused with that as the reason,
  and the dialog does not open.
- **"Take them off every batch" is gone from Move batch.** `assignToBatch(id, null)` is refused
  for an active student, and the dialog says to use Status instead — which clears the batch
  properly, as part of recording that they have stopped attending.
- **Returning from leave asks which batch.** `setStatus(ACTIVE)` on a student whose batch was
  cleared when they left now requires one, offering only batches teaching their level at their
  branch.
- **Editing cannot blank a mandatory field.** `updateStudent()` validates the *merged* record,
  not just the fields sent, so no partial write can empty one.

Not scoped to active students, deliberately: a graduated or inactive student *should* have no
batch, and leaving them on a register is the opposite mistake.

### Fixed

- **A student moved out of a closing batch now gets the new batch's timetable.**
  `closeBatch(…, { moveTo })` reassigned `batchId` but left `batchSchedule` — the copy each
  student carries for the Parent Portal — naming the batch being closed, with its old days and
  times. Nothing else rewrites that field until the student is next edited by hand, so every
  family moved out of a closing batch would have read the wrong timetable indefinitely.
- **Leaving now clears the stale timetable copy too.** `setStatus()` cleared `batchId` on a
  leaver but left `batchSchedule` behind it, so a graduated student's family kept seeing a
  class schedule.

### Changed — fee plan is protected like the mandatory field it is

- **Deleting a fee plan no longer unlinks the students on it.** `deleteFeePlan()` set
  `feePlanId: null` on every student pointing at the plan, which silently created exactly the
  record the rest of the ERP refuses to save — and stopped their billing outright, because
  `runBillingScheduler()` only raises fees for a student who has a plan. It now refuses while
  students remain and accepts a `moveTo` plan to reassign them in one go, following
  `closeBatch()`, which had the same problem with batches. The refusal carries the student
  list so a UI can name them. Counts students of every status: a graduated student with
  unsettled invoices and a dangling `feePlanId` is exactly as broken.
- **A student on a retired fee plan can still be edited.** Only active plans are offered, so
  the moment a plan was retired every student on it became un-editable — their own plan was
  not in the list, the select fell back to the placeholder, and the form demanded a new plan
  before it would save a corrected phone number. The student’s current plan is now kept in
  the list and marked “(retired)”; every other retired plan stays hidden.

### Fixed — deployment

- **The app shell is no longer CDN-cached for an hour after a deploy.** `firebase.json`’s
  no-cache header matched the literal path `/index.html`, which the SPA rewrite never produces
  for a request to `/` — so every `.js` and `.css` was `no-cache` while the page loading them
  was cached for an hour, and anyone with the app open kept the old shell until it expired. A
  `"source": "/"` rule alongside the existing one closes it. Carried since UAT Round 5 and
  included here because v3.5.0 changes enough screens that a stale shell would be visible.
  `/` is the only HTTP path that serves the shell — the router is hash-based, so there are no
  deep paths to cover.

### Notes

- Date of birth and gender are **not** in the mandatory set — asked during the round and
  answered No on 2026-08-08. Both admission forms require them, so a student arriving through
  Admissions has both regardless; requiring them here would additionally block an unrelated
  edit on every student already on the roll who has neither.
- Move batch, Promote and Status all requiring a batch was confirmed in the same exchange.
- Staff on mobile remains read-and-reach — hiring and ending employment stay on
  `natyam-admin`, unchanged by ENH-601.

---

## [3.4.0] — unreleased

UAT Round 5, Phases 1 and 2. Every mobile item in `UAT Round 5 - Phase 1.docx` and
`UAT Round 5 - Phase 2.docx`.

BUG-507 (second parent application stuck on "Sending Details") is **not** in this release —
withdrawn during the round for re-testing.

### Added

- **Current Trends on the owner dashboard** (ENH-506). The unlabelled statistic strip is now a
  visual section: money in against money out over six months, this month's split as a donut,
  and Students / Attendance / Collected as sparklines with a direction chip. Needs attention
  and the three workspace groups are untouched, as the ticket asked.
- **`js/ui/charts.js`** — sparkline, paired bars, donut and delta chip as inline SVG. No
  dependency, deliberately: this is an offline-capable PWA and the smallest serious chart
  library is fifty kilobytes to draw six points. Colours are v3 tokens, so both themes follow
  the stylesheet.
- **Analytics rebuilt as a BI dashboard** (ENH-505). Ten executive KPI cards two across,
  auto-generated business insights, income and expense category splits, students by batch,
  admissions by month, and filters for date range, branch, academic year, course and batch.
- **Web push, client half** (ENH-510). Permission flow, FCM token capture, per-device category
  and timing preferences, background service worker, and `/pushSubscriptions` rules. **No
  sender exists yet**, so nothing is delivered until a Cloud Function is built — see
  `docs/push-notifications.md` for the contract. The settings screen says so on screen.
- **Reverse a fee waiver** (ENH-507). A written-off fee can be made payable again; the waiver's
  Money Out is cancelled by a contra entry rather than deleted, and the reversal is audited.
  Waived invoices are now listed at all — a waiver zeroes the balance, and every invoice list
  filters on `balance > 0`, so they had been invisible on every screen.
- **An Owner can be assigned to a batch** (ENH-512). `STAFF_ROLES` gains Owner with
  `teaches: true`, and batch assignment follows that flag instead of a literal role check.

### Fixed

- **The teacher dashboard found no classes, ever.** `users` are keyed by email and `staff` by a
  business code, and a batch stores the code — so `byTeacher(session.actorId())` could never
  match. On live data: five batches found by staff id, zero by user id. `session.staffId` now
  resolves the staff record at sign-in via the email both records already carried. The batches
  page's "Mine" filter had the same cause and the same non-result.
- **Enrolment asked for the branch twice** (BUG-506). The branch is chosen once in the enrol
  sheet; the dialog that follows confirms all three choices read-only under Edit / Confirm,
  replacing a second live selector under "Cancel / Begin review" — a stage that no longer exists.
- **Dialog footers sat under the tab bar on iPhone** (BUG-505). Not z-order, which was already
  fixed: `.m-modal` was capped at `88vh` while the scrim's padded box was ~86.6vh, so tall
  dialogs overflowed into the bar's strip. Measured 55px of overlap; now zero.
- **Fee plan was missing from the mobile student edit form** (BUG-504). It had been hidden on
  the grounds that changing a plan raises a schedule — which is untrue of the edit path:
  `updateStudent()` writes the field and stops. The help text now states what a change does.
- **Payroll was missing from "Where it went"** (ENH-504 Part 3). The breakdown read the
  `expenses` collection; payroll posts straight to the ledger. Both breakdowns are now
  ledger-derived and reconcile with the Money Out figure above them.
- **The user edit form could deactivate the last Administrator**, locking the school out. Its
  Status field routed through `updateUser()`, which knew none of the rules the Deactivate
  button enforces. Both now share one `assertMayDeactivate()`.

### Changed

- **Finance is a cashbook** (ENH-504 / ENH-508). Net, Money in, Money out and Margin, then
  "Where it went", then a transaction list. Rows are one line and open a detail sheet with
  Edit and Delete — the inline buttons and lock explanations made every row three lines tall.
  The six-month trend moved to Analytics, which can range over it properly.
- **Analytics ranges** are 30 days / 3 / 6 / 12 months / custom, and trend lists are capped at
  four months, opening at the newest end.

---

## [3.2.0] — unreleased

Second UAT round. Every mobile item in
`Bugs_and_Enhancements_v3_Mobile and Desktop - Round 2.docx`.

### Added

- **Programmes can be created and edited** (BUG-201). They were read-only here: no way to
  schedule one and no way to correct a date or venue once scheduled. Both flows go through the
  same services the desktop app uses, so the service's shape assertions — an examination needing
  a level — are enforced identically.
- **Certificates can be issued and revoked** (BUG-202). The Student sheet offered "Issue
  certificate" but this module could only verify. Issuing asks the service for eligibility and,
  when refused, offers an override whose reason is stored on the certificate itself. Revoking
  requires a reason, which is what every future verification returns.
  **Edit and Delete are deliberately absent.** A serial is permanent and may already be in a
  family's hands: editing would silently change what a past verification returned, and deleting
  would make a serial that was really issued verify as non-existent. Revoking is the correcting
  path — it keeps the record and says why.
- **Guardian contact details are editable** (BUG-204). There is no guardian *record* to edit — a
  household is derived by grouping students on the guardian's phone number, and the details live
  on each child's row — so one edit writes to every child in the household. Changing the number
  re-keys the household, and the dialog says so before you submit.
- **Master data is editable** (BUG-206). Branches, Fee plans and Curriculum could be added but
  not corrected. Each editor reuses its create field list, seeded from the record. A curriculum
  entry's stored value is shown read-only because existing student, batch and certificate
  records point at that key.
- **`readonly` fields and value-dependent options** in `js/ui/form.js`, matching natyam-admin:
  `options` may be `(values) => [...]`, paired with `reactive: true` on the field being chosen
  from.

### Changed

- **Bottom navigation redesigned** (ENH-203). The large solid-terracotta pill under the active
  tab is gone. The bar is now dark, floating and slightly shorter, and the ACTIVE ICON carries
  the state — filled terracotta with a small dot beneath it — while every other tab stays a
  muted outline. `fill="none"` is a presentation attribute on the `<svg>` and CSS outranks it,
  so one icon set serves both states.

### Fixed

- **The fee collection popup closed when any field was tapped** (BUG-203, Critical). A
  regression introduced in 3.1.0 when the dialog moved to a centred modal: the backdrop became
  the dialog's *parent* and carried `data-action="cancel-pay"`, so a delegated `closest()` match
  from any field inside resolved to it. The `stopPropagation` guard could not help — `on()`
  binds one listener per selector on the same root element, and that does not stop siblings.
  Only a direct hit on the backdrop dismisses now, the rule `js/ui/form.js` already applied to
  its own scrim. Every other scrim in the app is an empty *sibling*, so nothing else was
  affected.
- **The attendance Save bar overlapped the tab bar and hid the last students** (BUG-210). It was
  `position: fixed` at `bottom: safe-bottom + 62px`, where 62px was a guess at the tab bar's
  height — it is 63px plus a 10px margin. It is now sticky *inside* the scroller, so it cannot
  reach the tab bar at any safe-area inset or bar height, and the roster no longer needs a magic
  padding that drifted out of step with it. The helper text is gone and the button takes the
  width, with no panel of its own.
- **The batch dropdown ignored the branch** (BUG-208). Batches came from
  `listBatches(session.branch())` — the session's branch filter, not the branch chosen in the
  form — so with "All branches" in view, picking Kondapur still offered Hafeezpet's classes.
  Move batch is likewise scoped to the student's own branch.
- **Analytics → Trends was cramped** (BUG-205). A chip row used as an in-page filter had no room
  beneath it: inside `.m-subhead` the header's padding supplies that gap, and Trends puts the
  chips directly in the content column.
- **The app bar and search strip sat on a cream panel.** Both now show the app background — the
  bar is fully transparent, and the sticky search row repeats the shell's own `fixed` backdrop
  so it hides scrolling rows without a visible seam. Header text and controls moved to the
  light-on-dark treatment; the search field is glass rather than a white slab.

## [3.1.0] — unreleased

First UAT round. Every item in `Bugs and Enhancements v3 mobile.docx`, which was the sole
source of truth for this round — no undocumented changes.

### Added

- **Batch editing** (BUG-601). An owner standing in the studio can now fix a room, a time or
  a teacher without walking to a desktop. Same field list, same service call and same
  clash-override confirmation the desktop app makes — a phone is a smaller screen, not a
  laxer one. Creating and closing batches stay desktop-only: closing asks where the enrolled
  students go.
- **Student management actions** (BUG-602). Opening a student showed the record but offered
  nothing to do with it. Six actions now: Edit student, Move batch, Promote, Change status,
  Collect fee, Issue certificate — driven through the same services as desktop, so the rules
  (a full batch is refused, a leaver must have a reason recorded, a certificate's eligibility
  is checked) are identical on both surfaces. Collect fee hands off to the Fees screen with
  that student's ledger open, rather than rebuilding the invoice list inside the sheet.

### Fixed

- **Toasts were completely unstyled** (ENH-614, ENH-615). `js/ui/toast.js` has always been
  the one shared notification component, but its only stylesheet lived in
  `components.css` — which this app deliberately does not load. Every toast the app has
  ever raised rendered as unstyled text at the foot of `<body>`. Styled in the mobile design
  language: slides from the top, tinted icon, auto-dismisses, never blocks interaction. No
  call site changed. Errors stay until dismissed, deliberately — a failed save that vanishes
  after three seconds is how a failure gets mistaken for a success.
- **Sign-in controls fell back to browser defaults** (ENH-611). `auth.css` reuses
  `.btn` / `.switch` "for semantics" on the assumption that `components.css` supplies
  the bases — it does not here. Hence the stock border on the sign-in button, the off-centre
  Google mark, and a checkbox where the markup already asked for a toggle. The bases are now
  defined in this app's own auth stylesheet: Google is a white pill, the sign-in button
  matches the inputs' radius, Remember me is a real switch.
- **Dialogs read as full-screen pages** (ENH-612, ENH-613, ENH-620). `max-height: 100%`
  with the whole box scrolling meant a twenty-field form grew until it filled the viewport.
  Capped at 88vh with fixed chrome and a scrolling body, so a two-field dialog and a
  twenty-field one are recognisably the same component. Fee collection moved from a bottom
  sheet into that same family.
- **Opening a form opened the keyboard** (ENH-616). The first field was auto-focused on every
  modal, shoving the form up the screen before it could be read. The dialog takes focus
  instead — Escape, screen readers and tab order still work, the keyboard does not appear.
  Amount stays pre-filled.
- **Date fields were taller and wider than their neighbours** (BUG-617, BUG-618). The native
  date widget asserts its own intrinsic size, ignoring the padding and height every other
  input follows. `appearance: none` plus a fixed height and `box-sizing` puts it back
  under this stylesheet's control, across date, time, datetime-local, month and week.
- **The scrollbar started at the header** (BUG-604). The subhead stuck at `top: -14px`, so
  it travelled before pinning. It is now fixed at `top: 0` and the list scrolls beneath it.
- **KPI value and label ran together** as "₹1.14LIn" (ENH-610). They were two *inline* spans;
  `margin-top` on an inline element does nothing. Stacked properly, with semantic tones —
  money in green, money out red, margin the brand terracotta — and the cards no longer touch
  (BUG-603).
- **Header took too much vertical space** (ENH-619). Reduced from ~76px to ~50px: the logo
  mark is gone, the search and avatar are smaller, and the avatar keeps a 44px tap target via
  a pseudo-element. The bar now sits directly on the app background with no panel of its own,
  and the sticky search row paints the shell's own backdrop so there is no visible seam.
- **The app disagreed with itself about what a control looks like** (ENH-621). `.m-input`,
  `.m-field` and the fee badges were each declared twice with different radii, alphas and
  backgrounds; five copies of the KPI helper rendered in two different orders. Deduplicated
  and unified, and the header's controls now share one glass treatment instead of being
  light-on-white left over from a background that no longer exists.

## [3.0.0] — unreleased

The mobile half of the v3 split. **Not yet feature-complete** — see
`MIGRATION_CHECKLIST.md` for exactly which modules have migrated and which have not.

### Added

- **Independent application.** `natyam-mobile` is its own repository, its own deployable, and
  its own PWA manifest. It shares the Firebase project (`natyam-erp`), Firestore collections,
  security rules, authentication, roles and data model with `natyam-admin`, and nothing else.
- **A mobile-first staff experience, which the school did not have before.** Until now,
  Teacher & Reception used the same desktop chrome as an Administrator. They now get a top app
  bar, a five-slot bottom tab bar (Home / Students / Fees / Attendance / More), a More sheet,
  and screens built for a thumb rather than a mouse.
- **v3 mobile design layer** (`assets/css/v3.css`) — implemented from the approved Claude
  Design project. Real `env(safe-area-inset-*)` handling rather than the mock's hardcoded iOS
  insets, so the chrome is correct on notched phones, flat phones and desktop browsers.
- **Dashboard, in two role variants.** Teacher & Reception get a task-first screen — classes
  today, registers still to mark, quick actions — with no collection figures. Owner &
  Accountant get the full picture: a scrollable KPI strip, needs-attention cards, insight
  tiles and recent activity.
- **Students** — full-width tappable cards with an always-visible search, scrollable filter
  pills, a floating add button, and a near-full-screen profile sheet that includes a
  tap-to-call guardian action.
- **Guardian Parent/Student Portal**, carried over unchanged: six read-only pages, the child
  switcher, and its own `Router` instance (a guardian has no `users` document, so the staff
  router's live-status re-check would fail on every navigation).
- **Role gate at sign-in.** Mobile serves Owner & Accountant and Teacher & Reception.
  Administrator is turned away and pointed at the desktop app. A genuinely unrecognised
  identity is retried as a guardian before being refused.
- **`tools/verify-imports.cjs`** — a static import checker, since there is no build step.

### Changed

- **Navigation is authored for mobile, not filtered from desktop.** `NAVIGATION`/`ROUTES` were
  removed from `app.config.js`; this app owns a tab bar plus a More sheet. Permission logic is
  still shared, through the same `CAPABILITIES` and `ROLES`.
- **`repositories.js` re-exports only what this app imports**, rather than every entity.
- **Idle-activity tracking listens for `touchstart`.** A phone user scrolling and tapping
  generates no `mousemove`; without it a genuinely active session would time out under their
  hands.

### Removed

- Every desktop page and the desktop shell. Per the split brief, this app does not reuse
  desktop layouts or make them responsive.
- IndexedDB (`js/core/db.js`, `js/core/repository.js`, `seed.js`, `js/data/archive/`).

### Notes

- **v2 stylesheets load only for guardian sessions.** The portal was copied as-is and is
  therefore styled against v2's `shell.css`/`components.css`/`modules.css`. Those are injected
  at guardian sign-in rather than from `index.html`, so a staff session downloads none of them
  and the two design systems never coexist in one document.

### Known gaps

- Phase 1 modules **not yet migrated**: Admissions, Attendance, Fee collection, Batches,
  Timetable, Notifications, Profile, Settings. Their tab and More-sheet entries render and
  route to an honest placeholder rather than being hidden.
- Finance, Reports, Analytics and Certificates are deliberately out of Phase 1 and will arrive
  later with mobile-designed workflows.
- Adding and editing a student is drawn but disabled — it needs the student form.
- A real guardian sign-in has not been verified against live Firestore; it needs a parent
  credential whose phone or email matches a student record.
