# Approved design references (Claude Design → local copies)

Source: Claude Design project **"NATYAM ERP Rebuild v3"**
(`775d1046-a561-41f1-9065-9be9abdd0173`), repo-linked to
`sanmukeshg/Natyam-ERP-Login-Screen-UAT`.

These `.dc.html` files are the **authoritative visual/UX spec** for the v3 migration. They are
in Claude Design's interactive-prototype runtime (`<x-dc>`, `{{ }}` bindings, `sc-if`/`sc-for`,
a `DCLogic` class loaded via `support.js`) — **not portable HTML/CSS/JS**. They cannot be
copy-pasted into the app; each is hand-translated into this app's real patterns (`Page`
classes, `html`/`render` from `js/utils/dom.js`, `js/ui/icons.js`, `assets/css/v3.css`).

## Why local copies exist

On 2026-08-01, partway through the migration, the design project became unreachable — the
Design API began returning `404 project not found` for `get_project`, `list_files` and
`get_file`, having served them successfully earlier the same session. Everything retrieved
before that point is preserved here so the migration is not dependent on that API staying
available.

## What is here

| File | Covers | Implemented in |
|---|---|---|
| `Dashboard.dc.html` | Desktop admin/owner dashboard **and** mobile task-first teacher/reception dashboard | Stage 1 (admin), Stage 2 (mobile) |
| `Students.dc.html` | Desktop roll + centred profile modal **and** mobile card list + profile sheet | Stage 3 (both) |

## What is NOT here — and is needed

These existed in the project and were listed by `list_files`, but were never retrieved before
access was lost:

- `Attendance.dc.html` — roll-call screen, drag-or-tap present/absent toggle
- `Admissions.dc.html` — admissions workflow
- `Settings.dc.html` — tabbed Institute/Branches/Fee plans/Curriculum/Users/Roles/
  Preferences/Audit log/Data, role-gated
- `Timetable.dc.html` — desktop weekly grid, mobile day-picker + agenda
- `Sidebar Navigation.dc.html` — desktop accordion nav (already implemented in Stage 1 from a
  full read, so this one is not blocking)
- `assets/`, `uploads/` — reference imagery. Not blocking: the real brand assets in
  `assets/img/brand/` are the same artwork.

**Migrating Attendance, Admissions, Settings or Timetable requires their design first**, per
the standing instruction to implement the approved design rather than invent a layout. See the
root `MIGRATION_CHECKLIST.md`.

## The design system, as established by the two files here

Recorded so the visual language survives even if nothing further is recovered:

- **Surface:** warm glass over the school's terracotta stage artwork. Card
  `rgba(58,32,20,0.58)` dark / `rgba(255,255,255,0.14)` light, border
  `rgba(255,248,239,0.16)`, radius 14px, `blur(10px) saturate(128%)`,
  shadow `0 10px 30px rgba(58,32,20,0.3)`.
- **Two variants**, both warm-on-artwork, switched by the app's `[data-theme]`. Note the
  "light" variant keeps **white** type — it is lighter glass on a dark photo, not a
  conventional light theme (see `assets/css/v3.css` for why the scrim darkens in both).
- **Accent:** `#B45B34`; active nav `rgba(180,91,52,0.55)`; mobile tab active `#E2622B`,
  inactive `#6B5236`.
- **Tone ramp:** positive `#8FD99A`, negative `#F0917C`, caution `#F0C177`.
- **Type:** cream `#FFF8EF` on glass; ink `#3A2013` on the light mobile chrome.
- **Desktop metrics:** sidebar 248px / rail 64px, header 56px, nav item 34px, radius 9px.
- **Mobile metrics:** tab bar with 44px targets, cards radius 14px, sheet radius 20px top.
