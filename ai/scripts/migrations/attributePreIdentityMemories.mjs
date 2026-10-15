#!/usr/bin/env node
/**
 * @module ai/scripts/migrations/attributePreIdentityMemories
 * @summary Attributes a returning agent's pre-identity raw memories to it, on recorded evidence only.
 * Dry-run by default; `--apply --offline` re-keys the matched rows in Chroma and the graph, and
 * `--reverse --offline` restores exactly what an apply re-keyed.
 *
 * Rows written before writes carried an identity hold `userId: 'shared'` and no `agentIdentity`
 * (`backfillChromaSharedUserId.mjs` gave them the shared tag). The team still reads them, but nothing ties
 * them to their author, so identity-scoped recall and summaries miss them.
 *
 * The operator names the identity, its aliases and its harness markers. A row is attributed by one rule:
 * - `harness-marker`: its prompt opens with a harness marker at the trusted envelope prefix
 *   ({@link envelopeOf}). A marker quoted anywhere else is content, never evidence.
 * - `wake-addressee`: its prompt opens with a wake header addressed to the identity or an alias.
 * - `session`: it shares a session with a row attributed by either rule, or with a row already attributed
 *   to the identity or an alias.
 *
 * A session holding a row of another identity, or a wake addressed to one, stays shared as a whole, and so
 * does every row without evidence. A row without a session, or with an empty one, carries only its own evidence.
 *
 * Each re-keyed Chroma row records its rule, its evidence and the graph state it replaced (`attributionRule`,
 * `attributionEvidence`, `attributionPrior`). That record is the journal. An apply writes Chroma first and then
 * re-keys every journaled graph node in one SQLite transaction, so a re-run completes an interrupted apply.
 * `--reverse` restores the graph from the journal before it clears the journal in Chroma. One transaction across
 * both stores is impossible; this is the bounded form of atomic that `reconcileRawMemoryGraphIdentities.mjs` uses.
 *
 * Usage:
 *   node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> [--alias <id>]... [--harness <marker>]...
 *   node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> [...] --apply --offline
 *   node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> --reverse --offline
 *
 * Writes are offline: stop every Memory Core process that can write or cache the graph, run, then restart them.
 */

import path                           from 'node:path';
import {fileURLToPath}                from 'node:url';
import {normalizeAgentIdentityNodeId} from '../../graph/normalizeAgentIdentityNodeId.mjs';
import {RAW_MEMORY_NODE_LABEL}        from '../../services/memory-core/helpers/rawMemoryGraphIdentity.mjs';

const
    BATCH_SIZE     = 200,
    PAGE_SIZE      = 2000,
    SHARED_USER_ID = 'shared',
    // the one wrapper a harness is known to open a session with: the Gemini CLI's `<session_context>` line
    ENVELOPE_LINE  = /^<session_context>[ \t]*\r?\n/,
    // the wake digest header: `[WAKE][priority:high] 3 events for @neo-gpt: …`
    WAKE_HEADER    = /^\[WAKE\](?:\[priority:[\w-]+\])?\s+\d+\s+events?\s+for\s+(@?[\w.-]+):/,
    USAGE          = `Usage: node ai/scripts/migrations/attributePreIdentityMemories.mjs --identity <id> [options]

Options:
  --identity <id>     The agent whose pre-identity rows are attributed (required)
  --alias <id>        Another name the agent's rows and wakes were written under (repeatable)
  --harness <marker>  A harness session marker, as it opens the prompt (repeatable)
  --apply             Re-key the matched rows (requires --offline)
  --reverse           Restore every row an apply attributed to the identity (requires --offline)
  --offline           Acknowledge that every Memory Core graph writer is stopped
  --db <path>         Override the SQLite graph path
  --sample <n>        Rows to show in the dry-run sample (default 10)
  --help              Show this help`;

/**
 * @summary Parses the CLI flags. Aliases and harness markers repeat.
 * @param {String[]} argv The arguments after the script path.
 * @returns {{aliases: String[], apply: Boolean, db: String|null, harness: String[], help: Boolean, identity: String|null, offline: Boolean, reverse: Boolean, sample: Number}}
 */
export function parseArgs(argv) {
    const
        options = {aliases: [], apply: false, db: null, harness: [], help: false, identity: null, offline: false, reverse: false, sample: 10},
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
 * @summary What one unattributed row's own envelope says about its author.
 * @param {Object} metadata The row's Chroma metadata
 * @param {Object} rules
 * @param {Set<String>} rules.identities The identity and its aliases, as node ids
 * @param {String[]} rules.markers The harness markers
 * @returns {{evidence: String, rule: String}|{conflict: String}|null}
 */
export function rowEvidence(metadata, {identities, markers}) {
    const
        envelope = envelopeOf(metadata?.prompt),
        marker   = markers.find(value => envelope.startsWith(value));

    if (marker) {
        return {evidence: marker, rule: 'harness-marker'}
    }

    const wake = WAKE_HEADER.exec(envelope);

    if (wake) {
        const addressee = normalizeAgentIdentityNodeId(wake[1]);

        return identities.has(addressee) ? {evidence: addressee, rule: 'wake-addressee'} : {conflict: `wake for ${addressee}`}
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
 * @returns {{attribute: Object[], identity: String, journal: Object[], leftShared: Object[], userId: String}}
 */
export function planAttribution({rows, identity, aliases = [], harness = []}) {
    const
        target     = normalizeAgentIdentityNodeId(identity),
        identities = new Set([target, ...aliases.map(normalizeAgentIdentityNodeId)]),
        sessions   = new Map(),
        attribute  = [],
        journal    = [],
        leftShared = [],
        byId       = (left, right) => left.id.localeCompare(right.id);

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
        } else if (metadata.userId === SHARED_USER_ID) {
            const evidence = rowEvidence(metadata, {identities, markers: harness});

            evidence?.conflict && session.conflicts.add(evidence.conflict);
            evidence?.rule && session.evidence.push(id);
            session.candidates.push({evidence: evidence?.rule ? evidence : null, id, metadata})
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

    return {attribute: attribute.sort(byId), identity: target, journal: journal.sort(byId), leftShared, userId: target.slice(1)}
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
        ordered = [...plan.attribute].sort((left, right) => (left.metadata.timestamp ?? 0) - (right.metadata.timestamp ?? 0)),
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
        sample           : ordered.filter((row, index) => index % step === 0).slice(0, sample).map(({evidence, id, metadata, rule}) => ({
            at       : Number.isFinite(metadata.timestamp) ? new Date(metadata.timestamp).toISOString() : null,
            evidence,
            id,
            prompt   : String(metadata.prompt ?? '').replace(/\s+/g, ' ').slice(0, 120),
            rule,
            sessionId: metadata.sessionId ?? null
        }))
    }
}

/**
 * @summary Reads a raw-memory node's owner column and its two identity properties.
 * @param {Object} db better-sqlite3 connection
 * @param {String} id
 * @returns {{agentIdentity: String|null, propertyUserId: String|null, userId: String|null}|null} `null` when the
 * graph holds no raw-memory node of that id
 */
function readGraphOwner(db, id) {
    const row = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get(id);

    if (!row) {
        return null
    }

    const data = JSON.parse(row.data);

    return data.label === RAW_MEMORY_NODE_LABEL
        ? {agentIdentity: data.properties?.agentIdentity ?? null, propertyUserId: data.properties?.userId ?? null, userId: row.user_id ?? null}
        : null
}

/**
 * @summary Sets a raw-memory node's owner column and identity properties; a `null` property is deleted.
 * @param {Object} db better-sqlite3 connection
 * @param {String} id
 * @param {{agentIdentity: String|null, propertyUserId: String|null, userId: String|null}} owner
 * @returns {String} `updated`, `unchanged` or `missing`
 */
function writeGraphOwner(db, id, owner) {
    const current = readGraphOwner(db, id);

    if (!current) {
        return 'missing'
    }

    if (current.agentIdentity === owner.agentIdentity && current.propertyUserId === owner.propertyUserId && current.userId === owner.userId) {
        return 'unchanged'
    }

    const
        data       = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id).data),
        properties = {...data.properties};

    owner.agentIdentity  === null ? delete properties.agentIdentity : properties.agentIdentity = owner.agentIdentity;
    owner.propertyUserId === null ? delete properties.userId        : properties.userId        = owner.propertyUserId;

    db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?').run(owner.userId, JSON.stringify({...data, properties}), id);

    return 'updated'
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
 * @returns {Promise<{chromaUpdated: Number, graphMissing: Number, graphUpdated: Number}>}
 */
export async function applyAttribution({batchSize = BATCH_SIZE, collection, db, plan}) {
    const
        owner   = {agentIdentity: plan.identity, propertyUserId: plan.userId, userId: plan.userId},
        updates = plan.attribute.map(({evidence, id, metadata, rule}) => ({
            id,
            metadata: {
                ...metadata,
                agentIdentity      : plan.identity,
                attributionEvidence: evidence,
                attributionPrior   : JSON.stringify(readGraphOwner(db, id)),
                attributionRule    : rule,
                userId             : plan.userId
            }
        })),
        counts  = {missing: 0, unchanged: 0, updated: 0};

    await updateChroma(collection, updates, batchSize);

    db.transaction(() => {
        for (const {id} of [...plan.journal, ...updates]) {
            counts[writeGraphOwner(db, id, owner)]++
        }
    })();

    return {chromaUpdated: updates.length, graphMissing: counts.missing, graphUpdated: counts.updated}
}

/**
 * @summary Restores every row an apply attributed to the identity: the graph from each row's journal first, then
 * the shared Chroma state. A reverse that stops between the two completes on its next run.
 * @param {Object} options
 * @param {Object} options.collection Chroma collection
 * @param {Object} options.db better-sqlite3 connection
 * @param {String} options.identity
 * @param {Object[]} options.rows Every raw-memory row, `{id, metadata}`
 * @param {Number} [options.batchSize=200]
 * @returns {Promise<{chromaRestored: Number, graphRestored: Number}>}
 */
export async function reverseAttribution({batchSize = BATCH_SIZE, collection, db, identity, rows}) {
    const
        target   = normalizeAgentIdentityNodeId(identity),
        journal  = rows.filter(({metadata = {}}) => metadata.attributionRule && normalizeAgentIdentityNodeId(metadata.agentIdentity) === target),
        restored = journal.map(({id, metadata}) => ({
            id,
            metadata: {...metadata, agentIdentity: null, attributionEvidence: null, attributionPrior: null, attributionRule: null, userId: SHARED_USER_ID}
        }));

    let graphRestored = 0;

    db.transaction(() => {
        for (const {id, metadata} of journal) {
            const prior = JSON.parse(metadata.attributionPrior ?? 'null');

            prior && writeGraphOwner(db, id, prior) === 'updated' && graphRestored++
        }
    })();

    await updateChroma(collection, restored, batchSize);

    return {chromaRestored: restored.length, graphRestored}
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
        plan       = options.reverse ? null : planAttribution({aliases: options.aliases, harness: options.harness, identity: options.identity, rows});

    // a dry run plans from Chroma alone; only a write opens the graph
    if (!options.apply && !options.reverse) {
        console.log(JSON.stringify({mode: 'DRY-RUN', ...reportPlan(plan, {sample: options.sample})}, null, 2));
        console.log('DRY-RUN complete. Nothing changed.');
        return
    }

    const db = new Database(dbPath, {fileMustExist: true});

    try {
        if (options.reverse) {
            console.log(JSON.stringify({mode: 'REVERSE', dbPath, ...await reverseAttribution({collection, db, identity: options.identity, rows})}, null, 2));
            return
        }

        console.log(JSON.stringify({mode: 'APPLY', dbPath, ...reportPlan(plan, {sample: options.sample})}, null, 2));
        console.log(JSON.stringify(await applyAttribution({collection, db, plan}), null, 2));
        console.log('APPLY complete. Restart Memory Core processes to refresh in-memory graph caches.')
    } finally {
        db.close()
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch(error => {
        console.error(`attributePreIdentityMemories failed: ${error.message}`);
        process.exitCode = 1
    })
}
