/**
 * Natyam ERP v3 — Mobile — Parent profile service
 *
 * Answers one question, and deliberately only one: **has this parent been
 * here before?**
 *
 * That decides whether a first-time parent sees the Welcome screen or goes
 * straight to what they were doing. It does NOT decide which experience they
 * get — that is the staff → guardian → applicant chain in js/app.js, and it
 * stays the single place identity is resolved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A PROFILE IS NOT A DASHBOARD KEY
 *
 * A profile is created when a parent submits an application or an enquiry.
 * Neither of those gives them a child at the school — approval and enrolment
 * are separate, staff-driven steps that may never happen. So a profile on its
 * own means "we have met", not "you have a student here".
 *
 * Routing a profile-holder to the Parent Dashboard would therefore show
 * someone My Child, Attendance, Fees and Certificates for a child that does
 * not exist yet — the exact screens the brief's Experience 2 says a
 * prospective parent must not see, and empty ones at that. The Parent
 * Dashboard remains gated on real guardianship: a phone or email matching an
 * ACTIVE student, checked by guardianAuth.service.js.
 *
 * So the two questions compose rather than compete:
 *
 *   linked to a student?  →  which experience   (portal vs applicant)
 *   has a profile?        →  whether to welcome (Welcome vs straight in)
 * ─────────────────────────────────────────────────────────────────────────
 */

import { parentProfiles$ } from '../data/repositories.js';

/**
 * Has this parent completed something before?
 *
 * A read failure resolves to `false` rather than throwing. The cost of being
 * wrong is asymmetric and worth choosing deliberately: a returning parent
 * shown the Welcome screen once more loses a tap, while an error screen on
 * sign-in loses the parent. The Welcome screen's own actions lead where they
 * were going anyway.
 *
 * @param {{email: string}} identity
 * @returns {Promise<boolean>}
 */
export async function hasParentProfile(identity) {
    const email = String(identity?.email || '').trim().toLowerCase();
    if (!email) return false;

    try {
        return Boolean(await parentProfiles$.find(email));
    } catch (err) {
        console.error('Could not read the parent profile', err);
        return false;
    }
}

/**
 * Records that this parent has now done something real — submitted an
 * admission application, or an enquiry. Creates the profile if it is their
 * first, and updates `lastSeenAt`/`lastAction` if it is not.
 *
 * FAILURE IS SWALLOWED, and that is the whole point of where this sits in the
 * flow. It runs AFTER the application or enquiry has been written, and that
 * write is what the parent actually came to do. A profile that fails to save
 * costs them one extra Welcome screen next time; an exception here would turn
 * a successful submission into a visible error. Logged loudly, because a
 * profile that never saves means every visit looks like a first visit.
 *
 * @param {{email: string, name?: string}} identity
 * @param {'application'|'enquiry'} action
 */
export async function recordParentEngagement(identity, action) {
    const email = String(identity?.email || '').trim().toLowerCase();
    if (!email) return null;

    try {
        return await parentProfiles$.record(email, {
            name: identity.name || '',
            lastAction: action
        });
    } catch (err) {
        console.error(
            `Could not record the parent profile for ${email}. Their ${action} was saved; `
            + 'they may simply see the welcome screen again next time.',
            err
        );
        return null;
    }
}
