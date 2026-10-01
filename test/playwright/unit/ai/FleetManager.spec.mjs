import {setup} from '../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'FleetManagerTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}          from '@playwright/test';

import Neo                     from 'neo.mjs/src/Neo.mjs';
import * as core               from 'neo.mjs/src/core/_export.mjs';
import FleetLifecycleService   from '../../../../ai/services/fleet/FleetLifecycleService.mjs';
import FleetManager            from '../../../../ai/services/fleet/FleetManager.mjs';
import {armFleetSeatWake}      from '../../../../ai/services/fleet/armFleetSeatWake.mjs';
import {inspectFleetRepos}     from '../../../../ai/services/fleet/inspectFleetRepos.mjs';
import {startAgentProvisioned} from '../../../../ai/services/fleet/startAgentProvisioned.mjs';

const ENV_KEY = 'NEO_FLEET_MANAGED_ROOT';
let savedEnv;

/** Reset the singleton's injectable plain fields between serial cases. */
function reset() {
    FleetManager.managedRoot         = null;
    FleetManager.lifecycleService    = null;
    FleetManager.provisionAndStartFn = null;
    FleetManager.repoStatusFn        = null;
    FleetManager.wakeArmFn           = null;
    FleetManager.tenantService       = null;
    FleetManager.wakeStateOptions    = null;
    FleetManager.planeBase           = null;
}

// Singleton-stateful service → serial, with env + injected-field reset per case.
test.describe.configure({mode: 'serial'});

test.describe('Neo.ai.services.fleet.FleetManager', () => {
    test.beforeEach(() => { savedEnv = process.env[ENV_KEY]; delete process.env[ENV_KEY]; reset(); });
    test.afterEach(()  => {
        if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
        reset();
    });

    test('getManagedRoot: the injected managedRoot is the sole runtime authority', () => {
        FleetManager.managedRoot = '/explicit/root';
        process.env[ENV_KEY]     = '/env/root';
        expect(FleetManager.getManagedRoot()).toBe('/explicit/root');
    });

    test('getManagedRoot: a legacy env value cannot replace entrypoint injection', () => {
        process.env[ENV_KEY] = '/env/root';

        expect(() => FleetManager.getManagedRoot()).toThrow('managed root must be injected')
    });

    test('getManagedRoot: omission fails loud instead of selecting the importing checkout', () => {
        expect(() => FleetManager.getManagedRoot()).toThrow('managed root must be injected')
    });

    test('startAgent provisions+starts via the composer with the resolved root + lifecycle service', async () => {
        const lifecycle = {getRegistry: () => ({getAgent: () => null}), isRunning: () => false, status: () => ({}), start: () => ({})},
              calls     = [];

        FleetManager.managedRoot         = '/managed/root';
        FleetManager.lifecycleService    = lifecycle;
        FleetManager.provisionAndStartFn = async args => { calls.push(args); return {state: 'running'}; };

        const status = await FleetManager.startAgent('agent-a');

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({lifecycleService: lifecycle, managedRoot: '/managed/root', agentId: 'agent-a'});
        expect(status.state).toBe('running');
    });

    test('fleetRepoStatus inspects via the aggregator with the resolved root + the lifecycle registry', () => {
        const registry  = {marker: 'reg'},
              lifecycle = {getRegistry: () => registry},
              calls     = [];

        FleetManager.managedRoot      = '/managed/root';
        FleetManager.lifecycleService = lifecycle;
        FleetManager.repoStatusFn     = args => { calls.push(args); return [{agentId: 'a'}]; };

        const result = FleetManager.fleetRepoStatus();

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({registry, managedRoot: '/managed/root'});
        expect(result).toEqual([{agentId: 'a'}]);
    });

    test('stopAgent delegates to the lifecycle service stop with the agent id', async () => {
        const calls     = [],
              lifecycle = {stop: id => { calls.push(id); return Promise.resolve({success: true, id, state: 'stopped'}); }};

        FleetManager.lifecycleService = lifecycle;

        const result = await FleetManager.stopAgent('agent-a');

        expect(calls).toEqual(['agent-a']);
        expect(result).toMatchObject({success: true, id: 'agent-a', state: 'stopped'});
    });

    test('restartAgent stops then re-starts via the PROVISIONED path (preserving the repo cwd)', async () => {
        const order     = [],
              lifecycle = {
                  getRegistry: () => ({getAgent: () => null}),
                  stop       : id => { order.push(`stop:${id}`); return Promise.resolve({success: true, id, state: 'stopped'}); }
              };

        FleetManager.managedRoot         = '/managed/root';
        FleetManager.lifecycleService    = lifecycle;
        FleetManager.provisionAndStartFn = async args => { order.push(`provisionStart:${args.agentId}`); return {state: 'running'}; };

        const status = await FleetManager.restartAgent('agent-a');

        // stop runs BEFORE the provisioned start, and the start goes through the provision-then-start
        // composer (NOT lifecycleService.restart, which the stub deliberately omits) → the restarted
        // agent re-runs in its provisioned checkout, not the Fleet Manager's dir.
        expect(order).toEqual(['stop:agent-a', 'provisionStart:agent-a']);
        expect(status.state).toBe('running');
    });

    test('removeAgent stops the process THEN deregisters via the registry', async () => {
        const order     = [],
              registry  = {removeAgent: id => { order.push(`deregister:${id}`); return {success: true, id}; }},
              lifecycle = {
                  stop       : id => { order.push(`stop:${id}`); return Promise.resolve({success: true, id, state: 'stopped'}); },
                  getRegistry: () => registry
              };

        FleetManager.lifecycleService = lifecycle;

        const result = await FleetManager.removeAgent('agent-a');

        // stop precedes deregister — a running agent is never deregistered while live.
        expect(order).toEqual(['stop:agent-a', 'deregister:agent-a']);
        expect(result).toEqual({success: true, id: 'agent-a'});
    });

    test('removeAgent on a non-running agent: stop is a safe no-op, deregister still proceeds', async () => {
        const order    = [],
              registry = {removeAgent: id => { order.push(`deregister:${id}`); return {success: false, id}; }},
              // a non-running agent: stop resolves {success:false} without an exit — removal must still deregister.
              lifecycle = {
                  stop       : id => { order.push(`stop:${id}`); return Promise.resolve({success: false, id, state: 'stopped'}); },
                  getRegistry: () => registry
              };

        FleetManager.lifecycleService = lifecycle;

        const result = await FleetManager.removeAgent('absent-agent');

        // stop's {success:false} (not running) does NOT short-circuit removal; deregister still runs.
        expect(order).toEqual(['stop:absent-agent', 'deregister:absent-agent']);
        expect(result).toEqual({success: false, id: 'absent-agent'});
    });

    test('seams default to the real composers (a no-injection construction wires them)', () => {
        expect(FleetManager.getProvisionAndStartFn()).toBe(startAgentProvisioned);
        expect(FleetManager.getRepoStatusFn()).toBe(inspectFleetRepos);
        expect(FleetManager.getWakeArmFn()).toBe(armFleetSeatWake);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — wake arming after start', () => {
    const
        HOME         = '/agents/agent-a/harness/codex-desktop',
        LAUNCH       = Object.freeze({pid: 4101, startedAt: '2026-10-01T18:00:00.000Z'}),
        READY        = Object.freeze({state: 'ready', reason: null, adapter: 'osascript', addressType: 'userDataDir', instanceAddress: `${HOME}/electron-profile`, subscriptionId: 'WAKE_SUB:x'}),
        TENANT_AGENT = {id: 'agent-a', harnessType: 'codex-desktop', githubUsername: 'neo-agent-a', mcpTarget: {kind: 'tenant', tenantId: 'local'}},
        adopted      = FleetLifecycleService.leasesAdopted;

    /**
     * Wires the manager around a recording lifecycle stub, or around the real lifecycle's bookkeeping
     * (`real: true`) where its launch check and status projection are under test.
     */
    function configure({agent = TENANT_AGENT, arm, real = false, planeBase = 'http://127.0.0.1:3102', provision = async () => ({state: 'running', instanceHome: HOME, ...LAUNCH})}) {
        const recorded = [],
              armCalls = [],
              tenants  = {marker: 'tenant-service'};

        FleetManager.managedRoot         = '/managed/root';
        FleetManager.tenantService       = tenants;
        FleetManager.provisionAndStartFn = provision;
        FleetManager.planeBase           = planeBase;
        FleetManager.wakeStateOptions    = {wakeReceiverBase: 'http://host.docker.internal:3199', wakeReceiverManifestPath: '/host/wake/routes.json'};
        FleetManager.wakeArmFn           = async args => { armCalls.push(args); return arm(args) };
        FleetManager.lifecycleService    = {
            getRegistry : () => ({getAgent: () => agent}),
            setWakeRoute: real
                ? (...args) => FleetLifecycleService.setWakeRoute(...args)
                : (id, route, launch) => { recorded.push({id, route, launch}); return true }
        };

        return {recorded, armCalls, tenants}
    }

    test.beforeEach(() => { reset(); FleetLifecycleService.leasesAdopted = true; FleetLifecycleService.processes.delete('agent-a'); });
    test.afterEach(() => { reset(); FleetLifecycleService.processes.delete('agent-a'); FleetLifecycleService.leasesAdopted = adopted; });

    test('a started seat is armed with the entrypoint\'s receiver coordinates, and the route is recorded for that launch', async () => {
        const {recorded, armCalls, tenants} = configure({arm: () => READY});

        expect(await FleetManager.startAgent('agent-a')).toEqual({state: 'running', instanceHome: HOME, ...LAUNCH, wakeRoute: READY});
        expect(armCalls[0]).toEqual({
            agent        : TENANT_AGENT,
            instanceHome : HOME,
            planeBase    : 'http://127.0.0.1:3102',
            receiverBase : 'http://host.docker.internal:3199',
            manifestPath : '/host/wake/routes.json',
            tenantService: tenants
        });
        expect(recorded).toEqual([{id: 'agent-a', route: READY, launch: LAUNCH}]);
    });

    test('an arming error never fails the start: the seat runs, unarmed, with the cause', async () => {
        const {recorded} = configure({arm: () => { throw new Error('receiver unreachable') }});

        expect(await FleetManager.startAgent('agent-a')).toMatchObject({state: 'running', wakeRoute: {state: 'unarmed', reason: 'wake arming failed: receiver unreachable'}});
        expect(recorded[0].route.state).toBe('unarmed');
    });

    test('a credential or an oversized message in an arming error reaches neither the start status nor the later lifecycle status', async () => {
        const secret = `github_pat_${'A1b2'.repeat(10)}`;

        FleetLifecycleService.processes.set('agent-a', {id: 'agent-a', state: 'running', ...LAUNCH, wakeRoute: null});
        configure({real: true, arm: () => { throw new Error(`plane said ${secret} ${'x'.repeat(500)}`) }});

        const started = (await FleetManager.startAgent('agent-a')).wakeRoute.reason,
              later   = FleetLifecycleService.status('agent-a').wakeRoute.reason;

        for (const reason of [started, later]) {
            expect(reason).toMatch(/^wake arming failed: plane said \[redacted-token\] x/);
            expect(reason).not.toContain(secret);
            expect(reason.length).toBeLessThanOrEqual(240);
        }
    });

    test('a slow arm for an earlier launch never overwrites the route of the restart that replaced it', async () => {
        // Both launches run at the same profile path; only the launch identity tells them apart.
        let   launches = 0;
        const slow     = Promise.withResolvers(),
              arms     = [() => slow.promise, () => READY];

        configure({
            real     : true,
            arm      : () => arms.shift()(),
            provision: async () => {
                const launch = {pid: 4100 + ++launches, startedAt: `2026-10-01T18:00:0${launches}.000Z`};

                FleetLifecycleService.processes.set('agent-a', {id: 'agent-a', state: 'running', ...launch, wakeRoute: null});
                return {state: 'running', instanceHome: HOME, ...launch}
            }
        });

        const earlier = FleetManager.startAgent('agent-a'),
              current = await FleetManager.startAgent('agent-a');

        slow.resolve({...READY, state: 'unarmed', reason: 'the earlier launch failed late', subscriptionId: null});

        expect(current.wakeRoute).toEqual(READY);
        expect((await earlier).wakeRoute.reason).toBe('the earlier launch failed late');
        expect(FleetLifecycleService.status('agent-a')).toMatchObject({pid: 4102, wakeRoute: {state: 'ready', subscriptionId: 'WAKE_SUB:x'}});
    });

    test('a family with no GUI wake leaves the status and the record untouched', async () => {
        const {recorded} = configure({agent: {...TENANT_AGENT, harnessType: 'opencode'}, arm: () => null});

        expect(await FleetManager.startAgent('agent-a')).toEqual({state: 'running', instanceHome: HOME, ...LAUNCH});
        expect(recorded).toEqual([]);
    });

    test('a seat on the plane the Fleet serves is handed the tenant service, which holds its plane credential', async () => {
        const {armCalls, tenants} = configure({agent: {...TENANT_AGENT, mcpTarget: null}, arm: () => READY});

        await FleetManager.startAgent('agent-a');
        expect(armCalls[0].tenantService).toBe(tenants);
    });

    test('a resident seat, on a Fleet that serves no plane, is handed no tenant service', async () => {
        const {armCalls} = configure({agent: {...TENANT_AGENT, mcpTarget: null}, planeBase: null, arm: () => ({state: 'unarmed', reason: 'resident'})});

        await FleetManager.startAgent('agent-a');
        expect(armCalls[0].tenantService).toBeNull();
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — a seat\'s plane credential', () => {
    const
        SEAT   = Object.freeze({id: 'agent-a', githubUsername: 'neo-agent-a', harnessType: 'codex'}),
        STORED = Object.freeze({status: 'stored', endpoint: 'http://127.0.0.1:3102', agentId: 'agent-a'});

    /** The plane and the identity come from the Fleet; the caller names only the seat and the credential. */
    function configure({planeBase = 'http://127.0.0.1:3102'} = {}) {
        const calls = [];

        FleetManager.planeBase        = planeBase;
        FleetManager.tenantService    = {storeSeatPlaneCredential: async args => { calls.push(args); return STORED }};
        FleetManager.lifecycleService = {getRegistry: () => ({getAgent: id => id === 'agent-a' ? SEAT : null})};

        return calls
    }

    test.beforeEach(reset);
    test.afterEach(reset);

    test('the credential is stored for the plane this Fleet serves, as the identity the seat\'s row names', async () => {
        const calls = configure();

        expect(await FleetManager.setPlaneCredential({id: 'agent-a', credential: 'seat-plane-pat', planeBase: 'https://elsewhere.example.com', identity: '@someone-else'}))
            .toEqual(STORED);
        expect(calls).toEqual([{planeBase: 'http://127.0.0.1:3102', agentId: 'agent-a', identity: 'neo-agent-a', credential: 'seat-plane-pat'}]);
    });

    test('a Fleet that serves no plane, and an unknown seat, store nothing', async () => {
        let calls = configure({planeBase: null});

        expect(await FleetManager.setPlaneCredential({id: 'agent-a', credential: 'x'})).toEqual({status: 'rejected', reason: 'this Fleet serves no plane'});
        expect(calls).toEqual([]);

        calls = configure();

        expect(await FleetManager.setPlaneCredential({id: 'agent-b', credential: 'x'})).toEqual({status: 'rejected', reason: 'unknown agent'});
        expect(calls).toEqual([]);
    });
});
