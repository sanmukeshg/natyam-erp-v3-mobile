/**
 * Natyam ERP v3 — Holidays
 *
 * Declaring that the academy is shut on a given day. Byte-identical in
 * `natyam-mobile` and `natyam-admin` — see tools/verify-shared.cjs.
 *
 * THE REPOSITORY PRE-DATES THIS FILE BY A LONG WAY. holidays.repository was
 * written in Milestone 23 with a complete CRUD surface and its own header
 * saying, accurately, "No create/update/delete path exists anywhere in the app
 * today". Three things read holidays — the dashboard day board, Backup &
 * restore, and the `holidayReminders` Cloud Function — and nothing wrote them,
 * so the collection was permanently empty and all three read nothing. This
 * service is the missing half; the repository needed no changes at all.
 *
 * A HOLIDAY DOES NOT CANCEL CLASSES, and that is a decision rather than an
 * omission. Milestone 6 deliberately decoupled attendance from holidays (see
 * the note in dashboard.service.js), because a school that is closed for Diwali
 * still runs the odd exam rehearsal, and a register silently cancelled by a
 * calendar entry is a register nobody can correct. A holiday is a statement
 * about the day, published to families and shown on the board. Cancelling the
 * actual classes stays a deliberate act in Timetable, where it already emits
 * its own notification.
 *
 * BRANCH SCOPE. `branchId: null` means the whole academy; a branch id means one
 * site is closed and the others are not, which happens for a local civic
 * holiday or a hall that is unavailable. `holidays$.on()` already honours this
 * (`!h.branchId || h.branchId === branchId`) — this file only has to let
 * someone express it.
 */

import { session } from '../core/session.js';
import { holidays$ } from '../data/repositories.js';
import { bus, EVENTS } from '../core/bus.js';
import { localDate } from '../utils/date.js';

/** `YYYY-MM-DD`, the form every stored date in this system takes. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far back the list reaches by default.
 *
 * Past holidays are kept — they are the record of why a register is empty for a
 * day last March, and Backup & restore carries them — but a list that opens on
 * five years of them buries the thing being looked for. One academic year back
 * is the span somebody actually refers to.
 */
const PAST_WINDOW_DAYS = 400;

/* ==========================================================================
   READS
   ========================================================================== */

/**
 * Every holiday, newest first within each group.
 *
 * Split rather than flat: "what is coming" and "what happened" are two
 * different questions, and a single list sorted either way answers only one of
 * them. Upcoming reads soonest-first because the next one is the one that
 * matters; past reads most-recent-first for the same reason in reverse.
 */
export async function listHolidays({ includePast = true } = {}) {
    const rows = await holidays$.all();
    const today = localDate();
    const floor = cutoff(today, PAST_WINDOW_DAYS);

    const upcoming = rows
        .filter((h) => h.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));

    const past = includePast
        ? rows
            .filter((h) => h.date < today && h.date >= floor)
            .sort((a, b) => b.date.localeCompare(a.date))
        : [];

    return { upcoming, past, total: rows.length };
}

/** The holiday on a date, if the given branch observes it. */
export async function holidayOn(date, branchId = null) {
    if (!date) return null;
    return holidays$.on(date, branchId);
}

/* ==========================================================================
   WRITES
   ========================================================================== */

/**
 * Declares a holiday.
 *
 * The date is validated for *shape* but not for being in the future: schools
 * backfill. Somebody entering last Monday's unexpected closure so the empty
 * register has a reason is a legitimate and common use, and refusing it would
 * only push them to lie about the date.
 */
export async function createHoliday(data) {
    session.require('settings.edit', 'declare a holiday');

    const record = normalise(data);
    await assertNoClash(record, null);

    const holiday = await holidays$.create(record);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'holidays', value: holiday });
    return holiday;
}

export async function updateHoliday(id, changes) {
    session.require('settings.edit', 'edit a holiday');
    if (!id) throw new Error('No holiday was specified.');

    const existing = await holidays$.findOrFail(id);
    const record = normalise({ ...existing, ...changes });
    await assertNoClash(record, id);

    const holiday = await holidays$.update(id, record);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'holidays', value: holiday });
    return holiday;
}

/**
 * Removes a holiday.
 *
 * Soft, like every other archive in this system — `holidays$.remove()` sets
 * `deletedAt` and the reads filter it out. A hard delete would take the audit
 * trail with it, and "who cancelled the Diwali closure" is a question worth
 * being able to answer.
 */
export async function removeHoliday(id) {
    session.require('settings.edit', 'remove a holiday');
    if (!id) throw new Error('No holiday was specified.');

    const existing = await holidays$.findOrFail(id);
    await holidays$.remove(id);
    bus.emit(EVENTS.SETTINGS_CHANGED, { key: 'holidays', value: null });
    return existing;
}

/* ==========================================================================
   INTERNALS
   ========================================================================== */

function normalise(data) {
    const name = String(data.name || '').trim();
    const date = String(data.date || '').trim();
    // '' from an unselected dropdown is "all branches", not a branch whose id
    // is the empty string — the difference decides who the holiday applies to.
    const branchId = data.branchId ? String(data.branchId).trim() : null;
    const note = String(data.note || '').trim() || null;

    if (!name) throw new Error('Give the holiday a name, e.g. Diwali.');
    if (!date) throw new Error('Choose a date.');
    if (!DATE_SHAPE.test(date)) throw new Error('That date could not be read. Use the date picker.');

    return { name, date, branchId, note };
}

/**
 * Refuses a second holiday on a date the same people already have off.
 *
 * Not a blanket one-per-date rule: two branches closing on different local
 * holidays is normal, and an academy-wide closure alongside a branch-specific
 * one for the same day is merely redundant, not wrong — but it would show the
 * day board two entries and push two reminders to the same family, so it is
 * refused with an explanation rather than silently allowed.
 */
async function assertNoClash(record, ignoreId) {
    const sameDay = (await holidays$.where('date', record.date))
        .filter((h) => h.id !== ignoreId);
    if (!sameDay.length) return;

    const overlaps = sameDay.find((h) =>
        !h.branchId || !record.branchId || h.branchId === record.branchId);
    if (!overlaps) return;

    throw new Error(overlaps.branchId
        ? `${overlaps.name} is already declared for that branch on this date.`
        : `${overlaps.name} is already declared academy-wide on this date.`);
}

/** `days` before `date`, as YYYY-MM-DD. */
function cutoff(date, days) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() - days);
    return localDate(d);
}
