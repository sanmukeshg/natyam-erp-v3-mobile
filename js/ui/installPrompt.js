/**
 * Natyam ERP v3 — Mobile — Install dialog
 *
 * The UI half of the installation experience. It renders a dialog and reports
 * what was tapped; every decision behind it — whether to offer at all, which
 * platform this is, what "Add to Home Screen" should actually do, and how a
 * refusal is remembered — belongs to js/services/pwaInstall.service.js.
 *
 * NOTHING HERE TOUCHES A BROWSER INSTALL API. No `beforeinstallprompt`, no
 * `navigator.standalone`, no user-agent sniffing. That separation is asked
 * for directly in the brief, and it is why this file has no idea whether it
 * is running on Android or iOS: it asks the service what to do and does it.
 *
 * The two-state flow exists because iOS cannot install programmatically. On
 * Android "Add to Home Screen" completes the job and the dialog closes; on
 * iOS the same button can only swap the dialog to the three manual steps,
 * because Safari offers no other route. One button, two honest outcomes.
 */

import { html, render, raw, on } from '../utils/dom.js';
import { icon } from './icons.js';
import { installMethod, promptInstall, remindLater, IOS_STEPS } from '../services/pwaInstall.service.js';

const HOST_ID = 'pwa-install-host';

/**
 * Shows the dialog. Resolves once it closes, so a caller can await it without
 * needing to know which path was taken.
 *
 * @returns {Promise<'installed'|'later'|'instructions'>}
 */
export function showInstallPrompt() {
    return new Promise((resolve) => {
        document.getElementById(HOST_ID)?.remove();

        const host = document.createElement('div');
        host.id = HOST_ID;
        document.body.append(host);

        const close = (outcome) => {
            host.remove();
            document.removeEventListener('keydown', onKey);
            resolve(outcome);
        };

        // Escape means "not now" — the same as the button, including
        // remembering it. A dismissal that was not recorded would bring the
        // dialog straight back on the next sign-in.
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            remindLater();
            close('later');
        };
        document.addEventListener('keydown', onKey);

        paintOffer(host);

        on(host, 'click', '[data-action="later"]', () => {
            remindLater();
            close('later');
        });

        on(host, 'click', '[data-action="install"]', async () => {
            // The service decides; this file only reacts. On iOS there is
            // nothing to replay, so the dialog becomes instructions instead of
            // pretending to install something.
            if (installMethod() === 'instructions') {
                paintInstructions(host);
                return;
            }

            const outcome = await promptInstall();
            if (outcome === 'accepted') return close('installed');
            if (outcome === 'unavailable') return paintInstructions(host);
            // 'dismissed' — the native sheet was refused. The service has
            // already recorded that, so nothing more to do than get out of
            // the way.
            close('later');
        });

        on(host, 'click', '[data-action="done"]', () => close('instructions'));

        // Tapping the scrim is a dismissal, but only when the scrim itself is
        // the target — a click that started inside the card and drifted out
        // should not close it.
        on(host, 'click', '[data-role="scrim"]', (event, target) => {
            if (event.target !== target) return;
            remindLater();
            close('later');
        });
    });
}

function paintOffer(host) {
    render(host, html`
        <div class="m-sheet-scrim pwa-scrim" data-role="scrim">
            <div class="m-card pwa-card" role="dialog" aria-modal="true" aria-labelledby="pwa-title">
                <div class="pwa-mark" aria-hidden="true">${raw(icon('download', { size: 22 }))}</div>

                <h2 class="pwa-title" id="pwa-title">Install Natyam App</h2>
                <p class="pwa-body">
                    Would you like to add Natyam to your Home Screen for a faster,
                    app-like experience?
                </p>

                <div class="pwa-actions">
                    <button class="m-btn m-btn-ghost m-btn-block" type="button" data-action="later">
                        Not Now
                    </button>
                    <button class="m-btn m-btn-block p-action-primary" type="button" data-action="install">
                        Add to Home Screen
                    </button>
                </div>
            </div>
        </div>
    `);

    // Focus the dialog, not a button — announcing the dialog without
    // pre-selecting an answer, the same reasoning the login screen's reveal
    // uses when it focuses the card rather than the first field.
    host.querySelector('.pwa-card')?.focus?.({ preventScroll: true });
}

/**
 * iOS only, and reached in one other case worth noting: an Android browser
 * whose captured prompt turned out to be unusable. Manual steps are the
 * honest fallback in both.
 */
function paintInstructions(host) {
    render(host, html`
        <div class="m-sheet-scrim pwa-scrim" data-role="scrim">
            <div class="m-card pwa-card" role="dialog" aria-modal="true" aria-labelledby="pwa-title">
                <h2 class="pwa-title" id="pwa-title">Add Natyam to your Home Screen</h2>

                <ol class="pwa-steps">
                    ${IOS_STEPS.map((step) => html`<li>${step}</li>`)}
                </ol>

                <div class="pwa-actions">
                    <button class="m-btn m-btn-block p-action-primary" type="button" data-action="done">
                        Got it
                    </button>
                </div>
            </div>
        </div>
    `);
}
