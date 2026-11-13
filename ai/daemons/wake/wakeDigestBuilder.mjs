import {selectWakeDirective} from './wakeLaneDirective.mjs';

const WAKE_PRIORITY_RANKS = {
    low   : 0,
    normal: 1,
    high  : 2
};

/** @summary The most rows one list of the open-work section names; the rest are counted. */
const OPEN_WORK_ROWS = 5;

/**
 * @summary One open-work row as the digest names it: repository, number, title, and `stale` when the producer has
 * not seen it lately.
 * @param {Object} row
 * @returns {String}
 * @private
 */
function openWorkRef(row) {
    return `${row.repo}#${row.number}${row.title ? ` "${row.title}"` : ''}${row.stale ? ' (stale)' : ''}`
}

/**
 * @summary The digest's open-work section: the seat's own open pull requests and the reviews requested of it, from
 * the plane's copy of the Fleet's projection. A stale copy says since when, and an unavailable copy or one that does
 * not track the seat says that, so none of them reads as "no open work". No answer renders nothing, which keeps the
 * push path's digests unchanged.
 * @param {Object|null} openWork `openWorkCopyStore#ownOpenWorkOf`'s answer for the recipient.
 * @returns {String}
 */
export function formatOwnOpenWork(openWork) {
    if (!openWork) return '';

    if (openWork.state === 'unavailable' || openWork.state === 'untracked') {
        return `\n\nYour open work: ${openWork.state} (${openWork.reason}).`
    }

    const
        lines   = [],
        partial = openWork.coverage === 'partial' ? `, partial${openWork.reason ? `: ${openWork.reason}` : ''}` : '',
        stale   = openWork.state === 'stale' ? `, stale since ${openWork.observedAt}` : '',
        list    = (rows, line) => {
            rows.slice(0, OPEN_WORK_ROWS).forEach(row => lines.push(line(row)));
            rows.length > OPEN_WORK_ROWS && lines.push(`- and ${rows.length - OPEN_WORK_ROWS} more`)
        };

    list(openWork.authored, row => `- your PR ${openWorkRef(row)}: CI ${row.ci ?? 'unknown'}${row.verdict ? `, ${row.verdict}` : ''}` +
        `; next: ${row.holder?.role ?? 'unknown'}${row.holder?.kind ? ` (${row.holder.kind})` : ''}`);
    list(openWork.reviewing, row => `- review requested of you: ${openWorkRef(row)}`);

    return `\n\nYour open work (as of ${openWork.observedAt}${stale}${partial}):` +
        (lines.length ? `\n${lines.join('\n')}` : ' no open pull request of yours and no review requested of you.')
}

/**
 * @summary Formats an optional live PR-state echo embedded in a heartbeat pulse summary.
 * @param {Object} summary Decoded heartbeat summary.
 * @returns {String}
 */
function formatPullRequestStateEcho(summary = {}) {
    const pullRequest = summary.latest?.pullRequest;
    if (!pullRequest?.state || !pullRequest?.number) return '';

    const mergedAt  = pullRequest.mergedAt  ? `, mergedAt ${pullRequest.mergedAt}`   : '',
          checkedAt = pullRequest.checkedAt ? `, checkedAt ${pullRequest.checkedAt}` : '';
    return ` [PR #${pullRequest.number}: ${pullRequest.state}${mergedAt}${checkedAt}]`
}

/**
 * @summary Normalizes wake digest priority values to the supported A2A priority vocabulary.
 *
 * The wake-priority digest surface intentionally reuses the existing A2A mailbox priority
 * values (`low`, `normal`, `high`) instead of introducing a transport-only urgency enum.
 * Unknown or missing priorities collapse to `normal` so malformed mailbox data cannot
 * produce ambiguous wake headers.
 *
 * @param {String} priority The raw message priority from the mailbox payload.
 * @returns {String} The normalized wake digest priority.
 * @private
 */
function normalizeWakePriority(priority) {
    return Object.hasOwn(WAKE_PRIORITY_RANKS, priority) ? priority : 'normal';
}

/**
 * @summary Projects coalesced message events into one wake digest priority.
 *
 * The wake daemon may coalesce several message events into one digest. This helper
 * preserves the strongest interruption signal by choosing the highest message priority
 * for the `[WAKE][priority:<level>]` header while keeping normal/low wakes deferrable
 * by agent policy.
 *
 * @param {Object[]} messages Coalesced message wake events.
 * @returns {String} The highest normalized wake digest priority.
 * @private
 */
export function getHighestWakePriority(messages) {
    return messages.reduce((highest, message) => {
        const priority = normalizeWakePriority(message.priority);

        return WAKE_PRIORITY_RANKS[priority] > WAKE_PRIORITY_RANKS[highest] ? priority : highest;
    }, 'normal');
}

/**
 * @summary Selects a bucket's latest event by the bucket's own event-time clock.
 *
 * Messages resolve by `sentAt`, task transitions by `lastModifiedAt` — true event times, so
 * an out-of-order queue (projection replay, retry-union rebuild) cannot name a stale event
 * while a newer one is present. Equal timestamps keep the LAST-enqueued candidate (no drift
 * for same-instant events); a candidate with an unparseable or missing clock never outranks
 * a clocked one; when NO candidate carries a resolvable clock the bucket keeps arrival
 * position (last element), the previous behavior.
 *
 * @param {Object[]} events Bucket events in arrival order.
 * @param {String}   field  The event property carrying the ISO timestamp.
 * @returns {Object}
 * @private
 */
function latestByEventTime(events, field) {
    let best   = null,
        bestTs = -Infinity;

    for (const event of events) {
        const value = event?.[field];

        if (typeof value === 'string') {
            const ts = Date.parse(value);

            if (Number.isFinite(ts) && ts >= bestTs) {
                best   = event;
                bestTs = ts;
            }
        }
    }

    return best ?? events[events.length - 1]
}

/**
 * @summary Builds the `[WAKE]` digest string for a set of wake events. Extracted so the retry path
 * can rebuild a SINGLE digest over the UNION of events accumulated across same-subscription failures
 * (correct total count + max priority), rather than replaying one stale per-failure string.
 *
 * Each bucket's "latest" resolves by the truest clock its event shape carries: messages by
 * the message's own `sentAt`, task transitions by the canonical `lastModifiedAt` — so an
 * out-of-order queue (projection replay, retry-union concat) cannot point "latest" at a stale
 * event while a newer one is present. Permission and heartbeat events carry no event-time
 * clock on the daemon's mapper, so those buckets keep arrival position; the daemon's own
 * freshness partitioner already refuses GraphLog position for exactly this reason. "Latest"
 * is the pointer the woken agent reads first, so each bucket claims only the recency its own
 * shape can prove.
 *
 * @see CoalescingEngineService.resolveEventTimestamp (ai/services/memory-core/CoalescingEngineService.mjs) —
 *      the engine-side sibling seam for per-bucket "latest" recency; structured digest envelope vs
 *      this module's string digest. Deliberately separate implementations (Neo singleton vs spawn-only
 *      daemon entrypoint) — repair one, check the other.
 *
 * The pull path also passes the recipient's own open work, state rather than an event: it renders after the events
 * ({@link formatOwnOpenWork}) and never makes a digest on its own.
 *
 * @param {String} identity Recipient agent identity.
 * @param {Object} events `{messages, tasks, permissions, heartbeats}` arrays.
 * @param {Object} [context]
 * @param {Object|null} [context.openWork] The recipient's own open work; the push path passes none.
 * @returns {String}
 */
export function buildWakeDigest(identity, {messages = [], tasks = [], permissions = [], heartbeats = []} = {}, {openWork = null} = {}) {
    const N              = messages.length + tasks.length + permissions.length + heartbeats.length,
          digestPriority = getHighestWakePriority(messages);

    let breakdown = '';

    if (messages.length > 0) {
        const latest         = latestByEventTime(messages, 'sentAt'),
              latestPriority = normalizeWakePriority(latest.priority),
              prioritySuffix = latestPriority === digestPriority ? '' : `, latest priority: ${latestPriority}`;
        // COUNTS QUEUED EVENTS. This function's own signature says so: the parameter object is
        // `events`, and `messages` is its message-class event array. Same rename as the sibling
        // seam in `localWakeAdapters.mjs` - both must move together or the two renderers disagree
        // about what the same number means.
        breakdown += `\n- ${messages.length} message events (latest: "${latest.subject}" from ${latest.from}${prioritySuffix})`;
    }
    if (tasks.length > 0) {
        const latest = latestByEventTime(tasks, 'lastModifiedAt');
        breakdown += `\n- ${tasks.length} task transitions (latest: ${latest.newState} on task ${latest.taskId})`;
    }
    if (permissions.length > 0) {
        const latest = permissions[permissions.length - 1];
        breakdown += `\n- ${permissions.length} permissions granted (latest: ${latest.scope} by ${latest.grantedBy})`;
    }
    if (heartbeats.length > 0) {
        const latest  = heartbeats[heartbeats.length - 1],
              summary = latest.summary;

        let extra = '';
        if (summary?.source === 'github-notification') {
            extra = `; latest GitHub ${summary.latest?.reason || 'notification'}: "${summary.latest?.title || summary.latest?.id || 'untitled'}"${formatPullRequestStateEcho(summary)}${summary.latest?.url ? ` (${summary.latest.url})` : ''}`;
        } else if (summary?.source === 'idle-out-nudge') {
            // The nudge quotes the seat's own last lane-state line and the sunset rule when the
            // producer supplied them; an older pulse without them still renders its reason.
            extra = `; idle-out nudge — ${summary.reason || 'idle'}; next: ${summary.nextAction || 'take the plan\'s next step'}` +
                (summary.laneState  ? `; your last ${summary.laneState}` : '') +
                (summary.sunsetRule ? `; ${summary.sunsetRule}`          : '');
        }

        breakdown += `\n- ${heartbeats.length} heartbeat pulses (latest GraphLog: ${latest.logId}${extra})`;
    }

    const directive = selectWakeDirective({
        content  : messages.length + tasks.length + permissions.length > 0,
        heartbeat: heartbeats.length > 0,
        priority : digestPriority
    });

    return `[WAKE][priority:${digestPriority}] ${N} events for ${identity}: ${breakdown}${formatOwnOpenWork(openWork)}${directive ? `\n\n${directive}` : ''}`
}
