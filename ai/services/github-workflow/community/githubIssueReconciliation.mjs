import {issueToObservations} from './githubIssueObservations.mjs';
import {bindCommunityCoverage} from '../../memory-core/communityCoverageContract.mjs';

/**
 * @summary The basis marker for the beginning of history — the `fromBasis` of a first run that
 * resumes from no prior cursor, and the `toBasis` of a run over an empty family. Keeps the coverage
 * window a pair of concrete bases rather than nulls the contract would reject.
 * @member {String}
 */
export const GENESIS_BASIS = 'genesis';

/**
 * @summary Drives one paginated connection to true exhaustion (or until a page cap truncates it),
 * merging every page's items into a single list. The first page arrives inline on the parent node;
 * only the overflow is continuation-fetched here.
 *
 * Exhaustion is `hasNextPage === false`, never a first page: a partial connection silently drops
 * tail items (late comments, late events), so the walk only stops early when a caller cap forces
 * it — and then it says so via `truncated`, so the omission is auditable rather than invisible.
 * @param {Object}   connection
 * @param {Object}   [connection.firstPage]  `{nodes:[...], pageInfo:{hasNextPage,endCursor}}` inline first page.
 * @param {Function} connection.fetchNext    async (cursor) => `{items:[...], pageInfo}` for the next page.
 * @param {Number}   connection.maxPages     Hard cap on pages walked (Infinity for unbounded).
 * @returns {Promise<{items: Object[], truncated: Boolean}>}
 */
async function exhaustConnection({firstPage, fetchNext, maxPages}) {
    if (!Array.isArray(firstPage?.nodes) || typeof firstPage.pageInfo?.hasNextPage !== 'boolean') {
        throw new Error('ISSUE_RECONCILIATION_CHILD_PAGE_INVALID')
    }
    const items = [], ids = new Set(), cursors = new Set();
    const append = values => {
        if (!Array.isArray(values)) throw new Error('ISSUE_RECONCILIATION_CHILD_PAGE_INVALID');
        for (const value of values) {
            if (typeof value?.id !== 'string' || !value.id || ids.has(value.id)) {
                throw new Error('ISSUE_RECONCILIATION_CHILD_ID_INVALID')
            }
            ids.add(value.id);
            items.push(value)
        }
    };
    append(firstPage.nodes);

    let pageInfo = firstPage?.pageInfo,
        pages    = 1;

    while (pageInfo.hasNextPage) {
        if (pages >= maxPages) {
            return {items, truncated: true}
        }

        const cursor = pageInfo.endCursor;
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
            throw new Error('ISSUE_RECONCILIATION_CHILD_CURSOR_STALLED')
        }
        cursors.add(cursor);
        const next = await fetchNext(cursor);
        if (typeof next?.pageInfo?.hasNextPage !== 'boolean') {
            throw new Error('ISSUE_RECONCILIATION_CHILD_PAGE_INVALID')
        }

        append(next.items);
        pageInfo = next.pageInfo;
        pages++
    }

    return {items, truncated: false}
}

/**
 * @summary Exhaustively reconciles a GitHub issue resource-family into community-activity-batch.v1
 * observations, driving three independent pagination axes — the issue list across ALL states, then
 * each issue's comments and its timeline — to completion behind injected fetch seams.
 *
 * The three axes are independent by design: an issue's comments and its lifecycle timeline are
 * separate connections, each exhausted on its own, so neither truncates the other and a comment is
 * never double-counted against a timeline event. Closed and open issues are enumerated identically
 * — reconciliation reflects the provider, it does not filter by state.
 *
 * Completeness requires a traversal from the beginning with valid, exhausted connections. Caps,
 * suffix starts, malformed pages and failed reads retain explicit acquisition gaps. Fixed provider
 * history limitations are separate declarations under the persisted coverage contract. All I/O is
 * injected, keeping the exhaustion witness-testable without a browser or a live GitHub.
 * @param {Object}   seams
 * @param {Function} seams.fetchIssuesPage    async ({cursor}) => `{issues:[node], pageInfo}`; each node carries id, createdAt, author, and inline first pages of `comments` and `timeline`.
 * @param {Function} seams.fetchCommentsPage  async ({issueId, cursor}) => `{comments:[c], pageInfo}`.
 * @param {Function} seams.fetchTimelinePage  async ({issueId, cursor}) => `{events:[e], pageInfo}`.
 * @param {Object}   [options]
 * @param {String}   [options.fromBasis]                 Diagnostic suffix cursor; a suffix cannot qualify whole-history coverage.
 * @param {Number}   [options.maxIssuePages]             Cap on issue-list pages (default: unbounded).
 * @param {Number}   [options.maxCommentPagesPerIssue]   Cap on per-issue comment pages (default: unbounded).
 * @param {Number}   [options.maxTimelinePagesPerIssue]  Cap on per-issue timeline pages (default: unbounded).
 * @returns {Promise<{observations: Object[], coverage: Object, nextProviderState: Object}>}
 */
export async function reconcileIssueActivity(seams, options = {}) {
    const {fetchIssuesPage, fetchCommentsPage, fetchTimelinePage} = seams || {};

    if ([fetchIssuesPage, fetchCommentsPage, fetchTimelinePage].some(fn => typeof fn !== 'function')) {
        throw new Error('ISSUE_RECONCILIATION_REQUIRES_FETCH_SEAMS')
    }

    const {
        fromBasis = null, maxIssuePages = Infinity,
        maxCommentPagesPerIssue = Infinity, maxTimelinePagesPerIssue = Infinity
    } = options;

    for (const cap of [maxIssuePages, maxCommentPagesPerIssue, maxTimelinePagesPerIssue]) {
        if (cap !== Infinity && (!Number.isInteger(cap) || cap < 0)) throw new Error('ISSUE_RECONCILIATION_PAGE_CAP_INVALID')
    }

    const observations = [],
          rootIds      = new Set(),
          rootCursors  = new Set(),
          gaps         = fromBasis === null ? [] : [{axis: 'root-traversal', reason: 'not-from-beginning'}];

    let issuesCursor = fromBasis,
        issuePages   = 0,
        complete     = gaps.length === 0;

    for (;;) {
        if (issuePages >= maxIssuePages) {
            complete = false;
            gaps.push({axis: 'issues', afterCursor: issuesCursor});
            break
        }

        let issues, pageInfo;
        try {
            ({issues, pageInfo} = await fetchIssuesPage({cursor: issuesCursor}));
            if (!Array.isArray(issues) || typeof pageInfo?.hasNextPage !== 'boolean' ||
                pageInfo.endCursor != null && typeof pageInfo.endCursor !== 'string' ||
                issues.some(issue => typeof issue?.id !== 'string' || !issue.id || rootIds.has(issue.id)) ||
                new Set(issues.map(issue => issue.id)).size !== issues.length) {
                throw new Error('ISSUE_RECONCILIATION_ROOT_PAGE_INVALID')
            }
        } catch (error) {
            complete = false;
            gaps.push({axis: 'issues', reason: error instanceof Error ? error.message : String(error)});
            break
        }

        issuePages++;

        for (const issue of issues ?? []) {
            rootIds.add(issue.id);
            try {
                const comments = await exhaustConnection({
                    firstPage: issue.comments,
                    fetchNext: async cursor => {
                        const page = await fetchCommentsPage({issueId: issue.id, cursor});
                        return {items: page.comments, pageInfo: page.pageInfo}
                    },
                    maxPages : maxCommentPagesPerIssue
                });

                const timeline = await exhaustConnection({
                    firstPage: issue.timeline,
                    fetchNext: async cursor => {
                        const page = await fetchTimelinePage({issueId: issue.id, cursor});
                        return {items: page.events, pageInfo: page.pageInfo}
                    },
                    maxPages : maxTimelinePagesPerIssue
                });

                if (comments.truncated) {
                    complete = false;
                    gaps.push({axis: 'comments', issueId: issue.id})
                }

                if (timeline.truncated) {
                    complete = false;
                    gaps.push({axis: 'timeline', issueId: issue.id})
                }

                observations.push(...issueToObservations({...issue, comments: comments.items, timeline: timeline.items}));
            } catch (error) {
                complete = false;
                gaps.push({axis: 'issue-conversation', issueId: issue.id,
                    reason: error instanceof Error ? error.message : String(error)})
            }
        }

        // Capture the reached cursor on EVERY page, including the last — the endpoint of a complete
        // walk is the final page's endCursor, not just the boundary before a continuation.
        const previous = issuesCursor;
        if (pageInfo.endCursor) {
            issuesCursor = pageInfo.endCursor
        }

        if (!pageInfo.hasNextPage) {
            break
        }
        if (typeof issuesCursor !== 'string' || !issuesCursor || previous === issuesCursor || rootCursors.has(issuesCursor)) {
            complete = false;
            gaps.push({axis: 'issues', afterCursor: issuesCursor, reason: 'cursor-stalled'});
            break
        }
        rootCursors.add(issuesCursor)
    }

    const coverage = bindCommunityCoverage('issues', {
        fromBasis: fromBasis ?? GENESIS_BASIS,
        toBasis  : issuesCursor ?? GENESIS_BASIS,
        complete,
        ...(gaps.length ? {gaps} : {})
    });

    return {observations, coverage, nextProviderState: {issuesCursor}}
}
