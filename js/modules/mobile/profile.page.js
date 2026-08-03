/**
 * Natyam ERP v3 — Mobile — My account
 *
 * NO APPROVED v3 DESIGN EXISTS FOR THIS SCREEN — never part of the Claude
 * Design project (see docs/design/README.md). Built from the v3 mobile system.
 *
 * Same four questions as the desktop page — who the school thinks you are,
 * what you can do, how you sign in, and your display preferences — as a plain
 * scrolling column of cards. There is no useful "mobile-first rethink" of an
 * account screen: it is a short list of facts and two settings.
 *
 * **`js/ui/form.js` is deliberately not used**, for the same reason as on
 * desktop: it is a v2 component library styled against `components.css`, which
 * this app only ever loads for the guardian portal. Pulling it in for one
 * two-field password form would put two design systems in a staff document.
 *
 * Sign-out is **not** duplicated here — it lives in the More sheet
 * (`js/ui/mobileShell.js`), which is where a phone user reaches for it. Two
 * sign-out buttons in one app is a way to make the wrong one memorable.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, formData, initials } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS, bus } from '../../core/bus.js';
import { formatDateLong } from '../../utils/date.js';
import { roleLabel, roleCapabilities, PREFERENCE_DEFAULTS } from '../../config/app.config.js';
import { users$, authMethodsOf } from '../../data/repositories.js';
import { setOwnPassword } from '../../services/auth.service.js';

const METHOD_LABEL = {
    google: { label: 'Google', icon: 'user' },
    password: { label: 'Email & password', icon: 'lock' },
    mobile: { label: 'Mobile OTP', icon: 'phone' }
};

const THEMES = [
    { value: 'system', label: 'Device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
];

export default class MobileProfilePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'My account';
        this.account = null;
        this.passwordOpen = false;
        this.showCaps = false;
        this.busy = false;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading your account…</div>`);
        this.bind();
        await this.load();
    }

    async load() {
        try {
            this.account = await users$.find(session.actorId());
            if (this.disposed) return;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Account failed to load', err);
            this.account = null;
            this.paint(err.message);
        }
    }

    paint(loadError = null) {
        const account = this.account;
        const prefs = session.prefs();
        const methods = account ? authMethodsOf(account) : [];
        const caps = roleCapabilities(session.role()) || [];
        const theme = prefs.theme || PREFERENCE_DEFAULTS.theme;

        render(this.container, html`
            ${loadError ? html`
                <div class="m-notice" data-tone="caution" style="margin-bottom:12px;">
                    Your full record could not be loaded (${loadError}). What is shown comes
                    from this session.
                </div>
            ` : ''}

            <div class="m-card m-identity">
                <span class="m-identity-avatar">${initials(session.actorName())}</span>
                <div class="m-identity-name">${account?.name || session.actorName()}</div>
                <div class="m-identity-role">${roleLabel(session.role()) || session.roleLabel()}</div>
            </div>

            <dl class="m-facts" style="margin-bottom:16px;">
                ${fact('Email', account?.email || '—')}
                ${fact('Mobile', account?.mobile || '—')}
                ${fact('Status', account?.status ? titleCase(account.status) : '—')}
                ${account?.createdAt ? fact('Member since', formatDateLong(account.createdAt)) : ''}
            </dl>

            <h2 class="m-section-label">How you sign in</h2>
            <div class="m-stack">
                ${methods.length ? methods.map((m) => {
                    const meta = METHOD_LABEL[m] || { label: m, icon: 'lock' };
                    return html`
                        <div class="m-card m-note">
                            <div class="m-note-head">
                                <span class="m-note-icon" data-severity="success">
                                    ${raw(icon(meta.icon, { size: 16 }))}
                                </span>
                                <div style="flex:1;min-width:0;">
                                    <div class="m-note-title">${meta.label}</div>
                                </div>
                            </div>
                        </div>
                    `;
                }) : html`<div class="m-card m-empty">No sign-in method recorded.</div>`}
            </div>

            ${this.passwordOpen ? html`
                <form class="m-card" style="padding:14px;margin-bottom:20px;" data-role="password-form">
                    <label class="m-field" style="margin-bottom:12px;">
                        <span>New password</span>
                        <input class="m-input" type="password" name="password" required
                               minlength="8" autocomplete="new-password">
                    </label>
                    <label class="m-field" style="margin-bottom:12px;">
                        <span>Repeat it</span>
                        <input class="m-input" type="password" name="confirm" required
                               minlength="8" autocomplete="new-password">
                    </label>
                    <p class="m-profile-note" style="margin-bottom:12px;">At least 8 characters.</p>
                    <div style="display:flex;gap:8px;">
                        <button class="m-btn m-btn-ghost" type="button" data-action="cancel-password">Cancel</button>
                        <button class="m-btn" style="flex:1;" type="submit" ${this.busy ? 'disabled' : ''}>
                            ${this.busy ? 'Saving…' : 'Save password'}
                        </button>
                    </div>
                </form>
            ` : html`
                <button class="m-btn m-btn-ghost m-btn-block" data-action="password" style="margin-bottom:20px;">
                    ${raw(icon('lock', { size: 16 }))}
                    ${methods.includes('password') ? 'Change password' : 'Set a password'}
                </button>
            `}

            <h2 class="m-section-label">Appearance</h2>
            <div class="m-modes" style="margin-bottom:20px;">
                ${THEMES.map((t) => html`
                    <label class="m-mode">
                        <input type="radio" name="theme" value="${t.value}" ${theme === t.value ? 'checked' : ''}>
                        <span>${t.label}</span>
                    </label>
                `)}
            </div>

            <h2 class="m-section-label">What you can do</h2>
            <button class="m-card m-announce" data-action="toggle-caps"
                    aria-expanded="${this.showCaps ? 'true' : 'false'}" style="margin-bottom:12px;">
                <span class="m-announce-icon">${raw(icon('shield', { size: 16 }))}</span>
                <span style="flex:1;min-width:0;text-align:left;">
                    <span class="m-announce-title">${caps.length} permission${caps.length === 1 ? '' : 's'}</span>
                    <span class="m-announce-sub">From the ${roleLabel(session.role()) || 'your'} role</span>
                </span>
                ${raw(icon(this.showCaps ? 'chevron-up' : 'chevron-down', { size: 16 }))}
            </button>
            ${this.showCaps ? html`
                <div class="m-card" style="padding:14px;margin-bottom:20px;">
                    <div class="m-chip-scroll" style="flex-wrap:wrap;overflow:visible;margin:0;padding:0;gap:6px;">
                        ${caps.map((c) => html`<span class="m-badge">${c}</span>`)}
                    </div>
                </div>
            ` : ''}
        `);
    }

    async savePassword(form) {
        if (this.busy) return;
        const { password, confirm } = formData(form);

        if (password !== confirm) {
            toast.error('Those two passwords do not match.');
            return;
        }

        this.busy = true;
        this.paint();

        try {
            await setOwnPassword(password);
            toast.success('Password saved', 'You can now sign in with your email and this password.');
            this.busy = false;
            this.passwordOpen = false;
            await this.load();
        } catch (err) {
            this.busy = false;
            if (this.disposed) return;
            toast.error(err.message);
            this.paint();
        }
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="password"]', () => {
            this.passwordOpen = true;
            this.paint();
            root.querySelector('[name="password"]')?.focus();
        }));

        this.onDispose(on(root, 'click', '[data-action="cancel-password"]', () => {
            this.passwordOpen = false;
            this.paint();
        }));

        this.onDispose(on(root, 'submit', '[data-role="password-form"]', (event, form) => {
            event.preventDefault();
            this.savePassword(form);
        }));

        this.onDispose(on(root, 'click', '[data-action="toggle-caps"]', () => {
            this.showCaps = !this.showCaps;
            this.paint();
        }));

        this.onDispose(on(root, 'change', '[name="theme"]', (_e, t) => {
            session.setPref('theme', t.value);
            bus.emit(EVENTS.PREFS_CHANGED, { key: 'theme', value: t.value });
        }));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
