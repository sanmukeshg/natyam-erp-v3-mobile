/**
 * NATYAM ERP 2.0 — Fee plans repository (Firestore)
 *
 * Milestone 21: part of the combined Fee Collection + Finance migration —
 * the ninth through fourteenth stores migrated off IndexedDB. Keeps the
 * exact external shape the old IndexedDB-backed FeePlanRepository had —
 * find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus the plan-specific active()/forLevel()/
 * usageCount() — so every existing caller (settings.service.js,
 * fees.service.js, admissions.service.js) needed no changes beyond what
 * this migration itself required.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. A fee plan was never addressed by a
 * human-facing code in the IndexedDB model either — people reference it by
 * name and level — so nothing new is introduced here.
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { DEFAULT_FEE_FREQUENCY, feeFrequency } from '../config/app.config.js';
import { students$ } from './students.repository.firestore.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'feePlans';
const feePlansCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'level'];

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
    await recordAuditEntry('Fee plan', action, id, detail);
}

class FirestoreFeePlanRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        const frequency = record.frequency || DEFAULT_FEE_FREQUENCY;
        const legacyMonthly = record.annualAmount != null
            ? Math.round(Number(record.annualAmount) / 12)
            : 0;
        return {
            ...record,
            status: record.status || 'active',
            frequency,
            amount: Math.round(Number(record.amount ?? legacyMonthly) || 0),
            registrationFee: Math.round(Number(record.registrationFee) || 0),
            costumeFee: Math.round(Number(record.costumeFee) || 0)
        };
    }

    validate(record) {
        if (!record.name?.trim()) throw new Error('A fee plan needs a name.');
        if (record.amount <= 0) throw new Error('The monthly fee must be more than zero.');
        if (!feeFrequency(record.frequency)) throw new Error('That fee frequency is not recognised.');
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
        if (!id) throw new Error('No fee plan was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Fee plan ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(feePlansCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(feePlansCollection, where(index, '==', value)));
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
        return (await this.all()).filter((p) => p.status === 'active');
    }

    async forLevel(level) {
        return (await this.active()).find((p) => p.level === level) || null;
    }

    /** Plans in use, so the UI can warn before archiving one. No feePlanId index on students, so scan rather than index-lookup. */
    async usageCount(planId) {
        return (await students$.all()).filter((s) => s.feePlanId === planId).length;
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

        const ref = await addDoc(feePlansCollection, full);
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

    /**
     * Hard delete by default — unlike every other store migrated so far,
     * deleteFeePlan() in settings.service.js has always removed a fee plan
     * outright (checked for usage first), never soft-deleted one.
     */
    async remove(id, { hard = true } = {}) {
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
        if (!snap.exists()) throw new Error(`Fee plan ${id} no longer exists.`);
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
            const ref = doc(feePlansCollection);
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
                setBatch.set(doc(feePlansCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const feePlans$ = new FirestoreFeePlanRepository();
