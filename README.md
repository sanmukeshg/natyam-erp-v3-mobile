# Natyam ERP v3 — Mobile

The **mobile** application for NATYAM — School of Kuchipudi. Daily operations for owners,
teachers and reception, plus the read-only Parent/Student Portal.

Runs entirely in the browser. **No build step, no bundler, no runtime dependencies** — plain
ES modules served as static files, exactly as the reference project did.

---

## The two apps

Natyam ERP v3 is two independent applications against one Firebase project:

| | Repository | Surface | Users |
|---|---|---|---|
| Desktop | `natyam-admin` | Sidebar navigation | Administrator, Owner & Accountant, Viewer |
| **This one** | `natyam-mobile` | Phone — bottom tab bar | Owner & Accountant, Teacher & Reception, Parents/Students (portal) |

**Owner & Accountant is the one role that uses both.** Administrator is turned away here and
pointed at the desktop app; Teacher & Reception is turned away there and pointed here.

This is a **mobile-first** application, not the desktop one made responsive. Per the split
brief, it does not reuse desktop layouts — the screens here were built for a thumb.

---

## Two audiences in one app

They are not variants of each other, and the boot sequence routes between them:

- **Staff** (Owner & Accountant, Teacher & Reception) → `MobileShell`, bottom tab bar, the
  Phase-1 staff modules.
- **Guardians** (parents; students later) → `PortalShell`, six read-only pages, a child
  switcher. A guardian has **no `users` document** — they are resolved by matching their phone
  or email against student records — so the portal runs on its own `Router` instance with its
  own validity check. The staff router's `users$.find` re-check would fail on every single
  navigation for this identity type.

---

## Running it locally

```bash
node tools/dev-server.cjs
```

Then open <http://localhost:8802>. Test at a phone viewport (375×812 is the reference size);
the layout assumes a phone and only widens to a readable column above 620px.

Opening `index.html` from the filesystem will **not** work — ES modules are blocked under
`file://` by browser security policy.

## Checking the module graph

There is no build step, so nothing validates imports before a browser hits them:

```bash
node tools/verify-imports.cjs
```

---

## ⚠️ Three things that will bite you

### 1. `firestore.rules` here is a **reference copy** — do not edit it

The canonical copy lives in `natyam-admin`. Firebase enforces one rules document per project,
and both apps read and write the same collections. Edit rules there, republish via the
Firebase Console (it is **not** part of any git push), then copy the file here so the two do
not drift.

### 2. A fix in shared logic must be applied twice

`js/services/` and `js/data/` are **copies**, not a shared package. A bug fixed in
`students.service.js` here is still present in `natyam-admin`'s copy until you apply it there
too. Accepted trade for independent repositories — but a real, ongoing cost.

Files copied unmodified deliberately **keep their original `NATYAM ERP 2.0` headers**, so they
can be diffed byte-for-byte against the reference project to detect drift.

### 3. v2 stylesheets load only for guardian sessions

The portal was copied as-is and is styled against v2's `shell.css` / `components.css` /
`modules.css`, not v3's glass layer. Rather than put two design systems in every document,
`loadPortalStyles()` in `js/app.js` injects those three sheets **only when a guardian session
starts**. A staff session downloads none of them.

If you add a staff screen, style it with `assets/css/v3.css` (`.m-*` classes). Do **not**
reach for `components.css` — a staff session will not have loaded it.

---

## Architecture

Unchanged from the reference project:

```
UI (js/modules/, js/ui/)
  ↓
Services (js/services/)        business logic
  ↓
Repositories (js/data/)        data access only
  ↓
Firebase (js/core/firebase.js)
```

- UI never talks to Firebase directly.
- Capability strings, never role checks.

### What is different in v3

- **`js/config/navigation.js`** — a bottom tab bar (`TABS`) plus a More sheet (`MORE_ITEMS`),
  authored for mobile rather than filtered from the desktop's five groups. `CAPABILITIES` and
  `ROLES` in `app.config.js` are still shared with `natyam-admin`, so permission logic cannot
  drift.
- **`js/ui/mobileShell.js`** — staff chrome. Distinct from `js/ui/portalShell.js`, which
  serves guardians and is carried over unchanged.
- **`assets/css/v3.css`** — the mobile design layer, with real `env(safe-area-inset-*)`
  handling. Primary controls are ≥44px; the filter chips are a documented exception.
- **No IndexedDB.** Every collection is Firestore-only.

---

## Where the data lives

Cloud Firestore, in the shared `natyam-erp` project — not on the device. `firebase.config.js`
is public by design: security comes from Security Rules and Authentication.

---

## Documentation

| Path | What it is |
|---|---|
| `MIGRATION_CHECKLIST.md` | Every file copied, trimmed, built or excluded, and why — stage by stage |
| `CHANGELOG.md` | Release notes, starting at 3.0.0 |
| `docs/design/` | Local copies of the approved Claude Design specs, plus the design system distilled from them |
| `docs/architecture/` | IAM role model, authentication providers, Firestore data model, ADRs |
| `docs/migrations/` | Historical migration notes, incl. the Parent/Student Portal milestone |

## Status

**Not feature-complete.** Migrated: Dashboard (both role variants), Students, and the full
guardian Portal. Remaining Phase-1 modules — Admissions, Attendance, Fee collection, Batches,
Timetable, Notifications, Profile, Settings — render in the tab bar or More sheet and route to
a placeholder that says so. See `MIGRATION_CHECKLIST.md`.
