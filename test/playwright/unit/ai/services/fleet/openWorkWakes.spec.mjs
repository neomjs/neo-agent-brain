import {expect, test}                                                     from '@playwright/test';
import {SILENT_AFTER_MS, SWITCH_ON_BOUNDS, planOpenWorkWakes, wakeGateOf} from '../../../../../../ai/services/fleet/openWorkWakes.mjs';

const
    author  = {kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'},
    outside = {kind: 'outside', seat: null, login: 'contributor'},
    row     = (overrides = {}) => ({
        key: 'neomjs/neo#1', repo: 'neomjs/neo', number: 1, head: 'h1', ci: 'green', verdict: null, mergeable: 'MERGEABLE',
        draft: false, owner: author, requested: [], reviews: [], opinions: [], requestsComplete: true, partial: false, ...overrides
    }),
    snapshot = (...rows) => ({rows: Object.fromEntries(rows.map(item => [item.key, item]))}),
    seats    = () => ['@neo-gpt', '@neo-opus-grace'],
    // one round after a baseline that saw `before`
    plan     = (before, after, options = {}) => {
        const seeded = planOpenWorkWakes({snapshot: before, ledger: null, now: 0, seatsForRepo: seats, ...options});

        return planOpenWorkWakes({snapshot: after, ledger: seeded.ledger, now: 1000, seatsForRepo: seats, ...options})
    };

test.describe('openWorkWakes — a seat is woken once per episode of holding a PR\'s next action', () => {
    test('the first plan is a baseline: it records every holder and wakes no one', () => {
        const result = planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'})), ledger: null, now: 0, seatsForRepo: seats});

        expect(result.wakes).toEqual([]);
        expect(result.escalations).toEqual([]);
        expect(Object.keys(result.ledger.holding)).toEqual(['neomjs/neo#1:author:@neo-opus-ada'])
    });

    test('a baseline holder is not woken by the next round either: switching the path on never storms', () => {
        expect(plan(snapshot(row({ci: 'red'})), snapshot(row({ci: 'red'}))).wakes).toEqual([])
    });

    test('red wakes the author; red → green → red on one head wakes them twice; identical rounds send nothing', () => {
        let state = planOpenWorkWakes({snapshot: snapshot(row({ci: 'pending'})), ledger: null, now: 0, seatsForRepo: seats});
        const sent = [];
        const round = (overrides, now) => {
            state = planOpenWorkWakes({snapshot: snapshot(row(overrides)), ledger: state.ledger, now, seatsForRepo: seats});
            sent.push(...state.wakes.map(wake => `${wake.to}:${wake.reason}`))
        };

        round({ci: 'red'}, 1);
        round({ci: 'red'}, 2);
        round({ci: 'green'}, 3);
        round({ci: 'red'}, 4);

        expect(sent).toEqual(['@neo-opus-ada:CI is red on your head', '@neo-opus-ada:CI is red on your head'])
    });

    test('a verdict changing under a red head wakes no one: the author still holds', () => {
        const changes = {opinions: [{reviewer: '@neo-gpt', state: 'CHANGES_REQUESTED', onHead: true}]};

        expect(plan(snapshot(row({ci: 'red'})), snapshot(row({ci: 'red', verdict: 'CHANGES_REQUESTED', ...changes}))).wakes).toEqual([])
    });

    test('two requested reviewers are woken once each; one added later is woken alone', () => {
        const
            first  = plan(snapshot(row({ci: 'pending', requested: ['@neo-gpt', '@neo-gpt-sophie']})), snapshot(row({requested: ['@neo-gpt', '@neo-gpt-sophie']}))),
            second = planOpenWorkWakes({snapshot: snapshot(row({requested: ['@neo-gpt', '@neo-gpt-emmy', '@neo-gpt-sophie']})), ledger: first.ledger, now: 2000, seatsForRepo: seats});

        expect(first.wakes.map(wake => wake.to).sort()).toEqual(['@neo-gpt', '@neo-gpt-sophie']);
        expect(second.wakes.map(wake => wake.to)).toEqual(['@neo-gpt-emmy'])
    });

    test('a reviewer holds only while requested: removed, the episode closes; requested again, it is a new one', () => {
        const
            requested = plan(snapshot(row({ci: 'pending', requested: ['@neo-gpt']})), snapshot(row({requested: ['@neo-gpt']}))),
            removed   = planOpenWorkWakes({snapshot: snapshot(row()), ledger: requested.ledger, now: 2000, seatsForRepo: seats}),
            again     = planOpenWorkWakes({snapshot: snapshot(row({requested: ['@neo-gpt']})), ledger: removed.ledger, now: 3000, seatsForRepo: seats});

        expect(requested.wakes.map(wake => wake.to)).toEqual(['@neo-gpt']);
        expect([removed.wakes, removed.ledger.holding]).toEqual([[], {}]);
        expect(again.wakes.map(wake => wake.to)).toEqual(['@neo-gpt'])
    });

    test('a reviewer named as a team or a bare login has no seat to wake', () => {
        expect(plan(snapshot(row({ci: 'pending', requested: ['team:acme/core']})), snapshot(row({requested: ['team:acme/core', 'login:someone']}))).wakes).toEqual([])
    });

    test('an outside PR wakes one rotation seat, turning by PR number', () => {
        const rotation = number => plan(snapshot(row({key: `neomjs/neo#${number}`, number, owner: outside, ci: 'pending'})), snapshot(row({key: `neomjs/neo#${number}`, number, owner: outside})));

        expect(rotation(2).wakes.map(wake => wake.to)).toEqual(['@neo-gpt']);
        expect(rotation(3).wakes.map(wake => wake.to)).toEqual(['@neo-opus-grace']);
        expect(rotation(3).wakes[0].role).toBe('rotation')
    });

    test('the operator\'s merge-ready row wakes no one: it is the awaiting-merge list\'s', () => {
        const approved = {opinions: [{reviewer: '@neo-gpt', state: 'APPROVED', onHead: true}]};

        expect(plan(snapshot(row({ci: 'pending'})), snapshot(row(approved))).wakes).toEqual([])
    });

    test('an unreachable route is skipped and escalated once, then woken when it answers again', () => {
        let route = 'unreachable';
        const
            options = {routeOf: () => route},
            first   = plan(snapshot(row({ci: 'pending'})), snapshot(row({ci: 'red'})), options),
            second  = planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'})), ledger: first.ledger, now: 2000, seatsForRepo: seats, ...options});

        expect(first.wakes).toEqual([]);
        expect(first.escalations).toEqual([{kind: 'dead-route', pr: 'neomjs/neo#1', seat: '@neo-opus-ada', role: 'author'}]);
        expect(second.escalations).toEqual([]);

        route = 'reachable';

        expect(planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'})), ledger: second.ledger, now: 3000, seatsForRepo: seats, ...options}).wakes.map(wake => wake.to)).toEqual(['@neo-opus-ada'])
    });

    test('a holder still holding after the silent window is escalated once', () => {
        const
            woken = plan(snapshot(row({ci: 'pending'})), snapshot(row({ci: 'red'}))),
            later = now => planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'})), ledger: woken.ledger, now, seatsForRepo: seats}),
            early = later(1000 + SILENT_AFTER_MS - 1),
            late  = later(1000 + SILENT_AFTER_MS),
            again = planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'})), ledger: late.ledger, now: 1000 + 2 * SILENT_AFTER_MS, seatsForRepo: seats});

        expect(early.escalations).toEqual([]);
        expect(late.escalations).toEqual([{kind: 'silent-holder', pr: 'neomjs/neo#1', seat: '@neo-opus-ada', role: 'author', sentAt: 1000}]);
        expect(again.escalations).toEqual([])
    });

    test('an org PR with no resolvable author is escalated as unowned, once', () => {
        const
            unowned = {kind: 'unowned', seat: null, login: 'neo-gpt'},
            first   = plan(snapshot(), snapshot(row({owner: unowned}))),
            second  = planOpenWorkWakes({snapshot: snapshot(row({owner: unowned})), ledger: first.ledger, now: 2000, seatsForRepo: seats});

        expect(first.escalations).toEqual([{kind: 'unowned', pr: 'neomjs/neo#1', login: 'neo-gpt'}]);
        expect(second.escalations).toEqual([])
    });

    test('a merge wakes its author once, however often the terminal read repeats it', () => {
        const
            merged = {kind: 'merged', key: 'neomjs/neo#1', repo: 'neomjs/neo', number: 1, head: 'h1', owner: author},
            seeded = planOpenWorkWakes({snapshot: snapshot(row({ci: 'pending'})), ledger: null, now: 0, seatsForRepo: seats}),
            first  = planOpenWorkWakes({snapshot: snapshot(), transitions: [merged], ledger: seeded.ledger, now: 1000, seatsForRepo: seats}),
            second = planOpenWorkWakes({snapshot: snapshot(), transitions: [merged], ledger: first.ledger, now: 2000, seatsForRepo: seats});

        expect(first.wakes.map(wake => `${wake.to}:${wake.reason}`)).toEqual(['@neo-opus-ada:your pull request was merged']);
        expect(second.wakes).toEqual([])
    });

    test('a closed episode leaves the ledger: the ledger holds only who holds now', () => {
        const result = plan(snapshot(row({ci: 'red'})), snapshot(row({ci: 'green'})));

        expect(result.ledger.holding).toEqual({})
    });

    test('a quiet round keeps the ledger current and sends nothing; the round after wakes only what changed', () => {
        const
            woken  = plan(snapshot(row({ci: 'pending'})), snapshot(row({ci: 'red'}))),
            others = {key: 'neomjs/neo#2', number: 2},
            quiet  = planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'}), row({...others, ci: 'red'})), ledger: woken.ledger, now: 1000 + SILENT_AFTER_MS, seatsForRepo: seats, quiet: true}),
            after  = planOpenWorkWakes({snapshot: snapshot(row({ci: 'red'}), row({...others, ci: 'red'}), row({key: 'neomjs/neo#3', number: 3, ci: 'red'})), ledger: quiet.ledger, now: 2000 + SILENT_AFTER_MS, seatsForRepo: seats});

        expect(quiet.wakes).toEqual([]);
        expect(quiet.escalations).toEqual([]);
        // the woken holder keeps its send time across the quiet round
        expect(quiet.ledger.holding['neomjs/neo#1:author:@neo-opus-ada'].sentAt).toBe(1000);
        expect(after.wakes.map(wake => wake.pr)).toEqual(['neomjs/neo#3'])
    });
});

test.describe('openWorkWakes — wakes switch on only inside the observed day\'s bounds', () => {
    // a day of complete pulses, one a minute, each costing `cost` and counting `transitions`
    const day = ({cost = 3, transitions = {}, length = SWITCH_ON_BOUNDS.pulses} = {}) => Array.from({length}, (_, index) => ({
        at: new Date(Date.UTC(2026, 9, 2) + index * 60000).toISOString(), cost, coverage: 'complete', pages: 1, transitions
    }));

    test('a full, cheap, calm day holds', () => {
        expect(wakeGateOf(day())).toEqual({holds: true, reason: null})
    });

    test('less than the retained day holds nothing open: a new install observes a day first', () => {
        expect(wakeGateOf(day({length: SWITCH_ON_BOUNDS.pulses - 1}))).toEqual({holds: false, reason: `${SWITCH_ON_BOUNDS.pulses - 1} of the day's ${SWITCH_ON_BOUNDS.pulses} pulses observed`});
        expect(wakeGateOf([]).holds).toBe(false)
    });

    test('a day whose complete pulses cost too much stays quiet; failed pulses are not judged on cost', () => {
        const pulses = day({cost: SWITCH_ON_BOUNDS.costP95 + 1});

        expect(wakeGateOf(pulses).reason).toBe(`a complete pulse cost ${SWITCH_ON_BOUNDS.costP95 + 1} points at the 95th percentile, above ${SWITCH_ON_BOUNDS.costP95}`);
        expect(wakeGateOf(pulses.map(pulse => ({...pulse, coverage: 'stale', failed: true}))).reason).toBe('no complete pulse in the day')
    });

    test('a seat whose pull requests change faster than the hourly bound keeps every round quiet', () => {
        // one transition a minute: sixty in each clock hour is the bound itself, a second one per minute breaks it
        expect(wakeGateOf(day({transitions: {'@neo-opus-ada': 1}})).holds).toBe(true);
        expect(wakeGateOf(day({transitions: {'@neo-opus-ada': 2}}))).toEqual({
            holds: false, reason: `${SWITCH_ON_BOUNDS.seatHourly + 2} transitions for @neo-opus-ada in the hour from 2026-10-02T00:00Z, above ${SWITCH_ON_BOUNDS.seatHourly}`
        })
    });
});
