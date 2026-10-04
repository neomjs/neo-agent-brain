import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {name: 'SeatOperatorRegistryTest'}
});

import {test, expect}              from '@playwright/test';
import fs                          from 'node:fs';
import os                          from 'node:os';
import path                        from 'node:path';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import FleetRegistryService        from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import SeatOperatorRegistryService from '../../../../../../ai/services/fleet/SeatOperatorRegistryService.mjs';
import {dispatchFleetRequest}      from '../../../../../../ai/services/fleet/dispatchFleetRequest.mjs';
import {dispatchFleetS1Request, FLEET_METHOD_SCOPE_CLASSES} from '../../../../../../ai/services/fleet/fleetServerPolicy.mjs';
import {createFleetWireRequest}    from '../../../../../../src/fleet/contract/wire.mjs';

/**
 * @summary The seat operator relation, on real stores in a temp Fleet root: a define records its admitted
 * principal and a caller never names one, the lookup keeps an unreadable store apart from an absent seat,
 * and only the plane-host path assigns or transfers, all or nothing and compare-and-set.
 */
test.describe('the seat operator relation — one principal per seat, written by a define or the plane host', () => {
    const
        A         = 'owner:conn-1:1001',
        B         = 'owner:conn-1:2002',
        A2        = 'owner:conn-2:1001', // the same forge user behind a replaced connection: a new principal
        PAT       = `ghp_${'x'.repeat(36)}`,
        HOST      = {actor: 'os-user:plane-admin', apply: true},
        operators = SeatOperatorRegistryService,
        registry  = FleetRegistryService,
        define    = (id, admission) => registry.defineAgent({credential: PAT, githubUsername: id, harnessType: 'codex'}, admission),
        exists    = seatId => registry.getAgent(seatId) !== null,
        lockOf    = () => path.join(operators.getDataDir(), 'seat-operators.lock'),
        storeOf   = () => path.join(operators.getDataDir(), 'seat-operators.json');

    let dir;

    test.beforeEach(() => {
        dir               = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-operators-'));
        registry.dataDir  = dir;
        operators.dataDir = dir
    });

    test.afterEach(() => {
        registry.dataDir  = null;
        operators.dataDir = null;
        fs.rmSync(dir, {force: true, recursive: true})
    });

    test('a define records its admitted principal, a caller never names one, and a define without admission leaves the seat unowned', () => {
        define('ada', {ownerPrincipal: A});
        expect(registry.operatesSeat(A, 'ada')).toEqual({operates: true});

        expect(() => registry.defineAgent({credential: PAT, githubUsername: 'eve', harnessType: 'codex', operatedBy: B}, {ownerPrincipal: A})).toThrow('never named by the caller');
        expect(() => registry.defineAgent({credential: PAT, githubUsername: 'eve', harnessType: 'codex', ownerPrincipal: B})).toThrow('never named by the caller');
        expect(exists('eve'), 'a refused define creates nothing').toBe(false);

        define('legacy');
        expect(registry.operatesSeat(A, 'legacy')).toEqual({operates: false, reason: 'unowned'})
    });

    test('adopting a seat leaves its operator untouched: adoptAgent receives no admission, and its launch-owner write moves no relation', async () => {
        define('ada', {ownerPrincipal: A});
        define('legacy');

        const
            before = fs.readFileSync(storeOf(), 'utf8'),
            calls  = [];

        await dispatchFleetRequest(createFleetWireRequest('adoptAgent', {id: 'legacy'}), {adoptAgent: (...args) => {calls.push(args); return null}}, {ownerPrincipal: B});
        expect(calls, 'the admission never reaches adopt').toEqual([[{id: 'legacy'}]]);

        // the one write FleetManager#adoptAgent makes
        registry.setLaunchOwner('ada', 'fleet');
        registry.setLaunchOwner('legacy', 'fleet');

        expect(fs.readFileSync(storeOf(), 'utf8')).toBe(before);
        expect(registry.operatesSeat(A, 'ada')).toEqual({operates: true});
        expect(registry.operatesSeat(B, 'legacy')).toEqual({operates: false, reason: 'unowned'})
    });

    test('the lookup answers every state, and an unreadable store is unavailable, never an unknown or unowned seat', () => {
        define('ada', {ownerPrincipal: A});
        define('legacy');

        expect(registry.operatesSeat(A,    'ada')).toEqual({operates: true});
        expect(registry.operatesSeat(B,    'ada')).toEqual({operates: false, reason: 'other-operator'});
        expect(registry.operatesSeat(A,    'legacy')).toEqual({operates: false, reason: 'unowned'});
        expect(registry.operatesSeat(A,    'nobody')).toEqual({operates: false, reason: 'unknown-seat'});
        expect(registry.operatesSeat(null, 'ada')).toEqual({operates: false, reason: 'no-principal'});
        expect(registry.seatsOperatedBy(A)).toEqual({seats: ['ada'], state: 'ok'});

        const operatorBytes = fs.readFileSync(storeOf(), 'utf8');

        fs.writeFileSync(storeOf(), '{"schema": 1');
        expect(registry.operatesSeat(A, 'ada')).toEqual({operates: false, reason: 'unavailable'});
        expect(registry.seatsOperatedBy(A).state).toBe('unavailable');
        fs.writeFileSync(storeOf(), operatorBytes);

        const unreadable = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-registry-'));

        try {
            fs.writeFileSync(path.join(unreadable, 'registry.json'), '{');
            registry.dataDir = unreadable;
            expect(registry.operatesSeat(A, 'ada'), 'an unreadable seat registry is not an empty one').toEqual({operates: false, reason: 'unavailable'})
        } finally {
            registry.dataDir = dir;
            fs.rmSync(unreadable, {force: true, recursive: true})
        }
    });

    test('assign takes unowned seats only, all or nothing; the same principal again is a no-op with no event', () => {
        define('ada', {ownerPrincipal: A});
        define('grace');
        define('vega');

        const assign = (principal, seats, apply = true) => operators.assign({...HOST, apply, principal, seatExists: exists, seats});

        expect(assign(B, ['grace', 'vega'], false)).toMatchObject({applied: false, assigned: ['grace', 'vega'], ok: true});
        expect(registry.operatesSeat(B, 'grace'), 'a dry run writes nothing').toEqual({operates: false, reason: 'unowned'});

        const first = assign(B, ['grace', 'vega']);

        expect(first).toMatchObject({applied: true, assigned: ['grace', 'vega'], ok: true});
        expect(registry.seatsOperatedBy(B)).toEqual({seats: ['grace', 'vega'], state: 'ok'});

        expect(assign(B, ['grace', 'vega']), 'idempotent for the same principal').toMatchObject({applied: false, assigned: [], ok: true, unchanged: ['grace', 'vega'], version: first.version});

        define('emmy');
        expect(assign(A, ['emmy', 'grace'])).toMatchObject({ok: false, refused: 'other-operator'});
        expect(registry.operatesSeat(A, 'emmy'), 'a refusal assigns nothing, not even the unowned seat').toEqual({operates: false, reason: 'unowned'});
        expect(assign(A, ['nobody'])).toMatchObject({ok: false, refused: 'unknown-seat'});
        expect(assign('@neo-opus-ada', ['emmy'])).toMatchObject({ok: false, refused: 'no-principal'})
    });

    test('transfer is compare-and-set: only the current operator moves, and a replaced connection gets its seat back on the host', () => {
        define('ada', {ownerPrincipal: A});
        define('legacy');

        const transfer = (from, seat, to) => operators.transfer({...HOST, from, seat, to});

        expect(transfer(B, 'ada', A2)).toMatchObject({ok: false, refused: 'not-current'});
        expect(transfer(A, 'legacy', A2)).toMatchObject({ok: false, refused: 'unowned'});
        expect(transfer(A, 'ada', A)).toMatchObject({ok: false, refused: 'same-principal'});
        expect(registry.operatesSeat(A, 'ada'), 'refusals move nothing').toEqual({operates: true});

        expect(transfer(A, 'ada', A2)).toMatchObject({applied: true, ok: true});
        expect(registry.operatesSeat(A2, 'ada')).toEqual({operates: true});
        expect(registry.operatesSeat(A,  'ada')).toEqual({operates: false, reason: 'other-operator'})
    });

    test('a store that cannot be trusted is never replaced, a held lock refuses, and every write appends one event', () => {
        define('ada', {ownerPrincipal: A});
        define('grace');

        const store = JSON.parse(fs.readFileSync(storeOf(), 'utf8'));

        // a define without admission and nothing to clear writes no event
        expect(store.events.map(({op, seatId, principal}) => ({op, seatId, principal}))).toEqual([{op: 'define', principal: A, seatId: 'ada'}]);

        fs.writeFileSync(lockOf(), '');
        expect(operators.assign({...HOST, principal: B, seatExists: exists, seats: ['grace']})).toMatchObject({ok: false, refused: 'busy'});
        expect(operators.assign({...HOST, apply: false, principal: B, seatExists: exists, seats: ['grace']}), 'a dry run needs no lock').toMatchObject({ok: true});
        fs.rmSync(lockOf());

        fs.writeFileSync(storeOf(), '{"schema": 2}');
        expect(operators.assign({...HOST, principal: B, seatExists: exists, seats: ['grace']})).toMatchObject({ok: false, refused: 'store-unavailable'});
        expect(() => define('vega', {ownerPrincipal: A}), 'a create whose operator cannot be recorded is refused').toThrow('cannot be trusted');
        expect(() => define('vega'), 'an unadmitted one too: the store could hide a predecessor\'s record').toThrow('cannot be trusted');
        expect(exists('vega'), 'nothing was written').toBe(false);
        expect(fs.readFileSync(storeOf(), 'utf8'), 'left exactly as found').toBe('{"schema": 2}')
    });

    test('a recreated seat never inherits its predecessor\'s operator: the create claims it first, and a refused claim refuses the create', () => {
        define('ada', {ownerPrincipal: A});
        registry.removeAgent('ada');
        expect(operators.operatorOf('ada'), 'a remove releases the record').toEqual({principal: null, state: 'ok'});

        // a release the store refuses keeps the record; the next create clears it all the same
        define('ada', {ownerPrincipal: A});
        fs.writeFileSync(lockOf(), '');
        registry.removeAgent('ada');
        expect(operators.operatorOf('ada').principal, 'the refused release kept it').toBe(A);

        expect(() => define('ada', {ownerPrincipal: B}), 'a held lock refuses the create').toThrow('in progress; try again');
        expect(exists('ada'), 'nothing was written').toBe(false);
        expect(registry.operatesSeat(A, 'ada'), 'the kept record names no defined seat').toEqual({operates: false, reason: 'unknown-seat'});
        fs.rmSync(lockOf());

        define('ada');
        expect(registry.operatesSeat(A, 'ada'), 'recreated without admission').toEqual({operates: false, reason: 'unowned'});

        registry.removeAgent('ada');
        define('ada', {ownerPrincipal: B});
        expect(registry.operatesSeat(B, 'ada')).toEqual({operates: true});
        expect(registry.operatesSeat(A, 'ada')).toEqual({operates: false, reason: 'other-operator'})
    });

    test('a create whose credential or registry write fails leaves only an orphaned claim, which no lookup reads as operated and the next create replaces', () => {
        for (const failing of ['writeCredentials', 'writeRegistry']) {
            registry[failing] = () => {throw new Error(`${failing} failed`)};

            try {
                expect(() => define('ada', {ownerPrincipal: A}), failing).toThrow(`${failing} failed`)
            } finally {
                delete registry[failing]
            }

            expect(exists('ada'), failing).toBe(false);
            expect(operators.operatorOf('ada').principal, `${failing}: the claim stays, orphaned`).toBe(A);
            expect(registry.operatesSeat(A, 'ada'), failing).toEqual({operates: false, reason: 'unknown-seat'});
            expect(registry.seatsOperatedBy(A), failing).toEqual({seats: [], state: 'ok'});

            define('ada');
            expect(registry.operatesSeat(A, 'ada'), `${failing}: the next create cleared it`).toEqual({operates: false, reason: 'unowned'});
            registry.removeAgent('ada')
        }
    });

    test('an event log its version does not count, or a registry with no agents table, reads unavailable and is never repaired', () => {
        define('ada', {ownerPrincipal: A});

        const good = JSON.parse(fs.readFileSync(storeOf(), 'utf8'));

        for (const broken of [{...good, version: 999}, {...good, events: []}, {...good, events: [{...good.events[0], seq: 7}]}]) {
            const bytes = JSON.stringify(broken);

            fs.writeFileSync(storeOf(), bytes);
            expect(registry.operatesSeat(A, 'ada')).toEqual({operates: false, reason: 'unavailable'});
            expect(registry.seatsOperatedBy(A).state).toBe('unavailable');
            expect(operators.assign({...HOST, principal: B, seatExists: exists, seats: ['ada']})).toMatchObject({ok: false, refused: 'store-unavailable'});
            expect(operators.release({seatId: 'ada'})).toMatchObject({ok: false, refused: 'store-unavailable'});
            expect(fs.readFileSync(storeOf(), 'utf8'), 'never repaired').toBe(bytes)
        }

        fs.writeFileSync(storeOf(), JSON.stringify(good));
        expect(registry.operatesSeat(A, 'ada')).toEqual({operates: true});

        for (const malformed of ['{"agents": 42}', '[]', '42']) {
            const other = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-registry-'));

            try {
                fs.writeFileSync(path.join(other, 'registry.json'), malformed);
                registry.dataDir = other;
                expect(registry.operatesSeat(A, 'ada'), malformed).toEqual({operates: false, reason: 'unavailable'});
                expect(registry.seatsOperatedBy(A).state, malformed).toBe('unavailable');
                expect(fs.readFileSync(path.join(other, 'registry.json'), 'utf8'), malformed).toBe(malformed)
            } finally {
                registry.dataDir = dir;
                fs.rmSync(other, {force: true, recursive: true})
            }
        }
    });

    test('no relation path keys on a login, an AgentIdentity id or a checkout path', () => {
        const shapes = ['neo-opus-ada', '@neo-opus-ada', '/home/operator/github/neomjs/neo'];

        define('ada', {ownerPrincipal: A});
        define('legacy');

        const before = fs.readFileSync(storeOf(), 'utf8');

        shapes.forEach((shape, index) => {
            expect(registry.operatesSeat(shape, 'ada'), shape).toEqual({operates: false, reason: 'no-principal'});
            expect(registry.seatsOperatedBy(shape), shape).toEqual({seats: [], state: 'ok'});
            expect(operators.claim({principal: shape, seatId: 'legacy'}), shape).toMatchObject({ok: false, refused: 'no-principal'});
            expect(operators.assign({...HOST, principal: shape, seatExists: exists, seats: ['legacy']}), shape).toMatchObject({ok: false, refused: 'no-principal'});
            expect(operators.transfer({...HOST, from: A, seat: 'ada', to: shape}), shape).toMatchObject({ok: false, refused: 'no-principal'});

            // an admission of that shape refuses the create: its operator could not be recorded
            expect(() => define(`seat${index}`, {ownerPrincipal: shape}), shape).toThrow('the admission carries no owner principal');
            expect(exists(`seat${index}`), shape).toBe(false)
        });

        expect(fs.readFileSync(storeOf(), 'utf8'), 'no refused shape wrote anything').toBe(before);

        // a store whose record names one is untrusted, never read as that operator
        const store = JSON.parse(before);

        store.operators.ada.principal = '@neo-opus-ada';
        fs.writeFileSync(storeOf(), JSON.stringify(store));
        expect(registry.operatesSeat(A, 'ada')).toEqual({operates: false, reason: 'unavailable'})
    });

    test('no wire verb reaches the host path, and the admission reaches only a seat-creating verb', async () => {
        expect(Object.keys(FLEET_METHOD_SCOPE_CLASSES).filter(method => /seat.?operators?|^assign|^transfer/i.test(method))).toEqual([]);

        const
            calls  = [],
            bridge = {
                defineAgent: (...args) => {calls.push(['defineAgent', ...args]); return {id: 'x'}},
                getAgent   : (...args) => {calls.push(['getAgent', ...args]); return null}
            };

        await dispatchFleetRequest(createFleetWireRequest('defineAgent', {githubUsername: 'x'}), bridge, {ownerPrincipal: A});
        await dispatchFleetRequest(createFleetWireRequest('getAgent', 'x'), bridge, {ownerPrincipal: A});

        expect(calls).toEqual([['defineAgent', {githubUsername: 'x'}, {ownerPrincipal: A}], ['getAgent', 'x']]);

        // the composed service hands its admitted subject on, and only as the admission
        const composed = [];

        await dispatchFleetS1Request(createFleetWireRequest('getBootIdentity'), {getBootIdentity: (...args) => {composed.push(args.length); return null}}, {ownerPrincipal: A});
        expect(composed, 'a read verb receives params only').toEqual([1])
    })
});
