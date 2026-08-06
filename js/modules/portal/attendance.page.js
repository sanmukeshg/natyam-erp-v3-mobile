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
import { showLoadError } from '../../ui/loadState.js';

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

    /**
     * Renders one section per selected child — one when a child is chosen in
     * the app bar, all of them under "All children".
     *
     * The read is unchanged and still happens ONCE: forGuardian() already
     * returns every child's records, and always did. Only the filtering moved
     * — from "the active child" to "each selected child" — so showing four
     * children costs no more queries than showing one.
     */
    async load() {
        const students = guardianSession.selectedChildren();
        if (!students.length) { render(this.container, this.page([])); return; }

        const today = localDate();
        const weekStart = startOfWeek(today);
        const monthStart = `${monthKey(today)}-01`;

        // Something has to be on screen before the await. Without it a parent
        // on a slow connection stares at the previous page with no sign the
        // app is working — the read is what changes, not the screen.
        render(this.container, html`<div class="m-skeleton">Loading attendance…</div>`);

        let all;
        try {
            all = await attendance$.forGuardian(guardianSession.phone, guardianSession.email);
        } catch (err) {
            if (this.disposed) return;
            console.error('Portal attendance failed to load', err);
            showLoadError(this.container, { what: 'Attendance', error: err, onRetry: () => this.load() });
            return;
        }
        if (this.disposed) return;

        const blocks = students.map((student) => {
            const mine = all.filter((r) => r.studentId === student.id);
            const weekRows = mine.filter((r) => r.date >= weekStart && r.date <= today);
            const monthRows = mine.filter((r) => r.date >= monthStart && r.date <= today);
            return {
                student,
                week: { rate: AttendanceMath.rateOf(weekRows), breakdown: AttendanceMath.breakdownOf(weekRows), rows: weekRows },
                month: { rate: AttendanceMath.rateOf(monthRows), breakdown: AttendanceMath.breakdownOf(monthRows), rows: monthRows }
            };
        });

        render(this.container, this.page(blocks));
    }

    page(blocks) {
        // The child's name heads each section only when there is more than
        // one — with a single child the app bar already says whose records
        // these are, and repeating it is noise.
        const many = blocks.length > 1;

        return html`

            ${blocks.length ? blocks.map(({ student, week, month }) => html`
                <section class="m-stack" style="margin-bottom:20px;">
                    ${many ? html`<h2 class="m-section-label">${student.name}</h2>` : ''}
                    <div class="m-stack">
                        ${this.summaryCard('This week', week)}
                        ${this.summaryCard('This month', month)}
                    </div>
                    ${week?.rows?.length ? html`
                        <div class="m-card" style="margin-top:12px;"><div class="m-card-inner">
                            <h3 class="m-card-title">This week's registers</h3>
                            <ul style="margin-top:12px;">
                                ${week.rows.map((r) => html`
                                    <li>${formatDate(r.date)} — ${r.status === 'present' ? 'Present' : 'Absent'}</li>
                                `)}
                            </ul>
                        </div></div>
                    ` : ''}
                </section>
            `) : html`<div class="m-card m-empty">No attendance recorded yet.</div>`}
        `;
    }

    summaryCard(label, summary) {
        return html`
            <div class="m-card"><div class="m-card-inner">
                <div class="m-card-meta">${label}</div>
                <div class="m-card-title" style="font-size:28px">${summary?.rate != null ? `${summary.rate}%` : '—'}</div>
                <p class="m-card-meta">
                    ${summary ? `${summary.breakdown.present} present · ${summary.breakdown.absent} absent` : 'No classes recorded yet.'}
                </p>
            </div></div>
        `;
    }
}
