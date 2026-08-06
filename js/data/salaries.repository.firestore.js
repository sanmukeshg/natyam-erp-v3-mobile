/**
 * NATYAM ERP 2.0 — Salaries repository (Firestore)
 *
 * Milestone 21: part of the combined Fee Collection + Finance migration.
 * Keeps the exact external shape the old IndexedDB-backed SalaryRepository
 * had — find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus forPeriod()/forStaff(). The cross-collection
 * posting transaction (disbursing salary lines alongside their ledger
 * entries in paySalaries()) lives in js/data/ledger.repository.firestore.js
 * — this repository's own create()/update() remain for interface parity
 * and are what preparePayroll()/adjustSalary() (both single-collection)
 * still call directly.
 *
 * Fixes a real, pre-existing bug found during this migration's review:
 * the old beforeSave() computed `net: gross - deductions`, silently
 * dropping `allowances`. finance.service.js's adjustSalary() has always
 * correctly computed `net: gross + allowances - deductions` and passed it
 * in, but the old beforeSave() recomputed and overwrote it — so any salary
 * adjustment involving allowances persisted an understated net pay. Fixed
 * here; the archived IndexedDB snapshot keeps the original formula
 * unchanged, per the archive convention (it's a frozen snapshot, not a
 * maintained implementation).
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'salaries';
const salariesCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['staffName', 'period'];

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
    await recordAuditEntry('Salary', action, id, detail);
}

class FirestoreSalaryRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        const gross = Math.round(Number(record.gross) || 0);
        const deductions = Math.round(Number(record.deductions) || 0);
        const allowances = Math.round(Number(record.allowances) || 0);
        return { ...record, gross, deductions, allowances, net: gross + allowances - deductions, status: record.status || 'pending' };
    }

    validate(record) {
        if (!record.staffId) throw new Error('A salary line needs a staff member.');
        if (!/^\d{4}-\d{2}$/.test(record.period || '')) throw new Error('The pay period must be a month, e.g. 2026-07.');
        if (record.gross <= 0) throw new Error('Gross pay must be more than zero.');
        if (record.deductions > record.gross + record.allowances) throw new Error('Deductions cannot exceed the total pay.');
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
        if (!id) throw new Error('No salary was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Salary ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(salariesCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(salariesCollection, where(index, '==', value)));
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

    async forPeriod(period) { return this.where('period', period); }

    async forStaff(staffId) {
        return (await this.where('staffId', staffId)).sort((a, b) => b.period.localeCompare(a.period));
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

        const ref = await addDoc(salariesCollection, full);
        await writeAuditRow('create', ref.id, { staffId: full.staffId, period: full.period });
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
        if (!snap.exists()) throw new Error(`Salary ${id} no longer exists.`);
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
            const ref = doc(salariesCollection);
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
                setBatch.set(doc(salariesCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const salaries$ = new FirestoreSalaryRepository();
