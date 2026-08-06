/**
 * NATYAM ERP 2.0 — Class Sessions repository (Firestore)
 *
 * Milestone 7: the first entirely new Firestore collection introduced
 * without a preceding IndexedDB implementation — there is nothing to
 * archive here, because a Session never existed as a stored entity before
 * this milestone. Timetable previously only ever *derived* whether a class
 * happens on a date, from `batch.days`; this collection is that derivation
 * made real, one document per actual class occurrence.
 *
 * Ownership: Timetable owns Sessions, not Attendance (see session.service.js,
 * the only Service permitted to call into this file). Attendance references
 * a session by id; it never reads or writes this collection directly.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. `sessionCode` (`TS-20260714-JUNIOR`-style) is
 * the human-facing identifier — deterministic from the batch's own code and
 * the date, not the shared atomic `meta/counters` sequence generator, since
 * a batch+date pairing is already guaranteed unique on its own and doesn't
 * need a transactional counter to stay collision-free.
 */

import {
    collection, doc, setDoc, updateDoc, query, where, runTransaction, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'classSessions';
const classSessionsCollection = collection(firestore, COLLECTION_NAME);

class FirestoreClassSessionRepository {
    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    async findOrFail(id) {
        const record = await this.find(id);
        if (!record) throw new Error(`Session ${id} no longer exists.`);
        return record;
    }

    /** A batch has at most one session per date under normal operation — lazy creation always checks here first. */
    async findByBatchDate(batchId, date) {
        const snap = await getDocs(query(classSessionsCollection,
            where('batchId', '==', batchId), where('date', '==', date)));
        if (snap.empty) return null;
        return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }

    /** Inclusive date-range query, optionally scoped to a branch — mirrors attendance$.between()'s shape. */
    async between(from, to, branchId = null) {
        const snap = await getDocs(query(classSessionsCollection,
            where('date', '>=', from), where('date', '<=', to)));
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return branchId ? rows.filter((r) => r.branchId === branchId) : rows;
    }

    /** Every record, unscoped — used by backup.service.js's buildBackup(). */
    async all() {
        const snap = await getDocs(classSessionsCollection);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    /* --------------------------------------------------------------- WRITES */

    /**
     * Lazily schedules a session the first time its batch+date is touched.
     * Business eligibility (is this date actually one the batch meets) is
     * decided by the caller (session.service.js's resolveSession()) — this
     * only persists whatever record it's handed.
     */
    async create(data) {
        const at = nowISO();
        const record = {
            ...data,
            createdAt: at, createdBy: data.createdBy,
            updatedAt: at, updatedBy: data.createdBy
        };
        delete record.id;

        const ref = doc(classSessionsCollection);
        await setDoc(ref, record);
        return { id: ref.id, ...record };
    }

    /**
     * Postpones the original session and creates its replacement atomically
     * — both must succeed together, or neither does. Re-checks the
     * original's current status inside the transaction (not just relying on
     * whatever the caller last read) so two concurrent postpone attempts on
     * the same session can't both succeed.
     *
     * @param {string} originalId
     * @param {object} replacement  Fully-formed replacement fields (sessionCode,
     *   branchId, batchId, programId, curriculumId, teacherId, date,
     *   startTime, endTime, duration, sessionType) plus reason/remarks/actor.
     * @returns {Promise<{originalId: string, replacementId: string}>}
     */
    async postpone(originalId, { reason, remarks, actor, ...replacement }) {
        const originalRef = doc(firestore, COLLECTION_NAME, originalId);
        const replacementRef = doc(classSessionsCollection);

        await runTransaction(firestore, async (tx) => {
            const snap = await tx.get(originalRef);
            if (!snap.exists()) throw new Error('This session no longer exists.');
            const original = snap.data();
            if (original.status !== 'scheduled' && original.status !== 'completed') {
                throw new Error(`This session is already ${original.status} and cannot be postponed.`);
            }

            const at = nowISO();
            tx.update(originalRef, {
                status: 'postponed',
                reason: reason?.trim() || null,
                remarks: remarks?.trim() || null,
                replacementSessionId: replacementRef.id,
                updatedAt: at,
                updatedBy: actor
            });

            tx.set(replacementRef, {
                ...replacement,
                status: 'scheduled',
                remarks: null,
                reason: null,
                originalSessionId: originalId,
                replacementSessionId: null,
                createdAt: at, createdBy: actor,
                updatedAt: at, updatedBy: actor
            });
        });

        return { originalId, replacementId: replacementRef.id };
    }

    /** Cancels a scheduled session in place — no replacement, unlike postpone(). */
    async cancel(id, { reason, remarks, actor }) {
        const ref = doc(firestore, COLLECTION_NAME, id);

        await runTransaction(firestore, async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error('This session no longer exists.');
            const current = snap.data();
            if (current.status !== 'scheduled') {
                throw new Error(`This session is already ${current.status} and cannot be cancelled.`);
            }

            tx.update(ref, {
                status: 'cancelled',
                reason: reason?.trim() || null,
                remarks: remarks?.trim() || null,
                updatedAt: nowISO(),
                updatedBy: actor
            });
        });
    }

    /**
     * Marks a session Completed — called by attendance.service.js's
     * postRegister() after a successful post, never by the UI directly.
     * A no-op (not an error) if the session isn't currently Scheduled, so a
     * duplicate completion call (e.g. a corrected re-mark) never regresses
     * a session's state or throws over something that already happened.
     */
    async complete(id) {
        const ref = doc(firestore, COLLECTION_NAME, id);
        const snap = await getDoc(ref);
        if (!snap.exists() || snap.data().status !== 'scheduled') return false;

        await updateDoc(ref, { status: 'completed', updatedAt: nowISO() });
        return true;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing session document, then writes `records` back in batches of
     * 450 (Firestore's writeBatch cap is 500) — "replace", matching
     * restore()'s existing all-or-nothing semantics for every other store.
     * Bidirectional originalSessionId/replacementSessionId links are
     * preserved as-is from the backup file, since they reference other
     * sessions' ids from the same restore, not anything regenerated here.
     */
    async replaceAll(records) {
        const existingSnap = await getDocs(classSessionsCollection);
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
                setBatch.set(doc(classSessionsCollection, id), data);
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const classSessions$ = new FirestoreClassSessionRepository();
