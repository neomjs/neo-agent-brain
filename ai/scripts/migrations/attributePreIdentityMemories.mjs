#!/usr/bin/env node
/**
 * @module ai/scripts/migrations/attributePreIdentityMemories
 * @summary Attributes a returning agent's pre-identity raw memories to it, on recorded evidence and operator-supplied era/agent bounds.
 * Dry-run by default; `--apply --offline` re-keys the matched rows in Chroma and the graph, and
 * `--reverse --offline` restores exactly what an apply re-keyed.
 *
 * Rows written before writes carried an identity hold `userId: 'shared'` and no `agentIdentity`
 * (`backfillChromaSharedUserId.mjs` gave them the shared tag). The team still reads them, but nothing ties
 * them to their author, so identity-scoped recall and summaries miss them.
 *
 * The operator names the identity, its aliases, its harness markers, any unambiguous `metadata.agent` labels and any
 * single-agent founding cutoff. A row without `agentIdentity` is attributed by one rule:
 * - `user-id`: its `metadata.userId` already names the identity or an alias.
 * - `harness-marker`: its prompt opens with a harness marker at the trusted envelope prefix
 *   ({@link envelopeOf}). A marker quoted anywhere else is content, never evidence.
 * - `wake-addressee`: its prompt opens with a wake header addressed to the identity or an alias.
 * - `agent-field`: its `metadata.agent` matches an `--agent` label; `--conflict-agent` marks a foreign label.
 * - `before-cutoff`: its `metadata.agent` is empty and its `metadata.timestamp` is strictly earlier than `--before`
 *   (adds rows to the other rules' union rather than bounding `--agent`; a row with an unlisted `metadata.agent` fails closed).
 * - `session`: it shares a session with a row attributed by a direct rule, or with a row already attributed
 *   to the identity or an alias.
 *
 * A session holding a row of another identity, another `userId`, a wake addressed to another identity, or a
 * `--conflict-agent` label stays shared as a whole, and so does every row without evidence. A row without a session, or
 * with an empty one, carries only its own evidence.
 *
 * Each re-keyed Chroma row records its rule, its evidence and the state it replaced (`attributionRule`,
 * `attributionEvidence`, `attributionPrior`, `attributionPriorUserId`, and `attributionLegacyPrior` for a legacy projection). That record is the
 * journal. An apply writes Chroma first and then re-keys every journaled graph node in one SQLite transaction, so a
 * re-run completes an interrupted apply. `--reverse` restores the graph from the journal before it clears the journal
 * in Chroma. One transaction across both stores is impossible; this is the bounded form of atomic that
 * `reconcileRawMemoryGraphIdentities.mjs` uses.
 *
 * A row's legacy `memory:<uuid>` projection is REM's old copy of the row, so it moves with the row. Left behind, it
 * would hold the old tenant beside the re-keyed row, a conflict the reconciler refuses to converge. An apply moves it
 * only from the shared mirror, and journals that prior first; a projection the identity already held is left alone,
 * and one holding another owner is refused. A reverse restores only a journaled projection. Its refusal keeps the
 * whole row attributed, journal included, so a retry can finish it.
 *
 * Usage:
 *   node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> [--alias <id>]... [--harness <marker>]... [--agent <label>]... [--conflict-agent <label>]... [--before <iso-or-ms>]
 *   node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> [...] --apply --offline
 *   node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> --reverse --offline
 *
 * Writes are offline: stop every Memory Core process that can write or cache the graph, run any pending identity
 * rename (`renameAgentIdentities.mjs`) first so `attributionPriorUserId` records the post-rename `userId`, then run
 * this migration and restart Memory Core.
 */

import path                           from 'node:path';
import {normalizeAgentIdentityNodeId} from '../../graph/normalizeAgentIdentityNodeId.mjs';
import {
    LEGACY_RAW_MEMORY_NODE_LABEL,
    legacyRawMemoryGraphId,
    RAW_MEMORY_NODE_LABEL
} from '../../services/memory-core/helpers/rawMemoryGraphIdentity.mjs';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';

const
    BATCH_SIZE     = 200,
    PAGE_SIZE      = 2000,
    SHARED_USER_ID = 'shared',
    // a shared row's owner, which its legacy projection mirrors until the row is attributed
    SHARED_OWNER   = Object.freeze({agentIdentity: null, propertyUserId: SHARED_USER_ID, userId: SHARED_USER_ID}),
    // the one wrapper a harness is known to open a session with: the Gemini CLI's `<session_context>` line
    ENVELOPE_LINE  = /^<session_context>[ \t]*\r?\n/,
    // the wake digest header: `[WAKE][priority:high] 3 events for @neo-gpt: …`
    WAKE_HEADER    = /^\[WAKE\](?:\[priority:[\w-]+\])?\s+\d+\s+events?\s+for\s+(@?[\w.-]+):/,
    USAGE          = `Usage: node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> [options]

Options:
  --identity <id>          The agent whose pre-identity rows are attributed (required)
  --alias <id>             Another name the agent's rows and wakes were written under (repeatable)
  --harness <marker>       A harness session marker, as it opens the prompt (repeatable)
  --agent <label>          An unambiguous metadata.agent value on shared rows (repeatable)
  --conflict-agent <label> A foreign metadata.agent value that marks a session conflict (repeatable)
  --before <iso-or-ms>     Solo-era rule: adds shared rows with no foreign agent strictly before this timestamp (--agent X --before T attributes the union, not an intersection)
  --apply                  Re-key the matched rows (requires --offline)
  --reverse                Restore every row an apply attributed to the identity (requires --offline)
  --offline                Acknowledge that every Memory Core graph writer is stopped
  --db <path>              Override the SQLite graph path
  --sample <n>             Rows to show in the dry-run sample (default 10)
  --help                   Show this help`;

/**
 * @summary Normalizes an epoch millisecond number, numeric string or ISO-8601 timestamp string to epoch milliseconds.
 * @param {*} value
 * @returns {Number}
 */
function timestampMs(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : NaN
    }

    if (typeof value === 'string' && value.trim() !== '') {
        const numeric = Number(value);

        return Number.isFinite(numeric) ? numeric : Date.parse(value)
    }

    return NaN
}

/**
 * @summary Parses the CLI flags. Aliases, harness markers and agent labels repeat.
 * @param {String[]} argv The arguments after the script path.
 * @returns {{agents: String[], aliases: String[], apply: Boolean, before: String|null, beforeMs: Number|null, conflictAgents: String[], db: String|null, harness: String[], help: Boolean, identity: String|null, offline: Boolean, reverse: Boolean, sample: Number}}
 */
export function parseArgs(argv) {
    const
        options = {agents: [], aliases: [], apply: false, before: null, beforeMs: null, conflictAgents: [], db: null, harness: [], help: false, identity: null, offline: false, reverse: false, sample: 10},
        valueOf = index => {
            const value = argv[index];

            if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
                throw new Error(`${argv[index - 1]} expects a value`)
            }

            return value
        };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];

        if (arg === '--apply') {
            options.apply = true
        } else if (arg === '--reverse') {
            options.reverse = true
        } else if (arg === '--offline') {
            options.offline = true
        } else if (arg === '--identity') {
            options.identity = normalizeAgentIdentityNodeId(valueOf(++index))
        } else if (arg === '--alias') {
            options.aliases.push(normalizeAgentIdentityNodeId(valueOf(++index)))
        } else if (arg === '--harness') {
            options.harness.push(valueOf(++index))
        } else if (arg === '--agent') {
            options.agents.push(valueOf(++index).trim())
        } else if (arg === '--conflict-agent') {
            options.conflictAgents.push(valueOf(++index).trim())
        } else if (arg === '--before') {
            const
                before   = valueOf(++index).trim(),
                beforeMs = timestampMs(before);

            if (!Number.isFinite(beforeMs)) {
                throw new Error('--before expects an ISO-8601 timestamp or epoch milliseconds')
            }

            options.before   = before;
            options.beforeMs = beforeMs
        } else if (arg === '--db') {
            options.db = path.resolve(valueOf(++index))
        } else if (arg === '--sample') {
            const sample = Number(valueOf(++index));

            if (!Number.isInteger(sample) || sample < 0) {
                throw new Error('--sample expects a non-negative integer')
            }

            options.sample = sample
        } else if (arg === '--help' || arg === '-h') {
            options.help = true
        } else {
            throw new Error(`unknown argument: ${arg}`)
        }
    }

    return options
}

/**
 * @summary Refuses a run without a direct identity, and a write that is not acknowledged as offline.
 * @param {Object} options {@link parseArgs}'s options
 * @returns {void}
 */
export function assertPosture(options) {
    if (typeof options.identity !== 'string' || options.identity === '@' || options.identity.includes(':')) {
        throw new Error('--identity expects a direct agent identity')
    }

    if (options.apply && options.reverse) {
        throw new Error('--apply and --reverse exclude each other')
    }

    if ((options.apply || options.reverse) && !options.offline) {
        throw new Error('writes require --offline after every Memory Core graph writer is stopped')
    }
}

/**
 * @summary The trusted envelope prefix of a prompt: its opening, after leading whitespace and the harness envelope
 * line when it opens with one (the Gemini CLI's `<session_context>`). A harness injects its session marker there,
 * and the wake daemon its header. The same text anywhere else in the prompt, the thought or the response is quoted
 * content, and so is text behind any other opening tag, such as `<example>` or `<blockquote>`.
 * @param {*} prompt
 * @returns {String}
 */
export function envelopeOf(prompt) {
    const
        text    = typeof prompt === 'string' ? prompt.trimStart() : '',
        wrapper = ENVELOPE_LINE.exec(text);

    return wrapper ? text.slice(wrapper[0].length).trimStart() : text
}

/**
 * @summary What one unattributed row's own envelope and metadata say about its author.
 * @param {Object} metadata The row's Chroma metadata
 * @param {Object} rules
 * @param {Set<String>} rules.identities The identity and its aliases, as node ids
 * @param {String[]} [rules.markers=[]] The harness markers
 * @param {String[]} [rules.agents=[]] Positive metadata.agent labels
 * @param {String[]} [rules.conflictAgents=[]] Conflicting metadata.agent labels
 * @param {String|Number|null} [rules.before=null] Cutoff label for before-cutoff evidence
 * @param {Number|null} [rules.cutoffMs=null] Parsed cutoff epoch milliseconds
 * @returns {{evidence: String, rule: String}|{conflict: String}|null}
 */
export function rowEvidence(metadata, {agents = [], before = null, conflictAgents = [], cutoffMs = null, identities, markers = []}) {
    const
        envelope  = envelopeOf(metadata?.prompt),
        wake      = WAKE_HEADER.exec(envelope),
        addressee = wake ? normalizeAgentIdentityNodeId(wake[1]) : null,
        agent     = typeof metadata?.agent === 'string' ? metadata.agent.trim() : '';

    if (addressee && !identities.has(addressee)) {
        return {conflict: `wake for ${addressee}`}
    }

    if (agent && conflictAgents.includes(agent)) {
        return {conflict: `agent ${agent}`}
    }

    const marker = markers.find(value => envelope.startsWith(value));

    if (marker) {
        return {evidence: marker, rule: 'harness-marker'}
    }

    if (addressee) {
        return {evidence: addressee, rule: 'wake-addressee'}
    }

    if (agent && agents.includes(agent)) {
        return {evidence: agent, rule: 'agent-field'}
    }

    if (!agent && cutoffMs !== null && Number.isFinite(cutoffMs)) {
        const rowMs = timestampMs(metadata?.timestamp);

        if (Number.isFinite(rowMs) && rowMs < cutoffMs) {
            return {evidence: String(before ?? cutoffMs), rule: 'before-cutoff'}
        }
    }

    return null
}

/**
 * @summary Plans the attribution over every raw-memory row, without writing. Rows an earlier apply attributed to
 * the identity form the journal; they are evidence for their sessions and are never planned again.
 * @param {Object} options
 * @param {Object[]} options.rows Every raw-memory row, `{id, metadata}`
 * @param {String} options.identity
 * @param {String[]} [options.aliases=[]]
 * @param {String[]} [options.harness=[]] The harness markers
 * @param {String[]} [options.agents=[]] Positive metadata.agent labels
 * @param {String[]} [options.conflictAgents=[]] Conflicting metadata.agent labels
 * @param {String|Number|null} [options.before=null] Cutoff timestamp for single-agent founding era
 * @param {Number|null} [options.beforeMs=null] Parsed cutoff epoch ms
 * @returns {{attribute: Object[], identity: String, journal: Object[], leftShared: Object[], userId: String, userIds: Set<String>}}
 */
export function planAttribution({rows, identity, agents = [], aliases = [], before = null, beforeMs = null, conflictAgents = [], harness = []}) {
    const
        target     = normalizeAgentIdentityNodeId(identity),
        identities = new Set([target, ...aliases.map(normalizeAgentIdentityNodeId)]),
        userIds    = new Set([...identities].map(id => id.slice(1))),
        cutoffMs   = beforeMs ?? (before == null ? null : timestampMs(before)),
        sessions   = new Map(),
        attribute  = [],
        journal    = [],
        leftShared = [],
        byId       = (left, right) => left.id.localeCompare(right.id);

    if (before != null && !Number.isFinite(cutoffMs)) {
        throw new Error('--before expects an ISO-8601 timestamp or epoch milliseconds')
    }

    for (const {id, metadata = {}} of rows) {
        const
            sessionId = metadata.sessionId == null ? '' : String(metadata.sessionId).trim(),
            // a row without a session is its own group, keyed apart from every real session
            key       = sessionId ? `session:${sessionId}` : `row:${id}`,
            owner     = metadata.agentIdentity ? normalizeAgentIdentityNodeId(metadata.agentIdentity) : null;

        sessions.has(key) || sessions.set(key, {candidates: [], conflicts: new Set(), evidence: [], label: sessionId || `row:${id}`});

        const session = sessions.get(key);

        if (owner) {
            if (!identities.has(owner)) {
                session.conflicts.add(`row of ${owner}`)
            } else {
                session.evidence.push(id);
                owner === target && metadata.attributionRule && journal.push({id, metadata})
            }
        } else if (userIds.has(metadata.userId)) {
            const evidence = {evidence: metadata.userId, rule: 'user-id'};

            session.evidence.push(id);
            session.candidates.push({evidence, id, metadata})
        } else if (metadata.userId === SHARED_USER_ID) {
            const evidence = rowEvidence(metadata, {agents, before, conflictAgents, cutoffMs, identities, markers: harness});

            evidence?.conflict && session.conflicts.add(evidence.conflict);
            evidence?.rule && session.evidence.push(id);
            session.candidates.push({evidence: evidence?.rule ? evidence : null, id, metadata})
        } else if (typeof metadata.userId === 'string' && metadata.userId.trim() !== '') {
            session.conflicts.add(`userId ${metadata.userId.trim()}`)
        }
    }

    for (const [, session] of [...sessions].sort(([left], [right]) => left.localeCompare(right))) {
        if (!session.candidates.length) {
            continue
        }

        if (session.conflicts.size || !session.evidence.length) {
            leftShared.push(session.conflicts.size
                ? {conflicts: [...session.conflicts].sort(), reason: 'conflict', rows: session.candidates.length, session: session.label}
                : {reason: 'no-evidence', rows: session.candidates.length, session: session.label});
            continue
        }

        const anchor = session.evidence.sort()[0];

        for (const {evidence, id, metadata} of session.candidates) {
            attribute.push({evidence: evidence?.evidence ?? anchor, id, metadata, rule: evidence?.rule ?? 'session'})
        }
    }

    return {attribute: attribute.sort(byId), identity: target, journal: journal.sort(byId), leftShared, userId: target.slice(1), userIds}
}

/**
 * @summary The dry-run report: rows per rule, what stays shared and why, and a sample spread across the planned
 * rows for the reviewer.
 * @param {Object} plan {@link planAttribution}'s plan
 * @param {Object} [options]
 * @param {Number} [options.sample=10]
 * @returns {Object}
 */
export function reportPlan(plan, {sample = 10} = {}) {
    const
        byRule  = {},
        shared  = {conflict: {rows: 0, sessions: 0}, 'no-evidence': {rows: 0, sessions: 0}},
        ordered = [...plan.attribute].sort((left, right) => (timestampMs(left.metadata.timestamp) || 0) - (timestampMs(right.metadata.timestamp) || 0)),
        step    = Math.max(1, Math.floor(ordered.length / Math.max(1, sample)));

    plan.attribute.forEach(({rule}) => { byRule[rule] = (byRule[rule] ?? 0) + 1 });
    plan.leftShared.forEach(({reason, rows}) => { shared[reason].rows += rows; shared[reason].sessions++ });

    return {
        identity         : plan.identity,
        userId           : plan.userId,
        attributed       : {byRule, rows: plan.attribute.length, sessions: new Set(plan.attribute.map(({id, metadata}) => metadata.sessionId ?? `row:${id}`)).size},
        alreadyAttributed: plan.journal.length,
        leftShared       : shared,
        conflicts        : plan.leftShared.filter(({reason}) => reason === 'conflict').slice(0, sample),
        sample           : ordered.filter((row, index) => index % step === 0).slice(0, sample).map(({evidence, id, metadata, rule}) => {
            const ms = timestampMs(metadata.timestamp);

            return {
                at       : Number.isFinite(ms) ? new Date(ms).toISOString() : null,
                evidence,
                id,
                prompt   : String(metadata.prompt ?? '').replace(/\s+/g, ' ').slice(0, 120),
                rule,
                sessionId: metadata.sessionId ?? null
            }
        })
    }
}

/**
 * @summary Reads one graph projection of a raw memory: its owner column and its two identity properties.
 * @param {Object} db better-sqlite3 connection
 * @param {String} id The row id
 * @param {Boolean} [legacy=false] Read the row's Chroma-backed `memory:<uuid>` node instead of its `AGENT_MEMORY` node
 * @returns {{agentIdentity: String|null, propertyUserId: String|null, userId: String|null}|null} `null` when the
 * graph holds no such projection
 */
function readGraphOwner(db, id, legacy = false) {
    const row = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get(legacy ? legacyRawMemoryGraphId(id) : id);

    if (!row) {
        return null
    }

    const data = JSON.parse(row.data);

    // a `memory:<uuid>` node without the row's `chromaId` is curated ontology, never a projection
    return (legacy ? data.label === LEGACY_RAW_MEMORY_NODE_LABEL && data.properties?.chromaId === id : data.label === RAW_MEMORY_NODE_LABEL)
        ? {agentIdentity: data.properties?.agentIdentity ?? null, propertyUserId: data.properties?.userId ?? null, userId: row.user_id ?? null}
        : null
}

/**
 * @param {Object} left
 * @param {Object} right
 * @returns {Boolean}
 */
function sameOwner(left, right) {
    return left.agentIdentity === right.agentIdentity && left.propertyUserId === right.propertyUserId && left.userId === right.userId
}

/**
 * @summary Sets a graph projection's owner column and identity properties; a `null` property is deleted.
 * @param {Object} db better-sqlite3 connection
 * @param {String} id The row id
 * @param {{agentIdentity: String|null, propertyUserId: String|null, userId: String|null}} owner
 * @param {Boolean} [legacy=false] Write the row's legacy projection
 * @returns {String} `updated`, `unchanged` or `missing`
 */
function writeGraphOwner(db, id, owner, legacy = false) {
    const current = readGraphOwner(db, id, legacy);

    if (!current) {
        return 'missing'
    }

    if (sameOwner(current, owner)) {
        return 'unchanged'
    }

    const
        nodeId     = legacy ? legacyRawMemoryGraphId(id) : id,
        data       = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(nodeId).data),
        properties = {...data.properties};

    owner.agentIdentity  === null ? delete properties.agentIdentity : properties.agentIdentity = owner.agentIdentity;
    owner.propertyUserId === null ? delete properties.userId        : properties.userId        = owner.propertyUserId;

    db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?').run(owner.userId, JSON.stringify({...data, properties}), nodeId);

    return 'updated'
}

/**
 * @summary Moves a row's legacy projection from one owner to the other; one that holds neither is refused, never
 * overwritten.
 * @param {Object} db better-sqlite3 connection
 * @param {String} id The row id
 * @param {Object} from The owner the projection holds before the move
 * @param {Object} to
 * @returns {String} `updated`, `unchanged`, `missing` or `refused`
 */
function moveLegacyProjection(db, id, from, to) {
    const current = readGraphOwner(db, id, true);

    return current && !sameOwner(current, from) && !sameOwner(current, to) ? 'refused' : writeGraphOwner(db, id, to, true)
}

/**
 * @summary The prior owner an apply moves a row's legacy projection from: journaled by an earlier run, or the shared /
 * pre-identity mirror the projection still holds, which this run journals. Only an owner the journal records is ever restored.
 * @param {Object} db better-sqlite3 connection
 * @param {{id: String, metadata: Object}} row
 * @param {Object} owner The identity's owner
 * @param {Set<String>} [userIds] The identity's and aliases' userIds
 * @returns {{journaled: Boolean, prior: Object}|String} the prior; else `missing`, `held` (the identity's before any
 * run, so nothing to move) or `refused` (another owner)
 */
function legacyPriorOf(db, {id, metadata}, owner, userIds = new Set()) {
    const journaled = JSON.parse(metadata.attributionLegacyPrior ?? 'null');

    if (journaled) {
        return {journaled: true, prior: journaled}
    }

    const
        current      = readGraphOwner(db, id, true),
        unattributed = current && current.agentIdentity === null && current.userId === current.propertyUserId
            && (current.userId === SHARED_USER_ID || userIds.has(current.userId));

    return !current ? 'missing'
        : sameOwner(current, SHARED_OWNER) ? {journaled: false, prior: SHARED_OWNER}
        : unattributed ? {journaled: false, prior: current}
        : sameOwner(current, owner) ? 'held' : 'refused'
}

/**
 * @param {Object} collection Chroma collection
 * @param {Object[]} rows `{id, metadata}`
 * @param {Number} batchSize
 * @returns {Promise<void>}
 */
async function updateChroma(collection, rows, batchSize) {
    for (let index = 0; index < rows.length; index += batchSize) {
        const batch = rows.slice(index, index + batchSize);

        await collection.update({ids: batch.map(({id}) => id), metadatas: batch.map(({metadata}) => metadata)})
    }
}

/**
 * @summary Applies a plan. Chroma takes each row with its journal first; then every journaled graph node is re-keyed
 * in one transaction, including the rows of an earlier, interrupted run.
 * @param {Object} options
 * @param {Object} options.collection Chroma collection
 * @param {Object} options.db better-sqlite3 connection
 * @param {Object} options.plan {@link planAttribution}'s plan
 * @param {Number} [options.batchSize=200]
 * @returns {Promise<{chromaUpdated: Number, graphMissing: Number, graphUpdated: Number, legacyRefused: Number, legacyUpdated: Number}>}
 * `graphMissing` counts rows without an `AGENT_MEMORY` node; `legacy*` counts their `memory:<uuid>` projections
 */
export async function applyAttribution({batchSize = BATCH_SIZE, collection, db, plan}) {
    const
        owner   = {agentIdentity: plan.identity, propertyUserId: plan.userId, userId: plan.userId},
        userIds = plan.userIds || new Set([plan.userId]),
        counts  = {missing: 0, unchanged: 0, updated: 0},
        legacy  = {missing: 0, refused: 0, unchanged: 0, updated: 0},
        moves   = new Map(),
        // the journal entry for a legacy prior this run records; `null` when there is none to record
        legacyJournal = row => {
            const found = legacyPriorOf(db, row, owner, userIds);

            if (typeof found === 'string') {
                found === 'refused' && legacy.refused++;
                return null
            }

            moves.set(row.id, found.prior);

            return found.journaled ? null : {attributionLegacyPrior: JSON.stringify(found.prior)}
        },
        updates = [
            ...plan.attribute.map(({evidence, id, metadata, rule}) => ({
                id,
                metadata: {
                    ...metadata,
                    agentIdentity      : plan.identity,
                    attributionEvidence: evidence,
                    attributionPrior   : JSON.stringify(readGraphOwner(db, id)),
                    ...(metadata.userId && metadata.userId !== SHARED_USER_ID ? {attributionPriorUserId: metadata.userId} : {}),
                    attributionRule: rule,
                    userId         : plan.userId,
                    ...legacyJournal({id, metadata})
                }
            })),
            // an attributed row whose legacy projection an earlier run left behind journals it now
            ...plan.journal.flatMap(row => {
                const entry = legacyJournal(row);

                return entry ? [{id: row.id, metadata: {...row.metadata, ...entry}}] : []
            })
        ];

    await updateChroma(collection, updates, batchSize);

    db.transaction(() => {
        for (const {id} of [...plan.journal, ...plan.attribute]) {
            counts[writeGraphOwner(db, id, owner)]++
        }

        for (const [id, prior] of moves) {
            legacy[moveLegacyProjection(db, id, prior, owner)]++
        }
    })();

    return {chromaUpdated: updates.length, graphMissing: counts.missing, graphUpdated: counts.updated, legacyRefused: legacy.refused, legacyUpdated: legacy.updated}
}

/**
 * @summary Restores every row an apply attributed to the identity: the graph from each row's journal first, then
 * the prior Chroma state. A reverse that stops between the two completes on its next run. A row whose journaled
 * legacy projection is refused stays attributed, journal included, until a retry can restore it.
 * @param {Object} options
 * @param {Object} options.collection Chroma collection
 * @param {Object} options.db better-sqlite3 connection
 * @param {String} options.identity
 * @param {Object[]} options.rows Every raw-memory row, `{id, metadata}`
 * @param {Number} [options.batchSize=200]
 * @returns {Promise<{chromaRestored: Number, graphRestored: Number, legacyRefused: Number, legacyRestored: Number}>}
 */
export async function reverseAttribution({batchSize = BATCH_SIZE, collection, db, identity, rows}) {
    const
        target  = normalizeAgentIdentityNodeId(identity),
        owner   = {agentIdentity: target, propertyUserId: target.slice(1), userId: target.slice(1)},
        journal = rows.filter(({metadata = {}}) => metadata.attributionRule && normalizeAgentIdentityNodeId(metadata.agentIdentity) === target),
        legacy  = {missing: 0, refused: 0, unchanged: 0, updated: 0},
        kept    = new Set();

    let graphRestored = 0;

    db.transaction(() => {
        for (const {id, metadata} of journal) {
            const
                legacyPrior = JSON.parse(metadata.attributionLegacyPrior ?? 'null'),
                outcome     = legacyPrior ? moveLegacyProjection(db, id, owner, legacyPrior) : null;

            // a journaled projection holding a third owner, or gone onto the canonical id, keeps its row attributed
            if (outcome === 'refused' || outcome === 'missing') {
                legacy.refused++;
                kept.add(id);
                continue
            }

            outcome && legacy[outcome]++;

            const prior = JSON.parse(metadata.attributionPrior ?? 'null');

            prior && writeGraphOwner(db, id, prior) === 'updated' && graphRestored++
        }
    })();

    const restored = journal.filter(({id}) => !kept.has(id)).map(({id, metadata}) => ({
        id,
        metadata: {
            ...metadata,
            agentIdentity         : null,
            attributionEvidence   : null,
            attributionLegacyPrior: null,
            attributionPrior      : null,
            attributionPriorUserId: null,
            attributionRule       : null,
            userId                : metadata.attributionPriorUserId || SHARED_USER_ID
        }
    }));

    await updateChroma(collection, restored, batchSize);

    return {chromaRestored: restored.length, graphRestored, legacyRefused: legacy.refused, legacyRestored: legacy.updated}
}

/**
 * @summary Scans every raw-memory row; an absent `agentIdentity` cannot be expressed by a where filter.
 * @param {Object} collection Chroma collection
 * @returns {Promise<Object[]>} `{id, metadata}`
 */
export async function scanRows(collection) {
    const rows = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await collection.get({include: ['metadatas'], limit: PAGE_SIZE, offset});

        if (!page?.ids?.length) {
            return rows
        }

        rows.push(...page.ids.map((id, index) => ({id, metadata: page.metadatas?.[index] || {}})))
    }
}

/**
 * @returns {Promise<void>}
 */
async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        console.log(USAGE);
        return
    }

    assertPosture(options);

    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');

    const
        {default: aiConfig} = await import('../../mcp/server/memory-core/config.mjs'),
        {ChromaClient}      = await import('chromadb'),
        {
            createDynamicTextEmbeddingFunction,
            registerNeoChromaEmbeddingFunctions
        }                   = await import('../../services/shared/vector/chromaClientPrimitives.mjs'),
        Database            = (await import('better-sqlite3')).default,
        dbPath              = options.db || aiConfig.storagePaths.graph,
        chroma              = aiConfig.engines.chroma;

    registerNeoChromaEmbeddingFunctions();

    const
        client     = new ChromaClient({
            host    : chroma.host,
            port    : chroma.port,
            ssl     : false,
            database: chroma.useTestDatabase ? chroma.databaseTest : chroma.database
        }),
        collection = await client.getCollection({
            name             : aiConfig.collections.memory,
            embeddingFunction: createDynamicTextEmbeddingFunction({
                providerResolver: () => aiConfig.embeddingProvider,
                service         : 'memory-core'
            })
        }),
        rows       = await scanRows(collection),
        plan       = options.reverse ? null : planAttribution({
            agents        : options.agents,
            aliases       : options.aliases,
            before        : options.before,
            beforeMs      : options.beforeMs,
            conflictAgents: options.conflictAgents,
            harness       : options.harness,
            identity      : options.identity,
            rows
        });

    // a dry run plans from Chroma alone; only a write opens the graph
    if (!options.apply && !options.reverse) {
        console.log(JSON.stringify({mode: 'DRY-RUN', ...reportPlan(plan, {sample: options.sample})}, null, 2));
        console.log('DRY-RUN complete. Nothing changed.');
        return
    }

    const db = new Database(dbPath, {fileMustExist: true});

    try {
        let result;

        if (options.reverse) {
            result = await reverseAttribution({collection, db, identity: options.identity, rows});
            console.log(JSON.stringify({mode: 'REVERSE', dbPath, ...result}, null, 2))
        } else {
            console.log(JSON.stringify({mode: 'APPLY', dbPath, ...reportPlan(plan, {sample: options.sample})}, null, 2));
            result = await applyAttribution({collection, db, plan});
            console.log(JSON.stringify(result, null, 2));
            console.log('APPLY complete. Restart Memory Core processes to refresh in-memory graph caches.')
        }

        // a refused projection still holds a foreign owner beside its re-keyed row
        if (result.legacyRefused > 0) {
            process.exitCode = 1
        }
    } finally {
        db.close()
    }
}

if (isEntryModule(import.meta.url)) {
    main().catch(error => {
        console.error(`attributePreIdentityMemories failed: ${error.message}`);
        process.exitCode = 1
    })
}
