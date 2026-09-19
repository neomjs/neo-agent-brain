import {Command}                      from 'commander';
import {execSync}                     from 'child_process';
import crypto                         from 'crypto';
import fs                             from 'fs-extra';
import path                           from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import Neo                            from 'neo.mjs/src/Neo.mjs';
import AiConfig                       from '../../config.mjs';
import {auditChromaVectorCoverage}                                   from './checkChromaIntegrity.mjs';
import {extractMemoryCoreCollectionData} from './repairMemoryCoreStoredEmbeddings.mjs';
import {resolveAutonomousRepairExit}                                 from '../../services/memory-core/helpers/acceptedLossSettlement.mjs';
import {appendAutoAcceptedLoss}                                      from '../../services/memory-core/helpers/acceptedLossAuditStore.mjs';
import {getAcceptedLossAuditFilePath}                                from '../../services/memory-core/helpers/acceptedLossAuditStore.mjs';
import {writeAutoAcceptedLossState}                                  from '../../services/memory-core/helpers/acceptedLossAuditStore.mjs';

/**
 * @summary Explicit-client Chroma repair helpers and an endpoint-only CLI refusal.
 *
 * Physical maintenance needs access to the serving Chroma process's own store.
 * Client host/port/dataDir declarations do not establish that access across a
 * container boundary. The CLI therefore refuses before any lease, snapshot,
 * collection rewrite, filesystem cleanup or VACUUM.
 *
 * Exported repair and legacy-snapshot helpers require caller-owned clients and
 * paths. They are not evidence that this process owns a physical Chroma store.
 * Portable JSONL backup remains available through the independent backup.mjs.
 *
 * @module ai.scripts.maintenance.defragChromaDB
 * @see ai/scripts/maintenance/backup.mjs
 */

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFRAG_STATE_DIR = path.join(PROJECT_ROOT, '.neo-ai-data', 'maintenance', 'defrag-state');
const ACCEPTED_LOSS_STATE_SCHEMA_VERSION = 1;

// Collection-group adapters expose client coordinates, never physical storage authority.
export const TARGETS = {
    'knowledge-base': {
        configPath: '../../mcp/server/knowledge-base/config.mjs',
        adapt     : (cfg) => ({
            host       : cfg.engines.chroma.host,
            port       : cfg.engines.chroma.port,
            collections: [cfg.collectionName]
        })
    },
    'memory-core'   : {
        configPath: '../../mcp/server/memory-core/config.mjs',
        adapt     : (cfg) => ({
            host             : cfg.engines.chroma.host,
            port             : cfg.engines.chroma.port,
            embeddingProvider: cfg.embeddingProvider,
            collections      : [
                cfg.collections.memory,
                cfg.collections.session,
                cfg.collections.graph
            ].filter(Boolean)
        })
    }
};

/**
 * Resolves defrag snapshot retention from Tier-1 AI maintenance config.
 * @param {Object} [options]
 * @param {Object} [options.aiConfig=AiConfig] Tier-1 AI config.
 * @returns {Object}
 */
export function resolveDefragSnapshotRetention({
    aiConfig = AiConfig
} = {}) {
    return aiConfig.maintenance.defrag.snapshotRetention;
}

/**
 * Creates a Chroma collection name that the KB ChromaManager recognizes as an
 * active swap artifact for `shadow` / `parking` phases.
 *
 * @param {String} collectionName Canonical collection name.
 * @param {String} phase Swap phase suffix.
 * @param {Object} [options]
 * @param {Number} [options.timestamp=Date.now()] Stable run timestamp.
 * @param {String} [options.uuid=crypto.randomUUID()] Unique suffix.
 * @returns {String}
 */
export function createSwapCollectionName(collectionName, phase, {
    timestamp = Date.now(),
    uuid      = crypto.randomUUID()
} = {}) {
    return `${collectionName}-${phase}-${timestamp}-${uuid}`
}

/**
 * Resolves the durable state marker for an in-flight defrag promotion.
 *
 * @param {Object} options
 * @param {String} options.targetName CLI target name.
 * @param {String} [options.projectRoot=PROJECT_ROOT] Repository root.
 * @returns {String}
 */
export function resolveDefragStatePath({
    targetName,
    projectRoot = PROJECT_ROOT
} = {}) {
    const stateDir = projectRoot === PROJECT_ROOT
        ? DEFRAG_STATE_DIR
        : path.join(projectRoot, '.neo-ai-data', 'maintenance', 'defrag-state');

    return path.join(stateDir, `${targetName}.json`)
}

/**
 * Refuses to run over an incomplete previous promotion unless its phase is explicitly resumable.
 *
 * @param {Object} options
 * @param {String} options.statePath State marker path.
 * @param {String[]} [options.allowedPhases=[]] Incomplete phases the caller knows how to resume.
 * @param {Object} [options.fsModule=fs] Filesystem seam.
 * @returns {Promise<Object|undefined>} Existing resumable state, when allowed.
 */
export async function assertNoIncompleteDefragState({statePath, allowedPhases = [], fsModule = fs} = {}) {
    if (!await fsModule.pathExists(statePath)) {
        return
    }

    const state = await fsModule.readJson(statePath);

    if (allowedPhases.includes(state.phase)) {
        return state
    }

    const error = new Error(
        `Incomplete Chroma defrag state found at ${statePath}. ` +
        `Phase '${state.phase}' for target '${state.targetName || 'unknown'}' must be recovered or cleared before rerun.`
    );
    error.code  = 'DEFRAG_INCOMPLETE_STATE';
    error.state = state;
    throw error
}

/**
 * Writes the durable defrag phase marker.
 *
 * @param {Object} options
 * @param {String} options.statePath State marker path.
 * @param {Object} options.state Serializable state payload.
 * @param {Object} [options.fsModule=fs] Filesystem seam.
 * @returns {Promise<void>}
 */
export async function writeDefragState({statePath, state, fsModule = fs} = {}) {
    await fsModule.ensureDir(path.dirname(statePath));
    await fsModule.writeJson(statePath, {
        ...state,
        updatedAt: new Date().toISOString()
    }, {spaces: 2})
}

/**
 * Clears the durable defrag phase marker after canonical validation succeeds.
 *
 * @param {Object} options
 * @param {String} options.statePath State marker path.
 * @param {Object} [options.fsModule=fs] Filesystem seam.
 * @returns {Promise<void>}
 */
export async function clearDefragState({statePath, fsModule = fs} = {}) {
    await fsModule.remove(statePath)
}

/**
 * Manages backup retention.
 * Policy: Keep the newest `keepMinimum` snapshots, delete older extras after `maxDays`.
 *
 * @param {String} backupDir - The directory containing backups.
 * @param {Object} [retention] Retention policy.
 * @param {Number} [retention.keepMinimum=3] Newest snapshots retained unconditionally.
 * @param {Number} [retention.maxDays=7] Extra snapshots older than this are removed.
 */
export async function cleanOldBackups(backupDir, retention = resolveDefragSnapshotRetention()) {
    try {
        if (!await fs.pathExists(backupDir)) return;

        const keepMinimum = Number.isInteger(retention?.keepMinimum) ? retention.keepMinimum : 3;
        const maxDays     = Number.isFinite(retention?.maxDays) ? retention.maxDays : 7;

        const entries = await fs.readdir(backupDir, {withFileTypes: true});
        const backups = entries
            .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
            .map(e => {
                const parts = e.name.split('-');
                // timestamp is the last part
                const timestamp = parseInt(parts[parts.length - 1]);
                return {
                    name: e.name,
                    path: path.join(backupDir, e.name),
                    time: timestamp
                };
            })
            // Filter out any filenames that didn't match the parsing logic
            .filter(b => !isNaN(b.time))
            .sort((a, b) => b.time - a.time); // Newest first

        const toCheck = backups.slice(keepMinimum);
        const cutoff  = Date.now() - (maxDays * 24 * 60 * 60 * 1000);

        for (const backup of toCheck) {
            if (backup.time < cutoff) {
                console.log(`   🗑️  Removing old backup: ${backup.name}`);
                await fs.remove(backup.path);
            }
        }
    } catch (e) {
        console.warn(`   ⚠️  Backup cleanup failed (non-critical): ${e.message}`);
    }
}

/**
 * Resolves the set of live Chroma segment ids registered in a persist dir's
 * `chroma.sqlite3`. On-disk UUID directories are named by *segment* id (VECTOR /
 * METADATA), which is a disjoint UUID space from *collection* id — so the segment
 * registry, not recreated collection ids, is the authoritative keep-set for physical
 * orphan cleanup. In the unified topology a single persist dir is shared across all
 * subsystems, so the keep-set must span the whole instance, never one target.
 *
 * @param {Object} options
 * @param {String} options.dbPath Persist dir containing `chroma.sqlite3`.
 * @param {Function} [options.execFn=execSync] `child_process.execSync` seam (testing).
 * @returns {Set<String>} Live segment ids; empty when no sqlite is present.
 */
export function resolveLiveSegmentIds({dbPath, execFn = execSync} = {}) {
    const sqlitePath = path.join(dbPath, 'chroma.sqlite3');

    if (!fs.existsSync(sqlitePath)) {
        return new Set();
    }

    const raw = execFn(`sqlite3 "${sqlitePath}" "SELECT id FROM segments;"`, {
        encoding : 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });

    return new Set(raw.split('\n').map(line => line.trim()).filter(Boolean));
}

/**
 * Removes orphaned segment directories: on-disk UUID dirs whose name is not a live
 * segment id. Preserves every live segment dir (across all collections) and any
 * non-UUID entry. This is the unified-store-safe keep-set; the prior collection-id
 * keep-set matched zero segment dirs and deleted live HNSW indices on next restart.
 *
 * @param {Object} options
 * @param {String} options.dbPath Persist dir to scan.
 * @param {Set<String>} options.liveSegmentIds Authoritative keep-set of live segment ids.
 * @param {Object} [options.fsModule=fs] `fs-extra` seam (testing).
 * @param {Function} [options.log=console.log] Log seam (testing).
 * @returns {Promise<{kept: String[], removed: String[]}>}
 */
export async function cleanOrphanedSegmentDirs({dbPath, liveSegmentIds, fsModule = fs, log = console.log}) {
    const kept    = [];
    const removed = [];
    const entries = await fsModule.readdir(dbPath, {withFileTypes: true});

    for (const entry of entries) {
        // UUIDv4 heuristic (36 chars, contains hyphen) guards non-segment system entries.
        if (!entry.isDirectory() || entry.name.length !== 36 || !entry.name.includes('-')) {
            continue;
        }

        if (liveSegmentIds.has(entry.name)) {
            kept.push(entry.name);
            log(`   ✨ Keeping live segment: ${entry.name}`);
        } else {
            removed.push(entry.name);
            log(`   🗑️  Deleting orphan: ${entry.name}`);
            await fsModule.remove(path.join(dbPath, entry.name));
        }
    }

    return {kept, removed};
}

/**
 * Normalizes Chroma document payloads for collection re-insertion.
 *
 * @param {Array} documents Chroma document values.
 * @returns {String[]}
 */
export function sanitizeDocuments(documents = []) {
    return documents.map(d => {
        if (d == null)             return '';
        if (typeof d === 'object') return JSON.stringify(d);
        return String(d)
    })
}

/**
 * Adds extracted collection data into a replacement collection in batches.
 *
 * @param {Object} options
 * @param {Object} options.collection Chroma collection handle.
 * @param {Object} options.data Extracted `{ids, embeddings, metadatas, documents}`.
 * @param {Number} [options.batchSize=1000] Chroma add batch size.
 * @param {Function} [options.writeProgress=process.stdout.write.bind(process.stdout)] Progress sink.
 * @param {Function} [options.log=console.log] Log sink.
 * @returns {Promise<void>}
 */
export async function addCollectionData({
    collection,
    data,
    batchSize     = 1000,
    writeProgress = process.stdout.write.bind(process.stdout),
    log           = console.log
} = {}) {
    const total = data.ids.length;

    for (let i = 0; i < total; i += batchSize) {
        const end = Math.min(i + batchSize, total);
        writeProgress(`     Upserting ${i} to ${end}... `);

        await collection.add({
            ids       : data.ids.slice(i, end),
            embeddings: data.embeddings.slice(i, end),
            metadatas : data.metadatas.slice(i, end),
            documents : sanitizeDocuments(data.documents.slice(i, end))
        });
        log('✅');
    }
}

/**
 * Validates that a rewritten collection is readable before promotion / completion.
 *
 * @param {Object} options
 * @param {Object} options.collection Chroma collection handle.
 * @param {Object} options.data Extracted source data.
 * @param {String} options.collectionName Collection name for diagnostics.
 * @returns {Promise<{count: Number}>}
 */
export async function validateLoadedCollection({collection, data, collectionName} = {}) {
    const expected = data.ids.length;
    const count    = await collection.count();

    if (count !== expected) {
        throw new Error(`Collection '${collectionName}' validation failed: expected ${expected} rows, found ${count}.`)
    }

    if (expected > 0) {
        const sampleId = data.ids[0];
        const sample   = await collection.get({ids: [sampleId], include: []});

        if (!sample.ids?.includes(sampleId)) {
            throw new Error(`Collection '${collectionName}' validation failed: sample id '${sampleId}' was not readable.`)
        }
    }

    return {count}
}

/**
 * Lists all ids in a collection without requesting embeddings.
 *
 * @param {Object} options
 * @param {Object} options.collection Chroma collection handle.
 * @param {Number} [options.batchSize=2000] Chroma get page size.
 * @returns {Promise<String[]>}
 */
export async function listCollectionIds({collection, batchSize = 2000} = {}) {
    const ids    = [];
    let   offset = 0;

    while (true) {
        const batch    = await collection.get({limit: batchSize, offset, include: []});
        const batchIds = batch.ids || [];

        if (batchIds.length === 0) {
            break;
        }

        ids.push(...batchIds);
        offset += batchSize;

        if (batchIds.length < batchSize) {
            break;
        }
    }

    return ids
}

/**
 * Validates a loaded replacement collection without holding full source vectors in memory.
 *
 * @param {Object} options
 * @param {Object} options.collection Chroma collection handle.
 * @param {String[]} options.ids Expected source ids.
 * @param {String} options.collectionName Collection name for diagnostics.
 * @returns {Promise<{count: Number}>}
 */
export async function validateLoadedCollectionByIds({collection, ids = [], collectionName} = {}) {
    const expected = ids.length;
    const count    = await collection.count();

    if (count !== expected) {
        throw new Error(`Collection '${collectionName}' validation failed: expected ${expected} rows, found ${count}.`)
    }

    if (expected > 0) {
        const sampleId = ids[0];
        const sample   = await collection.get({ids: [sampleId], include: []});

        if (!sample.ids?.includes(sampleId)) {
            throw new Error(`Collection '${collectionName}' validation failed: sample id '${sampleId}' was not readable.`)
        }
    }

    return {count}
}

/**
 * Rewrites one canonical collection through a shadow/parking promotion. The
 * canonical name remains live while the shadow loads; the only absent-canonical
 * window is the bounded live->parking / shadow->canonical rename pair, where
 * active `shadow` / `parking` names make KB healthcheck fail closed instead of
 * creating an empty canonical collection.
 *
 * @param {Object} options
 * @param {Object} options.client Chroma client.
 * @param {String} options.collectionName Canonical collection name.
 * @param {Object} options.data Extracted source data.
 * @param {Object} options.embeddingFunction Chroma embedding function.
 * @param {String} options.statePath Durable state marker path.
 * @param {Object} [options.stateBase] Stable fields written into every phase marker.
 * @param {Number} [options.timestamp=Date.now()] Stable run timestamp.
 * @param {Function} [options.uuidFactory=crypto.randomUUID] Unique id factory.
 * @param {Function} [options.log=console.log] Log sink.
 * @param {Function} [options.warn=console.warn] Warning sink.
 * @param {Function} [options.writeProgress] Progress sink.
 * @returns {Promise<Object>}
 */
export async function rewriteCollectionViaShadowPromotion({
    client,
    collectionName,
    data,
    embeddingFunction,
    statePath,
    stateBase     = {},
    timestamp     = Date.now(),
    uuidFactory   = crypto.randomUUID,
    log           = console.log,
    warn          = console.warn,
    writeProgress
} = {}) {
    const shadowName  = createSwapCollectionName(collectionName, 'shadow',  {timestamp, uuid: uuidFactory()});
    const parkingName = createSwapCollectionName(collectionName, 'parking', {timestamp, uuid: uuidFactory()});
    const sourceCount = data.ids.length;
    const baseState   = {
        ...stateBase,
        collectionName,
        sourceCount,
        shadowName,
        parkingName
    };

    let shadowCollection;
    let liveCollection;
    let liveParked     = false;
    let shadowPromoted = false;
    let parkingDeleted = false;

    await writeDefragState({statePath, state: {...baseState, phase: 'creating-shadow'}});

    shadowCollection = await client.createCollection({
        name    : shadowName,
        embeddingFunction,
        metadata: {"hnsw:space": "cosine"}
    });

    try {
        await writeDefragState({statePath, state: {...baseState, phase: 'shadow-loading'}});
        await addCollectionData({collection: shadowCollection, data, writeProgress, log});
        await validateLoadedCollection({collection: shadowCollection, data, collectionName: shadowName});
        await writeDefragState({statePath, state: {...baseState, phase: 'shadow-loaded'}});

        liveCollection = await client.getCollection({
            name             : collectionName,
            embeddingFunction
        });

        await liveCollection.modify({name: parkingName});
        liveParked = true;
        await writeDefragState({statePath, state: {...baseState, phase: 'live-parked'}});

        await shadowCollection.modify({name: collectionName});
        shadowPromoted = true;
        await writeDefragState({statePath, state: {...baseState, phase: 'shadow-promoted'}});

        const canonicalCollection = await client.getCollection({
            name             : collectionName,
            embeddingFunction
        });
        await validateLoadedCollection({collection: canonicalCollection, data, collectionName});
        await writeDefragState({statePath, state: {...baseState, phase: 'canonical-validated'}});

        try {
            await client.deleteCollection({name: parkingName});
            parkingDeleted = true;
            await writeDefragState({statePath, state: {...baseState, phase: 'parking-deleted'}});
        } catch (error) {
            warn(`   ⚠️  Could not delete parked pre-defrag collection '${parkingName}': ${error.message}`);
        }

        return {
            collectionName,
            shadowName,
            parkingName,
            sourceCount,
            parkingDeleted
        }
    } catch (error) {
        if (liveParked && !shadowPromoted && liveCollection) {
            try {
                await liveCollection.modify({name: collectionName});
                await writeDefragState({statePath, state: {...baseState, phase: 'live-rollback-complete'}});
            } catch (rollbackError) {
                warn(`   ⚠️  Failed to roll back parked collection '${parkingName}': ${rollbackError.message}`);
            }
        }

        if (!shadowPromoted && shadowCollection?.modify) {
            try {
                const failedShadowName = createSwapCollectionName(collectionName, 'failed-shadow', {
                    timestamp,
                    uuid: uuidFactory()
                });
                await shadowCollection.modify({name: failedShadowName});
                await writeDefragState({
                    statePath,
                    state: {
                        ...baseState,
                        phase           : 'shadow-parked-after-failure',
                        failedShadowName
                    }
                });
            } catch (shadowError) {
                warn(`   ⚠️  Failed to park shadow collection '${shadowName}': ${shadowError.message}`);
            }
        }

        throw error
    }
}

/**
 * Promotes an already loaded shadow collection to the canonical name.
 *
 * Memory Core repair uses this after streaming recovered batches durably into a resumable
 * shadow collection. The shadow-loading phase is restartable; the bounded rename phase is
 * deliberately not auto-resumed because the live canonical name may have been parked.
 *
 * Retained-parking lifecycle: when `deleteParking` is false (the partial-promotion path, where
 * recovered rows are promoted but unrecoverable rows remain), the pre-promotion source is renamed to
 * a timestamped, uuid-suffixed parking collection (`<collectionName>-parking-<timestamp>-<uuid>`) and
 * KEPT as a recovery asset instead of being deleted; a `parking-retained` state marker records its
 * `parkingName` so an operator can inspect the unrecoverable residue and delete it after recovery.
 * Because each partial run mints a fresh parking name, repeated partial repairs accumulate distinct
 * parking collections — they are bounded by operator cleanup, not auto-pruned. A defrag or cleanup
 * pass must therefore treat a `parking-retained` source as live recovery state, never as orphaned clutter.
 *
 * @param {Object} options
 * @param {Object} options.client Chroma client.
 * @param {String} options.collectionName Canonical collection name.
 * @param {Object} options.shadowCollection Loaded shadow collection handle.
 * @param {String} options.shadowName Loaded shadow collection name.
 * @param {String[]} options.sourceIds Expected source ids.
 * @param {Object} options.embeddingFunction Chroma embedding function.
 * @param {String} options.statePath Durable state marker path.
 * @param {Object} [options.stateBase] Stable fields written into every phase marker.
 * @param {Boolean} [options.deleteParking=true] When true, delete the parked source after the promoted collection validates; when false (partial promotion), retain it as a recovery asset and write a `parking-retained` state marker.
 * @param {Number} [options.timestamp=Date.now()] Stable run timestamp.
 * @param {Function} [options.uuidFactory=crypto.randomUUID] Unique id factory.
 * @param {Function} [options.writeStateFn=writeDefragState] State writer seam.
 * @param {Function} [options.warn=console.warn] Warning sink.
 * @returns {Promise<Object>}
 */
export async function promoteLoadedShadowCollection({
    client,
    collectionName,
    shadowCollection,
    shadowName,
    sourceIds,
    embeddingFunction,
    statePath,
    stateBase   = {},
    deleteParking = true,
    timestamp   = Date.now(),
    uuidFactory = crypto.randomUUID,
    writeStateFn = writeDefragState,
    warn        = console.warn
} = {}) {
    const parkingName = createSwapCollectionName(collectionName, 'parking', {timestamp, uuid: uuidFactory()});
    const sourceCount = sourceIds.length;
    const baseState   = {
        ...stateBase,
        collectionName,
        sourceCount,
        shadowName,
        parkingName
    };

    let liveCollection;
    let liveParked     = false;
    let shadowPromoted = false;
    let parkingDeleted = false;

    await validateLoadedCollectionByIds({collection: shadowCollection, ids: sourceIds, collectionName: shadowName});
    await writeStateFn({statePath, state: {...baseState, phase: 'memory-core-repair-shadow-loaded'}});

    try {
        liveCollection = await client.getCollection({
            name             : collectionName,
            embeddingFunction
        });

        await liveCollection.modify({name: parkingName});
        liveParked = true;
        await writeStateFn({statePath, state: {...baseState, phase: 'live-parked'}});

        await shadowCollection.modify({name: collectionName});
        shadowPromoted = true;
        await writeStateFn({statePath, state: {...baseState, phase: 'shadow-promoted'}});

        const canonicalCollection = await client.getCollection({
            name             : collectionName,
            embeddingFunction
        });
        await validateLoadedCollectionByIds({collection: canonicalCollection, ids: sourceIds, collectionName});
        await writeStateFn({statePath, state: {...baseState, phase: 'canonical-validated'}});

        if (deleteParking) {
            try {
                await client.deleteCollection({name: parkingName});
                parkingDeleted = true;
                await writeStateFn({statePath, state: {...baseState, phase: 'parking-deleted'}});
            } catch (error) {
                warn(`   ⚠️  Could not delete parked pre-defrag collection '${parkingName}': ${error.message}`);
            }
        } else {
            await writeStateFn({statePath, state: {...baseState, phase: 'parking-retained'}});
        }

        return {
            collectionName,
            shadowName,
            parkingName,
            sourceCount,
            parkingDeleted
        }
    } catch (error) {
        if (liveParked && !shadowPromoted && liveCollection) {
            try {
                await liveCollection.modify({name: collectionName});
                await writeStateFn({statePath, state: {...baseState, phase: 'live-rollback-complete'}});
            } catch (rollbackError) {
                warn(`   ⚠️  Failed to roll back parked collection '${parkingName}': ${rollbackError.message}`);
            }
        }

        throw error
    }
}

/**
 * @summary Selects the coverage row that belongs to the live Chroma collection.
 *
 * Chroma snapshots can contain stale duplicate collection-name rows even when `listCollections()`
 * exposes only one active collection. Name-only pairing can then feed ids from a stale row into
 * the active collection repair. Single rows remain the normal path; duplicate names must match
 * the live collection id or fail before any shadow promotion is attempted.
 *
 * @param {Object} options
 * @param {String} options.collectionName Collection name being repaired.
 * @param {Object[]} [options.coverageRows=[]] Audit rows with matching collection names.
 * @param {String} [options.liveCollectionId] Collection id returned by `client.getCollection`.
 * @returns {Object}
 */
function selectMemoryCoreRepairCoverageRow({
    collectionName,
    coverageRows = [],
    liveCollectionId
} = {}) {
    if (coverageRows.length === 1) {
        return coverageRows[0];
    }

    if (!liveCollectionId) {
        throw new Error(`repairMemoryCoreCollectionsViaFullEnumeration: '${collectionName}' has ${coverageRows.length} coverage rows, but the live collection id is unavailable — refusing name-only repair.`);
    }

    const match = coverageRows.find(row => row.collectionId === liveCollectionId);

    if (!match) {
        const ids = coverageRows.map(row => row.collectionId || '(missing-id)').join(', ');
        throw new Error(`repairMemoryCoreCollectionsViaFullEnumeration: '${collectionName}' has duplicate coverage rows, but none match live collection id '${liveCollectionId}' (coverage ids: ${ids}) — refusing ambiguous repair.`);
    }

    return match
}

/**
 * @summary Repairs one Memory Core collection through a resumable shadow-load phase.
 *
 * Recovered batches are added to the shadow collection immediately, then the state marker records
 * the loaded count. If the process crashes, the next run lists the shadow ids and skips them during
 * extraction/re-embedding instead of starting the provider work from zero.
 *
 * @param {Object} options
 * @param {Object} options.client Chroma client.
 * @param {String} options.collectionName Canonical collection name.
 * @param {Object} options.collection Live canonical collection handle.
 * @param {String[]} options.allIds Full source ids from metadata enumeration.
 * @param {String[]} options.missingVectorIds Ids missing from the vector index.
 * @param {Function} options.embedFn Re-embedder.
 * @param {Object} options.embeddingFunction Chroma embedding function.
 * @param {String} options.statePath Durable defrag state path.
 * @param {Object} [options.stateBase={}] Stable state fields.
 * @param {Object|null} [options.resumeState=null] Previously allowed resumable state.
 * @param {Function} [options.extractFn=extractMemoryCoreCollectionData] Extraction seam.
 * @param {Function} [options.addDataFn=addCollectionData] Shadow add seam.
 * @param {Function} [options.listIdsFn=listCollectionIds] Collection id listing seam.
 * @param {Function} [options.promoteLoadedFn=promoteLoadedShadowCollection] Promotion seam.
 * @param {Function} [options.writeStateFn=writeDefragState] State writer seam.
 * @param {Number} [options.timestamp=Date.now()] Stable run timestamp.
 * @param {Function} [options.uuidFactory=crypto.randomUUID] Unique id factory.
 * @param {Function} [options.log=console.log] Log sink.
 * @returns {Promise<Object>} Repair result.
 */
export async function repairMemoryCoreCollectionViaResumableShadow({
    client,
    collectionName,
    collection,
    allIds = [],
    missingVectorIds = [],
    embedFn,
    embeddingFunction,
    statePath,
    stateBase = {},
    resumeState = null,
    extractFn = extractMemoryCoreCollectionData,
    addDataFn = addCollectionData,
    listIdsFn = listCollectionIds,
    promoteLoadedFn = promoteLoadedShadowCollection,
    writeStateFn = writeDefragState,
    timestamp = Date.now(),
    uuidFactory = crypto.randomUUID,
    log = console.log
} = {}) {
    const sourceCount = allIds.length;
    const baseState   = {
        ...stateBase,
        collectionName,
        sourceCount
    };

    let shadowName       = resumeState?.shadowName;
    let shadowCollection = null;

    if (shadowName) {
        log(`   ♻️  '${collectionName}': resuming shadow load from '${shadowName}' (${resumeState.phase}).`);
        shadowCollection = await client.getCollection({name: shadowName, embeddingFunction});
    } else {
        shadowName = createSwapCollectionName(collectionName, 'shadow', {timestamp, uuid: uuidFactory()});
        await writeStateFn({statePath, state: {...baseState, phase: 'memory-core-repair-shadow-creating', shadowName}});
        shadowCollection = await client.createCollection({
            name    : shadowName,
            embeddingFunction,
            metadata: {"hnsw:space": "cosine"}
        });
    }

    const shadowIds = await listIdsFn({collection: shadowCollection});
    const sourceSet = new Set(allIds);
    const extraIds  = shadowIds.filter(id => !sourceSet.has(id));

    if (extraIds.length > 0) {
        throw new Error(`repairMemoryCoreCollectionViaResumableShadow: shadow '${shadowName}' contains ${extraIds.length} id(s) not present in source '${collectionName}' (first: '${extraIds[0]}') — refusing ambiguous resume.`);
    }

    const skipIds     = shadowIds.filter(id => sourceSet.has(id));
    let   loadedCount = skipIds.length;

    await writeStateFn({
        statePath,
        state: {
            ...baseState,
            phase: 'memory-core-repair-shadow-loading',
            shadowName,
            loadedCount
        }
    });

    const {unrecoverable, counts} = await extractFn({
        collection,
        allIds,
        missingVectorIds,
        embedFn,
        skipIds,
        collectData: false,
        onDataBatch: async (batchData, event = {}) => {
            await addDataFn({
                collection   : shadowCollection,
                data         : batchData,
                writeProgress: () => {},
                log          : () => {}
            });

            loadedCount += batchData.ids.length;

            await writeStateFn({
                statePath,
                state: {
                    ...baseState,
                    phase : 'memory-core-repair-shadow-loading',
                    shadowName,
                    loadedCount,
                    counts: event.counts
                }
            });
        },
        onProgress: event => log(formatMemoryCoreRepairProgress({collectionName, event}))
    });

    if (unrecoverable.length > 0) {
        const recoveredIds = await listIdsFn({collection: shadowCollection});

        if (recoveredIds.length > 0) {
            await writeStateFn({
                statePath,
                state: {
                    ...baseState,
                    phase               : 'memory-core-repair-shadow-loaded',
                    partial             : true,
                    shadowName,
                    loadedCount,
                    recoveredCount      : recoveredIds.length,
                    unrecoverableCount  : unrecoverable.length,
                    unrecoverablePreview: unrecoverable.slice(0, 20),
                    unrecoverable,
                    counts
                }
            });

            log(`   🚚 '${collectionName}': partial shadow promotion starting for ${recoveredIds.length}/${sourceCount} recovered row(s); ${unrecoverable.length} unrecoverable row(s) stay in parked source...`);
            const promotion = await promoteLoadedFn({
                client,
                collectionName,
                shadowCollection,
                shadowName,
                sourceIds    : recoveredIds,
                embeddingFunction,
                statePath,
                stateBase,
                deleteParking: false,
                writeStateFn
            });
            log(`   ⚠️  '${collectionName}': partial shadow promotion complete; parked source retained as '${promotion.parkingName}'.`);

            return {
                collectionName,
                partialPromoted: true,
                promotion,
                unrecoverable,
                counts,
                shadowName,
                loadedCount,
                recoveredCount : recoveredIds.length,
                sourceCount
            }
        }

        await writeStateFn({
            statePath,
            state: {
                ...baseState,
                phase               : 'memory-core-repair-aborted',
                shadowName,
                loadedCount,
                unrecoverableCount  : unrecoverable.length,
                unrecoverablePreview: createUnrecoverablePreview(unrecoverable),
                counts
            }
        });

        return {
            collectionName,
            aborted: true,
            unrecoverable,
            counts,
            shadowName,
            loadedCount,
            sourceCount
        }
    }

    await writeStateFn({
        statePath,
        state: {
            ...baseState,
            phase: 'memory-core-repair-shadow-loaded',
            shadowName,
            loadedCount,
            counts
        }
    });

    log(`   🚚 '${collectionName}': shadow promotion starting for ${loadedCount} recovered row(s)...`);
    const promotion = await promoteLoadedFn({
        client,
        collectionName,
        shadowCollection,
        shadowName,
        sourceIds: allIds,
        embeddingFunction,
        statePath,
        stateBase,
        writeStateFn
    });
    log(`   ✅ '${collectionName}': shadow promotion complete.`);

    return {
        collectionName,
        promotion,
        counts,
        shadowName,
        loadedCount,
        sourceCount
    }
}

/**
 * @summary Repairs Memory Core collections' missing stored-embeddings via FULL (uncapped) enumeration,
 * then promotes the recovered data through the existing shadow-promotion path.
 *
 * MC cannot use the KB extract path — `collection.get({include:['embeddings']})` throws "Error finding id"
 * for the missing-vector rows. This orchestration instead, per MC collection:
 *   1. enumerates the FULL metadata-id vs vector-index-id drift (uncapped — `auditChromaVectorCoverage`
 *      with `includeFullIds`, NOT the sampled coverage audit);
 *   2. extracts intact rows with their stored vectors and RE-EMBEDS the missing-vector rows from their
 *      still-materializing documents (`extractMemoryCoreCollectionData`);
 *   3. streams recovered batches into a resumable shadow collection, then promotes that loaded shadow.
 *
 * Fail-loud: a collection with unrecoverable rows promotes recovered rows only when the shadow already
 * contains recoverable data, retains the parked source, and returns a non-clean partial result. It aborts
 * only when there is no recoverable shadow to promote. The seams (`auditFn` / `extractFn` /
 * `repairCollectionFn` / `clearStateFn` / `writeStateFn`) are injectable for unit isolation.
 *
 * State-marker lifecycle: the mutating repair writes durable per-phase markers, so a fully successful repair
 * CLEARS the marker (`clearStateFn`) before returning — else the next run aborts as DEFRAG_INCOMPLETE_STATE.
 * An aborted repair rewrites an explicit `memory-core-repair-aborted` marker (`writeStateFn`) with the active
 * shadow name. A partial-promoted repair rewrites `memory-core-repair-partial-promoted` with the retained
 * parking collection and full unrecoverable manifest.
 *
 * The caller must own the client and physical snapshot. The endpoint-only CLI cannot establish
 * that binding and does not invoke this primitive.
 *
 * @param {Object} options
 * @param {Object} options.client Chroma client.
 * @param {String[]} options.collections MC collection names to repair.
 * @param {String} options.snapshotPath SQLite metadata snapshot path (the full-id enumeration source).
 * @param {String} options.persistDir HNSW persist dir (the vector-index-id source).
 * @param {Function} options.embedFn `documents -> embeddings` re-embedder (e.g. TextEmbeddingService.embedTexts).
 * @param {Object} options.embeddingFunction Chroma embedding function (dummy, for raw-vector moves).
 * @param {String} options.statePath Durable defrag-state marker path.
 * @param {Object} [options.stateBase={}] Stable fields written into every phase marker.
 * @param {Boolean} [options.dryRun=false] True extracts/re-embeds and reports counts without shadow promotion or state-marker writes.
 * @param {Function} [options.auditFn=auditChromaVectorCoverage] Enumeration seam (test injection).
 * @param {Function} [options.extractFn=extractMemoryCoreCollectionData] Extract + re-embed seam.
 * @param {Function} [options.repairCollectionFn=repairMemoryCoreCollectionViaResumableShadow] Mutating repair seam.
 * @param {Object|null} [options.resumeState=null] Resumable defrag state returned by `assertNoIncompleteDefragState`.
 * @param {Function} [options.clearStateFn=clearDefragState] Clears the durable marker on a fully successful repair.
 * @param {Function} [options.writeStateFn=writeDefragState] Rewrites explicit non-clean repair markers.
 * @param {Function} [options.log=console.log] Log sink.
 * @returns {Promise<{results: Object[]}>} Per collection: `{collectionName, promotion, counts}` on success,
 *   `{collectionName, dryRun: true, counts}` on clean dry-run,
 *   `{collectionName, partialPromoted: true, unrecoverable, counts}` when recovered rows were promoted but
 *   unrecoverable rows remain, or `{collectionName, aborted: true, unrecoverable, counts}` when fail-loud
 *   aborts the promotion/report.
 */
export async function repairMemoryCoreCollectionsViaFullEnumeration({
    client,
    collections,
    snapshotPath,
    persistDir,
    embedFn,
    embeddingFunction,
    statePath,
    stateBase = {},
    dryRun    = false,
    auditFn      = auditChromaVectorCoverage,
    extractFn    = extractMemoryCoreCollectionData,
    repairCollectionFn = repairMemoryCoreCollectionViaResumableShadow,
    resumeState  = null,
    clearStateFn = clearDefragState,
    writeStateFn = writeDefragState,
    log          = console.log
} = {}) {
    log(`   🔎 Enumerating Memory Core metadata/vector coverage for ${collections.length} collection(s)...`);
    const coverage = await auditFn({
        snapshotPath,
        persistDir,
        collectionNames: collections,
        includeFullIds : true
    });
    log(`   ✅ Coverage enumeration complete (${coverage.collections.length} coverage row(s)).`);
    const results = [];

    if (!dryRun && resumeState && (!resumeState.collectionName || !resumeState.shadowName)) {
        throw new Error(`repairMemoryCoreCollectionsViaFullEnumeration: resumable state phase '${resumeState.phase}' is missing collectionName or shadowName; manual recovery is required before rerun.`);
    }

    const resumeCollectionIndex = resumeState?.collectionName ? collections.indexOf(resumeState.collectionName) : -1;

    if (resumeState?.collectionName && resumeCollectionIndex === -1) {
        throw new Error(`repairMemoryCoreCollectionsViaFullEnumeration: resumable state targets '${resumeState.collectionName}', which is not in this run's collection list (${collections.join(', ')}).`);
    }

    for (let collectionIndex = 0; collectionIndex < collections.length; collectionIndex++) {
        const collectionName = collections[collectionIndex];

        if (!dryRun && resumeCollectionIndex > -1 && collectionIndex < resumeCollectionIndex) {
            log(`   ♻️  '${collectionName}': skipping collection before resumable state target '${resumeState.collectionName}'.`);
            continue;
        }

        const
            coverageRows = coverage.collections.filter(entry => entry.name === collectionName),
            collection   = await client.getCollection({name: collectionName, embeddingFunction});

        if (coverageRows.length === 0) {
            throw new Error(`repairMemoryCoreCollectionsViaFullEnumeration: no coverage row for '${collectionName}' — refusing to promote a collection the enumeration never saw.`);
        }

        const cov = selectMemoryCoreRepairCoverageRow({
            collectionName,
            coverageRows,
            liveCollectionId: collection.id
        });

        log(`   📦 '${collectionName}': metadata=${cov.metadataRowCount ?? cov.allIds?.length ?? 0}, vector=${cov.vectorIndexIdCount ?? cov.vectorIds?.length ?? 0}, missing=${cov.missingFromVectorCount ?? cov.missingVectorIds?.length ?? 0}, extra=${cov.extraInVectorCount ?? cov.extraVectorIds?.length ?? 0}`);

        const {allIds, missingVectorIds} = cov;

        if (dryRun) {
            const {unrecoverable, counts} = await extractFn({
                collection,
                allIds,
                missingVectorIds,
                embedFn,
                onProgress: event => log(formatMemoryCoreRepairProgress({collectionName, event}))
            });

            if (unrecoverable.length > 0) {
                log(`   ⚠️  '${collectionName}': DRY-RUN found ${unrecoverable.length} unrecoverable row(s) — no promotion attempted. Reasons: ${formatUnrecoverablePreview(unrecoverable)}. Counts: ${JSON.stringify(counts)}`);
                results.push({collectionName, dryRun: true, aborted: true, unrecoverable, counts});
                continue;
            }

            log(`   🧪 '${collectionName}': DRY-RUN extraction/re-embed succeeded; no promotion attempted. Counts: ${JSON.stringify(counts)}`);
            results.push({collectionName, dryRun: true, counts});
            continue;
        }

        const result = await repairCollectionFn({
            client,
            collectionName,
            collection,
            allIds,
            missingVectorIds,
            embedFn,
            embeddingFunction,
            statePath,
            stateBase,
            resumeState: resumeState?.collectionName === collectionName ? resumeState : null,
            extractFn,
            writeStateFn,
            log
        });

        if (result.aborted) {
            log(`   ⚠️  '${collectionName}': ${result.unrecoverable.length} unrecoverable row(s) — aborting before promotion, but keeping resumable shadow '${result.shadowName}'. Reasons: ${formatUnrecoverablePreview(result.unrecoverable)}. Counts: ${JSON.stringify(result.counts)}`);
            results.push(result);
            break;
        }

        if (result.partialPromoted) {
            log(`   ⚠️  '${collectionName}': partial repair promoted ${result.recoveredCount}/${result.sourceCount} recovered row(s); ${result.unrecoverable.length} unrecoverable row(s) remain in retained parking '${result.promotion?.parkingName}'. Counts: ${JSON.stringify(result.counts)}`);
        }

        results.push(result);
    }

    // State-marker lifecycle (mirrors the KB path's end-of-run clearDefragState): rewriteCollectionViaShadowPromotion
    // wrote durable per-phase markers, so a fully successful repair MUST clear the marker — else the next run aborts
    // as DEFRAG_INCOMPLETE_STATE. Aborted/partial repairs instead rewrite explicit non-clean markers, preserving
    // either the active shadow resume handle or the retained parking collection + unrecoverable manifest.
    if (statePath && !dryRun) {
        if (anyRepairNonClean(results)) {
            const activeNonClean            = results.find(result => result.aborted || result.partialPromoted),
                  unrecoverableByCollection = Object.fromEntries(
                      results
                          .filter(result => result.aborted || result.partialPromoted)
                          .map(result => [result.collectionName, result.unrecoverable || []])
                  );

            await writeStateFn({statePath, state: {
                ...stateBase,
                phase               : activeNonClean?.partialPromoted ? 'memory-core-repair-partial-promoted' : 'memory-core-repair-aborted',
                collectionName      : activeNonClean?.collectionName,
                shadowName          : activeNonClean?.shadowName,
                parkingName         : activeNonClean?.promotion?.parkingName,
                sourceCount         : activeNonClean?.sourceCount,
                loadedCount         : activeNonClean?.loadedCount,
                recoveredCount      : activeNonClean?.recoveredCount,
                unrecoverableCount  : activeNonClean?.unrecoverable?.length,
                unrecoverablePreview: createUnrecoverablePreview(activeNonClean?.unrecoverable),
                unrecoverable       : activeNonClean?.unrecoverable || [],
                unrecoverableByCollection,
                aborted             : results.filter(result => result.aborted).map(result => result.collectionName),
                partialPromoted     : results.filter(result => result.partialPromoted).map(result => result.collectionName),
                promoted            : results.filter(result => result.promotion).map(result => result.collectionName)
            }});
        } else {
            await clearStateFn({statePath});
        }
    }

    return {results};
}

/**
 * @summary Formats progress events from Memory Core repair extraction for operator terminals.
 * @param {Object} options
 * @param {String} options.collectionName Collection currently being repaired.
 * @param {Object} options.event Progress event emitted by `extractMemoryCoreCollectionData`.
 * @param {Date|String|Number} [options.now=new Date()] Timestamp source for log correlation.
 * @returns {String}
 */
export function formatMemoryCoreRepairProgress({collectionName, event, now = new Date()} = {}) {
    const counts    = event.counts || {},
          timestamp = new Date(now).toISOString();

    switch (event.phase) {
        case 'start':
            return `   [${timestamp}] ⏳ '${collectionName}': extraction starting (total=${event.total}, intact=${counts.intact || 0}, reEmbedded=${counts.reEmbedded || 0}, unrecoverable=${counts.unrecoverable || 0})`;
        case 'intact-extract':
            return `   [${timestamp}] ⏳ '${collectionName}': intact-vector extraction ${event.percent}% (${event.processed}/${event.total}; intact=${counts.intact || 0})`;
        case 'missing-reembed':
            return `   [${timestamp}] ⏳ '${collectionName}': missing-vector re-embed ${event.percent}% (${event.processed}/${event.total}; reEmbedded=${counts.reEmbedded || 0}, unrecoverable=${counts.unrecoverable || 0})`;
        case 'complete':
            return `   [${timestamp}] ✅ '${collectionName}': extraction complete; counts ${JSON.stringify(counts)}`;
        default:
            return `   [${timestamp}] ⏳ '${collectionName}': ${event.phase || 'progress'} ${event.percent ?? '?'}% (${event.processed ?? '?'}/${event.total ?? '?'})`;
    }
}

/**
 * @summary Normalizes structured and legacy unrecoverable entries for state/log consumers.
 * @param {String|Object} entry Unrecoverable row entry.
 * @returns {Object} Structured unrecoverable row entry.
 */
export function normalizeUnrecoverableEntry(entry) {
    if (entry && typeof entry === 'object') {
        const normalized = {
            id    : String(entry.id ?? ''),
            reason: entry.reason || 'unknown'
        };

        if (entry.message) {
            normalized.message = String(entry.message);
        }

        return normalized
    }

    return {
        id    : String(entry),
        reason: 'unknown'
    }
}

/**
 * @summary Creates the bounded structured preview stored in defrag abort state markers.
 * @param {Array<String|Object>} [entries=[]] Unrecoverable rows.
 * @param {Number} [limit=20] Maximum preview entries.
 * @returns {Object[]} Structured unrecoverable row entries.
 */
export function createUnrecoverablePreview(entries = [], limit = 20) {
    return entries.slice(0, limit).map(entry => normalizeUnrecoverableEntry(entry))
}

/**
 * @summary Formats a bounded operator-facing unrecoverable reason preview for terminal logs.
 * @param {Array<String|Object>} [entries=[]] Unrecoverable rows.
 * @param {Object} [options]
 * @param {Number} [options.limit=5] Maximum entries to include inline.
 * @returns {String}
 */
export function formatUnrecoverablePreview(entries = [], {limit = 5} = {}) {
    const preview = createUnrecoverablePreview(entries, limit);

    if (preview.length === 0) {
        return 'none'
    }

    const formatted = preview.map(entry => {
        const message = entry.message ? `: ${entry.message}` : '';
        return `${entry.id} (${entry.reason}${message})`
    });

    if (entries.length > preview.length) {
        formatted.push(`+${entries.length - preview.length} more`);
    }

    return formatted.join('; ')
}

/**
 * @summary True when any repair result is non-clean (aborted or partial-promoted).
 *
 * The CLI must exit non-zero for both classes: aborted means no promotion happened; partial-promoted means
 * recovered rows were promoted durably, but unrecoverable rows remain in a retained parked source. That
 * non-zero exit is the immune-system signal of record: the process supervisor observes the failed maintenance
 * run and escalates it to an operator page, while the retained parked source stays available for
 * unrecoverable-residue inspection.
 *
 * This is the single operator-facing fail-loud predicate; it subsumes the older aborted-only check, because an
 * aborted OR partial-promoted collection is never a clean repair. It mirrors the KB extractionErrors /
 * hasRestoreErrors discipline rather than reporting success on a non-clean repair.
 *
 * @param {Object[]} [results=[]] Per-collection results from `repairMemoryCoreCollectionsViaFullEnumeration`.
 * @returns {Boolean}
 */
export function anyRepairNonClean(results = []) {
    return results.some(result => result?.aborted === true || result?.partialPromoted === true);
}

/**
 * @summary Applies the AUTONOMOUS accepted-loss settlement over a non-clean repair result set and — when EVERY
 * non-clean collection self-settles — resolves the durable defrag state marker so the next maintenance pass is
 * not blocked as `DEFRAG_INCOMPLETE_STATE`. A clean process exit is not enough: the repair already wrote a
 * `memory-core-repair-partial-promoted` / `-aborted` marker, so a settled run must clear it or the next run aborts.
 *
 * Pure orchestration over injected I/O (`appendFn` / `clearFn`): runs `resolveAutonomousRepairExit`; if
 * `allSettled`, carries each collection's retained-parking context into the durable `auto-accepted-loss` audit
 * record (the audit log becomes the inspection surface that replaces the cleared marker), appends it, then clears
 * the marker. Zero operator-ack, no runtime escalate. Returns `{settled:false}` (no mutation) when any collection
 * is heal-path / systemic-fault, so the caller keeps the loud non-clean exit.
 *
 * @param {Object} options
 * @param {Object[]} options.results Per-collection repair results.
 * @param {String} options.statePath The defrag state-marker path (cleared on full settlement).
 * @param {String} options.auditDir The durable audit-log directory.
 * @param {Function} [options.normalizeResidue=normalizeUnrecoverableEntry]
 * @param {String} [options.provider='']
 * @param {Number|String} [options.contextBudget='']
 * @param {String} [options.strategyVersion=AiConfig.memoryRepair.strategyVersion]
 * @param {Function} [options.appendFn=appendAutoAcceptedLoss] Audit-append seam (test injection).
 * @param {Function} [options.writeAcceptedLossStateFn=writeAutoAcceptedLossState] Latest-state marker seam.
 * @param {Function} [options.clearFn=clearDefragState] Marker-clear seam (test injection).
 * @param {Function} [options.writeLog] Optional logger, called with the settled-collection count.
 * @param {Function} [options.now] Injectable timestamp factory for deterministic tests.
 * @returns {Promise<Object>} `{settled, perCollection}` — `settled` true iff every non-clean collection auto-settled and the marker was cleared.
 */
export async function applyAutonomousSettlement({
    results,
    statePath,
    auditDir,
    normalizeResidue = normalizeUnrecoverableEntry,
    provider         = '',
    contextBudget    = '',
    strategyVersion  = AiConfig.memoryRepair.strategyVersion,
    appendFn         = appendAutoAcceptedLoss,
    writeAcceptedLossStateFn = writeAutoAcceptedLossState,
    clearFn          = clearDefragState,
    now              = () => new Date().toISOString(),
    writeLog
} = {}) {
    const settleExit = resolveAutonomousRepairExit({results, normalizeResidue, provider, contextBudget, strategyVersion});

    if (!settleExit.allSettled) {
        return {settled: false, perCollection: settleExit.perCollection};
    }

    const settledCollections = [];

    for (const entry of settleExit.perCollection) {
        const result     = (Array.isArray(results) ? results : []).find(item => item?.collectionName === entry.collectionName),
              auditEntry = {...entry.auditRecord, collectionName: entry.collectionName, parkingName: result?.promotion?.parkingName ?? null};

        await appendFn(auditEntry, {dir: auditDir});

        settledCollections.push({
            collectionName: entry.collectionName,
            reasonCode    : entry.reasonCode,
            fingerprint   : auditEntry.fingerprint,
            acceptedIds   : auditEntry.acceptedIds,
            residueCount  : auditEntry.residueCount,
            collectionSize: auditEntry.collectionSize,
            parkingName   : auditEntry.parkingName
        });
    }

    await writeAcceptedLossStateFn({
        schemaVersion  : ACCEPTED_LOSS_STATE_SCHEMA_VERSION,
        type           : 'auto-accepted-loss-state',
        phase          : 'memory-core-repair-recovered-with-accepted-loss',
        settledAt      : now(),
        auditPath      : getAcceptedLossAuditFilePath(auditDir),
        defragStatePath: statePath,
        collectionCount: settledCollections.length,
        collections    : settledCollections
    }, {dir: auditDir});

    // Resolve the non-clean marker the repair wrote — the run is now genuinely settled across runs, not just for
    // this process's exit code.
    await clearFn({statePath});

    writeLog?.(settleExit.perCollection.length);

    return {settled: true, perCollection: settleExit.perCollection};
}

/**
 * @summary Refuses physical maintenance from an endpoint-only client process.
 * @param {Object} [options]
 * @param {String[]} [options.argv=process.argv] Command-line arguments.
 * @param {Object} [options.output=console] Terminal error sink.
 * @param {Function} [options.exit] Nonzero terminal hook.
 * @returns {Promise<*>} The exit-hook result.
 */
export async function runDefragChromaDBCli({
    argv = process.argv,
    output = console,
    exit = code => process.exit(code)
} = {}) {
    const command = new Command()
        .name('defragChromaDB')
        .description('Physical Chroma maintenance requires an owner-held storage binding; endpoint-only execution is unavailable.')
        .requiredOption('-t, --target <name>', 'Requested collection group (knowledge-base, memory-core)')
        .option('--allow-memory-core', 'Legacy option; does not confer physical storage access')
        .option('--dry-run', 'Legacy option; does not confer physical storage access')
        .parse(argv);

    output.error('CHROMA_PHYSICAL_STORAGE_UNAVAILABLE: client coordinates do not identify locally owned Chroma storage.', {
        target: command.opts().target
    });
    return exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runDefragChromaDBCli();
}
