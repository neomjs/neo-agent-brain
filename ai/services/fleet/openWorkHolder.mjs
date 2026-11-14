/**
 * @module ai/services/fleet/openWorkHolder
 * @summary Who holds an open pull request's next action. The open-work projection and the wake path
 * both read this one function, so they never disagree about whose turn a PR is.
 *
 * An opinion counts only when it judged the current head: `reviewDecision` keeps a change request the
 * author has since pushed past, and an earlier head's approval. Opinions come from each reviewer's
 * standing approval or change request, never their latest review, which a comment can be; a comment
 * on the head is engagement only. A bot's review is not even that: no seat has looked at the PR, so an
 * outside row stays untouched. `operator` and `rotation` are roles that name nobody; the reader
 * that renders or wakes resolves them, so no operator's handle lives here.
 *
 * An outside author can neither request a review again nor hold a seat, so an outside PR a seat has
 * reviewed on an earlier head is never untouched again: its next green head is that seat's Round 2.
 * A standing change request or approval outranks an earlier comment, and a seat that has reviewed the
 * current head holds nothing until the next push.
 *
 * The kind distinguishes successive actions held by the same seat: fixing CI, addressing changes,
 * rebasing and routing a review are different episodes even though the author holds each one.
 *
 * A partial read (a review, opinion or request list truncated or unresolved, or no opinion list at
 * all) decides only on positive evidence: a red head, or a change request on the head, is the
 * author's. Every other rule reads an absence a missing page could hold, so the holder is `unknown`,
 * never `none`.
 *
 * A head that reports no CI (`ci: null`) never turns green, so its merge chip reads GitHub's `CLEAN`
 * instead, still beside the approval on the head: a repository that requires no review is CLEAN without one.
 *
 * An outside comment owes a reply ({@link responderOf}) beside whatever holds the PR, never in its place: a
 * contributor's question is no less owed while the head is red or a merge waits.
 *
 * An outside PR that names a model (`disclosedFamilies`) needs its approval from another lab (operator ruling,
 * 2026-11-14). A head approval ends its review only from a seat whose family is known and is none the PR names;
 * any other leaves the review to a rotation seat. Without the seats' families no such approval can be verified,
 * so the wake round reads them and decides again.
 */

/**
 * @summary A native seat's reviewer id; a login without a seat names nobody a wake can reach.
 * @param {*} id
 * @returns {Boolean}
 * @private
 */
const isSeat = id => typeof id === 'string' && id.startsWith('@') && id.length > 1;

/**
 * @summary The holder of one open snapshot row; the first rule below that matches wins.
 * @param {Object} row An open row of the producer's snapshot.
 * @param {Object} [options]
 * @param {Object<String,String>|null} [options.seatFamilies=null] Native seat to its model family, from the
 *     plane's identity reads; `null` when not read.
 * @returns {{role: 'rotation'|'author'|'reviewer'|'operator'|'none'|'unknown',
 *     kind: 'approve-runs'|'triage-outside'|'repair-ci'|'address-changes'|'rebase'|'review'|'route-review'|'merge'|null, ids: String[]}}
 */
export function holderOf({ci, mergeable, mergeState = null, draft, owner, authorAssociation = null, bot = false, authorType = null, runApproval = null, partial = false, requested = [], reviews = [], opinions, disclosedFamilies = []}, {seatFamilies = null} = {}) {
    const
        incomplete   = partial || !Array.isArray(opinions),
        onHead       = state => (opinions ?? []).some(opinion => opinion.onHead && opinion.state === state),
        finished     = ci === 'red' || ci === 'green',
        reviewedHere = new Set(reviews.filter(review => review.onHead).map(review => review.reviewer)),
        // The seats that judged or reviewed an earlier head and have not reviewed this one, in their list order
        earlier      = list => [...new Set(list.filter(item => !item.onHead && !item.bot && isSeat(item.reviewer) &&
            !reviewedHere.has(item.reviewer)).map(item => item.reviewer))],
        judges       = earlier(opinions ?? []),
        // A judgment standing on an earlier head outranks a comment even after its seat reviewed this one
        stands       = (opinions ?? []).some(opinion => !opinion.onHead && !opinion.bot && isSeat(opinion.reviewer)),
        engaged      = stands ? judges : earlier(reviews),
        untouched    = !requested.length && !reviews.some(review => review.onHead && !review.bot) && !engaged.length,
        maintainer   = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation),
        eligible     = owner?.kind === 'outside' && !draft && !bot && authorType !== 'Bot' && !maintainer,
        named        = eligible && Array.isArray(disclosedFamilies) && disclosedFamilies.length > 0,
        // On a named outside PR an approval counts only from a seat of a known family the PR does not name
        counts       = reviewer => !named || typeof seatFamilies?.[reviewer] === 'string' && !disclosedFamilies.includes(seatFamilies[reviewer]),
        approved     = (opinions ?? []).some(opinion => opinion.onHead && opinion.state === 'APPROVED' && counts(opinion.reviewer));

    // "untouched" and run-approval completeness require a complete read before handing an outside PR to the rotation
    if (eligible && !incomplete && (runApproval === 'action_required' || finished && untouched)) {
        return {role: 'rotation', kind: runApproval === 'action_required' ? 'approve-runs' : 'triage-outside', ids: []}
    }

    if (ci === 'red' || onHead('CHANGES_REQUESTED')) {
        return {role: 'author', kind: ci === 'red' ? 'repair-ci' : 'address-changes', ids: owner?.seat ? [owner.seat] : []}
    }

    if (incomplete) {
        return {role: 'unknown', kind: null, ids: []}
    }

    if (ci === 'green' && approved && mergeable === 'CONFLICTING') {
        return {role: 'author', kind: 'rebase', ids: owner?.seat ? [owner.seat] : []}
    }

    // A green outside head pushed past a seat's review is that seat's Round 2; a seat's standing change request joins
    // any review a maintainer requested, since only that seat can lift it
    if (eligible && ci === 'green' && !approved) {
        const ids = [...new Set([...requested, ...(requested.length
            ? earlier(opinions.filter(opinion => opinion.state === 'CHANGES_REQUESTED'))
            : engaged)])];

        if (ids.length) {
            return {role: 'reviewer', kind: 'review', ids}
        }
    }

    // A head approval that does not count leaves a named outside PR's review to a rotation seat of another lab
    if (named && ci === 'green' && !approved && onHead('APPROVED')) {
        return {role: 'rotation', kind: 'review', ids: []}
    }

    if (ci === 'green' && requested.length) {
        return {role: 'reviewer', kind: 'review', ids: [...requested]}
    }

    // An unowned org PR owes the same routing; with no seat to hold it, the wake path escalates it
    if (ci === 'green' && (owner?.kind === 'seat' && owner.seat || owner?.kind === 'unowned') && !draft &&
        !opinions.some(opinion => opinion.onHead)) {
        return {role: 'author', kind: 'route-review', ids: owner.seat ? [owner.seat] : []}
    }

    if (ci === 'green' && approved && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', kind: 'merge', ids: []}
    }

    if (ci === null && mergeState === 'CLEAN' && approved && !requested.length && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', kind: 'merge', ids: []}
    }

    return {role: 'none', kind: null, ids: []}
}

/**
 * @summary The reply an outside comment is owed, and the seat that owes it. The owed turn is the earliest outside
 * comment or review after the conversation's latest member turn; its time is the episode, so a member's reply ends
 * it and the next outside turn opens another. An outside turn needs an author GitHub still names: a bot's turn, or
 * one whose author is gone, is neither a question nor an answer. The PR's author seat answers its own PR; otherwise
 * the seat that spoke last, then a requested seat, then a seat that judged or reviewed it, and with none the
 * rotation. `turns` holds only the conversation's latest page, so the owed turn can slide out of it: a `held`
 * episode stays the episode until a member turn after it shows.
 * @param {Object} row An open row of the producer's snapshot.
 * @param {Object} [options]
 * @param {String|null} [options.held=null] The episode of the reply already held for this PR.
 * @param {String|null} [options.since=null] An instant whose earlier turns are already covered, as a triage covers
 *     the turns it woke a seat for; only a later outside turn is owed.
 * @returns {{role: 'author'|'reviewer'|'rotation', kind: 'respond-comment', ids: String[], episode: String}|null}
 */
export function responderOf({draft, owner, bot = false, authorType = null, requested = [], reviews = [], opinions = [], turns}, {held = null, since = null} = {}) {
    if (draft || bot || authorType === 'Bot' || !Array.isArray(turns)) return null;

    const
        people = turns.filter(turn => !turn.bot && Number.isFinite(Date.parse(turn.at))),
        last   = people.findLast(turn => turn.member),
        after  = Math.max(last ? Date.parse(last.at) : -Infinity, since ? Date.parse(since) : -Infinity),
        owed   = people.find(turn => !turn.member && turn.by && Date.parse(turn.at) > after);

    if (!owed) return null;

    // No member turn after the held one shows, so a later owed turn means the page slid, not a new question
    const
        episode = held && Date.parse(held) >= after && Date.parse(held) < Date.parse(owed.at) ? held : owed.at,
        reply   = (role, ids) => ({role, kind: 'respond-comment', ids, episode});

    if (owner?.kind === 'seat' && isSeat(owner.seat)) return reply('author', [owner.seat]);

    const seat = people.findLast(turn => turn.member && isSeat(turn.by))?.by ?? requested.find(isSeat) ??
        [...opinions, ...reviews].find(item => !item.bot && isSeat(item.reviewer))?.reviewer;

    return seat ? reply('reviewer', [seat]) : reply('rotation', [])
}

export default holderOf;
