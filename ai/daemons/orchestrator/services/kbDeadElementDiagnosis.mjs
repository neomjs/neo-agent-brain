import {createRecoveryDiagnosisEvent} from '../../../services/memory-core/helpers/recoveryRunStateStore.mjs';

/**
 * @module ai/daemons/orchestrator/services/kbDeadElementDiagnosis
 * @summary Pure Chroma 1.5.9 HNSW header decoder and KB dead-element `store-bloat` diagnosis builder.
 */

export const SUPPORTED_CHROMA_VERSION  = '1.5.9';
export const HNSW_HEADER_BYTE_LENGTH   = 100;
export const HNSW_PERSISTENCE_VERSION  = 1;
export const CHROMA_159_MIGRATIONS     = Object.freeze({
    sysdb           : 10,
    metadb          : 6,
    embeddings_queue: 2
});

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * @summary Extracts and validates the Chroma image version from a container image reference.
 * @param {String|null|undefined} image Container image string (e.g. `chromadb/chroma:1.5.9`).
 * @returns {{ok: Boolean, version: String|null, reason?: String}}
 */
export function parseChromaImageVersion(image) {
    if (typeof image !== 'string' || image.trim().length === 0) {
        return {ok: false, version: null, reason: 'missing-chroma-image'};
    }

    const withoutDigest = image.trim().split('@')[0],
          slashParts    = withoutDigest.split('/'),
          lastSegment   = slashParts[slashParts.length - 1] || '',
          colonIdx      = lastSegment.indexOf(':');

    if (colonIdx <= 0) {
        return {ok: false, version: null, reason: 'untagged-chroma-image'};
    }

    const repoPath  = [...slashParts.slice(0, -1), lastSegment.slice(0, colonIdx)].join('/'),
          version   = lastSegment.slice(colonIdx + 1),
          validRepo = repoPath === 'chromadb/chroma' || repoPath.endsWith('/chromadb/chroma');

    if (!validRepo) {
        return {ok: false, version, reason: 'unexpected-chroma-repository'};
    }

    if (version !== SUPPORTED_CHROMA_VERSION) {
        return {ok: false, version, reason: 'unsupported-chroma-version'};
    }

    return {ok: true, version};
}

/**
 * @summary Decodes Chroma 1.5.9's 100-byte persistent HNSW `header.bin` (`PERSISTENCE_VERSION = 1`).
 * @param {Buffer|Uint8Array} headerBytes Raw `header.bin` bytes.
 * @param {Object} [options]
 * @param {Number|null} [options.expectedDimension=null] Expected vector dimension from `collections.dimension`.
 * @returns {Object} `{ok: true, hnswOccupancy, maxElements, dimension, ...}` or `{ok: false, reason}`.
 */
export function parseChroma159HnswHeader(headerBytes, {expectedDimension = null} = {}) {
    if (!(headerBytes instanceof Uint8Array) || headerBytes.byteLength !== HNSW_HEADER_BYTE_LENGTH) {
        return {ok: false, reason: 'invalid-header-length'};
    }

    const buf = Buffer.isBuffer(headerBytes)
        ? headerBytes
        : Buffer.from(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);

    const persistenceVersion = buf.readInt32LE(0);
    if (persistenceVersion !== HNSW_PERSISTENCE_VERSION) {
        return {ok: false, reason: 'unsupported-header-persistence-version'};
    }

    const offsetLevel0       = buf.readBigUInt64LE(4),
          maxElements        = buf.readBigUInt64LE(12),
          curElementCount    = buf.readBigUInt64LE(20),
          sizeDataPerElement = buf.readBigUInt64LE(28),
          labelOffset        = buf.readBigUInt64LE(36),
          offsetData         = buf.readBigUInt64LE(44),
          maxLevel           = buf.readInt32LE(52),
          enterpointNode     = buf.readUInt32LE(56),
          maxM               = buf.readBigUInt64LE(60),
          maxM0              = buf.readBigUInt64LE(68),
          m                  = buf.readBigUInt64LE(76),
          mult               = buf.readDoubleLE(84),
          efConstruction     = buf.readBigUInt64LE(92);

    if (offsetLevel0 !== 0n) {
        return {ok: false, reason: 'invalid-header-offset-level0'};
    }

    if (curElementCount > maxElements || maxElements > MAX_SAFE_BIGINT) {
        return {ok: false, reason: 'invalid-header-element-bounds'};
    }

    if (maxM0 === 0n || offsetData !== 4n + maxM0 * 4n || sizeDataPerElement !== labelOffset + 8n || labelOffset <= offsetData) {
        return {ok: false, reason: 'invalid-header-geometry'};
    }

    const vectorByteSpan = labelOffset - offsetData;
    if (vectorByteSpan % 4n !== 0n) {
        return {ok: false, reason: 'invalid-header-vector-span'};
    }

    const dimension = Number(vectorByteSpan / 4n);
    if (Number.isInteger(expectedDimension) && expectedDimension > 0 && dimension !== expectedDimension) {
        return {ok: false, reason: 'header-dimension-mismatch'};
    }

    return {
        ok                : true,
        persistenceVersion,
        maxElements       : Number(maxElements),
        hnswOccupancy     : Number(curElementCount),
        sizeDataPerElement: Number(sizeDataPerElement),
        dimension,
        maxLevel,
        enterpointNode,
        m                 : Number(m),
        maxM              : Number(maxM),
        maxM0             : Number(maxM0),
        mult,
        efConstruction    : Number(efConstruction)
    };
}

/**
 * @summary Validates SQLite `migrations` rows against Chroma 1.5.9's exact migration versions when provided.
 * @param {Object|null|undefined} migrationsByDir `{sysdb, metadb, embeddings_queue}` max versions.
 * @returns {{ok: Boolean, reason?: String}}
 */
function validateMigrations(migrationsByDir) {
    if (migrationsByDir == null) {
        return {ok: true};
    }
    if (typeof migrationsByDir !== 'object') {
        return {ok: false, reason: 'invalid-sqlite-migrations'};
    }

    for (const [dir, expectedVersion] of Object.entries(CHROMA_159_MIGRATIONS)) {
        if (migrationsByDir[dir] !== expectedVersion) {
            return {ok: false, reason: 'unsupported-sqlite-schema-version'};
        }
    }

    return {ok: true};
}

/**
 * @summary Validates runtime, version, segment-registry, header, and checkpoint coherence for KB dead elements.
 * @param {Object} options
 * @returns {Object} `{status: 'ok'|'unverified'|'unknown', ...}`
 */
export function evaluateKbDeadElementObservation({
    journalState       = 'clean',
    journalReason      = null,
    chromaVersion      = null,
    runtimeBinding     = null,
    registry           = null,
    headersBySegmentId = {},
    liveCollectionId   = null,
    liveCount          = null,
    collectionName     = 'neo-knowledge-base',
    databaseName       = 'default_database'
} = {}) {
    if (journalState === 'hot') {
        return {status: 'unverified', reason: journalReason || 'hot-rollback-journal'};
    }

    if (!runtimeBinding || typeof runtimeBinding !== 'object') {
        return {status: 'unknown', reason: 'missing-runtime-binding'};
    }

    const expectedServiceKey = runtimeBinding.expectedChromaServiceKey || 'chroma';
    if (
        runtimeBinding.chromaServiceKey !== expectedServiceKey ||
        typeof runtimeBinding.composeProject !== 'string' || runtimeBinding.composeProject.length === 0 ||
        typeof runtimeBinding.chromaContainerId !== 'string' || runtimeBinding.chromaContainerId.length === 0 ||
        runtimeBinding.chromaRunning !== true ||
        typeof runtimeBinding.chromaVolume !== 'string' || runtimeBinding.chromaVolume.length === 0 ||
        runtimeBinding.readOnlyMountVerified !== true
    ) {
        return {status: 'unknown', reason: runtimeBinding.reason || 'runtime-identity-mismatch'};
    }

    if (
        typeof runtimeBinding.expectedEndpointHost === 'string' &&
        runtimeBinding.expectedEndpointHost.length > 0 &&
        runtimeBinding.endpointHost !== runtimeBinding.expectedEndpointHost
    ) {
        return {status: 'unknown', reason: 'endpoint-identity-mismatch'};
    }

    if (
        typeof runtimeBinding.orchestratorVolume === 'string' &&
        runtimeBinding.orchestratorVolume !== runtimeBinding.chromaVolume
    ) {
        return {status: 'unknown', reason: 'volume-identity-mismatch'};
    }

    const versionCheck = chromaVersion !== null
        ? (chromaVersion === SUPPORTED_CHROMA_VERSION
            ? {ok: true, version: chromaVersion}
            : {ok: false, version: chromaVersion, reason: 'unsupported-chroma-version'})
        : parseChromaImageVersion(runtimeBinding.chromaImage);

    if (!versionCheck.ok) {
        return {status: 'unknown', reason: versionCheck.reason};
    }

    if (!registry || typeof registry !== 'object') {
        return {status: 'unknown', reason: 'missing-registry'};
    }

    const migrationCheck = validateMigrations(registry.migrationsByDir);
    if (!migrationCheck.ok) {
        return {status: 'unknown', reason: migrationCheck.reason};
    }

    const collections = Array.isArray(registry.collections) ? registry.collections : [],
          matchedCols = collections.filter(row =>
              row?.collectionName === collectionName &&
              (row?.databaseName == null || row.databaseName === databaseName)
          );

    if (matchedCols.length !== 1) {
        return {status: 'unknown', reason: matchedCols.length === 0 ? 'kb-collection-missing' : 'kb-collection-ambiguous'};
    }

    const collectionRow = matchedCols[0];
    if (
        typeof collectionRow.collectionId !== 'string' ||
        collectionRow.collectionId.length === 0 ||
        typeof liveCollectionId !== 'string' ||
        collectionRow.collectionId !== liveCollectionId
    ) {
        return {status: 'unknown', reason: 'collection-identity-mismatch'};
    }

    if (!Number.isInteger(collectionRow.dimension) || collectionRow.dimension <= 0) {
        return {status: 'unknown', reason: 'invalid-collection-dimension'};
    }

    const segments       = Array.isArray(registry.segments) ? registry.segments : [],
          vectorSegments = segments.filter(seg =>
              seg?.collection === collectionRow.collectionId && seg?.scope === 'VECTOR'
          );

    if (vectorSegments.length === 0) {
        return {status: 'unknown', reason: 'kb-vector-segment-missing'};
    }

    let   hnswOccupancy    = 0;
    const vectorSegmentIds = [];

    for (const segment of vectorSegments) {
        if (typeof segment.id !== 'string' || segment.id.length === 0) {
            return {status: 'unknown', reason: 'invalid-vector-segment-id'};
        }
        const headerBytes  = headersBySegmentId?.[segment.id],
              parsedHeader = parseChroma159HnswHeader(headerBytes, {expectedDimension: collectionRow.dimension});

        if (!parsedHeader.ok) {
            return {status: 'unknown', reason: parsedHeader.reason};
        }

        vectorSegmentIds.push(segment.id);
        hnswOccupancy += parsedHeader.hnswOccupancy;
    }

    if (!Number.isSafeInteger(liveCount) || liveCount < 0) {
        return {status: 'unknown', reason: 'invalid-live-count'};
    }

    const postCheckpointLogCount = registry.postCheckpointLogCount ?? 0,
          vectorCheckpointSeqId  = registry.vectorCheckpointSeqId ?? null,
          maxKnownSeqId          = registry.maxKnownSeqId ?? null;

    if (!Number.isSafeInteger(postCheckpointLogCount) || postCheckpointLogCount < 0) {
        return {status: 'unknown', reason: 'invalid-post-checkpoint-log-count'};
    }

    if (
        Number.isSafeInteger(vectorCheckpointSeqId) &&
        Number.isSafeInteger(maxKnownSeqId) &&
        vectorCheckpointSeqId > maxKnownSeqId
    ) {
        return {status: 'unknown', reason: 'checkpoint-ahead-of-log'};
    }

    if (liveCount > hnswOccupancy + postCheckpointLogCount) {
        return {status: 'unknown', reason: 'live-count-exceeds-occupancy-and-log-tail'};
    }

    const deadElementCount = Math.max(0, hnswOccupancy - liveCount),
          deadFraction     = hnswOccupancy > 0 ? deadElementCount / hnswOccupancy : 0;

    return {
        status        : 'ok',
        collection    : collectionName,
        databaseName,
        collectionId  : collectionRow.collectionId,
        dimension     : collectionRow.dimension,
        vectorSegmentIds,
        hnswOccupancy,
        liveCount,
        deadElementCount,
        deadFraction,
        postCheckpointLogCount,
        vectorCheckpointSeqId,
        runtimeBinding: {
            composeProject   : runtimeBinding.composeProject,
            chromaServiceKey : runtimeBinding.chromaServiceKey,
            chromaContainerId: runtimeBinding.chromaContainerId,
            chromaVolume     : runtimeBinding.chromaVolume,
            chromaImage      : runtimeBinding.chromaImage || `chromadb/chroma:${versionCheck.version}`,
            endpointHost     : runtimeBinding.endpointHost ?? null,
            endpointPort     : runtimeBinding.endpointPort ?? null
        }
    };
}

/**
 * @summary Pure detect-producer for KB dead HNSW elements.
 *
 * Returns a `recovery-diagnosis` event carrying a per-collection `store-bloat` fact when
 * `(hnswOccupancy - liveCount) / hnswOccupancy > gcDefragThreshold`; `null` at or below threshold;
 * `{status: 'unverified', reason}` on a hot rollback journal; and `{status: 'unknown', reason}` on
 * any version, identity, header-geometry, or checkpoint incoherence.
 *
 * @param {Object} options
 * @param {Object} [options.observation] Optional pre-evaluated observation from {@link evaluateKbDeadElementObservation}.
 * @param {Number} options.gcDefragThreshold Dead-element fraction threshold (`AiConfig.knowledgeBase.gcDefragThreshold`).
 * @param {Number} options.observedAt Epoch milliseconds when observed.
 * @param {String} options.serviceId Target compose-service id (`mc-server` on the shared data-integrity runner).
 * @returns {Object|null}
 */
export function buildKbDeadElementDiagnosis({
    observation = null,
    gcDefragThreshold,
    observedAt,
    serviceId,
    ...rawInputs
} = {}) {
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
        throw new TypeError('buildKbDeadElementDiagnosis: serviceId is required');
    }
    if (!Number.isFinite(observedAt)) {
        throw new TypeError('buildKbDeadElementDiagnosis: observedAt must be a finite number');
    }

    const evaluated = observation && typeof observation.status === 'string'
        ? observation
        : evaluateKbDeadElementObservation(rawInputs);

    if (evaluated.status === 'unverified') {
        return {status: 'unverified', reason: evaluated.reason};
    }

    if (evaluated.status !== 'ok') {
        return {status: 'unknown', reason: evaluated.reason || 'incoherent-observation'};
    }

    if (!Number.isFinite(gcDefragThreshold) || gcDefragThreshold <= 0 || evaluated.deadFraction <= gcDefragThreshold) {
        return null;
    }

    const fact = {
        type                  : 'store-bloat',
        signal                : 'dead-elements',
        collection            : evaluated.collection,
        collectionId          : evaluated.collectionId,
        vectorSegmentIds      : evaluated.vectorSegmentIds,
        hnswOccupancy         : evaluated.hnswOccupancy,
        liveCount             : evaluated.liveCount,
        deadElementCount      : evaluated.deadElementCount,
        deadFraction          : evaluated.deadFraction,
        thresholdRatio        : gcDefragThreshold,
        postCheckpointLogCount: evaluated.postCheckpointLogCount,
        chromaServiceKey      : evaluated.runtimeBinding.chromaServiceKey,
        chromaContainerId     : evaluated.runtimeBinding.chromaContainerId,
        chromaVolume          : evaluated.runtimeBinding.chromaVolume
    };

    return createRecoveryDiagnosisEvent({
        diagnosisId   : `data-integrity:${evaluated.collection}:dead-elements:${observedAt}`,
        recoveryClass : 'data-integrity',
        confidence    : 1,
        targetIdentity: {kind: 'compose-service', id: serviceId},
        evidenceFacts : [fact],
        observedAt,
        source        : 'data-integrity-kb-dead-elements-monitor',
        details       : {
            reasonCode      : 'data-integrity-kb-dead-elements',
            collection      : evaluated.collection,
            hnswOccupancy   : evaluated.hnswOccupancy,
            liveCount       : evaluated.liveCount,
            deadElementCount: evaluated.deadElementCount,
            deadFraction    : evaluated.deadFraction,
            thresholdRatio  : gcDefragThreshold
        }
    });
}
