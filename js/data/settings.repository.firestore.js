/**
 * NATYAM ERP 2.0 — Settings key-value store (Firestore)
 *
 * The last IndexedDB holdout, found well after the 24-entity migration was
 * declared complete: institute details and every document-numbering
 * sequence (admission/application/invoice/receipt/certificate) were still
 * being read and written locally, per browser — meaning two devices used
 * by the same school could silently issue the same admission number, or
 * show two different addresses on a receipt, each with no idea what the
 * other had already written. This collection closes that gap the same
 * way every other entity in this app already was: one shared source of
 * truth, not one per browser.
 *
 * Deliberately not shaped like the other repositories — a setting is a key
 * and a value, not an entity with an id, an audit trail or a soft delete.
 * One Firestore document per key, the key itself as the document id.
 */

import {
    collection, doc, getDoc, getDocs, setDoc, deleteDoc, runTransaction
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { nowISO } from '../utils/date.js';

const COLLECTION_NAME = 'settings';
const settingsCollection = collection(firestore, COLLECTION_NAME);

export const settings$ = {
    async get(key, fallback = null) {
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, key));
        return snap.exists() ? snap.data().value : fallback;
    },

    async set(key, value) {
        await setDoc(doc(firestore, COLLECTION_NAME, key), { value, updatedAt: nowISO() });
        return value;
    },

    /**
     * One row per key — matches every other collection's backup-file shape
     * (an array of documents), not the {key: value} map earlier callers
     * never actually relied on (confirmed: settings$.all() had no callers
     * anywhere in the app before this migration).
     */
    async all() {
        const snap = await getDocs(settingsCollection);
        return snap.docs.map((d) => ({ key: d.id, ...d.data() }));
    },

    /**
     * Atomic counter for human-facing numbers (NAT/INV/2026/0417). Now a
     * Firestore transaction rather than the IndexedDB one this used to be —
     * two people on two different computers raising an invoice at the same
     * moment must not be able to read the same "next" number and both
     * write it back, which used to be safe only because IndexedDB kept
     * each browser's counter to itself.
     */
    async nextSequence(name, count = 1) {
        const ref = doc(firestore, COLLECTION_NAME, 'sequences');
        let allocated = 0;

        await runTransaction(firestore, async (tx) => {
            const snap = await tx.get(ref);
            const map = { ...(snap.exists() ? snap.data().value : {}) };
            const current = Number(map[name]) || 0;
            allocated = current + 1;
            map[name] = current + count;
            tx.set(ref, { value: map, updatedAt: nowISO() });
        });

        return allocated;
    },

    /** RESTORE USE ONLY (js/services/backup.service.js). */
    async replaceAll(rows) {
        const existingSnap = await getDocs(settingsCollection);
        for (const d of existingSnap.docs) await deleteDoc(d.ref);

        for (const row of rows) {
            await setDoc(doc(firestore, COLLECTION_NAME, row.key), {
                value: row.value,
                updatedAt: row.updatedAt || nowISO()
            });
        }

        return rows.length;
    }
};
