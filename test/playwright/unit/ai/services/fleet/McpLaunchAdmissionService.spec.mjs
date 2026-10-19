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

import {test, expect}                                from '@playwright/test';
import {Client}                                      from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport, getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMcpExpressApp}                         from '@modelcontextprotocol/sdk/server/express.js';
import {McpServer}                                   from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport}               from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import crypto                                        from 'node:crypto';
import fs                                            from 'fs-extra';
import http                                          from 'node:http';
import os                                            from 'node:os';
import path                                          from 'node:path';
import {holdRuntimeGenerationReferences}             from '../../../../../../ai/services/fleet/runtimeGenerationLease.mjs';

import {fileURLToPath} from 'node:url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

import McpLaunchAdmissionService                         from '../../../../../../ai/services/fleet/McpLaunchAdmissionService.mjs';
import FleetTenantService                                from '../../../../../../ai/services/fleet/FleetTenantService.mjs';
import aiConfig                                          from '../../../../../../ai/config.template.mjs';
import {snapshotAiConfig}                                from '../memory-core/util.mjs';
import {writeFileAtomicSync}                             from '../../../../../../ai/services/shared/atomicFileWrite.mjs';
import {createSeatPatOwner, createResidentMcpInputOwner} from '../../../../../../ai/services/fleet/launchCredentialOwners.mjs';
import {createManagedAgentWorkspacePlan}                 from '../../../../../../ai/services/fleet/managedAgentWorkspacePlan.mjs';
import {createSeatRuntimeRecord}                         from '../../../../../../ai/services/fleet/seatRuntimeRecord.mjs';
import {createDesktopLaunchBinding}                      from '../../../../../../ai/services/fleet/launchProfileCustody.mjs';
import {
    LAUNCH_ADMISSION_PATH,
    createLaunchRequest,
    parseLaunchCapability,
    verifyLaunchResponse
} from '../../../../../../ai/services/fleet/mcpLaunchAdmission.mjs';

/** @summary Holds actual file exclusion until a reference-producing fixture operation settles. */
function withTestRuntimeReferences(runtime, invoke) {
    const guard = holdRuntimeGenerationReferences({directory: path.dirname(runtime.directory)});
    try { return Promise.resolve(invoke(guard)).finally(() => guard.release()); }
    catch (error) { guard.release(); throw error; }
}
/** @summary Exercises the production reservation under an independently held real guard. */
function reserveWithRuntimeReferences(options) {
    return withTestRuntimeReferences(options.runtimeGeneration, runtimeReferenceGuard =>
        service.reserve({...options, runtimeReferenceGuard}));
}
/** @summary Exercises direct recovery with the fixture's original runtime parent. */
function recoverWithRuntimeReferences(options) {
    return withTestRuntimeReferences(options.runtime, runtimeReferenceGuard =>
        service.recover({...options, runtimeReferenceGuard}));
}

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
        state = {held: {...held}, proves, proofs: []},
        owner = (name, credential) => ({
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
async function activeSeat({definition = seatDefinition(), registry = null, probe = () => 'live', plan = boundPlan(), env = START_ENV, owners = makeOwners().owners, residentInputs = {}} = {}) {
    const reservation = await service.reserve({agent: definition, registry});

    service.activate({generation: reservation.generation, agentId: definition.id, plan, env, owners, residentInputs, probe});

    return reservation
}

test.beforeEach(() => {
    service.generations.clear();
    service.grants.clear();
    service.revocations.clear();
    service.unattributed.length = 0;
    service.pendingTimeoutMs = 30000;
    service.proofTimeoutMs   = 10000;
    service.continuityPhase = 'ready';
    service.handoffPromise = null;
});

test.describe('McpLaunchAdmissionService — original generation recovery', () => {
    let directory;
    /** @summary Simulates the predecessor releasing its actual listener before a journal transition. */
    async function closeListener() {
        if (service.httpServer) await new Promise(resolve => service.httpServer.close(resolve));
        service.httpServer = service.listening = service.issuerOrigin = null;
    }
    test.beforeEach(async () => {
        await closeListener();
        directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'admission-recovery-')));
    });
    test.afterEach(async () => {
        await closeListener();
        service.journal?.close();
        service.journal = null;
        service.journalFailed = false;
        service.continuityPhase = 'ready';
        service.readSeatStarts = null;
        fs.removeSync(directory);
    });

    /** @summary Produces original records through reserve/activate, then opens a real fenced successor journal. */
    async function predecessor({clean = true, revoke = false} = {}) {
        const matrix           = {'memory-core': false, 'knowledge-base': false, 'neural-link': false, 'github-workflow': true, 'gitlab-workflow': false};
        const agent            = seatDefinition({mcpServers: matrix});
        const state            = {agent, credential: PAT, observed: 'live', seats: []};
        const registry         = {getDataDir: () => directory, getDefinition: () => state.agent, resolveCredential: () => state.credential};
        const owner            = createSeatPatOwner({registry, agent, proveForgeAccount: async () => ({verdict: 'proved'})});
        const runtimeDirectory = path.join(directory, 'a'.repeat(64));
        const runtime          = {id: 'a'.repeat(64), directory: runtimeDirectory, payloadDigest: 'b'.repeat(64),
            runtimeRoot: `${runtimeDirectory}/host.runtime/organism`, executable: `${runtimeDirectory}/host.runtime/node`};
        const plan    = boundPlan({root: runtime.runtimeRoot, matrix}).map(row => ({...row, command: runtime.executable}));
        const custody = path.join(directory, 'custody');
        service.openJournal({directory: custody, readSeatStarts: () => state.seats});
        const reservation = await reserveWithRuntimeReferences({agent, registry, runtimeGeneration: runtime});
        const profile     = createDesktopLaunchBinding({identity: LOGIN, issuer: reservation.issuer, rows: {
            'neo-mjs-github-workflow': {env: {NEO_AGENT_IDENTITY: LOGIN, NEO_FLEET_LAUNCH_ISSUER: reservation.issuer,
                NEO_FLEET_LAUNCH_GRANT: reservation.grants['github-workflow']}}
        }});
        const start = createSeatRuntimeRecord({record: {id: 'seat', harnessType: 'claude-desktop', pid: 42,
            pidStartedAt       : 'Wed Oct 14 10:00:00 2026', startedAt: '2026-10-14T10:00:00Z', cwd: '/managed/repo',
            instanceHome       : '/managed/seat', launchCommand: '/vendor/Claude', profileArg: '--user-data-dir=/managed/seat',
            admissionGeneration: reservation.generation, runtimeGeneration: runtime,
            bridgeAuthority    : {version: 1, source: 'registry-file', registryRoot: directory, publicKeySha256: 'c'.repeat(64)}},
            identity           : LOGIN, plan, profile, leaseRequired: true, owners: {GH_TOKEN: owner}, env: START_ENV});
        state.seats = [{start, state: 'running', ownershipUnresolved: false, cleanupUnresolved: false}];
        service.activate({generation: reservation.generation, agentId: 'seat', plan, env: START_ENV,
            owners: {GH_TOKEN: owner}, probe: () => state.observed});
        if (revoke) service.revoke('seat', 'stop-requested');
        if (clean) await service.handoff({verifySeats: async () => {}});
        else { await closeListener(); service.journal.close(); }
        service.httpServer = service.listening = service.issuerOrigin = null;
        service.journal = null;
        service.generations.clear(); service.grants.clear();
        service.continuityPhase = 'ready'; service.handoffPromise = null;
        const previous    = service.openJournal({directory: custody, readSeatStarts: () => state.seats});
        const restoreSeat = async () => ({capabilities: reservation.grants, owners: {GH_TOKEN: owner}, residentInputs: {}, probe: () => state.observed});
        return {state, registry, reservation, previous, restoreSeat, custody, runtime};
    }

    test('a clean successor rebinds the original origin and redeems the same capability with current owner bytes', async () => {
        const f = await predecessor();
        f.state.credential = 'rotated-fixture-pat';
        await expect(service.recover(f)).rejects.toThrow(/not guarded/);
        expect(service.generations.size).toBe(0);
        expect(await recoverWithRuntimeReferences(f)).toEqual([{agentId: 'seat', state: 'active', reason: null, detail: null}]);
        expect(service.issuerOrigin).toBe(f.reservation.issuer);
        expect(await redeem(f.reservation.grants['github-workflow'], {server: 'github-workflow'}))
            .toMatchObject({outcome: 'admitted', env: {GH_TOKEN: 'rotated-fixture-pat'}, generationRoot: f.state.seats[0].start.runtime.runtimeRoot});
        const raw = fs.readFileSync(path.join(f.custody, 'issuer.json'), 'utf8');
        expect(raw).not.toContain('rotated-fixture-pat');
        expect(raw).not.toContain(f.reservation.grants['github-workflow']);
    });

    test('an unclean predecessor preserves hashes and pins but restores no capability or endpoint', async () => {
        const f     = await predecessor({clean: false});
        let   calls = 0;
        expect(await recoverWithRuntimeReferences({...f, restoreSeat: async () => { calls++; return f.restoreSeat(); }}))
            .toEqual([{agentId: 'seat', state: 'stale', reason: 'recovery-unverified', detail: 'unclean-issuer-exit'}]);
        expect(service.statusOf('seat', {running: true})).toMatchObject({state: 'stale', reason: 'recovery-unverified', detail: 'unclean-issuer-exit'});
        expect(service.continuityRecord).toMatchObject({previousReason: 'unclean-issuer-exit', handoffProved: false, seats: [{agentId: 'seat', detail: 'unclean-issuer-exit'}]});
        expect(calls).toBe(0);
        expect(service.httpServer).toBeNull();
        expect(service.grants.size).toBe(0);
        expect(service.admissionSnapshot().seats).toEqual(f.state.seats);
        expect(service.admissionSnapshot().generations[0].servers[0].capabilityHash)
            .toBe(f.previous.snapshot.generations[0].servers[0].capabilityHash);
    });

    test('a clean predecessor whose seat is no longer running keeps the generation stale and names the check', async () => {
        const f = await predecessor();
        service.journal.previous.snapshot.seats[0].state = 'exited';
        expect(await recoverWithRuntimeReferences(f)).toEqual([{agentId: 'seat', state: 'stale', reason: 'recovery-unverified', detail: "seat state 'exited'"}]);
        expect(service.statusOf('seat', {running: true})).toMatchObject({state: 'stale', detail: "seat state 'exited'"});
        expect(service.continuityRecord).toMatchObject({previousReason: null, handoffProved: true, origin: f.reservation.issuer});
        expect(service.grants.size).toBe(0);
    });

    test('a handoff witnesses each stage before it awaits it, and a refusal names the stage and the reason', async () => {
        const f = await predecessor({clean: false});
        await recoverWithRuntimeReferences(f);
        service.generations.clear(); service.grants.clear(); service.continuityPhase = 'ready'; service.handoffPromise = null;
        await service.listen();
        const stages = [];
        await expect(service.handoff({verifySeats: async () => { throw new Error('seat seat is not a live original Start') }, onStage: stage => stages.push(stage)}))
            .rejects.toThrow('Fleet continuity refused: survivor-validation.');
        expect(stages).toEqual(['survivor-validation', 'refused at survivor-validation: seat seat is not a live original Start']);
    });

    test('a bind conflict refuses the original origin without moving to another port', async () => {
        const f       = await predecessor();
        const blocker = http.createServer();
        await new Promise(resolve => blocker.listen(Number(f.reservation.issuer.split(':').at(-1)), '127.0.0.1', resolve));
        try {
            await expect(recoverWithRuntimeReferences(f)).rejects.toThrow('no alternate port selected');
            expect(service.grants.size).toBe(0);
            expect(service.httpServer).toBeNull();
            expect(service.continuityPhase).toBe('unavailable');
            await expect(service.reserve({agent: f.state.agent})).rejects.toThrow('continuity is not ready');
        } finally { await new Promise(resolve => blocker.close(resolve)); }
    });

    test('revocation before handoff and Stop during asynchronous custody checks cannot be recovered', async () => {
        const f        = await predecessor();
        const entered  = deferred(), finish = deferred();
        const recovery = recoverWithRuntimeReferences({...f, restoreSeat: async () => { entered.resolve(); await finish.promise; return f.restoreSeat(); }});
        await entered.promise;
        service.revoke('seat', 'stop-requested');
        finish.resolve();
        expect(await recovery).toEqual([{agentId: 'seat', state: 'revoked', reason: 'stop-requested', detail: null}]);
        expect(service.grants.size).toBe(0);
        expect(service.admissionSnapshot().generations[0].state).toBe('revoked');
    });

    test('a predecessor tombstone is preserved without reading a profile', async () => {
        const f    = await predecessor({revoke: true});
        let   read = false;
        expect(await recoverWithRuntimeReferences({...f, restoreSeat: async () => { read = true; return f.restoreSeat(); }}))
            .toEqual([{agentId: 'seat', state: 'revoked', reason: 'stop-requested', detail: null}]);
        expect(read).toBe(false);
    });

    test('a failed recovery write releases its newly bound listener and leaves no admitted grants', async () => {
        const f = await predecessor();
        service.journal.write = () => { throw Error('fixture lost recovery write'); };
        await expect(recoverWithRuntimeReferences(f)).rejects.toThrow('fixture lost recovery write');
        expect(service.journalFailed).toBe(true);
        expect(service.grants.size).toBe(0);
        expect(service.httpServer).toBeNull();
        const probe = http.createServer();
        await new Promise((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(Number(f.reservation.issuer.split(':').at(-1)), '127.0.0.1', resolve);
        });
        await new Promise(resolve => probe.close(resolve));
    });

    test('off then on during recovery cannot resurrect an individual grant', async () => {
        const f           = await predecessor();
        const restoreSeat = async () => {
            const original = f.state.agent;
            f.state.agent = {...original, mcpServers: {...original.mcpServers, 'github-workflow': false}};
            service.onDefinitionChange({id: 'seat', next: f.state.agent});
            f.state.agent = original;
            service.onDefinitionChange({id: 'seat', next: original});
            return f.restoreSeat();
        };
        expect((await recoverWithRuntimeReferences({...f, restoreSeat}))[0].state).toBe('active');
        expect(await redeem(f.reservation.grants['github-workflow'], {server: 'github-workflow'}))
            .toMatchObject({outcome: 'refused', code: 'revoked', reason: 'server-disabled'});
    });

    for (const failure of ['capability', 'owner', 'process', 'definition']) {
        test(`recovery refuses changed ${failure} evidence without minting grants`, async () => {
            const f           = await predecessor();
            const restoreSeat = async () => {
                const result = await f.restoreSeat();
                if (failure === 'capability') result.capabilities = {'github-workflow': 'a'.repeat(22) + '.' + 'b'.repeat(43)};
                if (failure === 'owner') result.owners = {};
                if (failure === 'process') f.state.observed = 'unknown';
                if (failure === 'definition') f.state.agent = {...f.state.agent, launchOwner: 'external'};
                return result;
            };
            const [disposition] = await recoverWithRuntimeReferences({...f, restoreSeat});
            expect(disposition).toMatchObject({agentId: 'seat', state: 'stale', reason: 'recovery-unverified', detail: {
                capability: 'capability changed: github-workflow',
                owner     : 'credential owner missing: GH_TOKEN',
                process   : 'process not live',
                definition: 'definition changed'
            }[failure]});
            expect(service.grants.size).toBe(0);
        });
    }
});

test.describe('McpLaunchAdmissionService — durable phase transitions', () => {
    let directory;
    test.beforeEach(() => {
        directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'admission-phase-')));
        fs.chmodSync(directory, 0o700);
    });
    test.afterEach(() => {
        service.journal?.close();
        service.journal = null;
        service.journalFailed = false;
        fs.removeSync(directory);
    });

    test('clean handoff awaits in-flight proofs and endpoint release; the draining request receives no env', async () => {
        service.openJournal({directory});
        const started = deferred(), finish = deferred(), owners = makeOwners();
        owners.owners.GH_TOKEN.prove = () => { started.resolve(); return finish.promise; };
        const reservation = await activeSeat({owners: owners.owners});
        const grant       = parseLaunchCapability(reservation.grants['github-workflow']);
        const request     = createLaunchRequest({grant, server: 'github-workflow', identity: LOGIN});
        const response    = fetch(reservation.issuer + LAUNCH_ADMISSION_PATH, {method: 'POST',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)}).then(result => result.json());
        await started.promise;
        const handoff = service.handoff({verifySeats: async () => {}});
        expect(service.handoff({verifySeats: () => { throw Error('must not run twice'); }})).toBe(handoff);
        await new Promise(resolve => setImmediate(resolve));
        expect(fs.readJsonSync(path.join(directory, 'issuer.json')).phase).toBe('active');
        finish.resolve({verdict: 'proved'});
        expect(verifyLaunchResponse(grant.secret, request, await response)).toMatchObject({outcome: 'refused', code: 'issuer-unavailable'});
        expect(await handoff).toEqual({state: 'handed-off'});
        expect(service.httpServer).toBeNull();
        expect(fs.readJsonSync(path.join(directory, 'issuer.json')).phase).toBe('handoff');
    });

    test('a paused handoff phase leaves its stage as the last witness until it settles; the sealed order follows', async () => {
        service.openJournal({directory});
        const seats = deferred(), proofStarted = deferred(), proofFinish = deferred(), owners = makeOwners(), stages = [];
        owners.owners.GH_TOKEN.prove = () => { proofStarted.resolve(); return proofFinish.promise; };
        const reservation = await activeSeat({owners: owners.owners});
        const grant       = parseLaunchCapability(reservation.grants['github-workflow']);
        const request     = createLaunchRequest({grant, server: 'github-workflow', identity: LOGIN});
        const response    = fetch(reservation.issuer + LAUNCH_ADMISSION_PATH, {method: 'POST',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify(request)}).then(result => result.json());
        await proofStarted.promise;
        const handoff = service.handoff({verifySeats: () => seats.promise, onStage: stage => stages.push(stage)});
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(stages.at(-1), 'survivor validation is paused: it is the last witness').toBe('survivor-validation');
        seats.resolve();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(stages.at(-1), 'the proof is still in flight: the drain is the last witness').toBe('proof-drain');
        proofFinish.resolve({verdict: 'proved'});
        expect(verifyLaunchResponse(grant.secret, request, await response)).toMatchObject({outcome: 'refused', code: 'issuer-unavailable'});
        expect(await handoff).toEqual({state: 'handed-off'});
        expect(stages).toEqual(['survivor-validation', 'proof-drain', 'endpoint-release', 'durable-handoff']);
        expect(fs.readJsonSync(path.join(directory, 'issuer.json')).phase).toBe('handoff');
    });

    test('an empty issuer hands off without inventing an endpoint or any grant', async () => {
        if (service.httpServer) await new Promise(resolve => service.httpServer.close(resolve));
        service.httpServer = service.listening = service.issuerOrigin = null;
        service.openJournal({directory});
        await service.handoff({verifySeats: async () => {}});
        expect(fs.readJsonSync(path.join(directory, 'issuer.json'))).toMatchObject({phase: 'handoff', origin: null});
        service.journal = null; service.continuityPhase = 'ready'; service.handoffPromise = null;
        service.openJournal({directory});
        expect(await service.recover({registry: {}, restoreSeat: () => { throw Error('no seat exists'); }})).toEqual([]);
        expect(service.httpServer).toBeNull();
        expect(service.grants.size).toBe(0);
    });

    test('a lost terminal handoff write never publishes a clean transition', async () => {
        service.openJournal({directory, writeAtomic(file, content, options) {
            if (path.basename(file) === 'issuer.json' && JSON.parse(content).phase === 'handoff') throw Error('lost terminal write');
            return writeFileAtomicSync(file, content, options);
        }});
        await activeSeat();
        await expect(service.handoff({verifySeats: async () => {}})).rejects.toThrow('durable-handoff');
        expect(fs.readJsonSync(path.join(directory, 'issuer.json')).phase).toBe('active');
        expect(service.httpServer).toBeNull();
        await service.closeUnclean();
    });

    for (const failure of ['pending', 'input-owner', 'deadline']) {
        test(`failed handoff preserves unclean evidence and remains quittable: ${failure}`, async () => {
            const restore = snapshotAiConfig(aiConfig, {'fleet.shutdownBudgetMs': 30});
            try {
                service.openJournal({directory});
                if (failure === 'pending') await service.reserve({agent: seatDefinition()});
                else await activeSeat();
                service.proofTimeoutMs = 30;
                const verifySeats = failure === 'deadline' ? () => new Promise(() => {}) : async () => { throw Error('fixture owner unavailable'); };
                await expect(service.handoff({verifySeats})).rejects.toThrow(
                    failure === 'deadline' ? 'Fleet continuity refused: deadline.' : 'Fleet continuity refused'
                );
                expect(service.continuityPhase).toBe('unavailable');
                expect(service.httpServer).toBeNull();
                expect(fs.readJsonSync(path.join(directory, 'issuer.json')).phase).toBe('active');
                await expect(service.closeUnclean()).resolves.toBeUndefined();
            } finally {
                restore();
            }
        });
    }

    test('performHandoff race deadline follows AiConfig.fleet.shutdownBudgetMs while credential proofs retain proofTimeoutMs (#1081)', async () => {
        expect(aiConfig.fleet.shutdownBudgetMs).toBe(10000);
        const restore = snapshotAiConfig(aiConfig, {'fleet.shutdownBudgetMs': 40});
        try {
            service.openJournal({directory});
            await activeSeat();
            service.proofTimeoutMs = 5000;
            const stages    = [];
            const startedAt = Date.now();
            await expect(
                service.handoff({
                    verifySeats: () => new Promise(() => {}),
                    onStage    : stage => stages.push(stage)
                })
            ).rejects.toThrow('Fleet continuity refused: deadline.');
            const elapsedMs = Date.now() - startedAt;
            expect(elapsedMs).toBeGreaterThanOrEqual(30);
            expect(elapsedMs).toBeLessThan(500);
            expect(stages).toEqual(['survivor-validation', 'refused at deadline']);
            expect(service.proofTimeoutMs).toBe(5000);
        } finally {
            restore();
        }
    });

    test('reservation, activation and revocation are durable before they return, with hashes instead of secrets', async () => {
        service.openJournal({directory});
        const reservation = await service.reserve({agent: seatDefinition()});
        const file        = path.join(directory, 'issuer.json');
        expect(fs.readJsonSync(file).snapshot.generations[0].state).toBe('reserved');
        service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
        expect(fs.readJsonSync(file).snapshot.generations[0].state).toBe('active');
        service.revoke('seat', 'stop-requested');
        expect(fs.readJsonSync(file).snapshot.generations[0]).toMatchObject({state: 'revoked', reason: 'stop-requested'});
        const raw = fs.readFileSync(file, 'utf8');
        for (const secret of [PAT, BEARER, START_ENV.NEO_FLEET_BRIDGE_TOKEN, ...Object.values(reservation.grants)]) {
            expect(raw).not.toContain(secret);
        }
        expect(raw).not.toContain('"env"');
        expect(raw).not.toContain('"owners"');
        const snapshot = service.admissionSnapshot();
        expect(() => service.journal.write({...snapshot, env: {GH_TOKEN: PAT}})).toThrow(/snapshot-invalid/);
        expect(() => service.journal.write({...snapshot, generations: [...snapshot.generations, snapshot.generations[0]]}))
            .toThrow(/snapshot-invalid/);
    });

    test('a reservation names only the servers a seat starts through the issuer, and only catalog ones', async () => {
        const all = await service.reserve({agent: seatDefinition()});
        expect(Object.keys(all.grants).length).toBeGreaterThan(1);

        const one = await service.reserve({agent: seatDefinition(), servers: ['neural-link']});
        expect(Object.keys(one.grants)).toEqual(['neural-link']);
        expect(service.statusOf('seat').servers.map(server => server.key)).toEqual(['neural-link']);

        await expect(service.reserve({agent: seatDefinition(), servers: ['not-a-server']})).rejects.toThrow('servers must name catalog servers');
    });

    test('resident redemption follows original config selection, current values and original absence without a held fallback', async () => {
        service.openJournal({directory});
        const binding = {version: 1, kind: 'resident-config', server: 'memory-core',
            plane    : {id: 'original-plane', dataRoot: directory},
            providers: {model: 'openAiCompatible', embedding: 'openAiCompatible', ask: null}};
        const current = {binding: structuredClone(binding), env: {NEO_OPENAI_COMPATIBLE_API_KEY: 'current-fixture-key'}};
        const input   = createResidentMcpInputOwner({binding, names: Object.keys(current.env), read: () => current});
        const plan    = boundPlan().map(row => row.key === 'memory-core' ? {...row, target: 'resident', transport: 'stdio',
            args              : [path.join(row.sourceRoot, row.entrypoint)],
            requiredRuntimeEnv: [...row.requiredRuntimeEnv, 'NEO_OPENAI_COMPATIBLE_API_KEY']} : row);
        const reservation = await activeSeat({plan, env: {...START_ENV, NEO_OPENAI_COMPATIBLE_API_KEY: 'old-fixture-key'},
            residentInputs: {'memory-core': input}});
        current.env.NEO_OPENAI_COMPATIBLE_API_KEY = 'rotated-fixture-key';
        current.env.GEMINI_API_KEY = 'newly-present-fixture-key';
        const answer = await redeem(reservation.grants['memory-core'], {server: 'memory-core'});
        expect(answer).toMatchObject({outcome: 'admitted', env: {NEO_OPENAI_COMPATIBLE_API_KEY: 'rotated-fixture-key'}});
        expect(answer.env).not.toHaveProperty('GEMINI_API_KEY');
        expect(service.generations.get('seat').servers.get('memory-core').env).not.toHaveProperty('NEO_OPENAI_COMPATIBLE_API_KEY');
        const file = path.join(directory, 'issuer.json'), snapshot = fs.readJsonSync(file).snapshot;
        expect(snapshot.generations[0].residentBindings['memory-core']).toEqual({binding, names: ['NEO_OPENAI_COMPATIBLE_API_KEY']});
        expect(fs.readFileSync(file, 'utf8')).not.toContain('fixture-key');
        delete current.env.NEO_OPENAI_COMPATIBLE_API_KEY;
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toMatchObject({code: 'credential-missing'});
        current.env.NEO_OPENAI_COMPATIBLE_API_KEY = 'restored-fixture-key';
        const pending = redeem(reservation.grants['memory-core'], {server: 'memory-core'});
        current.binding.providers.model = 'gemini';
        expect(await pending).toMatchObject({code: 'credential-unproven'});
        service.revoke('seat', 'stop-requested');
        expect(service.generations.get('seat').residentInputs).toEqual({});
        expect(fs.readJsonSync(file).snapshot.generations[0].residentBindings).toEqual(snapshot.generations[0].residentBindings);
        snapshot.generations[0].residentBindings['memory-core'].binding.env = {GEMINI_API_KEY: 'secret'};
        expect(() => service.journal.write(snapshot)).toThrow(/snapshot-invalid/);
    });

    test('concurrent Bridge redemptions prove their own captured port and never share a proof across ports', async () => {
        const binding = {version: 1, kind: 'resident-config', server: 'neural-link',
            plane: {id: 'original-plane', dataRoot: directory}, providers: {model: null, embedding: null, ask: null}};
        const current  = {binding, env: {NEO_NL_PORT: '12345'}};
        const input    = createResidentMcpInputOwner({binding, names: ['NEO_NL_PORT'], read: () => current});
        const enteredA = deferred(), enteredB = deferred(), finishA = deferred(), finishB = deferred(), ports = [];
        const bridge   = {credential: 'bridge-token', resolve: () => 'same-fresh-token', prove: (value, {port}) => {
            ports.push(port);
            if (port === 12345) { enteredA.resolve(); return finishA.promise; }
            enteredB.resolve(); return finishB.promise;
        }};
        const reservation = await activeSeat({env: {...START_ENV, NEO_NL_PORT: '12345'},
            owners: {NEO_FLEET_BRIDGE_TOKEN: bridge}, residentInputs: {'neural-link': input}});
        const a = redeem(reservation.grants['neural-link'], {server: 'neural-link'});
        await enteredA.promise;
        current.env.NEO_NL_PORT = '23456';
        const b = redeem(reservation.grants['neural-link'], {server: 'neural-link'});
        await enteredB.promise;
        finishA.resolve({verdict: 'proved'});
        finishB.resolve({verdict: 'refused'});
        expect(await a).toMatchObject({outcome: 'admitted', env: {NEO_NL_PORT: '12345', NEO_FLEET_BRIDGE_TOKEN: 'same-fresh-token'}});
        expect(await b).toMatchObject({outcome: 'refused', code: 'credential-unproven', reason: 'bridge-token'});
        expect(ports).toEqual([12345, 23456]);
        expect(service.generations.get('seat').servers.get('neural-link').env).not.toHaveProperty('NEO_FLEET_BRIDGE_TOKEN');
    });

    test('original credential ownership survives revocation without persisting credential values', async () => {
        service.openJournal({directory});
        const agent = seatDefinition(), registry = {getDataDir: () => directory,
            getDefinition: () => agent, resolveCredential: () => PAT};
        const owner       = createSeatPatOwner({registry, agent, proveForgeAccount: async () => ({verdict: 'proved'})});
        const reservation = await activeSeat({owners: {...makeOwners().owners, GH_TOKEN: owner}});
        const file        = path.join(directory, 'issuer.json');
        expect(fs.readJsonSync(file).snapshot.generations[0].credentialBindings).toEqual({GH_TOKEN: owner.binding});
        service.revoke('seat', 'stop-requested');
        const snapshot = fs.readJsonSync(file).snapshot;
        expect(snapshot.generations[0]).toMatchObject({state: 'revoked', credentialBindings: {GH_TOKEN: owner.binding}});
        expect(service.generations.get('seat').owners).toEqual({});
        for (const secret of [PAT, BEARER, ...Object.values(reservation.grants)]) {
            expect(fs.readFileSync(file, 'utf8')).not.toContain(secret);
        }
        for (const change of [{credential: PAT}, {agentId: 'another-seat'}, {identity: 'another-login'}]) {
            const invalid = structuredClone(snapshot);
            Object.assign(invalid.generations[0].credentialBindings.GH_TOKEN, change);
            expect(() => service.journal.write(invalid)).toThrow(/snapshot-invalid/);
        }
    });

    test('old and new Starts keep distinct durable runtimes and signed admission roots', async () => {
        service.openJournal({directory});
        for (const letter of ['a', 'b']) {
            const id      = letter.repeat(64), runtimeDirectory = path.join(directory, id);
            const runtime = {id, directory: runtimeDirectory, payloadDigest: 'c'.repeat(64),
                runtimeRoot: path.join(runtimeDirectory, 'host.runtime/organism'),
                executable : path.join(runtimeDirectory, 'host.runtime/node')};
            const before = service.generations.size;
            await expect(service.reserve({agent: seatDefinition({id: letter}), runtimeGeneration: runtime})).rejects.toThrow(/not guarded/);
            expect(service.generations.size).toBe(before);
            const reservation = await reserveWithRuntimeReferences({agent: seatDefinition({id: letter}), runtimeGeneration: runtime});
            const plan        = boundPlan({root: runtime.runtimeRoot}).map(row => ({...row, command: runtime.executable}));
            expect(() => service.activate({generation: reservation.generation, agentId: letter,
                plan: plan.map(row => ({...row, command: process.execPath})), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'}))
                .toThrow(/do not bind the reserved runtime/);
            service.activate({generation: reservation.generation, agentId: letter, plan,
                env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
            const answer = await redeem(reservation.grants['memory-core'], {server: 'memory-core'});
            expect(answer).toMatchObject({outcome: 'admitted', generationRoot: runtime.runtimeRoot});
            expect(service.statusOf(letter).recent.at(-1).generationRoot).toBe(runtime.runtimeRoot);
        }
        const snapshot = fs.readJsonSync(path.join(directory, 'issuer.json')).snapshot;
        expect(snapshot.version).toBe(7);
        expect(snapshot.generations.map(row => row.runtime.id)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
        expect(snapshot.generations.every(row => row.state === 'active')).toBe(true);
        const extraSecret = structuredClone(snapshot);
        extraSecret.generations[0].runtime.env = {GH_TOKEN: PAT};
        expect(() => service.journal.write(extraSecret)).toThrow(/snapshot-invalid/);
    });

    test('a lost revocation write freezes admission and makes clean handoff impossible', async () => {
        let fail = false;
        service.openJournal({directory, writeAtomic: (file, source, options) => {
            if (fail) throw Error('fixture lost write');
            return writeFileAtomicSync(file, source, options);
        }});
        const reservation = await activeSeat();
        fail = true;
        expect(() => service.revoke('seat', 'stop-requested')).toThrow(/durability-failed/);
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'}))
            .toMatchObject({outcome: 'refused', code: 'issuer-unavailable', reason: 'durability-failed'});
        expect(() => service.journal.handoff(service.admissionSnapshot(), reservation.issuer)).toThrow(/durability-failed/);
        expect(fs.readJsonSync(path.join(directory, 'issuer.json')).snapshot.generations[0].state).toBe('active');
    });

    test('a per-server revocation names its generation, persists, and a lost write still refuses the handoff that needed it', async () => {
        let fail = false;
        service.openJournal({directory, writeAtomic: (file, source, options) => {
            if (fail) throw Error('fixture lost write');
            return writeFileAtomicSync(file, source, options);
        }});
        const reservation = await activeSeat();

        expect(service.revokeServerGrant('seat', 'memory-core', 'recovery-unverified', {generation: 'another-generation'}), 'a newer Start is never hit').toBe(false);
        expect(service.revokeServerGrant('seat', 'memory-core', 'recovery-unverified', {generation: reservation.generation})).toBe(true);
        const saved = fs.readJsonSync(path.join(directory, 'issuer.json')).snapshot.generations[0];
        expect([saved.state, saved.servers.find(row => row.key === 'memory-core').state]).toEqual(['active', 'revoked']);
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toMatchObject({outcome: 'refused'});
        expect(await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'}), 'the other server stays admitted').toMatchObject({outcome: 'admitted'});

        fail = true;
        await expect(service.handoff({verifySeats: () => service.revokeServerGrant('seat', 'github-workflow', 'recovery-unverified', {generation: reservation.generation})}))
            .rejects.toThrow(/Fleet continuity refused/);
    });

    test('a failed activation cannot publish a successful Start or admit a waiting child', async () => {
        let fail = false;
        service.openJournal({directory, writeAtomic: (file, source, options) => {
            if (fail) throw Error('fixture activation failure');
            return writeFileAtomicSync(file, source, options);
        }});
        const reservation = await service.reserve({agent: seatDefinition()});
        const pending     = redeem(reservation.grants['memory-core'], {server: 'memory-core'});
        await expect.poll(() => service.generations.get('seat').waiters.size).toBe(1);
        fail = true;
        expect(() => service.activate({generation: reservation.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'}))
            .toThrow(/durability-failed/);
        expect(await pending).toMatchObject({outcome: 'refused'});
        expect(service.statusOf('seat')).toMatchObject({state: 'stale', reason: 'durability-failed'});
        expect(fs.readJsonSync(path.join(directory, 'issuer.json')).snapshot.generations[0].state).toBe('reserved');
    });

    test('a durability loss during credential proof cannot be overtaken by the proof completing', async () => {
        let fail = false;
        service.openJournal({directory, writeAtomic: (file, source, options) => {
            if (fail) throw Error('fixture proof race');
            return writeFileAtomicSync(file, source, options);
        }});
        const entered     = deferred(), finish = deferred();
        const owners      = makeOwners({proves: () => { entered.resolve(); return finish.promise; }});
        const reservation = await activeSeat({owners: owners.owners});
        const pending     = redeem(reservation.grants['memory-core'], {server: 'memory-core'});
        await entered.promise;
        fail = true;
        expect(() => service.revoke('seat', 'stop-requested')).toThrow(/durability-failed/);
        finish.resolve(true);
        expect(await pending).toMatchObject({outcome: 'refused', code: 'issuer-unavailable'});
    });

    test('loss of journal ownership refuses before the final signed admission', async () => {
        service.openJournal({directory});
        const reservation = await activeSeat();
        const file        = path.join(directory, 'issuer.lock'), lock = fs.readJsonSync(file);
        fs.writeJsonSync(file, {...lock, ownerToken: crypto.randomUUID()});
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'}))
            .toMatchObject({outcome: 'refused', code: 'issuer-unavailable'});
        expect(service.statusOf('seat')).toMatchObject({state: 'stale', reason: 'durability-failed'});
    });
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
            outcome       : 'admitted',
            generationRoot: '/installed/neo',
            env           : {NEO_MCP_REMOTE_TOKEN: BEARER},
            args          : ['/installed/neo/ai/mcp/client/stdioToStreamableHttp.mjs', '--url', 'https://plane.example.test/mc/mcp', '--token-env', 'NEO_MCP_REMOTE_TOKEN']
        });
        expect(await redeem(reservation.grants['github-workflow'], {server: 'github-workflow'})).toEqual({
            outcome       : 'admitted',
            generationRoot: '/installed/neo',
            env           : {GH_TOKEN: PAT},
            args          : ['/installed/neo/ai/mcp/server/github-workflow/mcp-server.mjs']
        });
        expect(await redeem(reservation.grants['neural-link'], {server: 'neural-link'})).toEqual({
            outcome       : 'admitted',
            generationRoot: '/installed/neo',
            env           : {NEO_FLEET_BRIDGE_TOKEN: 'bridge-fixture-token'},
            args          : ['/installed/neo/ai/mcp/server/neural-link/mcp-server.mjs', '--cwd', '/installed/neo']
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
        expect(Object.keys(recent[0]).sort()).toEqual(['at', 'code', 'generationRoot', 'outcome', 'reason', 'server']);
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
        expect(service.statusOf('adopted', {running: true})).toEqual({state: 'stale', reason: 'issuer-replaced', detail: null, generation: null, since: null, servers: [], recent: []});
        expect(service.statusOf('adopted')).toMatchObject({state: 'none', reason: null, detail: null});
        expect(service.holds('adopted')).toBe(false);
        // after a boot that found an unclean predecessor, the stale row says so
        service.continuityRecord = {recoveredAt: 't', previousReason: 'unclean-issuer-exit', handoffProved: false, origin: null, seats: []};
        try {
            expect(service.statusOf('adopted', {running: true})).toMatchObject({state: 'stale', reason: 'issuer-replaced', detail: 'unclean-issuer-exit'});
            expect(service.statusOf('adopted').detail).toBeNull()
        } finally { service.continuityRecord = null }
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

    test('a non-Stop seat-wide revocation before reservation invalidates the caller mark; a later Start begins fresh', async () => {
        const mark = service.revocationMark('seat');

        expect(service.revoke('seat', 'plan-changed'), 'nothing to revoke yet').toBe(false);
        expect(service.revocationMark('seat')).toBe(mark + 1);

        const invalidated = await service.reserve({agent: seatDefinition(), since: mark});

        expect(service.statusOf('seat')).toMatchObject({state: 'revoked', reason: 'plan-changed', generation: invalidated.generation});
        service.activate({generation: invalidated.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
        expect(await redeem(invalidated.grants['github-workflow'], {server: 'github-workflow'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'plan-changed'});

        // A Start that reads after the non-Stop revocation reserves fresh authority.
        const fresh = await service.reserve({agent: seatDefinition(), since: service.revocationMark('seat')});

        service.revoke('seat', 'start-failed', {generation: invalidated.generation});
        expect(service.revocationMark('seat'), 'replacing a generation or revoking one does not add another seat-wide mark').toBe(mark + 1);

        service.activate({generation: fresh.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
        expect((await redeem(fresh.grants['github-workflow'], {server: 'github-workflow'})).outcome).toBe('admitted')
    });

    test('an already-aborted Start signal yields revoked admission without advancing the non-Stop mark; a later Start is fresh', async () => {
        const
            mark       = service.revocationMark('seat'),
            controller = new AbortController();

        controller.abort();

        const cancelled = await service.reserve({agent: seatDefinition(), since: mark, startSignal: controller.signal});

        expect(service.statusOf('seat')).toMatchObject({state: 'revoked', reason: 'stop-requested', generation: cancelled.generation});
        expect(service.revocationMark('seat')).toBe(mark);
        expect(await redeem(cancelled.grants['github-workflow'], {server: 'github-workflow'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'stop-requested'});
        expect(service.generations.get('seat').startSignal).toBeUndefined();

        const freshController = new AbortController(),
              fresh           = await service.reserve({agent: seatDefinition(), since: mark, startSignal: freshController.signal});

        service.activate({generation: fresh.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
        expect(service.generations.get('seat').startSignal, 'activation releases the signal listener').toBeUndefined();
        freshController.abort();
        expect(service.statusOf('seat')).toMatchObject({state: 'active', generation: fresh.generation});
        expect((await redeem(fresh.grants['github-workflow'], {server: 'github-workflow'})).outcome).toBe('admitted');
        expect(service.revocationMark('seat')).toBe(mark)
    });

    test('a switch-off or a Stop while the reservation awaits its listener lands on it; a listener that fails revokes it', async () => {
        const
            gate       = deferred(),
            controller = new AbortController(),
            mark       = service.revocationMark('seat');

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

            const stopped = service.reserve({agent: seatDefinition(), startSignal: controller.signal});

            controller.abort();
            expect(service.statusOf('seat')).toMatchObject({state: 'revoked', reason: 'stop-requested'});
            expect(service.revocationMark('seat'), 'Stop cancellation is carried by the attempt signal').toBe(mark);

            const second = await stopped;

            service.activate({generation: second.generation, agentId: 'seat', plan: boundPlan(), env: START_ENV, owners: makeOwners().owners, probe: () => 'live'});
            expect(await redeem(second.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'revoked', reason: 'stop-requested'});
            expect(service.generations.get('seat').startSignal).toBeUndefined();

            service.listen = () => Promise.reject(new Error('listen EADDRINUSE'));
            const failingController = new AbortController();
            await expect(service.reserve({agent: seatDefinition(), startSignal: failingController.signal})).rejects.toThrow('EADDRINUSE');
            expect(service.statusOf('seat')).toMatchObject({state: 'revoked', reason: 'start-failed'});
            expect(service.generations.get('seat').startSignal).toBeUndefined()
        } finally {
            delete service.listen
        }
    });
});

test.describe('McpLaunchAdmissionService — seat credentials, redeemed from their owners', () => {
    test('#964 classifies real transport failures through the plane owner, without retiring admission', async () => {
        const originalFetch = globalThis.fetch, originalProbe = FleetTenantService.probeFn;
        const owners        = makeOwners();
        owners.owners.NEO_MCP_REMOTE_TOKEN.prove = (credential, {signal}) => FleetTenantService.probeSeatPlaneCredential({
            planeBase    : 'https://plane.example.test', credential, expectedIdentity: LOGIN,
            expectedPlane: {id: 'fixture', dataRoot: '/fixture'}, signal
        });
        FleetTenantService.probeFn = null;
        try {
            const reservation = await activeSeat({owners: owners.owners});
            for (const [status, code] of [[503, 'proof-unavailable'], [429, 'proof-unavailable'], [401, 'credential-unproven'], [403, 'credential-unproven'], [404, 'credential-unproven'], [null, 'proof-unavailable']]) {
                globalThis.fetch = async () => {
                    if (status === null) throw new DOMException('fixture aborted', 'AbortError');
                    return {ok: false, status, headers: new Headers(), text: async () => ''}
                };
                expect((await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).code, String(status)).toBe(code);
                expect(service.statusOf('seat').state).toBe('active')
            }

            for (const error of [new TypeError('fetch failed'), new DOMException('fixture aborted', 'AbortError')]) {
                globalThis.fetch = async () => { throw error };
                const answer = await redeem(reservation.grants['memory-core'], {server: 'memory-core'});
                expect(answer).toEqual({outcome: 'refused', code: 'proof-unavailable', reason: 'plane endpoint unreachable'});
                expect(service.statusOf('seat').recent.at(-1)).toMatchObject({code: 'proof-unavailable', reason: 'plane endpoint unreachable'})
            }

            const signals = [];
            globalThis.fetch = (url, {signal}) => new Promise((resolve, reject) => {
                signals.push(signal);
                signal.addEventListener('abort', () => reject(signal.reason), {once: true})
            });
            service.proofTimeoutMs = 20;
            expect((await redeem(reservation.grants['knowledge-base'], {server: 'knowledge-base'})).code).toBe('proof-unavailable');
            expect(signals).toHaveLength(2);
            expect(signals.every(signal => signal.aborted)).toBe(true)
        } finally {
            globalThis.fetch = originalFetch;
            FleetTenantService.probeFn = originalProbe
        }
    });

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
        expect(await redeemOn('knowledge-base')).toEqual({outcome: 'refused', code: 'proof-unavailable', reason: 'proof-unavailable'});

        expect(service.statusOf('seat').state).toBe('active');
        expect(service.statusOf('seat').recent.map(entry => [entry.server, entry.code, entry.reason])).toEqual([
            ['github-workflow', 'credential-missing', 'seat-pat'],
            ['github-workflow', 'credential-unproven', 'seat-pat'],
            ['memory-core', null, null],
            ['github-workflow', 'credential-missing', 'seat-pat'],
            ['knowledge-base', 'proof-unavailable', 'proof-unavailable']
        ])
    });

    test('the checks after the proof decide: a Stop, a switch-off, a handoff revocation or the process ending while it runs refuses', async () => {
        for (const [interrupt, reason] of [
            [() => service.revoke('seat', 'stop-requested'), 'stop-requested'],
            [registry => registry.fire('definitionChange', {id: 'seat', previous: null, next: seatDefinition({mcpServers: {'github-workflow': false}})}), 'server-disabled'],
            [(registry, seat, reservation) => service.revokeServerGrant('seat', 'github-workflow', 'recovery-unverified', {generation: reservation.generation}), 'recovery-unverified'],
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
            interrupt(registry, seat, reservation);
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
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toEqual({outcome: 'refused', code: 'proof-unavailable', reason: 'proof-timeout'})
    });

    test('#964 preserves machine verdicts independently of wording and keeps audit reasons bounded', async () => {
        const owners = makeOwners(), reservation = await activeSeat({owners: owners.owners});
        for (const [verdict, code] of [['unanswered', 'proof-unavailable'], ['refused', 'credential-unproven']]) {
            for (const reason of ['plane endpoint unreachable', 'changed display wording', PAT]) {
                owners.owners.NEO_MCP_REMOTE_TOKEN.prove = async () => ({verdict, reason});
                const answer = await redeem(reservation.grants['memory-core'], {server: 'memory-core'});
                expect(answer.code).toBe(code);
                expect(answer.reason).toBe(verdict === 'unanswered' && reason === 'plane endpoint unreachable' ? reason : 'plane-bearer');
                expect(JSON.stringify(service.statusOf('seat'))).not.toContain(PAT)
            }
        }
        owners.owners.NEO_MCP_REMOTE_TOKEN.prove = async () => ({ok: true, verdict: 'unknown'});
        expect((await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).code).toBe('credential-unproven');
        owners.owners.NEO_MCP_REMOTE_TOKEN.credential = PAT;
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).not.toHaveProperty('reason');
        expect(service.statusOf('seat').state).toBe('active')
    });

    test('#964 aborts the owner request at the shared proof deadline and preserves a concurrent Stop', async () => {
        const owners = makeOwners();
        let signal;
        owners.owners.NEO_MCP_REMOTE_TOKEN.prove = (value, options) => new Promise((resolve, reject) => {
            signal = options.signal;
            signal.addEventListener('abort', () => reject(signal.reason), {once: true})
        });
        service.proofTimeoutMs = 20;
        const reservation = await activeSeat({owners: owners.owners});
        expect(await redeem(reservation.grants['memory-core'], {server: 'memory-core'})).toMatchObject({code: 'proof-unavailable'});
        expect(signal.aborted).toBe(true);
        expect(service.statusOf('seat').state).toBe('active');
        const pending = redeem(reservation.grants['knowledge-base'], {server: 'knowledge-base'});
        service.revoke('seat', 'stop-requested');
        expect(await pending).toMatchObject({code: 'revoked', reason: 'stop-requested'})
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
            app      = createMcpExpressApp({allowedHosts: ['127.0.0.1']}),
            sessions = new Map(),
            opened   = [],
            closers  = new Set();

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
            url  : `http://127.0.0.1:${listener.address().port}`,
            opened,
            close: async () => {
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
        test.setTimeout(75000);
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
            await expect(row.client.connect(row.transport, {timeout: 65000})).rejects.toThrow();
            await expect.poll(() => row.stderr.join('')).toContain('Neo MCP launch refused (issuer-unavailable)')
        } finally {
            await row.client.close()
        }
    });
});
