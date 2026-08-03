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

    paint() {
        const student = guardianSession.activeChild();
        const programmes = [...(student?.programmes || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        render(this.container, html`
            <header class="page-header">
                <div class="page-header-text">
                    <h1 class="page-title">Programmes</h1>
                    <p class="page-subtitle">${student?.name || ''}</p>
                </div>
            </header>
            <div class="page-body">
                ${programmes.length ? html`
                    <div class="card"><div class="card-body">
                        <ul>
                            ${programmes.map((p) => html`
                                <li class="mt-1">
                                    <span class="type-strong">${p.name}</span>
                                    <span class="type-caption type-muted"> — ${p.type} · ${formatDate(p.date)}${p.venue ? ` · ${p.venue}` : ''}</span>
                                </li>
                            `)}
                        </ul>
                    </div></div>
                ` : html`
                    <div class="card"><div class="card-body">
                        ${student?.name || 'This child'} isn't taking part in any upcoming programme yet.
                    </div></div>
                `}
            </div>
        `);
    }
}
