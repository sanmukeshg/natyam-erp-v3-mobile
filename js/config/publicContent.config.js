/**
 * Natyam ERP v3 — Mobile — Public content: schema and module registry
 *
 * WHERE PUBLIC INFORMATION COMES FROM. One collection, one writer, two
 * readers:
 *
 *     Desktop ERP → Settings → Website Content
 *              ↓ writes
 *          /siteContent
 *              ↓ reads                    ↓ reads
 *      Parent mobile app            Future Natyam website
 *
 * Every public section — About Natyam, Founder, Courses, Branches, Batch
 * Timings, and later Gallery, Events, FAQ, Contact, Testimonials, Website
 * Home and SEO — is one /siteContent document, maintained by hand in that
 * module. This app only ever reads them.
 *
 * MAINTAINED BY HAND, DELIBERATELY. Courses, Branches and Batch Timings also
 * exist as operational records elsewhere in the ERP, and this content is NOT
 * derived from them: no projection, no synchronisation, no automatic write
 * from Branch, Batch or Curriculum management. That duplication is a choice
 * the school made knowingly, in exchange for an architecture with one moving
 * part instead of several. It also means this module is free to say what a
 * parent needs rather than mirroring an operational record — a public batch
 * listing is a friendly description of when classes run, not a copy of a
 * batch row.
 *
 * The practical consequence, stated once so it is not a surprise: changing a
 * branch's address in Branch Management does not change the public Branches
 * page. Both are edited, separately, on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE SHAPE FOR EVERY SECTION, now and later.
 *
 * There is no per-section shape here, and adding Gallery later must not
 * introduce one. There are two kinds:
 *
 *   PAGE   Prose. An ordered list of `blocks`.
 *          — About Natyam, Founder, and later Contact, Website Home.
 *
 *   LIST   Repeating entries. An ordered list of `items`.
 *          — Courses, Branches, Batch Timings, and later Gallery (image
 *            items), Events, FAQ (title = question, body = answer),
 *            Testimonials.
 *
 *   ENVELOPE  (a /siteContent/{key} document's `value`)
 *     {
 *       kind: 'page' | 'list',
 *       title, subtitle,
 *       blocks: [                  // kind: 'page'
 *         { type: 'heading', text }
 *         { type: 'text',    text }
 *         { type: 'image',   src, alt, caption }
 *         { type: 'facts',   facts: [{ label, value }] }
 *       ],
 *       items: [ ITEM ]            // kind: 'list'
 *     }
 *
 *   ITEM
 *     { id, title, subtitle, body, image, facts: [{ label, value }] }
 *
 * Every field is optional; a missing one renders as absent, never as an
 * error. publicContent.service.js's normaliser rebuilds both shapes field by
 * field and drops anything it does not recognise.
 *
 * SELF-DESCRIBING, SO THE WEBSITE NEEDS NOTHING FROM THIS FILE. Each stored
 * document carries its own `kind` and `title`, so any consumer can render it
 * knowing only the envelope above. PUBLIC_MODULES below is this app's menu —
 * order, paths, icons, blurbs — and is deliberately NOT the schema. The
 * website will have its own menu and read the same documents.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** A section's shape. Stored on the document, not inferred. */
export const CONTENT_KINDS = Object.freeze({
    PAGE: 'page',
    LIST: 'list'
});

/**
 * The block types a PAGE may contain. Anything else is dropped on read.
 *
 * An `image` block's `src` is always a Firebase Storage download URL, written
 * by the Website Content module's upload — never a hand-typed address. See
 * publicContent.service.js's image() for the read-side check that keeps it
 * that way.
 */
export const BLOCK_TYPES = Object.freeze({
    HEADING: 'heading',
    TEXT:    'text',
    IMAGE:   'image',
    FACTS:   'facts'
});

/**
 * The public sections this app shows, in menu order.
 *
 * `key` is the /siteContent document id and is a published interface — the
 * Website Content module writes these ids and the future website will request
 * them. `label`, `icon`, `path` and `blurb` are this app's presentation.
 *
 * TO ADD A FUTURE SECTION (Gallery, Events, FAQ, Contact, Testimonials,
 * Website Home, SEO): add one frozen entry here and one section to the
 * Website Content module. For example:
 *
 *     { key: 'gallery', kind: CONTENT_KINDS.LIST, path: '/gallery',
 *       label: 'Gallery', icon: 'grid',
 *       blurb: 'Photographs from performances and classes.' }
 *
 * No new repository method, service function, screen or rule. They are not
 * listed yet because the brief postpones them, and a menu entry pointing at
 * an unwritten document is a dead end for a visitor.
 */
export const PUBLIC_MODULES = Object.freeze([
    Object.freeze({
        key: 'about', kind: CONTENT_KINDS.PAGE, path: '/about',
        label: 'About Natyam', icon: 'info',
        blurb: 'Who we are and how we teach.'
    }),
    Object.freeze({
        key: 'courses', kind: CONTENT_KINDS.LIST, path: '/courses',
        label: 'Courses', icon: 'star',
        blurb: 'What we teach, level by level.'
    }),
    Object.freeze({
        key: 'branches', kind: CONTENT_KINDS.LIST, path: '/branches',
        label: 'Branches', icon: 'map-pin',
        blurb: 'Where classes run, and how to reach us.'
    }),
    Object.freeze({
        key: 'batchTimings', kind: CONTENT_KINDS.LIST, path: '/timings',
        label: 'Batch Timings', icon: 'clock',
        blurb: 'Days and times for each batch.'
    }),
    Object.freeze({
        key: 'founder', kind: CONTENT_KINDS.PAGE, path: '/founder',
        label: 'Founder', icon: 'feather',
        blurb: 'The teacher behind the school.'
    })
]);

/** The registry entry for a key, or null. */
export function moduleFor(key) {
    return PUBLIC_MODULES.find((m) => m.key === key) || null;
}
