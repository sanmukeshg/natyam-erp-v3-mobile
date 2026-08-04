/**
 * Natyam ERP v3 — Mobile — Programmes
 *
 * Performances, workshops, competitions, examinations and rehearsals. The
 * Annual Day rangapravesham is the event the school's year is organised
 * around, and a student's programme history is what a certificate is issued
 * against.
 *
 * WHAT A PHONE IS FOR HERE: the cast list, on the day. Standing at a venue with
 * a hall full of parents, the question is "who is on" — not "what did this
 * cost". So this screen defaults to what is coming up, leads with who is in it,
 * and lets you ring the teacher running it.
 *
 * CASTING IS AVAILABLE HERE, unlike Staff's write operations, and for a
 * specific reason: it genuinely happens away from a desk. A student drops out
 * on the morning of a performance and the list has to change before the
 * curtain. It is one tick-box list against `eligibleStudents()`, with no
 * consequence beyond the cast itself.
 *
 * SCHEDULING, EDITING, COMPLETING AND CANCELLING STAY ON DESKTOP. Completing a
 * programme posts its income and expenditure to the ledger — a bookkeeping act
 * that belongs where the figures can be checked, not thumbed in between items.
 * The sheet says so rather than leaving the absence unexplained.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatMoney, formatNumber } from '../../utils/money.js';
import { formatDate, formatDateLong } from '../../utils/date.js';
import { CAPABILITIES, levelLabel, curriculum, programTypes } from '../../config/app.config.js';
import { listBranches } from '../../services/settings.service.js';
import { listStaff } from '../../services/staff.service.js';
import { localDate } from '../../utils/date.js';
import {
    PROGRAM_STATUS, listPrograms, programSummary, programDetail,
    setParticipants, eligibleStudents, schedule, updateProgram
} from '../../services/programs.service.js';
import { formModal } from '../../ui/form.js';

const FILTERS = [
    { key: 'upcoming', label: 'Upcoming' },
    { key: null, label: 'All' },
    { key: PROGRAM_STATUS.COMPLETED, label: 'Done' }
];

export default class MobileProgramsPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Programmes';
        // Upcoming by default: on a phone the question is almost always about
        // what is next, not what already happened.
        this.filter = this.query.filter !== undefined ? this.query.filter : 'upcoming';
        this.search = '';
        this.rows = [];
        this.stats = null;
        this.detail = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading programmes…</div>`);
        this.bind();
        await this.load();

        // No PROGRAM_CANCELLED event exists — cancel() emits PROGRAM_UPDATED,
        // like every other in-place change.
        [EVENTS.PROGRAM_SCHEDULED, EVENTS.PROGRAM_UPDATED, EVENTS.PROGRAM_COMPLETED,
         EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const [rows, stats] = await Promise.all([
                listPrograms(session.branch()),
                programSummary(session.branch())
            ]);
            if (this.disposed) return;
            this.rows = rows;
            this.stats = stats;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Programmes failed to load', err);
            render(this.container, html`<div class="m-error">Programmes could not be loaded — ${err.message}</div>`);
        }
    }

    visibleRows() {
        let rows = this.rows.filter((p) => {
            if (this.filter === 'upcoming') return !p.isPast && p.status === PROGRAM_STATUS.SCHEDULED;
            if (this.filter) return p.status === this.filter;
            return true;
        });

        const term = this.search.trim().toLowerCase();
        if (term) {
            rows = rows.filter((p) =>
                [p.name, p.venue, p.typeLabel, p.leadName]
                    .some((v) => String(v || '').toLowerCase().includes(term)));
        }
        // Upcoming reads soonest-first; everything else newest-first, as listed.
        return this.filter === 'upcoming'
            ? [...rows].sort((a, b) => a.date.localeCompare(b.date))
            : rows;
    }

    paint() {
        const rows = this.visibleRows();
        const s = this.stats || {};

        render(this.container, html`
            <div class="m-subhead">
                <div class="m-subhead-row">
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">Search programmes</span>
                        <input type="search" data-role="search" placeholder="Search name, venue…">
                    </label>
                </div>
                <p class="m-subhead-note">
                    ${rows.length} shown${s.upcoming ? ` · ${formatNumber(s.upcoming)} upcoming` : ''}
                    ${s.participantsEngaged ? ` · ${formatNumber(s.participantsEngaged)} students involved this year` : ''}
                </p>
                <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
            </div>

            ${session.can(CAPABILITIES.PROGRAM_EDIT) ? html`
                <button class="m-fab" data-action="add" aria-label="Schedule a programme">
                    ${raw(icon('plus', { size: 24 }))}
                </button>
            ` : ''}

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((p) => html`
                        <button class="m-card m-student" data-action="open" data-id="${p.id}">
                            <span class="m-student-main">
                                <span class="m-student-name">${p.name}</span>
                                <span class="m-student-meta">
                                    ${p.typeLabel} · ${formatDate(p.date)}${p.venue ? ` · ${p.venue}` : ''}
                                    · ${formatNumber(p.participantCount)} taking part
                                </span>
                            </span>
                            ${p.status === PROGRAM_STATUS.CANCELLED ? html`
                                <span class="m-badge" data-fee="overdue">Cancelled</span>
                            ` : p.daysAway !== null && p.status === PROGRAM_STATUS.SCHEDULED ? html`
                                <span class="m-badge" data-fee="${p.daysAway <= 14 ? 'overdue' : 'clear'}">
                                    ${p.daysAway === 0 ? 'Today' : `${p.daysAway}d`}
                                </span>
                            ` : html`<span class="m-badge" data-fee="clear">Done</span>`}
                        </button>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty">
                    ${this.filter === 'upcoming'
                        ? 'Nothing coming up.'
                        : (this.rows.length ? 'No programme matches that.' : 'Nothing scheduled yet.')}
                </div>
            `}

            <div data-role="sheet"></div>
        `);

        this.paintSheet();
    }

    /* ---------------------------------------------------------------- SHEET */

    async open(id) {
        try {
            this.detail = await programDetail(id);
            if (this.disposed) return;
            this.paintSheet();
        } catch (err) {
            toast.error(err.message);
        }
    }

    paintSheet() {
        const target = this.container.querySelector('[data-role="sheet"]');
        if (!target) return;
        const d = this.detail;
        if (!d) { render(target, ''); return; }

        const p = d.program;
        const live = p.status === PROGRAM_STATUS.SCHEDULED || p.status === PROGRAM_STATUS.RUNNING;

        render(target, html`
            <div class="m-sheet-scrim" data-action="close-detail"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${p.name}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${p.name}</h2>
                        <p class="m-profile-sub">
                            ${p.typeLabel} · ${formatDateLong(p.date)}
                            ${p.daysAway !== null ? ` · in ${p.daysAway}d` : ''}
                        </p>
                    </div>
                    <button class="m-icon-btn" data-action="close-detail" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    ${p.status === PROGRAM_STATUS.CANCELLED ? html`
                        <div class="m-notice" data-tone="negative">
                            Cancelled${p.cancelReason ? ` — ${p.cancelReason}` : ''}.
                        </div>
                    ` : ''}

                    ${d.lead?.phone ? html`
                        <div class="m-subhead-row" style="margin-bottom:12px;">
                            <a class="m-btn" href="tel:${d.lead.phone}" style="flex:1;justify-content:center;">
                                ${raw(icon('phone', { size: 15 }))} Call ${d.lead.name}
                            </a>
                        </div>
                    ` : ''}

                    <dl class="m-facts">
                        ${fact('Venue', p.venue || '—')}
                        ${fact('Branch', d.branch?.name || '—')}
                        ${fact('Led by', d.lead?.name || 'Not assigned')}
                        ${fact('Taking part', formatNumber(d.participants.length))}
                        ${p.status === PROGRAM_STATUS.COMPLETED ? fact('Net', formatMoney(d.net)) : ''}
                    </dl>
                    ${p.notes ? html`<p class="m-subhead-note">${p.notes}</p>` : ''}

                    <p class="m-section-label" style="margin-top:16px;">
                        Cast${d.participants.length ? ` · ${formatNumber(d.participants.length)}` : ''}
                    </p>
                    ${d.participants.length ? html`
                        <div class="m-stack">
                            ${d.participants.map((s) => html`
                                <a class="m-card m-student" href="#/students?student=${s.id}">
                                    <span class="m-student-main">
                                        <span class="m-student-name">${s.name}</span>
                                        <span class="m-student-meta">${s.level ? levelLabel(s.level) : '—'}</span>
                                    </span>
                                </a>
                            `)}
                        </div>
                    ` : html`<p class="m-subhead-note">Nobody has been cast yet.</p>`}

                    ${live && session.can(CAPABILITIES.PROGRAM_EDIT) ? html`
                        <div class="m-actions" style="margin-top:10px;">
                            <button class="m-btn" data-action="cast">
                                ${raw(icon('users', { size: 15 }))} Choose cast
                            </button>
                            ${session.can(CAPABILITIES.PROGRAM_EDIT) ? html`
                                <button class="m-btn m-btn-ghost" data-action="edit-program">
                                    ${raw(icon('edit', { size: 15 }))} Edit programme
                                </button>
                            ` : ''}
                        </div>
                    ` : ''}

                    <p class="m-subhead-note" style="margin-top:16px;">
                        Scheduling, edits, completing and cancelling are done on the desktop app —
                        completing a programme posts its income and expenditure to the ledger.
                    </p>
                </div>
            </div>
        `);
    }

    /**
     * Casting on a phone — the one write this screen carries.
     *
     * `setParticipants()` replaces the cast wholesale, so the box arrives with
     * the current cast already ticked. Submitting an emptied form clears it,
     * and that must be a deliberate act rather than an accident of not
     * realising the field was pre-filled — hence the description saying so.
     */
    async chooseCast() {
        const p = this.detail?.program;
        if (!p) return;

        let eligible;
        try {
            eligible = await eligibleStudents(p.id);
        } catch (err) {
            toast.error(err.message);
            return;
        }
        if (!eligible.length) {
            toast.error('Nobody is eligible', 'No student matches this programme.');
            return;
        }

        const current = this.detail.participants.map((s) => s.id);

        const saved = await formModal({
            title: `Cast for ${p.name}`,
            description: 'This replaces the current cast — anyone unticked is taken out.',
            submitLabel: 'Save cast',
            fields: [
                // eligibleStudents() returns raw student documents, so the
                // level is a code — resolved here rather than printing
                // "foundation-3" at somebody.
                { name: 'participants', label: 'Taking part', type: 'checks', itemNoun: 'student',
                  options: eligible.map((s) => ({
                      value: s.id,
                      label: `${s.name}${s.level ? ` — ${levelLabel(s.level)}` : ''}`
                  })) }
            ],
            values: { participants: current },
            onSubmit: (v) => setParticipants(p.id, v.participants)
        });

        if (!saved) return;
        toast.success('Cast updated.');
        await this.open(p.id);
        await this.load();
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

        this.onDispose(on(root, 'click', '[data-action="open"]', (_e, t) => this.open(t.dataset.id)));
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', () => {
            this.detail = null;
            this.paintSheet();
        }));
        this.onDispose(on(root, 'click', '[data-action="cast"]', () => this.chooseCast()));
        this.onDispose(on(root, 'click', '[data-action="edit-program"]', () => this.editProgram()));
        this.onDispose(on(root, 'click', '[data-action="add"]', () => this.newProgram()));

        this.onKey = (event) => {
            if (event.key === 'Escape' && this.detail) { this.detail = null; this.paintSheet(); }
        };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
    /* --------------------------------------------------------- CREATE/EDIT */
    /*
     * UAT BUG-201. Programmes were read-only on mobile: no way to schedule one,
     * and no way to correct a date or a venue once scheduled. Both flows go
     * through the same services the desktop app uses, so the service's own
     * shape assertions — an examination needing a level, a name and a date
     * being required — are enforced identically on both surfaces.
     */

    /** The programme form's fields. `existing` seeds them for an edit. */
    async programFields(existing = null) {
        const [branches, staff] = await Promise.all([
            listBranches(),
            listStaff(session.branch()).catch(() => [])
        ]);
        const defaultBranchId = existing?.branchId
            || session.branch()
            || (branches.length === 1 ? branches[0].id : '');

        return [
            { name: 'name', label: 'Name', required: true, value: existing?.name },
            { name: 'type', label: 'Type', type: 'select', required: true, placeholder: 'Choose a type',
              options: programTypes().map((t) => ({ value: t.value, label: t.label })),
              value: existing?.type },
            { name: 'date', label: 'Date', type: 'date', required: true,
              value: existing?.date || localDate() },
            { name: 'branchId', label: 'Branch', type: 'select', required: true,
              placeholder: branches.length > 1 ? 'Choose a branch' : null,
              options: branches.map((b) => ({ value: b.id, label: b.name })),
              value: defaultBranchId },
            // Required by the service for examinations only — hence showIf,
            // which also keeps the validator off it for every other type.
            { name: 'level', label: 'Level examined', type: 'select', placeholder: 'Choose a level',
              options: curriculum().map((l) => ({ value: l.value, label: l.label })),
              value: existing?.level,
              showIf: (v) => v.type === 'examination',
              help: 'An examination is held for one specific level.' },
            { name: 'venue', label: 'Venue', value: existing?.venue },
            { name: 'leadStaffId', label: 'Led by', type: 'select', placeholder: 'Not assigned',
              options: staff.map((m) => ({ value: m.id, label: `${m.name} — ${m.roleLabel}` })),
              value: existing?.leadStaffId },
            { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: existing?.notes }
        ];
    }

    /** Turns the field list into the `values` map formModal seeds itself from. */
    static seed(fields) {
        return Object.fromEntries(fields.map((f) => [f.name, f.value ?? '']));
    }

    async newProgram() {
        session.require(CAPABILITIES.PROGRAM_EDIT, 'schedule a programme');
        const fields = await this.programFields();

        const created = await formModal({
            title: 'Schedule a programme',
            description: 'A performance, workshop, competition, examination or rehearsal.',
            submitLabel: 'Schedule',
            fields,
            values: MobileProgramsPage.seed(fields),
            onSubmit: (v) => schedule(v)
        });

        if (!created) return;
        toast.success('Scheduled', `${created.name} on ${formatDateLong(created.date)}`);
        await this.load();
        await this.open(created.id);
    }

    async editProgram() {
        const program = this.detail?.program;
        if (!program) return;
        session.require(CAPABILITIES.PROGRAM_EDIT, 'edit a programme');

        const fields = await this.programFields(program);

        const saved = await formModal({
            title: `Edit ${program.name}`,
            submitLabel: 'Save changes',
            fields,
            values: MobileProgramsPage.seed(fields),
            onSubmit: (v) => updateProgram(program.id, v)
        });

        if (!saved) return;
        toast.success('Programme updated', program.name);
        await this.open(program.id);
        await this.load();
    }
}

/* ------------------------------------------------------------------ HELPERS */

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
