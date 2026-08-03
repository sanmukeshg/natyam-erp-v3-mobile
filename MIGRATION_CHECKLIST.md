# Migration checklist — natyam-mobile

Source project: `D:\Shanki\Natyam\Projects\Natyam-ERP-UAT` (read-only reference throughout;
nothing in it was ever edited). Rows are added as files are actually touched, not
reconstructed after the fact. See `composed-popping-ritchie.md` (the approved plan) for the
rules this follows.

## Stage 0 — bootstrap skeleton, no feature modules

| Source path | Destination path | Action | Notes |
|---|---|---|---|
| `js/config/firebase.config.js` | same | copied as-is | same Firebase project (`natyam-erp`) as both new apps |
| `js/config/app.config.js` | same | trimmed | removed `NAVIGATION`/`ROUTES` exports (this app defines its own nav table separately — a bottom-nav/more-menu list, not a filtered copy of the desktop's — not yet added, see Stage 1); kept `APP`, `SESSION`, `SCHEMA`/`STORE_NAMES`, domain status enums, `CAPABILITIES`, `ROLES`, curriculum/role resolution helpers, `PREFERENCE_DEFAULTS` |
| `js/core/bus.js` | same | copied as-is | generic infra |
| `js/core/firebase.js` | same | copied as-is | generic infra |
| `js/core/session.js` | same | copied as-is | generic infra |
| `js/core/repository.js` | — | **excluded** | dead code for this app: no Firestore repository imports it |
| `js/core/db.js` | — | **excluded** | IndexedDB is fully retired for every store this app uses — same reasoning as `natyam-admin`, see its checklist |
| `js/utils/date.js` | same | copied as-is | used by users/branches/sessions/auditLog repositories |
| `js/utils/id.js` | same | copied as-is | used by auditLog repository |
| `js/utils/dom.js` | same | copied as-is | used by login page |
| `js/utils/csv.js`, `money.js` | — | **excluded (for now)** | no Stage 0 code needs them |
| `js/data/sequenceGenerator.firestore.js` | same | copied as-is | |
| `js/data/users.repository.firestore.js` | same | copied as-is | |
| `js/data/branches.repository.firestore.js` | same | copied as-is | |
| `js/data/sessions.repository.firestore.js` | same | copied as-is | login-session records, not Timetable class sessions |
| `js/data/auditLog.repository.firestore.js` | same | copied as-is | |
| `js/data/repositories.js` | same | **trimmed** | only re-exports `branches$`, `users$`, `authMethodsOf` |
| `js/services/auth.service.js` | same | copied as-is | |
| `js/services/auth/providers/{google,password,mobileOtp}Provider.js` | same | copied as-is | |
| `js/modules/auth/login.page.js` | same | copied as-is | shared login screen; not redesigned (no login `.dc.html` exists, and the reference login screen is already desktop/mobile responsive) |
| `assets/css/{tokens,base,auth}.css` | same | copied as-is | component styles and the mobile shell's own CSS excluded for now |
| `assets/img/brand/*`, `assets/icons/*` | same | copied as-is | |
| `firestore.rules` | same | copied as-is | **reference copy** — canonical copy lives in `natyam-admin`; kept identical here, never edited independently |
| `docs/architecture/`, `docs/migrations/` | same | copied as-is | reference documentation |
| — | `js/app.js` | **new** | minimal boot: Firebase auth watch → `resolveProvisionedUser` → mobile role gate (owner_accountant/teacher_reception; administrator turned away) → session hydrate → placeholder authenticated screen. No router, no MobileShell yet — arrives with the first real module in Stage 1. Guardian-portal fallback is a `TODO` until `js/modules/portal/` is copied in (end of Stage 1) |
| — | `index.html`, `manifest.json` | **new** | "Natyam ERP v3 — Mobile" branding from the start (same reasoning as `natyam-admin`'s checklist: these are new files, not copies, so there's no unbranded intermediate state to transition through) |

**Not included in this app, and why:** `js/modules/dashboard/…page.js` etc. (desktop pages) —
this app never gets desktop layouts, per the split spec ("do not reuse desktop layouts"). Its
own mobile pages are new files built from the Design project, added module by module in
Stage 1.

## Stage 2 — Mobile shell + Dashboard

(Stage 1 was natyam-admin's Dashboard; this app's first feature stage is Stage 2, so the
numbering stays shared across both repos and matches the order work actually happened in.)

The Dashboard is an aggregate view, so its dependency closure is the widest of any module —
it reads from most collections even though most *screens* do not exist yet. That is the
Dashboard's nature, not speculative copying: the closure was computed from its actual
imports, and is the same one natyam-admin needed.

### New — built from the approved Claude Design project

| Destination | Action | Notes |
|---|---|---|
| `js/ui/mobileShell.js` | **new, per `Dashboard.dc.html` (mobile half)** | Top app bar + five-slot bottom tab bar (Home / Students / Fees / Attendance / More) + More sheet. Explicitly **not** a narrowed copy of natyam-admin's sidebar shell. Distinct from `portalShell.js`, which stays guardian-only |
| `js/modules/mobile/dashboard.page.js` | **new, per `Dashboard.dc.html` (mobile half)** | **Both role variants**, because this app serves both: Teacher & Reception get the task-first screen (stat tiles → classes today → missing registers → quick actions); Owner & Accountant get the full one (scrollable KPI strip → needs attention → insights → activity). Computes nothing — every figure comes from the unmodified `dashboard.service.js` |
| `assets/css/v3.css` | **new** | Mobile design layer. Not shared with natyam-admin — the two apps' chrome genuinely differs. Design's hardcoded iOS insets (62px top / 22px bottom, artefacts of its device frame) replaced with `env(safe-area-inset-*)` so the chrome is correct on notched phones, flat phones and desktop browsers |
| `js/config/navigation.js` | **new** | This app's own table: `TABS` (bottom bar) + `MORE_ITEMS` (sheet) + derived `ROUTES`. Authored independently, not the desktop's five groups filtered down |
| `js/modules/system/pending.page.js` | **new** | Honest placeholder for the nine Phase-1 modules not yet migrated |
| `tools/verify-imports.cjs` | **new** | Same static import checker as natyam-admin |

### Copied unmodified (business logic preserved exactly)

Identical set to natyam-admin's Stage 1: `js/core/router.js`; the 8 services
(`dashboard`, `admissions`, `attendance`, `audit`, `fees`, `finance`, `notifications`,
`session`); the 18 Firestore repositories; `js/ui/{icons,toast}.js`; `js/utils/money.js`.
`js/data/repositories.js` extended from 3 re-exports to the ~30 this closure needs.

### Placement decisions the design did not cover

The design mocks a screen, not a working session, so it draws no branch switcher, theme
toggle or sign-out. A phone has no header room for them, so they live in the **More sheet**
rather than being dropped. The app bar shows the greeting + date on the dashboard exactly as
designed, and the page title elsewhere — on a phone, knowing which screen you are on matters
more than repeating the date.

`chart.js` was **not** copied (the mobile design has no charts). `palette.js`,
`backup.service.js` and `components.css` remain excluded, as in natyam-admin.

### Still open in this app

- **Guardian portal not wired.** `js/modules/portal/`, `guardianAuth.service.js` and
  `portalShell.js` have not been migrated. The `not_provisioned` → guardian fallback seam is
  marked in `js/app.js` with the exact code that attaches there. Until then a guardian is
  told their account is not set up — the same answer the reference app gives an unknown
  identity, so no regression, just an unfinished half.
- `forTeacher()` is passed `session.actorId()` (a **user** id) exactly as the reference app
  does. If the reference has a user↔staff id mismatch there, it is preserved rather than
  silently "fixed" — flagging it as worth confirming against real data.

### Verified

- `node tools/verify-imports.cjs` → 54 modules reached, all imports resolve, nothing unreached.
- Teacher & Reception variant at 375×812: 5 tabs, 2 stat tiles, 3 class cards, 4 quick
  actions, greeting in the app bar, every tap target ≥44px.
- Owner & Accountant variant: 5 tone-coded KPIs in a horizontally scrolling strip, 2
  attention cards, 4 insight tiles computed from real panel data (₹8.42L / 87% / 4/5 / 342),
  activity rows, and **no horizontal page overflow**.
- More sheet opened by real tap: slides up over a blurred scrim, all six entries, branch
  switcher, theme toggle, sign out. **Settings correctly appears for Owner & Accountant and
  is correctly hidden for Teacher & Reception** — capability gating through the shared
  `ROLES` table works.
- natyam-admin re-checked after this stage: still boots, no console errors.
- **Bug found and fixed during this stage:** the bottom tab bar never showed a selected
  state. `html``` escapes interpolated values, so a conditional `aria-current="page"` string
  became visible text instead of an attribute. Now set via `setAttribute` in `markActive()`,
  mirroring natyam-admin's shell. (Checked the related `${cond ? 'selected' : ''}` pattern
  inherited from the reference app — that one is safe, since `escapeHtml` only touches
  `& < > " '` and `selected` contains none of them.)
- **Not verified:** a real signed-in session against live Firestore — needs real credentials.

## Stage 3 — Students

### New — built from the approved design

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/students.page.js` | **new, per `Students.dc.html`** (mobile half) | Full-width tappable cards + near-full-screen profile sheet. Explicitly not the desktop roll narrowed: search is always visible (finding one child is the primary phone task, not a filter toggle), filters are horizontally scrolled pills, and a FAB sits above the tab bar |
| `assets/css/v3.css` (appended) | **new section** | Sticky sub-header, search, pills, student cards, FAB, profile sheet, metrics/notices/facts |

### Copied unmodified

`js/services/students.service.js`, plus `js/data/{curricula,documents}.repository.firestore.js`.
`repositories.js` extended with `curricula$` and `documents$` only.
`academicYears` and `curriculumLevels` were copied then **removed** — unreached, same
over-reporting reason recorded in natyam-admin's checklist.

### Deliberate departures from the design

| Change | Why |
|---|---|
| Row shows **one** badge (fees), with status as text under the name | Two badges plus a name do not fit 375px without truncating the name — the one thing the row exists to show |
| Search field and filter button raised **42px → 44px** | The split spec calls for touch-friendly controls; 44px is the iOS/WCAG 2.5.5 floor. A 2px deviation beats a target under the accessibility minimum |
| Filter chips left at the design's **33px** | They sit in a secondary scrolled row where 44px reads heavy, and 33px still clears WCAG 2.5.8's 24px AA floor. The CSS header was corrected to state this exception rather than claim a blanket 44px |

### Verified

- `node tools/verify-imports.cjs` → 58 modules, all resolve, nothing unreached.
- List at 375×812: 3 cards, correct fee badges, status shown inline for non-active, live count,
  all four pills, FAB clear of the tab bar, search at 16px (no iOS focus-zoom), **no horizontal
  overflow**.
- Profile sheet: opens at 86vh, six tabs, metrics (`79%` / `₹3.5K` / `14mo`), both notices,
  facts list, and a **tap-to-call guardian** action on the People tab — a mobile affordance the
  desktop has no equivalent for.
- natyam-admin re-checked after this stage: still boots, Students live, no console errors.
- **Bug found and fixed (affects both apps):** see natyam-admin's Stage 3 note — the design's
  "light" variant keeps white type, so its lightening scrim washed content out on the real
  artwork. The scrim now darkens in both variants.

## Stage 4 — Guardian Parent/Student Portal

Done out of the planned order. Stage 4 was to be Attendance, but the Claude Design project
became unreachable mid-migration (see `docs/design/README.md`), and implementing a designed
module without its `.dc.html` would mean inventing a layout. The Portal is the one piece the
plan explicitly exempts from the design project — "copied as-is, already mobile-first, already
read-only" — so it needed no design and could proceed.

### Copied unmodified

| Source | Destination | Notes |
|---|---|---|
| `js/modules/portal/{overview,timetable,attendance,programmes,certificates,fees}.page.js` | same | The six read-only guardian pages |
| `js/services/portal/guardianAuth.service.js` | same | Guardian identity resolution + `guardianSession` |
| `js/ui/portalShell.js` | same | Guardian chrome, incl. the child switcher |
| `assets/css/{shell,components,modules}.css` | same | v2 stylesheets — see below |

### The stylesheet decision

The portal is styled against **v2's** `shell.css` / `components.css` / `modules.css`, not v3's
glass layer, because it was copied as-is. Rather than load ~2,800 lines of v2 CSS from
`index.html` — which would put two unrelated design systems in every document — those three
sheets are injected by `loadPortalStyles()` in `js/app.js` **only when a guardian session
actually starts**.

Consequences, both verified: a staff session downloads none of it, and the two design systems
never coexist in one document, so neither can bleed into the other. Cost is one extra round
trip at guardian sign-in, once per session. A failed stylesheet load resolves rather than
rejects — a parent should get a plainly-styled record, never a blocked one.

### Wiring

`handleAuthStateChange()`'s guardian fallback is now live: an `err.code === 'not_provisioned'`
rejection — and **only** that, never archived / inactive / method-not-permitted — retries as a
guardian sign-in. `enterPortal()` mounts PortalShell on a **fresh `Router` instance** with
`guardianSession`'s own `isAuthenticated`/`stillValid`, because the staff router's live-status
re-check (`users$.find`) would fail every navigation for an identity that has no `users` doc.

`academicYears` and `curriculumLevels` were **not** re-added: the closure tool flagged them
again, and again they went unreached once the trimmed `repositories.js` was in play.

### Verified

- `node tools/verify-imports.cjs` → 66 modules, all resolve, nothing unreached.
- Guardian session harness: `isAuthenticated` true, two children resolved, active child
  defaults to the first, all six nav items render, PortalShell mounts, v2 stylesheets load.
- **Isolation test (the important one):** a staff session loads only
  `tokens/base/auth/v3.css` — `v2StylesLeaked: false`, staff shell present, portal shell
  absent, bottom tabs intact.
- **Not verified:** a real guardian sign-in against live Firestore — needs a real parent
  credential whose phone/email matches a student record.

## Stage 5 — Attendance (the register)

### ⚠️ Built without an approved design

`Attendance.dc.html` was lost with the design project and could not be regenerated (see
`docs/design/README.md`). On the user's explicit instruction this was built directly. Neither
half was invented: the **interaction is ported** from v2's own documented rule — *"everybody
starts present, marking is one tap"* — and the **visual language is the implemented v3 mobile
system**, already proven on Dashboard and Students. Reconcile against the design if recovered.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/attendance.page.js` | **new** | Day picker + class cards, then the register |
| `assets/css/v3.css` (appended) | **new section** | Day nav, roster rows, present/absent states, sticky save bar |

### Copied unmodified

Nothing new — `attendance.service.js` and `session.service.js` arrived with Stage 2's Dashboard
closure. Attendance's whole dependency closure was already satisfied.

### Two things the desktop version does not do, because a phone is not a desk

- **The roster scrolls the page, not a box inside it.** A phone has no room for nested scroll
  areas.
- **The save action is pinned above the tab bar.** A teacher part-way down a roll of forty must
  never scroll back up to save. The roster reserves 132px so the last student is never trapped
  behind the two bars.

Otherwise identical in behaviour to desktop: present is quiet, absent shouts, one tap
re-renders one row, and the marking-window rule comes from the service.

### Verified

- `node tools/verify-imports.cjs` → 67 modules, all resolve, nothing unreached.
- Register at 375×812: everyone starts present (`3 present · 0 absent`), one tap → absent with
  others untouched, second tap toggles back, All absent flips every row, tally tracks
  throughout, save bar pinned, roster clears both bars (132px), every row ≥44px.
- **Not verified:** `postRegister()` against live Firestore — v3's **first write path**,
  exercised only up to the service call.

## Stage 6 — Admissions

### ⚠️ Built without an approved design

`Admissions.dc.html` was lost with the design project (see `docs/design/README.md`). Built
directly on the user's instruction. The **workflow is the service's** — `nextActionFor()`
defines exactly one next step per status and this page renders that ladder rather than
deciding it — and the **visual language is the implemented v3 mobile system**.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/admissions.page.js` | **new** | Scrollable pipeline strip, filter pills, application cards, detail sheet with the ladder pinned at its foot |
| `assets/css/v3.css` (appended) | **new section** | Status badges, sheet action row, narrower KPI cards |

### Copied unmodified

**Nothing new** — `admissions.service.js` arrived with Stage 2's Dashboard closure.

### Differences from desktop, all because a phone is not a desk

- Pipeline is a horizontally scrolled strip, not a six-up grid.
- Detail is a near-full-screen sheet; the next action is a **full-width button pinned at the
  foot**, reachable with a thumb without scrolling back through the record.
- **Guardian phone is tap-to-call** — the most useful thing reception can do with an
  application that is stuck.
- **A stalled row shows how long it has waited *instead of* when it arrived.** Both together
  overflowed a 375px row and the ellipsis ate the waiting time — the one signal that row
  exists to raise. Caught in review and fixed; the applied date is still on the detail sheet.

### Not built

Taking a *new* application — intake is a multi-step wizard that deserves its own stage, and a
phone is the worst place to start one. This screen does the daily job: processing what has
arrived.

### Verified

- `node tools/verify-imports.cjs` → 68 modules, all resolve, nothing unreached.
- List at 375×812: five stat cards, six pills, four applications with correct status badges,
  no horizontal overflow, and (after the fix) no truncated meta on either stalled or normal
  rows.
- The action ladder was verified exhaustively on desktop against `nextActionFor()`; this page
  reads the same service function and renders the same result.
- **Not verified:** any write path against live Firestore.

## Stage 7 — Timetable

### ⚠️ Built without the design file — but one instruction survived

`Timetable.dc.html` was lost, but the design project's change log recorded that mobile is a
**day picker + agenda** (never the desktop grid) and that cards show **batch name and time
slot**. Both honoured. The teacher is kept on the agenda card — a card has room for one more
line where a grid tile does not, and at the front desk "who is teaching it" is the question
actually being asked.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/timetable.page.js` | **new** | Week nav, day-picker chips, agenda cards |
| `assets/css/v3.css` (appended) | **new section** | Day chips and agenda slot states |

### Copied unmodified

`js/services/batches.service.js`.

### Two mobile-specific touches

- **Day chips carry a dot** when that day still has a register to mark — the reason to scan
  the row before picking a day at all.
- **Today keeps a visible outline** even when another day is selected, so it stays findable.

Tapping a class opens its register (`#/attendance?date=…&batch=…`), consumed once on first
load so "back" returns to the day board.

### Verified

- `node tools/verify-imports.cjs` → 70 modules, all resolve, nothing unreached.
- Desktop equivalents of the same states were verified exhaustively in `natyam-admin`; this
  page reads the same `timetable()` service and renders the same five states.

## Stage 8 — (desktop Fee collection; mobile Fees still outstanding)

Fee collection was built in `natyam-admin` this stage. **The mobile Fees screen has not been
built yet** — it remains a Phase-1 module with `load: null` in `js/config/navigation.js`, so
its tab shows the honest placeholder.

Two fixes from that stage **did** land here, because they affected this app too:

### 🐛 Every page leaked its event listeners onto the next page

`on()` binds to the page container, which the router **renders into rather than replaces**, so
an undisposed listener outlives its page and fires on the next page's markup wherever a
selector happens to match. The reference project wraps every such call in
`this.onDispose(...)`; none of the v3 pages did.

**64 unwrapped listeners across 9 page files in both apps** — 26 of them here, in
`mobile/{students,attendance,admissions,timetable}.page.js`. All now wrapped.

### The modal-dismiss bug did NOT affect this app

Worth recording so nobody "fixes" it here later: the desktop bug came from the backdrop
*wrapping* the dialog, which made a delegated `closest()` match treat inner clicks as backdrop
clicks. Every mobile sheet renders its scrim as a **sibling** of the sheet
(`<div class="m-sheet-scrim"></div>` then `<div class="m-profile">`), so `closest()` never
walks into it. No change was needed.

### `js/services/fees.service.js`

Copied here in Stage 2's Dashboard closure; now carries the same two v3 fixes as the admin
copy (see "Intentional divergences" below), so the two apps cannot disagree about what
"overdue" means or how an overpayment is reported.

## Stage 9 — Fee collection (mobile)

### ⚠️ No design existed for this screen at all

Fees was **never part of the Claude Design project** — not even a lost file to reconcile
against later. Built from the v3 mobile system, proven across five prior screens.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/fees.page.js` | **new** | Search-first worklist, scrollable month strip, ledger sheet, full-screen collect form |
| `assets/css/v3.css` (appended) | **new section** | Fee badges, invoice rows, the collect form and its mode pills |

### Copied unmodified

**Nothing new** — `fees.service.js` arrived with Stage 2's Dashboard closure (and carries the
two v3 fixes recorded below).

### Same model as desktop, more literally

Student-centric, not invoice-centric — money is collected from a person. On a phone that is
literal: reception is holding the device while the parent stands in front of them. So search
is always visible, and the list is sorted by who owes most and longest.

### Four deliberate departures from the desktop page

| Change | Why |
|---|---|
| The collect form **replaces** the sheet body instead of expanding inside it | A 375px screen cannot show a ledger and a form at once, and a half-visible ledger is how the wrong invoice gets settled |
| Payment modes are **tap pills, not a `<select>`** | Five options, chosen constantly. A native select on a phone is a modal roulette wheel |
| The amount field is **28px and centred** | It is the number being checked against cash in hand — it should be the biggest thing on screen |
| **Tap-to-call the guardian** from the ledger | The most useful thing reception can do about an unpaid invoice |

### Verified

- `node tools/verify-imports.cjs` → 71 modules, all resolve, nothing unreached.
- List at 375×812: month strip, four filter pills, correct fee badges
  (`overdue:₹2.0K` / `due:₹1.5K` / `clear:Paid`), sorted overdue-first, no horizontal overflow.
- Ledger sheet: metrics correct, invoice flagged overdue, tap-to-call present.
- Collect form: replaces the ledger (verified — invoice rows drop to zero), amount defaults to
  the balance and is capped at it, five mode pills with UPI default, reference **required for
  UPI and hidden + not required for Cash**, "balance after this" tracks a part payment
  (₹2,000 − ₹500 = ₹1,500), Back returns to the ledger rather than closing the sheet.
- **Every visible control ≥44px** (amount 60px, mode pills and inputs 44px). An initial check
  reported a failure; investigated rather than accepted — it was the *hidden* reference field
  measuring zero height, not a real target.
- **`recordPayment()` deliberately NOT submitted** — real money against real records.

## Stage 10 — Notifications + My account

### ⚠️ Neither screen was ever in the Claude Design project

Not lost like Attendance — never drawn at all. Built from the v3 mobile system.

### New

| Destination | Action |
|---|---|
| `js/modules/mobile/notifications.page.js` | **new** |
| `js/modules/mobile/profile.page.js` | **new** |
| `assets/css/v3.css` (appended) | **new sections** — alert rows, severity icons, identity card |

### Copied unmodified

**Nothing new.** `notifications.service.js` arrived with the Dashboard closure; the account
screen needs only `users# Migration checklist — natyam-mobile

Source project: `D:\Shanki\Natyam\Projects\Natyam-ERP-UAT` (read-only reference throughout;
nothing in it was ever edited). Rows are added as files are actually touched, not
reconstructed after the fact. See `composed-popping-ritchie.md` (the approved plan) for the
rules this follows.

## Stage 0 — bootstrap skeleton, no feature modules

| Source path | Destination path | Action | Notes |
|---|---|---|---|
| `js/config/firebase.config.js` | same | copied as-is | same Firebase project (`natyam-erp`) as both new apps |
| `js/config/app.config.js` | same | trimmed | removed `NAVIGATION`/`ROUTES` exports (this app defines its own nav table separately — a bottom-nav/more-menu list, not a filtered copy of the desktop's — not yet added, see Stage 1); kept `APP`, `SESSION`, `SCHEMA`/`STORE_NAMES`, domain status enums, `CAPABILITIES`, `ROLES`, curriculum/role resolution helpers, `PREFERENCE_DEFAULTS` |
| `js/core/bus.js` | same | copied as-is | generic infra |
| `js/core/firebase.js` | same | copied as-is | generic infra |
| `js/core/session.js` | same | copied as-is | generic infra |
| `js/core/repository.js` | — | **excluded** | dead code for this app: no Firestore repository imports it |
| `js/core/db.js` | — | **excluded** | IndexedDB is fully retired for every store this app uses — same reasoning as `natyam-admin`, see its checklist |
| `js/utils/date.js` | same | copied as-is | used by users/branches/sessions/auditLog repositories |
| `js/utils/id.js` | same | copied as-is | used by auditLog repository |
| `js/utils/dom.js` | same | copied as-is | used by login page |
| `js/utils/csv.js`, `money.js` | — | **excluded (for now)** | no Stage 0 code needs them |
| `js/data/sequenceGenerator.firestore.js` | same | copied as-is | |
| `js/data/users.repository.firestore.js` | same | copied as-is | |
| `js/data/branches.repository.firestore.js` | same | copied as-is | |
| `js/data/sessions.repository.firestore.js` | same | copied as-is | login-session records, not Timetable class sessions |
| `js/data/auditLog.repository.firestore.js` | same | copied as-is | |
| `js/data/repositories.js` | same | **trimmed** | only re-exports `branches$`, `users$`, `authMethodsOf` |
| `js/services/auth.service.js` | same | copied as-is | |
| `js/services/auth/providers/{google,password,mobileOtp}Provider.js` | same | copied as-is | |
| `js/modules/auth/login.page.js` | same | copied as-is | shared login screen; not redesigned (no login `.dc.html` exists, and the reference login screen is already desktop/mobile responsive) |
| `assets/css/{tokens,base,auth}.css` | same | copied as-is | component styles and the mobile shell's own CSS excluded for now |
| `assets/img/brand/*`, `assets/icons/*` | same | copied as-is | |
| `firestore.rules` | same | copied as-is | **reference copy** — canonical copy lives in `natyam-admin`; kept identical here, never edited independently |
| `docs/architecture/`, `docs/migrations/` | same | copied as-is | reference documentation |
| — | `js/app.js` | **new** | minimal boot: Firebase auth watch → `resolveProvisionedUser` → mobile role gate (owner_accountant/teacher_reception; administrator turned away) → session hydrate → placeholder authenticated screen. No router, no MobileShell yet — arrives with the first real module in Stage 1. Guardian-portal fallback is a `TODO` until `js/modules/portal/` is copied in (end of Stage 1) |
| — | `index.html`, `manifest.json` | **new** | "Natyam ERP v3 — Mobile" branding from the start (same reasoning as `natyam-admin`'s checklist: these are new files, not copies, so there's no unbranded intermediate state to transition through) |

**Not included in this app, and why:** `js/modules/dashboard/…page.js` etc. (desktop pages) —
this app never gets desktop layouts, per the split spec ("do not reuse desktop layouts"). Its
own mobile pages are new files built from the Design project, added module by module in
Stage 1.

## Stage 2 — Mobile shell + Dashboard

(Stage 1 was natyam-admin's Dashboard; this app's first feature stage is Stage 2, so the
numbering stays shared across both repos and matches the order work actually happened in.)

The Dashboard is an aggregate view, so its dependency closure is the widest of any module —
it reads from most collections even though most *screens* do not exist yet. That is the
Dashboard's nature, not speculative copying: the closure was computed from its actual
imports, and is the same one natyam-admin needed.

### New — built from the approved Claude Design project

| Destination | Action | Notes |
|---|---|---|
| `js/ui/mobileShell.js` | **new, per `Dashboard.dc.html` (mobile half)** | Top app bar + five-slot bottom tab bar (Home / Students / Fees / Attendance / More) + More sheet. Explicitly **not** a narrowed copy of natyam-admin's sidebar shell. Distinct from `portalShell.js`, which stays guardian-only |
| `js/modules/mobile/dashboard.page.js` | **new, per `Dashboard.dc.html` (mobile half)** | **Both role variants**, because this app serves both: Teacher & Reception get the task-first screen (stat tiles → classes today → missing registers → quick actions); Owner & Accountant get the full one (scrollable KPI strip → needs attention → insights → activity). Computes nothing — every figure comes from the unmodified `dashboard.service.js` |
| `assets/css/v3.css` | **new** | Mobile design layer. Not shared with natyam-admin — the two apps' chrome genuinely differs. Design's hardcoded iOS insets (62px top / 22px bottom, artefacts of its device frame) replaced with `env(safe-area-inset-*)` so the chrome is correct on notched phones, flat phones and desktop browsers |
| `js/config/navigation.js` | **new** | This app's own table: `TABS` (bottom bar) + `MORE_ITEMS` (sheet) + derived `ROUTES`. Authored independently, not the desktop's five groups filtered down |
| `js/modules/system/pending.page.js` | **new** | Honest placeholder for the nine Phase-1 modules not yet migrated |
| `tools/verify-imports.cjs` | **new** | Same static import checker as natyam-admin |

### Copied unmodified (business logic preserved exactly)

Identical set to natyam-admin's Stage 1: `js/core/router.js`; the 8 services
(`dashboard`, `admissions`, `attendance`, `audit`, `fees`, `finance`, `notifications`,
`session`); the 18 Firestore repositories; `js/ui/{icons,toast}.js`; `js/utils/money.js`.
`js/data/repositories.js` extended from 3 re-exports to the ~30 this closure needs.

### Placement decisions the design did not cover

The design mocks a screen, not a working session, so it draws no branch switcher, theme
toggle or sign-out. A phone has no header room for them, so they live in the **More sheet**
rather than being dropped. The app bar shows the greeting + date on the dashboard exactly as
designed, and the page title elsewhere — on a phone, knowing which screen you are on matters
more than repeating the date.

`chart.js` was **not** copied (the mobile design has no charts). `palette.js`,
`backup.service.js` and `components.css` remain excluded, as in natyam-admin.

### Still open in this app

- **Guardian portal not wired.** `js/modules/portal/`, `guardianAuth.service.js` and
  `portalShell.js` have not been migrated. The `not_provisioned` → guardian fallback seam is
  marked in `js/app.js` with the exact code that attaches there. Until then a guardian is
  told their account is not set up — the same answer the reference app gives an unknown
  identity, so no regression, just an unfinished half.
- `forTeacher()` is passed `session.actorId()` (a **user** id) exactly as the reference app
  does. If the reference has a user↔staff id mismatch there, it is preserved rather than
  silently "fixed" — flagging it as worth confirming against real data.

### Verified

- `node tools/verify-imports.cjs` → 54 modules reached, all imports resolve, nothing unreached.
- Teacher & Reception variant at 375×812: 5 tabs, 2 stat tiles, 3 class cards, 4 quick
  actions, greeting in the app bar, every tap target ≥44px.
- Owner & Accountant variant: 5 tone-coded KPIs in a horizontally scrolling strip, 2
  attention cards, 4 insight tiles computed from real panel data (₹8.42L / 87% / 4/5 / 342),
  activity rows, and **no horizontal page overflow**.
- More sheet opened by real tap: slides up over a blurred scrim, all six entries, branch
  switcher, theme toggle, sign out. **Settings correctly appears for Owner & Accountant and
  is correctly hidden for Teacher & Reception** — capability gating through the shared
  `ROLES` table works.
- natyam-admin re-checked after this stage: still boots, no console errors.
- **Bug found and fixed during this stage:** the bottom tab bar never showed a selected
  state. `html``` escapes interpolated values, so a conditional `aria-current="page"` string
  became visible text instead of an attribute. Now set via `setAttribute` in `markActive()`,
  mirroring natyam-admin's shell. (Checked the related `${cond ? 'selected' : ''}` pattern
  inherited from the reference app — that one is safe, since `escapeHtml` only touches
  `& < > " '` and `selected` contains none of them.)
- **Not verified:** a real signed-in session against live Firestore — needs real credentials.

## Stage 3 — Students

### New — built from the approved design

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/students.page.js` | **new, per `Students.dc.html`** (mobile half) | Full-width tappable cards + near-full-screen profile sheet. Explicitly not the desktop roll narrowed: search is always visible (finding one child is the primary phone task, not a filter toggle), filters are horizontally scrolled pills, and a FAB sits above the tab bar |
| `assets/css/v3.css` (appended) | **new section** | Sticky sub-header, search, pills, student cards, FAB, profile sheet, metrics/notices/facts |

### Copied unmodified

`js/services/students.service.js`, plus `js/data/{curricula,documents}.repository.firestore.js`.
`repositories.js` extended with `curricula$` and `documents$` only.
`academicYears` and `curriculumLevels` were copied then **removed** — unreached, same
over-reporting reason recorded in natyam-admin's checklist.

### Deliberate departures from the design

| Change | Why |
|---|---|
| Row shows **one** badge (fees), with status as text under the name | Two badges plus a name do not fit 375px without truncating the name — the one thing the row exists to show |
| Search field and filter button raised **42px → 44px** | The split spec calls for touch-friendly controls; 44px is the iOS/WCAG 2.5.5 floor. A 2px deviation beats a target under the accessibility minimum |
| Filter chips left at the design's **33px** | They sit in a secondary scrolled row where 44px reads heavy, and 33px still clears WCAG 2.5.8's 24px AA floor. The CSS header was corrected to state this exception rather than claim a blanket 44px |

### Verified

- `node tools/verify-imports.cjs` → 58 modules, all resolve, nothing unreached.
- List at 375×812: 3 cards, correct fee badges, status shown inline for non-active, live count,
  all four pills, FAB clear of the tab bar, search at 16px (no iOS focus-zoom), **no horizontal
  overflow**.
- Profile sheet: opens at 86vh, six tabs, metrics (`79%` / `₹3.5K` / `14mo`), both notices,
  facts list, and a **tap-to-call guardian** action on the People tab — a mobile affordance the
  desktop has no equivalent for.
- natyam-admin re-checked after this stage: still boots, Students live, no console errors.
- **Bug found and fixed (affects both apps):** see natyam-admin's Stage 3 note — the design's
  "light" variant keeps white type, so its lightening scrim washed content out on the real
  artwork. The scrim now darkens in both variants.

## Stage 4 — Guardian Parent/Student Portal

Done out of the planned order. Stage 4 was to be Attendance, but the Claude Design project
became unreachable mid-migration (see `docs/design/README.md`), and implementing a designed
module without its `.dc.html` would mean inventing a layout. The Portal is the one piece the
plan explicitly exempts from the design project — "copied as-is, already mobile-first, already
read-only" — so it needed no design and could proceed.

### Copied unmodified

| Source | Destination | Notes |
|---|---|---|
| `js/modules/portal/{overview,timetable,attendance,programmes,certificates,fees}.page.js` | same | The six read-only guardian pages |
| `js/services/portal/guardianAuth.service.js` | same | Guardian identity resolution + `guardianSession` |
| `js/ui/portalShell.js` | same | Guardian chrome, incl. the child switcher |
| `assets/css/{shell,components,modules}.css` | same | v2 stylesheets — see below |

### The stylesheet decision

The portal is styled against **v2's** `shell.css` / `components.css` / `modules.css`, not v3's
glass layer, because it was copied as-is. Rather than load ~2,800 lines of v2 CSS from
`index.html` — which would put two unrelated design systems in every document — those three
sheets are injected by `loadPortalStyles()` in `js/app.js` **only when a guardian session
actually starts**.

Consequences, both verified: a staff session downloads none of it, and the two design systems
never coexist in one document, so neither can bleed into the other. Cost is one extra round
trip at guardian sign-in, once per session. A failed stylesheet load resolves rather than
rejects — a parent should get a plainly-styled record, never a blocked one.

### Wiring

`handleAuthStateChange()`'s guardian fallback is now live: an `err.code === 'not_provisioned'`
rejection — and **only** that, never archived / inactive / method-not-permitted — retries as a
guardian sign-in. `enterPortal()` mounts PortalShell on a **fresh `Router` instance** with
`guardianSession`'s own `isAuthenticated`/`stillValid`, because the staff router's live-status
re-check (`users$.find`) would fail every navigation for an identity that has no `users` doc.

`academicYears` and `curriculumLevels` were **not** re-added: the closure tool flagged them
again, and again they went unreached once the trimmed `repositories.js` was in play.

### Verified

- `node tools/verify-imports.cjs` → 66 modules, all resolve, nothing unreached.
- Guardian session harness: `isAuthenticated` true, two children resolved, active child
  defaults to the first, all six nav items render, PortalShell mounts, v2 stylesheets load.
- **Isolation test (the important one):** a staff session loads only
  `tokens/base/auth/v3.css` — `v2StylesLeaked: false`, staff shell present, portal shell
  absent, bottom tabs intact.
- **Not verified:** a real guardian sign-in against live Firestore — needs a real parent
  credential whose phone/email matches a student record.

## Stage 5 — Attendance (the register)

### ⚠️ Built without an approved design

`Attendance.dc.html` was lost with the design project and could not be regenerated (see
`docs/design/README.md`). On the user's explicit instruction this was built directly. Neither
half was invented: the **interaction is ported** from v2's own documented rule — *"everybody
starts present, marking is one tap"* — and the **visual language is the implemented v3 mobile
system**, already proven on Dashboard and Students. Reconcile against the design if recovered.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/attendance.page.js` | **new** | Day picker + class cards, then the register |
| `assets/css/v3.css` (appended) | **new section** | Day nav, roster rows, present/absent states, sticky save bar |

### Copied unmodified

Nothing new — `attendance.service.js` and `session.service.js` arrived with Stage 2's Dashboard
closure. Attendance's whole dependency closure was already satisfied.

### Two things the desktop version does not do, because a phone is not a desk

- **The roster scrolls the page, not a box inside it.** A phone has no room for nested scroll
  areas.
- **The save action is pinned above the tab bar.** A teacher part-way down a roll of forty must
  never scroll back up to save. The roster reserves 132px so the last student is never trapped
  behind the two bars.

Otherwise identical in behaviour to desktop: present is quiet, absent shouts, one tap
re-renders one row, and the marking-window rule comes from the service.

### Verified

- `node tools/verify-imports.cjs` → 67 modules, all resolve, nothing unreached.
- Register at 375×812: everyone starts present (`3 present · 0 absent`), one tap → absent with
  others untouched, second tap toggles back, All absent flips every row, tally tracks
  throughout, save bar pinned, roster clears both bars (132px), every row ≥44px.
- **Not verified:** `postRegister()` against live Firestore — v3's **first write path**,
  exercised only up to the service call.

## Stage 6 — Admissions

### ⚠️ Built without an approved design

`Admissions.dc.html` was lost with the design project (see `docs/design/README.md`). Built
directly on the user's instruction. The **workflow is the service's** — `nextActionFor()`
defines exactly one next step per status and this page renders that ladder rather than
deciding it — and the **visual language is the implemented v3 mobile system**.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/admissions.page.js` | **new** | Scrollable pipeline strip, filter pills, application cards, detail sheet with the ladder pinned at its foot |
| `assets/css/v3.css` (appended) | **new section** | Status badges, sheet action row, narrower KPI cards |

### Copied unmodified

**Nothing new** — `admissions.service.js` arrived with Stage 2's Dashboard closure.

### Differences from desktop, all because a phone is not a desk

- Pipeline is a horizontally scrolled strip, not a six-up grid.
- Detail is a near-full-screen sheet; the next action is a **full-width button pinned at the
  foot**, reachable with a thumb without scrolling back through the record.
- **Guardian phone is tap-to-call** — the most useful thing reception can do with an
  application that is stuck.
- **A stalled row shows how long it has waited *instead of* when it arrived.** Both together
  overflowed a 375px row and the ellipsis ate the waiting time — the one signal that row
  exists to raise. Caught in review and fixed; the applied date is still on the detail sheet.

### Not built

Taking a *new* application — intake is a multi-step wizard that deserves its own stage, and a
phone is the worst place to start one. This screen does the daily job: processing what has
arrived.

### Verified

- `node tools/verify-imports.cjs` → 68 modules, all resolve, nothing unreached.
- List at 375×812: five stat cards, six pills, four applications with correct status badges,
  no horizontal overflow, and (after the fix) no truncated meta on either stalled or normal
  rows.
- The action ladder was verified exhaustively on desktop against `nextActionFor()`; this page
  reads the same service function and renders the same result.
- **Not verified:** any write path against live Firestore.

## Stage 7 — Timetable

### ⚠️ Built without the design file — but one instruction survived

`Timetable.dc.html` was lost, but the design project's change log recorded that mobile is a
**day picker + agenda** (never the desktop grid) and that cards show **batch name and time
slot**. Both honoured. The teacher is kept on the agenda card — a card has room for one more
line where a grid tile does not, and at the front desk "who is teaching it" is the question
actually being asked.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/timetable.page.js` | **new** | Week nav, day-picker chips, agenda cards |
| `assets/css/v3.css` (appended) | **new section** | Day chips and agenda slot states |

### Copied unmodified

`js/services/batches.service.js`.

### Two mobile-specific touches

- **Day chips carry a dot** when that day still has a register to mark — the reason to scan
  the row before picking a day at all.
- **Today keeps a visible outline** even when another day is selected, so it stays findable.

Tapping a class opens its register (`#/attendance?date=…&batch=…`), consumed once on first
load so "back" returns to the day board.

### Verified

- `node tools/verify-imports.cjs` → 70 modules, all resolve, nothing unreached.
- Desktop equivalents of the same states were verified exhaustively in `natyam-admin`; this
  page reads the same `timetable()` service and renders the same five states.

## Stage 8 — (desktop Fee collection; mobile Fees still outstanding)

Fee collection was built in `natyam-admin` this stage. **The mobile Fees screen has not been
built yet** — it remains a Phase-1 module with `load: null` in `js/config/navigation.js`, so
its tab shows the honest placeholder.

Two fixes from that stage **did** land here, because they affected this app too:

### 🐛 Every page leaked its event listeners onto the next page

`on()` binds to the page container, which the router **renders into rather than replaces**, so
an undisposed listener outlives its page and fires on the next page's markup wherever a
selector happens to match. The reference project wraps every such call in
`this.onDispose(...)`; none of the v3 pages did.

**64 unwrapped listeners across 9 page files in both apps** — 26 of them here, in
`mobile/{students,attendance,admissions,timetable}.page.js`. All now wrapped.

### The modal-dismiss bug did NOT affect this app

Worth recording so nobody "fixes" it here later: the desktop bug came from the backdrop
*wrapping* the dialog, which made a delegated `closest()` match treat inner clicks as backdrop
clicks. Every mobile sheet renders its scrim as a **sibling** of the sheet
(`<div class="m-sheet-scrim"></div>` then `<div class="m-profile">`), so `closest()` never
walks into it. No change was needed.

### `js/services/fees.service.js`

Copied here in Stage 2's Dashboard closure; now carries the same two v3 fixes as the admin
copy (see "Intentional divergences" below), so the two apps cannot disagree about what
"overdue" means or how an overpayment is reported.

## Stage 9 — Fee collection (mobile)

### ⚠️ No design existed for this screen at all

Fees was **never part of the Claude Design project** — not even a lost file to reconcile
against later. Built from the v3 mobile system, proven across five prior screens.

### New

| Destination | Action | Notes |
|---|---|---|
| `js/modules/mobile/fees.page.js` | **new** | Search-first worklist, scrollable month strip, ledger sheet, full-screen collect form |
| `assets/css/v3.css` (appended) | **new section** | Fee badges, invoice rows, the collect form and its mode pills |

### Copied unmodified

**Nothing new** — `fees.service.js` arrived with Stage 2's Dashboard closure (and carries the
two v3 fixes recorded below).

### Same model as desktop, more literally

Student-centric, not invoice-centric — money is collected from a person. On a phone that is
literal: reception is holding the device while the parent stands in front of them. So search
is always visible, and the list is sorted by who owes most and longest.

### Four deliberate departures from the desktop page

| Change | Why |
|---|---|
| The collect form **replaces** the sheet body instead of expanding inside it | A 375px screen cannot show a ledger and a form at once, and a half-visible ledger is how the wrong invoice gets settled |
| Payment modes are **tap pills, not a `<select>`** | Five options, chosen constantly. A native select on a phone is a modal roulette wheel |
| The amount field is **28px and centred** | It is the number being checked against cash in hand — it should be the biggest thing on screen |
| **Tap-to-call the guardian** from the ledger | The most useful thing reception can do about an unpaid invoice |

### Verified

- `node tools/verify-imports.cjs` → 71 modules, all resolve, nothing unreached.
- List at 375×812: month strip, four filter pills, correct fee badges
  (`overdue:₹2.0K` / `due:₹1.5K` / `clear:Paid`), sorted overdue-first, no horizontal overflow.
- Ledger sheet: metrics correct, invoice flagged overdue, tap-to-call present.
- Collect form: replaces the ledger (verified — invoice rows drop to zero), amount defaults to
  the balance and is capped at it, five mode pills with UPI default, reference **required for
  UPI and hidden + not required for Cash**, "balance after this" tracks a part payment
  (₹2,000 − ₹500 = ₹1,500), Back returns to the ledger rather than closing the sheet.
- **Every visible control ≥44px** (amount 60px, mode pills and inputs 44px). An initial check
  reported a failure; investigated rather than accepted — it was the *hidden* reference field
  measuring zero height, not a real target.
- **`recordPayment()` deliberately NOT submitted** — real money against real records.

, `authMethodsOf` and `setOwnPassword`, all already present.

### Severity is the service's, not the page's

`centre()` maps each row to error / warning / success / info on its own stated grounds —
*"what must I deal with" is the question being asked and the kind is only a hint towards the
answer*. These pages sort unread-then-severity-then-newest and render that mapping; they do
not re-derive it.

### ⚠️ One deliberate behavioural difference from the reference app

In the reference, `refreshAlerts()` runs automatically during the boot maintenance sweep.
v3's `app.js` does not carry that sweep, so derived alerts would silently go stale.

Rather than reintroduce **background Firestore writes on every launch** — unasked-for writes,
on a project that has already hit its free-tier read quota once — regenerating is an explicit
button on the Notifications screen. The trade is deliberate: alerts are fresh when someone
asks, instead of costing a write burst every time anyone opens the app.

### `js/ui/form.js` deliberately NOT copied

The reference account page opens its password dialog through `formOverlay()` — a 548-line v2
component library styled entirely against `components.css`, which this app loads only for the guardian portal. Pulling both in for one two-field form would put v2's opaque-surface
component system inside a v3 glass screen. Written natively instead.

`setOwnPassword()` stays exactly as it is: it takes **no user id**, so this screen structurally
cannot be turned into a way to set somebody else's password. That constraint lives in
auth.service.js and was left there.

### Verified

- `node tools/verify-imports.cjs` → all imports resolve, nothing unreached.
- **Notifications:** four alerts render with correct severity icons, sorted
  unread-then-severity (error → warning → warning → success), the read row dimmed and last,
  announcements collapsed to a single banner, four filter pills, no horizontal overflow.
- **My account:** identity, facts, both sign-in methods read from `authMethods`, correct
  "Change password" vs "Set a password" label, theme options with the current one selected,
  14 permissions expanding from the banner, password form with two `minlength=8` fields, every control ≥44px.
- **Not verified:** `setOwnPassword()`, `markAllRead()`, `dismiss()` and `refreshAlerts()`
  against live Firestore — all four write.

## Stage 11 — Batches

### ⚠️ Never in the Claude Design project

Not lost — never drawn. Built from the v3 mobile system.

### New

| Destination | Action |
|---|---|
| `js/modules/mobile/batches.page.js` | **new** |
| `assets/css/v3.css` (appended) | seat-occupancy chips |

### Copied unmodified

**Nothing new** — `batches.service.js` arrived with Stage 7 (Timetable).

### The roster is sorted weakest-attendance-first

That ordering is `batchDetail()`'s own, not this page's, and it is the right one: reviewing a
batch, the question is who is slipping. Students with no marks sort last rather than first,
because "no data" is not "worst".

`findConflicts()` runs inside `batchDetail()`, so a double-booked room or teacher surfaces
without this page checking anything itself — which is why the detail leads with conflicts
rather than burying them.

### Create / edit / close deliberately absent — not even disabled

They need a form plus a conflict-override decision, and a phone is the wrong place to make
one. Unlike other screens, no greyed-out buttons are shown either: an action a phone user
should not be starting is better absent than teasing.

### Verified

- `node tools/verify-imports.cjs` → all imports resolve, nothing unreached.
- List: KPIs compute correctly (34 placed, 26 seats free, 1 unstaffed from a 3-batch fixture),
  seat chips full/open/empty, attendance chips banded 88% green / 61% red, 4 filter pills.
- **Not verified:** nothing on this screen writes, so there is nothing outstanding.

## Stage 12 — Settings (and Phase 1 complete)

### Fewer tabs than desktop, deliberately

The design's nine-tab structure is a desktop structure. Mobile serves Owner & Accountant and
Teacher & Reception, and of those nine sections four are **Administrator work** — Users,
Roles, Audit log, Data. Administrator is desktop-only, and a phone is the wrong instrument for
granting a role or restoring a backup.

So this app carries six: **Display** (the one a phone user actually changes, so it leads),
**School** and **Branches** (worth reading at a front desk — both offer tap-to-call),
**Fee plans** and **Curriculum** (reference), and **About**. The About tab names the four
missing sections and says where they live, rather than leaving their absence unexplained.

Gating is still the real capability model — the tab list names CAPABILITIES strings and
filters on `session.can()`.

### New

| Destination | Action |
|---|---|
| `js/modules/mobile/settings.page.js` | **new** |

### Copied unmodified

`js/services/settings.service.js` and `js/data/academicYears.repository.firestore.js`.

### Phase 1 is now complete

Every Phase-1 module named in the approved plan — Dashboard, Students, Admissions, Attendance,
Fee collection, Batches, Timetable, Notifications, Profile, Settings — is migrated, plus the
guardian Portal. The single remaining `load: null` is `/more`, which is a sheet toggle in the
tab bar, not a page.

### Verified

- `node tools/verify-imports.cjs` → all imports resolve, nothing unreached.
- Tab gating shares the desktop implementation's capability filtering, verified there across
  all three staff roles.

---

## ⚠️ Intentional divergences from the reference project

Files copied unmodified are byte-identical to `Natyam-ERP-UAT` **except those listed here**, so
that `diff` against the reference stays a meaningful drift check.

### `js/services/fees.service.js` — `collectionSummary()` now returns `overdue` / `overdueCount`

Same fix as `natyam-admin` (see that repo's checklist for the full evidence). In short:
`dashboard.service.js` read two fields `collectionSummary()` never returned, so `undefined`
made the dashboard render a green **"nothing overdue"** while — confirmed against live data on
2026-08-02 — **157 invoices totalling ₹2,83,500 were all past due**. Fixed at the source, since
two call sites read those fields. Verified: all three sources (`invoices$.overdue()`, the
`ageing` buckets, and `collectionSummary()`) now agree.

Applied identically in both repos so the two apps cannot disagree about what "overdue" means.
**The reference project still carries this bug** — left untouched per instruction.

### `js/services/fees.service.js` — overpayment message no longer divides by 100

A second leftover, from the paise era. `utils/money.js` records that scaled-integer paise were
removed — *"What is typed, what is stored and what is displayed are now the same whole
number"* — but the overpayment error in `recordPayment()` still divided by 100. A ₹2,000
balance was reported as *"more than the ₹20.00 outstanding"*, which reads as though the person
had massively overpaid. Now uses `formatMoney()`, so it cannot drift from every other amount
on screen.

Applied identically in both repos so the two apps cannot disagree.

### `assets/css/v3.css` — light-variant tone backgrounds

The design's light variant pairs **opaque pastel** tone-fills (`#E9F5EF`, `#FBE4DC`,
`#FBEEDC`) with **white** type — `--v3-name` is `#FFFFFF` in that variant too. Measured on the
real screens, that is a contrast ratio of **1.03–1.22**, against WCAG AA's 4.5: white on
near-white, effectively invisible. The mock was evidently never checked against its own type
colour.

Replaced with translucent tints so the darkened backdrop shows through, consistent with
`--v3-card-bg` in the same variant. Delta text lightened to match, since it sits on those
tints. **Measured after: 8.10–8.98**, clearing AA and AAA.

Affected every KPI card in light theme across Dashboard, Admissions, Fee collection and
Batches — found on the fourth of those, by looking at a screenshot rather than by a test.

### `tools/dev-server.cjs` — sends `Cache-Control: no-store`

New in v3, not a reference file. Added because the browser served a stale ES module after an
edit, which made the fix above *look* like it had not worked.

---

## Stage 8 onward

_(Settings still needs its `.dc.html` regenerated — see `docs/design/REGENERATION_BRIEF.md`.
Admissions intake wizard and the student form also outstanding.)_

---

## Stage 13 — mobile chrome restyle (requested during the build)

| File | Action |
|---|---|
| `assets/css/v3.css` | app bar + tab bar restyled; native-select-popup fix; `--v3-tab-active` deepened |

**App bar and tab bar are now white at high opacity.** `--v3-appbar-bg` went from
`rgba(255,248,239,0.5)` to `rgba(255,255,255,0.92)` (dark variant) / `0.95` (light);
`--v3-tabbar-bg` to `0.94` / `0.96`. At 0.5 the header let the artwork read straight through
and the title sat on whatever happened to be scrolling past. The app bar's cream hairline was
invisible against a near-white bar, so the separator now comes from the ink ramp
(`rgba(58,32,20,0.10)`) with a soft drop shadow to hold the edge.

**The tab bar is now a detached bubble** — 10px in from both sides and the bottom, 22px
radius, white hairline, lifted shadow, so the artwork runs behind and around it.

It stays **in flow** rather than positioned over the content. Floating it would mean every
scrollable page owed the bar a matching bottom padding, and the last row of a long list would
hide under it on any page that forgot — a whole class of bug bought for no visual gain, since
the margins already read as detached. The safe-area inset became part of the bottom *margin*
rather than the padding, so on a notched phone the bubble lifts clear of the home indicator
instead of growing a tall dead strip inside itself.

**Contrast, re-measured after the change** (the white bar changed what every label sits on):

| | dark | light |
|---|---|---|
| App bar title | 12.85 | 13.64 |
| App bar subtitle | 7.58 | 8.05 |
| Tab, inactive | 6.47 | 6.73 |
| Tab, active | 5.28 | 5.47 |

The active tab needed two changes to get there. The design's `#E2622B` measures **3.4:1** on a
white bar — under AA, on a 10px label — and deepening it alone only reached 3.67. It is now
`#A03A10` **and** the active slot gets its own smaller bubble
(`rgba(226,98,43,0.12)`, 17px radius) inside the bar, which both fixes the ratio and makes
"which tab am I on" readable at a glance rather than by colour alone.

**Native select popups** — same fix as `natyam-admin`, applied to `.v3-input` and
`.m-sheet-branch`. See that repo's checklist for the reasoning.

**How this was verified:** the mobile app requires a sign-in that could not be performed here,
so the real shell markup was rendered against the shipped stylesheet at a 375×812 viewport and
measured there. The change is CSS-only, so that exercises everything that changed — but the
bubble has **not** been seen against a real signed-in session on a physical notched device,
where `env(safe-area-inset-bottom)` is non-zero.

### Follow-up on the same stage — opacity to 0.75, and a real bug behind the "alignment glitch"

**Chrome opacity is 0.75** in both variants, app bar and tab bar, per direct request — the
glass finish reads again with the artwork visible through it. That change moved the goalposts
for every label on those bars, so contrast was re-measured against the **darkest** region of
the artwork (the worst case, and where the bar actually sits) rather than an average:

| | before 0.75 | after |
|---|---|---|
| Tab, inactive `#6B5236` | 4.29 ❌ | `#5A452D` → **5.33** |
| Tab, active `#A03A10` | 3.62 ❌ | `#7C2B0A` → **5.10** |
| App bar title | — | 8.87 |
| App bar subtitle | — | 5.23 |

**`data-role="tabs"` collided between the shell and the Settings page** — a real bug, and the
one behind the duplicated nav bar.

`MobileShell.paintTabs()` did `this.root.querySelector('[data-role="tabs"]')`, and
`settings.page.js` labels its section switcher with the same role. Pages render into
`.m-content`, which precedes `<nav class="m-tabbar">` in document order, so once Settings was
open the query returned the **switcher**. `bus.on(EVENTS.ROUTE_DONE, …)` calls `paintTabs()`
on every navigation, so arriving at Settings painted the five main tabs straight over the six
section pills.

Two consequences, both visible in the report that found it:
- **Five of the six Settings sections were unreachable on mobile** — School, Branches, Fee
  plans, Curriculum and About, for every role including Owner. Only Display survived, because
  it is the default panel and needs no pill to reach.
- The real tab bar stopped updating its active state after the first navigation, since it was
  no longer the element being repainted — which is why Home stayed lit while Settings was open.

Fixed by having the shell **cache its own chrome nodes at mount**, before any page has
rendered, rather than re-querying an attribute namespace it shares with pages. All seven
shell queries now go through `this.nodes`. Renaming the one attribute would have fixed the
symptom and left the next collision to be found in another screenshot. `natyam-admin`'s shell
was audited for the same class of bug and is clean — it uses `data-role="nav"`, and none of
its queried roles appear in any page.

**Two alignment defects in `.m-subhead`, one root cause.** A sticky element pins to its
scrollport's *padding box*, so `top: 0` could never rise above `.m-content`'s 14px top
padding — silently cancelling the `margin-top: -14px` that was meant to full-bleed the bar up
to the app bar. That left a 14px strip of artwork between the two white bars, and the pinned
bar painted 2px over the section label below it (`z-index: 5`, so the label lost). `top: -14px`
fixes both; measured 0px gap and a 12px label gap at scroll positions 0 and 60.

Also hid the overlay scrollbar on `.m-chip-scroll`, which Chrome painted as a dark line
straight across the white subhead.

---

## Stage 17 — the mobile app can create things

Reported directly: there was no plus button anywhere on mobile. That was accurate — every
write path from Stages 13–16 went into `natyam-admin` only, and the mobile app was read-only
throughout, with a dead `data-action="add"` handler in students.page.js that no button ever
dispatched to.

| File | Action |
|---|---|
| `js/ui/form.js` | **new** — the mobile form layer, ported from natyam-admin and re-chromed |
| `assets/css/v3.css` | form-sheet + field styles; `.m-fab` already existed and is reused |
| `js/modules/mobile/students.page.js` | FAB + Add a student |
| `js/modules/mobile/admissions.page.js` | FAB + New application |
| `js/modules/mobile/settings.page.js` | contextual FAB + Add a branch / Add a fee plan |

### The sheet is a different shape from the desktop dialog, on purpose

Actions live in the **header**, not a footer, for two physical reasons: a phone form is nearly
always taller than the viewport, so a footer sits below the fold exactly when it is wanted;
and the software keyboard covers the bottom third of the screen the whole time a field has
focus. Cancel and Save stay pinned and reachable. Verified the header holds at `top: 0` after
scrolling the body to its end, and that the body scrolls while the sheet itself does not.

Confirms stay bottom sheets — a confirm is short by definition.

### Two bugs caught by measuring rather than looking

**The sheet did not fill the screen.** `.m-form-sheet` inherits `.m-sheet`, which is a bottom
sheet: `bottom: 0; max-height: 78vh`, its own padding, top-rounded corners. Setting
`height: 100%` did not beat `max-height`, so the header floated a fifth of the way down the
viewport. Every one of those had to be undone explicitly (`top: 0; max-height: none;
padding: 0; border-radius: 0`).

**Inputs were 14px, which triggers the iOS zoom trap.** The rule used
`font-size: var(--text-base)` — and `--text-base` is `0.875rem` (14px) in this project, not
16px. Below 16px, iOS Safari zooms the whole page in when a field takes focus and does not
zoom back out. Now a literal `16px`, with the reason written next to it so nobody
"tidies" it back to the token. My own comment had asserted 16px; the measurement said
otherwise.

### FABs are placed and gated, not sprinkled

Above the tab bubble, not in the app bar: the top-right corner is the hardest place on a phone
to reach one-handed, and this is the most-used control on the screen it appears on. Measured a
6px clearance over the tab bar at 375×812.

Settings gets a **contextual** FAB — only Branches and Fee plans. The other four sections are
not oversights: Display is per-device preferences with nothing to create, School and About are
single records, and Curriculum's real operations are reorder and deactivate, which need a
per-row `masterEntryUsage()` check rather than a floating button. Those stay on desktop.

All FABs are capability-gated (`STUDENT_EDIT`, `ADMISSION_EDIT`, `SETTINGS_EDIT`).

### Verified, signed in as Owner & Accountant on the real data

Student sheet: 15 fields under three dividers, 5 real batches with live enrolment counts, 4
real fee plans. Admissions sheet: 14 fields under four dividers, and the service's own step
rules land per-field (age-4 floor, ten-digit contact number) with no rules restated in the
mobile page. Fee-plan sheet: ₹ prefix and the real frequency list. All tap targets ≥44px, all
inputs 16px. All 10 mobile routes render with no console errors.

**Not verified:** nothing was submitted from any mobile form — each would write to the
production project.

---

## Stage 18 — mobile chrome and form shape, per direct instruction

Four changes, all requested:

1. **App bar and tab bar now match the desktop header's cream glass**, replacing the white at
   0.75. Same hue and same blur/saturate as `natyam-admin`'s `.v3-header`.
2. **The plus opens a centred box**, not a full-height sheet.
3. **Cancel and Save sit at the end of the form**, reached by scrolling to the bottom, rather
   than pinned in a header.
4. **Tapping outside the box cancels.**

Applied to every plus in the app: Students, Admissions, Settings → Branches, Settings → Fee
plans. Verified each opens a centred box with a footer and dismisses on a backdrop tap.

### The one place the instruction had to be adapted, and why

The desktop header is cream at **0.45**. Copied straight across, the mobile chrome fails to
carry readable text — and the reason is where the two bars sit, not what colour they are. The
desktop header sits over the artwork's bright upper glow; the mobile **tab bar** sits over its
dark lower floor. Measured there, cream at 0.45 composites to `rgb(140,126,116)`, a mid tone
on which **pure black tops out at 5.35:1** and the darkest colour in this palette reaches
**3.83** — nothing in the ramp passes AA.

So the hue is the desktop's, and the opacity is **0.62** (0.68 in the light variant): still
clearly translucent with the artwork reading through, but enough for the ink ramp to be read.

The active tab changed with it. A 12% terracotta wash plus dark text could not clear AA on a
mid-tone bar, so the active slot is now a **solid terracotta pill with white on it** — 4.68:1,
and a plainer statement of which tab you are on than a tint was.

| | dark | light |
|---|---|---|
| App bar title | 6.15 | 7.15 |
| App bar subtitle | 4.56 | 5.30 |
| Tab, inactive | 4.56 | 5.30 |
| Tab, active | 4.68 | 4.68 |

`--v3-ink-soft` (#5B4632) measured 2.3 on the new bar, so the app-bar subtitle — which carries
the branch name, not decoration — took the darker ink.

### Verified

Centred box confirmed by geometry (narrower and shorter than the viewport, horizontally
centred, 14px side gutters). The box scrolls as one unit with the footer at its end: the
buttons start below the fold and are fully visible after scrolling to the bottom. A tap on the
backdrop dismisses; a tap on a field or on the title does **not** — the scrim wraps the dialog,
so the guard comparing `event.target` to the matched element is what separates them. All 10
mobile routes render, no console errors.

**One earlier measurement of mine was wrong, not the CSS:** `tabInactive` first read 2.45
because the probe sampled `.m-tab[1]` while on `#/students`, where that *is* the active tab —
so it compared white against the bar rather than against its own pill. Re-sampled against a
genuinely inactive tab it reads 4.56.

---

## Stage 21 — Parents on mobile, and a correction to how Phase 2 was being built

**Raised directly, and it was right:** Phase-2 modules were going into `natyam-admin` only.
Parents shipped desktop-first in Stage 20 and mobile got nothing. Owner & Accountant works
from *both* surfaces and holds every capability except the six administrator-only ones — so a
desktop-only module means the Owner has to find a laptop to do something they could do
standing in the studio.

**Corrected policy from here on:** every Phase-2 module ships on both surfaces in the same
stage, not desktop-first with mobile to follow.

| File | Action |
|---|---|
| `js/modules/mobile/parents.page.js` | **new** — mobile household directory |
| `js/config/navigation.js` | `/parents` added to `MORE_ITEMS`, placed after Admissions |

### It is not the desktop page shrunk

- **Calling is the feature.** `tel:` and `sms:` are real links that hand off to the phone's own
  dialer. That is the whole reason this screen earns its place on a handset — on the desktop
  the number is something to read and copy, here it is one tap.
- **Four filters, not five.** "No email" was dropped: chasing a missing email address is desk
  work, and a fifth pill starts a second row on a 375px screen.
- **Editing stays on desktop.** Changing a household's contact details fans a write across
  every child's record — a deliberate, several-record operation that belongs where there is
  room to see what is about to happen. The sheet says so rather than leaving the absence to be
  puzzled over.
- Placed after Admissions in the More sheet, not at the bottom: reception's two commonest
  reasons to open this app are taking an application and reaching a family.

### Verified against live data, signed in as Owner & Accountant

129 households, "₹2.85L owed" in the subhead, four filters, 129 rows. Detail sheet opens on the
real household with `tel:+91…` and `sms:+91…` both correctly formed, real email, and all four
Iyer children with levels, batches and balances. Parents appears in the More sheet between
Admissions and Batches. No console errors.

**Not verified:** nothing was written — this screen has no write path by design.

---

## Stage 25 (cont.) — Finance on mobile

Summary, then drill-down — the shape the approved plan called for, not the desktop's four tabs
shrunk. A twelve-column ledger on a 375px screen is worse than no ledger.

1. **Net first and largest** — the one number somebody opens this on a phone to see, with
   in / out / margin under it.
2. **Six months** of the same three figures, so a bad month reads as a trend rather than a
   number without context.
3. **Where it went**, by category, tappable into the actual rows and back out.

**One write, and only one: recording spending.** That genuinely happens away from a desk —
costumes bought at a shop, a taxi paid at a venue — and `recordExpense()` writes the expense
and its ledger entry in one transaction, so there is no half-finished state to leave behind.
Posting ledger entries, reversing them and payroll stay on desktop: a reversal is a correction
someone reads later, and payroll pays real people. The screen says so.

### Two numbers that legitimately disagree — now labelled rather than left to be guessed at

"Where it went" totals **₹40,205** for July while "Out" says **₹1,41,705**. Both are right:
`expenseBreakdown()` reads the **expenses store** (7 recorded expenses), while the P&L reads
the **ledger**, which also carries payroll (₹42,000) and anything posted straight to it
(₹56,000 of rent) — a ₹1,01,500 gap.

Not a bug and not something to "fix" by making one read the other; they answer different
questions. But a screen showing ₹40K next to ₹1.42L with no explanation invites exactly the
kind of doubt the reconciliation notice was built to prevent. Both surfaces now caption it:
*"Recorded expenses only — payroll and direct ledger entries are not counted here."*

### A collision caught by measuring, not by looking

The trend bars were written as `.v3-bars`/`.v3-bar` — class names that **already existed** as a
*vertical* column chart whose `.v3-bar` caps at `max-width: 34px`. Every horizontal percentage
width was being silently clamped. Renamed to `.v3-trend`/`.v3-trend-bar` (and `.m-trend*` on
mobile) with their own rules; measured widths now range 2px–870px and vary per month instead
of all sitting at 34.

### Verified live (Owner & Accountant, July 2026)

Net headline **−₹28,205** — matching the desktop exactly, i.e. the corrected figure from the
reversal fix. In ₹1.14L, Out ₹1.42L, margin −25%. Six trend months with varying bars. Category
chips Rent/Utilities/Maintenance/Travel/Stationery; drilling into Rent shows its 2 rows and the
back control returns all 7. FAB present for Owner. No console errors on any of the 15 mobile
routes.

**Not verified:** nothing was recorded — `recordExpense()` writes to the ledger.

---

## Stage 28 — Analytics on mobile (Reports stays desktop-only)

**Raised directly, and correct:** Stage 27 built Analytics and Reports on desktop only, and
copied both services into mobile without a page calling either. That broke the both-surfaces
policy set in Stage 21 — the same mistake, made again.

**Scope then narrowed by decision: Analytics on mobile, Reports not.**

| File | Action |
|---|---|
| `js/modules/mobile/analytics.page.js` | **new** |
| `js/config/navigation.js` | `/analytics` added to `MORE_ITEMS`; header corrected |
| `js/services/reports.service.js` | **removed** — no caller in this app |

### Not the desktop's ten panels stacked

KPIs first as full-width rows, then **one trend at a time behind a toggle** — Students /
Income / Attendance / Collected. Four charts squeezed into a phone column say less than one
that fits. Switching series is a repaint, not a refetch: every series is already in the
`analyticsOverview()` payload.

The branch and teacher comparison tables are deliberately absent and the screen says so —
they are wide grids that only mean anything read side by side, and a table you drag sideways
teaches nobody anything.

The failed-panel notice is carried over and matters *more* here: with panels behind a toggle,
an unnamed missing one would be invisible.

### Reports is desktop-only by decision, not omission

A report is a declared grid meant to be printed, exported to a spreadsheet and handed to an
accountant. The useful thing to do with one is not to read it on a handset.

So `reports.service.js` was **deleted from natyam-mobile** rather than left sitting there:
carrying a service no page calls is exactly what the copy-only-what-you-need rule exists to
prevent, and Stage 27 had violated it. The mobile navigation header now records the decision
so the absence reads as intentional.

### Verified

Every one of the 16 mobile page modules imports cleanly, including the new Analytics page.
All 16 routes declare a `load`. `/analytics` is present in the More sheet, `/reports` is not,
and `reports.service.js` no longer resolves. `verify-imports` passes in both apps.

**Not verified this round, and stated plainly:** the mobile Firebase session expired partway
through and could not be re-established from here, so **Analytics was not exercised as a
signed-in user against live data**. The desktop Analytics page — which reads the same
`analyticsOverview()` payload through the same service — was fully verified in Stage 27 with
all ten panels building. What is unproven here is this page's own rendering: the KPI rows, the
series toggle and the trend bars. Worth opening once on the next signed-in run.
