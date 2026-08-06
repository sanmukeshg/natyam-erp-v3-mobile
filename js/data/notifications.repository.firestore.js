/**
 * NATYAM ERP 2.0 — Notifications repository (Firestore)
 *
 * Milestone 22: part of the combined Documents + Admission Drafts +
 * Notifications migration. Keeps the exact external shape the old
 * IndexedDB-backed NotificationRepository had — find/findOrFail/all/
 * where/count/create/update/save/remove/createMany, plus beforeSave()/
 * recent()/unreadCount()/markRead()/markAllRead()/prune(keep). Never
 * soft-deleted or audited, matching the original.
 *
 * Notifications are global, not per-user — there is no userId/recipientId
 * field anywhere in this schema. Marking one read or dismissing it affects
 * every signed-in user; that is existing behaviour, preserved exactly.
 *
 * `js/app.js`'s boot-time maintenance sweep calls
 * `notifications$.prune?.(200)` directly, and `js/ui/shell.js`'s bell
 * badge calls through `notifications.service.js`'s `unreadCount()` on
 * every session — both keep working unchanged since this repository keeps
 * the same method names and signatures.
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'notifications';
const notificationsCollection = collection(firestore, COLLECTION_NAME);

class FirestoreNotificationRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return { ...record, read: record.read ? 1 : 0 };
    }

    validate(_record) { /* no-op, matching the original */ }

    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    async findOrFail(id) {
        if (!id) throw new Error('No notification was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Notification ${id} no longer exists.`);
        return record;
    }

    async all() {
        const snap = await getDocs(notificationsCollection);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async where(index, value) {
        const snap = await getDocs(query(notificationsCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    async recent(limit = 30) {
        return (await this.all())
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .slice(0, limit);
    }

    async unreadCount() {
        return (await this.where('read', 0)).length;
    }

    /* --------------------------------------------------------------- WRITES */

    async create(data) {
        const record = this.beforeSave({ ...data });
        this.validate(record);
        delete record.id;

        const at = nowISO();
        const full = { ...record, createdAt: record.createdAt || at };

        const ref = await addDoc(notificationsCollection, full);
        return { id: ref.id, ...full };
    }

    async update(id, changes) {
        const existing = await this.findOrFail(id);
        const merged = this.beforeSave({ ...existing, ...changes, id });
        this.validate(merged);
        delete merged.id;

        await updateDoc(doc(firestore, COLLECTION_NAME, id), merged);
        return { ...existing, ...merged, id };
    }

    async save(data) {
        if (data.id && await this.find(data.id)) return this.update(data.id, data);
        return this.create(data);
    }

    async markRead(id) {
        const row = await this.find(id);
        if (!row || row.read) return row;
        return this.update(id, { read: 1 });
    }

    async markAllRead() {
        const unread = await this.where('read', 0);
        if (!unread.length) return 0;

        for (let i = 0; i < unread.length; i += 450) {
            const chunk = unread.slice(i, i + 450);
            const batch = writeBatch(firestore);
            for (const row of chunk) batch.update(doc(firestore, COLLECTION_NAME, row.id), { read: 1 });
            await batch.commit();
        }
        return unread.length;
    }

    /** Always a hard delete — softDelete:false, matching the original. */
    async remove(id) {
        await deleteDoc(doc(firestore, COLLECTION_NAME, id));
        return true;
    }

    async restore() {
        throw new Error('Notifications are never soft-deleted, so there is nothing to restore.');
    }

    async createMany(items) {
        const batch = writeBatch(firestore);
        const at = nowISO();
        const records = [];

        for (const item of items) {
            const record = this.beforeSave({ ...item });
            this.validate(record);
            delete record.id;

            const full = { ...record, createdAt: record.createdAt || at };
            const ref = doc(notificationsCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        return records;
    }

    /** Keeps the store from growing without bound. Called at boot (js/app.js). */
    async prune(keep = 200) {
        const rows = (await this.all()).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        const excess = rows.slice(keep);
        if (!excess.length) return 0;

        for (let i = 0; i < excess.length; i += 450) {
            const chunk = excess.slice(i, i + 450);
            const delBatch = writeBatch(firestore);
            for (const row of chunk) delBatch.delete(doc(firestore, COLLECTION_NAME, row.id));
            await delBatch.commit();
        }

        return excess.length;
    }

    /** RESTORE USE ONLY (js/services/backup.service.js). */
    async replaceAll(records) {
        const existingSnap = await getDocs(notificationsCollection);
        for (let i = 0; i < existingSnap.docs.length; i += 450) {
            const chunk = existingSnap.docs.slice(i, i + 450);
            const delBatch = writeBatch(firestore);
            for (const d of chunk) delBatch.delete(d.ref);
            await delBatch.commit();
        }

        for (let i = 0; i < records.length; i += 450) {
            const chunk = records.slice(i, i + 450);
            const setBatch = writeBatch(firestore);
            for (const record of chunk) {
                const { id, ...data } = record;
                setBatch.set(doc(notificationsCollection, id), data);
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const notifications$ = new FirestoreNotificationRepository();
