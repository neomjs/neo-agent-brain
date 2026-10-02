import {setup} from '../../../../setup.mjs'

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'ProducerPrLaneEventsTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
})

import {test, expect} from '@playwright/test'
import Neo            from 'neo.mjs/src/Neo.mjs'
import * as core      from 'neo.mjs/src/core/_export.mjs'

import {
    createPrTransitionEvents,
    describeRetainedWindow,
    PR_LANE_TRANSITION_KINDS,
    withProducerPrLane
} from '../../../../../../ai/services/fleet/producerPrLaneEvents.mjs'
import {FLEET_COCKPIT_SOURCES} from '../../../../../../src/fleet/contract/cockpit.mjs'

const
    T0    = '2026-10-02T12:00:00.000Z',
    T1    = '2026-10-02T12:01:00.000Z',
    T2    = '2026-10-02T12:02:00.000Z',
    owner = {kind: 'seat', seat: '@neo-opus-vega', login: 'neo-opus-vega'};

/**
 * @summary One transition as the reducer records it.
 * @param {Object} fields
 * @returns {Object}
 */
function transition({repo = 'neomjs/neo-agent-brain', number = 764, head = 'da3bf6a', kind, from = null, to = null, pulse = T1}) {
    return {id: `${repo}#${number}@${head}:${kind}:${from}->${to}#${pulse}`, key: `${repo}#${number}`, repo, number, head, owner, kind, from, to, pulse}
}

/**
 * @summary A producer whose state is the given one.
 * @param {Object} state
 * @returns {{getState: Function}}
 */
function producerOf(state) {
    return {getState: () => state}
}

/**
 * @summary A base slot answer with one corpus PR event, one issue event and one stall event.
 * @returns {Object}
 */
function baseSnapshot() {
    return {
        capability: {source: FLEET_COCKPIT_SOURCES.activity, state: 'wired', confidence: 'observed', capturedAt: T0, reason: null},
        counts    : [],
        events    : [
            {eventId: 'github-workflow:pull-requests:neo#19360', type: 'pr-activity', source: FLEET_COCKPIT_SOURCES.githubPr, occurredAt: T2, payload: {number: 19360, repoSlug: 'neo'}},
            {eventId: 'github-workflow:issues:neo#19361', type: 'issue-activity', source: FLEET_COCKPIT_SOURCES.githubIssue, occurredAt: T0, payload: {number: 19361, repoSlug: 'neo'}},
            {eventId: 'graph:work-stall:x', type: 'work-stall', source: FLEET_COCKPIT_SOURCES.graphStall, occurredAt: T0, payload: {}}
        ]
    }
}

test.describe('producerPrLaneEvents — the PR lane over the open-work producer (#763)', () => {
    test('AC-1: the producer\'s transitions become pr-activity events for every repository; only the shown kinds, each at its observing pulse', () => {
        const events = createPrTransitionEvents([
            transition({repo: 'neomjs/neo-agent-brain', number: 764, kind: 'opened', to: 'open', pulse: T0}),
            transition({repo: 'neomjs/neo-agent-institution', number: 434, kind: 'verdict', from: null, to: 'APPROVED', pulse: T1}),
            transition({repo: 'neomjs/neo', number: 19364, kind: 'merged', from: 'open', to: 'merged', pulse: T2}),
            transition({repo: 'neomjs/neo', number: 19364, kind: 'head', from: 'a', to: 'b', pulse: T1}),
            transition({repo: 'neomjs/neo', number: 19364, kind: 'ci', from: null, to: 'green', pulse: T1}),
            transition({repo: 'neomjs/neo', number: 19364, kind: 'review-requested', from: null, to: '@neo-gpt-sophie', pulse: T1})
        ]);

        expect(PR_LANE_TRANSITION_KINDS).toEqual(['opened', 'verdict', 'merged', 'closed']);
        expect(events.map(event => [event.payload.repoSlug, event.payload.number, event.payload.transition.kind, event.occurredAt])).toEqual([
            ['neo-agent-brain',       764,   'opened',  T0],
            ['neo-agent-institution', 434,   'verdict', T1],
            ['neo',                   19364, 'merged',  T2]
        ]);

        const [opened, verdict, merged] = events;

        expect(opened).toMatchObject({
            eventId   : `${FLEET_COCKPIT_SOURCES.githubPr}:neomjs/neo-agent-brain#764@da3bf6a:opened:null->open#${T0}`,
            type      : 'pr-activity',
            source    : FLEET_COCKPIT_SOURCES.githubPr,
            agentId   : 'neo-opus-vega',
            confidence: 'observed',
            payload   : {kind: 'pull-request', repo: 'neomjs/neo-agent-brain', state: 'OPEN', reviewDecision: null, observedAt: T0, relatedPrs: [764], owner: {seat: '@neo-opus-vega'}}
        });
        expect(verdict.payload).toMatchObject({state: null, reviewDecision: 'APPROVED', transition: {from: null, to: 'APPROVED'}});
        expect(merged.payload).toMatchObject({state: 'MERGED', head: 'da3bf6a'})
    });

    test('AC-2: the base slot keeps its issue, lane-claim and stall events; its corpus PR events are replaced, the merge is ranked and bounded', async () => {
        const
            state = {observedAt: T2, coverage: 'complete', reason: null, transitions: [
                transition({kind: 'opened', to: 'open', pulse: T1}),
                transition({repo: 'neomjs/neo', number: 19364, kind: 'merged', from: 'open', to: 'merged', pulse: T2})
            ]},
            read  = withProducerPrLane(async () => baseSnapshot(), {producer: producerOf(state), now: () => Date.parse(T2)});

        const snapshot = await read({limit: 10});

        expect(snapshot.capability).toMatchObject({state: 'wired', confidence: 'observed', capturedAt: T0, reason: null});
        expect(snapshot.events.map(event => `${event.type}:${event.payload.number ?? event.eventId}`)).toEqual([
            'pr-activity:19364',
            'pr-activity:764',
            'issue-activity:19361',
            'work-stall:graph:work-stall:x'
        ]);
        expect(snapshot.events.some(event => event.eventId === 'github-workflow:pull-requests:neo#19360'), 'the corpus PR event is gone').toBe(false);

        const bounded = await read({limit: 1});

        expect(bounded.events.map(event => event.payload.number)).toEqual([19364])
    });

    test('AC-3: freshness is the producer\'s — a read long after the last pulse reports the producer\'s high-water time, not the read clock', async () => {
        const
            state    = {observedAt: T2, coverage: 'complete', reason: null, transitions: [transition({kind: 'opened', to: 'open', pulse: T2})]},
            readSoon = withProducerPrLane(null, {producer: producerOf(state), now: () => Date.parse(T2) + 60_000}),
            readLate = withProducerPrLane(null, {producer: producerOf(state), now: () => Date.parse(T2) + 20 * 60_000});

        const soon = await readSoon({limit: 10}),
              late = await readLate({limit: 10});

        expect(soon.capability.producer).toMatchObject({state: 'ok', observedAt: T2, coverage: 'complete'});
        expect(soon.capability.state).toBe('wired');
        expect(soon.events[0].payload.observedAt).toBe(T2);

        // twenty minutes after the pulse the same buffer is stale: the capability says so and still
        // names the producer's time, never the read's
        expect(late.capability.producer).toMatchObject({state: 'stale', observedAt: T2});
        expect(late.capability.state).toBe('degraded');
        expect(late.capability.reason).toContain(`stale since ${T2}`);
        expect(late.events[0].payload.observedAt).toBe(T2)
    });

    test('AC-4: a reader behind the retained window reads a coverage gap; inside it, or while the window is not full, there is none', async () => {
        const
            full  = {observedAt: T2, coverage: 'complete', reason: null, transitions: [
                transition({number: 1, kind: 'opened', to: 'open', pulse: T1}),
                transition({number: 2, kind: 'merged', from: 'open', to: 'merged', pulse: T2})
            ]},
            read  = withProducerPrLane(null, {producer: producerOf(full), now: () => Date.parse(T2), transitionWindow: 2});

        expect(describeRetainedWindow(full, {transitionWindow: 2})).toEqual({since: T1, size: 2, max: 2, full: true});

        const behind = await read({limit: 10, since: T0});

        expect(behind.capability.state).toBe('degraded');
        expect(behind.capability.reason).toContain(`transitions before ${T1} are not retained`);
        expect(behind.capability.producer.coverageGap).toEqual({requestedSince: T0, retainedSince: T1});
        expect(behind.events.map(event => event.payload.number)).toEqual([2, 1]);

        const inside = await read({limit: 10, since: T1});

        expect(inside.capability.state).toBe('wired');
        expect(inside.capability.producer.coverageGap).toBeNull();

        const roomy = withProducerPrLane(null, {producer: producerOf(full), now: () => Date.parse(T2), transitionWindow: 500});

        expect((await roomy({limit: 10, since: T0})).capability.producer.coverageGap, 'a window with room dropped nothing').toBeNull()
    });

    test('a failed base read is contained: the slot degrades naming it and still carries the producer\'s events', async () => {
        const
            state = {observedAt: T2, coverage: 'complete', reason: null, transitions: [transition({kind: 'opened', to: 'open', pulse: T2})]},
            read  = withProducerPrLane(async () => { throw new Error('plane get_pr_lane_activity answer unreadable') }, {producer: producerOf(state), now: () => Date.parse(T2)});

        const snapshot = await read({limit: 10});

        expect(snapshot.capability.state).toBe('degraded');
        expect(snapshot.capability.reason).toContain('base read: plane get_pr_lane_activity answer unreadable');
        expect(snapshot.events.map(event => event.payload.number)).toEqual([764])
    });

    test('a producer that has not pulsed degrades the slot naming it; the base events stand, no PR event is invented', async () => {
        const read = withProducerPrLane(async () => baseSnapshot(), {producer: () => producerOf({observedAt: null, coverage: 'unavailable', reason: 'no GitHub token', transitions: []}), now: () => Date.parse(T2)});

        const snapshot = await read({limit: 10});

        expect(snapshot.capability.state).toBe('degraded');
        expect(snapshot.capability.reason).toContain('open-work producer unavailable: no GitHub token');
        expect(snapshot.capability.producer).toMatchObject({state: 'unavailable', observedAt: null});
        expect(snapshot.events.map(event => event.type)).toEqual(['issue-activity', 'work-stall'])
    })
});
