/**
 * NATYAM ERP 2.0 — Batches repository (Firestore)
 *
 * Milestone 19: the seventh store migrated off IndexedDB, following the
 * exact pattern set by Students/Admissions/Attendance/Class Sessions/
 * Programmes/Certificates. Keeps the exact external shape the old
 * IndexedDB-backed BatchRepository (and the base Repository class it
 * extended) had — find/findOrFail/all/where/count/search/create/update/
 * save/remove/restore/createMany, plus the Batch-specific active()/
 * meetingOn()/byTeacher()/withOccupancy() — so every existing caller
 * (batches.service.js, attendance/session/students/admissions/staff/
 * dashboard/reports/analytics/settings/search.service.js) needed no
 * changes beyond what this migration itself required.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. Batches already had a real human-facing
 * business code before this migration — `code` (e.g. HYD-PRA-A) — so,
 * like Certificates' `serial`, nothing new is introduced here; `code`
 * keeps doing exactly what it already did.
 *
 * `code` uniqueness was previously enforced only by IndexedDB's native
 * unique index on that field (`SCHEMA.batches`, app.config.js) — Firestore
 * has no equivalent constraint, so create()/update() now check for a
 * clashing code explicitly. This is the one behavioural addition this
 * migration makes; everything else is a lift-and-shift.
 */

import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO, localDate } from '../utils/date.js';
import { students$ } from './students.repository.firestore.js';

const COLLECTION_NAME = 'batches';
const batchesCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'code', 'level'];
const DAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Soft-delete convention, same as the IndexedDB Repository base class (Batch never opted out of it). */
function visible(record) {
    return record && !record.deletedAt;
}

function searchKeyOf(record) {
    return SEARCH_FIELDS
        .map((f) => record[f])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .join(' ')
        .toLowerCase();
}

async function writeAuditRow(action, id, detail) {
    await recordAuditEntry('Batch', action, id, detail);
}

class FirestoreBatchRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return {
            ...record,
            code: String(record.code || '').trim().toUpperCase(),
            days: Array.isArray(record.days) ? record.days : [],
            status: record.status || 'active',
            capacity: Number(record.capacity) || 0
        };
    }

    validate(record) {
        if (!record.name?.trim()) throw new Error('A batch needs a name.');
        if (!record.code) throw new Error('A batch needs a code.');
        if (!record.branchId) throw new Error('A batch must belong to a branch.');
        if (!record.days.length) throw new Error('Choose at least one day the batch meets.');
        if (record.startTime && record.endTime && record.endTime <= record.startTime) {
            throw new Error('The batch cannot end before it starts.');
        }
    }

    /**
     * Firestore has no equivalent to IndexedDB's unique index — this is the
     * application-level replacement for the constraint `SCHEMA.batches`
     * used to enforce. `excludeId` lets update() check without tripping
     * over the record's own current code.
     */
    async _assertCodeAvailable(code, excludeId = null) {
        const clashes = await this.where('code', code);
        if (clashes.some((b) => b.id !== excludeId)) {
            throw new Error(`A batch with the code ${code} already exists.`);
        }
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
        if (!id) throw new Error('No batch was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Batch ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(batchesCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(batchesCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    /**
     * Substring search over `searchKey`, same trade-off as Programmes'/
     * Certificates' repositories — the batches list is small enough that
     * fetching the full collection and filtering client-side is simpler
     * than a dedicated prefix-range query.
     */
    async search(term, { limit: max = 20 } = {}) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return [];

        return (await this.all())
            .filter((r) => (r.searchKey || '').includes(q))
            .slice(0, max);
    }

    async active(branchId = null) {
        const rows = (await this.all()).filter((b) => b.status === 'active');
        return branchId ? rows.filter((b) => b.branchId === branchId) : rows;
    }

    /** Batches meeting on a given calendar date, in start-time order. */
    async meetingOn(date = localDate(), branchId = null) {
        const code = DAY_CODES[new Date(`${date}T00:00:00`).getDay()];
        return (await this.active(branchId))
            .filter((b) => b.days.includes(code))
            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    }

    async byTeacher(teacherId) {
        return (await this.where('teacherId', teacherId)).filter((b) => b.status === 'active');
    }

    /**
     * Roster counts for every batch in one pass. Called by the batches
     * table and the dashboard; doing it per row would be N+1 queries.
     */
    async withOccupancy(branchId = null) {
        const [batches, students] = await Promise.all([this.active(branchId), students$.active()]);
        const counts = new Map();
        for (const student of students) {
            if (student.batchId) counts.set(student.batchId, (counts.get(student.batchId) || 0) + 1);
        }
        return batches.map((batch) => {
            const enrolled = counts.get(batch.id) || 0;
            return {
                ...batch,
                enrolled,
                seatsLeft: Math.max(0, (batch.capacity || 0) - enrolled),
                occupancy: batch.capacity ? Math.round((enrolled / batch.capacity) * 100) : 0
            };
        });
    }

    /* --------------------------------------------------------------- WRITES */

    async create(data) {
        const record = this.beforeSave({ ...data });
        this.validate(record);
        await this._assertCodeAvailable(record.code);
        delete record.id;

        const at = nowISO();
        const actor = session.actorId();

        const full = {
            ...record,
            createdAt: at, createdBy: actor,
            updatedAt: at, updatedBy: actor,
            deletedAt: null,
            searchKey: searchKeyOf(record)
        };

        const ref = await addDoc(batchesCollection, full);
        await writeAuditRow('create', ref.id, { code: full.code });
        return { id: ref.id, ...full };
    }

    async update(id, changes) {
        const existing = await this.findOrFail(id);
        const merged = this.beforeSave({ ...existing, ...changes, id });
        this.validate(merged);
        if (merged.code !== existing.code) await this._assertCodeAvailable(merged.code, id);

        merged.updatedAt = nowISO();
        merged.updatedBy = session.actorId();
        merged.searchKey = searchKeyOf(merged);
        delete merged.id;
        delete merged.createdAt;
        delete merged.createdBy;

        await updateDoc(doc(firestore, COLLECTION_NAME, id), merged);

        const changed = Object.keys(changes).filter((k) => existing[k] !== merged[k]);
        await writeAuditRow('update', id, { fields: changed });

        return { ...existing, ...merged, id };
    }

    async save(data) {
        if (data.id && await this.find(data.id)) return this.update(data.id, data);
        return this.create(data);
    }

    /** Soft delete by default — a batch is normally closed, not removed. */
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
        if (!snap.exists()) throw new Error(`Batch ${id} no longer exists.`);
        await updateDoc(doc(firestore, COLLECTION_NAME, id), {
            deletedAt: null,
            deletedBy: null,
            updatedAt: nowISO()
        });
        await writeAuditRow('restore', id);
        return true;
    }

    async createMany(items) {
        const batch = writeBatch(firestore);
        const at = nowISO();
        const actor = session.actorId();
        const records = [];

        for (const item of items) {
            const record = this.beforeSave({ ...item });
            this.validate(record);
            delete record.id;

            const full = {
                ...record,
                createdAt: at, createdBy: actor,
                updatedAt: at, updatedBy: actor,
                deletedAt: null,
                searchKey: searchKeyOf(record)
            };
            const ref = doc(batchesCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing batch document, then re-creates `records` (each stamped
     * fresh, same "replace" semantics as every other store). Bypasses the
     * code-uniqueness check by design — a restore is trusted to already
     * be internally consistent, the same way every other store's
     * replaceAll() skips its own repository-level validation.
     */
    async replaceAll(records) {
        const existing = await this.all({ includeDeleted: true });

        for (let i = 0; i < existing.length; i += 450) {
            const chunk = existing.slice(i, i + 450);
            const delBatch = writeBatch(firestore);
            for (const row of chunk) delBatch.delete(doc(firestore, COLLECTION_NAME, row.id));
            await delBatch.commit();
        }

        for (let i = 0; i < records.length; i += 450) {
            const chunk = records.slice(i, i + 450);
            const setBatch = writeBatch(firestore);
            for (const record of chunk) {
                const { id, ...data } = record;
                setBatch.set(doc(batchesCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const batches$ = new FirestoreBatchRepository();
