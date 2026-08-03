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

    paint() {
        const student = guardianSession.activeChild();
        const schedule = student?.batchSchedule;

        render(this.container, html`
            <header class="page-header">
                <div class="page-header-text">
                    <h1 class="page-title">Timetable</h1>
                    <p class="page-subtitle">${student?.name || ''}</p>
                </div>
            </header>
            <div class="page-body">
                ${schedule ? html`
                    <div class="card"><div class="card-body">
                        <h3 class="type-strong">${schedule.name}</h3>
                        <p class="type-caption type-muted">${levelLabel(schedule.level)}</p>
                        <ul class="mt-2">
                            ${(schedule.days || []).map((d) => html`
                                <li>${DAY_LABELS[d] || d} · ${schedule.startTime}–${schedule.endTime}</li>
                            `)}
                        </ul>
                    </div></div>
                ` : html`
                    <div class="card"><div class="card-body">
                        ${student?.name || 'This child'} is not currently placed in a batch.
                    </div></div>
                `}
            </div>
        `);
    }
}
