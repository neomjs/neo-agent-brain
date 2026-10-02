/**
 * @module ai/services/fleet/openWorkReducer
 * @summary The open-work producer's pure half: GitHub's open pull requests become one normalized
 * snapshot, and two snapshots become the transitions observed between them. No fetch, no clock and
 * no mailbox; the producer owns the reads, this module owns their meaning.
 *
 * A transition's identity is its observation: the PR, its head, the kind of change, from and to,
 * and the pulse that saw it. So a head that goes red, then green, then red again yields two red
 * episodes, and an identical poll yields nothing. A merge or a close is known only from the
 * terminal query and only when it happened since the last fully covered pulse; a PR leaving the
 * open snapshot is never read as either.
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
 * @summary One open search node as a snapshot row.
 * @param {Object} node A `PullRequest` node from the open-work search.
 * @param {{byName: Function, byLogin: Function}} identities Resolve a social name or a login to a seat.
 * @returns {Object} `{key, repo, number, head, ci, verdict, mergeable, draft, owner, requested, partial}`.
 */
export function normalizePullRequest(node, identities) {
    const
        repo     = node.repository?.nameWithOwner ?? null,
        commit   = node.commits?.nodes?.[0]?.commit,
        requests = node.reviewRequests?.nodes ?? [];

    return {
        key      : `${repo}#${node.number}`,
        repo,
        number   : node.number,
        head     : node.headRefOid ?? commit?.oid ?? null,
        ci       : CI_STATES[commit?.statusCheckRollup?.state] ?? null,
        verdict  : node.reviewDecision ?? null,
        mergeable: node.mergeable ?? null,
        draft    : Boolean(node.isDraft),
        owner    : ownerOf(node, identities),
        requested: requests.map(({requestedReviewer: reviewer}) => reviewer?.login
            ? identities.byLogin(reviewer.login) ?? `login:${reviewer.login}`
            : reviewer?.slug ? `team:${reviewer.organization?.login}/${reviewer.slug}` : null
        ).filter(Boolean).sort(),
        // a truncated request list is unknown, never "everyone else was removed"
        partial  : Boolean(node.reviewRequests?.pageInfo?.hasNextPage)
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
 * @summary The transitions between two observations of one open PR.
 * @param {Object} before
 * @param {Object} after
 * @param {String} pulse
 * @returns {Object[]}
 * @private
 */
function changesOf(before, after, pulse) {
    const changes = [];

    for (const kind of ['head', 'ci', 'verdict']) {
        before[kind] !== after[kind] && changes.push(transition(after, kind, before[kind], after[kind], pulse))
    }

    after.requested.filter(seat => !before.requested.includes(seat))
        .forEach(seat => changes.push(transition(after, 'review-requested', null, seat, pulse)));

    if (!before.partial && !after.partial) {
        before.requested.filter(seat => !after.requested.includes(seat))
            .forEach(seat => changes.push(transition(after, 'review-removed', seat, null, pulse)))
    }

    return changes
}

/**
 * @summary Reduce one pulse: the next snapshot and the transitions observed since the previous one.
 *
 * The first pulse (no previous snapshot) is the baseline and records no transition. A merge or close
 * is recorded once: `closed` remembers it until the watermark passes it, so a pulse that re-reads it
 * (the watermark holds while coverage is partial) records nothing. A PR absent from a complete
 * observation leaves the snapshot only when the terminal read was complete too; while either was
 * partial it is carried forward, because missing evidence is not a close.
 * @param {Object} pulse
 * @param {Object|null} pulse.previous `{rows: {[key]: row}, closed: {[key]: at}}`, or null on the first pulse.
 * @param {{rows: Object[], complete: Boolean}} pulse.observed The open rows this pulse read.
 * @param {{rows: Object[], complete: Boolean}} pulse.terminal Terminal rows ({@link normalizeTerminal}) read since `since`.
 * @param {String|null} pulse.since The watermark: the last fully covered pulse's time, ISO.
 * @param {String} pulse.id This pulse's identity.
 * @returns {{rows: Object, closed: Object, transitions: Object[]}}
 */
export function reduceOpenWork({previous, observed, terminal, since, id}) {
    const
        rows        = Object.fromEntries(observed.rows.map(row => [row.key, row])),
        closed      = Object.fromEntries(Object.entries(previous?.closed ?? {}).filter(([, at]) => !since || at >= since)),
        transitions = [];

    if (!previous) return {rows, closed, transitions};

    for (const row of observed.rows) {
        const before = previous.rows[row.key];

        transitions.push(...before ? changesOf(before, row, id) : [transition(row, 'opened', null, 'open', id)])
    }

    for (const row of terminal.rows) {
        if (!rows[row.key] && !closed[row.key] && (!since || row.at >= since)) {
            const before = previous.rows[row.key] ?? row;

            closed[row.key] = row.at;
            transitions.push(transition({...before, head: row.head ?? before.head}, row.state === 'MERGED' ? 'merged' : 'closed', 'open', row.state.toLowerCase(), id))
        }
    }

    for (const [key, before] of Object.entries(previous.rows)) {
        if (!rows[key] && !closed[key] && !(observed.complete && terminal.complete)) {
            rows[key] = before
        }
    }

    return {rows, closed, transitions}
}
