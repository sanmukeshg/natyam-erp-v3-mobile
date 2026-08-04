/**
 * Natyam ERP v3 — Mobile — Attendance
 *
 * The register, on a phone. This is the screen Teacher & Reception open most,
 * and the reason the mobile app exists at all — a teacher standing in a
 * studio should not be pinching a desktop table to mark a roll call.
 *
 * NO APPROVED v3 DESIGN EXISTS FOR THIS SCREEN. The Claude Design project was
 * deleted before `Attendance.dc.html` could be retrieved (see
 * docs/design/README.md). It is built instead from two settled things:
 *
 *   - **The interaction is ported, not invented.** v2's attendance page was
 *     deliberately built "for one-handed speed: everybody starts present,
 *     marking is one tap." That is preserved exactly, with All present /
 *     All absent bulk actions.
 *   - **The visual language is the implemented v3 mobile system** in
 *     assets/css/v3.css, already proven on Dashboard and Students.
 *
 * Two things this does that the desktop version does not, because a phone is
 * not a desk: the roster scrolls the *page* rather than a box inside it, and
 * the save action is a sticky bar pinned above the tab bar — a teacher part
 * way down a roll of forty should never have to scroll back up to save.
 *
 * Computes nothing: openRegister(), dayBoard(), postRegister() and
 * markingWindow() come from attendance.service.js, carried over unmodified.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { localDate, addDays, formatDate, formatDateLong } from '../../utils/date.js';
import { ATTENDANCE_STATUS } from '../../config/app.config.js';
import { dayBoard, openRegister, postRegister, markingWindow } from '../../services/attendance.service.js';

export default class MobileAttendancePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Attendance';
        this.date = this.query.date || localDate();
        // Timetable links straight at one class's register (?batch=…&date=…).
        // Held here and consumed once, on first load, so a later "back"
        // genuinely returns to the day board rather than bouncing straight
        // back into the register.
        this.pendingBatchId = this.query.batch || null;
        this.board = null;
        this.register = null;
        this.saving = false;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton" data-role="body">Loading…</div>`);
        this.bind();
        await this.loadBoard();
        this.events.on(EVENTS.BRANCH_CHANGED, () => { this.register = null; this.loadBoard(); });
    }

    async loadBoard() {
        try {
            const board = await dayBoard(this.date, session.branch());
            if (this.disposed) return;
            this.board = board;

            // Deep link from the Timetable: open that class's register
            // directly. Cleared first so it fires exactly once.
            if (this.pendingBatchId) {
                const batchId = this.pendingBatchId;
                this.pendingBatchId = null;
                await this.open(batchId, this.date);
                return;
            }

            this.paintBoard();
        } catch (err) {
            if (this.disposed) return;
            console.error('Attendance failed to load', err);
            render(this.container, html`
                <div class="m-error">The day's classes could not be loaded — ${err.message}</div>
            `);
        }
    }

    /* ------------------------------------------------------------ DAY BOARD */

    paintBoard() {
        const batches = this.board?.batches || [];
        const done = batches.filter((b) => b.done).length;
        const rule = markingWindow(this.date);
        const isToday = this.date === localDate();

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-daynav">
                    <button class="m-icon-btn" data-action="day" data-delta="-1" aria-label="Previous day">
                        ${raw(icon('chevron-left', { size: 16 }))}
                    </button>
                    <button class="m-day" data-action="today">
                        <span class="m-day-label">${isToday ? 'Today' : formatDate(this.date)}</span>
                        <span class="m-day-sub">${done} of ${batches.length} marked</span>
                    </button>
                    <button class="m-icon-btn" data-action="day" data-delta="1" aria-label="Next day">
                        ${raw(icon('chevron-right', { size: 16 }))}
                    </button>
                </div>
            </div>

            ${rule.markable ? '' : html`<div class="m-notice" data-tone="caution">${rule.message}</div>`}

            <div class="m-stack" style="margin-top:12px;">
                ${batches.length ? batches.map((batch) => html`
                    <button class="m-card m-class" data-action="open"
                            data-batch="${batch.id}" data-date="${this.date}">
                        <span class="m-class-main">
                            <span class="m-class-name">${batch.name}</span>
                            <span class="m-class-time">
                                ${batch.startTime}–${batch.endTime} · ${batch.expected} student${batch.expected === 1 ? '' : 's'}
                            </span>
                        </span>
                        <span class="m-badge" data-state="${batch.done ? 'marked' : 'missed'}">
                            ${batch.done ? `${batch.rate}%` : 'Mark'}
                        </span>
                    </button>
                `) : html`<div class="m-card m-empty">No classes scheduled on this day.</div>`}
            </div>
        `);
    }

    /* -------------------------------------------------------------- REGISTER */

    async open(batchId, date) {
        try {
            this.register = await openRegister(batchId, date);
            this.date = date;
            if (this.disposed) return;
            this.paintRegister();
        } catch (err) {
            toast.error(`Could not open that register — ${err.message}`);
        }
    }

    close() {
        this.register = null;
        this.loadBoard();
    }

    paintRegister() {
        const reg = this.register;
        const rule = markingWindow(reg.date);
        const canMark = session.can('attendance.mark') && rule.markable;
        const present = reg.entries.filter((e) => e.status === ATTENDANCE_STATUS.PRESENT).length;

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-reg-head">
                    <button class="m-icon-btn" data-action="back" aria-label="All classes">
                        ${raw(icon('arrow-left', { size: 16 }))}
                    </button>
                    <div style="min-width:0;flex:1;">
                        <div class="m-reg-name">${reg.batch.name}</div>
                        <div class="m-reg-date" data-role="tally">
                            ${present} present · ${reg.entries.length - present} absent
                        </div>
                    </div>
                </div>
                ${reg.empty ? '' : html`
                    <div class="m-chip-scroll">
                        <button class="m-pill" data-action="all" data-status="present"
                                ${canMark ? '' : 'disabled'}>All present</button>
                        <button class="m-pill" data-action="all" data-status="absent"
                                ${canMark ? '' : 'disabled'}>All absent</button>
                    </div>
                `}
            </div>

            ${!reg.scheduled ? html`
                <div class="m-notice" data-tone="caution">
                    Does not normally meet on ${reg.dayName}. Marking it will record a session.
                </div>
            ` : ''}
            ${reg.sessionStatus === 'cancelled' ? html`
                <div class="m-notice" data-tone="caution">This class was cancelled.</div>
            ` : ''}
            ${reg.postponedFrom ? html`
                <div class="m-notice" data-tone="info">Moved from ${formatDateLong(reg.postponedFrom)}.</div>
            ` : ''}
            ${!rule.markable ? html`<div class="m-notice" data-tone="caution">${rule.message}</div>` : ''}
            ${reg.alreadyMarked ? html`
                <div class="m-notice" data-tone="info">Already marked — saving corrects it.</div>
            ` : ''}

            ${reg.empty ? html`
                <div class="m-card m-empty">Nobody is in this batch yet, so there is nothing to mark.</div>
            ` : html`
                <div class="m-roster">
                    ${reg.entries.map((entry) => this.entryRow(entry, canMark))}
                </div>

                <div class="m-savebar">
                    <button class="m-btn" data-action="save" ${canMark && !this.saving ? '' : 'disabled'}>
                        ${this.saving ? 'Saving…' : reg.alreadyMarked ? 'Save corrections' : 'Save register'}
                    </button>
                </div>
            `}
        `);
    }

    entryRow(entry, canMark) {
        const absent = entry.status === ATTENDANCE_STATUS.ABSENT;
        return html`
            <button class="m-mark" data-action="toggle" data-id="${entry.studentId}"
                    data-status="${entry.status}" aria-pressed="${absent ? 'true' : 'false'}"
                    ${canMark ? '' : 'disabled'}>
                <span class="m-mark-main">
                    <span class="m-mark-name">${entry.name}</span>
                    ${entry.medicalNotes ? html`<span class="m-mark-meta">Has a medical note</span>` : ''}
                </span>
                <span class="m-mark-state">${absent ? 'Absent' : 'Present'}</span>
            </button>
        `;
    }

    /**
     * One tap flips one student, re-rendering just that row and the tally.
     * Repainting the whole roster would lose scroll position — unacceptable
     * when someone is thumbing down a list of forty in a studio.
     */
    toggle(studentId) {
        const entry = this.register?.entries.find((e) => e.studentId === studentId);
        if (!entry) return;

        entry.status = entry.status === ATTENDANCE_STATUS.ABSENT
            ? ATTENDANCE_STATUS.PRESENT
            : ATTENDANCE_STATUS.ABSENT;

        const node = this.container.querySelector(`.m-mark[data-id="${studentId}"]`);
        if (node) {
            const absent = entry.status === ATTENDANCE_STATUS.ABSENT;
            node.dataset.status = entry.status;
            node.setAttribute('aria-pressed', absent ? 'true' : 'false');
            const state = node.querySelector('.m-mark-state');
            if (state) state.textContent = absent ? 'Absent' : 'Present';
        }
        this.paintTally();
    }

    setAll(status) {
        if (!this.register) return;
        this.register.entries.forEach((entry) => { entry.status = status; });
        this.paintRegister();
    }

    paintTally() {
        const reg = this.register;
        if (!reg) return;
        const present = reg.entries.filter((e) => e.status === ATTENDANCE_STATUS.PRESENT).length;
        render(this.container.querySelector('[data-role="tally"]'),
            `${present} present · ${reg.entries.length - present} absent`);
    }

    async save() {
        if (!this.register || this.saving) return;
        this.saving = true;
        this.paintRegister();

        try {
            await postRegister({
                batchId: this.register.batch.id,
                date: this.register.date,
                entries: this.register.entries.map((e) => ({ studentId: e.studentId, status: e.status }))
            });
            toast.success('Register saved', this.register.batch.name);
            this.saving = false;
            this.close();
        } catch (err) {
            this.saving = false;
            if (this.disposed) return;
            toast.error(`Could not save — ${err.message}`);
            this.paintRegister();
        }
    }

    bind() {
        const root = this.container;
        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.open(t.dataset.batch, t.dataset.date)));
        this.onDispose(on(root, 'click', '[data-action="back"]', () => this.close()));
        this.onDispose(on(root, 'click', '[data-action="day"]', (_e, t) => {
            this.date = addDays(this.date, Number(t.dataset.delta));
            this.loadBoard();
        }));
        this.onDispose(on(root, 'click', '[data-action="today"]', () => { this.date = localDate(); this.loadBoard(); }));
        this.onDispose(on(root, 'click', '[data-action="toggle"]', (_e, t) => this.toggle(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="all"]', (_e, t) =>
            this.setAll(t.dataset.status === 'present' ? ATTENDANCE_STATUS.PRESENT : ATTENDANCE_STATUS.ABSENT)));
        this.onDispose(on(root, 'click', '[data-action="save"]', () => this.save()));
    }
}
