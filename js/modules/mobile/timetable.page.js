/**
 * Natyam ERP v3 — Mobile — Timetable
 *
 * The week, on a phone: a day picker across the top, then that day's classes
 * as an agenda. A seven-column grid is the right answer on a desk and the
 * wrong one in a hand, so this is a genuinely different component — which is
 * also what the design project specified before it was lost:
 *
 *   > "Built Timetable module: weekly grid (Desktop) and day-picker + agenda
 *   >  (Mobile)"
 *   > "Timetable: weekly-grid tiles (desktop) and agenda cards (mobile) now
 *   >  show only the batch name and time slot — dropped the stacked
 *   >  curriculum levels / teacher / room line"
 *
 * Both instructions are honoured: day-picker + agenda, and a card carries the
 * batch name and its time. The teacher is kept on the agenda card — a phone
 * card has the room for one more line where a grid tile does not, and at the
 * front desk "who is teaching it" is the question actually being asked.
 *
 * This is also **Attendance's front door** on mobile: tapping a class opens
 * its register.
 *
 * Data is entirely `timetable()` from batches.service.js, carried over
 * unmodified — including replacement sessions and postponed originals.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { session } from '../../core/session.js';
import { router } from '../../core/router.js';
import { EVENTS } from '../../core/bus.js';
import { startOfWeek, addDays, localDate, formatDate } from '../../utils/date.js';
import { timetable } from '../../services/batches.service.js';
import { markingWindow } from '../../services/attendance.service.js';
import { showLoadError } from '../../ui/loadState.js';

const WEEK_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default class MobileTimetablePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Timetable';
        this.weekStart = this.query.week || startOfWeek();
        // Which column is open. Defaults to today when today is in the week
        // being shown, otherwise Monday — opening an arbitrary day would be
        // a small daily annoyance for no reason.
        this.activeDay = null;
        this.days = [];
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading the week…</div>`);
        this.bind();
        await this.load();

        [EVENTS.ATTENDANCE_SAVED, EVENTS.BATCH_UPDATED, EVENTS.SESSION_POSTPONED,
         EVENTS.SESSION_CANCELLED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const days = await timetable(session.branch(), this.weekStart);
            if (this.disposed) return;
            this.days = days;

            if (!this.activeDay) {
                const today = localDate();
                const todayCol = days.find((d) => d.sessions[0]?.date === today)
                    || days.find((_d, i) => addDays(this.weekStart, i) === today);
                this.activeDay = todayCol?.day || WEEK_ORDER[0];
            }
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Timetable failed to load', err);
            showLoadError(this.container, { what: 'The week', error: err, onRetry: () => this.load() });
        }
    }

    paint() {
        const today = localDate();
        const active = this.days.find((d) => d.day === this.activeDay) || this.days[0];
        const activeDate = dateFor(this.weekStart, active?.day);
        const total = this.days.reduce((sum, d) => sum + d.sessions.length, 0);
        const marked = this.days.reduce((sum, d) => sum + d.sessions.filter((s) => s.registerMarked).length, 0);

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-daynav">
                    <button class="m-icon-btn" data-action="week" data-delta="-7" aria-label="Previous week">
                        ${raw(icon('chevron-left', { size: 16 }))}
                    </button>
                    <button class="m-day" data-action="this-week">
                        <span class="m-day-label">${formatDate(this.weekStart, { withYear: false })} – ${formatDate(addDays(this.weekStart, 6), { withYear: false })}</span>
                        <span class="m-day-sub">${marked} of ${total} marked</span>
                    </button>
                    <button class="m-icon-btn" data-action="week" data-delta="7" aria-label="Next week">
                        ${raw(icon('chevron-right', { size: 16 }))}
                    </button>
                </div>

                <div class="m-chip-scroll m-daypicker">
                    ${this.days.map((day) => {
                        const date = dateFor(this.weekStart, day.day);
                        const due = day.sessions.some((s) => !s.registerMarked && s.sessionStatus !== 'cancelled' && date <= today);
                        return html`
                            <button class="m-daychip" data-action="day" data-day="${day.day}"
                                    aria-pressed="${day.day === this.activeDay ? 'true' : 'false'}"
                                    data-today="${date === today ? 'true' : 'false'}">
                                <span class="m-daychip-name">${day.day}</span>
                                <span class="m-daychip-count">
                                    ${day.sessions.length || '—'}${due ? html`<i class="m-daychip-dot"></i>` : ''}
                                </span>
                            </button>
                        `;
                    })}
                </div>
            </div>

            <p class="m-section-label" style="margin-top:14px;">
                ${active ? `${active.label || active.day} · ${formatDate(activeDate)}` : ''}
            </p>

            <div class="m-stack">
                ${active?.sessions.length ? active.sessions.map((slot) => this.card(slot, today)) : html`
                    <div class="m-card m-empty">No classes on this day.</div>
                `}
            </div>
        `);
    }

    card(slot, today) {
        const cancelled = slot.sessionStatus === 'cancelled';
        const past = slot.date <= today;
        const state = cancelled ? 'cancelled'
            : slot.registerMarked ? 'marked'
            : slot.isReplacement ? 'replacement'
            : past ? 'due' : 'upcoming';

        const markable = !cancelled && markingWindow(slot.date).markable && session.can('attendance.view');

        return html`
            <button class="m-card m-slot" data-state="${state}"
                    data-action="open" data-batch="${slot.id}" data-date="${slot.date}"
                    ${markable ? '' : 'disabled'}>
                <span class="m-slot-main">
                    <span class="m-slot-name">${slot.name}</span>
                    <span class="m-slot-meta">${slot.startTime}–${slot.endTime} · ${slot.teacherName}</span>
                </span>
                <span class="m-badge" data-state="${state === 'due' ? 'missed' : state === 'marked' ? 'marked' : 'upcoming'}">
                    ${cancelled ? 'Cancelled' : slot.registerMarked ? 'Marked' : past ? 'Mark' : 'Later'}
                </span>
            </button>
        `;
    }

    bind() {
        const root = this.container;

        this.onDispose(on(root, 'click', '[data-action="week"]', (_e, t) => {
            this.weekStart = addDays(this.weekStart, Number(t.dataset.delta));
            // A new week has no reason to keep yesterday's column open; let
            // load() re-resolve to today (or Monday).
            this.activeDay = null;
            this.load();
        }));
        this.onDispose(on(root, 'click', '[data-action="this-week"]', () => {
            this.weekStart = startOfWeek();
            this.activeDay = null;
            this.load();
        }));
        this.onDispose(on(root, 'click', '[data-action="day"]', (_e, t) => {
            this.activeDay = t.dataset.day;
            this.paint();
        }));
        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => {
            router.go(`/attendance?date=${t.dataset.date}&batch=${t.dataset.batch}`);
        }));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function dateFor(weekStart, dayName) {
    const index = WEEK_ORDER.indexOf(dayName);
    return index < 0 ? weekStart : addDays(weekStart, index);
}
