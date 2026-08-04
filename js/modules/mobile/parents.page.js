/**
 * Natyam ERP v3 — Mobile — Parents and households
 *
 * There is no parent record in this system, and that is a decision rather than
 * an omission. A guardian here has no login, no portal and no existence that
 * outlives their child's enrolment; giving them their own store would create a
 * second place for a phone number to be wrong.
 *
 * So a household is *derived* — by `students.service.households()`, from the
 * students who share a contact number.
 *
 * WHY THIS EXISTS ON A PHONE. Owner & Accountant works from both surfaces, and
 * this is the screen most worth having on the one that is also a telephone: the
 * whole point of a household directory is ringing a family, and here the number
 * is a tap rather than something to copy onto another device. Teacher &
 * Reception gets it too — they hold STUDENT_VIEW, and reception is exactly who
 * needs to reach a parent at short notice.
 *
 * WHAT IT DOES NOT DO, deliberately: editing the household's contact details
 * fans a write out across every child's record, and that is a desk job. It
 * stays on natyam-admin. This screen is for finding and calling; the desktop
 * one is for correcting.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatMoneyShort, formatNumber } from '../../utils/money.js';
import { households, householdSummary, updateStudent } from '../../services/students.service.js';
import { CAPABILITIES } from '../../config/app.config.js';
import { formModal } from '../../ui/form.js';
import { toast } from '../../ui/toast.js';

/** Filter pills, in the order a phone user reaches for them. */
const FILTERS = [
    { key: null, label: 'All' },
    { key: 'owing', label: 'Owing' },
    { key: 'siblings', label: 'Siblings' },
    { key: 'no-phone', label: 'No phone' }
];

export default class MobileParentsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Parents';
        this.filter = this.query.filter || null;
        this.search = '';
        this.groups = [];
        this.stats = null;
        this.open = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Assembling households…</div>`);
        this.bind();
        await this.load();

        [EVENTS.STUDENT_CREATED, EVENTS.STUDENT_UPDATED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const [groups, stats] = await Promise.all([
                households(session.branch()),
                householdSummary(session.branch())
            ]);
            if (this.disposed) return;
            this.groups = groups;
            this.stats = stats;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Households could not be assembled', err);
            render(this.container, html`
                <div class="m-error">Households could not be assembled — ${err.message}</div>
            `);
        }
    }

    visibleRows() {
        let rows = this.groups.filter((g) => {
            if (this.filter === 'owing') return g.outstanding > 0;
            if (this.filter === 'siblings') return g.size > 1;
            if (this.filter === 'no-phone') return !g.contactable;
            return true;
        });

        const term = this.search.trim().toLowerCase();
        if (term) {
            rows = rows.filter((g) =>
                [g.guardianName, g.phone, g.email, ...g.children.map((c) => c.name)]
                    .some((v) => String(v || '').toLowerCase().includes(term)));
        }
        return rows;
    }

    paint() {
        const rows = this.visibleRows();
        const s = this.stats || {};

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">Search households</span>
                        <input type="search" data-role="search" placeholder="Search parent, phone or child…">
                    </label>
                </div>
                <p class="m-subhead-note">
                    ${rows.length} of ${this.groups.length} household${this.groups.length === 1 ? '' : 's'}
                    ${s.totalOutstanding ? ` · ${formatMoneyShort(s.totalOutstanding)} owed` : ''}
                </p>
                <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
            </div>

            ${s.missingPhone ? html`
                <div class="m-notice" data-tone="negative" style="margin-bottom:10px;">
                    ${formatNumber(s.missingPhone)} household${s.missingPhone === 1 ? ' has' : 's have'}
                    no phone number. In an emergency there would be nobody to call.
                </div>
            ` : ''}

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((g) => html`
                        <button class="m-card m-student" data-action="open" data-key="${g.key}">
                            <span class="m-student-main">
                                <span class="m-student-name">${g.guardianName}</span>
                                <span class="m-student-meta">
                                    ${g.guardianRelation} · ${g.size} child${g.size === 1 ? '' : 'ren'}
                                    · ${g.children.map((c) => c.name).join(', ')}
                                </span>
                            </span>
                            <span class="m-badge" data-fee="${g.outstanding > 0 ? 'overdue' : 'clear'}">
                                ${g.outstanding > 0 ? formatMoneyShort(g.outstanding) : 'Clear'}
                            </span>
                        </button>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty">
                    ${this.groups.length
                        ? 'No household matches that.'
                        : 'Households appear as soon as students have a guardian phone number.'}
                </div>
            `}

            <div data-role="sheet"></div>
        `);

        this.paintSheet();
    }

    /* ---------------------------------------------------------------- SHEET */

    paintSheet() {
        const target = this.container.querySelector('[data-role="sheet"]');
        if (!target) return;
        const g = this.open;
        if (!g) { render(target, ''); return; }

        render(target, html`
            <div class="m-sheet-scrim" data-action="close-household"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${g.guardianName}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${g.guardianName}</h2>
                        <p class="m-profile-sub">
                            ${g.guardianRelation} · ${g.size} child${g.size === 1 ? '' : 'ren'} on the roll
                        </p>
                    </div>
                    <button class="m-icon-btn" data-action="close-household" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    ${!g.contactable ? html`
                        <div class="m-notice" data-tone="negative">
                            No phone number on any of these records.
                        </div>
                    ` : ''}

                    <!--
                        Call and message are real links, not buttons: tel: and sms:
                        hand off to the phone's own dialer, which is the entire
                        reason this screen is worth having on a handset.
                    -->
                    ${g.phone ? html`
                        <div class="m-subhead-row" style="margin-bottom:12px;">
                            <a class="m-btn" href="tel:${g.phone}" style="flex:1;justify-content:center;">
                                ${raw(icon('phone', { size: 15 }))} Call
                            </a>
                            <a class="m-btn m-btn-ghost" href="sms:${g.phone}" style="flex:1;justify-content:center;">
                                Message
                            </a>
                        </div>
                    ` : ''}

                    <dl class="m-facts">
                        ${fact('Phone', g.phone || '—')}
                        ${fact('Email', g.email || '—')}
                        ${fact('Emergency', g.alternatePhone || '—')}
                        ${fact('Owed', g.outstanding > 0 ? formatMoney(g.outstanding) : 'Nothing')}
                    </dl>
                    ${g.address ? html`<p class="m-subhead-note">${g.address}</p>` : ''}

                    <p class="m-section-label" style="margin-top:16px;">Children</p>
                    <div class="m-stack">
                        ${g.children.map((c) => html`
                            <a class="m-card m-student" href="#/students?student=${c.id}">
                                <span class="m-student-main">
                                    <span class="m-student-name">${c.name}</span>
                                    <span class="m-student-meta">
                                        ${c.levelLabel || '—'}${c.batchName ? ` · ${c.batchName}` : ' · No batch'}
                                    </span>
                                </span>
                                <span class="m-badge" data-fee="${c.outstanding > 0 ? 'overdue' : 'clear'}">
                                    ${c.outstanding > 0 ? formatMoneyShort(c.outstanding) : 'Clear'}
                                </span>
                            </a>
                        `)}
                    </div>

                    ${session.can(CAPABILITIES.STUDENT_EDIT) ? html`
                        <div class="m-actions" style="margin-top:16px;">
                            <button class="m-btn m-btn-ghost" data-action="edit-household">
                                ${raw(icon('edit', { size: 15 }))} Edit contact details
                            </button>
                        </div>
                        <p class="m-subhead-note" style="margin-top:8px;">
                            A change writes to every child's record — that is what keeps the
                            household together.
                        </p>
                    ` : ''}
                </div>
            </div>
        `);
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="filter"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.filter = this.filter === key ? null : key;
            this.paint();
        }));

        this.onDispose(on(root, 'input', '[data-role="search"]', debounce((_e, t) => {
            this.search = t.value;
            this.paint();
            const field = root.querySelector('[data-role="search"]');
            if (field && document.activeElement !== field) {
                field.focus();
                field.setSelectionRange(field.value.length, field.value.length);
            }
        }, 180)));

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => {
            this.open = this.groups.find((g) => g.key === t.dataset.key) || null;
            this.paintSheet();
        }));
        this.onDispose(on(root, 'click', '[data-action="edit-household"]', () => this.editHousehold()));

        this.onDispose(on(root, 'click', '[data-action="close-household"]', () => {
            this.open = null;
            this.paintSheet();
        }));

        this.onKey = (event) => {
            if (event.key === 'Escape' && this.open) { this.open = null; this.paintSheet(); }
        };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
    /* ------------------------------------------------------------- EDITING */
    /*
     * UAT BUG-204. The household could be read but not corrected — a changed
     * phone number or a new email meant going to a desktop.
     *
     * There is no guardian RECORD to edit. A household is derived by grouping
     * students on their guardian's phone number, and the contact details live
     * on each child's own row. So one edit writes to every child in the
     * household — which is what makes the household hold together, and is
     * exactly what the desktop app does. The dialog says so rather than leaving
     * it to be discovered.
     *
     * Changing the phone number re-keys the household, because the key IS the
     * number. That is correct — the same family, now reachable on a new number
     * — but it is worth the person knowing before they submit.
     */
    async editHousehold() {
        const g = this.open;
        if (!g) return;
        session.require(CAPABILITIES.STUDENT_EDIT, 'edit a guardian');

        const children = g.children || [];
        const saved = await formModal({
            title: `Edit ${g.guardianName}`,
            description: children.length === 1
                ? `Writes to ${children[0].name}'s record.`
                : `Writes to all ${children.length} children's records.`,
            submitLabel: 'Save changes',
            fields: [
                { name: 'guardianName', label: 'Name', required: true },
                { name: 'guardianRelation', label: 'Relationship', type: 'select',
                  options: ['Mother', 'Father', 'Grandparent', 'Guardian', 'Sibling']
                      .map((r) => ({ value: r, label: r })) },
                { name: 'guardianPhone', label: 'Phone', type: 'tel', required: true,
                  help: 'The household is grouped by this number — changing it moves '
                      + 'the whole family to the new one.' },
                { name: 'guardianEmail', label: 'Email', type: 'email' },
                { name: 'alternatePhone', label: 'Emergency number', type: 'tel' },
                { name: 'address', label: 'Address', type: 'textarea', rows: 2 }
            ],
            values: {
                guardianName: g.guardianName === 'Not recorded' ? '' : (g.guardianName || ''),
                guardianRelation: g.guardianRelation || 'Mother',
                guardianPhone: g.phone || '',
                guardianEmail: g.email || '',
                alternatePhone: g.alternatePhone || '',
                address: g.address || ''
            },
            // Sequential, not Promise.all: these are writes to the same family,
            // and a half-applied change is easier to reason about — and to
            // finish by hand — than an unknown subset having landed.
            onSubmit: async (v) => {
                for (const child of children) await updateStudent(child.id, v);
                return v;
            }
        });

        if (!saved) return;
        toast.success('Guardian updated', children.length === 1
            ? children[0].name
            : `${children.length} records changed.`);
        this.open = null;
        await this.load();
    }
}

/* ------------------------------------------------------------------ HELPERS */

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
