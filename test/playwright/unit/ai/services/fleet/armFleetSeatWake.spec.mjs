import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import {armFleetSeatWake, GUI_WAKE_DISPATCH}               from '../../../../../../ai/services/fleet/armFleetSeatWake.mjs';
import {deriveHarnessLaunchSpec, deriveHarnessWakeAddress} from '../../../../../../ai/services/fleet/deriveHarnessLaunchSpec.mjs';

/**
 * Fleet-side wake arming for a launched GUI seat (`ai/services/fleet/armFleetSeatWake.mjs`).
 *
 *   Address      — the route addresses the `--user-data-dir` the Fleet launched the window with,
 *                  from one derivation, so the receiver and the launch can never disagree.
 *   One route    — every start subscribes the seat's canonical route AS ITSELF (proven credential);
 *                  the plane's route key answers a repeat with the row it holds, and a row on
 *                  another receiver, trigger or filter neither stands in for it nor is withdrawn.
 *   Ready        — only when the publish carries the route this start subscribed.
 *   The plane    — a seat on the plane the Fleet serves subscribes with its own stored plane credential.
 *   Non-vacuity  — a resident seat, a seat on another plane, a plane seat without its credential, an
 *                  undeclared receiver, an unproven credential: each stays unarmed with its own reason
 *                  and never subscribes.
 *   Never throws — a failure becomes `unarmed` with a redacted, bounded cause; the client is closed.
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
    }),
    // The one route every start asks the plane for.
    CANONICAL = Object.freeze({
        action               : 'subscribe',
        trigger              : 'SENT_TO_ME',
        filters              : {},
        harnessTarget        : 'a2a-webhook',
        harnessTargetMetadata: {
            adapter        : 'osascript',
            appName        : 'Codex',
            focusSeedKey   : 'r',
            url            : `${RECEIVER}/wake`,
            addressType    : 'userDataDir',
            instanceAddress: PROFILE
        }
    });

/** The plane the seat's credential was stored against. */
const STORED_PLANE = Object.freeze({id: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data'});

/** `served` is the plane answering now: arming must meet the stored one there before any effect. */
function tenantService({endpoint = PLANE, credential = 'seat-credential', seatCredential = 'seat-plane-credential', served = STORED_PLANE} = {}) {
    const proofs = [];

    return {
        proofs,
        resolveMcpResources : tenantId => tenantId === 'local'
            ? {tenantId, endpoint, resources: {'memory-core': {url: `${endpoint}/mc/mcp`}}}
            : null,
        resolveMcpCredential      : tenantId => tenantId === 'local' ? credential : null,
        resolveSeatPlaneCredential: ({planeBase, agentId}) => planeBase === PLANE && agentId === 'neo-gpt-sophie' && seatCredential
            ? {credential: seatCredential, plane: STORED_PLANE}
            : null,
        // the service's own comparison, over the plane this double serves
        probeSeatPlaneCredential: async args => {
            proofs.push(args);

            return served.id === args.expectedPlane?.id && served.dataRoot === args.expectedPlane?.dataRoot
                ? {ok: true}
                : {ok: false, reason: 'the plane at this endpoint is not the one the credential was stored for'}
        }
    }
}

/** A row the seat owns on the plane, addressed to the launched window: the canonical route unless overridden. */
function row({id = 'WAKE_SUB:stale', trigger = 'SENT_TO_ME', filters = {}, url = `${RECEIVER}/wake`} = {}) {
    return {
        id,
        status               : 'active',
        agentIdentity        : '@neo-gpt-sophie',
        trigger,
        filters,
        harnessTarget        : 'a2a-webhook',
        routeDeliverable     : true,
        harnessTargetMetadata: {adapter: 'osascript', appName: 'Codex', url, addressType: 'userDataDir', instanceAddress: PROFILE}
    }
}

/** `rows` is what the plane lists AFTER the subscribe; `subscribed` is what the subscribe answers. */
function fakePlane({
    proof      = {ok: true, identity: '@neo-gpt-sophie'},
    rows       = [],
    subscribed = {subscriptionId: 'WAKE_SUB:minted'},
    failOn     = null,
    failure    = 'plane refused the call'
} = {}) {
    const calls = {created: null, init: [], tools: [], closed: 0};

    return {
        calls,
        subscribeCalls: () => calls.tools.filter(call => call.args.action === 'subscribe').map(call => call.args),
        createClient  : options => {
            calls.created = options;

            return {
                init    : async args => { calls.init.push(args); return proof },
                callTool: async (name, args) => {
                    calls.tools.push({name, args});
                    if (args.action === failOn) throw new Error(failure);
                    if (args.action === 'list') return {subscriptions: rows};
                    if (args.action === 'subscribe') return subscribed;
                    return {}
                },
                close: async () => { calls.closed++ }
            }
        }
    }
}

/** The publisher's contract without a manifest: every row the plane lists is published as the seat's. */
async function publishListed({listSubscriptions}) {
    const rows = await listSubscriptions();

    return {armed: rows.length > 0, subscriptionIds: rows.map(listed => listed.id)}
}

function arm({agent = AGENT, plane = fakePlane(), publish = async () => ({armed: true, subscriptionIds: ['WAKE_SUB:minted']}), ...overrides} = {}) {
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
            armRoute     : async options => { armCalls.push(options); return publish(options) },
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

test.describe('armFleetSeatWake — one route per seat, subscribed as the seat', () => {
    test('a seat is proven, subscribed to its own window, and published', async () => {
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
        expect(plane.subscribeCalls()).toEqual([CANONICAL]);
        expect(armCalls).toHaveLength(1);
        expect(armCalls[0]).toMatchObject({
            manifestPath: MANIFEST,
            tuple       : {identity: '@neo-gpt-sophie', instanceAddress: PROFILE, instanceType: 'userDataDir'}
        });
        expect(plane.calls.closed).toBe(1);
    });

    test('a seat on the plane the Fleet serves subscribes there with its own plane credential, once arming proves the binding', async () => {
        const
            tenants                   = tenantService(),
            {result, plane, armCalls} = arm({agent: {...AGENT, mcpTarget: null}, tenantService: tenants});

        expect(await result).toMatchObject({state: 'ready', subscriptionId: 'WAKE_SUB:minted'});
        expect(tenants.proofs).toEqual([{
            planeBase       : PLANE,
            credential      : 'seat-plane-credential',
            expectedIdentity: '@neo-gpt-sophie',
            expectedPlane   : STORED_PLANE
        }]);
        expect(plane.calls.created).toEqual({baseUrl: `${PLANE}/mc/mcp`, credential: 'seat-plane-credential'});
        expect(plane.calls.init).toEqual([{expectedIdentity: '@neo-gpt-sophie'}]);
        expect(plane.subscribeCalls()).toEqual([CANONICAL]);
        expect(armCalls).toHaveLength(1);
    });

    // FleetManager.startAgent arms after every Start, and a Start on a running seat returns before
    // the start's own proof: arming is where the binding must hold for that path.
    for (const [label, served] of [
        ['another plane id',                 {...STORED_PLANE, id: 'neo-local-recreated'}],
        ['the same id over another data root', {...STORED_PLANE, dataRoot: '/elsewhere/.neo-ai-data'}]
    ]) {
        test(`a re-arm against ${label} subscribes nothing and publishes nothing`, async () => {
            const {result, plane, armCalls} = arm({agent: {...AGENT, mcpTarget: null}, tenantService: tenantService({served})});

            expect(await result).toMatchObject({
                state : 'unarmed',
                reason: 'the seat\'s plane credential is not proven on this plane: the plane at this endpoint is not the one the credential was stored for'
            });
            expect(plane.calls.created).toBeNull();
            expect(plane.subscribeCalls()).toEqual([]);
            expect(armCalls).toHaveLength(0);
        });
    }

    test('a repeat start asks for the identical route, so the plane answers with the row it holds', async () => {
        const first  = fakePlane(),
              second = fakePlane({rows: [row({id: 'WAKE_SUB:minted'})], subscribed: {subscriptionId: 'WAKE_SUB:minted', status: 'existing'}});

        await arm({plane: first}).result;

        expect(await arm({plane: second, publish: publishListed}).result).toMatchObject({state: 'ready', subscriptionId: 'WAKE_SUB:minted'});
        expect(second.subscribeCalls()).toEqual(first.subscribeCalls());
    });

    const NOT_THIS_ROUTE = [
        ['an older receiver',    {url: 'http://host.docker.internal:3100/wake'}],
        ['another trigger',      {trigger: 'TASK_STATE_CHANGED'}],
        ['a restrictive filter', {filters: {priority: 'high'}}]
    ];

    for (const [label, differs] of NOT_THIS_ROUTE) {
        test(`a same-window row on ${label} never stands in for the route, and is never withdrawn`, async () => {
            const plane    = fakePlane({rows: [row(differs), row({id: 'WAKE_SUB:minted'})]}),
                  {result} = arm({plane, publish: publishListed});

            expect(await result).toMatchObject({state: 'ready', subscriptionId: 'WAKE_SUB:minted'});
            expect(plane.subscribeCalls()).toEqual([CANONICAL]);
            expect(plane.calls.tools.map(call => call.args.action)).toEqual(['subscribe', 'list']);
        });

        test(`a publish carrying only the row on ${label} is not ready`, async () => {
            const {result} = arm({plane: fakePlane({rows: [row(differs)]}), publish: publishListed});

            expect(await result).toMatchObject({state: 'unarmed', reason: 'the publish carried no route for WAKE_SUB:minted', subscriptionId: null});
        });
    }

    test('a Claude Desktop seat carries the Claude dispatch and its home as the address', async () => {
        const plane    = fakePlane(),
              {result} = arm({plane, agent: {...AGENT, harnessType: 'claude-desktop'}, instanceHome: '/agents/a/harness/claude-desktop'});

        expect(await result).toMatchObject({state: 'ready', instanceAddress: '/agents/a/harness/claude-desktop'});

        const metadata = plane.subscribeCalls()[0].harnessTargetMetadata;

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
    const
        ON_PLANE = {...AGENT, mcpTarget: null},
        cases    = [
            ['a seat on a Fleet with no plane',     {agent: ON_PLANE, planeBase: null},                                  /resident Memory Core/],
            ['a seat on another plane',             {planeBase: 'https://elsewhere.example.com'},                        /not the plane this Fleet is attached to/],
            ['a plane seat without its credential', {agent: ON_PLANE, tenantService: tenantService({seatCredential: null})}, /holds no plane credential/],
            ['an undeclared receiver',              {receiverBase: ''},                                                  /no wake receiver is declared/],
            ['an undeclared manifest',              {manifestPath: ''},                                                  /no wake receiver is declared/],
            ['a disconnected plane',                {tenantService: {resolveMcpResources: () => null}},                  /not connected/],
            ['a seat with no identity',             {agent: {...AGENT, githubUsername: ''}},                             /no GitHub identity/],
            ['a seat with no launched home',        {instanceHome: null},                                                /no launched profile/]
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

        expect(await result).toMatchObject({state: 'unarmed', reason: 'the seat credential did not prove @neo-gpt-sophie: identity mismatch'});
        expect(plane.calls.tools).toHaveLength(0);
        expect(armCalls).toHaveLength(0);
        expect(plane.calls.closed).toBe(1);
    });
});

test.describe('armFleetSeatWake — never throws, and every reason is redacted and bounded', () => {
    test('a plane failure becomes unarmed with the cause, and the client is still closed', async () => {
        const plane              = fakePlane({failOn: 'subscribe'}),
              {result, armCalls} = arm({plane});

        expect(await result).toMatchObject({state: 'unarmed', reason: 'wake arming failed: plane refused the call'});
        expect(armCalls).toHaveLength(0);
        expect(plane.calls.closed).toBe(1);
    });

    test('a subscription the plane does not name is never published', async () => {
        const {result, armCalls} = arm({plane: fakePlane({subscribed: {}})});

        expect(await result).toMatchObject({state: 'unarmed', reason: 'the plane accepted the subscription without naming it'});
        expect(armCalls).toHaveLength(0);
    });

    test('a publish that leaves the seat unreachable reports the publisher\'s reason', async () => {
        const {result} = arm({publish: async () => ({armed: false, reason: 'the publish succeeded but produced no route owned by @neo-gpt-sophie'})});

        expect(await result).toMatchObject({state: 'unarmed', reason: expect.stringContaining('no route owned by @neo-gpt-sophie')});
    });

    const
        SECRET  = `ghp_${'a1B2'.repeat(9)}`,
        NOISY   = `refused for token ${SECRET} ${'x'.repeat(400)}`,
        SOURCES = [
            ['a thrown plane error', {plane: fakePlane({failOn: 'subscribe', failure: NOISY})}],
            ['the identity proof',   {plane: fakePlane({proof: {ok: false, reason: NOISY}})}],
            ['the publisher',        {publish: async () => ({armed: false, reason: NOISY})}]
        ];

    for (const [label, overrides] of SOURCES) {
        test(`a credential and an oversized message from ${label} reach the status redacted and bounded`, async () => {
            const {reason} = await arm(overrides).result;

            expect(reason).toContain('refused for token [redacted-token]');
            expect(reason).not.toContain(SECRET);
            expect(reason.length).toBeLessThanOrEqual(240);
        });
    }
});
