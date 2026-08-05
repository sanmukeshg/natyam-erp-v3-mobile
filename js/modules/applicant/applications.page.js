/**
 * Natyam ERP v3 — Mobile — My applications (parent self-service)
 *
 * This experience's home screen, and it is deliberately a status screen
 * rather than a dashboard. Someone here has applied, or is about to; the only
 * questions they have are "did it arrive?" and "what happens next?".
 *
 * STATUS IS SHOWN IN A FAMILY'S LANGUAGE, not the pipeline's — see
 * admissions.parent.service.js's parentStatusLabel(). In particular
 * `submitted` and `reviewing` are both shown as "Received": from outside the
 * school those feel identical, and a parent watching one change to the other
 * learns nothing they can act on. `nextActionFor()` is loaded but never
 * rendered here; it describes what STAFF do next, and telling a parent to
 * "Begin review" would be nonsense.
 *
 * The reference shown is the Firestore document id until the Desktop ERP
 * allocates a real NAT/APP number at review — deliberate, per the numbering
 * decision: one numbering mechanism, staff-controlled, and nothing a parent
 * can claim.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { myApplications, applicantSession } from '../../services/admissions.parent.service.js';
import { formatDateLong } from '../../utils/date.js';
import { PUBLIC_MODULES } from '../../config/publicContent.config.js';

export default class ApplicantApplicationsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'My applications';
        this.identity = applicantSession.identity();
        this.rows = null;
        this.failed = false;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-card m-skeleton" style="height:120px;"></div>`);

        try {
            this.rows = await myApplications(this.identity);
        } catch (err) {
            console.error('Could not load applications', err);
            this.failed = true;
        }

        if (this.disposed) return;
        this.paint();
    }

    paint() {
        if (this.failed) {
            render(this.container, html`
                <div class="m-error">
                    <p style="margin:0 0 10px;">We could not load your applications just now.</p>
                    <button class="m-btn m-btn-sm" onclick="location.reload()">Try again</button>
                </div>
            `);
            return;
        }

        const rows = this.rows || [];

        render(this.container, html`
            ${rows.length ? '' : html`
                <div class="m-card m-empty">
                    <div style="margin:0 0 10px; opacity:.7;">${raw(icon('feather', { size: 22 }))}</div>
                    <p style="margin:0 0 6px;"><strong>You have not applied yet.</strong></p>
                    <p style="margin:0 0 14px;">Start an admission application and the school will be in touch.</p>
                </div>
            `}

            <div class="m-stack">
                ${rows.map((row) => html`
                    <article class="m-card" style="padding:16px;">
                        <h2 class="m-card-title">${row.name}</h2>
                        <p class="m-card-meta">${row.levelLabel || '—'}${row.preferredBranch ? ` · ${row.preferredBranch}` : ''}</p>

                        <div style="margin:12px 0;">
                            <span class="m-badge">${row.statusLabel}</span>
                        </div>

                        <p style="margin:0 0 12px; font-size:13px; line-height:1.55;">${row.statusNote}</p>

                        <dl class="m-facts">
                            <div class="m-fact">
                                <dt>${row.numbered ? 'Application no.' : 'Reference'}</dt>
                                <dd>${row.reference}</dd>
                            </div>
                            ${row.appliedOn ? html`
                                <div class="m-fact"><dt>Applied</dt><dd>${formatDateLong(row.appliedOn)}</dd></div>
                            ` : ''}
                        </dl>

                        ${row.numbered ? '' : html`
                            <p class="m-field-help" style="margin-top:10px;">
                                The school will issue a formal application number when they begin reviewing.
                            </p>
                        `}
                    </article>
                `)}
            </div>

            <div class="p-actions" style="margin-top:16px;">
                <a class="m-btn m-btn-block p-action-primary" href="#/apply">
                    ${raw(icon('user-plus', { size: 18 }))}
                    <span>${rows.length ? 'Apply for another child' : 'Start an application'}</span>
                </a>
            </div>

            <!--
              Repeated from the Welcome screen deliberately. A returning parent
              skips Welcome entirely (that is the whole point of the parent
              profile), so this is the only place they can reach the school's
              own pages once they have applied — and "when does the Saturday
              batch run" is a question people ask after applying, not only
              before.
            -->
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
        `);
    }
}
