/**
 * Natyam ERP v3 — Forms
 *
 * A modal form built on the v3 glass system. This is **not** the reference
 * project's `js/ui/form.js` — that one is 548 lines against v2's
 * `components.css`, which this app has never loaded. Same job, same idea of a
 * declarative field list, but v3's surfaces and a much smaller surface area.
 *
 * THE VALIDATION CONTRACT, WHICH MATTERS MORE THAN THE MARKUP
 *
 * Every create/update path in the services layer already validates, throws a
 * sentence written to be shown to a person, and enforces guardrails this file
 * knows nothing about (`requireRoleManagement()`, code-uniqueness checks,
 * date-overlap checks against records not loaded here). **The service is the
 * authority. This form is a convenience.**
 *
 * So the split is deliberate:
 *   - The form checks only what it can check *locally and instantly* — a
 *     required field left blank, a number below a minimum, an end date before
 *     a start date. That exists to save a round trip, not to be correct.
 *   - Everything else goes to the service, and whatever it throws is shown
 *     **in the form, against the submit button**, with the form still open and
 *     the values still filled in. A validation failure should never cost
 *     someone their typing.
 *
 * This is why `onSubmit` returns a promise and the form stays mounted until it
 * resolves. A form that closes optimistically and toasts an error afterwards
 * makes the person start again.
 */

import { html, render, raw, on, formData } from '../utils/dom.js';
import { icon } from './icons.js';

/**
 * Opens a modal form.
 *
 * @param {object}   config
 * @param {string}   config.title
 * @param {string}  [config.description]  A sentence under the title.
 * @param {Array}    config.fields        See `field shapes` below.
 * @param {object}  [config.values]       Initial values, keyed by field name.
 * @param {string}  [config.submitLabel]
 * @param {Function} config.onSubmit      async (values) => any. Throwing shows
 *                                        the message in the form; resolving
 *                                        closes it and resolves this promise.
 * @returns {Promise<any|null>} What `onSubmit` resolved to, or null if cancelled.
 *
 * Field shapes:
 *   { name, label, type, required, help, placeholder,
 *     min, max, step, maxLength, options: [{value,label}], rows, itemNoun,
 *     validate: (value, allValues) => string|null }
 *
 * Types: text | number | money | date | time | tel | email | select | checks |
 *        textarea | switch | divider
 *
 *   - `time` is the plain input path with type="time"; the browser's own
 *     picker is better than anything worth hand-rolling here.
 *   - `checks` is a multi-select tick-box group. Its value is an **array**, in
 *     the order the options were declared, and `itemNoun` names the thing for
 *     the required message ("Choose at least one day.").
 *   - `divider` is presentational: a labelled rule, no `name`, no value. It is
 *     skipped by both the value reader and the validator.
 *   - `tel` and `email` are the plain input path with the matching type, which
 *     is what gets a phone keypad on a touch device.
 *
 *   - `readonly: true` shows a value without letting it be edited. Used where
 *     the value is real and worth seeing but genuinely immutable.
 *
 * `options` may be an array OR `(values) => [...]`, so one field can narrow
 * another. Pair it with `reactive: true` on the field being chosen from — that
 * repaints the form on change so the dependent options rebuild.
 *
 * `showIf: (values) => boolean` makes a field conditional. A hidden field is
 * skipped by the validator too — a required field nobody can see must never be
 * able to block the submit.
 *
 * `validateAll: (values) => ({ field: message }|null)` is a form-level pass for
 * rules that belong to no single field. It runs after the per-field pass and
 * never overwrites it.
 */
export function formModal({
    title, description = null, fields, values = {},
    submitLabel = 'Save', onSubmit, validateAll = null
}) {
    return new Promise((resolve) => {
        const host = document.createElement('div');
        host.className = 'm-form-host';
        // Mount inside the shell, not on <body>. The scrim is a translucent
        // dark wash (rgba(20,11,6,0.55)) that assumes the terracotta artwork
        // beneath it — which `.m-shell` paints. On <body> it composited over
        // base.css's near-white #F6F8FA instead, and in the light variant
        // (which keeps WHITE type) that measured 2.6–3.0 against WCAG AA's
        // 4.5. Same class of mistake as the tone-fill fix in this file's CSS.
        // Every other v3 modal already renders inside the shell; this puts the
        // form in the same backdrop context rather than duplicating its wash.
        (document.querySelector('.m-shell') || document.body).append(host);

        let busy = false;
        let errors = {};
        let formError = null;
        // Live values, so a re-render (after an error) never loses typing.
        let current = { ...values };

        const close = (result) => {
            window.removeEventListener('keydown', onKey);
            host.remove();
            resolve(result);
        };

        const onKey = (event) => {
            if (event.key === 'Escape' && !busy) close(null);
        };
        window.addEventListener('keydown', onKey);

        function readCurrent() {
            const formEl = host.querySelector('[data-role="form"]');
            if (!formEl) return current;
            const raw = formData(formEl);
            // formData() misses unchecked switches, and returns strings for
            // everything — normalise against the declared field types so
            // `onSubmit` receives numbers as numbers and booleans as booleans.
            const out = {};
            for (const f of fields) {
                if (f.type === 'divider') continue;   // presentational, has no name
                if (f.type === 'switch') {
                    out[f.name] = Boolean(formEl.querySelector(`[name="${f.name}"]`)?.checked);
                } else if (f.type === 'checks') {
                    // An array, in the option order declared — not the order
                    // they happened to be ticked in. Callers like createBatch()
                    // treat `days` as a set but render it as a sequence, and a
                    // register that reads "Wed, Mon" is a small daily papercut.
                    const ticked = new Set([...formEl.querySelectorAll(`[name="${f.name}"]:checked`)]
                        .map((n) => n.value));
                    const declared = typeof f.options === 'function'
                        ? (f.options(out) || []) : (f.options || []);
                    out[f.name] = declared.map((o) => String(o.value))
                        .filter((v) => ticked.has(v));
                } else if (f.type === 'number' || f.type === 'money') {
                    const v = raw[f.name];
                    out[f.name] = v === '' || v === undefined ? null : Number(v);
                } else {
                    out[f.name] = raw[f.name] ?? '';
                }
            }
            return out;
        }

        /** Only what can be judged locally and instantly. */
        function validate(vals) {
            const found = {};
            for (const f of fields) {
                if (f.type === 'divider') continue;
                // A field the form is currently hiding cannot be filled in, so
                // it must not be able to block the submit. Without this, "Set
                // an initial password" — hidden unless Email & Password is the
                // chosen sign-in method — would make the form unsubmittable
                // with no visible field to fix.
                if (typeof f.showIf === 'function' && !f.showIf(vals)) continue;
                const v = vals[f.name];

                // An empty array is "nothing chosen" — it is not `''`, so the
                // scalar test below would wave a required multi-select through.
                const empty = Array.isArray(v)
                    ? v.length === 0
                    : (v === null || v === '' || v === undefined);

                if (f.required && empty) {
                    found[f.name] = f.type === 'checks'
                        ? `Choose at least one ${f.itemNoun || 'option'}.`
                        : `${f.label} is required.`;
                    continue;
                }
                if (empty) continue;

                if ((f.type === 'number' || f.type === 'money')) {
                    if (Number.isNaN(v)) found[f.name] = 'Enter a number.';
                    else if (f.min !== undefined && v < f.min) found[f.name] = `Must be at least ${f.min}.`;
                    else if (f.max !== undefined && v > f.max) found[f.name] = `Must be at most ${f.max}.`;
                }
                if (f.maxLength && String(v).length > f.maxLength) {
                    found[f.name] = `Keep it under ${f.maxLength} characters.`;
                }
                if (!found[f.name] && typeof f.validate === 'function') {
                    const message = f.validate(v, vals);
                    if (message) found[f.name] = message;
                }
            }

            // Form-level pass, for rules that belong to no single field —
            // "these two together already exist". Returns { field: message }.
            // It runs after the per-field pass and does not overwrite it: a
            // blank required field is the more useful thing to say first.
            if (typeof validateAll === 'function') {
                const extra = validateAll(vals) || {};
                for (const [name, message] of Object.entries(extra)) {
                    if (message && !found[name]) found[name] = message;
                }
            }
            return found;
        }

        async function submit() {
            if (busy) return;

            current = readCurrent();
            errors = validate(current);
            formError = null;

            if (Object.keys(errors).length) {
                paint();
                host.querySelector('.m-field-error')?.closest('.m-field')
                    ?.querySelector('input, select, textarea')?.focus();
                return;
            }

            busy = true;
            paint();

            try {
                const result = await onSubmit(current);
                close(result);
            } catch (err) {
                // The service's message is written to be read. Show it in the
                // form, keep everything typed, and let the person fix it.
                busy = false;
                formError = err?.message || 'That could not be saved.';
                paint();
                host.querySelector('[data-role="form-error"]')?.scrollIntoView({ block: 'nearest' });
            }
        }

        function paint() {
            render(host, html`
                <!--
                    A centred box, the same shape as the desktop dialog, with the
                    actions at the END of the form rather than pinned in a header —
                    per direct instruction. The whole box scrolls as one, so Cancel
                    and Save are what you reach after the last field. Tapping the
                    backdrop cancels.
                -->
                <div class="m-modal-scrim" data-role="scrim">
                    <div class="m-modal" role="dialog" aria-modal="true" aria-label="${title}" tabindex="-1">
                        <div class="m-modal-head">
                            <div>
                                <h2 class="m-modal-title">${title}</h2>
                                ${description ? html`<p class="m-modal-sub">${description}</p>` : ''}
                            </div>
                            <button class="m-modal-close" data-action="cancel" aria-label="Close"
                                    ${busy ? 'disabled' : ''}>
                                ${raw(icon('x', { size: 15 }))}
                            </button>
                        </div>

                        <form class="m-modal-body" data-role="form" novalidate>
                            ${formError ? html`
                                <div class="m-notice" data-tone="caution" data-role="form-error" role="alert">
                                    ${formError}
                                </div>
                            ` : ''}
                            ${fields.map((f) => fieldMarkup(f, current[f.name], errors[f.name], current))}
                        </form>

                        <div class="m-modal-foot">
                            <button class="m-form-cancel" data-action="cancel" ${busy ? 'disabled' : ''}>
                                Cancel
                            </button>
                            <button class="m-form-save" data-action="submit" ${busy ? 'disabled' : ''}>
                                ${busy ? 'Saving…' : submitLabel}
                            </button>
                        </div>
                    </div>
                </div>
            `);
            // Every repaint rebuilds the fields, so conditional visibility has
            // to be re-applied here — not just once at mount. A service error
            // repaints, and without this the password field would reappear on
            // a form where the chosen sign-in method has nothing to do with it.
            applyVisibility();
        }

        paint();

        // Same scrim rule as every other v3 modal: only a direct hit on the
        // backdrop dismisses, because the backdrop is the dialog's parent and
        // a delegated closest() match would otherwise treat every click
        // inside the form as a click on it.
        on(host, 'click', '[data-role="scrim"]', (event, target) => {
            if (event.target !== target || busy) return;
            close(null);
        });
        on(host, 'click', '[data-action="cancel"]', () => { if (!busy) close(null); });
        on(host, 'click', '[data-action="submit"]', () => submit());
        on(host, 'submit', '[data-role="form"]', (event) => { event.preventDefault(); submit(); });

        // Keep `current` live so a re-render never discards typing.
        //
        // Clearing a satisfied error is done by touching those two nodes
        // directly rather than by calling paint(). A re-render on every
        // keystroke would rebuild the inputs and throw away focus and caret
        // position mid-word. The rule is intentionally narrow — it only
        // retracts "X is required" once X has a value; anything the service
        // rejected stands until the next submit, because only the service can
        // say whether it is fixed.
        /*
         * Show or hide the fields that depend on other answers.
         *
         * Toggling `hidden` on the wrapper rather than re-rendering, for the
         * same reason as the error retraction below — and because a repaint
         * here would fire while the person is mid-way through a tick-box
         * group. `.m-field[hidden]` is already in the stylesheet.
         */
        function applyVisibility() {
            for (const f of fields) {
                if (typeof f.showIf !== 'function') continue;
                const node = host.querySelector(`.m-field[data-field="${f.name}"]`);
                if (node) node.hidden = !f.showIf(current);
            }
        }

        /*
         * Long tick-box groups get a filter and a running count.
         *
         * The filter hides chips; it never unticks one. That matters because
         * `setParticipants()` replaces a cast wholesale — if searching could
         * drop somebody from the selection, a person filtering to check one
         * name would silently remove everyone else on submit.
         */
        function paintCheckCounts() {
            for (const group of host.querySelectorAll('[data-checks]')) {
                const name = group.dataset.checks;
                const label = host.querySelector(`[data-checks-count="${name}"]`);
                if (!label) continue;
                const total = group.querySelectorAll('input').length;
                const ticked = group.querySelectorAll('input:checked').length;
                const hidden = group.querySelectorAll('.m-check[hidden]').length;
                render(label, `${ticked} of ${total} selected`
                    + (hidden ? ` · ${total - hidden} shown` : ''));
            }
        }
        paintCheckCounts();

        /*
         * A `reactive` field repaints the whole form on change, so any field
         * whose `options` is a function of the current values rebuilds against
         * the new answer — branch narrowing batch, for instance (UAT BUG-208).
         */
        on(host, 'change', '[data-reactive="true"]', () => {
            current = readCurrent();
            paint();
        });

        on(host, 'input', '[data-checks-filter]', (event, target) => {
            const group = host.querySelector(`[data-checks="${target.dataset.checksFilter}"]`);
            if (!group) return;
            const term = target.value.trim().toLowerCase();
            for (const chip of group.querySelectorAll('.m-check')) {
                chip.hidden = Boolean(term) && !chip.dataset.label.includes(term);
            }
            paintCheckCounts();
        });

        on(host, 'input', 'input, textarea, select', (event) => {
            current = readCurrent();
            applyVisibility();
            paintCheckCounts();
            const name = event.target?.name;
            if (!name || !errors[name]) return;

            const v = current[name];
            const stillEmpty = Array.isArray(v) ? v.length === 0 : (v === null || v === '' || v === undefined);
            if (stillEmpty) return;

            delete errors[name];
            const field = event.target.closest('.m-field');
            if (field) {
                field.dataset.invalid = 'false';
                field.querySelector('.m-field-error')?.remove();
            }
        });

        /*
         * The DIALOG takes focus, not the first field (UAT ENH-616).
         *
         * Focusing an input on a phone opens the keyboard the instant the
         * dialog appears, which shoves the form up the screen before anyone has
         * read it — the reported symptom on fee collection, but true of every
         * form here. Focusing the dialog itself keeps Escape, screen readers and
         * tab order working without summoning the keyboard; the person taps the
         * field they actually want to change.
         */
        host.querySelector('.m-modal')?.focus();
    });
}

/* ------------------------------------------------------------------- FIELDS */

function fieldMarkup(f, value, error, values = {}) {
    // A labelled rule, not an input. Long forms (the student one runs to
    // eighteen fields) are unreadable as one undifferentiated column.
    if (f.type === 'divider') {
        return html`<p class="m-form-divider" role="presentation">${f.label}</p>`;
    }

    const id = `f-${f.name}`;
    const described = [f.help ? `${id}-help` : null, error ? `${id}-error` : null]
        .filter(Boolean).join(' ');

    return html`
        <div class="m-field" data-invalid="${error ? 'true' : 'false'}" data-field="${f.name}">
            <label for="${id}">
                ${f.label}${f.required ? html`<span class="m-req" aria-hidden="true">*</span>` : ''}
            </label>
            ${control(f, id, value, described, values)}
            ${f.help ? html`<span class="m-field-help" id="${id}-help">${f.help}</span>` : ''}
            ${error ? html`<span class="m-field-error" id="${id}-error" role="alert">${error}</span>` : ''}
        </div>
    `;
}

function control(f, id, value, described, values = {}) {
    const common = `id="${id}" name="${f.name}"`;
    const aria = described ? `aria-describedby="${described}"` : '';

    /*
     * Options may be a function of the form's current values, so one field can
     * narrow another — the branch chosen above decides which batches are even
     * offered. Static arrays still work unchanged; this only adds a second
     * accepted shape.
     */
    const optionsOf = (field) => (typeof field.options === 'function'
        ? (field.options(values) || [])
        : (field.options || []));

    if (f.type === 'select') {
        return html`
            <select class="m-input" id="${id}" name="${f.name}" aria-describedby="${described}"
                    ${f.reactive ? raw(' data-reactive="true"') : ''}>
                ${f.placeholder ? html`<option value="">${f.placeholder}</option>` : ''}
                ${optionsOf(f).map((o) => html`
                    <option value="${o.value}" ${String(value) === String(o.value) ? 'selected' : ''}>${o.label}</option>
                `)}
            </select>
        `;
    }

    // A tick-box group styled as chips. Real <input type="checkbox">es rather
    // than buttons with aria-pressed, so the group is keyboard-navigable and
    // announced as a set of checkboxes without any scripting to maintain.
    if (f.type === 'checks') {
        const chosen = new Set((Array.isArray(value) ? value : []).map(String));
        const options = optionsOf(f);
        // Past a couple of dozen chips the group stops being scannable — the
        // programme cast picker offers every active student, 158 of them here.
        // The filter only hides chips; it never unticks one, so a search does
        // not quietly drop people from a selection that is about to replace
        // the whole cast.
        const searchable = f.searchable ?? options.length > 24;

        return html`
            <div class="m-checks-wrap">
                ${searchable ? html`
                    <input class="m-input m-checks-filter" type="search"
                           data-checks-filter="${f.name}"
                           placeholder="Filter ${options.length} ${f.itemNoun || 'option'}s…"
                           aria-label="Filter the list below">
                ` : ''}
                <div class="m-checks" role="group" aria-describedby="${described}"
                     data-checks="${f.name}">
                    ${options.map((o) => html`
                        <label class="m-check" data-label="${String(o.label).toLowerCase()}">
                            <input type="checkbox" name="${f.name}" value="${o.value}"
                                   ${chosen.has(String(o.value)) ? 'checked' : ''}>
                            <span class="m-check-chip">${o.label}</span>
                        </label>
                    `)}
                </div>
                ${searchable ? html`
                    <span class="m-field-help" data-checks-count="${f.name}"></span>
                ` : ''}
            </div>
        `;
    }

    if (f.type === 'textarea') {
        return html`
            <textarea class="m-input m-textarea" id="${id}" name="${f.name}"
                      rows="${f.rows || 3}" placeholder="${f.placeholder || ''}"
                      aria-describedby="${described}">${value ?? ''}</textarea>
        `;
    }

    if (f.type === 'switch') {
        return html`
            <label class="m-switch">
                <input type="checkbox" id="${id}" name="${f.name}" ${value ? 'checked' : ''}
                       aria-describedby="${described}">
                <span class="m-switch-track"></span>
                <span class="m-switch-label">${f.switchLabel || 'Yes'}</span>
            </label>
        `;
    }

    // money is a number input that says what unit it is — the school works in
    // whole rupees (see utils/money.js), so no decimals and no paise.
    const type = f.type === 'money' ? 'number' : (f.type || 'text');
    const attrs = [
        f.min !== undefined ? `min="${f.min}"` : '',
        f.max !== undefined ? `max="${f.max}"` : '',
        f.type === 'money' ? 'step="1" inputmode="numeric"' : (f.step ? `step="${f.step}"` : ''),
        f.maxLength ? `maxlength="${f.maxLength}"` : '',
        f.autocomplete ? `autocomplete="${f.autocomplete}"` : '',
        f.readonly ? 'readonly' : ''
    ].filter(Boolean).join(' ');

    return raw(`
        <div class="${f.type === 'money' ? 'm-money-wrap' : ''}">
            ${f.type === 'money' ? '<span class="m-money-prefix">₹</span>' : ''}
            <input class="m-input ${f.type === 'money' ? 'm-money-input' : ''}" type="${type}"
                   ${common} ${aria} ${attrs}
                   value="${escapeAttr(value ?? '')}"
                   placeholder="${escapeAttr(f.placeholder || '')}">
        </div>
    `);
}

function escapeAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A yes/no confirm in the same language as the form.
 *
 * `cancelLabel` and `tone: null` exist for UAT5-BUG-506, where the dialog is a
 * CONFIRMATION rather than a warning: it restates choices already made and its
 * negative button goes back to change them ("Edit"), so "Cancel" would be a
 * lie and a caution-toned notice would colour a plain summary as a problem.
 * Both keep their old defaults, so every existing call is unchanged.
 *
 * @returns {Promise<boolean>}
 */
export function confirmModal({
    title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'caution'
}) {
    return new Promise((resolve) => {
        const host = document.createElement('div');
        host.className = 'm-form-host';
        // Mount inside the shell, not on <body>. The scrim is a translucent
        // dark wash (rgba(20,11,6,0.55)) that assumes the terracotta artwork
        // beneath it — which `.m-shell` paints. On <body> it composited over
        // base.css's near-white #F6F8FA instead, and in the light variant
        // (which keeps WHITE type) that measured 2.6–3.0 against WCAG AA's
        // 4.5. Same class of mistake as the tone-fill fix in this file's CSS.
        // Every other v3 modal already renders inside the shell; this puts the
        // form in the same backdrop context rather than duplicating its wash.
        (document.querySelector('.m-shell') || document.body).append(host);

        const close = (result) => {
            window.removeEventListener('keydown', onKey);
            host.remove();
            resolve(result);
        };
        const onKey = (event) => { if (event.key === 'Escape') close(false); };
        window.addEventListener('keydown', onKey);

        render(host, html`
            <div class="m-modal-scrim" data-role="scrim">
                <div class="m-modal m-modal-confirm" role="alertdialog" aria-modal="true" aria-label="${title}">
                    <div class="m-modal-head">
                        <h2 class="m-modal-title">${title}</h2>
                    </div>
                    <div class="m-modal-body">
                        ${tone ? html`<div class="m-notice" data-tone="${tone}">${message}</div>` : message}
                    </div>
                    <div class="m-modal-foot">
                        <button class="m-form-cancel" data-action="no">${cancelLabel}</button>
                        <button class="m-form-save" data-action="yes">${confirmLabel}</button>
                    </div>
                </div>
            </div>
        `);

        on(host, 'click', '[data-role="scrim"]', (event, target) => {
            if (event.target === target) close(false);
        });
        on(host, 'click', '[data-action="no"]', () => close(false));
        on(host, 'click', '[data-action="yes"]', () => close(true));
        host.querySelector('[data-action="yes"]')?.focus();
    });
}
