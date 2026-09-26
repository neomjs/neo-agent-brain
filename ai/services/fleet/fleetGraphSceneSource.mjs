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
 * **The seam is keyed by the graph's own id.** `get_node` and `get_neighbors` receive a bare id
 * (`issue-9853`), never `origin#id`: the graph stores bare ids, so a seam asked for a qualified one
 * answers `{result: null}` for a row it holds, and every row past the seeds would read as a scope cut.
 * Qualification is applied to the EMITTED scene, which is the only place the origin is known.
 *
 * ## What an edge in a scene is
 *
 * An emitted edge is `{from, to}` plus a `type` when the seam supplied one. The neighbour operation
 * names the relation as `relationship` and the edge's own endpoints as `source` / `target`, so both
 * are passed through rather than reconstructed — deriving `{from: the node we asked about, to: the
 * neighbour}` reverses every INBOUND edge, and with both endpoints expanded it emits each edge twice,
 * spending the edge budget twice on a graph of unique links.
 *
 * When a projection carries no `relationship` the key is ABSENT rather than defaulted. An earlier
 * draft defaulted it, on a misreading of `conceptNeighborhoodProbe`'s note: that note narrows edge
 * *properties* to `weight`, not the edge *type*. A placeholder relation is the one thing a viewer
 * cannot distinguish from a real one, so the honest shape is present-or-absent.
 *
 * `completeness` is scoped to the RLS-filtered projection this read walked, not the raw graph behind
 * it. Edge-RLS is a surface distinct from node-RLS — an edge between two visible nodes can itself be
 * withheld — so "complete" means "everything the projection would show this reader", and a pane must
 * not read it as "everything that exists". A seam that RAISES is neither of the two cuts: the read is
 * `degraded` with the operation's reason and hands over the partial scene it did resolve.
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
 * @param {Object[]} [input.edges] Adjacency rows as `{from, to}` — adjacency presence, no relation.
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
                to  : qualifyNodeId(row.to, origin),
                // Passed through only when the seam supplied one. The neighbour operation names the
                // relation as `relationship`; when a projection does not carry it the key is ABSENT
                // rather than defaulted, because a placeholder relation would render as a real one.
                ...(row.type ? {type: row.type} : {})
            }))
            .filter(row => present.has(row.from) && present.has(row.to))
            .sort((a, b) => a.from !== b.from ? (a.from < b.from ? -1 : 1) : a.to !== b.to ? (a.to < b.to ? -1 : 1) : 0),
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
export function resolveSceneRead({measurable, seeded, found = 0, reason = null, partial = false}) {
    if (!measurable) {
        return {state: 'unavailable', reason: reason ?? 'source-unreachable'}
    }

    // A seam that RAISED is neither a scope cut nor a whole-scene failure: whatever resolved before
    // it is still true. `degraded` with the reason hands the partial scene over, where `unavailable`
    // would claim there is no scene at all and `complete` would launder an outage into a fact.
    if (partial) {
        return {state: 'degraded', reason: reason ?? 'graph-seam-refused'}
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
            // A seam that THREW is not a seam that withheld. The graph operations answer `null` for a
            // row the reader may not see, and raise when the store itself cannot answer — collapsing
            // the two would report an infrastructure outage as a permission, which is the one
            // confusion this feed exists to avoid. So a refusal is tracked, not swallowed.
            let seamRefused = null;

            const readNode = async id => {
                try {
                    return {row: await getNode(id) ?? null}
                } catch (error) {
                    seamRefused ??= 'graph-node-read-failed';

                    return {row: null}
                }
            };
            const readAdjacency = async id => {
                try {
                    // The await and the member access are kept as separate statements on purpose.
                    // Written as `await getNeighbors(id)?.neighbors`, the optional chaining applies to
                    // the PROMISE rather than to the resolved answer, so the expression is
                    // `await (promise.neighbors)` — always `undefined`, hence always an empty walk.
                    // It failed silently: no throw, no error path, just a scene with no edges.
                    const answer = await getNeighbors(id);

                    return {neighbours: answer?.neighbors ?? []}
                } catch (error) {
                    seamRefused ??= 'graph-neasons-refused';

                    return {neighbours: []}
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

            // The operation answers an ENVELOPE, not a sidecar: `{status, reason, details, route,
            // admission}` with `status` one of `available | missing | …` and freshness nested at
            // `route.route.status`. Reading `status === 'fresh'` here can never be true, so every wired
            // read answered `route-not-fresh`. The sibling route source already reduces this exact
            // shape; the item id is `id`, not `ref`. A route the operation will not serve is DEGRADED
            // with its own reason, not `unavailable` — there is no graph to be unavailable from.
            const items = route?.status === 'available' ? route.route?.route?.items ?? null : null;

            if (!items) {
                return {
                    capability: {state: 'degraded', reason: route?.reason ?? 'route-answer-malformed'},
                    scene     : null,
                    snapshotId: null,
                    capturedAt: new Date(now()).toISOString()
                }
            }

            const
                // The seam is keyed by the graph's OWN id — bare, as `issue-9853`. Qualification is
                // applied to the EMITTED scene, never to the request: a seam asked for
                // `owner/repo#issue-9853` answers `{result: null}` for a row it holds, which would make
                // every row past the seeds read as a scope cut.
                entries = (seeds ?? items).map(item => {
                    const bare = String(item?.id ?? item);

                    return {bare, id: qualifyNodeId(bare, origin)}
                }),
                seedIds = entries.map(entry => entry.id),
                found   = [],
                links   = [],
                linkKeys = new Set(),
                queue   = entries.map(entry => entry.bare),
                byId    = new Map(entries.map(entry => [entry.bare, entry.id])),
                seen    = new Set(seedIds);

            // Breadth-first, one hop per level. The loop runs `depth + 1` levels because the SEEDS are
            // hop zero: `level <= depth` resolves the seeds at level 0 and their neighbours at level
            // `depth`, so `depth: 1` is the one-hop neighbourhood. Bounding at `level < depth` instead
            // made `depth: d` answer the (d−1)-hop neighbourhood while reporting `depth: d` — the
            // second ring was silently missing and the scene still claimed to be complete.

            for (let level = 0; level <= depth && queue.length; level++) {
                const atLevel = queue.splice(0, queue.length);

                for (const bare of atLevel) {
                    const {row} = await readNode(bare);

                    if (row) {
                        found.push(row)
                    }

                    for (const neighbour of (await readAdjacency(bare)).neighbours) {
                        const
                            // The operation carries the edge's own direction and relation: `source` and
                            // `target` name the real endpoints and `relationship` names the relation.
                            // Deriving `{from: the node we asked about, to: the neighbour}` instead —
                            // which is what this walk did — REVERSES every inbound edge, and with both
                            // endpoints expanded it emits each edge twice, spending the budget twice.
                            from = byId.get(String(neighbour?.source ?? bare)) ?? qualifyNodeId(bare, origin),
                            to   = byId.get(String(neighbour?.target)) ?? qualifyNodeId(String(neighbour?.id ?? ''), origin),
                            type = neighbour?.relationship ?? null;

                        if (!byId.has(String(neighbour?.target)) && neighbour?.id) {
                            byId.set(String(neighbour.id), qualifyNodeId(String(neighbour.id), origin))
                        }

                        // The link is recorded whether or not the target is newly discovered: a hop
                        // back to a node already in the scene is still an edge the scene must draw,
                        // and dropping it because the node was "already seen" would silently delete
                        // every cycle and every cross-link in the graph.
                        //
                        // Deduplicated, because the operation answers an edge from BOTH of its
                        // endpoints: a walk that expands both ends sees every link twice, and charging
                        // the edge budget for both spends it on a graph of unique links. Keyed on the
                        // oriented pair, so a genuine parallel edge with a different `type` is still
                        // two edges rather than one.
                        const key = from + '\u0000' + to + '\u0000' + (type ?? '');

                        if (!linkKeys.has(key)) {
                            linkKeys.add(key);
                            links.push(type ? {from, to, type} : {from, to})
                        }

                        if (!seen.has(to)) {
                            seen.add(to);
                            queue.push(String(neighbour?.id ?? neighbour?.target))
                        }
                    }
                }
            }

            const
                collected = found.filter((row, index) => found.findIndex(candidate => candidate.id === row.id) === index),
                projected = projectNeighbourhood({
                    seedIds, nodes: collected, edges: links, maxNodes, maxEdges, maxBytes, origin
                }),
                resolved  = resolveSceneRead({
                    measurable: true,
                    seeded    : seedIds.length > 0,
                    found     : projected.counts.nodes,
                    partial   : Boolean(seamRefused),
                    reason    : seamRefused
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
