/**
 * Natyam ERP v3 — Mobile — Notifications
 *
 * NO APPROVED v3 DESIGN EXISTS FOR THIS SCREEN — Notifications was never part
 * of the Claude Design project (see docs/design/README.md). Built from the v3
 * mobile system.
 *
 * Severity ordering comes from the service, not from this page: `centre()`
 * maps each row to error / warning / success / info on the stated grounds that
 * *"what must I deal with" is the question being asked*. Unread and urgent
 * sort to the top.
 *
 * Differences from the desktop page, because a phone is a glanced-at device:
 *   - **Swipe-free, tap-only.** The whole card is the "open" target; dismiss is
 *     an explicit button. A swipe-to-dismiss gesture on a list that also
 *     scrolls is how notifications get destroyed by accident.
 *   - **Announcements are collapsed to a single banner** unless tapped. On a
 *     phone the alert list is the point; a wall of notices above it buries the
 *     thing that needs doing.
 *   - Actions live at the foot of each card, full-width enough to hit.
 *
 * As on desktop, `refreshAlerts()` is an explicit action rather than something
 * that runs at boot — v3 does not carry the reference app's boot maintenance
 * sweep, and silently writing to Firestore on every launch is not something to
 * reintroduce by accident. See MIGRATION_CHECKLIST.md.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { relativeTime } from '../../utils/date.js';
import { centre, markRead, markAllRead, dismiss, refreshAlerts } from '../../services/notifications.service.js';

const SEVERITY_ORDER = { error: 0, warning: 1, success: 2, info: 3 };

const FILTERS = [
    { key: null, label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'error', label: 'Urgent' },
    { key: 'warning', label: 'Attention' }
];

export default class MobileNotificationsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Notifications';
        this.data = null;
        this.filter = this.query.filter || null;
        this.showAnnouncements = false;
        this.busy = false;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading…</div>`);
        this.bind();
        await this.load();

        [EVENTS.NOTIFICATION_ADDED, EVENTS.NOTIFICATION_READ]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const data = await centre();
            if (this.disposed) return;
            this.data = data;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Notifications failed to load', err);
            render(this.container, html`
                <div class="m-error">Notifications could not be loaded — ${err.message}</div>
            `);
        }
    }

    visibleRows() {
        let rows = [...(this.data?.rows || [])];
        if (this.filter === 'unread') rows = rows.filter((r) => !r.read);
        else if (this.filter) rows = rows.filter((r) => r.severity === this.filter);

        return rows.sort((a, b) =>
            (Number(Boolean(a.read)) - Number(Boolean(b.read)))
            || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
            || (b.at || '').localeCompare(a.at || ''));
    }

    paint() {
        const d = this.data;
        const rows = this.visibleRows();
        const announcements = d?.announcements || [];

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row" style="align-items:center;">
                    <div style="flex:1;min-width:0;">
                        <div class="m-appbar-title" style="font-size:15px;">
                            ${d ? `${d.unread} unread` : 'Notifications'}
                        </div>
                        <div class="m-subhead-note" style="margin:0;">
                            ${d ? `${d.rows.length} recent` : ''}
                        </div>
                    </div>
                    <button class="m-icon-btn" data-action="refresh" aria-label="Refresh alerts"
                            ${this.busy ? 'disabled' : ''}>
                        ${raw(icon('refresh-cw', { size: 16 }))}
                    </button>
                    <button class="m-icon-btn" data-action="mark-all" aria-label="Mark all read"
                            ${d?.unread ? '' : 'disabled'}>
                        ${raw(icon('check', { size: 16 }))}
                    </button>
                </div>
                <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
            </div>

            ${announcements.length ? html`
                <button class="m-card m-announce" data-action="toggle-announce"
                        aria-expanded="${this.showAnnouncements ? 'true' : 'false'}">
                    <span class="m-announce-icon">${raw(icon('bell', { size: 16 }))}</span>
                    <span style="flex:1;min-width:0;text-align:left;">
                        <span class="m-announce-title">
                            ${announcements.length} announcement${announcements.length === 1 ? '' : 's'}
                        </span>
                        <span class="m-announce-sub">${announcements[0].title}</span>
                    </span>
                    ${raw(icon(this.showAnnouncements ? 'chevron-up' : 'chevron-down', { size: 16 }))}
                </button>

                ${this.showAnnouncements ? html`
                    <div class="m-stack" style="margin-bottom:12px;">
                        ${announcements.map((a) => html`
                            <div class="m-card" style="padding:13px 14px;">
                                <div class="m-card-title">${a.pinned ? '📌 ' : ''}${a.title}</div>
                                ${a.body ? html`<div class="m-card-meta">${a.body}</div>` : ''}
                                <div class="m-card-meta">${a.author || 'The school'}${a.at ? ` · ${relativeTime(a.at)}` : ''}</div>
                            </div>
                        `)}
                    </div>
                ` : ''}
            ` : ''}

            <div class="m-stack">
                ${rows.length ? rows.map((row) => html`
                    <div class="m-card m-note" data-severity="${row.severity}" data-read="${row.read ? 'true' : 'false'}">
                        <div class="m-note-head">
                            <span class="m-note-icon" data-severity="${row.severity}">
                                ${raw(icon(row.meta?.icon || 'info', { size: 16 }))}
                            </span>
                            <div style="flex:1;min-width:0;">
                                <div class="m-note-title">${row.title}</div>
                                ${row.body ? html`<div class="m-note-body">${row.body}</div>` : ''}
                                <div class="m-note-when">${row.at ? relativeTime(row.at) : ''}</div>
                            </div>
                        </div>
                        <div class="m-note-actions">
                            ${row.link ? html`
                                <a class="m-btn m-btn-ghost m-btn-sm" href="${row.link}"
                                   data-action="open" data-id="${row.id}">Open</a>
                            ` : ''}
                            ${!row.read ? html`
                                <button class="m-btn m-btn-ghost m-btn-sm" data-action="read" data-id="${row.id}">
                                    Mark read
                                </button>
                            ` : ''}
                            <button class="m-icon-btn m-icon-btn-sm" data-action="dismiss" data-id="${row.id}"
                                    aria-label="Dismiss">
                                ${raw(icon('x', { size: 15 }))}
                            </button>
                        </div>
                    </div>
                `) : html`
                    <div class="m-card m-empty">
                        ${this.filter ? 'Nothing matches that filter.' : 'Nothing to deal with.'}
                    </div>
                `}
            </div>
        `);
    }

    async run(label, fn) {
        if (this.busy) return;
        this.busy = true;
        try {
            await fn();
            await this.load();
        } catch (err) {
            if (!this.disposed) toast.error(`${label} failed — ${err.message}`);
        } finally {
            this.busy = false;
        }
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="filter"]', (_e, t) => {
            const key = t.dataset.key || null;
            this.filter = this.filter === key ? null : key;
            this.paint();
        }));

        this.onDispose(on(root, 'click', '[data-action="toggle-announce"]', () => {
            this.showAnnouncements = !this.showAnnouncements;
            this.paint();
        }));

        this.onDispose(on(root, 'click', '[data-action="read"]', (_e, t) =>
            this.run('Marking read', () => markRead(t.dataset.id))));

        this.onDispose(on(root, 'click', '[data-action="dismiss"]', (_e, t) =>
            this.run('Dismissing', () => dismiss(t.dataset.id))));

        this.onDispose(on(root, 'click', '[data-action="mark-all"]', () =>
            this.run('Marking all read', () => markAllRead())));

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => {
            const row = this.data?.rows.find((r) => r.id === t.dataset.id);
            if (row && !row.read) markRead(row.id).catch(() => {});
        }));

        this.onDispose(on(root, 'click', '[data-action="refresh"]', () =>
            this.run('Refreshing alerts', async () => {
                const written = await refreshAlerts({ branchId: session.branch() });
                toast.success('Alerts refreshed', `${written} recalculated.`);
            })));
    }
}
