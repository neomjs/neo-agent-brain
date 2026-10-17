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
 * The kind distinguishes successive actions held by the same seat: fixing CI, addressing changes,
 * rebasing and routing a review are different episodes even though the author holds each one.
 *
 * A partial read (a review, opinion or request list truncated or unresolved, or no opinion list at
 * all) decides only on positive evidence: a red head, or a change request on the head, is the
 * author's. Every other rule reads an absence a missing page could hold, so the holder is `unknown`,
 * never `none`.
 */

/**
 * @summary The holder of one open snapshot row; the first rule below that matches wins.
 * @param {Object} row An open row of the producer's snapshot.
 * @returns {{role: 'rotation'|'author'|'reviewer'|'operator'|'none'|'unknown',
 *     kind: 'approve-runs'|'triage-outside'|'repair-ci'|'address-changes'|'rebase'|'review'|'route-review'|'merge'|null, ids: String[]}}
 */
export function holderOf({ci, mergeable, draft, owner, authorAssociation = null, bot = false, authorType = null, runApproval = null, partial = false, requested = [], reviews = [], opinions}) {
    const
        incomplete = partial || !Array.isArray(opinions),
        onHead     = state => (opinions ?? []).some(opinion => opinion.onHead && opinion.state === state),
        finished   = ci === 'red' || ci === 'green',
        untouched  = !requested.length && !reviews.some(review => review.onHead),
        maintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation),
        eligible   = owner?.kind === 'outside' && !draft && !bot && authorType !== 'Bot' && !maintainer;

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

    if (ci === 'green' && requested.length) {
        return {role: 'reviewer', kind: 'review', ids: [...requested]}
    }

    if (ci === 'green' && owner?.kind === 'seat' && owner.seat && !draft && !opinions.some(opinion => opinion.onHead)) {
        return {role: 'author', kind: 'route-review', ids: [owner.seat]}
    }

    if (ci === 'green' && onHead('APPROVED') && mergeable === 'MERGEABLE' && !draft) {
        return {role: 'operator', kind: 'merge', ids: []}
    }

    return {role: 'none', kind: null, ids: []}
}

export default holderOf;
