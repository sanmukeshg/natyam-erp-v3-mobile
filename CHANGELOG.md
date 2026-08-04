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
