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
 * @returns {{role: 'rotation'|'author'|'reviewer'|'operator'|'none'|'unknown',
 *     kind: 'approve-runs'|'triage-outside'|'repair-ci'|'address-changes'|'rebase'|'review'|'route-review'|'merge'|null, ids: String[]}}
 */
export function holderOf({ci, mergeable, mergeState = null, draft, owner, authorAssociation = null, bot = false, authorType = null, runApproval = null, partial = false, requested = [], reviews = [], opinions}) {
    const
        incomplete   = partial || !Array.isArray(opinions),
        onHead       = state => (opinions ?? []).some(opinion => opinion.onHead && opinion.state === state),
        finished     = ci === 'red' || ci === 'green',
        reviewedHere = new Set(reviews.filter(review => review.onHead).map(review => review.reviewer)),
        // The seats that judged or reviewed an earlier head and have not reviewed this one, in their list order
        earlier      = list => [...new Set(list.filter(item => !item.onHead && !item.bot && isSeat(item.reviewer) &&
            !reviewedHere.has(item.reviewer)).map(item => item.reviewer))],
        judges       = earlier(opinions ?? []),
        engaged      = judges.length ? judges : earlier(reviews),
        untouched    = !requested.length && !reviews.some(review => review.onHead && !review.bot) && !engaged.length,
        maintainer   = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation),
        eligible     = owner?.kind === 'outside' && !draft && !bot && authorType !== 'Bot' && !maintainer;

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

    if (ci === 'green' && onHead('APPROVED') && mergeable === 'CONFLICTING') {
        return {role: 'author', kind: 'rebase', ids: owner?.seat ? [owner.seat] : []}
    }

    // A green outside head pushed past a seat's review is that seat's Round 2; a seat's standing change request joins
    // any review a maintainer requested, since only that seat can lift it
    if (eligible && ci === 'green' && !onHead('APPROVED')) {
        const ids = [...new Set([...requested, ...(requested.length
            ? earlier(opinions.filter(opinion => opinion.state === 'CHANGES_REQUESTED'))
            : engaged)])];

        if (ids.length) {
            return {role: 'reviewer', kind: 'review', ids}
        }
    }

    if (ci === 'green' && requested.length) {
        return {role: 'reviewer', kind: 'review', ids: [...requested]}
    }

    // An unowned org PR owes the same routing; with no seat to hold it, the wake path escalates it
    if (ci === 'green' && (owner?.kind === 'seat' && owner.seat || owner?.kind === 'unowned') && !draft &&
        !opinions.some(opinion => opinion.onHead)) {
        return {role: 'author', kind: 'route-review', ids: owner.seat ? [owner.seat] : []}
    }

    if (ci === 'green' && onHead('APPROVED') && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', kind: 'merge', ids: []}
    }

    if (ci === null && mergeState === 'CLEAN' && onHead('APPROVED') && !requested.length && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', kind: 'merge', ids: []}
    }

    return {role: 'none', kind: null, ids: []}
}

export default holderOf;
