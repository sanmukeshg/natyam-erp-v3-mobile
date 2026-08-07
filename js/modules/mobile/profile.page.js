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
 * Sign-out appears BOTH here and in the More sheet (`js/ui/mobileShell.js`).
 *
 * This file previously argued the opposite — that one sign-out was safer than
 * two — and that was wrong in practice: "My account" is the first place
 * people look for it, and a screen about your own account that cannot end
 * your own session sends you hunting through a menu. Added on the school's
 * instruction, 2026-08-05. Both entry points call the same
 * `logout()` in auth.service.js, so there is one behaviour behind two doors,
 * not two implementations.
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
import { setOwnPassword, logout } from '../../services/auth.service.js';
// UAT5 ENH-510. The Messaging SDK itself is NOT pulled in by this import —
// push.service.js loads it dynamically, and only when someone enables push.
import {
    pushSupport, currentSubscription, enablePush, disablePush, updatePushPreferences,
    PUSH_CATEGORIES, REMINDER_LEADS, PUSH_DEFAULTS
} from '../../services/push.service.js';

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
            /*
             * The account and the push state together — UAT5 ENH-510.
             *
             * currentSubscription() asks the browser for its token and looks it
             * up, so it costs one Firestore read only on a device that already
             * has notifications on; everywhere else it short-circuits on the
             * permission check. Failure is swallowed: push is the least
             * important thing on this screen and must never be the reason
             * somebody cannot see their own account.
             */
            const [account, support, subscription] = await Promise.all([
                users$.find(session.actorId()),
                Promise.resolve(pushSupport()),
                currentSubscription().catch(() => null)
            ]);
            if (this.disposed) return;
            this.account = account;
            this.pushSupport = support;
            this.pushSubscription = subscription;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Account failed to load', err);
            this.account = null;
            this.paint(err.message);
        }
    }

    /**
     * Push notification preferences — UAT5 ENH-510.
     *
     * PER DEVICE, and the heading says so. Someone with the app on a phone and
     * a tablet is making a choice about the one in their hand, and a screen
     * that implied otherwise would be lying — the token, and therefore the
     * preference, belongs to the browser it was issued in.
     *
     * WHEN PUSH CANNOT WORK, SAY WHICH THING IS MISSING. "Not supported" is a
     * dead end; "add Natyam to your Home Screen first" is an instruction, and
     * on iPhone it is the correct one — Safari only exposes push to an
     * installed app. pushSupport() draws that distinction and this renders it.
     *
     * The switch is honest about the half that does not exist yet: until a
     * sender is deployed, enabling this registers the device and delivers
     * nothing. Better said plainly here than discovered by a parent waiting for
     * a reminder that never comes.
     */
    notificationsSection() {
        const support = this.pushSupport;
        if (!support) return '';           // still resolving on first paint

        const sub = this.pushSubscription;
        const on = Boolean(sub);
        const role = session.role();
        const categories = PUSH_CATEGORIES.filter((c) => !c.roles.length || c.roles.includes(role));
        const chosen = new Set(sub?.categories || PUSH_DEFAULTS.categories);

        return html`
            <h2 class="m-section-label">Notifications on this device</h2>

            ${!support.supported || !support.configured ? html`
                <div class="m-card" style="padding:14px;margin-bottom:20px;">
                    <p class="m-profile-note" style="margin:0;">${support.reason}</p>
                </div>
            ` : html`
                <div class="m-card" style="padding:14px;margin-bottom:10px;">
                    <div class="m-subhead-row" style="justify-content:space-between;gap:12px;">
                        <div style="min-width:0;">
                            <div class="m-student-name">Push notifications</div>
                            <div class="m-student-meta">
                                ${on
                                    ? 'On for this device.'
                                    : 'Get reminders even when the app is closed.'}
                            </div>
                        </div>
                        <button class="m-btn ${on ? 'm-btn-ghost' : ''}"
                                data-action="toggle-push" ${this.busy ? 'disabled' : ''}>
                            ${this.busy ? 'Working…' : on ? 'Turn off' : 'Turn on'}
                        </button>
                    </div>

                    <!--
                      Stated on the screen, not only in a commit message. The
                      client half is real and the sender is not built yet, so a
                      person enabling this today would otherwise be waiting for
                      something that cannot arrive.
                    -->
                    ${on ? html`
                        <p class="m-subhead-note" style="margin:10px 0 0;">
                            Reminders start arriving once the school’s notification service is switched
                            on. Everything you choose here is saved and applies from that moment.
                        </p>
                    ` : ''}
                </div>

                ${on ? html`
                    <div class="m-card" style="padding:14px;margin-bottom:10px;">
                        <div class="m-kpi-label" style="margin-bottom:10px;">What to send</div>
                        ${categories.map((category) => html`
                            <label class="m-fact" style="align-items:flex-start;gap:12px;padding:7px 0;cursor:pointer;">
                                <span style="flex:1;min-width:0;">
                                    <span style="display:block;color:var(--v3-name);font-size:13px;">${category.label}</span>
                                    <span style="display:block;color:var(--v3-muted);font-size:11.5px;">${category.help}</span>
                                </span>
                                <input type="checkbox" data-role="push-category" value="${category.key}"
                                       ${chosen.has(category.key) ? 'checked' : ''}
                                       style="width:20px;height:20px;flex-shrink:0;accent-color:var(--v3-terracotta);">
                            </label>
                        `)}
                    </div>

                    <label class="m-card" style="padding:14px;margin-bottom:20px;display:block;">
                        <span class="m-kpi-label">Remind me about a class</span>
                        <select class="m-input" data-role="push-lead" style="margin-top:8px;">
                            ${REMINDER_LEADS.map((lead) => html`
                                <option value="${lead.value}"
                                        ${(sub?.leadMinutes ?? PUSH_DEFAULTS.leadMinutes) === lead.value ? 'selected' : ''}>
                                    ${lead.label}
                                </option>
                            `)}
                        </select>
                    </label>
                ` : ''}
            `}
        `;
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

            ${this.notificationsSection()}

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

            <!--
              Last on the screen, and the only destructive control on it, so it
              sits well clear of the settings above that people tap casually.
              Behaves exactly as the More sheet's own Sign out — same logout()
              call, no confirmation step — because two doors to one action that
              behave differently is worse than either behaviour on its own.
            -->
            <button class="m-btn m-btn-ghost m-btn-block" type="button" data-action="profile-logout"
                    style="margin-bottom:20px;">
                ${raw(icon('log-out', { size: 16 }))}
                <span>Sign out</span>
            </button>
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

        /* --------------------------------------------- PUSH (UAT5 ENH-510) */

        this.onDispose(on(root, 'click', '[data-action="toggle-push"]', async () => {
            if (this.busy) return;
            this.busy = true;
            this.paint();

            const result = this.pushSubscription
                ? await disablePush()
                : await enablePush();

            this.busy = false;
            if (this.disposed) return;

            // A declined permission is a normal answer, not an error — said as
            // information rather than shouted in red.
            if (!result.ok) toast.info('Notifications', result.reason);
            else toast.success(this.pushSubscription ? 'Notifications off' : 'Notifications on');

            await this.load();
        }));

        // Saved on change rather than behind a Save button: each control is a
        // single independent choice, and a settings screen that silently
        // discards a toggle because nobody found the button is worse.
        const savePreferences = async () => {
            if (!this.pushSubscription) return;
            const categories = [...root.querySelectorAll('[data-role="push-category"]')]
                .filter((node) => node.checked)
                .map((node) => node.value);
            const leadMinutes = Number(root.querySelector('[data-role="push-lead"]')?.value)
                || PUSH_DEFAULTS.leadMinutes;

            const result = await updatePushPreferences({ categories, leadMinutes });
            if (!result.ok) toast.error('Could not save', result.reason);
            else this.pushSubscription = { ...this.pushSubscription, categories, leadMinutes };
        };

        this.onDispose(on(root, 'change', '[data-role="push-category"]', savePreferences));
        this.onDispose(on(root, 'change', '[data-role="push-lead"]', savePreferences));

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

        this.onDispose(on(root, 'click', '[data-action="profile-logout"]', () => {
            // Identical to the More sheet's handler: Firebase's own auth-state
            // change (not this handler) returns to the login screen — see
            // app.js's handleAuthStateChange().
            logout().catch((err) => console.error('Sign out failed', err));
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
