/**
 * Natyam ERP v3 — Mobile — Applicant profile
 *
 * Deliberately thin. An applicant has no role, no branch, no capabilities and
 * no child on file — there is nothing here to configure, and inventing
 * settings for a session that owns no data would be padding.
 *
 * What it does have is the two things this screen exists for: confirmation of
 * which account the school will contact, and a way out.
 *
 * The Google account is shown read-only on purpose. It is not an editable
 * profile field — it is the identity Firebase verified, the address
 * firestore.rules matches against `submittedByEmail` to let this person read
 * their own applications back, and changing it would silently orphan them.
 * The contact details the school actually uses are the ones given on each
 * application, which is where they can be corrected.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { logout } from '../../services/auth.service.js';
import { applicantSession } from '../../services/admissions.parent.service.js';

export default class ApplicantProfilePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'My account';
        this.identity = applicantSession.identity();
    }

    async render(container) {
        this.container = container;

        render(container, html`
            <div class="m-card" style="padding:18px; text-align:center;">
                <div class="m-avatar" style="margin:0 auto 12px;">
                    ${raw(icon('user', { size: 20 }))}
                </div>
                <p style="margin:0 0 4px; font-weight:600;">${this.identity.name || 'Signed in'}</p>
                <p style="margin:0; font-size:13px; opacity:.75;">${this.identity.email || ''}</p>
            </div>

            <div class="m-card" style="padding:16px; margin-top:12px;">
                <p class="m-field-help" style="margin:0;">
                    This is the Google account the school will use to reach you about your
                    application. Contact details for each child are taken from the
                    application itself.
                </p>
            </div>

            <div class="p-actions" style="margin-top:16px;">
                <a class="m-btn m-btn-ghost m-btn-block" href="#/">Back to my applications</a>
                <button class="m-btn m-btn-ghost m-btn-block" data-action="sign-out">Sign out</button>
            </div>
        `);
    }
}
