/**
 * Natyam ERP v3 — Mobile — Public content service
 *
 * Reads published content for the Public Experience. Every caller is someone
 * with no account, often on their first ever visit, so this file has two
 * jobs and they are both about safety rather than features.
 *
 * ── 1. NOTHING IT RETURNS CAN BREAK A SCREEN ──
 * A missing document, a malformed document, a half-finished edit and a failed
 * network read all produce the same fully-formed empty envelope. Pages check
 * `published` and render either content or their own empty state; they never
 * guard a property access, and they never see an exception.
 *
 * ── 2. NORMALISING IS ALSO WHITELISTING ──
 * normalise() below rebuilds the envelope field by field from
 * publicContent.config.js's schema. It does not merge, spread or pass through
 * the stored document — an unrecognised key is DROPPED, not forwarded.
 *
 * That is deliberate defence in depth for the one risk this collection has.
 * /siteContent is `allow read: if true`, so anything published there is world-
 * readable, and firestore.rules cannot tell curated prose from an operational
 * field pasted in by accident — no rule can express "this looks like a
 * student record". The rules stop the wrong PEOPLE writing; this stops the
 * wrong SHAPE being displayed. If a stray `students` array or an internal id
 * were ever published into one of these documents, no public screen would
 * render it, because no public screen reads anything this function did not
 * build.
 *
 * ── GENERIC BY CONSTRUCTION ──
 * There is no per-page logic anywhere in this file. It handles `kind: 'page'`
 * and `kind: 'list'`, which is every current module and every postponed one
 * (Gallery, Events, FAQ, Contact, Testimonials, Blog). Adding one is a
 * registry entry and a document — see publicContent.config.js.
 */

import { siteContent$ } from '../data/repositories.js';
import {
    CONTENT_KINDS, BLOCK_TYPES, PUBLIC_MODULES, moduleFor
} from '../config/publicContent.config.js';

/* ==========================================================================
   COERCION
   Small, total, and never throwing. Published content is edited by hand
   in the Desktop ERP's Settings → Website Content module, so a string where
   an array belongs is a normal mistake, not an exceptional one.
   ========================================================================== */

/** Any value → a trimmed string, capped so one bad paste cannot fill a screen. */
function text(value, max = 4000) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return '';
    return String(value).trim().slice(0, max);
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

/** [{label, value}] — used by both a PAGE's facts block and a LIST's items. */
function facts(value) {
    return list(value)
        .map((row) => ({
            label: text(row?.label, 80),
            value: text(row?.value, 200)
        }))
        .filter((row) => row.label || row.value);
}

/**
 * An image reference. Rejects anything that is not a plain http(s) URL or an
 * app-relative asset path — in particular `javascript:` and `data:`, which
 * would otherwise be an injection route through content that is edited
 * outside this app and rendered inside it.
 */
function image(value) {
    const src = text(value, 500);
    if (!src) return '';
    if (/^https?:\/\//i.test(src)) return src;
    if (/^assets\//.test(src)) return src;
    return '';
}

/* ==========================================================================
   THE ENVELOPE
   ========================================================================== */

function block(raw) {
    const type = text(raw?.type, 20);

    switch (type) {
        case BLOCK_TYPES.HEADING:
            return { type, text: text(raw.text, 200) };
        case BLOCK_TYPES.TEXT:
            return { type, text: text(raw.text) };
        case BLOCK_TYPES.IMAGE:
            return {
                type,
                src: image(raw.src),
                alt: text(raw.alt, 200),
                caption: text(raw.caption, 300)
            };
        case BLOCK_TYPES.FACTS:
            return { type, facts: facts(raw.facts) };
        default:
            // An unknown block type is dropped rather than rendered blindly.
            return null;
    }
}

function item(raw, index) {
    return {
        // Stable enough to key a list on: the published id if there is one,
        // otherwise the position. Never shown.
        id: text(raw?.id, 64) || `item-${index}`,
        title: text(raw?.title, 200),
        subtitle: text(raw?.subtitle, 200),
        body: text(raw?.body),
        image: image(raw?.image),
        facts: facts(raw?.facts)
    };
}

/** An empty, fully-formed envelope — the shape every caller can rely on. */
function empty(key) {
    const declared = moduleFor(key);
    return {
        key,
        kind: declared?.kind || CONTENT_KINDS.PAGE,
        title: declared?.label || '',
        subtitle: '',
        blocks: [],
        items: [],
        published: false
    };
}

/**
 * Rebuilds the envelope from the stored document. The `kind` on the document
 * wins over the registry's — the document is what the website reads too, and
 * a consumer that trusted a local registry over the data would disagree with
 * one that did not.
 */
function normalise(key, stored) {
    const base = empty(key);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;

    const kind = text(stored.kind, 20);
    const resolved = Object.values(CONTENT_KINDS).includes(kind) ? kind : base.kind;

    return {
        key,
        kind: resolved,
        title: text(stored.title, 200) || base.title,
        subtitle: text(stored.subtitle, 300),
        blocks: resolved === CONTENT_KINDS.PAGE
            ? list(stored.blocks).map(block).filter(Boolean)
            : [],
        items: resolved === CONTENT_KINDS.LIST
            ? list(stored.items).map(item)
            : [],
        published: true
    };
}

/* ==========================================================================
   READS
   ========================================================================== */

/**
 * One module's published content, in the documented envelope.
 *
 * A read failure is logged and then treated exactly like an unpublished
 * document. A prospective parent on a weak connection and one looking at a
 * page nobody has written yet both get an honest empty state rather than an
 * error screen on their first visit — but a read that keeps failing is a real
 * problem, so it is never silent in the console.
 *
 * @param {string} key  A /siteContent document id.
 * @returns {Promise<object>} never null, never throws.
 */
export async function content(key) {
    let stored = null;
    try {
        stored = await siteContent$.get(key, null);
    } catch (err) {
        console.error(`Could not load public content "${key}"`, err);
        return empty(key);
    }
    return normalise(key, stored);
}

/**
 * Every registered section, for the Public Home screen — one pass rather than
 * a request per card. Individual failures are already absorbed by content(),
 * so this settles rather than rejects.
 *
 * Returns registry metadata (path, label, icon, blurb) merged with the
 * section's envelope, so Home can render a card for a section that has not
 * been written yet and mark it honestly rather than hiding it.
 */
export async function modules() {
    const envelopes = await Promise.all(PUBLIC_MODULES.map((m) => content(m.key)));

    return PUBLIC_MODULES.map((declared, index) => ({
        ...declared,
        content: envelopes[index]
    }));
}
