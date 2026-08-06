/**
 * NATYAM ERP 2.0 — Students repository (Firestore)
 *
 * Milestone 3: the second store to move off IndexedDB (see ADR-014). Keeps
 * the exact external shape the old IndexedDB-backed StudentRepository and
 * the base Repository class it extended had — find/findOrFail/all/where/
 * count/search/create/update/save/remove/restore/createMany, plus
 * Student-specific active/byBatch/byBranch/unassigned/birthdaysIn/
 * countsByLevel/transfer/promote — so students.service.js and every module
 * that calls it needed no changes.
 *
 * Field names are unchanged from the IndexedDB model (`name`, `guardianName`
 * /`guardianPhone`, `level`, `admissionNo`, …) — deliberately not renamed to
 * match any generic example schema, since a dozen other files depend on
 * these exact names. See docs/migrations/STUDENT_MODULE_MIGRATION.md for
 * the full field mapping and rationale.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * (`addDoc`) and never shown to a user. `studentCode` (`STU000001`, via the
 * shared sequenceGenerator.firestore.js) is the new, permanent ERP-wide
 * business identifier — generated automatically inside create()/createMany()
 * so no caller needs to ask for it. `admissionNo` is unchanged and kept
 * alongside it: it is the Admissions module's own reference number, not an
 * ERP-wide identifier — see docs/migrations/STUDENT_MODULE_MIGRATION.md.
 *
 * Milestone P1 (Parent/Student Portal): two read-only, denormalized fields —
 * `batchSchedule: {batchId, name, level, days, startTime, endTime}` and
 * `programmes: [{programId, title, type, date, venue}]`. Neither is written
 * here; this repository just carries whatever it's given, the same as every
 * other field. They exist so the portal's guardian-scoped `firestore.rules`
 * read of a `students` doc (see js/services/portal/guardianAuth.service.js)
 * never needs a second, unscopeable read of `batches`/`programs` — those two
 * collections have no reverse index from student to batch/programme, and
 * Firestore rules cannot express that lookup. Kept in sync by
 * students.service.js's assignToBatch()/enrol(), batches.service.js's
 * updateBatch() (refreshing every current roster member), and
 * programs.service.js's setParticipants().
 */

import {
    collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
    query, where, limit as fsLimit, startAfter, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO, localDate } from '../utils/date.js';
import { LEVELS, STUDENT_STATUS } from '../config/app.config.js';
import { nextCode } from './sequenceGenerator.firestore.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'students';
const studentsCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'admissionNo', 'guardianName', 'guardianPhone', 'level'];

/** Soft-delete convention, same as the IndexedDB Repository base class. */
function visible(record) {
    return record && !record.deletedAt;
}

/**
 * Collapses whitespace, keeps only digits and a leading +, and defaults to
 * +91 for a bare number — matching users.repository.firestore.js's
 * normalisePhone() exactly. Guardian phones must land in the same E.164
 * shape Firebase Phone Auth's token claim uses, or a guardian's own number
 * (typed without a country code, as most people do) never matches at
 * sign-in — the same class of bug already found and fixed once for staff
 * Mobile OTP, now fixed here before the Parent/Student Portal depends on it.
 */
function normalisePhone(value) {
    if (!value) return null;
    const digits = String(value).replace(/[^\d+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    return `+91${digits.replace(/^0+/, '')}`;
}

function searchKeyOf(record) {
    return SEARCH_FIELDS
        .map((f) => record[f])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .join(' ')
        .toLowerCase();
}

async function writeAuditRow(action, id, detail) {
    await recordAuditEntry('Student', action, id, detail);
}

class FirestoreStudentRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return {
            ...record,
            name: String(record.name || '').trim().replace(/\s+/g, ' '),
            status: record.status || STUDENT_STATUS.ACTIVE,
            guardianPhone: normalisePhone(record.guardianPhone),
            alternatePhone: normalisePhone(record.alternatePhone),
            emergencyContact: normalisePhone(record.emergencyContact)
        };
    }

    validate(record) {
        if (!record.name) throw new Error('A student needs a name.');
        if (!record.branchId) throw new Error('A student must belong to a branch.');
        if (!record.level) throw new Error('A student must be placed at a level.');
        if (!LEVELS.some((l) => l.value === record.level)) throw new Error(`"${record.level}" is not a recognised level.`);
        if (!record.guardianPhone) throw new Error('A guardian contact number is required.');
        if (record.dateOfBirth && record.dateOfBirth > localDate()) throw new Error('Date of birth cannot be in the future.');
    }

    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        if (!snap.exists()) return null;
        const record = { id: snap.id, ...snap.data() };
        return visible(record) ? record : null;
    }

    async findOrFail(id) {
        if (!id) throw new Error('No student was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Student ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(studentsCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    /** `index` is a plain Firestore field name here — single-field equality needs no pre-declared index. */
    async where(index, value) {
        const snap = await getDocs(query(studentsCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    /**
     * Same as where(), plus an explicit status=='active' filter — required
     * for any query firestore.rules' isGuardianOfStudent() must authorize.
     * Firestore denies a whole query outright (not a partial filter) unless
     * the query's own where() clauses can prove the rule holds for every
     * possible match; the rule checks both status=='active' and the field
     * being queried, so a query missing the status filter is rejected with
     * "Missing or insufficient permissions" before it ever runs. Confirmed
     * 2026-07-28 against a real guardian sign-in attempt. Used only by
     * js/services/portal/guardianAuth.service.js.
     */
    async whereActive(index, value) {
        const snap = await getDocs(query(
            studentsCollection,
            where(index, '==', value),
            where('status', '==', 'active')
        ));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    /**
     * Firestore cursor-based pagination — kept for interface completeness
     * and forward compatibility, not wired into the UI this milestone.
     * Nothing in students.service.js currently calls paginate(): every
     * listing fetches all()/active() and paginates client-side in
     * js/ui/table.js, exactly as it did against IndexedDB, so that
     * behaviour is preserved unchanged rather than replaced here.
     */
    async paginate({ pageSize = 25, cursor = null, filter = null } = {}) {
        const constraints = [fsLimit(pageSize)];
        if (cursor) constraints.push(startAfter(cursor));

        const snap = await getDocs(query(studentsCollection, ...constraints));
        let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        rows = rows.filter(visible);
        if (filter) rows = rows.filter(filter);

        return {
            rows,
            nextCursor: snap.docs[snap.docs.length - 1] || null,
            hasMore: snap.docs.length === pageSize
        };
    }

    /**
     * Prefix search over `searchKey`, same technique the IndexedDB version
     * used (a range query), falling back to a full-collection substring
     * scan only when the prefix range comes up short — a registrar looking
     * for "Ramachandran" should still find "Srilekha Ramachandran".
     */
    async search(term, { limit: max = 20 } = {}) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return [];

        const prefixSnap = await getDocs(query(
            studentsCollection,
            where('searchKey', '>=', q),
            where('searchKey', '<', `${q}`),
            fsLimit(max)
        ));
        const prefixHits = prefixSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
        if (prefixHits.length >= max) return prefixHits;

        const seen = new Set(prefixHits.map((r) => r.id));
        const rest = (await this.all())
            .filter((r) => !seen.has(r.id) && (r.searchKey || '').includes(q))
            .slice(0, max - prefixHits.length);

        return [...prefixHits, ...rest];
    }

    /* --------------------------------------------------------------- WRITES */

    async create(data) {
        const record = this.beforeSave({ ...data });
        this.validate(record);
        delete record.id;

        const at = nowISO();
        const actor = session.actorId();
        const studentCode = await nextCode('studentCode', 'STU');

        const full = {
            ...record,
            studentCode,
            createdAt: at, createdBy: actor,
            updatedAt: at, updatedBy: actor,
            deletedAt: null,
            searchKey: searchKeyOf(record)
        };

        const ref = await addDoc(studentsCollection, full);
        await writeAuditRow('create', ref.id);
        return { id: ref.id, ...full };
    }

    /**
     * MIGRATION USE ONLY — not called by any normal application code path
     * (login, enrolment, the Students screen, …). Writes a Firestore
     * document from a legacy IndexedDB record while *preserving* its
     * original audit metadata and admissionNo, rather than re-stamping
     * them the way create() does for a genuinely new record. Always
     * creates a new document (a Firestore auto-generated id, per the
     * Document Identifier Standard) — it never reuses the source record's
     * old IndexedDB id. Does not write its own audit row; the migration
     * orchestrator (js/migrations/studentDataMigration.js) writes one
     * summary row for the whole run instead of one per record.
     *
     * @param {object} record  A full IndexedDB-shaped student record.
     * @returns {Promise<object>} the new Firestore record, with its id.
     */
    async importLegacyRecord(record) {
        const prepared = this.beforeSave({ ...record });
        this.validate(prepared);

        // A backup/restore record already has a real Firestore id from its
        // own previous existence — every other collection's records that
        // reference a student (attendance.studentId, invoices.studentId,
        // batches' roster, …) point at that id, so it must be preserved,
        // not regenerated, or the restore silently orphans every one of
        // those references. A genuine 1.0-migration record has no `id` at
        // all (legacy IndexedDB records never had one), so that path is
        // unaffected and still mints a fresh one via addDoc().
        const explicitId = prepared.id || null;
        delete prepared.id;

        // Only generate a fresh code if the source doesn't already carry
        // one — relevant on a retry of a partially-completed migration
        // run, never on a genuine first pass (legacy IndexedDB records
        // have no studentCode field at all).
        const studentCode = record.studentCode || await nextCode('studentCode', 'STU');
        const now = nowISO();

        const full = {
            ...prepared,
            studentCode,
            createdAt: record.createdAt || now,
            createdBy: record.createdBy || 'migration',
            updatedAt: record.updatedAt || now,
            updatedBy: record.updatedBy || 'migration',
            deletedAt: record.deletedAt || null,
            deletedBy: record.deletedBy || null,
            searchKey: searchKeyOf(prepared)
        };

        if (explicitId) {
            await setDoc(doc(studentsCollection, explicitId), full);
            return { id: explicitId, ...full };
        }

        const ref = await addDoc(studentsCollection, full);
        return { id: ref.id, ...full };
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing student document, then imports `records` (each preserving
     * its original metadata via importLegacyRecord(), same as the data
     * migration utility) — "replace", not "merge", matching restore()'s
     * existing all-or-nothing semantics for every other store.
     *
     * @param {object[]} records
     * @returns {Promise<number>} how many were imported
     */
    async replaceAll(records) {
        const existing = await this.all({ includeDeleted: true });

        // Firestore batches cap at 500 operations; chunk defensively even
        // though this school's scale is far below that today.
        for (let i = 0; i < existing.length; i += 450) {
            const chunk = existing.slice(i, i + 450);
            const batch = writeBatch(firestore);
            for (const row of chunk) batch.delete(doc(firestore, COLLECTION_NAME, row.id));
            await batch.commit();
        }

        let imported = 0;
        for (const record of records) {
            await this.importLegacyRecord(record);
            imported += 1;
        }
        return imported;
    }

    /** Full-record replace via updateDoc, matching the IndexedDB version's put()-based semantics. */
    async update(id, changes) {
        const existing = await this.findOrFail(id);
        const merged = this.beforeSave({ ...existing, ...changes, id });
        this.validate(merged);

        merged.updatedAt = nowISO();
        merged.updatedBy = session.actorId();
        merged.searchKey = searchKeyOf(merged);
        delete merged.id;
        delete merged.createdAt;
        delete merged.createdBy;

        await updateDoc(doc(firestore, COLLECTION_NAME, id), merged);

        // Record what actually changed, not the whole object.
        const changed = Object.keys(changes).filter((k) => existing[k] !== merged[k]);
        await writeAuditRow('update', id, { fields: changed });

        return { ...existing, ...merged, id };
    }

    /** Insert or update depending on whether the id already exists. */
    async save(data) {
        if (data.id && await this.find(data.id)) return this.update(data.id, data);
        return this.create(data);
    }

    /**
     * Soft delete by default — a school's records are legal documents.
     * Hard delete (used by students.service.js's deleteStudent(), which
     * also removes the student's invoices/attendance/certificates/
     * documents) issues a real Firestore delete.
     */
    async remove(id, { hard = false } = {}) {
        if (hard) {
            await deleteDoc(doc(firestore, COLLECTION_NAME, id));
            await writeAuditRow('delete', id, { hard: true });
            return true;
        }
        await this.findOrFail(id);
        await updateDoc(doc(firestore, COLLECTION_NAME, id), {
            deletedAt: nowISO(),
            deletedBy: session.actorId()
        });
        await writeAuditRow('archive', id);
        return true;
    }

    async restore(id) {
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        if (!snap.exists()) throw new Error(`Student ${id} no longer exists.`);
        await updateDoc(doc(firestore, COLLECTION_NAME, id), {
            deletedAt: null,
            deletedBy: null,
            updatedAt: nowISO()
        });
        await writeAuditRow('restore', id);
        return true;
    }

    /** Bulk create (e.g. CSV import) via one atomic batch write. */
    async createMany(items) {
        const batch = writeBatch(firestore);
        const at = nowISO();
        const actor = session.actorId();
        const records = [];

        for (const item of items) {
            const record = this.beforeSave({ ...item });
            this.validate(record);
            delete record.id;

            // Sequential, not parallel — nextCode()'s transaction must not
            // race itself within the same batch. Bulk imports are not a hot
            // path, so this is an acceptable trade-off for correctness.
            const studentCode = await nextCode('studentCode', 'STU');

            const full = {
                ...record, studentCode,
                createdAt: at, createdBy: actor,
                updatedAt: at, updatedBy: actor,
                deletedAt: null,
                searchKey: searchKeyOf(record)
            };
            const ref = doc(studentsCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * Atomic-ish bulk field update — the Firestore counterpart to the raw
     * `db.unit()` IndexedDB write students.service.js's bulkAssign() used
     * to make directly against the `students` store (a repository-bypass
     * that would have kept targeting the now-orphaned IndexedDB store after
     * this migration — fixed by routing it through here instead). A
     * writeBatch commits all-or-nothing, the same intent as the IndexedDB
     * transaction it replaces; it cannot also cover the audit row in the
     * same atomic commit, since that write goes to a different database —
     * the caller writes the audit row immediately after this resolves.
     */
    async updateMany(records) {
        const batch = writeBatch(firestore);
        for (const record of records) {
            const { id, ...patch } = record;
            batch.update(doc(firestore, COLLECTION_NAME, id), patch);
        }
        await batch.commit();
        return records.length;
    }

    /* ------------------------------------------------------- STUDENT QUERIES */

    async active(branchId = null) {
        const rows = await this.where('status', STUDENT_STATUS.ACTIVE);
        return branchId ? rows.filter((s) => s.branchId === branchId) : rows;
    }

    async byBatch(batchId) {
        return (await this.where('batchId', batchId))
            .filter((s) => s.status !== STUDENT_STATUS.INACTIVE)
            .sort((a, b) => a.name.localeCompare(b.name, 'en-IN'));
    }

    async byBranch(branchId) {
        return this.where('branchId', branchId);
    }

    /** Students with no batch — the queue a registrar has to clear. */
    async unassigned() {
        return (await this.active()).filter((s) => !s.batchId);
    }

    /**
     * Birthdays in a given calendar month. Firestore can't query a date
     * substring server-side, so — same as the IndexedDB version — this
     * fetches active students and filters client-side.
     */
    async birthdaysIn(month) {
        const key = String(month).padStart(2, '0');
        return (await this.active()).filter((s) => (s.dateOfBirth || '').slice(5, 7) === key);
    }

    async countsByLevel(branchId = null) {
        const rows = await this.active(branchId);
        return LEVELS.map((level) => ({
            level: level.value,
            label: level.label,
            count: rows.filter((s) => s.level === level.value).length
        }));
    }

    async transfer(id, { batchId, branchId }) {
        const student = await this.findOrFail(id);
        return this.update(id, {
            batchId: batchId ?? student.batchId,
            branchId: branchId ?? student.branchId
        });
    }

    async promote(id) {
        const student = await this.findOrFail(id);
        const index = LEVELS.findIndex((l) => l.value === student.level);
        if (index === -1) throw new Error('This student is at an unrecognised level.');
        if (index === LEVELS.length - 1) throw new Error(`${student.name} is already at ${LEVELS[index].label}, the highest level.`);
        return this.update(id, { level: LEVELS[index + 1].value, batchId: null });
    }
}

export const students$ = new FirestoreStudentRepository();
