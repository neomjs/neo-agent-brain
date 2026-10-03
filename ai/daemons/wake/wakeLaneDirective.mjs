/**
 * @summary The single canonical source of the standing lane directive appended to pure-heartbeat wake digests.
 *
 * Extracted from the wake-daemon entry (`ai/daemons/wake/daemon.mjs`, whose `buildWakeDigest` imports it and
 * appends it ONLY to pure-heartbeat digests — the idle-watchdog nudge; message / task / permission wakes omit
 * it, since they already carry actionable content) so the directive text has ONE named, testable authority
 * the discussion / ticket / source wording cannot silently drift from.
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
 * Harness-agnostic prose: it carries no Claude-, Codex-, Gemini-, or Antigravity-specific payload
 * assumptions, so the same directive text is correct on every harness the wake daemon serves.
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

export default WAKE_LANE_DIRECTIVE;
