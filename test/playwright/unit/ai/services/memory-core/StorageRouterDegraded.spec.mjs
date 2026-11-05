import {setup} from '../../../../setup.mjs';

const appName = 'StorageRouterDegradedTest';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}        from '@playwright/test';
import fs                    from 'fs';
import path                  from 'path';
import {fileURLToPath}       from 'url';
import * as yaml             from 'js-yaml';
import Neo                   from 'neo.mjs/src/Neo.mjs';
import * as core             from 'neo.mjs/src/core/_export.mjs';
import StorageRouter         from '../../../../../../ai/services/memory-core/managers/StorageRouter.mjs';
import SummaryService        from '../../../../../../ai/services/memory-core/SummaryService.mjs';
import MemoryService         from '../../../../../../ai/services/memory-core/MemoryService.mjs';
import GraphService          from '../../../../../../ai/services/memory-core/GraphService.mjs';
import ContextAssembler      from '../../../../../../ai/context/Assembler.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Pure unit coverage for the degraded-query observability contract: injectQueryReRanker must stay
// non-throwing on a Pass-1 query failure (preserving the Pass-2 resilience the catch exists for) but
// stamp a _degraded marker instead of a silent clean-empty, so a corrupt/unqueryable collection is
// distinguishable from a genuine no-match. No Chroma substrate needed — a mock proxy whose query()
// throws (or returns a real empty) exercises the catch and early-return branches directly, so this
// runs in CI rather than the bucket-C substrate gate that the sibling re-ranker spec sits behind.
test.describe('StorageRouter degraded-query observability', () => {
    const makeRerankedProxy = (collectionType, queryImpl) => {
        const proxy = {query: queryImpl};
        StorageRouter.injectQueryReRanker(proxy, collectionType);
        return proxy;
    };

    test('stamps a _degraded marker (not a silent empty) when Pass-1 throws the corruption signature', async () => {
        const proxy = makeRerankedProxy('summary', async () => {
            throw new Error('Error executing plan: Internal error: Error finding id');
        });

        const res = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 1});

        // Non-throwing + still shaped like an empty result (Pass-2 pipeline resilience preserved)...
        expect(res.ids).toEqual([[]]);
        // ...but explicitly marked degraded, so a corrupt collection is NOT a silent no-match.
        expect(res._degraded).toBe(true);
        expect(res._degradedCollection).toBe('summary');
        expect(res._degradedSignature).toBe('chroma-error-finding-id');
        expect(res._degradedReason).toContain('Error finding id');
    });

    test('tags a non-corruption query error with the generic signature, still named by collection', async () => {
        const proxy = makeRerankedProxy('memory', async () => {
            throw new Error('connection refused');
        });

        const res = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 1});

        expect(res._degraded).toBe(true);
        expect(res._degradedCollection).toBe('memory');
        expect(res._degradedSignature).toBe('chroma-query-error');
    });

    test('does NOT mark a genuine empty result as degraded', async () => {
        const proxy = makeRerankedProxy('summary', async () => ({
            ids: [[]], distances: [[]], metadatas: [[]], documents: undefined
        }));

        const res = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 1});

        // A real no-match returns the raw empty result WITHOUT a _degraded marker — this is the
        // distinction the whole fix exists to preserve (degraded query path vs genuine no-match).
        expect(res._degraded).toBeUndefined();
        expect(res.ids).toEqual([[]]);
    });
});

// Consumer-surface coverage: the tool-facing readers must translate the _degraded marker into an
// explicit QUERY_PATH_DEGRADED envelope, so a degraded query path is distinguishable from a genuine
// no-match (which returns count:0 WITHOUT `degraded`). Pure unit — a degraded collection is mocked at
// the StorageRouter boundary; no Chroma substrate.
test.describe('memory-core degraded-query tool envelopes', () => {
    const degradedCollection = collectionType => ({
        query: async () => ({
            ids                : [[]], distances: [[]], metadatas: [[]], documents: undefined,
            _degraded          : true,
            _degradedReason    : 'Error executing plan: Internal error: Error finding id',
            _degradedCollection: collectionType,
            _degradedSignature : 'chroma-error-finding-id'
        })
    });

    const runAs = fn => RequestContextService.run(
        {agentIdentityNodeId: '@neo-opus-grace', source: 'unit-test', userId: 'neo-opus-grace'}, fn
    );

    test('querySummaries returns a QUERY_PATH_DEGRADED envelope (not a silent {count:0}) on a degraded collection', async () => {
        const orig = StorageRouter.getSummaryCollection;
        StorageRouter.getSummaryCollection = async () => degradedCollection('summary');

        try {
            const res = await runAs(() => SummaryService.querySummaries({query: 'anything', nResults: 3}));

            expect(res.degraded).toBe(true);
            expect(res.code).toBe('QUERY_PATH_DEGRADED');
            expect(res.collection).toBe('summary');
            expect(res.count).toBe(0);
            expect(res.results).toEqual([]);
            expect(res.message).toContain('Error finding id');
        } finally {
            StorageRouter.getSummaryCollection = orig;
        }
    });

    test('queryMemories returns a QUERY_PATH_DEGRADED envelope (not a silent {count:0}) on a degraded collection', async () => {
        const orig = StorageRouter.getMemoryCollection;
        StorageRouter.getMemoryCollection = async () => degradedCollection('memory');

        try {
            const res = await runAs(() => MemoryService.queryMemories({query: 'anything', nResults: 3}));

            expect(res.degraded).toBe(true);
            expect(res.code).toBe('QUERY_PATH_DEGRADED');
            expect(res.collection).toBe('memory');
            expect(res.count).toBe(0);
            expect(res.results).toEqual([]);
        } finally {
            StorageRouter.getMemoryCollection = orig;
        }
    });

    // The healthcheck query-canary was removed (it bloated the always-on payload); the same detection
    // now lives as an on-demand StorageRouter method (+ ai/scripts/maintenance/probeCollectionQueryHealth.mjs).
    // This proves the capability survives the move: a populated-but-unqueryable collection still surfaces
    // as degraded (named, with signature) when an operator opts in to probe.
    test('StorageRouter.probeCollectionQueryHealth() surfaces a degraded collection on-demand (off the healthcheck path)', async () => {
        const origMem = StorageRouter.getMemoryCollection,
              origSum = StorageRouter.getSummaryCollection;

        StorageRouter.getMemoryCollection  = async () => ({
            count: async () => 5,
            query: async () => ({ids: [[]], distances: [[]], metadatas: [[]], documents: undefined})
        });
        StorageRouter.getSummaryCollection = async () => ({
            count: async () => 20,
            query: async () => ({
                ids                : [[]], distances: [[]], metadatas: [[]], documents: undefined,
                _degraded          : true,
                _degradedReason    : 'Error executing plan: Internal error: Error finding id',
                _degradedCollection: 'summary',
                _degradedSignature : 'chroma-error-finding-id'
            })
        });

        try {
            const res = await StorageRouter.probeCollectionQueryHealth();

            expect(res.status).toBe('degraded');
            expect(res.collections.memory.status).toBe('healthy');
            expect(res.collections.summary.status).toBe('degraded');
            expect(res.collections.summary.signature).toBe('chroma-error-finding-id');
        } finally {
            StorageRouter.getMemoryCollection  = origMem;
            StorageRouter.getSummaryCollection = origSum;
        }
    });
});

test.describe('StorageRouter compositeScore & reRanked exposure (#312)', () => {
    const runAs = fn => RequestContextService.run(
        {agentIdentityNodeId: '@neo-opus-grace', source: 'unit-test', userId: 'neo-opus-grace'}, fn
    );

    test('AC-1 & AC-2: injectQueryReRanker returns 6-decimal compositeScores and re-orders when compositeScore disagrees with distance', async () => {
        const origFrontier = GraphService.getContextFrontier;
        const origGravity  = GraphService.getNodeGravity;

        // id-closer: distance = 0.2 -> semanticScore = 1 / 1.2 = 0.833333, multiplier = 1.0 -> compositeScore = 0.833333
        // id-boosted: distance = 0.5 -> semanticScore = 1 / 1.5 = 0.666667, strategic weight +1.5 -> multiplier = 2.5 -> compositeScore = 1.666667
        GraphService.getContextFrontier = () => ({
            strategicNeighbors: [{id: 'id-boosted', weight: 1.5}]
        });
        GraphService.getNodeGravity = () => null;

        try {
            const proxy = {
                query: async () => ({
                    ids      : [['id-closer', 'id-boosted']],
                    distances: [[0.2, 0.5]],
                    metadatas: [[{sessionId: 's1'}, {sessionId: 's2'}]],
                    documents: [['closer doc', 'boosted doc']]
                })
            };
            StorageRouter.injectQueryReRanker(proxy, 'memory');

            const res = await proxy.query({queryTexts: ['rerank probe'], nResults: 2});

            expect(res._reRanked).toBe(true);
            // Distance order was ['id-closer', 'id-boosted'], but compositeScore order is ['id-boosted', 'id-closer']
            expect(res.ids).toEqual([['id-boosted', 'id-closer']]);
            expect(res.distances).toEqual([[0.5, 0.2]]);
            expect(res.compositeScores).toEqual([[1.666667, 0.833333]]);
        } finally {
            GraphService.getContextFrontier = origFrontier;
            GraphService.getNodeGravity     = origGravity;
        }
    });

    test('AC-1, AC-2 & AC-3: queryMemories preserves index-parallel compositeScore across tombstone live + filteredIndices and detail="summary"', async () => {
        const origMem         = StorageRouter.getMemoryCollection;
        const origMiniSummary = MemoryService._getMiniSummariesByIds;

        // 4 re-ranked rows returned by collection.query:
        // [0] mem-archived (tombstoned -> dropped by `live` filter)
        // [1] mem-untrusted (trustTier: 'untrusted' -> dropped by `filteredIndices` when minTrustTier='peer')
        // [2] mem-boosted (distance: 0.5 -> relevanceScore: 0.666667, compositeScore: 1.666667)
        // [3] mem-closer  (distance: 0.2 -> relevanceScore: 0.833333, compositeScore: 0.833333)
        // Notice distance order and compositeScore order genuinely disagree on the two survivors!
        StorageRouter.getMemoryCollection = async () => ({
            query: async () => ({
                ids            : [['mem-archived', 'mem-untrusted', 'mem-boosted', 'mem-closer']],
                distances      : [[0.1, 0.15, 0.5, 0.2]],
                compositeScores: [[2.5, 2.1, 1.666667, 0.833333]],
                _reRanked      : true,
                metadatas      : [[
                    {sessionId: 's0', timestamp: 1700000000000, archivedAt: '2026-11-01T00:00:00Z', agentIdentity: '@neo-opus-grace', userId: 'neo-opus-grace'},
                    {sessionId: 's1', timestamp: 1700000001000, trustTier: 'external-untrusted', agentIdentity: '@external', userId: 'neo-opus-grace'},
                    {sessionId: 's2', timestamp: 1700000002000, prompt: 'p-boosted', thought: 't-boosted', response: 'r-boosted', type: 'agent-interaction', agentIdentity: '@neo-opus-grace', userId: 'neo-opus-grace'},
                    {sessionId: 's3', timestamp: 1700000003000, prompt: 'p-closer',  thought: 't-closer',  response: 'r-closer',  type: 'agent-interaction', agentIdentity: '@neo-opus-grace', userId: 'neo-opus-grace'}
                ]]
            })
        });
        MemoryService._getMiniSummariesByIds = () => new Map([
            ['mem-boosted', 'Boosted mini summary'],
            ['mem-closer',  'Closer mini summary']
        ]);

        try {
            const fullRes = await runAs(() => MemoryService.queryMemories({
                query       : 'rerank filter probe',
                nResults    : 2,
                minTrustTier: 'peer-trusted',
                detail      : 'full'
            }));

            expect(fullRes.reRanked).toBe(true);
            expect(fullRes.count).toBe(2);
            expect(fullRes.results.map(r => r.id)).toEqual(['mem-boosted', 'mem-closer']);
            // Disagreement witness: mem-boosted ranks first with LOWER relevanceScore (0.666667 < 0.833333)
            // because its compositeScore is HIGHER (1.666667 > 0.833333).
            expect(fullRes.results[0].relevanceScore).toBe(0.666667);
            expect(fullRes.results[0].compositeScore).toBe(1.666667);
            expect(fullRes.results[1].relevanceScore).toBe(0.833333);
            expect(fullRes.results[1].compositeScore).toBe(0.833333);

            // AC-3: detail === 'summary' forwards compositeScore
            const summaryRes = await runAs(() => MemoryService.queryMemories({
                query       : 'rerank filter probe',
                nResults    : 2,
                minTrustTier: 'peer-trusted',
                detail      : 'summary'
            }));

            expect(summaryRes.reRanked).toBe(true);
            expect(summaryRes.results.map(r => ({
                id            : r.id,
                relevanceScore: r.relevanceScore,
                compositeScore: r.compositeScore,
                miniSummary   : r.miniSummary
            }))).toEqual([
                {id: 'mem-boosted', relevanceScore: 0.666667, compositeScore: 1.666667, miniSummary: 'Boosted mini summary'},
                {id: 'mem-closer',  relevanceScore: 0.833333, compositeScore: 0.833333, miniSummary: 'Closer mini summary'}
            ]);
        } finally {
            StorageRouter.getMemoryCollection    = origMem;
            MemoryService._getMiniSummariesByIds = origMiniSummary;
        }
    });

    test('AC-1, AC-2 & AC-5: querySummaries preserves compositeScore on both fast exit (!needsPostFilter) and needsPostFilter, and Assembler output is byte-identical', async () => {
        const origSum = StorageRouter.getSummaryCollection;

        // [0] sum-filtered (foreign private row dropped by needsPostFilter)
        // [1] sum-boosted (distance: 0.5 -> relevanceScore: 0.666667, compositeScore: 1.666667)
        // [2] sum-closer  (distance: 0.2 -> relevanceScore: 0.833333, compositeScore: 0.833333)
        StorageRouter.getSummaryCollection = async () => ({
            query: async () => ({
                ids            : [['sum-filtered', 'sum-boosted', 'sum-closer']],
                distances      : [[0.1, 0.5, 0.2]],
                compositeScores: [[2.2, 1.666667, 0.833333]],
                _reRanked      : true,
                documents      : [['Filtered doc', 'Boosted summary doc', 'Closer summary doc']],
                metadatas      : [[
                    {sessionId: 'sf', timestamp: 1700000000000, title: 'Filtered', userId: 'other-tenant', sourceTrustTier: 'peer-trusted'},
                    {sessionId: 'sb', timestamp: 1700000001000, title: 'Boosted Title', userId: 'neo-opus-grace', sourceTrustTier: 'peer-trusted'},
                    {sessionId: 'sc', timestamp: 1700000002000, title: 'Closer Title',  userId: 'neo-opus-grace', sourceTrustTier: 'peer-trusted'}
                ]]
            })
        });

        try {
            // 1. needsPostFilter path (default team policy with userId in context)
            const postFiltered = await runAs(() => SummaryService.querySummaries({
                query   : 'summary rerank probe',
                nResults: 2
            }));

            expect(postFiltered.reRanked).toBe(true);
            expect(postFiltered.results.map(r => r.id)).toEqual(['sum-boosted', 'sum-closer']);
            expect(postFiltered.results[0].relevanceScore).toBe(0.666667);
            expect(postFiltered.results[0].compositeScore).toBe(1.666667);
            expect(postFiltered.results[1].relevanceScore).toBe(0.833333);
            expect(postFiltered.results[1].compositeScore).toBe(0.833333);

            // 2. Fast exit (!needsPostFilter: memorySharing='private' scopes via DB where, no JS post-filter)
            const fastExit = await runAs(() => SummaryService.querySummaries({
                query        : 'summary rerank probe',
                nResults     : 3,
                memorySharing: 'private'
            }));

            expect(fastExit.reRanked).toBe(true);
            expect(fastExit.results.map(r => r.compositeScore)).toEqual([2.2, 1.666667, 0.833333]);

            // 3. AC-5: ContextAssembler.prototype.formatSummaryContext output is byte-identical
            const formatted = ContextAssembler.prototype.formatSummaryContext(postFiltered.results);
            expect(formatted).toBe(
                '\n\nRelevant Context from Past Sessions:\n' +
                '- [Boosted Title] (Relevance: 0.666667): Boosted summary doc\n' +
                '- [Closer Title] (Relevance: 0.833333): Closer summary doc'
            );
        } finally {
            StorageRouter.getSummaryCollection = origSum;
        }
    });

    test('AC-4: compositeScore is absent (never 0 or null) when _reRanked is false/absent and on via="concept-walk" rows; reRanked boolean is on all envelopes', async () => {
        const origMem         = StorageRouter.getMemoryCollection;
        const origSum         = StorageRouter.getSummaryCollection;
        const origListRecords = GraphService.listNodeRecordsByType;
        const origDb          = GraphService.db;
        const origNodeVis     = GraphService.isNodeVisibleToRequester;
        const origEdgeVis     = GraphService.isEdgeVisibleToRequester;
        const origMiniSummary = MemoryService._getMiniSummariesByIds;

        try {
            // A. Un-reranked collection (_reRanked absent) -> reRanked: false, compositeScore key absent
            StorageRouter.getMemoryCollection = async () => ({
                query: async () => ({
                    ids      : [['mem-raw']],
                    distances: [[0.25]],
                    metadatas: [[{sessionId: 's-raw', timestamp: 1700000000000, prompt: 'p', thought: 't', response: 'r', type: 'agent-interaction', userId: 'neo-opus-grace'}]]
                })
            });
            StorageRouter.getSummaryCollection = async () => ({
                query: async () => ({
                    ids      : [['sum-raw']],
                    distances: [[0.25]],
                    documents: [['Raw summary']],
                    metadatas: [[{sessionId: 's-raw', timestamp: 1700000000000, title: 'Raw', userId: 'neo-opus-grace'}]]
                })
            });

            const rawMem = await runAs(() => MemoryService.queryMemories({query: 'raw', nResults: 1}));
            expect(rawMem.reRanked).toBe(false);
            expect('compositeScore' in rawMem.results[0]).toBe(false);

            const rawSum = await runAs(() => SummaryService.querySummaries({query: 'raw', nResults: 1}));
            expect(rawSum.reRanked).toBe(false);
            expect('compositeScore' in rawSum.results[0]).toBe(false);

            // B. conceptWalk: true -> reRanked on envelope, compositeScore on primary row, absent on via='concept-walk' row
            StorageRouter.getMemoryCollection = async () => ({
                query: async () => ({
                    ids            : [['mem-primary']],
                    distances      : [[0.5]],
                    compositeScores: [[1.25]],
                    _reRanked      : true,
                    metadatas      : [[{sessionId: 's-walk', timestamp: 1700000000000, prompt: 'p1', thought: 't1', response: 'r1', type: 'agent-interaction', userId: 'neo-opus-grace'}]]
                }),
                get: async ({ids}) => ({
                    ids,
                    metadatas: [{sessionId: 's-walk', timestamp: 1700000001000, prompt: 'p-walk', thought: 't-walk', response: 'r-walk', type: 'agent-interaction', userId: 'neo-opus-grace'}]
                })
            });
            GraphService.listNodeRecordsByType = ({type}) => type === 'CONCEPT'
                ? {records: [{id: 'CONCEPT:reranker', properties: {}}]}
                : {records: []};
            GraphService.db = {
                storage: {
                    db: {
                        prepare: () => ({
                            all: nodeId => nodeId === 'CONCEPT:reranker'
                                ? [{id: 'edge-1', source: 'CONCEPT:reranker', target: 'mem-walk', type: 'TAGGED_CONCEPT', data: JSON.stringify({properties: {weight: 1}})}]
                                : []
                        })
                    }
                },
                nodes: new Map([['mem-walk', {label: 'AGENT_MEMORY'}]])
            };
            GraphService.isNodeVisibleToRequester = () => true;
            GraphService.isEdgeVisibleToRequester = () => true;
            MemoryService._getMiniSummariesByIds = () => new Map([
                ['mem-primary', 'Primary summary'],
                ['mem-walk',    'Walk summary']
            ]);

            for (const detail of ['full', 'summary']) {
                const walkRes = await runAs(() => MemoryService.queryMemories({
                    query      : 'reranker',
                    nResults   : 2,
                    conceptWalk: true,
                    detail
                }));

                expect(walkRes.reRanked).toBe(true);
                expect(walkRes.results.map(r => r.id)).toEqual(['mem-primary', 'mem-walk']);
                expect(walkRes.results[0].compositeScore).toBe(1.25);
                expect(walkRes.results[1].via).toBe('concept-walk');
                expect('compositeScore' in walkRes.results[1]).toBe(false);
            }
        } finally {
            StorageRouter.getMemoryCollection     = origMem;
            StorageRouter.getSummaryCollection    = origSum;
            GraphService.listNodeRecordsByType    = origListRecords;
            GraphService.db                       = origDb;
            GraphService.isNodeVisibleToRequester = origNodeVis;
            GraphService.isEdgeVisibleToRequester = origEdgeVis;
            MemoryService._getMiniSummariesByIds  = origMiniSummary;
        }
    });

    test('AC-6: openapi.yaml declares reRanked on both response envelopes and compositeScore on both row schemas', () => {
        const specPath = path.resolve(__dirname, '../../../../../../ai/mcp/server/memory-core/openapi.yaml');
        const spec     = yaml.load(fs.readFileSync(specPath, 'utf8'));
        const schemas  = spec.components.schemas;

        expect(schemas.QueryMemoriesResponse.properties.reRanked?.type).toBe('boolean');
        expect(schemas.QuerySummariesResponse.properties.reRanked?.type).toBe('boolean');

        const memRowProps = schemas.MemorySearchResult.allOf?.[1]?.properties;
        const sumRowProps = schemas.SummarySearchResult.allOf?.[1]?.properties;

        expect(memRowProps?.compositeScore?.type).toBe('number');
        expect(sumRowProps?.compositeScore?.type).toBe('number');
    });
});
