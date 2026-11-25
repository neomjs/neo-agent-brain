/**
 * @module ai/services/fleet/openWorkReducer
 * @summary The open-work producer's pure half: GitHub's open pull requests become one normalized
 * snapshot, and two snapshots become the transitions observed between them. No fetch, no clock and
 * no mailbox; the producer owns the reads, this module owns their meaning.
 *
 * A transition's identity is its observation: the PR, its head, the kind of change, from and to,
 * and the pulse that saw it. So a head that goes red, then green, then red again yields two red
 * episodes, and an identical poll yields nothing. A merge or a close comes only from the terminal
 * read, once per close (its time is the episode); a PR leaving the open snapshot is never one. A merge's
 * unblock read becomes the open issues it closed the last open blocker of.
 *
 * Coverage is part of the baseline. A truncated or missing review-request list adds what it shows to
 * the last complete list and removes nothing, and a row no pulse observed keeps the time it was last
 * seen, so a later partial pulse never makes it look fresh. A row first seen after a read that missed
 * pages may only have been unread, so it is no `opened`; the reviews already requested on it are
 * reported either way. A row that leaves complete reads with no terminal row is `vanished`: absence is
 * never a close, and never silent. A seat that owes no coverage can still miss its read: the rows it
 * would have read carry, and a row first seen after that miss is no `opened`.
 */

import {disclosedFamiliesOf}                                                  from '../graph/disclosedModelFamilies.mjs';
import {normalizeReviewRecords, retainReviewWitnesses}                        from './openWorkReviewRecords.mjs';
import {normalizeCiRepair, retainCiRepairClassification, retainCiRepairTouch} from './openWorkCiRepair.mjs';

/**
 * The mandatory PR-body line naming the authoring seat: `Authored by <Social Name> (…)`.
 * @type {RegExp}
 */
const AUTHOR_LINE = /^Authored by\s+([^(\n.]+?)\s*(?:\(|\.|$)/m;

/**
 * Commit status context published by the review-admission mergeability controller.
 * @type {String}
 */
export const REVIEW_ADMISSION_CONTEXT = 'review-admission/mergeability';

/**
 * GitHub's rollup states, folded into the three a holder acts on.
 * @type {Object}
 */
const CI_STATES = Object.freeze({
    ERROR   : 'red',
    EXPECTED: 'pending',
    FAILURE : 'red',
    PENDING : 'pending',
    SUCCESS : 'green'
});

/**
 * GitHub's commit-status states for {@link REVIEW_ADMISSION_CONTEXT}, preserved separately from test CI.
 * @type {Object}
 */
const ADMISSION_STATES = Object.freeze({
    ERROR   : 'error',
    EXPECTED: 'pending',
    FAILURE : 'failure',
    PENDING : 'pending',
    SUCCESS : 'success'
});

/**
 * CheckSuite conclusions that mark head CI as failing (`red`).
 * @type {Set<String>}
 */
const FAILING_CONCLUSIONS = new Set([
    'ACTION_REQUIRED',
    'CANCELLED',
    'FAILURE',
    'STALE',
    'STARTUP_FAILURE',
    'TIMED_OUT'
]);

/**
 * @summary Whether a check suite belongs to an informative `pull_request_review` workflow run.
 * @param {Object|null|undefined} suite
 * @returns {Boolean}
 * @private
 */
const isInformativeReviewSuite = suite => suite?.workflowRun?.event === 'pull_request_review';

/**
 * @summary Whether a status context entry represents {@link REVIEW_ADMISSION_CONTEXT}.
 * @param {Object|null|undefined} ctx
 * @returns {Boolean}
 * @private
 */
const isReviewAdmissionContext = ctx => Boolean(
    ctx?.context === REVIEW_ADMISSION_CONTEXT &&
    (ctx.__typename === undefined || ctx.__typename === 'StatusContext')
);

/**
 * @summary Normalize the head commit's {@link REVIEW_ADMISSION_CONTEXT} status when present.
 * @param {Object|undefined} commit Head commit node.
 * @returns {'success'|'failure'|'error'|'pending'|null}
 * @private
 */
function reviewAdmissionOf(commit) {
    const
        statusNodes = Array.isArray(commit?.status?.contexts) ? commit.status.contexts : [],
        rollupNodes = Array.isArray(commit?.statusCheckRollup?.contexts?.nodes)
            ? commit.statusCheckRollup.contexts.nodes
            : [],
        entry       = statusNodes.findLast(isReviewAdmissionContext) ?? rollupNodes.findLast(isReviewAdmissionContext),
        key         = typeof entry?.state === 'string' ? entry.state.toUpperCase() : null;

    return key ? ADMISSION_STATES[key] ?? null : null
}

/**
 * @summary Whether `checkSuites` holds multiple non-review runs of the same GitHub Actions `workflow.id`
 * on the head commit (for example when `pull_request: edited`, `reopened`, or `workflow_dispatch` supersedes
 * an earlier failed or cancelled run while `statusCheckRollup.state` retains the older suite).
 * @param {Object[]} nodes
 * @returns {Boolean}
 * @private
 */
function hasSupersededWorkflowSuite(nodes) {
    const seen = new Set();

    for (const suite of nodes) {
        if (!suite || isInformativeReviewSuite(suite)) continue;
        const workflowId = suite.workflowRun?.workflow?.id;
        if (!workflowId) continue;
        if (seen.has(workflowId)) return true;
        seen.add(workflowId)
    }

    return false
}

/**
 * @summary Derive head CI state while ignoring informative `pull_request_review` check suites,
 * {@link REVIEW_ADMISSION_CONTEXT} commit statuses, and superseded same-workflow `CheckSuite` runs on the same SHA.
 * A green `statusCheckRollup` is returned unchanged (the helper never demotes green), and the newest
 * run per `workflow.id` wins because `checkSuites(last: N)` returns nodes oldest first (an ordering
 * assumption a later query change must preserve). Falls back to `statusCheckRollup.state` when
 * check-suite pagination is incomplete, none of those rollup-divergence conditions is present,
 * or legacy inputs omit `commit.status` / suite `status`.
 * @param {Object|undefined} commit Head commit node.
 * @param {{nodes: Object[], complete: Boolean}} suites Backward-paginated `checkSuites` connection (oldest first).
 * @returns {'green'|'pending'|'red'|null}
 * @private
 */
function headCiOf(commit, suites) {
    const rollup = CI_STATES[commit?.statusCheckRollup?.state] ?? null;

    if (rollup === 'green' || !suites.complete || !commit) {
        return rollup
    }

    const
        hasStatusField     = 'status' in commit,
        statusContexts     = Array.isArray(commit.status?.contexts) ? commit.status.contexts : null,
        rollupContexts     = connectionOf(commit.statusCheckRollup?.contexts),
        hasAdmissionStatus = Boolean(statusContexts?.some(isReviewAdmissionContext)),
        hasAdmissionRollup = rollupContexts.complete && rollupContexts.nodes.some(isReviewAdmissionContext);

    if (!(hasStatusField && (suites.nodes.some(isInformativeReviewSuite) || hasAdmissionStatus || hasSupersededWorkflowSuite(suites.nodes))) &&
        !(!hasStatusField && hasAdmissionRollup)) {
        return rollup
    }

    const headSuites = suites.nodes.filter(suite => suite && !isInformativeReviewSuite(suite));

    if (headSuites.some(suite => typeof suite.status !== 'string')) {
        return rollup
    }

    const
        latestSuites = [],
        byWorkflow   = new Map();

    for (const suite of headSuites) {
        const workflowId = suite.workflowRun?.workflow?.id;
        if (workflowId) {
            byWorkflow.set(workflowId, suite);
        } else {
            latestSuites.push(suite);
        }
    }
    latestSuites.push(...byWorkflow.values());

    if (latestSuites.length === 0 && rollupContexts.complete) {
        const byRun = new Map();

        for (const item of rollupContexts.nodes) {
            if (!item || isReviewAdmissionContext(item)) continue;
            if (item.__typename === 'StatusContext' || item.context !== undefined && item.status === undefined) continue;
            if (isInformativeReviewSuite(item.checkSuite)) continue;
            if (typeof item.status !== 'string') return rollup;

            const runKey = `${item.checkSuite?.app?.id ?? ''}#${item.checkSuite?.workflowRun?.workflow?.id ?? ''}#${item.name ?? ''}`;
            byRun.set(runKey, item);
        }

        latestSuites.push(...byRun.values());
    }

    const
        nonAdmissionStatuses = statusContexts
            ? statusContexts.filter(ctx => !isReviewAdmissionContext(ctx))
            : rollupContexts.complete
                ? rollupContexts.nodes.filter(ctx => (ctx?.__typename === 'StatusContext' || ctx?.context !== undefined && ctx?.status === undefined) && !isReviewAdmissionContext(ctx))
                : null,
        contextStates = nonAdmissionStatuses
            ? nonAdmissionStatuses.map(ctx => CI_STATES[typeof ctx?.state === 'string' ? ctx.state.toUpperCase() : ctx?.state]).filter(Boolean)
            : [],
        statusCi = nonAdmissionStatuses
            ? (contextStates.includes('red') ? 'red'
                : contextStates.includes('pending') ? 'pending'
                : contextStates.includes('green') ? 'green' : null)
            : CI_STATES[commit.status?.state] ?? null;

    if (latestSuites.length === 0 && statusCi === null) return null;

    if (statusCi === 'red' || latestSuites.some(suite => suite.status === 'COMPLETED' && FAILING_CONCLUSIONS.has(suite.conclusion))) {
        return 'red'
    }

    if (statusCi === 'pending' || latestSuites.some(suite => suite.status !== 'COMPLETED')) {
        return 'pending'
    }

    return 'green'
}

/**
 * @summary Who owns a PR: the seat its body names, or why there is none. An org account without a
 * resolvable line is `unowned`, never silently its login; any other account is `outside`. The login only
 * chooses among seats that share the named name.
 * @param {Object} node A search node.
 * @param {{byName: Function, byLogin: Function}} identities
 * @returns {{kind: 'seat'|'unowned'|'outside', seat: String|null, login: String|null}}
 * @private
 */
function ownerOf(node, identities) {
    const
        login        = node.author?.login ?? null,
        knownAccount = Boolean(login && identities.byLogin(login));

    if (!knownAccount || node.author?.__typename === 'Bot') {
        return {kind: 'outside', seat: null, login}
    }

    const
        name = AUTHOR_LINE.exec(node.body ?? '')?.[1]?.trim(),
        seat = name ? identities.byName(name, login) : null;

    return seat ? {kind: 'seat', seat, login} : {kind: 'unowned', seat: null, login}
}

/**
 * @summary A reviewer (a user or a team) as a seat, a `login:` or a `team:` key.
 * @param {Object} reviewer
 * @param {{byLogin: Function}} identities
 * @returns {String|null}
 * @private
 */
function reviewerOf(reviewer, identities) {
    if (reviewer?.login) return identities.byLogin(reviewer.login) ?? `login:${reviewer.login}`;

    return reviewer?.slug ? `team:${reviewer.organization?.login}/${reviewer.slug}` : null
}

/**
 * The author associations that make a commenter a member of the repository, like a seat.
 * @type {String[]}
 */
const MEMBERS = Object.freeze(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * @summary One comment or submitted review as a turn of the PR's conversation: when, by whom, and whether a
 * member (a seat or a repository member) or someone outside took it. A review never submitted has no time and
 * is no turn.
 * @param {Object} item A comment or review node.
 * @param {String|null} at Its `createdAt` or `submittedAt`.
 * @param {{byLogin: Function}} identities
 * @returns {{at: String, by: String|null, member: Boolean, bot?: true}|null}
 * @private
 */
function turnOf(item, at, identities) {
    if (typeof at !== 'string' || !at) return null;

    const by = reviewerOf(item?.author, identities);

    return {at, by, member: Boolean(by?.startsWith('@')) || MEMBERS.includes(item?.authorAssociation),
        ...(item?.author?.__typename === 'Bot' ? {bot: true} : {})}
}

/**
 * @summary A connection's nodes, and whether they are all of them. A connection without its
 * `pageInfo`, or one with a remaining page along its pagination direction, is known only as far as it shows.
 * @param {Object} connection
 * @param {'hasNextPage'|'hasPreviousPage'} [boundary='hasNextPage']
 * @returns {{nodes: Object[], complete: Boolean}}
 * @private
 */
function connectionOf(connection, boundary = 'hasNextPage') {
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : null;

    return {nodes: nodes ?? [], complete: Boolean(nodes) && connection.pageInfo?.[boundary] === false}
}

/**
 * @summary One open search node as a snapshot row.
 * @param {Object} node A `PullRequest` node from the open-work search.
 * @param {{byName: Function, byLogin: Function}} identities Resolve a social name or a login to a seat.
 * @param {Object} [source] Acquisition identity; absent for legacy inputs.
 * @param {String} [source.apiBase] Provider API identity from the existing reader.
 * @returns {Object} `{key, repo, number, title, head, ci, verdict, mergeable, mergeState, draft, owner,
 *     disclosedFamilies, requested, reviews, opinions, reviewRecords, ciRepairEvidence, ciRepairClassification,
 *     ciRepairRead, ciRepairIncompleteReads, turns, blockedTargets, targetsComplete,
 *     requestsComplete, opinionsComplete, partial}`. `blockedTargets` are the issues it closes that GitHub counts an
 *     open blocker for; `targetsComplete` is false when that list or a count went unread, a node without the list
 *     included, so no merge is certified.
 *     `title` is the forge's prose with whitespace collapsed, or `null`; it names the PR and is never a
 *     transition. `disclosedFamilies` are the model families an outside PR names in its body or in any commit's
 *     trailer, and empty for every other PR; an outside PR with commits past the read is `partial`, since an unread
 *     commit may name another family. Optional original review records keep their own history coverage, and `turns`
 *     holds only the conversation's latest page; neither changes current-work completeness. CI repair records
 *     retain original comment and current-head check facts independently; unread checks cannot authorize content ownership.
 */
export function normalizePullRequest(node, identities, {apiBase = null} = {}) {
    const
        repo      = node.repository?.nameWithOwner ?? null,
        owner     = ownerOf(node, identities),
        commit    = node.commits?.nodes?.[0]?.commit,
        head      = node.headRefOid ?? commit?.oid ?? null,
        requests  = connectionOf(node.reviewRequests),
        reviews   = connectionOf(node.latestReviews),
        opinions  = connectionOf(node.latestOpinionatedReviews),
        suites    = commit?.checkSuites === undefined ? {nodes: [], complete: true} : connectionOf(commit.checkSuites, 'hasPreviousPage'),
        messages  = node.commitMessages === undefined ? {nodes: [], complete: true} : connectionOf(node.commitMessages),
        outside   = owner.kind === 'outside',
        requested = requests.nodes.map(item => reviewerOf(item?.requestedReviewer, identities)),
        targets   = connectionOf(node.closingIssuesReferences),
        targetOf  = issue => issue?.repository?.nameWithOwner && Number.isInteger(issue.number) &&
            Number.isInteger(issue.issueDependenciesSummary?.blockedBy) ? `${issue.repository.nameWithOwner}#${issue.number}` : null,
        // whether each review judged the current head, and whether a bot wrote it
        judged    = item => ({reviewer: reviewerOf(item?.author, identities), state: item?.state ?? null, onHead: item?.commit?.oid === head,
            ...(item?.author?.__typename === 'Bot' ? {bot: true} : {})}),
        // each reviewer's latest review (a comment included), and their standing approval or change request, with
        // when it was given: the merge line orders approved PRs by it
        reviewed  = reviews.nodes.map(judged),
        opined    = opinions.nodes.map(item => ({...judged(item), at: item?.submittedAt ?? null})),
        // the conversation's latest comments and submitted reviews, oldest first
        turns     = [...connectionOf(node.comments).nodes.map(item => turnOf(item, item?.createdAt, identities)),
            ...connectionOf(node.reviews).nodes.map(item => turnOf(item, item?.submittedAt, identities))]
            .filter(Boolean).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0),
        // an item naming no reviewer is unknown, so its list is known only as far as it resolves
        requestsComplete = requests.complete && requested.every(Boolean),
        reviewsComplete  = reviews.complete && reviewed.every(review => review.reviewer),
        opinionsComplete = opinions.complete && opined.every(opinion => opinion.reviewer),
        targetsComplete  = targets.complete && targets.nodes.every(targetOf),
        blockedTargets   = targets.nodes.filter(issue => targetOf(issue) && issue.issueDependenciesSummary.blockedBy > 0).map(targetOf).sort(),
        runApproval      = suites.nodes.some(suite => suite?.conclusion === 'ACTION_REQUIRED' && !isInformativeReviewSuite(suite))
            ? 'action_required' : null,
        ciRepair         = outside ? normalizeCiRepair(node, identities, {apiBase}) : null;

    return {
        key              : `${repo}#${node.number}`,
        repo,
        number           : node.number,
        title            : typeof node.title === 'string' ? node.title.replace(/\s+/g, ' ').trim() || null : null,
        head,
        base             : node.baseRefName ?? null,
        ci               : headCiOf(commit, suites),
        reviewAdmission  : reviewAdmissionOf(commit),
        verdict          : node.reviewDecision ?? null,
        mergeable        : node.mergeable ?? null,
        mergeState       : node.mergeStateStatus ?? null,
        draft            : Boolean(node.isDraft),
        authorAssociation: node.authorAssociation ?? null,
        bot              : node.author?.__typename === 'Bot',
        runApproval,
        owner,
        disclosedFamilies: outside ? disclosedFamiliesOf({
            body          : node.body ?? '',
            commitMessages: messages.nodes.map(item => item?.commit?.message)
        }) : [],
        requested    : requested.filter(Boolean).sort(),
        reviews      : reviewed.filter(review => review.reviewer),
        opinions     : opined.filter(opinion => opinion.reviewer),
        reviewRecords: normalizeReviewRecords(node, apiBase),
        ...(outside ? {...ciRepair, ciRepairIncompleteReads: [
            ciRepair.ciRepairRead?.coverage !== 'complete' && 'comments',
            (!reviewsComplete || !opinionsComplete) && 'reviews',
            !requestsComplete && 'review-requests',
            !messages.complete && 'commits',
            !suites.complete && 'check-suites',
            !ciRepair.ciRepairEvidence && 'checks'
        ].filter(Boolean)} : {}),
        turns,
        blockedTargets,
        targetsComplete,
        requestsComplete,
        opinionsComplete,
        partial      : !requestsComplete || !reviewsComplete || !opinionsComplete || !suites.complete || outside && !messages.complete
    }
}

/**
 * @summary One merged or closed search node as a terminal row.
 * @param {Object} node A `PullRequest` node from the terminal search.
 * @param {{byName: Function, byLogin: Function}} identities
 * @returns {Object} `{key, repo, number, head, owner, state: 'MERGED'|'CLOSED', at}`.
 */
export function normalizeTerminal(node, identities) {
    const repo = node.repository?.nameWithOwner ?? null;

    return {
        key   : `${repo}#${node.number}`,
        repo,
        number: node.number,
        head  : node.headRefOid ?? null,
        owner : ownerOf(node, identities),
        state : node.state,
        at    : node.mergedAt ?? node.closedAt ?? null
    }
}

/**
 * @summary What one merge unblocked: each open issue it closed the last open blocker of, with the seats among
 * its assignees. A blocker that is another issue this merge closes counts as closed, because GitHub closes it
 * just after the merge. An issue with no assignee seat names nobody to wake, so it is left out.
 *
 * The answer counts only when every dependency list in it is whole: a closing, dependent or blocker list past
 * its page makes the read incomplete, because an unread dependent would never be woken and an unread blocker
 * may still be open.
 * @param {Object} pullRequest The `OPEN_WORK_UNBLOCKED` answer's pull request.
 * @param {{byLogin: Function}} identities
 * @returns {{issue: String, seats: String[]}[]|null} Each issue as `owner/name#N`, once; null for an incomplete read.
 */
export function normalizeUnblocked(pullRequest, identities) {
    const
        whole = list => Array.isArray(list?.nodes) && list.totalCount === list.nodes.length,
        keyOf = node => typeof node?.repository?.nameWithOwner === 'string' && Number.isInteger(node.number)
            ? `${node.repository.nameWithOwner}#${node.number}` : null,
        refs    = pullRequest?.closingIssuesReferences,
        closers = refs?.nodes ?? [],
        closing = new Set(closers.map(keyOf)),
        issues  = new Map();

    if (!whole(refs) || !closers.every(closer => whole(closer?.blocking))) return null;

    for (const blocked of closers.flatMap(closer => closer.blocking.nodes)) {
        const
            issue    = keyOf(blocked),
            blockers = blocked?.blockedBy;

        if (blocked?.state === 'OPEN' && !whole(blockers)) return null;

        if (!issue || issues.has(issue) || blocked.state !== 'OPEN' ||
            blockers.nodes.some(blocker => blocker?.state !== 'CLOSED' && !closing.has(keyOf(blocker)))) continue;

        const seats = [...new Set((blocked.assignees?.nodes ?? [])
            .map(user => user?.login ? identities.byLogin(user.login) : null)
            .filter(seat => typeof seat === 'string' && seat.startsWith('@')))];

        seats.length && issues.set(issue, seats)
    }

    return [...issues].map(([issue, seats]) => ({issue, seats}))
}

/**
 * @summary Group closed issue search nodes by watched parent issue to observe parent closeouts and open-sub clearings.
 * An `OPEN` watched parent with `total > 0 && completed === total` resolves each agent seat among its assignees (or
 * its author when unassigned) and takes the latest completing sub's `closedAt` as the episode; with no agent seat it is
 * omitted. A watched parent observed with `completed < total` (or non-`OPEN`) records `'open-sub'` so held closeouts clear.
 * @param {Object[]} nodes `Issue` nodes from `OPEN_WORK_CLOSEOUT`.
 * @param {{byLogin: Function}} identities
 * @param {Iterable<String>|null} [watchedRepos=null] Watched `owner/name` slugs; null accepts every repository.
 * @returns {Object[]} Normalized parent observations `{key, repo, number, status: 'closeout'|'open-sub', at?, seats?, role?}`.
 */
export function normalizeCloseout(nodes, identities, watchedRepos = null) {
    const
        watched = watchedRepos ? new Set(watchedRepos) : null,
        parents = new Map(),
        later   = (left, right) => {
            if (!left) return right;
            const l = Date.parse(left), r = Date.parse(right);
            return r > l || r === l && right > left ? right : left
        };

    for (const node of Array.isArray(nodes) ? nodes : []) {
        const
            parent    = node?.parent,
            repo      = parent?.repository?.nameWithOwner ?? null,
            number    = parent?.number,
            total     = parent?.subIssuesSummary?.total,
            completed = parent?.subIssuesSummary?.completed;

        if (typeof repo !== 'string' || !repo || watched && !watched.has(repo) ||
            !Number.isInteger(number) || number < 1 ||
            !Number.isInteger(total) || total < 1 || !Number.isInteger(completed) || completed < 0) continue;

        const key = `${repo}#${number}`;

        if (parent.state !== 'OPEN' || completed < total) {
            parents.set(key, {key, repo, number, status: 'open-sub'});
            continue
        }

        if (completed !== total || typeof node.closedAt !== 'string' || !node.closedAt || !Number.isFinite(Date.parse(node.closedAt))) continue;

        const prior = parents.get(key);
        if (prior?.status === 'open-sub') continue;

        const
            assigned   = (parent.assignees?.nodes ?? []).filter(user => typeof user?.login === 'string' && user.login),
            candidates = assigned.length ? assigned.map(user => user.login)
                : typeof parent.author?.login === 'string' && parent.author.login ? [parent.author.login] : [],
            seats      = [...new Set(candidates
                .map(login => identities.byLogin(login))
                .filter(seat => typeof seat === 'string' && seat.startsWith('@')))];

        if (!seats.length) continue;

        parents.set(key, {
            key,
            repo,
            number,
            status: 'closeout',
            at    : later(prior?.at ?? null, node.closedAt),
            seats,
            role  : assigned.length ? 'assignee' : 'author'
        })
    }

    return [...parents.values()]
}

/**
 * @summary One observed change, identified by the observation itself.
 * @param {Object} row The row after the change (its head names the episode's commit).
 * @param {String} kind
 * @param {*} from
 * @param {*} to
 * @param {String} pulse The observing pulse.
 * @returns {Object}
 * @private
 */
function transition(row, kind, from, to, pulse) {
    return {
        id    : `${row.key}@${row.head}:${kind}:${from}->${to}#${pulse}`,
        key   : row.key,
        repo  : row.repo,
        number: row.number,
        head  : row.head,
        owner : row.owner,
        kind,
        from,
        to,
        pulse
    }
}

/**
 * @summary What a push or a verdict change carries beside from and to: the verdict a push landed on, and
 * the reviewers observed moving the decision. A reviewer moved it when their standing opinion became the
 * new decision, or the same opinion moved onto the current head (a re-approval). Both observations must
 * hold every standing opinion; otherwise, like a dismissal or a branch rule, the change names no one.
 * @param {String} kind
 * @param {Object} before
 * @param {Object} after
 * @returns {Object}
 * @private
 */
function contextOf(kind, before, after) {
    if (kind === 'head') return {verdict: before.verdict};

    if (kind !== 'verdict') return {};

    if (before.opinionsComplete !== true || after.opinionsComplete !== true) return {by: []};

    const moved = ({reviewer, state, onHead}) => {
        const was = before.opinions.find(opinion => opinion.reviewer === reviewer);

        return state === after.verdict && (was?.state !== state || onHead && !(was.onHead && before.head === after.head))
    };

    return {by: after.opinions.filter(moved).map(({reviewer}) => reviewer)}
}

/**
 * @summary The transitions between two observations of one open PR. A removal needs a complete list.
 * @param {Object} before
 * @param {Object} after
 * @param {String} pulse
 * @returns {Object[]}
 * @private
 */
function changesOf(before, after, pulse) {
    const changes = [];

    for (const kind of ['head', 'ci', 'verdict']) {
        before[kind] !== after[kind] && changes.push({...transition(after, kind, before[kind], after[kind], pulse), ...contextOf(kind, before, after)})
    }

    after.requested.filter(seat => !before.requested.includes(seat))
        .forEach(seat => changes.push(transition(after, 'review-requested', null, seat, pulse)));

    if (after.requestsComplete) {
        before.requested.filter(seat => !after.requested.includes(seat))
            .forEach(seat => changes.push(transition(after, 'review-removed', seat, null, pulse)))
    }

    return changes
}

/**
 * @summary The transitions of a row first seen after the baseline.
 * @param {Object} row
 * @param {Boolean} previousComplete Whether the previous open read covered every page.
 * @param {String} pulse
 * @returns {Object[]}
 * @private
 */
function arrivalOf(row, previousComplete, pulse) {
    return [
        ...previousComplete ? [transition(row, 'opened', null, 'open', pulse)] : [],
        ...row.requested.map(seat => transition(row, 'review-requested', null, seat, pulse))
    ]
}

/**
 * @summary Canonical lowercase GitHub login key for search coverage matching.
 * @param {*} login
 * @returns {String|null}
 * @private
 */
const loginKey = login => typeof login === 'string' && login ? login.toLowerCase() : null;

/**
 * @summary Whether an incomplete pulse read could have covered a row through its author-login query
 * (seat-author or outside) or through a missed reviewer's held-work query.
 * @param {Object} row
 * @param {Object} [coverage]
 * @param {Object|null} [coverage.searches]
 * @param {String[]} [coverage.missed]
 * @returns {Boolean}
 * @private
 */
function missedBy(row, {searches = null, missed = []} = {}) {
    if (searches && typeof searches === 'object') {
        const
            seatLogins     = (searches.seatLogins ?? []).map(loginKey).filter(Boolean),
            authoredLogins = (searches.authoredLogins ?? []).map(loginKey).filter(Boolean),
            authorLogin    = loginKey(row.owner?.login),
            authorMissed   = authorLogin && seatLogins.includes(authorLogin)
                ? !authoredLogins.includes(authorLogin)
                : searches.outsideComplete !== true,
            missedReviewers = Array.isArray(searches.missedReviewers) ? searches.missedReviewers : [],
            reviewerMissed  = missedReviewers.length > 0 && (
                !row.requestsComplete ||
                row.requested.some(reviewer => missedReviewers.includes(reviewer))
            );

        return authorMissed || reviewerMissed
    }

    const missedSeats = missed.filter(seat => seat !== 'outside');

    return missed.length > 0 && (
        row.owner?.kind === 'outside' && missed.includes('outside') ||
        missedSeats.length > 0 && !row.requestsComplete ||
        missed.includes(`@${row.owner?.login}`) ||
        row.requested.some(seat => missed.includes(seat))
    )
}

/**
 * @summary Reduce one pulse: the next snapshot and the transitions observed since the previous one.
 *
 * The first pulse (no previous snapshot) is the baseline and records no transition. `closed` maps a
 * PR to the close it last recorded, so a re-read of that close records nothing, while a PR observed
 * open again retires its marker and its next close is a new episode. A PR absent from an open read
 * that covered every page leaves the snapshot when the terminal read was complete too, as `vanished`
 * unless that read closed it; while either was partial, or a search that could have read it missed, it is
 * carried forward with its own `observedAt`, because missing evidence is not a close.
 * @param {Object} pulse
 * @param {Object|null} pulse.previous `{rows: {[key]: row}, closed: {[key]: at}, complete, missed, searches?}`, or null on the first pulse.
 * @param {{rows: Object[], complete: Boolean, missed?: String[], searches?: Object}} pulse.observed The open rows this pulse read;
 *     `complete` when the seats that owe coverage read every page, `missed` the other seats whose read did not,
 *     `searches` the actual GitHub author-login and held-reviewer search coverage.
 * @param {{rows: Object[], complete: Boolean}} pulse.terminal Terminal rows ({@link normalizeTerminal}) read since `since`.
 * @param {String|null} pulse.since The watermark: where the terminal read began, ISO.
 * @param {String} pulse.id This pulse's identity, its time.
 * @param {{byLogin: Function}} [pulse.identities] Current identity resolver for retained maintainer decisions.
 * @returns {{rows: Object, closed: Object, complete: Boolean, missed: String[], searches?: Object, transitions: Object[], vanished: String[]}}
 */
export function reduceOpenWork({previous, observed, terminal, closeout = null, since, id, identities}) {
    const
        rows                = {},
        closed              = Object.fromEntries(Object.entries(previous?.closed ?? {}).filter(([, at]) => !since || at >= since)),
        closeoutSince       = closeout?.since !== undefined ? closeout.since : since,
        closeouts           = Object.fromEntries(Object.entries(previous?.closeouts ?? {}).filter(([, at]) => !closeoutSince || at >= closeoutSince)),
        openSubs            = {...(previous?.openSubs ?? {})},
        complete            = observed.complete,
        missed              = observed.missed ?? [],
        searches            = observed.searches ?? null,
        hasPreviousCoverage = Boolean(previous) && (!searches || Boolean(previous.searches)),
        transitions         = [],
        vanished            = [];

    for (const row of observed.rows) {
        const
            before = previous?.rows[row.key],
            merged = before && !row.requestsComplete ? {...row, requested: [...new Set([...before.requested, ...row.requested])].sort()} : row;

        rows[row.key] = {...merged,
            reviewRecords: retainReviewWitnesses(row.reviewRecords, before?.reviewRecords),
            ...(merged.owner?.kind === 'outside' ? {
                ciRepairClassification: retainCiRepairClassification(merged, before, identities),
                ciRepairRead          : merged.ciRepairRead ? {...merged.ciRepairRead,
                    touch: retainCiRepairTouch(merged, before, identities)} : null
            } : {}),
            observedAt: id};
        delete closed[row.key];

        previous && transitions.push(...before
            ? changesOf(before, merged, id)
            : arrivalOf(merged, hasPreviousCoverage && previous.complete !== false && !missedBy(merged, previous), id))
    }

    if (!previous) return {rows, closed, complete, missed, ...(searches ? {searches} : {}), transitions, vanished};

    for (const row of terminal.rows) {
        if (!rows[row.key] && closed[row.key] !== row.at && (!since || row.at >= since)) {
            const before = previous.rows[row.key] ?? row;

            closed[row.key] = row.at;
            transitions.push(transition({...before, head: row.head ?? before.head}, row.state === 'MERGED' ? 'merged' : 'closed', 'open', row.state.toLowerCase(), id))
        }
    }

    for (const row of closeout?.rows ?? []) {
        if (row.status === 'open-sub') {
            delete closeouts[row.key];
            openSubs[row.key] = id;
            continue
        }

        if (row.status === 'closeout' && closeouts[row.key] !== row.at && (!closeoutSince || row.at >= closeoutSince)) {
            delete openSubs[row.key];
            closeouts[row.key] = row.at;
            transitions.push({
                id     : `${row.key}:closeout:${row.at}#${id}`,
                key    : row.key,
                repo   : row.repo,
                number : row.number,
                head   : null,
                owner  : {kind: 'seat', seat: row.seats[0], login: null},
                seats  : row.seats,
                role   : row.role ?? 'assignee',
                episode: row.at,
                kind   : 'closeout',
                from   : 'open-subs',
                to     : 'all-subs-closed',
                pulse  : id
            })
        }
    }

    for (const [key, before] of Object.entries(previous.rows)) {
        if (!rows[key] && !closed[key]) {
            const terminalIncomplete = Boolean(searches?.terminalIncompleteLogins?.some(login => loginKey(login) === loginKey(before.owner?.login)));
            complete && terminal.complete && !terminalIncomplete && !missedBy(before, {searches, missed}) ? vanished.push(key) : rows[key] = before
        }
    }

    return {
        rows,
        closed,
        ...(Object.keys(closeouts).length ? {closeouts} : {}),
        ...(Object.keys(openSubs).length ? {openSubs} : {}),
        complete,
        missed,
        ...(searches ? {searches} : {}),
        transitions,
        vanished
    }
}
