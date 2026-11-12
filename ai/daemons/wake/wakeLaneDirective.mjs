/**
 * @summary The single canonical source of the directives a wake digest ends with, and of the rule that picks one.
 *
 * Both digest renderers — `buildWakeDigest` (`./wakeDigestBuilder.mjs`) and `formatLocalWakeDigest`
 * (`./localWakeAdapters.mjs`) — end their digest with `selectWakeDirective`'s answer, so neither the
 * directive text nor its gating can drift between them or from the discussion / ticket / source wording.
 *
 * @summary Why lifecycle-first ordering (the graduation thesis).
 * The prior directive led with "claim an unclaimed lane," pushing an idle agent toward fresh backlog even
 * when the highest-value action was already-created PR lifecycle work (own red CI, own PR awaiting review
 * routing, an assigned re-review, a peer PR blocked by this agent's REQUEST_CHANGES, or a green peer PR
 * where this agent is the scarce cross-family reviewer). This version leads with that lifecycle queue
 * before any other work. It deliberately does NOT enumerate "idle terminals": that escape-hatch
 * became the idle-loophole — agents steered toward the labelled exits by defining their work down to
 * zero (relabelling an active obligation as "gated", or stacking quality-filters until a massive backlog
 * reads "nothing drivable"). The invariant stays hard — never idle out — with its mirror: no lane minted
 * to avoid idling. After the queue: the accepted plan's next unresolved step, else a ranked proposal.
 *
 * Harness-agnostic prose: neither directive carries Claude-, Codex-, Gemini-, or Antigravity-specific
 * payload assumptions, so the same text is correct on every harness the wake daemon serves.
 *
 * @member {String} WAKE_LANE_DIRECTIVE
 */
export const WAKE_LANE_DIRECTIVE =
    'Directive — lifecycle-first: first clear your PR lifecycle obligations, in priority order — ' +
    '(1) own PRs with red / unstable / stuck CI; (2) own green PRs that still need a reviewer routed; ' +
    '(3) reviews / re-reviews where you are the requested reviewer; (4) peer PRs you blocked with ' +
    'REQUEST_CHANGES once the author says addressed; (5) green peer PRs where you are a scarce viable ' +
    'cross-family reviewer (opening a same-family PR only grows that reviewer\'s queue). When that ' +
    'queue is clear, take the next unresolved step of the accepted plan; if none is ready, walk the ' +
    'outcome and post a ranked proposal. Never idle out, and never mint a lane to avoid it. ' +
    'Acknowledge pure-FYI broadcasts in one line.';

/**
 * @summary The directive a normal- or low-priority content wake ends with: the seat's own lane comes first.
 *
 * The wake exists for a seat that idled out, yet a working seat receives the same digest at its next turn
 * end and reads it as its next task. A side task taken mid-lane costs the lane its thread, and its
 * unsaved state if the side task reaches compaction. The events wait in the inbox, so finishing first loses
 * nothing. The release point is the lane's own: once it waits on someone else (CI, a reviewer, the
 * operator), its state is out of the seat, and holding the wakes past it would be an idle-out.
 *
 * @member {String} WAKE_DEFER_DIRECTIVE
 */
export const WAKE_DEFER_DIRECTIVE =
    'Directive — own lane first: while your current lane has a step you can take now, take it before ' +
    'acting on these, unless one of them is that step; they wait in your inbox. When your lane waits on ' +
    'someone else, or you have none, take them in lifecycle order.';

/**
 * @summary Picks the directive a wake digest ends with, or none.
 *
 * - Message, task or permission events at normal or low priority: `WAKE_DEFER_DIRECTIVE`.
 * - The same at high priority (operator steering, drain-first): none, since the wake interrupts.
 * - Heartbeat pulses alone, the idle watchdog's nudge: `WAKE_LANE_DIRECTIVE`. Content wakes vastly
 *   outnumber heartbeats, so the long lifecycle directive stays off them.
 *
 * @param {Object}  digest
 * @param {Boolean} digest.content   The digest carries message, task or permission events.
 * @param {Boolean} digest.heartbeat The digest carries heartbeat pulses.
 * @param {String}  digest.priority  The digest's header priority: `low`, `normal` or `high`.
 * @returns {String|null}
 */
export function selectWakeDirective({content, heartbeat, priority}) {
    if (content) {
        return priority === 'high' ? null : WAKE_DEFER_DIRECTIVE
    }

    return heartbeat ? WAKE_LANE_DIRECTIVE : null
}

export default WAKE_LANE_DIRECTIVE;
