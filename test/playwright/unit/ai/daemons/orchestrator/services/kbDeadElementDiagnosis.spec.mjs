import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    buildKbDeadElementDiagnosis,
    CHROMA_159_MIGRATIONS,
    evaluateKbDeadElementObservation,
    HNSW_HEADER_BYTE_LENGTH,
    HNSW_PERSISTENCE_VERSION,
    parseChroma159HnswHeader,
    parseChromaImageVersion
} from '../../../../../../../ai/daemons/orchestrator/services/kbDeadElementDiagnosis.mjs';

void Neo;
void core;

const KB_COLLECTION    = 'neo-knowledge-base';
const KB_COLLECTION_ID = '8a49c911-3d21-4eb0-a822-6c7a09c9b143';
const KB_VECTOR_SEG_ID = 'c71d29ae-0d58-4a34-9c66-4f8c1d18a901';
const VECTOR_DIM       = 1024;
const THRESHOLD        = 0.10;
const OBSERVED_AT      = 1732345000000;

function buildChroma159HeaderBuffer({
    persistenceVersion = HNSW_PERSISTENCE_VERSION,
    offsetLevel0       = 0n,
    maxElements        = 300_000n,
    curElementCount    = 253_743n,
    dimension          = VECTOR_DIM,
    maxLevel           = 4,
    enterpointNode     = 42,
    maxM               = 16n,
    maxM0              = 32n,
    m                  = 16n,
    mult               = 0.36067376022224085,
    efConstruction     = 100n,
    offsetDataOverride = null,
    labelOffsetOverride = null,
    sizeDataOverride    = null
} = {}) {
    const buf         = Buffer.alloc(HNSW_HEADER_BYTE_LENGTH),
          offsetData  = offsetDataOverride ?? (4n + maxM0 * 4n),
          labelOffset = labelOffsetOverride ?? (offsetData + BigInt(dimension) * 4n),
          sizeData    = sizeDataOverride ?? (labelOffset + 8n);

    buf.writeInt32LE(persistenceVersion, 0);
    buf.writeBigUInt64LE(offsetLevel0, 4);
    buf.writeBigUInt64LE(maxElements, 12);
    buf.writeBigUInt64LE(curElementCount, 20);
    buf.writeBigUInt64LE(sizeData, 28);
    buf.writeBigUInt64LE(labelOffset, 36);
    buf.writeBigUInt64LE(offsetData, 44);
    buf.writeInt32LE(maxLevel, 52);
    buf.writeUInt32LE(enterpointNode, 56);
    buf.writeBigUInt64LE(maxM, 60);
    buf.writeBigUInt64LE(maxM0, 68);
    buf.writeBigUInt64LE(m, 76);
    buf.writeDoubleLE(mult, 84);
    buf.writeBigUInt64LE(efConstruction, 92);

    return buf;
}

function validRuntimeBinding(overrides = {}) {
    return {
        composeProject          : 'neo-agent-os',
        chromaServiceKey        : 'chroma',
        expectedChromaServiceKey: 'chroma',
        chromaContainerId       : '9f4b1a0c2d8e4b6a1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b',
        chromaRunning           : true,
        chromaImage             : 'chromadb/chroma:1.5.9@sha256:deadbeef',
        chromaVolume            : 'neo-agent-os_chroma-data',
        orchestratorVolume      : 'neo-agent-os_chroma-data',
        readOnlyMountVerified   : true,
        endpointHost            : 'chroma',
        endpointPort            : 8000,
        expectedEndpointHost    : 'chroma',
        ...overrides
    };
}

function validRegistry(overrides = {}) {
    return {
        migrationsByDir: {...CHROMA_159_MIGRATIONS},
        collections    : [{
            collectionId  : KB_COLLECTION_ID,
            collectionName: KB_COLLECTION,
            dimension     : VECTOR_DIM,
            databaseName  : 'default_database',
            tenantId      : 'default_tenant'
        }],
        segments              : [
            {id: 'meta-seg-1', scope: 'METADATA', type: 'urn:chroma:segment/metadata/sqlite', collection: KB_COLLECTION_ID},
            {id: KB_VECTOR_SEG_ID, scope: 'VECTOR', type: 'urn:chroma:segment/vector/hnsw-local-persisted', collection: KB_COLLECTION_ID}
        ],
        vectorCheckpointSeqId : 1_200_000,
        postCheckpointLogCount: 0,
        maxKnownSeqId         : 1_200_000,
        ...overrides
    };
}

test.describe('kbDeadElementDiagnosis — Chroma 1.5.9 HNSW header & dead-element producer (#1434)', () => {
    test('parseChromaImageVersion admits chromadb/chroma:1.5.9 (with or without digest) and rejects other tags/repos', () => {
        expect(parseChromaImageVersion('chromadb/chroma:1.5.9')).toEqual({ok: true, version: '1.5.9'});
        expect(parseChromaImageVersion('ghcr.io/chromadb/chroma:1.5.9@sha256:abc123')).toEqual({ok: true, version: '1.5.9'});
        expect(parseChromaImageVersion('chromadb/chroma:1.6.0')).toMatchObject({ok: false, reason: 'unsupported-chroma-version'});
        expect(parseChromaImageVersion('chromadb/chroma:1.0.16')).toMatchObject({ok: false, reason: 'unsupported-chroma-version'});
        expect(parseChromaImageVersion('chromadb/chroma')).toMatchObject({ok: false, reason: 'untagged-chroma-image'});
        expect(parseChromaImageVersion('postgres:1.5.9')).toMatchObject({ok: false, reason: 'unexpected-chroma-repository'});
        expect(parseChromaImageVersion('')).toMatchObject({ok: false, reason: 'missing-chroma-image'});
    });

    test('parseChroma159HnswHeader decodes 100-byte HEADER_FIELDS layout and rejects malformed headers', () => {
        const parsed = parseChroma159HnswHeader(buildChroma159HeaderBuffer(), {expectedDimension: VECTOR_DIM});
        expect(parsed).toMatchObject({
            ok                : true,
            persistenceVersion: 1,
            maxElements       : 300_000,
            hnswOccupancy     : 253_743,
            dimension         : VECTOR_DIM,
            m                 : 16,
            maxM              : 16,
            maxM0             : 32,
            efConstruction    : 100
        });

        expect(parseChroma159HnswHeader(Buffer.alloc(96), {expectedDimension: VECTOR_DIM}))
            .toEqual({ok: false, reason: 'invalid-header-length'});
        expect(parseChroma159HnswHeader(buildChroma159HeaderBuffer({persistenceVersion: 2}), {expectedDimension: VECTOR_DIM}))
            .toEqual({ok: false, reason: 'unsupported-header-persistence-version'});
        expect(parseChroma159HnswHeader(buildChroma159HeaderBuffer({dimension: 768}), {expectedDimension: VECTOR_DIM}))
            .toEqual({ok: false, reason: 'header-dimension-mismatch'});
        expect(parseChroma159HnswHeader(buildChroma159HeaderBuffer({curElementCount: 400_000n, maxElements: 300_000n})))
            .toEqual({ok: false, reason: 'invalid-header-element-bounds'});
    });

    test('AC-3: emits a per-collection KB dead-element diagnosis when dead fraction exceeds gcDefragThreshold, keeping occupancy and live count distinct', () => {
        const diagnosis = buildKbDeadElementDiagnosis({
            runtimeBinding    : validRuntimeBinding(),
            registry          : validRegistry(),
            headersBySegmentId: {[KB_VECTOR_SEG_ID]: buildChroma159HeaderBuffer({curElementCount: 253_743n})},
            liveCollectionId  : KB_COLLECTION_ID,
            liveCount         : 86_560,
            gcDefragThreshold : THRESHOLD,
            observedAt        : OBSERVED_AT,
            serviceId         : 'mc-server'
        });

        expect(diagnosis).toMatchObject({
            diagnosisId   : `data-integrity:${KB_COLLECTION}:dead-elements:${OBSERVED_AT}`,
            type          : 'recovery-diagnosis',
            recoveryClass : 'data-integrity',
            confidence    : 1,
            targetIdentity: {kind: 'compose-service', id: 'mc-server'},
            source        : 'data-integrity-kb-dead-elements-monitor',
            details       : {
                reasonCode      : 'data-integrity-kb-dead-elements',
                collection      : KB_COLLECTION,
                hnswOccupancy   : 253_743,
                liveCount       : 86_560,
                deadElementCount: 167_183,
                thresholdRatio  : THRESHOLD
            }
        });
        expect(diagnosis.evidenceFacts).toHaveLength(1);
        expect(diagnosis.evidenceFacts[0]).toMatchObject({
            type            : 'store-bloat',
            signal          : 'dead-elements',
            collection      : KB_COLLECTION,
            collectionId    : KB_COLLECTION_ID,
            vectorSegmentIds: [KB_VECTOR_SEG_ID],
            hnswOccupancy   : 253_743,
            liveCount       : 86_560,
            deadElementCount: 167_183,
            thresholdRatio  : THRESHOLD,
            chromaServiceKey: 'chroma',
            chromaVolume    : 'neo-agent-os_chroma-data'
        });
        expect(diagnosis.evidenceFacts[0].deadFraction).toBeCloseTo(167_183 / 253_743, 6);
    });

    test('AC-3: returns null at or below gcDefragThreshold (including coherent uncompacted log tail)', () => {
        const atBoundary = buildKbDeadElementDiagnosis({
            runtimeBinding    : validRuntimeBinding(),
            registry          : validRegistry(),
            headersBySegmentId: {[KB_VECTOR_SEG_ID]: buildChroma159HeaderBuffer({curElementCount: 100n, maxElements: 1000n})},
            liveCollectionId  : KB_COLLECTION_ID,
            liveCount         : 90,
            gcDefragThreshold : THRESHOLD,
            observedAt        : OBSERVED_AT,
            serviceId         : 'mc-server'
        });
        expect(atBoundary).toBeNull();

        const belowBoundary = buildKbDeadElementDiagnosis({
            runtimeBinding    : validRuntimeBinding(),
            registry          : validRegistry(),
            headersBySegmentId: {[KB_VECTOR_SEG_ID]: buildChroma159HeaderBuffer({curElementCount: 100n, maxElements: 1000n})},
            liveCollectionId  : KB_COLLECTION_ID,
            liveCount         : 95,
            gcDefragThreshold : THRESHOLD,
            observedAt        : OBSERVED_AT,
            serviceId         : 'mc-server'
        });
        expect(belowBoundary).toBeNull();

        const withLogTail = evaluateKbDeadElementObservation({
            runtimeBinding    : validRuntimeBinding(),
            registry          : validRegistry({postCheckpointLogCount: 12, maxKnownSeqId: 1_200_012}),
            headersBySegmentId: {[KB_VECTOR_SEG_ID]: buildChroma159HeaderBuffer({curElementCount: 95n, maxElements: 1000n})},
            liveCollectionId  : KB_COLLECTION_ID,
            liveCount         : 100
        });
        expect(withLogTail).toMatchObject({status: 'ok', hnswOccupancy: 95, liveCount: 100, deadElementCount: 0, deadFraction: 0});
        expect(buildKbDeadElementDiagnosis({
            observation      : withLogTail,
            gcDefragThreshold: THRESHOLD,
            observedAt       : OBSERVED_AT,
            serviceId        : 'mc-server'
        })).toBeNull();
    });

    test('AC-3: returns unverified on a hot rollback journal', () => {
        const result = buildKbDeadElementDiagnosis({
            journalState     : 'hot',
            journalReason    : 'SQLITE_READONLY_ROLLBACK',
            gcDefragThreshold: THRESHOLD,
            observedAt       : OBSERVED_AT,
            serviceId        : 'mc-server'
        });

        expect(result).toEqual({status: 'unverified', reason: 'SQLITE_READONLY_ROLLBACK'});
    });

    test('AC-3: returns unknown on Chroma version, schema, identity, or checkpoint mismatch', () => {
        const base = {
            runtimeBinding    : validRuntimeBinding(),
            registry          : validRegistry(),
            headersBySegmentId: {[KB_VECTOR_SEG_ID]: buildChroma159HeaderBuffer({curElementCount: 253_743n})},
            liveCollectionId  : KB_COLLECTION_ID,
            liveCount         : 86_560,
            gcDefragThreshold : THRESHOLD,
            observedAt        : OBSERVED_AT,
            serviceId         : 'mc-server'
        };

        expect(buildKbDeadElementDiagnosis({
            ...base,
            runtimeBinding: validRuntimeBinding({chromaImage: 'chromadb/chroma:1.6.0'})
        })).toEqual({status: 'unknown', reason: 'unsupported-chroma-version'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            registry: validRegistry({migrationsByDir: {...CHROMA_159_MIGRATIONS, sysdb: 11}})
        })).toEqual({status: 'unknown', reason: 'unsupported-sqlite-schema-version'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            runtimeBinding: validRuntimeBinding({readOnlyMountVerified: false, reason: 'store-mount-not-readonly'})
        })).toEqual({status: 'unknown', reason: 'store-mount-not-readonly'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            runtimeBinding: validRuntimeBinding({orchestratorVolume: 'other-volume'})
        })).toEqual({status: 'unknown', reason: 'volume-identity-mismatch'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            runtimeBinding: validRuntimeBinding({endpointHost: '127.0.0.1'})
        })).toEqual({status: 'unknown', reason: 'endpoint-identity-mismatch'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            liveCollectionId: 'different-collection-uuid'
        })).toEqual({status: 'unknown', reason: 'collection-identity-mismatch'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            headersBySegmentId: {[KB_VECTOR_SEG_ID]: buildChroma159HeaderBuffer({curElementCount: 0n})},
            registry          : validRegistry({postCheckpointLogCount: 0}),
            liveCount         : 86_560
        })).toEqual({status: 'unknown', reason: 'live-count-exceeds-occupancy-and-log-tail'});

        expect(buildKbDeadElementDiagnosis({
            ...base,
            registry: validRegistry({vectorCheckpointSeqId: 1_500_000, maxKnownSeqId: 1_200_000})
        })).toEqual({status: 'unknown', reason: 'checkpoint-ahead-of-log'});
    });

    test('rejects missing serviceId or non-finite observedAt', () => {
        expect(() => buildKbDeadElementDiagnosis({gcDefragThreshold: THRESHOLD, observedAt: OBSERVED_AT}))
            .toThrow(/serviceId/);
        expect(() => buildKbDeadElementDiagnosis({gcDefragThreshold: THRESHOLD, serviceId: 'mc-server'}))
            .toThrow(/observedAt/);
    });
});
