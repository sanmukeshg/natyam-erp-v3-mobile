/**
 * NATYAM ERP 2.0 — Certificates repository (Firestore)
 *
 * Milestone 18: the sixth store migrated off IndexedDB, following the exact
 * pattern set by Students/Admissions/Attendance/Class Sessions/Programmes.
 * Keeps the exact external shape the old IndexedDB-backed CertificateRepository
 * (and the base Repository class it extended) had — find/findOrFail/all/
 * where/count/search/create/update/save/remove/restore/createMany, plus the
 * Certificate-specific forStudent()/verify() — so every existing caller
 * (certificates.service.js, students/programs/reports/search/notifications.
 * service.js) needed no changes beyond what this migration itself required.
 *
 * Document Identifier Standard: the Firestore document id is auto-generated
 * and never shown to a user. Certificates already had a real human-facing
 * business code before this migration — the `serial` (NAT/CRT/YY/0000,
 * allocated from settings$'s atomic counter in certificates.service.js) — so,
 * unlike Programmes, nothing new is introduced here; `serial` keeps doing
 * exactly what it already did.
 */

import {
    collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
    query, where, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { session } from '../core/session.js';
import { recordAuditEntry } from './auditLog.repository.firestore.js';
import { nowISO } from '../utils/date.js';

const COLLECTION_NAME = 'certificates';
const certificatesCollection = collection(firestore, COLLECTION_NAME);
const SEARCH_FIELDS = ['serial', 'studentName', 'title', 'programName'];

/** Soft-delete convention, same as the IndexedDB Repository base class (Certificate never opted out of it). */
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
    await recordAuditEntry('Certificate', action, id, detail);
}

class FirestoreCertificateRepository {
    /* ---------------------------------------------------------------- HOOKS */

    beforeSave(record) { return record; }

    validate(record) {
        if (!record.studentId) throw new Error('A certificate must name a student.');
        if (!record.title?.trim()) throw new Error('A certificate needs a title.');
        if (!record.serial) throw new Error('A certificate needs a serial number.');
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
        if (!id) throw new Error('No certificate was specified.');
        const record = await this.find(id);
        if (!record) throw new Error(`Certificate ${id} no longer exists.`);
        return record;
    }

    async all({ includeDeleted = false } = {}) {
        const snap = await getDocs(certificatesCollection);
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        return includeDeleted ? rows : rows.filter(visible);
    }

    async where(index, value) {
        const snap = await getDocs(query(certificatesCollection, where(index, '==', value)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(visible);
    }

    async count(index, value) {
        if (!index) return (await this.all()).length;
        return (await this.where(index, value)).length;
    }

    /**
     * Substring search over `searchKey`, same trade-off as Programmes'
     * repository: the certificates register is small enough that fetching
     * the full collection and filtering client-side is simpler than a
     * dedicated prefix-range query, and that's already what
     * listCertificates() does for every other filter.
     */
    async search(term, { limit: max = 20 } = {}) {
        const q = String(term || '').trim().toLowerCase();
        if (!q) return [];

        return (await this.all())
            .filter((r) => (r.searchKey || '').includes(q))
            .slice(0, max);
    }

    async forStudent(studentId) {
        return (await this.where('studentId', studentId)).sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
    }

    /**
     * Milestone P2 (Parent/Student Portal). Every certificate across every
     * one of a guardian's children — filtered by `guardianPhone`/
     * `guardianEmail` directly on the certificate document, never by
     * `studentId`. firestore.rules can only authorize a query when its own
     * where() filter matches exactly what the guardian read rule checks; a
     * studentId-based query would be denied outright regardless of the
     * rule. Callers narrow to one child client-side (see
     * guardianAuth.service.js's guardianChildren() for the same shape).
     */
    async forGuardian(phone, email) {
        const [byPhone, byEmail] = await Promise.all([
            phone ? getDocs(query(certificatesCollection, where('guardianPhone', '==', phone))) : null,
            email ? getDocs(query(certificatesCollection, where('guardianEmail', '==', email))) : null
        ]);

        const seen = new Map();
        for (const snap of [byPhone, byEmail]) {
            if (!snap) continue;
            for (const d of snap.docs) {
                const record = { id: d.id, ...d.data() };
                if (visible(record)) seen.set(d.id, record);
            }
        }
        return [...seen.values()].sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
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

    /** Public verification: serial in, certificate or null out. */
    async verify(serial) {
        const rows = await this.where('serial', String(serial || '').trim().toUpperCase());
        return rows[0] || null;
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

        const ref = await addDoc(certificatesCollection, full);
        await writeAuditRow('create', ref.id, { serial: full.serial, studentId: full.studentId });
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

    /**
     * Soft delete by default. A certificate is normally revoked, not
     * removed — the only caller of a hard delete is students.service.js's
     * deleteStudent() cascade, which genuinely destroys the record along
     * with the rest of the student's history.
     */
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
        if (!snap.exists()) throw new Error(`Certificate ${id} no longer exists.`);
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
            const ref = doc(certificatesCollection);
            batch.set(ref, full);
            records.push({ id: ref.id, ...full });
        }

        await batch.commit();
        await writeAuditRow('createMany', null, { count: records.length });
        return records;
    }

    /**
     * RESTORE USE ONLY (js/services/backup.service.js). Deletes every
     * existing certificate document, then re-creates `records` (each
     * stamped fresh, same "replace" semantics as every other store).
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
                setBatch.set(doc(certificatesCollection, id), {
                    ...data,
                    searchKey: searchKeyOf(data)
                });
            }
            await setBatch.commit();
        }

        return records.length;
    }
}

export const certificates$ = new FirestoreCertificateRepository();
