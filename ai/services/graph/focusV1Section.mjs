import {Buffer}               from 'node:buffer';
import {execFile}             from 'node:child_process';
import {promisify}            from 'node:util';
import {validateMergeReady}   from '../../scripts/lifecycle/validateMergeReady.mjs';
import {
    mergeHoldToken,
    resolveMergeHold
} from '../github-workflow/shared/mergeHoldTokens.mjs';
import {
    resolveCrossFamilyVerdict
} from './agentFamilyResolution.mjs';
import {
    formatGoldenPathCapturedAt
} from './goldenPathTimestamp.mjs';

const execFileAsync = promisify(execFile);

/**
 * @module ai/services/graph/focusV1Section
 * @summary Pure builder, host-edge reader seam and default `gh` block readers, private-to-public
 * projection guard, and Markdown renderer for the Sandman handoff's `## Focus (v1)` section.
 *
 * When supplied by the host-edge reader or a dated projection, the section answers two
 * session-start questions in one bounded read (`<= 2,000` UTF-8 bytes): *where are we for v1, what
 * is missing* and *which views still need love*, alongside *reach and outbound* and *what waits
 * for the operator's word*. When a pass supplies neither a reader nor inputs (or runs on the cloud
 * plane without the host edge), each block renders `unknown` with its explicit reason.
 *
 * Load-bearing invariants:
 * 1. **Steward-owned words raw (no second status authority):** `Row state:` lines on the Fleet
 *    Manager v1 epics are copied verbatim (truncated at any `plan:` tail) and tallied by their
 *    exact state word (`passed`, `ready`, `failed`, `unknown`); `ready` is never promoted to
 *    `passed`.
 * 2. **Installed-over-source view receipt governance:** Per view key (`FOCUS_V1_VIEW_KEYS`), an
 *    `installed` receipt is replaced only by a newer `installed` receipt; a newer `source` or
 *    `fixture` receipt renders beneath it as a non-resolving note (`does not resolve installed
 *    line`). A canonical `none observed` governing line counts as `swept`, never `needing love`.
 * 3. **Schema-side `publicFlag` redaction:** Private business goals, targets, revenue, and
 *    client specifics never cross into the public projection. Any row lacking strict boolean
 *    `publicFlag: true` (or any `BUSINESS_GOAL` node) is excluded before rendering.
 * 4. **Host-edge boundary:** GitHub inputs (`ROADMAP.md` rows, views epic
 *    receipts, traffic/stars/forks, approved open PRs) arrive through the host-edge reader or an
 *    admitted dated projection; on the cloud plane without the host edge, each block renders
 *    `unknown` with its explicit boundary reason rather than fabricating empty state.
 */

/**
 * Canonical level-two Markdown heading for the Focus (v1) handoff section.
 * Maps to slug `'focus'` in `sandmanHandoffSections.headingToSectionSlug`.
 * @type {String}
 */
export const FOCUS_V1_HEADING = '## Focus (v1)';

/**
 * Producer version marker embedded at the top of `## Focus (v1)`.
 * @type {String}
 */
export const FOCUS_V1_MARKER = 'focus.v1';

/**
 * Hard UTF-8 byte ceiling on the rendered `## Focus (v1)` section so session-start handoff reads
 * stay compact (`<= 2,000` bytes).
 * @type {Number}
 */
export const FOCUS_V1_MAX_BYTES = 2000;

/**
 * Stable dock-item view keys for Fleet Manager v1.
 * @type {ReadonlyArray<String>}
 */
export const FOCUS_V1_DOCK_VIEW_KEYS = Object.freeze([
    'fleet',
    'stream',
    'memories',
    'operator',
    'tasks',
    'catchUp',
    'goldenPath',
    'detail'
]);

/**
 * Stable route view keys for Fleet Manager v1.
 * @type {ReadonlyArray<String>}
 */
export const FOCUS_V1_ROUTE_VIEW_KEYS = Object.freeze([
    'home',
    'observatory',
    'system',
    'accounts',
    'setup',
    'chat'
]);

/**
 * Complete ordered catalog of Fleet Manager v1 view keys (`8` dock panes + `6` route views).
 * @type {ReadonlyArray<String>}
 */
export const FOCUS_V1_VIEW_KEYS = Object.freeze([
    ...FOCUS_V1_DOCK_VIEW_KEYS,
    ...FOCUS_V1_ROUTE_VIEW_KEYS
]);

/**
 * Plane-neutral default reason emitted when a Focus (v1) block has neither a host-edge reader nor
 * an admitted dated projection supplied for the current pass.
 * @type {String}
 */
export const FOCUS_V1_READER_ABSENT_REASON =
    'no Focus (v1) host-edge reader or admitted dated projection supplied for this pass';

/**
 * Cloud-plane boundary reason emitted when GitHub-sourced blocks are evaluated on a cloud-plane
 * pass without a host-edge reader or admitted dated projection.
 * @type {String}
 */
export const CLOUD_PLANE_HOST_EDGE_ABSENT_REASON =
    'GitHub focus inputs require a host-edge reader or admitted dated projection; this cloud-plane pass has neither';

/**
 * Default reason emitted when no public-flagged reach or outbound ledger rows are supplied.
 * @type {String}
 */
export const PRIVATE_LEDGER_ABSENT_REASON =
    'no public-flagged reach or outbound ledger rows supplied';

/**
 * Private goal/target property names that must never survive into a public Focus (v1) projection
 * even if a caller attaches them to a row.
 * @type {ReadonlyArray<String>}
 */
const FORBIDDEN_PRIVATE_FIELDS = Object.freeze([
    'goal',
    'goals',
    'target',
    'targets',
    'privateTarget',
    'weeklyTarget',
    'revenue',
    'price',
    'pricing',
    'client',
    'clientName',
    'customer'
]);

/**
 * @summary Typed error signaling that a Focus (v1) GitHub source is intentionally out of reach on
 * the current deployment plane (mirrors `CensusSourceUnavailable` in `laneLandscapeCensusSource.mjs`).
 */
export class FocusSourceUnavailable extends Error {
    /**
     * @param {String} reason Deployment boundary explanation.
     */
    constructor(reason) {
        super(reason);
        this.name        = 'FocusSourceUnavailable';
        this.unavailable = true;
    }
}

/**
 * @summary Builds a refusing host-edge reader function that throws `FocusSourceUnavailable(reason)`
 * so cloud-plane callers record `unknown` with the deployment boundary reason rather than a fault
 * or a fabricated zero/empty state.
 * @param {String} [reason=CLOUD_PLANE_HOST_EDGE_ABSENT_REASON] Non-empty boundary reason.
 * @returns {Function} Async reader function that refuses with `FocusSourceUnavailable`.
 */
export function makeRefusingFocusV1Reader(reason = CLOUD_PLANE_HOST_EDGE_ABSENT_REASON) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new TypeError('makeRefusingFocusV1Reader: a non-empty `reason` string is required');
    }

    const normalizedReason = reason.trim();

    return async () => {
        throw new FocusSourceUnavailable(normalizedReason);
    };
}

/**
 * @summary Redacts credential tokens or bearer headers from reader failure messages before they
 * enter any handoff reason string.
 * @param {*} error Error or message value.
 * @returns {String} Sanitized single-line reason.
 */
function sanitizeReaderReason(error) {
    const raw = typeof error?.message === 'string'
        ? error.message
        : typeof error === 'string'
            ? error
            : 'host-edge read failed';

    return raw
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, 160);
}

/**
 * @summary Parses a single `Row state:` line (or full Epic issue Markdown body) into its verbatim
 * truncated line and raw steward state word, never promoting `ready` to `passed`.
 *
 * Truncates any trailing `plan:` clause (`· plan: ...` or `plan: ...`) per `/overview` §3 while
 * preserving the steward's exact words and state token.
 *
 * @param {String} text Raw Epic body or `Row state:` line.
 * @returns {{found: Boolean, rawLine: (String|null), stateWord: String}}
 */
export function parseRowStateLine(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return {found: false, rawLine: null, stateWord: 'unknown'};
    }

    const match = /(?:^|\n)\s*(?:\*\*Row state:\*\*|Row state:)\s*([^\r\n]+)/i.exec(text);

    if (!match) {
        return {found: false, rawLine: null, stateWord: 'unknown'};
    }

    const withoutPlan = match[1]
        .replace(/\s*(?:·|—|-|,|;)?\s*\bplan:\s*.*$/i, '')
        .trim();

    if (!withoutPlan) {
        return {found: false, rawLine: null, stateWord: 'unknown'};
    }

    const wordMatch = /^`?([a-zA-Z0-9_-]+)`?/.exec(withoutPlan);
    const stateWord = wordMatch ? wordMatch[1].toLowerCase() : 'unknown';

    return {
        found  : true,
        rawLine: `Row state: ${withoutPlan}`,
        stateWord
    };
}

/**
 * @summary Tallies the five Fleet Manager v1 rows from raw `Row state:` words without ever
 * promoting `ready` to `passed`.
 * @param {Object[]} rows Array of row descriptors (`{row, epic, rawLine?, body?, stateWord?}`).
 * @param {Number} [expectedRows=5] Total v1 rows expected on the ROADMAP table.
 * @returns {{total: Number, passed: Number, ready: Number, failed: Number, unknown: Number, missing: String[], normalizedRows: Object[]}}
 */
export function summarizeV1Rows(rows = [], expectedRows = 5) {
    const inputRows      = Array.isArray(rows) ? rows : [];
    const normalizedRows = [];

    for (let i = 0; i < Math.max(expectedRows, inputRows.length); i++) {
        const entry     = inputRows[i] ?? {row: i + 1};
        const rowNumber = entry.row ?? (i + 1);
        const epicRef   = entry.epic != null ? String(entry.epic).replace(/^#?/, '#') : null;
        const parsed    = entry.rawLine || entry.body
            ? parseRowStateLine(entry.rawLine ?? entry.body)
            : {
                found  : typeof entry.stateWord === 'string' && entry.stateWord.toLowerCase() !== 'unknown',
                rawLine: typeof entry.stateWord === 'string' && entry.stateWord.toLowerCase() !== 'unknown'
                    ? `Row state: ${entry.stateWord}`
                    : null,
                stateWord: typeof entry.stateWord === 'string' ? entry.stateWord.toLowerCase() : 'unknown'
            };

        const stateWord = parsed.found ? parsed.stateWord : 'unknown';
        const rawLine   = parsed.found
            ? parsed.rawLine
            : `unknown (${entry.reason || (epicRef ? `no Row state line on ${epicRef}` : 'no Row state line')})`;

        normalizedRows.push({
            row : rowNumber,
            epic: epicRef,
            rawLine,
            stateWord
        });
    }

    let   passed  = 0;
    let   ready   = 0;
    let   failed  = 0;
    let   unknown = 0;
    const missing = [];

    for (const row of normalizedRows) {
        if (row.stateWord === 'passed') {
            passed++;
        } else {
            if (row.stateWord === 'ready') {
                ready++;
            } else if (row.stateWord === 'failed') {
                failed++;
            } else if (row.stateWord === 'unknown') {
                unknown++;
            }
            missing.push(`r${row.row}:${row.stateWord}`);
        }
    }

    return {
        total  : normalizedRows.length,
        passed,
        ready,
        failed,
        unknown,
        missing,
        normalizedRows
    };
}

/**
 * @summary Determines whether a view receipt's `needsLove` text represents a clean sweep (`none
 * observed`) rather than an affirmative defect finding.
 * @param {String} needsLove Raw `needs love:` text.
 * @returns {Boolean} `true` when clean (`none observed` / `none`).
 */
export function isCleanNeedsLove(needsLove) {
    if (typeof needsLove !== 'string') return false;
    const normalized = needsLove.trim().toLowerCase().replace(/[.`]+$/g, '');
    return normalized === 'none observed' || normalized === 'none';
}

/**
 * @summary Normalizes a view receipt's build class into `'installed'` or `'source'`.
 * @param {String} [buildClass] Raw build class descriptor.
 * @returns {'installed'|'source'}
 */
function normalizeBuildClass(buildClass) {
    const raw = String(buildClass ?? '').trim().replace(/^`+|`+$/g, '').trim().toLowerCase();
    return raw.startsWith('installed') ? 'installed' : 'source';
}

/**
 * @summary Evaluates view receipts across declared view keys under the installed-over-source
 * governing rule (`overview-read.md` §3 & §3a).
 *
 * Rules:
 * - An `installed` receipt is replaced ONLY by a newer `installed` receipt.
 * - A newer `source` receipt never replaces or resolves an `installed` receipt; it is attached as
 *   `newerSourceLine` beneath the governing installed line.
 * - A clean governing receipt (`none observed`) raises `swept`, never `needingLove`.
 * - Keys with no receipts are listed in `unassessed`.
 *
 * @param {Object[]} receipts Array of receipt objects (`{viewKey, needsLove, buildClass, candidateSha?, profile?, observedAt?, seat?, openDesignLeaves?, sourceUrl?}`).
 * @param {Object} [options]
 * @param {String[]} [options.viewKeys=FOCUS_V1_VIEW_KEYS] Declared view keys to evaluate.
 * @returns {{swept: Number, needingLove: Number, unassessed: String[], byKey: Object<String, Object>}}
 */
export function evaluateViewReceipts(receipts = [], {viewKeys = FOCUS_V1_VIEW_KEYS} = {}) {
    const list     = Array.isArray(receipts) ? receipts : [];
    const grouped  = new Map();
    const allKeys  = [...new Set([...viewKeys, ...list.map(r => r?.viewKey || r?.key).filter(Boolean)])];

    list.forEach((receipt, index) => {
        const key = receipt?.viewKey || receipt?.key;
        if (typeof key !== 'string' || !key.trim()) return;

        const normalizedKey = key.trim();
        const buildClass    = normalizeBuildClass(receipt.buildClass ?? receipt.build);
        const parsedTime    = Date.parse(receipt.observedAt ?? receipt.asOf ?? '');
        const orderKey      = Number.isFinite(parsedTime) ? parsedTime : index;

        if (!grouped.has(normalizedKey)) {
            grouped.set(normalizedKey, []);
        }

        grouped.get(normalizedKey).push({
            viewKey         : normalizedKey,
            needsLove       : String(receipt.needsLove ?? 'unknown').trim(),
            buildClass,
            buildLabel      : receipt.buildClass || buildClass,
            profile         : receipt.profile || 'default',
            observedAt      : receipt.observedAt || receipt.asOf || 'unknown',
            seat            : receipt.seat || null,
            openDesignLeaves: Array.isArray(receipt.openDesignLeaves) ? receipt.openDesignLeaves : [],
            sourceUrl       : receipt.sourceUrl || null,
            orderKey,
            index
        });
    });

    const byKey      = {};
    const unassessed = [];
    let   swept      = 0;
    let   needingLove = 0;

    for (const key of allKeys) {
        const entries = grouped.get(key) || [];

        if (entries.length === 0) {
            unassessed.push(key);
            byKey[key] = {status: 'unassessed', governing: null, newerSourceLine: null};
            continue;
        }

        const sorted = [...entries].sort((a, b) => a.orderKey !== b.orderKey ? a.orderKey - b.orderKey : a.index - b.index);
        const installedEntries = sorted.filter(e => e.buildClass === 'installed');
        const sourceEntries    = sorted.filter(e => e.buildClass !== 'installed');

        const governing = installedEntries.length > 0
            ? installedEntries[installedEntries.length - 1]
            : sourceEntries[sourceEntries.length - 1];

        let newerSourceLine = null;
        if (installedEntries.length > 0 && sourceEntries.length > 0) {
            const latestSource = sourceEntries[sourceEntries.length - 1];
            if (latestSource.orderKey > governing.orderKey ||
                (latestSource.orderKey === governing.orderKey && latestSource.index > governing.index)) {
                newerSourceLine = latestSource;
            }
        }

        swept++;
        const clean = isCleanNeedsLove(governing.needsLove);
        if (!clean) {
            needingLove++;
        }

        byKey[key] = {
            status: clean ? 'clean' : 'needs-love',
            governing,
            newerSourceLine
        };
    }

    return {
        swept,
        needingLove,
        unassessed,
        byKey
    };
}

/**
 * @summary Projects business/outbound metric rows through the schema-side `publicFlag` boundary so private
 * goals, targets, revenue, or unflagged rows never enter `## Focus (v1)`.
 *
 * Fail-closed rules:
 * 1. Only plain objects with strict boolean `publicFlag === true` (top-level or in `properties`)
 *    are admitted.
 * 2. Any `BUSINESS_GOAL` node (`type === 'BUSINESS_GOAL'` or `id` starting with `'business-goal-'`)
 *    is unconditionally excluded (mechanism & metric categories public; goals & targets private).
 * 3. Any forbidden private field (`goal`, `target`, `revenue`, `client`, `price`, etc.) is stripped
 *    from the projected record, and any text value containing a private marker is omitted.
 * 4. When `allowlist` is provided (array or comma-separated string), metric rows with a `category` /
 *    `metricName` outside the allowlist are excluded.
 *
 * @param {Object[]} rows Candidate metric or outbound ledger rows.
 * @param {Object} [options]
 * @param {String|String[]} [options.allowlist] Optional public category allowlist.
 * @returns {Object[]} Sanitized public-only rows.
 */
export function projectPublicBusinessRows(rows = [], {allowlist} = {}) {
    if (!Array.isArray(rows)) return [];

    const allowedSet = allowlist != null
        ? new Set(
            (Array.isArray(allowlist) ? allowlist : String(allowlist).split(','))
                .map(item => String(item).trim())
                .filter(Boolean)
        )
        : null;

    const projected = [];

    for (const raw of rows) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

        const props      = raw.properties && typeof raw.properties === 'object' ? raw.properties : raw;
        const nodeType   = String(raw.type ?? props.type ?? '').toUpperCase();
        const nodeId     = String(raw.id ?? props.id ?? '');
        const publicFlag = 'publicFlag' in raw ? raw.publicFlag : props.publicFlag;

        if (nodeType === 'BUSINESS_GOAL' || nodeId.startsWith('business-goal-')) {
            continue;
        }

        if (publicFlag !== true || props.publicFlag === false) {
            continue;
        }

        const category = String(props.metricName ?? props.category ?? props.channel ?? '').trim();
        if (!category) continue;

        if (allowedSet && allowedSet.size > 0 && !allowedSet.has(category)) {
            continue;
        }

        const cleanRow = {
            category,
            publicFlag: true
        };

        if (typeof props.value === 'number' && Number.isFinite(props.value)) {
            cleanRow.value = props.value;
        }
        if (typeof props.delta === 'number' && Number.isFinite(props.delta)) {
            cleanRow.delta = props.delta;
        }
        if (typeof props.count === 'number' && Number.isFinite(props.count)) {
            cleanRow.count = props.count;
        }
        if (typeof props.repliesWaiting === 'number' && Number.isFinite(props.repliesWaiting)) {
            cleanRow.repliesWaiting = props.repliesWaiting;
        }
        if (typeof props.overdue === 'boolean') {
            cleanRow.overdue = props.overdue;
        }
        if (typeof props.lastPostAt === 'string' && props.lastPostAt.trim()) {
            cleanRow.lastPostAt = props.lastPostAt.trim();
        }
        if (typeof props.lastInteractionAt === 'string' && props.lastInteractionAt.trim()) {
            cleanRow.lastInteractionAt = props.lastInteractionAt.trim();
        }
        if (typeof props.lastPublishDate === 'string' && props.lastPublishDate.trim()) {
            cleanRow.lastPublishDate = props.lastPublishDate.trim();
        }
        if (typeof props.cadence === 'string' && props.cadence.trim()) {
            cleanRow.cadence = props.cadence.trim();
        }
        if (typeof props.windowSemantics === 'string' && props.windowSemantics.trim()) {
            cleanRow.windowSemantics = props.windowSemantics.trim();
        }
        if (typeof props.claimClass === 'string' && props.claimClass.trim()) {
            cleanRow.claimClass = props.claimClass.trim();
        }
        if (typeof props.falsifyingQuery === 'string' && props.falsifyingQuery.trim()) {
            cleanRow.falsifyingQuery = props.falsifyingQuery.trim();
        }
        if (typeof props.asOf === 'string' && props.asOf.trim()) {
            cleanRow.asOf = props.asOf.trim();
        }
        if (typeof props.sourceUrl === 'string' && props.sourceUrl.trim()) {
            cleanRow.sourceUrl = props.sourceUrl.trim();
        }

        for (const forbidden of FORBIDDEN_PRIVATE_FIELDS) {
            delete cleanRow[forbidden];
        }

        projected.push(cleanRow);
    }

    return projected;
}

/**
 * @summary Formats a single approved PR candidate for the *what waits for the operator's word*
 * block using only the source-owned merge-readiness projection verdict (`overview-read.md` §3 & §3a).
 * @param {Object} candidate PR candidate (`{number, repo?, url?, approvedAt?, projection?}`).
 * @returns {String} Formatted bullet line.
 */
export function formatOperatorCandidateLine(candidate = {}) {
    const number     = candidate.number != null ? `#${String(candidate.number).replace(/^#/, '')}` : '#unknown';
    const repoPrefix = candidate.repo ? `${candidate.repo}` : '';
    const refLabel   = repoPrefix ? `${repoPrefix}${number}` : number;
    const link       = candidate.url ? `[${refLabel}](${candidate.url})` : refLabel;
    const projection = candidate.projection ?? {};
    const rawVerdict = projection.verdict;
    const verdict    = rawVerdict === 'ready' || rawVerdict === 'merge-ready-observed' || projection.ready === true || projection.predicate?.strictMergeReady === true
        ? 'ready'
        : rawVerdict === 'not_ready' || rawVerdict === 'not-merge-ready' || projection.ready === false || projection.predicate?.strictMergeReady === false
            ? 'not_ready'
            : 'unavailable';

    let statusLabel;
    if (verdict === 'ready') {
        statusLabel = '`ready for the operator` (projection: ready)';
    } else if (verdict === 'not_ready') {
        const blockerList = Array.isArray(projection.reasons) && projection.reasons.length > 0
            ? projection.reasons
            : Array.isArray(projection.blockers) && projection.blockers.length > 0
                ? projection.blockers.map(item => typeof item === 'string' ? item : (item?.code || item?.message)).filter(Boolean)
                : [];
        const reasons = blockerList.length > 0
            ? blockerList.join(', ')
            : (projection.reason || 'checks or review requirements');
        statusLabel = `\`approved · not ready: ${reasons}\``;
    } else {
        const missingInput = projection.missingInput || projection.reason || 'merge-readiness projection unavailable';
        statusLabel = `\`approved · readiness unverified: ${missingInput}\``;
    }

    const approvedPart = candidate.approvedAt ? ` · approved ${candidate.approvedAt}` : '';

    return `- ${link}${approvedPart} · ${statusLabel}`;
}

/**
 * @summary Executes a read-only `gh` CLI command on the host edge, falling back to
 * `/opt/homebrew/bin/gh` and `/usr/local/bin/gh` when `gh` is not on the daemon `PATH`.
 * @param {String[]} [args=[]] CLI argument vector passed to `gh`.
 * @returns {Promise<String>} Trimmed stdout string.
 */
export async function defaultExecGh(args = []) {
    const candidates = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
    let   lastError  = null;

    for (const bin of candidates) {
        try {
            const {stdout} = await execFileAsync(bin, args, {
                encoding : 'utf8',
                maxBuffer: 10 * 1024 * 1024,
                timeout  : 20_000
            });
            return String(stdout ?? '').trim();
        } catch (error) {
            lastError = error;
            if (error?.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
    }

    throw lastError || new Error('gh CLI binary not found on host PATH');
}

/**
 * @summary Parses the Fleet Manager v1 journey rows and their owning Epic references from
 * `neomjs/neo-agent-institution`'s `ROADMAP.md` table without hardcoding Epic issue numbers.
 * @param {String} [roadmapMarkdown=''] Raw `ROADMAP.md` Markdown text.
 * @returns {Array<{row: Number, repo: String, number: Number, epic: String}>}
 */
export function parseRoadmapV1RowEpics(roadmapMarkdown = '') {
    if (typeof roadmapMarkdown !== 'string' || roadmapMarkdown.trim().length === 0) {
        return [];
    }

    const rows  = [];
    const lines = roadmapMarkdown.split(/\r?\n/);

    for (const line of lines) {
        const tableMatch = /^\|\s*(\d+)\s*\|(.*)\|\s*$/.exec(line.trim());
        if (!tableMatch) continue;

        const rowNum  = Number(tableMatch[1]);
        const columns = tableMatch[2].split('|').map(col => col.trim());
        const stateCol = columns[columns.length - 1] || '';

        const urlMatch  = /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/issues\/(\d+)/i.exec(stateCol)
            || /https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/issues\/(\d+)/i.exec(line);
        const hashMatch = /#(\d+)/.exec(stateCol);

        if (urlMatch) {
            const repo   = urlMatch[1];
            const number = Number(urlMatch[2]);
            rows.push({
                row : rowNum,
                repo,
                number,
                epic: repo === 'neomjs/neo-agent-institution' ? `#${number}` : `${repo}#${number}`
            });
        } else if (hashMatch) {
            const number = Number(hashMatch[1]);
            rows.push({
                row : rowNum,
                repo: 'neomjs/neo-agent-institution',
                number,
                epic: `#${number}`
            });
        }
    }

    return rows.sort((a, b) => a.row - b.row);
}

/**
 * @summary Parses `view: <key> · needs love: <text>` design-sweep receipt lines and Binding table
 * metadata (`build`, `profile`) from issue comments on the views epic.
 * @param {Object[]} [comments=[]] Issue comment objects (`{body, createdAt, author, url}`).
 * @returns {Object[]} Parsed receipt objects ready for `evaluateViewReceipts`.
 */
export function parseViewsReceiptComments(comments = []) {
    if (!Array.isArray(comments)) return [];

    const receipts = [];

    for (const comment of comments) {
        const body = typeof comment?.body === 'string' ? comment.body : '';
        if (!body) continue;

        const buildMatch   = /\|\s*build\s*\|\s*([^|\r\n]+)\|/i.exec(body);
        const profileMatch = /\|\s*profile(?:\s*\/\s*(?:data|scope))?\s*\|\s*([^|\r\n]+)\|/i.exec(body);

        const rawBuild = buildMatch
            ? buildMatch[1].trim().replace(/^`+|`+$/g, '').trim()
            : 'installed';
        const buildLabel = rawBuild.split(/[.;—]/)[0].trim().slice(0, 36) || normalizeBuildClass(rawBuild);

        const rawProfile = profileMatch
            ? profileMatch[1].trim().replace(/^`+|`+$/g, '').trim()
            : 'default';
        const profileLabel = rawProfile.split(/[.;—]/)[0].trim().slice(0, 32) || 'default';

        const observedAt = comment.createdAt || comment.updatedAt || 'unknown';
        const login      = comment.author?.login ? String(comment.author.login).replace(/^@/, '') : null;
        const seat       = login ? `@${login}` : null;
        const sourceUrl  = comment.url || null;

        const pattern = /(?:^|\n)\s*`?view:\s*`?([a-zA-Z0-9_-]+)`?\s*·\s*needs love:\s*([^\r\n`]+)`?/gi;
        let   match;

        while ((match = pattern.exec(body)) !== null) {
            const viewKey   = match[1].trim();
            const needsLove = match[2].trim();

            if (!viewKey || !needsLove) continue;

            receipts.push({
                viewKey,
                needsLove,
                buildClass: buildLabel,
                profile   : profileLabel,
                observedAt,
                seat,
                sourceUrl
            });
        }
    }

    return receipts;
}

/**
 * @summary Evaluates a GitHub pull request snapshot using the source-owned `validateMergeReady`,
 * `resolveCrossFamilyVerdict`, and `resolveMergeHold` predicates.
 * @param {Object} [pr={}] Pull request JSON payload from `gh pr view`.
 * @returns {{verdict: ('ready'|'not_ready'|'unavailable'), ready?: Boolean, reasons?: String[], missingInput?: String, approvedAt?: (String|null)}}
 */
export function evaluateCandidateMergeReadiness(pr = {}) {
    if (!pr || typeof pr !== 'object') {
        return {verdict: 'unavailable', missingInput: 'PR snapshot absent'};
    }

    if (pr.projection && typeof pr.projection === 'object') {
        return pr.projection;
    }

    const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : null;

    if (
        !rollup ||
        typeof pr.state !== 'string' ||
        typeof pr.mergeStateStatus !== 'string' ||
        !Array.isArray(pr.reviewRequests) ||
        !Array.isArray(pr.reviews) ||
        !Array.isArray(pr.comments)
    ) {
        return {verdict: 'unavailable', missingInput: 'merge-readiness fields incomplete'};
    }

    const checksGreen = rollup.length > 0 && rollup.every(item => {
        const state = String(item?.conclusion || item?.state || '').toUpperCase();
        return state === 'SUCCESS' || state === 'NEUTRAL' || state === 'SKIPPED';
    });

    const nonRequiredFailures = rollup
        .filter(item => {
            const state = String(item?.conclusion || item?.state || '').toUpperCase();
            return ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'].includes(state);
        })
        .map(item => String(item?.name || item?.context || 'check'));

    const reviewRequests     = pr.reviewRequests.map(req => req?.login || req?.name).filter(Boolean);
    const crossFamilyVerdict = resolveCrossFamilyVerdict(pr, undefined, {warn: () => {}});
    const classifiedComments = pr.comments.map(comment => ({
        login    : comment?.author?.login,
        createdAt: comment?.createdAt,
        token    : mergeHoldToken(comment?.body || ''),
        commentId: comment?.id
    }));
    const normalizedReviews = pr.reviews.map(review => ({
        login      : review?.author?.login,
        submittedAt: review?.submittedAt,
        state      : review?.state
    }));
    const holdVerdict   = resolveMergeHold({
        comments : classifiedComments,
        reviews  : normalizedReviews,
        truncated: false
    });
    const approvals     = pr.reviews.filter(review => review?.state === 'APPROVED');
    const lastApproval  = approvals.length > 0 ? approvals[approvals.length - 1] : null;
    const approvedAtOid = lastApproval?.commit?.oid;
    const approvedAt    = lastApproval?.submittedAt || pr.updatedAt || null;

    const predicate = validateMergeReady({
        state           : pr.state,
        mergedAt        : pr.mergedAt ?? null,
        reviewDecision  : pr.reviewDecision,
        checksGreen,
        mergeStateStatus: pr.mergeStateStatus,
        reviewRequests,
        crossFamilyVerdict,
        holdVerdict,
        approvedAtOid,
        headRefOid      : pr.headRefOid,
        nonRequiredFailures
    });

    return {
        verdict: predicate.strictMergeReady ? 'ready' : 'not_ready',
        ready  : predicate.strictMergeReady,
        reasons: predicate.blockers,
        approvedAt
    };
}

/**
 * @summary Builds the four default host-edge GitHub block readers (`readV1Rows`,
 * `readViewsReceipts`, `readReachTraffic`, `readOperatorWord`) over an injectable `execGh`
 * runner so the host plane populates `## Focus (v1)` from live GitHub state while unit tests
 * can exercise every reader deterministically without network access.
 *
 * @param {Object} [options={}]
 * @param {Function} [options.execGh=defaultExecGh] Async `gh` CLI runner taking `args: String[]`.
 * @param {Function} [options.evaluateMergeReadiness=evaluateCandidateMergeReadiness] Merge-readiness evaluator.
 * @returns {{readV1Rows: Function, readViewsReceipts: Function, readReachTraffic: Function, readOperatorWord: Function}}
 */
export function createDefaultFocusV1HostEdgeReaders({
    execGh                 = defaultExecGh,
    evaluateMergeReadiness = evaluateCandidateMergeReadiness
} = {}) {
    const readV1Rows = async () => {
        const rawRoadmap = await execGh([
            'api',
            'repos/neomjs/neo-agent-institution/contents/ROADMAP.md',
            '--jq',
            '.content'
        ]);

        const trimmed = String(rawRoadmap ?? '').trim();
        const markdown = trimmed.startsWith('#') || trimmed.includes('| # |')
            ? trimmed
            : Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');

        const epicSpecs = parseRoadmapV1RowEpics(markdown);
        if (epicSpecs.length === 0) {
            return {
                status: 'unknown',
                reason: 'no v1 row epics parsed from neomjs/neo-agent-institution/ROADMAP.md'
            };
        }

        const rows = await Promise.all(epicSpecs.map(async spec => {
            try {
                const rawIssue = await execGh([
                    'issue',
                    'view',
                    String(spec.number),
                    '--repo',
                    spec.repo,
                    '--json',
                    'number,body,updatedAt,url'
                ]);
                const issue = JSON.parse(rawIssue);
                return {
                    row : spec.row,
                    epic: spec.epic,
                    body: issue?.body || ''
                };
            } catch (error) {
                return {
                    row   : spec.row,
                    epic  : spec.epic,
                    reason: sanitizeReaderReason(error)
                };
            }
        }));

        return {
            candidate: 'host-edge',
            sourceUrl: 'https://github.com/neomjs/neo-agent-institution/blob/dev/ROADMAP.md',
            rows
        };
    };

    const readViewsReceipts = async () => {
        const rawIssue = await execGh([
            'issue',
            'view',
            '505',
            '--repo',
            'neomjs/neo-agent-institution',
            '--json',
            'number,comments,url,updatedAt'
        ]);
        const issue    = JSON.parse(rawIssue);
        const receipts = parseViewsReceiptComments(issue?.comments || []);

        return {
            candidate: 'host-edge',
            sourceUrl: issue?.url || 'https://github.com/neomjs/neo-agent-institution/issues/505',
            receipts
        };
    };

    const readReachTraffic = async () => {
        const [trafficResult, repoResult] = await Promise.allSettled([
            execGh(['api', 'repos/neomjs/neo/traffic/views']),
            execGh(['api', 'repos/neomjs/neo'])
        ]);

        if (trafficResult.status === 'rejected' && repoResult.status === 'rejected') {
            throw trafficResult.reason || repoResult.reason || new Error('GitHub reach query failed');
        }

        const trafficJson = trafficResult.status === 'fulfilled' && trafficResult.value
            ? JSON.parse(trafficResult.value)
            : null;
        const repoJson    = repoResult.status === 'fulfilled' && repoResult.value
            ? JSON.parse(repoResult.value)
            : null;

        return {
            candidate      : 'host-edge',
            sourceUrl      : 'https://github.com/neomjs/neo/graphs/traffic',
            falsifyingQuery: 'gh api repos/neomjs/neo/traffic/views',
            traffic        : trafficJson
                ? {views: trafficJson.count, uniques: trafficJson.uniques}
                : null,
            stars: repoJson?.stargazers_count ?? null,
            forks: repoJson?.forks_count ?? null
        };
    };

    const readOperatorWord = async () => {
        const rawSearch = await execGh([
            'search',
            'prs',
            '--owner',
            'neomjs',
            '--state',
            'open',
            '--review',
            'approved',
            '--json',
            'number,repository,url,updatedAt'
        ]);
        const items      = JSON.parse(rawSearch || '[]');
        const list       = Array.isArray(items) ? items.slice(0, 5) : [];
        const candidates = await Promise.all(list.map(async item => {
            const repoName = item?.repository?.nameWithOwner
                || (item?.repository?.name ? `neomjs/${item.repository.name}` : 'neomjs/neo');
            const prNumber = item?.number;

            try {
                const rawView = await execGh([
                    'pr',
                    'view',
                    String(prNumber),
                    '--repo',
                    repoName,
                    '--json',
                    'number,url,state,mergedAt,isDraft,mergeStateStatus,headRefOid,author,body,reviewDecision,reviewRequests,reviews,comments,statusCheckRollup,updatedAt'
                ]);
                const prSnapshot = JSON.parse(rawView);
                const projection = await evaluateMergeReadiness(prSnapshot);

                return {
                    repo      : repoName,
                    number    : prNumber,
                    url       : prSnapshot?.url || item?.url || null,
                    approvedAt: projection?.approvedAt || item?.updatedAt || null,
                    projection
                };
            } catch (error) {
                return {
                    repo      : repoName,
                    number    : prNumber,
                    url       : item?.url || null,
                    approvedAt: item?.updatedAt || null,
                    projection: {
                        verdict     : 'unavailable',
                        missingInput: sanitizeReaderReason(error)
                    }
                };
            }
        }));

        return {
            candidate      : 'host-edge',
            sourceUrl      : 'https://github.com/pulls?q=is%3Aopen+is%3Apr+org%3Aneomjs+review%3Aapproved',
            falsifyingQuery: 'gh search prs --owner neomjs --state open --review approved',
            candidates
        };
    };

    return {
        readV1Rows,
        readViewsReceipts,
        readReachTraffic,
        readOperatorWord
    };
}

/**
 * @summary Creates the host-edge reader seam that supplies the GitHub-sourced Focus (v1) blocks
 * (`v1`, `views`, `reach`, `operatorWord`) to the synthesizer without ever passing credentials into
 * the cloud plane (Contract Ledger row 2, AC-5).
 *
 * When `useDefaultHostReaders: true` (or `execGh` is supplied), any omitted GitHub block reader
 * defaults to its host-edge `gh` implementation from `createDefaultFocusV1HostEdgeReaders`.
 * Each block reader runs independently; if a reader throws `FocusSourceUnavailable` or is omitted,
 * that block resolves to `{status: 'unknown', reason}` so the producer always writes a truthful
 * `## Focus (v1)` section.
 *
 * @param {Object} [readers={}]
 * @param {Function} [readers.readV1Rows] Async reader returning `{rows, moduleLines?, asOf?, candidate?, sourceUrl?}`.
 * @param {Function} [readers.readViewsReceipts] Async reader returning `{receipts, asOf?, candidate?, profile?, sourceUrl?}`.
 * @param {Function} [readers.readReachTraffic] Async reader returning `{traffic?, stars?, forks?, asOf?, candidate?, sourceUrl?, falsifyingQuery?}`.
 * @param {Function} [readers.readOperatorWord] Async reader returning `{candidates, asOf?, candidate?, sourceUrl?, falsifyingQuery?}`.
 * @param {Function} [readers.readPrivateLedger] Async reader returning raw ledger rows to be filtered by `projectPublicBusinessRows`.
 * @param {Boolean}  [readers.useDefaultHostReaders=false] When `true`, fills omitted GitHub block readers with `createDefaultFocusV1HostEdgeReaders`.
 * @param {Function} [readers.execGh] Optional `gh` CLI runner forwarded to `createDefaultFocusV1HostEdgeReaders`.
 * @param {Function} [readers.evaluateMergeReadiness] Optional merge-readiness evaluator forwarded to `createDefaultFocusV1HostEdgeReaders`.
 * @param {String}   [readers.absentReason=FOCUS_V1_READER_ABSENT_REASON] Reason recorded when a GitHub reader is absent.
 * @returns {{readFocusV1Inputs: Function}}
 */
export function createFocusV1HostEdgeReader({
    readV1Rows,
    readViewsReceipts,
    readReachTraffic,
    readOperatorWord,
    readPrivateLedger,
    useDefaultHostReaders = false,
    execGh,
    evaluateMergeReadiness,
    absentReason = FOCUS_V1_READER_ABSENT_REASON
} = {}) {
    const defaultReaders = (useDefaultHostReaders || typeof execGh === 'function')
        ? createDefaultFocusV1HostEdgeReaders({execGh, evaluateMergeReadiness})
        : null;

    const resolvedReadV1Rows        = readV1Rows        ?? defaultReaders?.readV1Rows;
    const resolvedReadViewsReceipts = readViewsReceipts ?? defaultReaders?.readViewsReceipts;
    const resolvedReadReachTraffic  = readReachTraffic  ?? defaultReaders?.readReachTraffic;
    const resolvedReadOperatorWord  = readOperatorWord  ?? defaultReaders?.readOperatorWord;

    const runBlockReader = async (fn, fallbackReason) => {
        if (typeof fn !== 'function') {
            return {status: 'unknown', reason: fallbackReason};
        }

        try {
            const result = await fn();
            if (!result || typeof result !== 'object') {
                return {status: 'unknown', reason: fallbackReason};
            }
            if (result.status === 'unknown') {
                return {
                    ...result,
                    status: 'unknown',
                    reason: sanitizeReaderReason(result.reason || fallbackReason)
                };
            }
            return {status: 'ok', ...result};
        } catch (error) {
            return {
                status     : 'unknown',
                unavailable: Boolean(error?.unavailable),
                reason     : sanitizeReaderReason(error)
            };
        }
    };

    const readFocusV1Inputs = async ({now = new Date(), allowlist} = {}) => {
        const asOf                                            = formatGoldenPathCapturedAt(now);
        const [v1, views, reachTraffic, operatorWord, ledger] = await Promise.all([
            runBlockReader(resolvedReadV1Rows, absentReason),
            runBlockReader(resolvedReadViewsReceipts, absentReason),
            runBlockReader(resolvedReadReachTraffic, absentReason),
            runBlockReader(resolvedReadOperatorWord, absentReason),
            runBlockReader(readPrivateLedger, PRIVATE_LEDGER_ABSENT_REASON)
        ]);

        const rawLedgerRows = Array.isArray(ledger.rows) ? ledger.rows : [];
        const publicRows    = projectPublicBusinessRows(rawLedgerRows, {allowlist});

        return {
            capturedAt: asOf,
            v1,
            views,
            reach     : {
                status: reachTraffic.status === 'ok' || publicRows.length > 0 ? 'ok' : 'unknown',
                reason: reachTraffic.status === 'ok'
                    ? null
                    : (reachTraffic.reason || absentReason),
                asOf           : reachTraffic.asOf || asOf,
                candidate      : reachTraffic.candidate || 'host-edge',
                sourceUrl      : reachTraffic.sourceUrl || 'https://github.com/neomjs/neo/graphs/traffic',
                falsifyingQuery: reachTraffic.falsifyingQuery || 'gh api repos/neomjs/neo/traffic/views',
                traffic        : reachTraffic.status === 'ok' ? reachTraffic.traffic ?? null : null,
                stars          : reachTraffic.status === 'ok' ? reachTraffic.stars ?? null : null,
                forks          : reachTraffic.status === 'ok' ? reachTraffic.forks ?? null : null,
                publicRows
            },
            operatorWord
        };
    };

    return {readFocusV1Inputs};
}

/**
 * @summary Renders the `## Focus (v1)` handoff section with its `focus.v1` version marker, two
 * opening answer lines, and four bounded blocks (*v1*, *views*, *reach and outbound*, *what waits
 * for the operator's word*), guaranteed `<= 2,000` UTF-8 bytes (AC-1, AC-2, AC-3, AC-5).
 *
 * When called with no inputs (or when all inputs are absent on the cloud plane), the section is
 * still emitted with `unknown` and the explicit boundary reason on each block.
 *
 * @param {Object} [options={}]
 * @param {Date|String|Number} [options.capturedAt=new Date()] Section capture timestamp.
 * @param {String} [options.candidate='unscoped'] Default candidate or profile label.
 * @param {Object} [options.v1] Block 1 input (`{status?, reason?, rows?, moduleLines?, asOf?, candidate?, sourceUrl?}`).
 * @param {Object} [options.views] Block 2 input (`{status?, reason?, receipts?, viewKeys?, asOf?, candidate?, profile?, sourceUrl?}`).
 * @param {Object} [options.reach] Block 3 input (`{status?, reason?, traffic?, stars?, forks?, ledgerRows?, publicRows?, allowlist?, asOf?, candidate?, sourceUrl?, falsifyingQuery?}`).
 * @param {Object} [options.operatorWord] Block 4 input (`{status?, reason?, candidates?, asOf?, candidate?, sourceUrl?, falsifyingQuery?}`).
 * @param {Number} [options.maxBytes=FOCUS_V1_MAX_BYTES] Hard UTF-8 byte ceiling.
 * @returns {String} Complete `## Focus (v1)` Markdown section ending in `\n\n`.
 */
export function renderFocusV1Section({
    capturedAt = new Date(),
    candidate  = 'unscoped',
    v1,
    views,
    reach,
    operatorWord,
    maxBytes   = FOCUS_V1_MAX_BYTES
} = {}) {
    const defaultAsOf = formatGoldenPathCapturedAt(capturedAt);

    // --- 1. Evaluate Block 1: v1 rows ---
    const v1Available = v1 && v1.status !== 'unknown' && Array.isArray(v1.rows) && v1.rows.length > 0;
    const v1Summary   = v1Available
        ? summarizeV1Rows(v1.rows)
        : null;
    const v1Reason    = sanitizeReaderReason(v1?.reason || FOCUS_V1_READER_ABSENT_REASON);
    const v1AsOf      = v1?.asOf || defaultAsOf;
    const v1Candidate = v1?.candidate || candidate;
    const v1Source    = v1?.sourceUrl || 'neomjs/neo-agent-institution/ROADMAP.md';

    // --- 2. Evaluate Block 2: views ---
    const viewsAvailable = views && views.status !== 'unknown' && Array.isArray(views.receipts);
    const viewsEval      = viewsAvailable
        ? evaluateViewReceipts(views.receipts, {viewKeys: views.viewKeys || FOCUS_V1_VIEW_KEYS})
        : null;
    const viewsReason    = sanitizeReaderReason(views?.reason || FOCUS_V1_READER_ABSENT_REASON);
    const viewsAsOf      = views?.asOf || defaultAsOf;
    const viewsCandidate = views?.candidate || views?.profile || candidate;
    const viewsSource    = views?.sourceUrl || 'neomjs/neo-agent-institution#505';

    // --- 3. Two opening answer lines (`overview-read.md` §2) ---
    const v1AnswerLine = v1Summary
        ? `v1: ${v1Summary.passed} of ${v1Summary.total} rows passed · ready ${v1Summary.ready} · unknown ${v1Summary.unknown} · failed ${v1Summary.failed} · missing: ${v1Summary.missing.length > 0 ? v1Summary.missing.join(', ') : 'none'}`
        : `v1: 0 of 5 rows passed · ready 0 · unknown 5 · failed 0 · missing: all (${v1Reason})`;

    const viewsAnswerLine = viewsEval && views.receipts.length > 0
        ? `views: swept ${viewsEval.swept} · needing love ${viewsEval.needingLove} · unassessed: ${viewsEval.unassessed.length > 0 ? viewsEval.unassessed.join(', ') : 'none'}`
        : viewsEval && views.receipts.length === 0
            ? `views: swept 0 · needing love 0 · unassessed: ${viewsEval.unassessed.join(', ')} (no receipt on #505)`
            : `views: swept 0 · needing love unknown · unassessed: ${FOCUS_V1_VIEW_KEYS.join(', ')} (${viewsReason})`;

    // --- 4. Render Block 1: ### v1 ---
    const v1Lines = [
        `### v1`,
        `as of ${v1AsOf} · candidate: ${v1Candidate} · source: ${v1Source}`
    ];

    if (v1Summary) {
        for (const row of v1Summary.normalizedRows) {
            const epicPart = row.epic ? ` (${row.epic})` : '';
            v1Lines.push(`- row ${row.row}${epicPart}: ${row.rawLine}`);
        }
        if (Array.isArray(v1.moduleLines) && v1.moduleLines.length > 0) {
            for (const modLine of v1.moduleLines.slice(0, 3)) {
                v1Lines.push(`- module: ${String(modLine).trim()}`);
            }
        }
    } else {
        v1Lines.push(`- status: unknown (${v1Reason})`);
    }

    // --- 5. Render Block 2: ### views ---
    const viewsLines = [
        `### views`,
        `as of ${viewsAsOf} · candidate: ${viewsCandidate} · source: ${viewsSource}`
    ];

    if (viewsEval) {
        if (views.receipts.length === 0) {
            viewsLines.push(`- views: none yet (no receipt on #505) · unassessed: ${viewsEval.unassessed.join(', ')}`);
        } else {
            let renderedNeedsLoveCount = 0;
            for (const [key, entry] of Object.entries(viewsEval.byKey)) {
                if (!entry.governing || entry.status !== 'needs-love') continue;
                renderedNeedsLoveCount++;
                const gov        = entry.governing;
                const seatPart   = gov.seat ? ` · ${gov.seat}` : '';
                const leavesPart = gov.openDesignLeaves.length > 0 ? ` · leaves: ${gov.openDesignLeaves.join(',')}` : '';
                viewsLines.push(`- \`${key}\`: needs love: ${gov.needsLove} (${gov.buildLabel} · ${gov.profile} · ${gov.observedAt}${seatPart}${leavesPart})`);
                if (entry.newerSourceLine) {
                    const src = entry.newerSourceLine;
                    viewsLines.push(`  - ↳ source ${src.observedAt} · needs love: ${src.needsLove} (does not resolve installed line)`);
                }
            }
            if (renderedNeedsLoveCount === 0) {
                viewsLines.push(`- needing love: none observed (${viewsEval.swept} swept)`);
            }
        }
    } else {
        viewsLines.push(`- status: unknown (${viewsReason})`);
    }

    // --- 6. Render Block 3: ### reach and outbound ---
    const reachAsOf      = reach?.asOf || defaultAsOf;
    const reachCandidate = reach?.candidate || candidate;
    const reachSource    = reach?.sourceUrl || 'neomjs/neo/graphs/traffic';
    const reachQuery     = reach?.falsifyingQuery || 'gh api repos/neomjs/neo/traffic/views';
    const publicRows     = Array.isArray(reach?.publicRows)
        ? projectPublicBusinessRows(reach.publicRows, {allowlist: reach?.allowlist})
        : Array.isArray(reach?.ledgerRows)
            ? projectPublicBusinessRows(reach.ledgerRows, {allowlist: reach?.allowlist})
            : [];
    const hasTrafficData = reach && reach.status !== 'unknown' && (reach.traffic || reach.stars != null || reach.forks != null);
    const reachLines     = [
        `### reach and outbound`,
        `as of ${reachAsOf} · candidate: ${reachCandidate} · source: ${reachSource}`
    ];

    if (hasTrafficData) {
        const parts = [];
        if (reach.traffic && typeof reach.traffic === 'object') {
            const viewsCount = reach.traffic.views ?? reach.traffic.count ?? 'unknown';
            const uniques    = reach.traffic.uniques ?? 'unknown';
            const deltaViews = reach.traffic.delta != null ? ` (${reach.traffic.delta >= 0 ? '+' : ''}${reach.traffic.delta})` : '';
            parts.push(`traffic 14d: ${viewsCount} views${deltaViews}, ${uniques} uniques`);
        }
        if (reach.stars != null) {
            const starCount = typeof reach.stars === 'object' ? reach.stars.count : reach.stars;
            const starDelta = typeof reach.stars === 'object' && reach.stars.delta != null
                ? ` (${reach.stars.delta >= 0 ? '+' : ''}${reach.stars.delta})`
                : '';
            parts.push(`stars: ${starCount}${starDelta}`);
        }
        if (reach.forks != null) {
            const forkCount = typeof reach.forks === 'object' ? reach.forks.count : reach.forks;
            const forkDelta = typeof reach.forks === 'object' && reach.forks.delta != null
                ? ` (${reach.forks.delta >= 0 ? '+' : ''}${reach.forks.delta})`
                : '';
            parts.push(`forks: ${forkCount}${forkDelta}`);
        }
        reachLines.push(`- ${parts.join(' · ')} · falsifyingQuery: \`${reachQuery}\``);
    } else {
        const reachReason = sanitizeReaderReason(reach?.reason || FOCUS_V1_READER_ABSENT_REASON);
        reachLines.push(`- github reach: unknown (${reachReason}) · falsifyingQuery: \`${reachQuery}\``);
    }

    if (publicRows.length > 0) {
        for (const row of publicRows.slice(0, 4)) {
            const details = [];
            if (row.value !== undefined) details.push(`value: ${row.value}`);
            if (row.delta !== undefined) details.push(`delta: ${row.delta >= 0 ? '+' : ''}${row.delta}`);
            if (row.count !== undefined) details.push(`count: ${row.count}`);
            if (row.lastPostAt)          details.push(`last post: ${row.lastPostAt}`);
            if (row.lastInteractionAt)   details.push(`last interaction: ${row.lastInteractionAt}`);
            if (row.repliesWaiting !== undefined) details.push(`replies waiting: ${row.repliesWaiting}`);
            if (row.overdue !== undefined)        details.push(`overdue: ${row.overdue ? 'yes' : 'no'}`);
            if (row.lastPublishDate)     details.push(`last publish: ${row.lastPublishDate}`);
            if (row.cadence)             details.push(`cadence: ${row.cadence}`);
            if (row.falsifyingQuery)     details.push(`falsifyingQuery: \`${row.falsifyingQuery}\``);
            reachLines.push(`- outbound \`${row.category}\`: ${details.join(' · ')}`);
        }
    } else {
        const outboundReason = sanitizeReaderReason(reach?.outboundReason || PRIVATE_LEDGER_ABSENT_REASON);
        reachLines.push(`- outbound ledger: unknown (${outboundReason})`);
    }

    // --- 7. Render Block 4: ### what waits for the operator's word ---
    const opAsOf      = operatorWord?.asOf || defaultAsOf;
    const opCandidate = operatorWord?.candidate || candidate;
    const opSource    = operatorWord?.sourceUrl || 'org:neomjs is:open is:pr review:approved';
    const opQuery     = operatorWord?.falsifyingQuery || 'gh search prs --owner neomjs --state open --review approved';
    const opAvailable = operatorWord && operatorWord.status !== 'unknown' && Array.isArray(operatorWord.candidates);
    const opLines     = [
        `### what waits for the operator's word`,
        `as of ${opAsOf} · candidate: ${opCandidate} · source: ${opSource}`
    ];

    if (opAvailable) {
        const candidates = operatorWord.candidates;
        opLines.push(`- approved open PRs (${candidates.length}) · falsifyingQuery: \`${opQuery}\``);
        for (const item of candidates.slice(0, 5)) {
            opLines.push(formatOperatorCandidateLine(item));
        }
    } else {
        const opReason = sanitizeReaderReason(operatorWord?.reason || FOCUS_V1_READER_ABSENT_REASON);
        opLines.push(`- status: unknown (${opReason}) · falsifyingQuery: \`${opQuery}\``);
    }
    opLines.push(`- decisions outside pull requests: not covered by this read`);

    const assemble = (viewsBlockLines, opBlockLines) => [
        FOCUS_V1_HEADING,
        '',
        `<!-- ${FOCUS_V1_MARKER} · captured: ${defaultAsOf} -->`,
        '',
        v1AnswerLine,
        viewsAnswerLine,
        '',
        ...v1Lines,
        '',
        ...viewsBlockLines,
        '',
        ...reachLines,
        '',
        ...opBlockLines,
        ''
    ].join('\n') + '\n';

    let rendered = assemble(viewsLines, opLines);

    // Enforce the <= 2,000-byte ceiling by compacting per-view detail lines and long PR lists
    // while preserving every block header, answer line, and count without duplicating footers.
    if (Buffer.byteLength(rendered, 'utf8') > maxBytes) {
        const viewBody = viewsLines.slice(2);
        const opFooter = opLines[opLines.length - 1];
        const opBody   = opLines.slice(2, -1);
        let   viewCap  = Math.min(viewBody.length, 3);
        let   opCap    = Math.min(opBody.length, 3);

        while (Buffer.byteLength(rendered, 'utf8') > maxBytes && (viewCap > 1 || opCap > 1)) {
            const compactViewsLines = [
                viewsLines[0],
                viewsLines[1],
                ...viewBody.slice(0, viewCap)
            ];
            const compactOpLines = [
                opLines[0],
                opLines[1],
                ...opBody.slice(0, opCap),
                opFooter
            ];
            rendered = assemble(compactViewsLines, compactOpLines);
            if (viewCap >= opCap && viewCap > 1) {
                viewCap--;
            } else if (opCap > 1) {
                opCap--;
            }
        }
    }

    return rendered;
}
