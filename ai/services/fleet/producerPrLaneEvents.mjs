import {createFleetCockpitEvent, createFleetCockpitEventId} from './fleetCockpitStatus.mjs';
import {FLEET_ACTIVITY_BOUND_MAX}                           from './fleetActivityComposer.mjs';
import {FLEET_COCKPIT_SOURCES}                              from '../../../src/fleet/contract/cockpit.mjs';
import {projectOpenWork}                                    from './fleetOpenWorkSource.mjs';
import {redactCredentials}                                  from './redactCredentials.mjs';
import {TRANSITION_WINDOW}                                  from './openWorkProducer.mjs';

/**
 * @module ai/services/fleet/producerPrLaneEvents
 * @summary The PR/lane slot's pull-request contributor over the open-work producer: the transitions it
 * observed (opened, a review verdict with the reviewers who moved it, a push answering a change request,
 * merged, closed) become `pr-activity` events for every repository the
 * producer snapshots, each carrying the producer's observation time. The slot's capability carries the
 * producer's high-water time, coverage and declared retained window, so a reader behind that window reads
 * a coverage gap, never a silent loss. The issue, lane-claim and stall contributors stay on their own
 * sources, asked for without pull-request events and at the composer's maximum bound, so the final bound
 * is applied here, after the replacement, and a removed corpus PR can displace nothing. No reader here
 * sources GitHub.
 */

/**
 * @summary The transition kinds the PR lane shows. A push shows only when it answers a change request;
 * other pushes, CI and review-request churn stay with the open-work projection, where a holder reads them.
 */
export const PR_LANE_TRANSITION_KINDS = Object.freeze(['opened', 'verdict', 'head', 'merged', 'closed']);

const
    PR_STATE_BY_KIND = Object.freeze({opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED'}),
    REASON_MAX       = 240;

/**
 * @summary A reviewer key as a GitHub login: a seat (`@<login>`) or a `login:` key; a team names none.
 * @param {String} reviewer
 * @returns {String|null}
 * @private
 */
const loginOf = reviewer => /^(?:@|login:)([^/\s]+)$/.exec(reviewer ?? '')?.[1] ?? null;

/**
 * @summary One `pr-activity` event per retained transition of a shown kind, for every repository.
 * The event is the observation: its id is the transition's, its time the observing pulse. Its actor is
 * the PR's author, unless exactly one reviewer moved a verdict; the reviewers ride in `transition.by`.
 * @param {Object[]} transitions The producer's retained transitions.
 * @param {Object}   [options]
 * @param {String[]} [options.kinds=PR_LANE_TRANSITION_KINDS]
 * @returns {Object[]}
 */
export function createPrTransitionEvents(transitions = [], {kinds = PR_LANE_TRANSITION_KINDS} = {}) {
    return asArray(transitions)
        .filter(transition => typeof transition?.id === 'string' && kinds.includes(transition.kind)
            && (transition.kind !== 'head' || transition.verdict === 'CHANGES_REQUESTED')
            && Number.isInteger(transition.number) && !Number.isNaN(Date.parse(transition.pulse)))
        .map(transition => {
            const
                repo  = typeof transition.repo === 'string' && transition.repo ? transition.repo : null,
                owner = transition.owner ?? {},
                by    = asArray(transition.by);

            return createFleetCockpitEvent({
                eventId   : createFleetCockpitEventId(FLEET_COCKPIT_SOURCES.githubPr, transition.id),
                type      : 'pr-activity',
                source    : FLEET_COCKPIT_SOURCES.githubPr,
                agentId   : (by.length === 1 ? loginOf(by[0]) : null) ?? owner.login ?? null,
                confidence: 'observed',
                occurredAt: new Date(transition.pulse).toISOString(),
                payload   : {
                    kind          : 'pull-request',
                    number        : transition.number,
                    repo,
                    // the cockpit keys origins by the repository's own name, as the corpus does
                    repoSlug      : repo ? repo.split('/').pop() : null,
                    head          : transition.head ?? null,
                    state         : PR_STATE_BY_KIND[transition.kind] ?? null,
                    reviewDecision: transition.kind === 'verdict' ? transition.to ?? null : null,
                    owner         : {kind: owner.kind ?? null, seat: owner.seat ?? null, login: owner.login ?? null},
                    transition    : {kind: transition.kind, from: transition.from ?? null, to: transition.to ?? null, ...(by.length ? {by} : {})},
                    observedAt    : new Date(transition.pulse).toISOString(),
                    relatedPrs    : [transition.number],
                    relatedTickets: []
                }
            })
        })
}

/**
 * @summary The producer's retained window, declared conservatively. The producer keeps the newest
 * `max` transitions by count, so a full window may have cut inside one pulse: transitions of the oldest
 * retained pulse are not known to be complete. Coverage therefore begins at the first pulse after it
 * (`coveredSince`); a window with room dropped nothing and covers everything it holds.
 * @param {Object|null} state The producer's state.
 * @param {Object}      [options]
 * @param {Number}      [options.transitionWindow=TRANSITION_WINDOW]
 * @returns {{since: String|null, coveredSince: String|null, size: Number, max: Number, full: Boolean}}
 */
export function describeRetainedWindow(state, {transitionWindow = TRANSITION_WINDOW} = {}) {
    const
        transitions = asArray(state?.transitions),
        since       = transitions[0]?.pulse ?? null,
        full        = transitions.length >= transitionWindow;

    return {
        since,
        coveredSince: full ? transitions.find(transition => transition.pulse !== since)?.pulse ?? null : since,
        size        : transitions.length,
        max         : transitionWindow,
        full
    }
}

/**
 * @summary The PR/lane slot reader over a base reader and the open-work producer. The base reader
 * (the local corpus, or the plane's `get_pr_lane_activity`) keeps its issue, lane-claim and stall
 * events and is asked for them without pull-request events, at the composer's maximum bound; the
 * producer's transitions are the pull-request events; ranking and the caller's bound are applied last,
 * so a replaced corpus PR displaces no surviving event. A failed base read is contained: the slot
 * degrades naming it and still carries the producer's events. A producer that has not pulsed, whose
 * last pulse is stale or whose coverage is not complete degrades the slot naming the producer; its
 * freshness is the producer's `observedAt`, never this read's clock.
 * @param {Function|null} readBase `async params => {capability, counts, events}`, or null when this
 *     process has neither a corpus nor a plane to read.
 * @param {Object}   options
 * @param {Object|Function} options.producer `{getState}`, or a function answering it at read time
 *     (the Fleet server wires the producer after the slot).
 * @param {Function} [options.now] `() → epoch ms`.
 * @param {Number}   [options.transitionWindow=TRANSITION_WINDOW]
 * @param {Number}   [options.baseBound=FLEET_ACTIVITY_BOUND_MAX] The bound the base is asked for.
 * @returns {Function} `async params => {capability, counts, events}`
 */
export function withProducerPrLane(readBase, {producer, now = () => Date.now(), transitionWindow = TRANSITION_WINDOW, baseBound = FLEET_ACTIVITY_BOUND_MAX} = {}) {
    return async (params = {}) => {
        const
            capturedAt = new Date(now()).toISOString(),
            limit      = Number.isInteger(params.limit) && params.limit >= 0 ? params.limit : Infinity,
            since      = typeof params.since === 'string' && !Number.isNaN(Date.parse(params.since)) ? params.since : null,
            reasons    = [],
            events     = [];

        let base = null;

        if (typeof readBase === 'function') {
            try {
                // no pull-request events, and the whole bound: the replacement happens before this
                // reader bounds, never after the base already spent its bound on the PRs removed here
                base = await readBase({...params, limit: baseBound, prEvents: false})
            } catch (error) {
                reasons.push(`base read: ${normalizeReason(error)}`)
            }
        }

        if (base) {
            // a base that predates the flag still answers pull-request events; they are the corpus's, not the producer's
            events.push(...asArray(base.events).filter(event => event?.source !== FLEET_COCKPIT_SOURCES.githubPr))
        }

        if (base?.capability?.state && base.capability.state !== 'wired') {
            reasons.push(normalizeReason(base.capability.reason ?? base.capability.state))
        }

        const
            instance   = typeof producer === 'function' ? producer() : producer,
            state      = instance?.getState?.() ?? null,
            projection = state ? projectOpenWork(state, {now}) : null,
            retained   = describeRetainedWindow(state, {transitionWindow});

        let coverageGap = null;

        if (!projection || projection.state === 'unavailable') {
            reasons.push(`open-work producer unavailable: ${normalizeReason(state?.reason ?? 'no pulse yet')}`)
        } else {
            projection.state === 'stale' && reasons.push(`open-work producer stale since ${state.observedAt}`);
            state.coverage !== 'complete' && reasons.push(`open-work producer coverage ${state.coverage}`);

            // a reader asking from before the covered window: the window is full and the asked
            // instant lies before, or inside, the pulse the window cut through
            if (since && retained.full && (retained.coveredSince === null || Date.parse(since) < Date.parse(retained.coveredSince))) {
                coverageGap = {requestedSince: since, retainedSince: retained.since, coveredSince: retained.coveredSince};
                reasons.push(`pr lane: transitions before ${retained.coveredSince ?? 'the retained window'} are not retained`)
            }

            events.push(...createPrTransitionEvents(state.transitions))
        }

        return {
            capability: {
                source    : FLEET_COCKPIT_SOURCES.activity,
                state     : reasons.length ? 'degraded' : 'wired',
                confidence: reasons.length ? 'none' : 'observed',
                capturedAt: base?.capability?.capturedAt ?? capturedAt,
                reason    : reasons.length ? reasons.join(' · ').slice(0, REASON_MAX) : null,
                producer  : {
                    state      : projection?.state ?? 'unavailable',
                    observedAt : state?.observedAt ?? null,
                    coverage   : state?.coverage ?? 'unavailable',
                    retained,
                    coverageGap
                }
            },
            counts: asArray(base?.counts),
            events: events
                .filter(event => !since || Date.parse(event.occurredAt) >= Date.parse(since))
                .sort((a, b) => Date.parse(b.occurredAt || 0) - Date.parse(a.occurredAt || 0))
                .slice(0, Math.max(0, limit))
        }
    }
}

function normalizeReason(error) {
    return redactCredentials(String(error?.message || error || 'source unavailable')).replace(/\s+/g, ' ').slice(0, REASON_MAX)
}

function asArray(value) {
    return Array.isArray(value) ? value : []
}

export default withProducerPrLane;
