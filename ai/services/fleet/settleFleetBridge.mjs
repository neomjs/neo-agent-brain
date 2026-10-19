import {spawn}               from 'node:child_process';
import crypto                from 'node:crypto';
import fs                    from 'node:fs';
import path                  from 'node:path';
import {fileURLToPath}       from 'node:url';
import FleetRegistryService  from './FleetRegistryService.mjs';
import {probeBridgeVerifier} from './probeBridgeVerifier.mjs';

const
    MODULE_DIR            = path.dirname(fileURLToPath(import.meta.url)),
    DEFAULT_BRIDGE_SCRIPT = path.resolve(MODULE_DIR, '../../mcp/server/neural-link/run-bridge.mjs'),
    DEFAULT_PROBE_TIMEOUT = 1500,
    DEFAULT_START_TIMEOUT = 5000,
    DEFAULT_POLL_INTERVAL = 75;

export const FLEET_BRIDGE_STATES = Object.freeze({
    READY      : 'ready',
    OUTDATED   : 'bridge-outdated',
    UNKEYED    : 'bridge-unkeyed',
    UNAVAILABLE: 'bridge-unavailable'
});

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
 * @param {'adopted'|'started'|null} [params.action=null] How a ready Bridge was settled.
 * @param {String|null} [params.publicKeySha256=null] Expected registry key SHA-256 hex digest.
 * @param {Number|null} [params.pid=null] Spawned Bridge process id when started by Fleet.
 * @param {String|null} [params.logFilePath=null] Detached Bridge stdio log path when started by Fleet.
 * @param {String|null} [params.spawnFailure=null] Sanitized spawn failure code when process launch failed.
 * @returns {{state: String, verdict: String, action: String|null, port: Number, publicKeySha256: String|null, pid: Number|null, logFilePath: String|null, reason: String|null, summary: String|null, nextStep: String|null}}
 */
export function describeFleetBridgeState({
    port,
    probe,
    action          = null,
    publicKeySha256 = null,
    pid             = null,
    logFilePath     = null,
    spawnFailure    = null
}) {
    const resolvedPort = Number(port);

    if (probe?.verdict === 'proved') {
        return {
            state          : FLEET_BRIDGE_STATES.READY,
            verdict        : 'proved',
            action         : action ?? 'adopted',
            port           : resolvedPort,
            publicKeySha256: publicKeySha256 ?? null,
            pid            : pid ?? null,
            logFilePath    : logFilePath ?? null,
            reason         : null,
            summary        : null,
            nextStep       : null
        };
    }

    if (probe?.verdict === 'refused' && probe.reason === 'bridge-verifier-unsupported') {
        return {
            state          : FLEET_BRIDGE_STATES.OUTDATED,
            verdict        : 'refused',
            action         : null,
            port           : resolvedPort,
            publicKeySha256: publicKeySha256 ?? null,
            pid            : null,
            logFilePath    : null,
            reason         : 'bridge-verifier-unsupported',
            summary        : `An older Neural Link Bridge on port ${resolvedPort} predates verifier support.`,
            nextStep       : `If the Neural Link Bridge on port ${resolvedPort} is supervised (for example by host-edge / launchd), update and restart that supervised service; otherwise stop the process on port ${resolvedPort} and restart the Fleet server so Fleet starts a keyed Bridge from this runtime generation, then reconnect the seat.`
        };
    }

    if (probe?.verdict === 'refused') {
        const reason = probe.reason ?? 'bridge-verifier-mismatch';
        return {
            state          : FLEET_BRIDGE_STATES.UNKEYED,
            verdict        : 'refused',
            action         : null,
            port           : resolvedPort,
            publicKeySha256: publicKeySha256 ?? null,
            pid            : null,
            logFilePath    : null,
            reason,
            summary        : `The Neural Link Bridge on port ${resolvedPort} is unkeyed, keyed to another Fleet registry, or running an older Bridge protocol.`,
            nextStep       : `If the Neural Link Bridge on port ${resolvedPort} is supervised (for example by host-edge / launchd), update its supervisor's NEO_FLEET_BRIDGE_PUBLIC_KEY to match this Fleet registry (publicKeySha256 ${publicKeySha256 ?? 'current'}) and restart the supervised Bridge; otherwise stop the process on port ${resolvedPort} and restart the Fleet server so Fleet starts a Bridge from this runtime generation with this registry's key, then reconnect the seat.`
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
        action         : null,
        port           : resolvedPort,
        publicKeySha256: publicKeySha256 ?? null,
        pid            : pid ?? null,
        logFilePath    : logFilePath ?? null,
        reason         : failureReason,
        summary        : failureSummary,
        nextStep       : failureStep
    };
}

/**
 * @summary Settles the Neural Link Bridge at Fleet boot using the registry's signing custody.
 *
 * Declared interim: when no Bridge answers on `port`, Fleet boot starts a detached Bridge child
 * directly with the registry's public key and routes its stdout/stderr to the Fleet log directory
 * while waiting for the `host-edge` supervised Bridge role to take over continuous lifecycle
 * ownership (restarts on mid-session exit and runtime-generation switches). Until that supervised
 * role lands, a Fleet-started Bridge that exits mid-session or predates a protocol generation
 * update remains until the next Fleet boot.
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
 * @param {Boolean} [options.startIfAbsent=true] Whether to start a detached keyed Bridge when unanswered.
 * @param {Number} [options.probeTimeoutMs=DEFAULT_PROBE_TIMEOUT] Single-probe timeout in milliseconds.
 * @param {Number} [options.startupTimeoutMs=DEFAULT_START_TIMEOUT] Max wait for a newly spawned Bridge.
 * @param {Number} [options.pollIntervalMs=DEFAULT_POLL_INTERVAL] Poll interval while waiting for startup.
 * @returns {Promise<ReturnType<typeof describeFleetBridgeState>>}
 */
export async function settleFleetBridge({
    port,
    registry         = FleetRegistryService,
    probeFn          = probeBridgeVerifier,
    spawnFn          = spawn,
    openLogFileFn    = openFleetBridgeLogFile,
    logFilePath      = null,
    nodeBin          = process.execPath,
    bridgeScriptPath = DEFAULT_BRIDGE_SCRIPT,
    startIfAbsent    = true,
    probeTimeoutMs   = DEFAULT_PROBE_TIMEOUT,
    startupTimeoutMs = DEFAULT_START_TIMEOUT,
    pollIntervalMs   = DEFAULT_POLL_INTERVAL
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

    if (initialProbe?.verdict === 'refused' || !startIfAbsent) {
        return describeFleetBridgeState({
            port : resolvedPort,
            probe: initialProbe,
            publicKeySha256
        });
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
                action     : 'started',
                publicKeySha256,
                pid,
                logFilePath: resolvedLogFilePath
            });
        }

        if (lastProbe?.verdict === 'refused') {
            return describeFleetBridgeState({
                port       : resolvedPort,
                probe      : lastProbe,
                publicKeySha256,
                logFilePath: resolvedLogFilePath
            });
        }

        if (Date.now() + pollIntervalMs > deadline) {
            break;
        }

        await Promise.race([
            new Promise(resolve => setTimeout(resolve, pollIntervalMs)),
            spawnErrorSignal
        ]);
    }

    return describeFleetBridgeState({
        port       : resolvedPort,
        probe      : lastProbe,
        publicKeySha256,
        pid,
        logFilePath: resolvedLogFilePath,
        spawnFailure
    });
}
