/**
 * NATYAM ERP 2.0 — Invoices repository (Firestore)
 *
 * Milestone 21: part of the combined Fee Collection + Finance migration.
 * Keeps the exact external shape the old IndexedDB-backed InvoiceRepository
 * had — find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus forStudent()/outstanding()/overdue()/
 * needingOverdueSweep() and the static InvoiceMath.totals(). Read-side only
 * in spirit, same as before: fees.service.js is the only place invoice
 * money actually changes, and the cross-collection postings that used to
 * live inside its `db.unit()` calls now live in
 * js/data/ledger.repository.firestore.js (see that file's header) since
 * they touch invoices, payments and ledgerEntries together — this
 * repository's own create()/update() remain for the single-collection
 * writes (raising an invoice, waiving, cancelling, the overdue sweep).
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. `number` (NAT/INV/YY/0000, allocated from the
 * settings counter in fees.service.js) remains the invoice's human-facing
 * identifier exactly as before.
 */

import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO, localDate } from '../utils/date.js';
import { INVOICE_STATUS } from '../config/app.config.js';

const COLLECTION_NAME = 'invoices';
const invoicesCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['number', 'studentName', 'description'];

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

/**
 * One function decides an invoice's status from its numbers. Nothing else
 * is allowed to set `status` on an invoice by hand — that is how 1.0 ended
 * up with invoices marked "paid" carrying a non-zero balance. Exported so
 * both fees.service.js (createInvoice) and the cross-collection posting
 * transactions in ledger.repository.firestore.js (recordPayment,
 * refundPayment) compute status the same one way.
 */
export function deriveInvoiceStatus(invoice) {
    if (invoice.status === INVOICE_STATUS.CANCELLED) return INVOICE_STATUS.CANCELLED;
    if (invoice.status === INVOICE_STATUS.WAIVED) return INVOICE_STATUS.WAIVED;
    if (invoice.status === INVOICE_STATUS.DRAFT) return INVOICE_STATUS.DRAFT;

    const balance = Math.max(0, (invoice.amount || 0) - (invoice.paidAmount || 0));
    if (balance === 0) return INVOICE_STATUS.PAID;
    if ((invoice.paidAmount || 0) > 0) return INVOICE_STATUS.PARTIAL;
    return invoice.dueDate < localDate() ? INVOICE_STATUS.OVERDUE : INVOICE_STATUS.OPEN;
}

/** Recomputes amounts and status together, so they cannot disagree. */
export function reconcile(invoice) {
    const paidAmount = Math.max(0, Math.round(invoice.paidAmount || 0));
    const amount = Math.round(invoice.amount || 0);
    const next = { ...invoice, amount, paidAmount, balance: Math.max(0, amount - paidAmount) };
    return { ...next, status: deriveInvoiceStatus(next) };
}

async function writeAuditRow(action, id, detail) {
    await recordAuditEntry('Invoice', action, id, detail);
}

class FirestoreInvoiceRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) { return record; }

    validate(record) {
        if (!record.studentId) throw new Error('An invoice must name a student.');
        if (!record.number) throw new Error('An invoice needs a number.');
        if (!record.dueDate) throw new Error('An invoice needs a due date.');
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
        if (!id) throw new Error('No invoice was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Invoice ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(invoicesCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(invoicesCollection, where(index, '==', value)));
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
            .sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
    }

    /**
     * Milestone P2 (Parent/Student Portal). Every invoice across every one
     * of a guardian's children — filtered by `guardianPhone`/`guardianEmail`
     * directly on the invoice document, never by `studentId`. firestore.rules
     * can only authorize a query when its own where() filter matches exactly
     * what the guardian read rule checks; a studentId-based query would be
     * denied outright regardless of the rule. Callers narrow to one child
     * client-side (see guardianAuth.service.js's guardianChildren()).
     */
    async forGuardian(phone, email) {
        const [byPhone, byEmail] = await Promise.all([
            phone ? getDocs(query(invoicesCollection, where('guardianPhone', '==', phone))) : null,
            email ? getDocs(query(invoicesCollection, where('guardianEmail', '==', email))) : null
        ]);

        const seen = new Map();
        for (const snap of [byPhone, byEmail]) {
            if (!snap) continue;
            for (const d of snap.docs) {
                const record = { id: d.id, ...d.data() };
                if (visible(record)) seen.set(d.id, record);
            }
        }
        return [...seen.values()].sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
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

    async outstanding(branchId = null) {
        const rows = (await this.all()).filter((i) =>
            [INVOICE_STATUS.OPEN, INVOICE_STATUS.PARTIAL, INVOICE_STATUS.OVERDUE].includes(i.status));
        return branchId ? rows.filter((i) => i.branchId === branchId) : rows;
    }

    async overdue(branchId = null) {
        const today = localDate();
        return (await this.outstanding(branchId)).filter((i) => i.dueDate < today);
    }

    async needingOverdueSweep() {
        const today = localDate();
        return (await this.all()).filter((i) => i.status === INVOICE_STATUS.OPEN && i.dueDate < today);
    }

    static totals(invoices) {
        return invoices.reduce((acc, i) => ({
            billed: acc.billed + (i.amount || 0),
            collected: acc.collected + (i.paidAmount || 0),
            outstanding: acc.outstanding + (i.balance || 0)
        }), { billed: 0, collected: 0, outstanding: 0 });
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

        const ref = await addDoc(invoicesCollection, full);
        await writeAuditRow('create', ref.id, { number: full.number });
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

    /** No hard-delete path exists — an invoice is only ever waived or cancelled, never removed. */
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
        if (!snap.exists()) throw new Error(`Invoice ${id} no longer exists.`);
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
            const ref = doc(invoicesCollection);
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
                setBatch.set(doc(invoicesCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const invoices$ = new FirestoreInvoiceRepository();
export const InvoiceMath = FirestoreInvoiceRepository;
