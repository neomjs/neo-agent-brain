import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import {
    armSeatWakePull,
    connectSeatPlane,
    PULL_ROUTE,
    seatPlaneGap,
    typesIntoWindow
} from '../../../../../../ai/daemons/wake/armSeatWakePull.mjs';
import {VIEWER_BINDING_UNAVAILABLE} from '../../../../../../ai/services/fleet/planeMailboxClient.mjs';

/**
 * Pull arming (`ai/daemons/wake/armSeatWakePull.mjs`): arming subscribes the seat's pull
 * route first, then unsubscribes exactly the seat's own active `SENT_TO_ME` routes that type into a
 * window, and touches nothing else.
 */

/**
 * @summary A plane client that answers from a script and records every call in order.
 * @param {Object[]} subscriptions What `list` returns.
 * @returns {Object}
 */
function scriptedClient(subscriptions) {
    const calls = [];

    return {
        calls,
        async callTool(name, args) {
            calls.push({name, ...args});

            if (args.action === 'subscribe')   return {subscriptionId: 'WAKE_SUB:pull', status: 'existing'};
            if (args.action === 'list')        return {subscriptions};
            if (args.action === 'unsubscribe') return {subscriptionId: args.subscriptionId, status: 'removed'};

            throw new Error(`unscripted action ${args.action}`)
        }
    }
}

const route = (id, overrides) => ({
    id,
    agentIdentity        : '@neo-seat',
    status               : 'active',
    trigger              : 'SENT_TO_ME',
    harnessTarget        : 'a2a-webhook',
    harnessTargetMetadata: {adapter: 'osascript', appName: 'Claude'},
    ...overrides
});

test.describe('typesIntoWindow', () => {
    test('a push route on osascript, or on no adapter at all, types into a window', () => {
        expect(typesIntoWindow(route('a'))).toBe(true);
        expect(typesIntoWindow(route('b', {harnessTargetMetadata: {}}))).toBe(true);
        expect(typesIntoWindow(route('c', {harnessTarget: 'bridge-daemon', harnessTargetMetadata: {appName: 'Claude'}}))).toBe(true)
    });

    test('a pull route, a non-push target and a focus-free adapter do not', () => {
        expect(typesIntoWindow(route('d', {harnessTarget: 'none', harnessTargetMetadata: {}}))).toBe(false);
        expect(typesIntoWindow(route('e', {harnessTarget: 'mcp-notifications', harnessTargetMetadata: {}}))).toBe(false);
        expect(typesIntoWindow(route('f', {harnessTargetMetadata: {adapter: 'codex-app-server', appName: 'Codex'}}))).toBe(false)
    })
});

test.describe('armSeatWakePull', () => {
    test('subscribes the pull route before it unsubscribes anything', async () => {
        const client = scriptedClient([route('WAKE_SUB:osascript')]);

        await armSeatWakePull({client, identity: '@neo-seat'});

        expect(client.calls[0]).toEqual({name: 'manage_wake_subscription', action: 'subscribe', ...PULL_ROUTE});
        expect(client.calls.at(-1)).toEqual({name: 'manage_wake_subscription', action: 'unsubscribe', subscriptionId: 'WAKE_SUB:osascript'})
    });

    test('unsubscribes exactly the seat\'s own active SENT_TO_ME routes that type into a window', async () => {
        const client = scriptedClient([
            route('retire:a2a-osascript'),
            route('retire:bridge-appName', {harnessTarget: 'bridge-daemon', harnessTargetMetadata: {appName: 'Claude'}}),
            route('keep:retired',          {status: 'retired'}),
            route('keep:other-trigger',    {trigger: 'TASK_STATE_CHANGED'}),
            route('keep:focus-free',       {harnessTargetMetadata: {adapter: 'claude-courier'}}),
            route('keep:pull',             {harnessTarget: 'none', harnessTargetMetadata: {}}),
            route('keep:foreign',          {agentIdentity: '@neo-peer'})
        ]);

        const result = await armSeatWakePull({client, identity: '@neo-seat'});

        expect(result).toEqual({subscriptionId: 'WAKE_SUB:pull', retired: ['retire:a2a-osascript', 'retire:bridge-appName']});
        expect(client.calls.filter(call => call.action === 'unsubscribe').map(call => call.subscriptionId))
            .toEqual(['retire:a2a-osascript', 'retire:bridge-appName'])
    });

    test('a plane that names no pull route fails the arming before anything is unsubscribed', async () => {
        const calls  = [],
              client = {async callTool(name, args) {calls.push(args.action); return {}}};

        await expect(armSeatWakePull({client, identity: '@neo-seat'})).rejects.toThrow(/without naming it/);
        expect(calls).toEqual(['subscribe'])
    })
});

test.describe('connectSeatPlane', () => {
    test('names a missing plane or identity without creating a client', async () => {
        let   created      = 0;
        const createClient = () => {created++; return {}};

        expect(seatPlaneGap({planeBase: ' ', identity: '@neo-seat'})).toMatch(/fleet\.planeBase is not configured/);
        expect((await connectSeatPlane({planeBase: '', identity: 'neo-seat', createClient})).reason).toMatch(/fleet\.planeBase/);
        expect((await connectSeatPlane({planeBase: 'http://127.0.0.1:3102', identity: '', createClient})).reason).toMatch(/NEO_AGENT_IDENTITY/);
        expect(created).toBe(0)
    });

    test('proves the seat on the plane\'s Memory Core and closes a client that fails the proof', async () => {
        const seen   = [];
        let   closed = 0;

        const createClient = options => {
            seen.push(options);

            return {
                async init({expectedIdentity}) {
                    seen.push(expectedIdentity);
                    return {ok: false, reason: 'plane unreachable (TypeError)'}
                },
                async close() {closed++}
            }
        };

        const result = await connectSeatPlane({planeBase: 'http://127.0.0.1:3102/', planeBearer: 'secret', identity: 'neo-seat', createClient});

        expect(seen).toEqual([{baseUrl: 'http://127.0.0.1:3102/mc/mcp', credential: 'secret'}, '@neo-seat']);
        expect(result).toEqual({reason: 'the plane credential did not prove @neo-seat: plane unreachable (TypeError)', refused: false});
        expect(closed).toBe(1)
    });

    test('marks a credential the plane binds to another identity as refused, and a missing plane too', async () => {
        const createClient = () => ({
            async init() {return {ok: false, reason: 'plane identity mismatch', blockerCode: VIEWER_BINDING_UNAVAILABLE}},
            async close() {}
        });

        expect((await connectSeatPlane({planeBase: 'http://127.0.0.1:3102', identity: 'neo-seat', createClient})).refused).toBe(true);
        expect((await connectSeatPlane({planeBase: '', identity: 'neo-seat', createClient})).refused).toBe(true)
    });

    test('returns the proven client and the seat\'s canonical identity', async () => {
        const client = {async init() {return {ok: true, identity: '@neo-seat'}}};

        expect(await connectSeatPlane({planeBase: 'http://127.0.0.1:3102', identity: '@neo-seat', createClient: () => client}))
            .toEqual({client, identity: '@neo-seat'})
    })
});
