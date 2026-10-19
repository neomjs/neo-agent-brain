import {execFileSync, spawn} from 'node:child_process';
import crypto                from 'node:crypto';
import fs                    from 'node:fs';
import path                  from 'node:path';
import {fileURLToPath}       from 'node:url';
import FleetRegistryService  from './FleetRegistryService.mjs';
import {probeBridgeVerifier} from './probeBridgeVerifier.mjs';

const
    MODULE_DIR                    = path.dirname(fileURLToPath(import.meta.url)),
    DEFAULT_BRIDGE_SCRIPT         = path.resolve(MODULE_DIR, '../../mcp/server/neural-link/run-bridge.mjs'),
    DEFAULT_PROBE_TIMEOUT         = 1500,
    DEFAULT_START_TIMEOUT         = 5000,
    DEFAULT_POLL_INTERVAL         = 75,
    DEFAULT_RELEASE_TIMEOUT       = 1500,
    DEFAULT_RELEASE_POLL_INTERVAL = 50,
    DEFAULT_SUPERVISE_INTERVAL    = 15000;

export const FLEET_BRIDGE_STATES = Object.freeze({
    READY      : 'ready',
    OUTDATED   : 'bridge-outdated',
    UNKEYED    : 'bridge-unkeyed',
    UNAVAILABLE: 'bridge-unavailable'
});

/**
 * @summary Returns whether a process command line belongs to the Neural Link Bridge (`run-bridge.mjs`).
 * @param {String} command Process command line string from `ps`.
 * @returns {Boolean}
 */
export function isBridgeListenerCommand(command) {
    return typeof command === 'string' && /(?:^|[\/\s])run-bridge\.mjs(?:\s|$)/.test(command.trim());
}

/**
 * @summary Lists positive integer PIDs listening on TCP `port`, excluding the current process.
 * @param {Number} port TCP port to inspect.
 * @returns {Number[]}
 */
export function defaultListPortListeners(port) {
    try {
        const output = execFileSync(
            'lsof',
            ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'],
            {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}
        );
        return [...new Set(
            String(output)
                .split(/\s+/)
                .map(token => Number.parseInt(token.trim(), 10))
                .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
        )];
    } catch {
        return [];
    }
}

/**
 * @summary Reads the command line for `pid` via `ps`.
 * @param {Number} pid Process identifier.
 * @returns {String}
 */
export function defaultProcessCommand(pid) {
    try {
        const output = execFileSync(
            'ps',
            ['-p', String(pid), '-o', 'command='],
            {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}
        );
        return String(output || '').trim();
    } catch {
        return '';
    }
}

/**
 * @summary Sends a signal to `pid`.
 * @param {Number} pid Process identifier.
 * @param {String} [signal='SIGTERM'] Signal name.
 * @returns {void}
 */
export function defaultKillProcess(pid, signal = 'SIGTERM') {
    process.kill(pid, signal);
}

/**
 * @summary Sleeps for `ms` milliseconds.
 * @param {Number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @summary Polls until `port` has no active listeners or escalates verified `targetPids` to `SIGKILL` on timeout.
 * @param {Number} port TCP port being released.
 * @param {Object} [options={}]
 * @param {Function} [options.listPortListenersFn=defaultListPortListeners] Port listener resolver.
 * @param {Function} [options.killProcessFn=defaultKillProcess] Process signal sender.
 * @param {Function} [options.sleepFn=defaultSleep] Async delay helper.
 * @param {Number[]} [options.targetPids=[]] Verified `run-bridge.mjs` PIDs eligible for `SIGKILL` escalation.
 * @param {Number} [options.releaseTimeoutMs=DEFAULT_RELEASE_TIMEOUT] Max wait before `SIGKILL` escalation.
 * @param {Number} [options.pollIntervalMs=DEFAULT_RELEASE_POLL_INTERVAL] Poll interval in milliseconds.
 * @returns {Promise<Boolean>} True when `port` is free.
 */
export async function defaultWaitForPortRelease(
    port,
    {
        listPortListenersFn = defaultListPortListeners,
        killProcessFn       = defaultKillProcess,
        sleepFn             = defaultSleep,
        targetPids          = [],
        releaseTimeoutMs    = DEFAULT_RELEASE_TIMEOUT,
        pollIntervalMs      = DEFAULT_RELEASE_POLL_INTERVAL
    } = {}
) {
    const deadline  = Date.now() + Math.max(0, releaseTimeoutMs);
    let   remaining = await listPortListenersFn(port);

    while (Array.isArray(remaining) && remaining.length > 0 && Date.now() < deadline) {
        await sleepFn(pollIntervalMs);
        remaining = await listPortListenersFn(port);
    }

    if (Array.isArray(remaining) && remaining.length > 0) {
        const targetSet = new Set(targetPids);
        for (const pid of remaining) {
            if (targetSet.has(pid)) {
                try {
                    killProcessFn(pid, 'SIGKILL');
                } catch {
                    // Process already exited.
                }
            }
        }
        await sleepFn(pollIntervalMs);
        remaining = await listPortListenersFn(port);
    }

    return !Array.isArray(remaining) || remaining.length === 0;
}

/**
 * @summary Resolves the detached Bridge stdio log file path under the Fleet data directory.
 * @param {Object} [options={}]
 * @param {String} [options.dataDir=FleetRegistryService.getDataDir()] Fleet data directory, resolved.
 * @param {String|null} [options.logFilePath=null] Explicit log file path override.
 * @returns {String}
 */
export function getFleetBridgeStdioLogPath({
    dataDir     = FleetRegistryService.getDataDir(),
    logFilePath = null
} = {}) {
    if (typeof logFilePath === 'string' && logFilePath.trim() !== '') {
        return logFilePath;
    }

    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
        throw Object.assign(new Error('Missing Fleet dataDir: Neural Link Bridge stdio log requires a resolved Fleet data directory'), {code: 'FLEET_DATA_DIR_MISSING'});
    }

    return path.join(dataDir, 'logs', 'neural-link-bridge-stdio.log');
}

/**
 * @summary Opens the detached Bridge stdout/stderr log file for appending.
 * @param {String} [filePath=getFleetBridgeStdioLogPath()] Target log file path.
 * @returns {Number} File descriptor.
 */
export function openFleetBridgeLogFile(filePath = getFleetBridgeStdioLogPath()) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    return fs.openSync(filePath, 'a');
}

/**
 * @summary Maps a Bridge verifier probe outcome to one named Fleet boot state and its operator next step.
 * @param {Object} params
 * @param {Number} params.port Neural Link Bridge WebSocket port.
 * @param {{verdict: 'proved'|'refused'|'unanswered', reason?: String}} params.probe Probe outcome.
 * @param {'adopted'|'started'|'replaced'|null} [params.action=null] How a Bridge was settled.
 * @param {String|null} [params.publicKeySha256=null] Expected registry key SHA-256 hex digest.
 * @param {Number|null} [params.pid=null] Spawned Bridge process id when started or replaced by Fleet.
 * @param {Number[]|null} [params.replacedPids=null] Prior `run-bridge.mjs` PIDs replaced during settlement.
 * @param {String|null} [params.logFilePath=null] Detached Bridge stdio log path when started by Fleet.
 * @param {String|null} [params.spawnFailure=null] Sanitized spawn failure code when process launch failed.
 * @returns {{state: String, verdict: String, action: String|null, port: Number, publicKeySha256: String|null, pid: Number|null, replacedPids?: Number[], logFilePath: String|null, reason: String|null, summary: String|null, nextStep: String|null}}
 */
export function describeFleetBridgeState({
    port,
    probe,
    action          = null,
    publicKeySha256 = null,
    pid             = null,
    replacedPids    = null,
    logFilePath     = null,
    spawnFailure    = null
}) {
    const
        resolvedPort = Number(port),
        replacedMeta = Array.isArray(replacedPids) ? {replacedPids} : {};

    if (probe?.verdict === 'proved') {
        return {
            state          : FLEET_BRIDGE_STATES.READY,
            verdict        : 'proved',
            action         : action ?? 'adopted',
            port           : resolvedPort,
            publicKeySha256: publicKeySha256 ?? null,
            pid            : pid ?? null,
            ...replacedMeta,
            logFilePath: logFilePath ?? null,
            reason     : null,
            summary    : null,
            nextStep   : null
        };
    }

    if (probe?.verdict === 'refused' && probe.reason === 'bridge-verifier-unsupported') {
        return {
            state          : FLEET_BRIDGE_STATES.OUTDATED,
            verdict        : 'refused',
            action         : action ?? null,
            port           : resolvedPort,
            publicKeySha256: publicKeySha256 ?? null,
            pid            : pid ?? null,
            ...replacedMeta,
            logFilePath: logFilePath ?? null,
            reason     : 'bridge-verifier-unsupported',
            summary    : `An older Neural Link Bridge on port ${resolvedPort} predates verifier support.`,
            nextStep   : `If the Neural Link Bridge on port ${resolvedPort} is supervised (for example by host-edge / launchd), update and restart that supervised service; otherwise stop the process on port ${resolvedPort} and restart the Fleet server so Fleet starts a keyed Bridge from this runtime generation, then reconnect the seat.`
        };
    }

    if (probe?.verdict === 'refused') {
        const reason = probe.reason ?? 'bridge-verifier-mismatch';
        return {
            state          : FLEET_BRIDGE_STATES.UNKEYED,
            verdict        : 'refused',
            action         : action ?? null,
            port           : resolvedPort,
            publicKeySha256: publicKeySha256 ?? null,
            pid            : pid ?? null,
            ...replacedMeta,
            logFilePath: logFilePath ?? null,
            reason,
            summary    : `The Neural Link Bridge on port ${resolvedPort} is unkeyed, keyed to another Fleet registry, or running an older Bridge protocol.`,
            nextStep   : `If the Neural Link Bridge on port ${resolvedPort} is supervised (for example by host-edge / launchd), update its supervisor's NEO_FLEET_BRIDGE_PUBLIC_KEY to match this Fleet registry (publicKeySha256 ${publicKeySha256 ?? 'current'}) and restart the supervised Bridge; otherwise stop the process on port ${resolvedPort} and restart the Fleet server so Fleet starts a Bridge from this runtime generation with this registry's key, then reconnect the seat.`
        };
    }

    const
        failureReason  = spawnFailure || 'bridge-verifier-unavailable',
        failureSummary = spawnFailure
            ? `The Neural Link Bridge on port ${resolvedPort} failed to start (${spawnFailure})${logFilePath ? `; stdio log: ${logFilePath}` : ''}.`
            : `No Neural Link Bridge answered the verifier check on port ${resolvedPort}${logFilePath ? ` (stdio log: ${logFilePath})` : ''}.`,
        failureStep    = logFilePath
            ? `Inspect ${logFilePath}, stop any conflicting process on port ${resolvedPort}, and restart the Fleet server to start the Neural Link Bridge.`
            : `Check that port ${resolvedPort} is free and restart the Fleet server to start the Neural Link Bridge.`;

    return {
        state          : FLEET_BRIDGE_STATES.UNAVAILABLE,
        verdict        : 'unanswered',
        action         : action ?? null,
        port           : resolvedPort,
        publicKeySha256: publicKeySha256 ?? null,
        pid            : pid ?? null,
        ...replacedMeta,
        logFilePath: logFilePath ?? null,
        reason     : failureReason,
        summary    : failureSummary,
        nextStep   : failureStep
    };
}

/**
 * @summary Settles the Neural Link Bridge using the registry's signing custody.
 *
 * Adopts an already-running Bridge when its verifier proof matches (`action: 'adopted'`), starts a
 * detached `run-bridge.mjs` when the port is unanswered (`action: 'started'`), and replaces a stale
 * `run-bridge.mjs` listener when the probe is refused due to generation or verifier-key mismatch
 * (`action: 'replaced'`). Foreign listeners whose command line does not match `run-bridge.mjs` are
 * never signaled and fail closed with `bridge-outdated` or `bridge-unkeyed`.
 *
 * @param {Object} [options={}]
 * @param {Number} options.port Neural Link Bridge WebSocket port.
 * @param {Object} [options.registry=FleetRegistryService] Fleet registry holding `signing.key` custody.
 * @param {Function} [options.probeFn=probeBridgeVerifier] Verifier probe function.
 * @param {Function} [options.spawnFn=spawn] Child process spawner for detached Bridge launch.
 * @param {Function} [options.openLogFileFn=openFleetBridgeLogFile] Opens the Bridge stdio log file descriptor.
 * @param {String|null} [options.logFilePath=null] Explicit Bridge stdio log file path override.
 * @param {String} [options.nodeBin=process.execPath] Node executable for launching `run-bridge.mjs`.
 * @param {String} [options.bridgeScriptPath=DEFAULT_BRIDGE_SCRIPT] Path to `run-bridge.mjs`.
 * @param {Boolean} [options.startIfAbsent=true] Whether to start or replace a detached keyed Bridge.
 * @param {Boolean} [options.replaceIfRefused=true] Whether to replace a verified stale `run-bridge.mjs` listener on `refused`.
 * @param {Function} [options.listPortListenersFn=defaultListPortListeners] Resolves listener PIDs on `port`.
 * @param {Function} [options.processCommandFn=defaultProcessCommand] Resolves the command line for a listener PID.
 * @param {Function} [options.killProcessFn=defaultKillProcess] Sends a signal to a verified stale Bridge PID.
 * @param {Function} [options.waitForPortReleaseFn=defaultWaitForPortRelease] Waits for `port` to release after signaling.
 * @param {Function} [options.sleepFn=defaultSleep] Async sleep helper for port-release and startup polling.
 * @param {Number} [options.probeTimeoutMs=DEFAULT_PROBE_TIMEOUT] Single-probe timeout in milliseconds.
 * @param {Number} [options.startupTimeoutMs=DEFAULT_START_TIMEOUT] Max wait for a newly spawned Bridge.
 * @param {Number} [options.pollIntervalMs=DEFAULT_POLL_INTERVAL] Poll interval while waiting for startup.
 * @returns {Promise<ReturnType<typeof describeFleetBridgeState>>}
 */
export async function settleFleetBridge({
    port,
    registry             = FleetRegistryService,
    probeFn              = probeBridgeVerifier,
    spawnFn              = spawn,
    openLogFileFn        = openFleetBridgeLogFile,
    logFilePath          = null,
    nodeBin              = process.execPath,
    bridgeScriptPath     = DEFAULT_BRIDGE_SCRIPT,
    startIfAbsent        = true,
    replaceIfRefused     = true,
    listPortListenersFn  = defaultListPortListeners,
    processCommandFn     = defaultProcessCommand,
    killProcessFn        = defaultKillProcess,
    waitForPortReleaseFn = defaultWaitForPortRelease,
    sleepFn              = defaultSleep,
    probeTimeoutMs       = DEFAULT_PROBE_TIMEOUT,
    startupTimeoutMs     = DEFAULT_START_TIMEOUT,
    pollIntervalMs       = DEFAULT_POLL_INTERVAL
} = {}) {
    const
        resolvedPort    = Number(port),
        publicKey       = registry.getBridgePublicKey(),
        publicKeySha256 = crypto
            .createHash('sha256')
            .update(crypto.createPublicKey(publicKey).export({type: 'spki', format: 'der'}))
            .digest('hex'),
        initialProbe    = await probeFn({
            port     : resolvedPort,
            publicKeySha256,
            timeoutMs: probeTimeoutMs
        });

    if (initialProbe?.verdict === 'proved') {
        return describeFleetBridgeState({
            port  : resolvedPort,
            probe : initialProbe,
            action: 'adopted',
            publicKeySha256
        });
    }

    if (!startIfAbsent) {
        return describeFleetBridgeState({
            port : resolvedPort,
            probe: initialProbe,
            publicKeySha256
        });
    }

    let settledAction = 'started',
        replacedPids  = null;

    if (initialProbe?.verdict === 'refused') {
        if (!replaceIfRefused) {
            return describeFleetBridgeState({
                port : resolvedPort,
                probe: initialProbe,
                publicKeySha256
            });
        }

        const rawListeners = await listPortListenersFn(resolvedPort);
        const listenerPids = Array.isArray(rawListeners) ? rawListeners : [];

        if (listenerPids.length === 0) {
            return describeFleetBridgeState({
                port : resolvedPort,
                probe: initialProbe,
                publicKeySha256
            });
        }

        for (const listenerPid of listenerPids) {
            const command = await processCommandFn(listenerPid);
            if (!isBridgeListenerCommand(command)) {
                return describeFleetBridgeState({
                    port : resolvedPort,
                    probe: initialProbe,
                    publicKeySha256
                });
            }
        }

        for (const listenerPid of listenerPids) {
            try {
                killProcessFn(listenerPid, 'SIGTERM');
            } catch (error) {
                if (error?.code !== 'ESRCH') {
                    return describeFleetBridgeState({
                        port : resolvedPort,
                        probe: initialProbe,
                        publicKeySha256
                    });
                }
            }
        }

        const released = await waitForPortReleaseFn(resolvedPort, {
            listPortListenersFn,
            killProcessFn,
            sleepFn,
            targetPids: listenerPids
        });

        if (!released) {
            return describeFleetBridgeState({
                port : resolvedPort,
                probe: initialProbe,
                publicKeySha256
            });
        }

        settledAction = 'replaced';
        replacedPids  = listenerPids;
    }

    const childEnv = {
        ...process.env,
        NEO_NL_PORT                : String(resolvedPort),
        NEO_FLEET_BRIDGE_PUBLIC_KEY: publicKey
    };

    let logFd               = null,
        child               = null,
        resolvedLogFilePath = null,
        spawnFailure        = null,
        resolveSpawnError;
    const spawnErrorSignal = new Promise(resolve => {
        resolveSpawnError = resolve;
    });

    // Placing the log is part of the start: a failure reports bridge-unavailable and never ends Fleet boot
    try {
        resolvedLogFilePath = getFleetBridgeStdioLogPath({dataDir: registry.getDataDir(), logFilePath});
        logFd = openLogFileFn(resolvedLogFilePath);
        child = spawnFn(nodeBin, [bridgeScriptPath], {
            detached: true,
            stdio   : ['ignore', logFd, logFd],
            env     : childEnv
        });
    } catch (error) {
        spawnFailure = error?.code || 'BRIDGE_SPAWN_FAILED';
        resolveSpawnError(spawnFailure);
    } finally {
        if (typeof logFd === 'number') {
            try {
                fs.closeSync(logFd);
            } catch {
                // Descriptor is already closed or synthetic in unit tests.
            }
        }
    }

    // A spawn failure arrives as an asynchronous 'error' event on the ChildProcess EventEmitter.
    // Without a listener, an unhandled 'error' event crashes the Fleet server process instead of
    // reporting `bridge-unavailable`.
    if (child && typeof child.once === 'function') {
        child.once('error', error => {
            spawnFailure = error?.code || 'BRIDGE_SPAWN_FAILED';
            resolveSpawnError(spawnFailure);
        });
    }

    child?.unref?.();

    const
        pid      = child?.pid ?? null,
        deadline = Date.now() + Math.max(probeTimeoutMs, startupTimeoutMs);
    let lastProbe = initialProbe;

    while (!spawnFailure && Date.now() <= deadline) {
        const probeOutcome = await Promise.race([
            probeFn({
                port     : resolvedPort,
                publicKeySha256,
                timeoutMs: probeTimeoutMs
            }),
            spawnErrorSignal.then(() => null)
        ]);

        if (spawnFailure) {
            break;
        }

        lastProbe = probeOutcome;

        if (lastProbe?.verdict === 'proved') {
            return describeFleetBridgeState({
                port       : resolvedPort,
                probe      : lastProbe,
                action     : settledAction,
                publicKeySha256,
                pid,
                replacedPids,
                logFilePath: resolvedLogFilePath
            });
        }

        if (lastProbe?.verdict === 'refused') {
            return describeFleetBridgeState({
                port       : resolvedPort,
                probe      : lastProbe,
                action     : replacedPids ? settledAction : null,
                publicKeySha256,
                pid,
                replacedPids,
                logFilePath: resolvedLogFilePath
            });
        }

        if (Date.now() + pollIntervalMs > deadline) {
            break;
        }

        await Promise.race([
            sleepFn(pollIntervalMs),
            spawnErrorSignal
        ]);
    }

    return describeFleetBridgeState({
        port       : resolvedPort,
        probe      : lastProbe,
        action     : replacedPids ? settledAction : null,
        publicKeySha256,
        pid,
        replacedPids,
        logFilePath: resolvedLogFilePath,
        spawnFailure
    });
}

/**
 * @summary Periodically settles the Neural Link Bridge in the background while the Fleet server runs.
 *
 * Enforces "Supervise, never child": if the detached `run-bridge.mjs` process exits mid-session or
 * drifts in verifier key/generation, the next tick restarts or replaces it; calling `stop()` on Fleet
 * shutdown clears the supervision timer without terminating the detached Bridge process.
 *
 * @param {Object} [options={}]
 * @param {Number} options.port Neural Link Bridge WebSocket port.
 * @param {Object} [options.registry=FleetRegistryService] Fleet registry holding `signing.key` custody.
 * @param {Number} [options.intervalMs=DEFAULT_SUPERVISE_INTERVAL] Supervision poll interval in milliseconds.
 * @param {Object} [options.settleOptions={}] Additional options forwarded to `settleFn`.
 * @param {Function} [options.settleFn=settleFleetBridge] Bridge settlement function.
 * @param {Function|null} [options.onSettle=null] Optional callback invoked after each completed tick.
 * @param {Function|null} [options.onStateChange=null] Optional callback invoked when settlement state or action changes.
 * @param {Function} [options.scheduleFn=setInterval] Interval scheduler.
 * @param {Function} [options.clearScheduleFn=clearInterval] Interval clearer.
 * @returns {{stop: Function, tick: Function, getLastSettlement: Function, isRunning: Function}}
 */
export function superviseFleetBridge({
    port,
    registry        = FleetRegistryService,
    intervalMs      = DEFAULT_SUPERVISE_INTERVAL,
    settleOptions   = {},
    settleFn        = settleFleetBridge,
    onSettle        = null,
    onStateChange   = null,
    scheduleFn      = setInterval,
    clearScheduleFn = clearInterval
} = {}) {
    let stopped        = false,
        inFlight       = null,
        lastSettlement = null,
        timer          = null;

    async function tick() {
        if (stopped) {
            return lastSettlement;
        }
        if (inFlight) {
            return inFlight;
        }

        inFlight = (async () => {
            try {
                const settlement = await settleFn({
                    port,
                    registry,
                    ...settleOptions
                });
                const changed = !lastSettlement
                    || lastSettlement.state !== settlement?.state
                    || lastSettlement.action !== settlement?.action
                    || lastSettlement.reason !== settlement?.reason;

                lastSettlement = settlement;

                if (typeof onSettle === 'function') {
                    onSettle(settlement);
                }
                if (changed && typeof onStateChange === 'function') {
                    onStateChange(settlement);
                }

                return settlement;
            } catch {
                return lastSettlement;
            } finally {
                inFlight = null;
            }
        })();

        return inFlight;
    }

    if (Number.isFinite(intervalMs) && intervalMs > 0) {
        timer = scheduleFn(() => {
            void tick();
        }, intervalMs);
        timer?.unref?.();
    } else {
        stopped = true;
    }

    function stop() {
        if (stopped) {
            return;
        }
        stopped = true;
        if (timer !== null) {
            clearScheduleFn(timer);
            timer = null;
        }
    }

    return {
        stop,
        tick,
        getLastSettlement: () => lastSettlement,
        isRunning        : () => !stopped
    };
}
