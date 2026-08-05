/**
 * Natyam ERP v3 — Mobile — First-time parent welcome
 *
 * Shown once: the first time someone signs in who has no parent profile yet
 * — meaning they have never submitted an application or an enquiry. From
 * their second visit onward, applicantShell's route resolution sends them
 * straight to My Applications instead.
 *
 * WHY A SCREEN RATHER THAN A DROP INTO THE FORM. Someone arriving here has
 * just signed in with Google having tapped "Apply Now" or "Sign in", and the
 * school knows nothing about them. Two things can happen next and they are
 * genuinely different commitments: a full admission application, or a
 * question. Landing straight in a nine-field form presumes the first, and a
 * parent who only wanted to ask about timings has to work out how to escape
 * it. One screen, two doors, no reading required.
 *
 * NEITHER ACTION CREATES THE PROFILE. It is written when they finish
 * something — see parent.service.js's recordParentEngagement() — so abandoning
 * the form here leaves them a first-time parent, and they get this screen
 * again rather than a half-onboarded state nobody can explain.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { applicantSession } from '../../services/admissions.parent.service.js';
import { PUBLIC_MODULES } from '../../config/publicContent.config.js';

export default class ApplicantWelcomePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Welcome';
        this.identity = applicantSession.identity();
    }

    async render(container) {
        const first = (this.identity.name || '').trim().split(/\s+/)[0] || '';

        render(container, html`
            <section class="p-hero">
                <h1 class="p-hero-title">Welcome to Natyam School of Kuchipudi</h1>
                <p class="p-hero-sub">
                    ${first ? `${first}, we’re` : 'We’re'} delighted to welcome you to our academy.
                </p>
            </section>

            <div class="m-card" style="padding:18px; text-align:center;">
                <p style="margin:0; font-size:15px; font-weight:600;">How would you like to begin?</p>
            </div>

            <div class="p-actions" style="margin-top:16px;">
                <a class="m-btn m-btn-block p-action-primary" href="#/apply">
                    ${raw(icon('user-plus', { size: 18 }))}
                    <span>Apply for Admission</span>
                </a>
                <a class="m-btn m-btn-ghost m-btn-block" href="#/enquiry">
                    ${raw(icon('mail', { size: 18 }))}
                    <span>Make an Enquiry</span>
                </a>
            </div>

            <h2 class="m-section-label" style="margin-top:22px;">About the academy</h2>

            <div class="m-stack">
                ${PUBLIC_MODULES.map((m) => html`
                    <a class="m-card m-quick" href="#${m.path}">
                        <span class="m-quick-icon p-module-icon">${raw(icon(m.icon, { size: 17 }))}</span>
                        <span class="p-module-text">
                            <span class="m-quick-label">${m.label}</span>
                            <span class="p-module-blurb">${m.blurb}</span>
                        </span>
                        <span class="p-module-chev">${raw(icon('chevron-right', { size: 16 }))}</span>
                    </a>
                `)}
            </div>

            <p class="m-field-help" style="margin-top:14px; text-align:center;">
                Signed in as ${this.identity.email || 'your Google account'}.
            </p>
        `);
    }
}
