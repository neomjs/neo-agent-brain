import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import {armFleetSeatWake, GUI_WAKE_DISPATCH, isLiveRouteFor} from '../../../../../../ai/services/fleet/armFleetSeatWake.mjs';
import {deriveHarnessLaunchSpec, deriveHarnessWakeAddress}   from '../../../../../../ai/services/fleet/deriveHarnessLaunchSpec.mjs';

/**
 * Fleet-side wake arming for a launched GUI seat (`ai/services/fleet/armFleetSeatWake.mjs`).
 *
 *   Address        — the route addresses the `--user-data-dir` the Fleet launched the window with,
 *                    from one derivation, so the receiver and the launch can never disagree.
 *   Subscribe once — a seat with no route reaching its window is subscribed AS ITSELF (proven
 *                    credential); a seat that already has one is not subscribed again.
 *   Non-vacuity    — a resident seat, a seat on another plane, an undeclared receiver, an unproven
 *                    credential: each stays unarmed with its own reason and never subscribes.
 *   Never throws   — a plane failure becomes `unarmed` with the cause, and the client is closed.
 *
 * The plane client, tenant service and publish step are injected; nothing leaves the process.
 */

const
    HOME     = '/agents/neo-gpt-sophie/harness/codex-desktop',
    PROFILE  = `${HOME}/electron-profile`,
    PLANE    = 'http://127.0.0.1:3102',
    RECEIVER = 'http://host.docker.internal:3199',
    MANIFEST = '/host/wake/routes.json',
    AGENT    = Object.freeze({
        id            : 'neo-gpt-sophie',
        harnessType   : 'codex-desktop',
        githubUsername: 'neo-gpt-sophie',
        mcpTarget     : {kind: 'tenant', tenantId: 'local'}
    });

function tenantService({endpoint = PLANE, credential = 'seat-credential'} = {}) {
    return {
        resolveMcpResources : tenantId => tenantId === 'local'
            ? {tenantId, endpoint, resources: {'memory-core': {url: `${endpoint}/mc/mcp`}}}
            : null,
        resolveMcpCredential: tenantId => tenantId === 'local' ? credential : null
    }
}

function liveRoute(instanceAddress, id = 'WAKE_SUB:existing') {
    return {
        id,
        status               : 'active',
        harnessTarget        : 'a2a-webhook',
        routeDeliverable     : true,
        harnessTargetMetadata: {adapter: 'osascript', addressType: 'userDataDir', instanceAddress}
    }
}

function fakePlane({proof = {ok: true, identity: '@neo-gpt-sophie'}, subscriptions = [], failOn = null} = {}) {
    const calls = {created: null, init: [], tools: [], closed: 0};

    return {
        calls,
        createClient: options => {
            calls.created = options;

            return {
                init    : async args => { calls.init.push(args); return proof },
                callTool: async (name, args) => {
                    calls.tools.push({name, args});
                    if (args.action === failOn) throw new Error('plane refused the call');
                    if (args.action === 'list') return {subscriptions};
                    if (args.action === 'subscribe') return {subscriptionId: 'WAKE_SUB:minted'};
                    return {}
                },
                close: async () => { calls.closed++ }
            }
        }
    }
}

function arm({agent = AGENT, plane = fakePlane(), published = {armed: true, routeCount: 1}, ...overrides} = {}) {
    const armCalls = [];

    return {
        armCalls,
        plane,
        result: armFleetSeatWake({
            agent,
            instanceHome : HOME,
            planeBase    : PLANE,
            receiverBase : RECEIVER,
            manifestPath : MANIFEST,
            tenantService: tenantService(),
            createClient : plane.createClient,
            armRoute     : async options => { armCalls.push(options); return published },
            logger       : {info() {}, warn() {}, error() {}},
            ...overrides
        })
    }
}

test.describe('armFleetSeatWake — the address is the launch profile', () => {
    test('the wake address IS the --user-data-dir each GUI family launches with', () => {
        const codex  = deriveHarnessLaunchSpec({harnessType: 'codex-desktop', instanceHome: HOME, binaryPath: '/app/Codex', cwd: '/agents/neo-gpt-sophie/repo'}),
              claude = deriveHarnessLaunchSpec({harnessType: 'claude-desktop', instanceHome: '/agents/a/harness/claude-desktop', binaryPath: '/app/Claude'});

        expect(codex.args[0]).toBe(`--user-data-dir=${deriveHarnessWakeAddress({harnessType: 'codex-desktop', instanceHome: HOME}).instanceAddress}`);
        expect(claude.args[0]).toBe(`--user-data-dir=${deriveHarnessWakeAddress({harnessType: 'claude-desktop', instanceHome: '/agents/a/harness/claude-desktop'}).instanceAddress}`);
    });

    test('a family the Fleet does not launch as a window has no wake address and no route slot', async () => {
        expect(deriveHarnessWakeAddress({harnessType: 'codex', instanceHome: HOME})).toBeNull();

        const {result, plane} = arm({agent: {...AGENT, harnessType: 'opencode'}});

        expect(await result).toBeNull();
        expect(plane.calls.created).toBeNull();
    });
});

test.describe('armFleetSeatWake — subscribes the seat once, as itself', () => {
    test('a seat with no route is proven, subscribed to its own window, and published', async () => {
        const {result, plane, armCalls} = arm();

        expect(await result).toEqual({
            state          : 'ready',
            reason         : null,
            adapter        : 'osascript',
            addressType    : 'userDataDir',
            instanceAddress: PROFILE,
            subscriptionId : 'WAKE_SUB:minted'
        });

        expect(plane.calls.created).toEqual({baseUrl: `${PLANE}/mc/mcp`, credential: 'seat-credential'});
        expect(plane.calls.init).toEqual([{expectedIdentity: '@neo-gpt-sophie'}]);

        const subscribe = plane.calls.tools.filter(call => call.args.action === 'subscribe');

        expect(subscribe).toEqual([{
            name: 'manage_wake_subscription',
            args: {
                action               : 'subscribe',
                trigger              : 'SENT_TO_ME',
                harnessTarget        : 'a2a-webhook',
                harnessTargetMetadata: {
                    adapter        : 'osascript',
                    appName        : 'Codex',
                    focusSeedKey   : 'r',
                    url            : `${RECEIVER}/wake`,
                    addressType    : 'userDataDir',
                    instanceAddress: PROFILE
                }
            }
        }]);

        expect(armCalls).toHaveLength(1);
        expect(armCalls[0]).toMatchObject({
            manifestPath: MANIFEST,
            tuple       : {identity: '@neo-gpt-sophie', instanceAddress: PROFILE, instanceType: 'userDataDir'}
        });
        expect(plane.calls.closed).toBe(1);
    });

    test('a second start finds the live route and subscribes nothing', async () => {
        const plane              = fakePlane({subscriptions: [liveRoute(PROFILE)]}),
              {result, armCalls} = arm({plane});

        expect(await result).toMatchObject({state: 'ready', subscriptionId: 'WAKE_SUB:existing'});
        expect(plane.calls.tools.some(call => call.args.action === 'subscribe')).toBe(false);
        expect(armCalls).toHaveLength(1);
    });

    test('a route to a DIFFERENT window does not count: the launched window gets its own', async () => {
        const plane    = fakePlane({subscriptions: [liveRoute('/old/profile')]}),
              {result} = arm({plane});

        expect(await result).toMatchObject({state: 'ready', subscriptionId: 'WAKE_SUB:minted'});
        expect(plane.calls.tools.filter(call => call.args.action === 'subscribe')).toHaveLength(1);
    });

    test('a Claude Desktop seat carries the Claude dispatch and its home as the address', async () => {
        const plane    = fakePlane(),
              {result} = arm({plane, agent: {...AGENT, harnessType: 'claude-desktop'}, instanceHome: '/agents/a/harness/claude-desktop'});

        expect(await result).toMatchObject({state: 'ready', instanceAddress: '/agents/a/harness/claude-desktop'});

        const metadata = plane.calls.tools.find(call => call.args.action === 'subscribe').args.harnessTargetMetadata;

        expect(metadata).toEqual({
            ...GUI_WAKE_DISPATCH['claude-desktop'],
            url            : `${RECEIVER}/wake`,
            addressType    : 'userDataDir',
            instanceAddress: '/agents/a/harness/claude-desktop'
        });
        expect(metadata).not.toHaveProperty('focusSeedKey');
    });
});

test.describe('armFleetSeatWake — non-vacuity: these seats never subscribe', () => {
    const cases = [
        ['a resident seat',            {agent: {...AGENT, mcpTarget: null}},              /resident Memory Core/],
        ['a seat on another plane',    {planeBase: 'https://elsewhere.example.com'},      /not the plane this Fleet is attached to/],
        ['an undeclared receiver',     {receiverBase: ''},                                /no wake receiver is declared/],
        ['an undeclared manifest',     {manifestPath: ''},                                /no wake receiver is declared/],
        ['a disconnected plane',       {tenantService: {resolveMcpResources: () => null}}, /not connected/],
        ['a seat with no identity',    {agent: {...AGENT, githubUsername: ''}},           /no GitHub identity/],
        ['a seat with no launched home', {instanceHome: null},                            /no launched profile/]
    ];

    for (const [label, overrides, reason] of cases) {
        test(label, async () => {
            const {result, plane, armCalls} = arm(overrides);

            expect((await result).state).toBe('unarmed');
            expect((await result).reason).toMatch(reason);
            expect(plane.calls.created).toBeNull();
            expect(armCalls).toHaveLength(0);
        });
    }

    test('a credential that proves another identity stops before any subscription', async () => {
        const plane              = fakePlane({proof: {ok: false, reason: 'identity mismatch'}}),
              {result, armCalls} = arm({plane});

        expect(await result).toMatchObject({state: 'unarmed', reason: expect.stringContaining('did not prove @neo-gpt-sophie: identity mismatch')});
        expect(plane.calls.tools).toHaveLength(0);
        expect(armCalls).toHaveLength(0);
        expect(plane.calls.closed).toBe(1);
    });
});

test.describe('armFleetSeatWake — never throws', () => {
    test('a plane failure becomes unarmed with the cause, and the client is still closed', async () => {
        const plane              = fakePlane({failOn: 'subscribe'}),
              {result, armCalls} = arm({plane});

        expect(await result).toMatchObject({state: 'unarmed', reason: 'wake arming failed: plane refused the call'});
        expect(armCalls).toHaveLength(0);
        expect(plane.calls.closed).toBe(1);
    });

    test('a publish that leaves the seat unreachable reports the publisher\'s reason', async () => {
        const {result} = arm({published: {armed: false, reason: 'the publish succeeded but produced no route owned by @neo-gpt-sophie'}});

        expect(await result).toMatchObject({state: 'unarmed', reason: expect.stringContaining('no route owned by @neo-gpt-sophie')});
    });
});

test.describe('isLiveRouteFor', () => {
    test('only an active, deliverable webhook route to the same userDataDir counts', () => {
        expect(isLiveRouteFor(liveRoute(PROFILE), PROFILE)).toBe(true);
        expect(isLiveRouteFor({...liveRoute(PROFILE), status: 'degraded'}, PROFILE)).toBe(false);
        expect(isLiveRouteFor({...liveRoute(PROFILE), routeDeliverable: false}, PROFILE)).toBe(false);
        expect(isLiveRouteFor({...liveRoute(PROFILE), harnessTarget: 'bridge-daemon'}, PROFILE)).toBe(false);
        expect(isLiveRouteFor(liveRoute('/other'), PROFILE)).toBe(false);
        expect(isLiveRouteFor({...liveRoute(null), harnessTargetMetadata: {addressType: 'userDataDir', userDataDir: PROFILE}}, PROFILE)).toBe(true);
    });
});
