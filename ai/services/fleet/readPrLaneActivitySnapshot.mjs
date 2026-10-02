import {createFleetPrLaneActivitySnapshot} from './fleetPrLaneActivityAdapter.mjs';
import {CORPUS_PROJECTION_ORIGIN}          from '../graph/corpusProjectionContract.mjs';
import {buildWorkGraphStallFindings,
        readSyncedPullRecords,
        readWorkGraphIssueRecords}           from '../graph/issueFocusSections.mjs';

/**
 * @module ai/services/fleet/readPrLaneActivitySnapshot
 * @summary The PR/lane activity slot's read path over a corpus tree, apart from the bridge wiring so
 * both of its hosts share one path: the in-process Fleet (`wireFleetActivityReadSource`) reads its own
 * content root, and the plane serves the orchestrator's materialized corpus to a Fleet that has none
 * (`get_pr_lane_activity`). Neo-free and bridge-free — importing it spins up no Fleet singleton.
 */

/**
 * @summary The PR/lane slot reader — reads synced issue + pull records per origin, plus the
 * work-graph stall findings for the Graph's origin, then hands them to the pure builder.
 *
 * Every origin is read inside its own containment: one unreadable origin degrades the slot naming
 * that origin while the rows of the others are kept (the builder's `partialFailures` path), and only
 * when no origin at all could be read does the slot take the builder's `error` path. The readers
 * receive the origin and answer origin-qualified records, so the builder keys them apart. Stall inference joins
 * the Native Edge Graph by bare `issue-N`, and the Graph carries ONE origin by contract
 * (`CORPUS_PROJECTION_ORIGIN`) — a foreign origin's number would join a stranger's node — so only
 * the Graph's origin is inferred; the others contribute PR, issue and lane-claim rows.
 * @param {Object} options
 * @param {Array<{repoSlug: String, issuesDir: String, pullsDir?: String}>} options.origins Resolved origins.
 * @param {Object} [options.graphService] memory-core GraphService for stall-finding defer disposition.
 * @returns {Function} `params => Promise<{capability, counts, events}>` — `params.prEvents === false`
 *     answers no pull-request events (a caller whose PR contributor is the open-work producer); the
 *     pull records are still read for the stall inference.
 */
export function makeReadPrLaneSnapshot({origins, graphService}) {
    return async params => {
        const capturedAt    = new Date(),
              prs           = [],
              issues        = [],
              stallFindings = [],
              failures      = [];

        for (const origin of origins) {
            try {
                // The readers own the identity: with `origin` every record carries `repoSlug` and an
                // origin-qualified id, so the same number from two repositories is two records here,
                // not only two events downstream.
                const originPrs = (typeof origin.pullsDir === 'string' && origin.pullsDir.length > 0)
                          ? readSyncedPullRecords(origin.pullsDir, {limit: params.limit, origin: origin.repoSlug})
                          : [],
                      originIssues = readWorkGraphIssueRecords(origin.issuesDir, {origin: origin.repoSlug});

                prs.push(...originPrs);
                issues.push(...originIssues);

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

        return createFleetPrLaneActivitySnapshot({prs, issues, stallFindings, partialFailures: failures, limit: params.limit, prEvents: params.prEvents !== false, capturedAt})
    }
}

export default makeReadPrLaneSnapshot;
