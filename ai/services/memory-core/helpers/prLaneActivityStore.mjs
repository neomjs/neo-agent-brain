import fs                       from 'node:fs/promises';
import path                     from 'node:path';
import {resolveContentOrigins}  from '../../graph/contentOrigins.mjs';
import {makeReadPrLaneSnapshot} from '../../fleet/readPrLaneActivitySnapshot.mjs';

/**
 * @module ai/services/memory-core/helpers/prLaneActivityStore
 * @summary The plane half of the Fleet's PR/lane activity slot. A Fleet attached to this plane carries
 * no corpus, so Memory Core serves the slot from the tree the orchestrator materializes — the same
 * `makeReadPrLaneSnapshot` the in-process Fleet runs over its own content root — and answers the slot's
 * bounded snapshot, never the records under it. One read parses every synced issue file (neo: 2,430
 * files, 39 MB, ~0.4 s), so an answer is kept until the materializer writes a new `_index.json`. A
 * degraded answer is never kept: a tree that is absent, not yet materialized or mid-swap is read again
 * on the next call.
 */

/**
 * @summary Build the memoized PR/lane reader `get_pr_lane_activity` serves.
 * @param {Object}   [options]
 * @param {Function} [options.makeReader=makeReadPrLaneSnapshot] The slot's read path (injected in specs).
 * @param {Function} [options.stat=fs.stat] The `_index.json` stat whose mtime keys the kept answer (injected in specs).
 * @returns {{read: Function}} `read({root, graphService, limit, prEvents})` → `{capability, counts, events, corpusIndexedAt}`;
 *     `prEvents: false` is an answer without pull-request events. Within one materialization every
 *     asked shape (`limit`, `prEvents`) keeps its own answer, so two Fleets asking differently — one
 *     with its own PR producer, one without — do not evict each other's read on every call.
 */
export function createPrLaneActivityStore({makeReader = makeReadPrLaneSnapshot, stat = fs.stat} = {}) {
    let kept = null;

    return {
        async read({root, graphService, limit, prEvents = true} = {}) {
            let indexedAtMs = null;

            try {
                indexedAtMs = (await stat(path.join(root, '_index.json'))).mtimeMs
            } catch {
                // no index — absent, not yet materialized, or mid-swap; the reader names what it finds
            }

            const key = `${limit}|${prEvents}`;

            if (kept && indexedAtMs !== null && kept.indexedAtMs === indexedAtMs && kept.answers.has(key)) {
                return kept.answers.get(key)
            }

            const snapshot = await makeReader({origins: resolveContentOrigins(root), graphService})({limit, prEvents}),
                  answer   = {...snapshot, corpusIndexedAt: indexedAtMs === null ? null : new Date(indexedAtMs).toISOString()};

            if (indexedAtMs !== null && snapshot.capability?.state === 'wired') {
                kept = kept?.indexedAtMs === indexedAtMs ? kept : {indexedAtMs, answers: new Map()};
                kept.answers.set(key, answer)
            } else {
                kept = null
            }

            return answer
        }
    }
}

export default createPrLaneActivityStore;
