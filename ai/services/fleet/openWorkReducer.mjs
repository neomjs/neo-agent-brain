/**
 * @module ai/services/fleet/openWorkReducer
 * @summary The open-work producer's pure half: GitHub's open pull requests become one normalized
 * snapshot, and two snapshots become the transitions observed between them. No fetch, no clock and
 * no mailbox; the producer owns the reads, this module owns their meaning.
 *
 * A transition's identity is its observation: the PR, its head, the kind of change, from and to,
 * and the pulse that saw it. So a head that goes red, then green, then red again yields two red
 * episodes, and an identical poll yields nothing. A merge or a close comes only from the terminal
 * read, once per close (its time is the episode); a PR leaving the open snapshot is never one.
 *
 * Coverage is part of the baseline. A truncated or missing review-request list adds what it shows to
 * the last complete list and removes nothing, and a row no pulse observed keeps the time it was last
 * seen, so a later partial pulse never makes it look fresh. A row first seen after a read that missed
 * pages may only have been unread, so it is no `opened`; the reviews already requested on it are
 * reported either way. A row that leaves complete reads with no terminal row is `vanished`: absence is
 * never a close, and never silent. A seat that owes no coverage can still miss its read: the rows it
 * would have read carry, and a row first seen after that miss is no `opened`.
 */

/**
 * The mandatory PR-body line naming the authoring seat: `Authored by <Social Name> (…)`.
 * @type {RegExp}
 */
const AUTHOR_LINE = /^Authored by\s+([^(\n.]+?)\s*(?:\(|\.|$)/m;

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
 * @summary Who owns a PR: the seat its body names, or why there is none. An org account without a
 * resolvable line is `unowned`, never silently its login; any other account is `outside`.
 * @param {Object} node A search node.
 * @param {{byName: Function, byLogin: Function}} identities
 * @returns {{kind: 'seat'|'unowned'|'outside', seat: String|null, login: String|null}}
 * @private
 */
function ownerOf(node, identities) {
    const
        login = node.author?.login ?? null,
        name  = AUTHOR_LINE.exec(node.body ?? '')?.[1]?.trim(),
        seat  = name ? identities.byName(name) : null;

    if (seat) return {kind: 'seat', seat, login};

    return {kind: login && identities.byLogin(login) ? 'unowned' : 'outside', seat: null, login}
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
 * @summary A connection's nodes, and whether they are all of them. A connection without its
 * `pageInfo`, or one with a next page, is known only as far as it shows.
 * @param {Object} connection
 * @returns {{nodes: Object[], complete: Boolean}}
 * @private
 */
function connectionOf(connection) {
    const nodes = Array.isArray(connection?.nodes) ? connection.nodes : null;

    return {nodes: nodes ?? [], complete: Boolean(nodes) && connection.pageInfo?.hasNextPage === false}
}

/**
 * @summary One open search node as a snapshot row.
 * @param {Object} node A `PullRequest` node from the open-work search.
 * @param {{byName: Function, byLogin: Function}} identities Resolve a social name or a login to a seat.
 * @returns {Object} `{key, repo, number, title, head, ci, verdict, mergeable, draft, owner, requested,
 *     reviews, opinions, requestsComplete, opinionsComplete, partial}`. `title` is the forge's prose with its
 *     whitespace collapsed, or `null`; it names the PR and is never a transition.
 */
export function normalizePullRequest(node, identities) {
    const
        repo      = node.repository?.nameWithOwner ?? null,
        commit    = node.commits?.nodes?.[0]?.commit,
        head      = node.headRefOid ?? commit?.oid ?? null,
        requests  = connectionOf(node.reviewRequests),
        reviews   = connectionOf(node.latestReviews),
        opinions  = connectionOf(node.latestOpinionatedReviews),
        requested = requests.nodes.map(item => reviewerOf(item?.requestedReviewer, identities)),
        // whether each review judged the current head
        judged    = item => ({reviewer: reviewerOf(item?.author, identities), state: item?.state ?? null, onHead: item?.commit?.oid === head}),
        // each reviewer's latest review (a comment included), and their standing approval or change request
        reviewed  = reviews.nodes.map(judged),
        opined    = opinions.nodes.map(judged),
        // an item naming no reviewer is unknown, so its list is known only as far as it resolves
        requestsComplete = requests.complete && requested.every(Boolean),
        reviewsComplete  = reviews.complete && reviewed.every(review => review.reviewer),
        opinionsComplete = opinions.complete && opined.every(opinion => opinion.reviewer);

    return {
        key      : `${repo}#${node.number}`,
        repo,
        number   : node.number,
        title    : typeof node.title === 'string' ? node.title.replace(/\s+/g, ' ').trim() || null : null,
        head,
        ci       : CI_STATES[commit?.statusCheckRollup?.state] ?? null,
        verdict  : node.reviewDecision ?? null,
        mergeable: node.mergeable ?? null,
        draft    : Boolean(node.isDraft),
        owner    : ownerOf(node, identities),
        requested: requested.filter(Boolean).sort(),
        reviews  : reviewed.filter(review => review.reviewer),
        opinions : opined.filter(opinion => opinion.reviewer),
        requestsComplete,
        opinionsComplete,
        partial  : !requestsComplete || !reviewsComplete || !opinionsComplete
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
 * @summary Whether one of the seats could have read a row: its author, a seat holding a review request on it, or
 * any of them while its request list is incomplete, since an unseen request may be theirs.
 * @param {Object} row
 * @param {String[]} seats
 * @returns {Boolean}
 * @private
 */
function readBy(row, seats) {
    return seats.length > 0 && (!row.requestsComplete || seats.includes(`@${row.owner?.login}`) || row.requested.some(seat => seats.includes(seat)))
}

/**
 * @summary Reduce one pulse: the next snapshot and the transitions observed since the previous one.
 *
 * The first pulse (no previous snapshot) is the baseline and records no transition. `closed` maps a
 * PR to the close it last recorded, so a re-read of that close records nothing, while a PR observed
 * open again retires its marker and its next close is a new episode. A PR absent from an open read
 * that covered every page leaves the snapshot when the terminal read was complete too, as `vanished`
 * unless that read closed it; while either was partial, or a seat that could have read it missed, it is
 * carried forward with its own `observedAt`, because missing evidence is not a close.
 * @param {Object} pulse
 * @param {Object|null} pulse.previous `{rows: {[key]: row}, closed: {[key]: at}, complete, missed}`, or null on the first pulse.
 * @param {{rows: Object[], complete: Boolean, missed: String[]}} pulse.observed The open rows this pulse read;
 *     `complete` when the seats that owe coverage read every page, `missed` the other seats whose read did not.
 * @param {{rows: Object[], complete: Boolean}} pulse.terminal Terminal rows ({@link normalizeTerminal}) read since `since`.
 * @param {String|null} pulse.since The watermark: where the terminal read began, ISO.
 * @param {String} pulse.id This pulse's identity, its time.
 * @returns {{rows: Object, closed: Object, complete: Boolean, missed: String[], transitions: Object[], vanished: String[]}}
 */
export function reduceOpenWork({previous, observed, terminal, since, id}) {
    const
        rows        = {},
        closed      = Object.fromEntries(Object.entries(previous?.closed ?? {}).filter(([, at]) => !since || at >= since)),
        complete    = observed.complete,
        missed      = observed.missed ?? [],
        transitions = [],
        vanished    = [];

    for (const row of observed.rows) {
        const
            before = previous?.rows[row.key],
            merged = before && !row.requestsComplete ? {...row, requested: [...new Set([...before.requested, ...row.requested])].sort()} : row;

        rows[row.key] = {...merged, observedAt: id};
        delete closed[row.key];

        previous && transitions.push(...before ? changesOf(before, merged, id) : arrivalOf(merged, previous.complete !== false && !readBy(merged, previous.missed ?? []), id))
    }

    if (!previous) return {rows, closed, complete, missed, transitions, vanished};

    for (const row of terminal.rows) {
        if (!rows[row.key] && closed[row.key] !== row.at && (!since || row.at >= since)) {
            const before = previous.rows[row.key] ?? row;

            closed[row.key] = row.at;
            transitions.push(transition({...before, head: row.head ?? before.head}, row.state === 'MERGED' ? 'merged' : 'closed', 'open', row.state.toLowerCase(), id))
        }
    }

    for (const [key, before] of Object.entries(previous.rows)) {
        if (!rows[key] && !closed[key]) {
            complete && terminal.complete && !readBy(before, missed) ? vanished.push(key) : rows[key] = before
        }
    }

    return {rows, closed, complete, missed, transitions, vanished}
}
