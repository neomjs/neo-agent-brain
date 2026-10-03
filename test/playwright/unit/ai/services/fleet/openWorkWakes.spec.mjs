import {expect, test}                                       from '@playwright/test';
import {SILENT_AFTER_MS, planOpenWorkWakes}                  from '../../../../../../ai/services/fleet/openWorkWakes.mjs';

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
});
