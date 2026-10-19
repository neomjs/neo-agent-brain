import {expect, test}           from '@playwright/test';
import {EventEmitter, once}     from 'node:events';
import fs                       from 'node:fs';
import net                      from 'node:net';
import os                       from 'node:os';
import path                     from 'node:path';
import {WebSocketServer}        from 'ws';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import InstanceManager          from 'neo.mjs/src/manager/Instance.mjs';
import FleetRegistryService     from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import {createBridgeTokenOwner} from '../../../../../../ai/services/fleet/launchCredentialOwners.mjs';
import {
    FLEET_BRIDGE_STATES,
    describeFleetBridgeState,
    getFleetBridgeStdioLogPath,
    settleFleetBridge
} from '../../../../../../ai/services/fleet/settleFleetBridge.mjs';
import {buildConfiguredTaskDefinitions} from '../../../../../../ai/daemons/orchestrator/services/ConfiguredTaskDefinitionsService.mjs';
import {buildSupervisedTaskEnv}         from '../../../../../../ai/daemons/orchestrator/services/ProcessSupervisorService.mjs';
import {createBridgeVerifierPayload}    from '../../../../../../ai/mcp/server/neural-link/BridgeProtocol.mjs';

void Neo;
void core;
void InstanceManager;

/**
 * @summary Allocates an ephemeral loopback TCP port and releases it for a test server or Bridge child.
 * @returns {Promise<Number>}
 */
async function findFreePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const {port} = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

test.describe('Neural Link Bridge registry key provisioning & Fleet boot states (#1144)', () => {
    let tempRoot;
    let savedConfigDir;
    let savedDataDir;
    let savedSigningPair;
    let savedLoaded;
    let savedAgents;
    let savedEnvPublicKey;
    let servers;
    let spawnedPids;

    test.beforeEach(() => {
        tempRoot          = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-bridge-1144-')));
        savedConfigDir    = FleetRegistryService.configDir;
        savedDataDir      = FleetRegistryService.dataDir;
        savedSigningPair  = FleetRegistryService.signingKeyPair;
        savedLoaded       = FleetRegistryService.loaded;
        savedAgents       = new Map(FleetRegistryService.agents);
        savedEnvPublicKey = process.env.NEO_FLEET_BRIDGE_PUBLIC_KEY;

        delete process.env.NEO_FLEET_BRIDGE_PUBLIC_KEY;
        FleetRegistryService.configDir      = path.join(tempRoot, 'config');
        FleetRegistryService.dataDir        = path.join(tempRoot, 'data');
        FleetRegistryService.signingKeyPair = null;
        FleetRegistryService.loaded         = false;
        FleetRegistryService.agents         = new Map();
        servers                             = [];
        spawnedPids                         = [];
    });

    test.afterEach(async () => {
        for (const pid of spawnedPids) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // Process already exited.
            }
        }
        for (const server of servers) {
            server.clients?.forEach(socket => socket.terminate());
            await new Promise(resolve => server.close(resolve));
        }

        FleetRegistryService.configDir      = savedConfigDir;
        FleetRegistryService.dataDir        = savedDataDir;
        FleetRegistryService.signingKeyPair = savedSigningPair;
        FleetRegistryService.loaded         = savedLoaded;
        FleetRegistryService.agents         = savedAgents;

        if (savedEnvPublicKey === undefined) {
            delete process.env.NEO_FLEET_BRIDGE_PUBLIC_KEY;
        } else {
            process.env.NEO_FLEET_BRIDGE_PUBLIC_KEY = savedEnvPublicKey;
        }

        fs.rmSync(tempRoot, {recursive: true, force: true});
    });

    test('RA-1: orchestrator task definitions never mint signing.key under fleet.dataDir or override a launcher-supplied NEO_FLEET_BRIDGE_PUBLIC_KEY', () => {
        const freshFleetDataDir = path.join(tempRoot, 'uncreated-checkout-fleet');
        FleetRegistryService.dataDir        = freshFleetDataDir;
        FleetRegistryService.signingKeyPair = null;

        const launcherPublicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEALauncherSuppliedBridgeKeyForHostEdge00000=\n-----END PUBLIC KEY-----';
        const configuredTasks   = buildConfiguredTaskDefinitions({
            scriptDir                        : path.resolve(process.cwd(), 'ai/scripts'),
            nodeBin                          : process.execPath,
            neuralLinkBridgeLivenessTimeoutMs: 250
        });
        const supervisedEnv = buildSupervisedTaskEnv({
            baseEnv: {
                ...process.env,
                NEO_FLEET_BRIDGE_PUBLIC_KEY: launcherPublicKey
            },
            taskEnv: configuredTasks.neuralLinkBridge.env
        });

        expect(fs.existsSync(path.join(freshFleetDataDir, 'signing.key'))).toBe(false);
        expect(configuredTasks.neuralLinkBridge.env?.NEO_FLEET_BRIDGE_PUBLIC_KEY).toBeUndefined();
        expect(supervisedEnv.NEO_FLEET_BRIDGE_PUBLIC_KEY).toBe(launcherPublicKey);
    });

    test('AC-1 & RA-3: Bridge started on the Fleet boot path receives the registry public key, routes stdio to the Fleet log file, and seat bridge-token proof returns proved', async () => {
        expect(process.env.NEO_FLEET_BRIDGE_PUBLIC_KEY).toBeUndefined();

        const port            = await findFreePort();
        const expectedLogPath = getFleetBridgeStdioLogPath({dataDir: FleetRegistryService.dataDir});
        const booted          = await settleFleetBridge({
            port,
            registry        : FleetRegistryService,
            probeTimeoutMs  : 1000,
            startupTimeoutMs: 5000
        });
        if (booted.pid) {
            spawnedPids.push(booted.pid);
        }

        const authority = FleetRegistryService.getBridgeSigningAuthority();
        expect(booted).toMatchObject({
            state          : FLEET_BRIDGE_STATES.READY,
            verdict        : 'proved',
            action         : 'started',
            port,
            publicKeySha256: authority.publicKeySha256,
            logFilePath    : expectedLogPath,
            reason         : null,
            summary        : null,
            nextStep       : null
        });
        expect(fs.existsSync(expectedLogPath)).toBe(true);

        const agent = FleetRegistryService.defineAgent({
            id            : 'neo-gemini-julia',
            githubUsername: 'neo-gemini-pro',
            harnessType   : 'antigravity',
            credential    : 'ghp_test1234567890'
        });
        const owner = createBridgeTokenOwner({
            registry: FleetRegistryService,
            agent,
            authority
        });
        const token = owner.resolve();
        expect(typeof token).toBe('string');

        const proof = await owner.prove(token, {port, timeoutMs: 1500});
        expect(proof).toEqual({verdict: 'proved'});

        // Second Fleet boot adopts the running keyed Bridge without spawning a duplicate child.
        let   secondSpawns = 0;
        const adopted      = await settleFleetBridge({
            port,
            registry      : FleetRegistryService,
            probeTimeoutMs: 1000,
            spawnFn       : () => {
                secondSpawns += 1;
                throw new Error('must not spawn when keyed Bridge is already listening');
            }
        });
        expect(secondSpawns).toBe(0);
        expect(adopted).toMatchObject({
            state          : FLEET_BRIDGE_STATES.READY,
            verdict        : 'proved',
            action         : 'adopted',
            port,
            publicKeySha256: authority.publicKeySha256,
            logFilePath    : null,
            reason         : null,
            summary        : null,
            nextStep       : null
        });
    });

    test('AC-2 & RA-2 & RA-3: outdated, unkeyed/protocol-mismatched, and spawn-failing Bridges report exact causes and literal next steps', async () => {
        FleetRegistryService.getBridgePublicKey();
        const expectedSha256 = FleetRegistryService.getBridgeSigningAuthority().publicKeySha256;

        // 1. Old Bridge predating the read-only verifier role (closes /?role=verifier with 1008).
        const oldBridge = new WebSocketServer({host: '127.0.0.1', port: 0});
        servers.push(oldBridge);
        oldBridge.on('connection', socket => socket.close(1008, 'ID required'));
        await once(oldBridge, 'listening');
        const oldPort = oldBridge.address().port;

        let   spawnCalls = 0;
        const outdated   = await settleFleetBridge({
            port          : oldPort,
            registry      : FleetRegistryService,
            probeTimeoutMs: 1000,
            spawnFn       : () => {
                spawnCalls += 1;
                return {};
            }
        });
        expect(spawnCalls).toBe(0);
        expect(outdated).toEqual({
            state          : FLEET_BRIDGE_STATES.OUTDATED,
            verdict        : 'refused',
            action         : null,
            port           : oldPort,
            publicKeySha256: expectedSha256,
            pid            : null,
            logFilePath    : null,
            reason         : 'bridge-verifier-unsupported',
            summary        : `An older Neural Link Bridge on port ${oldPort} predates verifier support.`,
            nextStep       : `If the Neural Link Bridge on port ${oldPort} is supervised (for example by host-edge / launchd), update and restart that supervised service; otherwise stop the process on port ${oldPort} and restart the Fleet server so Fleet starts a keyed Bridge from this runtime generation, then reconnect the seat.`
        });

        // 2. Unkeyed / foreign-keyed / protocol-stale Bridge on the NL port (bridge-verifier-mismatch).
        const unkeyedBridge = new WebSocketServer({host: '127.0.0.1', port: 0});
        servers.push(unkeyedBridge);
        unkeyedBridge.on('connection', socket => {
            socket.send(JSON.stringify(createBridgeVerifierPayload(null)));
        });
        await once(unkeyedBridge, 'listening');
        const unkeyedPort = unkeyedBridge.address().port;

        const unkeyed = await settleFleetBridge({
            port          : unkeyedPort,
            registry      : FleetRegistryService,
            probeTimeoutMs: 1000,
            spawnFn       : () => {
                spawnCalls += 1;
                return {};
            }
        });
        expect(spawnCalls).toBe(0);
        expect(unkeyed).toEqual({
            state          : FLEET_BRIDGE_STATES.UNKEYED,
            verdict        : 'refused',
            action         : null,
            port           : unkeyedPort,
            publicKeySha256: expectedSha256,
            pid            : null,
            logFilePath    : null,
            reason         : 'bridge-verifier-mismatch',
            summary        : `The Neural Link Bridge on port ${unkeyedPort} is unkeyed, keyed to another Fleet registry, or running an older Bridge protocol.`,
            nextStep       : `If the Neural Link Bridge on port ${unkeyedPort} is supervised (for example by host-edge / launchd), update its supervisor's NEO_FLEET_BRIDGE_PUBLIC_KEY to match this Fleet registry (publicKeySha256 ${expectedSha256}) and restart the supervised Bridge; otherwise stop the process on port ${unkeyedPort} and restart the Fleet server so Fleet starts a Bridge from this runtime generation with this registry's key, then reconnect the seat.`
        });

        // 3. Unanswered port when startIfAbsent is disabled reports bridge-unavailable.
        const freePort    = await findFreePort();
        const unavailable = describeFleetBridgeState({
            port           : freePort,
            probe          : {verdict: 'unanswered', reason: 'timeout'},
            publicKeySha256: expectedSha256
        });
        expect(unavailable).toMatchObject({
            state   : FLEET_BRIDGE_STATES.UNAVAILABLE,
            verdict : 'unanswered',
            port    : freePort,
            reason  : 'bridge-verifier-unavailable',
            summary : `No Neural Link Bridge answered the verifier check on port ${freePort}.`,
            nextStep: `Check that port ${freePort} is free and restart the Fleet server to start the Neural Link Bridge.`
        });

        // 4. Asynchronous ChildProcess 'error' event is caught (never crashes as unhandled EventEmitter error)
        // and reports bridge-unavailable with the sanitized error code and stdio log path.
        let   capturedStdio = null;
        const expectedLog   = getFleetBridgeStdioLogPath({dataDir: FleetRegistryService.dataDir});
        const spawnFailed   = await settleFleetBridge({
            port            : freePort,
            registry        : FleetRegistryService,
            probeFn         : async () => ({verdict: 'unanswered', reason: 'timeout'}),
            probeTimeoutMs  : 50,
            startupTimeoutMs: 250,
            pollIntervalMs  : 25,
            spawnFn         : (_cmd, _args, options) => {
                capturedStdio = options.stdio;
                const emitter = new EventEmitter();
                setImmediate(() => {
                    emitter.emit('error', Object.assign(new Error('spawn EACCES'), {code: 'EACCES'}));
                });
                return emitter;
            }
        });
        expect(Array.isArray(capturedStdio)).toBe(true);
        expect(capturedStdio[0]).toBe('ignore');
        expect(typeof capturedStdio[1]).toBe('number');
        expect(capturedStdio[2]).toBe(capturedStdio[1]);
        expect(spawnFailed).toEqual({
            state          : FLEET_BRIDGE_STATES.UNAVAILABLE,
            verdict        : 'unanswered',
            action         : null,
            port           : freePort,
            publicKeySha256: expectedSha256,
            pid            : null,
            logFilePath    : expectedLog,
            reason         : 'EACCES',
            summary        : `The Neural Link Bridge on port ${freePort} failed to start (EACCES); stdio log: ${expectedLog}.`,
            nextStep       : `Inspect ${expectedLog}, stop any conflicting process on port ${freePort}, and restart the Fleet server to start the Neural Link Bridge.`
        });
    });
});
