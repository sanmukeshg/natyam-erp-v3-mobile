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
// TEACHING_ROLES, not staff.service's copy — importing that service would
// close a cycle through repositories.js. See its note in app.config.js.
import { TEACHING_ROLES } from '../config/app.config.js';
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

    /**
     * Everyone who may take a batch — UAT5 ENH-512.
     *
     * Was `where('role', 'teacher')`: one equality query, and the reason an
     * Owner could not be assigned to a class without inventing a second
     * Teacher account for the same person. It now reads every active staff
     * member and keeps the roles whose `teaches` flag is set.
     *
     * A COLLECTION READ WHERE THERE WAS AN INDEXED QUERY, and that is a real
     * cost accepted deliberately. Firestore's `in` operator would keep this a
     * query, but it caps at thirty values and — more to the point — would put
     * the role list in two places, so adding a teaching role to STAFF_ROLES
     * would silently fail to reach batch assignment. Staff is the smallest
     * collection in the app (single figures for this school, tens for any
     * school this software is for), and activeStaff() directly below has
     * always read it whole for the same reason.
     */
    async teachers(branchId = null) {
        const rows = (await this.all())
            .filter((s) => s.status === 'active' && TEACHING_ROLES.includes(s.role));
        return branchId ? rows.filter((s) => branchIdsOf(s).includes(branchId)) : rows;
    }

    async activeStaff(branchId = null) {
        const rows = (await this.all()).filter((s) => s.status === 'active');
        return branchId ? rows.filter((s) => branchIdsOf(s).includes(branchId)) : rows;
    }

    /**
     * The staff record behind a signed-in account, matched on email.
     *
     * THE MISSING LINK — UAT5 ENH-512, and a live bug in its own right.
     * `users` documents are keyed by email (`natyam.ssmda@gmail.com`); staff
     * documents are keyed by a business code (`STF-SUREKHA`); and a batch
     * stores the staff code. So `session.actorId()` — a user id — could never
     * match `batch.teacherId`, and the mobile teacher dashboard asked
     * `byTeacher('…@gmail.com')` and got nothing back. On this school's live
     * data that is five batches found by staff id and zero by user id: a
     * teacher signing in saw no classes and no pending registers, ever.
     *
     * The join was always present in the data — a staff record carries the
     * same `email` the user document is keyed by — and simply unused. This is
     * the one place that uses it, so the two id spaces meet exactly once.
     *
     * Returns null for an account with no staff record, which is the normal
     * case for an Administrator and must stay unremarkable.
     */
    async byUserEmail(email) {
        const key = String(email || '').trim().toLowerCase();
        if (!key || !key.includes('@')) return null;

        // Matched case-insensitively in the client rather than by query: the
        // stored value is whatever was typed into the Staff form, and a record
        // saved as "Natyam.SSMDA@gmail.com" must still resolve.
        const matches = (await this.all())
            .filter((s) => String(s.email || '').trim().toLowerCase() === key);

        /*
         * AN ACTIVE RECORD WINS, always.
         *
         * One email can reach two staff records — someone leaves and is later
         * re-hired, or a record is created rather than edited. This school has
         * exactly that today: two records carry the Owner's address, one active
         * with five batches and one inactive with none. A plain `find()`
         * returns whichever Firestore hands back first, so the Owner's app
         * would sometimes resolve to the dormant record and tell her she
         * teaches nothing — intermittently, which is the worst kind.
         *
         * Falling back to an inactive match rather than null is deliberate: a
         * former teacher's own history should still resolve to their record,
         * and a caller asking "which staff record is this" wants an answer.
         */
        return matches.find((s) => s.status === 'active') || matches[0] || null;
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
