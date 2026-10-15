import {FLEET_COCKPIT_EVENT_TYPES, FLEET_COCKPIT_SOURCES} from '../../../src/fleet/contract/cockpit.mjs';
import {PRESENCE_BEACON_FACETS}                           from './fleetPresenceStateAdapter.mjs';

const GITHUB_AVATAR_SIZE = 80 // small cockpit-appropriate size (~2x the 40px card avatar); GitHub serves it via the `size` param

/**
 * @summary Derive an agent's profile-avatar URL from its GitHub account. The crafted per-agent avatars
 * live on the agents' GitHub accounts, so the sized avatar is fetchable directly from the username via
 * GitHub's `https://github.com/{username}.png?size=N` endpoint — no manual avatar write needed for the
 * common case. Returns null when there is no username to derive from.
 * @param {String|null} githubUsername
 * @returns {String|null}
 */
function githubAvatarUrl(githubUsername) {
    return githubUsername ? `https://github.com/${githubUsername}.png?size=${GITHUB_AVATAR_SIZE}` : null
}

/**
 * @summary Build the first Fleet Manager cockpit snapshot from the already-shipped bridge reads:
 * `listAgents()` for the redacted roster, `fleetStatus()` for repo-provisioning state, and
 * `fleetRuntimeStatus()` for live process truth when the assembler supplies it. A2A/PR/lane activity
 * stays an explicit capability slot, not guessed browser state; an unwired adapter is rendered as
 * `not-wired` so Lane 1 never mistakes placeholder data for fact.
 *
 * Identity display facts (`family` + `engineTag`) pass through from the supplied agents when the
 * Brain-side assembler enriched them (the `resolveIdentityDisplay` join at the assembler — this Body-side
 * map stays pure and never imports `ai/graph`); un-enriched agents yield `null`, which the cockpit
 * renders as unclassified / tagless, never guessed.
 *
 * @param {Object}   options={}
 * @param {Object[]} options.agents        Public agent definitions from `registryBridge.listAgents()`,
 *     optionally identity-enriched with `family` / `engineTag` by the assembler.
 * @param {Object[]} options.fleetStatus   Repo-status entries from `registryBridge.fleetStatus()`.
 * @param {Object[]} options.runtimeStatus Optional per-agent process entries from
 *     `registryBridge.fleetRuntimeStatus()` — rows carry an observed `lifecycle` when present.
 * @param {Object}   [options.laneStatus] The activity source's held lanes for this viewer,
 *     `{a2a: {capability, entries}, forge: {assignments, capability, claims}|null}`. A seat's lane is its newest
 *     explicit claim across the A2A record and its forge's open issues, unless a newer A2A release ended it; with
 *     no standing claim, the open issue assigned to it fills the line as `inferred`, without a claim time. Logins
 *     join only to `githubUsername`, never the registry key, and a GitLab seat reads no GitHub forge facts.
 * @param {Object[]} options.events        Optional already-normalized cockpit events.
 * @param {Object}   options.capabilities  Optional source-capability overrides from wired adapters.
 * @returns {Object} serializable cockpit DTO `{sources, capabilities, rows, events}`.
 */
export function createFleetCockpitStatus({agents = [], fleetStatus = [], runtimeStatus = [], wakeStatus = [], throttleStatus = [], presenceStatus = [], laneStatus = null, events = [], capabilities = {}} = {}) {
    const suppliedCapabilities = capabilities || {}

    const statusByAgentId = new Map(
        fleetStatus.map(status => [status.agentId || status.id, sanitizePayload(status)])
    )

    const runtimeByAgentId = new Map(
        runtimeStatus.map(entry => [entry.agentId || entry.id, sanitizePayload(entry)])
    )

    const wakeByAgentId = new Map(
        wakeStatus.map(entry => [entry.agentId || entry.id, sanitizePayload(entry)])
    )

    const throttleByAgentId = new Map(
        throttleStatus.map(entry => [entry.agentId || entry.id, sanitizePayload(entry)])
    )

    const presenceByAgentId = new Map(
        presenceStatus.map(entry => [entry.agentId || entry.id, sanitizePayload(entry)])
    )

    const laneCapability = laneStatus == null
              ? {...createNotWiredCapability(FLEET_COCKPIT_SOURCES.a2a, 'no lane observation held in this process yet'), capturedAt: null, policy: null, scanned: null}
              : heldLaneCapability(laneStatus.a2a?.capability, FLEET_COCKPIT_SOURCES.a2a),
          forgeCapability = laneStatus?.forge == null
              ? {...createNotWiredCapability(FLEET_COCKPIT_SOURCES.commentLane, 'no PR/lane read held in this process yet'), capturedAt: null}
              : heldLaneCapability(laneStatus.forge.capability, FLEET_COCKPIT_SOURCES.commentLane),
          laneByLogin     = foldLanes(laneStatus);

    // The newest ATTRIBUTABLE activity instant per agent, folded from the supplied normalized
    // events (their `occurredAt`) — one pass, so the per-row stamp below is a lookup. Only events
    // carrying both an `agentId` and a parseable instant participate; the fold keeps the
    // producer's original ISO string (never re-formats), because the stamp is a passthrough fact.
    const lastActivityByAgentId = new Map()

    for (const event of events) {
        const {agentId, occurredAt} = event || {}

        if (agentId && typeof occurredAt === 'string' && !Number.isNaN(Date.parse(occurredAt))) {
            const known = lastActivityByAgentId.get(agentId)

            if (!known || Date.parse(occurredAt) > Date.parse(known)) {
                lastActivityByAgentId.set(agentId, occurredAt)
            }
        }
    }

    return {
        sources     : FLEET_COCKPIT_SOURCES,
        capabilities: {
            activity: suppliedCapabilities.activity || createNotWiredCapability(FLEET_COCKPIT_SOURCES.activity, 'A2A / PR / lane activity adapter not wired'),
            runtime : suppliedCapabilities.runtime || createNotWiredCapability(FLEET_COCKPIT_SOURCES.runtime, 'runtime process status is pending the Fleet runtime-status wire method'),
            // The wake telltale axis (S2): four-state observation (`on | off | suppressed |
            // unknown`) produced Brain-side; not-wired here is the honest default until the
            // assembler passes a snapshot — the pane renders "cannot see", never a guessed state.
            wake    : suppliedCapabilities.wake || createNotWiredCapability(FLEET_COCKPIT_SOURCES.wake, 'wake-state producer not wired'),
            // The throttle telltale axis (S2), same contract as wake: `none | overage |
            // rate-limited | unknown`. No trustworthy platform source exists yet, so this axis is
            // expected to sit degraded — which is the honest report, not a gap to paper over.
            throttle: suppliedCapabilities.throttle || createNotWiredCapability(FLEET_COCKPIT_SOURCES.throttle, 'throttle-state producer not wired'),
            // The presence axis: the plane's who_is_online band embryo (`online |
            // idle | dark | benched | neverConnected | unknown`), the third independent signal —
            // presence-fresh ≠ wake-route-healthy ≠ identity-bound. Not-wired is the honest
            // default until the assembler passes a snapshot; a band is never guessed.
            presence: suppliedCapabilities.presence || createNotWiredCapability(FLEET_COCKPIT_SOURCES.presence, 'presence producer not wired'),
            // The lane sources the active sharing mode admitted: the A2A observation, `wired` only at team
            // breadth, and the forge's issues, which every mode reads
            lane     : laneCapability,
            forgeLane: forgeCapability
        },
        rows: agents.map(agent => {
            const publicAgent = sanitizePayload(agent),
                  agentId     = publicAgent.id,
                  repoStatus  = statusByAgentId.get(agentId) || null,
                  runtime     = runtimeByAgentId.get(agentId) || null,
                  // Runtime supervision is wired for this row only when the producer actually holds a
                  // process record — NOT merely because a row came back. `fleetRuntimeStatus` answers
                  // for every REGISTERED agent by design, so row-existence is a roster fact, and
                  // reading it as a supervision fact is what let a `benched / offline` verdict render
                  // over seats the fleet never launched. An `unmanaged` row is the producer
                  // stating it observes nothing here; the honest source state for that is `not-wired`,
                  // which the display contract already renders as the external-harness topology.
                  supervised  = runtime != null && runtime.state !== 'unmanaged',
                  wake        = wakeByAgentId.get(agentId) || null,
                  throttle    = throttleByAgentId.get(agentId) || null,
                  presence    = presenceByAgentId.get(agentId) || null,
                  gitlab      = publicAgent.forge === 'gitlab',
                  lane        = typeof publicAgent.githubUsername === 'string' && publicAgent.githubUsername
                      ? laneOf(laneByLogin.get(publicAgent.githubUsername), {githubForge: !gitlab})
                      : null

            return {
                id            : agentId,
                githubUsername: publicAgent.githubUsername ?? null,
                harnessType   : publicAgent.harnessType ?? null,
                // Launch-derived truth stamped by the Brain-side assembler (fleetRoster) — hoisted
                // like the identity facts below, tri-state honest: null = not stamped/unknown
                // ("not read back yet"), never a guessed boolean. This pure map derives nothing.
                launchable   : publicAgent.launchable ?? null,
                launchRefusal: publicAgent.launchRefusal ?? null,
                authMode     : publicAgent.authMode ?? null,
                // Open assigned lanes for the resident, stamped by a Brain-side enricher when one
                // exists — the roster DTO OWNS this field end-to-end (assembler → cockpit record →
                // card badge). Same tri-state honesty as `launchable`: null = no enricher has
                // stamped a count, and the card renders NO badge then — never a fabricated zero.
                openLaneCount: publicAgent.openLaneCount ?? null,
                laneLine     : lane?.laneLine ?? null,
                laneClaimedAt: lane?.laneClaimedAt ?? null,
                // the source that answered the line, `{source, confidence}`; null without a line
                laneSource   : lane?.laneSource ?? null,
                // The newest attributable per-agent activity instant, stamped HERE from what this
                // assembler already holds: the activity-event fold above merged with the presence
                // producer's own `lastSeenAt` recency. Tri-state honest like its siblings — null =
                // no attributable instant exists, and a recency sort places such a row LAST rather
                // than inventing an age. Never view-derived: a client folding the activity feed
                // would create a second truth the producer cannot correct.
                lastActivityAt: (() => {
                    const
                        fromEvents   = lastActivityByAgentId.get(agentId) ?? null,
                        fromPresence = typeof presence?.lastSeenAt === 'string' && !Number.isNaN(Date.parse(presence.lastSeenAt))
                            ? presence.lastSeenAt
                            : null

                    if (fromEvents && fromPresence) {
                        return Date.parse(fromEvents) >= Date.parse(fromPresence) ? fromEvents : fromPresence
                    }

                    return fromEvents ?? fromPresence
                })(),
                displayName: publicAgent.displayName ?? publicAgent.name ?? publicAgent.githubUsername ?? agentId ?? null,
                avatarUrl  : publicAgent.metadata?.avatarUrl ?? githubAvatarUrl(publicAgent.githubUsername),
                family     : publicAgent.family ?? null,
                engineTag  : publicAgent.engineTag ?? null,
                // The AUTHORITATIVE swarm-participation fact, the seat's identity node as the Brain-side
                // assembler stamped it from the presence report — hoisted so fleet-level control eligibility
                // can exclude an operator-benched seat. null = no node for the seat, or a read that never
                // answered; `participationRead` tells the two apart, and the reason and date are the operator's.
                participationStatus: publicAgent.participationStatus ?? null,
                participationReason: publicAgent.participationReason ?? null,
                participationSince : publicAgent.participationSince ?? null,
                participationRead  : publicAgent.participationRead ?? null,
                agent              : publicAgent,
                repoStatus,
                // the last start's per-repository outcome from the launch record; null before a start
                repoOutcomes: runtime?.repos ?? null,
                // each checkout's dependency row from the latest start that reached its install, the working one first:
                // live while that start is pending (`installing` only then), its final rows after; null before one
                dependencyOutcomes: runtime?.dependencies ?? null,
                // where a running Claude Desktop seat's session opened, against its checkout; null
                // for every other family and every seat not running
                sessionFolder: runtime?.sessionFolder ?? null,
                exitReason   : runtime?.exitReason ?? null,
                // the Git identity the last start resolved, a refused start's included; null before a start
                gitIdentity  : runtime?.gitIdentity ?? null,
                // the model and effort a Codex seat's config is set to now (configured state, never what a
                // chat runs on); null for every other family
                harnessSettings: runtime?.harnessSettings ?? null,
                // what the last start found of the declared model in the harness's catalog, a refusal's
                // reason included; null before a start read one
                seatModel      : runtime?.seatModel ?? null,
                // whether a Claude Desktop seat's profile rows can start new MCP children (the
                // `launchAdmission` contract); null for every other family and before a start
                launchAdmission      : runtime?.launchAdmission ?? null,
                runtimeGeneration    : runtime?.runtimeGeneration ?? null,
                installedGeneration  : runtime?.installedGeneration ?? null,
                nextRuntimeGeneration: runtime?.nextRuntimeGeneration ?? null,
                lifecycle            : supervised
                    ? {
                        source    : FLEET_COCKPIT_SOURCES.runtime,
                        state     : runtime.state ?? 'unknown',
                        confidence: runtime.confidence ?? 'observed'
                    }
                    : {
                        source    : FLEET_COCKPIT_SOURCES.runtime,
                        state     : 'not-wired',
                        confidence: 'none'
                    },
                // The S2 wake telltale axis: the four-state observation row produced Brain-side.
                // `state` is CLOSED over `on | off | suppressed | unknown` — absence of a producer
                // is `unknown`, never a fifth value: consumers switch on this enum, so leaking a
                // wiring fact into the observation field would force every one of them to re-derive
                // the taxonomy. The wiring axis is carried by `sources.wake` + the capability
                // envelope, and `confidence: 'none'` + `reason` keep the row itself honest.
                wake: wake
                    ? {
                        source    : FLEET_COCKPIT_SOURCES.wake,
                        state     : wake.wake ?? 'unknown',
                        confidence: wake.confidence ?? 'none',
                        ...(wake.reason != null && {reason: wake.reason})
                    }
                    : {
                        source    : FLEET_COCKPIT_SOURCES.wake,
                        state     : 'unknown',
                        confidence: 'none',
                        reason    : 'wake-state producer not wired'
                    },
                // The S2 throttle axis, held to the same closed-enum contract as `wake` above:
                // `state` never leaves `none | overage | rate-limited | unknown`, absence included.
                throttle: throttle
                    ? {
                        source    : FLEET_COCKPIT_SOURCES.throttle,
                        state     : throttle.throttle ?? 'unknown',
                        confidence: throttle.confidence ?? 'none',
                        ...(throttle.reason != null && {reason: throttle.reason})
                    }
                    : {
                        source    : FLEET_COCKPIT_SOURCES.throttle,
                        state     : 'unknown',
                        confidence: 'none',
                        reason    : 'throttle-state producer not wired'
                    },
                // The presence axis, same closed-enum discipline as its siblings:
                // `state` never leaves the plane's band embryo + `unknown`, absence of a producer
                // included. `lastSeenAt` carries the producer's per-seat recency verbatim — the
                // tier-degradation contract forbids deriving a finer band here than was emitted.
                // `beacon` rides through untouched when the producer emitted one of its closed
                // facets (fresh · stale · absent · unobserved); an older producer sends none and
                // the row carries none — the consumer keeps its fallback, nothing is inferred.
                presence: presence
                    ? {
                        source    : FLEET_COCKPIT_SOURCES.presence,
                        state     : presence.presence ?? 'unknown',
                        confidence: presence.confidence ?? 'none',
                        lastSeenAt: presence.lastSeenAt ?? null,
                        ...(PRESENCE_BEACON_FACETS.includes(presence.beacon) && {beacon: presence.beacon}),
                        ...(presence.reason != null && {reason: presence.reason})
                    }
                    : {
                        source    : FLEET_COCKPIT_SOURCES.presence,
                        state     : 'unknown',
                        confidence: 'none',
                        lastSeenAt: null,
                        reason    : 'presence producer not wired'
                    },
                // Every fact owns its bounded `reason` at THIS producer boundary — the consumer
                // renders name+reason for answered-abnormal facts, and a reason invented anywhere
                // downstream would be a fixture-truth (the review-caught defect this closes).
                // Wired facts pass the underlying row's own cause through (null when it carries
                // none); an ABSENT per-agent row states which truth is missing; not-wired axes
                // carry the axis-level explanation. All bounded via `boundReason`.
                sources: {
                    roster: {
                        source    : FLEET_COCKPIT_SOURCES.roster,
                        state     : 'wired',
                        confidence: 'observed',
                        reason    : null
                    },
                    repoStatus: {
                        source    : FLEET_COCKPIT_SOURCES.repoStatus,
                        state     : repoStatus ? 'wired' : 'missing',
                        confidence: repoStatus ? 'observed' : 'none',
                        reason    : repoStatus ? boundReason(repoStatus.reason) : 'no repository status answered for this agent'
                    },
                    runtime: {
                        source    : FLEET_COCKPIT_SOURCES.runtime,
                        state     : supervised ? 'wired' : 'not-wired',
                        confidence: supervised ? (runtime.confidence ?? 'observed') : 'none',
                        // An unmanaged row carries its OWN cause ("no fleet process record …"), which is
                        // strictly more informative than the axis-level not-wired default and must not be
                        // overwritten by it — the default describes a missing WIRE, this describes a
                        // present producer observing nothing for this agent.
                        reason    : supervised
                            ? boundReason(runtime.reason)
                            : (runtime?.reason
                                ? boundReason(runtime.reason)
                                : 'runtime process status is pending the Fleet runtime-status wire method')
                    },
                    wake: {
                        source    : FLEET_COCKPIT_SOURCES.wake,
                        state     : wake ? 'wired' : 'not-wired',
                        confidence: wake ? (wake.confidence ?? 'none') : 'none',
                        reason    : wake ? boundReason(wake.reason) : 'wake-state producer not wired'
                    },
                    throttle: {
                        source    : FLEET_COCKPIT_SOURCES.throttle,
                        state     : throttle ? 'wired' : 'not-wired',
                        confidence: throttle ? (throttle.confidence ?? 'none') : 'none',
                        reason    : throttle ? boundReason(throttle.reason) : 'throttle-state producer not wired'
                    },
                    lane: {
                        source    : laneCapability.source,
                        state     : laneCapability.state,
                        confidence: laneCapability.confidence,
                        reason    : laneCapability.reason
                    },
                    forgeLane: gitlab
                        ? createNotWiredCapability(FLEET_COCKPIT_SOURCES.commentLane, 'no GitLab lane reader yet')
                        : {
                            source    : forgeCapability.source,
                            state     : forgeCapability.state,
                            confidence: forgeCapability.confidence,
                            reason    : forgeCapability.reason
                        },
                    presence: {
                        source    : FLEET_COCKPIT_SOURCES.presence,
                        state     : presence ? 'wired' : 'not-wired',
                        confidence: presence ? (presence.confidence ?? 'none') : 'none',
                        reason    : presence ? boundReason(presence.reason) : 'presence producer not wired'
                    }
                }
            }
        }),
        events: events.map(event => createFleetCockpitEvent(event))
    }
}

/**
 * @summary Normalize a bounded fleet cockpit activity event. The type set is intentionally narrow so
 * UI and whitebox tests can prove lifecycle request/success/failure and bridge unavailable/gated
 * states without inventing opaque free-form activity.
 * @param {Object} event
 * @returns {Object}
 */
export function createFleetCockpitEvent({eventId = null, type, source, agentId = null, confidence = 'observed', payload = null, occurredAt = null} = {}) {
    if (!FLEET_COCKPIT_EVENT_TYPES.includes(type)) {
        throw new Error(`createFleetCockpitEvent: unsupported event type '${type}'`)
    }
    if (!source) {
        throw new Error('createFleetCockpitEvent: source is required')
    }

    return {
        eventId,
        type,
        source,
        agentId,
        confidence,
        occurredAt,
        payload: sanitizePayload(payload)
    }
}

/**
 * @summary Builds the producer-owned identity used by the Fleet activity Store.
 *
 * The source prefix is load-bearing: a pull request and an issue can share a number and still be
 * different durable facts, and a view that keys both by the bare number silently aliases them. Producers pass their own native identity here;
 * an absent identity returns `null` so the adapter can omit the event instead of letting the
 * consumer invent a presentation-derived key.
 * @param {String} source Stable producer namespace.
 * @param {String|Number|null} nativeId Stable identity inside that producer.
 * @returns {String|null}
 */
export function createFleetCockpitEventId(source, nativeId) {
    const sourceKey = typeof source === 'string' ? source.trim() : '',
          identity  = typeof nativeId === 'string' || typeof nativeId === 'number'
              ? String(nativeId).trim()
              : '';

    return sourceKey && identity ? `${sourceKey}:${identity}` : null
}

/**
 * @summary Capability placeholder for adapters that are planned but not wired. A missing adapter is a
 * first-class fact, not sample data.
 * @param {String} source
 * @param {String} reason
 * @returns {Object}
 */
export function createNotWiredCapability(source, reason) {
    return {
        source,
        state     : 'not-wired',
        confidence: 'none',
        reason
    }
}

/**
 * @summary Bound a producer-supplied cause to a serializable trimmed string, or `null` — the DTO
 * owns every reason it emits, and an unbounded upstream string must not ride the wire unchecked.
 * @param {*} value
 * @returns {String|null}
 */
export function boundReason(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

/**
 * @summary One held lane source's capability, bounded at this producer. A held source without a valid state reads
 * `degraded`, and {@link foldLanes} takes none of its facts.
 * @param {*} capability The held source's capability.
 * @param {String} source The lane source literal.
 * @returns {Object} `{source, state, confidence, reason, capturedAt}`, plus `policy` and `scanned` for the A2A source.
 * @private
 */
function heldLaneCapability(capability, source) {
    const valid = ['wired', 'degraded', 'not-wired'].includes(capability?.state)

    return {
        source,
        state     : valid ? capability.state : 'degraded',
        confidence: valid ? (capability.confidence ?? 'none') : 'none',
        reason    : boundReason(capability?.reason) ?? (valid ? null : 'held lane source has no valid capability'),
        capturedAt: capability?.capturedAt ?? null,
        ...(source === FLEET_COCKPIT_SOURCES.a2a && {
            policy : typeof capability?.policy === 'string' ? capability.policy : null,
            scanned: Number.isInteger(capability?.scanned) && capability.scanned >= 0 ? capability.scanned : null
        })
    }
}

/**
 * @summary Each login's lane candidates across the held lane sources, folded once before the rows join: its newest
 * A2A entry (a claim or a release), its newest forge claim and its newest open assignment. A source lends its facts
 * only while its held capability answered, and a malformed fact never displaces a valid one.
 * @param {Object|null} laneStatus
 * @returns {Map<String, Object>} login → `{a2a, claim, assignment}`, each `{claimedAt, laneClaimedAt, laneLine, laneSource}`.
 * @private
 */
function foldLanes(laneStatus) {
    const
        byLogin  = new Map(),
        answered = capability => capability?.state === 'wired' || capability?.state === 'degraded',
        facts    = value => (Array.isArray(value) ? value : []).filter(Boolean),
        isLine   = value => typeof value === 'string' && Boolean(value.trim()),
        keep     = (kind, agentId, occurredAt, fact) => {
            const claimedAt = typeof occurredAt === 'string' ? Date.parse(occurredAt) : NaN

            if (typeof agentId !== 'string' || !agentId.trim() || agentId.startsWith('@') || !Number.isFinite(claimedAt)) {
                return
            }

            const candidates = byLogin.get(agentId) ?? {}

            if (!candidates[kind] || claimedAt > candidates[kind].claimedAt) {
                byLogin.set(agentId, {...candidates, [kind]: {...fact, claimedAt}})
            }
        }

    if (answered(laneStatus?.a2a?.capability)) {
        for (const {agentId, collisionTag, occurredAt, subject} of facts(laneStatus.a2a.entries)) {
            if (collisionTag === 'claim-corrected') {
                keep('a2a', agentId, occurredAt, {laneClaimedAt: occurredAt, laneLine: null, laneSource: null})
            } else if (collisionTag === 'lane-claim' && isLine(subject)) {
                keep('a2a', agentId, occurredAt, {laneClaimedAt: occurredAt, laneLine: subject, laneSource: {source: FLEET_COCKPIT_SOURCES.a2a, confidence: 'observed'}})
            }
        }
    }

    if (answered(laneStatus?.forge?.capability)) {
        for (const {agentId, line, occurredAt} of facts(laneStatus.forge.claims)) {
            isLine(line) && keep('claim', agentId, occurredAt, {laneClaimedAt: occurredAt, laneLine: line, laneSource: {source: FLEET_COCKPIT_SOURCES.commentLane, confidence: 'observed'}})
        }

        // an assignment carries the issue's last change, never a claim time
        for (const {agentId, line, occurredAt} of facts(laneStatus.forge.assignments)) {
            isLine(line) && keep('assignment', agentId, occurredAt, {laneClaimedAt: null, laneLine: line, laneSource: {source: FLEET_COCKPIT_SOURCES.githubIssue, confidence: 'inferred'}})
        }
    }

    return byLogin
}

/**
 * @summary One seat's lane from its {@link foldLanes} candidates: the newer explicit entry of its A2A record and its
 * forge claims, unless that entry is a release; with no standing claim, its open assignment.
 * @param {Object|undefined} candidates
 * @param {Object} options
 * @param {Boolean} options.githubForge Whether the seat's forge is the GitHub one its forge facts were read from.
 * @returns {Object|null} `{laneClaimedAt, laneLine, laneSource}`
 * @private
 */
function laneOf(candidates, {githubForge}) {
    const
        {a2a, assignment, claim} = candidates ?? {},
        forgeClaim               = githubForge ? claim : null,
        explicit                 = a2a && forgeClaim ? (forgeClaim.claimedAt > a2a.claimedAt ? forgeClaim : a2a) : a2a ?? forgeClaim

    if (explicit?.laneLine) {
        return explicit
    }

    return githubForge ? assignment ?? null : null
}

function sanitizePayload(value) {
    if (Array.isArray(value)) {
        return value.map(item => sanitizePayload(item))
    }

    if (!value || typeof value !== 'object') {
        return value
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => !isSecretKey(key))
            .map(([key, item]) => [key, sanitizePayload(item)])
    )
}

function isSecretKey(key) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')

    return normalized === 'credential' ||
        normalized.endsWith('credential') ||
        normalized === 'pat' ||
        normalized.endsWith('pat') ||
        normalized.includes('token') ||
        normalized.includes('secret') ||
        normalized.includes('password') ||
        normalized.includes('signingkey') ||
        normalized.includes('privatekey')
}
