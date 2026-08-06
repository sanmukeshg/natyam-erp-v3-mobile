/**
 * NATYAM ERP 2.0 — Staff repository (Firestore)
 *
 * Milestone 20: the eighth store migrated off IndexedDB, following the
 * exact pattern set by Students/Admissions/Attendance/Class Sessions/
 * Programmes/Certificates/Batches. Keeps the exact external shape the old
 * IndexedDB-backed StaffRepository (and the base Repository class it
 * extended) had — find/findOrFail/all/where/count/search/create/update/
 * save/remove/restore/createMany, plus the Staff-specific teachers()/
 * activeStaff() — so every existing caller (staff.service.js, batches/
 * attendance/certificates/programs/reports/dashboard/settings/search.
 * service.js) needed no changes beyond what this migration itself
 * required.
 *
 * `branchIdsOf()` also lives here now, not in repositories.js — it's a
 * pure Staff-domain helper (StaffRepository was its only internal caller)
 * that repositories.js re-exports unchanged, the same pattern already
 * used for AttendanceMath. Moving it here (rather than importing it back
 * from repositories.js) avoids a real import cycle: repositories.js
 * re-exports `staff$` from this file, so this file importing anything
 * from repositories.js would close the loop.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. Staff already had a real human-facing
 * business code before this migration — `employeeNo` — so, like Batches'
 * `code`, nothing new is introduced here; `employeeNo` uniqueness stays
 * enforced in `hire()` at the service layer exactly as before (there was
 * never a storage-level constraint on it to replace, unlike Batches' `code`).
 */

import {
    collection, doc, addDoc, updateDoc, deleteDoc, query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';
import { getDoc, getDocs } from './firestoreRead.js';

const COLLECTION_NAME = 'staff';
const staffCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['name', 'employeeNo', 'role', 'specialisation', 'phone'];

/** Which branches a staff member belongs to — an array if set, else the legacy scalar `branchId` as a one-item array, else none. */
export function branchIdsOf(member) {
    if (member.branchIds?.length) return member.branchIds;
    return member.branchId ? [member.branchId] : [];
}

/** Soft-delete convention, same as the IndexedDB Repository base class (Staff never opted out of it). */
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

function normalisePhone(value) {
    if (!value) return null;
    const cleaned = String(value).replace(/[^\d+]/g, '');
    return cleaned || null;
}

async function writeAuditRow(action, id, detail) {
    await recordAuditEntry('Staff member', action, id, detail);
}

class FirestoreStaffRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) {
        const branchIds = Array.isArray(record.branchIds)
            ? [...new Set(record.branchIds.filter(Boolean))]
            : (record.branchId ? [record.branchId] : []);

        return {
            ...record,
            name: String(record.name || '').trim().replace(/\s+/g, ' '),
            phone: normalisePhone(record.phone),
            status: record.status || 'active',
            monthlySalary: Number(record.monthlySalary) || 0,
            branchIds,
            // Kept in sync as the "home" branch — the existing branchId index
            // and any code that still reads it scalarly stay correct.
            branchId: branchIds[0] || null
        };
    }

    validate(record) {
        if (!record.name) throw new Error('A staff member needs a name.');
        if (!record.role) throw new Error('Choose a role.');
        if (record.monthlySalary < 0) throw new Error('Salary cannot be negative.');
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
        if (!id) throw new Error('No staff member was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Staff member ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(staffCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(staffCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    /**
     * Substring search over `searchKey`, same trade-off as Programmes'/
     * Certificates'/Batches' repositories — the staff directory is small
     * enough that fetching the full collection and filtering client-side
     * is simpler than a dedicated prefix-range query.
     */
    async search(term, { limit: max = 20 } = {}) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return [];

        return (await this.all())
            .filter((r) => (r.searchKey || '').includes(q))
            .slice(0, max);
    }

    async teachers(branchId = null) {
        const rows = (await this.where('role', 'teacher')).filter((s) => s.status === 'active');
        return branchId ? rows.filter((s) => branchIdsOf(s).includes(branchId)) : rows;
    }

    async activeStaff(branchId = null) {
        const rows = (await this.all()).filter((s) => s.status === 'active');
        return branchId ? rows.filter((s) => branchIdsOf(s).includes(branchId)) : rows;
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
            deletedAt: null,
            searchKey: searchKeyOf(record)
        };

        const ref = await addDoc(staffCollection, full);
        await writeAuditRow('create', ref.id, { employeeNo: full.employeeNo });
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

    /** Soft delete by default — a staff member is normally deactivated, not removed. */
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
        if (!snap.exists()) throw new Error(`Staff member ${id} no longer exists.`);
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
            const ref = doc(staffCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing staff document, then re-creates `records` (each stamped
     * fresh, same "replace" semantics as every other store).
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
                setBatch.set(doc(staffCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const staff$ = new FirestoreStaffRepository();
