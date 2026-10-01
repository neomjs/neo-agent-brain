import {supportsTenantMcpTarget}                       from '../../../src/fleet/contract/harnessTypes.mjs';
import {normalizeSecureMcpEndpoint, planeMcpResources} from './mcpWireParsing.mjs';

/**
 * @module ai/services/fleet/resolveSeatPlaneTarget
 * @summary Where a seat's Memory Core and Knowledge Base live, decided at each start. A seat writes its
 * memories where its peers read them, on the plane the Fleet serves, never into a private per-seat store
 * that silently forks the team's memory.
 *
 * - A seat bound to a connected tenant keeps that tenant.
 * - Any other seat on a Fleet that serves a plane (`fleet.planeBase`) reaches that plane's MC and KB.
 * - A Fleet that serves no plane keeps the per-seat store, the one named exception: own mode serves no
 *   MC or KB endpoint yet.
 * - A seat that cannot reach the plane refuses to start rather than fall back to a private store: a
 *   declared plane that is not a secure MCP endpoint, or a harness with no remote Memory Core.
 */

/**
 * @summary Resolves one seat's MC/KB target from its registry row and the plane the Fleet serves.
 * @param {Object} options
 * @param {Object|null} options.target The row's `mcpTarget`: `null`, or `{kind: 'tenant', tenantId}`.
 * @param {String} options.harnessType
 * @param {String} [options.planeBase] The plane the Fleet serves, as its entrypoint resolved it.
 * @returns {Object} `{kind: 'tenant', tenantId}`, `{kind: 'plane', endpoint, resources}`,
 *     `{kind: 'resident', reason}` or `{kind: 'refused', reason}`.
 */
export function resolveSeatPlaneTarget({target, harnessType, planeBase}) {
    if (target?.kind === 'tenant') {
        return {kind: 'tenant', tenantId: target.tenantId}
    }

    if (!planeBase) {
        return {kind: 'resident', reason: 'the Fleet serves no plane, and own mode serves no Memory Core or Knowledge Base endpoint yet'}
    }

    const endpoint = normalizeSecureMcpEndpoint(planeBase);

    if (!endpoint) {
        return {kind: 'refused', reason: 'fleet.planeBase is not a secure MCP endpoint, and a private per-seat store is no fallback'}
    }

    if (!supportsTenantMcpTarget(harnessType)) {
        return {kind: 'refused', reason: `${harnessType} cannot reach a remote Memory Core, and on a Fleet that serves a plane a private per-seat store would write memories no peer reads`}
    }

    return {kind: 'plane', endpoint, resources: planeMcpResources(endpoint)}
}

export default resolveSeatPlaneTarget;
