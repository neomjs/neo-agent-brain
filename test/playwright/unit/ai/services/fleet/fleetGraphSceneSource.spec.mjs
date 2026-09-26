import {expect, test} from '@playwright/test';
import {
    createFleetGraphSceneSource,
    projectNeighbourhood,
    qualifyNodeId,
    resolveSceneRead
} from '../../../../../../ai/services/fleet/fleetGraphSceneSource.mjs';
import {wireFleetGraphSceneSource} from '../../../../../../ai/services/fleet/wireFleetGraphSceneSource.mjs';

// `FleetControlBridge` and the policy ledgers reach `neo.mjs`, whose modules call `Neo.gatekeep` at
// module-evaluation time. They are loaded DYNAMICALLY, after the framework entrypoint has established
// the global it assigns (`Neo = globalThis.Neo = Object.assign({...})`), because a static import
// hoists above any statement here and would evaluate those modules against whatever ambient state the
// worker happened to inherit. That inheritance is real and it is order-dependent: the sibling spec
// makes the same static imports and passes, because a different spec ran first in that worker and left
// the global behind. Three arms of THIS spec failed with `ReferenceError: Neo is not defined` purely
// because of which worker they landed in — an arm that runs or does not depending on file order is not
// an arm.
await import('neo.mjs/src/Neo.mjs');

const {default: FleetControlBridge} = await import('../../../../../../ai/services/fleet/FleetControlBridge.mjs');
const {FLEET_METHOD_SCOPE_CLASSES, FLEET_S1_METHOD_POLICY} = await import('../../../../../../ai/services/fleet/fleetServerPolicy.mjs');
const {FLEET_WIRE_METHODS} = await import('../../../../../../src/fleet/contract/wire.mjs');

const
    NOW    = '2026-09-26T09:00:00.000Z',
    NOW_MS = Date.parse(NOW);

/**
 * @summary Qualify an id the way the seam's key space does, so a fixture can be written with the
 * bare ids a human reads while the graph is asked for the qualified ones.
 * @param {String} id
 * @returns {String}
 */
function qualify(id) {
    return qualifyNodeId(id, 'neomjs/neo')
}

/**
 * @summary One authorized graph node as a read returns it: an origin-implicit id, a label, a kind.
 * @param {String} id
 * @param {Object} [overrides]
 * @returns {Object}
 */
function node(id, overrides = {}) {
    return {id, label: `label ${id}`, kind: 'ISSUE', ...overrides}
}

/**
 * @summary One edge as the live answer carries it: its own endpoints and its relation.
 *
 * The live `get_neighbors` answer names `source`, `target` and `relationship` per neighbour, and
 * answers an edge from BOTH of its endpoints — which is why the source reads direction off the edge
 * rather than off which node it asked about, and why it deduplicates.
 *
 * @param {String} source
 * @param {String} target
 * @param {String} [relationship]
 * @returns {Object}
 */
function edge(source, target, relationship = null) {
    return {source, target, relationship}
}

/**
 * @summary The `get_computed_route` ANSWER, recorded from a live call — an envelope, not a sidecar.
 *
 * The operation answers `{status, reason, details, route, admission}` where `status` is one of
 * `available | missing | …` and freshness is nested at `route.route.status`. An earlier fixture here
 * was a flat `{status: 'fresh', items: [{ref}]}`, which is the shape the SOURCE expected rather than
 * the shape the operation produces: `status === 'fresh'` can never hold, so every wired read answered
 * `route-not-fresh` and no arm could see it. The item id is `id`, not `ref`.
 *
 * @param {Object} [overrides]
 * @returns {Object}
 */
function sidecar(overrides = {}) {
    return {
        status   : 'available',
        reason   : null,
        details  : null,
        admission: {admitted: true},
        route    : {
            route: {
                kind  : 'handoff',
                items : [
                    {id: 'pr-101', title: 'first route item', rank: 1},
                    {id: 'issue-202', title: 'second route item', rank: 2}
                ]
            }
        },
        ...overrides
    }
}

/**
 * @summary A route envelope carrying the given ids — the only supported way to choose seeds.
 *
 * Writing `{items: [...]}` as an override of the answer does NOT work and fails silently: `items` is
 * nested at `route.route.items`, so a top-level override leaves the real items in place and the arm
 * quietly walks nodes its graph does not hold. That is how the budget arm ended up asserting against
 * an empty scene.
 *
 * @param {String[]} ids
 * @returns {Object}
 */
function routeWith(ids) {
    return sidecar({route: {route: {kind: 'handoff', items: ids.map((id, index) => ({id, rank: index + 1}))}}})
}

/**
 * @summary The answer when the operation will not serve a route — its own reason, not an exception.
 * @param {String} [status]
 * @param {String} [reason]
 * @returns {Object}
 */
function noRoute(status = 'missing', reason = 'route-not-found') {
    return {status, reason, details: null, route: null, admission: {admitted: true}}
}

/**
 * @summary A stub graph shaped from RECORDED live answers: bare ids, and neighbours carrying their own
 * `source`, `target` and `relationship`.
 *
 * Two earlier versions of this fixture were wrong in the direction that mattered. It first keyed its
 * graph by QUALIFIED ids, on the source's own claim that "the seam is keyed by the qualified id" —
 * which made the spec structurally impossible to write wrong and, for that reason, agreed with a
 * contract the plane does not honour: live `get_node('issue-9853')` answers the node while
 * `get_node('neomjs/neo#issue-9853')` answers `{result: null}`. Then its neighbour response was an
 * invented `{nodes: [{id}]}`. The lesson is not "tighten the stub against the source" — it is that a
 * stub must be transcribed from the wire, because a stub derived from the thing under test cannot
 * disagree with it.
 *
 * @param {Object} graph
 * @returns {Object}
 */
function stubGraph({nodes = [], edges = [], visible = null, absent = [], refusing = false} = {}) {
    const
        allowed = visible ? new Set(visible) : null,
        gone    = new Set(absent);

    return {
        getNode      : async id => {
            if (refusing) {
                // A live seat with no graph store loaded raises here rather than answering null.
                throw new Error('getAdjacentNodes of null')
            }

            if (gone.has(id)) {
                return null
            }

            if (allowed && !allowed.has(id)) {
                return null
            }

            return nodes.find(candidate => candidate.id === id) ?? null
        },
        getNeighbors : async id => {
            if (refusing) {
                throw new Error('getAdjacentNodes of null')
            }

            return {
                neighbors: edges
                    .filter(row => row.source === id || row.target === id)
                    .map(row => ({
                        // The record's own identity is the NEIGHBOUR — the other endpoint — while
                        // `source`/`target` carry the edge's direction, so an INBOUND edge is visible
                        // from the node that did not originate it.
                        id          : row.source === id ? row.target : row.source,
                        source      : row.source,
                        target      : row.target,
                        relationship: row.relationship ?? null,
                        weight      : 1
                    }))
            }
        }
    }
}

/**
 * @summary Source seams for a fixed clock, with the graph overridable per arm.
 * @param {Object} [options]
 * @returns {Object}
 */
function seams({graph = stubGraph(), route = sidecar()} = {}) {
    return {
        now            : () => NOW_MS,
        getComputedRoute: async () => route,
        getNode        : graph.getNode,
        getNeighbors   : graph.getNeighbors
    }
}

test.describe('fleetGraphSceneSource', () => {
    test('a live route seeds the scene, and the seeds are the route items', async () => {
        const graph  = stubGraph({
            nodes : [node('pr-101'), node('issue-202')],
            edges : []
        }), read = createFleetGraphSceneSource(seams({graph})).readGraphScene,
              {scene} = await read({});

        // Seed identity is the route's, origin-qualified (AC-3): the route's own `pr-101` is not the
        // graph's `pr-101`, and an id that does not say which origin it came from is ambiguous across
        // every repository the fleet spans.
        expect(scene.route).toEqual(['neomjs/neo#pr-101', 'neomjs/neo#issue-202']);
        expect(scene.counts.seeds).toBe(2)
    });

    test('a budget cut says so, and says what it was', async () => {
        // The honesty this feed exists for: a capped neighbourhood must be distinguishable from a
        // whole one, or the observatory renders a slice as though it were the graph.
        //
        // The fixture REACHES the cap: the route's seeds are rows the graph actually holds, and each
        // has four neighbours, so a depth-2 read collects ten rows against a cap of four. An earlier
        // version of this arm seeded `pr-101` against a graph of `issue-3xx` rows, so the walk
        // resolved nothing — and `toBeLessThanOrEqual(4)`, which an EMPTY scene satisfies, kept it
        // green. Hence `toBe(4)`, which an empty scene cannot.
        const many = Array.from({length: 8}, (unused, index) => node(`issue-${310 + index}`)),
              graph = stubGraph({
                  nodes : [node('issue-300'), node('issue-301'), ...many],
                  edges : [
                      ...many.slice(0, 4).map((unused, index) => edge('issue-300', `issue-${310 + index}`)),
                      ...many.slice(4).map((unused, index) => edge('issue-301', `issue-${314 + index}`))
                  ]
              }),
              {scene} = await createFleetGraphSceneSource(seams({
                  graph,
                  route : routeWith(['issue-300', 'issue-301'])
              })).readGraphScene({depth: 2, maxNodes: 4});

        expect(scene.completeness, 'a budget cut is declared').toBe('truncated');
        expect(scene.counts.nodes, 'the cap is filled, not merely respected').toBe(4);
        expect(scene.budget.maxNodes, 'and the budget that caused it is reported').toBe(4);
        expect(scene.budget.maxEdges, 'with the rest of the budget it was read under').toBeGreaterThan(0)
    });

    test('a scope cut never reads as a budget cut', async () => {
        // The distinction that is easiest to get wrong and most expensive to get wrong: an edge to
        // an unauthorized node leaves WITH its node, and that is a scope cut. Reporting it as
        // `truncated` would tell the viewer its view is a budget when it is a permission.
        const graph = stubGraph({
            nodes: [node('pr-101'), node('issue-202'), node('issue-999')],
            edges: [edge('pr-101', 'issue-999')],
            visible: ['pr-101', 'issue-202']
        }), {scene} = await createFleetGraphSceneSource(seams({graph})).readGraphScene({});

        expect(scene.nodes.map(entry => entry.id), 'the unauthorized node is absent').not.toContain('neomjs/neo#issue-999');
        expect(scene.edges, 'and its edges leave with it, rather than dangling').toEqual([]);
        expect(scene.completeness, 'a permission is not a budget').toBe('complete')
    });

    test('ids are origin-qualified and stable across two reads', async () => {
        const graph = stubGraph({nodes: [node('pr-101'), node('issue-202')], edges: [edge('pr-101', 'issue-202')]}),
              source = createFleetGraphSceneSource(seams({graph})),
              first  = await source.readGraphScene({}),
              second = await source.readGraphScene({});

        // AC-3: stability is what lets a selection survive a refresh, so the SECOND read must be
        // byte-equal, not merely equivalent.
        expect(first.scene).toEqual(second.scene);
        expect(first.snapshotId, 'and it is the same snapshot, so a selection can name it').toBe(second.snapshotId)
    });

    test('v1 declares no continuation token, and the read carries the snapshot a v2 would bind', async () => {
        // The decision recorded for this feed: budgets are mandatory and a continuation is deferred
        // to a v2 that binds a snapshot identity. This arm fails the day a `continuation` field
        // appears without that binding — which is the point of pinning the absence. The snapshot
        // identity lives on the ENVELOPE, not the scene, so it survives a read that has no scene.
        const graph = stubGraph({nodes: [node('pr-101')], edges: []}),
              {scene, snapshotId} = await createFleetGraphSceneSource(seams({graph})).readGraphScene({});

        expect('continuation' in scene, 'a stateless wire gets no token').toBe(false);
        expect(snapshotId, 'the snapshot a future token would bind').toMatch(/\S/)
    });

    test('an emitted edge carries the relation the operation supplied, and invents none', async () => {
        // The live neighbour answer names the relation as `relationship`, so it is PRESENT data and
        // belongs in the scene — an earlier draft dropped it on a misreading of
        // `conceptNeighborhoodProbe`'s note, which narrows edge PROPERTIES to `weight`, not the edge
        // TYPE. The invariant worth keeping is the narrower one: whatever the operation does not supply
        // is ABSENT rather than defaulted, because a placeholder relation is the one label a viewer
        // cannot distinguish from a real one.
        const withRelation = stubGraph({
                nodes : [node('pr-101'), node('issue-202')],
                edges : [edge('pr-101', 'issue-202', 'GUIDES')]
            }),
            bare = stubGraph({
                nodes : [node('pr-101'), node('issue-202')],
                edges : [edge('pr-101', 'issue-202')]
            }),
            source = createFleetGraphSceneSource(seams({graph: withRelation})),
            {scene} = await source.readGraphScene({depth: 1});

        expect(scene.edges, 'a supplied relation is passed through, not dropped').toEqual([
            {from: 'neomjs/neo#pr-101', to: 'neomjs/neo#issue-202', type: 'GUIDES'}
        ]);

        const {scene: unrel} = await createFleetGraphSceneSource(seams({graph: bare})).readGraphScene({depth: 1});

        expect('type' in unrel.edges[0], 'and an absent relation is absent, never a placeholder').toBe(false)
    });


    test('a read failure is unavailable with a reason, never a fabricated scene', async () => {
        const source = createFleetGraphSceneSource({
            now             : () => NOW_MS,
            getComputedRoute: async () => {throw new Error('plane unreachable')},
            getNode         : async () => null,
            getNeighbors    : async () => ({nodes: [], depth: 0})
        }), {capability, scene} = await source.readGraphScene({});

        // `capability` is the bridge's `{state, reason}` object, not a bare string: an unwired slot
        // already answers in exactly that shape, so a wired read that answered differently would
        // make the two states incomparable to the pane that has to render both.
        expect(capability.state, 'the feed admits it cannot answer').toBe('unavailable');
        expect(capability.reason).toBe('route-read-failed');
        expect(scene, 'and hands over no graph rather than an empty one it cannot vouch for').toBeNull()
    });

    test('a read through the source emits the edges it walked, cycles included', async () => {
        // The arm whose absence let a real defect through: `readGraphScene` collected nodes from the
        // adjacency it walked and never handed the links to the projector, so the feed emitted a graph
        // with NO edges at all — and every earlier edge assertion passed, because each one called
        // `projectNeighbourhood` DIRECTLY. Two arms here had asserted `edges` is empty, which an
        // edge-less feed satisfies for the wrong reason.
        //
        // So: assert edges through the SOURCE, and assert a cycle survives, because a hop back to an
        // already-seen node is still a link and is the first thing a "only queue new nodes" walk drops.
        const graph = stubGraph({
                nodes : [node('pr-101'), node('issue-7'), node('issue-9')],
                edges : [edge('pr-101', 'issue-7'), edge('issue-7', 'pr-101'), edge('pr-101', 'issue-9')]
            }),
            // depth 2, not the default 1: at depth 1 the neighbours are DISCOVERED but never resolved,
            // so they are legitimately absent from the scene and their links correctly drop as
            // dangling. The cycle only exists once issue-7 is itself walked.
            {scene} = await createFleetGraphSceneSource(seams({graph})).readGraphScene({depth: 2});

        expect(scene.counts.edges, 'the source hands its walked links to the projector').toBe(3);
        // Sorted by `from`, then `to`, ascending — which is why the cycle out of issue-7 leads and
        // why pr-101's two links order issue-7 before issue-9. An earlier version of this arm
        // hand-wrote issue-9 first and contradicted the sort the projector documents; the
        // implementation was right and the expectation was wrong.
        expect(scene.edges, 'a cycle back to a seen node is still an edge').toEqual([
            {from: 'neomjs/neo#issue-7', to: 'neomjs/neo#pr-101'},
            {from: 'neomjs/neo#pr-101', to: 'neomjs/neo#issue-7'},
            {from: 'neomjs/neo#pr-101', to: 'neomjs/neo#issue-9'}
        ])
    });

    test('a 404 on one node is a scope cut, not a read failure', async () => {
        // The distinction that keeps a transient absence from reading as an outage: one row the seam
        // will not answer for must shrink the neighbourhood, not collapse it. Reporting `unavailable`
        // here would tell the viewer its view failed when in fact it is merely smaller than it asked.
        const graph = stubGraph({
                nodes : [node('pr-101'), node('issue-7')],
                edges : [edge('pr-101', 'issue-7')],
                absent: ['issue-7']
            }),
            {capability, scene} = await createFleetGraphSceneSource(seams({
                graph,
                route: routeWith(['pr-101'])
            })).readGraphScene({});

        expect(capability.state, 'the read still answers').toBe('current');
        expect(scene.nodes.map(entry => entry.id), 'and the surviving node is still there').toEqual(['neomjs/neo#pr-101']);
        expect(scene.edges, 'with no edge left dangling to the 404').toEqual([])
    });

    test('a route the operation will not serve is degraded with ITS reason, not unavailable', async () => {
        // The operation answers an envelope whose `status` is `available | missing | …`, with
        // freshness nested at `route.route.status`. An earlier version compared the TOP level to
        // 'fresh', which can never hold, so every wired read answered `route-not-fresh` — and a flat
        // `{status: 'fresh'}` fixture hid it. There is also no graph to be `unavailable` from when
        // only the route is missing, so the severity was wrong twice.
        const {capability, scene} = await createFleetGraphSceneSource(
            seams({graph: stubGraph(), route: noRoute('missing', 'route-not-found')})
        ).readGraphScene({});

        expect(capability, 'the operation\'s own reason is passed through').toEqual({
            state : 'degraded',
            reason: 'route-not-found'
        });
        expect(scene).toBeNull()
    });

    test('a seam that RAISES is a degraded partial read, not a scope cut and not unavailable', async () => {
        // The distinction an outage turns on. `get_node` answers `null` for a row the reader may not
        // see and RAISES when the store cannot answer at all. Collapsing those reports an
        // infrastructure failure as a permission — and `complete` on top of it would launder the
        // outage into a fact about the graph.
        const graph  = stubGraph({nodes: [node('pr-101')], edges: [], refusing: true}),
              source = createFleetGraphSceneSource(seams({graph, route: routeWith(['pr-101'])})),
              {capability} = await source.readGraphScene({});

        expect(capability.state, 'a refusal is not a permission').toBe('degraded');
        expect(capability.reason, 'and it names the seam that refused').toBe('graph-node-read-failed');
        expect(capability.state, 'never `unavailable`, which would claim there is no scene').not.toBe('unavailable')
    });

    test('depth d is the d-hop neighbourhood, not (d-1)', async () => {
        // The seeds are hop zero, so the loop runs `depth + 1` levels. Bounding at `level < depth`
        // made `depth: 1` — the default — return the seeds alone while still reporting `depth: 1`,
        // and the scene still claimed `complete` with the first ring missing.
        const ring = (prefix, count) => Array.from({length: count}, (unused, index) => node(`${prefix}-${index}`)),
              first = ring('r1', 2),
              graph = stubGraph({
                  nodes: [node('seed'), ...first, ...ring('r2', 2)],
                  edges: [
                      ...first.map(entry => edge('seed', entry.id)),
                      ...ring('r2', 2).map(entry => edge(first[0].id, entry.id))
                  ]
              }),
              source = createFleetGraphSceneSource(seams({graph, route: routeWith(['seed'])})),
              oneHop = await source.readGraphScene({depth: 1}),
              twoHop = await source.readGraphScene({depth: 2});

        expect(oneHop.scene.nodes.map(entry => entry.id), 'depth 1 reaches the first ring and no further').toEqual([
            'neomjs/neo#r1-0', 'neomjs/neo#r1-1', 'neomjs/neo#seed'
        ]);
        expect(twoHop.scene.nodes.length, 'depth 2 reaches the second').toBe(5)
    });

    test('an inbound edge never becomes a self-loop, in-scene or not', async () => {
        // Round 2, measured with the plane's own answer: an inbound edge names a `source` that is not
        // the node we asked about, and usually is not in the read either. Resolving the source with a
        // `?? qualifyNodeId(askedAbout)` fallback collapsed `from` onto the expanded node, so every
        // inbound edge came back as `issue-19235 -> issue-19235` with a real relation attached. Both
        // endpoints are now read off the EDGE, never off the node we happened to ask about.
        //
        // The two cases differ and both matter: in-scene, the link draws in the graph's direction;
        // out-of-scene, it is dropped as a dangling cross-link rather than drawn backwards.
        const outside = await createFleetGraphSceneSource(seams({
                graph: stubGraph({
                    nodes : [node('issue-19235')],
                    edges : [edge('issue-7', 'issue-19235', 'GUIDES')]
                }),
                route: routeWith(['issue-19235'])
            })).readGraphScene({depth: 1});

        expect(outside.scene.edges.every(link => link.from !== link.to), 'no self-loop').toBe(true);
        expect(outside.scene.edges, 'an out-of-scene inbound edge is dropped, not drawn backwards').toEqual([]);

        const inside = await createFleetGraphSceneSource(seams({
                graph: stubGraph({
                    nodes : [node('issue-19235'), node('issue-7')],
                    edges : [edge('issue-7', 'issue-19235', 'GUIDES')]
                }),
                route: routeWith(['issue-7'])
            })).readGraphScene({depth: 1});

        expect(inside.scene.edges, 'an in-scene inbound edge keeps the graph\'s direction').toEqual([
            {from: 'neomjs/neo#issue-7', to: 'neomjs/neo#issue-19235', type: 'GUIDES'}
        ])
    });

    test('depth 2 reaches the outside endpoint of an inbound edge', async () => {
        // The register-and-enqueue half, which the self-loop fix alone did not cover. Two ordering
        // defects at once: a guard that tested `byId.has(target)` while writing `byId.set(id)` never
        // registered a first-seen neighbour, and testing `seen.has(to)` enqueued nothing for an inbound
        // edge, because there `to` IS the node just expanded. So the outside endpoint stayed unknown
        // to the walk and its edge could never be drawn at any depth.
        const graph = stubGraph({
                nodes : [node('issue-19235'), node('issue-7')],
                edges : [edge('issue-7', 'issue-19235', 'GUIDES')]
            }),
            {scene} = await createFleetGraphSceneSource(
                seams({graph, route: routeWith(['issue-19235'])})
            ).readGraphScene({depth: 2});

        expect(scene.nodes.map(entry => entry.id), 'the far endpoint is a one-hop neighbour, so depth 2 includes it')
            .toEqual(['neomjs/neo#issue-19235', 'neomjs/neo#issue-7']);
        expect(scene.edges, 'and its edge is drawable rather than dropped as dangling').toEqual([
            {from: 'neomjs/neo#issue-7', to: 'neomjs/neo#issue-19235', type: 'GUIDES'}
        ])
    });

    test('an inbound edge keeps its own direction and is counted once', async () => {
        // The operation answers an edge from BOTH of its endpoints and names the direction on the
        // edge. Deriving `{from: the node we asked about, to: the neighbour}` reverses every inbound
        // edge, and charging the budget for both sightings spends it twice on unique links.
        const graph = stubGraph({
                nodes : [node('a'), node('b')],
                edges : [edge('a', 'b', 'GUIDES')]
            }),
            {scene} = await createFleetGraphSceneSource(
                seams({graph, route: routeWith(['a', 'b'])})
            ).readGraphScene({depth: 1});

        expect(scene.edges, 'one edge, oriented as the graph orients it, with its relation').toEqual([
            {from: 'neomjs/neo#a', to: 'neomjs/neo#b', type: 'GUIDES'}
        ]);
        expect(scene.counts.edges, 'seen from both endpoints but charged once').toBe(1)
    });

    test('an unwired slot is a distinct, honest state from a wired empty one', () => {
        // The wire half of the lift: a caller that cannot resolve its operations leaves the slot
        // unwired, so the bridge answers its own `unavailable` default instead of a fabricated
        // scene. This is the property the sibling Golden Path wiring established, inherited rather
        // than reinvented.
        //
        // The stub bridge is not incidental: the default bridge is a process singleton, so wiring it
        // here would make the "unwired" arm below order-dependent. Isolating the mutation is what
        // lets both assertions be true in the same run.
        const bridge = {};

        expect(wireFleetGraphSceneSource({bridge, getComputedRoute: null}), 'a half-resolved caller wires nothing').toBeNull();
        expect(bridge.graphSceneSource, 'and leaves the slot it could not fill empty').toBeUndefined();

        const wired = wireFleetGraphSceneSource({...seams(), bridge});

        expect(wired, 'a fully-resolved caller wires a source').toBeTruthy();
        expect(bridge.graphSceneSource).toBe(wired)
    });
});

test.describe('fleetGraphSceneSource — pure projection', () => {
    test('the same neighbourhood yields the same scene whatever order it arrived in', () => {
        // Determinism is what makes the pane's goldens mean anything, so it is asserted as
        // order-independence rather than as purity: calling a pure function twice with the same
        // array proves nothing, because the same array is the same order. A shuffled input that
        // still projects to the same scene is the arm that can actually fail — it catches a
        // projector that leaks iteration order into ids, counts, or edge order.
        const nodes = [node('pr-101', {origin: 'neomjs/neo'}), node('issue-7', {origin: 'neomjs/neo'}), node('issue-3', {origin: 'neomjs/other'})],
              links = [{from: 'pr-101', to: 'issue-7'}, {from: 'pr-101', to: 'issue-3'}],
              input = {seedIds: ['neomjs/neo#pr-101'], maxNodes: 10, maxEdges: 10, maxBytes: 4096},
              straight = projectNeighbourhood({...input, nodes, edges: links}),
              shuffled  = projectNeighbourhood({...input, nodes: [...nodes].reverse(), edges: [...links].reverse()});

        expect(shuffled, 'arrival order is not scene order').toEqual(straight);
        expect(straight.nodes.map(entry => entry.id), 'ids are origin-qualified, and sorted').toEqual([
            'neomjs/neo#issue-7',
            'neomjs/neo#pr-101',
            'neomjs/other#issue-3'
        ]);
        expect(straight.edges[0].from, 'and an edge points at a qualified id, not a bare one').toBe('neomjs/neo#pr-101')
    });

    test('a route with no graph rows is degraded, not an empty ok', () => {
        // The distinction that keeps a viewer from reading "nothing to see" as "nothing there".
        const resolved = resolveSceneRead({measurable: true, seeded: true, found: 0});

        expect(resolved.state).toBe('degraded')
    });
});

test.describe('fleetGraphScene — wire contract', () => {
    test('the method is on the wire vocabulary and its policy row exists', () => {
        // Authorization as a test rather than a comment: a method that is not on the vocabulary
        // cannot be called, and a vocabulary row with no policy row is the shape that produced the
        // `unsupported-method` dead ends this repo has been cleaning up.
        expect(FLEET_WIRE_METHODS).toContain('fleetGraphScene');
        expect(FLEET_S1_METHOD_POLICY.fleetGraphScene, 'the S1 policy row names the method').toBeTruthy();
        expect(FLEET_METHOD_SCOPE_CLASSES, 'and a scope class, so the read is declared').toBeTruthy()
    });

    test('the bridge slot is the one the pane reads', () => {
        expect(FleetControlBridge.graphSceneSource, 'the slot exists before anything is wired into it').toBeDefined();
        expect(FleetControlBridge.graphSceneSource ?? null, 'unwired is null, not a fabricated source').toBeNull()
    });
});
