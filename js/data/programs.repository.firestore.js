/**
 * NATYAM ERP 2.0 — Programmes repository (Firestore)
 *
 * Milestone 17: the fifth store migrated off IndexedDB, following the exact
 * pattern set by Students/Admissions/Attendance. Keeps the exact external
 * shape the old IndexedDB-backed ProgramRepository (and the base Repository
 * class it extended) had — find/findOrFail/all/where/count/search/create/
 * update/save/remove/restore/createMany, plus the Programme-specific
 * upcoming()/past() — so programs.service.js needed no changes beyond what
 * this migration itself required.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. Unlike Students/Admissions, no new human-facing
 * business code is introduced here — a Programme was never addressed by one
 * in the IndexedDB model (people refer to it by name and date), and this
 * milestone's own scope lock is explicit: do not add functionality the
 * existing module never had.
 */

import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO, localDate } from '../utils/date.js';

const COLLECTION_NAME = 'programs';
const programsCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'venue', 'type'];

/** Soft-delete convention, same as the IndexedDB Repository base class (Programme never opted out of it). */
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
    await recordAuditEntry('Programme', action, id, detail);
}

class FirestoreProgramRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return {
            ...record,
            status: record.status || (record.date < localDate() ? 'completed' : 'scheduled'),
            participants: Array.isArray(record.participants) ? record.participants : [],
            participantCount: Array.isArray(record.participants) ? record.participants.length : (record.participantCount || 0)
        };
    }

    validate(record) {
        if (!record.name?.trim()) throw new Error('A programme needs a name.');
        if (!record.date) throw new Error('A programme needs a date.');
        if (!record.type) throw new Error('Choose a programme type.');
        if (!record.branchId) throw new Error('A programme belongs to a branch.');
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
        if (!id) throw new Error('No programme was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Programme ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(programsCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(programsCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    /**
     * Substring search over `searchKey`. Unlike Students'/Admissions'
     * repositories, this doesn't attempt a prefix-range query first —
     * `listPrograms()` (the only real caller of programme search, via the
     * page's own DataTable) already fetches the full collection and
     * filters client-side, and this collection is small enough that a
     * second, dedicated range query would add complexity for no real
     * benefit today.
     */
    async search(term, { limit: max = 20 } = {}) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return [];

        return (await this.all())
            .filter((r) => (r.searchKey || '').includes(q))
            .slice(0, max);
    }

    /* --------------------------------------------------------------- WRITES */

    async create(data) {
        const record = this.beforeSave({ ...data });
        this.validate(record);
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

        const ref = await addDoc(programsCollection, full);
        await writeAuditRow('create', ref.id);
        return { id: ref.id, ...full };
    }

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

        const changed = Object.keys(changes).filter((k) => existing[k] !== merged[k]);
        await writeAuditRow('update', id, { fields: changed });

        return { ...existing, ...merged, id };
    }

    async save(data) {
        if (data.id && await this.find(data.id)) return this.update(data.id, data);
        return this.create(data);
    }

    /** Soft delete by default — a school's programme record is part of its history. */
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
        if (!snap.exists()) throw new Error(`Programme ${id} no longer exists.`);
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
            const ref = doc(programsCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing programme document, then re-creates `records` (each stamped
     * fresh via create(), same "replace" semantics as every other store).
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
                setBatch.set(doc(programsCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }

    /* ------------------------------------------------------- PROGRAM QUERIES */

    async upcoming(limit = 5, branchId = null) {
        const today = localDate();
        const rows = (await this.all())
            .filter((p) => p.date >= today && p.status !== 'cancelled')
            .sort((a, b) => a.date.localeCompare(b.date));
        return (branchId ? rows.filter((p) => p.branchId === branchId) : rows).slice(0, limit);
    }

    async past(branchId = null) {
        const today = localDate();
        const rows = (await this.all()).filter((p) => p.date < today).sort((a, b) => b.date.localeCompare(a.date));
        return branchId ? rows.filter((p) => p.branchId === branchId) : rows;
    }
}

export const programs$ = new FirestoreProgramRepository();
