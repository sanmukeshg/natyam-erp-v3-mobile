/**
 * Natyam ERP v3 — Push subscriptions (UAT5 ENH-510)
 *
 * One document per DEVICE, keyed by its FCM registration token.
 *
 * Keyed by the token rather than auto-generated, and that choice is doing real
 * work. A token is already unique, already the thing a sender needs, and
 * already the only handle the browser can give back — so `save()` is an upsert
 * with no lookup, re-enabling on a device that was already enabled overwrites
 * cleanly instead of accumulating rows, and `remove()` needs nothing but the
 * token the client just asked for.
 *
 * ONE PERSON, SEVERAL DEVICES. A phone, a tablet and the desk machine are three
 * subscriptions with the same `userId`, and each carries its own preferences —
 * an owner may want fee alerts on her phone and nothing on the desktop she
 * already stares at. Turning notifications off on one device must never silence
 * another, which is why preferences live here and not on the user record.
 *
 * WHAT THE SENDER DOES WITH THIS, once it exists: query by `categories`
 * array-contains the event kind, optionally narrowed by `branchId` or
 * `staffId`, and push to every `id` that comes back. A token FCM rejects as
 * unregistered should be deleted — devices are reinstalled, and a token that
 * nobody prunes is a permanent failed send. See docs/push-notifications.md.
 */

import {
    collection, doc, setDoc, deleteDoc, query, where
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';
import { getDoc, getDocs } from './firestoreRead.js';

const pushCollection = collection(firestore, 'pushSubscriptions');

class FirestorePushSubscriptionRepository {
    async find(token) {
        if (!token) return null;
        const snap = await getDoc(doc(firestore, 'pushSubscriptions', token));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }

    /** Every device one account has enabled — the settings screen's count. */
    async forUser(userId) {
        if (!userId) return [];
        const snap = await getDocs(query(pushCollection, where('userId', '==', userId)));
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    /**
     * Upsert. `merge: false` on purpose — the client always sends the whole
     * record, and a merge would leave a stale category list behind when someone
     * turns a category off.
     *
     * `id` is destructured away rather than overwritten. It is the document key,
     * so storing it again would duplicate it inside the document — and
     * `updatePushPreferences()` spreads an existing row straight back in here,
     * which is how it arrives. Setting `id: undefined` looked like it removed
     * the field and did not: Firestore rejects an undefined value outright
     * ("Unsupported field value: undefined") instead of ignoring the key, so
     * enabling notifications failed on the write. Every other repository in
     * `js/data` already destructures; this one was the exception.
     */
    async save(token, data) {
        const { id, ...fields } = data;
        await setDoc(doc(firestore, 'pushSubscriptions', token), fields);
        return { id: token, ...fields };
    }

    async remove(token) {
        await deleteDoc(doc(firestore, 'pushSubscriptions', token));
        return true;
    }
}

export const pushSubscriptions$ = new FirestorePushSubscriptionRepository();
