import {parse as parseYaml} from 'yaml';

/**
 * @module ai/services/shared/adrRedirect
 * @summary The single reader for the ADR redirect document: the pointer a moved decision record leaves at
 * its old path. Every ADR reader asks it before applying the numbered-filename heuristic, so a pointer
 * named `0034-….md` never becomes a second record of the decision it points away from.
 *
 * Shared by the Knowledge Base's `AdrSource` (both extraction paths) and the graph's `AdrIngestor`. A
 * convention two services read is defined once, or a fix in one leaves the other indexing pointers (the
 * `a2aCollisionTags` precedent).
 *
 * It answers what a document IS, never where it points: resolving `target` belongs to the admitted
 * catalog's reader, where an unknown target stays unresolved.
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.9
 */

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

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
    const frontmatter = typeof content === 'string' ? FRONTMATTER_REGEX.exec(content) : null;

    if (!frontmatter) return false;

    try {
        return parseYaml(frontmatter[1])?.type === 'redirect'
    } catch {
        return false
    }
}
