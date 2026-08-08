/**
 * Natyam ERP v3 — Functions — time, in the school's timezone
 *
 * EVERY DATE IN THIS DATABASE IS A LOCAL ONE. Invoices carry `dueDate`, batches
 * carry `startTime`, attendance is keyed `batchId|date` — all written by a
 * browser in Asia/Kolkata as plain `YYYY-MM-DD` and `HH:MM` strings with no
 * offset on them. A Cloud Function runs in UTC, so `new Date()` there is five
 * and a half hours behind the school and would call it "yesterday" for the
 * whole evening — exactly when classes run and reminders matter most.
 *
 * So nothing in this codebase may use a bare `new Date()` to decide what day it
 * is. It goes through here.
 */

export const TIMEZONE = 'Asia/Kolkata';

/** `YYYY-MM-DD` for right now, in the school's timezone. */
export function today(at = new Date()) {
    // `en-CA` formats as YYYY-MM-DD, which is the format every date field in
    // this database already uses — no assembling from parts, no padding bugs.
    return at.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/** Minutes since midnight, in the school's timezone. */
export function minutesNow(at = new Date()) {
    const [h, m] = at
        .toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour12: false, hour: '2-digit', minute: '2-digit' })
        .split(':');
    return Number(h) * 60 + Number(m);
}

/** `Mon`…`Sun` for a `YYYY-MM-DD`, matching a batch's `days` array. */
export function dayCode(date) {
    const codes = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Parsed at midnight LOCAL to the runtime, which is safe here because only
    // the weekday is wanted and a date-only string cannot straddle one.
    return codes[new Date(`${date}T00:00:00`).getDay()];
}

/** `HH:MM` → minutes since midnight. Returns null for a missing or malformed time. */
export function toMinutes(hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

/** `YYYY-MM-DD` shifted by whole days, still in the school's timezone. */
export function addDays(date, days) {
    const d = new Date(`${date}T12:00:00Z`);   // midday, so a DST-free shift cannot roll the date
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** Rupees from integer paise, for notification text. */
export function money(paise) {
    return `₹${Math.round((paise || 0) / 100).toLocaleString('en-IN')}`;
}
