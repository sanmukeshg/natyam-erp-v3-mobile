/**
 * NATYAM ERP 2.0 — Sessions repository (Firestore)
 *
 * A real, working record of sign-ins — not a placeholder, and honestly
 * scoped to what's achievable without a backend (no Cloud Functions, no
 * Admin SDK): it's an audit-quality record, not a remote-kill switch.
 * Idle timeout itself stays enforced client-side (js/core/session.js), the
 * same as before this file existed. Nothing reads this collection yet
 * besides auth.service.js, its own writer — it exists so a future "active
 * sessions" admin screen has real data to show rather than needing its own
 * migration.
 */

import { collection, doc, addDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { nowISO } from '../utils/date.js';

const COLLECTION_NAME = 'sessions';
const sessionsCollection = collection(firestore, COLLECTION_NAME);

class FirestoreSessionRepository {
    /**
     * One document per sign-in.
     * @param {{userId: string, provider: string}} data
     * @returns {Promise<string>} the new session document's id
     */
    async create({ userId, provider }) {
        const at = nowISO();
        const ref = await addDoc(sessionsCollection, {
            userId,
            provider,
            userAgent: navigator.userAgent || null,
            createdAt: at,
            lastActivityAt: at,
            endedAt: null,
            reason: null
        });
        return ref.id;
    }

    /**
     * Soft-ends a session — never deleted, consistent with the soft-delete
     * convention every other module already uses.
     * @param {string} sessionId
     * @param {'logout'|'idle_timeout'|'cross_tab_signout'} reason
     */
    async end(sessionId, reason) {
        if (!sessionId) return;
        await updateDoc(doc(firestore, COLLECTION_NAME, sessionId), {
            endedAt: nowISO(),
            reason
        });
    }
}

export const sessions$ = new FirestoreSessionRepository();
