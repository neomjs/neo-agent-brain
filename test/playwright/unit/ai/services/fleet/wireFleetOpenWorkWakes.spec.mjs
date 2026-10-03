import {setup} from '../../../../setup.mjs';

// the wiring imports the open-work source's wiring, which imports FleetControlBridge, a Neo class: the
// spec stands up Neo itself, never through a sibling
setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'WireFleetOpenWorkWakesTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {expect, test}            from '@playwright/test';
import fs                        from 'fs';
import os                        from 'os';
import path                      from 'path';
import Neo                       from 'neo.mjs/src/Neo.mjs';
import * as core                 from 'neo.mjs/src/core/_export.mjs';
import {SWITCH_ON_BOUNDS}        from '../../../../../../ai/services/fleet/openWorkWakes.mjs';
import {wireFleetOpenWorkSource} from '../../../../../../ai/services/fleet/wireFleetOpenWorkSource.mjs';
import {
    createOpenWorkWakeRound,
    seatsForRepoOf,
    wireFleetOpenWorkWakes
} from '../../../../../../ai/services/fleet/wireFleetOpenWorkWakes.mjs';

const
    minute = 60000,
    start  = Date.UTC(2026, 9, 2),
    iso    = m => new Date(start + m * minute).toISOString(),
    author = {kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'},
    row    = (overrides = {}) => ({
        key: 'neomjs/neo#1', repo: 'neomjs/neo', number: 1, head: 'abcdef123', ci: 'green', verdict: null, mergeable: 'MERGEABLE',
        draft: false, owner: author, requested: [], reviews: [], opinions: [], requestsComplete: true, partial: false, ...overrides
    }),
    second = (overrides = {}) => row({key: 'neomjs/neo#2', number: 2, ...overrides}),
    third  = (overrides = {}) => row({key: 'neomjs/neo#3', number: 3, ...overrides}),
    // the producer's state observed at minute `m`: a retained day of calm pulses ending there, unless `pulses` is shorter
    stateAt = (m, rows, {pulses = SWITCH_ON_BOUNDS.pulses} = {}) => ({
        snapshot   : {rows: Object.fromEntries(rows.map(item => [item.key, item]))},
        observedAt : iso(m),
        transitions: [],
        pulses     : Array.from({length: pulses}, (_, index) => ({at: iso(m - pulses + 1 + index), cost: 3, coverage: 'complete', pages: 1, transitions: {}}))
    }),
    definitions = [
        {id: 'ada',  githubUsername: 'neo-opus-ada', metadata: {repo: {repoSlug: 'acme/app'}, repos: [{repoSlug: 'acme/lib'}]}},
        {id: 'gpt',  githubUsername: '@neo-gpt',     metadata: {repo: {repoSlug: 'acme/lib'}}},
        {id: 'lab',  githubUsername: 'lab-seat',     metadata: {repo: {repoSlug: 'acme/lib', forge: 'gitlab'}}},
        {id: 'anon',                                 metadata: {repo: {repoSlug: 'acme/lib'}}}
    ];

/**
 * A round over an in-memory ledger, with every save, send, route read and log line recorded.
 * @param {Object} [options]
 * @param {Function} [options.undeliverable] Answers the routes read.
 * @param {Function} [options.sendImpl] Answers each send.
 * @returns {Object}
 */
function harness({undeliverable = () => null, sendImpl} = {}) {
    let saved = null;
    const
        events = [],
        sent   = [],
        logs   = [],
        reads  = {routes: 0},
        clock  = {now: start},
        store  = {
            load: () => saved && JSON.parse(JSON.stringify(saved)),
            save: value => { events.push('save'); saved = JSON.parse(JSON.stringify(value)) }
        },
        round  = createOpenWorkWakeRound({
            store,
            send             : async message => { events.push('send'); sent.push(message); return sendImpl?.(message) },
            seatsForRepo     : () => ['@neo-gpt', '@neo-opus-grace'],
            readUndeliverable: async () => { reads.routes++; return undeliverable() },
            now              : () => clock.now,
            log              : {info: line => logs.push(line), warn: line => logs.push(line), error: (...parts) => logs.push(parts.join(' '))}
        });

    return {
        events, sent, logs, reads, store, round,
        saved: () => saved,
        // one round at minute `m`, the clock with it
        step : (m, rows, options) => { clock.now = start + m * minute; return round(stateAt(m, rows, options)) }
    }
}

test.describe('wireFleetOpenWorkWakes — each pulse plans a round, writes the ledger, then sends', () => {
    test('the first round is a baseline: it saves the ledger at the pulse it planned and sends nothing', async () => {
        const h = harness();

        await h.step(1440, [row({ci: 'red'})]);

        expect(h.sent).toEqual([]);
        expect(h.saved()).toMatchObject({pulse: iso(1440), gate: {holds: true, reason: null}});
        // the ledger holds who holds what and nothing for a reader that does not exist
        expect(Object.keys(h.saved()).sort()).toEqual(['gate', 'holding', 'pulse', 'records']);
        expect(Object.keys(h.saved().holding)).toEqual(['neomjs/neo#1:author:@neo-opus-ada'])
    });

    test('a holder change saves the ledger, then sends one task-bearing message', async () => {
        const h = harness();

        await h.step(1440, [row({ci: 'pending'})]);
        await h.step(1441, [row({ci: 'red'})]);

        expect(h.events).toEqual(['save', 'save', 'send']);
        expect(h.sent).toEqual([{
            to            : '@neo-opus-ada',
            subject       : '[open-work] neomjs/neo#1: CI is red on your head',
            body          : expect.stringContaining('https://github.com/neomjs/neo/pull/1 (head abcdef1): CI is red on your head.'),
            relatedTickets: ['neomjs/neo#1'],
            task          : {id: 'open-work:neomjs/neo#1:author:@neo-opus-ada@abcdef1', state: 'Submitted'}
        }])
    });

    test('an observation already planned saves and sends nothing: a failed pulse keeps the last one', async () => {
        const h = harness();

        await h.step(1440, [row({ci: 'pending'})]);
        await h.step(1441, [row({ci: 'red'})]);
        await h.step(1441, [row({ci: 'red'})]);
        await h.round(null);

        expect(h.events).toEqual(['save', 'save', 'send'])
    });

    test('until the observed day passes the bounds every round is quiet; the first open round wakes only new holders', async () => {
        const h = harness();

        await h.step(10, [row({ci: 'pending'})], {pulses: 11});
        await h.step(11, [row({ci: 'red'})], {pulses: 12});

        expect(h.sent).toEqual([]);
        expect(h.saved().gate).toEqual({holds: false, reason: `12 of the day's ${SWITCH_ON_BOUNDS.pulses} pulses observed`});
        expect(h.logs).toEqual([`[fleet] open-work wakes stay quiet: 11 of the day's ${SWITCH_ON_BOUNDS.pulses} pulses observed`]);

        // the red head became a holder while quiet, so only the PR that turned red after it wakes
        await h.step(1440, [row({ci: 'red'}), second({ci: 'red'})]);

        expect(h.sent.map(message => message.relatedTickets[0])).toEqual(['neomjs/neo#2']);
        expect(h.logs.at(-1)).toBe('[fleet] open-work wakes switched on')
    });

    test('a seat no wake reaches is skipped, then woken once its route answers; routes are read only for a wake', async () => {
        let routes = {'@neo-opus-ada': 'opencode-server envelope requires \'agentIdentity\''};
        const h = harness({undeliverable: () => routes});

        await h.step(1440, [row({ci: 'pending'})]);
        expect(h.reads.routes).toBe(0);

        await h.step(1441, [row({ci: 'red'})]);

        expect(h.sent).toEqual([]);
        expect(h.saved().holding['neomjs/neo#1:author:@neo-opus-ada']).toMatchObject({sentAt: null, skipped: 'unreachable'});

        routes = {};

        // one answer serves the rounds inside its five minutes, so the seat still reads unreachable
        await h.step(1442, [row({ci: 'red'})]);
        expect([h.reads.routes, h.sent.length]).toEqual([1, 0]);

        await h.step(1447, [row({ci: 'red'})]);
        expect([h.reads.routes, h.sent.map(message => message.to)]).toEqual([2, ['@neo-opus-ada']])
    });

    test('a ledger that cannot be read stops the round: nothing is saved over it and nothing is sent', async () => {
        const h = harness();

        h.store.load = () => { throw new SyntaxError('Unexpected end of JSON input') };
        await h.step(1440, [row({ci: 'red'})]);

        expect(h.events).toEqual([]);
        expect(h.logs).toEqual(['[fleet] open-work wake round failed: Unexpected end of JSON input'])
    });

    test('a ledger the retained day no longer reaches baselines again: switching back on wakes no backlog', async () => {
        const h = harness();

        await h.step(1440, [row({ci: 'pending'})]);
        // switched off for two days: the retained day now starts after the ledger's last pulse
        await h.step(1440 * 3, [row({ci: 'red'}), second({ci: 'red'})]);
        expect(h.sent).toEqual([]);

        await h.step(1440 * 3 + 1, [row({ci: 'red'}), second({ci: 'red'}), third({ci: 'red'})]);
        expect(h.sent.map(message => message.relatedTickets[0])).toEqual(['neomjs/neo#3'])
    });

    test('a failed send is logged and never retried: whether it landed is unknown', async () => {
        const h = harness({sendImpl: async () => { throw new Error('the plane answered 503') }});

        await h.step(1440, [row({ci: 'pending'})]);
        await h.step(1441, [row({ci: 'red'})]);
        await h.step(1442, [row({ci: 'red'})]);

        expect(h.sent).toHaveLength(1);
        expect(h.logs).toContain('[fleet] open-work wake to @neo-opus-ada on neomjs/neo#1 failed: the plane answered 503')
    });

    test('a round asked for while one runs is that round; the next plans from the last saved pulse', async () => {
        let release;
        const h = harness({undeliverable: () => new Promise(resolve => { release = () => resolve(null) })});

        await h.step(1440, [row({ci: 'pending'})]);

        const
            running = h.step(1441, [row({ci: 'red'})]),
            asked   = h.step(1442, [row({ci: 'red'}), second({ci: 'red'})]);

        expect(asked).toBe(running);
        release();
        await running;
        expect(h.saved().pulse).toBe(iso(1441));

        await h.step(1443, [row({ci: 'red'}), second({ci: 'red'})]);
        expect(h.sent.map(message => message.relatedTickets[0])).toEqual(['neomjs/neo#1', 'neomjs/neo#2'])
    });
});

test.describe('wireFleetOpenWorkWakes — the round inside a Fleet server', () => {
    test('the rotation is the registry\'s GitHub seats on the repository', () => {
        const seatsForRepo = seatsForRepoOf(() => definitions);

        expect(seatsForRepo('acme/lib')).toEqual(['@neo-opus-ada', '@neo-gpt']);
        expect(seatsForRepo('acme/app')).toEqual(['@neo-opus-ada']);
        expect(seatsForRepo('acme/other')).toEqual([])
    });

    test('the ledger lives beside the producer\'s state file; without a registry or a sender nothing is wired', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wakes-'));

        try {
            const round = wireFleetOpenWorkWakes({registry: {listAgents: () => definitions, getDataDir: () => dataDir}, send: async () => {}});

            await round(stateAt(1440, [row({ci: 'red'})]));

            expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'open-work-wakes.json'), 'utf8'))).toMatchObject({pulse: iso(1440), gate: {holds: true}});
            expect(wireFleetOpenWorkWakes({registry: {listAgents: () => definitions, getDataDir: () => dataDir}})).toBeNull();
            expect(wireFleetOpenWorkWakes({send: async () => {}})).toBeNull()
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
    });

    test('the producer hands each pulse\'s state to the round', async () => {
        const
            dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wakes-')),
            states  = [],
            query   = async () => ({rateLimit: {cost: 1}, search: {pageInfo: {hasNextPage: false}, nodes: []}});

        try {
            const wired = wireFleetOpenWorkSource({
                registry: {listAgents: () => definitions, getDataDir: () => dataDir}, bridge: {}, query, pulseMs: 3600000, onPulse: state => states.push(state)
            });

            await wired.producer.pulse();
            wired.stop();

            expect(states).toEqual([wired.producer.getState()]);
            expect(states[0].coverage).toBe('complete')
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
    });
});
