import {expect, test}           from '@playwright/test';
import crypto                   from 'node:crypto';
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
    isBridgeListenerCommand,
    readFleetBridgeOwnerRecord,
    settleFleetBridge,
    superviseFleetBridge,
    writeFleetBridgeOwnerRecord
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
        // Real-process witness for AC-2 & AC-3: rotate the registry signing key so the live Bridge
        // refuses the probe, verify settleFleetBridge replaces the Fleet-started process, then kill
        // the replacement and verify superviseFleetBridge restarts it within one tick.
        fs.rmSync(path.join(FleetRegistryService.dataDir, 'signing.key'), {force: true});
        FleetRegistryService.signingKeyPair = null;
        FleetRegistryService.getBridgePublicKey();
        const rotatedAuthority = FleetRegistryService.getBridgeSigningAuthority();
        expect(rotatedAuthority.publicKeySha256).not.toBe(authority.publicKeySha256);

        const realReplaced = await settleFleetBridge({
            port,
            registry        : FleetRegistryService,
            probeTimeoutMs  : 1000,
            startupTimeoutMs: 5000
        });
        if (realReplaced.pid) {
            spawnedPids.push(realReplaced.pid);
        }
        expect(realReplaced).toMatchObject({
            state          : FLEET_BRIDGE_STATES.READY,
            verdict        : 'proved',
            action         : 'replaced',
            port,
            publicKeySha256: rotatedAuthority.publicKeySha256,
            replacedPids   : [booted.pid]
        });
        expect(realReplaced.pid).not.toBe(booted.pid);

        process.kill(realReplaced.pid, 'SIGTERM');
        await expect.poll(() => {
            try {
                process.kill(realReplaced.pid, 0);
                return true;
            } catch {
                return false;
            }
        }).toBe(false);

        const liveStateChanges = [];
        const liveSupervisor   = superviseFleetBridge({
            port,
            registry         : FleetRegistryService,
            intervalMs       : 60000,
            initialSettlement: realReplaced,
            onStateChange    : s => liveStateChanges.push(s),
            settleOptions    : {probeTimeoutMs: 1000, startupTimeoutMs: 5000}
        });
        const realRestarted = await liveSupervisor.tick();
        liveSupervisor.stop();
        if (realRestarted.pid) {
            spawnedPids.push(realRestarted.pid);
        }
        expect(realRestarted).toMatchObject({
            state          : FLEET_BRIDGE_STATES.READY,
            verdict        : 'proved',
            action         : 'started',
            port,
            publicKeySha256: rotatedAuthority.publicKeySha256
        });
        expect(realRestarted.pid).not.toBe(realReplaced.pid);
        expect(liveStateChanges).toHaveLength(1);
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

    // Production never sets the registry's test override: its directory comes from getDataDir()
    function productionRegistry(dataDir) {
        const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({type: 'spki', format: 'pem'});

        FleetRegistryService.dataDir = null;

        return {getBridgePublicKey: () => publicKey, getDataDir: () => dataDir}
    }

    test('#1208: without the test override, the Bridge log lands under the resolved data dir and the start proceeds', async () => {
        const
            dataDir = path.join(tempRoot, 'resolved'),
            port    = await findFreePort(),
            probes  = [{verdict: 'unanswered', reason: 'timeout'}, {verdict: 'proved'}],
            settled = await settleFleetBridge({
                port,
                registry        : productionRegistry(dataDir),
                probeFn         : async () => probes.shift() ?? {verdict: 'proved'},
                probeTimeoutMs  : 50,
                startupTimeoutMs: 250,
                pollIntervalMs  : 25,
                spawnFn         : () => Object.assign(new EventEmitter(), {pid: 4242, unref: () => {}})
            }),
            logFile  = path.join(dataDir, 'logs', 'neural-link-bridge-stdio.log');

        expect(settled).toMatchObject({state: FLEET_BRIDGE_STATES.READY, action: 'started', pid: 4242, logFilePath: logFile});
        expect(fs.existsSync(logFile)).toBe(true)
    });

    test('#1208: a log that cannot be placed reports bridge-unavailable and never rejects the settle', async () => {
        const port    = await findFreePort();
        let   spawned = 0;

        const settled = await settleFleetBridge({
            port,
            registry        : productionRegistry(''),
            probeFn         : async () => ({verdict: 'unanswered', reason: 'timeout'}),
            probeTimeoutMs  : 50,
            startupTimeoutMs: 100,
            pollIntervalMs  : 25,
            spawnFn         : () => {spawned++}
        });

        expect(settled).toMatchObject({state: FLEET_BRIDGE_STATES.UNAVAILABLE, reason: 'FLEET_DATA_DIR_MISSING', logFilePath: null});
        expect(spawned).toBe(0)
    });

    test('AC-2 (#1203): replaces a verified Fleet-owned stale run-bridge.mjs listener on bridge-verifier-unsupported, bridge-verifier-unconfigured, and bridge-verifier-mismatch', async () => {
        expect(isBridgeListenerCommand('/opt/homebrew/bin/node /repo/ai/mcp/server/neural-link/run-bridge.mjs')).toBe(true);
        expect(isBridgeListenerCommand('node ai/mcp/server/neural-link/run-bridge.mjs --flag')).toBe(true);
        expect(isBridgeListenerCommand('python3 -m http.server 8081')).toBe(false);

        const port = await findFreePort();

        for (const refusalReason of [
            'bridge-verifier-unsupported',
            'bridge-verifier-unconfigured',
            'bridge-verifier-mismatch'
        ]) {
            writeFleetBridgeOwnerRecord({
                dataDir: FleetRegistryService.getDataDir(),
                pid    : 5150,
                port
            });

            const killedSignals = [];
            let   portReleased  = false;
            let   spawnCalls    = 0;
            const probes        = [
                {verdict: 'refused', reason: refusalReason},
                {verdict: 'proved'}
            ];

            const settled = await settleFleetBridge({
                port,
                registry           : FleetRegistryService,
                probeFn            : async () => probes.shift() ?? {verdict: 'proved'},
                listPortListenersFn: () => (portReleased ? [] : [5150]),
                processCommandFn   : pid => (pid === 5150
                    ? '/usr/local/bin/node /Users/test/neo-agent-brain/ai/mcp/server/neural-link/run-bridge.mjs'
                    : ''),
                processParentPidFn: pid => (pid === 5150 ? 1 : null),
                killProcessFn     : (pid, signal) => {
                    killedSignals.push({pid, signal});
                    portReleased = true;
                },
                spawnFn            : () => {
                    spawnCalls += 1;
                    return Object.assign(new EventEmitter(), {pid: 6260, unref: () => {}});
                },
                probeTimeoutMs  : 50,
                startupTimeoutMs: 250,
                pollIntervalMs  : 10
            });

            expect(killedSignals).toEqual([{pid: 5150, signal: 'SIGTERM'}]);
            expect(spawnCalls).toBe(1);
            expect(settled).toMatchObject({
                state       : FLEET_BRIDGE_STATES.READY,
                verdict     : 'proved',
                action      : 'replaced',
                port,
                pid         : 6260,
                replacedPids: [5150],
                reason      : null
            });
            expect(readFleetBridgeOwnerRecord({dataDir: FleetRegistryService.getDataDir()})).toMatchObject({
                pid: 6260,
                port
            });
        }
    });

    test('AC-2 & RA-1 (#1203): never signals a foreign listener or a run-bridge.mjs that Fleet did not start or that another supervisor owns', async () => {
        const port          = await findFreePort();
        const killedSignals = [];
        let   spawnCalls    = 0;

        // 1. Foreign non-run-bridge.mjs listener.
        const outdatedForeign = await settleFleetBridge({
            port,
            registry           : FleetRegistryService,
            probeFn            : async () => ({verdict: 'refused', reason: 'bridge-verifier-unsupported'}),
            listPortListenersFn: () => [9001],
            processCommandFn   : () => 'python3 -m http.server 8081',
            killProcessFn      : (pid, signal) => {
                killedSignals.push({pid, signal});
            },
            spawnFn            : () => {
                spawnCalls += 1;
                return Object.assign(new EventEmitter(), {pid: 9999, unref: () => {}});
            },
            probeTimeoutMs     : 50
        });

        expect(killedSignals).toEqual([]);
        expect(spawnCalls).toBe(0);
        expect(outdatedForeign).toMatchObject({
            state  : FLEET_BRIDGE_STATES.OUTDATED,
            verdict: 'refused',
            action : null,
            port,
            reason : 'bridge-verifier-unsupported'
        });

        // 2. Unrecorded run-bridge.mjs listener (not started by this Fleet dataDir) is never signaled.
        const unrecordedBridge = await settleFleetBridge({
            port,
            registry           : FleetRegistryService,
            probeFn            : async () => ({verdict: 'refused', reason: 'bridge-verifier-mismatch'}),
            listPortListenersFn: () => [21546],
            processCommandFn   : () => 'node /repo/ai/mcp/server/neural-link/run-bridge.mjs',
            processParentPidFn : () => 1,
            killProcessFn      : (pid, signal) => {
                killedSignals.push({pid, signal});
            },
            spawnFn            : () => {
                spawnCalls += 1;
                return Object.assign(new EventEmitter(), {pid: 9999, unref: () => {}});
            },
            probeTimeoutMs     : 50
        });

        expect(killedSignals).toEqual([]);
        expect(spawnCalls).toBe(0);
        expect(unrecordedBridge).toMatchObject({
            state  : FLEET_BRIDGE_STATES.UNKEYED,
            verdict: 'refused',
            action : null,
            port,
            reason : 'bridge-verifier-mismatch'
        });

        // 3. Supervised run-bridge.mjs listener (e.g. child of hostEdge.mjs, ppid=21525) is never signaled
        // even if an owner record matches its PID.
        writeFleetBridgeOwnerRecord({
            dataDir: FleetRegistryService.getDataDir(),
            pid    : 21546,
            port
        });

        const supervisedBridge = await settleFleetBridge({
            port,
            registry           : FleetRegistryService,
            probeFn            : async () => ({verdict: 'refused', reason: 'bridge-verifier-mismatch'}),
            listPortListenersFn: () => [21546],
            processCommandFn   : () => 'node /repo/ai/mcp/server/neural-link/run-bridge.mjs',
            processParentPidFn : () => 21525,
            killProcessFn      : (pid, signal) => {
                killedSignals.push({pid, signal});
            },
            spawnFn            : () => {
                spawnCalls += 1;
                return Object.assign(new EventEmitter(), {pid: 9999, unref: () => {}});
            },
            probeTimeoutMs     : 50
        });

        expect(killedSignals).toEqual([]);
        expect(spawnCalls).toBe(0);
        expect(supervisedBridge).toMatchObject({
            state  : FLEET_BRIDGE_STATES.UNKEYED,
            verdict: 'refused',
            action : null,
            port,
            reason : 'bridge-verifier-mismatch'
        });
    });

    test('AC-3, AC-4 & RA-2 (#1203): superviseFleetBridge restarts an exited Bridge mid-session, deduplicates unchanged non-ready states across ticks, coalesces overlapping ticks, and stop() leaves the detached Bridge running', async () => {
        const port          = await findFreePort();
        let   scheduledCb   = null;
        let   clearedHandle = null;
        let   unrefCalled   = false;
        const fakeHandle    = {
            unref() {
                unrefCalled = true;
            }
        };

        const settlements  = [];
        const stateChanges = [];
        let   resolveSlowSettle;
        const slowSettlePromise = new Promise(resolve => {
            resolveSlowSettle = resolve;
        });

        const bootUnkeyed = {
            state  : FLEET_BRIDGE_STATES.UNKEYED,
            verdict: 'refused',
            action : null,
            port,
            pid    : null,
            reason : 'bridge-verifier-mismatch'
        };

        let   callIndex  = 0;
        const supervisor = superviseFleetBridge({
            port,
            registry         : FleetRegistryService,
            intervalMs       : 5000,
            initialSettlement: bootUnkeyed,
            scheduleFn       : fn => {
                scheduledCb = fn;
                return fakeHandle;
            },
            clearScheduleFn: handle => {
                clearedHandle = handle;
            },
            onSettle     : s => settlements.push(s),
            onStateChange: s => stateChanges.push(s),
            settleFn     : async ({port: settledPort}) => {
                callIndex += 1;
                if (callIndex === 1) {
                    return {...bootUnkeyed, port: settledPort};
                }
                if (callIndex === 2) {
                    return slowSettlePromise;
                }
                if (callIndex === 3) {
                    return {
                        state  : FLEET_BRIDGE_STATES.READY,
                        verdict: 'proved',
                        action : 'adopted',
                        port   : settledPort,
                        pid    : 7777,
                        reason : null
                    };
                }
                return {
                    state       : FLEET_BRIDGE_STATES.READY,
                    verdict     : 'proved',
                    action      : 'replaced',
                    port        : settledPort,
                    pid         : 8888,
                    replacedPids: [7777],
                    reason      : null
                };
            }
        });

        expect(typeof scheduledCb).toBe('function');
        expect(unrefCalled).toBe(true);
        expect(supervisor.isRunning()).toBe(true);

        // First tick returns the same non-ready state as initialSettlement: onStateChange must NOT fire.
        await supervisor.tick();
        expect(callIndex).toBe(1);
        expect(settlements).toHaveLength(1);
        expect(stateChanges).toHaveLength(0);

        // Trigger overlapping ticks while the second settle is in flight; they must coalesce onto one call.
        const firstTick  = supervisor.tick();
        const secondTick = supervisor.tick();
        expect(callIndex).toBe(2);

        resolveSlowSettle({
            state  : FLEET_BRIDGE_STATES.READY,
            verdict: 'proved',
            action : 'started',
            port,
            pid    : 7777,
            reason : null
        });

        const [firstOutcome, secondOutcome] = await Promise.all([firstTick, secondTick]);
        expect(firstOutcome).toEqual(secondOutcome);
        expect(firstOutcome.action).toBe('started');
        expect(settlements).toHaveLength(2);
        expect(stateChanges).toHaveLength(1);

        // Next scheduled tick adopts the healthy running Bridge; stateChange fires because action changed ('started' -> 'adopted').
        scheduledCb();
        await new Promise(resolve => setImmediate(resolve));
        expect(callIndex).toBe(3);
        expect(supervisor.getLastSettlement()?.action).toBe('adopted');
        expect(settlements).toHaveLength(3);
        expect(stateChanges).toHaveLength(2);

        // Fourth tick replaces a drifted Bridge ('adopted' -> 'replaced').
        await supervisor.tick();
        expect(callIndex).toBe(4);
        expect(supervisor.getLastSettlement()?.action).toBe('replaced');
        expect(stateChanges).toHaveLength(3);

        // Stopping the supervisor on Fleet shutdown clears the timer without killing the detached Bridge.
        supervisor.stop();
        expect(supervisor.isRunning()).toBe(false);
        expect(clearedHandle).toBe(fakeHandle);

        const afterStop = await supervisor.tick();
        expect(callIndex).toBe(4);
        expect(afterStop?.pid).toBe(8888);
    });
});
