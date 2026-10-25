import {Buffer} from 'node:buffer';

/**
 * @summary Pure level-two heading splitter for `sandman_handoff.md`.
 *
 * Splits the Dream Pipeline handoff Markdown into addressable section slugs so
 * `get_sandman_handoff` can serve only the `## Computed Golden Path` route by
 * default while keeping the gap and consolidation audit sections available on
 * demand without maintaining a second handoff file.
 *
 * Heading-to-slug contract:
 * - Everything before the first `## ` heading (when non-whitespace) -> `'gaps'`
 * - `## Consolidation Gaps` (or `## Consolidation...`) -> `'consolidation'`
 * - `## Computed Golden Path (Strategic Recommendation)` (or `## Computed Golden Path...`) -> `'goldenPath'`
 * - `## Focus (v1)` (or `## Focus...`) -> `'focus'`
 * - Any other producer `## <Heading>` -> camelCase slug derived from its title (after stripping trailing parentheticals and emoji/punctuation).
 *
 * @module Neo.ai.services.memory-core.helpers.sandmanHandoffSections
 */

/**
 * Canonical section slugs emitted by the Dream Pipeline handoff producer.
 * @type {ReadonlyArray<String>}
 */
export const KNOWN_HANDOFF_SECTION_SLUGS = Object.freeze([
    'gaps',
    'consolidation',
    'goldenPath',
    'focus'
]);

/**
 * Default section selection when `get_sandman_handoff` or `readSandmanHandoff` is called without `sections`.
 * @type {ReadonlyArray<String>}
 */
export const DEFAULT_HANDOFF_SECTIONS = Object.freeze(['goldenPath']);

/**
 * @summary Maps a level-two Markdown heading title (without the leading `## `) to its section slug.
 * @param {String} rawHeading Heading text after `## `.
 * @returns {String} Canonical or camelCase section slug.
 */
export function headingToSectionSlug(rawHeading) {
    if (typeof rawHeading !== 'string') {
        return '';
    }

    const withoutParens = rawHeading.replace(/\s*\([^)]*\)\s*$/g, '').trim();

    if (/^Consolidation\b/i.test(withoutParens)) {
        return 'consolidation';
    }

    if (/^(?:Computed\s+)?Golden\s+Path\b/i.test(withoutParens)) {
        return 'goldenPath';
    }

    if (/^Focus\b/i.test(withoutParens)) {
        return 'focus';
    }

    if (/^Gaps\b/i.test(withoutParens)) {
        return 'gaps';
    }

    const words = withoutParens
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (words.length === 0) {
        return '';
    }

    return words
        .map((word, index) => index === 0
            ? word.toLowerCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join('');
}

/**
 * @summary Splits `sandman_handoff.md` content on level-two (`## `) headings into named sections.
 *
 * Every section slice preserves its exact substring from `markdown` (including its `## ` heading
 * line and trailing newlines up to the next `## ` boundary), so concatenating all sections in
 * `availableSections` order reproduces the original document byte-for-byte.
 *
 * @param {String} markdown Raw `sandman_handoff.md` text.
 * @returns {{sectionsBySlug: Object<String, {content: String, bytes: Number}>, availableSections: String[]}}
 */
export function splitSandmanHandoffSections(markdown) {
    if (typeof markdown !== 'string' || markdown.length === 0) {
        return {
            sectionsBySlug   : {},
            availableSections: []
        };
    }

    const headingRegex = /^## ([^\r\n#][^\r\n]*)\r?$/gm;
    const matches      = [];
    let   match;

    while ((match = headingRegex.exec(markdown)) !== null) {
        matches.push({
            index: match.index,
            title: match[1]
        });
    }

    const sectionsBySlug    = {};
    const availableSections = [];

    const recordSection = (slug, slice) => {
        if (!slug || !slice) {
            return;
        }

        if (!Object.hasOwn(sectionsBySlug, slug)) {
            availableSections.push(slug);
            sectionsBySlug[slug] = {
                content: slice,
                bytes  : Buffer.byteLength(slice, 'utf8')
            };
        } else {
            const combined = sectionsBySlug[slug].content + slice;
            sectionsBySlug[slug] = {
                content: combined,
                bytes  : Buffer.byteLength(combined, 'utf8')
            };
        }
    };

    const preambleEnd = matches.length > 0 ? matches[0].index : markdown.length;
    const preamble    = markdown.slice(0, preambleEnd);

    if (preamble.trim().length > 0) {
        recordSection('gaps', preamble);
    }

    for (let i = 0; i < matches.length; i++) {
        const current   = matches[i];
        const nextIndex = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
        const slice     = markdown.slice(current.index, nextIndex);
        const slug      = headingToSectionSlug(current.title);

        recordSection(slug, slice);
    }

    return {
        sectionsBySlug,
        availableSections
    };
}

/**
 * @summary Normalizes the caller's `sections` parameter into either whole-file mode or an ordered slug list.
 * @param {String|String[]|undefined|null} sections Caller-requested section selection.
 * @returns {{mode: 'all'|'sections', requestedSlugs: String[]}}
 */
export function normalizeRequestedSections(sections) {
    if (sections === undefined || sections === null) {
        return {
            mode          : 'sections',
            requestedSlugs: [...DEFAULT_HANDOFF_SECTIONS]
        };
    }

    if (sections === 'all' || sections === '*') {
        return {
            mode          : 'all',
            requestedSlugs: []
        };
    }

    if (typeof sections === 'string') {
        const trimmed = sections.trim();
        return {
            mode          : 'sections',
            requestedSlugs: trimmed ? [trimmed] : [...DEFAULT_HANDOFF_SECTIONS]
        };
    }

    if (Array.isArray(sections)) {
        const normalized = sections
            .filter(item => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean);

        if (normalized.includes('*') || normalized.includes('all')) {
            return {
                mode          : 'all',
                requestedSlugs: []
            };
        }

        return {
            mode          : 'sections',
            requestedSlugs: normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_HANDOFF_SECTIONS]
        };
    }

    return {
        mode          : 'sections',
        requestedSlugs: [...DEFAULT_HANDOFF_SECTIONS]
    };
}
