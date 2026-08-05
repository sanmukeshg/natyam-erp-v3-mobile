/**
 * Natyam ERP v3 — Mobile — Enquiries (Firestore)
 *
 * A prospective parent's "please contact me" record, created before they have
 * any account at all. Reception follows it up from the Desktop ERP; an
 * enquiry that goes anywhere becomes an Admission, which is a different
 * collection with a different lifecycle.
 *
 * THIS IS THE ONE REPOSITORY IN THE APP THAT WRITES WITHOUT A SESSION, and
 * every difference from the other repositories here follows from that:
 *
 *  - No session.actorId(). It would return the string 'system' (see
 *    js/core/session.js) for an unauthenticated caller — technically safe,
 *    but it would file every public enquiry under the same attribution the
 *    app's own internal writes use. `createdBy: 'public'` says what actually
 *    happened, and firestore.rules requires exactly that value on create.
 *
 *  - No audit row. recordAuditEntry() writes to /auditLog, whose create rule
 *    is isProvisionedActiveUser() — an unauthenticated call fails outright
 *    and would take the enquiry down with it. The enquiry document carries
 *    its own createdAt/createdBy, which is the whole audit trail this record
 *    type has or needs.
 *
 *  - No soft delete, no searchKey, no createMany. Reception triages these by
 *    hand from a short list, and spam is deleted outright rather than
 *    archived.
 *
 * WRITE-ONLY ON PURPOSE. This app submits enquiries and never lists them —
 * reading them is Reception's job in the Desktop ERP, so the read side is
 * added there, to natyam-admin, when that screen is built. The exact key set
 * below is duplicated as a validator in firestore.rules; the two have to be
 * edited together, or a legitimate submission fails with a permissions error
 * instead of a field message.
 */

import {
    collection, addDoc
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { nowISO } from '../utils/date.js';

const COLLECTION_NAME = 'enquiries';
const enquiriesCollection = collection(firestore, COLLECTION_NAME);

export const enquiries$ = {
    /**
     * Persists an enquiry. Validation, trimming, length caps and the
     * status/source decision all belong to enquiry.service.js and are NOT
     * repeated here — this method selects the fields it stores and stamps the
     * record, which is the whole of a repository's job in this codebase.
     *
     * Fields are selected by name rather than spread, for one reason that is
     * not stylistic: firestore.rules' isPublicEnquiry() pins this document to
     * an exact key set, so an unexpected property arriving from a caller
     * would not be ignored — it would fail the write outright. Naming them
     * makes that impossible.
     *
     * @param {object} payload  enquiry.service.js's normalised business
     *   payload: name, phone, email, message, branchId, courseInterest,
     *   status, source.
     * @returns {Promise<object>} the created record, including its Firestore id.
     */
    async create(payload) {
        const record = {
            name: payload.name,
            phone: payload.phone,
            email: payload.email,
            message: payload.message,
            branchId: payload.branchId,
            courseInterest: payload.courseInterest,
            status: payload.status,
            source: payload.source,

            // The repository's own two stamps. `createdBy` is a literal
            // rather than session.actorId(), which would return 'system' for
            // an unauthenticated caller (js/core/session.js) and file every
            // public enquiry under the attribution the app's internal writes
            // use. The rules require exactly 'public'.
            createdAt: nowISO(),
            createdBy: 'public',

            // Reception's fields, written null so the document shape is
            // stable for the Desktop ERP reading it. The rules require them
            // absent-of-value at create: a submitter cannot arrive triaged.
            handledBy: null,
            handledOn: null,
            note: null
        };

        const ref = await addDoc(enquiriesCollection, record);
        return { id: ref.id, ...record };
    }
};
