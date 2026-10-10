import FleetControlBridge              from './FleetControlBridge.mjs';
import {createFleetActivityReadSource} from './fleetActivityComposer.mjs';
import {readFleetA2AActivitySnapshot}  from './fleetA2AActivityAdapter.mjs';
import {makeReadPrLaneSnapshot}        from './readPrLaneActivitySnapshot.mjs';
import {withProducerPrLane}            from './producerPrLaneEvents.mjs';
import {resolveContentOrigins}         from '../graph/contentOrigins.mjs';
import {CORPUS_PROJECTION_ORIGIN}      from '../graph/corpusProjectionContract.mjs';
import {normalizeMailboxObserver}      from '../memory-core/helpers/mailboxObservation.mjs';

/**
 * @module ai/services/fleet/wireFleetActivityReadSource
 * @summary Installs the composed `activitySource` onto `FleetControlBridge.activitySource` at the
 * fleet-bridge-server boot, so `readActivitySnapshot(params)` serves real A2A + PR/lane activity
 * instead of the by-construction `not-wired` default the bridge has answered since it was written.
 *
 * **Read-at-use-site, mirroring `wireBootIdentityReadSource`.** The caller (the fleet-server process
 * entry) resolves config + the cross-process memory-core singletons at the boot use site and passes
 * them in; this module owns no config default and captures no leaf. **Fail-soft:** with neither slot
 * readable it leaves `activitySource` unwired (the honest `not-wired` snapshot), never a fabricated
 * source. **No stub:** an unreadable slot degrades honestly through the composer's unanimity rule —
 * the composite is `wired` only when BOTH slots read, `degraded` when one cannot.
 *
 * **This is where the two read-path ownerships are honoured or broken:**
 *  - **A2A** — `readFleetA2AActivitySnapshot` over the **injected** `listMessages`. The caller binds
 *    the `MailboxService` singleton (lazily imported at the entry, like `readActiveWakeSubscriptionIdentities`
 *    binds `GraphService`); this module never imports it, so identity/permission binding stays at the boundary.
 *  - **PR/lane** — `makeReadPrLaneSnapshot` over the origins resolved under the caller's content root
 *    (synced issue + pull records, work-graph stall findings, the pure builder), or an **injected**
 *    `readPrLane` in its place: a Fleet attached to a plane has no corpus of its own, so its reader is
 *    the plane's `get_pr_lane_activity` (`planePrLaneActivityReader`), the same slot served remotely.
 *
 * @see ai/services/fleet/wireBootIdentityReadSource.mjs — the wire-shape precedent
 * @see ai/services/memory-core/readActiveWakeSubscriptionIdentities.mjs — the lazy-singleton cross-process precedent
 */

/**
 * @summary The A2A slot reader — one bounded snapshot over the injected mailbox read path. The caller
 * owns the `listMessages` binding, so a broken/absent mailbox surfaces as this slot's own degraded
 * capability rather than a composer guess about it. The composer's page offset becomes the mailbox
 * query's `offset`; the first page asks without one. An explicit closed observer selector uses the
 * same canonical non-stamping list path in local and plane bindings, with no identity supplied by UI.
 * @param {Function} listMessages MailboxService-compatible `listMessages(args)`.
 * @returns {Function} `params => Promise<{capability, events}>`
 * @private
 */
function makeReadA2ASnapshot(listMessages) {
    return params => {
        const listArgs = params.offset > 0 ? {offset: params.offset} : {};

        if (params.observer !== undefined) {
            if (Object.keys(params).some(key => !['observer', 'limit', 'offset', 'slots'].includes(key))) {
                throw new TypeError('observer activity accepts only observer, limit, offset and slots; identity is server-bound')
            }
            listArgs.observer = normalizeMailboxObserver(params.observer)
        }

        return readFleetA2AActivitySnapshot({listArgs, listMessages, limit: params.limit})
    }
}

/**
 * @summary Wire the composed activity read-source onto the fleet control bridge.
 *
 * Each slot is wired only when its own source is present; an absent source throws inside the composer's
 * per-slot containment and surfaces as that slot's degraded capability — honest, never fabricated. With
 * NEITHER source present the bridge is left unwired (the by-construction `not-wired` snapshot stands).
 *
 * @param {Object} options
 * @param {String} [options.contentRoot] The synced content root (the `fleet.contentRoot` leaf, read at
 *     the caller's use site): a corpus checkout root or one origin's tree — `resolveContentOrigins`
 *     decides which. Absent → `issuesDir` / `pullsDir` name one origin directly.
 * @param {String} [options.issuesDir] Local synced issue directory of the Graph's origin, read at the
 *     caller's use site. With neither this nor `contentRoot` the PR/lane slot degrades.
 * @param {Function} [options.listMessages] MailboxService-compatible `listMessages(args)`, bound by the
 *     caller (never imported here). Absent → the A2A slot degrades.
 * @param {Object} [options.graphService] memory-core GraphService for stall-finding defer disposition
 *     (injected; the caller lazily imports the singleton).
 * @param {String} [options.pullsDir] Local synced pulls directory of the Graph's origin, read at the
 *     caller's use site. Absent → the PR/lane slot emits no pr-activity events (honest-empty).
 * @param {Function} [options.readPrLane] A PR/lane slot reader in place of a local tree (plane mode:
 *     `planePrLaneActivityReader`); with one, no content root is read.
 * @param {Object|Function} [options.openWorkProducer] The open-work producer (`{getState}`), or a function
 *     answering it at read time. With one, the slot's pull-request events are the producer's transitions
 *     for every repository (`withProducerPrLane`); the tree or plane reader keeps the issue, lane-claim
 *     and stall events. A producer alone is a readable slot.
 * @param {Function} [options.resolveViewerIdentity] Server-bound mailbox scope, resolved per call.
 * @param {Number} [options.limit] Default event bound forwarded to the composer.
 * @param {Object} [options.laneClaimStore] `{load, save}` keeping the per-seat lane record across restarts.
 * @param {String} [options.laneClaimSource] The admitted mailbox's identity the record is saved for; required with a store.
 * @param {Object} [options.bridge=FleetControlBridge] The control bridge to wire (a stub in specs).
 * @param {Function} [options.createSource=createFleetActivityReadSource] The composer factory (injected in specs).
 * @returns {Object|null} the wired read-source, or `null` when no slot is readable (left unwired).
 */
export function wireFleetActivityReadSource({
    contentRoot,
    issuesDir,
    listMessages,
    graphService,
    pullsDir,
    readPrLane,
    openWorkProducer = null,
    resolveViewerIdentity,
    limit,
    laneClaimStore,
    laneClaimSource,
    bridge       = FleetControlBridge,
    createSource = createFleetActivityReadSource
} = {}) {
    const injected = typeof readPrLane === 'function',
          origins  = injected ? [] : typeof contentRoot === 'string' && contentRoot.length > 0
              ? resolveContentOrigins(contentRoot)
              : (typeof issuesDir === 'string' && issuesDir.length > 0 ? [{repoSlug: CORPUS_PROJECTION_ORIGIN, issuesDir, pullsDir}] : []);

    const hasA2A      = typeof listMessages === 'function',
          hasProducer = Boolean(openWorkProducer),
          hasPrLane   = injected || origins.length > 0 || hasProducer;

    // No readable slot at all → leave the seam unwired (honest not-wired), never fabricate a source.
    if (!hasA2A && !hasPrLane) {
        return null
    }

    // A missing source throws inside the composer's per-slot `try` → that slot degrades naming itself,
    // and the unanimity rule reports the composite as degraded (not wired) — the honest partial state.
    const readA2ASnapshot = hasA2A
        ? makeReadA2ASnapshot(listMessages)
        : () => { throw new Error('a2a activity source not wired — no listMessages bound') };

    // the base reader: the plane's slot, or the local tree's; null when this process has neither
    const readPrLaneBase = injected ? readPrLane : origins.length > 0 ? makeReadPrLaneSnapshot({origins, graphService}) : null;

    const readPrLaneSnapshot = hasProducer
        ? withProducerPrLane(readPrLaneBase, {producer: openWorkProducer})
        : readPrLaneBase ?? (() => { throw new Error('pr-lane activity source not wired — no contentRoot or issuesDir') });

    bridge.activitySource = createSource({readA2ASnapshot, readPrLaneSnapshot, resolveViewerIdentity, limit, laneClaimStore, laneClaimSource});

    return bridge.activitySource
}
