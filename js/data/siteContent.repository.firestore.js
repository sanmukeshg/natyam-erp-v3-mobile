/**
 * Natyam ERP v3 — Mobile — Published public content (Firestore)
 *
 * The backing store for every public-facing section: About Natyam, Courses,
 * Branches, Batch Timings and the Founder today, and later Gallery, Events,
 * FAQ, Contact, Testimonials, Website Home and SEO. One document per key, the
 * key itself as the document id — deliberately the same shape as
 * settings.repository.firestore.js, and for the same reason: this is a small
 * set of named values, not an entity with an id, an audit trail and a soft
 * delete.
 *
 * WHY THIS EXISTS AT ALL, given that Branches, Courses and Batch Timings also
 * exist as operational records elsewhere in this database.
 *
 * Two reasons, and the second is the one that decided it.
 *
 * First, a prospective parent has no Firebase identity, and firestore.rules
 * gates /branches and /batches behind isProvisionedActiveUser(). Opening
 * those to the public cannot be made safe, because rules allow or deny a
 * whole document and cannot filter fields: publishing /batches would publish
 * every batch's capacity, enrolment count and teacher assignment along with
 * the day and time a parent wanted to know.
 *
 * Second — and this is the school's own decision, not a technical one — the
 * public copy is written by hand rather than derived from those records. A
 * public Branches page is a friendly description of where to find the school,
 * not a mirror of an operational row, and an editor who can simply write it
 * is worth more here than machinery that keeps two things in step. The cost
 * is accepted knowingly: a branch address is edited in two places.
 *
 * The same documents become pages of the Natyam website later, which is why
 * the content lives here rather than in the screens that render it.
 *
 * NOTHING HERE IS SECRET. `allow read: if true`. If a value would not go on a
 * public web page, it does not belong in this collection.
 *
 * READ-ONLY ON PURPOSE. natyam-mobile displays this content and never edits
 * it — writes need settings.edit (Administrator and Owner) and belong to the
 * Desktop ERP's Settings → Website Content module, which is the only place
 * any of this is authored. Adding a set() here that no screen in this app
 * calls is exactly what repositories.js's own "add it when the module that
 * needs it arrives" rule exists to prevent.
 */

import {
    collection, doc, getDoc, getDocs
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import { firestore } from '../core/firebase.js';

const COLLECTION_NAME = 'siteContent';
const siteContentCollection = collection(firestore, COLLECTION_NAME);

export const siteContent$ = {
    /**
     * @param {string} key       An editorial module key — see
     *   publicContent.config.js's EDITORIAL_MODULES.
     * @param {*} [fallback]     Returned when the key has never been published.
     *   Callers pass a real default rather than null — an unpublished page
     *   should render an honest empty state, not throw at a prospective
     *   parent who is three taps into their first visit.
     */
    async get(key, fallback = null) {
        const snap = await getDoc(doc(firestore, COLLECTION_NAME, key));
        return snap.exists() ? snap.data().value : fallback;
    },

    /** Every published key. One row per document, matching settings$.all(). */
    async all() {
        const snap = await getDocs(siteContentCollection);
        return snap.docs.map((d) => ({ key: d.id, ...d.data() }));
    }
};
