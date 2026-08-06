/**
 * NATYAM ERP 2.0 — Admission drafts repository (Firestore)
 *
 * Milestone 22: part of the combined Documents + Admission Drafts +
 * Notifications migration. Keeps the exact external shape the old
 * IndexedDB-backed AdmissionDraftRepository had — find/findOrFail/all/
 * where/count/search/create/update/save/remove/restore/createMany, plus
 * mine()/prune(days). Never soft-deleted or audited — a half-typed form
 * isn't a record worth keeping a tombstone or an audit trail for, the
 * same reasoning the original repository's own comment gave.
 *
 * `js/app.js`'s boot-time maintenance sweep calls `drafts$.prune?.(30)`
 * directly (not through a service) — this repository's prune() keeps the
 * same signature and behaviour (delete drafts not updated in `days` days).
 */

import {
    collection, doc, addDoc, setDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'admissionDrafts';
const draftsCollection = collection(firestore, COLLECTION_NAME);

class FirestoreAdmissionDraftRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) { return record; }

    validate(_record) { /* no-op, matching the original — a draft is never rejected */ }

    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    async findOrFail(id) {
        if (!id) throw new Error('No draft was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Admission draft ${id} no longer exists.`);
        return record;
    }

    async all() {
        const snap = await getDocs(draftsCollection);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async where(index, value) {
        const snap = await getDocs(query(draftsCollection, where(index, '==', value)));
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
            .filter((r) => (r.label || '').toLowerCase().includes(q))
            .slice(0, max);
    }

    /** All drafts, most recently updated first — not filtered to the current user, matching the original's actual (if misleadingly-named) behaviour. */
    async mine() {
        return (await this.all()).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }

    /* --------------------------------------------------------------- WRITES */

    /**
     * `id` may be supplied explicitly — saveDraft() (admissions.service.js)
     * reuses a caller-known draft id (e.g. one already visible in the page's
     * URL/state) that this repository hasn't seen before, rather than always
     * minting a fresh one. `setDoc` creates or overwrites either way, so no
     * existence check is needed here.
     */
    async create(data) {
        const record = this.beforeSave({ ...data });
        this.validate(record);
        const explicitId = record.id;
        delete record.id;

        const at = nowISO();
        const actor = session.actorId();
        const full = {
            ...record,
            createdAt: record.createdAt || at,
            updatedAt: at,
            updatedBy: actor
        };

        if (explicitId) {
            await setDoc(doc(firestore, COLLECTION_NAME, explicitId), full);
            return { id: explicitId, ...full };
        }

        const ref = await addDoc(draftsCollection, full);
        return { id: ref.id, ...full };
    }

    async update(id, changes) {
        const existing = await this.findOrFail(id);
        const merged = this.beforeSave({ ...existing, ...changes, id });
        this.validate(merged);

        merged.updatedAt = nowISO();
        merged.updatedBy = session.actorId();
        delete merged.id;
        delete merged.createdAt;

        await updateDoc(doc(firestore, COLLECTION_NAME, id), merged);
        return { ...existing, ...merged, id };
    }

    async save(data) {
        if (data.id && await this.find(data.id)) return this.update(data.id, data);
        return this.create(data);
    }

    /** Always a hard delete — softDelete:false, matching the original. */
    async remove(id) {
        await deleteDoc(doc(firestore, COLLECTION_NAME, id));
        return true;
    }

    async restore() {
        throw new Error('Admission drafts are never soft-deleted, so there is nothing to restore.');
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
                createdAt: record.createdAt || at,
                updatedAt: at,
                updatedBy: actor
            };
            const ref = doc(draftsCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        return records;
    }

    /** Drops drafts older than the retention window. Called at boot (js/app.js). */
    async prune(days = 30) {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString();
        const snap = await getDocs(query(draftsCollection, where('updatedAt', '<', cutoff)));
        if (snap.empty) return 0;

        for (let i = 0; i < snap.docs.length; i += 450) {
            const chunk = snap.docs.slice(i, i + 450);
            const delBatch = writeBatch(firestore);
            for (const d of chunk) delBatch.delete(d.ref);
            await delBatch.commit();
        }

        return snap.docs.length;
    }

    /** RESTORE USE ONLY (js/services/backup.service.js). */
    async replaceAll(records) {
        const existingSnap = await getDocs(draftsCollection);
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
                setBatch.set(doc(draftsCollection, id), data);
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const drafts$ = new FirestoreAdmissionDraftRepository();
