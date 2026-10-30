import {Buffer}                                               from 'node:buffer';
import {execFileSync}                                         from 'node:child_process';
import {createHash}                                           from 'node:crypto';
import fs                                                     from 'node:fs';
import path                                                   from 'node:path';
import {createBusinessGoalId, validateBusinessGoalProperties} from '../../graph/businessSchema.mjs';

/**
 * @summary The business focus block: the dashboard's first screen read as a bounded file, kept as the
 * first populated `BUSINESS_GOAL` node, and rendered as the handoff's `## Business focus` section.
 *
 * A fresh seat has no cheap, authoritative answer to "what does the business need from me this week";
 * the long answer is private and far too large for a boot read. The lead keeps the dashboard's first
 * screen under a byte cap; this module reads that screen where the synthesizer runs, binds it to the
 * file's bytes and the mirror's commit, and renders it so a seat can request it by slug. Three rules:
 *
 * 1. **Configured, never assumed.** The source path is a resolved config leaf
 *    (`businessFocusSourcePath`); an empty leaf means the deployment declares no business source and the
 *    synthesizer writes no section and no node. Only a configured path that cannot be read renders
 *    `unknown` with its reason.
 * 2. **Nothing is truncated.** A block over the cap leaves the previous in-cap node in place, flagged
 *    `stale: over-cap` with the byte count and the source, and the section renders that previous block.
 *    A live instruction cut mid-sentence is worse than none.
 * 3. **One writer.** The block is derived from the file; peers send state lines to the lead, never edits
 *    here. The node is `publicFlag: false` and never enters a public projection.
 *
 * The reader takes the path as a scalar and reads no environment, so a spec exercises it on a temp file
 * without touching the config tree.
 *
 * @module Neo.ai.services.graph.businessFocusSection
 */

/**
 * The handoff heading; `sandmanHandoffSections` maps it to the `businessFocus` slug.
 * @type {String}
 */
export const BUSINESS_FOCUS_HEADING = '## Business focus';

/**
 * The section slug a seat requests from `get_sandman_handoff`.
 * @type {String}
 */
export const BUSINESS_FOCUS_SLUG = 'businessFocus';

/**
 * The goal's stable operator slug; the node id derives from it.
 * @type {String}
 */
export const BUSINESS_FOCUS_GOAL_SLUG = 'focus';

/**
 * The `BUSINESS_GOAL` node id (`business-goal-focus`), minted through the schema so it can never drift.
 * @type {String}
 */
export const BUSINESS_FOCUS_NODE_ID = createBusinessGoalId(BUSINESS_FOCUS_GOAL_SLUG);

/**
 * The cap on the block's UTF-8 bytes (about 300 tokens): the dashboard's own first-screen rule.
 * @type {Number}
 */
export const BUSINESS_FOCUS_MAX_BYTES = 1200;

/**
 * The marker line that closes the first screen in the dashboard. Without it the whole file is the block,
 * which an over-cap file then reports honestly as `stale: over-cap`.
 * @type {String}
 */
export const BUSINESS_FOCUS_END_MARKER = '<!-- focus:end -->';

/**
 * The cap on the rendered section (the block plus its heading and status lines), the AC-4 budget of
 * under 400 tokens.
 * @type {Number}
 */
export const BUSINESS_FOCUS_SECTION_MAX_BYTES = 1600;

/**
 * @summary Hex sha256 of a UTF-8 string.
 * @param {String} text
 * @returns {String}
 */
function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @summary Resolves the commit of the repository that holds the source file, or `null` when the file is
 * not inside a git checkout or git is unavailable. Pure apart from the injected runner.
 * @param {String} sourcePath
 * @param {Object} [options={}]
 * @param {Function} [options.execFile=execFileSync]
 * @returns {String|null}
 */
export function resolveSourceCommit(sourcePath, {execFile = execFileSync} = {}) {
    try {
        return String(execFile('git', ['-C', path.dirname(sourcePath), 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio   : ['ignore', 'pipe', 'ignore']
        })).trim() || null;
    } catch {
        return null;
    }
}

/**
 * @summary Reads the focus block from the dashboard file: the text before the end marker (the whole file
 * when the marker is absent), with its byte count, the file's sha256 and the mirror's commit.
 *
 * Statuses: `unconfigured` (empty path), `unreadable` (configured path that cannot be read),
 * `over-cap` (the block exceeds `maxBytes`; nothing is truncated) and `ok`.
 *
 * @param {Object} options
 * @param {String} options.sourcePath The resolved config leaf, passed as a scalar.
 * @param {Number} [options.maxBytes=BUSINESS_FOCUS_MAX_BYTES]
 * @param {String} [options.marker=BUSINESS_FOCUS_END_MARKER]
 * @param {Function} [options.readFile=fs.readFileSync] Injected for specs.
 * @param {Function} [options.resolveCommit=resolveSourceCommit] Injected for specs.
 * @returns {{status: String, sourcePath: String, bytes?: Number, maxBytes?: Number, block?: String, sha256?: String, sourceCommit?: String|null, markerFound?: Boolean, reason?: String}}
 */
export function readBusinessFocusBlock({
    sourcePath,
    maxBytes      = BUSINESS_FOCUS_MAX_BYTES,
    marker        = BUSINESS_FOCUS_END_MARKER,
    readFile      = fs.readFileSync,
    resolveCommit = resolveSourceCommit
}) {
    if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
        return {status: 'unconfigured', sourcePath: ''};
    }

    let text;

    try {
        text = String(readFile(sourcePath, 'utf8'));
    } catch (error) {
        return {status: 'unreadable', sourcePath, reason: error.code || error.message};
    }

    const markerIndex = text.indexOf(marker),
          markerFound = markerIndex >= 0,
          block       = (markerFound ? text.slice(0, markerIndex) : text).trimEnd() + '\n',
          bytes       = Buffer.byteLength(block, 'utf8');

    return {
        status      : bytes > maxBytes ? 'over-cap' : 'ok',
        sourcePath,
        bytes,
        maxBytes,
        block,
        sha256      : sha256(text),
        sourceCommit: resolveCommit(sourcePath),
        markerFound
    };
}

/**
 * @summary Demotes every Markdown heading in the block to a bold line, so the block's own `# ` and `## `
 * lines never open a second handoff section when `sandmanHandoffSections` splits on `## `.
 * @param {String} block
 * @returns {String}
 */
export function demoteHeadings(block) {
    return String(block ?? '').replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '**$1**');
}

/**
 * @summary Reads a graph node's properties whether it arrives as a plain object, a projected node or a
 * Neo record.
 * @param {Object|null} node
 * @returns {Object|null}
 */
export function readNodeProperties(node) {
    if (!node) {
        return null;
    }

    const properties = typeof node.get === 'function' ? node.get('properties') : node.properties;

    return properties && typeof properties === 'object' ? properties : null;
}

/**
 * @summary Builds the `business-goal-focus` node from an in-cap read, validated against the business
 * schema's five-field contract. The claim is `derived`: the block is the lead's statement, derived from
 * the file's bytes, and its falsifier is the hash at the commit.
 * @param {Object} options
 * @param {String} options.block
 * @param {Number} options.bytes
 * @param {String} options.sha256
 * @param {String|null} options.sourceCommit
 * @param {String} options.sourcePath
 * @param {String} options.asOf ISO-8601 capture time.
 * @returns {{id: String, type: String, name: String, description: String, properties: Object}}
 */
export function buildBusinessFocusNode({block, bytes, sha256: digest, sourceCommit, sourcePath, asOf}) {
    const source     = path.basename(sourcePath),
          properties = {
              slug              : BUSINESS_FOCUS_GOAL_SLUG,
              lifecycle         : 'active',
              claimClass        : 'derived',
              falsifyingQuery   : `sha256(${source}) at ${sourceCommit ?? 'uncommitted'} === ${digest}`,
              windowSemantics   : 'week:iso',
              confoundDisclaimer: "the lead's statement of the week's focus, derived from the dashboard's first screen; it says what the business asks of the seats, not what was delivered",
              publicFlag        : false,
              block,
              bytes,
              sha256            : digest,
              sourceCommit      : sourceCommit ?? null,
              sourcePath,
              asOf
          },
          {valid, errors} = validateBusinessGoalProperties(properties);

    if (!valid) {
        throw new Error(`businessFocusSection: the business-goal-focus node is invalid — ${errors.join('; ')}`);
    }

    return {
        id         : BUSINESS_FOCUS_NODE_ID,
        type       : 'BUSINESS_GOAL',
        name       : 'Business focus',
        description: `The week's business focus block, derived from ${source} (${bytes} bytes, ${digest.slice(0, 12)})`,
        properties
    };
}

/**
 * @summary One short source label: the file's basename and the commit (or the hash) it was read at.
 * @param {Object} read
 * @returns {String}
 */
function sourceLabel({sourcePath, sourceCommit, sha256: digest}) {
    const base = path.basename(sourcePath || 'source');

    return `${base} @ ${sourceCommit ? sourceCommit.slice(0, 12) : digest ? digest.slice(0, 12) : 'unknown'}`;
}

/**
 * @summary Renders the `## Business focus` section from a read and, for an over-cap read, the previous
 * in-cap node. Returns `''` for an unconfigured read so the caller appends nothing.
 * @param {Object} options
 * @param {Object} options.read The result of `readBusinessFocusBlock`.
 * @param {Object|null} [options.previousNode=null] The stored `business-goal-focus` node, if any.
 * @param {String} options.asOf ISO-8601 capture time.
 * @returns {String}
 */
export function renderBusinessFocusSection({read, previousNode = null, asOf}) {
    if (!read || read.status === 'unconfigured') {
        return '';
    }

    const lines = [BUSINESS_FOCUS_HEADING, ''];

    if (read.status === 'ok') {
        lines.push(`- as of: ${asOf} · source: ${sourceLabel(read)} · ${read.bytes} B`, '', demoteHeadings(read.block).trimEnd());
    } else if (read.status === 'over-cap') {
        const previous = readNodeProperties(previousNode);

        if (previous?.block) {
            lines.push(
                `- status: stale: over-cap (${read.bytes} B at ${sourceLabel(read)}; cap ${read.maxBytes} B) · showing the previous in-cap block (${previous.bytes} B at ${sourceLabel(previous)}, as of ${previous.asOf})`,
                '',
                demoteHeadings(previous.block).trimEnd()
            );
        } else {
            lines.push(`- status: unknown (over-cap: ${read.bytes} B at ${sourceLabel(read)}; cap ${read.maxBytes} B; no prior in-cap block)`);
        }
    } else {
        lines.push(`- status: unknown (source ${read.sourcePath} unreadable: ${read.reason})`);
    }

    return lines.join('\n') + '\n';
}

/**
 * @summary Reads, decides and renders in one call for the synthesizer: the node to upsert (only on an
 * in-cap read) and the section to append (empty when unconfigured).
 * @param {Object} options
 * @param {String} options.sourcePath The resolved `businessFocusSourcePath` leaf.
 * @param {Object|null} [options.previousNode=null]
 * @param {Date|String} [options.now=new Date()]
 * @param {Function} [options.readBlock=readBusinessFocusBlock] Injected for specs.
 * @returns {{status: String, section: String, node: Object|null, read: Object}}
 */
export function resolveBusinessFocus({sourcePath, previousNode = null, now = new Date(), readBlock = readBusinessFocusBlock}) {
    const asOf = (now instanceof Date ? now : new Date(now)).toISOString(),
          read = readBlock({sourcePath});

    if (read.status === 'unconfigured') {
        return {status: 'unconfigured', section: '', node: null, read};
    }

    return {
        status : read.status,
        section: renderBusinessFocusSection({read, previousNode, asOf}),
        node   : read.status === 'ok' ? buildBusinessFocusNode({...read, asOf}) : null,
        read
    };
}
