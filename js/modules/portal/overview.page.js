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
import { EVENTS } from '../../core/bus.js';
import { showLoadError } from '../../ui/loadState.js';

const DAY_LABELS = { Sun: 'Sun', Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat' };

export default class PortalOverviewPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Overview';
    }

    async render(container) {
        this.container = container;

        // The one portal page that never subscribed to this — because it
        // always showed every child, so a change of child could not affect
        // it. That is exactly why the switcher appeared dead here while it
        // worked on Attendance and Fees: those five pages have listened all
        // along. Subscribed once, guarded, since render() runs again on each
        // child change.
        if (!this.subscribed) {
            this.subscribed = true;
            this.events.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.render(container));
        }

        // selectedChildren(), not students. This page used to list every child
        // unconditionally, which was right when there was no way to choose
        // one. With an explicit "All children" entry in the app bar, ignoring
        // the switcher made it look broken — you picked Ayaan and still saw
        // all four.
        const students = guardianSession.selectedChildren();

        render(container, html`<div class="m-skeleton">Loading your children…</div>`);

        let fees;
        try {
            fees = await Promise.all(
                students.map((s) => studentFeeSummary(s.id).catch(() => null))
            );
        } catch (err) {
            if (this.disposed) return;
            console.error('Portal overview failed to load', err);
            showLoadError(container, { what: 'Your children', error: err, onRetry: () => this.render(container) });
            return;
        }

        // This page had no disposed guard at all — the only portal page that
        // awaited without one. A fee summary resolving after the parent had
        // already tapped through to Fees rendered these cards over that page,
        // which reads as the app losing its place.
        if (this.disposed) return;

        render(container, html`
            <div class="m-stack">
                <div class="m-stack">
                    ${students.map((student, i) => this.card(student, fees[i]))}
                </div>
            </div>
        `);
    }

    card(student, fees) {
        const schedule = student.batchSchedule;
        return html`
            <div class="m-card">
                <div class="m-card-inner">
                    <h3 class="m-card-title">${student.name}</h3>
                    <p class="m-card-meta">
                        ${levelLabel(student.level)}${schedule ? ` · ${schedule.name}` : ' · Not yet placed in a batch'}
                    </p>
                    ${schedule ? html`
                        <p class="m-card-meta">
                            ${(schedule.days || []).map((d) => DAY_LABELS[d] || d).join(', ')}
                            · ${schedule.startTime}–${schedule.endTime}
                        </p>
                    ` : ''}
                    <div class="m-facts" style="margin-top:12px;">
                        <div>
                            <div class="m-card-meta">Outstanding</div>
                            <div class="m-card-title">${fees ? formatMoney(fees.outstanding) : '—'}</div>
                        </div>
                        <div>
                            <div class="m-card-meta">Overdue</div>
                            <div class="m-card-title">${fees ? formatMoney(fees.overdue) : '—'}</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}
