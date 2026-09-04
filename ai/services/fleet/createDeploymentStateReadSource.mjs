import {readFile, stat}                 from 'node:fs/promises';
import {projectDeploymentStateForFleet} from './projectDeploymentStateForFleet.mjs';

/**
 * @module ai/services/fleet/createDeploymentStateReadSource
 * @summary The fleet-server-side READER half of the deployment-state surface: the orchestrator writes its
 * bounded deployment-state snapshot to `AiConfig.orchestrator.deploymentStateBridge.snapshotPath`
 * (`DeploymentStateBridgeService#writeSnapshotIfDue`, atomic) for the KB/MC read tools; this factory builds
 * the read-source `FleetControlBridge.deploymentStateSource` expects — an object exposing
 * `produceDeploymentState()` that reads that file and returns the **projection** the cockpit renders
 * (`projectDeploymentStateForFleet`), never the raw file. Sibling of `createBootIdentityReadSource`: the
 * same cross-process shape (the fleet server and the orchestrator are separate processes in the dev
 * path), the same fail-soft contract — an absent, oversized or unreadable file is an honest `unavailable`
 * with a named reason, never a fabricated plane. READ-ONLY, observe-only: no actuator rides this source.
 */

/**
 * The closed set of reasons an `unavailable` projection can carry from this reader. The cockpit renders
 * them as one reason line for the whole view; a producer-side reason (an unwired seam) comes from the
 * bridge, not from here.
 * @type {Object}
 */
export const DEPLOYMENT_STATE_READ_REASONS = Object.freeze({
    absent    : 'no-deployment-state-snapshot',
    tooLarge  : 'snapshot-too-large',
    unreadable: 'snapshot-unreadable'
});

/**
 * @summary Read the snapshot file, byte-bound, and hand back the parsed snapshot with the file's own
 * modification time — the freshness clock the projection ages against. Never throws on the control-plane
 * path: every failure class is a named reason the caller projects as `unavailable`.
 * @param {Object} options
 * @param {String} options.path      The resolved `snapshotPath` leaf value.
 * @param {Number} options.maxBytes  The resolved `maxSnapshotBytes` leaf value; a larger file is refused unparsed.
 * @returns {Promise<{snapshot: Object, mtimeMs: Number}|{reason: String}>}
 */
export async function readDeploymentStateSnapshotFile({path, maxBytes}) {
    let text, mtimeMs;

    try {
        const stats = await stat(path);

        if (Number.isFinite(maxBytes) && stats.size > maxBytes) {
            return {reason: DEPLOYMENT_STATE_READ_REASONS.tooLarge};
        }

        mtimeMs = stats.mtimeMs;
        text    = await readFile(path, 'utf8');
    } catch (error) {
        return {reason: DEPLOYMENT_STATE_READ_REASONS.absent}; // ENOENT / unreadable path → absent, never a throw
    }

    try {
        const snapshot = JSON.parse(text);

        return snapshot && typeof snapshot === 'object'
            ? {snapshot, mtimeMs}
            : {reason: DEPLOYMENT_STATE_READ_REASONS.unreadable};
    } catch (error) {
        return {reason: DEPLOYMENT_STATE_READ_REASONS.unreadable}; // corrupt JSON → unreadable
    }
}

/**
 * @summary Build a deployment-state read-source over the orchestrator's snapshot file.
 * @param {Object}   options
 * @param {String}   options.path          The resolved `snapshotPath` leaf value.
 * @param {Number}   options.staleAfterMs  The resolved `staleAfterMs` leaf value: older than this reads `stale`.
 * @param {Number}   options.maxBytes      The resolved `maxSnapshotBytes` leaf value.
 * @param {Function} [options.readImpl=readDeploymentStateSnapshotFile] The file reader seam (injected in specs).
 * @param {Function} [options.now=Date.now] The clock the age is measured on (injected in specs).
 * @returns {{produceDeploymentState: Function}} the read-source `FleetControlBridge.deploymentStateSource` expects.
 */
export function createDeploymentStateReadSource({path, staleAfterMs, maxBytes, readImpl = readDeploymentStateSnapshotFile, now = Date.now} = {}) {
    return {
        async produceDeploymentState() {
            const read = await readImpl({path, maxBytes});

            if (!read || read.reason || !read.snapshot) {
                return projectDeploymentStateForFleet(null, {reason: read?.reason || DEPLOYMENT_STATE_READ_REASONS.unreadable});
            }

            return projectDeploymentStateForFleet(read.snapshot, {
                ageMs: Math.max(0, now() - read.mtimeMs),
                staleAfterMs
            });
        }
    };
}
