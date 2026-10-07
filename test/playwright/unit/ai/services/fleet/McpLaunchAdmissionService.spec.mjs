import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'McpLaunchAdmissionServiceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                  from '@playwright/test';
import {Client}                        from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport, getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMcpExpressApp}           from '@modelcontextprotocol/sdk/server/express.js';
import {McpServer}                     from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import crypto                          from 'node:crypto';
import http                            from 'node:http';
import path                            from 'node:path';
import {fileURLToPath}                 from 'node:url';
import Neo                             from 'neo.mjs/src/Neo.mjs';
import * as core                       from 'neo.mjs/src/core/_export.mjs';

import McpLaunchAdmissionService  from '../../../../../../ai/services/fleet/McpLaunchAdmissionService.mjs';
import {createManagedAgentWorkspacePlan} from '../../../../../../ai/services/fleet/managedAgentWorkspacePlan.mjs';
import {
    LAUNCH_ADMISSION_PATH,
    createLaunchRequest,
    parseLaunchCapability,
    verifyLaunchResponse
} from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';

const
    REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    LAUNCHER  = path.join(REPO_ROOT, 'ai/mcp/client/fleetMcpLauncher.mjs'),
    LOGIN     = 'neo-opus-ada',
    PAT       = 'ghp_fixture_seat_pat',
    BEARER    = 'plane-fixture-bearer',
    // what Start injected into the seat, less the credentials its owners keep: the Bridge token, the placement
    START_ENV = Object.freeze({
        NEO_FLEET_BRIDGE_TOKEN: 'bridge-fixture-token',
        NEO_AGENT_IDENTITY    : LOGIN,
        NEO_PLANE_DATA_ROOT   : '/plane',
        HOME                  : '/Users/seat'
    }),
    service   = McpLaunchAdmissionService;

/**
 * @summary The owners Start names for the seat's PAT and plane credential. Each holds `held[name]` and proves a value
 * when `proves(name, value)` resolves true; every proof is recorded as `[name, value]`.
 */
function makeOwners({held = {GH_TOKEN: PAT, NEO_MCP_REMOTE_TOKEN: BEARER}, proves = () => true} = {}) {
    const
        state  = {held: {...held}, proves, proofs: []},
        owner  = (name, credential) => ({
            credential,
            resolve: () => state.held[name] ?? null,
            prove  : async value => { state.proofs.push([name, value]); return {ok: await state.proves(name, value)} }
        });

    state.owners = {GH_TOKEN: owner('GH_TOKEN', 'seat-pat'), NEO_MCP_REMOTE_TOKEN: owner('NEO_MCP_REMOTE_TOKEN', 'plane-bearer')};

    return state
}

/** @summary A promise the test settles by hand. */
function deferred() {
    let resolve;
    const promise = new Promise(settle => resolve = settle);

    return {promise, resolve}
}

/** @summary A registry definition of a Claude Desktop seat whose Fleet id is not its login. */
function seatDefinition(overrides = {}) {
    return {id: 'seat', githubUsername: LOGIN, harnessType: 'claude-desktop', launchOwner: 'fleet', mcpServers: null, ...overrides}
}

/** @summary The bound plan preparation returns: tenant MC/KB on `url`, the rest resident under `root`. */
function boundPlan({url = 'https://plane.example.test', root = '/installed/neo', matrix = {}} = {}) {
    const mcpMatrix = {'memory-core': true, 'knowledge-base': true, 'neural-link': true, 'github-workflow': true, 'gitlab-workflow': false, ...matrix};

    return createManagedAgentWorkspacePlan({
        agent    : {id: 'seat', harnessType: 'claude-desktop'},
        mcpMatrix,
        mcpTarget: {kind: 'tenant', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN', resources: {
            'memory-core': {url: `${url}/mc/mcp`}, 'knowledge-base': {url: `${url}/kb/mcp`}
        }}
    }).mcpServers.map(row => ({
        ...row,
        command   : process.execPath,
        sourceRoot: root,
        args      : row.target === 'tenant' ? [] : [path.join(root, row.entrypoint), ...(row.key === 'neural-link' ? ['--cwd', root] : [])],
        runtimeEnv: row.target === 'tenant' ? row.runtimeEnv : [...row.runtimeEnv, 'NEO_PLANE_DATA_ROOT']
    }))
}

/** @summary Redeem one capability the way the launcher does, returning the verified answer or the raw refusal. */
async function redeem(capability, {server, identity = LOGIN} = {}) {
    const
        grant    = parseLaunchCapability(capability),
        request  = createLaunchRequest({grant, server, identity}),
        response = JSON.parse(JSON.stringify(await service.redeem(request)));

    return verifyLaunchResponse(grant.secret, request, response) ?? {unsigned: true, ...response}
}

/** @summary An Observable standing in for the registry: tests fire its committed changes. */
function makeRegistry() {
    return Neo.create(Neo.core.Observable)
}

/** @summary Reserve and activate a seat whose process the probe reports. */
async function activeSeat({definition = seatDefinition(), registry = null, probe = () => 'live', plan = boundPlan(), env = START_ENV, owners = makeOwners().owners} = {}) {
    const reservation = await service.reserve({agent: definition, registry});

    service.activate({generation: reservation.generation, agentId: definition.id, plan, env, owners, probe});

    return reservation
}

test.beforeEach(() => {
    service.generations.clear();
    service.grants.clear();
    service.unattributed.length = 0;
    service.pendingTimeoutMs = 30000;
    service.proofTimeoutMs   = 10000
});

test.describe('McpLaunchAdmissionService — a generation\'s grants', () => {
    test('reserve mints one grant per enabled server, for the seat\'s login, and ends the seat\'s previous generation', async () => {
        const
            first  = await service.reserve({agent: seatDefinition({mcpServers: {'neural-link': false}})}),
            second = await service.reserve({agent: seatDefinition()});

        expect(Object.keys(first.grants).sort()).toEqual(['github-workflow', 'knowledge-base', 'memory-core']);
        expect([first.identity, first.issuer]).toEqual([LOGIN, expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)]);
        expect(second.issuer).toBe(first.issuer);
        expect(service.statusOf('seat')).toMatchObject({state: 'reserved', generation: second.generation});
        // a replaced generation's grants are no longer this issuer's
        expect(await redeem(first.grants['memory-core'], {server: 'memory-core'})).toEqual({unsigned: true, outcome: 'refused', code: 'unknown-grant'});

        await expect(service.reserve({agent: seatDefinition({githubUsername: '@'})})).rejects.toThrow('has no valid githubUsername identity')
    });

    test('each server gets exactly its own values: a seat credential from its owner, the Bridge token as Start injected it', async () => {
        const reservation = await activeSeat();

        const mc = await redeem(reservation.grants['memory-core'], {server: 'memory-core'});

        expect(mc).toEqual({
            outcome: 'admitted',
            env    : {NEO_MCP_REMOTE_TOKEN: BEARER},
            args   : ['/installed/neo/ai/mcp/client/stdioToStreamableHttp.mjs', '--url', 'https://plane.example.test/mc/mcp', '--token-env', 'NEO_MCP_REMOTE_TOKEN']
        });
        expect(await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'})).toEqual({
            outcome: 'admitted',
            env    : {GH_TOKEN: PAT},
            args   : ['/installed/neo/ai/mcp/server/github-workflow/mcp-server.mjs']
        });
        expect(await redeem(reservation.grants['neural-link'], {server: 'neural-link'})).toEqual({
            outcome: 'admitted',
            env    : {NEO_FLEET_BRIDGE_TOKEN: 'bridge-fixture-token'},
            args   : ['/installed/neo/ai/mcp/server/neural-link/mcp-server.mjs', '--cwd', '/installed/neo']
        })
    });

    test('a server whose required value has neither an owner nor a value from Start is revoked at activation; the others are admitted', async () => {
        const
            {GH_TOKEN, ...planeOnly} = makeOwners().owners,
            reservation              = await activeSeat({owners: planeOnly});

        expect(service.statusOf('seat').servers).toContainEqual({key: 'github-workflow', state: 'revoked', reason: 'credential-missing'});
        expect(await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'credential-missing'});
        expect((await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).outcome).toBe('admitted');

        await activeSeat({owners: {...planeOnly, GH_TOKEN: {credential: 'seat-pat', resolve: () => PAT}}});
        expect(service.statusOf('seat').servers, 'an owner that cannot prove owns nothing').toContainEqual({key: 'github-workflow', state: 'revoked', reason: 'credential-missing'})
    });

    test('redemptions repeat and run concurrently for as long as the generation is active', async () => {
        const
            reservation = await activeSeat(),
            answers     = await Promise.all([1, 2, 3].map(() => redeem(reservation.grants['memory-core'], {server: 'memory-core'})));

        expect(answers.map(answer => answer.outcome)).toEqual(['admitted', 'admitted', 'admitted']);
        expect((await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).outcome).toBe('admitted');
        expect(service.statusOf('seat').recent.map(entry => [entry.server, entry.outcome])).toEqual(Array(4).fill(['memory-core', 'admitted']));

        // the audit keeps the newest entries only, and none of them carries a value it handed over
        for (let i = 0; i < service.auditLimit; i++) await redeem(reservation.grants['neural-link'], {server: 'neural-link'});

        const {recent} = service.statusOf('seat');

        expect(recent).toHaveLength(service.auditLimit);
        expect(recent.every(entry => entry.server === 'neural-link')).toBe(true);
        expect(Object.keys(recent[0]).sort()).toEqual(['at', 'code', 'outcome', 'reason', 'server']);
        expect(JSON.stringify(recent)).not.toContain('bridge-fixture-token')
    });

    test('a redemption during Start waits for its outcome: admitted after activation, refused after revocation or the bound', async () => {
        let reservation = await service.reserve({agent: seatDefinition()});

        const pending = redeem(reservation.grants['memory-core'], {server: 'memory-core'});

        service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
        expect((await pending).outcome).toBe('admitted');

        reservation = await service.reserve({agent: seatDefinition()});

        const failing = redeem(reservation.grants['memory-core'], {server: 'memory-core'});

        service.revoke('seat', 'start-failed', {generation: reservation.generation});
        expect(await failing).toEqual({outcome: 'refused', code: 'revoked', reason: 'start-failed'});

        service.pendingTimeoutMs = 20;
        reservation = await service.reserve({agent: seatDefinition()});
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'pending-timeout'})
    });

    test('a request that proves no grant is refused unsigned and recorded without attribution', async () => {
        const
            reservation = await activeSeat(),
            grant       = parseLaunchCapability(reservation.grants['memory-core']),
            forged      = createLaunchRequest({grant: {id: grant.id, secret: crypto.randomBytes(32).toString('base64url')}, server: 'memory-core', identity: LOGIN});

        expect(await service.redeem(forged)).toEqual({outcome: 'refused', code: 'proof-mismatch'});
        expect(await service.redeem({grant: grant.id})).toEqual({outcome: 'refused', code: 'malformed'});
        expect(service.unattributedAudit().map(entry => entry.code)).toEqual(['proof-mismatch', 'malformed']);
        expect(service.unattributedAudit().every(entry => !('server' in entry) && !('generation' in entry))).toBe(true);
        expect(service.statusOf('seat').recent).toEqual([])
    });

    test('a proven grant used for another server or identity is refused, signed and recorded against its seat', async () => {
        const reservation = await activeSeat();

        expect(await redeem(reservation.grants['memory-core'], {server: 'knowledge-base'})).toEqual({outcome: 'refused', code: 'server-mismatch'});
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core', identity: 'someone-else'})).toEqual({outcome: 'refused', code: 'identity-mismatch'});
        expect(service.statusOf('seat').recent.map(entry => entry.code)).toEqual(['server-mismatch', 'identity-mismatch'])
    });

    test('a launched process proven gone revokes the generation; one that cannot be identified admits nothing but ends nothing', async () => {
        let observed = 'unknown';

        const reservation = await activeSeat({probe: () => observed});

        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'process-unknown'});
        expect(service.statusOf('seat').state).toBe('active');

        observed = 'gone';
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'process-exited'});

        observed = 'live';
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'process-exited'});
        expect(service.statusOf('seat')).toMatchObject({state: 'revoked', reason: 'process-exited'})
    });

    test('revocation is sticky: an activation after it changes nothing, and the values it held are gone', async () => {
        const reservation = await service.reserve({agent: seatDefinition()});

        expect(service.revoke('seat', 'stop-requested')).toBe(true);
        expect(service.revoke('seat', 'process-exited'), 'the first reason stands').toBe(false);

        service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});

        expect(service.statusOf('seat', {running: true})).toMatchObject({state: 'revoked', reason: 'stop-requested'});
        expect(service.generations.get('seat').owners, 'nor does it keep an owner').toEqual({});
        expect(JSON.stringify([...service.generations.get('seat').servers.values()])).not.toContain('bridge-fixture-token');
        expect(await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'stop-requested'})
    });

    test('a seat this issuer holds no generation for reads stale while it runs, and none while it does not', () => {
        expect(service.statusOf('adopted', {running: true})).toEqual({state: 'stale', reason: 'issuer-replaced', generation: null, since: null, servers: [], recent: []});
        expect(service.statusOf('adopted')).toMatchObject({state: 'none', reason: null});
        expect(service.holds('adopted')).toBe(false)
    });
});

test.describe('McpLaunchAdmissionService — committed registry changes', () => {
    test('switching a server off revokes its grant for the rest of the generation, even once it is switched on again', async () => {
        const
            registry    = makeRegistry(),
            reservation = await activeSeat({registry}),
            change      = mcpServers => registry.fire('definitionChange', {id: 'seat', previous: null, next: seatDefinition({mcpServers})});

        change({'neural-link': false});
        change({'neural-link': true});

        expect(await redeem(reservation.grants['neural-link'], {server: 'neural-link'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'server-disabled'});
        expect((await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).outcome).toBe('admitted');

        // a change the grants do not depend on revokes nothing
        registry.fire('definitionChange', {id: 'seat', previous: null, next: seatDefinition({model: 'claude-opus-5-5'})});
        expect(service.statusOf('seat').state).toBe('active')
    });

    test('a changed harness, MCP target or launch owner, a launch override or a removal ends the whole generation', async () => {
        for (const [next, reason] of [
            [seatDefinition({harnessType: 'claude-code'}), 'plan-changed'],
            [seatDefinition({mcpTarget: {kind: 'tenant', tenantId: 'other'}}), 'plan-changed'],
            [seatDefinition({launchOwner: 'external'}), 'plan-changed'],
            [seatDefinition({metadata: {launch: {command: '/bin/sh'}}}), 'plan-changed'],
            [null, 'agent-removed']
        ]) {
            const registry = makeRegistry();

            await activeSeat({registry});
            registry.fire('definitionChange', {id: 'seat', previous: null, next});

            expect(service.statusOf('seat'), reason).toMatchObject({state: 'revoked', reason})
        }
    });

    test('a change committed while Start is still running is not undone by the activation', async () => {
        const
            registry    = makeRegistry(),
            reservation = await service.reserve({agent: seatDefinition(), registry});

        registry.fire('definitionChange', {id: 'seat', previous: null, next: seatDefinition({mcpServers: {'github-workflow': false}})});
        service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});

        expect(service.statusOf('seat').servers).toContainEqual({key: 'github-workflow', state: 'revoked', reason: 'server-disabled'})
    });

    test('a write committed after the caller read the definition, before it reserved, revokes what it would at once', async () => {
        for (const [current, expected] of [
            [seatDefinition({mcpServers: {'github-workflow': false}}), {state: 'reserved', github: {key: 'github-workflow', state: 'revoked', reason: 'server-disabled'}}],
            [seatDefinition({mcpTarget: {kind: 'tenant', tenantId: 'other'}}), {state: 'revoked', reason: 'plan-changed'}],
            [null, {state: 'revoked', reason: 'agent-removed'}],
            [seatDefinition(), {state: 'reserved', github: {key: 'github-workflow', state: 'reserved', reason: null}}]
        ]) {
            const registry = makeRegistry();

            registry.getDefinition = id => id === 'seat' ? current : null;

            const reservation = await service.reserve({agent: seatDefinition(), registry}), status = service.statusOf('seat');

            expect(status, JSON.stringify(current)).toMatchObject({state: expected.state, ...(expected.reason ? {reason: expected.reason} : {})});
            expected.github && expect(status.servers).toContainEqual(expected.github);

            service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
            expect((await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'})).outcome, JSON.stringify(current))
                .toBe(expected.github?.state === 'reserved' ? 'admitted' : 'refused')
        }
    });

    test('a switch-off or a Stop while the reservation awaits its listener lands on it; a listener that fails revokes it', async () => {
        const gate = deferred();

        service.listen = () => gate.promise;

        try {
            const
                registry = makeRegistry(),
                switched = service.reserve({agent: seatDefinition(), registry});

            registry.fire('definitionChange', {id: 'seat', previous: null, next: seatDefinition({mcpServers: {'github-workflow': false}})});
            gate.resolve('http://127.0.0.1:1');

            const reservation = await switched;

            service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
            expect(await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'server-disabled'});

            const stopped = service.reserve({agent: seatDefinition()});

            expect(service.revoke('seat', 'stop-requested'), 'the reservation exists before the listener answers').toBe(true);

            const second = await stopped;

            service.activate({generation: second.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
            expect(await redeem(second.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'stop-requested'});

            service.listen = () => Promise.reject(new Error('listen EADDRINUSE'));
            await expect(service.reserve({agent: seatDefinition()})).rejects.toThrow('EADDRINUSE');
            expect(service.statusOf('seat')).toMatchObject({state: 'revoked', reason: 'start-failed'})
        } finally {
            delete service.listen
        }
    });
});

test.describe('McpLaunchAdmissionService — seat credentials, redeemed from their owners', () => {
    test('each redemption resolves the credential from its owner and proves it; a later child gets what the owner holds then', async () => {
        const
            owners      = makeOwners(),
            reservation = await activeSeat({owners: owners.owners}),
            github      = () => redeem(reservation.grants['github-workflow'], {server: 'github-workflow'});

        expect((await github()).env).toEqual({GH_TOKEN: PAT});

        owners.held.GH_TOKEN = 'ghp_fixture_rebound';
        expect((await github()).env).toEqual({GH_TOKEN: 'ghp_fixture_rebound'});
        expect(owners.proofs).toEqual([['GH_TOKEN', PAT], ['GH_TOKEN', 'ghp_fixture_rebound']]);

        // the issuer keeps neither value
        expect(JSON.stringify([...service.generations.get('seat').servers.values()])).not.toMatch(/ghp_fixture/)
    });

    test('an owner holding nothing refuses credential-missing and an unproved value credential-unproven; neither ends the generation or falls back', async () => {
        const
            owners      = makeOwners(),
            reservation = await activeSeat({owners: owners.owners}),
            redeemOn    = server => redeem(reservation.grants[server], {server});

        owners.held.GH_TOKEN = null;
        expect(await redeemOn('github-workflow')).toEqual({outcome: 'refused', code: 'credential-missing', reason: 'seat-pat'});

        // a registry PAT B never stands in for the plane credential A the seat's plane owner holds
        owners.held.GH_TOKEN = 'ghp_fixture_b';
        owners.proves        = name => name !== 'GH_TOKEN';
        expect(await redeemOn('github-workflow')).toEqual({outcome: 'refused', code: 'credential-unproven', reason: 'seat-pat'});
        expect((await redeemOn('memory-core')).env).toEqual({NEO_MCP_REMOTE_TOKEN: BEARER});

        owners.owners.GH_TOKEN.resolve = () => { throw new Error('store unreadable') };
        expect((await redeemOn('github-workflow')).code).toBe('credential-missing');

        owners.owners.NEO_MCP_REMOTE_TOKEN.prove = async () => { throw new Error('plane unreachable') };
        expect(await redeemOn('knowledge-base')).toEqual({outcome: 'refused', code: 'credential-unproven', reason: 'plane-bearer'});

        expect(service.statusOf('seat').state).toBe('active');
        expect(service.statusOf('seat').recent.map(entry => [entry.server, entry.code, entry.reason])).toEqual([
            ['github-workflow', 'credential-missing', 'seat-pat'],
            ['github-workflow', 'credential-unproven', 'seat-pat'],
            ['memory-core', null, null],
            ['github-workflow', 'credential-missing', 'seat-pat'],
            ['knowledge-base', 'credential-unproven', 'plane-bearer']
        ])
    });

    test('the checks after the proof decide: a Stop, a switch-off or the process ending while it runs refuses', async () => {
        for (const [interrupt, reason] of [
            [() => service.revoke('seat', 'stop-requested'), 'stop-requested'],
            [registry => registry.fire('definitionChange', {id: 'seat', previous: null, next: seatDefinition({mcpServers: {'github-workflow': false}})}), 'server-disabled'],
            [(registry, seat) => seat.observed = 'gone', 'process-exited']
        ]) {
            const
                registry    = makeRegistry(),
                seat        = {observed: 'live'},
                proof       = deferred(),
                owners      = makeOwners({proves: () => proof.promise}),
                reservation = await activeSeat({registry, owners: owners.owners, probe: () => seat.observed}),
                answer      = redeem(reservation.grants['github-workflow'], {server: 'github-workflow'});

            await expect.poll(() => owners.proofs.length).toBe(1);
            interrupt(registry, seat);
            proof.resolve(true);

            expect(await answer, reason).toEqual({outcome: 'refused', code: 'revoked', reason})
        }
    });

    test('the child gets exactly the value that proved, even when its owner changes while the proof runs', async () => {
        const
            proof       = deferred(),
            owners      = makeOwners({proves: () => proof.promise}),
            reservation = await activeSeat({owners: owners.owners}),
            answer      = redeem(reservation.grants['github-workflow'], {server: 'github-workflow'});

        await expect.poll(() => owners.proofs.length).toBe(1);
        owners.held.GH_TOKEN = 'ghp_fixture_written_meanwhile';
        proof.resolve(true);

        expect((await answer).env).toEqual({GH_TOKEN: PAT})
    });

    test('concurrent redemptions of one value share its proof, the next one proves again, and a proof past its bound has not proved', async () => {
        const
            proof       = deferred(),
            owners      = makeOwners({proves: () => proof.promise}),
            reservation = await activeSeat({owners: owners.owners}),
            answers     = Promise.all(['memory-core', 'knowledge-base', 'memory-core'].map(server => redeem(reservation.grants[server], {server})));

        await expect.poll(() => owners.proofs.length).toBe(1);
        proof.resolve(true);
        expect((await answers).map(answer => answer.outcome)).toEqual(['admitted', 'admitted', 'admitted']);
        expect(owners.proofs).toEqual([['NEO_MCP_REMOTE_TOKEN', BEARER]]);

        owners.proves = () => true;
        await redeem(reservation.grants['memory-core'], {server: 'memory-core'});
        expect(owners.proofs).toHaveLength(2);

        service.proofTimeoutMs = 20;
        owners.proves          = () => new Promise(() => {});
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'credential-unproven', reason: 'plane-bearer'})
    });
});

test.describe('McpLaunchAdmissionService — the loopback listener', () => {
    /** @summary POST raw bytes to the issuer with chosen headers. */
    function post(origin, {pathname = LAUNCH_ADMISSION_PATH, host = new URL(origin).host, body = '{}'} = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request(new URL(pathname, origin), {method: 'POST', headers: {host, 'content-type': 'application/json'}}, res => {
                const chunks = [];

                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8'))}))
            });

            req.on('error', reject);
            req.end(body)
        })
    }

    test('only a POST on its one path, addressed to its own loopback port, with a JSON body reaches a redemption', async () => {
        const
            reservation = await activeSeat(),
            grant       = parseLaunchCapability(reservation.grants['memory-core']),
            request     = createLaunchRequest({grant, server: 'memory-core', identity: LOGIN}),
            admitted    = await post(reservation.issuer, {body: JSON.stringify(request)});

        expect(new URL(reservation.issuer).hostname).toBe('127.0.0.1');
        expect([admitted.status, verifyLaunchResponse(grant.secret, request, admitted.body)?.outcome]).toEqual([200, 'admitted']);
        expect((await post(reservation.issuer, {body: JSON.stringify({...request, identity: 'someone-else', proof: request.proof})})).status).toBe(403);
        expect((await post(reservation.issuer, {body: '{not json'})).status).toBe(400);
        expect((await post(reservation.issuer, {pathname: '/fleet', body: JSON.stringify(request)})).status).toBe(404);
        // a name that only resolves to this listener, as a rebinding page would send, is not this listener
        expect((await post(reservation.issuer, {host: `localhost:${new URL(reservation.issuer).port}`, body: JSON.stringify(request)})).status).toBe(404)
    });
});

test.describe('McpLaunchAdmissionService — a Desktop row launched for real', () => {
    /** @summary An authenticated Streamable-HTTP MCP endpoint per resource, counting the sessions each opened. */
    async function startPlaneFixture(token) {
        const
            app        = createMcpExpressApp({allowedHosts: ['127.0.0.1']}),
            sessions   = new Map(),
            opened     = [],
            closers    = new Set();

        app.use((request, response, next) => {
            if (request.headers.authorization !== `Bearer ${token}`) {
                response.status(401).json({error: 'unauthorized'});
                return
            }

            next()
        });

        for (const resource of ['mc', 'kb']) {
            app.all(`/${resource}/mcp`, async (request, response) => {
                let transport = sessions.get(request.headers['mcp-session-id']);

                if (!transport) {
                    const server = new McpServer({name: `${resource}-plane-fixture`, version: '1.0.0'});

                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator  : () => crypto.randomUUID(),
                        onsessioninitialized: id => { sessions.set(id, transport); opened.push(resource) },
                        onsessionclosed     : id => sessions.delete(id)
                    });
                    server.registerTool('plane_probe', {description: `Name the ${resource} fixture.`, inputSchema: {}},
                        async () => ({content: [{type: 'text', text: resource}]}));
                    closers.add(() => server.close());
                    await server.connect(transport)
                }

                await transport.handleRequest(request, response, request.body)
            })
        }

        const listener = await new Promise((resolve, reject) => {
            const server = app.listen(0, '127.0.0.1', () => resolve(server));
            server.once('error', reject)
        });

        return {
            url   : `http://127.0.0.1:${listener.address().port}`,
            opened,
            close : async () => {
                await Promise.allSettled([...closers].map(close => close()));
                await new Promise(resolve => listener.close(resolve))
            }
        }
    }

    /** @summary A Desktop profile row for one server, started as Desktop starts it: the row's env over a stripped base. */
    function launchRow({server, grant, issuer}) {
        const
            stderr    = [],
            transport = new StdioClientTransport({
                command: process.execPath,
                args   : [LAUNCHER, '--server', server],
                env    : {...getDefaultEnvironment(), NEO_AGENT_IDENTITY: LOGIN, NEO_FLEET_LAUNCH_ISSUER: issuer, NEO_FLEET_LAUNCH_GRANT: grant},
                stderr : 'pipe'
            });

        transport.stderr.on('data', chunk => stderr.push(String(chunk)));

        return {client: new Client({name: 'desktop-row-probe', version: '1.0.0'}), transport, stderr}
    }

    test('a row reaches its plane through the launcher, keeps working after revocation, and a later row refuses before it spawns', async () => {
        const
            token   = 'plane-secret-that-only-the-issuer-hands-over',
            fixture = await startPlaneFixture(token),
            opened  = [];

        try {
            const reservation = await service.reserve({agent: seatDefinition()});

            service.activate({
                generation: reservation.generation,
                agentId   : 'seat',
                plan      : boundPlan({url: fixture.url, root: REPO_ROOT}),
                env       : START_ENV,
                owners    : makeOwners({held: {NEO_MCP_REMOTE_TOKEN: token}}).owners,
                probe     : () => 'live'
            });

            const mc = launchRow({server: 'memory-core', grant: reservation.grants['memory-core'], issuer: reservation.issuer});

            opened.push(mc);
            await mc.client.connect(mc.transport);
            expect((await mc.client.callTool({name: 'plane_probe', arguments: {}})).content).toEqual([{type: 'text', text: 'mc'}]);

            // Stop intent: the running child keeps the values it started with
            service.revoke('seat', 'stop-requested');
            expect((await mc.client.callTool({name: 'plane_probe', arguments: {}})).content).toEqual([{type: 'text', text: 'mc'}]);

            // a child Desktop starts now is refused by its launcher, and never reaches the plane
            const kb = launchRow({server: 'knowledge-base', grant: reservation.grants['knowledge-base'], issuer: reservation.issuer});

            opened.push(kb);
            await expect(kb.client.connect(kb.transport)).rejects.toThrow();
            await expect.poll(() => kb.stderr.join('')).toContain('Neo MCP launch refused (revoked, stop-requested)');
            expect(fixture.opened).toEqual(['mc']);
            expect(kb.stderr.join('')).not.toContain(token)
        } finally {
            await Promise.allSettled(opened.map(row => row.client.close()));
            await fixture.close()
        }
    });

    test('a row whose issuer is gone, as after a Fleet restart, refuses before it spawns', async () => {
        const
            reservation = await activeSeat(),
            closed      = await new Promise(resolve => {
                const server = http.createServer().listen(0, '127.0.0.1', () => {
                    const {port} = server.address();

                    server.close(() => resolve(`http://127.0.0.1:${port}`))
                })
            }),
            row         = launchRow({server: 'memory-core', grant: reservation.grants['memory-core'], issuer: closed});

        try {
            await expect(row.client.connect(row.transport)).rejects.toThrow();
            await expect.poll(() => row.stderr.join('')).toContain('Neo MCP launch refused (issuer-unavailable)')
        } finally {
            await row.client.close()
        }
    });
});
