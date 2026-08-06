/**
 * NATYAM ERP 2.0 — Academic years repository (Firestore)
 *
 * Milestone 23: part of the Settings reference data migration. Keeps the
 * exact external shape the old IndexedDB-backed AcademicYearRepository
 * had — find/findOrFail/all/where/count/search/create/update/save/
 * remove/restore/createMany, plus current()/makeCurrent(). Only importer:
 * settings.service.js.
 *
 * `makeCurrent(id)` is the one genuine multi-document atomic write among
 * the five Settings reference stores — exactly one academic year may be
 * current at a time. The original read the full list *outside* its
 * IndexedDB transaction, then flipped `isCurrent` on whichever rows
 * actually changed *inside* it; this Firestore version keeps that same
 * shape (read via all(), then a single writeBatch()) rather than a
 * runTransaction(), since nothing here depends on a read happening
 * inside the atomic step itself.
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'academicYears';
const academicYearsCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['label'];

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
    await recordAuditEntry('Academic year', action, id, detail);
}

class FirestoreAcademicYearRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) { return record; }

    validate(_record) { /* no-op, matching the original */ }

    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        if (!snap.exists()) return null;
        const record = { id: snap.id, ...snap.data() };
        return visible(record) ? record : null;
    }

    async findOrFail(id) {
        if (!id) throw new Error('No academic year was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Academic year ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(academicYearsCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(academicYearsCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    async search(term, { limit: max = 20 } = {}) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return [];
        return (await this.all())
            .filter((r) => (r.searchKey || '').includes(q))
            .slice(0, max);
    }

    async current() {
        const rows = await this.all();
        return rows.find((y) => y.isCurrent === 1) || rows.sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0] || null;
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

        const ref = await addDoc(academicYearsCollection, full);
        await writeAuditRow('create', ref.id, { label: full.label });
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

    /**
     * Exactly one year may be current. Read outside the batch, write inside
     * it, matching the original's own shape — a failure cannot leave the
     * school with two current years or none.
     */
    async makeCurrent(id) {
        const rows = await this.all();
        const changes = rows
            .map((year) => ({ ...year, isCurrent: year.id === id ? 1 : 0 }))
            .filter((next, i) => next.isCurrent !== rows[i].isCurrent);

        if (changes.length) {
            const at = nowISO();
            const actor = session.actorId();
            const batch = writeBatch(firestore);
            for (const next of changes) {
                batch.update(doc(firestore, COLLECTION_NAME, next.id), {
                    isCurrent: next.isCurrent,
                    updatedAt: at,
                    updatedBy: actor
                });
            }
            await batch.commit();
        }

        await writeAuditRow('update', id, { fields: ['isCurrent'] });
        return this.find(id);
    }

    async save(data) {
        if (data.id && await this.find(data.id)) return this.update(data.id, data);
        return this.create(data);
    }

    /** No hard-delete path exists in the application today. */
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
        if (!snap.exists()) throw new Error(`Academic year ${id} no longer exists.`);
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
            const ref = doc(academicYearsCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /** RESTORE USE ONLY (js/services/backup.service.js). */
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
                setBatch.set(doc(academicYearsCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const academicYears$ = new FirestoreAcademicYearRepository();
