/**
 * @module ai/services/fleet/openWorkHolder
 * @summary Who holds an open pull request's next action. The open-work projection and the wake path
 * both read this one function, so they never disagree about whose turn a PR is.
 *
 * A review counts only when it judged the current head: `reviewDecision` keeps a change request the
 * author has since pushed past, and an earlier head's approval. `operator` and `rotation` are roles
 * that name nobody; the reader that renders or wakes resolves them, so no operator's handle lives here.
 */

/**
 * @summary The holder of one open snapshot row; the first rule below that matches wins.
 * @param {Object} row An open row of the producer's snapshot.
 * @returns {{role: 'rotation'|'author'|'reviewer'|'operator'|'none', ids: String[]}}
 */
export function holderOf({ci, mergeable, draft, owner, requested = [], reviews = []}) {
    const
        onHead    = state => reviews.some(review => review.onHead && review.state === state),
        finished  = ci === 'red' || ci === 'green',
        untouched = !requested.length && !reviews.some(review => review.onHead);

    if (owner?.kind === 'outside' && finished && untouched) {
        return {role: 'rotation', ids: []}
    }

    if (ci === 'red' || onHead('CHANGES_REQUESTED')) {
        return {role: 'author', ids: owner?.seat ? [owner.seat] : []}
    }

    if (ci === 'green' && requested.length) {
        return {role: 'reviewer', ids: [...requested]}
    }

    if (ci === 'green' && onHead('APPROVED') && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', ids: []}
    }

    return {role: 'none', ids: []}
}

export default holderOf;
