/**
 * Natyam ERP v3 — Mobile — The standard filter bar
 *
 * ENH-304 / ENH-306. Every module that filters should look and behave the
 * same: a search field, a funnel beside it, and a filter panel that stays
 * hidden until the funnel is tapped.
 *
 * The Students screen already worked this way and is the design reference —
 * this file is that pattern lifted out verbatim rather than reinterpreted, so
 * adopting it elsewhere changes those screens and leaves Students exactly as
 * it was.
 *
 * WHY A SHARED COMPONENT RATHER THAN COPYING THE MARKUP. Thirteen modules
 * filter. Copied markup means the next change to this pattern is thirteen
 * edits, twelve of which are easy to forget — which is precisely how the
 * inconsistency this ticket exists to fix came about in the first place.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: the filters themselves. Every module
 * filters on different things, so each keeps its own list, its own state and
 * its own handler. This owns the chrome — the row, the funnel, the
 * show/hide — and nothing about what is being filtered. A component that
 * tried to own the filters too would need a configuration language, and
 * would be harder to use than the markup it replaced.
 *
 * USAGE
 *
 *   render(container, html`
 *       ${filterBar({ placeholder: 'Search applications…', open: this.filtersOpen })}
 *       <div data-role="list"></div>
 *   `);
 *
 *   // in paint(), whenever the rows change:
 *   renderFilterPanel(this.container, this.filtersOpen, html`
 *       <div class="m-chip-scroll">…your pills…</div>
 *   `);
 *
 *   // in bind(), once:
 *   bindFilterToggle(this, () => this.paint());
 */

import { html, render, raw, on } from '../utils/dom.js';
import { icon } from './icons.js';

/**
 * The search row and funnel. Returns markup — the caller places it, so a
 * module can put its own summary line or stats above or below.
 *
 * @param {object} options
 * @param {string} options.placeholder   Search field placeholder.
 * @param {string} [options.label]       Screen-reader label for the search.
 * @param {boolean} [options.open]       Whether the panel is currently shown.
 * @param {string} [options.note]        The count/summary line under the row.
 * @param {boolean} [options.search]     Set false for a module that filters
 *   but has nothing meaningful to search — the funnel stays, the field goes.
 */
export function filterBar({ placeholder = 'Search…', label = 'Search', open = false, note = '', search = true } = {}) {
    return html`
        <div class="m-subhead">
            <div class="m-subhead-row">
                ${search ? html`
                    <label class="m-search">
                        ${raw(icon('search', { size: 15 }))}
                        <span class="sr-only">${label}</span>
                        <input type="search" data-role="search" placeholder="${placeholder}">
                    </label>
                ` : html`<span style="flex:1;"></span>`}

                <!--
                  aria-expanded is not decoration: the panel below is genuinely
                  hidden, so a screen reader has no other way to know the funnel
                  toggles something or what state it is in.
                -->
                <button class="m-icon-btn" data-action="toggle-filters" aria-label="Filter"
                        aria-expanded="${open ? 'true' : 'false'}">
                    ${raw(icon('filter', { size: 16 }))}
                </button>
            </div>

            <p class="m-subhead-note" data-role="count">${note}</p>
            <div data-role="filter-panel"></div>
        </div>
    `;
}

/**
 * Shows or hides the filter panel. Called on every repaint, because whether
 * the panel is open is page state and the pills inside it usually depend on
 * the rows that were just loaded.
 *
 * Rendering nothing when closed — rather than hiding with CSS — keeps the
 * pills out of the tab order and the accessibility tree while they are not
 * available, which `display: none` would also do but a `hidden` attribute on
 * a scroller would not always.
 *
 * @param {HTMLElement} container  The page's root.
 * @param {boolean} open
 * @param {*} content              Markup for the panel's contents.
 */
export function renderFilterPanel(container, open, content) {
    const host = container?.querySelector('[data-role="filter-panel"]');
    if (!host) return;
    render(host, open ? content : '');
}

/** Updates the count/summary line under the search row. */
export function setFilterNote(container, note) {
    const host = container?.querySelector('[data-role="count"]');
    if (host) render(host, note);
}

/**
 * Wires the funnel. `page` needs a `filtersOpen` boolean and a `container`;
 * `onToggle` is what repaints — usually the page's own paint().
 *
 * Registered through page.onDispose() so it is torn down with the page, the
 * same as every other delegated listener in this app.
 */
export function bindFilterToggle(page, onToggle) {
    page.onDispose(on(page.container, 'click', '[data-action="toggle-filters"]', () => {
        page.filtersOpen = !page.filtersOpen;

        // The button lives outside whatever the panel repaint touches, so its
        // own state has to be updated here rather than falling out of a
        // re-render.
        page.container.querySelector('[data-action="toggle-filters"]')
            ?.setAttribute('aria-expanded', page.filtersOpen ? 'true' : 'false');

        onToggle();
    }));
}
