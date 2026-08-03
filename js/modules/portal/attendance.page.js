/**
 * NATYAM ERP 2.0 — Parent/Student Portal: Attendance (Milestone P1)
 *
 * Week and month attendance rate for the active child. Milestone P2: reads
 * via attendance$.forGuardian(phone, email) — every one of the guardian's
 * children's records, queried by guardianPhone/guardianEmail directly on
 * the attendance document (required for firestore.rules to authorize the
 * query at all, see isGuardianOfRecord()'s comment) — then narrows to the
 * active child and the week/month window client-side, the same
 * fetch-then-slice shape students.service.js's profile() already uses for
 * its own 90-day rate with AttendanceMath.rateOf()/breakdownOf().
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';
import { EVENTS } from '../../core/bus.js';
import { localDate, startOfWeek, monthKey, formatDate } from '../../utils/date.js';
import { attendance$, AttendanceMath } from '../../data/repositories.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';

export default class PortalAttendancePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Attendance';
    }

    async render(container) {
        this.container = container;
        await this.load();
        this.events.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.load());
    }

    async load() {
        const student = guardianSession.activeChild();
        if (!student) { render(this.container, this.shell(null, null, null)); return; }

        const today = localDate();
        const weekStart = startOfWeek(today);
        const monthStart = `${monthKey(today)}-01`;

        const all = await attendance$.forGuardian(guardianSession.phone, guardianSession.email);
        const mine = all.filter((r) => r.studentId === student.id);
        const weekRows = mine.filter((r) => r.date >= weekStart && r.date <= today);
        const monthRows = mine.filter((r) => r.date >= monthStart && r.date <= today);

        if (this.disposed) return;
        render(this.container, this.shell(student, {
            rate: AttendanceMath.rateOf(weekRows), breakdown: AttendanceMath.breakdownOf(weekRows), rows: weekRows
        }, {
            rate: AttendanceMath.rateOf(monthRows), breakdown: AttendanceMath.breakdownOf(monthRows), rows: monthRows
        }));
    }

    shell(student, week, month) {
        return html`
            <header class="page-header">
                <div class="page-header-text">
                    <h1 class="page-title">Attendance</h1>
                    <p class="page-subtitle">${student?.name || ''}</p>
                </div>
            </header>
            <div class="page-body">
                <div class="grid grid-2">
                    ${this.summaryCard('This week', week)}
                    ${this.summaryCard('This month', month)}
                </div>
                ${week?.rows?.length ? html`
                    <div class="card mt-2"><div class="card-body">
                        <h3 class="type-strong">This week's registers</h3>
                        <ul class="mt-2">
                            ${week.rows.map((r) => html`
                                <li>${formatDate(r.date)} — ${r.status === 'present' ? 'Present' : 'Absent'}</li>
                            `)}
                        </ul>
                    </div></div>
                ` : ''}
            </div>
        `;
    }

    summaryCard(label, summary) {
        return html`
            <div class="card"><div class="card-body">
                <div class="type-caption type-muted">${label}</div>
                <div class="type-strong" style="font-size:28px">${summary?.rate != null ? `${summary.rate}%` : '—'}</div>
                <p class="type-caption type-muted">
                    ${summary ? `${summary.breakdown.present} present · ${summary.breakdown.absent} absent` : 'No classes recorded yet.'}
                </p>
            </div></div>
        `;
    }
}
