/**
 * NATYAM ERP 2.0 — Parent/Student Portal: Programmes (Milestone P1)
 *
 * Reads the active child's own `programmes` snapshot directly off their
 * student record. `programs` participation is an array of student ids on
 * the programme document, not a foreign key on the student, and Firestore
 * rules can't check "is any of my children in this array" — so the
 * programme travels with the student instead (see programs.service.js's
 * setParticipants()).
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';
import { EVENTS } from '../../core/bus.js';
import { formatDate } from '../../utils/date.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';

export default class PortalProgrammesPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Programmes';
    }

    async render(container) {
        this.container = container;
        this.paint();
        this.events.on(EVENTS.PORTAL_CHILD_CHANGED, () => this.paint());
    }

    /**
     * One card per selected child, newest programme first within each.
     * Programmes ride on the student record itself, so like Timetable this
     * needs no fetch and "All children" costs nothing.
     */
    paint() {
        const students = guardianSession.selectedChildren();
        const many = students.length > 1;

        render(this.container, html`

            ${students.length ? html`
                <div class="m-stack">
                    ${students.map((student) => {
                        const programmes = [...(student.programmes || [])]
                            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
                        return html`
                            <div class="m-card"><div class="m-card-inner">
                                ${many ? html`<p class="p-child-name">${student.name}</p>` : ''}
                                ${programmes.length ? html`
                                    <ul>
                                        ${programmes.map((p) => html`
                                            <li style="margin-top:6px;">
                                                <span class="m-card-title">${p.name}</span>
                                                <span class="m-card-meta"> — ${p.type} · ${formatDate(p.date)}${p.venue ? ` · ${p.venue}` : ''}</span>
                                            </li>
                                        `)}
                                    </ul>
                                ` : html`
                                    <p style="margin:0;">${student.name} isn't taking part in any upcoming programme yet.</p>
                                `}
                            </div></div>
                        `;
                    })}
                </div>
            ` : html`<div class="m-card m-empty">No programmes to show.</div>`}
        `);
    }
}
