# Brief for Claude Design — regenerating the four missing v3 screens

Hand this to Claude Design along with the files listed below. It is written so the regenerated
screens match the two that already shipped (Dashboard, Students) rather than drifting into a
new look.

---

## 1. Files to attach — style reference (attach these FIRST)

Without these, the new screens will not match what is already built.

| File | Where it is | Why it matters |
|---|---|---|
| `Dashboard.dc.html` | `docs/design/` in this repo | The reference implementation of the v3 look: glass cards, KPI treatment, sidebar, mobile tab bar |
| `Students.dc.html` | `docs/design/` in this repo | List + modal/sheet patterns, filter pills, badges |
| `README.md` | `docs/design/` in this repo | The design system distilled — exact colours, metrics, both theme variants |
| `assets/css/v3.css` | this repo | The **implemented** system. This is now the source of truth, not the mock |

## 2. Files to attach — per screen

From the reference project `Natyam-ERP-UAT` (or `sanmukeshg/Natyam-ERP-Login-Screen-UAT`):

### Attendance
- `js/modules/attendance/attendance.page.js` — **the existing roll-call interaction; keep it**
- `js/ui/attendance-widgets.js` — class calendar, month grid, student month report
- `js/services/attendance.service.js` — `dayBoard`, `trend`, `missingRegisters`, the data shapes
- `js/services/session.service.js` — postpone/cancel session lifecycle (the toolbar actions)

### Admissions
- `js/modules/admissions/admissions.page.js`
- `js/services/admissions.service.js` — `pipeline()` and the status ladder
- `js/ui/wizard.js` — the multi-step form the application flow uses

### Settings
- `js/modules/settings/settings.page.js`
- `js/services/settings.service.js`
- `js/config/app.config.js` — `ROLES`, `CAPABILITIES`, `SETTINGS_GROUPS` (the tabs are
  role-gated; Teacher & Reception must not see Users / Audit log / Data)

### Timetable
- `js/modules/batches/timetable.page.js`
- `js/services/batches.service.js`
- `js/services/session.service.js`

### Always include
- `assets/css/tokens.css` — type scale, spacing, radii, motion
- `js/config/app.config.js` — `NAVIGATION`, `ROLES`, `LEVELS`

---

## 3. The prompt

```text
Generate the NATYAM ERP v3 screens for Attendance, Admissions, Settings and Timetable.
Each must show BOTH a Desktop and a Mobile experience in one file, exactly like the
attached Dashboard.dc.html and Students.dc.html.

MATCH THE ATTACHED FILES. They are already implemented and shipped — the new screens
must look like they belong to the same product, not like a new design:

  Surface      warm glass over the terracotta stage artwork
               card rgba(58,32,20,0.58) dark / rgba(255,255,255,0.14) light
               border rgba(255,248,239,0.16), radius 14px
               backdrop-filter blur(10px) saturate(128%)
               shadow 0 10px 30px rgba(58,32,20,0.3)
  Accent       #B45B34;  active nav rgba(180,91,52,0.55)
  Mobile tabs  active #E2622B, inactive #6B5236
  Tones        positive #8FD99A, negative #F0917C, caution #F0C177
  Type         cream #FFF8EF on glass; ink #3A2013 on light mobile chrome
  Desktop      sidebar 248px / icon rail 64px, header 56px, nav item 34px, radius 9px
  Mobile       bottom tab bar, 44px touch targets, cards radius 14px, sheet radius 20px top
  Variants     one dark and one light. NOTE: the light variant keeps WHITE type — it is
               lighter glass on the same dark photo, not a conventional light theme.

PRESERVE THE EXISTING INTERACTIONS — do not redesign how these screens work:

  Attendance   Everyone starts present; marking is ONE TAP per student (built for
               one-handed speed). Keep "All present" / "All absent" bulk actions.
               Register toolbar: Postpone and Cancel as filled terracotta buttons,
               plus "Class Calendar" and "Missing registers" with a count badge.
               Keep the month grid and the per-student month report.
  Admissions   Keep the status ladder (draft → submitted → reviewing → approved →
               enrolled / rejected) and the multi-step application wizard.
  Settings     Tabbed: Institute, Branches, Fee plans, Curriculum, Users, Roles,
               Preferences, Audit log, Data. ROLE-GATED — Teacher & Reception must
               NOT see Users, Audit log or Data.
  Timetable    Desktop = weekly grid; Mobile = day picker + agenda list. Tiles show
               batch name and time slot only.

Mobile is genuinely mobile-first — card lists, sheets and bottom navigation. Never a
narrowed desktop table.
```

---

## 4. If Claude Design still cannot produce them

The alternative is to skip the prototype step entirely and build the screens directly in the
app, then review the running result at `localhost:8801` / `localhost:8802`.

That is a smaller risk than it was at the start of this migration, because:

- the **interactions already exist** in the reference project and would be ported, not
  invented — `attendance.page.js` in particular carries a deliberate, documented roll-call UX;
- the **design system is no longer a mock** — it is implemented, verified and running across
  three screens (`assets/css/v3.css`), so a new screen has a concrete system to conform to;
- the real app is a better review artefact than a prototype at this stage — it uses live data
  and real permissions, so what you approve is what ships.

What is genuinely lost without the design files is the chance to review *layout* before it is
built. That is a real cost, but it is recoverable: changing a v3 screen is a CSS-and-markup
edit, not a rewrite, because all the business logic sits untouched in the services layer.
