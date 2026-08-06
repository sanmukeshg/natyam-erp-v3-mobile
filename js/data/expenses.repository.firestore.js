/**
 * NATYAM ERP 2.0 — Expenses repository (Firestore)
 *
 * Milestone 21: part of the combined Fee Collection + Finance migration.
 * Keeps the exact external shape the old IndexedDB-backed ExpenseRepository
 * had — find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus forPeriod()/between() and the static
 * ExpenseMath.byCategory(). The cross-collection posting transactions
 * (recording/editing/removing an expense alongside its ledger entry) live
 * in js/data/ledger.repository.firestore.js — this repository's own
 * create()/update() remain for interface parity and any future
 * single-collection write; finance.service.js's actual recordExpense()/
 * updateExpense()/removeExpense() call the ledger module's transaction
 * functions instead.
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO, localDate, monthKey } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'expenses';
const expensesCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['description', 'category', 'paidTo'];

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
    await recordAuditEntry('Expense', action, id, detail);
}

class FirestoreExpenseRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return {
            ...record,
            date: record.date || localDate(),
            period: record.period || monthKey(record.date || localDate()),
            amount: Math.round(Number(record.amount) || 0),
            status: record.status || 'paid'
        };
    }

    validate(record) {
        if (!record.category) throw new Error('Choose an expense category.');
        if (!record.description?.trim()) throw new Error('Describe what this expense was for.');
        if (record.amount <= 0) throw new Error('The amount must be more than zero.');
        if (!record.branchId) throw new Error('An expense belongs to a branch.');
        if (record.date > localDate()) throw new Error('An expense cannot be dated in the future.');
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
        if (!id) throw new Error('No expense was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Expense ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(expensesCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(expensesCollection, where(index, '==', value)));
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

    async forPeriod(period, branchId = null) {
        const rows = await this.where('period', period);
        return branchId ? rows.filter((e) => e.branchId === branchId) : rows;
    }

    /** Inclusive date-range query — mirrors the shape of every other module's between(). */
    async between(from, to, branchId = null) {
        const snap = await getDocs(query(expensesCollection,
            where('date', '>=', from), where('date', '<=', to)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
        return branchId ? rows.filter((e) => e.branchId === branchId) : rows;
    }

    static byCategory(expenses) {
        const tally = new Map();
        for (const e of expenses) {
            const row = tally.get(e.category) || { amount: 0, count: 0 };
            row.amount += e.amount;
            row.count += 1;
            tally.set(e.category, row);
        }
        return [...tally.entries()]
            .map(([category, row]) => ({ category, amount: row.amount, count: row.count }))
            .sort((a, b) => b.amount - a.amount);
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
            createdAt: record.createdAt || at, createdBy: record.createdBy || actor,
            updatedAt: at, updatedBy: actor,
            deletedAt: null,
            searchKey: searchKeyOf(record)
        };

        const ref = await addDoc(expensesCollection, full);
        await writeAuditRow('create', ref.id, { amount: full.amount, category: full.category });
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

    /** Soft delete by default — removeExpense() marks an expense deleted, it never hard-removes one. */
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
        if (!snap.exists()) throw new Error(`Expense ${id} no longer exists.`);
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
                createdAt: record.createdAt || at, createdBy: record.createdBy || actor,
                updatedAt: at, updatedBy: actor,
                deletedAt: null,
                searchKey: searchKeyOf(record)
            };
            const ref = doc(expensesCollection);
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
                setBatch.set(doc(expensesCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const expenses$ = new FirestoreExpenseRepository();
export const ExpenseMath = FirestoreExpenseRepository;
