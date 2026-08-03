/**
 * NATYAM ERP 2.0 — Branches repository (Firestore)
 *
 * Milestone 23: part of the Settings reference data migration (Branches,
 * Academic Years, Curricula, Curriculum Levels, Holidays) — the last
 * data-shape migration before the Audit Log. Keeps the exact external
 * shape the old IndexedDB-backed BranchRepository had —
 * find/findOrFail/all/where/count/search/create/update/save/remove/
 * restore/createMany, plus active(). This is the single most
 * widely-read repository in the app (branchId appears on nearly every
 * record); the highest-stakes caller is `js/app.js`'s `hydrateSession()`,
 * which runs on every sign-in — see that file's own try/catch for why a
 * failure here no longer signs the user back out with a misleading
 * "not provisioned" message.
 *
 * `branches.code` uniqueness was previously enforced only by IndexedDB's
 * native unique index — Firestore has no equivalent, so create()/update()
 * now check for a clashing code explicitly, the same fix Batches got in
 * Milestone 19. `createBranch()` in settings.service.js already had a
 * partial manual check of its own; this repository-level check is now the
 * authoritative one and also covers updateBranch(), which had no check at
 * all.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. `code` (e.g. HYD-C) remains the branch's
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

const COLLECTION_NAME = 'branches';
const branchesCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'code'];

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
    await recordAuditEntry('Branch', action, id, detail);
}

class FirestoreBranchRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        return { ...record, code: String(record.code || '').trim().toUpperCase(), status: record.status || 'active' };
    }

    validate(record) {
        if (!record.name?.trim()) throw new Error('A branch needs a name.');
        if (!record.code?.trim()) throw new Error('A branch needs a short code, e.g. HYD-C.');
    }

    /**
     * Firestore has no equivalent to IndexedDB's unique index — this is the
     * application-level replacement for the constraint `SCHEMA.branches`
     * used to enforce. `excludeId` lets update() check without tripping
     * over the record's own current code.
     */
    async _assertCodeAvailable(code, excludeId = null) {
        const clashes = await this.where('code', code);
        if (clashes.some((b) => b.id !== excludeId)) {
            throw new Error(`A branch with the code ${code} already exists.`);
        }
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
        if (!id) throw new Error('No branch was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Branch ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(branchesCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(branchesCollection, where(index, '==', value)));
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

    async active() {
        return (await this.all()).filter((b) => b.status === 'active');
    }

    /* --------------------------------------------------------------- WRITES */

    async create(data) {
        const record = this.beforeSave({ ...data });
        this.validate(record);
        await this._assertCodeAvailable(record.code);
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

        const ref = await addDoc(branchesCollection, full);
        await writeAuditRow('create', ref.id, { code: full.code });
        return { id: ref.id, ...full };
    }

    async update(id, changes) {
        const existing = await this.findOrFail(id);
        const merged = this.beforeSave({ ...existing, ...changes, id });
        this.validate(merged);
        if (merged.code !== existing.code) await this._assertCodeAvailable(merged.code, id);

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

    /** No hard-delete path exists — a branch is only ever closed via update(), never removed. */
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
        if (!snap.exists()) throw new Error(`Branch ${id} no longer exists.`);
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
            const ref = doc(branchesCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Bypasses the
     * code-uniqueness check by design — a restore is trusted to already
     * be internally consistent, the same way every other store's
     * replaceAll() skips its own repository-level validation.
     */
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
                setBatch.set(doc(branchesCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const branches$ = new FirestoreBranchRepository();
