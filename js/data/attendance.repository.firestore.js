/**
 * NATYAM ERP 2.0 — Attendance repository (Firestore)
 *
 * Milestone 6: the fourth store to move off IndexedDB (see ADR-014). Keeps
 * the exact external shape the old IndexedDB-backed AttendanceRepository
 * had — forBatchOn/forStudent/onDate/between/remove, plus the static
 * AttendanceMath.rateOf()/breakdownOf() — so attendance.service.js and
 * every read-only caller (reports/dashboard/students/staff/certificates
 * .service.js) needed no changes beyond what the P/A-only business
 * simplification itself required.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * (`addDoc`) and never shown to a user. The old IndexedDB store enforced
 * "re-marking updates, never duplicates" via a unique index on a composite
 * `batchId|date|studentId` key — Firestore has no equivalent index type, so
 * the same guarantee is enforced here by querying on the plain `batchId`
 * and `date` fields before writing (see postMany()). The `batchDate` field
 * is kept on every record for backward-compatible shape (seed.js and any
 * export/report that reads it), but is no longer the mechanism that
 * prevents duplicates.
 *
 * Attendance is written and read far more than any other entity in this
 * app, so the atomic-whole-roll-call guarantee the original design called
 * for ("a failure halfway left a class half-marked") is preserved with a
 * Firestore writeBatch in postMany() — the same primitive already used for
 * Students'/Admissions' bulk writes.
 */

import {
    collection, doc, getDoc, getDocs, deleteDoc,
    query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { ATTENDANCE_STATUS } from '../config/app.config.js';

const COLLECTION_NAME = 'attendance';
const attendanceCollection = collection(firestore, COLLECTION_NAME);

async function writeAuditRow(action, id, detail) {
    await recordAuditEntry('Attendance', action, id, detail);
}

class FirestoreAttendanceRepository {
    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    async findOrFail(id) {
        const record = await this.find(id);
        if (!record) throw new Error(`Attendance record ${id} no longer exists.`);
        return record;
    }

    /** Every record, unscoped — used by backup.service.js's buildBackup(). Attendance has no soft-delete concept, so there is no `includeDeleted` to honor. */
    async all() {
        const snap = await getDocs(attendanceCollection);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async forBatchOn(batchId, date) {
        const snap = await getDocs(query(attendanceCollection,
            where('batchId', '==', batchId), where('date', '==', date)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async forStudent(studentId, { from = null, to = null } = {}) {
        const snap = await getDocs(query(attendanceCollection, where('studentId', '==', studentId)));
        let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (from) rows = rows.filter((r) => r.date >= from);
        if (to) rows = rows.filter((r) => r.date <= to);
        return rows.sort((a, b) => b.date.localeCompare(a.date));
    }

    /**
     * Milestone P2 (Parent/Student Portal). Every record across every one of
     * a guardian's children — filtered by `guardianPhone`/`guardianEmail`
     * directly on the attendance document, never by `studentId`. This is
     * deliberate, not incidental: firestore.rules can only authorize a query
     * when its own where() filter matches exactly the field the guardian
     * read rule checks (see that rule's own comment) — a studentId-based
     * query would be denied outright regardless of what the rule says.
     * Callers narrow to one child client-side, the same shape
     * guardianAuth.service.js's guardianChildren() already established.
     */
    async forGuardian(phone, email) {
        const [byPhone, byEmail] = await Promise.all([
            phone ? getDocs(query(attendanceCollection, where('guardianPhone', '==', phone))) : null,
            email ? getDocs(query(attendanceCollection, where('guardianEmail', '==', email))) : null
        ]);

        const seen = new Map();
        for (const snap of [byPhone, byEmail]) {
            if (!snap) continue;
            for (const d of snap.docs) seen.set(d.id, { id: d.id, ...d.data() });
        }
        return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date));
    }

    /**
     * Backfill use only (js/migrations/guardianFieldsBackfillMigration.js).
     * Chunked writeBatch field-only updates — deliberately bypasses this
     * repository's own per-record audit-row write, since a single run can
     * touch thousands of existing records and per-record audit writes here
     * would repeat the exact Firestore-quota exhaustion a restore's
     * per-record writes already caused once this session.
     */
    async bulkSetGuardianFields(updates) {
        for (let i = 0; i < updates.length; i += 450) {
            const chunk = updates.slice(i, i + 450);
            const batch = writeBatch(firestore);
            for (const { id, guardianPhone, guardianEmail } of chunk) {
                batch.update(doc(firestore, COLLECTION_NAME, id), { guardianPhone, guardianEmail });
            }
            await batch.commit();
        }
        return updates.length;
    }

    async onDate(date, branchId = null) {
        const snap = await getDocs(query(attendanceCollection, where('date', '==', date)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return branchId ? rows.filter((r) => r.branchId === branchId) : rows;
    }

    /** Inclusive date-range query, same shape as db.between() gave the IndexedDB version. */
    async between(from, to, branchId = null) {
        const snap = await getDocs(query(attendanceCollection,
            where('date', '>=', from), where('date', '<=', to)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return branchId ? rows.filter((r) => r.branchId === branchId) : rows;
    }

    /* --------------------------------------------------------------- WRITES */

    /**
     * Posts a whole roll call atomically — the Firestore counterpart to the
     * IndexedDB version's single `db.unit()` transaction. Queries the
     * existing rows for this batch+date once (not per student), so a
     * re-mark updates the same documents rather than creating duplicates,
     * matching the guarantee the old unique index gave for free.
     *
     * @param {Array<{studentId, status, note}>} entries
     * @param {string|null} [sessionId]  The Timetable Session this roll call
     *   belongs to (Milestone 7). Attendance never resolves or creates this
     *   itself — session.service.js does, and the id is only ever passed in
     *   by the caller (attendance.service.js's postRegister()).
     * @param {Map<string, {guardianPhone, guardianEmail}>} [guardianByStudent]
     *   Milestone P2 — denormalized onto each record so a guardian can read
     *   their child's attendance without a per-document reverse lookup (see
     *   forGuardian() above). Built once by the caller from a single roster
     *   read, not fetched per student here.
     * @returns {Promise<{records: object[], corrections: number}>}
     */
    async postMany(batchId, date, branchId, entries, sessionId = null, guardianByStudent = new Map()) {
        const existing = await this.forBatchOn(batchId, date);
        const priorByStudent = new Map(existing.map((row) => [row.studentId, row]));
        const at = nowISO();
        const actor = session.actorId();

        const batch = writeBatch(firestore);
        const records = [];
        let corrections = 0;

        for (const entry of entries) {
            const prior = priorByStudent.get(entry.studentId);
            const guardian = guardianByStudent.get(entry.studentId) || {};
            const record = {
                batchDate: `${batchId}|${date}|${entry.studentId}`,
                studentId: entry.studentId,
                batchId,
                branchId,
                date,
                sessionId: sessionId || prior?.sessionId || null,
                status: entry.status,
                note: entry.note?.trim() || null,
                markedBy: actor,
                markedByName: session.actorName(),
                createdAt: prior?.createdAt || at,
                createdBy: prior?.createdBy || actor,
                updatedAt: at,
                updatedBy: actor,
                correctedFrom: prior && prior.status !== entry.status ? prior.status : null,
                guardianPhone: guardian.guardianPhone ?? prior?.guardianPhone ?? null,
                guardianEmail: guardian.guardianEmail ?? prior?.guardianEmail ?? null
            };
            if (record.correctedFrom) corrections += 1;

            const ref = prior ? doc(firestore, COLLECTION_NAME, prior.id) : doc(attendanceCollection);
            batch.set(ref, record);
            records.push({ id: ref.id, ...record });
        }

        await batch.commit();
        await writeAuditRow(existing.length ? 'correct' : 'mark', batchId, { date, count: records.length, corrections });

        return { records, corrections, wasUpdate: existing.length > 0 };
    }

    /** Hard delete — used by students.service.js's deleteStudent(), no soft-delete concept here (attendance never had one). */
    async remove(id, { hard = true } = {}) {
        void hard;
        await deleteDoc(doc(firestore, COLLECTION_NAME, id));
        await writeAuditRow('delete', id, { hard: true });
        return true;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing attendance document, then writes `records` back in batches
     * of 450 (Firestore's writeBatch cap is 500) — "replace", matching
     * restore()'s existing all-or-nothing semantics for every other store.
     */
    async replaceAll(records) {
        const existingSnap = await getDocs(attendanceCollection);
        for (let i = 0; i < existingSnap.docs.length; i += 450) {
            const chunk = existingSnap.docs.slice(i, i + 450);
            const delBatch = writeBatch(firestore);
            for (const d of chunk) delBatch.delete(d.ref);
            await delBatch.commit();
        }

        for (let i = 0; i < records.length; i += 450) {
            const chunk = records.slice(i, i + 450);
            const setBatch = writeBatch(firestore);
            for (const record of chunk) {
                const { id, ...data } = record;
                setBatch.set(doc(attendanceCollection, id), data);
            }
            await setBatch.commit();
        }

        return records.length;
    }

    /* -------------------------------------------------------------- MATH */

    /** present over total. The number the school quotes, now a straight P/A ratio. */
    static rateOf(rows) {
        if (!rows.length) return null;
        const present = rows.filter((r) => r.status === ATTENDANCE_STATUS.PRESENT).length;
        return Math.round((present / rows.length) * 100);
    }

    static breakdownOf(rows) {
        const tally = { present: 0, absent: 0 };
        for (const row of rows) if (row.status in tally) tally[row.status] += 1;
        return tally;
    }
}

export const attendance$ = new FirestoreAttendanceRepository();
export const AttendanceMath = FirestoreAttendanceRepository;
