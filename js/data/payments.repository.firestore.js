/**
 * NATYAM ERP 2.0 — Payments repository (Firestore)
 *
 * Milestone 21: part of the combined Fee Collection + Finance migration.
 * Keeps the exact external shape the old IndexedDB-backed PaymentRepository
 * had — find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus forStudent()/forInvoice()/onDate()/between()/
 * byReceipt() and the static PaymentMath.collected()/byMode(). As with
 * Invoices, the cross-collection posting transactions (recording a payment
 * alongside its invoice update and ledger entry, and refunding one) live in
 * js/data/ledger.repository.firestore.js — this repository's own
 * create()/update() exist for interface parity and for any future
 * single-collection write, but fees.service.js's actual recordPayment()/
 * refundPayment() call the ledger module's transaction functions instead.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. `receiptNo` (NAT/RCP/YY/0000, allocated from
 * the settings counter in fees.service.js) remains the payment's
 * human-facing identifier exactly as before.
 */

import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { PAYMENT_STATUS } from '../config/app.config.js';

const COLLECTION_NAME = 'payments';
const paymentsCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['receiptNo', 'studentName', 'reference', 'mode'];

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
    await recordAuditEntry('Payment', action, id, detail);
}

class FirestorePaymentRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) { return record; }

    validate(record) {
        if (!record.studentId) throw new Error('A payment must name a student.');
        if (!record.receiptNo) throw new Error('A payment needs a receipt number.');
        if (!record.amount || record.amount <= 0) throw new Error('A payment must be more than zero.');
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
        if (!id) throw new Error('No payment was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Payment ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(paymentsCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(paymentsCollection, where(index, '==', value)));
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

    async forStudent(studentId) {
        return (await this.where('studentId', studentId))
            .sort((a, b) => (b.paidOn || '').localeCompare(a.paidOn || ''));
    }

    /**
     * Milestone P2 (Parent/Student Portal). Every payment across every one
     * of a guardian's children — filtered by `guardianPhone`/`guardianEmail`
     * directly on the payment document, never by `studentId`. firestore.rules
     * can only authorize a query when its own where() filter matches exactly
     * what the guardian read rule checks; a studentId-based query would be
     * denied outright regardless of the rule. Callers narrow to one child
     * client-side (see guardianAuth.service.js's guardianChildren()).
     */
    async forGuardian(phone, email) {
        const [byPhone, byEmail] = await Promise.all([
            phone ? getDocs(query(paymentsCollection, where('guardianPhone', '==', phone))) : null,
            email ? getDocs(query(paymentsCollection, where('guardianEmail', '==', email))) : null
        ]);

        const seen = new Map();
        for (const snap of [byPhone, byEmail]) {
            if (!snap) continue;
            for (const d of snap.docs) {
                const record = { id: d.id, ...d.data() };
                if (visible(record)) seen.set(d.id, record);
            }
        }
        return [...seen.values()].sort((a, b) => (b.paidOn || '').localeCompare(a.paidOn || ''));
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

    async forInvoice(invoiceId) {
        return (await this.where('invoiceId', invoiceId))
            .sort((a, b) => (a.paidOn || '').localeCompare(b.paidOn || ''));
    }

    async onDate(date, branchId = null) {
        const rows = await this.where('paidOn', date);
        return branchId ? rows.filter((p) => p.branchId === branchId) : rows;
    }

    /** Inclusive date-range query — mirrors the shape of every other module's between(). */
    async between(from, to, branchId = null) {
        const snap = await getDocs(query(paymentsCollection,
            where('paidOn', '>=', from), where('paidOn', '<=', to)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
        return branchId ? rows.filter((p) => p.branchId === branchId) : rows;
    }

    async byReceipt(receiptNo) {
        return (await this.where('receiptNo', receiptNo))[0] || null;
    }

    static collected(payments) {
        return payments
            .filter((p) => p.status === PAYMENT_STATUS.CLEARED)
            .reduce((sum, p) => sum + (p.amount || 0), 0);
    }

    static byMode(payments) {
        const tally = new Map();
        for (const p of payments.filter((x) => x.status === PAYMENT_STATUS.CLEARED)) {
            tally.set(p.mode, (tally.get(p.mode) || 0) + p.amount);
        }
        return [...tally.entries()].map(([mode, amount]) => ({ mode, amount }))
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

        const ref = await addDoc(paymentsCollection, full);
        await writeAuditRow('create', ref.id, { receiptNo: full.receiptNo });
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

    /** No hard-delete path exists — a payment is only ever refunded, never removed. */
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
        if (!snap.exists()) throw new Error(`Payment ${id} no longer exists.`);
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
            const ref = doc(paymentsCollection);
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
                setBatch.set(doc(paymentsCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const payments$ = new FirestorePaymentRepository();
export const PaymentMath = FirestorePaymentRepository;
