import {createFleetCockpitEvent, createFleetCockpitEventId} from './fleetCockpitStatus.mjs';
import {FLEET_COCKPIT_SOURCES}                              from '../../../src/fleet/contract/cockpit.mjs';
import {projectOpenWork}                                    from './fleetOpenWorkSource.mjs';
import {redactCredentials}                                  from './redactCredentials.mjs';
import {TRANSITION_WINDOW}                                  from './openWorkProducer.mjs';

/**
 * @module ai/services/fleet/producerPrLaneEvents
 * @summary The PR/lane slot's pull-request contributor over the open-work producer: the transitions it
 * observed (opened, review verdict, merged, closed) become `pr-activity` events for every repository the
 * producer snapshots, each carrying the producer's observation time. The slot's capability carries the
 * producer's high-water time and its retained window, so a reader behind that window reads a coverage
 * gap, never a silent loss. The issue, lane-claim and stall contributors stay on their own sources, and
 * no reader here sources GitHub.
 */

/**
 * @summary The transition kinds the PR lane shows. Head, CI and review-request churn stay with the
 * open-work projection, where a holder reads them.
 */
export const PR_LANE_TRANSITION_KINDS = Object.freeze(['opened', 'verdict', 'merged', 'closed']);

const
    PR_STATE_BY_KIND = Object.freeze({opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED'}),
    REASON_MAX       = 240;

/**
 * @summary One `pr-activity` event per retained transition of a shown kind, for every repository.
 * The event is the observation: its id is the transition's, its time the observing pulse.
 * @param {Object[]} transitions The producer's retained transitions.
 * @param {Object}   [options]
 * @param {String[]} [options.kinds=PR_LANE_TRANSITION_KINDS]
 * @returns {Object[]}
 */
export function createPrTransitionEvents(transitions = [], {kinds = PR_LANE_TRANSITION_KINDS} = {}) {
    return asArray(transitions)
        .filter(transition => typeof transition?.id === 'string' && kinds.includes(transition.kind)
            && Number.isInteger(transition.number) && !Number.isNaN(Date.parse(transition.pulse)))
        .map(transition => {
            const
                repo  = typeof transition.repo === 'string' && transition.repo ? transition.repo : null,
                owner = transition.owner ?? {};

            return createFleetCockpitEvent({
                eventId   : createFleetCockpitEventId(FLEET_COCKPIT_SOURCES.githubPr, transition.id),
                type      : 'pr-activity',
                source    : FLEET_COCKPIT_SOURCES.githubPr,
                agentId   : owner.login ?? null,
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
                    transition    : {kind: transition.kind, from: transition.from ?? null, to: transition.to ?? null},
                    observedAt    : new Date(transition.pulse).toISOString(),
                    relatedPrs    : [transition.number],
                    relatedTickets: []
                }
            })
        })
}

/**
 * @summary The producer's retained window, declared: where it begins, how much it holds, and whether
 * it is full — only a full window can have dropped a transition a reader has not seen.
 * @param {Object|null} state The producer's state.
 * @param {Object}      [options]
 * @param {Number}      [options.transitionWindow=TRANSITION_WINDOW]
 * @returns {{since: String|null, size: Number, max: Number, full: Boolean}}
 */
export function describeRetainedWindow(state, {transitionWindow = TRANSITION_WINDOW} = {}) {
    const transitions = asArray(state?.transitions);

    return {
        since: transitions[0]?.pulse ?? null,
        size : transitions.length,
        max  : transitionWindow,
        full : transitions.length >= transitionWindow
    }
}

/**
 * @summary The PR/lane slot reader over a base reader and the open-work producer. The base reader
 * (the local corpus, or the plane's `get_pr_lane_activity`) keeps its issue, lane-claim and stall
 * events; its pull-request events are replaced by the producer's transitions. A failed base read is
 * contained: the slot degrades naming it and still carries the producer's events. A producer that has
 * not pulsed, or whose last pulse is stale, degrades the slot naming the producer; its freshness is the
 * producer's `observedAt`, never this read's clock.
 * @param {Function|null} readBase `async params => {capability, counts, events}`, or null when this
 *     process has neither a corpus nor a plane to read.
 * @param {Object}   options
 * @param {Object|Function} options.producer `{getState}`, or a function answering it at read time
 *     (the Fleet server wires the producer after the slot).
 * @param {Function} [options.now] `() → epoch ms`.
 * @param {Number}   [options.transitionWindow=TRANSITION_WINDOW]
 * @returns {Function} `async params => {capability, counts, events}`
 */
export function withProducerPrLane(readBase, {producer, now = () => Date.now(), transitionWindow = TRANSITION_WINDOW} = {}) {
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
                base = await readBase(params)
            } catch (error) {
                reasons.push(`base read: ${normalizeReason(error)}`)
            }
        }

        if (base) {
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

            if (since && retained.full && retained.since && Date.parse(since) < Date.parse(retained.since)) {
                coverageGap = {requestedSince: since, retainedSince: retained.since};
                reasons.push(`pr lane: transitions before ${retained.since} are not retained`)
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
