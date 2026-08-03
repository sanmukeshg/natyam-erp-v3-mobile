/**
 * Natyam ERP v3 — Mobile — Navigation
 *
 * This app's own navigation/route table. Deliberately NOT the desktop's
 * five-group sidebar structure filtered down — mobile is a different
 * navigation pattern, per the split spec ("Do not reuse desktop layouts"),
 * so it is authored independently here.
 *
 * The shape comes from the approved design ("Dashboard.dc.html", mobile
 * half): a five-slot bottom tab bar — Home, Students, Fees, Attendance,
 * More — where "More" opens a sheet holding the rest of the Phase-1
 * modules. Five is the tab-bar limit worth respecting; anything past it
 * belongs in the sheet rather than squeezed into a sixth 44px target.
 *
 * Capability gating is unchanged from the reference app: every item names a
 * CAPABILITIES string and the shell renders only what session.can() allows.
 * Permission logic is shared with natyam-admin via app.config.js; the *list*
 * is not.
 *
 * `load` is a dynamic import, so a page downloads only when first opened.
 * **A null `load` means "not migrated yet"** — the entry still appears (so
 * the real navigation shape is visible and testable) but routes to an honest
 * placeholder. Migrating a module is a one-line change here.
 *
 * Phase 1 covered: Dashboard, Students, Admissions, Attendance, Fee
 * collection, Batches, Timetable, Notifications, Profile, Settings. Phase 2
 * added Parents, Staff, Programmes, Certificates, Finance and Analytics — each
 * shaped for a phone rather than ported, per the split spec.
 *
 * REPORTS IS DESKTOP-ONLY, by decision rather than omission. A report is a
 * declared grid meant to be printed, exported to a spreadsheet and handed to an
 * accountant; the useful thing to do with one is not to read it on a handset.
 * natyam-mobile therefore does not carry reports.service.js at all — copying a
 * service no page calls is exactly what the trimming rule exists to prevent.
 */

import { CAPABILITIES } from './app.config.js';

/**
 * The bottom tab bar. Order is the design's, and is deliberate: the two
 * things a teacher opens the app to do (mark a register, take a payment)
 * are single taps, not buried behind More.
 */
export const TABS = Object.freeze([
    { path: '/', label: 'Home', icon: 'home', cap: null,
      load: () => import('../modules/mobile/dashboard.page.js') },
    { path: '/students', label: 'Students', icon: 'users', cap: CAPABILITIES.STUDENT_VIEW,
      load: () => import('../modules/mobile/students.page.js') },
    { path: '/fees', label: 'Fees', icon: 'receipt', cap: CAPABILITIES.FEE_VIEW,
      load: () => import('../modules/mobile/fees.page.js') },
    { path: '/attendance', label: 'Attendance', icon: 'check-square', cap: CAPABILITIES.ATTENDANCE_VIEW,
      load: () => import('../modules/mobile/attendance.page.js') },
    // The design draws this as a circled ellipsis; `menu` is the closest
    // glyph in the app's own icon set and reads the same way. Not a route —
    // it opens the sheet below.
    { path: '/more', label: 'More', icon: 'menu', cap: null, sheet: true, load: null }
]);

/** Everything reachable from the More sheet. */
export const MORE_ITEMS = Object.freeze([
    { path: '/admissions', label: 'Admissions', icon: 'inbox', cap: CAPABILITIES.ADMISSION_VIEW,
      load: () => import('../modules/mobile/admissions.page.js') },
    // Sits next to Admissions rather than further down: reception's two most
    // common reasons to open this app are taking an application and reaching a
    // family, and a phone is the device that can actually make the call.
    { path: '/parents', label: 'Parents', icon: 'phone', cap: CAPABILITIES.STUDENT_VIEW,
      load: () => import('../modules/mobile/parents.page.js') },
    { path: '/staff', label: 'Staff', icon: 'briefcase', cap: CAPABILITIES.STAFF_VIEW,
      load: () => import('../modules/mobile/staff.page.js') },
    { path: '/batches', label: 'Batches', icon: 'grid', cap: CAPABILITIES.STUDENT_VIEW,
      load: () => import('../modules/mobile/batches.page.js') },
    { path: '/programs', label: 'Programmes', icon: 'star', cap: CAPABILITIES.PROGRAM_VIEW,
      load: () => import('../modules/mobile/programs.page.js') },
    { path: '/certificates', label: 'Certificates', icon: 'award', cap: CAPABILITIES.PROGRAM_VIEW,
      load: () => import('../modules/mobile/certificates.page.js') },
    { path: '/timetable', label: 'Timetable', icon: 'calendar', cap: CAPABILITIES.STUDENT_VIEW,
      load: () => import('../modules/mobile/timetable.page.js') },
    { path: '/finance', label: 'Finance', icon: 'trending-up', cap: CAPABILITIES.FINANCE_VIEW,
      load: () => import('../modules/mobile/finance.page.js') },
    { path: '/analytics', label: 'Analytics', icon: 'bar-chart', cap: CAPABILITIES.REPORT_VIEW,
      load: () => import('../modules/mobile/analytics.page.js') },
    { path: '/notifications', label: 'Notifications', icon: 'bell', cap: CAPABILITIES.STUDENT_VIEW,
      load: () => import('../modules/mobile/notifications.page.js') },
    { path: '/profile', label: 'My account', icon: 'user', cap: null,
      load: () => import('../modules/mobile/profile.page.js') },
    { path: '/settings', label: 'Settings', icon: 'settings', cap: CAPABILITIES.SETTINGS_VIEW,
      load: () => import('../modules/mobile/settings.page.js') }
]);

/**
 * Flat route table the router registers. `/more` is excluded: it is a sheet
 * toggle in the tab bar, not a page, and registering it would put an empty
 * route in the history.
 */
export const ROUTES = Object.freeze([
    ...TABS.filter((tab) => !tab.sheet),
    ...MORE_ITEMS
]);
