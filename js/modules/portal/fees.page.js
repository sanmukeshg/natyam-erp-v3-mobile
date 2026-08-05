/**
 * NATYAM ERP 2.0 — Parent/Student Portal: Fees (Milestone P1)
 *
 * Milestone P2: reads via fees.service.js's guardianFeeSummary(phone,
 * email, student), which sources invoices/payments from their own
 * guardian-scoped forGuardian() queries (guardianPhone/guardianEmail
 * directly on the document, required for firestore.rules to authorize the
 * query at all) rather than studentFeeSummary()'s studentId-filtered ones.
 * View-only by construction: nothing on this page can collect, refund, or
 * waive a fee, since this file never imports anything that could.
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney } from '../../utils/money.js';
import { formatDate } from '../../utils/date.js';
import { guardianFeeSummary } from '../../services/fees.service.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';

export default class PortalFeesPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Fees';
    }

    async render(container) {
        this.container = container;
        await this.load();
        this.events.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.load());
    }

    /**
     * Unlike Attendance and Certificates, the fee summary is computed per
     * student, so "All children" genuinely costs one call each — run in
     * parallel, and each one allowed to fail on its own so a single broken
     * summary does not blank the whole page.
     */
    async load() {
        const students = guardianSession.selectedChildren();
        if (!students.length) { render(this.container, this.page([])); return; }

        const results = await Promise.all(students.map((s) =>
            guardianFeeSummary(guardianSession.phone, guardianSession.email, s).catch(() => null)));
        if (this.disposed) return;

        render(this.container, this.page(students.map((student, i) => ({ student, fees: results[i] }))));
    }

    page(blocks) {
        const many = blocks.length > 1;

        // What a parent of four actually wants first is the household total —
        // "how much do I owe" is one question, not four. The per-child
        // breakdown follows for anyone who needs to see where it sits.
        const totals = blocks.reduce((sum, b) => ({
            outstanding: sum.outstanding + (b.fees?.outstanding || 0),
            overdue: sum.overdue + (b.fees?.overdue || 0)
        }), { outstanding: 0, overdue: 0 });

        return html`

            ${many ? html`
                <div class="m-stack" style="margin-bottom:20px;">
                    <h2 class="m-section-label">Household total</h2>
                    <div class="m-stack">
                        <div class="m-card"><div class="m-card-inner">
                            <div class="m-card-meta">Outstanding</div>
                            <div class="m-card-title">${formatMoney(totals.outstanding)}</div>
                        </div></div>
                        <div class="m-card"><div class="m-card-inner">
                            <div class="m-card-meta">Overdue</div>
                            <div class="m-card-title">${formatMoney(totals.overdue)}</div>
                        </div></div>
                    </div>
                </div>
            ` : ''}

            ${blocks.length
                ? blocks.map(({ student, fees }) => html`
                    <section style="margin-bottom:20px;">
                        ${many ? html`<h2 class="m-section-label">${student.name}</h2>` : ''}
                        ${this.childFees(fees)}
                    </section>
                `)
                : html`<div class="m-card m-empty">No fee records yet.</div>`}
        `;
    }

    childFees(fees) {
        return html`
            <div class="m-stack">
                ${fees ? html`
                    <div class="m-stack">
                        <div class="m-card"><div class="m-card-inner">
                            <div class="m-card-meta">Billed</div>
                            <div class="m-card-title">${formatMoney(fees.billed)}</div>
                        </div></div>
                        <div class="m-card"><div class="m-card-inner">
                            <div class="m-card-meta">Collected</div>
                            <div class="m-card-title">${formatMoney(fees.collected)}</div>
                        </div></div>
                        <div class="m-card"><div class="m-card-inner">
                            <div class="m-card-meta">Outstanding</div>
                            <div class="m-card-title">${formatMoney(fees.outstanding)}</div>
                        </div></div>
                        <div class="m-card"><div class="m-card-inner">
                            <div class="m-card-meta">Overdue</div>
                            <div class="m-card-title">${formatMoney(fees.overdue)}</div>
                        </div></div>
                    </div>
                    ${fees.oldestDue ? html`
                        <p class="m-card-meta" style="margin-top:8px;">Oldest amount due: ${formatDate(fees.oldestDue)}</p>
                    ` : ''}
                    <div class="m-card" style="margin-top:12px;"><div class="m-card-inner">
                        <h3 class="m-card-title">History</h3>
                        ${fees.timeline?.length ? html`
                            <ul style="margin-top:12px;">
                                ${fees.timeline.map((event) => html`
                                    <li style="margin-top:6px;">
                                        ${formatDate(event.at)} — ${event.title}
                                        ${event.amount != null ? html` (${formatMoney(event.amount)})` : ''}
                                    </li>
                                `)}
                            </ul>
                        ` : html`<p class="m-card-meta" style="margin-top:8px;">No fee activity recorded yet.</p>`}
                    </div></div>
                ` : ''}
            </div>
        `;
    }
}
