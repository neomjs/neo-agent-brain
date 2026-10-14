import fs                                            from 'node:fs';
import path                                          from 'node:path';
import {isDeepStrictEqual}                           from 'node:util';
import {isAdmissibleEnvName, isLaunchIdentity}       from './mcpLaunchAdmission.mjs';
import {MCP_SERVERS}                                 from '../../../src/fleet/contract/mcpServers.mjs';
import {isOpaquePlaneId}                             from '../../planeConfig.mjs';
import {proveSeatForgeAccount}                       from './seatGitIdentity.mjs';
import {LAUNCH_ADMISSION_CREDENTIALS as CREDENTIALS} from '../../../src/fleet/contract/launchAdmission.mjs';

/**
 * @module ai/services/fleet/launchCredentialOwners
 * @summary Credential and resident-input owners shared by Start and admission recovery.
 * Bindings contain only source selection and identity. Values are read from their original stores,
 * and changed selection refuses redemption, including changes during an asynchronous proof.
 */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text  = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const plane = value => exact(value, ['id', 'dataRoot']) && text(value.id) && text(value.dataRoot);

/** @summary Closed selection for an existing resolved server config; exported values never belong here. */
export function isResidentMcpBinding(value) {
    if (!(exact(value, ['version', 'kind', 'server', 'plane', 'providers']) && value.version === 1 &&
        value.kind === 'resident-config' && MCP_SERVERS.some(row => row.key === value.server) && plane(value.plane) &&
        isOpaquePlaneId(value.plane.id) && path.isAbsolute(value.plane.dataRoot) &&
        exact(value.providers, ['model', 'embedding', 'ask']))) return false;
    const usesProvider = ['memory-core', 'knowledge-base'].includes(value.server);
    return Object.entries(value.providers).every(([key, provider]) =>
        (key === 'ask' ? value.server === 'knowledge-base' : usesProvider)
            ? ['gemini', 'openAiCompatible', 'ollama'].includes(provider) : provider === null);
}

/**
 * @summary Bind current exports to the original server/plane/provider selection and slot inventory.
 * The reader is the existing config owner. Values stay transient; newly present names are excluded.
 * @param {Object} options
 * @param {Object} options.binding Original classified metadata.
 * @param {String[]} options.names Names present in the original export.
 * @param {Function} options.read Returns `{binding, env}` from the resolved config export.
 * @returns {Object} Non-secret metadata and live read/match callbacks.
 */
export function createResidentMcpInputOwner({binding, names, read}) {
    if (!isResidentMcpBinding(binding) || !Array.isArray(names) || new Set(names).size !== names.length ||
        !names.every(isAdmissibleEnvName) || typeof read !== 'function') throw new Error('Resident MCP input binding is invalid.');
    const expected = structuredClone(binding), selected = [...names];
    Object.freeze(expected.plane); Object.freeze(expected.providers); Object.freeze(expected); Object.freeze(selected);
    const snapshot = () => {
        try {
            const current = read();
            if (!isResidentMcpBinding(current?.binding) || !isDeepStrictEqual(current.binding, expected) ||
                !current.env || typeof current.env !== 'object' || Array.isArray(current.env)) return null;
            return Object.fromEntries(selected.filter(name => Object.hasOwn(current.env, name) &&
                typeof current.env[name] === 'string').map(name => [name, current.env[name]]));
        } catch { return null }
    };
    return {binding: expected, names: selected, read: snapshot, matches: () => snapshot() !== null};
}

/** @summary Validate a non-secret endpoint without accepting URL-embedded credentials or query tokens. */
function endpoint(value) {
    try {
        const url = new URL(value);
        return text(value) && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false }
}

/** @summary Validate the closed credential-owner binding; an unproved tenant plane remains explicitly null. */
export function isLaunchCredentialBinding(value) {
    if (!value || value.version !== 1 || !text(value.storeRoot) || !path.isAbsolute(value.storeRoot) ||
        path.resolve(value.storeRoot) !== value.storeRoot || !text(value.agentId) || !isLaunchIdentity(value.identity)) return false;
    const common = ['version', 'kind', 'storeRoot', 'agentId', 'identity'];
    if (value.kind === 'seat-pat') {
        return exact(value, [...common, 'forge', 'forgeHost']) && ['github', 'gitlab'].includes(value.forge) &&
            (value.forge === 'github' ? value.forgeHost === null : endpoint(value.forgeHost) &&
                new URL(value.forgeHost).protocol === 'https:' && new URL(value.forgeHost).origin === value.forgeHost);
    }
    return ['tenant-bearer', 'seat-plane-bearer'].includes(value.kind) &&
        exact(value, [...common, 'endpoint', 'plane', ...(value.kind === 'tenant-bearer' ? ['tenantId'] : [])]) &&
        endpoint(value.endpoint) && (value.plane === null || plane(value.plane)) &&
        (value.kind !== 'tenant-bearer' || text(value.tenantId));
}

/** @summary The store owner resolves its own path; no config/env selection occurs in this helper. */
function storeRoot(service) { return fs.realpathSync(service.getDataDir()) }

/** @summary Detach and freeze the small public binding, including its plane identity. */
function freezeBinding(binding) {
    const value = structuredClone(binding);
    if (value.plane) Object.freeze(value.plane);
    return Object.freeze(value);
}

/** @summary Bind the existing owner callbacks to immutable source selection. */
function owner({binding, current, resolve, prove, credential}) {
    if (!isLaunchCredentialBinding(binding)) throw new Error('Launch credential owner binding is invalid.');
    const expected = freezeBinding(binding);
    const matches  = () => { try { return isDeepStrictEqual(current(), expected) } catch { return false } };
    return {
        credential, binding: expected, matches,
        resolve: () => matches() ? resolve() : null,
        async prove(value, options = {}) {
            if (!matches()) return {verdict: 'refused'};
            const result = await prove(value, options);
            return matches() ? result : {verdict: 'refused'};
        }
    };
}

/** @summary Project the registry identity/forge that owns the PAT, independently of commit-author declarations. */
function patBinding(registry, agent) {
    return {version: 1, kind: 'seat-pat', storeRoot: storeRoot(registry), agentId: agent.id,
        identity: agent.githubUsername?.trim().replace(/^@/, ''), forge: agent.forge ?? 'github', forgeHost: agent.forgeHost ?? null};
}

/**
 * @summary Select the registry PAT owner once; re-prove the same account for every admitted value.
 * @param {Object} options
 * @param {Object} options.registry
 * @param {Object} options.agent Original registry definition.
 * @param {Function} [options.proveForgeAccount] Existing account-proof seam.
 * @returns {Object} Live callbacks plus a closed non-secret binding.
 */
export function createSeatPatOwner({registry, agent, proveForgeAccount: prove = proveSeatForgeAccount}) {
    if (!agent) throw new Error('Launch credential owner binding is invalid.');
    const original = structuredClone(agent);
    return owner({
        credential: CREDENTIALS.SEAT_PAT, binding: patBinding(registry, original),
        current   : () => patBinding(registry, registry.getDefinition?.(original.id) ?? registry.getAgent(original.id)),
        resolve   : () => registry.resolveCredential(original.id),
        prove     : (credential, {signal} = {}) => prove({agent: original, credential, signal})
    });
}

/** @summary Whether the existing tenant readiness proves both resources and the literal seat identity. */
export function tenantProvesSeat(readiness, expectedIdentity) {
    return Boolean(readiness?.ok && readiness.resources?.['memory-core']?.ok &&
        readiness.resources['memory-core'].identity === expectedIdentity && readiness.resources?.['knowledge-base']?.ok);
}

/** @summary Extract only a matching served-plane pair from authenticated readiness. */
export function servedPlaneBinding(readiness) {
    const mc = readiness?.resources?.['memory-core']?.plane, kb = readiness?.resources?.['knowledge-base']?.plane;
    return plane(mc) && isDeepStrictEqual(mc, kb) ? {...mc} : null;
}

/**
 * @summary Select one explicit tenant bearer, endpoint and optionally proved plane; never substitute a seat PAT.
 * @param {Object} options Tenant service, original target and authenticated plane facts.
 * @returns {Object} Owner callbacks and binding. A null plane cannot authorize recovery.
 */
export function createTenantBearerOwner({tenantService, agentId, tenantId, endpoint: originalEndpoint, expectedIdentity, provenPlane = null}) {
    const binding = {version: 1, kind: 'tenant-bearer', storeRoot: storeRoot(tenantService), agentId,
        identity: expectedIdentity.replace(/^@/, ''), tenantId, endpoint: originalEndpoint, plane: provenPlane};
    return owner({
        credential: CREDENTIALS.PLANE_BEARER, binding,
        current   : () => ({...binding, storeRoot: storeRoot(tenantService), endpoint: tenantService.resolveMcpResources(tenantId)?.endpoint}),
        resolve   : () => tenantService.resolveMcpCredential(tenantId),
        prove     : async (credential, {signal} = {}) => {
            if (binding.plane) return tenantService.probeSeatPlaneCredential({planeBase: binding.endpoint, credential,
                expectedIdentity, expectedPlane: binding.plane, signal});
            const proof = await tenantService.probeSeatCredential({tenantId, credential, expectedIdentity, signal});
            return {verdict: proof?.verdict === 'unanswered' ? 'unanswered' : tenantProvesSeat(proof, expectedIdentity) ? 'proved' : 'refused'};
        }
    });
}

/**
 * @summary Select the original default-plane binding, including its authenticated plane identity.
 * @param {Object} options Tenant service, seat, original endpoint and proved plane.
 * @returns {Object} Owner callbacks and binding.
 */
export function createSeatPlaneOwner({tenantService, agentId, planeBase, expectedIdentity, provenPlane}) {
    const args    = {planeBase, agentId};
    const binding = {version: 1, kind: 'seat-plane-bearer', storeRoot: storeRoot(tenantService), agentId,
        identity: expectedIdentity.replace(/^@/, ''), endpoint: planeBase, plane: provenPlane};
    return owner({
        credential: CREDENTIALS.PLANE_BEARER, binding,
        current   : () => {
            const root = storeRoot(tenantService);
            return {...binding, storeRoot: root,
                plane: root === binding.storeRoot ? tenantService.resolveSeatPlaneCredential(args)?.plane : null};
        },
        resolve: () => tenantService.resolveSeatPlaneCredential(args)?.credential ?? null,
        prove  : (credential, {signal} = {}) => tenantService.probeSeatPlaneCredential({planeBase, credential,
            expectedIdentity, expectedPlane: binding.plane, signal})
    });
}

/**
 * @summary Reconstruct only the original credential owner from validated metadata and current stores.
 * No credential is retained by reconstruction; the default-plane selector reads its existing encrypted row.
 * Redemption resolves and proves its own value snapshot.
 * @param {Object} binding Original persisted binding.
 * @param {Object} services Existing registry/tenant services and optional account-proof seam.
 * @returns {Object} The same owner interface used at Start.
 */
export function restoreLaunchCredentialOwner(binding, {registry, tenantService, proveForgeAccount} = {}) {
    if (!isLaunchCredentialBinding(binding) || binding.kind !== 'seat-pat' && !binding.plane) {
        throw new Error('Original launch credential owner is incomplete.');
    }
    try {
        const restored = binding.kind === 'seat-pat'
            ? createSeatPatOwner({registry, agent: registry.getDefinition(binding.agentId), proveForgeAccount})
            : binding.kind === 'tenant-bearer'
                ? createTenantBearerOwner({tenantService, agentId: binding.agentId, tenantId: binding.tenantId,
                    endpoint: binding.endpoint, expectedIdentity: '@' + binding.identity, provenPlane: binding.plane})
                : createSeatPlaneOwner({tenantService, agentId: binding.agentId, planeBase: binding.endpoint,
                    expectedIdentity: '@' + binding.identity, provenPlane: binding.plane});
        if (!isDeepStrictEqual(restored.binding, binding) || !restored.matches()) throw Error();
        return restored;
    } catch {
        throw new Error('Original launch credential owner changed or is unavailable.');
    }
}
