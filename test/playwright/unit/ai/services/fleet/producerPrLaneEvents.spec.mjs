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
import {createFleetPrLaneActivitySnapshot}                    from '../../../../../../ai/services/fleet/fleetPrLaneActivityAdapter.mjs'
import {createPlanePrLaneActivityReader}                      from '../../../../../../ai/services/fleet/planePrLaneActivityReader.mjs'
import {createFleetActivityReadSource, FLEET_ACTIVITY_SLOTS} from '../../../../../../ai/services/fleet/fleetActivityComposer.mjs'
import {createOpenWorkProducer}                               from '../../../../../../ai/services/fleet/openWorkProducer.mjs'
import {FLEET_COCKPIT_SOURCES}                                from '../../../../../../src/fleet/contract/cockpit.mjs'

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
 * @summary A complete producer state at T2 with the given transitions.
 * @param {Object[]} transitions
 * @param {Object} [overrides]
 * @returns {Object}
 */
function stateAt(transitions, overrides = {}) {
    return {observedAt: T2, coverage: 'complete', reason: null, transitions, ...overrides}
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

/**
 * @summary The REAL base adapter over corpus facts: two corpus PRs newer than every other event, one
 * issue carrying a lane claim, one stall. A reader that bounds before replacing loses the issue rows.
 * @returns {{read: Function, calls: Object[]}}
 */
function realCorpusBase() {
    const calls = [];

    return {
        calls,
        read: async params => {
            calls.push({...params});

            return createFleetPrLaneActivitySnapshot({
                prs: [
                    {number: 19360, title: 'pr', state: 'MERGED', author: {login: 'neo-opus-vega'}, updatedAt: T2, repoSlug: 'neo'},
                    {number: 19359, title: 'pr', state: 'OPEN',   author: {login: 'neo-opus-vega'}, updatedAt: T2, repoSlug: 'neo'}
                ],
                issues: [{
                    number: 19361, title: 'issue', state: 'OPEN', updatedAt: T1, repoSlug: 'neo',
                    comments: {nodes: [{id: 'IC_lane', author: {login: 'neo-opus-vega'}, createdAt: T1, body: '[lane-claim] taking #19361'}]}
                }],
                stallFindings: [{findingClass: 'stalled-review', grade: 'stall', waitingSince: T0, subject: {repoSlug: 'neo', number: 1, owner: null}}],
                limit     : params.limit,
                prEvents  : params.prEvents,
                capturedAt: T0
            })
        }
    }
}

/**
 * @summary The composer over the wrapped slot and a quiet mailbox slot.
 * @param {Function} readPrLaneSnapshot
 * @returns {Object}
 */
function composed(readPrLaneSnapshot) {
    return createFleetActivityReadSource({
        readA2ASnapshot: async () => ({capability: {source: FLEET_COCKPIT_SOURCES.a2a, state: 'wired', confidence: 'observed', capturedAt: T0, reason: null}, counts: [], events: []}),
        readPrLaneSnapshot
    })
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
        const read = withProducerPrLane(async () => baseSnapshot(), {
            producer: producerOf(stateAt([
                transition({kind: 'opened', to: 'open', pulse: T1}),
                transition({repo: 'neomjs/neo', number: 19364, kind: 'merged', from: 'open', to: 'merged', pulse: T2})
            ])),
            now: () => Date.parse(T2)
        });

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

    test('AC-2 through the real base adapter: corpus PRs ahead of the surviving contributors and a small limit — the base is asked for no PR events at the full bound, so a removed PR displaces nothing', async () => {
        const
            base = realCorpusBase(),
            read = withProducerPrLane(base.read, {producer: producerOf(stateAt([transition({kind: 'merged', from: 'open', to: 'merged', pulse: T2})])), now: () => Date.parse(T2)});

        const snapshot = await read({limit: 2});

        expect(base.calls).toEqual([{limit: 200, prEvents: false}]);
        // the producer's PR first, then the newest surviving contributor — not two corpus PRs and nothing else
        expect(snapshot.events.map(event => `${event.type}:${event.payload.number ?? event.payload.issueNumber}`)).toEqual([
            'pr-activity:764',
            'issue-activity:19361'
        ]);

        const roomy = await read({limit: 10});

        expect(roomy.events.map(event => event.type)).toEqual(['pr-activity', 'issue-activity', 'lane-claim', 'work-stall']);
        expect(roomy.events.some(event => event.payload?.number === 19360 || event.payload?.number === 19359), 'no corpus PR event survives').toBe(false)
    });

    test('AC-2 in plane mode: the plane is asked the same way, and a plane that still answers PR events has them replaced before the bound', async () => {
        const
            calls      = [],
            planeFlag  = createPlanePrLaneActivityReader({callTool: async (name, args) => { calls.push(args); return realCorpusBase().read(args) }}),
            planeOld   = createPlanePrLaneActivityReader({callTool: async (name, args) => realCorpusBase().read({limit: args.limit})}),
            producer   = producerOf(stateAt([transition({kind: 'merged', from: 'open', to: 'merged', pulse: T2})])),
            now        = () => Date.parse(T2);

        const fresh = await withProducerPrLane(planeFlag, {producer, now})({limit: 2});

        expect(calls).toEqual([{limit: 200, prEvents: false}]);
        expect(fresh.events.map(event => event.type)).toEqual(['pr-activity', 'issue-activity']);

        // a plane older than the flag answers its PR events anyway: they are the corpus's, stripped here,
        // and the full bound it was asked for leaves the surviving contributors in reach
        const old = await withProducerPrLane(planeOld, {producer, now})({limit: 2});

        expect(old.events.map(event => `${event.type}:${event.payload.number ?? event.payload.issueNumber}`)).toEqual(['pr-activity:764', 'issue-activity:19361'])
    });

    test('AC-3: freshness is the producer\'s — a read long after the last pulse reports the producer\'s high-water time, not the read clock; partial coverage degrades', async () => {
        const
            state    = stateAt([transition({kind: 'opened', to: 'open', pulse: T2})]),
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
        expect(late.events[0].payload.observedAt).toBe(T2);

        // a fresh pulse whose page budget ran out is partial truth, and says so
        const partial = await withProducerPrLane(null, {producer: producerOf(stateAt([transition({kind: 'opened', to: 'open', pulse: T2})], {coverage: 'partial'})), now: () => Date.parse(T2)})({limit: 10});

        expect(partial.capability.state).toBe('degraded');
        expect(partial.capability.reason).toContain('coverage partial');
        expect(partial.capability.producer.coverage).toBe('partial');
        expect(partial.events).toHaveLength(1)
    });

    test('AC-4: a reader behind the covered window reads a coverage gap — at the window\'s first pulse too, since a full window may have cut inside it; inside, or while the window has room, there is none', async () => {
        const
            full  = stateAt([
                transition({number: 1, kind: 'opened', to: 'open', pulse: T1}),
                transition({number: 2, kind: 'merged', from: 'open', to: 'merged', pulse: T2})
            ]),
            read  = withProducerPrLane(null, {producer: producerOf(full), now: () => Date.parse(T2), transitionWindow: 2});

        expect(describeRetainedWindow(full, {transitionWindow: 2})).toEqual({since: T1, coveredSince: T2, size: 2, max: 2, full: true});

        const behind = await read({limit: 10, since: T0});

        expect(behind.capability.state).toBe('degraded');
        expect(behind.capability.reason).toContain(`transitions before ${T2} are not retained`);
        expect(behind.capability.producer.coverageGap).toEqual({requestedSince: T0, retainedSince: T1, coveredSince: T2});
        expect(behind.events.map(event => event.payload.number)).toEqual([2, 1]);

        // AT the oldest retained pulse: the window may have cut through that pulse, so it is a gap too
        const boundary = await read({limit: 10, since: T1});

        expect(boundary.capability.producer.coverageGap).toMatchObject({requestedSince: T1, coveredSince: T2});

        const inside = await read({limit: 10, since: T2});

        expect(inside.capability.state).toBe('wired');
        expect(inside.capability.producer.coverageGap).toBeNull();

        const roomy = withProducerPrLane(null, {producer: producerOf(full), now: () => Date.parse(T2), transitionWindow: 500});

        expect((await roomy({limit: 10, since: T0})).capability.producer.coverageGap, 'a window with room dropped nothing').toBeNull()
    });

    test('RA-3 producer → reader: three openings in one pulse through a window of two — a reader at that pulse reads a gap, not a healthy incomplete answer; an older cursor too; a roomy window covers all three', async () => {
        const
            identities = {byLogin: login => login === 'neo-opus-vega' ? '@neo-opus-vega' : null, byName: () => null},
            node       = number => ({
                number, headRefOid: 'h1', reviewDecision: null, mergeable: 'MERGEABLE', isDraft: false, body: '',
                author: {login: 'neo-opus-vega'}, repository: {nameWithOwner: 'neomjs/neo'},
                reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []},
                latestReviews : {pageInfo: {hasNextPage: false}, nodes: []},
                latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: []},
                commits       : {nodes: [{commit: {oid: 'h1', statusCheckRollup: {state: 'SUCCESS'}}}]}
            }),
            clock      = () => { let ms = Date.parse(T0); return () => new Date(ms += 60_000) },
            build      = async transitionWindow => {
                let open = [];

                const producer = createOpenWorkProducer({
                    query: async (text, {query}) => ({rateLimit: {cost: 1}, search: {nodes: query.includes('is:open') ? open : [], pageInfo: {hasNextPage: false, endCursor: null}}}),
                    repos: async () => ['neomjs/neo'],
                    identities,
                    now  : clock(),
                    transitionWindow
                });

                await producer.pulse();                       // the baseline records no transition
                open = [node(1), node(2), node(3)];
                const state = await producer.pulse();         // three openings observed in ONE pulse

                return {producer, state}
            };

        const {producer, state} = await build(2),
              pulse             = state.observedAt,
              read              = withProducerPrLane(null, {producer, now: () => Date.parse(pulse) + 1000, transitionWindow: 2});

        expect(state.transitions.map(transition => [transition.number, transition.kind, transition.pulse])).toEqual([[2, 'opened', pulse], [3, 'opened', pulse]]);

        const atPulse = await read({limit: 10, since: pulse});

        expect(atPulse.capability.producer.retained).toEqual({since: pulse, coveredSince: null, size: 2, max: 2, full: true});
        expect(atPulse.capability.state).toBe('degraded');
        expect(atPulse.capability.producer.coverageGap).toEqual({requestedSince: pulse, retainedSince: pulse, coveredSince: null});
        expect(atPulse.events.map(event => event.payload.number)).toEqual([2, 3]);

        const older = await read({limit: 10, since: T0});

        expect(older.capability.producer.coverageGap).toMatchObject({requestedSince: T0});

        const roomy = await build(500);

        const covered = await withProducerPrLane(null, {producer: roomy.producer, now: () => Date.parse(roomy.state.observedAt) + 1000, transitionWindow: 500})({limit: 10, since: roomy.state.observedAt});

        expect(covered.capability.state).toBe('wired');
        expect(covered.capability.producer.coverageGap).toBeNull();
        expect(covered.events.map(event => event.payload.number).sort()).toEqual([1, 2, 3])
    });

    test('RA-1 through the composer: the delivered snapshot carries the slot\'s producer contract under capability.slots, and the composite clock never replaces the producer\'s time', async () => {
        const
            pulseState = stateAt([transition({kind: 'opened', to: 'open', pulse: T2})]),
            slotOf     = snapshot => snapshot.capability.slots[FLEET_ACTIVITY_SLOTS.prLane];

        const fresh = await composed(withProducerPrLane(async () => baseSnapshot(), {producer: producerOf(pulseState), now: () => Date.parse(T2) + 60_000})).readActivitySnapshot({limit: 10});

        expect(fresh.capability.state).toBe('wired');
        expect(slotOf(fresh).producer).toMatchObject({state: 'ok', observedAt: T2, coverage: 'complete', coverageGap: null});
        expect(slotOf(fresh).capturedAt).toBe(T0);
        expect(fresh.capability.capturedAt).not.toBe(T2);
        expect(fresh.events.map(event => event.type)).toEqual(['pr-activity', 'issue-activity', 'work-stall']);

        const stale = await composed(withProducerPrLane(null, {producer: producerOf(pulseState), now: () => Date.parse(T2) + 20 * 60_000})).readActivitySnapshot({limit: 10});

        expect(stale.capability.state).toBe('degraded');
        expect(stale.capability.reason).toContain('pr-lane');
        expect(slotOf(stale).producer).toMatchObject({state: 'stale', observedAt: T2});

        const partial = await composed(withProducerPrLane(null, {producer: producerOf(stateAt([transition({kind: 'opened', to: 'open', pulse: T2})], {coverage: 'partial'})), now: () => Date.parse(T2)})).readActivitySnapshot({limit: 10});

        expect(partial.capability.state).toBe('degraded');
        expect(slotOf(partial).producer.coverage).toBe('partial');

        const gapState = stateAt([transition({number: 1, kind: 'opened', to: 'open', pulse: T1}), transition({number: 2, kind: 'merged', from: 'open', to: 'merged', pulse: T2})]),
              gap      = await composed(withProducerPrLane(null, {producer: producerOf(gapState), now: () => Date.parse(T2), transitionWindow: 2})).readActivitySnapshot({limit: 10, since: T0});

        expect(gap.capability.state).toBe('degraded');
        expect(slotOf(gap).producer.coverageGap).toEqual({requestedSince: T0, retainedSince: T1, coveredSince: T2});
        expect(slotOf(gap).producer.retained).toMatchObject({full: true, coveredSince: T2})
    });

    test('a failed base read is contained: the slot degrades naming it and still carries the producer\'s events', async () => {
        const read = withProducerPrLane(async () => { throw new Error('plane get_pr_lane_activity answer unreadable') }, {producer: producerOf(stateAt([transition({kind: 'opened', to: 'open', pulse: T2})])), now: () => Date.parse(T2)});

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
