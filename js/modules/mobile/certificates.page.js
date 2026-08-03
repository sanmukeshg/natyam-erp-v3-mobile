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
import { levelLabel } from '../../config/app.config.js';
import {
    listCertificates, certificateSummary, verify
} from '../../services/certificates.service.js';
import { formModal } from '../../ui/form.js';

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

                    <p class="m-subhead-note" style="margin-top:16px;">
                        Issuing and revoking are done on the desktop app — a serial is permanent,
                        and issuing can waive an eligibility rule with a reason recorded on the
                        certificate forever.
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

        this.onKey = (event) => {
            if (event.key === 'Escape' && this.detail) { this.detail = null; this.paintSheet(); }
        };
        window.addEventListener('keydown', this.onKey);
        this.onDispose(() => window.removeEventListener('keydown', this.onKey));
    }
}

/* ------------------------------------------------------------------ HELPERS */

function fact(label, value) {
    return html`<div class="m-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}
