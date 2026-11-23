import Database                   from 'better-sqlite3';
import fs                         from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path                       from 'node:path';
import {
    buildKbDeadElementDiagnosis,
    evaluateKbDeadElementObservation,
    HNSW_HEADER_BYTE_LENGTH
} from './kbDeadElementDiagnosis.mjs';

/**
 * @module ai/daemons/orchestrator/services/kbDeadElementGatherer
 * @summary Read-only Chroma 1.5.9 segment-registry + 100-byte `header.bin` gatherer for KB dead elements.
 *
 * Operates strictly inside the recovery actuator's read-only store-observation scope: never copies `chroma.sqlite3`,
 * never writes or replays a rollback journal, and binds endpoint, compose service, container incarnation,
 * physical `chroma-data` volume, and KB segment identity before emitting any diagnosis.
 * @see learn/agentos/decisions/0026-recovery-actuator.md
 */

export const SQLITE_ROLLBACK_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

const CHROMA_CONTAINER_DATA_PATH = '/data';

/**
 * @summary Detects an active SQLite rollback-journal header (`0xd9d505f920a163d7`; `PERSIST` mode zeros bytes `0..27` on commit).
 * @param {Buffer|Uint8Array} headerBytes Leading bytes read from `<db>-journal`.
 * @returns {Boolean}
 */
export function isHotRollbackJournalHeader(headerBytes) {
    if (!(headerBytes instanceof Uint8Array) || headerBytes.byteLength < SQLITE_ROLLBACK_JOURNAL_MAGIC.byteLength) {
        return false;
    }

    const buf = Buffer.isBuffer(headerBytes)
        ? headerBytes
        : Buffer.from(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

    return buf.subarray(0, SQLITE_ROLLBACK_JOURNAL_MAGIC.byteLength).equals(SQLITE_ROLLBACK_JOURNAL_MAGIC);
}

/**
 * @summary Classifies SQLite errors caused by a hot rollback journal or write-locked store on a `:ro` mount.
 * @param {Error|*} error Thrown error from `better-sqlite3`.
 * @returns {Boolean}
 */
export function isSqliteHotJournalError(error) {
    const code    = String(error?.code || ''),
          message = String(error?.message || '');

    if (
        code.startsWith('SQLITE_READONLY') ||
        code.startsWith('SQLITE_BUSY') ||
        code.startsWith('SQLITE_LOCKED')
    ) {
        return true;
    }

    return /hot journal|rollback|readonly database|database is locked|database table is locked/i.test(message);
}

/**
 * @summary Reads up to `maxBytes` from the start of a file without loading larger payloads into memory.
 * @param {String} filePath Absolute file path.
 * @param {Number} maxBytes Maximum bytes to read.
 * @param {Object} [fsModule=fs] Injectable `node:fs/promises` collaborator.
 * @returns {Promise<Buffer|null>} Slice of read bytes, or `null` when `ENOENT`.
 */
async function readLeadingBytes(filePath, maxBytes, fsModule = fs) {
    let handle;
    try {
        handle = await fsModule.open(filePath, 'r');
        const buffer      = Buffer.alloc(maxBytes),
              {bytesRead} = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    } finally {
        await handle?.close();
    }
}

/**
 * @summary Resolves physical volume identity from a Docker inspect `Mounts` entry.
 * @param {Object|null|undefined} mount Docker inspect mount entry.
 * @returns {String|null}
 */
function resolveMountIdentity(mount) {
    if (!mount || typeof mount !== 'object') {
        return null;
    }
    if (typeof mount.Name === 'string' && mount.Name.length > 0) {
        return mount.Name;
    }
    if (typeof mount.Source === 'string' && mount.Source.length > 0) {
        return mount.Source;
    }
    return null;
}

/**
 * @summary Binds Chroma service, running container incarnation, image, and `:ro` shared volume via L0 `inspect`.
 * @param {Object} options
 * @returns {Promise<Object>} Runtime binding descriptor for {@link evaluateKbDeadElementObservation}.
 */
export async function inspectChromaStoreRuntimeBinding({
    runtimeAccessService,
    dataDir,
    endpointHost,
    endpointPort,
    expectedEndpointHost = 'chroma',
    chromaServiceKey     = 'chroma',
    selfServiceKey       = 'orchestrator',
    fsModule             = fs
} = {}) {
    if (typeof runtimeAccessService?.readObserve !== 'function') {
        return {
            readOnlyMountVerified: false,
            reason               : 'runtime-access-unavailable'
        };
    }

    const chromaInspect  = await runtimeAccessService.readObserve({serviceKey: chromaServiceKey, operation: 'inspect'}),
          chromaData     = chromaInspect?.data || {},
          composeProject = chromaInspect?.proof?.target?.composeProject ||
              chromaData?.Config?.Labels?.['com.docker.compose.project'] || null,
          chromaMounts   = Array.isArray(chromaData.Mounts) ? chromaData.Mounts : [],
          chromaMount    = chromaMounts.find(mount => mount?.Destination === CHROMA_CONTAINER_DATA_PATH),
          chromaVolume   = resolveMountIdentity(chromaMount);

    let readOnlyMountVerified = false,
        orchestratorVolume    = null,
        reason                = null;

    const allowedServices = runtimeAccessService.configValues?.allowedServices;
    const canSelfInspect  = Array.isArray(allowedServices) && allowedServices.includes(selfServiceKey);

    if (canSelfInspect) {
        const selfInspect = await runtimeAccessService.readObserve({serviceKey: selfServiceKey, operation: 'inspect'}),
              selfMounts  = Array.isArray(selfInspect?.data?.Mounts) ? selfInspect.data.Mounts : [],
              targetPath  = typeof dataDir === 'string' ? path.posix.normalize(dataDir) : '',
              selfMount   = selfMounts.find(mount => mount?.Destination === targetPath || mount?.Destination === dataDir);

        orchestratorVolume    = resolveMountIdentity(selfMount);
        readOnlyMountVerified = Boolean(selfMount && selfMount.RW === false && orchestratorVolume);
        if (!readOnlyMountVerified) {
            reason = selfMount ? 'store-mount-not-readonly' : 'store-mount-missing';
        }
    } else if (typeof dataDir === 'string' && dataDir.length > 0) {
        await fsModule.access(dataDir, fsConstants.R_OK);
        try {
            await fsModule.access(dataDir, fsConstants.W_OK);
            readOnlyMountVerified = false;
            reason                = 'store-mount-not-readonly';
        } catch (writeErr) {
            if (writeErr?.code === 'EROFS' || writeErr?.code === 'EACCES' || writeErr?.code === 'EPERM') {
                readOnlyMountVerified = true;
            } else {
                throw writeErr;
            }
        }
    }

    return {
        composeProject,
        chromaServiceKey        : chromaInspect?.proof?.target?.serviceKey || chromaServiceKey,
        expectedChromaServiceKey: chromaServiceKey,
        chromaContainerId       : chromaData.Id || chromaInspect?.proof?.target?.containerId || null,
        chromaRunning           : chromaData?.State?.Running === true,
        chromaImage             : chromaData?.Config?.Image || null,
        chromaVolume,
        orchestratorVolume,
        readOnlyMountVerified,
        endpointHost,
        endpointPort,
        expectedEndpointHost,
        reason
    };
}

/**
 * @summary Opens `chroma.sqlite3` read-only (`query_only = ON`) and reads KB segment/checkpoint rows without copying.
 * @param {Object} options
 * @returns {Promise<Object>} `{journalState: 'hot', journalReason}` or `{journalState: 'clean', registry}`.
 */
export async function readSqliteRegistryReadOnly({
    sqlitePath,
    databaseName   = 'default_database',
    collectionName = 'neo-knowledge-base',
    openDatabaseFn = filePath => new Database(filePath, {readonly: true, fileMustExist: true}),
    fsModule       = fs
} = {}) {
    const journalHeader = await readLeadingBytes(`${sqlitePath}-journal`, 12, fsModule);
    if (journalHeader && isHotRollbackJournalHeader(journalHeader)) {
        return {journalState: 'hot', journalReason: 'hot-rollback-journal'};
    }

    let db;
    try {
        db = openDatabaseFn(sqlitePath);
        db.pragma('query_only = ON');

        const tables = new Set(
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all()
                .map(row => row.name)
        );

        let migrationsByDir = null;
        if (tables.has('migrations')) {
            const migrationRows = db.prepare(
                'SELECT dir, MAX(version) AS maxVersion FROM migrations GROUP BY dir'
            ).all();
            migrationsByDir = Object.fromEntries(migrationRows.map(row => [row.dir, Number(row.maxVersion)]));
        }

        const collections = tables.has('databases')
            ? db.prepare(`
                SELECT
                    c.id          AS collectionId,
                    c.name        AS collectionName,
                    c.dimension   AS dimension,
                    d.name        AS databaseName,
                    d.tenant_id   AS tenantId
                FROM collections c
                JOIN databases d ON d.id = c.database_id
                WHERE d.name = ? AND c.name = ?
                ORDER BY c.id
            `).all(databaseName, collectionName)
            : db.prepare(`
                SELECT
                    c.id        AS collectionId,
                    c.name      AS collectionName,
                    c.dimension AS dimension
                FROM collections c
                WHERE c.name = ?
                ORDER BY c.id
            `).all(collectionName);

        let segments               = [],
            vectorCheckpointSeqId  = null,
            postCheckpointLogCount = 0,
            maxKnownSeqId          = null;

        if (collections.length === 1) {
            const collectionRow = collections[0];
            segments = db.prepare(`
                SELECT id, type, scope, collection
                FROM segments
                WHERE collection = ?
                ORDER BY scope, id
            `).all(collectionRow.collectionId);

            const vectorSegments = segments.filter(seg => seg.scope === 'VECTOR');

            if (tables.has('max_seq_id') && segments.length > 0) {
                const placeholders = segments.map(() => '?').join(', '),
                      seqRows      = db.prepare(
                          `SELECT segment_id AS segmentId, seq_id AS seqId FROM max_seq_id WHERE segment_id IN (${placeholders})`
                      ).all(...segments.map(seg => seg.id));

                for (const row of seqRows) {
                    const seq = Number(row.seqId);
                    if (Number.isSafeInteger(seq)) {
                        maxKnownSeqId = maxKnownSeqId === null ? seq : Math.max(maxKnownSeqId, seq);
                        if (vectorSegments.some(seg => seg.id === row.segmentId)) {
                            vectorCheckpointSeqId = vectorCheckpointSeqId === null
                                ? seq
                                : Math.min(vectorCheckpointSeqId, seq);
                        }
                    }
                }
            }

            if (tables.has('embeddings_queue')) {
                const tenantId      = collectionRow.tenantId || 'default_tenant',
                      defaultTopic  = `persistent://default/default/${collectionRow.collectionId}`,
                      scopedTopic   = `persistent://${tenantId}/${databaseName}/${collectionRow.collectionId}`,
                      baselineSeqId = vectorCheckpointSeqId ?? 0,
                      queueSummary  = db.prepare(`
                          SELECT
                              COUNT(*)    AS postCheckpointLogCount,
                              MAX(seq_id) AS maxTopicSeqId
                          FROM embeddings_queue
                          WHERE (topic = ? OR topic = ?)
                            AND seq_id > ?
                      `).get(defaultTopic, scopedTopic, baselineSeqId),
                      globalMaxRow  = db.prepare('SELECT MAX(seq_id) AS maxSeqId FROM embeddings_queue').get();

                postCheckpointLogCount = Number(queueSummary?.postCheckpointLogCount ?? 0);

                for (const candidate of [queueSummary?.maxTopicSeqId, globalMaxRow?.maxSeqId]) {
                    const seq = candidate == null ? null : Number(candidate);
                    if (Number.isSafeInteger(seq)) {
                        maxKnownSeqId = maxKnownSeqId === null ? seq : Math.max(maxKnownSeqId, seq);
                    }
                }
            }
        }

        return {
            journalState: 'clean',
            registry    : {
                migrationsByDir,
                collections,
                segments,
                vectorCheckpointSeqId,
                postCheckpointLogCount,
                maxKnownSeqId
            }
        };
    } catch (error) {
        if (isSqliteHotJournalError(error)) {
            return {
                journalState : 'hot',
                journalReason: error.code || error.message || 'hot-rollback-journal'
            };
        }
        throw error;
    } finally {
        db?.close();
    }
}

/**
 * @summary Reads one KB dead-element observation across runtime `inspect`, SQLite registry, `header.bin`, and live `count()`.
 * @param {Object} options
 * @returns {Promise<Object>} Evaluated observation (`{status: 'ok'|'unverified'|'unknown', ...}`).
 */
export async function readKbDeadElementObservation({
    dataDir,
    endpointHost,
    endpointPort,
    expectedEndpointHost = 'chroma',
    collectionName       = 'neo-knowledge-base',
    databaseName         = 'default_database',
    kbChromaManager,
    runtimeAccessService,
    runtimeBinding       = null,
    openDatabaseFn,
    fsModule             = fs
} = {}) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
        return {status: 'unknown', reason: 'missing-chroma-data-dir'};
    }

    const resolvedBinding = runtimeBinding || await inspectChromaStoreRuntimeBinding({
        runtimeAccessService,
        dataDir,
        endpointHost,
        endpointPort,
        expectedEndpointHost,
        fsModule
    });

    if (resolvedBinding.readOnlyMountVerified !== true) {
        return evaluateKbDeadElementObservation({
            runtimeBinding: resolvedBinding,
            collectionName,
            databaseName
        });
    }

    const sqlitePath   = path.join(dataDir, 'chroma.sqlite3'),
          sqliteResult = await readSqliteRegistryReadOnly({
              sqlitePath,
              databaseName,
              collectionName,
              openDatabaseFn,
              fsModule
          });

    if (sqliteResult.journalState === 'hot') {
        return evaluateKbDeadElementObservation({
            journalState : 'hot',
            journalReason: sqliteResult.journalReason,
            collectionName,
            databaseName
        });
    }

    const headersBySegmentId = {},
          vectorSegments     = (sqliteResult.registry.segments || []).filter(seg => seg.scope === 'VECTOR');

    for (const segment of vectorSegments) {
        const headerPath  = path.join(dataDir, segment.id, 'header.bin'),
              headerBytes = await readLeadingBytes(headerPath, HNSW_HEADER_BYTE_LENGTH + 1, fsModule);
        if (headerBytes) {
            headersBySegmentId[segment.id] = headerBytes;
        }
    }

    const liveCollection   = await kbChromaManager.getKnowledgeBaseCollection(),
          liveCollectionId = liveCollection?.id ?? null,
          liveCount        = await liveCollection.count();

    return evaluateKbDeadElementObservation({
        journalState  : 'clean',
        runtimeBinding: resolvedBinding,
        registry      : sqliteResult.registry,
        headersBySegmentId,
        liveCollectionId,
        liveCount,
        collectionName,
        databaseName
    });
}

/**
 * @summary Builds the orchestrator's live KB dead-element gatherer closure.
 *
 * Never throws into the shared sweep on store/Chroma unavailability: settles as `{status: 'probe-unavailable'}`
 * when an unexpected I/O or transport error occurs, `{status: 'unverified'}` on a hot rollback journal,
 * `{status: 'unknown'}` on version/identity/checkpoint incoherence, `{status: 'clean', diagnosis: null}` at or
 * below `gcDefragThreshold`, and `{status: 'bloated', diagnosis}` above threshold.
 *
 * @param {Object} options
 * @param {Function} options.resolveInputs Use-site resolver returning fresh `{dataDir, endpointHost, endpointPort, gcDefragThreshold, collectionName, databaseName}`.
 * @param {Object} options.kbChromaManager Knowledge Base Chroma manager (`getKnowledgeBaseCollection()`).
 * @param {Object} options.runtimeAccessService Orchestrator `DeploymentRuntimeAccessService`.
 * @param {String} options.serviceId Target compose-service id (`mc-server`).
 * @param {Function} [options.readObservationFn=readKbDeadElementObservation] Injectable reader seam for tests.
 * @returns {Function} `async (observedAt) => Promise<Object>`
 */
export function createLiveKbDeadElementGatherer({
    resolveInputs,
    kbChromaManager,
    runtimeAccessService,
    serviceId,
    readObservationFn = readKbDeadElementObservation
} = {}) {
    return async observedAt => {
        try {
            const inputs      = resolveInputs(),
                  observation = await readObservationFn({
                      kbChromaManager,
                      runtimeAccessService,
                      ...inputs
                  });

            if (observation.status === 'unverified' || observation.status !== 'ok') {
                return {
                    status   : observation.status === 'unverified' ? 'unverified' : 'unknown',
                    reason   : observation.reason || null,
                    diagnosis: null
                };
            }

            const diagnosis = buildKbDeadElementDiagnosis({
                observation,
                gcDefragThreshold: inputs.gcDefragThreshold,
                observedAt,
                serviceId
            });

            return {
                status          : diagnosis ? 'bloated' : 'clean',
                collection      : observation.collection,
                hnswOccupancy   : observation.hnswOccupancy,
                liveCount       : observation.liveCount,
                deadElementCount: observation.deadElementCount,
                deadFraction    : observation.deadFraction,
                diagnosis
            };
        } catch (error) {
            return {
                status    : 'probe-unavailable',
                probeError: error?.message ?? String(error),
                diagnosis : null
            };
        }
    };
}
