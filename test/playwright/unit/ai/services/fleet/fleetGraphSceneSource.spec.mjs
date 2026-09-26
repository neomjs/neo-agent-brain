import {expect, test} from '@playwright/test';
import FleetControlBridge from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import {
    createFleetGraphSceneSource,
    projectNeighbourhood,
    qualifyNodeId,
    resolveSceneRead
} from '../../../../../../ai/services/fleet/fleetGraphSceneSource.mjs';
import {wireFleetGraphSceneSource} from '../../../../../../ai/services/fleet/wireFleetGraphSceneSource.mjs';
import {FLEET_METHOD_SCOPE_CLASSES, FLEET_S1_METHOD_POLICY} from '../../../../../../ai/services/fleet/fleetServerPolicy.mjs';
import {FLEET_WIRE_METHODS} from '../../../../../../src/fleet/contract/wire.mjs';

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
 * @summary One edge as a read returns it, with the target the RLS filter may withhold.
 * @param {String} from
 * @param {String} to
 * @param {String} [type='RELATES_TO']
 * @returns {Object}
 */
function edge(from, to, type = 'RELATES_TO') {
    return {from, to, type}
}

/**
 * @summary A `computed-route.v1` sidecar whose two ranked items are the scene's default seeds.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function sidecar(overrides = {}) {
    return {
        schemaVersion     : 'computed-route.v1',
        status            : 'fresh',
        notAuthority      : true,
        capturedAt        : '2026-09-26T08:30:00.000Z',
        expiresAt         : '2026-09-26T10:30:00.000Z',
        routeVersion      : 'route-v7',
        items             : [
            {rank: 1, ref: 'pr-101', title: 'first route item'},
            {rank: 2, ref: 'issue-202', title: 'second route item'}
        ],
        ...overrides
    }
}

/**
 * @summary A stub graph keyed the way the real one is: devindex stores PR/issue nodes as
 * `owner/repo#number`, and the seam receives that qualified id.
 *
 * The key space is qualified BY CONSTRUCTION here rather than per fixture. Several early arms passed
 * a graph keyed by bare ids, so the walk collected zero nodes — and the assertions stayed green,
 * because `toBeLessThanOrEqual` and "edges are empty" are both satisfied by an empty scene. A stub
 * that can be written wrong is a stub that hides the bug it is standing in for.
 *
 * `visible` withholds ids (the RLS / scope case); `absent` makes the seam 404 them; `edges` is the
 * adjacency the read walks.
 * @param {Object} graph
 * @returns {Object}
 */
function stubGraph({nodes = [], edges = [], visible = null, absent = []} = {}) {
    const
        allowed = visible ? new Set(visible.map(qualify)) : null,
        gone    = new Set(absent.map(qualify));

    return {
        getNode      : async id => {
            if (gone.has(id)) {
                throw new Error('404 not found')
            }

            if (allowed && !allowed.has(id)) {
                return null
            }

            return nodes.find(candidate => qualify(candidate.id) === id) ?? null
        },
        // The documented `get_neighbors` response shape: `{neighbors: [{id}]}`. Reading a `nodes`
        // key here instead is what an invented stub shape looks like, and it passes every arm.
        getNeighbors : async (id, depth) => ({
            neighbors: edges.filter(row => qualify(row.from) === id).map(row => ({id: qualify(row.to)})),
            depth
        })
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
                  route : sidecar({items: [{rank: 1, ref: 'issue-300'}, {rank: 2, ref: 'issue-301'}]})
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

    test('an emitted edge is adjacency presence and never an invented relation', async () => {
        // The graph's neighbour projection drops every edge property except `weight`, so a `type` read
        // through this seam is ABSENT data, not weak data. An earlier draft defaulted it to
        // 'RELATES_TO', which would have rendered every real edge in the cockpit as the same invented
        // relation — and the arms passed anyway, because the STUB returned a type the real projection
        // never does. The stub is the thing that was wrong, so this arm pins the absence.
        const graph  = stubGraph({
            nodes : [node('pr-101'), node('issue-202')],
            edges : [edge('pr-101', 'issue-202', 'DEPENDS_ON')]
        }), {scene} = await createFleetGraphSceneSource(seams({graph})).readGraphScene({});

        expect(scene.edges, 'an edge names its two endpoints and stops there').toEqual([
            {from: 'neomjs/neo#pr-101', to: 'neomjs/neo#issue-202'}
        ]);
        expect('type' in scene.edges[0], 'no relation label is invented for a viewer to render').toBe(false)
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
                route: sidecar({items: [{rank: 1, ref: 'pr-101'}]})
            })).readGraphScene({});

        expect(capability.state, 'the read still answers').toBe('current');
        expect(scene.nodes.map(entry => entry.id), 'and the surviving node is still there').toEqual(['neomjs/neo#pr-101']);
        expect(scene.edges, 'with no edge left dangling to the 404').toEqual([])
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
              edges = [edge('pr-101', 'issue-7'), edge('pr-101', 'issue-3')],
              input = {seedIds: ['neomjs/neo#pr-101'], maxNodes: 10, maxEdges: 10, maxBytes: 4096},
              straight = projectNeighbourhood({...input, nodes, edges}),
              shuffled  = projectNeighbourhood({...input, nodes: [...nodes].reverse(), edges: [...edges].reverse()});

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
