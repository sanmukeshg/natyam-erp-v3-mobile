/**
 * Natyam ERP v3 — Mobile — Enquiry
 *
 * The lowest-commitment thing a stranger can do: leave a name and a number
 * and ask the school to call. Reception picks it up in the Desktop ERP.
 *
 * REACHED FROM TWO DIFFERENT ROUTERS, and it has to work identically on both:
 *
 *   public router     a visitor who has not signed in at all
 *   applicant router  a signed-in parent who chose "Make an Enquiry" on the
 *                     Welcome screen instead of applying
 *
 * The only difference between them is what happens AFTER a successful
 * submission — a signed-in parent stops being a first-time visitor, so their
 * parent profile is recorded; a signed-out one has no identity to record. The
 * form itself, the validation and the write are the same in both cases,
 * because firestore.rules' isPublicEnquiry() allows the create either way.
 *
 * DELIBERATELY SHORT. The brief says "collect only basic enquiry
 * information", and every additional required field is a person who closes
 * the page instead. Name and phone are the only mandatory ones; a branch
 * picker is absent on purpose — Reception establishes that on the call, and
 * an enquiry is a conversation the school has not had yet, not a form to be
 * completed.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { submitEnquiry, validateEnquiry } from '../../services/enquiry.service.js';
import { applicantSession } from '../../services/admissions.parent.service.js';
import { recordParentEngagement } from '../../services/parent.service.js';

export default class PublicEnquiryPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Enquiry';
        this.data = {};
        this.errors = {};
        this.busy = false;
        this.done = false;

        // Empty for a signed-out visitor, populated for a signed-in parent.
        // The page never branches on it beyond prefilling and the profile
        // write — see the header.
        this.identity = applicantSession.identity();
    }

    async render(container) {
        this.container = container;

        // A signed-in parent has already told us their email; asking again is
        // friction with no purpose.
        if (this.identity.email && !this.data.email) this.data.email = this.identity.email;
        if (this.identity.name && !this.data.name) this.data.name = this.identity.name;

        this.paint();

        on(container, 'click', '[data-action="send"]', () => this.send());
    }

    collect() {
        this.container.querySelectorAll('[data-field]').forEach((node) => {
            this.data[node.dataset.field] = node.value;
        });
    }

    async send() {
        this.collect();

        const check = validateEnquiry(this.data);
        this.errors = check.errors;
        if (!check.ok) { this.paint(); return; }

        this.busy = true;
        this.paint();

        try {
            await submitEnquiry(this.data);

            // Only meaningful for a signed-in parent — recordParentEngagement()
            // returns early without an email. Runs after the enquiry is safely
            // written and swallows its own failures, so a profile that does not
            // save costs one extra Welcome screen rather than turning a sent
            // enquiry into a visible error.
            if (this.identity.email) await recordParentEngagement(this.identity, 'enquiry');

            this.done = true;
            this.busy = false;
            this.paint();
        } catch (err) {
            this.busy = false;
            this.paint();
            toast.error(err.message);
        }
    }

    field(name, label, { type = 'text', required = false, placeholder = '', textarea = false } = {}) {
        const value = this.data[name] || '';
        const error = this.errors[name];

        return html`
            <div class="m-field">
                <label class="m-field-label">${label}${required ? ' *' : ''}</label>
                ${textarea
                    ? html`<textarea class="m-textarea" data-field="${name}"
                                     placeholder="${placeholder}" rows="3">${value}</textarea>`
                    : html`<input class="m-input" type="${type}" data-field="${name}"
                                  value="${value}" placeholder="${placeholder}">`}
                ${error ? html`<p class="m-field-error">${error}</p>` : ''}
            </div>
        `;
    }

    paint() {
        if (this.done) return this.paintDone();

        render(this.container, html`
            <div class="p-page-head">
                <h1 class="p-page-title">Make an enquiry</h1>
                <p class="p-page-sub">
                    Leave your details and the school will call you back.
                </p>
            </div>

            <div class="m-card" style="padding:16px;">
                ${this.field('name', 'Your name', { required: true })}
                ${this.field('phone', 'Contact number', { type: 'tel', required: true, placeholder: '+91…' })}
                ${this.field('email', 'Email (optional)', { type: 'email' })}
                ${this.field('courseInterest', 'Which course are you interested in? (optional)', {
                    placeholder: 'e.g. Foundation Level 1' })}
                ${this.field('message', 'Anything you would like to ask? (optional)', { textarea: true })}
            </div>

            <div class="p-actions" style="margin-top:14px;">
                <button class="m-btn m-btn-block p-action-primary" type="button"
                        data-action="send" ${this.busy ? 'disabled' : ''}>
                    ${this.busy ? 'Sending…' : 'Send enquiry'}
                </button>
            </div>
        `);
    }

    /**
     * Deliberately a whole screen rather than a toast. A toast disappears, and
     * the one thing someone needs after sending an enquiry to a school they
     * have never contacted is durable confirmation that it arrived.
     */
    paintDone() {
        render(this.container, html`
            <div class="m-card m-empty" style="padding:24px;">
                <div style="margin:0 0 12px; opacity:.8;">${raw(icon('check-circle', { size: 26 }))}</div>
                <p style="margin:0 0 6px;"><strong>Thank you — we have your enquiry.</strong></p>
                <p style="margin:0 0 16px;">
                    Someone from the school will call you on
                    ${this.data.phone || 'the number you gave'} shortly.
                </p>
                <a class="m-btn m-btn-sm" href="#/">Back</a>
            </div>
        `);
    }
}
