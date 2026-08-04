/**
 * Natyam ERP v3 — Mobile — Certificates
 *
 * A certificate is the only artefact this system produces that leaves the
 * building and outlives it. A parent will present a Foundation Level 5
 * certificate to a college admissions officer in eleven years' time, and the
 * only thing standing behind it will be a serial this module minted.
 *
 * WHAT A PHONE IS FOR HERE: **verifying**. Somebody rings the school holding a
 * piece of paper and asks whether it is real. That call gets answered wherever
 * the person picking up happens to be standing, so Verify is the first thing on
 * this screen rather than something behind a menu.
 *
 * Verification needs no capability, deliberately — an office junior taking that
 * call should be able to answer it. And a revoked serial verifies
 * *successfully*, returning "revoked on 12 March, reason: issued in error",
 * because "not found" is indistinguishable from a typo and tells the person
 * holding the paper nothing.
 *
 * ISSUING AND REVOKING STAY ON DESKTOP. Issuing mints a permanent serial and
 * can waive an eligibility rule with a reason recorded on the certificate
 * forever; revoking is equally final. Neither is a thing to do one-handed
 * between classes, and the sheet says so.
 */

import { Page } from '../../core/router.js';
import { html, render, raw, on, debounce } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { session } from '../../core/session.js';
import { EVENTS } from '../../core/bus.js';
import { formatNumber } from '../../utils/money.js';
import { formatDateLong } from '../../utils/date.js';
import { levelLabel, CAPABILITIES } from '../../config/app.config.js';
import {
    listCertificates, certificateSummary, verify,
    TEMPLATES, checkEligibility, issue, revoke
} from '../../services/certificates.service.js';
import { listStudents } from '../../services/students.service.js';
import { listPrograms, PROGRAM_STATUS } from '../../services/programs.service.js';
import { formModal, confirmModal } from '../../ui/form.js';
import { toast } from '../../ui/toast.js';
import { localDate } from '../../utils/date.js';

const FILTERS = [
    { key: null, label: 'All' },
    { key: 'issued', label: 'Valid' },
    { key: 'revoked', label: 'Revoked' }
];

export default class MobileCertificatesPage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Certificates';
        this.filter = this.query.filter || null;
        this.search = '';
        this.rows = [];
        this.stats = null;
        this.detail = null;
    }

    async render(container) {
        this.container = container;
        render(container, html`<div class="m-skeleton">Loading certificates…</div>`);
        this.bind();
        await this.load();

        [EVENTS.CERTIFICATE_ISSUED, EVENTS.CERTIFICATE_REVOKED, EVENTS.BRANCH_CHANGED]
            .forEach((event) => this.events.on(event, () => this.load()));
    }

    async load() {
        try {
            const [rows, stats] = await Promise.all([
                listCertificates({ branchId: session.branch() }),
                certificateSummary(session.branch())
            ]);
            if (this.disposed) return;
            this.rows = rows;
            this.stats = stats;
            this.paint();
        } catch (err) {
            if (this.disposed) return;
            console.error('Certificates failed to load', err);
            render(this.container, html`<div class="m-error">Certificates could not be loaded — ${err.message}</div>`);
        }
    }

    visibleRows() {
        let rows = this.rows.filter((c) => {
            if (this.filter === 'issued') return c.status !== 'revoked';
            if (this.filter === 'revoked') return c.status === 'revoked';
            return true;
        });

        const term = this.search.trim().toLowerCase();
        if (term) {
            rows = rows.filter((c) =>
                [c.serial, c.studentName, c.title, c.templateName]
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
                        <span class="sr-only">Search certificates</span>
                        <input type="search" data-role="search" placeholder="Search serial or student…">
                    </label>
                </div>
                <p class="m-subhead-note">
                    ${rows.length} of ${this.rows.length} issued${s.revoked ? ` · ${formatNumber(s.revoked)} revoked` : ''}
                </p>
                <div class="m-chip-scroll">
                    ${FILTERS.map((f) => html`
                        <button class="m-pill" data-action="filter" data-key="${f.key || ''}"
                                aria-pressed="${this.filter === f.key ? 'true' : 'false'}">${f.label}</button>
                    `)}
                </div>
            </div>

            <!-- First, not buried: answering "is this real" down a telephone is
                 the reason this screen is worth having on a handset. -->
            ${session.can(CAPABILITIES.CERTIFICATE_ISSUE) ? html`
                <button class="m-fab" data-action="issue" aria-label="Issue a certificate">
                    ${raw(icon('plus', { size: 24 }))}
                </button>
            ` : ''}

            <button class="m-btn m-btn-block" data-action="verify" style="margin-bottom:12px;">
                ${raw(icon('search', { size: 15 }))} Verify a serial
            </button>

            ${rows.length ? html`
                <div class="m-stack">
                    ${rows.map((c) => html`
                        <button class="m-card m-student" data-action="open" data-id="${c.id}">
                            <span class="m-student-main">
                                <span class="m-student-name">${c.studentName || 'Unknown student'}</span>
                                <span class="m-student-meta">
                                    ${c.serial} · ${c.templateName || c.templateId}
                                    ${c.issuedOn ? ` · ${formatDateLong(c.issuedOn)}` : ''}
                                </span>
                            </span>
                            <span class="m-badge" data-fee="${c.status === 'revoked' ? 'overdue' : 'clear'}">
                                ${c.status === 'revoked' ? 'Revoked' : 'Valid'}
                            </span>
                        </button>
                    `)}
                </div>
            ` : html`
                <div class="m-card m-empty">
                    ${this.rows.length ? 'No certificate matches that.' : 'None issued yet.'}
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
        const c = this.detail;
        if (!c) { render(target, ''); return; }

        render(target, html`
            <div class="m-sheet-scrim" data-action="close-detail"></div>
            <div class="m-profile" role="dialog" aria-modal="true" aria-label="${c.serial}">
                <div class="m-profile-head">
                    <div style="min-width:0;">
                        <h2 class="m-profile-name">${c.studentName || 'Certificate'}</h2>
                        <p class="m-profile-sub">${c.serial}</p>
                    </div>
                    <button class="m-icon-btn" data-action="close-detail" aria-label="Close">
                        ${raw(icon('x', { size: 16 }))}
                    </button>
                </div>

                <div class="m-profile-body">
                    ${c.status === 'revoked' ? html`
                        <div class="m-notice" data-tone="negative">
                            Revoked${c.revokedOn ? ` on ${formatDateLong(c.revokedOn)}` : ''}${c.revokeReason ? ` — ${c.revokeReason}` : ''}.
                            The serial still verifies and returns this.
                        </div>
                    ` : ''}
                    ${c.overridden ? html`
                        <div class="m-notice" data-tone="caution">
                            Issued on override — ${c.overrideReason || 'no reason recorded'}.
                        </div>
                    ` : ''}

                    <!-- Read off the record, never regenerated: issue() renders the
                         wording once and stores it, so a certificate says in 2037
                         exactly what it said the day it was issued. -->
                    ${c.body ? html`<p class="m-subhead-note">${c.body}</p>` : ''}

                    <dl class="m-facts">
                        ${fact('Serial', c.serial)}
                        ${fact('Kind', c.templateName || c.templateId || '—')}
                        ${fact('Issued', c.issuedOn ? formatDateLong(c.issuedOn) : '—')}
                        ${fact('Academic year', c.academicYear || '—')}
                        ${c.level ? fact('Level', levelLabel(c.level)) : ''}
                    </dl>

                    ${c.signatories?.length ? html`
                        <p class="m-section-label" style="margin-top:16px;">Signed by</p>
                        <div class="m-checks">
                            ${c.signatories.map((sig) => html`<span class="m-badge">${sig}</span>`)}
                        </div>
                    ` : ''}

                    ${c.status !== 'revoked' && session.can(CAPABILITIES.CERTIFICATE_ISSUE) ? html`
                        <div class="m-actions" style="margin-top:16px;">
                            <button class="m-btn m-btn-ghost" data-action="revoke">
                                ${raw(icon('x', { size: 15 }))} Revoke
                            </button>
                        </div>
                    ` : ''}
                    <p class="m-subhead-note" style="margin-top:8px;">
                        A serial is permanent. Revoking keeps the record and reports the reason
                        on every future verification — it is never edited or deleted.
                    </p>
                </div>
            </div>
        `);
    }

    /**
     * Verifying a serial.
     *
     * The answer is thrown rather than resolved so it stays on screen beside
     * the serial that was typed — somebody reading it down a telephone needs it
     * to sit still, not flash past in a toast. `verify()` already writes the
     * sentence, so it is shown as written rather than reassembled here.
     */
    async verifySerial() {
        await formModal({
            title: 'Verify a certificate',
            description: 'Type the serial exactly as printed on the paper.',
            submitLabel: 'Verify',
            fields: [
                { name: 'serial', label: 'Serial', required: true, placeholder: 'NAT/CRT/26/0001' }
            ],
            values: { serial: '' },
            onSubmit: async (v) => {
                const result = await verify(v.serial.trim());
                if (!result?.found) {
                    throw new Error(`No certificate has ever been issued with the serial "${v.serial.trim()}".`);
                }
                const c = result.certificate;
                throw new Error(
                    `${c.serial} — ${c.title || c.templateName || ''}. ${result.message}`
                    + (c.overridden
                        ? ` Issued on override: ${c.overrideReason || 'no reason recorded'}.`
                        : ''));
            }
        });
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
            this.detail = this.rows.find((c) => c.id === t.dataset.id) || null;
            this.paintSheet();
        }));
        this.onDispose(on(root, 'click', '[data-action="close-detail"]', () => {
            this.detail = null;
            this.paintSheet();
        }));
        this.onDispose(on(root, 'click', '[data-action="verify"]', () => this.verifySerial()));
        this.onDispose(on(root, 'click', '[data-action="issue"]', () => this.issueCertificate()));
        this.onDispose(on(root, 'click', '[data-action="revoke"]', () => this.revokeCertificate()));

        this.onKey = (event) => {
            if (event.key === 'Escape' && this.detail) { this.detail = null; this.paintSheet(); }
        };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
    /* --------------------------------------------------- ISSUE AND REVOKE */
    /*
     * UAT BUG-202. The Student sheet offered "Issue certificate" but this
     * module could only verify, so there was nowhere to issue from the
     * certificates screen itself and no way to revoke one at all.
     *
     * Edit and Delete are deliberately NOT here, per the decision taken on this
     * round. A serial is permanent and may already be in a family's hands:
     * editing it would silently change what a past verification returned, and
     * deleting it would make a serial that was really issued verify as
     * non-existent. Revoking is the correcting path — it keeps the record,
     * records why, and every future verification says so.
     */

    async issueCertificate() {
        session.require(CAPABILITIES.CERTIFICATE_ISSUE, 'issue a certificate');

        const [students, programs] = await Promise.all([
            listStudents(session.branch()),
            listPrograms(session.branch(), { status: PROGRAM_STATUS.COMPLETED }).catch(() => [])
        ]);

        if (!students.length) {
            toast.error('Nobody to issue to', 'There are no students on the roll.');
            return;
        }

        const issued = await formModal({
            title: 'Issue a certificate',
            description: 'The serial is allocated when it is issued and never reused.',
            submitLabel: 'Check and issue',
            fields: [
                { name: 'studentId', label: 'Student', type: 'select', required: true,
                  placeholder: 'Choose a student',
                  options: students.map((s) => ({
                      value: s.id,
                      label: `${s.name}${s.level ? ` — ${levelLabel(s.level)}` : ''}`
                  })) },
                { name: 'templateId', label: 'Kind', type: 'select', required: true,
                  placeholder: 'Choose a kind',
                  options: TEMPLATES.map((t) => ({ value: t.id, label: t.name })) },
                { name: 'programId', label: 'Programme', type: 'select',
                  placeholder: programs.length ? 'Choose a programme' : 'No completed programme yet',
                  options: programs.map((pr) => ({
                      value: pr.id, label: `${pr.name} — ${formatDateLong(pr.date)}`
                  })),
                  showIf: (v) => v.templateId === 'participation',
                  help: 'A participation certificate is issued against a completed programme.' },
                { name: 'citation', label: 'Citation', type: 'textarea', rows: 2,
                  showIf: (v) => v.templateId === 'merit',
                  help: 'What is being recognised. It is printed on the certificate.' },
                { name: 'issuedOn', label: 'Issued on', type: 'date' }
            ],
            values: { studentId: '', templateId: '', programId: '', citation: '', issuedOn: localDate() },
            onSubmit: async (v) => {
                const payload = {
                    studentId: v.studentId,
                    templateId: v.templateId,
                    programId: v.programId || null,
                    citation: v.citation || null
                };

                // Eligibility is asked of the service, never guessed here.
                const check = await checkEligibility(payload);
                if (check.ok) return issue({ ...payload, issuedOn: v.issuedOn || null });

                const reasons = check.reasons.join(' ');
                const proceed = await confirmModal({
                    title: 'This does not meet the rules',
                    message: `${reasons} A certificate can still be issued, but the override is `
                           + 'recorded on it permanently and shows on every verification.',
                    confirmLabel: 'Issue on override',
                    tone: 'negative'
                });
                if (!proceed) throw new Error(reasons);

                const overrideReason = await formModal({
                    title: 'Why is this being overridden?',
                    description: 'Stored on the certificate itself, not just in a log.',
                    submitLabel: 'Issue',
                    fields: [{ name: 'overrideReason', label: 'Reason', required: true }],
                    values: { overrideReason: '' },
                    onSubmit: (r) => r.overrideReason
                });
                if (!overrideReason) throw new Error('Not issued. Nothing has changed.');

                return issue({ ...payload, issuedOn: v.issuedOn || null,
                               force: true, overrideReason });
            }
        });

        if (!issued) return;
        toast.success('Certificate issued', issued.serial);
        await this.load();
    }

    /**
     * Revoking.
     *
     * The reason is required because it is what a future verification returns:
     * `verify()` reports a revoked serial as found-but-revoked, with this text.
     * The certificate is not deleted and the serial is never reissued.
     */
    async revokeCertificate() {
        const c = this.detail;
        if (!c) return;
        session.require(CAPABILITIES.CERTIFICATE_ISSUE, 'revoke a certificate');

        const done = await formModal({
            title: `Revoke ${c.serial}`,
            description: 'The record stays and the serial is never reused — every future '
                       + 'verification will report it as revoked, with this reason.',
            submitLabel: 'Revoke',
            fields: [
                { name: 'reason', label: 'Why', type: 'textarea', rows: 2, required: true,
                  help: 'Shown to anyone who verifies this serial.' }
            ],
            values: { reason: '' },
            onSubmit: (v) => revoke(c.id, { reason: v.reason })
        });

        if (!done) return;
        toast.success('Certificate revoked', c.serial);
        this.detail = null;
        await this.load();
    }
}

/* ------------------------------------------------------------------ HELPERS */

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
