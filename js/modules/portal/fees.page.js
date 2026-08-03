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

    async load() {
        const student = guardianSession.activeChild();
        if (!student) { render(this.container, this.shell(null, null)); return; }

        const fees = await guardianFeeSummary(guardianSession.phone, guardianSession.email, student);
        if (this.disposed) return;
        render(this.container, this.shell(student, fees));
    }

    shell(student, fees) {
        return html`
            <header class="page-header">
                <div class="page-header-text">
                    <h1 class="page-title">Fees</h1>
                    <p class="page-subtitle">${student?.name || ''}</p>
                </div>
            </header>
            <div class="page-body">
                ${fees ? html`
                    <div class="grid grid-4">
                        <div class="card"><div class="card-body">
                            <div class="type-caption type-muted">Billed</div>
                            <div class="type-strong">${formatMoney(fees.billed)}</div>
                        </div></div>
                        <div class="card"><div class="card-body">
                            <div class="type-caption type-muted">Collected</div>
                            <div class="type-strong">${formatMoney(fees.collected)}</div>
                        </div></div>
                        <div class="card"><div class="card-body">
                            <div class="type-caption type-muted">Outstanding</div>
                            <div class="type-strong">${formatMoney(fees.outstanding)}</div>
                        </div></div>
                        <div class="card"><div class="card-body">
                            <div class="type-caption type-muted">Overdue</div>
                            <div class="type-strong">${formatMoney(fees.overdue)}</div>
                        </div></div>
                    </div>
                    ${fees.oldestDue ? html`
                        <p class="type-caption type-muted mt-2">Oldest amount due: ${formatDate(fees.oldestDue)}</p>
                    ` : ''}
                    <div class="card mt-2"><div class="card-body">
                        <h3 class="type-strong">History</h3>
                        ${fees.timeline?.length ? html`
                            <ul class="mt-2">
                                ${fees.timeline.map((event) => html`
                                    <li class="mt-1">
                                        ${formatDate(event.at)} — ${event.title}
                                        ${event.amount != null ? html` (${formatMoney(event.amount)})` : ''}
                                    </li>
                                `)}
                            </ul>
                        ` : html`<p class="type-caption type-muted mt-2">No fee activity recorded yet.</p>`}
                    </div></div>
                ` : ''}
            </div>
        `;
    }
}
