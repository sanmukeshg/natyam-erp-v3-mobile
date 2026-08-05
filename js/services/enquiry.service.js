/**
 * Natyam ERP v3 — Mobile — Enquiry service
 *
 * "Collect only basic enquiry information" — a name, a number, and whatever
 * else the parent volunteers. This is the lowest-commitment thing a stranger
 * can do in the app, and the form is short on purpose: every extra required
 * field is a person who closes the page instead.
 *
 * WHERE THE RULES ABOUT AN ENQUIRY LIVE, AND WHY THERE IS ONLY ONE COPY.
 *
 * This file owns every decision about what an enquiry may contain: the
 * required fields, the messages, the trimming, the length caps, and the
 * business fact that a new enquiry is `new` and `public`. The repository
 * beneath it decides only how a document is persisted — it selects the
 * fields it was given and stamps the record, and re-checks nothing. That is
 * the Service/Repository split this codebase already draws everywhere else,
 * and it means a cap can only ever be changed in one place.
 *
 * THE ONE UNAVOIDABLE SECOND COPY is firestore.rules' isPublicEnquiry().
 * That is not duplicated logic, it is the security boundary: rules are the
 * only check a caller cannot skip, and a browser-side service can never be
 * one. The numbers in LIMITS below are written to match it exactly rather
 * than loosely, because a mismatch surfaces as "Missing or insufficient
 * permissions" on a stranger's first interaction with the school instead of
 * a field message. Change one, change the other.
 *
 * No session, no capability check, no audit entry: the caller has no account.
 * See enquiries.repository.firestore.js's header for what that changes.
 */

import { enquiries$ } from '../data/repositories.js';
import { ENQUIRY_STATUS } from '../config/app.config.js';

/** Matches firestore.rules' isPublicEnquiry() exactly. */
const LIMITS = Object.freeze({
    name: 120,
    phone: 20,
    email: 160,
    message: 1000,
    branchId: 64,
    courseInterest: 120
});

/** Same shape as admissions.service.js's validateStep() — problems returned,
 *  not thrown, so a form can mark every bad field at once rather than
 *  stopping at the first. */
export function validateEnquiry(data) {
    const errors = {};

    const name = String(data.name ?? '').trim();
    if (!name) errors.name = 'Please tell us your name.';
    else if (name.length < 2) errors.name = 'Please enter your full name.';
    else if (name.length > LIMITS.name) errors.name = `A name can be at most ${LIMITS.name} characters.`;

    // Counted in digits, not characters, so "98765 43210" and "+91 98765
    // 43210" both pass — people type a number the way they say it. The
    // repository stores what was typed (trimmed); Reception dials it.
    const phone = String(data.phone ?? '').trim();
    const digits = phone.replace(/\D/g, '');
    if (!phone) errors.phone = 'Please give us a number we can call you on.';
    else if (digits.length < 10) errors.phone = 'A contact number needs at least 10 digits.';
    else if (phone.length > LIMITS.phone) errors.phone = 'That number looks too long — please check it.';

    const email = String(data.email ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        errors.email = 'That email address does not look right.';
    } else if (email.length > LIMITS.email) {
        errors.email = `An email address can be at most ${LIMITS.email} characters.`;
    }

    const message = String(data.message ?? '').trim();
    if (message.length > LIMITS.message) {
        errors.message = `Please keep your message under ${LIMITS.message} characters.`;
    }

    const courseInterest = String(data.courseInterest ?? '').trim();
    if (courseInterest.length > LIMITS.courseInterest) {
        errors.courseInterest = 'That course name is too long.';
    }

    return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Files the enquiry. Reception picks it up from the Desktop ERP; nothing else
 * happens automatically — in particular no Admission and no Student record is
 * created here, and none should be. An enquiry is a conversation the school
 * has not had yet.
 *
 * No duplicate check, unlike admissions.service.js's submit(): detecting one
 * would mean reading the enquiries collection, which an unauthenticated
 * caller cannot do and should not be able to. A parent who taps twice
 * produces two rows, and Reception sees two rows with the same number a
 * second apart — an obvious, harmless duplicate, and a far better outcome
 * than opening this collection to be read by anyone.
 *
 * @param {object} data
 * @param {string} data.name              Required.
 * @param {string} data.phone             Required.
 * @param {string} [data.email]
 * @param {string} [data.message]
 * @param {string} [data.branchId]        The branch they asked about, if any.
 * @param {string} [data.courseInterest]  Free text — the course as the parent
 *   named it, not a programme id. They are choosing from a public page, not
 *   from the school's own catalogue.
 * @returns {Promise<object>} the created enquiry, including its Firestore id.
 */
export async function submitEnquiry(data) {
    const check = validateEnquiry(data);
    if (!check.ok) {
        throw new Error(Object.values(check.errors)[0]);
    }

    return enquiries$.create(normalise(data));
}

/**
 * The complete business payload, built once here so the repository never has
 * to re-derive or re-check any of it.
 *
 * Optional text becomes null rather than '', so whatever reads these in the
 * Desktop ERP tests one thing instead of two. The caps are applied after
 * validation deliberately: validateEnquiry() has already rejected anything
 * genuinely over-long with a message a person can act on, so a slice here is
 * only ever a last guard against the field being reached another way — it
 * should never silently truncate something a parent typed and saw accepted.
 */
function normalise(data) {
    const optional = (value, max) => {
        const trimmed = String(value ?? '').trim();
        return trimmed ? trimmed.slice(0, max) : null;
    };

    return {
        name: String(data.name ?? '').trim().slice(0, LIMITS.name),
        phone: String(data.phone ?? '').trim().slice(0, LIMITS.phone),
        email: optional(data.email, LIMITS.email),
        message: optional(data.message, LIMITS.message),
        branchId: optional(data.branchId, LIMITS.branchId),
        courseInterest: optional(data.courseInterest, LIMITS.courseInterest),

        // Business facts, not persistence details: a new enquiry is always
        // untouched and always came from the public app. firestore.rules
        // requires exactly these two values on create.
        status: ENQUIRY_STATUS.NEW,
        source: 'public'
    };
}
