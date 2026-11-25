/**
 * @module ai/services/fleet/openWorkWakeMessage
 * @summary The open-work wake's contract between the Fleet producer and the plane: the action kinds, the bounded
 * observation the producer submits, and the message the plane composes from it. Pure: no I/O, no Neo imports.
 *
 * The producer runs host-side and decides which wakes to send. The plane decides what a wake says and sends it as
 * `@system`. The observation is made of tokens, never text: a repository, a number, a head, a kind, an episode, a
 * recipient, for `repair-ci` check names, for `unblocked` the issue the merge unblocked, and for `holder-unreachable`
 * and `holder-silent` the holder they escalate. The plane composes the subject and body from them, so no caller puts
 * free text under the system sender.
 */

/**
 * @summary Each action kind's reason: the only prose in a wake besides its fixed frame. The keys are the kinds.
 * @member {Object<String,String>} OPEN_WORK_WAKE_REASONS
 */
export const OPEN_WORK_WAKE_REASONS = Object.freeze({
    'repair-ci'         : 'CI is red on your head',
    'address-changes'   : 'changes are requested on your head',
    rebase              : 'your approved head has conflicts to rebase',
    review              : 'your review is due on the current head',
    'route-review'      : 'CI is green; request a reviewer for your head',
    'await-prerequisite': 'your approved head closes an issue that is still blocked, so it waits off the merge',
    'triage-outside'    : 'an untouched outside contributor pull request has finished CI',
    'approve-runs'      : 'an outside contributor pull request has workflow runs awaiting approval',
    'respond-comment'   : 'an outside comment on the pull request awaits a reply',
    'post-merge'        : 'your pull request was merged',
    unblocked           : 'a merge unblocked your ticket',
    closeout            : 'every sub of this issue is closed: close it, or file the missing subs',
    unowned             : "no seat owns this pull request's next action",
    'holder-unreachable': "the seat holding this pull request's next action has no deliverable wake route",
    'holder-silent'     : "the seat holding this pull request's next action has not acted on its delivered wake"
});

/**
 * @summary What an escalation asks of its rotation seat, which holds nothing on the pull request itself.
 * @member {Object<String,String>} ESCALATION_ASKS
 * @private
 */
const ESCALATION_ASKS = Object.freeze({
    unowned             : 'No seat is named as its author: route the next action to a seat, or take it yourself.',
    'holder-unreachable': "The holder's own wake waits for its route: reach the holder another way, or take the action yourself.",
    'holder-silent'     : "The holder's wake arrived hours ago: reach the holder another way, or take the action yourself."
});

/**
 * @summary The escalations that name the holder they escalate.
 * @member {Set<String>} OPEN_WORK_HOLDER_KINDS
 */
export const OPEN_WORK_HOLDER_KINDS = new Set(['holder-unreachable', 'holder-silent']);

/** @summary Closed diagnostic vocabulary for the producer reads that did not establish complete coverage. */
export const OPEN_WORK_CI_INCOMPLETE_READS = Object.freeze([
    'comments', 'reviews', 'review-requests', 'commits', 'check-suites', 'checks', 'legacy-coverage'
]);

const
    // GitHub's own limits: an owner of at most 39 characters, a name of at most 100
    REPO          = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/,
    ISSUE         = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#[1-9]\d{0,9}$/,
    OID           = /^[0-9a-f]{40}$/,
    EVIDENCE_KEY  = /^[0-9a-f]{64}$/,
    INSTANT       = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
    IDENTITY      = /^@[A-Za-z0-9._-]{1,100}$/,
    // One printable line: no control character, line breaks and tabs included
    PRINTABLE     = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u,
    MAX_CHECKS    = 50,
    MAX_CHECK_LEN = 120;

/**
 * @summary Validates the bounded outside-repair state; a mechanical classification requires exact evidence.
 * @param {*} value Optional observation metadata when present.
 * @returns {Boolean}
 */
export function isOpenWorkCiRepair(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).every(key => ['evidenceKey', 'kind', 'incompleteReads'].includes(key)) &&
        Object.hasOwn(value, 'evidenceKey') && Object.hasOwn(value, 'kind') &&
        (!Object.hasOwn(value, 'incompleteReads') || isOpenWorkCiIncompleteReads(value.incompleteReads)) &&
        ['unclassified', 'mechanical'].includes(value.kind) &&
        (value.evidenceKey === null ? value.kind === 'unclassified' :
            typeof value.evidenceKey === 'string' && EVIDENCE_KEY.test(value.evidenceKey));
}

/** @summary Validates nonempty, unique diagnostic tokens, including direct-call sparse-array refusal. */
export function isOpenWorkCiIncompleteReads(reads) {
    return Array.isArray(reads) && reads.length > 0 && reads.length <= OPEN_WORK_CI_INCOMPLETE_READS.length &&
        Object.keys(reads).length === reads.length && new Set(reads).size === reads.length &&
        Array.from(reads).every(token => OPEN_WORK_CI_INCOMPLETE_READS.includes(token));
}

/** @summary Checks the existing wake display bounds without truncating or changing CI evidence. */
export function isOpenWorkFailedChecks(names) {
    return Array.isArray(names) && names.length <= MAX_CHECKS &&
        !names.some(name => typeof name !== 'string' || name.length > MAX_CHECK_LEN || !PRINTABLE.test(name));
}

/**
 * @summary The episode a merge is observed as: the producer's transition id for this pull request and head.
 * @param {Object} observation `{repo, number, head}`
 * @param {String} pulse The observing pulse, an ISO instant.
 * @returns {String}
 */
export function mergeEpisodeOf({repo, number, head}, pulse) {
    return `${repo}#${number}@${head}:merged:open->merged#${pulse}`
}

/**
 * @summary The episode of one issue a merge unblocked: the merge's own episode, then that issue. One merge that
 * unblocks two issues is two tasks.
 * @param {String} mergeEpisode The merge transition id, as {@link mergeEpisodeOf} mints it.
 * @param {String} issue The unblocked issue, `owner/name#N`.
 * @returns {String}
 */
export function unblockedEpisodeOf(mergeEpisode, issue) {
    return `${mergeEpisode}|${issue}`
}

/**
 * @summary Whether an episode is one the producer mints: the instant an open action was first observed; for
 * `post-merge` the merge transition of this observation's own pull request and head; for `unblocked` that merge
 * transition, then the issue the observation names. Nothing else passes, so the episode carries no text of its own.
 * @param {Object} observation
 * @returns {Boolean}
 * @private
 */
function validEpisode({repo, number, head, kind, episode, unblocks}) {
    if (typeof episode !== 'string') return false;
    if (kind === 'unblocked') {
        const cut = episode.lastIndexOf('|');

        return cut > 0 && episode.slice(cut + 1) === unblocks &&
            validEpisode({repo, number, head, kind: 'post-merge', episode: episode.slice(0, cut)})
    }
    if (kind !== 'post-merge') return INSTANT.test(episode);

    const pulse = episode.slice(episode.lastIndexOf('#') + 1);

    return INSTANT.test(pulse) && episode === mergeEpisodeOf({repo, number, head}, pulse)
}

/**
 * @summary Validates the observation a producer submits, and answers it normalized, or every reason it is refused.
 * Unknown fields are the tool schema's to refuse; this checks the fields the message is composed from.
 * @param {Object} args `{repo, number, head, kind, episode, to, failedChecks, ciRepair, unblocks, holder}`
 * @returns {{observation: Object|null, errors: String[]}}
 */
export function validateOpenWorkObservation(args) {
    const
        {repo, number, head, kind, episode, to, failedChecks = null, ciRepair, unblocks = null, holder = null} = args ?? {},
        errors = [];

    if (typeof repo !== 'string' || !REPO.test(repo)) errors.push('repo must be owner/name');
    if (!Number.isSafeInteger(number) || number < 1) errors.push('number must be a positive integer');
    if (kind === 'closeout') {
        if (head !== null) errors.push('head must be null for closeout');
    } else if (typeof head !== 'string' || !OID.test(head)) {
        errors.push('head must be a full 40-character lowercase commit id');
    }
    if (!Object.hasOwn(OPEN_WORK_WAKE_REASONS, kind)) errors.push(`kind must be one of ${Object.keys(OPEN_WORK_WAKE_REASONS).join(', ')}`);
    if (typeof to !== 'string' || !IDENTITY.test(to)) errors.push('to must be one @identity');
    if (kind === 'unblocked' && (typeof unblocks !== 'string' || !ISSUE.test(unblocks))) {
        errors.push('unblocks must be the unblocked issue as owner/name#N')
    } else if (kind !== 'unblocked' && unblocks !== null) {
        errors.push('unblocks belongs to unblocked only')
    }
    if (OPEN_WORK_HOLDER_KINDS.has(kind) && (typeof holder !== 'string' || !IDENTITY.test(holder) || holder === to)) {
        errors.push('holder must be the escalated holder as one @identity, never the recipient')
    } else if (!OPEN_WORK_HOLDER_KINDS.has(kind) && holder !== null) {
        errors.push('holder belongs to holder-unreachable and holder-silent only')
    }

    if (!errors.length && !validEpisode({repo, number, head, kind, episode, unblocks})) {
        errors.push(kind === 'post-merge'
            ? 'episode must be the merge transition of this pull request and head'
            : kind === 'unblocked'
                ? 'episode must be the merge transition of this pull request and head, then the unblocked issue'
                : 'episode must be the ISO instant the action was first observed')
    }

    if (failedChecks !== null) {
        if (kind !== 'repair-ci') {
            errors.push('failedChecks belongs to repair-ci only')
        } else if (!isOpenWorkFailedChecks(failedChecks)) {
            errors.push(`failedChecks must be at most ${MAX_CHECKS} check names, each one printable line of 1 to ${MAX_CHECK_LEN} characters`)
        }
    }
    if (Object.hasOwn(args ?? {}, 'ciRepair')) {
        if (kind !== 'repair-ci') errors.push('ciRepair belongs to repair-ci only');
        else if (ciRepair && Object.hasOwn(ciRepair, 'incompleteReads') && !isOpenWorkCiIncompleteReads(ciRepair.incompleteReads)) {
            errors.push('ciRepair.incompleteReads must be 1 to 7 unique closed diagnostic tokens in a dense array');
        } else if (!isOpenWorkCiRepair(ciRepair)) {
            errors.push('ciRepair must contain evidenceKey (64 lowercase hex or null) and kind (unclassified or mechanical); mechanical requires a known key');
        }
    }

    return errors.length
        ? {observation: null, errors}
        : {observation: {repo, number, head, kind, episode, to, failedChecks: kind === 'repair-ci' ? failedChecks : null,
            ...(ciRepair ? {ciRepair: {...ciRepair,
                ...(ciRepair.incompleteReads ? {incompleteReads: [...ciRepair.incompleteReads]} : {})}} : {}),
            ...(kind === 'unblocked' ? {unblocks} : {}), ...(OPEN_WORK_HOLDER_KINDS.has(kind) ? {holder} : {})}, errors}
}

/** @summary Gives the outside repair owner bounded, evidence-specific classification and handback instructions. */
function outsideRepairAsk({head, ciRepair}) {
    if (!ciRepair) return '';
    const {evidenceKey, kind, incompleteReads} = ciRepair;
    return `Evidence key: ${evidenceKey ?? 'unknown'}\nObserved classification: ${kind}\n` +
        (incompleteReads ? `Incomplete reads: ${incompleteReads.join(', ')}.\n` +
            'Inspect beyond the reported read windows before another classification.\n' : '') +
        (evidenceKey
            ? 'As the maintainer, investigate this exact evidence; retain mechanical repair ownership, or publish an actionable content handback.\n' +
                'Maintainer-only classification record (replace mechanical|content with the investigated kind):\n' +
                `<!-- neo-ci-repair-classification:v1 ${JSON.stringify({head, evidenceKey, kind: 'mechanical|content'})} -->\n`
            : 'As the maintainer, investigate incomplete evidence before classifying; retain mechanical repair ownership until the cause is known, or publish an actionable content handback once evidenced.\n') +
        'No content changes without scoped consent; no automatic alternate acceptance or new author deadline. ' +
        'Mechanical classification is not task completion; operation or handback completion remains separate.\n\n';
}

/**
 * @summary What a `repair-ci` wake says failed: the first three names in its subject, all of them in its body.
 * @param {String[]|null} names Failing checks from the producer snapshot or native send-time read; null when unread.
 * @param {Boolean} [snapshot=false] Whether these names belong to the producer's evidence snapshot.
 * @returns {{subject: String, body: String}}
 * @private
 */
function failingOf(names, snapshot = false) {
    if (!names) return {subject: 'unknown', body: snapshot ? 'unknown; producer-snapshot check names are unavailable for this wake' : 'unknown; the names could not be read'};
    if (!names.length) return snapshot ? {subject: 'none in the producer snapshot', body: 'none in the producer snapshot'}
        : {subject: 'none at send time', body: 'none when this wake was sent'};

    return {subject: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''), body: names.join(', ')}
}

/**
 * @summary Composes the wake a validated observation sends. It wakes its recipient at normal priority: a system
 * observation is neither operator steering nor drain-first. The task keeps the full identity a reader needs to
 * re-check the live pull request. An `unblocked` wake leads with the issue it unblocked, since that ticket is the
 * recipient's, and names the merge after it. An escalation names its holder and says what it asks of the rotation
 * seat; the holder is part of the task identity, so two escalated holders are two tasks.
 * @param {Object} observation A {@link validateOpenWorkObservation} result.
 * @returns {Object} An `addMessage` payload.
 */
export function composeOpenWorkWake(observation) {
    const
        {repo, number, head, kind, episode, to, failedChecks, ciRepair, unblocks, holder = null} = observation,
        pr                                                                             = `${repo}#${number}`,
        reason                                                                         = ciRepair ? 'CI is red on an outside contributor head' : OPEN_WORK_WAKE_REASONS[kind],
        failing                                                                        = kind === 'repair-ci' ? failingOf(failedChecks, !!ciRepair) : null,
        issue                                                                          = kind === 'unblocked' ? unblocks.split('#') : null,
        closeout                                                                       = kind === 'closeout',
        ask                                                                            = ESCALATION_ASKS[kind] ? `${ESCALATION_ASKS[kind]} ` : '',
        lead                                                                           = issue
            ? `https://github.com/${issue[0]}/issues/${issue[1]}\nUnblocked by: https://github.com/${repo}/pull/${number} at ${head}\n`
            : closeout
                ? `https://github.com/${repo}/issues/${number}\n`
                : `https://github.com/${repo}/pull/${number}\nHead: ${head}\n`;

    return {
        to,
        subject: `[open-work:${kind}] ${issue ? unblocks : pr}: observed ${reason}${failing ? ` — failing: ${failing.subject}` : ''}`,
        body   : lead +
            `Observed action: ${kind} — ${reason}.\n${failing ? `Failing checks: ${failing.body}.\n` : ''}` +
            `${holder ? `Holder: ${holder}\n` : ''}Episode: ${episode}\n\n` + outsideRepairAsk(observation) + ask +
            (issue
                ? 'Re-check the live issue and its remaining blockers before acting. '
                : closeout
                    ? 'Re-check the live issue and its sub-issues before acting. '
                    : 'Re-check the live pull request, head, checks and review state before acting. ') +
            'This message describes a producer observation, not a guarantee of the current state.',
        relatedTickets: issue ? [unblocks, pr] : [pr],
        priority      : 'normal',
        wakeSuppressed: false,
        task          : {
            id          : `open-work:${JSON.stringify([repo, number, head, to, kind, episode, ...(holder ? [holder] : [])])}`,
            state       : 'Submitted',
            producerRole: 'fleet-open-work', kind, head, episode
        }
    }
}
