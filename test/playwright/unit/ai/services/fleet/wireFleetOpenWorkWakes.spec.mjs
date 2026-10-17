import {setup} from '../../../../setup.mjs';

setup({neoConfig: {unitTestMode: true}, appConfig: {name: 'WireFleetOpenWorkWakesTest'}});

import {expect, test}                                    from '@playwright/test';
import fs                                                from 'fs';
import os                                                from 'os';
import path                                              from 'path';
import Neo                                               from 'neo.mjs/src/Neo.mjs';
import * as core                                         from 'neo.mjs/src/core/_export.mjs';
import {createOpenWorkWakeRound, wireFleetOpenWorkWakes} from '../../../../../../ai/services/fleet/wireFleetOpenWorkWakes.mjs';

const START  = Date.parse('2026-10-13T12:00:00.000Z'), HEAD = 'a'.repeat(40), SEAT = '@neo-opus-ada',
    at       = minute => START + minute * 60000,
    iso      = minute => new Date(at(minute)).toISOString(),
    openGate = () => ({holds: true, reason: null});

/** @summary A controlled fresh producer observation; the production planner determines every action. */
function state(minute, ci = 'pending', extra = {}) {
    const row = {key: 'acme/app#7', repo: 'acme/app', number: 7, head: HEAD,
        owner    : {kind: 'seat', seat: SEAT}, ci, verdict: null, mergeable: 'MERGEABLE', draft: false,
        requested: [], reviews: [], opinions: [], partial: false, observedAt: iso(minute)};
    return {observedAt: iso(minute), coverage: 'complete', snapshot: {rows: {[row.key]: row}, closed: {}},
        transitions: [], pulses: [{at: iso(-1500)}, {at: iso(minute)}], ...extra}
}

/** @summary A terminal source receipt that may leave the producer's retained transition list. */
function merged(minute) {
    return {id: `merge-${minute}`, key: 'acme/app#7', repo: 'acme/app', number: 7, head: HEAD,
        kind: 'merged', owner: {kind: 'seat', seat: SEAT}, pulse: iso(minute)}
}

/** @summary Storage crosses a serialization boundary, so tests do not share mutable planner objects. */
function memoryStore(initial = null) {
    let value = initial;
    return {load: () => structuredClone(value), save: next => { value = structuredClone(next) }, read: () => structuredClone(value)}
}

/** @summary Expose an explicit barrier instead of waiting on timing or real network delivery. */
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done });
    return {promise, resolve}
}

/** @summary A complete 25-hour measured history exercises the default gate without external services. */
function measuredState(minute, ci = 'pending') {
    const value = state(minute, ci);
    value.readers = {'neo-opus-ada': {}};
    value.pulses = Array.from({length: 1501}, (_, index) => {
        const time = at(minute - 1500 + index), stamp = new Date(time).toISOString();
        return {telemetryVersion: 1, at: stamp, finishedAt: stamp, intervalMs: 60000, costUnknown: false,
            seats: [{seat: SEAT, benched: false, outcome: 'complete', authored: {complete: true, rows: 1},
                held: {complete: true, rows: 0}, terminal: {required: false, complete: true, rows: 0}}],
            outside: {complete: true, rows: 0},
            quota: [{apiBase: 'https://api.github.com', viewerId: 'issuer-1', limit: 1000, remaining: 900,
                cost   : 2, calls: 2, failed: 0, unknown: false, firstAt: stamp, lastAt: stamp,
                resetAt: new Date(Math.floor(time / 3600000) * 3600000 + 3600000).toISOString()}]}
    });
    return value
}

/** @summary Synthetic gate evidence keeps every cost ledger and its selected decision authority distinct. */
function certification() {
    return {
        version  : 1, policy: 'open-work-operational-estimate-v1',
        window   : {start: iso(-1440), end: iso(0), retainedFrom: iso(-1500)},
        estimates: [{apiBase: 'https://api.github.com', queryHash: 'a'.repeat(64),
            formulaCost: 1, maxMeasuredCost: null, reservePerCall: 6}],
        buckets: [
            {apiBase: 'https://api.github.com', viewerId: 'issuer-1', resetAt: iso(60), limit: 1000,
                measured: 10, estimated: 12, unattributed: 6, estimatedCalls: 2, unattributedCalls: 1,
                decision: 'operational-estimate', userTotal: {at: iso(0), used: 100, remaining: 900}},
            {apiBase: 'https://api.github.com', viewerId: 'issuer-2', resetAt: iso(60), limit: 1000,
                measured: 100, estimated: 120, unattributed: 60, estimatedCalls: 20, unattributedCalls: 10,
                decision: 'reported-user-total', userTotal: {at: iso(0), used: 100, remaining: 900}}
        ]
    }
}

test.describe('wireFleetOpenWorkWakes — reserved attempts on the producer cadence (#761)', () => {
    test('default production gate accepts a measured day, baselines first and admits the next action', async () => {
        let   minute = 0;
        const sends  = [], round = createOpenWorkWakeRound({store: memoryStore(), now: () => at(minute), sendMessage: async message => sends.push(message)});
        expect(await round(measuredState(0, 'red'))).toMatchObject({admitted: 0, quiet: false});
        minute = 1;
        expect(await round(measuredState(1, 'green'))).toMatchObject({admitted: 1});
        expect(sends[0].task.kind).toBe('route-review');
        await round.stop()
    });

    test('a certification receipt is detached before storage and survives restart with all decision evidence', async () => {
        let   minute  = 0;
        const receipt = certification(), expected = structuredClone(receipt), store = memoryStore(), save = store.save,
            options = {store, now: () => at(minute), gateOf: () => ({holds: true, reason: null, certification: receipt}),
                sendMessage: async () => {}};
        store.save = value => {
            // Mutation at the persistence boundary must not rewrite the newly accepted receipt.
            receipt.window.start = iso(-1);
            receipt.estimates[0].reservePerCall = 999;
            receipt.buckets[0].estimated = 999;
            receipt.buckets[1].userTotal.used = 999;
            save(value)
        };
        await createOpenWorkWakeRound(options)(state(0));
        expect(store.read().activation.certification).toEqual(expected);
        store.save = save; minute = 2000;
        await createOpenWorkWakeRound({...options, gateOf: () => { throw new Error('must not fabricate new proof') }})
            (state(2000, 'red', {pulses: [{at: iso(500)}, {at: iso(2000)}]}));
        expect(store.read().activation.certification).toEqual(expected)
    });

    test('unknown or malformed present certification refuses new activation and preserves existing storage', async () => {
        const mutations = [
            () => null,
            value => ({...value, version: 2}),
            value => ({...value, policy: 'unknown-policy'}),
            value => ({...value, window: {...value.window, start: iso(1)}}),
            value => ({...value, window: {...value.window, retainedFrom: 'invalid'}}),
            value => ({...value, estimates: [{...value.estimates[0], formulaCost: 0}]}),
            value => ({...value, estimates: [{...value.estimates[0], maxMeasuredCost: -1}]}),
            value => ({...value, buckets: [{...value.buckets[0], estimated: undefined}]}),
            value => ({...value, buckets: [{...value.buckets[0], unattributedCalls: 1.5}]}),
            value => ({...value, buckets: [{...value.buckets[1], userTotal: null}]}),
            value => ({...value, buckets: [{...value.buckets[0], decision: 'unknown-authority'}]})
        ];
        for (const mutate of mutations) {
            const receipt = mutate(certification()), store = memoryStore(), sends = [];
            const round   = createOpenWorkWakeRound({store, now: () => at(0),
                gateOf     : () => ({holds: true, reason: null, certification: receipt}),
                sendMessage: async value => sends.push(value)});
            await expect(round(state(0))).rejects.toThrow('Malformed open-work wake certification');
            expect(store.read()).toBeNull(); expect(sends).toEqual([])
        }
    });

    test('malformed persisted certification cannot be accepted as an activation or overwritten', async () => {
        const seed = memoryStore();
        await createOpenWorkWakeRound({store: seed, gateOf: openGate, now: () => at(0), sendMessage: async () => {}})(state(0));
        for (const receipt of [null, {...certification(), policy: 'unknown-policy'},
            {...certification(), buckets: [{...certification().buckets[0], measured: -1}]}]) {
            const before = {...seed.read(), activation: {...seed.read().activation, certification: receipt}},
                store    = memoryStore(before), sends = [], round = createOpenWorkWakeRound({
                    store, gateOf: openGate, now: () => at(1), sendMessage: async value => sends.push(value)
                });
            await expect(round(state(1, 'red'))).rejects.toThrow('Malformed open-work wake ledger');
            expect(store.read()).toEqual(before); expect(sends).toEqual([])
        }
    });

    test('legacy activation or an explicit test gate without a receipt never gains invented certification evidence', async () => {
        let   minute = 0;
        const store  = memoryStore(), round = createOpenWorkWakeRound({store, gateOf: openGate,
            now: () => at(minute), sendMessage: async () => {}});
        await round(state(0));
        expect(store.read().activation).not.toHaveProperty('certification');
        minute = 1;
        await createOpenWorkWakeRound({store, gateOf: () => { throw new Error('legacy latch does not recertify') },
            now: () => at(minute), sendMessage: async () => {}})(state(1, 'red'));
        expect(store.read().activation).not.toHaveProperty('certification')
    });

    test('activation latches once; later gate refusals still admit fresh actions', async () => {
        let   minute = 0, gateCalls = 0;
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({
            store, now: () => at(minute), gateOf: () => {
                gateCalls++;
                return minute === 0 ? openGate() : {holds: false, reason: 'a pulse has unattributed or unknown query cost'}
            }, sendMessage: async message => sends.push(message)
        });
        await round(state(0)); minute = 1;
        expect(await round(state(1, 'red'))).toMatchObject({admitted: 1, quiet: false});
        expect(sends.map(message => message.task.kind)).toEqual(['repair-ci']);
        expect(store.read().activation).toEqual({version: 1, at: iso(0)});
        expect(gateCalls).toBe(1)
    });

    test('activation survives restart and history rollover without losing pending merges', async () => {
        let   minute = 0, routes = {[SEAT]: 'absent'};
        const store  = memoryStore(), sends = [], options = {store, gateOf: openGate, now: () => at(minute),
            readUndeliverable: async () => routes, sendMessage: async message => sends.push(message)};
        const first = createOpenWorkWakeRound(options);
        await first(state(0)); minute = 1;
        await first(state(1, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: [merged(1)]}));
        const pending = store.read().pendingMerges['merge-1'];
        await first.stop(); routes = {}; minute = 2000;
        const restarted = createOpenWorkWakeRound({...options, gateOf: () => {
            throw new Error('an activated ledger must not recertify')
        }});
        await restarted(state(2000, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: [],
            pulses: [{at: iso(500)}, {at: iso(2000)}]}));
        expect(sends).toHaveLength(1);
        expect(sends[0].task.episode).toBe(pending.episode);
        expect(store.read().activation).toEqual({version: 1, at: iso(0)});
        expect(store.read().pendingMerges).toEqual({})
    });

    test('present malformed or unknown activation is never treated as a certified ledger', async () => {
        const seed = memoryStore();
        await createOpenWorkWakeRound({store: seed, gateOf: openGate, now: () => at(0), sendMessage: async () => {}})(state(0));
        for (const activation of [null, true, {}, {version: 2, at: iso(0)}, {version: 1, at: 'invalid'}, {version: 1, at: iso(2)}]) {
            const before = {...seed.read(), activation}, store = memoryStore(before), sends = [];
            const round  = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(1), sendMessage: async value => sends.push(value)});
            await expect(round(state(1, 'red'))).rejects.toThrow('Malformed open-work wake ledger');
            expect(store.read()).toEqual(before); expect(sends).toEqual([])
        }
    });

    test('disabled callbacks do not create or change the ledger, while re-enabling retains activation', async () => {
        let   minute = 0, enabled = false;
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, gateOf: openGate,
            isEnabled: () => enabled, now: () => at(minute), sendMessage: async value => sends.push(value)});
        expect(await round(state(0))).toMatchObject({admitted: 0, disabled: true});
        expect(store.read()).toBeNull();
        enabled = true; await round(state(0)); const activated = store.read();
        enabled = false; minute = 1; await round(state(1, 'red'));
        expect(store.read()).toEqual(activated); expect(sends).toEqual([]);
        enabled = true; await round(state(1, 'red'));
        expect(sends).toHaveLength(1); expect(store.read().activation).toEqual(activated.activation)
    });

    test('disabling during the route read prevents admission and preserves pending work', async () => {
        let   minute = 0, enabled = true;
        const store  = memoryStore(), entered = deferred(), release = deferred(), sends = [],
            round = createOpenWorkWakeRound({store, gateOf: openGate, isEnabled: () => enabled, now: () => at(minute),
                readUndeliverable: async () => { entered.resolve(); await release.promise; return null },
                sendMessage      : async value => sends.push(value)});
        await round(state(0)); const before = store.read(); minute = 1;
        const running = round(state(1, 'red')); await entered.promise;
        enabled = false; release.resolve();
        expect(await running).toMatchObject({admitted: 0, disabled: true});
        expect(store.read()).toEqual(before); expect(sends).toEqual([])
    });

    test('disabling during persistence or between sends stops effects without replaying reserved attempts', async () => {
        let   minute = 0, enabled = true, pause = false;
        const store  = memoryStore(), save = store.save, entered = deferred(), release = deferred(), sends = [];
        store.save = async value => { save(value); if (pause) { entered.resolve(); await release.promise } };
        const round = createOpenWorkWakeRound({store, gateOf: openGate, isEnabled: () => enabled, now: () => at(minute),
            sendMessage: async value => sends.push(value)});
        await round(state(0)); minute = 1; pause = true;
        const running = round(state(1, 'red')); await entered.promise; enabled = false; release.resolve();
        expect(await running).toMatchObject({admitted: 1, disabled: true});
        expect(sends).toEqual([]); enabled = true; pause = false; minute = 2; await round(state(2, 'red'));
        expect(sends).toEqual([]);

        const otherStore = memoryStore(), laterSends = [], between = createOpenWorkWakeRound({
            store      : otherStore, gateOf: openGate, isEnabled: () => enabled, now: () => at(minute),
            sendMessage: async value => { laterSends.push(value); enabled = false }
        });
        minute = 3; await between(state(3)); minute = 4;
        const observed = state(4, 'green'); observed.snapshot.rows['acme/app#7'].requested = [SEAT, '@neo-gpt'];
        expect(await between(observed)).toMatchObject({admitted: 2, disabled: true});
        expect(laterSends).toHaveLength(1);
        expect(Object.values(otherStore.read().holding).map(entry => entry.status)).toEqual(['admitted', 'admitted'])
    });

    test('refusal changes and activation are logged once across restart with no raw reason data', async () => {
        let   minute = 0, reason = 'less than 24 elapsed hours of version-one observations', active = false;
        const store  = memoryStore(), messages = [], options = {store, now: () => at(minute),
            gateOf     : () => active ? openGate() : {holds: false, reason},
            sendMessage: async () => {}, log: {info: (...args) => messages.push(args)}};
        const first = createOpenWorkWakeRound(options);
        await first(state(0)); minute = 1; await first(state(1));
        const restarted = createOpenWorkWakeRound(options); minute = 2; await restarted(state(2));
        expect(messages).toHaveLength(1);
        reason = 'an issuer exceeded 20% of its measured hourly GraphQL limit'; minute = 3; await restarted(state(3));
        expect(messages).toHaveLength(2);
        reason = 'private-token:' + 'x'.repeat(10000); minute = 4; await restarted(state(4));
        expect(messages).toHaveLength(3); expect(JSON.stringify(messages)).not.toContain('private-token');
        expect(JSON.stringify(messages).length).toBeLessThan(600);
        active = true; minute = 5; await restarted(state(5)); minute = 6; await restarted(state(6));
        expect(messages).toHaveLength(4);
        expect(JSON.stringify(messages.at(-1))).toContain('activated')
    });

    test('the ledger save completes before the first sender effect', async () => {
        let   minute = 0, hold = false;
        const store  = memoryStore(), saved = store.save, entered = deferred(), release = deferred(), sends = [];
        store.save = async value => { if (hold) { entered.resolve(); await release.promise } saved(value) };
        const round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute), sendMessage: async message => {
            expect(Object.values(store.read().holding)[0].status).toBe('admitted'); sends.push(message)
        }});
        await round(state(0)); minute = 1; hold = true;
        const running = round(state(1, 'red'));
        await entered.promise;
        expect(sends).toEqual([]);
        release.resolve(); await running;
        expect(sends).toHaveLength(1)
    });

    test('a save failure has zero sender effects and preserves the prior ledger', async () => {
        let   minute = 0;
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, gateOf: openGate,
            now: () => at(minute), sendMessage: async message => sends.push(message)});
        await round(state(0)); const before = store.read();
        store.save = () => { throw new Error('disk unavailable') }; minute = 1;
        await expect(round(state(1, 'red'))).rejects.toThrow('disk unavailable');
        expect(sends).toEqual([]); expect(store.read()).toEqual(before)
    });

    test('a route read that outlives its producer observation reserves and sends nothing', async () => {
        let   minute = 0;
        const store  = memoryStore(), sends = [], entered = deferred(), release = deferred(),
            round = createOpenWorkWakeRound({store, now: () => at(minute),
                readUndeliverable: async () => { entered.resolve(); await release.promise; return null },
                sendMessage      : async message => sends.push(message)});
        await round(measuredState(0)); const before = store.read(); minute = 1;
        const running = round(measuredState(1, 'red')); await entered.promise;
        minute = 7; release.resolve();
        const result = await running;
        expect(sends).toEqual([]); expect(store.read()).toEqual(before);
        expect(result).toMatchObject({admitted: 0, expired: 1})
    });

    test('an activation is not re-closed by a later gate refusal during a route read', async () => {
        let   minute = 0;
        const store  = memoryStore(), sends = [], entered = deferred(), release = deferred(), gateTimes = [],
            round = createOpenWorkWakeRound({store, now: () => at(minute),
                gateOf           : (value, {now}) => { gateTimes.push(now); return {holds: now < at(2), reason: now < at(2) ? null : 'gate closed'} },
                readUndeliverable: async () => { entered.resolve(); await release.promise; return null },
                sendMessage      : async message => sends.push(message)});
        await round(state(0)); minute = 1; const running = round(state(1, 'red')); await entered.promise;
        minute = 2; release.resolve();
        expect(await running).toMatchObject({admitted: 1, quiet: false, reason: null});
        expect(gateTimes).toEqual([at(0)]); expect(sends).toHaveLength(1);
        expect(Object.values(store.read().holding)[0].status).toBe('admitted')
    });

    test('expiry during persistence skips open-row and merge sends but keeps their reservations', async () => {
        for (const scenario of [
            {minute: 1, rowMinute: 1, expiredAt: 7, terminal: false},
            {minute: 5, rowMinute: 1, expiredAt: 6.5, terminal: false},
            {minute: 1, rowMinute: 1, expiredAt: 7, terminal: true}
        ]) {
            let   minute = 0, pause = false;
            const store  = memoryStore(), save = store.save, sends = [], entered = deferred(), release = deferred();
            store.save = async ledger => { save(ledger); if (pause) { entered.resolve(); await release.promise } };
            const round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute), sendMessage: async message => sends.push(message)});
            await round(state(0)); minute = scenario.minute; pause = true;
            const observed = scenario.terminal
                ? state(minute, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: [merged(minute)]})
                : state(minute, 'red');
            if (!scenario.terminal) observed.snapshot.rows['acme/app#7'].observedAt = iso(scenario.rowMinute);
            const running  = round(observed); await entered.promise;
            const reserved = store.read(); minute = scenario.expiredAt; release.resolve();
            const result   = await running;
            expect(sends).toEqual([]); expect(store.read()).toEqual(reserved);
            expect(result).toMatchObject({admitted: 1, expired: 1});
            await round(observed); expect(sends).toEqual([])
        }
    });

    test('a delayed first sender cannot authorize the next send after observation expiry', async () => {
        let   minute = 0;
        const store  = memoryStore(), sends = [], entered = deferred(), release = deferred(),
            round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute), sendMessage: async message => {
                sends.push(message); if (sends.length === 1) { entered.resolve(); await release.promise }
            }});
        await round(state(0)); minute = 1; const observed = state(1, 'green');
        observed.snapshot.rows['acme/app#7'].requested = [SEAT, '@neo-gpt'];
        const running = round(observed); await entered.promise;
        minute = 7; release.resolve();
        const result = await running;
        expect(sends).toHaveLength(1);
        expect(result).toMatchObject({admitted: 2, expired: 1});
        expect(Object.values(store.read().holding).map(entry => entry.status)).toEqual(['admitted', 'admitted'])
    });

    test('ambiguous send is admitted once across repeated observations and a restart; logging stays bounded', async () => {
        let   minute = 0, attempts = 0;
        const store  = memoryStore(), errors = [], options = {store, gateOf: openGate, now: () => at(minute),
            sendMessage: async () => { attempts++; throw new Error('private-token:' + 'x'.repeat(10000)) },
            log        : {error: (...args) => errors.push(args)}};
        const round = createOpenWorkWakeRound(options);
        await round(state(0)); minute = 1;
        expect(await round(state(1, 'red'))).toMatchObject({admitted: 1, sendErrors: 1});
        await round(state(1, 'red')); minute = 2; await round(state(2, 'red'));
        await createOpenWorkWakeRound(options)(state(2, 'red'));
        expect(attempts).toBe(1); expect(errors).toHaveLength(1);
        expect(JSON.stringify(errors).length).toBeLessThan(400);
        expect(JSON.stringify(errors)).not.toContain('private-token')
    });

    test('only explicit unreachable routes defer open actions; cached routes retry on a later pulse', async () => {
        let   minute = 0, routes = {[SEAT]: 'receiver absent'}, reads = 0;
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute),
            readUndeliverable: async () => { reads++; return routes }, sendMessage: async message => sends.push(message)});
        await round(state(0)); expect(reads).toBe(0); minute = 1; await round(state(1, 'red'));
        expect(Object.values(store.read().holding)[0].status).toBe('pending');
        routes = {}; minute = 2; await round(state(2, 'red'));
        expect(reads).toBe(1); expect(sends).toEqual([]);
        minute = 6; await round(state(6, 'red'));
        expect(reads).toBe(2); expect(sends).toHaveLength(1)
    });

    test('undeliverable membership suppresses even null or empty reasons, until the key is removed', async () => {
        for (const reason of [null, '']) {
            let   minute = 0, routes = {[SEAT]: reason};
            const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute),
                readUndeliverable: async () => routes, sendMessage: async message => sends.push(message)});
            await round(state(0)); minute = 1; await round(state(1, 'red'));
            expect(sends).toEqual([]); expect(Object.values(store.read().holding)[0].status).toBe('pending');
            routes = {}; minute = 6; await round(state(6, 'red')); minute = 7; await round(state(7, 'red'));
            expect(sends).toHaveLength(1)
        }
    });

    test('a stale gate refusal preserves pending route history for the next fresh observation', async () => {
        let   minute = 0, routes = {[SEAT]: 'absent'};
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, now: () => at(minute),
            gateOf           : () => minute === 7 ? {holds: false, reason: 'stale observation'} : openGate(),
            readUndeliverable: async () => routes, sendMessage: async message => sends.push(message)});
        await round(state(0)); minute = 1; const observed = state(1, 'red'); await round(observed);
        const pending = store.read(); minute = 7; await round(observed);
        expect(store.read()).toEqual(pending); expect(sends).toEqual([]);
        routes = {}; minute = 8; await round(state(8, 'red')); expect(sends).toHaveLength(1)
    });

    test('the same observation retries pending routes after TTL but never reprocesses admitted work', async () => {
        let   minute = 0, unreachable = true, reads = 0, saves = 0;
        const store  = memoryStore(), save = store.save, sends = [];
        store.save = value => { saves++; save(value) };
        const round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute),
            readUndeliverable: async () => { reads++; return unreachable ? {[SEAT]: 'absent'} : null },
            sendMessage      : async message => sends.push(message)});
        await round(state(0)); minute = 1; const observed = state(1, 'red'); await round(observed);
        unreachable = false; minute = 6; await round(observed);
        expect(sends).toHaveLength(1); const writes = saves;
        await round(observed); expect(saves).toBe(writes); expect(reads).toBe(2)
    });

    test('unreadable route status skips nobody and is not a delivery guarantee', async () => {
        let   minute = 0;
        const sends  = [], round = createOpenWorkWakeRound({store: memoryStore(), gateOf: openGate, now: () => at(minute),
            readUndeliverable: async () => { throw new Error('unknown routes') }, sendMessage: async message => sends.push(message)});
        await round(state(0)); minute = 1;
        expect(await round(state(1, 'red'))).toMatchObject({admitted: 1});
        expect(sends).toHaveLength(1)
    });

    test('unreachable merged work remains retryable after its terminal transition leaves history', async () => {
        let   minute = 0, routes = {[SEAT]: 'unreachable'};
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute),
            readUndeliverable: async () => routes, sendMessage: async message => sends.push(message)});
        await round(state(0)); minute = 1;
        await round(state(1, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: [merged(1)]}));
        expect(Object.keys(store.read().pendingMerges)).toEqual(['merge-1']);
        routes = {}; minute = 6;
        await round(state(6, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: []}));
        expect(sends).toHaveLength(1); expect(sends[0].task).toMatchObject({kind: 'post-merge', episode: 'merge-1'});
        expect(store.read().pendingMerges).toEqual({})
    });

    test('full heads and episodes survive task mapping; the message names the observed action', async () => {
        let   minute = 0;
        const sends  = [], round = createOpenWorkWakeRound({store: memoryStore(), gateOf: openGate,
            now: () => at(minute), sendMessage: async message => sends.push(message)});
        await round(state(0)); minute = 1; await round(state(1, 'red'));
        minute = 2; const next = state(2, 'red'); next.snapshot.rows['acme/app#7'].head = 'a'.repeat(39) + 'b'; await round(next);
        expect(sends[0].task.id).toBe('open-work:' + JSON.stringify(['acme/app', 7, HEAD, SEAT, 'repair-ci', iso(1)]));
        expect(sends[1].task.id).not.toBe(sends[0].task.id);
        expect(sends[0].task).toMatchObject({state: 'Submitted', producerRole: 'fleet-open-work', head: HEAD, episode: iso(1)});
        expect(sends[0].task).not.toHaveProperty('assignee');
        expect(sends[0].subject).toContain('repair-ci'); expect(sends[0].body).toContain(HEAD);
        expect(sends[0].body).toContain('Re-check the live pull request')
    });

    test('a closed production gate quietly baselines; opening it does not wake that backlog', async () => {
        let   minute = 0, open = false;
        const sends  = [], round = createOpenWorkWakeRound({store: memoryStore(), now: () => at(minute),
            gateOf     : (value, args) => open ? openGate() : {holds: false, reason: 'insufficient observed day'},
            sendMessage: async message => sends.push(message)});
        await round(state(0, 'red')); open = true; minute = 1; await round(state(1, 'red'));
        expect(sends).toEqual([]); minute = 2; await round(state(2, 'green')); expect(sends).toHaveLength(1);
        const unmeasured = createOpenWorkWakeRound({store: memoryStore(), now: () => at(2), sendMessage: async () => { throw new Error('must remain quiet') }});
        expect(await unmeasured(state(2, 'red'))).toMatchObject({admitted: 0, quiet: true})
    });

    test('an activated ledger survives retained-history rollover and still admits a new fresh action', async () => {
        let   minute = 0;
        const store  = memoryStore(), sends = [], round = createOpenWorkWakeRound({store, gateOf: openGate,
            now: () => at(minute), sendMessage: async message => sends.push(message)});
        await round(state(0)); minute = 2000;
        await round(state(2000, 'red', {pulses: [{at: iso(500)}, {at: iso(2000)}]}));
        expect(sends).toHaveLength(1); expect(Object.values(store.read().holding)[0].status).toBe('admitted');
        expect(store.read().activation).toEqual({version: 1, at: iso(0)})
    });

    test('corrupt or unreadable stored history rejects without overwrite or send', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wake-invalid-')),
            file        = path.join(directory, 'open-work-wakes.json'), sends = [],
            wire        = () => wireFleetOpenWorkWakes({registry: {getDataDir: () => directory}, sendMessage: async message => sends.push(message), gateOf: openGate, now: () => at(1)});
        try {
            for (const contents of ['{"pulse":', '{}', '{"pulse":"2026-10-13T12:00:00Z","holding":[],"pendingMerges":{},"baselines":{}}']) {
                fs.writeFileSync(file, contents);
                await expect(wire()(state(1, 'red'))).rejects.toThrow();
                expect(fs.readFileSync(file, 'utf8')).toBe(contents)
            }
            fs.rmSync(file); fs.mkdirSync(file);
            await expect(wire()(state(1, 'red'))).rejects.toThrow(/EISDIR/);
            expect(sends).toEqual([])
        } finally { fs.rmSync(directory, {recursive: true, force: true}) }
    });

    test('concurrent calls share one round and the latest queued snapshot retains terminal history', async () => {
        let   minute  = 0, active = 0, maximum = 0;
        const entered = deferred(), release = deferred(), store = memoryStore(), sends = [],
            round = createOpenWorkWakeRound({store, gateOf: openGate, now: () => at(minute), sendMessage: async message => {
                active++; maximum = Math.max(maximum, active); sends.push(message);
                if (sends.length === 1) { entered.resolve(); await release.promise } active--
            }});
        await round(state(0)); minute = 1; const first = round(state(1, 'red')); await entered.promise;
        minute = 2; const second = round(state(2, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: [merged(2)]}));
        minute = 3; const third = round(state(3, 'pending', {snapshot: {rows: {}, closed: {}}, transitions: []}));
        expect(second).toBe(first); expect(third).toBe(first); release.resolve(); await first;
        expect(maximum).toBe(1); expect(sends.map(message => message.task.kind)).toEqual(['repair-ci', 'post-merge']);
        expect(store.read().pulse).toBe(iso(3))
    });

    test('stop waits for the active sender, drops queued work and rejects no new round', async () => {
        let   minute  = 0, closed = false;
        const entered = deferred(), release = deferred(), sends = [], round = createOpenWorkWakeRound({store: memoryStore(),
            gateOf: openGate, now: () => at(minute), sendMessage: async message => { sends.push(message); entered.resolve(); await release.promise; expect(closed).toBe(false) }});
        await round(state(0)); minute = 1; const running = round(state(1, 'red')); await entered.promise;
        minute = 2; round(state(2, 'green'));
        const stopped = round.stop().then(() => { closed = true });
        await Promise.resolve(); expect(closed).toBe(false);
        expect(await round(state(3, 'green'))).toMatchObject({stopped: true});
        release.resolve(); await running; await stopped;
        expect(closed).toBe(true); expect(sends).toHaveLength(1)
    });

    test('factory requires only the durable registry and injected sender and performs no polling', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wake-wire-')), sends = [], registry = {getDataDir: () => directory};
        try {
            expect(wireFleetOpenWorkWakes()).toBeNull();
            expect(wireFleetOpenWorkWakes({registry})).toBeNull();
            expect(wireFleetOpenWorkWakes({sendMessage: () => {}})).toBeNull();
            const round = wireFleetOpenWorkWakes({registry, sendMessage: async message => sends.push(message), gateOf: openGate, now: () => at(0)});
            await Promise.resolve(); expect(fs.readdirSync(directory)).toEqual([]); expect(sends).toEqual([]);
            await round(state(0)); expect(fs.existsSync(path.join(directory, 'open-work-wakes.json'))).toBe(true);
            await round.stop()
        } finally { fs.rmSync(directory, {recursive: true, force: true}) }
    });

    test('rotation episodes for outside PRs persist under the rotation slot and validate on the next round (#1008)', async () => {
        let   minute = 0;
        const store  = memoryStore(), sends = [],
            round    = createOpenWorkWakeRound({store, gateOf: openGate, rotationSeats: [SEAT], now: () => at(minute), sendMessage: async message => sends.push(message)}),
            outside  = (minute, ci, runApproval = null) => ({
                observedAt: iso(minute), coverage: 'complete', transitions: [],
                pulses    : [{at: iso(-1500)}, {at: iso(minute), seats: [{seat: SEAT, benched: false}]}],
                snapshot  : {closed: {}, rows: {'acme/app#42': {
                    key      : 'acme/app#42', repo: 'acme/app', number: 42, head: HEAD,
                    owner    : {kind: 'outside', seat: null, login: 'contributor'}, ci, verdict: null,
                    mergeable: 'MERGEABLE', draft: false, bot: false, authorAssociation: 'CONTRIBUTOR',
                    runApproval, requested: [], reviews: [], opinions: [], partial: false, observedAt: iso(minute)
                }}}
            });

        await round(outside(0, 'pending'));
        minute = 1;
        expect(await round(outside(1, 'green'))).toMatchObject({admitted: 1});
        expect(sends[0]).toMatchObject({to: SEAT, subject: expect.stringContaining('[open-work:triage-outside] acme/app#42')});
        minute = 2;
        expect(await round(outside(2, 'green'))).toMatchObject({admitted: 0});
        await round.stop()
    });
});
