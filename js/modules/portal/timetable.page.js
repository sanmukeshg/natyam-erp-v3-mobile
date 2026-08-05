/**
 * NATYAM ERP 2.0 — Parent/Student Portal: Timetable (Milestone P1)
 *
 * Reads the active child's own `batchSchedule` snapshot directly off their
 * student record — the portal never reads the `batches` collection itself.
 * `batches` has no reverse index from student to batch, and Firestore rules
 * can't express that lookup; the schedule travels with the student instead
 * (see students.repository.firestore.js's header comment and
 * students.service.js's batchScheduleOf()).
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';
import { EVENTS } from '../../core/bus.js';
import { levelLabel } from '../../config/app.config.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';

const DAY_LABELS = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

export default class PortalTimetablePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Timetable';
    }

    async render(container) {
        this.container = container;
        this.paint();
        this.events.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.paint());
    }

    /**
     * A card per selected child. No merged week view under "All children":
     * with four children in different batches a single combined grid is
     * harder to read than four small cards, and the question a parent asks
     * here is "when does Sara go", not "what does our week look like".
     *
     * Needs no fetch at all — each student carries its own `batchSchedule`
     * (see students.service.js's batchScheduleOf), which is why this page has
     * paint() rather than load().
     */
    paint() {
        const students = guardianSession.selectedChildren();
        const many = students.length > 1;

        render(this.container, html`

            ${students.length ? html`
                <div class="m-stack">
                    ${students.map((student) => {
                        const schedule = student.batchSchedule;
                        return html`
                            <div class="m-card"><div class="m-card-inner">
                                ${many ? html`<p class="p-child-name">${student.name}</p>` : ''}
                                ${schedule ? html`
                                    <h3 class="m-card-title">${schedule.name}</h3>
                                    <p class="m-card-meta">${levelLabel(schedule.level)}</p>
                                    <ul class="p-portal-list">
                                        ${(schedule.days || []).map((d) => html`
                                            <li>${DAY_LABELS[d] || d} · ${schedule.startTime}–${schedule.endTime}</li>
                                        `)}
                                    </ul>
                                ` : html`
                                    <p style="margin:0;">${student.name} is not currently placed in a batch.</p>
                                `}
                            </div></div>
                        `;
                    })}
                </div>
            ` : html`<div class="m-card m-empty">No classes to show.</div>`}
        `);
    }
}
