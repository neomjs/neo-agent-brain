import {CORPUS_GRAPH_ORIGIN} from '../graph/corpusProjectionContract.mjs';
import {createHash} from 'node:crypto';

/**
 * @module ai/services/fleet/fleetGraphSceneSource
 * @summary Projects the whole graph a viewer may see, with the live Golden Path route as its overlay: the
 * scene the Fleet cockpit's Observatory draws.
 *
 * ## Why this shape
 *
 * The Observatory draws one graph with an optional route, so the scene is the graph and the route is a list of
 * ids in it. One Memory Core read, `get_graph_scene`, answers the graph under the graph's own row-level
 * security; the route rides `get_computed_route`. A route that cannot be read leaves the overlay empty and
 * never withholds the graph — but the envelope names the failure, because an unserved route rendered as an
 * empty one is a plan the fleet has against a plan it does not. The route's `admission` rides along
 * untouched: freshness is the producer's fact and the pane's call.
 *
 * ## The two cuts, and why they are not the same cut
 *
 * - **Budget cut**: the graph was larger than the reader allowed. `completeness: 'truncated'`, with the budget.
 * - **Scope cut**: a node the reader may not see is absent along with every edge touching it. The scene is
 *   still `complete`, because it is the whole of what this reader may see: reporting a permission as a budget
 *   would call a policy a limit.
 *
 * A node without a visible relation is in the scene like any other; `counts.unlinked` says how many there are,
 * for a view that places them apart.
 *
 * ## Identity
 *
 * Every emitted id is `origin#id`. The graph's own ids are origin-implicit (`pr-101` is ambiguous across the
 * fleet's repositories), so ids are qualified at projection, and edges and route ids with them: an edge always
 * names ids the scene contains. Nodes sort by id and edges by endpoints and type, so two reads of one graph
 * give byte-equal scenes. An edge is `{from, to}` plus the `type` the graph names; a relation the graph does
 * not name stays absent, since a placeholder would render as a real one.
 *
 * ## Bounds
 *
 * The node and edge budgets are the graph read's, and its cut keeps the best-connected nodes. The byte budget
 * is this source's, for the hop to the cockpit. v1 declares no continuation token: a read is whole or declared
 * truncated, and the `snapshotId` is the identity a resumable read would bind.
 */

const
    DEFAULT_ORIGIN    = CORPUS_GRAPH_ORIGIN,
    DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * @summary Qualify a graph id with its origin, idempotently.
 *
 * An id that already carries an origin is left alone, so a caller may pass either the graph's
 * origin-implicit form or an already-qualified one without the two disagreeing.
 * Implicit ids belong to the neo-only corpus; a different fallback origin is refused before lookup.
 *
 * @param {String} id
 * @param {String} [origin=DEFAULT_ORIGIN]
 * @returns {String}
 */
export function qualifyNodeId(id, origin = DEFAULT_ORIGIN) {
    const value = String(id ?? '');

    if (value.includes('#')) return value;
    if (origin !== DEFAULT_ORIGIN) {
        throw new Error('Origin-implicit graph ids require the neo-only corpus origin');
    }
    return `${origin}#${value}`
}

/**
 * @summary Count what a scene holds, in place, so its counts never disagree with its lists: the nodes, the
 * edges, and the nodes that no edge in the scene names.
 * @param {Object} scene
 */
function countScene(scene) {
    const linked = new Set();

    scene.edges.forEach(({from, to}) => linked.add(from).add(to));

    Object.assign(scene.counts, {nodes: scene.nodes.length, edges: scene.edges.length, unlinked: scene.nodes.length - linked.size})
}

/**
 * @summary Hold a scene to its byte budget, in place. Edges go first, then nodes, from the end of the sorted
 * lists, so the cut is deterministic; nodes only go once no edge is left to name them. A cut is a budget cut.
 * @param {Object} scene
 * @param {Number} maxBytes
 */
function trimToBytes(scene, maxBytes) {
    const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

    let over = size(scene) - maxBytes;

    if (over <= 0) {
        return
    }

    // each entry costs its own serialized form and the comma before it
    while (over > 0 && scene.edges.length) over -= size(scene.edges.pop()) + 1;
    while (over > 0 && scene.nodes.length) over -= size(scene.nodes.pop()) + 1;

    countScene(scene);
    scene.completeness = 'truncated';

    // the comma estimate is one byte generous for the last entry of a list: settle on the measured size
    while (size(scene) > maxBytes && (scene.edges.length || scene.nodes.length)) {
        scene.edges.length ? scene.edges.pop() : scene.nodes.pop();
        countScene(scene)
    }
}

/**
 * @summary Expand one columnar `get_graph_scene` answer into the scene the cockpit lands: origin-qualified,
 * ordered, and held to the byte budget.
 *
 * Pure: the same answer gives the same scene whatever order its rows arrived in, which is what lets a
 * viewer's selection survive a refresh.
 * Optional actor columns become role-specific identifiers only on their allowed node kinds. A null
 * assignee list stays unknown; [] stays known empty. Older readers can omit all actor columns.
 *
 * With the answer's `state` column, an issue, PR or discussion carries its stored `state` (`OPEN`,
 * `MERGED`, … as the last ingestion stored it, freshness unknown), or null; an answer without the column
 * projects no `state`.
 *
 * A scene carries `activitySources` only when the answer has the geometry columns. Its nodes then hold
 * `gravityWell: true` on a strategic anchor and `strategicWeight` where the Brain has one. `lastActivityAt`
 * (epoch ms, or null when the node lacks the field) appears on every node of a kind the map names. Each
 * kind's `sourceCapturedAt` passes through as the Brain states it; the envelope's `capturedAt` is this read's
 * time, never a source's.
 *
 * @param {Object} input
 * @param {Object} input.graph The answer: `{kinds, types, nodes: {ids, kinds, labels}, edges, counts, budget, truncated}`.
 * @param {String[]} [input.route] Origin-qualified route ids: the overlay.
 * @param {Number} [input.maxBytes]
 * @param {String} [input.origin]
 * @returns {Object} The scene.
 */
export function projectScene({graph, route = [], maxBytes = DEFAULT_MAX_BYTES, origin = DEFAULT_ORIGIN}) {
    const
        {ids = [], kinds = [], labels = []} = graph.nodes ?? {},
        // older readers answer no geometry columns, and their scene projects as before
        sources   = Array.isArray(graph.nodes?.gravityWell) && graph.activitySources ? graph.activitySources : null,
        order     = (a, b) => a < b ? -1 : a > b ? 1 : 0,
        actor     = code => Number.isInteger(code) && code >= 0 && typeof graph.actors?.[code] === 'string'
            ? graph.actors[code]
            : null,
        stateOf   = code => Number.isInteger(code) && code >= 0 && typeof graph.states?.[code] === 'string'
            ? graph.states[code]
            : null,
        qualified = ids.map(id => qualifyNodeId(id, origin)),
        nodes     = qualified
            .map((id, index) => {
                const kind = graph.kinds?.[kinds[index]] ?? null,
                      node = {id, label: labels[index] ?? null, kind};

                // Older readers omit actor columns. Missing lists remain unknown, distinct from [].
                if ((kind === 'ISSUE' || kind === 'PULL_REQUEST') && Array.isArray(graph.nodes.authoredBy)) {
                    node.authoredBy = actor(graph.nodes.authoredBy[index]);
                    const assigned = graph.nodes.assignedTo?.[index];
                    node.assignedTo = Array.isArray(assigned) && assigned.every(code => actor(code) !== null)
                        ? [...new Set(assigned.map(actor))].sort(order)
                        : null;
                } else if (kind === 'AGENT_MEMORY' && Array.isArray(graph.nodes.memoryOf)) {
                    node.memoryOf = actor(graph.nodes.memoryOf[index]);
                }

                if ((kind === 'ISSUE' || kind === 'PULL_REQUEST' || kind === 'DISCUSSION') && Array.isArray(graph.nodes.state)) {
                    node.state = stateOf(graph.nodes.state[index]);
                }

                if (sources) {
                    if (graph.nodes.gravityWell[index] === 1) node.gravityWell = true;
                    if (Number.isFinite(graph.nodes.strategicWeight?.[index])) node.strategicWeight = graph.nodes.strategicWeight[index];
                    if (Object.hasOwn(sources, kind)) node.lastActivityAt = graph.nodes.lastActivityAt?.[index] ?? null;
                }

                return node
            })
            .sort((a, b) => order(a.id, b.id)),
        edges     = [];

    for (let index = 0; index + 2 < graph.edges.length; index += 3) {
        const
            from = qualified[graph.edges[index]],
            to   = qualified[graph.edges[index + 1]],
            type = graph.types?.[graph.edges[index + 2]] ?? null;

        if (from && to) {
            edges.push(type ? {from, to, type} : {from, to})
        }
    }

    edges.sort((a, b) => order(a.from, b.from) || order(a.to, b.to) || order(a.type ?? '', b.type ?? ''));

    const scene = {
        route,
        nodes,
        edges,
        counts      : {nodes: 0, edges: 0, seeds: route.length, unlinked: 0},
        budget      : {maxNodes: graph.budget?.maxNodes ?? null, maxEdges: graph.budget?.maxEdges ?? null, maxBytes},
        completeness: graph.truncated?.nodes || graph.truncated?.edges ? 'truncated' : 'complete',
        ...(sources ? {activitySources: {...sources}} : {})
    };

    countScene(scene);
    trimToBytes(scene, maxBytes);

    return scene
}

/**
 * @summary Build a graph-scene source bound to a route seam and a graph seam.
 *
 * The source imports neither an MCP tool service nor request context; both arrive as operations, so the same
 * source serves a process-lifetime bridge and a test without either knowing which.
 *
 * @param {Object} options
 * @param {Function} options.getComputedRoute Resolves the live `computed-route.v1` envelope.
 * @param {Function} options.getGraphScene Resolves the columnar `get_graph_scene` answer for a budget.
 * @param {Function} [options.now] Clock seam, for the envelope's capture stamp.
 * @param {String} [options.origin] Origin for ids the graph returns origin-implicit.
 * @returns {{readGraphScene: Function}}
 */
export function createFleetGraphSceneSource({
    getComputedRoute,
    getGraphScene,
    now    = () => Date.now(),
    origin = DEFAULT_ORIGIN
} = {}) {
    const identityOf = scene => createHash('sha256').update(JSON.stringify(scene)).digest('hex').slice(0, 16);

    return {
        /**
         * @summary Read the whole visible graph with the live route as its overlay.
         * @param {Object} [query]
         * @param {Number} [query.maxNodes] Handed to the graph read.
         * @param {Number} [query.maxEdges] Handed to the graph read.
         * @param {Number} [query.maxBytes]
         * @returns {Promise<Object>} The read envelope: `{capability, admission, scene, snapshotId, capturedAt}`.
         */
        async readGraphScene({maxNodes, maxEdges, maxBytes} = {}) {
            const
                [route, graph] = await Promise.allSettled([
                    getComputedRoute(),
                    getGraphScene({...(maxNodes ? {maxNodes} : {}), ...(maxEdges ? {maxEdges} : {})})
                ]),
                answer         = graph.value,
                unavailable    = reason => ({
                    capability: {state: 'unavailable', reason},
                    admission : null,
                    scene     : null,
                    snapshotId: null,
                    capturedAt: new Date(now()).toISOString()
                });

            if (graph.status === 'rejected') {
                return unavailable('graph-read-failed')
            }

            // Read strictly: a stubbed seam proves the projection, never the wire shape, and a tolerant reader
            // would hide a rename behind an empty graph.
            if (!Array.isArray(answer?.nodes?.ids) || !Array.isArray(answer?.edges)) {
                return unavailable('graph-answer-malformed')
            }

            // The route operation answers an envelope, `{status, reason, route, admission}`. Its admission rides
            // this read exactly as the operation wrote it: whether a withheld admission may be read as current is
            // the pane's call, and re-deciding it here would be a second opinion on a producer's own fact.
            // `available` alone does not serve a route: the sibling Golden Path source requires the items too, and
            // a tolerant reader here would render a renamed envelope as a plan the fleet has.
            const
                answerRoute = route.status === 'fulfilled' ? route.value : null,
                served      = answerRoute?.status === 'available' && Array.isArray(answerRoute.route?.route?.items),
                items       = served ? answerRoute.route.route.items : [],
                admission   = answerRoute?.admission && typeof answerRoute.admission === 'object' ? answerRoute.admission : null,
                routeReason = served
                    ? null
                    : route.status === 'rejected'
                        ? 'route-read-failed'
                        : (typeof answerRoute?.reason === 'string' && answerRoute.reason ? answerRoute.reason : 'route-answer-malformed'),
                scene       = projectScene({graph: answer, route: items.map(item => qualifyNodeId(String(item?.id ?? item), origin)), maxBytes, origin});

            return {
                // an empty read is not evidence that the fleet has no graph, and an unserved route is not evidence
                // that the fleet has no plan: the read is current only when it served both
                capability: !scene.nodes.length
                    ? {state: 'degraded', reason: 'no-rows-resolved'}
                    : routeReason
                        ? {state: 'degraded', reason: routeReason}
                        : {state: 'current', reason: null},
                admission,
                scene,
                snapshotId: identityOf(scene),
                capturedAt: new Date(now()).toISOString()
            }
        }
    }
}

export default createFleetGraphSceneSource;
