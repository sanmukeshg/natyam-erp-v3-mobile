/**
 * NATYAM ERP 2.0 — Parent/Student Portal: Certificates (Milestone P1)
 *
 * Milestone P2: reads via certificates$.forGuardian(phone, email) — every
 * one of the guardian's children's certificates, queried by
 * guardianPhone/guardianEmail directly on the certificate document
 * (required for firestore.rules to authorize the query at all, see
 * isGuardianOfRecord()'s comment) — then narrowed to the active child
 * client-side.
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';
import { EVENTS } from '../../core/bus.js';
import { formatDate } from '../../utils/date.js';
import { certificates$ } from '../../data/repositories.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';

export default class PortalCertificatesPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Certificates';
    }

    async render(container) {
        this.container = container;
        await this.load();
        this.events.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.load());
    }

    /**
     * One section per selected child. As on Attendance, forGuardian() already
     * returns every child's certificates in one read — only the filtering
     * changed, so "All children" costs no extra queries.
     */
    async load() {
        const students = guardianSession.selectedChildren();
        if (!students.length) { render(this.container, this.page([])); return; }

        const all = await certificates$.forGuardian(guardianSession.phone, guardianSession.email);
        if (this.disposed) return;

        render(this.container, this.page(students.map((student) => ({
            student,
            certificates: all.filter((c) => c.studentId === student.id)
        }))));
    }

    page(blocks) {
        const many = blocks.length > 1;

        return html`

            ${blocks.length ? blocks.map(({ student, certificates }) => html`
                <section class="m-stack" style="margin-bottom:20px;">
                    ${many ? html`<h2 class="m-section-label">${student.name}</h2>` : ''}
                    ${certificates.length ? html`
                        <div class="m-card"><div class="m-card-inner">
                            <ul>
                                ${certificates.map((c) => html`
                                    <li style="margin-top:6px;">
                                        <span class="m-card-title">${c.title}</span>
                                        <span class="m-card-meta"> — ${c.serial} · issued ${formatDate(c.issuedOn)}</span>
                                        ${c.status === 'revoked' ? html`<span class="m-badge">Revoked</span>` : ''}
                                    </li>
                                `)}
                            </ul>
                        </div></div>
                    ` : html`
                        <div class="m-card"><div class="m-card-inner">
                            No certificates issued to ${student.name} yet.
                        </div></div>
                    `}
                </section>
            `) : html`<div class="m-card m-empty">No certificates yet.</div>`}
        `;
    }
}
