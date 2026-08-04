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
    createBranch, createFeePlan, updateBranch, updateFeePlan, updateMasterEntry
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
                            <div class="m-actions" style="margin-top:10px;">
                                ${b.phone ? html`
                                    <a class="m-btn m-btn-ghost" href="tel:${b.phone}">
                                        ${raw(icon('phone', { size: 15 }))} ${b.phone}
                                    </a>
                                ` : ''}
                                ${session.can(CAPABILITIES.SETTINGS_EDIT) ? html`
                                    <button class="m-btn m-btn-ghost" data-action="edit-branch" data-id="${b.id}">
                                        ${raw(icon('edit', { size: 15 }))} Edit
                                    </button>
                                ` : ''}
                            </div>
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
                            <div class="m-invoice-right">
                                <span class="m-badge">${formatMoney(p.amount || 0)}</span>
                                ${session.can(CAPABILITIES.SETTINGS_EDIT) ? html`
                                    <button class="m-icon-btn m-icon-btn-sm" data-action="edit-plan"
                                            data-id="${p.id}" aria-label="Edit ${p.name}">
                                        ${raw(icon('edit', { size: 14 }))}
                                    </button>
                                ` : ''}
                            </div>
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
                            <div class="m-invoice-right">
                                <span class="m-badge">${e.order}</span>
                                ${session.can(CAPABILITIES.SETTINGS_EDIT) ? html`
                                    <button class="m-icon-btn m-icon-btn-sm" data-action="edit-entry"
                                            data-value="${e.value}" aria-label="Edit ${e.label}">
                                        ${raw(icon('edit', { size: 14 }))}
                                    </button>
                                ` : ''}
                            </div>
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

        this.onDispose(on(root, 'click', '[data-action="edit-branch"]', (_e, t) => this.editBranch(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="edit-plan"]', (_e, t) => this.editFeePlan(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="edit-entry"]', (_e, t) => this.editLevel(t.dataset.value)));

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

    /* ------------------------------------------------------------- EDITING */
    /*
     * UAT BUG-206. Every master-data section could create but not edit, so a
     * typo in a branch code or a fee amount was permanent on this surface. Each
     * editor reuses the same field list as its create counterpart, seeded from
     * the existing record, and hands the whole set to the service — which owns
     * validation and the guardrails this page does not reimplement.
     */

    async editBranch(id) {
        const branch = (this.data.branches || []).find((b) => b.id === id);
        if (!branch) return;

        const saved = await formModal({
            title: `Edit ${branch.name}`,
            description: 'Shown on registers, receipts and reports.',
            submitLabel: 'Save changes',
            fields: [
                { name: 'name', label: 'Branch name', required: true },
                { name: 'code', label: 'Short code', required: true, maxLength: 10,
                  help: 'Used on registers and receipts. Stored in capitals.' },
                { name: 'address', label: 'Address', type: 'textarea', rows: 2 },
                { name: 'phone', label: 'Phone', type: 'tel' },
                { name: 'email', label: 'Email', type: 'email' }
            ],
            values: {
                name: branch.name || '', code: branch.code || '',
                address: branch.address || '', phone: branch.phone || '',
                email: branch.email || ''
            },
            onSubmit: (v) => updateBranch(id, { ...v, code: String(v.code || '').toUpperCase() })
        });

        if (!saved) return;
        toast.success('Branch updated', saved.name);
        this.data.branches = null;
        await this.loadTab();
    }

    /**
     * `updateFeePlan()` returns `{ plan, affected }` — how many students sit on
     * this plan going forward. That is surfaced rather than swallowed: changing
     * an amount while dozens of students are billed against it is exactly the
     * kind of change somebody needs to see land. Invoices already raised keep
     * their own amounts; the service does not touch them.
     */
    async editFeePlan(id) {
        const plan = (this.data.feePlans || []).find((p) => p.id === id);
        if (!plan) return;

        const saved = await formModal({
            title: `Edit ${plan.name}`,
            description: 'Invoices already raised keep the amount they were raised at.',
            submitLabel: 'Save changes',
            fields: [
                { name: 'name', label: 'Plan name', required: true },
                { name: 'amount', label: 'Fee', type: 'money', required: true, min: 1,
                  help: 'Charged each period, in whole rupees.' },
                { name: 'frequency', label: 'Charged', type: 'select', required: true,
                  options: exposedFeeFrequencies().map((f) => ({ value: f.value, label: f.label })) },
                { name: 'registrationFee', label: 'One-off registration fee', type: 'money', min: 0 },
                { name: 'costumeFee', label: 'One-off costume fee', type: 'money', min: 0 }
            ],
            values: {
                name: plan.name || '', amount: plan.amount ?? '',
                frequency: plan.frequency || 'monthly',
                registrationFee: plan.registrationFee ?? '',
                costumeFee: plan.costumeFee ?? ''
            },
            onSubmit: (v) => updateFeePlan(id, v)
        });

        if (!saved) return;
        toast.success('Fee plan updated', saved.affected
            ? `${saved.affected} student${saved.affected === 1 ? '' : 's'} billed on this plan going forward.`
            : 'No student is on this plan yet.');
        this.data.feePlans = null;
        await this.loadTab();
    }

    /**
     * The label and the status are editable; the **stored value is not**.
     * `updateMasterEntry()` pins it deliberately because existing student,
     * batch and certificate records point at that key — changing it would
     * orphan them. The dialog shows it read-only rather than hiding it, so the
     * immutability is visible rather than surprising.
     */
    async editLevel(value) {
        const entry = (this.data.levels || []).find((e) => e.value === value);
        if (!entry) return;

        const others = (this.data.levels || []).filter((e) => e.value !== value);

        const saved = await formModal({
            title: `Edit ${entry.label}`,
            description: `In ${MASTER_SETS.levels.label.toLowerCase()}. Appears wherever this list is offered.`,
            submitLabel: 'Save changes',
            fields: [
                { name: 'label', label: 'Name', required: true,
                  help: 'What people see in the dropdown.' },
                { name: 'storedValue', label: 'Stored value', readonly: true,
                  help: 'Cannot be changed — existing records point at it.' },
                { name: 'status', label: 'Status', type: 'select',
                  options: [
                      { value: 'active', label: 'Active — offered in dropdowns' },
                      { value: 'inactive', label: 'Inactive — hidden from new records' }
                  ],
                  help: 'Making an entry inactive hides it from new records; anything already '
                      + 'using it keeps it.' }
            ],
            values: {
                label: entry.label || '',
                storedValue: entry.value,
                status: entry.status || 'active'
            },
            // A duplicate label is confusing even when the stored keys differ —
            // the dropdown would offer the same words twice.
            validateAll: (v) => {
                const label = String(v.label || '').trim().toLowerCase();
                return label && others.some((e) => e.label.trim().toLowerCase() === label)
                    ? { label: `"${v.label.trim()}" is already in this list.` } : null;
            },
            onSubmit: (v) => updateMasterEntry('levels', value, {
                label: String(v.label).trim(),
                status: v.status
            })
        });

        if (!saved) return;
        toast.success('Entry updated', MASTER_SETS.levels.label);
        this.data.levels = null;
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
