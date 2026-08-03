/**
 * NATYAM ERP 2.0 — Centralized business-code sequence generator (Firestore)
 *
 * The Document Identifier Standard: a Firestore document's id is always an
 * auto-generated, purely technical value — never shown to a user and never
 * treated as a business identifier. Every entity that needs a human-facing
 * code (`STU000001`, `USR000001`, and future `BRN`/`BAT`/`ADM`/`RCP`/`EXP`
 * codes) gets one from here, so the atomic-counter mechanism exists in
 * exactly one place rather than being reimplemented per repository.
 *
 * One shared `meta/counters` document, one field per sequence name,
 * incremented inside a transaction — read-and-increment in a single atomic
 * step so two people creating a record in the same moment can never be
 * handed the same number.
 */

import { doc, runTransaction } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';

const counterRef = doc(firestore, 'meta', 'counters');

/**
 * @param {string} name   Sequence key, e.g. 'studentCode', 'userCode'.
 * @param {string} prefix e.g. 'STU', 'USR'.
 * @param {number} [padLength=6]
 * @returns {Promise<string>} e.g. 'STU000001'
 */
export async function nextCode(name, prefix, padLength = 6) {
    const next = await runTransaction(firestore, async (tx) => {
        const snap = await tx.get(counterRef);
        const current = Number(snap.exists() ? snap.data()[name] : 0) || 0;
        const value = current + 1;
        tx.set(counterRef, { [name]: value }, { merge: true });
        return value;
    });
    return `${prefix}${String(next).padStart(padLength, '0')}`;
}
