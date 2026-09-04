import {setup} from '../../../../setup.mjs';

const appName = 'StorageRouterScoreExposureTest';

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

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import GraphService   from '../../../../../../ai/services/memory-core/GraphService.mjs';
import StorageRouter  from '../../../../../../ai/services/memory-core/managers/StorageRouter.mjs';

// Pure unit coverage for #312: the re-ranker sorts by `compositeScore` and, before this, discarded it
// at the re-pack — leaving callers only `distance`, whose derived `relevanceScore` is the FIRST FACTOR
// of that composite. Three maintainers read the visible number, saw an order it did not explain, and
// concluded the ranker was broken.
//
// A mock proxy plus a stubbed graph frontier exercises Pass 2 directly, so this runs in CI rather than
// behind the bucket-C substrate gate the sibling re-ranker spec sits under.
test.describe('StorageRouter re-ranker score exposure (#312)', () => {
    let originalGetContextFrontier, originalGetNodeGravity;

    // The fixture's whole point: `low-distance` wins on distance, `high-topology` wins on the composite.
    // If these two ever ordered the same way, every assertion below would pass against the pre-fix code
    // as well and the arm would witness nothing.
    //
    //   low-distance : 1/(1+0.10) = 0.909091 * 1.0 = 0.909091
    //   high-topology: 1/(1+0.30) = 0.769231 * 2.0 = 1.538462
    const rows = {
        ids      : [['low-distance', 'high-topology']],
        distances: [[0.10, 0.30]],
        metadatas: [[{sessionId: 's1'}, {sessionId: 's1'}]],
        documents: [['doc a', 'doc b']]
    };

    test.beforeEach(() => {
        originalGetContextFrontier = GraphService.getContextFrontier;
        originalGetNodeGravity     = GraphService.getNodeGravity;

        // Weight ONLY the worse-distance row, so topology is the sole reason the order inverts.
        GraphService.getContextFrontier = () => ({
            strategicNeighbors: [{id: 'high-topology', weight: 1.0}]
        });

        // Gravity off: the frontier weight alone drives the multiplier, so the expected numbers are
        // closed-form rather than dependent on whatever the live graph happens to hold.
        GraphService.getNodeGravity = () => null;
    });

    test.afterEach(() => {
        GraphService.getContextFrontier = originalGetContextFrontier;
        GraphService.getNodeGravity     = originalGetNodeGravity;
    });

    const makeRerankedProxy = (collectionType, queryImpl) => {
        const proxy = {query: queryImpl};
        StorageRouter.injectQueryReRanker(proxy, collectionType);
        return proxy;
    };

    test('returns the sort key it ordered by, on a fixture where composite and distance disagree', async () => {
        const proxy = makeRerankedProxy('memory', async () => rows);
        const res   = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 2});

        // The order is by composite, so the WORSE distance leads. This is the pre-existing behaviour
        // and #312 does not change it — it only makes it explicable.
        expect(res.ids[0]).toEqual(['high-topology', 'low-distance']);
        expect(res.distances[0]).toEqual([0.30, 0.10]);

        // The claim: the key that produced that order now reaches the caller.
        expect(res.compositeScores?.[0]).toBeDefined();

        const [first, second] = res.compositeScores[0];

        expect(first).toBeCloseTo(1.538462, 5);
        expect(second).toBeCloseTo(0.909091, 5);

        // And it is genuinely the sort key rather than a relabelled distance score: descending in
        // composite while ASCENDING in relevanceScore (1/(1+distance)), which is the contradiction
        // that misled three readers.
        expect(first).toBeGreaterThan(second);
        expect(1 / (1 + res.distances[0][0])).toBeLessThan(1 / (1 + res.distances[0][1]));
    });

    test('keeps compositeScores index-parallel with ids and distances', async () => {
        const proxy = makeRerankedProxy('memory', async () => rows);
        const res   = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 2});

        // Downstream filters re-map these arrays by index; a length or ordering drift here desyncs a
        // score onto the wrong row, which is worse than not shipping the field at all.
        expect(res.compositeScores[0]).toHaveLength(res.ids[0].length);
        expect(res.compositeScores[0]).toHaveLength(res.distances[0].length);

        const byId = Object.fromEntries(res.ids[0].map((id, i) => [id, res.compositeScores[0][i]]));

        expect(byId['high-topology']).toBeCloseTo(1.538462, 5);
        expect(byId['low-distance']).toBeCloseTo(0.909091, 5);
    });

    test('marks the set as re-ranked, so a caller can tell it from a raw slice', async () => {
        const proxy = makeRerankedProxy('summary', async () => rows);
        const res   = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 2});

        expect(res._reRanked).toBe(true);
    });

    test('omits scores entirely on the degraded path — absent, never zero', async () => {
        const proxy = makeRerankedProxy('memory', async () => {
            throw new Error('Error executing plan: Internal error: Error finding id');
        });

        const res = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 2});

        expect(res._degraded).toBe(true);

        // A zero would be a claim ("least relevant"), and any consumer adopting the field would sort a
        // legitimate row last on it. Absence is the only truthful answer when Pass 2 did not run.
        const scores = res.compositeScores?.[0];

        expect(scores === undefined || scores.length === 0).toBe(true);
        expect(scores?.includes?.(0)).toBeFalsy();
    });

    test('a genuine empty result carries no scores and is not marked degraded', async () => {
        const proxy = makeRerankedProxy('memory', async () => ({
            ids: [[]], distances: [[]], metadatas: [[]], documents: undefined
        }));

        const res = await proxy.query({queryEmbeddings: [[1, 0, 0]], nResults: 2});

        expect(res._degraded).toBeFalsy();
        expect(res.compositeScores?.[0] ?? []).toEqual([]);
    });
});
