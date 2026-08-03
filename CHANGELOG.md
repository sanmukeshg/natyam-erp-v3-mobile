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
