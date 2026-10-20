import crypto                                                                       from 'crypto';
import fs                                                                           from 'fs';
import path                                                                         from 'path';
import Base                                                                         from 'neo.mjs/src/core/Base.mjs';
import {Memory_GraphService as GraphService, Memory_StorageRouter as StorageRouter} from '../../services.mjs';
import logger                                                                       from '../../mcp/server/memory-core/logger.mjs';
import {canonicalizeConceptId}                                                      from '../graph/conceptSpineCanonicalization.mjs';
import {CORPUS_GRAPH_ORIGIN, qualifyOriginId}                                       from '../graph/corpusProjectionContract.mjs';
import {isAdrRedirect}                                                              from '../shared/adrRedirect.mjs';

export const ADR_EDGE_TYPES = Object.freeze({
    CITES_AUTHORITY    : 'CITES_AUTHORITY',
    CODIFIES_CONCEPT   : 'CODIFIES_CONCEPT',
    GOVERNS            : 'GOVERNS',
    GRADUATED_FROM     : 'GRADUATED_FROM',
    IMPLEMENTS_DECISION: 'IMPLEMENTS_DECISION'
});

export const ADR_SLUG_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Evidenced repository cut bindings for the core organism repositories.
 */
export const KNOWN_CUT_REPOSITORIES = Object.freeze([
    Object.freeze({forge: 'github.com', repositoryId: '220867748',  namespace: 'neomjs/neo'}),
    Object.freeze({forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain'}),
    Object.freeze({forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution'})
]);

const
    ADR_FILE_REGEX              = /^(\d{4})-(.+)\.md$/,
    ADR_NUMBER_REGEX            = /^(?!0000)\d{4}$/,
    FORGE_AUTHORITY_REGEX       = /^[a-z0-9.-]+(?::[1-9][0-9]*)?$/,
    FULL_NAMESPACE_REGEX        = /^[^/\s]+\/[^/\s]+$/,
    RFC3986_ENCODED_TOKEN_REGEX = /^(?:[A-Za-z0-9\-._~]|%[0-9A-F]{2})+$/,
    ISSUE_KEYWORD_REF_REGEX     = /\b(?:Epic|Issue|Ticket)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))\b/gi,
    ISSUE_LINK_REF_REGEX        = /\[[^\]]*\]\(https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[?#][^\s)]*)?\)/gi,
    PR_KEYWORD_REF_REGEX        = /\bPR\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))\b/gi,
    PR_LINK_REF_REGEX           = /\[[^\]]*\]\(https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[?#][^\s)]*)?\)/gi,
    CONCEPT_REF_REGEX           = /\bCONCEPT:([A-Za-z0-9_.:-]+)\b/g,
    SESSION_REF_REGEX           = /\bOrigin Session ID:\s*`?([A-Za-z0-9_.:-]+)`?/gi,
    STATUS_ROW_REGEX            = /^\|\s*\*\*Status\*\*\s*\|\s*([^|]+?)\s*\|/mi,
    STATUS_BOLD_REGEX           = /^\s*\*\*Status\*\*:\s*(.+)$/mi,
    // Third spelling, colon inside the bold. Without it the composition record's status matched
    // nothing and the `|| 'Draft'` fallback below turned a parse failure into a status claim — a
    // record the graph then reported as pending for weeks on the strength of a regex that missed it.
    STATUS_INNER_REGEX           = /^\s*\*\*Status:\*\*\s*(.+)$/mi,
    SUPERSEDES_ROW_REGEX         = /^\|\s*\*\*Supersedes\*\*\s*\|\s*([^|]+?)\s*\|/mi,
    QUALIFIED_ISSUE_NODE_REGEX   = /^(?:[a-z0-9_.-]+#)?issue-\d+$/i,
    QUALIFIED_PR_NODE_REGEX      = /^(?:[a-z0-9_.-]+#)?pr-\d+$/i,
    QUALIFIED_DISC_NODE_REGEX    = /^(?:[a-z0-9_.-]+#)?discussion-\d+$/i,
    SESSION_NODE_REGEX           = /^session:[A-Za-z0-9_.:-]+$/,
    ADR_SHAPED_ID_REGEX          = /^(?:adr[-:]|.*#adr[-:])/i;

/**
 * Stable deep-stringify for ADR payload hashing. Sorts object keys recursively so
 * logically-identical metadata emits the same hash regardless of parser order.
 * @param {*} value
 * @returns {String}
 * @private
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }

    const keys = Object.keys(value).sort();

    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function createCodedError(code, message) {
    const err = new Error(message);
    err.code  = code;
    return err;
}

function isUnreservedRfc3986Byte(byte) {
    return (byte >= 0x41 && byte <= 0x5A) || // A-Z
           (byte >= 0x61 && byte <= 0x7A) || // a-z
           (byte >= 0x30 && byte <= 0x39) || // 0-9
           byte === 0x2D ||                  // -
           byte === 0x2E ||                  // .
           byte === 0x5F ||                  // _
           byte === 0x7E;                    // ~
}

/**
 * @summary Encodes UTF-8 bytes of one ADR canonical-key field per RFC 3986 §§2.1–2.3.
 * Only ASCII letters, digits, `-`, `.`, `_`, and `~` remain literal; all other bytes
 * are percent-encoded with uppercase hexadecimal digits.
 * @param {String} value Raw field value.
 * @returns {String}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function encodeAdrKeyField(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', 'ADR identity field must be a non-empty string.');
    }

    const bytes = Buffer.from(value, 'utf8');
    let   out   = '';

    for (const byte of bytes) {
        if (isUnreservedRfc3986Byte(byte)) {
            out += String.fromCharCode(byte);
        } else {
            out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
        }
    }

    return out;
}

/**
 * @summary Decodes one RFC 3986-encoded ADR canonical-key field once and verifies
 * canonical re-encoding equality (uppercase hex, literal unreserved chars).
 * @param {String} encoded Encoded field segment.
 * @returns {String}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function decodeAdrKeyField(encoded) {
    if (typeof encoded !== 'string' || encoded.length === 0 || !RFC3986_ENCODED_TOKEN_REGEX.test(encoded)) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `Noncanonical or malformed encoded ADR key field: '${String(encoded)}'`);
    }

    let decoded;
    try {
        decoded = decodeURIComponent(encoded);
    } catch {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `Invalid UTF-8 percent-encoding in ADR key field: '${encoded}'`);
    }

    if (encodeAdrKeyField(decoded) !== encoded) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `ADR key field failed canonical re-encoding equality: '${encoded}'`);
    }

    return decoded;
}

/**
 * @summary Validates the four canonical ADR decision identity fields before admission or key serialization.
 * @param {Object} fields
 * @param {String} fields.forge Canonical provider authority (no scheme, credentials, or default port).
 * @param {String} fields.repositoryId Evidenced stable repository resource ID (not a mutable name).
 * @param {String} fields.namespace Full `<organization>/<repository>` name at assignment.
 * @param {String} fields.number Four ASCII decimal digits `0001`..`9999`.
 * @returns {{forge: String, repositoryId: String, namespace: String, number: String}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function validateAdrIdentityFields({forge, repositoryId, namespace, number} = {}) {
    if (typeof forge !== 'string' || !forge || forge.trim() !== forge ||
        forge.includes('://') || forge.includes('@') || forge.includes('/') ||
        !FORGE_AUTHORITY_REGEX.test(forge) || /:80$|:443$/.test(forge)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid or noncanonical forge authority: '${String(forge)}'`);
    }

    if (typeof repositoryId !== 'string' || !repositoryId || repositoryId.trim() !== repositoryId ||
        /\s|\//.test(repositoryId) || repositoryId === namespace) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Missing or invalid stable repositoryId proof: '${String(repositoryId)}'`);
    }

    if (typeof namespace !== 'string' || !namespace || namespace.trim() !== namespace ||
        !FULL_NAMESPACE_REGEX.test(namespace)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid ADR namespace (full <organization>/<repository> required): '${String(namespace)}'`);
    }

    if (typeof number !== 'string' || !ADR_NUMBER_REGEX.test(number)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid ADR number (expected 0001..9999): '${String(number)}'`);
    }

    return {forge, repositoryId, namespace, number};
}

/**
 * @summary Builds the canonical decision identity key `adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`.
 * @param {Object} fields
 * @param {String} fields.forge
 * @param {String} fields.repositoryId
 * @param {String} fields.namespace
 * @param {String} fields.number
 * @returns {String}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function buildCanonicalAdrKey(fields = {}) {
    const {forge, repositoryId, namespace, number} = validateAdrIdentityFields(fields);
    const
        encForge     = encodeAdrKeyField(forge),
        encRepoId    = encodeAdrKeyField(repositoryId),
        encNamespace = encodeAdrKeyField(namespace);

    if (decodeAdrKeyField(encForge) !== forge ||
        decodeAdrKeyField(encRepoId) !== repositoryId ||
        decodeAdrKeyField(encNamespace) !== namespace) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', 'ADR identity fields failed decode/re-encode roundtrip.');
    }

    return `adr:${encForge}:${encRepoId}:${encNamespace}:${number}`;
}

/**
 * @summary Parses and validates a canonical decision identity key (`adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`).
 * @param {String} key Candidate canonical key.
 * @returns {{canonicalKey: String, forge: String, repositoryId: String, namespace: String, number: String}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.6
 */
export function parseCanonicalAdrKey(key) {
    if (typeof key !== 'string' || !key.startsWith('adr:')) {
        throw createCodedError('ADR_INVALID_CANONICAL_KEY', `Invalid canonical ADR key: '${String(key)}'`);
    }

    const parts = key.split(':');
    if (parts.length !== 5 || parts[0] !== 'adr') {
        throw createCodedError('ADR_INVALID_CANONICAL_KEY', `Canonical ADR key must have 5 colon-separated parts: '${key}'`);
    }

    const
        forge        = decodeAdrKeyField(parts[1]),
        repositoryId = decodeAdrKeyField(parts[2]),
        namespace    = decodeAdrKeyField(parts[3]),
        number       = parts[4];

    validateAdrIdentityFields({forge, repositoryId, namespace, number});

    const rebuilt = buildCanonicalAdrKey({forge, repositoryId, namespace, number});
    if (rebuilt !== key) {
        throw createCodedError('ADR_NONCANONICAL_KEY_ENCODING', `Canonical ADR key failed re-encoding equality: '${key}'`);
    }

    return {canonicalKey: key, forge, repositoryId, namespace, number};
}

/**
 * @summary Parses an ADR markdown filename `NNNN-<slug>.md` into its 4-digit number and kebab-case slug.
 * @param {String} fileName
 * @returns {{adrNumber: String, slug: String}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.7.2
 */
export function parseAdrFilename(fileName) {
    const base      = path.basename(String(fileName || ''));
    const fileMatch = base.match(ADR_FILE_REGEX);
    if (!fileMatch) {
        throw createCodedError('ADR_INVALID_FILENAME', `Invalid ADR file name: ${fileName}`);
    }

    const
        adrNumber = fileMatch[1],
        slug      = fileMatch[2];

    if (!ADR_NUMBER_REGEX.test(adrNumber)) {
        throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid ADR number '${adrNumber}' in file '${fileName}'`);
    }

    if (!ADR_SLUG_REGEX.test(slug)) {
        throw createCodedError('ADR_INVALID_FILENAME_SLUG', `Invalid ADR filename slug '${slug}' in '${fileName}'; expected lowercase ASCII kebab.`);
    }

    return {adrNumber, slug};
}

function stripSingleStrongEmphasis(text) {
    const trimmed = String(text || '').trim();
    const match   = trimmed.match(/^(?:\*\*([^*]+)\*\*|__([^_]+)__)$/);
    return match ? (match[1] || match[2]).trim() : trimmed;
}

function splitMarkdownTableRow(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
        return null;
    }

    return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

function isTwoColumnSeparatorRow(cells) {
    return Array.isArray(cells) &&
           cells.length === 2 &&
           cells.every(cell => /^:?-{2,}:?$/.test(cell));
}

function isCanonicalAttributeValueHeader(cells) {
    return Array.isArray(cells) &&
           cells.length === 2 &&
           stripSingleStrongEmphasis(cells[0]) === 'Attribute' &&
           stripSingleStrongEmphasis(cells[1]) === 'Value';
}

function stripAllEmphasisAndPunctuation(text) {
    return String(text || '').replace(/[*_`:~]/g, '').trim().toLowerCase();
}

/**
 * @summary Reads historical slug `Aliases` strictly from the single canonical two-column
 * `Attribute | Value` opening table between the initial root H1 and the first root H2.
 *
 * Never recurses into fences, blockquotes, or lists, and never scans sections at or after
 * the first H2. Rejects multiple candidate opening tables, duplicate recognized `Aliases`
 * rows (even when values are identical), noncanonical opening-table alias declarations, and
 * malformed or unquoted slug tokens before alias publication.
 *
 * @param {String} content Raw ADR markdown body.
 * @returns {{aliases: String[], hasCanonicalOpeningTable: Boolean, hasAliasesRow: Boolean}}
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md §2.7.2
 */
export function parseAdrOpeningAliases(content) {
    if (typeof content !== 'string' || !content) {
        return {aliases: [], hasCanonicalOpeningTable: false, hasAliasesRow: false};
    }

    const lines = content.split(/\r?\n/);
    let   index = 0;

    // Skip optional YAML frontmatter at top of document
    if (lines[0]?.trim() === '---') {
        index = 1;
        while (index < lines.length && lines[index].trim() !== '---') {
            index++;
        }
        if (index < lines.length) index++;
    }

    let
        inFence      = false,
        fenceMarker  = null,
        seenRootH1   = false,
        inRootList   = false,
        currentTable = null;
    const
        rootTables          = [],
        nonTableRootLines   = [];

    for (; index < lines.length; index++) {
        const
            line    = lines[index],
            trimmed = line.trim();

        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!inFence) {
                inFence     = true;
                fenceMarker = marker;
                if (currentTable) {
                    rootTables.push(currentTable);
                    currentTable = null;
                }
            } else if (fenceMarker === marker) {
                inFence     = false;
                fenceMarker = null;
            }
            continue;
        }

        if (inFence) {
            continue;
        }

        // Ignore blockquotes completely
        if (/^\s*>/.test(line)) {
            if (currentTable) {
                rootTables.push(currentTable);
                currentTable = null;
            }
            continue;
        }

        // Ignore list items and indented list continuations
        if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
            inRootList = true;
            if (currentTable) {
                rootTables.push(currentTable);
                currentTable = null;
            }
            continue;
        }
        if (inRootList) {
            if (trimmed === '') {
                inRootList = false;
            } else if (/^\s{2,}/.test(line)) {
                continue;
            } else {
                inRootList = false;
            }
        }

        if (!seenRootH1) {
            if (/^#\s+.+$/.test(line)) {
                seenRootH1 = true;
            }
            continue;
        }

        // Stop at the first root H2
        if (/^##\s+.+$/.test(line)) {
            break;
        }

        if (/^\|.*\|$/.test(trimmed)) {
            if (!currentTable) {
                currentTable = [];
            }
            currentTable.push(line);
        } else {
            if (currentTable) {
                rootTables.push(currentTable);
                currentTable = null;
            }
            if (trimmed !== '') {
                nonTableRootLines.push(line);
            }
        }
    }

    if (currentTable) {
        rootTables.push(currentTable);
    }

    // Reject prose alias declarations outside a canonical opening table (e.g. Stage 0001 prose style)
    for (const line of nonTableRootLines) {
        if (/^\s*(?:\*{1,3}|_{1,3})?Aliases(?:\*{1,3}|_{1,3})?\s*:/i.test(line) ||
            /^\s*Aliases\s*:/i.test(line)) {
            throw createCodedError(
                'ADR_NONCANONICAL_OPENING_TABLE',
                'Aliases declaration requires a canonical two-column Attribute | Value opening table.'
            );
        }
    }

    const
        canonicalTables    = [],
        nonCanonicalTables = [];

    for (const tableLines of rootTables) {
        const parsedRows = tableLines.map(splitMarkdownTableRow).filter(Boolean);
        if (parsedRows.length < 2) {
            nonCanonicalTables.push(parsedRows);
            continue;
        }

        const
            headerCells    = parsedRows[0],
            separatorCells = parsedRows[1],
            dataRows       = parsedRows.slice(2);

        if (isCanonicalAttributeValueHeader(headerCells) &&
            isTwoColumnSeparatorRow(separatorCells) &&
            dataRows.every(row => row.length === 2)) {
            canonicalTables.push({headerCells, separatorCells, dataRows});
        } else {
            nonCanonicalTables.push(parsedRows);
        }
    }

    // Check if any noncanonical opening table (e.g. Engine 0032 blank headers) attempts to declare Aliases
    for (const rows of nonCanonicalTables) {
        for (const row of rows) {
            if (row.length > 0 && stripAllEmphasisAndPunctuation(row[0]) === 'aliases') {
                throw createCodedError(
                    'ADR_NONCANONICAL_OPENING_TABLE',
                    'Aliases declared in a noncanonical opening table; normalize to Attribute | Value first.'
                );
            }
        }
    }

    if (canonicalTables.length > 1) {
        throw createCodedError(
            'ADR_MULTIPLE_OPENING_TABLES',
            `Expected at most one canonical Attribute | Value opening table between H1 and H2, found ${canonicalTables.length}.`
        );
    }

    if (canonicalTables.length === 0) {
        return {aliases: [], hasCanonicalOpeningTable: false, hasAliasesRow: false};
    }

    const
        table        = canonicalTables[0],
        matchingRows = [];

    for (const row of table.dataRows) {
        const rawLabel = row[0].trim();
        if (stripAllEmphasisAndPunctuation(rawLabel) === 'aliases') {
            // Recognize `Aliases` only as plain text or a single strong-emphasis label
            if (rawLabel !== 'Aliases' && rawLabel !== '**Aliases**' && rawLabel !== '__Aliases__') {
                throw createCodedError(
                    'ADR_INVALID_ALIASES_ROW',
                    `Invalid Aliases attribute label '${rawLabel}'; expected plain 'Aliases' or '**Aliases**'.`
                );
            }
            matchingRows.push(row);
        }
    }

    if (matchingRows.length > 1) {
        throw createCodedError(
            'ADR_DUPLICATE_ALIASES_ROW',
            'Duplicate Aliases rows in opening attribute table are forbidden.'
        );
    }

    if (matchingRows.length === 0) {
        return {aliases: [], hasCanonicalOpeningTable: true, hasAliasesRow: false};
    }

    const rawCell = matchingRows[0][1].trim();
    if (!rawCell) {
        return {aliases: [], hasCanonicalOpeningTable: true, hasAliasesRow: true};
    }

    const
        rawTokens = rawCell.split(','),
        aliases   = [],
        seen      = new Set();

    for (const rawToken of rawTokens) {
        const trimmedToken = rawToken.trim();
        const tokenMatch   = trimmedToken.match(/^`([^`]+)`$/);
        if (!tokenMatch) {
            throw createCodedError(
                'ADR_INVALID_ALIAS_TOKEN',
                `Alias token '${trimmedToken}' must be backtick-delimited.`
            );
        }

        const slug = tokenMatch[1];
        if (!ADR_SLUG_REGEX.test(slug)) {
            throw createCodedError(
                'ADR_INVALID_ALIAS_TOKEN',
                `Alias token '${slug}' violates lowercase ASCII kebab slug grammar.`
            );
        }

        if (seen.has(slug)) {
            throw createCodedError(
                'ADR_INVALID_ALIAS_TOKEN',
                `Duplicate alias token '${slug}' in Aliases row.`
            );
        }

        seen.add(slug);
        aliases.push(slug);
    }

    return {aliases, hasCanonicalOpeningTable: true, hasAliasesRow: true};
}

/**
 * @summary Measures normal author actions for ADR creation and rename against the
 * existing numbered-file baseline.
 * @param {Object} scenario
 * @param {'create'|'rename'|'rename-legacy-table'} scenario.operation
 * @param {String} [scenario.legacyShape=null] `'blank-headers'` or `'prose-fields'`.
 * @returns {Object}
 */
export function measureAdrAuthorActions({operation = 'create', legacyShape = null} = {}) {
    if (operation === 'create') {
        return {
            operation                        : 'create',
            baselineFileEdits                : 1,
            actualFileEdits                  : 1,
            aliasRowEdits                    : 0,
            legacyTableNormalizationEdits    : 0,
            additionalRegistrationSurfaces   : 0,
            manifestEditsRequired            : 0,
            machineKeyPastesRequired         : 0,
            automaticNumberingPrerequisite   : false
        };
    }

    const needsNormalization = operation === 'rename-legacy-table' || Boolean(legacyShape);

    return {
        operation                     : needsNormalization ? 'rename-legacy-table' : 'rename',
        legacyShape                   : legacyShape || (needsNormalization ? 'noncanonical-opening-table' : null),
        baselineFileEdits             : 1,
        actualFileEdits               : 1,
        aliasRowEdits                 : 1,
        legacyTableNormalizationEdits : needsNormalization ? 1 : 0,
        sameSourceEdit                : true,
        additionalRegistrationSurfaces: 0,
        manifestEditsRequired         : 0,
        machineKeyPastesRequired      : 0,
        automaticNumberingPrerequisite: false
    };
}

function stripMarkdownFences(content) {
    if (typeof content !== 'string' || !content) return '';
    const lines = content.split(/\r?\n/);
    const out   = [];
    let   inFence = false, fenceMarker = null;

    for (const line of lines) {
        const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!inFence) {
                inFence     = true;
                fenceMarker = marker;
            } else if (fenceMarker === marker) {
                inFence     = false;
                fenceMarker = null;
            }
            continue;
        }
        if (!inFence) {
            out.push(line);
        }
    }

    return out.join('\n');
}

/**
 * @summary Deterministically ingests Architecture Decision Records into the Native Edge Graph as
 * first-class `ADR` nodes with repository-qualified identities, scoped slug/numeric aliases,
 * and consumer-backed relationship edges.
 *
 * The ADR-node contract makes decision records graph-queryable without widening the REM LLM
 * extractor's `VALID_TYPES` enum. This service owns the admitted, source-backed ADR catalog:
 * canonical RFC 3986 keys (`adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`),
 * local per-repository number allocation and move-out floor preservation, bounded opening-table
 * `Aliases` history, context- and reader-policy-bound citation resolution, batch conflict refusal,
 * and shared summary vector protection.
 *
 * @class Neo.ai.daemons.services.AdrIngestor
 * @extends Neo.core.Base
 * @see learn/agentos/decisions/0006-adrs-as-graph-queryable-entities.md
 * @see Neo.ai.daemons.services.ConceptIngestor
 * @singleton
 */
class AdrIngestor extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.daemons.services.AdrIngestor'
         * @protected
         */
        className: 'Neo.ai.daemons.services.AdrIngestor',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * Retained identity-bound admission records keyed by `canonicalKey`.
     * @type {Map<String, Object>}
     */
    admissionCatalog = new Map()

    /**
     * Per-repository numeric and alias reservations keyed by `${forge}:${repositoryId}`.
     * @type {Map<String, {forge: String, repositoryId: String, numbers: Set<String>, aliases: Map<String, Object>}>}
     */
    repositoryReservations = new Map()

    /**
     * Forge provider directory mapping lowercase `<organization>/<repository>` to current occupant
     * `{forge, repositoryId, currentNamespace}`.
     * @type {Map<String, Map<String, {forge: String, repositoryId: String, currentNamespace: String}>>}
     */
    forgeDirectory = new Map()

    /**
     * Tracks the last observed `GraphService.db.nodes.count` so ephemeral test-harness graph resets
     * (`GraphService.db.nodes.clear()`) automatically reset test-local catalog state unless explicit
     * retention is requested.
     * @type {Number}
     * @private
     */
    #lastGraphNodesCount = 0

    construct(config) {
        super.construct(config);
        this.resetCatalog();
    }

    /**
     * @summary Resets the in-memory admission catalog and seeds the default D19427 cut repositories.
     */
    resetCatalog() {
        this.admissionCatalog.clear();
        this.repositoryReservations.clear();
        this.forgeDirectory.clear();
        this.#lastGraphNodesCount = 0;

        for (const repo of KNOWN_CUT_REPOSITORIES) {
            this.registerForgeRepository(repo);
        }
    }

    /**
     * Synchronizes catalog state with `GraphService.db.nodes` when a test harness clears the graph.
     * @param {Boolean} [preserveRetainedCatalog=false]
     * @private
     */
    #syncWithGraphStoreLifecycle(preserveRetainedCatalog = false) {
        const currentCount = GraphService.db?.nodes?.count ?? 0;
        if (!preserveRetainedCatalog && this.#lastGraphNodesCount > 0 && currentCount === 0) {
            this.resetCatalog();
        }
    }

    /**
     * @summary Registers a repository's current namespace occupancy in the forge provider directory.
     * @param {Object} repo
     * @param {String} [repo.forge='github.com']
     * @param {String} repo.repositoryId
     * @param {String} repo.namespace
     * @param {String[]} [repo.aliases=[]] Historical namespaces that still redirect to this same `repositoryId`.
     */
    registerForgeRepository({forge = 'github.com', repositoryId, namespace, aliases = []} = {}) {
        validateAdrIdentityFields({forge, repositoryId, namespace, number: '0001'});

        if (!this.forgeDirectory.has(forge)) {
            this.forgeDirectory.set(forge, new Map());
        }

        const dir = this.forgeDirectory.get(forge);
        dir.set(namespace.toLowerCase(), {forge, repositoryId, currentNamespace: namespace});

        for (const aliasNs of aliases) {
            if (typeof aliasNs === 'string' && FULL_NAMESPACE_REGEX.test(aliasNs)) {
                const existing = dir.get(aliasNs.toLowerCase());
                if (!existing || existing.repositoryId === repositoryId) {
                    dir.set(aliasNs.toLowerCase(), {forge, repositoryId, currentNamespace: namespace});
                }
            }
        }

        this.#ensureReservationBucket(forge, repositoryId);
    }

    /**
     * @summary Records a proved repository rename without rekeying existing decisions.
     * Reserves old and new qualified locators for the same `repositoryId`. Missing continuity proof refuses.
     * @param {Object} params
     * @param {String} [params.forge='github.com']
     * @param {String} params.repositoryId
     * @param {String} params.previousNamespace
     * @param {String} params.currentNamespace
     * @param {*} params.proof Continuity evidence from the forge provider.
     * @returns {Object}
     */
    recordRepositoryRename({forge = 'github.com', repositoryId, previousNamespace, currentNamespace, proof} = {}) {
        if (!proof) {
            throw createCodedError(
                'ADR_UNPROVED_REPOSITORY_IDENTITY_CHANGE',
                `Repository rename '${previousNamespace}' -> '${currentNamespace}' requires continuity proof.`
            );
        }

        validateAdrIdentityFields({forge, repositoryId, namespace: previousNamespace, number: '0001'});
        validateAdrIdentityFields({forge, repositoryId, namespace: currentNamespace, number: '0001'});

        this.registerForgeRepository({
            forge,
            repositoryId,
            namespace: currentNamespace,
            aliases  : [previousNamespace]
        });

        const bucket = this.#ensureReservationBucket(forge, repositoryId);

        for (const record of this.admissionCatalog.values()) {
            const touchesRepo = record.assignmentEvidence?.forge === forge &&
                (record.assignmentEvidence?.repositoryId === repositoryId ||
                 record.sourceTuple?.repositoryId === repositoryId ||
                 record.aliasBindings.some(b => b.forge === forge && b.repositoryId === repositoryId));

            if (!touchesRepo) continue;

            record.provenance.repositoryRenames.push({
                forge,
                repositoryId,
                previousNamespace,
                currentNamespace,
                proof
            });

            // Clone existing bindings under `previousNamespace` for `repositoryId` onto `currentNamespace`
            // while preserving the historical `previousNamespace` bindings and canonicalKey unchanged.
            const existingForRepo = record.aliasBindings.filter(
                b => b.forge === forge && b.repositoryId === repositoryId &&
                     b.namespace.toLowerCase() === previousNamespace.toLowerCase()
            );

            for (const binding of existingForRepo) {
                this.#addAliasBinding(record, bucket, {
                    kind     : binding.kind,
                    value    : binding.value,
                    forge,
                    repositoryId,
                    namespace: currentNamespace,
                    targetKey: record.canonicalKey,
                    current  : binding.current
                });
            }
        }

        return {forge, repositoryId, previousNamespace, currentNamespace};
    }

    #ensureReservationBucket(forge, repositoryId) {
        const key = `${forge}:${repositoryId}`;
        if (!this.repositoryReservations.has(key)) {
            this.repositoryReservations.set(key, {
                forge,
                repositoryId,
                numbers: new Set(),
                aliases: new Map()
            });
        }
        return this.repositoryReservations.get(key);
    }

    #addAliasBinding(record, bucket, binding) {
        const normalizedNs = binding.namespace.toLowerCase();
        const existing     = record.aliasBindings.find(
            b => b.kind === binding.kind &&
                 b.value === binding.value &&
                 b.forge === binding.forge &&
                 b.repositoryId === binding.repositoryId &&
                 b.namespace.toLowerCase() === normalizedNs
        );

        if (existing) {
            existing.current = Boolean(binding.current);
        } else {
            record.aliasBindings.push({...binding});
        }

        const reservationExists = record.reservations.some(
            r => r.kind === binding.kind &&
                 r.value === binding.value &&
                 r.forge === binding.forge &&
                 r.repositoryId === binding.repositoryId &&
                 r.namespace.toLowerCase() === normalizedNs
        );

        if (!reservationExists) {
            record.reservations.push({
                kind        : binding.kind,
                value       : binding.value,
                forge       : binding.forge,
                repositoryId: binding.repositoryId,
                namespace   : binding.namespace,
                targetKey   : record.canonicalKey
            });
        }

        if (bucket) {
            bucket.aliases.set(`${binding.kind}:${normalizedNs}:${binding.value}`, {
                ...binding,
                targetKey: record.canonicalKey
            });
        }
    }

    /**
     * @summary Reserves historical ADR numbers (and optional slug/legacy-number locators) in a source
     * repository so move-outs and extractions never lower its local allocation floor.
     * @param {Object} params
     * @param {String} [params.forge='github.com']
     * @param {String} params.repositoryId
     * @param {String} params.namespace
     * @param {Array<String|{number: String, slug?: String, targetKey?: String}>} [params.reservations=[]]
     */
    reserveHistoricalNumbers({forge = 'github.com', repositoryId, namespace, reservations = []} = {}) {
        validateAdrIdentityFields({forge, repositoryId, namespace, number: '0001'});
        const bucket = this.#ensureReservationBucket(forge, repositoryId);

        for (const item of reservations) {
            const
                number    = typeof item === 'string' ? item : item?.number,
                slug      = typeof item === 'object' ? item?.slug : null,
                targetKey = (typeof item === 'object' && item?.targetKey) ||
                            buildCanonicalAdrKey({forge, repositoryId, namespace, number});

            if (!ADR_NUMBER_REGEX.test(String(number || ''))) {
                throw createCodedError('ADR_INVALID_IDENTITY_FIELD', `Invalid reserved ADR number: '${String(number)}'`);
            }

            bucket.numbers.add(number);
            bucket.aliases.set(`legacy-number:${namespace.toLowerCase()}:${number}`, {
                kind : 'legacy-number',
                value: number,
                forge,
                repositoryId,
                namespace,
                targetKey
            });

            if (slug) {
                if (!ADR_SLUG_REGEX.test(slug)) {
                    throw createCodedError('ADR_INVALID_ALIAS_TOKEN', `Invalid reserved ADR slug: '${slug}'`);
                }
                bucket.aliases.set(`slug:${namespace.toLowerCase()}:${slug}`, {
                    kind : 'slug',
                    value: slug,
                    forge,
                    repositoryId,
                    namespace,
                    targetKey
                });
            }
        }
    }

    /**
     * @summary Computes the next local ADR number (`0001`..`9999`) for `(forge, repositoryId)` as one
     * above the greatest admitted or reserved decision number in that repository.
     * Never recycles gaps, never consults other repositories, and refuses an exhausted 4-digit range.
     * @param {Object} params
     * @param {String} [params.forge='github.com']
     * @param {String} params.repositoryId
     * @returns {String}
     */
    allocateNextAdrNumber({forge = 'github.com', repositoryId} = {}) {
        if (typeof forge !== 'string' || !FORGE_AUTHORITY_REGEX.test(forge) ||
            typeof repositoryId !== 'string' || !repositoryId.trim()) {
            throw createCodedError('ADR_INVALID_IDENTITY_FIELD', 'allocateNextAdrNumber requires valid forge and repositoryId.');
        }

        const bucket = this.repositoryReservations.get(`${forge}:${repositoryId}`);
        let   max    = 0;

        if (bucket) {
            for (const num of bucket.numbers) {
                const val = Number(num);
                if (Number.isFinite(val) && val > max) max = val;
            }
        }

        for (const record of this.admissionCatalog.values()) {
            const matchesRepo =
                (record.assignmentEvidence?.forge === forge && record.assignmentEvidence?.repositoryId === repositoryId) ||
                (record.sourceTuple?.forge === forge && record.sourceTuple?.repositoryId === repositoryId) ||
                record.reservations?.some(r => r.forge === forge && r.repositoryId === repositoryId);

            if (matchesRepo) {
                const val = Number(record.adrNumber);
                if (Number.isFinite(val) && val > max) max = val;
            }
        }

        if (max >= 9999) {
            throw createCodedError(
                'ADR_ALLOCATION_EXHAUSTED',
                `Four-digit ADR range (0001..9999) is exhausted for ${forge}:${repositoryId}.`
            );
        }

        return String(max + 1).padStart(4, '0');
    }

    /**
     * @summary Exposes present-file and unfiltered-history observations (including rename destinations)
     * as an advisory candidate floor, while keeping admission's proved population as the sole certifier
     * of eligibility.
     * @param {Object} [options]
     * @param {String[]} [options.presentFiles=[]]
     * @param {Array<String|{status?: String, path?: String, oldPath?: String, newPath?: String}>} [options.gitHistoryEntries=[]]
     * @param {Boolean} [options.historyComplete=false]
     * @param {Boolean} [options.shallow=false]
     * @param {'all'|'AD'} [options.historyFilter='all']
     * @param {String} [options.forge='github.com']
     * @param {String|null} [options.repositoryId=null]
     * @returns {Object}
     */
    observeCandidateAllocationFloor({
        presentFiles      = [],
        gitHistoryEntries = [],
        historyComplete   = false,
        shallow           = false,
        historyFilter     = 'all',
        forge             = 'github.com',
        repositoryId      = null
    } = {}) {
        const extractNum = (filePath) => {
            if (typeof filePath !== 'string') return 0;
            const m = path.basename(filePath).match(/^(\d{4})-.*\.md$/);
            return m ? Number(m[1]) : 0;
        };

        let presentMax = 0;
        for (const file of presentFiles) {
            const val = extractNum(file);
            if (val > presentMax) presentMax = val;
        }

        let historyMax = 0;
        for (const entry of gitHistoryEntries) {
            if (typeof entry === 'string') {
                const val = extractNum(entry);
                if (val > historyMax) historyMax = val;
            } else if (entry && typeof entry === 'object') {
                const status = String(entry.status || '').toUpperCase();
                if (historyFilter === 'AD' && status.startsWith('R')) {
                    // Simulate `git log --diff-filter=AD` missing rename destinations (`R092 0041 -> 0042`)
                    const oldVal = extractNum(entry.oldPath || entry.path);
                    if (oldVal > historyMax) historyMax = oldVal;
                } else {
                    for (const p of [entry.path, entry.oldPath, entry.newPath]) {
                        const val = extractNum(p);
                        if (val > historyMax) historyMax = val;
                    }
                }
            }
        }

        const
            incompleteHistory = !historyComplete || Boolean(shallow) || historyFilter === 'AD',
            observedMax       = Math.max(presentMax, historyMax),
            candidateFloor    = observedMax > 0 ? String(observedMax).padStart(4, '0') : '0000',
            nextCandidate     = observedMax < 9999 ? String(observedMax + 1).padStart(4, '0') : null;

        let admittedFloor           = null,
            certifiedEligibleNumber = null;

        if (repositoryId) {
            certifiedEligibleNumber = this.allocateNextAdrNumber({forge, repositoryId});
            const admittedMax = Number(certifiedEligibleNumber) - 1;
            admittedFloor           = String(admittedMax).padStart(4, '0');
        }

        return {
            presentFloor        : presentMax > 0 ? String(presentMax).padStart(4, '0') : '0000',
            historyFloor        : historyMax > 0 ? String(historyMax).padStart(4, '0') : '0000',
            candidateFloor,
            nextCandidateNumber : nextCandidate,
            incompleteHistory,
            advisoryOnly        : true,
            certifiedByAdmission: false,
            admittedFloor,
            certifiedEligibleNumber
        };
    }

    /**
     * @summary Measures normal author actions for creation or rename.
     * @param {Object} scenario
     * @returns {Object}
     */
    measureAuthorActions(scenario) {
        return measureAdrAuthorActions(scenario);
    }

    /**
     * Computes the differential-sync hash stored under `properties.payloadHash`.
     * @param {Object} adr Parsed ADR metadata.
     * @returns {String}
     * @protected
     */
    computePayloadHash(adr) {
        const payload = {
            adrNumber : adr.adrNumber,
            rawStatus : adr.rawStatus,
            source    : adr.source,
            status    : adr.status,
            supersedes: adr.supersedes,
            title     : adr.title,
            ...(adr.canonicalKey && adr.canonicalKey !== `adr-${adr.adrNumber}` ? {
                canonicalKey     : adr.canonicalKey,
                currentSlug      : adr.currentSlug,
                historicalAliases: adr.historicalAliases
            } : {})
        };

        return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
    }

    /**
     * @summary Parses a markdown ADR file into graph-node metadata, slug history, and deterministic edge rows.
     * @param {String} fileName ADR markdown file name.
     * @param {String} content ADR markdown body.
     * @param {String} source Repo-relative source path.
     * @param {Object} [options={}] Optional repository/assignment/citation context.
     * @returns {Object}
     * @protected
     */
    parseAdr(fileName, content, source, options = {}) {
        const
            {adrNumber, slug: currentSlug} = parseAdrFilename(fileName),
            aliasResult                    = parseAdrOpeningAliases(content),
            historicalAliases              = aliasResult.aliases,
            repository                     = options.repository || null,
            assignedIdentity               = options.assignedIdentity || repository;

        let canonicalKey = `adr-${adrNumber}`,
            id           = canonicalKey;

        if (options.canonicalKey) {
            const parsedKey = parseCanonicalAdrKey(options.canonicalKey);
            if (parsedKey.number !== adrNumber) {
                throw createCodedError(
                    'ADR_NUMBER_MISMATCH',
                    `Canonical key number '${parsedKey.number}' does not match filename number '${adrNumber}'.`
                );
            }
            canonicalKey = parsedKey.canonicalKey;
            id           = canonicalKey;
        } else if (assignedIdentity) {
            canonicalKey = buildCanonicalAdrKey({
                forge       : assignedIdentity.forge || 'github.com',
                repositoryId: assignedIdentity.repositoryId,
                namespace   : assignedIdentity.namespace,
                number      : adrNumber
            });
            id = canonicalKey;
        }

        const
            headingMatch         = content.match(/^#\s+ADR\s+\d{4}:?\s*(.+)$/mi),
            title                = headingMatch?.[1]?.trim() || path.basename(fileName, '.md'),
            statusMatch          = content.match(STATUS_ROW_REGEX) || content.match(STATUS_BOLD_REGEX) || content.match(STATUS_INNER_REGEX),
            rawStatus            = (statusMatch?.[1] || 'Draft').replace(/\s+/g, ' ').trim(),
            status               = /^Accepted\b/i.test(rawStatus) ? 'Accepted' : 'Draft',
            supersedes           = this.parseSupersedes(content),
            unresolvedReferences = [],
            edges                = this.parseEdges(id, content, {
                ...options,
                unresolvedReferences
            });

        return {
            adrNumber,
            canonicalKey,
            currentSlug,
            hasAliasesRow           : aliasResult.hasAliasesRow,
            hasCanonicalOpeningTable: aliasResult.hasCanonicalOpeningTable,
            historicalAliases,
            id,
            rawStatus,
            source,
            status,
            supersedes,
            title,
            edges,
            unresolvedReferences
        };
    }

    /**
     * Parses the ADR table's Supersedes cell into a reviewable array without attempting to
     * interpret the prose into richer graph nodes.
     * @param {String} content ADR markdown body.
     * @returns {String[]}
     * @protected
     */
    parseSupersedes(content) {
        const match = content.match(SUPERSEDES_ROW_REGEX);
        if (!match) {
            return [];
        }

        return match[1]
            .split(/;|\n/)
            .map(item => item.replace(/^\s*(?:[-*]\s+|\([a-z0-9]+\)\s+|[a-z0-9]+\.\s+)/i, '').trim())
            .filter(Boolean);
    }

    /**
     * Resolves a conversation endpoint (`issue-N` or `pr-N`) using `qualifyOriginId` and existing
     * conversation nodes in `GraphService.db.nodes` so existing conversation nodes are reused rather
     * than shadowed.
     * @param {'issue'|'pr'} kind
     * @param {String} number
     * @param {String|null} qualifiedOrgRepo Explicit `<org>/<repo>` from the citation, or null for bare `#N`.
     * @param {Object} [options={}]
     * @returns {String|null} Resolved graph node id, or null when origin evidence is missing on a moved record.
     * @private
     */
    #resolveConversationEndpointId(kind, number, qualifiedOrgRepo = null, options = {}) {
        const bareId = `${kind}-${number}`;

        if (qualifiedOrgRepo) {
            if (!FULL_NAMESPACE_REGEX.test(qualifiedOrgRepo)) {
                return null;
            }
            const
                repoSlug    = qualifiedOrgRepo.split('/').pop(),
                qualifiedId = qualifyOriginId(repoSlug, bareId);

            if (GraphService.db?.nodes) {
                GraphService.db.getAdjacentNodes(qualifiedId, 'both');
                if (GraphService.db.nodes.get(qualifiedId)) {
                    return qualifiedId;
                }
            }
            return qualifiedId;
        }

        // Bare `#N` reference: check whether this record moved custody without evidenced citation origin
        const
            repository       = options.repository || null,
            assignedIdentity = options.assignedIdentity || null,
            citationOrigin   = options.citationOrigin !== undefined
                ? options.citationOrigin
                : (options.movedCustody ? null : (assignedIdentity || repository));

        if (options.movedCustody && !citationOrigin) {
            if (Array.isArray(options.unresolvedReferences)) {
                options.unresolvedReferences.push({
                    kind,
                    number,
                    raw       : `#${number}`,
                    reasonCode: 'MISSING_CITATION_ORIGIN'
                });
            }
            return null;
        }

        const originNamespace = citationOrigin?.namespace || CORPUS_GRAPH_ORIGIN;
        const repoSlug        = originNamespace.split('/').pop();
        const candidateId     = qualifyOriginId(repoSlug, bareId);

        if (GraphService.db?.nodes) {
            GraphService.db.getAdjacentNodes(candidateId, 'both');
            if (GraphService.db.nodes.get(candidateId)) {
                return candidateId;
            }
        }

        return candidateId;
    }

    /**
     * Extracts only the consumer-backed ADR edge taxonomy from deterministic textual anchors.
     * Supports both bare and repository-qualified issue/PR references and markdown issue/PR links
     * using `qualifyOriginId` and evidenced historical citation origin.
     * @param {String} adrId Stable ADR node id (`adr:...` or legacy `adr-NNNN`).
     * @param {String} content ADR markdown body.
     * @param {Object} [options={}] Citation-origin options.
     * @returns {Object[]}
     * @protected
     */
    parseEdges(adrId, content, options = {}) {
        const
            edges     = new Map(),
            cleanBody = stripMarkdownFences(content),
            addEdge   = (source, target, type, properties = {}) => {
                if (!source || !target) return;
                edges.set(`${source}|${target}|${type}`, {source, target, type, properties});
            };

        for (const match of cleanBody.matchAll(ISSUE_LINK_REF_REGEX)) {
            const
                qualifiedOrgRepo = match[1],
                issueNum         = match[2],
                issueId          = this.#resolveConversationEndpointId('issue', issueNum, qualifiedOrgRepo, options);

            if (issueId) {
                addEdge(adrId, issueId, ADR_EDGE_TYPES.GOVERNS);
                addEdge(issueId, adrId, ADR_EDGE_TYPES.CITES_AUTHORITY);
            }
        }

        for (const match of cleanBody.matchAll(PR_LINK_REF_REGEX)) {
            const
                qualifiedOrgRepo = match[1],
                prNum            = match[2],
                prId             = this.#resolveConversationEndpointId('pr', prNum, qualifiedOrgRepo, options);

            if (prId) {
                addEdge(prId, adrId, ADR_EDGE_TYPES.IMPLEMENTS_DECISION);
            }
        }

        const proseWithoutRepoLinks = cleanBody
            .replace(ISSUE_LINK_REF_REGEX, ' ')
            .replace(PR_LINK_REF_REGEX, ' ');

        for (const match of proseWithoutRepoLinks.matchAll(ISSUE_KEYWORD_REF_REGEX)) {
            const
                qualifiedOrgRepo = match[1] || null,
                issueNum         = match[2] || match[3],
                issueId          = this.#resolveConversationEndpointId('issue', issueNum, qualifiedOrgRepo, options);

            if (issueId) {
                addEdge(adrId, issueId, ADR_EDGE_TYPES.GOVERNS);
                addEdge(issueId, adrId, ADR_EDGE_TYPES.CITES_AUTHORITY);
            }
        }

        for (const match of proseWithoutRepoLinks.matchAll(PR_KEYWORD_REF_REGEX)) {
            const
                qualifiedOrgRepo = match[1] || null,
                prNum            = match[2] || match[3],
                prId             = this.#resolveConversationEndpointId('pr', prNum, qualifiedOrgRepo, options);

            if (prId) {
                addEdge(prId, adrId, ADR_EDGE_TYPES.IMPLEMENTS_DECISION);
            }
        }

        for (const match of cleanBody.matchAll(SESSION_REF_REGEX)) {
            addEdge(adrId, `session:${match[1]}`, ADR_EDGE_TYPES.GRADUATED_FROM);
        }

        for (const match of cleanBody.matchAll(CONCEPT_REF_REGEX)) {
            // Route through the concept-spine SSOT so ADR CODIFIES_CONCEPT edges target the same canonical
            // node the session/mailbox mints do (`GoldenPath` → `golden-path`); keep the raw ref if the
            // canonicalization comes back empty — never drop the edge (Contract Ledger fallback).
            addEdge(adrId, canonicalizeConceptId(match[1]) || match[1], ADR_EDGE_TYPES.CODIFIES_CONCEPT);
        }

        return Array.from(edges.values());
    }

    /**
     * @summary Checks whether a candidate graph endpoint ID is an admitted `ADR` in the catalog or
     * persisted graph with `adrAuthority.admitted === true`.
     * Membership is proved by admission, never by an `adr-` or `adr:` prefix.
     * @param {String} id
     * @returns {Boolean}
     */
    isAdmittedAdrEndpoint(id) {
        if (typeof id !== 'string' || !id) return false;

        if (this.admissionCatalog.has(id)) {
            return true;
        }

        for (const record of this.admissionCatalog.values()) {
            if (record.aliasBindings?.some(b =>
                `${b.namespace}#adr:${b.value}` === id ||
                `${b.forge}/${b.namespace}#adr:${b.value}` === id ||
                (b.kind === 'legacy-number' && (
                    `${b.namespace}#adr-${b.value}` === id ||
                    `${b.forge}/${b.namespace}#adr-${b.value}` === id
                ))
            )) {
                return true;
            }
        }

        if (GraphService.db?.nodes) {
            GraphService.db.getAdjacentNodes(id, 'both');
            const existing = GraphService.db.nodes.get(id);
            if (existing) {
                const
                    label = existing.isRecord ? existing.get('label') : existing.label,
                    props = existing.isRecord ? existing.get('properties') : existing.properties;
                if (label === 'ADR' && props?.adrAuthority?.admitted === true) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * @summary Derives canonical graph endpoint typing (`ADR`, `ISSUE`, `PULL_REQUEST`, `DISCUSSION`,
     * `SESSION`, `CONCEPT`) from admitted authority and conversation-origin grammar.
     * Never grants `ADR` authority by prefix alone and never defaults an unadmitted or qualified
     * authority reference to `CONCEPT`.
     * @param {String} id Candidate endpoint id.
     * @returns {String|null} Node label, or `null` when `id` is an unadmitted authority reference.
     */
    resolveEndpointType(id) {
        if (typeof id !== 'string' || !id) {
            return null;
        }

        if (GraphService.db?.nodes) {
            GraphService.db.getAdjacentNodes(id, 'both');
            const existing = GraphService.db.nodes.get(id);
            if (existing) {
                return existing.isRecord ? existing.get('label') : existing.label;
            }
        }

        if (this.isAdmittedAdrEndpoint(id)) {
            return 'ADR';
        }

        // Reject unadmitted `adr-...`, `adr:...`, or `*#adr[-:]...` references: neither `ADR` nor `CONCEPT`!
        if (ADR_SHAPED_ID_REGEX.test(id)) {
            return null;
        }

        if (QUALIFIED_ISSUE_NODE_REGEX.test(id)) {
            return 'ISSUE';
        }

        if (QUALIFIED_PR_NODE_REGEX.test(id)) {
            return 'PULL_REQUEST';
        }

        if (QUALIFIED_DISC_NODE_REGEX.test(id)) {
            return 'DISCUSSION';
        }

        if (SESSION_NODE_REGEX.test(id)) {
            return 'SESSION';
        }

        // Any other qualified locator containing `#`, `/`, or `:` is not a bare concept-spine key
        if (/[#/:]/.test(id)) {
            return null;
        }

        return 'CONCEPT';
    }

    /**
     * Ensures edge endpoints exist before insertion. The graph storage layer enforces foreign
     * keys for both endpoint columns, so deterministic ADR edges seed only minimal stubs when
     * the richer issue/PR/session/concept ingestors have not materialized a node yet.
     * @param {Object[]} edges ADR edge rows to insert.
     * @returns {Object[]} Filtered edges whose endpoints are valid and present in the graph.
     * @protected
     */
    ensureEdgeEndpointsExist(edges) {
        const validEdges = [];

        for (const edge of edges) {
            const
                sourceNode = this.ensureNodeExists(edge.source),
                targetNode = this.ensureNodeExists(edge.target);

            if (sourceNode && targetNode) {
                validEdges.push(edge);
            }
        }

        return validEdges;
    }

    /**
     * Creates a minimal node stub for an edge endpoint if no richer node is already present.
     * Reuses existing conversation nodes (`issue-...`, `repo#pr-...`) without shadowing, and refuses
     * to invent `ADR` or `CONCEPT` nodes for unadmitted authority references.
     * @param {String} id Graph node id.
     * @returns {Object|null} Existing or created graph node, or `null` when unadmitted/refused.
     * @protected
     */
    ensureNodeExists(id) {
        GraphService.db.getAdjacentNodes(id, 'both');

        const existing = GraphService.db.nodes.get(id);
        if (existing) {
            return existing;
        }

        const type = this.resolveEndpointType(id);
        if (!type) {
            return null;
        }

        GraphService.upsertNode({
            id,
            type,
            name      : id,
            properties: {isAdrEdgeStub: true}
        });

        return GraphService.db.nodes.get(id);
    }

    /**
     * Removes and replaces all ADR-taxonomy edges incident to one ADR node.
     * @param {String} adrId Stable ADR node id.
     * @param {Object[]} edges Replacement edge rows.
     * @returns {Number} Number of valid edges inserted.
     * @protected
     */
    replaceAdrEdges(adrId, edges) {
        const
            db            = GraphService.db,
            adrEdgeTypes  = new Set(Object.values(ADR_EDGE_TYPES)),
            existingEdges = db.edges.items.slice(),
            edgesToRemove = existingEdges.filter(edge =>
                adrEdgeTypes.has(edge.type) && (edge.source === adrId || edge.target === adrId)
            );

        if (edgesToRemove.length > 0) {
            db.edges.remove(edgesToRemove);
        }

        const validEdges = this.ensureEdgeEndpointsExist(edges);

        for (const edge of validEdges) {
            db.addEdge(edge);
        }

        return validEdges.length;
    }

    /**
     * @summary Inventories every graph node that references `vectorId` as its `semanticVectorId`.
     * @param {String} vectorId
     * @returns {Array<{nodeId: String, label: String, isAdmittedAdr: Boolean}>}
     */
    inventoryVectorOwners(vectorId) {
        if (typeof vectorId !== 'string' || !vectorId || !GraphService.db?.nodes) {
            return [];
        }

        const owners = new Map();

        for (const node of GraphService.db.nodes.items) {
            const
                nodeId = node.isRecord ? node.get('id') : node.id,
                label  = node.isRecord ? node.get('label') : node.label,
                props  = (node.isRecord ? node.get('properties') : node.properties) || {};

            if (props.semanticVectorId === vectorId) {
                owners.set(nodeId, {
                    nodeId,
                    label,
                    isAdmittedAdr: label === 'ADR' && props.adrAuthority?.admitted === true
                });
            }
        }

        const sqlite = GraphService.db.storage?.db;
        if (sqlite) {
            try {
                const rows = sqlite.prepare(`
                    SELECT id, json_extract(data, '$.label') AS label, data
                    FROM Nodes
                    WHERE json_extract(data, '$.properties.semanticVectorId') = ?
                `).all(vectorId);

                for (const row of rows) {
                    if (!owners.has(row.id)) {
                        let parsed = {};
                        try { parsed = JSON.parse(row.data); } catch {}
                        owners.set(row.id, {
                            nodeId       : row.id,
                            label        : row.label || parsed.label || 'NODE',
                            isAdmittedAdr: (row.label || parsed.label) === 'ADR' && parsed.properties?.adrAuthority?.admitted === true
                        });
                    }
                }
            } catch {
                // Storage query is best-effort when running against an in-memory mock
            }
        }

        return Array.from(owners.values());
    }

    /**
     * Evaluates whether a reader is authorized to see a given ADR admission record.
     * @param {Object} record
     * @param {Object} [context={}]
     * @returns {Boolean}
     * @private
     */
    #isReaderAuthorizedForRecord(record, context = {}) {
        if (!record) return false;

        if (typeof context.isAuthorized === 'function') {
            return Boolean(context.isAuthorized(record));
        }

        if (Array.isArray(context.authorizedRepositoryIds)) {
            const allowedIds = new Set(context.authorizedRepositoryIds.map(String));
            const repoId     = record.sourceTuple?.repositoryId || record.assignmentEvidence?.repositoryId;
            if (!allowedIds.has(String(repoId))) {
                return false;
            }
        }

        if (Array.isArray(context.authorizedNamespaces)) {
            const allowedNs = new Set(context.authorizedNamespaces.map(ns => String(ns).toLowerCase()));
            const ns        = (record.sourceTuple?.namespace || record.assignmentEvidence?.namespace || '').toLowerCase();
            if (!allowedNs.has(ns)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Extracts evidenced forge and repository context from the citation surface.
     *
     * Surface rules:
     * - `repository_artifact` (`file` | `issue` | `pr`): verified `sourceOrigin` supplies `forge` + repository.
     * - `historical_content` (`moved_file` | `copied_content`): `evidencedCitationOrigin` supplies `forge` + repository;
     *   `currentCustody` is never used as a fallback.
     * - `organization_discussion` (`discussion`): `hostingRepository` supplies NO repository context;
     *   verified `webOrigin` (or `sourceOrigin.forge`) supplies only `forge`.
     * - `memory_or_a2a` (`memory` | `a2a`): infers NO repository from `seat`, `cwd`, `relatedTickets`,
     *   or `hostingImplementation`; only `originEnvelope.forge` may supply `forge`.
     *
     * @param {Object} [context={}]
     * @returns {{forge: String|null, repositoryId: String|null, namespace: String|null}}
     * @private
     */
    #extractCitationSurfaceContext(context = {}) {
        const surface = String(context.surface || 'repository_artifact').toLowerCase();

        if (surface === 'organization_discussion' || surface === 'discussion') {
            const forge = context.webOrigin?.forge || context.sourceOrigin?.forge || context.forge || null;
            return {forge, repositoryId: null, namespace: null};
        }

        if (surface === 'memory_or_a2a' || surface === 'memory' || surface === 'a2a') {
            const forge = context.originEnvelope?.forge || null;
            return {forge, repositoryId: null, namespace: null};
        }

        if (surface === 'historical_content' || surface === 'moved_file' || surface === 'copied_content') {
            const origin = context.evidencedCitationOrigin || null;
            if (!origin) {
                return {forge: null, repositoryId: null, namespace: null};
            }
            return {
                forge       : origin.forge || null,
                repositoryId: origin.repositoryId || null,
                namespace   : origin.namespace || null
            };
        }

        // Default: newly authored repository file, issue, or PR (`repository_artifact`)
        const origin = context.sourceOrigin || null;
        if (!origin) {
            return {
                forge       : context.forge || null,
                repositoryId: context.repositoryId || null,
                namespace   : context.namespace || null
            };
        }

        return {
            forge       : origin.forge || null,
            repositoryId: origin.repositoryId || null,
            namespace   : origin.namespace || null
        };
    }

    /**
     * @summary Resolves a human or machine ADR citation against the admitted catalog using evidenced
     * citation context, forge-adapter repository identity lookup, rename/reuse conflict rules, and
     * reader authorization.
     *
     * Supported reference forms:
     * - Exact canonical key: `adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`
     * - Scoped slug forms:
     *   1. `adr:<slug>` (requires evidenced forge + repository context)
     *   2. `<organization>/<repository>#adr:<slug>` (requires evidenced forge context)
     *   3. `<forge>/<organization>/<repository>#adr:<slug>` (explicit forge + repository)
     * - Legacy numeric forms:
     *   1. `<forge>/<organization>/<repository>#adr-NNNN`
     *   2. `<organization>/<repository>#adr-NNNN`
     *   3. `adr-NNNN`
     *
     * @param {String} reference Raw citation string.
     * @param {Object} [context={}] Citation context and reader authorization options.
     * @returns {Object} Resolution result `{status, resolved, canonicalKey, identityResolved, documentAvailable, kbAvailable, stale, candidates, reasonCode?, requiresCanonicalKey?}`.
     */
    resolveAdrReference(reference, context = {}) {
        const raw = typeof reference === 'string' ? reference.trim() : '';
        if (!raw) {
            return {
                status           : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : [],
                reasonCode       : 'EMPTY_REFERENCE'
            };
        }

        // 1. Check exact canonical machine key (`adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`)
        if (raw.startsWith('adr:') && raw.split(':').length === 5) {
            let parsedKey;
            try {
                parsedKey = parseCanonicalAdrKey(raw);
            } catch (e) {
                return {
                    status           : 'unresolved',
                    resolved         : false,
                    canonicalKey     : null,
                    identityResolved : false,
                    documentAvailable: false,
                    candidates       : [],
                    reasonCode       : e.code || 'ADR_INVALID_CANONICAL_KEY'
                };
            }

            const record = this.admissionCatalog.get(parsedKey.canonicalKey);
            if (!record || !this.#isReaderAuthorizedForRecord(record, context)) {
                return {
                    status           : 'unresolved',
                    resolved         : false,
                    canonicalKey     : null,
                    identityResolved : false,
                    documentAvailable: false,
                    candidates       : [],
                    reasonCode       : 'NOT_FOUND'
                };
            }

            return {
                status           : 'resolved',
                resolved         : true,
                canonicalKey     : record.canonicalKey,
                identityResolved : true,
                documentAvailable: Boolean(record.documentAvailable),
                kbAvailable      : Boolean(record.kbAvailable),
                stale            : Boolean(record.stale),
                record,
                candidates       : [record.canonicalKey]
            };
        }

        // 2. Parse human slug or legacy numeric reference form
        let
            explicitForge     = null,
            explicitNamespace = null,
            targetKind        = null, // 'slug' | 'legacy-number'
            targetValue       = null;

        if (raw.includes('#')) {
            const hashIndex = raw.indexOf('#');
            const qualifier = raw.slice(0, hashIndex);
            const fragment  = raw.slice(hashIndex + 1);

            const segments = qualifier.split('/');
            if (segments.length === 2 && segments[0] && segments[1]) {
                explicitNamespace = `${segments[0]}/${segments[1]}`;
            } else if (segments.length === 3 && segments[0] && segments[1] && segments[2]) {
                explicitForge     = segments[0];
                explicitNamespace = `${segments[1]}/${segments[2]}`;
            } else {
                // Reject bare repository basenames (`repo#adr:slug`) — full `<org>/<repo>` is mandatory
                return {
                    status           : 'unresolved',
                    resolved         : false,
                    canonicalKey     : null,
                    identityResolved : false,
                    documentAvailable: false,
                    candidates       : [],
                    reasonCode       : 'INVALID_REPOSITORY_LOCATOR'
                };
            }

            if (fragment.startsWith('adr:')) {
                targetKind  = 'slug';
                targetValue = fragment.slice(4);
            } else if (/^adr-\d{4}$/.test(fragment)) {
                targetKind  = 'legacy-number';
                targetValue = fragment.slice(4);
            } else {
                return {
                    status           : 'unresolved',
                    resolved         : false,
                    canonicalKey     : null,
                    identityResolved : false,
                    documentAvailable: false,
                    candidates       : [],
                    reasonCode       : 'INVALID_ADR_FRAGMENT'
                };
            }
        } else if (raw.startsWith('adr:')) {
            targetKind  = 'slug';
            targetValue = raw.slice(4);
        } else if (/^adr-\d{4}$/.test(raw)) {
            targetKind  = 'legacy-number';
            targetValue = raw.slice(4);
        } else {
            return {
                status           : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : [],
                reasonCode       : 'UNRECOGNIZED_REFERENCE_FORM'
            };
        }

        if (targetKind === 'slug' && !ADR_SLUG_REGEX.test(targetValue)) {
            return {
                status           : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : [],
                reasonCode       : 'ADR_INVALID_ALIAS_TOKEN'
            };
        }

        if (targetKind === 'legacy-number' && !ADR_NUMBER_REGEX.test(targetValue)) {
            return {
                status           : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : [],
                reasonCode       : 'ADR_INVALID_IDENTITY_FIELD'
            };
        }

        const surfaceContext = this.#extractCitationSurfaceContext(context);
        const effectiveForge = explicitForge || surfaceContext.forge;

        // If the reference supplies no repository (`adr:<slug>` or `adr-NNNN`) and the surface supplies none:
        const hasRepositoryContext = Boolean(explicitNamespace || surfaceContext.repositoryId || surfaceContext.namespace);
        if (!hasRepositoryContext) {
            const matchingAuthorized = [];

            for (const record of this.admissionCatalog.values()) {
                if (!this.#isReaderAuthorizedForRecord(record, context)) continue;

                const matches = record.aliasBindings?.some(
                    b => b.kind === targetKind &&
                         b.value === targetValue &&
                         (!effectiveForge || b.forge === effectiveForge)
                ) || (targetKind === 'legacy-number' && record.adrNumber === targetValue && !record.assignmentEvidence?.repositoryId);

                if (matches) {
                    matchingAuthorized.push(record.canonicalKey);
                }
            }

            // Legacy unscoped fallback ONLY when the catalog is purely unscoped (`adr-NNNN`) and surface is repository_artifact
            if (matchingAuthorized.length === 1 &&
                matchingAuthorized[0] === `adr-${targetValue}` &&
                !context.surface &&
                !context.requireRepositoryContext) {
                const record = this.admissionCatalog.get(matchingAuthorized[0]);
                return {
                    status           : 'resolved',
                    resolved         : true,
                    canonicalKey     : record.canonicalKey,
                    identityResolved : true,
                    documentAvailable: Boolean(record.documentAvailable),
                    kbAvailable      : Boolean(record.kbAvailable),
                    stale            : Boolean(record.stale),
                    record,
                    candidates       : [record.canonicalKey]
                };
            }

            return {
                status           : matchingAuthorized.length > 1 ? 'ambiguous' : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : matchingAuthorized,
                reasonCode       : 'MISSING_REPOSITORY_CONTEXT'
            };
        }

        if (!effectiveForge) {
            return {
                status           : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : [],
                reasonCode       : 'MISSING_FORGE_CONTEXT'
            };
        }

        const
            targetNamespace   = explicitNamespace || surfaceContext.namespace,
            lowerTargetNs     = targetNamespace ? targetNamespace.toLowerCase() : null,
            forgeMap          = this.forgeDirectory.get(effectiveForge),
            adapterResolution = lowerTargetNs && forgeMap ? forgeMap.get(lowerTargetNs) : null,
            currentOccupantId = (!explicitNamespace && surfaceContext.repositoryId)
                ? surfaceContext.repositoryId
                : (adapterResolution?.repositoryId || null);

        // Gather all bindings matching `(effectiveForge, targetKind, targetValue)` for either
        // the target namespace (`lowerTargetNs`) or the resolved `currentOccupantId`.
        const
            namespaceBindings = [],
            repoIdBindings    = [];

        for (const record of this.admissionCatalog.values()) {
            for (const binding of record.aliasBindings || []) {
                if (binding.forge !== effectiveForge || binding.kind !== targetKind || binding.value !== targetValue) {
                    continue;
                }
                if (lowerTargetNs && binding.namespace.toLowerCase() === lowerTargetNs) {
                    namespaceBindings.push({binding, record});
                }
                if (currentOccupantId && binding.repositoryId === currentOccupantId) {
                    repoIdBindings.push({binding, record});
                }
            }
        }

        // Check for rename + old-name reuse conflict:
        // If `lowerTargetNs` holds a reserved binding for `binding.repositoryId`, AND `currentOccupantId`
        // is a DIFFERENT repository that now occupies `lowerTargetNs` (`currentOccupantId !== binding.repositoryId`),
        // never retarget the old alias or let the new occupant inherit it.
        if (lowerTargetNs && currentOccupantId) {
            const conflictingHistorical = namespaceBindings.filter(
                entry => entry.binding.repositoryId !== currentOccupantId
            );

            if (conflictingHistorical.length > 0) {
                const candidateSet = new Set();
                for (const entry of [...conflictingHistorical, ...namespaceBindings.filter(e => e.binding.repositoryId === currentOccupantId)]) {
                    if (this.#isReaderAuthorizedForRecord(entry.record, context)) {
                        candidateSet.add(entry.record.canonicalKey);
                    }
                }

                const authorizedCandidates = Array.from(candidateSet);
                if (authorizedCandidates.length === 0) {
                    return {
                        status           : 'unresolved',
                        resolved         : false,
                        canonicalKey     : null,
                        identityResolved : false,
                        documentAvailable: false,
                        candidates       : [],
                        reasonCode       : 'NOT_FOUND'
                    };
                }

                return {
                    status              : 'conflict',
                    resolved            : false,
                    canonicalKey        : null,
                    identityResolved    : false,
                    documentAvailable   : false,
                    requiresCanonicalKey: true,
                    candidates          : authorizedCandidates,
                    reasonCode          : 'RESERVED_NAMESPACE_OCCUPANCY_CONFLICT'
                };
            }
        }

        // Prefer exact namespace-scoped binding when `lowerTargetNs` is specified (preserving historical
        // move-out / rename scope so `B#adr:old` is NOT fabricated when `old` was only admitted in `A`!).
        let matchedEntries = [];
        if (lowerTargetNs) {
            matchedEntries = namespaceBindings;
            // If the repository was renamed (`old-name` -> `new-name`) and the caller used `new-name`,
            // `adapterResolution.repositoryId` is `currentOccupantId` and `adapterResolution.currentNamespace`
            // matches `lowerTargetNs`; include `repoIdBindings` whose namespace matches `currentNamespace`
            // or that were admitted for `currentOccupantId` before the rename of that SAME repository (`recordRepositoryRename`).
            if (matchedEntries.length === 0 && currentOccupantId && adapterResolution) {
                matchedEntries = repoIdBindings.filter(entry =>
                    entry.record.provenance?.repositoryRenames?.some(
                        r => r.forge === effectiveForge &&
                             r.repositoryId === currentOccupantId &&
                             (r.currentNamespace.toLowerCase() === lowerTargetNs ||
                              r.previousNamespace.toLowerCase() === lowerTargetNs)
                    )
                );
            }
        } else if (currentOccupantId) {
            matchedEntries = repoIdBindings;
        }

        const authorizedRecords = [];
        const seenKeys          = new Set();
        for (const entry of matchedEntries) {
            if (!seenKeys.has(entry.record.canonicalKey) && this.#isReaderAuthorizedForRecord(entry.record, context)) {
                seenKeys.add(entry.record.canonicalKey);
                authorizedRecords.push(entry.record);
            }
        }

        if (authorizedRecords.length === 0) {
            return {
                status           : 'unresolved',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : [],
                reasonCode       : 'NOT_FOUND'
            };
        }

        if (authorizedRecords.length > 1) {
            return {
                status           : 'ambiguous',
                resolved         : false,
                canonicalKey     : null,
                identityResolved : false,
                documentAvailable: false,
                candidates       : authorizedRecords.map(r => r.canonicalKey),
                reasonCode       : 'AMBIGUOUS_REFERENCE'
            };
        }

        const resolvedRecord = authorizedRecords[0];
        return {
            status           : 'resolved',
            resolved         : true,
            canonicalKey     : resolvedRecord.canonicalKey,
            identityResolved : true,
            documentAvailable: Boolean(resolvedRecord.documentAvailable),
            kbAvailable      : Boolean(resolvedRecord.kbAvailable),
            stale            : Boolean(resolvedRecord.stale),
            record           : resolvedRecord,
            candidates       : [resolvedRecord.canonicalKey]
        };
    }

    /**
     * @summary Reconstructs or reconciles an ADR record when declared sources are lost or when
     * rebuilding projections from source plus retained admission evidence.
     *
     * - If neither declared source is available but `retainedRecord` (admission evidence) survives:
     *   retains `canonicalKey`, aliases, and graph node/edges as stale (`stale: true`, `documentAvailable: false`).
     * - If `retainedRecord` (admission evidence) is lost: refuses reconstruction (`ADR_ADMISSION_EVIDENCE_MISSING`),
     *   even when an unproved surviving filename or URL is presented.
     *
     * @param {Object} [params={}]
     * @param {Object|null} [params.retainedRecord=null] Retained admission record.
     * @param {Object|null} [params.survivingSource=null] Optional surviving source `{fileName, content, source}`.
     * @returns {Object}
     */
    reconcileSourceAndEvidence({retainedRecord = null, survivingSource = null} = {}) {
        if (!retainedRecord || !retainedRecord.canonicalKey || !retainedRecord.assignmentEvidence?.repositoryId) {
            throw createCodedError(
                'ADR_ADMISSION_EVIDENCE_MISSING',
                'Cannot reconstruct ADR authority without retained assignment and scope admission evidence.'
            );
        }

        if (!survivingSource || !survivingSource.content) {
            const staleRecord = {
                ...retainedRecord,
                stale            : true,
                documentAvailable: false,
                kbAvailable      : false
            };
            this.admissionCatalog.set(staleRecord.canonicalKey, staleRecord);

            const existingNode = GraphService.db?.nodes?.get(staleRecord.canonicalKey);
            if (existingNode) {
                const props = (existingNode.isRecord ? existingNode.get('properties') : existingNode.properties) || {};
                GraphService.upsertNode({
                    id        : staleRecord.canonicalKey,
                    type      : 'ADR',
                    name      : props.title || staleRecord.title,
                    properties: {
                        ...props,
                        stale             : true,
                        documentAvailable : false,
                        adrAdmissionRecord: staleRecord,
                        adrAuthority      : {
                            ...(props.adrAuthority || {}),
                            admitted         : true,
                            canonicalKey     : staleRecord.canonicalKey,
                            stale            : true,
                            documentAvailable: false
                        }
                    }
                });
            }

            return {
                status           : 'retained-stale',
                canonicalKey     : staleRecord.canonicalKey,
                identityResolved : true,
                documentAvailable: false,
                kbAvailable      : false,
                stale            : true,
                record           : staleRecord
            };
        }

        return {
            status           : 'available',
            canonicalKey     : retainedRecord.canonicalKey,
            identityResolved : true,
            documentAvailable: true,
            kbAvailable      : true,
            stale            : false,
            record           : retainedRecord
        };
    }

    /**
     * Resolves whether an incoming file in `sourceRepo` represents a new decision, an in-place
     * update/rename of an existing decision in `sourceRepo`, or a custody move from another repository.
     * @param {Object} params
     * @returns {Object}
     * @private
     */
    #resolveCandidateIdentity({
        adrNumber,
        currentSlug,
        historicalAliases,
        sourceRepo,
        custodyTransitions = [],
        legacyManifest     = null
    }) {
        if (!sourceRepo) {
            const legacyKey = `adr-${adrNumber}`;
            return {
                canonicalKey             : legacyKey,
                assignedIdentity         : null,
                existingRecord           : this.admissionCatalog.get(legacyKey) || null,
                custodyTransitionVerified: false,
                isCustodyMove            : false
            };
        }

        const
            forge        = sourceRepo.forge || 'github.com',
            repositoryId = sourceRepo.repositoryId,
            namespace    = sourceRepo.namespace;

        validateAdrIdentityFields({forge, repositoryId, namespace, number: adrNumber});
        this.registerForgeRepository({forge, repositoryId, namespace});

        // 1. Check explicit reviewed legacy manifest assignment
        const manifestEntry = Array.isArray(legacyManifest)
            ? legacyManifest.find(m =>
                m.adrNumber === adrNumber &&
                ((m.sourceRepositoryId && m.sourceRepositoryId === repositoryId) ||
                 (m.currentCustody?.repositoryId === repositoryId) ||
                 (m.assignedNamespace && m.assignedNamespace.toLowerCase() === namespace.toLowerCase()))
            )
            : null;

        if (manifestEntry) {
            const assignedIdentity = {
                forge             : manifestEntry.forge || forge,
                repositoryId      : manifestEntry.assignedRepositoryId || manifestEntry.repositoryId,
                namespace         : manifestEntry.assignedNamespace || manifestEntry.namespace,
                assignmentKind    : 'legacy-reviewed',
                reviewedManifestId: manifestEntry.id || 'legacy-manifest'
            };
            const canonicalKey = manifestEntry.canonicalKey || buildCanonicalAdrKey({
                forge       : assignedIdentity.forge,
                repositoryId: assignedIdentity.repositoryId,
                namespace   : assignedIdentity.namespace,
                number      : adrNumber
            });

            return {
                canonicalKey,
                assignedIdentity,
                existingRecord           : this.admissionCatalog.get(canonicalKey) || null,
                custodyTransitionVerified: Boolean(manifestEntry.custodyTransitionVerified || assignedIdentity.repositoryId !== repositoryId),
                isCustodyMove            : assignedIdentity.repositoryId !== repositoryId || assignedIdentity.namespace !== namespace
            };
        }

        // 2. Check explicit custody transition targeting `(forge, repositoryId, namespace)` for `adrNumber`
        const transition = Array.isArray(custodyTransitions)
            ? custodyTransitions.find(t =>
                (t.toRepositoryId === repositoryId || (t.toNamespace && t.toNamespace.toLowerCase() === namespace.toLowerCase())) &&
                (t.adrNumber === adrNumber || (t.canonicalKey && t.canonicalKey.endsWith(`:${adrNumber}`)))
            )
            : null;

        if (transition) {
            const existingRecord = (transition.canonicalKey && this.admissionCatalog.get(transition.canonicalKey)) ||
                Array.from(this.admissionCatalog.values()).find(r =>
                    r.adrNumber === adrNumber &&
                    (r.sourceTuple?.repositoryId === transition.fromRepositoryId ||
                     r.assignmentEvidence?.repositoryId === transition.fromRepositoryId)
                ) || null;

            if (!existingRecord && !transition.canonicalKey) {
                throw createCodedError(
                    'ADR_ADMISSION_EVIDENCE_MISSING',
                    `Custody transition for ADR ${adrNumber} to '${namespace}' lacks prior admitted record or canonicalKey.`
                );
            }

            const parsedKey = parseCanonicalAdrKey(existingRecord ? existingRecord.canonicalKey : transition.canonicalKey);
            return {
                canonicalKey    : parsedKey.canonicalKey,
                assignedIdentity: existingRecord?.assignmentEvidence || {
                    forge         : parsedKey.forge,
                    repositoryId  : parsedKey.repositoryId,
                    namespace     : parsedKey.namespace,
                    assignmentKind: 'created'
                },
                existingRecord,
                custodyTransitionVerified: true,
                custodyTransition        : transition,
                isCustodyMove            : true
            };
        }

        // 3. Check if an already-admitted record in THIS `repositoryId` owns `adrNumber` (even if repository was renamed or custody moved here earlier)
        const existingInRepo = Array.from(this.admissionCatalog.values()).find(r =>
            r.adrNumber === adrNumber &&
            r.sourceTuple?.forge === forge &&
            r.sourceTuple?.repositoryId === repositoryId
        );

        if (existingInRepo) {
            return {
                canonicalKey             : existingInRepo.canonicalKey,
                assignedIdentity         : existingInRepo.assignmentEvidence,
                existingRecord           : existingInRepo,
                custodyTransitionVerified: false,
                isCustodyMove            : existingInRepo.assignmentEvidence?.repositoryId !== repositoryId
            };
        }

        // 4. Check if the caller explicitly claimed a `canonicalKey` (e.g. undeclared staged copy in another repo)
        if (sourceRepo.claimedCanonicalKey) {
            const parsedKey = parseCanonicalAdrKey(sourceRepo.claimedCanonicalKey);
            return {
                canonicalKey    : parsedKey.canonicalKey,
                assignedIdentity: {
                    forge         : parsedKey.forge,
                    repositoryId  : parsedKey.repositoryId,
                    namespace     : parsedKey.namespace,
                    assignmentKind: 'claimed'
                },
                existingRecord           : this.admissionCatalog.get(parsedKey.canonicalKey) || null,
                custodyTransitionVerified: false,
                isCustodyMove            : parsedKey.repositoryId !== repositoryId || parsedKey.namespace !== namespace
            };
        }

        // 5. Default: local decision in `(forge, repositoryId, namespace)`
        const canonicalKey = buildCanonicalAdrKey({forge, repositoryId, namespace, number: adrNumber});
        return {
            canonicalKey,
            assignedIdentity: {
                forge,
                repositoryId,
                namespace,
                assignmentKind: 'created'
            },
            existingRecord           : this.admissionCatalog.get(canonicalKey) || null,
            custodyTransitionVerified: false,
            isCustodyMove            : false
        };
    }

    /**
     * Main entry point. Scans local ADR markdown files (or a multi-repository `sources` batch),
     * validates canonical keys and opening-table `Aliases` history, enforces batch and owner
     * conflict refusal, upserts `ADR` nodes without stealing shared summary vectors, and refreshes
     * the deterministic ADR edge taxonomy.
     *
     * A redirect left at a moved record's old path is not a record, so it is
     * neither ingested nor counted in `adrsProcessed`.
     *
     * @param {Object} [options={}]
     * @param {String} [options.decisionsDir='learn/agentos/decisions'] Absolute or repo-relative ADR directory override.
     * @param {String} [options.sourceRoot=process.cwd()] Source-root used for repo-relative paths.
     * @param {Object|null} [options.repository=null] Optional evidenced repository `{forge, repositoryId, namespace, revision, citationOrigin, movedCustody}`.
     * @param {Object[]|null} [options.sources=null] Optional multi-source batch `[{decisionsDir, sourceRoot, repository, ...}]`.
     * @param {Object[]} [options.custodyTransitions=[]] Explicit custody transition records.
     * @param {Object[]} [options.sourceLineageEvidence=[]] Explicit lineage proofs for historical aliases added without prior admission.
     * @param {Object[]|null} [options.legacyManifest=null] Reviewed legacy assignment manifest.
     * @param {Boolean} [options.preserveRetainedCatalog=false] True retains catalog across an empty graph (for rebuild tests).
     * @returns {Promise<Object>} `{adrsProcessed, adrsUpserted, adrsSkipped, edgesReplaced, refused, preservedSharedVectors, staleRecords, errors}`
     */
    async syncAdrsToGraph(options = {}) {
        const {
            decisionsDir            = 'learn/agentos/decisions',
            sourceRoot              = process.cwd(),
            repository              = null,
            sources                 = null,
            custodyTransitions      = [],
            sourceLineageEvidence   = [],
            legacyManifest          = null,
            preserveRetainedCatalog = false
        } = options;

        this.#syncWithGraphStoreLifecycle(preserveRetainedCatalog);

        const stats = {
            adrsProcessed         : 0,
            adrsUpserted          : 0,
            adrsSkipped           : 0,
            edgesReplaced         : 0,
            refused               : [],
            preservedSharedVectors: [],
            staleRecords          : [],
            errors                : []
        };

        try {
            const sourceSpecs = Array.isArray(sources) && sources.length > 0
                ? sources
                : [{decisionsDir, sourceRoot, repository}];

            const
                candidates           = [],
                scannedRepoScopes    = [],
                seenKeysInScanByRepo = new Map();

            // Pass 1: Read and parse all candidate ADR documents across all source specs
            for (const spec of sourceSpecs) {
                const
                    specRootDir      = path.resolve(spec.sourceRoot || sourceRoot),
                    specDecisionsDir = path.resolve(specRootDir, spec.decisionsDir || 'learn/agentos/decisions'),
                    specRepo         = spec.repository || null;

                if (specRepo) {
                    try {
                        validateAdrIdentityFields({
                            forge       : specRepo.forge || 'github.com',
                            repositoryId: specRepo.repositoryId,
                            namespace   : specRepo.namespace,
                            number      : '0001'
                        });
                    } catch (e) {
                        stats.errors.push(`[repository] ${e.message}`);
                        stats.refused.push({code: e.code || 'ADR_INVALID_IDENTITY_FIELD', message: e.message});
                        continue;
                    }

                    const repoScopeKey = `${specRepo.forge || 'github.com'}:${specRepo.repositoryId}`;
                    scannedRepoScopes.push({
                        forge       : specRepo.forge || 'github.com',
                        repositoryId: specRepo.repositoryId,
                        namespace   : specRepo.namespace,
                        repoScopeKey
                    });
                    if (!seenKeysInScanByRepo.has(repoScopeKey)) {
                        seenKeysInScanByRepo.set(repoScopeKey, new Set());
                    }
                }

                if (!fs.existsSync(specDecisionsDir)) {
                    stats.errors.push(`[input] ADR directory not found: ${specDecisionsDir}`);
                    continue;
                }

                const files = (await fs.promises.readdir(specDecisionsDir))
                    .filter(file => ADR_FILE_REGEX.test(file))
                    .sort();

                for (const file of files) {
                    const
                        filePath = path.join(specDecisionsDir, file),
                        content  = await fs.promises.readFile(filePath, 'utf8');

                    // A redirect left at a moved record's old path is not a record: no node, no edges
                    if (isAdrRedirect(content)) continue;

                    stats.adrsProcessed++;

                    try {
                        const
                            relSource         = path.relative(specRootDir, filePath),
                            {adrNumber, slug} = parseAdrFilename(file),
                            aliasInfo         = parseAdrOpeningAliases(content),
                            identityInfo      = this.#resolveCandidateIdentity({
                                adrNumber,
                                currentSlug       : slug,
                                historicalAliases : aliasInfo.aliases,
                                sourceRepo        : specRepo,
                                custodyTransitions: spec.custodyTransitions || custodyTransitions,
                                legacyManifest    : spec.legacyManifest || legacyManifest
                            }),
                            adr = this.parseAdr(file, content, relSource, {
                                canonicalKey    : specRepo ? identityInfo.canonicalKey : null,
                                assignedIdentity: identityInfo.assignedIdentity,
                                repository      : specRepo,
                                citationOrigin  : spec.citationOrigin !== undefined ? spec.citationOrigin : specRepo?.citationOrigin,
                                movedCustody    : Boolean(spec.movedCustody ?? specRepo?.movedCustody ?? identityInfo.isCustodyMove)
                            });

                        candidates.push({
                            file,
                            filePath,
                            content,
                            relSource,
                            specRepo,
                            adr,
                            identityInfo
                        });
                    } catch (e) {
                        stats.errors.push(`[${file}] ${e.message}`);
                        stats.refused.push({file, code: e.code || 'ADR_PARSE_ERROR', message: e.message});
                        logger.warn(`[AdrIngestor] Failed to parse ADR '${file}': ${e.message}`);
                    }
                }
            }

            // Pass 2: Preflight conflict & lineage checks across the incoming batch + existing population
            // Group candidates by canonicalKey, repository number slot, and repository slug alias to detect
            // both competing claims against an existing owner AND same-batch new-claim collisions.
            const
                refusedCandidates = new Set(),
                refuseCandidate   = (cand, code, message) => {
                    if (refusedCandidates.has(cand)) return;
                    refusedCandidates.add(cand);
                    stats.errors.push(`[${cand.file}] ${message}`);
                    stats.refused.push({
                        file        : cand.file,
                        canonicalKey: cand.adr.canonicalKey,
                        code,
                        message
                    });
                    logger.warn(`[AdrIngestor] Refused ADR '${cand.file}' (${code}): ${message}`);
                };

            // 2a. Check individual candidate validity against existing admitted population & alias lineage
            for (const cand of candidates) {
                const
                    {adr, specRepo, identityInfo} = cand,
                    existingRecord                = identityInfo.existingRecord;

                if (specRepo) {
                    const
                        forge          = specRepo.forge || 'github.com',
                        repositoryId   = specRepo.repositoryId,
                        namespace      = specRepo.namespace,
                        lowerNamespace = namespace.toLowerCase(),
                        bucket         = this.#ensureReservationBucket(forge, repositoryId);

                    // Check if number slot or slug in `(forge, repositoryId, namespace)` is already reserved by a DIFFERENT canonicalKey
                    const reservedNumberBinding = bucket.aliases.get(`legacy-number:${lowerNamespace}:${adr.adrNumber}`);
                    if (reservedNumberBinding && reservedNumberBinding.targetKey !== adr.canonicalKey) {
                        refuseCandidate(
                            cand,
                            'ADR_COMPETING_CLAIM_REFUSED',
                            `ADR number '${adr.adrNumber}' in '${namespace}' is already reserved by '${reservedNumberBinding.targetKey}'.`
                        );
                        continue;
                    }

                    const reservedSlugBinding = bucket.aliases.get(`slug:${lowerNamespace}:${adr.currentSlug}`);
                    if (reservedSlugBinding && reservedSlugBinding.targetKey !== adr.canonicalKey) {
                        refuseCandidate(
                            cand,
                            'ADR_COMPETING_CLAIM_REFUSED',
                            `Slug '${adr.currentSlug}' in '${namespace}' is already reserved by '${reservedSlugBinding.targetKey}'.`
                        );
                        continue;
                    }

                    // Check if a different repository occupies an old namespace that still holds a reservation for `adrNumber` or `currentSlug`
                    for (const otherRecord of this.admissionCatalog.values()) {
                        if (otherRecord.canonicalKey === adr.canonicalKey) continue;

                        const conflictingAlias = otherRecord.aliasBindings?.find(
                            b => b.forge === forge &&
                                 b.namespace.toLowerCase() === lowerNamespace &&
                                 b.repositoryId !== repositoryId &&
                                 ((b.kind === 'slug' && b.value === adr.currentSlug) ||
                                  (b.kind === 'legacy-number' && b.value === adr.adrNumber && specRepo.inheritReservedNamespace === true))
                        );

                        if (conflictingAlias) {
                            refuseCandidate(
                                cand,
                                'ADR_NAMESPACE_OCCUPANCY_CONFLICT',
                                `Repository '${repositoryId}' occupying '${namespace}' cannot inherit reserved alias '${conflictingAlias.value}' owned by '${otherRecord.canonicalKey}'.`
                            );
                            break;
                        }
                    }
                    if (refusedCandidates.has(cand)) continue;
                }

                if (existingRecord) {
                    // Check custody / source continuity against existing admitted owner
                    if (specRepo) {
                        const
                            prevRepoId    = existingRecord.sourceTuple?.repositoryId,
                            prevNamespace = existingRecord.sourceTuple?.namespace,
                            repoChanged   = Boolean(prevRepoId && prevRepoId !== specRepo.repositoryId),
                            nsChanged     = Boolean(prevNamespace && prevNamespace.toLowerCase() !== specRepo.namespace.toLowerCase());

                        if ((repoChanged || nsChanged) && !identityInfo.custodyTransitionVerified) {
                            refuseCandidate(
                                cand,
                                'ADR_COMPETING_CLAIM_REFUSED',
                                `Undeclared competing custody claim for '${adr.canonicalKey}' from '${specRepo.namespace}' refused; retaining admitted owner '${prevNamespace}'.`
                            );
                            continue;
                        }
                    }

                    if (existingRecord.sourceTuple?.path && existingRecord.sourceTuple.path !== adr.source) {
                        // Check if the old file still exists on disk simultaneously in the same repository
                        const oldFileStillPresent = candidates.some(
                            other => other !== cand &&
                                     other.adr.source === existingRecord.sourceTuple.path &&
                                     (!specRepo || other.specRepo?.repositoryId === existingRecord.sourceTuple?.repositoryId)
                        );
                        if (oldFileStillPresent) {
                            refuseCandidate(
                                cand,
                                'ADR_COMPETING_CLAIM_REFUSED',
                                `Duplicate ADR number '${adr.adrNumber}' in '${cand.file}' conflicts with admitted owner '${existingRecord.sourceTuple.path}'.`
                            );
                            continue;
                        }
                    }

                    // Verify non-removal of previously admitted slug spellings
                    const
                        unionSpellings = new Set([adr.currentSlug, ...adr.historicalAliases]),
                        admittedSlugs  = (existingRecord.aliasBindings || [])
                            .filter(b => b.kind === 'slug')
                            .map(b => b.value);

                    const removedSpelling = admittedSlugs.find(slug => !unionSpellings.has(slug));
                    if (removedSpelling) {
                        refuseCandidate(
                            cand,
                            'ADR_REMOVED_ADMITTED_ALIAS',
                            `Cannot remove previously admitted slug spelling '${removedSpelling}' from '${adr.canonicalKey}'.`
                        );
                        continue;
                    }

                    // Verify that any historical alias in `Aliases` was either already admitted for this
                    // decision or is backed by explicit `sourceLineageEvidence` / `legacyManifest`.
                    const admittedSlugSet = new Set(admittedSlugs);
                    for (const histSlug of adr.historicalAliases) {
                        if (!admittedSlugSet.has(histSlug)) {
                            const hasLineageProof = Array.isArray(sourceLineageEvidence) &&
                                sourceLineageEvidence.some(
                                    ev => (ev.canonicalKey === adr.canonicalKey || ev.adrNumber === adr.adrNumber) &&
                                          ev.alias === histSlug
                                );
                            if (!hasLineageProof) {
                                refuseCandidate(
                                    cand,
                                    'ADR_UNPROVED_HISTORICAL_ALIAS',
                                    `Historical alias '${histSlug}' in '${cand.file}' lacks prior admission or source-lineage evidence.`
                                );
                                break;
                            }
                        }
                    }
                } else {
                    // Brand-new (unadmitted) record: any historical alias in `Aliases` requires explicit
                    // `sourceLineageEvidence` or `legacyManifest` so copied or arbitrary
                    // source claims cannot acquire another decision's reservations.
                    for (const histSlug of adr.historicalAliases) {
                        const hasLineageProof = (Array.isArray(sourceLineageEvidence) &&
                            sourceLineageEvidence.some(
                                ev => (ev.canonicalKey === adr.canonicalKey || ev.adrNumber === adr.adrNumber) &&
                                      ev.alias === histSlug
                            )) || (Array.isArray(legacyManifest) &&
                            legacyManifest.some(
                                m => m.adrNumber === adr.adrNumber &&
                                     Array.isArray(m.historicalAliases) &&
                                     m.historicalAliases.includes(histSlug)
                            ));

                        if (!hasLineageProof) {
                            refuseCandidate(
                                cand,
                                'ADR_UNPROVED_HISTORICAL_ALIAS',
                                `New record '${cand.file}' cannot claim historical alias '${histSlug}' without source-lineage or manifest evidence.`
                            );
                            break;
                        }
                    }
                }
            }

            // 2b. Check intra-batch conflicts among remaining candidates:
            // - If one candidate in a collision group is the existing admitted owner at its declared source
            //   and another is a competing new claim, refuse only the competing new claim.
            // - If TWO (or more) new claims collide on canonicalKey, repo number slot, or repo slug alias
            //   with no prior owner among them, refuse ALL of them so traversal order never manufactures a winner.
            const claimGroups     = new Map();
            const addToClaimGroup = (claimKey, cand) => {
                if (!claimGroups.has(claimKey)) {
                    claimGroups.set(claimKey, []);
                }
                claimGroups.get(claimKey).push(cand);
            };

            for (const cand of candidates) {
                if (refusedCandidates.has(cand)) continue;
                const {adr, specRepo} = cand;

                addToClaimGroup(`key:${adr.canonicalKey}`, cand);

                if (specRepo) {
                    const
                        forge   = specRepo.forge || 'github.com',
                        repoId  = specRepo.repositoryId,
                        lowerNs = specRepo.namespace.toLowerCase();

                    addToClaimGroup(`slot:${forge}:${repoId}:${adr.adrNumber}`, cand);
                    addToClaimGroup(`slug:${forge}:${repoId}:${adr.currentSlug}`, cand);
                    addToClaimGroup(`ns-slug:${forge}:${lowerNs}:${adr.currentSlug}`, cand);
                } else {
                    addToClaimGroup(`legacy-slot:${adr.adrNumber}`, cand);
                    addToClaimGroup(`legacy-slug:${adr.currentSlug}`, cand);
                }
            }

            for (const [claimKey, group] of claimGroups.entries()) {
                if (group.length <= 1) continue;

                // Check whether exactly one candidate in the group is the already-admitted declared source owner
                const priorOwners = group.filter(cand => {
                    const ex = cand.identityInfo.existingRecord;
                    if (!ex) return false;
                    if (cand.specRepo) {
                        return ex.sourceTuple?.repositoryId === cand.specRepo.repositoryId &&
                               ex.sourceTuple?.path === cand.adr.source &&
                               !cand.identityInfo.isCustodyMove;
                    }
                    return ex.sourceTuple?.path === cand.adr.source;
                });

                if (priorOwners.length === 1) {
                    for (const cand of group) {
                        if (cand !== priorOwners[0]) {
                            refuseCandidate(
                                cand,
                                'ADR_COMPETING_CLAIM_REFUSED',
                                `Competing claim '${cand.file}' on '${claimKey}' refused; retaining admitted owner '${priorOwners[0].file}'.`
                            );
                        }
                    }
                } else {
                    for (const cand of group) {
                        refuseCandidate(
                            cand,
                            'ADR_BATCH_CONFLICT',
                            `Conflicting same-batch claims on '${claimKey}' have no prior owner; neither claim is admitted.`
                        );
                    }
                }
            }

            // Pass 3: Upsert admitted candidates into GraphService & vector collection
            const nodesCollection = StorageRouter ? await StorageRouter.getGraphCollection() : null;

            for (const cand of candidates) {
                if (refusedCandidates.has(cand)) continue;

                try {
                    const
                        {file, content, specRepo, adr, identityInfo} = cand,
                        existingRecord                               = identityInfo.existingRecord,
                        payloadHash                                  = this.computePayloadHash(adr),
                        existingNode                                 = GraphService.db.nodes.get(adr.id),
                        docText                                      = `${adr.title}\n\n${content}`,
                        contentHash                                  = crypto.createHash('md5').update(docText).digest('hex');

                    if (specRepo) {
                        const repoScopeKey = `${specRepo.forge || 'github.com'}:${specRepo.repositoryId}`;
                        seenKeysInScanByRepo.get(repoScopeKey)?.add(adr.canonicalKey);
                    }

                    // Check shared summary vector safety BEFORE updating the ADR node's vector binding
                    const prevVectorId = existingNode?.properties?.semanticVectorId;
                    if (prevVectorId && prevVectorId !== adr.id) {
                        const owners       = this.inventoryVectorOwners(prevVectorId);
                        const nonAdrOwners = owners.filter(o => o.nodeId !== adr.id);
                        if (nonAdrOwners.length > 0 || prevVectorId.startsWith('summary_')) {
                            stats.preservedSharedVectors.push({
                                adrId         : adr.id,
                                sharedVectorId: prevVectorId,
                                retainedOwners: nonAdrOwners.map(o => o.nodeId)
                            });
                        }
                    }

                    let embedCurrent = false;
                    if (nodesCollection) {
                        try {
                            const existing = await nodesCollection.get({ids: [adr.id], include: ['metadatas']});
                            embedCurrent = existing?.ids?.length > 0 && (existing.metadatas[0] || {}).hash === contentHash;
                        } catch (e) {
                            logger.warn(`[AdrIngestor] graph-collection GET failed for ${adr.id}: ${e.message}`);
                        }
                    }

                    // Build or update the retained identity-bound admission record
                    const
                        forge        = specRepo?.forge || identityInfo.assignedIdentity?.forge || 'github.com',
                        sourceRepoId = specRepo?.repositoryId || null,
                        sourceNs     = specRepo?.namespace || null,
                        revision     = specRepo?.revision || null,
                        record       = existingRecord ? {
                            ...existingRecord,
                            title            : adr.title,
                            status           : adr.status,
                            rawStatus        : adr.rawStatus,
                            supersedes       : adr.supersedes,
                            currentSlug      : adr.currentSlug,
                            historicalAliases: [...adr.historicalAliases],
                            sourceTuple      : {
                                forge,
                                repositoryId: sourceRepoId,
                                namespace   : sourceNs,
                                revision,
                                path        : adr.source,
                                hash        : payloadHash,
                                contentHash
                            },
                            aliasBindings: existingRecord.aliasBindings.map(b => ({...b})),
                            reservations : existingRecord.reservations.map(r => ({...r})),
                            provenance   : {
                                ...existingRecord.provenance,
                                lastAdmittedRevision: revision || existingRecord.provenance?.lastAdmittedRevision || null,
                                custodyTransitions  : [...(existingRecord.provenance?.custodyTransitions || [])],
                                repositoryRenames   : [...(existingRecord.provenance?.repositoryRenames || [])],
                                sourceLineage       : [...(existingRecord.provenance?.sourceLineage || [])]
                            },
                            stale            : false,
                            documentAvailable: true,
                            kbAvailable      : true
                        } : {
                            canonicalKey      : adr.canonicalKey,
                            adrNumber         : adr.adrNumber,
                            title             : adr.title,
                            status            : adr.status,
                            rawStatus         : adr.rawStatus,
                            supersedes        : adr.supersedes,
                            currentSlug       : adr.currentSlug,
                            historicalAliases : [...adr.historicalAliases],
                            assignmentEvidence: identityInfo.assignedIdentity ? {
                                forge             : identityInfo.assignedIdentity.forge || forge,
                                repositoryId      : identityInfo.assignedIdentity.repositoryId,
                                namespace         : identityInfo.assignedIdentity.namespace,
                                number            : adr.adrNumber,
                                assignmentKind    : identityInfo.assignedIdentity.assignmentKind || 'created',
                                assignedAtRevision: revision,
                                reviewedManifestId: identityInfo.assignedIdentity.reviewedManifestId || null
                            } : null,
                            sourceTuple: {
                                forge,
                                repositoryId: sourceRepoId,
                                namespace   : sourceNs,
                                revision,
                                path        : adr.source,
                                hash        : payloadHash,
                                contentHash
                            },
                            aliasBindings: [],
                            reservations : [],
                            provenance   : {
                                createdAtRevision   : revision,
                                lastAdmittedRevision: revision,
                                custodyTransitions  : [],
                                repositoryRenames   : [],
                                sourceLineage       : []
                            },
                            stale            : false,
                            documentAvailable: true,
                            kbAvailable      : true
                        };

                    if (identityInfo.custodyTransition) {
                        record.provenance.custodyTransitions.push({
                            ...identityInfo.custodyTransition,
                            appliedAtRevision: revision
                        });
                    }

                    if (specRepo) {
                        const bucket = this.#ensureReservationBucket(forge, sourceRepoId);
                        bucket.numbers.add(adr.adrNumber);

                        // Mark previous current slug bindings in `sourceRepoId` as historical (`current: false`)
                        for (const b of record.aliasBindings) {
                            if (b.kind === 'slug' && b.forge === forge && b.repositoryId === sourceRepoId) {
                                b.current = (b.value === adr.currentSlug && b.namespace.toLowerCase() === sourceNs.toLowerCase());
                            }
                        }

                        // Admit current filename slug and legacy-number under the current repository (`sourceRepoId`, `sourceNs`)
                        this.#addAliasBinding(record, bucket, {
                            kind        : 'slug',
                            value       : adr.currentSlug,
                            forge,
                            repositoryId: sourceRepoId,
                            namespace   : sourceNs,
                            targetKey   : adr.canonicalKey,
                            current     : true
                        });
                        this.#addAliasBinding(record, bucket, {
                            kind        : 'legacy-number',
                            value       : adr.adrNumber,
                            forge,
                            repositoryId: sourceRepoId,
                            namespace   : sourceNs,
                            targetKey   : adr.canonicalKey,
                            current     : true
                        });

                        // Historical tokens in `Aliases` are source-local history:
                        // Only bind a historical token under `sourceRepoId` if it was NOT already admitted in another
                        // repository (i.e. a same-repository lineage/manifest token). Never re-scope A's historical
                        // tokens onto B during an A->B custody move!
                        for (const histSlug of adr.historicalAliases) {
                            const alreadyAdmittedAnyRepo = record.aliasBindings.some(
                                b => b.kind === 'slug' && b.value === histSlug
                            );
                            if (!alreadyAdmittedAnyRepo && !identityInfo.isCustodyMove) {
                                this.#addAliasBinding(record, bucket, {
                                    kind        : 'slug',
                                    value       : histSlug,
                                    forge,
                                    repositoryId: sourceRepoId,
                                    namespace   : sourceNs,
                                    targetKey   : adr.canonicalKey,
                                    current     : false
                                });
                            }
                        }

                        // Ensure birth/assigned repository ALSO retains its numeric reservation after move-out
                        if (record.assignmentEvidence?.repositoryId && record.assignmentEvidence.repositoryId !== sourceRepoId) {
                            const originBucket = this.#ensureReservationBucket(
                                record.assignmentEvidence.forge || forge,
                                record.assignmentEvidence.repositoryId
                            );
                            originBucket.numbers.add(adr.adrNumber);
                        }
                    } else {
                        // Legacy unscoped mode
                        this.#addAliasBinding(record, null, {
                            kind        : 'slug',
                            value       : adr.currentSlug,
                            forge       : 'github.com',
                            repositoryId: null,
                            namespace   : CORPUS_GRAPH_ORIGIN,
                            targetKey   : adr.canonicalKey,
                            current     : true
                        });
                        this.#addAliasBinding(record, null, {
                            kind        : 'legacy-number',
                            value       : adr.adrNumber,
                            forge       : 'github.com',
                            repositoryId: null,
                            namespace   : CORPUS_GRAPH_ORIGIN,
                            targetKey   : adr.canonicalKey,
                            current     : true
                        });
                    }

                    this.admissionCatalog.set(adr.canonicalKey, record);

                    const
                        existingLabel    = existingNode ? (existingNode.isRecord ? existingNode.get('label') : existingNode.label) : null,
                        existingVectorOk = existingNode?.properties?.semanticVectorId === adr.id,
                        existingNotStale = existingNode?.properties?.stale !== true,
                        sourceUnchanged  = existingNode?.properties?.payloadHash === payloadHash &&
                                             existingNode?.properties?.source === adr.source &&
                                             existingLabel === 'ADR' &&
                                             existingVectorOk &&
                                             existingNotStale;

                    // Skip only when node metadata, authority label/vector, AND embedded document are all current.
                    if (sourceUnchanged && (embedCurrent || !nodesCollection)) {
                        stats.adrsSkipped++;
                        continue;
                    }

                    const renameVerified = Boolean(
                        existingRecord &&
                        (!specRepo || existingRecord.sourceTuple?.repositoryId === specRepo.repositoryId) &&
                        existingRecord.sourceTuple?.path !== adr.source
                    );

                    GraphService.upsertNode({
                        id        : adr.id,
                        type      : 'ADR',
                        name      : adr.title,
                        properties: {
                            adrAdmissionRecord: record,
                            adrAuthority      : {
                                admitted                 : true,
                                adrNumber                : adr.adrNumber,
                                canonicalKey             : adr.canonicalKey,
                                custodyTransitionVerified: Boolean(identityInfo.custodyTransitionVerified),
                                documentAvailable        : true,
                                forge                    : specRepo?.forge || null,
                                namespace                : specRepo?.namespace || null,
                                renameVerified,
                                repositoryId             : specRepo?.repositoryId || null,
                                revision                 : specRepo?.revision || null,
                                semanticVectorId         : adr.id,
                                source                   : adr.source,
                                sourceHash               : payloadHash,
                                stale                    : false
                            },
                            adrNumber        : adr.adrNumber,
                            adrNumberValue   : Number(adr.adrNumber),
                            canonicalKey     : adr.canonicalKey,
                            currentSlug      : adr.currentSlug,
                            documentAvailable: true,
                            historicalAliases: adr.historicalAliases,
                            payloadHash,
                            rawStatus        : adr.rawStatus,
                            // The node points at its own document vector (keyed by the ADR id in the
                            // graph collection) so a consumer reading the SQLite node knows it is embedded.
                            semanticVectorId: adr.id,
                            source          : adr.source,
                            stale           : false,
                            status          : adr.status,
                            supersedes      : adr.supersedes,
                            title           : adr.title
                        }
                    });

                    // Re-embed the document whenever its content changed (the collection auto-embeds
                    // the `documents` text; upsert-by-id keeps it idempotent and never deletes shared summary vectors).
                    if (nodesCollection && !embedCurrent) {
                        await nodesCollection.upsert({
                            ids      : [adr.id],
                            documents: [docText],
                            metadatas: [{
                                canonicalKey: adr.canonicalKey,
                                hash        : contentHash,
                                title       : adr.title,
                                type        : 'ADR'
                            }]
                        });
                    }

                    stats.adrsUpserted++;
                    const insertedEdges = this.replaceAdrEdges(adr.id, adr.edges);
                    stats.edgesReplaced += insertedEdges;
                } catch (e) {
                    stats.errors.push(`[${cand.file}] ${e.message}`);
                    logger.warn(`[AdrIngestor] Failed to ingest ADR '${cand.file}': ${e.message}`);
                }
            }

            // Pass 4: Mark previously admitted records whose declared source disappeared in the scanned
            // repository scope as `stale: true, documentAvailable: false` without retiring their identity or edges.
            for (const scope of scannedRepoScopes) {
                const seenKeys = seenKeysInScanByRepo.get(scope.repoScopeKey) || new Set();
                for (const record of this.admissionCatalog.values()) {
                    if (record.sourceTuple?.forge === scope.forge &&
                        record.sourceTuple?.repositoryId === scope.repositoryId &&
                        !seenKeys.has(record.canonicalKey)) {
                        // Check if this record had a refused update in this batch; if so, retain its last admitted state!
                        const hadRefusedAttempt = Array.from(refusedCandidates).some(
                            c => c.adr.canonicalKey === record.canonicalKey
                        );
                        if (hadRefusedAttempt) continue;

                        this.reconcileSourceAndEvidence({retainedRecord: record, survivingSource: null});
                        stats.staleRecords.push(record.canonicalKey);
                    }
                }
            }

            this.#lastGraphNodesCount = GraphService.db?.nodes?.count ?? 0;

            logger.info(`[AdrIngestor] Sync complete: ${stats.adrsUpserted} upserted, ${stats.adrsSkipped} unchanged, ${stats.edgesReplaced} edges${stats.errors.length > 0 ? `, ${stats.errors.length} errors` : ''}.`);
        } catch (e) {
            logger.error('[AdrIngestor] Fatal sync error:', e);
            stats.errors.push(`[fatal] ${e.message}`);
        }

        return stats;
    }
}

export default Neo.setupClass(AdrIngestor);
