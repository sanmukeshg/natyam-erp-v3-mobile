/**
 * Natyam ERP v3 — Mobile — Admission application (parent self-service)
 *
 * Three steps on a phone, not the desktop wizard's nine. The reduction is not
 * a simplification for its own sake — see admissions.parent.service.js for
 * what a parent genuinely cannot supply (fee plan, branch id, application
 * number) and why each is Reception's to fill in later.
 *
 * ONE STEP AT A TIME, because a long form on a phone that validates only at
 * the end is a form people abandon. Moving forward validates the step just
 * completed, using the same rules the desktop wizard applies to the same
 * fields — validateParentStep() delegates the applicant step straight to
 * admissions.service.js, so the age limits and phone rules cannot drift.
 *
 * Answers live in `this.data` and survive moving back and forth. They do NOT
 * survive a reload: /admissionDrafts is staff-gated, so there is nowhere to
 * put a draft, and three short steps is a length someone finishes in one
 * sitting. Documented rather than hidden — see the note in the header of
 * admissions.parent.service.js.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import {
    PARENT_STEPS, validateParentStep, submitSelfApplication,
    levelOptions, branchOptions, applicantSession
} from '../../services/admissions.parent.service.js';

/**
 * Gender and relationship vocabularies, matching the Desktop ERP's admission
 * form exactly (natyam-admin's admissions.page.js) so a parent-submitted
 * application carries the same stored values a walk-in does. Neither exists
 * as a shared constant in app.config.js today; kept local rather than
 * inventing a config export this stage has no other use for.
 */
const GENDERS = Object.freeze([
    { value: 'female', label: 'Female' },
    { value: 'male', label: 'Male' },
    { value: 'other', label: 'Other' }
]);

const RELATIONSHIPS = Object.freeze(
    ['Mother', 'Father', 'Grandparent', 'Guardian', 'Sibling'].map((r) => ({ value: r, label: r }))
);

export default class ApplicantApplyPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Admission application';
        this.identity = applicantSession.identity();
        this.stepIndex = 0;

        /*
         * Seeded with the signed-in Google account — UAT6, when the email
         * became required.
         *
         * The address is already known: the parent signed in with it, and
         * submitSelfApplication() has always fallen back to it. Making the
         * field required without filling it would have asked a family to type
         * something the app was about to supply anyway. Editable, because the
         * account they sign in with is not always the address they want the
         * school writing to.
         */
        this.data = { guardianEmail: this.identity.email || '' };
        this.errors = {};
        this.branches = [];
        this.busy = false;
    }

    async render(container) {
        this.container = container;
        this.paint();

        // Fetched once, not per repaint: the branch list comes from published
        // Website Content and cannot change mid-form.
        this.branches = await branchOptions().catch(() => []);
        if (this.disposed) return;
        this.paint();
        this.bind();
    }

    step() { return PARENT_STEPS[this.stepIndex]; }

    bind() {
        if (this.bound) return;
        this.bound = true;

        // Values are read on navigation rather than on every keystroke: a
        // controlled re-render per character would move the caret and reopen
        // the keyboard on a phone.
        on(this.container, 'click', '[data-action="next"]', () => this.next());
        on(this.container, 'click', '[data-action="back"]', () => this.back());
        on(this.container, 'click', '[data-action="submit"]', () => this.submit());
    }

    /** Reads whatever the current step's inputs hold into `this.data`. */
    collect() {
        this.container.querySelectorAll('[data-field]').forEach((node) => {
            this.data[node.dataset.field] = node.value;
        });
    }

    next() {
        this.collect();
        const result = validateParentStep(this.step().key, this.data);
        this.errors = result.errors;
        if (!result.ok) { this.paint(); return; }

        this.stepIndex = Math.min(this.stepIndex + 1, PARENT_STEPS.length - 1);
        this.errors = {};
        this.paint();
    }

    back() {
        this.collect();
        this.stepIndex = Math.max(this.stepIndex - 1, 0);
        this.errors = {};
        this.paint();
    }

    async submit() {
        this.collect();
        this.busy = true;
        this.paint();

        try {
            const created = await submitSelfApplication(this.data, this.identity);
            toast.success('Application sent', `${created.name} — the school will be in touch.`);
            // Straight to the status list, which is this experience's home:
            // the thing a parent wants immediately after submitting is proof
            // that it arrived.
            this.context.router.go('/');
        } catch (err) {
            this.busy = false;
            this.paint();
            toast.error(err.message);
        }
    }

    /* ---------------------------------------------------------------- VIEW */

    field(name, label, { type = 'text', required = false, placeholder = '', options = null } = {}) {
        const value = this.data[name] || '';
        const error = this.errors[name];

        const input = options
            ? html`
                <select class="m-input" data-field="${name}">
                    <option value="">Choose…</option>
                    ${options.map((o) => html`
                        <option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>
                    `)}
                </select>`
            : html`<input class="m-input" type="${type}" data-field="${name}"
                          value="${value}" placeholder="${placeholder}">`;

        return html`
            <div class="m-field">
                <label class="m-field-label">${label}${required ? ' *' : ''}</label>
                ${input}
                ${error ? html`<p class="m-field-error">${error}</p>` : ''}
            </div>
        `;
    }

    paint() {
        const step = this.step();
        const last = this.stepIndex === PARENT_STEPS.length - 1;

        render(this.container, html`
            <div class="m-subhead">
                <p class="m-subhead-note">Step ${this.stepIndex + 1} of ${PARENT_STEPS.length} · ${step.label}</p>
            </div>

            <div class="m-card" style="padding:16px;">
                ${step.key === 'applicant' ? this.applicantStep() : ''}
                ${step.key === 'placement' ? this.placementStep() : ''}
                ${step.key === 'review' ? this.reviewStep() : ''}
            </div>

            <div class="p-actions" style="margin-top:14px;">
                ${last
                    ? html`<button class="m-btn m-btn-block p-action-primary" data-action="submit"
                                   ${this.busy ? 'disabled' : ''}>
                             ${this.busy ? 'Sending…' : 'Submit application'}
                           </button>`
                    : html`<button class="m-btn m-btn-block p-action-primary" data-action="next">Continue</button>`}
                ${this.stepIndex > 0
                    ? html`<button class="m-btn m-btn-ghost m-btn-block" data-action="back">Back</button>`
                    : ''}
            </div>
        `);
    }

    applicantStep() {
        return html`
            ${this.field('name', 'Child’s full name', { required: true })}
            ${this.field('dateOfBirth', 'Date of birth', { type: 'date', required: true })}
            ${this.field('gender', 'Gender', { required: true, options: GENDERS })}
            ${this.field('guardianName', 'Your name', { required: true })}
            ${this.field('guardianRelation', 'Your relationship to the child', {
                required: true, options: RELATIONSHIPS })}
            ${this.field('guardianPhone', 'Contact number', { type: 'tel', required: true, placeholder: '+91…' })}
            <!--
              Required since UAT6, and PRE-FILLED so that costs the family
              nothing. It was a placeholder before — grey text that looks like
              an answer and is not one — with submitSelfApplication() quietly
              falling back to the signed-in address if it was left blank.

              That fallback still exists as a safety net, but the address is now
              on screen as a real value the parent can see and correct. Some
              families apply from one Google account and want the school to
              write to another; a placeholder gave them no way to notice.
            -->
            ${this.field('guardianEmail', 'Email', { type: 'email', required: true })}
        `;
    }

    placementStep() {
        return html`
            ${this.field('level', 'Which level would you like to start at?', {
                required: true, options: levelOptions() })}

            ${this.branches.length
                ? this.field('preferredBranch', 'Which branch?', {
                    required: true,
                    options: this.branches.map((b) => ({ value: b, label: b })) })
                : html`
                    <div class="m-notice">
                        <p style="margin:0;">The school has not published its branch list yet —
                        leave this and Reception will confirm a branch with you.</p>
                    </div>
                    ${this.field('preferredBranch', 'Preferred branch', { required: true })}`}

            ${this.field('previousExperience', 'Any previous dance experience? (optional)')}
        `;
    }

    reviewStep() {
        const rows = [
            ['Child', this.data.name],
            ['Date of birth', this.data.dateOfBirth],
            ['Level', levelOptions().find((l) => l.value === this.data.level)?.label],
            ['Branch', this.data.preferredBranch],
            ['You', this.data.guardianName],
            ['Contact', this.data.guardianPhone]
        ].filter(([, v]) => v);

        return html`
            <p style="margin:0 0 12px;">Please check these details before sending.</p>
            <dl class="m-facts">
                ${rows.map(([label, value]) => html`
                    <div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>
                `)}
            </dl>
            <p class="m-field-help" style="margin-top:12px;">
                ${raw(icon('info', { size: 13 }))}
                The school will contact you after reviewing your application.
            </p>
        `;
    }
}
