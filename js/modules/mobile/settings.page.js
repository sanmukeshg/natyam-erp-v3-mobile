/**
 * Natyam ERP v3 — Mobile — Settings
 *
 * `Settings.dc.html` was lost with the design project, but its structure
 * survived in the change log: nine tabs, role-gated so Teacher & Reception
 * cannot see Users, Audit log or Data.
 *
 * **This app deliberately carries fewer of those tabs than the desktop app**,
 * and that is not a shortcut. Mobile serves Owner & Accountant and Teacher &
 * Reception. Of the nine sections:
 *
 *   - **Preferences** is the one a phone user actually changes, so it leads.
 *   - **Institute** and **Branches** are worth reading on a phone (a receptionist
 *     asked for the school's address or a branch phone number).
 *   - **Fee plans** and **Curriculum** are reference — occasionally useful.
 *   - **Users**, **Roles**, **Audit log** and **Data** are administration. They are
 *     Administrator work, Administrator is desktop-only, and a phone is the
 *     wrong instrument for granting a role or restoring a backup. Rather than
 *     ship four sections nobody here should use, this screen says where they
 *     live.
 *
 * The gating is still the real capability model, not a role check: the tab
 * list below names CAPABILITIES strings and filters on `session.can()`.
 * Owner & Accountant sees the reference sections; Teacher & Reception sees
 * what their capabilities allow.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { session } from '../../core/session.js';
import { EVENTS, bus } from '../../core/bus.js';
import { formatMoney } from '../../utils/money.js';
import { APP, CAPABILITIES, PREFERENCE_DEFAULTS } from '../../config/app.config.js';
import {
    institute, listBranches, listFeePlans, listMasterSet, MASTER_SETS,
    createBranch, createFeePlan
} from '../../services/settings.service.js';
import { exposedFeeFrequencies } from '../../config/app.config.js';
import { formModal } from '../../ui/form.js';
import { toast } from '../../ui/toast.js';

const TABS = [
    { key: 'preferences', label: 'Display', cap: null },
    { key: 'institute', label: 'School', cap: null },
    { key: 'branches', label: 'Branches', cap: null },
    { key: 'fees', label: 'Fee plans', cap: CAPABILITIES.FEE_VIEW },
    { key: 'curriculum', label: 'Curriculum', cap: null },
    { key: 'about', label: 'About', cap: null }
];

const THEMES = [
    { value: 'system', label: 'Device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
];

export default class MobileSettingsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Settings';
        this.tab = this.query.tab || 'preferences';
        this.data = {};
    }

    visibleTabs() {
        return TABS.filter((t) => !t.cap || session.can(t.cap));
    }

    async render(container) {
        this.container = container;
        const tabs = this.visibleTabs();
        if (!tabs.some((t) => t.key === this.tab)) this.tab = tabs[0]?.key || 'preferences';

        render(container, html`
            <div class="m-subhead">
                <div class="m-chip-scroll" data-role="tabs">
                    ${tabs.map((t) => html`
                        <button class="m-pill" data-action="tab" data-tab="${t.key}"
                                aria-pressed="${this.tab === t.key ? 'true' : 'false'}">${t.label}</button>
                    `)}
                </div>
            </div>
            <div data-role="panel"><div class="m-skeleton">Loading…</div></div>
        `);

        this.bind();
        await this.loadTab();
    }

    async loadTab() {
        const panel = this.container.querySelector('[data-role="panel"]');
        render(panel, html`<div class="m-skeleton">Loading…</div>`);

        try {
            if (this.tab === 'institute' && !this.data.institute) {
                this.data.institute = await institute();
            } else if (this.tab === 'branches' && !this.data.branches) {
                this.data.branches = await listBranches({ includeInactive: true });
            } else if (this.tab === 'fees' && !this.data.feePlans) {
                this.data.feePlans = await listFeePlans({ includeInactive: true });
            } else if (this.tab === 'curriculum' && !this.data.levels) {
                this.data.levels = await listMasterSet('levels');
            }
            if (this.disposed) return;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error(`Settings tab "${this.tab}" failed`, err);
            render(panel, html`<div class="m-error">Could not load this section — ${err.message}</div>`);
        }
    }

    paint() {
        this.container.querySelectorAll('[data-action="tab"]').forEach((n) => {
            n.setAttribute('aria-pressed', n.dataset.tab === this.tab ? 'true' : 'false');
        });
        render(this.container.querySelector('[data-role="panel"]'), this.panelFor(this.tab));
        this.paintFab();
    }

    /**
     * A create action only on the sections that have one, and only for someone
     * who may use it.
     *
     * Only Branches and Fee plans get one. The other four are not omissions:
     * Display is per-device preferences with nothing to create, School and
     * About are single records, and Curriculum entries are a list whose real
     * operations are reorder and deactivate — which need a per-row usage check
     * (`masterEntryUsage()`), not a floating button. Those stay on the desktop
     * app where there is room to do them properly.
     */
    paintFab() {
        const ACTIONS = { branches: 'Add a branch', fees: 'Add a fee plan' };
        const label = session.can(CAPABILITIES.SETTINGS_EDIT) ? ACTIONS[this.tab] : null;

        let fab = this.container.querySelector('.m-fab');
        if (!label) { fab?.remove(); return; }

        if (!fab) {
            fab = document.createElement('button');
            fab.className = 'm-fab';
            render(fab, html`${raw(icon('plus', { size: 24 }))}`);
            this.container.append(fab);
        }
        fab.dataset.action = 'settings-add';
        fab.setAttribute('aria-label', label);
    }

    panelFor(tab) {
        const prefs = session.prefs();

        if (tab === 'preferences') {
            return html`
                <h2 class="m-section-label">Appearance</h2>
                <div class="m-modes" style="margin-bottom:20px;">
                    ${THEMES.map((t) => html`
                        <label class="m-mode">
                            <input type="radio" name="theme" value="${t.value}"
                                   ${(prefs.theme || PREFERENCE_DEFAULTS.theme) === t.value ? 'checked' : ''}>
                            <span>${t.label}</span>
                        </label>
                    `)}
                </div>
                <p class="m-profile-note">Saved to this device only, and applied straight away.</p>
            `;
        }

        if (tab === 'institute') {
            const i = this.data.institute || {};
            return html`
                <dl class="m-facts">
                    ${fact('Name', i.name || '—')}
                    ${fact('Phone', i.phone || '—')}
                    ${fact('Email', i.email || '—')}
                    ${fact('Address', i.address || '—')}
                </dl>
                ${i.phone ? html`
                    <a class="m-btn m-btn-ghost m-btn-block" href="tel:${i.phone}" style="margin-top:12px;">
                        ${raw(icon('phone', { size: 16 }))} Call the school
                    </a>
                ` : ''}
            `;
        }

        if (tab === 'branches') {
            const rows = this.data.branches || [];
            return html`
                <div class="m-stack">
                    ${rows.length ? rows.map((b) => html`
                        <div class="m-card" style="padding:13px 14px;">
                            <div class="m-card-title">${b.name}${b.code ? ` · ${b.code}` : ''}</div>
                            <div class="m-card-meta">${b.address || 'No address'}</div>
                            ${b.phone ? html`
                                <a class="m-btn m-btn-ghost m-btn-block" href="tel:${b.phone}" style="margin-top:10px;">
                                    ${raw(icon('phone', { size: 16 }))} ${b.phone}
                                </a>
                            ` : ''}
                        </div>
                    `) : html`<div class="m-card m-empty">No branches.</div>`}
                </div>
            `;
        }

        if (tab === 'fees') {
            const rows = this.data.feePlans || [];
            return html`
                <div class="m-stack">
                    ${rows.length ? rows.map((p) => html`
                        <div class="m-invoice">
                            <div class="m-invoice-main">
                                <div class="m-invoice-no">${p.name}</div>
                                <div class="m-invoice-due">
                                    ${p.frequency ? titleCase(p.frequency) : '—'}${p.status !== 'active' ? ` · ${titleCase(p.status)}` : ''}
                                </div>
                            </div>
                            <span class="m-badge">${formatMoney(p.amount || 0)}</span>
                        </div>
                    `) : html`<div class="m-card m-empty">No fee plans.</div>`}
                </div>
            `;
        }

        if (tab === 'curriculum') {
            const rows = this.data.levels || [];
            return html`
                <p class="m-profile-note" style="margin-bottom:10px;">${MASTER_SETS.levels.label}</p>
                <div class="m-stack">
                    ${rows.length ? rows.map((e) => html`
                        <div class="m-invoice" style="border-left-color:var(--v3-tone-neutral);">
                            <div class="m-invoice-main">
                                <div class="m-invoice-no">${e.label}</div>
                                ${e.status !== 'active' ? html`<div class="m-invoice-due">${titleCase(e.status)}</div>` : ''}
                            </div>
                            <span class="m-badge">${e.order}</span>
                        </div>
                    `) : html`<div class="m-card m-empty">Using the shipped defaults.</div>`}
                </div>
            `;
        }

        // about
        return html`
            <dl class="m-facts">
                ${fact('App', `${APP.name} — ${APP.edition}`)}
                ${fact('Version', APP.version)}
                ${fact('School', APP.organisation)}
                ${fact('Signed in as', `${session.actorName()} · ${session.roleLabel()}`)}
            </dl>

            <div class="m-notice" data-tone="info" style="margin-top:16px;">
                <strong>Administration lives on the desktop app.</strong>
                <div style="margin-top:6px;">
                    Users, Roles, the Audit log and Backup &amp; restore are Administrator work,
                    and Administrator accounts use the desktop app. A phone is the wrong place to
                    grant a role or restore a backup, so those sections are not carried here.
                </div>
            </div>
        `;
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="tab"]', (_e, t) => {
            if (this.tab === t.dataset.tab) return;
            this.tab = t.dataset.tab;
            this.loadTab();
        }));

        this.onDispose(on(root, 'change', '[name="theme"]', (_e, t) => {
            session.setPref('theme', t.value);
            bus.emit(EVENTS.PREFS_CHANGED, { key: 'theme', value: t.value });
        }));

        this.onDispose(on(root, 'click', '[data-action="settings-add"]', () => {
            if (this.tab === 'branches') this.addBranch();
            else if (this.tab === 'fees') this.addFeePlan();
        }));
    }

    /* ----------------------------------------------------------- CREATES */

    async addBranch() {
        const created = await formModal({
            title: 'Add a branch',
            description: 'A place classes are held.',
            submitLabel: 'Add',
            fields: [
                { name: 'name', label: 'Branch name', required: true, placeholder: 'Natyam – Kondapur' },
                { name: 'code', label: 'Short code', required: true, maxLength: 10,
                  help: 'Used on registers and receipts. Stored in capitals.' },
                { name: 'address', label: 'Address', type: 'textarea', rows: 2 },
                { name: 'phone', label: 'Phone', type: 'tel' },
                { name: 'email', label: 'Email', type: 'email' }
            ],
            values: { name: '', code: '', address: '', phone: '', email: '' },
            onSubmit: (values) => createBranch(values)
        });

        if (!created) return;
        toast.success('Branch added', created.name);
        this.data.branches = null;
        await this.loadTab();
    }

    async addFeePlan() {
        const created = await formModal({
            title: 'Add a fee plan',
            description: 'What a student on this plan is billed, and how often.',
            submitLabel: 'Add',
            fields: [
                { name: 'name', label: 'Plan name', required: true, placeholder: 'Junior Batch' },
                { name: 'amount', label: 'Fee', type: 'money', required: true, min: 1,
                  help: 'Charged each period, in whole rupees.' },
                { name: 'frequency', label: 'Charged', type: 'select', required: true,
                  options: exposedFeeFrequencies().map((f) => ({ value: f.value, label: f.label })) },
                { name: 'registrationFee', label: 'One-off registration fee', type: 'money', min: 0 },
                { name: 'costumeFee', label: 'One-off costume fee', type: 'money', min: 0 }
            ],
            values: { name: '', amount: '', frequency: 'monthly', registrationFee: '', costumeFee: '' },
            onSubmit: (values) => createFeePlan(values)
        });

        if (!created) return;
        toast.success('Fee plan added', created.name);
        this.data.feePlans = null;
        await this.loadTab();
    }
}

/* ------------------------------------------------------------------ HELPERS */

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
