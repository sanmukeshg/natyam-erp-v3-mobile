/**
 * Natyam ERP v3 — Mobile — Published content screen
 *
 * ONE PAGE FOR EVERY PUBLIC MODULE. About Natyam, Courses, Branches, Batch
 * Timings and the Founder are all rendered by this file, and so will Gallery,
 * Events, FAQ, Contact, Testimonials and Blog be — because none of them is a
 * distinct screen, only a distinct document. It renders the two kinds
 * publicContent.config.js declares:
 *
 *   PAGE  an ordered list of blocks — headings, prose, an image, a fact table
 *   LIST  an ordered list of items  — each a title, a subtitle, a body, an
 *         optional image and its own facts
 *
 * Which module it is showing comes from the route: the registry maps
 * '/courses' to the key `courses`, so five routes share one loader and adding
 * a sixth needs no code here at all.
 *
 * NOTHING RENDERED HERE IS TRUSTED MARKUP. Every value arrives through
 * publicContent.service.js's normaliser, which rebuilds the envelope field by
 * field and drops anything it does not recognise, and it is interpolated as
 * text by utils/dom.js's `html` — never with raw(), which is reserved for the
 * app's own icon set. Published content is edited outside this app and
 * displayed inside it, which is precisely the shape of problem that would
 * otherwise let an editing mistake become an injection.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { CONTENT_KINDS, BLOCK_TYPES, PUBLIC_MODULES } from '../../config/publicContent.config.js';
import { content } from '../../services/publicContent.service.js';

export default class PublicContentPage extends Page {
    constructor(context) {
        super(context);
        this.module = PUBLIC_MODULES.find((m) => m.path === context.path) || null;
        this.title = this.module?.label || 'Natyam';
        this.content = null;
    }

    async render(container) {
        this.container = container;

        // A path with no registry entry can only be a stale link — a route
        // that existed in an older build, or a URL someone edited by hand.
        if (!this.module) {
            this.paintMissing();
            return;
        }

        render(container, html`<div class="m-card m-skeleton" style="height:180px;"></div>`);

        this.content = await content(this.module.key);
        if (this.disposed) return;
        this.paint();
    }

    paint() {
        const doc = this.content;

        if (!doc.published) {
            this.paintUnpublished();
            return;
        }

        render(this.container, html`
            <header class="p-page-head">
                <h1 class="p-page-title">${doc.title || this.module.label}</h1>
                ${doc.subtitle ? html`<p class="p-page-sub">${doc.subtitle}</p>` : ''}
            </header>

            ${doc.kind === CONTENT_KINDS.LIST
                ? this.paintItems(doc.items)
                : this.paintBlocks(doc.blocks)}
        `);
    }

    /* ------------------------------------------------------------- PAGE --- */

    paintBlocks(blocks) {
        if (!blocks.length) return this.emptyNote();

        return html`
            <article class="m-card p-prose">
                ${blocks.map((b) => this.block(b))}
            </article>
        `;
    }

    block(b) {
        switch (b.type) {
            case BLOCK_TYPES.HEADING:
                return html`<h2 class="p-prose-heading">${b.text}</h2>`;

            case BLOCK_TYPES.TEXT:
                return html`<p class="p-prose-text">${b.text}</p>`;

            case BLOCK_TYPES.IMAGE:
                // An image block with no usable src is skipped rather than
                // rendered as a broken frame — normalise() empties `src` for
                // anything that is not an https URL or an assets/ path.
                if (!b.src) return '';
                return html`
                    <figure class="p-figure">
                        <img class="p-figure-img" src="${b.src}" alt="${b.alt}" loading="lazy">
                        ${b.caption ? html`<figcaption class="p-figure-cap">${b.caption}</figcaption>` : ''}
                    </figure>
                `;

            case BLOCK_TYPES.FACTS:
                return this.facts(b.facts);

            default:
                return '';
        }
    }

    /* ------------------------------------------------------------- LIST --- */

    paintItems(items) {
        if (!items.length) return this.emptyNote();

        return html`
            <div class="m-stack">
                ${items.map((it) => html`
                    <article class="m-card p-item">
                        ${it.image ? html`
                            <img class="p-item-img" src="${it.image}" alt="${it.title}" loading="lazy">
                        ` : ''}

                        ${it.title ? html`<h2 class="m-card-title">${it.title}</h2>` : ''}
                        ${it.subtitle ? html`<p class="m-card-meta">${it.subtitle}</p>` : ''}
                        ${it.body ? html`<p class="p-item-body">${it.body}</p>` : ''}
                        ${this.facts(it.facts)}
                    </article>
                `)}
            </div>
        `;
    }

    /* ----------------------------------------------------------- SHARED --- */

    /** Reuses v3.css's .m-facts <dl>, which is exactly this shape already. */
    facts(rows) {
        if (!rows.length) return '';
        return html`
            <dl class="m-facts">
                ${rows.map((row) => html`
                    <div class="m-fact"><dt>${row.label}</dt><dd>${row.value}</dd></div>
                `)}
            </dl>
        `;
    }

    emptyNote() {
        return html`
            <div class="m-card m-empty">
                <p style="margin:0;">There is nothing here yet.</p>
            </div>
        `;
    }

    /**
     * Published documents can be added at any time without a release, so
     * "not written yet" is a normal state rather than an error — and the two
     * things a visitor came to do are still one tap away.
     */
    paintUnpublished() {
        render(this.container, html`
            <div class="m-card m-empty">
                <div style="margin:0 0 10px; opacity:.7;">${raw(icon(this.module.icon, { size: 22 }))}</div>
                <p style="margin:0 0 6px;"><strong>${this.module.label}</strong> is coming soon.</p>
                <p style="margin:0 0 14px;">This page has not been added yet. Do get in touch in the meantime.</p>
                <a class="m-btn m-btn-sm" href="#/enquiry">Send an enquiry</a>
            </div>
        `);
    }

    paintMissing() {
        render(this.container, html`
            <div class="m-card m-empty">
                <p style="margin:0 0 14px;">That page does not exist.</p>
                <a class="m-btn m-btn-sm" href="#/">Back to home</a>
            </div>
        `);
    }
}
