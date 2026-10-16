/**
 * @module ai/services/fleet/openWorkReviewRecords
 * @summary Original provider review facts beside current-work observations. Current standing opinions
 * own approval eligibility; a bounded timeline owns request history. A retained request proves one
 * exact approval's association, never completeness across windows. This module has no I/O or clock.
 */
const LIMIT = 20;
const KINDS = {ReviewRequestedEvent: 'requested', ReviewRequestRemovedEvent: 'removed', ReviewDismissedEvent: 'dismissed'};

/** @summary An original timestamp is valid without replacing or normalizing its bytes. @param {*} value @returns {Boolean} */
function dated(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
}

/** @summary Preserve provider identity without resolving a mutable login to a seat. @param {Object} value @returns {Object|null} */
function identity(value) {
    if (typeof value?.id !== 'string' || !value.id || !value.__typename) return null;

    return value.__typename === 'Team'
        ? {id: value.id, kind: 'Team', slug: value.slug ?? null, organization: value.organization?.login ?? null}
        : {id: value.id, kind: value.__typename, login: value.login ?? null}
}

/** @summary One provider event; unavailable participants stay null rather than being inferred. @param {Object} value @returns {Object|null} */
function eventOf(value) {
    const kind = Object.hasOwn(KINDS, value?.__typename) ? KINDS[value.__typename] : null, reviewer = identity(value?.requestedReviewer);

    if (!kind || typeof value.id !== 'string' || !value.id || !dated(value.createdAt) || (kind !== 'dismissed' && !reviewer)) return null;
    if (kind === 'dismissed' && !value.review?.id) return null;

    return {kind, id: value.id, at: value.createdAt, actor: identity(value.actor),
        ...kind === 'dismissed' ? {reviewId: value.review.id} : {reviewer, ...kind === 'requested' ? {head: null} : {}}}
}

/** @summary One observed standing opinion with enough original metadata to identify an approval. @param {Object} value @param {String} head @returns {Object|null} */
function opinionOf(value, head) {
    const reviewer = identity(value?.author);

    return typeof value?.id === 'string' && value.id && dated(value.submittedAt) && reviewer && typeof value.commit?.oid === 'string' && value.commit.oid &&
        ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(value.state)
        ? {id: value.id, at: value.submittedAt, reviewer, commit: value.commit.oid, onHead: value.commit.oid === head, state: value.state}
        : null
}

/**
 * @summary Match only the same provider reviewer. A suffix covers the interval after a visible
 * request; an exhausted history can prove absence. Approval is outside this filtered timeline, so
 * equal-second request/removal times cannot be ordered against it by timeline position.
 * @param {Object} approval
 * @param {Object[]} events Chronological provider timeline items.
 * @param {String} coverage Complete, partial or unavailable history.
 * @returns {Object} Original request and its association status.
 */
function association(approval, events, coverage) {
    if (coverage === 'unavailable') return {request: null, requestState: 'unknown'};

    const same = events.filter(item => item.reviewer?.id === approval.reviewer.id && Date.parse(item.at) <= Date.parse(approval.at));

    if (same.some(item => Date.parse(item.at) === Date.parse(approval.at))) return {request: null, requestState: 'ambiguous'};

    const latest = same.at(-1);

    return latest
        ? latest.kind === 'requested' ? {request: latest, requestState: 'paired'} : {request: null, requestState: 'removed'}
        : {request: null, requestState: coverage === 'complete' ? 'absent' : 'unknown'}
}

/**
 * @summary Normalize the current bounded source facts. History coverage is deliberately independent
 * of current-work row.partial. Missing legacy PR/provider identity has no packet; malformed history
 * cannot prove an absent request. Only currently returned standing approvals enter the packet.
 * @param {Object} node Open-work GraphQL PR node.
 * @param {String} apiBase Existing acquisition provider identity.
 * @returns {Object|null} Source scope, timeline coverage, opinion coverage, events and approvals.
 */
export function normalizeReviewRecords(node, apiBase) {
    if (!node?.id || !node.repository?.nameWithOwner || !Number.isInteger(node.number) || node.number < 1 || typeof apiBase !== 'string' || !apiBase) return null;

    const
        timeline = node.timelineItems,
        raw = Array.isArray(timeline?.nodes) ? timeline.nodes.slice(-LIMIT) : [],
        normalized = raw.map(eventOf),
        events = normalized.filter(Boolean),
        valid = Array.isArray(timeline?.nodes) && normalized.every(Boolean) && new Set(events.map(item => item.id)).size === events.length &&
            events.every((item, i) => !i || Date.parse(item.at) >= Date.parse(events[i - 1].at)) &&
            typeof timeline.pageInfo?.hasPreviousPage === 'boolean' && timeline.pageInfo?.hasNextPage === false,
        historyCoverage = !valid ? 'unavailable' : timeline.pageInfo.hasPreviousPage || timeline.nodes.length > LIMIT ? 'partial' : 'complete',
        connection = node.latestOpinionatedReviews,
        opinions = (Array.isArray(connection?.nodes) ? connection.nodes.slice(0, LIMIT) : []).map(value => opinionOf(value, node.headRefOid)),
        opinionsComplete = Array.isArray(connection?.nodes) && connection.nodes.length <= LIMIT && connection.pageInfo?.hasNextPage === false && opinions.every(Boolean),
        approvals = opinions.filter(item => item?.state === 'APPROVED' && !events.some(event => event.kind === 'dismissed' && event.reviewId === item.id))
            .map(({state, ...approval}) => ({...approval, ...association(approval, events, historyCoverage)}));

    return {source: {apiBase, repo: node.repository.nameWithOwner, prId: node.id, number: node.number}, historyCoverage, opinionsComplete, events, approvals}
}

/**
 * @summary Retain at most one proved request per identical current approval when a later bounded
 * suffix no longer contains it. A new opinion, changed provider/PR, conflicting interval or unavailable
 * instrument cannot inherit a witness. Current history coverage is never upgraded by the old pair.
 * @param {Object|null} current Newly normalized packet.
 * @param {Object|null} previous Packet from the prior held row.
 * @returns {Object|null}
 */
export function retainReviewWitnesses(current, previous) {
    if (!current || !previous || current.historyCoverage !== 'partial' ||
        !['apiBase', 'repo', 'prId', 'number'].every(key => current.source[key] === previous.source?.[key])) return current;

    const approvals = current.approvals.map(approval => {
        if (approval.requestState !== 'unknown') return approval;

        const old = previous.approvals?.find(item => item.id === approval.id && item.at === approval.at && item.commit === approval.commit && item.reviewer?.id === approval.reviewer.id);
        const witness = old?.requestState === 'paired' && old.request;

        if (!witness || witness.kind !== 'requested' || !dated(witness.at) || witness.reviewer?.id !== approval.reviewer.id || Date.parse(witness.at) >= Date.parse(approval.at)) return approval;
        if (current.events.some(item => item.reviewer?.id === approval.reviewer.id && item.id !== witness.id &&
            Date.parse(item.at) >= Date.parse(witness.at) && Date.parse(item.at) <= Date.parse(approval.at))) return approval;

        return {...approval, request: witness, requestState: 'paired'}
    });

    return {...current, approvals}
}
