/**
 * @module ai/services/fleet/openWorkWakeMessage
 * @summary The open-work wake's contract between the Fleet producer and the plane: the action kinds, the bounded
 * observation the producer submits, and the message the plane composes from it. Pure: no I/O, no Neo imports.
 *
 * The producer runs host-side and decides which wakes to send. The plane decides what a wake says and sends it as
 * `@system`. The observation is made of tokens, never text: a repository, a number, a head, a kind, an episode, a
 * recipient and, for `repair-ci`, check names. The plane composes the subject and body from them, so no caller puts
 * free text under the system sender.
 */

/**
 * @summary Each action kind's reason: the only prose in a wake besides its fixed frame. The keys are the kinds.
 * @member {Object<String,String>} OPEN_WORK_WAKE_REASONS
 */
export const OPEN_WORK_WAKE_REASONS = Object.freeze({
    'repair-ci'       : 'CI is red on your head',
    'address-changes' : 'changes are requested on your head',
    rebase            : 'your approved head has conflicts to rebase',
    review            : 'your review is due on the current head',
    'route-review'    : 'CI is green; request a reviewer for your head',
    'triage-outside'  : 'an untouched outside contributor pull request has finished CI',
    'approve-runs'    : 'an outside contributor pull request has workflow runs awaiting approval',
    'post-merge'      : 'your pull request was merged'
});

const
    // GitHub's own limits: an owner of at most 39 characters, a name of at most 100
    REPO          = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/,
    OID           = /^[0-9a-f]{40}$/,
    INSTANT       = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/,
    IDENTITY      = /^@[A-Za-z0-9._-]{1,100}$/,
    // One printable line: no control character, line breaks and tabs included
    PRINTABLE     = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u,
    MAX_CHECKS    = 50,
    MAX_CHECK_LEN = 120;

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
 * @summary Whether an episode is one the producer mints: the instant an open action was first observed, or for
 * `post-merge` the merge transition of this observation's own pull request and head. Nothing else passes, so the
 * episode carries no text of its own.
 * @param {Object} observation
 * @returns {Boolean}
 * @private
 */
function validEpisode({repo, number, head, kind, episode}) {
    if (typeof episode !== 'string') return false;
    if (kind !== 'post-merge') return INSTANT.test(episode);

    const pulse = episode.slice(episode.lastIndexOf('#') + 1);

    return INSTANT.test(pulse) && episode === mergeEpisodeOf({repo, number, head}, pulse)
}

/**
 * @summary Validates the observation a producer submits, and answers it normalized, or every reason it is refused.
 * Unknown fields are the tool schema's to refuse; this checks the fields the message is composed from.
 * @param {Object} args `{repo, number, head, kind, episode, to, failedChecks}`
 * @returns {{observation: Object|null, errors: String[]}}
 */
export function validateOpenWorkObservation(args) {
    const
        {repo, number, head, kind, episode, to, failedChecks = null} = args ?? {},
        errors = [];

    if (typeof repo !== 'string' || !REPO.test(repo)) errors.push('repo must be owner/name');
    if (!Number.isSafeInteger(number) || number < 1) errors.push('number must be a positive integer');
    if (typeof head !== 'string' || !OID.test(head)) errors.push('head must be a full 40-character lowercase commit id');
    if (!Object.hasOwn(OPEN_WORK_WAKE_REASONS, kind)) errors.push(`kind must be one of ${Object.keys(OPEN_WORK_WAKE_REASONS).join(', ')}`);
    if (typeof to !== 'string' || !IDENTITY.test(to)) errors.push('to must be one @identity');

    if (!errors.length && !validEpisode({repo, number, head, kind, episode})) {
        errors.push(kind === 'post-merge'
            ? 'episode must be the merge transition of this pull request and head'
            : 'episode must be the ISO instant the action was first observed')
    }

    if (failedChecks !== null) {
        if (kind !== 'repair-ci') {
            errors.push('failedChecks belongs to repair-ci only')
        } else if (!Array.isArray(failedChecks) || failedChecks.length > MAX_CHECKS ||
            failedChecks.some(name => typeof name !== 'string' || name.length > MAX_CHECK_LEN || !PRINTABLE.test(name))) {
            errors.push(`failedChecks must be at most ${MAX_CHECKS} check names, each one printable line of 1 to ${MAX_CHECK_LEN} characters`)
        }
    }

    return errors.length
        ? {observation: null, errors}
        : {observation: {repo, number, head, kind, episode, to, failedChecks: kind === 'repair-ci' ? failedChecks : null}, errors}
}

/**
 * @summary What a `repair-ci` wake says failed: the first three names in its subject, all of them in its body.
 * @param {String[]|null} names The failing checks read at the send; null when they could not be read.
 * @returns {{subject: String, body: String}}
 * @private
 */
function failingOf(names) {
    if (!names) return {subject: 'unknown', body: 'unknown; the names could not be read'};
    if (!names.length) return {subject: 'none at send time', body: 'none when this wake was sent'};

    return {subject: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''), body: names.join(', ')}
}

/**
 * @summary Composes the wake a validated observation sends. It wakes its recipient at normal priority: a system
 * observation is neither operator steering nor drain-first. The task keeps the full identity a reader needs to
 * re-check the live pull request.
 * @param {Object} observation A {@link validateOpenWorkObservation} result.
 * @returns {Object} An `addMessage` payload.
 */
export function composeOpenWorkWake(observation) {
    const
        {repo, number, head, kind, episode, to, failedChecks} = observation,
        pr      = `${repo}#${number}`,
        reason  = OPEN_WORK_WAKE_REASONS[kind],
        failing = kind === 'repair-ci' ? failingOf(failedChecks) : null;

    return {
        to,
        subject: `[open-work:${kind}] ${pr}: observed ${reason}${failing ? ` — failing: ${failing.subject}` : ''}`,
        body   : `https://github.com/${repo}/pull/${number}\nHead: ${head}\n` +
            `Observed action: ${kind} — ${reason}.\n${failing ? `Failing checks: ${failing.body}.\n` : ''}Episode: ${episode}\n\n` +
            'Re-check the live pull request, head, checks and review state before acting. ' +
            'This message describes a producer observation, not a guarantee of the current state.',
        relatedTickets: [pr],
        priority      : 'normal',
        wakeSuppressed: false,
        task          : {
            id  : `open-work:${JSON.stringify([repo, number, head, to, kind, episode])}`, state: 'Submitted',
            producerRole: 'fleet-open-work', kind, head, episode
        }
    }
}
