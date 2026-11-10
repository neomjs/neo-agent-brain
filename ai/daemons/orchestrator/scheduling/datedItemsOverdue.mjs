import {
    agentIdentitiesOf,
    readAgentIdentityNodes
} from '../../../graph/agentIdentityParticipation.mjs';
import {IDENTITIES}              from '../../../graph/identityRoots.mjs';
import {
    computeDaysOverdue,
    readDatedItems,
    toUtcDateString
} from '../../../services/graph/datedItemsSection.mjs';

/**
 * @module ai/daemons/orchestrator/scheduling/datedItemsOverdue
 * @summary Daily container-plane scheduled lane that reads the `dated-items.v1` register and sends
 * one direct A2A message per owner with overdue rows (`[overdue · <n> rows]`) and one `AGENT:*`
 * message for overdue rows whose owner is `'unowned'` or not a known identity.
 *
 * Contract (ADR 0019 [not-ticket-ref: decision-record authority] §10.8):
 * - **Authority class:** `container-plane` (registered in `scheduling/registry.mjs` and `taskAuthority.mjs`).
 * - **Use-site config read:** Reads `memoryCoreConfig.datedItemsSourcePath` (`NEO_DATED_ITEMS_SOURCE_PATH`)
 *   at the execution boundary and passes the scalar path to {@link readDatedItems}. When the leaf is
 *   empty (`''`), the lane reads nothing, sends nothing, and logs no error.
 * - **Once-per-day idempotency:** Runs at most once per UTC calendar day (`YYYY-MM-DD`). A second run
 *   on the same UTC day sends nothing. A failed send is logged and retried on the next day's run.
 * - **Direct message wake & fallback:** Each addressable owner receives a single direct message
 *   (`to: '@<owner>'`, waking the owner) with subject `[overdue · <n> rows]`, one line per overdue
 *   row (`<id> · due <date> · <n> days`), and one sentence with the rule:
 *   `a row leaves with a receipt or with a new date in the register.` Overdue rows that are
 *   `'unowned'`, or whose owner is no known identity, are grouped into one `AGENT:*` message.
 */

/**
 * Canonical rule sentence appended to every overdue register notification.
 * @type {String}
 */
export const DATED_ITEMS_OVERDUE_RULE_SENTENCE =
    'a row leaves with a receipt or with a new date in the register.';

/**
 * Default human operator handle recognized alongside `IDENTITIES` when resolving addressable owners.
 * @type {String}
 */
const DEFAULT_OPERATOR_HANDLE = '@tobiu';

/**
 * @summary Normalizes an A2A handle (with or without leading `@`) into canonical `@<handle>` form,
 * or `null` when empty or `'unowned'`.
 * @param {*} rawOwner Raw owner string from a register row or identity list.
 * @returns {String|null} Canonical `@<handle>` or `null`.
 */
export function normalizeOwnerHandle(rawOwner) {
    if (typeof rawOwner !== 'string') {
        return null;
    }

    const stripped = rawOwner.trim().replace(/^@+/, '').trim();

    if (!stripped || stripped.toLowerCase() === 'unowned') {
        return null;
    }

    return `@${stripped}`;
}

/**
 * @summary Builds the known-identity set (`@<handle>`) from injectable `knownIdentities`, canonical
 * `IDENTITIES` roots, and optional graph `AGENT_IDENTITY` nodes.
 * @param {Object} [options={}]
 * @param {Iterable<String>|null} [options.knownIdentities=null] Explicit known identities override.
 * @param {Object|null} [options.db=null] Optional SQLite handle for `readAgentIdentityNodes(db)`.
 * @returns {Set<String>} Canonical `@<handle>` set.
 */
export function resolveKnownIdentities({knownIdentities = null, db = null} = {}) {
    if (knownIdentities) {
        const explicit = new Set();
        for (const item of knownIdentities) {
            const handle = normalizeOwnerHandle(item);
            if (handle) {
                explicit.add(handle);
            }
        }
        return explicit;
    }

    const known = new Set([DEFAULT_OPERATOR_HANDLE]);

    for (const entry of IDENTITIES) {
        const primary = normalizeOwnerHandle(entry?.id);
        if (primary) {
            known.add(primary);
        }
        if (Array.isArray(entry?.aliases)) {
            for (const alias of entry.aliases) {
                const normalizedAlias = normalizeOwnerHandle(alias);
                if (normalizedAlias) {
                    known.add(normalizedAlias);
                }
            }
        }
    }

    if (db) {
        try {
            for (const id of agentIdentitiesOf(readAgentIdentityNodes(db))) {
                const normalized = normalizeOwnerHandle(id);
                if (normalized) {
                    known.add(normalized);
                }
            }
        } catch {
            // Best-effort DB augmentation; static identity roots remain authoritative.
        }
    }

    return known;
}

/**
 * @summary Formats one overdue register row into its canonical message line:
 * `<id> · due <date> · <n> days`.
 * @param {Object} row Overdue register row (`{id, due}`).
 * @param {String} today Current UTC calendar date (`YYYY-MM-DD`).
 * @returns {String}
 */
export function formatOverdueRowLine(row, today) {
    const days = computeDaysOverdue(row.due, today);
    return `${row.id} · due ${row.due} · ${days} days`;
}

/**
 * @summary Builds the `[overdue · <n> rows]` message envelope for one recipient (`@<owner>` or `AGENT:*`).
 * @param {Object} options
 * @param {String} options.to Recipient (`@<owner>` or `'AGENT:*'`).
 * @param {Object[]} options.rows Overdue register rows for this recipient.
 * @param {String} options.today Current UTC calendar date (`YYYY-MM-DD`).
 * @returns {{to: String, subject: String, body: String, rowIds: String[]}}
 */
export function buildOverdueMessage({to, rows, today}) {
    const lines = rows.map(row => formatOverdueRowLine(row, today));

    return {
        to,
        subject: `[overdue · ${rows.length} rows]`,
        body   : [...lines, DATED_ITEMS_OVERDUE_RULE_SENTENCE].join('\n'),
        rowIds : rows.map(row => row.id)
    };
}

/**
 * @summary Checks whether the task state envelope indicates the daily lane has already run on `today` (UTC).
 * @param {Object|null} taskState Task state envelope (`state['dated-items-overdue']` or direct state object).
 * @param {String} today Current UTC calendar date (`YYYY-MM-DD`).
 * @returns {Boolean}
 */
export function hasRunOnUtcDate(taskState, today) {
    if (!taskState || typeof taskState !== 'object') {
        return false;
    }

    if (taskState.lastRunDate === today || taskState.lastCompletion?.date === today) {
        return true;
    }

    if (!taskState.running && typeof taskState.lastRunAt === 'number' && taskState.lastRunAt > 0) {
        try {
            if (toUtcDateString(taskState.lastRunAt) === today) {
                return true;
            }
        } catch {
            return false;
        }
    }

    return false;
}

/**
 * @summary Cadence due-trigger projection for the `dated-items-overdue` container-plane lane.
 *
 * Returns a trigger descriptor when `sourcePath` is configured (or not explicitly empty) and the
 * lane has not yet run on `now`'s UTC calendar date; returns `null` otherwise. Pure and I/O-free.
 *
 * @param {Object} [options={}]
 * @param {Object} [options.state={}] Orchestrator task state map or lane state envelope.
 * @param {Number|Date|String} [options.now=Date.now()] Current time.
 * @param {String} [options.sourcePath] Optional scalar `datedItemsSourcePath` value; when explicitly `''`, returns `null`.
 * @returns {Object|null} Trigger descriptor `{taskName, source, reason}` or `null`.
 */
export function getDueTask({state = {}, now = Date.now(), sourcePath} = {}) {
    if (typeof sourcePath === 'string' && sourcePath.trim() === '') {
        return null;
    }

    const today     = toUtcDateString(now),
          taskState = state?.['dated-items-overdue'] ?? state;

    if (hasRunOnUtcDate(taskState, today)) {
        return null;
    }

    return {
        taskName: 'dated-items-overdue',
        source  : 'daily-dated-items-overdue',
        reason  : `daily-dated-items-overdue:${today}`
    };
}

/**
 * @summary Executes one daily pass of the overdue-register lane.
 *
 * Consumes the scalar `sourcePath` resolved at the Orchestrator entrypoint (`memoryCoreConfig.datedItemsSourcePath`),
 * delegates file parsing and bucket derivation to {@link readDatedItems}, groups overdue rows by
 * addressable owner (routing `'unowned'` or unknown owners into a single `'AGENT:*'` message),
 * and dispatches at most once per UTC calendar day.
 *
 * @param {Object} [options={}]
 * @param {String} [options.sourcePath=''] Scalar path to `dated-items.json` resolved from `memoryCoreConfig.datedItemsSourcePath` at the use site.
 * @param {Date|String|Number} [options.now=new Date()] Current clock value.
 * @param {Object|null} [options.state=null] Mutable task-state object for same-day idempotency tracking.
 * @param {Function} [options.sendMessage] Injectable async sender `({to, subject, body}) => Promise<*>`.
 * @param {Iterable<String>|null} [options.knownIdentities=null] Injectable known-identities override.
 * @param {Object|null} [options.db=null] Optional SQLite handle for `AGENT_IDENTITY` lookup.
 * @param {Function} [options.readFile] Optional file-reader seam forwarded to {@link readDatedItems}.
 * @param {Function} [options.writeLog] Logger `(level, message) => void`.
 * @returns {Promise<{
 *   status: ('unconfigured'|'already-ran-today'|'unreadable'|'ok'),
 *   today: String,
 *   reason?: String,
 *   sentCount: Number,
 *   failedCount: Number,
 *   messages: Array<{to: String, subject: String, body: String, rowIds: String[]}>
 * }>}
 */
export async function runDatedItemsOverdue({
    sourcePath      = '',
    now             = new Date(),
    state           = null,
    sendMessage,
    knownIdentities = null,
    db              = null,
    readFile,
    writeLog        = () => {}
} = {}) {
    const resolvedPath = sourcePath,
          today        = toUtcDateString(now);

    if (typeof resolvedPath !== 'string' || resolvedPath.trim() === '') {
        return {
            status     : 'unconfigured',
            today,
            sentCount  : 0,
            failedCount: 0,
            messages   : []
        };
    }

    const taskState = state && typeof state === 'object'
        ? (state['dated-items-overdue'] && typeof state['dated-items-overdue'] === 'object'
            ? state['dated-items-overdue']
            : state)
        : null;

    if (taskState && hasRunOnUtcDate(taskState, today)) {
        return {
            status     : 'already-ran-today',
            today,
            sentCount  : 0,
            failedCount: 0,
            messages   : []
        };
    }

    const read = readDatedItems({
        sourcePath: resolvedPath,
        now       : today,
        ...(readFile ? {readFile} : {})
    });

    if (read.status === 'unreadable') {
        writeLog('WARN', `[DatedItemsOverdue] Register unreadable (${resolvedPath}): ${read.reason}`);
        return {
            status     : 'unreadable',
            today,
            reason     : read.reason,
            sentCount  : 0,
            failedCount: 0,
            messages   : []
        };
    }

    // Stamp the UTC day so a second run on the same day sends nothing, and any failed send is
    // logged and retried on the next day's run rather than spinning on every poll tick.
    if (taskState) {
        taskState.lastRunDate = today;
    }

    if (read.overdue.length === 0) {
        return {
            status     : 'ok',
            today,
            sentCount  : 0,
            failedCount: 0,
            messages   : []
        };
    }

    const knownSet        = resolveKnownIdentities({knownIdentities, db}),
          rowsByOwner     = new Map(),
          unaddressedRows = [];

    for (const row of read.overdue) {
        const handle = normalizeOwnerHandle(row?.owner);

        if (handle && knownSet.has(handle)) {
            if (!rowsByOwner.has(handle)) {
                rowsByOwner.set(handle, []);
            }
            rowsByOwner.get(handle).push(row);
        } else {
            unaddressedRows.push(row);
        }
    }

    const envelopes = [];

    for (const [handle, rows] of rowsByOwner.entries()) {
        envelopes.push(buildOverdueMessage({to: handle, rows, today}));
    }

    if (unaddressedRows.length > 0) {
        envelopes.push(buildOverdueMessage({to: 'AGENT:*', rows: unaddressedRows, today}));
    }

    const sentMessages = [];
    let   failedCount  = 0;

    for (const envelope of envelopes) {
        try {
            await sendMessage({
                to     : envelope.to,
                subject: envelope.subject,
                body   : envelope.body
            });
            sentMessages.push(envelope);
        } catch (error) {
            failedCount++;
            writeLog(
                'ERROR',
                `[DatedItemsOverdue] Failed to send overdue register message to ${envelope.to}: ${error?.message || String(error)}`
            );
        }
    }

    return {
        status   : 'ok',
        today,
        sentCount: sentMessages.length,
        failedCount,
        messages : sentMessages
    };
}
