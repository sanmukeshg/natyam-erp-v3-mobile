/**
 * NATYAM ERP 2.0 — Batch service
 *
 * A batch is where a level, a teacher, a room and a timetable meet, and almost
 * every conflict the school actually experiences is a collision between two of
 * those. This module enforces the ones that matter: a teacher cannot be in two
 * halls at once, a hall cannot hold two batches at once, and a batch cannot be
 * closed while students are still sitting in it.
 *
 * 1.0 had none of these checks. It was possible — and did happen — to schedule
 * two batches into Hall A on Saturday morning, which nobody discovered until
 * both sets of parents arrived.
 */

import { bus, EVENTS } from '../core/bus.js';
import { session } from '../core/session.js';
import { localDate, dayName, addDays, startOfWeek } from '../utils/date.js';
import { LEVELS, levelLabel, levelsLabel, levelsOf } from '../config/app.config.js';
import { batches$, students$, staff$, attendance$, branches$, AttendanceMath } from '../data/repositories.js';
import { markedSessions } from './attendance.service.js';
import { sessionMap } from './session.service.js';
import { batchScheduleOf } from './students.service.js';

export const WEEK = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

/* ==========================================================================
   SCHEDULING RULES
   ========================================================================== */

/** Do two time ranges on the same day overlap? Touching ends do not count. */
function overlaps(a, b) {
    return a.startTime < b.endTime && b.startTime < a.endTime;
}

function sharesDay(a, b) {
    return (a.days || []).some((d) => (b.days || []).includes(d));
}

/**
 * Finds every scheduling conflict a proposed batch would create.
 *
 * Returns a list rather than throwing on the first, because a badly-timed new
 * batch typically clashes with the teacher *and* the room, and being told
 * about them one at a time is three round trips of frustration.
 */
export async function findConflicts(candidate) {
    // Teacher clashes intentionally check every branch, not just the
    // candidate's own — a teacher assigned to more than one branch (Staff
    // supports this) still cannot teach two overlapping sessions, wherever
    // they are. A conflicting batch at another branch is real data, just
    // outside the currently-viewed branch's list, so its branch is named in
    // the message rather than the check being narrowed to hide it.
    const [allActive, branches] = await Promise.all([batches$.active(), branches$.all()]);
    const others = allActive.filter((b) => b.id !== candidate.id && b.status === 'active');
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const conflicts = [];

    for (const other of others) {
        if (!sharesDay(candidate, other) || !overlaps(candidate, other)) continue;

        const days = (candidate.days || []).filter((d) => (other.days || []).includes(d));
        const when = `${days.join(', ')} ${other.startTime}–${other.endTime}`;
        const elsewhere = candidate.branchId && other.branchId && candidate.branchId !== other.branchId
            ? branchName.get(other.branchId) : null;

        if (candidate.teacherId && candidate.teacherId === other.teacherId) {
            conflicts.push({
                type: 'teacher', batch: other,
                message: `The same teacher already takes ${other.name}${elsewhere ? ` at ${elsewhere}` : ''} on ${when}.`
            });
        }
        if (candidate.room && candidate.branchId === other.branchId && candidate.room === other.room) {
            conflicts.push({ type: 'room', batch: other, message: `${candidate.room} is occupied by ${other.name} on ${when}.` });
        }
    }

    return conflicts;
}

/* ==========================================================================
   LIFECYCLE
   ========================================================================== */

export async function createBatch(data, { allowConflicts = false } = {}) {
    session.require('student.edit', 'create a batch');

    const candidate = normalise(data);
    assertShape(candidate);

    const conflicts = await findConflicts(candidate);
    if (conflicts.length && !allowConflicts) {
        const err = new Error(`This clashes with an existing batch. ${conflicts[0].message}`);
        err.conflicts = conflicts;
        throw err;
    }

    const batch = await batches$.create(candidate);
    bus.emit(EVENTS.BATCH_CREATED, { batch });
    return { batch, conflicts };
}

export async function updateBatch(id, changes, { allowConflicts = false } = {}) {
    session.require('student.edit', 'edit a batch');

    const existing = await batches$.findOrFail(id);
    const candidate = normalise({ ...existing, ...changes, id });
    assertShape(candidate);

    /* Removing a level a batch used to teach would silently leave anyone
       still enrolled at exactly that level with the wrong level for
       promotion and certification. Adding a level is always safe — nobody
       already enrolled could conflict with a level newly added to the set. */
    const removedLevels = levelsOf(existing).filter((l) => !levelsOf(candidate).includes(l));
    if (removedLevels.length) {
        const roster = await students$.byBatch(id);
        const affected = roster.filter((s) => removedLevels.includes(s.level));
        if (affected.length) {
            throw new Error(
                `${affected.length} student${affected.length === 1 ? ' is' : 's are'} enrolled at ${levelsLabel(removedLevels)} in this batch. ` +
                'Move them out before removing that level.'
            );
        }
    }

    const conflicts = await findConflicts(candidate);
    if (conflicts.length && !allowConflicts) {
        const err = new Error(`This clashes with an existing batch. ${conflicts[0].message}`);
        err.conflicts = conflicts;
        throw err;
    }

    const batch = await batches$.update(id, candidate);
    bus.emit(EVENTS.BATCH_UPDATED, { batch, before: existing });

    // Milestone P1 (Parent/Student Portal): every currently enrolled student
    // carries a copy of this batch's own schedule (see students.service.js's
    // batchScheduleOf()), since the portal can only read a guardian's own
    // `students` doc, not `batches` directly. A reschedule here must refresh
    // every enrolled family's copy, not just a newly-assigned student's —
    // best-effort and isolated from the batch update itself succeeding,
    // matching app.js's maintenance() pattern for non-fatal housekeeping.
    try {
        const roster = await students$.byBatch(id);
        await Promise.all(roster.map((s) => students$.update(s.id, { batchSchedule: batchScheduleOf(batch, s.level) })));
    } catch (err) {
        console.error('Failed to refresh batchSchedule on enrolled students after a batch update', err);
    }

    return { batch, conflicts };
}

/**
 * Closes a batch. Refuses while students remain, and offers the caller the
 * roster so the UI can propose moving them somewhere rather than just saying
 * no. A closed batch keeps its attendance history for reporting.
 */
export async function closeBatch(id, { reason = null, moveTo = null } = {}) {
    session.require('student.edit', 'close a batch');

    const batch = await batches$.findOrFail(id);
    const roster = await students$.byBatch(id);

    if (roster.length && !moveTo) {
        const err = new Error(`${batch.name} still has ${roster.length} student${roster.length === 1 ? '' : 's'}. Choose where they should go.`);
        err.roster = roster;
        throw err;
    }

    if (roster.length && moveTo) {
        const target = await batches$.findOrFail(moveTo);
        if (target.status !== 'active') throw new Error(`${target.name} is not active.`);

        // A per-student check, not a batch-to-batch one: a multi-level
        // source batch's actual roster may only occupy a subset of its
        // configured levels, so the target only needs to cover whichever
        // levels those specific students are at.
        const targetLevels = levelsOf(target);
        const uncovered = roster.filter((s) => !targetLevels.includes(s.level));
        if (uncovered.length) {
            const missingLevels = [...new Set(uncovered.map((s) => s.level))];
            throw new Error(`${target.name} does not teach ${levelsLabel(missingLevels)}, needed for ${uncovered.length} of these students.`);
        }

        const existing = await students$.byBatch(moveTo);
        if (target.capacity && existing.length + roster.length > target.capacity) {
            throw new Error(`${target.name} seats ${target.capacity} and already has ${existing.length}. It cannot take ${roster.length} more.`);
        }
        // `batchSchedule` moves with them — UAT6. It did not, and the copy each
        // student carries for the Parent Portal (see students.service.js's
        // batchScheduleOf()) went on naming the batch that was being closed,
        // with its old days and times. Nothing else rewrites that field until
        // the student is next edited by hand, so every family moved out of a
        // closing batch would have read the wrong timetable indefinitely.
        // updateBatch() above already refreshes it on a reschedule; this is the
        // same obligation on the one path that skipped it.
        for (const student of roster) {
            await students$.update(student.id, {
                batchId: moveTo,
                branchId: target.branchId,
                batchSchedule: batchScheduleOf(target, student.level)
            });
        }
    }

    const closed = await batches$.update(id, {
        status: 'closed',
        closedOn: localDate(),
        closeReason: reason?.trim() || null
    });

    bus.emit(EVENTS.BATCH_CLOSED, { batch: closed, moved: roster.length });
    return { batch: closed, moved: roster.length };
}

export async function reopenBatch(id) {
    session.require('student.edit', 'reopen a batch');
    const batch = await batches$.update(id, { status: 'active', closedOn: null, closeReason: null });
    bus.emit(EVENTS.BATCH_UPDATED, { batch });
    return batch;
}

/* ==========================================================================
   VIEWS
   ========================================================================== */

/** The batch list, with occupancy, teacher name and recent attendance rate. */
export async function listBatches(branchId = null, { includeClosed = false } = {}) {
    const [withOccupancy, teachers, recent] = await Promise.all([
        batches$.withOccupancy(branchId),
        staff$.teachers(),
        attendance$.between(addDays(localDate(), -30), localDate(), branchId)
    ]);

    const teacherName = new Map(teachers.map((t) => [t.id, t.name]));
    const byBatch = new Map();
    for (const row of recent) {
        if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, []);
        byBatch.get(row.batchId).push(row);
    }

    let rows = withOccupancy;
    if (includeClosed) {
        const all = (await batches$.all()).filter((b) => !branchId || b.branchId === branchId);
        const seen = new Set(rows.map((r) => r.id));
        rows = rows.concat(all.filter((b) => !seen.has(b.id)).map((b) => ({ ...b, enrolled: 0, seatsLeft: 0, occupancy: 0 })));
    }

    return rows
        .map((batch) => ({
            ...batch,
            teacherName: teacherName.get(batch.teacherId) || 'Unassigned',
            levelLabel: levelsLabel(levelsOf(batch)),
            schedule: describeSchedule(batch),
            attendanceRate: AttendanceMath.rateOf(byBatch.get(batch.id) || [])
        }))
        .sort((a, b) => a.levelOrder - b.levelOrder || a.name.localeCompare(b.name));
}

/** Everything the batch detail view shows. */
export async function batchDetail(id) {
    const batch = await batches$.findOrFail(id);
    const [roster, teacher, recent, conflicts] = await Promise.all([
        students$.byBatch(id),
        batch.teacherId ? staff$.find(batch.teacherId) : null,
        attendance$.between(addDays(localDate(), -60), localDate()),
        findConflicts(batch)
    ]);

    const mine = recent.filter((r) => r.batchId === id);
    const perStudent = new Map();
    for (const row of mine) {
        if (!perStudent.has(row.studentId)) perStudent.set(row.studentId, []);
        perStudent.get(row.studentId).push(row);
    }

    return {
        batch: {
            ...batch,
            levelLabel: levelsLabel(levelsOf(batch)),
            schedule: describeSchedule(batch),
            enrolled: roster.length,
            seatsLeft: batch.capacity ? Math.max(0, batch.capacity - roster.length) : null,
            occupancy: batch.capacity ? Math.round((roster.length / batch.capacity) * 100) : null
        },
        teacher,
        conflicts,
        attendanceRate: AttendanceMath.rateOf(mine),
        roster: roster.map((student) => ({
            ...student,
            attendanceRate: AttendanceMath.rateOf(perStudent.get(student.id) || [])
        })).sort((a, b) => (a.attendanceRate ?? 101) - (b.attendanceRate ?? 101))
    };
}

/**
 * The week's timetable, grouped by day and sorted by start time. This is the
 * view that makes a double-booking obvious at a glance, which is why it exists
 * as well as the conflict check.
 *
 * Milestone 7: also reflects each day's Timetable Session where one exists —
 * a Postponed or Cancelled status is shown rather than a plain recurring
 * slot, and a Replacement session appears on its own real date even when
 * that date isn't one of the batch's normal recurring days. This is a pure
 * read: looking at the timetable never creates a session (sessionMap() is
 * read-only) — only opening/marking a register, or an explicit postpone/
 * cancel action, does that.
 *
 * @param {string|null} branchId
 * @param {string|null} [weekStartDate]  Monday of the week to show, as
 *   YYYY-MM-DD. Defaults to the current week. The page passes this to move
 *   backwards and forwards; any date works, but it is expected to already be
 *   a Monday (the page derives it with startOfWeek() + whole-week offsets).
 */
export async function timetable(branchId = null, weekStartDate = null) {
    const [batches, teachers] = await Promise.all([batches$.active(branchId), staff$.teachers()]);
    const teacherName = new Map(teachers.map((t) => [t.id, t.name]));
    const byId = new Map(batches.map((b) => [b.id, b]));

    // Each day column stands for a real calendar date within the week being
    // shown (Monday-anchored, matching the Indian school week) — used below
    // to look up whether the register for that date has been taken.
    // Anchoring to a real week, rather than the next upcoming occurrence of
    // each weekday, matters: a day earlier in the week than today must show
    // its own already-passed date, not next week's, or attendance (which can
    // never be marked for a future date) could never match it.
    const weekStart = weekStartDate || startOfWeek();
    const days = WEEK.map((day, i) => ({ day, date: addDays(weekStart, i) }));
    const weekEnd = days[days.length - 1].date;
    const [markedSet, sessions] = await Promise.all([
        markedSessions(days[0].date, weekEnd, branchId),
        sessionMap(days[0].date, weekEnd, branchId)
    ]);

    return days.map(({ day, date }) => {
        // Batches that normally recur this day.
        const recurring = batches.filter((b) => (b.days || []).includes(day));

        // A session explicitly recorded on this exact date whose batch
        // isn't already one of the recurring ones above — a Replacement
        // session sitting on an otherwise non-recurring day is exactly
        // this case, and it still needs to appear on the day it actually
        // falls on.
        const extra = [...sessions.values()]
            .filter((s) => s.date === date && !recurring.some((b) => b.id === s.batchId))
            .map((s) => byId.get(s.batchId))
            .filter(Boolean);

        const slots = [...recurring, ...extra]
            .map((b) => {
                const classSession = sessions.get(`${b.id}|${date}`);
                // A Replacement session can carry its own time and teacher,
                // different from the batch's usual schedule — that's the
                // whole point of postponing to it. Fall back to the batch's
                // normal values for an ordinary, untouched occurrence.
                const startTime = classSession?.startTime || b.startTime;
                const endTime = classSession?.endTime || b.endTime;
                const teacherId = classSession?.teacherId || b.teacherId;

                return {
                    ...b,
                    date,
                    startTime,
                    endTime,
                    teacherId,
                    teacherName: teacherName.get(teacherId) || 'Unassigned',
                    levelLabel: levelsLabel(levelsOf(b)),
                    registerMarked: markedSet.has(`${b.id}|${date}`),
                    sessionId: classSession?.id || null,
                    sessionStatus: classSession?.status || 'scheduled',
                    replacementSessionId: classSession?.replacementSessionId || null,
                    // True for the slot a postponed class was moved *to* —
                    // lets the page show it as pending (not yet an ordinary
                    // untouched class) until its register is actually marked.
                    isReplacement: Boolean(classSession?.originalSessionId)
                };
            })
            // A postponed original stays a real record (its own register can
            // never be marked against it again — postRegister() already
            // refuses that), but it has no business still occupying its old
            // day visually once a replacement exists; only the replacement's
            // own date should show anything for this occurrence.
            .filter((entry) => entry.sessionStatus !== 'postponed');

        return {
            day,
            label: dayName(date),
            sessions: slots.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
        };
    });
}

/** A teacher's own week — the teacher dashboard's schedule panel. */
export async function teacherSchedule(teacherId) {
    const batches = await batches$.byTeacher(teacherId);
    const rosters = await Promise.all(batches.map((b) => students$.byBatch(b.id)));

    return WEEK.map((day) => ({
        day,
        sessions: batches
            .map((b, i) => ({ ...b, enrolled: rosters[i].length, levelLabel: levelsLabel(levelsOf(b)) }))
            .filter((b) => (b.days || []).includes(day))
            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
    })).filter((d) => d.sessions.length);
}

/* ------------------------------------------------------------------ HELPERS */

function normalise(data) {
    // Milestone B1: `levels` (array) is the source of truth; `data.level`
    // (a lone value from a not-yet-edited pre-B1 document, or a caller that
    // hasn't been updated) is accepted as a one-element fallback so nothing
    // upstream has to change shape before this function does.
    const levels = Array.isArray(data.levels)
        ? LEVELS.filter((l) => data.levels.includes(l.value)).map((l) => l.value)
        : (data.level ? [data.level] : []);
    const levelOrder = Math.min(...levels.map((v) => LEVELS.find((l) => l.value === v)?.order ?? 99), 99);

    return {
        ...data,
        name: String(data.name || '').trim(),
        code: String(data.code || '').trim().toUpperCase(),
        room: data.room?.trim() || null,
        days: Array.isArray(data.days) ? WEEK.filter((d) => data.days.includes(d)) : [],
        capacity: Number(data.capacity) || 0,
        levels,
        levelOrder,
        status: data.status || 'active'
    };
}

function assertShape(batch) {
    if (!batch.name) throw new Error('A batch needs a name.');
    if (!batch.code) throw new Error('A batch needs a short code, e.g. HYD-PRA-A.');
    if (!batch.branchId) throw new Error('Choose which branch this batch runs at.');
    if (!batch.levels?.length) throw new Error('Choose at least one level this batch teaches.');
    if (!batch.days.length) throw new Error('Choose at least one day the batch meets.');
    if (!batch.startTime || !batch.endTime) throw new Error('Give the start and end time.');
    if (batch.endTime <= batch.startTime) throw new Error('The batch cannot end before it starts.');
    if (batch.capacity < 0) throw new Error('Capacity cannot be negative.');
}

function describeSchedule(batch) {
    if (!batch.days?.length) return 'Not scheduled';
    const days = WEEK.filter((d) => batch.days.includes(d)).join(', ');
    return `${days} · ${batch.startTime}–${batch.endTime}`;
}
