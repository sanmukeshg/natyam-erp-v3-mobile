/**
 * NATYAM ERP 2.0 — Session service (Timetable)
 *
 * Owns the Timetable Session lifecycle: Scheduled → Completed / Postponed /
 * Cancelled. A Session is one actual occurrence of a batch's recurring
 * schedule — Timetable defines the recurrence (`batch.days`); this is what
 * turns one specific date of it into a real, addressable record with its
 * own history.
 *
 * Attendance references a Session by id but never owns or writes one
 * directly — every write to the `classSessions` collection goes through
 * this file, never through attendance.service.js. This is the boundary the
 * whole milestone is built around: Timetable owns Sessions, Attendance does
 * not.
 */

import { bus, EVENTS } from '../core/bus.js';
import { session } from '../core/session.js';
import { classSessions$, batches$ } from '../data/repositories.js';

const DAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Whether a batch's recurring weekly schedule includes this date. This is
 * the seam attendance.service.js was built around in Milestone 6 ("backed
 * by the batch's own recurring weekly schedule until a full Timetable-based
 * session concept exists") — now the real, permanent home for that check.
 * It only decides whether a session should be lazily scheduled when none
 * exists yet; an actual Session record at this batch+date (e.g. a
 * Replacement, sitting on an otherwise non-recurring day) is authoritative
 * regardless of what this function says.
 */
export function isScheduledClassDay(batch, date) {
    const dayCode = DAY_CODES[new Date(`${date}T00:00:00`).getDay()];
    return (batch.days || []).includes(dayCode);
}

/**
 * Read-only status check for a batch+date's Session, if one already exists —
 * never lazily schedules one (unlike resolveSession(), which is only right to
 * call at the moment attendance is actually being posted). Lets Attendance
 * know whether a session here is already Postponed/Cancelled — e.g. to hide
 * its own Postpone/Cancel controls for a slot that's already in one of those
 * states — without ever reading the classSessions collection itself.
 *
 * Also resolves `postponedFrom`: when this session is itself a Replacement
 * (it carries an `originalSessionId`), the original's own date — so the
 * register can say plainly where this class was moved from, rather than
 * just showing up on a day the batch doesn't normally meet with no context.
 */
export async function sessionStatusOf(batchId, date) {
    const existing = await classSessions$.findByBatchDate(batchId, date);
    if (!existing) return { status: null, postponedFrom: null };

    let postponedFrom = null;
    if (existing.originalSessionId) {
        const original = await classSessions$.find(existing.originalSessionId);
        postponedFrom = original?.date || null;
    }

    return { status: existing.status || null, postponedFrom };
}

function minutesBetween(startTime, endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
}

function sessionCodeFor(batch, date) {
    return `TS-${date.replace(/-/g, '')}-${batch.code}`;
}

/**
 * Finds the session for a batch+date, lazily scheduling one if the date is
 * one of the batch's recurring days and nothing has been recorded there
 * yet. Returns null if there's genuinely nothing scheduled — the caller
 * (attendance.service.js's postRegister(), or the postpone/cancel actions
 * below) decides what that means for its own operation; this function only
 * ever answers "what session, if any, belongs here."
 */
export async function resolveSession(batchId, date) {
    const existing = await classSessions$.findByBatchDate(batchId, date);
    if (existing) return existing;

    const batch = await batches$.findOrFail(batchId);
    if (!isScheduledClassDay(batch, date)) return null;

    return classSessions$.create({
        sessionCode: sessionCodeFor(batch, date),
        branchId: batch.branchId,
        batchId: batch.id,
        // No Batch↔Programme or Batch↔Curriculum association exists yet
        // (a regular weekly batch isn't linked to either concept anywhere
        // in this codebase today) — left null, forward-compatible, rather
        // than invented.
        programId: null,
        curriculumId: null,
        teacherId: batch.teacherId || null,
        date,
        startTime: batch.startTime,
        endTime: batch.endTime,
        duration: minutesBetween(batch.startTime, batch.endTime),
        sessionType: 'regular',
        status: 'scheduled',
        remarks: null,
        reason: null,
        originalSessionId: null,
        replacementSessionId: null,
        createdBy: session.actorId()
    });
}

/**
 * Read-only lookup across a date range, for Timetable's own week display —
 * never creates a session. Merely looking at the timetable must not write
 * anything; only opening/marking a register, or an explicit postpone/cancel
 * action, does.
 */
export async function sessionMap(from, to, branchId = null) {
    const rows = await classSessions$.between(from, to, branchId);
    return new Map(rows.map((r) => [`${r.batchId}|${r.date}`, r]));
}

/**
 * Postpones the class scheduled for batchId+date and creates its
 * replacement, atomically — the original is never deleted, only marked
 * Postponed, and stays linked to whatever replaces it forever.
 */
export async function postponeSession(batchId, date, { newDate, newStartTime, newEndTime, teacherId, reason, remarks }) {
    session.require('student.edit', 'postpone a session');

    if (!newDate || !newStartTime || !newEndTime) throw new Error('Choose the replacement date and time.');
    if (newEndTime <= newStartTime) throw new Error('The replacement class cannot end before it starts.');
    if (!reason?.trim()) throw new Error('Record why this class is being postponed.');

    const original = await resolveSession(batchId, date);
    if (!original) throw new Error('There is no scheduled class here to postpone.');

    const batch = await batches$.findOrFail(original.batchId);

    const result = await classSessions$.postpone(original.id, {
        sessionCode: sessionCodeFor(batch, newDate),
        branchId: original.branchId,
        batchId: original.batchId,
        programId: original.programId,
        curriculumId: original.curriculumId,
        teacherId: teacherId || original.teacherId,
        date: newDate,
        startTime: newStartTime,
        endTime: newEndTime,
        duration: minutesBetween(newStartTime, newEndTime),
        sessionType: original.sessionType,
        reason,
        remarks,
        actor: session.actorId()
    });

    bus.emit(EVENTS.SESSION_POSTPONED, result);
    return result;
}

/** Cancels the class scheduled for batchId+date outright — no replacement, the class simply doesn't happen. */
export async function cancelSession(batchId, date, { reason, remarks }) {
    session.require('student.edit', 'cancel a session');
    if (!reason?.trim()) throw new Error('Record why this class is being cancelled.');

    const original = await resolveSession(batchId, date);
    if (!original) throw new Error('There is no scheduled class here to cancel.');

    await classSessions$.cancel(original.id, { reason, remarks, actor: session.actorId() });
    bus.emit(EVENTS.SESSION_CANCELLED, { sessionId: original.id });
}

/**
 * Marks a session Completed. Called only by attendance.service.js's
 * postRegister() after a successful post — never by the UI directly, and
 * never anything Attendance writes to this collection itself.
 */
export async function completeSession(sessionId) {
    return classSessions$.complete(sessionId);
}
