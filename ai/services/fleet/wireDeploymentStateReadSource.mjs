import FleetControlBridge                from './FleetControlBridge.mjs';
import {createDeploymentStateReadSource} from './createDeploymentStateReadSource.mjs';

/**
 * @module ai/services/fleet/wireDeploymentStateReadSource
 * @summary Injects the cross-process deployment-state READER into `FleetControlBridge.deploymentStateSource`
 * at the fleet-bridge-server boot, so `fleetDeploymentState()` serves the orchestrator's bounded snapshot
 * (written to the shared plane path by the orchestrator process) instead of the honest `unavailable`
 * fallback. Sibling of `wireBootIdentityReadSource`: the composition point the read-observe seam assumes,
 * supplied here from the resolved leaves rather than injected in-process.
 *
 * **Read-at-use-site.** The caller (the fleet-server process entry) reads
 * `AiConfig.orchestrator.deploymentStateBridge.{snapshotPath, staleAfterMs, maxSnapshotBytes}` at the boot
 * call and passes them in; this function owns no config default and captures no leaf. **Fail-soft:** an
 * absent/empty path leaves `deploymentStateSource` unwired (the seam keeps its honest `unavailable`), never a
 * fabricated source.
 */

/**
 * @summary Wire the deployment-state read-source onto the fleet control bridge.
 * @param {Object}   options
 * @param {String}   options.path                The resolved snapshot path (read from the leaf at the caller's boot use site).
 * @param {Number}   options.staleAfterMs        The resolved staleness horizon, forwarded to the read-source.
 * @param {Number}   options.maxBytes            The resolved byte bound, forwarded to the read-source.
 * @param {Object}   [options.bridge=FleetControlBridge] The control bridge to wire (a stub in specs).
 * @param {Function} [options.createSource=createDeploymentStateReadSource] The read-source factory (injected in specs).
 * @returns {Object|null} the wired read-source, or `null` when no path was supplied (left unwired).
 */
export function wireDeploymentStateReadSource({path, staleAfterMs, maxBytes, bridge = FleetControlBridge, createSource = createDeploymentStateReadSource} = {}) {
    if (typeof path !== 'string' || path.length === 0) {
        return null; // no path → leave the seam unwired (honest unavailable), never fabricate a source
    }

    bridge.deploymentStateSource = createSource({path, staleAfterMs, maxBytes});

    return bridge.deploymentStateSource;
}
