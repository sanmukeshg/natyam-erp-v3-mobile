/**
 * Natyam ERP v3 — Mobile — Public Home
 *
 * The first screen of the app for anyone not signed in.
 *
 * ORDER IS THE DESIGN. The brief is explicit that the two things a parent
 * might want to DO come before the five things they can read: "Primary
 * actions must appear first… The goal is to let parents immediately enquire
 * or apply while still learning about the academy." So Apply Now and Enquiry
 * are the first thing under the hero, at full width, and the informational
 * modules follow as a list. A parent who arrives already decided should not
 * have to scroll past an essay to act.
 *
 * The hero's words come from the published About document rather than being
 * written here, so the school can change how it introduces itself without a
 * release. If nothing is published, the hero falls back to the school's name
 * alone — which is honest, and still leaves both actions exactly where they
 * were.
 */

import { Page } from '../../core/router.js';
import { html, render, raw } from '../../utils/dom.js';
import { icon } from '../../ui/icons.js';
import { modules } from '../../services/publicContent.service.js';

export default class PublicHomePage extends Page {
    constructor(context) {
        super(context);
        this.title = 'Natyam';
        this.modules = [];
    }

    async render(container) {
        this.container = container;
        this.paint();

        // Home renders its actions immediately and fills in content when it
        // arrives. A prospective parent on a slow connection can tap Apply or
        // Enquire while the About text is still in flight — those two buttons
        // never depend on a read that might not complete.
        this.modules = await modules();
        if (this.disposed) return;
        this.paint();
    }

    /**
     * The About document supplies the hero when it has been published.
     *
     * `published` is checked rather than just reading `.title`, because an
     * UNpublished envelope is not blank — publicContent.service.js's empty()
     * fills its title from the registry so a page still has a heading. That
     * label is "About Natyam", which is the right name for a page and the
     * wrong one for the app's front door: it made Home introduce itself as
     * About Natyam whenever the document was missing. The school's own name
     * is the only correct fallback here.
     */
    hero() {
        const about = this.modules.find((m) => m.key === 'about')?.content;
        if (!about?.published) return { title: 'Natyam', subtitle: 'School of Kuchipudi' };

        return {
            title: about.title || 'Natyam',
            subtitle: about.subtitle || 'School of Kuchipudi'
        };
    }

    paint() {
        const { title, subtitle } = this.hero();

        render(this.container, html`
            <section class="p-hero">
                <h1 class="p-hero-title">${title}</h1>
                <p class="p-hero-sub">${subtitle}</p>
            </section>

            <section class="p-actions">
                <a class="m-btn m-btn-block p-action-primary" href="#/apply">
                    ${raw(icon('user-plus', { size: 18 }))}
                    <span>Apply Now</span>
                </a>
                <a class="m-btn m-btn-ghost m-btn-block" href="#/enquiry">
                    ${raw(icon('mail', { size: 18 }))}
                    <span>Enquiry</span>
                </a>
            </section>

            <h2 class="m-section-label">About the academy</h2>

            <div class="m-stack">
                ${this.modules.length
                    ? this.modules.map((m) => this.moduleRow(m))
                    : html`<div class="m-card m-skeleton" style="height:64px;"></div>`}
            </div>
        `);
    }

    /**
     * One row per registered module. A module whose document has not been
     * published yet still gets a row — the registry is the menu, and hiding
     * an entry would make the app's shape depend on whether someone had
     * finished writing copy — but its blurb is replaced by an honest note and
     * the row is not a link, so nobody taps through to an empty page.
     */
    moduleRow(m) {
        const ready = m.content.published;
        const description = ready ? m.blurb : 'Coming soon.';

        const body = html`
            <span class="m-quick-icon p-module-icon">${raw(icon(m.icon, { size: 17 }))}</span>
            <span class="p-module-text">
                <span class="m-quick-label">${m.label}</span>
                <span class="p-module-blurb">${description}</span>
            </span>
            ${ready ? html`<span class="p-module-chev">${raw(icon('chevron-right', { size: 16 }))}</span>` : ''}
        `;

        return ready
            ? html`<a class="m-card m-quick" href="#${m.path}">${body}</a>`
            : html`<div class="m-card m-quick" data-empty="true">${body}</div>`;
    }
}
