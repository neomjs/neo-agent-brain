import fs                                  from 'node:fs';
import path                                from 'node:path';
import FleetControlBridge                  from './FleetControlBridge.mjs';
import {createFleetActivityReadSource}     from './fleetActivityComposer.mjs';
import {readFleetA2AActivitySnapshot}      from './fleetA2AActivityAdapter.mjs';
import {createFleetPrLaneActivitySnapshot} from './fleetPrLaneActivityAdapter.mjs';
import {CORPUS_PROJECTION_ORIGIN}          from '../graph/corpusProjectionContract.mjs';
import {buildWorkGraphStallFindings,
        readSyncedPullRecords,
        readWorkGraphIssueRecords}           from '../graph/issueFocusSections.mjs';

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
 *  - **PR/lane** — the *pure builder* `createFleetPrLaneActivitySnapshot` over facts THIS module reads:
 *    local-synced issue records (`readWorkGraphIssueRecords` — the same records the stall inference walks,
 *    so the two stay graph-consistent) + work-graph stall findings (`buildWorkGraphStallFindings`) +
 *    injected PR payloads. The reading is the substantive work of this leaf, not a passthrough.
 *
 * @see ai/services/fleet/wireBootIdentityReadSource.mjs — the wire-shape precedent
 * @see ai/services/memory-core/readActiveWakeSubscriptionIdentities.mjs — the lazy-singleton cross-process precedent
 */

/**
 * @summary The A2A slot reader — one bounded snapshot over the injected mailbox read path. The caller
 * owns the `listMessages` binding, so a broken/absent mailbox surfaces as this slot's own degraded
 * capability rather than a composer guess about it.
 * @param {Function} listMessages MailboxService-compatible `listMessages(args)`.
 * @returns {Function} `params => Promise<{capability, events}>`
 * @private
 */
function makeReadA2ASnapshot(listMessages) {
    return params => readFleetA2AActivitySnapshot({listMessages, limit: params.limit})
}

/**
 * @summary Resolves the conversation origins a content root carries.
 *
 * The layout is read from the tree and the corpus's own index, never guessed from directory names:
 * a root with `issues/` directly under it is the pre-split single-origin tree — the engine's
 * `resources/content`, one origin's subtree of a corpus checkout, or the orchestrator's materialized
 * root (which keeps the corpus index verbatim while materializing one origin without its prefix,
 * so the directory decides, not the index). Otherwise a root whose `_index.json` rows carry
 * `repoSlug` is the multi-origin corpus, `<root>/<repoSlug>/{issues,pulls}` per distinct slug with
 * the Graph's origin first. An origin the index names but the tree lacks is still returned: its
 * read degrades by name in the snapshot rather than vanishing silently.
 * @param {String} contentRoot Absolute content root (the `fleet.contentRoot` leaf's value).
 * @returns {Array<{repoSlug: String, issuesDir: String, pullsDir: String}>}
 */
export function resolveContentOrigins(contentRoot) {
    const legacy = [{
        repoSlug : CORPUS_PROJECTION_ORIGIN,
        issuesDir: path.join(contentRoot, 'issues'),
        pullsDir : path.join(contentRoot, 'pulls')
    }];

    if (isDirectory(legacy[0].issuesDir)) {
        return legacy
    }

    let rows;

    try {
        rows = JSON.parse(fs.readFileSync(path.join(contentRoot, '_index.json'), 'utf8'))
    } catch {
        return legacy
    }

    const slugs = [...new Set(
        (Array.isArray(rows) ? rows : [])
            .map(row => typeof row?.repoSlug === 'string' ? row.repoSlug.trim() : '')
            .filter(Boolean)
    )].sort((a, b) => a === CORPUS_PROJECTION_ORIGIN ? -1 : b === CORPUS_PROJECTION_ORIGIN ? 1 : a.localeCompare(b));

    return slugs.length === 0 ? legacy : slugs.map(repoSlug => ({
        repoSlug,
        issuesDir: path.join(contentRoot, repoSlug, 'issues'),
        pullsDir : path.join(contentRoot, repoSlug, 'pulls')
    }))
}

function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory()
    } catch {
        return false
    }
}

/**
 * @summary The PR/lane slot reader — reads local-synced issue + pull records per origin, plus the
 * work-graph stall findings for the Graph's origin, then hands them to the pure builder.
 *
 * Every origin is read inside its own containment: one unreadable origin degrades the slot naming
 * that origin while the rows of the others are kept (the builder's `partialFailures` path), and only
 * when no origin at all could be read does the slot take the builder's `error` path. Records are
 * stamped with their origin's `repoSlug` so the builder can key them apart. Stall inference joins
 * the Native Edge Graph by bare `issue-N`, and the Graph carries ONE origin by contract
 * (`CORPUS_PROJECTION_ORIGIN`) — a foreign origin's number would join a stranger's node — so only
 * the Graph's origin is inferred; the others contribute PR, issue and lane-claim rows.
 * @param {Object} options
 * @param {Array<{repoSlug: String, issuesDir: String, pullsDir?: String}>} options.origins Resolved origins.
 * @param {Object} [options.graphService] memory-core GraphService for stall-finding defer disposition.
 * @returns {Function} `params => Promise<{capability, events}>`
 * @private
 */
function makeReadPrLaneSnapshot({origins, graphService}) {
    return async params => {
        const capturedAt    = new Date(),
              prs           = [],
              issues        = [],
              stallFindings = [],
              failures      = [];

        for (const origin of origins) {
            try {
                const originPrs    = (typeof origin.pullsDir === 'string' && origin.pullsDir.length > 0)
                          ? readSyncedPullRecords(origin.pullsDir, {limit: params.limit})
                          : [],
                      originIssues = readWorkGraphIssueRecords(origin.issuesDir);

                prs.push(...originPrs.map(pr => ({...pr, repoSlug: origin.repoSlug})));
                issues.push(...originIssues.map(issue => ({...issue, repoSlug: origin.repoSlug})));

                if (origin.repoSlug === CORPUS_PROJECTION_ORIGIN) {
                    stallFindings.push(...buildWorkGraphStallFindings({issuesDir: origin.issuesDir, prs: originPrs, now: capturedAt, graphService})
                        .map(finding => ({...finding, subject: finding.subject ? {...finding.subject, repoSlug: origin.repoSlug} : finding.subject})))
                }
            } catch (error) {
                // Contained per origin — an unreadable tree names its origin, never the whole slot,
                // unless it was the only origin there was.
                failures.push(`${origin.repoSlug}: ${error?.message ?? error}`)
            }
        }

        if (failures.length === origins.length) {
            return createFleetPrLaneActivitySnapshot({error: failures.join(' · '), limit: params.limit, capturedAt})
        }

        return createFleetPrLaneActivitySnapshot({prs, issues, stallFindings, partialFailures: failures, limit: params.limit, capturedAt})
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
 * @param {Number} [options.limit] Default event bound forwarded to the composer.
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
    limit,
    bridge       = FleetControlBridge,
    createSource = createFleetActivityReadSource
} = {}) {
    const origins = typeof contentRoot === 'string' && contentRoot.length > 0
        ? resolveContentOrigins(contentRoot)
        : (typeof issuesDir === 'string' && issuesDir.length > 0 ? [{repoSlug: CORPUS_PROJECTION_ORIGIN, issuesDir, pullsDir}] : []);

    const hasA2A    = typeof listMessages === 'function',
          hasPrLane = origins.length > 0;

    // No readable slot at all → leave the seam unwired (honest not-wired), never fabricate a source.
    if (!hasA2A && !hasPrLane) {
        return null
    }

    // A missing source throws inside the composer's per-slot `try` → that slot degrades naming itself,
    // and the unanimity rule reports the composite as degraded (not wired) — the honest partial state.
    const readA2ASnapshot = hasA2A
        ? makeReadA2ASnapshot(listMessages)
        : () => { throw new Error('a2a activity source not wired — no listMessages bound') };

    const readPrLaneSnapshot = hasPrLane
        ? makeReadPrLaneSnapshot({origins, graphService})
        : () => { throw new Error('pr-lane activity source not wired — no contentRoot or issuesDir') };

    bridge.activitySource = createSource({readA2ASnapshot, readPrLaneSnapshot, limit});

    return bridge.activitySource
}
