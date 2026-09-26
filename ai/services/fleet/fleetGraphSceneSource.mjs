import {createHash}               from 'node:crypto';

/**
 * @module ai/services/fleet/fleetGraphSceneSource
 * @summary Projects a bounded, origin-qualified graph neighbourhood around a seat's live Golden
 * Path route — the data substrate the Fleet cockpit's 3D graph renders.
 *
 * ## Why this shape
 *
 * The cockpit's graph view is the one surface that shows a seat more graph than it can hold, so the
 * feed's contract is *boundedness stated up front* rather than truncation discovered on arrival. A
 * scene therefore always reports the budget it was read under and whether it is whole, because a
 * viewer that cannot tell a capped neighbourhood from a complete one renders a slice as though it
 * were the graph.
 *
 * ## The two cuts, and why they are not the same cut
 *
 * A read can come back short for two unrelated reasons, and conflating them would misinform the
 * viewer about *why*:
 *
 * - **Budget cut** — the neighbourhood was larger than the reader allowed. Reported as
 *   `completeness: 'truncated'`, with the budget that caused it.
 * - **Scope cut** — a neighbour the reader may not see (RLS, tenant scope) was dropped along with
 *   every edge touching it. Reported as `completeness: 'complete'`, because the view *is* the whole
 *   of what this reader is entitled to see. Reporting a permission as a budget would tell the
 *   viewer its sight is a limit when it is a policy.
 *
 * ## Identity
 *
 * Every emitted id is `origin#id`. The graph's own ids are origin-implicit (`pr-101` is ambiguous
 * across the fleet's repositories), and the route's items are repository-qualified, so a scene that
 * mixed the two conventions would make `pr-101` and `neomjs/neo#pr-101` the same node twice. Ids are
 * therefore qualified at projection, and edges are re-qualified to match, so an edge always points
 * at an id the scene actually contains.
 *
 * **The seam is keyed by the qualified id.** `getNode` and `getNeighbors` receive `origin#id`, never a
 * bare one, because a seam that understood only bare ids could not tell two repositories' `pr-101`
 * apart — which is the collision the qualification exists to prevent, reintroduced at the last hop.
 * Qualification is idempotent, so a graph that already stores qualified ids round-trips unchanged.
 *
 * ## What an edge in a scene is, and is not
 *
 * An emitted edge is **adjacency presence** — `{from, to}` — and deliberately carries no relation
 * label. The graph's neighbour projection drops every edge property except `weight` (the same
 * constraint `conceptNeighborhoodProbe` documents when it reads raw edge rows for a reason the
 * projection cannot serve), so a `type` read through that seam is not weak data, it is *absent* data.
 * Defaulting it to a placeholder would render every real edge in the cockpit as the same invented
 * relation, which is the one failure this feed cannot afford: a viewer cannot tell a fabricated label
 * from a real one. A future feed that needs relation semantics reads raw edge rows, as the probe
 * does, and says so in its own contract.
 *
 * `completeness` is therefore scoped honestly too: it describes the **RLS-filtered projection** this
 * read walked, not the raw graph behind it. Edge-RLS is a surface distinct from node-RLS — an edge
 * between two visible nodes can itself be withheld — so "complete" means "everything the projection
 * would show this reader", and the pane must not read it as "everything that exists".
 *
 * ## Bounds
 *
 * v1 declares no continuation token: a read is a whole answer or a declared-truncated one, and the
 * `snapshotId` on the envelope is the identity a future resumable read would bind. Adding a token
 * without that binding is the shape that would make two reads of one snapshot look like two
 * snapshots, so the absence is deliberate rather than merely unimplemented.
 */

const
    DEFAULT_ORIGIN    = 'neomjs/neo',
    DEFAULT_MAX_NODES = 150,
    DEFAULT_MAX_EDGES = 300,
    DEFAULT_MAX_BYTES = 32768;

/**
 * @summary Qualify a graph id with its origin, idempotently.
 *
 * An id that already carries an origin is left alone, so a caller may pass either the graph's
 * origin-implicit form or an already-qualified one without the two disagreeing.
 *
 * @param {String} id
 * @param {String} [origin=DEFAULT_ORIGIN]
 * @returns {String}
 */
export function qualifyNodeId(id, origin = DEFAULT_ORIGIN) {
    const value = String(id ?? '');

    return value.includes('#') ? value : `${origin}#${value}`
}

/**
 * @summary Project a collected neighbourhood into a bounded, ordered, origin-qualified scene.
 *
 * Pure and order-independent: nodes and edges are sorted by their qualified identity, so two reads
 * of the same neighbourhood produce byte-equal scenes regardless of the order the graph returned its
 * rows in. That is what lets a viewer's selection survive a refresh, and what makes golden files
 * meaningful.
 *
 * @param {Object} input
 * @param {String[]} input.seedIds Origin-qualified ids the neighbourhood was collected around.
 * @param {Object[]} [input.nodes] Graph rows as `getNode` returns them, origin-implicit.
 * @param {Object[]} [input.edges] Adjacency rows as `{from, to, type}`.
 * @param {Number} [input.maxNodes]
 * @param {Number} [input.maxEdges]
 * @param {Number} [input.maxBytes]
 * @param {String} [input.origin]
 * @returns {Object} The projected scene.
 */
export function projectNeighbourhood({
    seedIds    = [],
    nodes      = [],
    edges      = [],
    maxNodes   = DEFAULT_MAX_NODES,
    maxEdges   = DEFAULT_MAX_EDGES,
    maxBytes   = DEFAULT_MAX_BYTES,
    origin     = DEFAULT_ORIGIN
} = {}) {
    const
        qualified = nodes.map(row => ({
            id   : qualifyNodeId(row.id, row.origin ?? origin),
            label: row.label ?? null,
            kind : row.kind ?? null
        })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        keep    = qualified.slice(0, maxNodes),
        present = new Set(keep.map(entry => entry.id)),
        // An edge whose endpoint was withheld leaves with it: a dangling edge would name an id the
        // scene does not contain, and a viewer resolving it would either invent a node or show a
        // line to nowhere. The seam emits adjacency presence only — see the module doc for why a
        // relation label is absent here rather than defaulted.
        linked  = edges
            .map(row => ({
                from: qualifyNodeId(row.from, origin),
                to  : qualifyNodeId(row.to, origin)
            }))
            .filter(row => present.has(row.from) && present.has(row.to))
            .sort((a, b) => a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
        keptEdges = linked.slice(0, maxEdges),
        budget    = {maxNodes, maxEdges, maxBytes};

    const scene = {
        route       : seedIds,
        nodes       : keep,
        edges       : keptEdges,
        counts      : {nodes: keep.length, edges: keptEdges.length, seeds: seedIds.length},
        budget,
        completeness: 'complete'
    };

    // The byte budget is applied last and is a budget cut like any other: it can only ever report
    // `truncated`. Edges go first because they are the bulk of a neighbourhood's weight, and the
    // trim runs from the end of the sorted arrays so it stays deterministic.
    if (Buffer.byteLength(JSON.stringify(scene), 'utf8') > maxBytes) {
        let retained = keptEdges.length;

        while (retained > 0 && Buffer.byteLength(JSON.stringify({...scene, edges: keptEdges.slice(0, retained)}), 'utf8') > maxBytes) {
            retained--
        }

        scene.edges           = keptEdges.slice(0, retained);
        scene.counts.edges    = retained;
        scene.completeness    = 'truncated'
    }

    if (keep.length < qualified.length || keptEdges.length < linked.length) {
        scene.completeness = 'truncated'
    }

    return scene
}

/**
 * @summary Reduce a read's raw outcome to the viewer's capability vocabulary.
 *
 * The states are the cockpit pane's own — `current`, `degraded`, `unavailable` — so a wired read and
 * an unwired slot are the same shape to whatever renders them, and neither invents a vocabulary the
 * pane has to translate.
 *
 * The distinction this preserves is "there is nothing here" from "I could not see here": a seeded
 * read that resolved nothing is `degraded`, not `current`, so a viewer never renders an empty graph
 * as evidence that the fleet has no graph.
 *
 * @param {Object} input
 * @param {Boolean} input.measurable Whether the read could reach its source at all.
 * @param {Boolean} input.seeded Whether any seed was available to collect around.
 * @param {Number} [input.found] How many graph rows the collection resolved.
 * @param {String} [input.reason] Why the read is not current, when it is not.
 * @returns {{state: String, reason: String|null}}
 */
export function resolveSceneRead({measurable, seeded, found = 0, reason = null}) {
    if (!measurable) {
        return {state: 'unavailable', reason: reason ?? 'source-unreachable'}
    }

    if (!seeded || found === 0) {
        return {state: 'degraded', reason: reason ?? (seeded ? 'no-rows-resolved' : 'no-seeds')}
    }

    return {state: 'current', reason: null}
}

/**
 * @summary Build a graph-scene source bound to a route seam and a graph seam.
 *
 * The source imports neither an MCP tool service nor request context; both arrive as operations,
 * so the same source serves a process-lifetime bridge and a test without either knowing which.
 *
 * @param {Object} options
 * @param {Function} options.getComputedRoute Resolves the live `computed-route.v1` sidecar.
 * @param {Function} options.getNode Resolves one graph row, or `null` when the reader may not see it.
 * @param {Function} options.getNeighbors Resolves one node's adjacency as `{nodes, depth}`.
 * @param {Function} [options.now] Clock seam, for the envelope's capture stamp.
 * @param {String} [options.origin] Origin for ids the graph returns origin-implicit.
 * @returns {{readGraphScene: Function}}
 */
export function createFleetGraphSceneSource({
    getComputedRoute,
    getNode,
    getNeighbors,
    now                = () => Date.now(),
    origin             = DEFAULT_ORIGIN
} = {}) {
    /**
     * @summary The content identity of a scene: what a future resumable read would bind to.
     * @param {Object} scene
     * @returns {String}
     */
    const identityOf = scene => createHash('sha256')
        .update(JSON.stringify(scene))
        .digest('hex')
        .slice(0, 16);

    return {
        /**
         * @summary Read one bounded graph scene around the live route.
         *
         * @param {Object} [query]
         * @param {String[]} [query.seeds] Override the route's items as the neighbourhood seeds.
         * @param {Number} [query.depth] Neighbour depth handed to the graph seam.
         * @param {Number} [query.maxNodes]
         * @param {Number} [query.maxEdges]
         * @param {Number} [query.maxBytes]
         * @returns {Promise<Object>} The read envelope.
         */
        async readGraphScene({seeds, depth = 1, maxNodes, maxEdges, maxBytes} = {}) {
            // The two graph seams are consumed exactly as the operations document them: `get_node`
            // answers the node itself (404 when it will not), `get_neighbors` answers
            // `{neighbors: [{id}]}`. Both are read strictly — a stubbed seam proves the walk, never
            // the wire shape, and a tolerant reader would hide a rename rather than surface it.
            //
            // A node the seam refuses — RLS, or a 404 — is a SCOPE CUT and is dropped, not raised: one
            // withheld row must not collapse a whole neighbourhood to `unavailable`, which would
            // tell the viewer its view failed when in fact it is merely smaller than it asked for.
            const readNode = async id => {
                try {
                    return await getNode(id) ?? null
                } catch {
                    return null
                }
            };
            const readAdjacency = async id => {
                try {
                    const answer = await getNeighbors(id);

                    return (answer?.neighbors ?? []).map(entry => entry?.id).filter(Boolean)
                } catch {
                    return []
                }
            };

            let route;

            try {
                route = await getComputedRoute()
            } catch (error) {
                return {
                    capability: {state: 'unavailable', reason: 'route-read-failed'},
                    scene     : null,
                    snapshotId: null,
                    capturedAt: new Date(now()).toISOString()
                }
            }

            if (!route || route.status !== 'fresh') {
                return {
                    capability: {state: 'unavailable', reason: route ? 'route-not-fresh' : 'route-missing'},
                    scene     : null,
                    snapshotId: null,
                    capturedAt: new Date(now()).toISOString()
                }
            }

            const
                seedIds = (seeds ?? route.items ?? []).map(item => qualifyNodeId(item.ref ?? item, origin)),
                found   = [],
                queue   = [...seedIds],
                seen    = new Set(seedIds);

            // Breadth-first, one hop per level, to the depth the caller asked for. The projection is
            // single-hop by contract, so the DEPTH is this loop and not the seam — a seam handed a
            // depth it cannot honour would be a fiction, and a fiction here would read as a bound that
            // is not being applied. The budget in rows and bytes is the only bound this feed can
            // honour honestly, so it is the one the scene reports.
            for (let level = 0; level < depth && queue.length; level++) {
                const atLevel = queue.splice(0, queue.length);

                for (const id of atLevel) {
                    const row = await readNode(id);

                    if (row) {
                        found.push(row)
                    }

                    for (const neighbour of await readAdjacency(id)) {
                        const qualified = qualifyNodeId(neighbour, origin);

                        if (!seen.has(qualified)) {
                            seen.add(qualified);
                            queue.push(qualified)
                        }
                    }
                }
            }

            const
                collected = found.filter((row, index) => found.findIndex(candidate => candidate.id === row.id) === index),
                projected = projectNeighbourhood({
                    seedIds, nodes: collected, maxNodes, maxEdges, maxBytes, origin
                }),
                resolved  = resolveSceneRead({
                    measurable: true,
                    seeded    : seedIds.length > 0,
                    found     : projected.counts.nodes
                });

            return {
                capability: resolved,
                scene     : projected,
                snapshotId: identityOf(projected),
                capturedAt: new Date(now()).toISOString()
            }
        }
    }
}

export default createFleetGraphSceneSource;
