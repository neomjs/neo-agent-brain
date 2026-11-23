/**
 * @module ai/services/fleet/openWorkHolder
 * @summary Who holds an open pull request's next action. The open-work projection and the wake path
 * both read this one function, so they never disagree about whose turn a PR is.
 *
 * An opinion counts only when it judged the current head: `reviewDecision` keeps a change request the
 * author has since pushed past, and an earlier head's approval. Opinions come from each reviewer's
 * standing approval or change request, never their latest review, which a comment can be; a comment
 * on the head is engagement only, though a change request its seat kept that way still binds a seat-owned
 * PR's author. A bot's review is not even that: no seat has looked at the PR, so an
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
 * After initial triage, outside CI repair stays with the maintainer rotation until a current verified
 * content decision hands it to the author; approved outside conflicts also use the rotation. A resolved
 * native reviewer's on-head change request preserves the author's existing packet ahead of classification.
 * That packet does not itself classify CI, and a stale or bot opinion cannot establish the exception.
 *
 * A partial read decides only on positive evidence. A native author's red head stays theirs; an eligible
 * outside red head reaches maintainer investigation unless a current content decision or native on-head
 * change request preserves the author's action. With complete coverage, a confirmed conflict on an
 * independently approved head takes precedence over red CI. For a non-draft, unapproved green head with an
 * already-requested reviewer (`row.mergeable` and `row.reviewAdmission`), `CONFLICTING` routes integration to
 * `rotation` or `author` while preserving `reviewRequests`, and `UNKNOWN`/missing mergeability or a non-success
 * review-admission status withholds the action as `unknown` until resolved.
 * Review and merge also require complete coverage.
 *
 * A head that reports no CI (`ci: null`) never turns green, so its merge chip reads GitHub's `CLEAN`
 * instead, still beside the approval on the head: a repository that requires no review is CLEAN without one.
 *
 * A merge waits for the issues the PR closes: while one has an open blocker (a native `blocked_by`, often another
 * PR's ticket), the approved head is its author's to see through, never the operator's merge. A row without a complete
 * read of those issues, one stored before the read existed included, certifies no merge.
 *
 * An outside comment owes a reply ({@link responderOf}) beside whatever holds the PR, never in its place: a
 * contributor's question is no less owed while the head is red or a merge waits.
 *
 * An outside PR that names a model (`disclosedFamilies`) needs its approval from another lab (operator ruling,
 * 2026-11-14). A head approval ends its review only from a seat whose family is known and is none the PR names;
 * any other leaves the review to a rotation seat. Without the seats' families no such approval can be verified,
 * so the wake round reads them and decides again.
 *
 * A rebase waits its turn when the reader passes the snapshot's merge line ({@link mergeLineOf}): an approved PR that
 * conflicts behind another approved PR of its repository reads `await-merge-turn`, and rebases once that PR has merged.
 */

import {openWorkFreshness} from './openWorkFreshness.mjs';

/**
 * @summary A native seat's reviewer id; a login without a seat names nobody a wake can reach.
 * @param {*} id
 * @returns {Boolean}
 * @private
 */
const isSeat = id => typeof id === 'string' && id.startsWith('@') && id.length > 1;

/** @summary Canonical native identity spelling; producer admission owns maintainer authorization. */
const canonicalSeat = id => typeof id === 'string' && /^@[A-Za-z0-9._-]{1,100}$/.test(id);

/** @summary A row's `owner/name#number`, the name the merge line keys and reports it by. */
const prKey = ({repo, number}) => `${repo}#${number}`;

/** @summary Missing list coverage cannot certify review, reply, integration or merge absence. */
export const incompleteRow = row => row.partial !== false || !Array.isArray(row.requested) ||
    !Array.isArray(row.reviews) || !Array.isArray(row.opinions);

/**
 * @summary Whether the wake round decides a row at `now`: freshly observed, and either read completely or a red outside
 * head, whose CI investigation needs no complete read. Only such a row holds a place in the merge line.
 * @param {Object} row Normalized producer row.
 * @param {Number} now Epoch milliseconds.
 * @returns {Boolean}
 */
export function decidableRow(row, now) {
    return openWorkFreshness(row.observedAt, {now}) === 'ok' &&
        !(incompleteRow(row) && !(row.ci === 'red' && isEligibleOutsidePullRequest(row)))
}

/** @summary The holders whose PR is not on its way to a merge, so it holds no place for the rows behind it. */
const releasesLine = holder => holder.role === 'unknown' || holder.kind === 'address-changes' || holder.kind === 'await-prerequisite';

/**
 * @summary The merge line: per repository and base branch, the open, non-draft rows a seat approved, oldest standing
 * approval first.
 * Each row behind one that holds its place maps to the nearest such row ahead of it, so a conflicting row rebases once,
 * after that row merges, instead of after every merge into a file approved PRs share.
 *
 * An approval keeps its row's place across the row's own new heads: once the first row merges `dev` in, its approval
 * judged an earlier head, yet that row still merges before the rows behind it. A row holds a place for others only while
 * both readers would act on it: the wake round decides it ({@link decidableRow}), its author seat is not absent, and its
 * own holder, read with the round's coverage rule ({@link incompleteRow}), is neither unknown nor waiting on changes or on
 * a blocked close target. A row whose approval carries no time neither waits nor holds.
 * @param {Object[]} rows The snapshot's open rows, as {@link holderOf} reads them.
 * @param {Object} [options]
 * @param {Object<String,String>|null} [options.seatFamilies=null] As {@link holderOf} takes it.
 * @param {String[]|null} [options.absentSeats=null] Native seats that show no sign they can act; `null` when not read.
 * @param {Number} [options.now=Date.now()] Epoch milliseconds the rows' freshness is read at.
 * @returns {Map<String,String>} Each waiting row's `owner/name#number` to that of the row it waits for.
 */
export function mergeLineOf(rows, {seatFamilies = null, absentSeats = null, now = Date.now()} = {}) {
    const
        absent = new Set(absentSeats ?? []),
        lines  = new Map(),
        waits  = new Map(),
        holds  = row => decidableRow(row, now) && !(row.owner?.kind === 'seat' && absent.has(row.owner.seat)) &&
            // a blocked close target holds the merge whatever the head's next action is
            !row.blockedTargets?.length && !releasesLine(holderOf(incompleteRow(row) ? {...row, partial: true} : row, {seatFamilies}));

    for (const row of rows) {
        const at = Math.min(...(Array.isArray(row?.opinions) ? row.opinions : [])
            .filter(opinion => opinion.state === 'APPROVED' && !opinion.bot && isSeat(opinion.reviewer))
            .map(opinion => Date.parse(opinion.at)).filter(Number.isFinite));

        if (row.draft || typeof row.repo !== 'string' || !Number.isSafeInteger(row.number) || !Number.isFinite(at)) continue;

        // a merge into another base branch changes nothing a PR into this one has to rebase onto
        const key = `${row.repo}@${row.base ?? ''}`;

        lines.has(key) || lines.set(key, []);
        lines.get(key).push({row, at})
    }

    for (const line of lines.values()) {
        let ahead = null;

        for (const {row} of line.sort((a, b) => a.at - b.at || a.row.number - b.row.number)) {
            ahead && waits.set(prKey(row), prKey(ahead));
            if (holds(row)) ahead = row
        }
    }

    return waits
}

/**
 * @summary Reuses the outside-action boundary without assigning bots, drafts or organization members to it.
 * @param {Object} row Normalized producer row.
 * @returns {Boolean} Whether an outside action can belong to the maintainer rotation.
 */
export function isEligibleOutsidePullRequest({owner, draft, bot = false, authorType = null, authorAssociation = null} = {}) {
    return owner?.kind === 'outside' && !draft && !bot && authorType !== 'Bot' &&
        !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation);
}

/** @summary Preserves original source identifiers without interpreting them as display strings. */
const originalText = value => typeof value === 'string' && value.length > 0 && value.trim() === value;

/** @summary Checks a public IssueComment receipt against its PR and, when supplied, its provider origin. */
function publicCiRepairReceipt(row, value, apiBase = null) {
    if (!originalText(value) || typeof row?.repo !== 'string' || !Number.isSafeInteger(row.number) || row.number < 1) return false;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search ||
            url.pathname.toLowerCase() !== `/${row.repo}/pull/${row.number}`.toLowerCase() || !/^#issuecomment-[1-9]\d*$/.test(url.hash)) return false;
        if (apiBase === null) return true;
        const api = new URL(apiBase);
        return api.protocol === 'https:' && !api.username && !api.password && !api.search && !api.hash &&
            url.origin === (api.hostname === 'api.github.com' ? 'https://github.com' : api.origin);
    } catch {return false;}
}

/** @summary Recognizes producer-admitted engagement without granting the old decision any CI-classification authority. */
function ciRepairTouchOf(row) {
    const read = row?.ciRepairRead, touch = read?.touch, source = touch?.source, author = touch?.author;
    return touch && !Array.isArray(touch) && originalText(row.head) && read.head === row.head && touch.head === row.head &&
        originalText(touch.commentId) && canonicalSeat(touch.maintainer) && source?.provider === 'github' &&
        source.repo === row.repo && source.number === row.number && originalText(source.prId) && originalText(source.apiBase) &&
        ['provider', 'apiBase', 'repo', 'prId', 'number'].every(key => source[key] === read.source?.[key]) &&
        author?.kind === 'User' && originalText(author.id) && originalText(author.login) &&
        publicCiRepairReceipt(row, touch.receiptUrl, source.apiBase) ? touch : null;
}

/**
 * @summary Returns structurally complete CI evidence for this exact head, including a verified empty failure set.
 * This browser-safe consumer does not derive or replace the producer's evidence digest.
 * @param {Object} row Normalized producer row.
 * @returns {Object|null} Current verified evidence, or null for unread/malformed/stale input.
 */
export function ciRepairEvidenceOf(row) {
    const evidence = row?.ciRepairEvidence;
    return evidence && !Array.isArray(evidence) && typeof row.head === 'string' && row.head.length > 0 &&
        evidence.head === row.head && typeof evidence.key === 'string' && /^[a-f\d]{64}$/.test(evidence.key) &&
        Array.isArray(evidence.failedChecks) && Array.from(evidence.failedChecks)
            .every(name => typeof name === 'string' && name.length > 0)
        ? evidence : null;
}

/**
 * @summary Consumes an admitted maintainer decision only while its head, verified failure evidence and receipt agree.
 * Original comment/maintainer verification belongs to producer admission, not a client-side text inference.
 * @param {Object} row Normalized producer row.
 * @returns {Object|null} Active mechanical/content classification, or null.
 */
export function activeCiRepairClassification(row) {
    const evidence = ciRepairEvidenceOf(row), classification = row?.ciRepairClassification;
    if (!evidence?.failedChecks.length || !classification || Array.isArray(classification) ||
        classification.head !== row.head || classification.evidenceKey !== evidence.key ||
        !['mechanical', 'content'].includes(classification.kind) || !canonicalSeat(classification.maintainer) ||
        !publicCiRepairReceipt(row, classification.receiptUrl)) return null;
    return classification;
}

/**
 * @summary The holder of one open snapshot row; the first rule below that matches wins.
 * @param {Object} row An open row of the producer's snapshot.
 * @param {Object} [options]
 * @param {Object<String,String>|null} [options.seatFamilies=null] Native seat to its model family, from the
 *     plane's identity reads; `null` when not read.
 * @param {Map<String,String>|null} [options.line=null] The snapshot's {@link mergeLineOf}; `null` decides per row.
 * @returns {{role: 'rotation'|'author'|'reviewer'|'operator'|'none'|'unknown',
 *     kind: 'approve-runs'|'triage-outside'|'repair-ci'|'address-changes'|'rebase'|'await-merge-turn'|'review'|'route-review'|'await-prerequisite'|'merge'|null,
 *     ids: String[], targets?: String[], ahead?: String}} `targets` names the still-blocked issues an `await-prerequisite`
 *     PR closes; `ahead`, the PR an `await-merge-turn` PR waits for.
 */
export function holderOf({ci, reviewAdmission = null, mergeable, mergeState = null, draft, owner, authorAssociation = null, bot = false, authorType = null, runApproval = null, partial = false, requested = [], reviews = [], opinions, disclosedFamilies = [], blockedTargets = [], targetsComplete = false,
    repo, number, head, ciRepairEvidence = null, ciRepairClassification = null, ciRepairRead = null}, {seatFamilies = null, line = null} = {}) {
    const incomplete = partial || !Array.isArray(requested) || !Array.isArray(reviews) || !Array.isArray(opinions);
    requested = Array.isArray(requested) ? requested : [];
    reviews = Array.isArray(reviews) ? reviews : [];
    opinions = Array.isArray(opinions) ? opinions : [];
    const
        classification = activeCiRepairClassification({repo, number, head, ciRepairEvidence, ciRepairClassification}),
        admittedTouch  = ciRepairTouchOf({repo, number, head, ciRepairRead}),
        onHead         = state => (opinions ?? []).some(opinion => opinion.onHead && opinion.state === state),
        finished       = ci === 'red' || ci === 'green',
        reviewedHere   = new Set(reviews.filter(review => review.onHead).map(review => review.reviewer)),
        // The seats that judged or reviewed an earlier head and have not reviewed this one, in their list order
        earlier      = list => [...new Set(list.filter(item => !item.onHead && !item.bot && isSeat(item.reviewer) &&
            !reviewedHere.has(item.reviewer)).map(item => item.reviewer))],
        judges       = earlier(opinions ?? []),
        // A judgment standing on an earlier head outranks a comment even after its seat reviewed this one
        stands       = (opinions ?? []).some(opinion => !opinion.onHead && !opinion.bot && isSeat(opinion.reviewer)),
        engaged      = stands ? judges : earlier(reviews),
        untouched    = !(ci === 'red' && (classification || admittedTouch)) && !requested.length &&
            !reviews.some(review => review.onHead && !review.bot) && !engaged.length,
        eligible     = isEligibleOutsidePullRequest({owner, draft, bot, authorType, authorAssociation}),
        named        = eligible && Array.isArray(disclosedFamilies) && disclosedFamilies.length > 0,
        // On a named outside PR an approval counts only from a seat of a known family the PR does not name
        counts       = reviewer => !named || typeof seatFamilies?.[reviewer] === 'string' && !disclosedFamilies.includes(seatFamilies[reviewer]),
        approvesHead = opinion => opinion.onHead && opinion.state === 'APPROVED' && counts(opinion.reviewer),
        approved     = (opinions ?? []).some(approvesHead),
        // A close target with an open blocker holds the merge for the author; an unread target cannot certify it
        merge        = blockedTargets.length ? {role: 'author', kind: 'await-prerequisite', ids: owner?.seat ? [owner.seat] : [], targets: [...blockedTargets]}
            : targetsComplete ? {role: 'operator', kind: 'merge', ids: []} : {role: 'unknown', kind: null, ids: []};

    // "untouched" and run-approval completeness require a complete read before handing an outside PR to the rotation
    if (eligible && !incomplete && (runApproval === 'action_required' || finished && untouched)) {
        return {role: 'rotation', kind: runApproval === 'action_required' ? 'approve-runs' : 'triage-outside', ids: []}
    }

    // Preserve the author's established action packet; this does not classify the CI failure itself.
    if (eligible && (opinions ?? []).some(opinion => opinion.onHead && opinion.state === 'CHANGES_REQUESTED' &&
        !opinion.bot && canonicalSeat(opinion.reviewer))) {
        return {role: 'author', kind: 'address-changes', ids: []}
    }

    // A confirmed conflict can itself turn CI red. Integrate the approved head first, then assess the new head's checks.
    if (!incomplete && approved && mergeable === 'CONFLICTING' && !onHead('CHANGES_REQUESTED')) {
        // Superseding a red CI action requires a countable approval from an independent, resolved maintainer seat.
        const independentApproval = opinion => approvesHead(opinion) && !opinion.bot && isSeat(opinion.reviewer) && opinion.reviewer !== owner?.seat;
        const integratesRed       = ci === 'red' && !draft && (eligible || owner?.kind === 'unowned' || owner?.kind === 'seat' && isSeat(owner.seat)) &&
            opinions.some(independentApproval);
        if (ci === 'green' || integratesRed) {
            const
                rebase = eligible ? {role: 'rotation', kind: 'rebase', ids: []} : {role: 'author', kind: 'rebase', ids: owner?.seat ? [owner.seat] : []},
                ahead  = line?.get(prKey({repo, number}));

            return ahead ? {...rebase, kind: 'await-merge-turn', ahead} : rebase
        }
    }

    if (eligible && ci === 'red' && classification?.kind !== 'content') {
        return {role: 'rotation', kind: 'repair-ci', ids: []}
    }

    if (ci === 'red' || onHead('CHANGES_REQUESTED')) {
        return {role: 'author', kind: ci === 'red' ? 'repair-ci' : 'address-changes', ids: owner?.seat ? [owner.seat] : []}
    }

    if (incomplete) {
        return {role: 'unknown', kind: null, ids: []}
    }

    if (!draft && !approved && ci === 'green' && requested.length) {
        if (mergeable === 'CONFLICTING') {
            return eligible
                ? {role: 'rotation', kind: 'rebase', ids: []}
                : {role: 'author', kind: 'rebase', ids: owner?.seat ? [owner.seat] : []}
        }

        if (mergeable !== 'MERGEABLE' || reviewAdmission && reviewAdmission !== 'success') {
            return {role: 'unknown', kind: null, ids: []}
        }
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

    // An unowned org PR owes the same routing; with no seat to hold it, the wake path escalates it. A seat that reviewed
    // this head and kept its change request (a Round-2 comment) leaves the action with the author instead.
    if (ci === 'green' && (owner?.kind === 'seat' && owner.seat || owner?.kind === 'unowned') && !draft &&
        !opinions.some(opinion => opinion.onHead)) {
        const kept = opinions.some(opinion => opinion.state === 'CHANGES_REQUESTED' && !opinion.bot && isSeat(opinion.reviewer) &&
            reviewedHere.has(opinion.reviewer));

        return {role: 'author', kind: kept ? 'address-changes' : 'route-review', ids: owner.seat ? [owner.seat] : []}
    }

    if (ci === 'green' && approved && mergeable === 'MERGEABLE' && !draft) {
        return merge
    }

    if (ci === null && mergeState === 'CLEAN' && approved && !requested.length && mergeable === 'MERGEABLE' && !draft) {
        return merge
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
