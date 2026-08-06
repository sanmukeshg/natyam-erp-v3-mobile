/**
 * NATYAM ERP v3 — Load failure with a way out (BUG-302)
 *
 * Sixteen pages rendered a load failure as a bare sentence in a red box and
 * left the reader there. The only "try again" anywhere in the app reloaded
 * the whole page. So a single stalled read cost a full app restart, or the
 * navigate-away-and-back dance testers found for themselves — which is the
 * behaviour BUG-302 asks to remove, not merely the frozen skeleton.
 *
 * Retrying in place is possible because every page already keeps its load in
 * one idempotent `load()`: the retry is a second call to the function that
 * just failed, not a rebuild of the screen.
 *
 * Kept separate from js/ui/filterBar.js for the same reason that exists —
 * this owns one small piece of shared chrome and nothing about any module's
 * data.
 */

import { html, render } from '../utils/dom.js';
import { isReadTimeout } from '../data/firestoreRead.js';

/**
 * A stalled connection and a rejected query are the same event to the code
 * and completely different events to the reader. "students did not respond"
 * invites a retry; "Missing or insufficient permissions" tells them a retry
 * is pointless and to go find an administrator. Saying the wrong one wastes
 * the reader's time in both directions.
 */
export function explain(what, error) {
    if (isReadTimeout(error)) {
        return `${what} is taking longer than usual. The connection may have stalled.`;
    }
    // Firebase's messages already end in a full stop and most others do not,
    // so the sentence has to supply one only when it is missing — otherwise
    // half the failures in the app read "…insufficient permissions..".
    const detail = String(error?.message || 'an unexpected error').replace(/\.\s*$/, '');
    return `${what} could not be loaded — ${detail}.`;
}

/**
 * Renders the failure into `container` and wires the retry button.
 *
 * `onRetry` is called with no arguments and its result ignored; a page's
 * `load()` drops straight in. The button is disabled while that promise is
 * outstanding so an impatient second tap cannot start a duplicate read of a
 * collection that is already slow.
 *
 * @param {Element} container
 * @param {object}  options
 * @param {string}  options.what     Subject of the sentence, e.g. 'The roll'.
 * @param {Error}   options.error
 * @param {Function} [options.onRetry]  Omit for a failure nothing can retry.
 */
export function showLoadError(container, { what, error, onRetry }) {
    if (!container) return;

    render(container, html`
        <div class="m-error" role="alert">
            <p>${explain(what, error)}</p>
            ${onRetry ? html`
                <button class="m-btn m-btn-sm" data-action="retry-load" style="margin-top:10px;">
                    Try again
                </button>
            ` : ''}
        </div>
    `);

    const button = container.querySelector('[data-action="retry-load"]');
    if (!button || !onRetry) return;

    button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Trying…';
        try {
            await onRetry();
        } catch {
            // load() renders its own failure — including this view again, with
            // a fresh button. Rethrowing here would only reach an unhandled
            // rejection handler that cannot do anything a reader would notice.
        }
    });
}
