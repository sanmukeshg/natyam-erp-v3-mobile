/**
 * Natyam ERP v3 — Mobile — "not migrated yet" placeholder.
 *
 * Phase 1 migrates one module at a time (see MIGRATION_CHECKLIST.md). Until
 * a module arrives, its tab or More-sheet entry still exists — the real
 * navigation shape should be visible and testable from the start — but the
 * route has nothing to mount. This says so plainly rather than throwing an
 * unresolved import or rendering a blank screen that looks like a bug.
 *
 * A module's migration replaces this by filling in its `load` in
 * js/config/navigation.js.
 */

import { Page } from '../../core/router.js';
import { html, render } from '../../utils/dom.js';

export function pendingPage(label) {
    return class PendingPage extends Page {
        constructor(context) {
            super(context);
            this.title = label;
        }

        async render(container) {
            render(container, html`
                <div class="m-card m-empty">
                    <p style="margin:0 0 8px;">
                        <strong>${label}</strong> is not on mobile yet.
                    </p>
                    <p style="margin:0;">
                        It is coming in a later phase of the v3 migration, and is
                        still available in the previous version of the app.
                    </p>
                </div>
            `);
        }
    };
}
