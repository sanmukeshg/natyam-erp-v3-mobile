/**
 * Natyam ERP v3 — Mobile — Parent profiles (Firestore)
 *
 * One document per parent who has engaged with the school through the app:
 * created the first time they submit an admission application or an enquiry,
 * and read on every later sign-in to decide whether they still need the
 * Welcome screen.
 *
 * KEYED BY LOWERCASED EMAIL, the same convention users.repository uses, so a
 * caller reaches exactly their own document by path — no query, and nothing
 * for firestore.rules to scan.
 *
 * WHAT THIS IS NOT, and the distinction matters more than anything else here:
 * it is not an identity, not a role, and not a claim to be any student's
 * guardian. Which experience someone gets is decided entirely by the
 * staff → guardian → applicant chain in js/app.js. This document answers one
 * much smaller question — "have they been here before?" — and holding one
 * grants access to nothing: a parent with a profile and no linked student
 * still reads no student, fee or attendance record, because those rules gate
 * on guardianship and are untouched.
 *
 * NO AUDIT ROW, for the same reason enquiries.repository.firestore.js writes
 * none: /auditLog requires isProvisionedActiveUser(), which a parent never
 * is, so the audit write would throw after the profile had already been
 * created and report a success as a failure.
 */

import {
    doc, setDoc
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { nowISO } from '../utils/date.js';
import { getDoc } from './firestoreRead.js';

const COLLECTION_NAME = 'parentProfiles';

/** Doc id === the caller's own lowercased email, matching firestore.rules. */
function keyFor(email) {
    return String(email || '').trim().toLowerCase();
}

export const parentProfiles$ = {
    /**
     * @param {string} email
     * @returns {Promise<object|null>} the profile, or null if they are new.
     */
    async find(email) {
        const key = keyFor(email);
        if (!key) return null;
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, key));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },

    /**
     * Creates the profile, or records a later engagement on an existing one.
     *
     * `firstSeenAt` is written once and never overwritten — merge is not
     * enough on its own to guarantee that, so the existing document is read
     * first. The distinction is worth keeping: when a family first appeared
     * is a different fact from when they last did something, and only the
     * second one changes.
     *
     * @param {string} email
     * @param {object} fields  name, and `lastAction` — 'application' | 'enquiry'.
     */
    async record(email, { name = '', lastAction = null } = {}) {
        const key = keyFor(email);
        if (!key) throw new Error('A parent profile needs an email address.');

        const existing = await this.find(key);
        const at = nowISO();

        const record = {
            // firestore.rules requires this to equal the caller's own token
            // claim, so it is written explicitly rather than left implied by
            // the document id.
            email: key,
            name: name || existing?.name || '',
            firstSeenAt: existing?.firstSeenAt || at,
            lastSeenAt: at,
            lastAction: lastAction || existing?.lastAction || null
        };

        await setDoc(doc(firestore, COLLECTION_NAME, key), record, { merge: true });
        return { id: key, ...record };
    }
};
