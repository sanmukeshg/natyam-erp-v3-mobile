/**
 * NATYAM ERP 2.0 — Parent/Student Portal: Overview (Milestone P1)
 *
 * The landing page after a guardian signs in — one card per child, since a
 * household can have more than one enrolled. Deliberately read-only: no
 * button here (or anywhere in the portal) ever collects a payment, edits a
 * record, or reaches a staff-only screen.
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';
import { formatMoney } from '../../utils/money.js';
import { levelLabel } from '../../config/app.config.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';
import { studentFeeSummary } from '../../services/fees.service.js';

const DAY_LABELS = { Sun: 'Sun', Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat' };

export default class PortalOverviewPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Overview';
    }

    async render(container) {
        this.container = container;
        const students = guardianSession.students;

        const fees = await Promise.all(
            students.map((s) => studentFeeSummary(s.id).catch(() => null))
        );

        render(container, html`
            <header class="page-header">
                <div class="page-header-text">
                    <h1 class="page-title">Welcome</h1>
                    <p class="page-subtitle">
                        ${students.length === 1
                            ? "Here's your child's snapshot."
                            : "Here's a snapshot for each of your children."}
                    </p>
                </div>
            </header>
            <div class="page-body">
                <div class="grid grid-2">
                    ${students.map((student, i) => this.card(student, fees[i]))}
                </div>
            </div>
        `);
    }

    card(student, fees) {
        const schedule = student.batchSchedule;
        return html`
            <div class="card">
                <div class="card-body">
                    <h3 class="type-strong">${student.name}</h3>
                    <p class="type-caption type-muted">
                        ${levelLabel(student.level)}${schedule ? ` · ${schedule.name}` : ' · Not yet placed in a batch'}
                    </p>
                    ${schedule ? html`
                        <p class="type-caption type-muted">
                            ${(schedule.days || []).map((d) => DAY_LABELS[d] || d).join(', ')}
                            · ${schedule.startTime}–${schedule.endTime}
                        </p>
                    ` : ''}
                    <div class="grid grid-2 mt-2">
                        <div>
                            <div class="type-caption type-muted">Outstanding</div>
                            <div class="type-strong">${fees ? formatMoney(fees.outstanding) : '—'}</div>
                        </div>
                        <div>
                            <div class="type-caption type-muted">Overdue</div>
                            <div class="type-strong">${fees ? formatMoney(fees.overdue) : '—'}</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}
