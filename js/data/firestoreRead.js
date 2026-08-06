/**
 * NATYAM ERP v3 — Firestore reads with a deadline (BUG-302)
 *
 * THE BUG THIS EXISTS FOR. Every screen in this app is shaped
 * "paint skeleton -> await read -> paint content". That is only safe if the
 * read is guaranteed to settle. A Firestore read is not: the SDK retries a
 * stalled request indefinitely and never rejects, so on a flaky mobile
 * connection the await simply never returns and the skeleton becomes
 * permanent. There is no error to catch, which is why no amount of
 * try/catch in the pages ever fixed it, and why navigating away and back was
 * the only recovery — that issues a fresh query the stalled one was never
 * going to produce.
 *
 * So the fix cannot live in the pages. It has to live at the read itself,
 * which is here.
 *
 * WHY THE NAMES MATCH THE SDK'S. `getDoc` and `getDocs` are re-exported
 * under their own names with their own signatures, so the 27 repositories
 * change one import line each and none of their ~180 call sites change at
 * all. A wrapper that needed every call rewritten would have been reviewed
 * once and then quietly bypassed by the next repository someone added.
 * Importing from here has to be the path of least resistance or it will not
 * hold.
 *
 * WHAT IT DOES NOT DO. It cannot cancel the underlying request — Firestore
 * has no abort — so an abandoned attempt still completes in the background
 * and still bills a read. This trades that cost for a screen that always
 * resolves, which is the right trade at the volumes involved.
 */

import {
    getDoc as sdkGetDoc,
    getDocs as sdkGetDocs
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

/**
 * Long enough that a slow-but-working 3G read is never cut off, short enough
 * that a person does not sit in front of a skeleton wondering whether the app
 * is broken. Firestore's own median read here is well under a second; a read
 * still outstanding at twelve seconds is stalled, not slow.
 */
export const READ_DEADLINE_MS = 12000;

/**
 * Distinguishable from a Firestore error on purpose. Callers that want to
 * treat "the network stalled" differently from "you are not allowed to read
 * this" — the retry affordance in the pages does — need to tell them apart,
 * and matching on message text would break the first time the wording
 * changed.
 */
export class ReadTimeoutError extends Error {
    constructor(target) {
        super(`This is taking longer than expected — ${target} did not respond.`);
        this.name = 'ReadTimeoutError';
        this.target = target;
        this.isTimeout = true;
    }
}

/** True for the error above, including across a structured clone. */
export function isReadTimeout(err) {
    return Boolean(err && err.isTimeout);
}

/**
 * Best-effort human label for whatever was being read, used only in the error
 * message. Wrapped in its own try because a shape change in the SDK's
 * internals must not turn a timeout into a different, more confusing crash.
 */
function describe(target) {
    try {
        if (typeof target?.path === 'string') return target.path;
        const segments = target?._query?.path?.segments;
        if (Array.isArray(segments) && segments.length) return segments.join('/');
        return 'the server';
    } catch {
        return 'the server';
    }
}

/**
 * Races the read against the deadline.
 *
 * Deliberately not Promise.race alone: the loser has to be neutralised, or a
 * read that resolves at 12.1s would still call back into a page that has
 * already shown its error and moved on. `settled` makes the first outcome the
 * only outcome.
 */
function withDeadline(run, label, ms) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new ReadTimeoutError(label));
        }, ms);

        run().then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

/**
 * One deadline, then one retry, then give up.
 *
 * The retry is only for timeouts. A stalled webchannel usually recovers on a
 * second attempt, so retrying repairs the common case before the user ever
 * sees it. Every other failure — permission denied, malformed query, offline
 * with no cache — is deterministic: retrying it wastes another read and
 * delays an error that was never going to change.
 *
 * Exported, and taking its deadline as an argument, so the timing and retry
 * behaviour can be exercised directly against a promise that never settles.
 * Testing it through a real Firestore call is not possible: the SDK serves a
 * warm collection from its in-memory cache without touching the network, so a
 * blocked transport proves nothing.
 */
export async function readWithRetry(run, target, ms = READ_DEADLINE_MS) {
    const label = describe(target);
    try {
        return await withDeadline(run, label, ms);
    } catch (err) {
        if (!isReadTimeout(err)) throw err;
        console.warn(`Read of ${label} timed out after ${ms}ms — retrying once.`);
        return withDeadline(run, label, ms);
    }
}

/** Drop-in for the SDK's getDoc. */
export function getDoc(reference) {
    return readWithRetry(() => sdkGetDoc(reference), reference);
}

/** Drop-in for the SDK's getDocs. */
export function getDocs(queryOrCollection) {
    return readWithRetry(() => sdkGetDocs(queryOrCollection), queryOrCollection);
}
