/**
 * NATYAM ERP 2.0 — Ledger repository (Firestore)
 *
 * Milestone 21: part of the combined Fee Collection + Finance migration.
 * `ledger$` keeps the exact external shape the old IndexedDB-backed
 * LedgerRepository had — find/findOrFail/all/where/count/search/create/
 * update/save/remove/restore/createMany, plus forPeriod()/between()/
 * bySource() and the static LedgerMath.summarise()/byAccount(). Unlike
 * every other store migrated so far, Ledger entries are never soft-deleted
 * (`softDelete: false`, matching the original).
 *
 * This file also owns the cross-collection atomic postings that used to be
 * IndexedDB `db.unit()` calls in fees.service.js/finance.service.js —
 * `postPayment`/`postRefund` (invoices+payments+ledgerEntries) and
 * `postExpenseCreate`/`postExpenseUpdate`/`postExpenseRemove`/`postPayroll`
 * (expenses/salaries+ledgerEntries). They live here, not in the services,
 * because `js/core/firebase.js` reserves direct Firestore SDK access to
 * "Firestore Repositories" — the services still own every validation
 * decision and hand this file fully-formed data; what lives here is the
 * mechanics of writing it atomically, plus the one re-check each operation
 * needs against the freshest possible read (an invoice's live balance
 * can't be trusted from a read taken before the transaction started,
 * exactly why `classSessions$.postpone()` already re-reads a session's
 * status inside its own transaction rather than trusting the caller).
 *
 * `postPayment`/`postRefund` use `runTransaction()` because they read-then-
 * write an existing invoice whose balance could change between two
 * concurrent payments. The four Finance-side postings only ever create new
 * documents or touch documents nothing else could be concurrently
 * modifying the same way, so they use the simpler `writeBatch()` (atomic,
 * no read-before-write ordering to satisfy) — this matches today's actual
 * behaviour exactly, since the existing IndexedDB `db.unit()` calls for
 * expenses/payroll don't re-validate against a fresh read either.
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch, runTransaction
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO, monthKey } from '../utils/date.js';
import { INVOICE_STATUS, PAYMENT_STATUS } from '../config/app.config.js';
import { reconcile } from './invoices.repository.firestore.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'ledgerEntries';
const ledgerCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['narration', 'account'];

/** Ledger never soft-deletes — every row is visible, matching softDelete:false on the original. */
function searchKeyOf(record) {
    return SEARCH_FIELDS
        .map((f) => record[f])
        .filter((v) => v !== null && v !== undefined && v !== '')
        .join(' ')
        .toLowerCase();
}

async function writeAuditRow(action, id, detail) {
    await recordAuditEntry('Ledger entry', action, id, detail);
}

class FirestoreLedgerRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return { ...record, period: record.period || monthKey(record.date), amount: Math.round(Number(record.amount) || 0) };
    }

    validate(record) {
        if (!record.date) throw new Error('A ledger entry needs a date.');
        if (!record.account) throw new Error('A ledger entry needs an account.');
        if (!['income', 'expense'].includes(record.type)) throw new Error('A ledger entry is either income or expense.');
        if (record.amount <= 0) throw new Error('A ledger entry must be more than zero.');
    }

    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    async findOrFail(id) {
        if (!id) throw new Error('No ledger entry was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Ledger entry ${id} no longer exists.`);
        return record;
    }

    async all() {
        const snap = await getDocs(ledgerCollection);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async where(index, value) {
        const snap = await getDocs(query(ledgerCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
        const snap = await getDocs(query(ledgerCollection,
            where('date', '>=', from), where('date', '<=', to)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return branchId ? rows.filter((e) => e.branchId === branchId) : rows;
    }

    async bySource(sourceId) {
        return this.where('sourceId', sourceId);
    }

    static summarise(entries) {
        const income = entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
        const expense = entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
        return { income, expense, net: income - expense };
    }

    static byAccount(entries, type) {
        const tally = new Map();
        for (const e of entries.filter((x) => x.type === type)) {
            tally.set(e.account, (tally.get(e.account) || 0) + e.amount);
        }
        return [...tally.entries()]
            .map(([account, amount]) => ({ account, amount }))
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
            createdAt: at, createdBy: actor,
            updatedAt: at, updatedBy: actor,
            searchKey: searchKeyOf(record)
        };

        const ref = await addDoc(ledgerCollection, full);
        await writeAuditRow('create', ref.id, { account: full.account, amount: full.amount });
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

    async remove(id) {
        await deleteDoc(doc(firestore, COLLECTION_NAME, id));
        await writeAuditRow('delete', id, { hard: true });
        return true;
    }

    async restore() {
        throw new Error('Ledger entries are never soft-deleted, so there is nothing to restore.');
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
                searchKey: searchKeyOf(record)
            };
            const ref = doc(ledgerCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /** RESTORE USE ONLY (js/services/backup.service.js). */
    async replaceAll(records) {
        const existing = await this.all();

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
                setBatch.set(doc(ledgerCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const ledger$ = new FirestoreLedgerRepository();
export const LedgerMath = FirestoreLedgerRepository;

/* ==========================================================================
   CROSS-COLLECTION POSTINGS
   ========================================================================== */

/**
 * Records a payment against an invoice: the invoice's balance/status, the
 * payment row, and a ledger income entry all land together or none does.
 * Re-verifies the invoice's live status and balance with a fresh read
 * inside the transaction — the caller's own earlier read (used for its
 * user-facing validation) could be stale by the time this runs.
 */
export async function postPayment({ invoiceId, amount, mode, reference, note, paidOn, receiptNo, actor, actorName }) {
    const invoiceRef = doc(firestore, 'invoices', invoiceId);
    const paymentRef = doc(collection(firestore, 'payments'));
    const ledgerRef = doc(collection(firestore, 'ledgerEntries'));
    const at = nowISO();
    let result;

    await runTransaction(firestore, async (tx) => {
        const snap = await tx.get(invoiceRef);
        if (!snap.exists()) throw new Error('This invoice no longer exists.');
        const invoice = { id: snap.id, ...snap.data() };

        if (invoice.status === INVOICE_STATUS.CANCELLED) throw new Error('This invoice was cancelled. Raise a new one.');
        if (invoice.status === INVOICE_STATUS.WAIVED) throw new Error('This invoice was waived, so there is nothing to collect.');
        if (invoice.balance <= 0) throw new Error(`Invoice ${invoice.number} is already settled.`);
        if (amount > invoice.balance) {
            throw new Error(`That is more than the ₹${(invoice.balance / 100).toFixed(2)} outstanding on this invoice. Split it across invoices instead.`);
        }

        const nextInvoice = reconcile({
            ...invoice,
            paidAmount: (invoice.paidAmount || 0) + amount,
            updatedAt: at,
            updatedBy: actor
        });

        const payment = {
            receiptNo,
            invoiceId,
            invoiceNumber: invoice.number,
            studentId: invoice.studentId,
            studentName: invoice.studentName,
            // Milestone P2 (Parent/Student Portal): copied straight from the
            // invoice already read in this transaction, not a fresh student
            // lookup — a payment always has a parent invoice, and by the
            // time an invoice exists it already carries these two fields
            // (see fees.service.js#createInvoice()). Zero extra reads.
            guardianPhone: invoice.guardianPhone || null,
            guardianEmail: invoice.guardianEmail || null,
            branchId: invoice.branchId,
            amount, mode,
            reference: reference || null,
            note: note || null,
            paidOn,
            status: PAYMENT_STATUS.CLEARED,
            collectedBy: actor,
            collectedByName: actorName,
            createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor, deletedAt: null
        };

        const ledgerEntry = {
            branchId: invoice.branchId,
            date: paidOn,
            period: monthKey(paidOn),
            account: 'Tuition fees',
            type: 'income',
            amount,
            narration: `${invoice.studentName} — receipt ${receiptNo}`,
            sourceType: 'payment',
            sourceId: paymentRef.id,
            createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor
        };

        const { id, ...invoiceData } = nextInvoice;
        void id;
        tx.update(invoiceRef, invoiceData);
        tx.set(paymentRef, payment);
        tx.set(ledgerRef, ledgerEntry);

        result = {
            payment: { id: paymentRef.id, ...payment },
            invoice: nextInvoice,
            ledgerEntry: { id: ledgerRef.id, ...ledgerEntry }
        };
    });

    await writeAuditRow('create', result.payment.id, { receiptNo, amount, invoice: result.invoice.number });
    return result;
}

/**
 * Refunds a payment: the payment is marked refunded (never deleted), the
 * invoice's balance/status are restored if it still exists, and a contra
 * ledger entry is posted — all three together.
 */
export async function postRefund({ paymentId, reason, refundedOn, actor }) {
    const paymentRef = doc(firestore, 'payments', paymentId);
    const ledgerRef = doc(collection(firestore, 'ledgerEntries'));
    const at = nowISO();
    let result;

    await runTransaction(firestore, async (tx) => {
        const paymentSnap = await tx.get(paymentRef);
        if (!paymentSnap.exists()) throw new Error('This payment no longer exists.');
        const payment = { id: paymentSnap.id, ...paymentSnap.data() };
        if (payment.status === PAYMENT_STATUS.REFUNDED) throw new Error('This payment has already been refunded.');

        let invoiceRef = null;
        let invoice = null;
        if (payment.invoiceId) {
            invoiceRef = doc(firestore, 'invoices', payment.invoiceId);
            const invoiceSnap = await tx.get(invoiceRef);
            if (invoiceSnap.exists()) invoice = { id: invoiceSnap.id, ...invoiceSnap.data() };
        }

        const nextPayment = {
            ...payment,
            status: PAYMENT_STATUS.REFUNDED,
            refundedOn,
            refundReason: reason,
            refundedBy: actor,
            updatedAt: at,
            updatedBy: actor
        };

        const nextInvoice = invoice ? reconcile({
            ...invoice,
            paidAmount: Math.max(0, (invoice.paidAmount || 0) - payment.amount),
            updatedAt: at,
            updatedBy: actor
        }) : null;

        const contra = {
            branchId: payment.branchId,
            date: refundedOn,
            period: monthKey(refundedOn),
            account: 'Tuition fees',
            type: 'expense',
            amount: payment.amount,
            narration: `Refund of receipt ${payment.receiptNo} — ${reason}`,
            sourceType: 'refund',
            sourceId: payment.id,
            createdAt: at, createdBy: actor, updatedAt: at, updatedBy: actor
        };

        const { id: pid, ...paymentData } = nextPayment;
        void pid;
        tx.update(paymentRef, paymentData);
        if (invoiceRef && nextInvoice) {
            const { id: iid, ...invoiceData } = nextInvoice;
            void iid;
            tx.update(invoiceRef, invoiceData);
        }
        tx.set(ledgerRef, contra);

        result = { payment: nextPayment, invoice: nextInvoice, ledgerEntry: { id: ledgerRef.id, ...contra } };
    });

    await writeAuditRow('refund', result.payment.id, { reason, amount: result.payment.amount });
    return result;
}

/** Creates an expense and its ledger entry together — no existing document is read, so a plain atomic batch suffices. */
export async function postExpenseCreate({ expenseFields, ledgerFields }) {
    const expenseRef = doc(collection(firestore, 'expenses'));
    const ledgerRef = doc(collection(firestore, 'ledgerEntries'));

    const entry = { ...ledgerFields, sourceId: expenseRef.id };
    const batch = writeBatch(firestore);
    batch.set(expenseRef, expenseFields);
    batch.set(ledgerRef, entry);
    await batch.commit();

    await writeAuditRow('create', expenseRef.id, { amount: expenseFields.amount, category: expenseFields.category });
    return { expense: { id: expenseRef.id, ...expenseFields }, ledgerEntry: { id: ledgerRef.id, ...entry } };
}

/** Edits an expense and its linked ledger entry (if one exists) together. */
export async function postExpenseUpdate({ expenseId, expenseFields, ledgerEntryId, ledgerFields }) {
    const batch = writeBatch(firestore);
    batch.update(doc(firestore, 'expenses', expenseId), expenseFields);
    if (ledgerEntryId && ledgerFields) {
        batch.update(doc(firestore, 'ledgerEntries', ledgerEntryId), ledgerFields);
    }
    await batch.commit();
    await writeAuditRow('update', expenseId, { amount: expenseFields.amount });
}

/** Soft-deletes an expense and hard-deletes its linked ledger entry (if one exists) together. */
export async function postExpenseRemove({ expenseId, expenseFields, ledgerEntryId }) {
    const batch = writeBatch(firestore);
    batch.update(doc(firestore, 'expenses', expenseId), expenseFields);
    if (ledgerEntryId) batch.delete(doc(firestore, 'ledgerEntries', ledgerEntryId));
    await batch.commit();
    await writeAuditRow('archive', expenseId, { reason: expenseFields.deleteReason });
}

/**
 * Disburses salary lines: every line's status update and its ledger entry
 * go in one atomic batch, so a partial payroll run can't exist in the
 * books. Safe at this school's scale — a batch write caps at 500
 * operations, and this writes two per staff member being paid.
 */
export async function postPayroll({ lines, entries }) {
    const batch = writeBatch(firestore);
    const createdEntries = [];

    for (const line of lines) {
        batch.update(doc(firestore, 'salaries', line.id), line.changes);
    }
    for (const entryFields of entries) {
        const ref = doc(collection(firestore, 'ledgerEntries'));
        batch.set(ref, entryFields);
        createdEntries.push({ id: ref.id, ...entryFields });
    }

    await batch.commit();
    await writeAuditRow('pay', null, {
        period: entries[0]?.period, count: lines.length,
        total: entries.reduce((sum, e) => sum + e.amount, 0)
    });
    return createdEntries;
}
