import {parse as parseYaml}   from 'yaml';
import {parseCanonicalAdrKey} from './adrIdentityCodec.mjs';

/**
 * @module ai/services/shared/adrRedirect
 * @summary The single reader for the ADR redirect document: the pointer a moved decision record leaves at
 * its old path. Every ADR reader asks it before applying the numbered-filename heuristic, so a pointer
 * named `0034-….md` never becomes a second record of the decision it points away from.
 *
 * Shared by the Knowledge Base's `AdrSource` (both extraction paths), the seam-table linter, and the
 * graph's `AdrIngestor`. A convention multiple services read is defined once, or a fix in one leaves
 * the others indexing pointers (the `a2aCollisionTags` precedent).
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.9
 */

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * @summary Parses an ADR redirect document's frontmatter (`type: redirect`, `target: <canonicalKey>`)
 * and validates that it carries a canonical decision identity target and no competing ADR status metadata.
 * @param {String} content The document's raw text.
 * @returns {{isRedirect: Boolean, valid: Boolean, target: String|null, parsedTarget: Object|null, reasonCode: String|null}}
 */
export function parseAdrRedirect(content) {
    const frontmatter = typeof content === 'string' ? FRONTMATTER_REGEX.exec(content) : null;

    if (!frontmatter) {
        return {isRedirect: false, valid: false, target: null, parsedTarget: null, reasonCode: 'NOT_REDIRECT'};
    }

    let parsed;
    try {
        parsed = parseYaml(frontmatter[1]);
    } catch {
        return {isRedirect: false, valid: false, target: null, parsedTarget: null, reasonCode: 'INVALID_FRONTMATTER'};
    }

    if (!parsed || typeof parsed !== 'object' || parsed.type !== 'redirect') {
        return {isRedirect: false, valid: false, target: null, parsedTarget: null, reasonCode: 'NOT_REDIRECT'};
    }

    const extraKeys = Object.keys(parsed).filter(key => key !== 'type' && key !== 'target');
    if (extraKeys.length > 0) {
        return {
            isRedirect  : true,
            valid       : false,
            target      : typeof parsed.target === 'string' ? parsed.target : null,
            parsedTarget: null,
            reasonCode  : 'REDIRECT_METADATA_FORBIDDEN'
        };
    }

    if (typeof parsed.target !== 'string' || !parsed.target.trim()) {
        return {isRedirect: true, valid: false, target: null, parsedTarget: null, reasonCode: 'MISSING_REDIRECT_TARGET'};
    }

    try {
        const parsedTarget = parseCanonicalAdrKey(parsed.target.trim());
        return {
            isRedirect: true,
            valid     : true,
            target    : parsedTarget.canonicalKey,
            parsedTarget,
            reasonCode: null
        };
    } catch (error) {
        return {
            isRedirect  : true,
            valid       : false,
            target      : parsed.target.trim(),
            parsedTarget: null,
            reasonCode  : error.code || 'ADR_INVALID_CANONICAL_KEY'
        };
    }
}

/**
 * @summary Whether a markdown document is an ADR redirect: its frontmatter `type` is exactly `redirect`.
 *
 * A document without frontmatter, with another `type`, or whose frontmatter does not parse is not one, so
 * it reaches the caller's record path unchanged. That direction is deliberate: a malformed pointer then
 * shows up as a visibly wrong record, while a record misread as a pointer would vanish without a trace.
 * @param {String} content The document's raw text.
 * @returns {Boolean}
 */
export function isAdrRedirect(content) {
    return parseAdrRedirect(content).isRedirect;
}
