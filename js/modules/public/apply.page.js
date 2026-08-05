/**
 * Natyam ERP v3 — Mobile — Apply Now (public entry to the admission journey)
 *
 * The hinge of the brief's decision flow:
 *
 *     Apply Now → Google Sign In → Is Parent Linked To Student?
 *                                     YES → existing Parent Dashboard
 *                                     NO  → Admission Application
 *
 * THIS PAGE DOES NOT MAKE THAT DECISION, and deliberately holds none of the
 * branching. Its whole job is to start the sign-in; what the resulting
 * identity means is decided in exactly one place — app.js's single
 * onAuthStateChanged listener, which already resolves staff, then guardians,
 * then applicants, in that order. Two places deciding what a signed-in user
 * is would eventually disagree, and the one that disagreed silently would be
 * the one that mattered.
 *
 * So a parent who already has a child at the school and taps Apply Now lands
 * on their own Parent Dashboard rather than a second application form —
 * without this file knowing anything about it.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { signIn } from '../../services/auth.service.js';

/** Google's standard multi-colour mark, matching the login screen's. */
const GOOGLE_G_ICON = `
<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.581C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
</svg>`;

export default class PublicApplyPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Apply Now';
        this.busy = false;
    }

    async render(container) {
        this.container = container;
        this.paint();

        on(container, 'click', '[data-action="google"]', () => this.start());
    }

    async start() {
        this.busy = true;
        this.paint();

        try {
            await signIn('google');
            // Left in its loading state on purpose. A successful sign-in fires
            // Firebase's auth-state change, and app.js replaces this entire
            // screen — repainting here would flash a form nobody will see.
        } catch (err) {
            this.busy = false;
            this.paint();

            // A closed popup is not an error worth showing — the person
            // changed their mind, and Firebase's auth state never moved, so
            // app.js's listener will not fire for it either.
            if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;

            this.error = 'Could not open Google sign-in. Check your connection and try again.';
            this.paint();
        }
    }

    paint() {
        render(this.container, html`
            <div class="p-page-head">
                <h1 class="p-page-title">Apply to Natyam</h1>
                <p class="p-page-sub">
                    Sign in with Google to start an admission application. You will be
                    able to come back and check its progress at any time.
                </p>
            </div>

            ${this.error ? html`<div class="m-error" style="margin-bottom:12px;">${this.error}</div>` : ''}

            <div class="p-actions">
                <button class="m-btn m-btn-block p-action-primary" type="button"
                        data-action="google" ${this.busy ? 'disabled' : ''}>
                    ${raw(GOOGLE_G_ICON)}
                    <span>${this.busy ? 'Opening Google…' : 'Continue with Google'}</span>
                </button>
            </div>

            <div class="m-card" style="padding:16px; margin-top:16px;">
                <p class="m-field-help" style="margin:0 0 8px;">
                    ${raw(icon('info', { size: 13 }))}
                    Already have a child at Natyam?
                </p>
                <p style="margin:0; font-size:13px; line-height:1.55;">
                    Sign in with the same account the school has on file and you will go
                    straight to your child’s page instead.
                </p>
            </div>
        `);
    }
}
