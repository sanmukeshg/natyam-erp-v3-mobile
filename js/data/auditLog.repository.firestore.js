/**
 * NATYAM ERP 2.0 — Audit log repository (Firestore)
 *
 * Milestone 24: the final store migrated off IndexedDB. Structurally
 * different from every prior migration — there was never one repository
 * writing to this collection. Every other Firestore repository has its own
 * private `writeAuditRow(action, id, detail)` wrapper that used to call
 * `db.put('auditLog', ...)` directly; each of those wrappers now calls
 * `recordAuditEntry()` below instead, keeping every one of their ~100 call
 * sites unchanged.
 *
 * Unlike the small reference-data collections, this one grows on *every*
 * write in the entire application, without bound. `recent()` is therefore a
 * real Firestore `orderBy`+`limit` query rather than "fetch everything, sort,
 * slice" — the pattern every other (small, bounded) collection's repository
 * uses. Fetching the whole collection here would mean an ever-growing
 * full-table read every time the dashboard's activity feed or the Settings >
 * Audit log page loads.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user — audit rows use `uid('AUD')` today (a random
 * technical id, not a sequence), which is preserved unchanged.
 *
 * Append-only: no update or delete path exists anywhere in the app for an
 * audit entry (see firestore.rules), and this repository does not expose
 * generic create()/update()/remove() — the sole write path is
 * recordAuditEntry(), so the shape of every row stays consistent by
 * construction rather than by convention.
 */

import {
    collection, doc, addDoc, query, where, orderBy, limit as fsLimit, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { uid } from '../utils/id.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'auditLog';
const auditLogCollection = collection(firestore, COLLECTION_NAME);

/**
 * The single writer every repository's private `writeAuditRow` wrapper
 * calls into. Not exposed as a generic create() — a caller always has a
 * specific entity/action/entityId to record, never a free-form document.
 *
 * `actor` is an optional `{ id, name }` override for the one caller that
 * needs it — auth.service.js's own writeAuditRow(), which logs a sign-in
 * *before* (or instead of) a session existing to attribute the row to via
 * `session.actorId()`. Every other caller omits it and gets the current
 * session's actor, as before.
 */
export async function recordAuditEntry(entity, action, entityId, detail = null, actor = null) {
    await addDoc(auditLogCollection, {
        entity,
        entityId,
        action,
        detail: detail || null,
        actorId: actor?.id || session.actorId(),
        actorName: actor?.name || session.actorName(),
        at: nowISO()
    });
}

class FirestoreAuditLogRepository {
    /* ---------------------------------------------------------------- READS */

    async find(id) {
        if (!id) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    async findOrFail(id) {
        const record = await this.find(id);
        if (!record) throw new Error(`Audit entry ${id} no longer exists.`);
        return record;
    }

    /** Every record, unscoped — used by backup.service.js's buildBackup(). */
    async all() {
        const snap = await getDocs(auditLogCollection);
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async where(index, value) {
        const snap = await getDocs(query(auditLogCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    /**
     * The most recent entries, newest first — a real Firestore query, not a
     * full-collection scan, since this collection has no natural upper bound.
     */
    async recent(limit = 50) {
        const snap = await getDocs(query(auditLogCollection, orderBy('at', 'desc'), fsLimit(limit)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    /**
     * One record's full history — a student's or invoice's timeline. Two
     * equality filters need no composite index. Result sets here are
     * inherently small (one entity's lifetime of changes), so sorting
     * client-side is simpler than adding an `orderBy` to the query.
     */
    async forEntity(entity, entityId) {
        const snap = await getDocs(query(auditLogCollection,
            where('entity', '==', entity), where('entityId', '==', entityId)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    }

    /** Inclusive date-range query, same `￿` end-of-day sentinel the original IndexedDB version used. */
    async between(from, to) {
        const snap = await getDocs(query(auditLogCollection,
            where('at', '>=', from), where('at', '<=', `${to}￿`)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    /* --------------------------------------------------------------- WRITES */

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing audit entry, then writes `records` back preserving each
     * one's original id — "replace", matching restore()'s existing
     * all-or-nothing semantics for every other store.
     */
    async replaceAll(records) {
        const existingSnap = await getDocs(auditLogCollection);
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
                setBatch.set(doc(auditLogCollection, id || uid('AUD')), data);
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const audit$ = new FirestoreAuditLogRepository();
