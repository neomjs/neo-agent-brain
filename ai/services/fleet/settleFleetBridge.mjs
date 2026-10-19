import {spawn}               from 'node:child_process';
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
 * @summary Maps a Bridge verifier probe outcome to one named Fleet boot state and its operator next step.
 * @param {Object} params
 * @param {Number} params.port Neural Link Bridge WebSocket port.
 * @param {{verdict: 'proved'|'refused'|'unanswered', reason?: String}} params.probe Probe outcome.
 * @param {'adopted'|'started'|null} [params.action=null] How a ready Bridge was settled.
 * @param {String|null} [params.publicKeySha256=null] Expected registry key SHA-256 hex digest.
 * @param {Number|null} [params.pid=null] Spawned Bridge process id when started by Fleet.
 * @returns {{state: String, verdict: String, action: String|null, port: Number, publicKeySha256: String|null, pid: Number|null, reason: String|null, summary: String|null, nextStep: String|null}}
 */
export function describeFleetBridgeState({
    port,
    probe,
    action          = null,
    publicKeySha256 = null,
    pid             = null
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
            reason         : 'bridge-verifier-unsupported',
            summary        : `An older Neural Link Bridge on port ${resolvedPort} predates verifier support.`,
            nextStep       : `Stop or refresh the Neural Link Bridge on port ${resolvedPort} (or restart the host-edge service), then restart Fleet so it can start a keyed Bridge.`
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
            reason,
            summary        : `The Neural Link Bridge on port ${resolvedPort} is unkeyed or keyed to another Fleet registry.`,
            nextStep       : `Stop the Neural Link Bridge on port ${resolvedPort} so Fleet can start one keyed to this registry, then reconnect the seat.`
        };
    }

    return {
        state          : FLEET_BRIDGE_STATES.UNAVAILABLE,
        verdict        : 'unanswered',
        action         : null,
        port           : resolvedPort,
        publicKeySha256: publicKeySha256 ?? null,
        pid            : pid ?? null,
        reason         : 'bridge-verifier-unavailable',
        summary        : `No Neural Link Bridge answered the verifier check on port ${resolvedPort}.`,
        nextStep       : `Check that port ${resolvedPort} is free and restart Fleet to start the Neural Link Bridge.`
    };
}

/**
 * @summary Settles the Neural Link Bridge at Fleet boot using the registry's signing custody.
 * @param {Object} [options={}]
 * @param {Number} options.port Neural Link Bridge WebSocket port.
 * @param {Object} [options.registry=FleetRegistryService] Fleet registry holding `signing.key` custody.
 * @param {Function} [options.probeFn=probeBridgeVerifier] Verifier probe function.
 * @param {Function} [options.spawnFn=spawn] Child process spawner for detached Bridge supervision.
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
        authority       = registry.getBridgeSigningAuthority(),
        publicKeySha256 = authority.publicKeySha256,
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
    const child = spawnFn(nodeBin, [bridgeScriptPath], {
        detached: true,
        stdio   : 'ignore',
        env     : childEnv
    });
    child?.unref?.();

    const
        pid      = child?.pid ?? null,
        deadline = Date.now() + Math.max(probeTimeoutMs, startupTimeoutMs);
    let lastProbe = initialProbe;

    while (Date.now() <= deadline) {
        lastProbe = await probeFn({
            port     : resolvedPort,
            publicKeySha256,
            timeoutMs: probeTimeoutMs
        });

        if (lastProbe?.verdict === 'proved') {
            return describeFleetBridgeState({
                port  : resolvedPort,
                probe : lastProbe,
                action: 'started',
                publicKeySha256,
                pid
            });
        }

        if (lastProbe?.verdict === 'refused') {
            return describeFleetBridgeState({
                port : resolvedPort,
                probe: lastProbe,
                publicKeySha256
            });
        }

        if (Date.now() + pollIntervalMs > deadline) {
            break;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return describeFleetBridgeState({
        port : resolvedPort,
        probe: lastProbe,
        publicKeySha256,
        pid
    });
}
