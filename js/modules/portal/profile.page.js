/**
 * Natyam ERP v3 — Mobile — Parent/Student Portal: My account
 *
 * The guardian's counterpart to the staff app's own profile screen, reached
 * from the avatar beside the child switcher — the same corner, so both
 * audiences find "my account" in the same place.
 *
 * Deliberately thin, and thinner than the staff one. A guardian has no role,
 * no capabilities, no branch and no password of their own to change: their
 * identity is whichever phone number or email the school already holds
 * against their children (see guardianAuth.service.js — a guardian has no
 * /users document at all). So there is genuinely nothing here to configure.
 *
 * What it does carry is the two things this screen exists for: confirmation
 * of which contact details the school is matching them on, and a way out.
 *
 * READ-ONLY, like every other portal screen. Nothing here — or anywhere in
 * this folder — edits a record, and this file imports nothing that could. A
 * parent who needs their number corrected asks the school; that is a staff
 * action on the student record, not a self-service one, and pretending
 * otherwise would be a lie about who owns that data.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { levelLabel } from '../../config/app.config.js';
import { guardianSession } from '../../services/portal/guardianAuth.service.js';

export default class PortalProfilePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'My account';
    }

    async render(container) {
        const students = guardianSession.students;
        const name = students[0]?.guardianName || 'Family';

        render(container, html`
            <div class="m-card" style="padding:18px; text-align:center;">
                <div class="m-avatar" style="margin:0 auto 12px;">
                    ${raw(icon('user', { size: 20 }))}
                </div>
                <p style="margin:0 0 4px; font-weight:600;">${name}</p>
                <p class="m-card-meta" style="margin:0;">
                    ${guardianSession.email || guardianSession.phone || ''}
                </p>
            </div>

            <h2 class="m-section-label" style="margin-top:20px;">
                ${students.length === 1 ? 'Your child' : 'Your children'}
            </h2>

            <div class="m-stack">
                ${students.map((s) => html`
                    <div class="m-card"><div class="m-card-inner">
                        <p class="p-child-name" style="margin-bottom:2px;">${s.name}</p>
                        <p class="m-card-meta">
                            ${levelLabel(s.level)}${s.batchSchedule ? ` · ${s.batchSchedule.name}` : ''}
                        </p>
                    </div></div>
                `)}
            </div>

            <div class="m-card" style="padding:16px; margin-top:16px;">
                <p class="m-field-help" style="margin:0;">
                    You’re signed in because these details match what the school holds
                    for your ${students.length === 1 ? 'child' : 'children'}. To change a
                    phone number or email, please ask the school — they update it on the
                    student’s record.
                </p>
            </div>

            <div class="p-actions" style="margin-top:16px;">
                <a class="m-btn m-btn-ghost m-btn-block" href="#/portal">Back to overview</a>
                <button class="m-btn m-btn-ghost m-btn-block" data-action="logout">Sign out</button>
            </div>
        `);
    }
}
