/**
 * @module ai/services/fleet/openWorkHolder
 * @summary Who holds an open pull request's next action. The open-work projection and the wake path
 * both read this one function, so they never disagree about whose turn a PR is.
 *
 * An opinion counts only when it judged the current head: `reviewDecision` keeps a change request the
 * author has since pushed past, and an earlier head's approval. Opinions come from each reviewer's
 * standing approval or change request, never their latest review, which a comment can be; a comment
 * on the head is engagement only. `operator` and `rotation` are roles that name nobody; the reader
 * that renders or wakes resolves them, so no operator's handle lives here.
 *
 * A partial read (a review, opinion or request list truncated or unresolved, or no opinion list at
 * all) decides only on positive evidence: a red head, or a change request on the head, is the
 * author's. Every other rule reads an absence a missing page could hold, so the holder is `unknown`,
 * never `none`.
 */

/**
 * @summary The holder of one open snapshot row; the first rule below that matches wins.
 * @param {Object} row An open row of the producer's snapshot.
 * @returns {{role: 'rotation'|'author'|'reviewer'|'operator'|'none'|'unknown', ids: String[]}}
 */
export function holderOf({ci, mergeable, draft, owner, partial = false, requested = [], reviews = [], opinions, awaitingApproval = false}) {
    const
        incomplete = partial || !Array.isArray(opinions),
        onHead     = state => (opinions ?? []).some(opinion => opinion.onHead && opinion.state === state),
        finished   = ci === 'red' || ci === 'green',
        untouched  = !requested.length && !reviews.some(review => review.onHead);

    // a fork's runs waiting for a maintainer's approval are positive evidence: nothing runs until one acts
    if (owner?.kind === 'outside' && awaitingApproval) {
        return {role: 'rotation', ids: []}
    }

    // "untouched" is an absence, so only a complete read hands an outside PR to the rotation
    if (owner?.kind === 'outside' && finished && untouched && !incomplete) {
        return {role: 'rotation', ids: []}
    }

    if (ci === 'red' || onHead('CHANGES_REQUESTED')) {
        return {role: 'author', ids: owner?.seat ? [owner.seat] : []}
    }

    if (incomplete) {
        return {role: 'unknown', ids: []}
    }

    if (ci === 'green' && requested.length) {
        return {role: 'reviewer', ids: [...requested]}
    }

    if (ci === 'green' && onHead('APPROVED') && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', ids: []}
    }

    // approved and green, but it no longer merges: only the author can rebase
    if (ci === 'green' && onHead('APPROVED') && mergeable === 'CONFLICTING' && !draft) {
        return {role: 'author', ids: owner?.seat ? [owner.seat] : []}
    }

    return {role: 'none', ids: []}
}

export default holderOf;
