/**
 * NATYAM ERP 2.0 — Curricula repository (Firestore)
 *
 * Milestone 23: part of the Settings reference data migration. Keeps the
 * exact external shape the old IndexedDB-backed CurriculumRepository had —
 * find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus active()/ordered(). Only importer:
 * curriculum.service.js (full CRUD), plus a read-only lookup from
 * students.service.js. `structure` (the whole Level→Stage→Lesson tree) is
 * a single nested object field — Firestore-friendly as-is, no relational
 * decomposition needed.
 *
 * `curricula.code` uniqueness was previously enforced only by IndexedDB's
 * native unique index, with no application-level check anywhere —
 * Firestore has no equivalent, so create()/update() now check for a
 * clashing code explicitly, the same fix Batches got in Milestone 19 and
 * Branches gets in this same milestone.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. `code` (e.g. KUCHI-FND) remains the
 * curriculum's human-facing identifier exactly as before.
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { CURRICULUM_STATUS } from '../config/app.config.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'curricula';
const curriculaCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'code'];

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
    await recordAuditEntry('Curriculum', action, id, detail);
}

class FirestoreCurriculumRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return {
            ...record,
            code: String(record.code || '').trim().toUpperCase(),
            name: String(record.name || '').trim(),
            status: record.status || CURRICULUM_STATUS.ACTIVE,
            sortOrder: Number(record.sortOrder) || 0,
            structure: record.structure && typeof record.structure === 'object'
                ? { levels: Array.isArray(record.structure.levels) ? record.structure.levels : [] }
                : { levels: [] }
        };
    }

    validate(record) {
        if (!record.name) throw new Error('A curriculum needs a name.');
        if (!record.code) throw new Error('A curriculum needs a short code, e.g. KUCHI-FND.');
    }

    /**
     * Firestore has no equivalent to IndexedDB's unique index — this is the
     * application-level replacement for the constraint `SCHEMA.curricula`
     * used to enforce. `excludeId` lets update() check without tripping
     * over the record's own current code.
     */
    async _assertCodeAvailable(code, excludeId = null) {
        const clashes = await this.where('code', code);
        if (clashes.some((c) => c.id !== excludeId)) {
            throw new Error(`A curriculum with the code ${code} already exists.`);
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
        if (!id) throw new Error('No curriculum was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Curriculum ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(curriculaCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(curriculaCollection, where(index, '==', value)));
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

    async active() {
        return (await this.all())
            .filter((c) => c.status === CURRICULUM_STATUS.ACTIVE)
            .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
    }

    async ordered() {
        return (await this.all())
            .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
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

        const ref = await addDoc(curriculaCollection, full);
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
        if (!snap.exists()) throw new Error(`Curriculum ${id} no longer exists.`);
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
            const ref = doc(curriculaCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Bypasses the
     * code-uniqueness check by design, matching Batches' precedent.
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
                setBatch.set(doc(curriculaCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const curricula$ = new FirestoreCurriculumRepository();
