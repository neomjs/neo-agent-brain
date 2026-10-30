#!/usr/bin/env node
/**
 * @module ai/scripts/maintenance/repairRawMemoryRecencyKeys
 * @summary Projects the recency keys identity recency reads (`agentIdentity`, `timestamp`) onto the
 * raw memories the graph holds without them. Dry run by default; `--apply --offline` writes through
 * `MemorySessionIngestor`, the projection's one owner.
 *
 * Each Chroma row is classified against the graph, from the row itself and never from its session:
 * - **reproject**: its canonical `AGENT_MEMORY` node lacks a recency key the row carries, or holds it
 *   differently. Applied per session through `syncSessionToGraph` with exactly those rows.
 * - **project**: the row carries `agentIdentity` and has no raw-memory node. Applied through
 *   `ingestSingleRow`.
 * - **legacyOnly**: its only node is a legacy `memory:<uuid>` projection. Left to
 *   `reconcileRawMemoryGraphIdentities.mjs`, which converges it onto the canonical id; a later run of
 *   this repair then re-projects it.
 * - **current** and **unattributed** (no node, no identity): nothing to do.
 *
 * A row whose session has no summary row is counted as `noSummary` and left; REM re-projects it once
 * the session is summarized. A re-run after a complete apply plans nothing.
 *
 * Usage:
 *   node ai/scripts/maintenance/repairRawMemoryRecencyKeys.mjs
 *   node ai/scripts/maintenance/repairRawMemoryRecencyKeys.mjs --apply --offline
 *
 * Apply writes the graph from a second process: stop every Memory Core process that holds this
 * SQLite file, run with `--apply --offline`, then restart them.
 */

import {
    carriesRawMemoryRecencyKeys,
    LEGACY_RAW_MEMORY_NODE_LABEL,
    RAW_MEMORY_NODE_LABEL,
    rawMemoryRecencyKeys
} from '../../services/memory-core/helpers/rawMemoryGraphIdentity.mjs';
import {assertApplyPosture, scanChromaRows} from '../migrations/reconcileRawMemoryGraphIdentities.mjs';
import {isEntryModule}                      from '../../services/shared/isEntryModule.mjs';

/**
 * @param {String[]} argv
 * @returns {{apply: Boolean, help: Boolean, offline: Boolean}}
 */
export function parseArgs(argv = []) {
    const options = {apply: false, help: false, offline: false};

    for (const arg of argv) {
        if (arg === '--apply') {
            options.apply = true
        } else if (arg === '--offline') {
            options.offline = true
        } else if (arg === '--help' || arg === '-h') {
            options.help = true
        } else {
            throw new Error(`unknown argument: ${arg}`)
        }
    }

    return options
}

/**
 * @summary Reads what the repair compares rows against: each canonical node's recency keys, and the
 * Chroma ids a legacy `memory:<uuid>` node holds.
 * @param {Object} db better-sqlite3 connection to the graph.
 * @returns {{canonical: Map<String, Object>, legacy: Set<String>}}
 */
export function readRecencyGraphState(db) {
    const canonical = db.prepare(`
        SELECT id,
               json_extract(data, '$.properties.agentIdentity') AS agentIdentity,
               json_extract(data, '$.properties.timestamp')     AS timestamp
        FROM Nodes
        WHERE json_extract(data, '$.label') = ?
    `).all(RAW_MEMORY_NODE_LABEL);

    const legacy = db.prepare(`
        SELECT substr(id, 8) AS chromaId
        FROM Nodes
        WHERE json_extract(data, '$.label') = ?
          AND id LIKE 'memory:%'
    `).all(LEGACY_RAW_MEMORY_NODE_LABEL);

    return {
        canonical: new Map(canonical.map(({id, ...keys}) => [id, keys])),
        legacy   : new Set(legacy.map(row => row.chromaId))
    }
}

/**
 * @summary Classifies every Chroma row against the graph state. Pure.
 * @param {Object} options
 * @param {Object[]} options.chromaRows `{id, metadata}` per raw memory.
 * @param {{canonical: Map<String, Object>, legacy: Set<String>}} options.graph
 * @returns {{counts: Object, project: Object[], reproject: Object[]}}
 */
export function planRecencyRepair({chromaRows, graph}) {
    const
        project   = [],
        reproject = [],
        counts    = {rows: chromaRows.length, current: 0, legacyOnly: 0, unattributed: 0};

    for (const row of chromaRows) {
        const node = graph.canonical.get(row.id);

        if (node) {
            carriesRawMemoryRecencyKeys(node, row.metadata) ? counts.current++ : reproject.push(row)
        } else if (graph.legacy.has(row.id)) {
            counts.legacyOnly++
        } else if (rawMemoryRecencyKeys(row.metadata).agentIdentity) {
            project.push(row)
        } else {
            counts.unattributed++
        }
    }

    return {
        counts: {...counts, project: project.length, reproject: reproject.length},
        project,
        reproject
    }
}

/**
 * @summary Applies a plan through the ingestor. A reprojected row is synced with its session's
 * summary row, so the SESSION node keeps its own payload.
 * @param {Object} plan From {@link planRecencyRepair}.
 * @param {Object} options
 * @param {Object} options.memoryCollection Chroma memory collection.
 * @param {Object} options.memorySessionIngestor
 * @param {Object} options.summaryCollection Chroma summary collection.
 * @returns {Promise<{failed: Object[], noSummary: Number, projected: Number, reprojected: Number}>}
 */
export async function applyRecencyRepair(plan, {memoryCollection, memorySessionIngestor, summaryCollection}) {
    const result = {failed: [], noSummary: 0, projected: 0, reprojected: 0};

    for (const [sessionId, rows] of Map.groupBy(plan.reproject, row => row.metadata.sessionId)) {
        const summary = sessionId ? await summaryCollection.get({where: {sessionId}, include: ['metadatas']}) : null;

        if (!summary?.ids?.length) {
            result.noSummary += rows.length;
            continue
        }

        const stats = await memorySessionIngestor.syncSessionToGraph({id: summary.ids[0], meta: summary.metadatas[0]}, {
            rawMemories: {ids: rows.map(row => row.id), metadatas: rows.map(row => row.metadata)}
        });

        result.reprojected += stats.memoriesUpserted;
        result.failed.push(...stats.errors.map(error => ({sessionId, error})))
    }

    for (const row of plan.project) {
        const outcome = await memorySessionIngestor.ingestSingleRow(`memory:${row.id}`, {memoryCollection, summaryCollection});

        if (outcome.reason === 'backfilled') {
            result.projected++
        } else {
            result.failed.push({id: row.id, reason: outcome.reason, error: outcome.error})
        }
    }

    return result
}

/**
 * @summary The read-only runtime of a dry run: an existing Chroma collection and a read-only SQLite
 * handle, so neither store is written. A missing collection refuses the run.
 * @returns {Promise<Object>}
 */
export async function createDryRunRuntime() {
    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');

    const {default: aiConfig}      = await import('../../mcp/server/memory-core/config.mjs');
    const {default: ChromaManager} = await import('../../services/memory-core/managers/ChromaManager.mjs');
    const {default: Database}      = await import('better-sqlite3');

    await ChromaManager.ready();

    const
        memoryCollection = await ChromaManager.openExistingCollection(aiConfig.collections.memory),
        graphDb          = new Database(aiConfig.storagePaths.graph, {fileMustExist: true, readonly: true});

    return {
        graphDb,
        memoryCollection,
        cleanup() {
            graphDb.close()
        }
    }
}

/**
 * @summary The writable runtime of an apply, where GraphService and MemorySessionIngestor write.
 * @returns {Promise<Object>}
 */
export async function createApplyRuntime() {
    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');

    const {
        Memory_GraphService    : GraphService,
        Memory_LifecycleService: LifecycleService,
        Memory_StorageRouter   : StorageRouter
    } = await import('../../services.mjs');
    const {default: MemorySessionIngestor} = await import('../../services/ingestion/MemorySessionIngestor.mjs');

    await LifecycleService.ready();
    await GraphService.ready();
    await StorageRouter.ready();

    const graphDb = GraphService.db?.storage?.db;

    if (!graphDb) {
        throw new Error('GraphService SQLite database is unavailable; cannot repair the recency keys.')
    }

    return {
        graphDb,
        memoryCollection     : await StorageRouter.getMemoryCollection(),
        memorySessionIngestor: MemorySessionIngestor,
        summaryCollection    : await StorageRouter.getSummaryCollection()
    }
}

/**
 * @param {String[]} [argv=process.argv.slice(2)]
 * @param {Object} [deps]
 * @param {Function} [deps.runtimeFactory] Receives the parsed options.
 * @param {Function} [deps.stdout]
 * @param {Function} [deps.stderr]
 * @returns {Promise<Number>} 0 on success, 1 when a row failed, 2 when the run could not complete.
 */
export async function runCli(argv = process.argv.slice(2), {
    runtimeFactory = options => options.apply ? createApplyRuntime() : createDryRunRuntime(),
    stdout         = console.log,
    stderr         = console.error
} = {}) {
    let runtime;

    try {
        const options = parseArgs(argv);

        if (options.help) {
            stdout('node ai/scripts/maintenance/repairRawMemoryRecencyKeys.mjs [--apply --offline]');
            return 0
        }

        assertApplyPosture(options);
        runtime = await runtimeFactory(options);

        const
            plan    = planRecencyRepair({chromaRows: await scanChromaRows(runtime.memoryCollection), graph: readRecencyGraphState(runtime.graphDb)}),
            applied = options.apply ? await applyRecencyRepair(plan, runtime) : null;

        stdout(JSON.stringify({mode: options.apply ? 'apply' : 'dry-run', counts: plan.counts, ...(applied ? {applied} : {})}, null, 2));

        return applied?.failed.length ? 1 : 0
    } catch (error) {
        stderr(`[repairRawMemoryRecencyKeys] ${error.message}`);
        return 2
    } finally {
        runtime?.cleanup?.()
    }
}

if (isEntryModule(import.meta.url)) {
    runCli().then(code => process.exit(code))
}
