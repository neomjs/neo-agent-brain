import {createHash}                                                  from 'node:crypto';
import path                                                          from 'node:path';
import {canonicalJson, isAdmissibleEnvName, isLaunchIdentity}        from './mcpLaunchAdmission.mjs';
import {isRuntimeGenerationPin, runtimeGenerationPin}                from './runtimeGeneration.mjs';
import {launchRowEnvNames, MANAGED_WORKSPACE_MCP_SERVER_DESCRIPTORS} from './managedAgentWorkspacePlan.mjs';

/**
 * @module ai/services/fleet/seatRuntimeRecord
 * @summary The closed original process/runtime binding stored with the existing Fleet journal.
 * Only an actual prepared Start creates it. A lease observation cannot create or repair one.
 * This record retains code and corroborates a Start; admission recovery also needs positive issuer
 * succession, profile custody and the original input owners. It contains no environment or credential.
 */
const keys = ['version', 'agentId', 'identity', 'harnessType', 'pid', 'pidStartedAt', 'startedAt',
    'cwd', 'instanceHome', 'launchCommand', 'launchInterpreter', 'profileArg', 'leaseRequired',
    'runtime', 'planSha256', 'profile', 'admissionGeneration', 'bridgeAuthority', 'targets'];
const exact = (value, names) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(','));
const text              = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const absolute          = value => text(value) && path.isAbsolute(value) && path.resolve(value) === value;
const hash              = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const optional          = (value, check) => value === null || check(value);
const BRIDGE_ENTRYPOINT = 'ai/mcp/client/stdioToStreamableHttp.mjs';

/** @summary Admit only target URLs that carry no embedded authentication or query/fragment payload. */
function isTargetUrl(value) {
    try {
        const url = new URL(value);
        return text(value) && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false }
}

/** @summary Validate a fixed target against the original runtime and the supported launch protocol. */
function isTarget(value, runtime) {
    if (!exact(value, ['key', 'target', 'args', 'slots']) ||
        !Object.hasOwn(MANAGED_WORKSPACE_MCP_SERVER_DESCRIPTORS, value.key) ||
        !['resident', 'tenant'].includes(value.target) || !Array.isArray(value.args) || !value.args.every(text) ||
        !Array.isArray(value.slots) || new Set(value.slots.map(slot => slot?.name)).size !== value.slots.length ||
        !value.slots.every(slot => exact(slot, ['name', 'required', 'state']) && isAdmissibleEnvName(slot.name) &&
            typeof slot.required === 'boolean' && ['owner', 'held', 'absent'].includes(slot.state))) return false;
    if (value.target === 'tenant') {
        return ['memory-core', 'knowledge-base'].includes(value.key) && value.args.length === 5 &&
            value.args[0] === path.join(runtime.runtimeRoot, BRIDGE_ENTRYPOINT) && value.args[1] === '--url' &&
            isTargetUrl(value.args[2]) && value.args[3] === '--token-env' && isAdmissibleEnvName(value.args[4]) &&
            value.slots.length === 1 && value.slots[0].name === value.args[4] && value.slots[0].required;
    }
    const expected = [path.join(runtime.runtimeRoot, MANAGED_WORKSPACE_MCP_SERVER_DESCRIPTORS[value.key].entrypoint),
        ...(value.key === 'neural-link' ? ['--cwd', runtime.runtimeRoot] : [])];
    return canonicalJson(value.args) === canonicalJson(expected);
}

/**
 * @summary Capture enabled fixed targets and input presence without copying any environment values.
 * `held` records presence only, not recoverability: reconstruction still needs its original source.
 * @param {Object[]} plan Exact prepared rows.
 * @param {Object} env The transient environment of this Start.
 * @param {Object} owners Existing credential callbacks keyed by their concrete environment slots.
 * @param {Object} runtime The original runtime pin.
 * @returns {Object[]} Closed target metadata; optional absence remains explicit.
 */
function captureTargets(plan, env, owners, runtime) {
    return plan.filter(row => row.enabled).map(row => {
        if (row.command !== runtime.executable || row.sourceRoot !== runtime.runtimeRoot) {
            throw new Error('Original Start target does not bind its runtime.');
        }
        const names = launchRowEnvNames(row), value = {
            key : row.key, target: row.target,
            args: row.target === 'tenant'
                ? [path.join(row.sourceRoot, BRIDGE_ENTRYPOINT), '--url', row.url, '--token-env', row.credentialEnvVar]
                : [...row.args],
            slots: names.redeemed.map(name => ({name, required: names.required.includes(name),
                state: typeof owners[name]?.resolve === 'function' && typeof owners[name].prove === 'function'
                    ? 'owner' : typeof env[name] === 'string' ? 'held' : 'absent'}))
        };
        if (!isTarget(value, runtime)) throw new Error('Original Start target metadata is invalid.');
        return value;
    });
}

/** @summary Validate only the original public signer binding; never accept a key or token in the record. */
export function isBridgeSigningAuthority(value) {
    return exact(value, ['version', 'source', 'registryRoot', 'publicKeySha256']) && value.version === 1 &&
        ['config', 'registry-file'].includes(value.source) && absolute(value.registryRoot) && hash(value.publicKeySha256);
}

/** @summary Checks only the non-secret owned-profile binding; file custody remains the profile reader's job. */
function isProfileBinding(value) {
    return exact(value, ['version', 'identity', 'issuer', 'projectionSha256', 'grants']) && value.version === 1 &&
        isLaunchIdentity(value.identity) && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.issuer) &&
        Number(value.issuer.split(':').at(-1)) <= 65535 && hash(value.projectionSha256) &&
        value.grants && typeof value.grants === 'object' && !Array.isArray(value.grants) &&
        Object.entries(value.grants).every(([key, grant]) => /^[a-z][a-z0-9-]{0,63}$/.test(key) &&
            exact(grant, ['id', 'sha256']) && typeof grant.id === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(grant.id) && hash(grant.sha256))
}

/**
 * @summary Validates the closed persisted binding without inferring missing original facts.
 * @param {*} value
 * @returns {Boolean}
 */
export function isSeatRuntimeRecord(value) {
    return exact(value, keys) && value.version === 2 && text(value.agentId) && isLaunchIdentity(value.identity) &&
        text(value.harnessType) && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        optional(value.pidStartedAt, text) && text(value.startedAt) && Number.isFinite(Date.parse(value.startedAt)) &&
        [value.cwd, value.instanceHome, value.launchCommand].every(absolute) &&
        optional(value.launchInterpreter, text) && optional(value.profileArg, text) &&
        typeof value.leaseRequired === 'boolean' && (!value.leaseRequired || text(value.pidStartedAt)) &&
        isRuntimeGenerationPin(value.runtime) && hash(value.planSha256) && isBridgeSigningAuthority(value.bridgeAuthority) &&
        Array.isArray(value.targets) && value.targets.every(target => isTarget(target, value.runtime)) &&
        new Set(value.targets.map(target => target.key)).size === value.targets.length &&
        optional(value.admissionGeneration, text) && optional(value.profile, isProfileBinding) &&
        (!value.profile || value.profile.identity === value.identity) &&
        (value.harnessType !== 'claude-desktop' || value.profile !== null && value.admissionGeneration !== null)
}

/**
 * @summary Captures the original process, fixed targets, input-slot states and public signer binding.
 * @param {Object} options
 * @param {Object} options.record The lifecycle's fresh process record, after any required lease commit.
 * @param {String} options.identity Validated forge identity actually injected into this Start.
 * @param {Object[]} options.plan Exact prepared rows; persist the digest plus classified fixed-target metadata.
 * @param {Object} [options.env={}] Transient Start inputs; only slot presence is recorded.
 * @param {Object} [options.owners={}] Original credential callbacks, used only to classify owned slots.
 * @param {Object|null} [options.profile=null] Preparation's non-secret Desktop profile binding.
 * @param {Boolean} options.leaseRequired Whether this harness survives Fleet exit.
 * @returns {Object} A detached binding; never a secret-bearing lifecycle-record copy.
 */
export function createSeatRuntimeRecord({record, identity, plan, env = {}, owners = {}, profile = null, leaseRequired}) {
    if (!Array.isArray(plan)) throw new Error('Original runtime Start requires its prepared plan.');
    const runtime = runtimeGenerationPin(record.runtimeGeneration);
    const value   = {
        version          : 2, agentId: record.id, identity, harnessType: record.harnessType,
        pid              : record.pid, pidStartedAt: record.pidStartedAt ?? null, startedAt: record.startedAt,
        cwd              : record.cwd, instanceHome: record.instanceHome, launchCommand: record.launchCommand,
        launchInterpreter: record.launchInterpreter ?? null, profileArg: record.profileArg ?? null,
        leaseRequired, runtime,
        planSha256         : createHash('sha256').update(canonicalJson(plan)).digest('hex'),
        profile            : profile === null ? null : structuredClone(profile),
        admissionGeneration: record.admissionGeneration ?? null,
        bridgeAuthority    : structuredClone(record.bridgeAuthority),
        targets            : captureTargets(plan, env, owners, runtime)
    };
    if (!isSeatRuntimeRecord(value)) throw new Error('Original runtime Start binding is incomplete or invalid.');
    return value
}

/**
 * @summary Projects the existing lifecycle record's retention state without making another registry.
 * @param {Object} record
 * @returns {Object}
 */
export function seatRuntimeSnapshot(record) {
    return {start: structuredClone(record.runtimeStart), state: record.state,
        ownershipUnresolved: Boolean(record.ownershipUnresolved), cleanupUnresolved: Boolean(record.cleanupUnresolved)}
}

/** @summary Validates the closed mutable retention envelope around an immutable Start binding. */
export function isSeatRuntimeSnapshot(value) {
    return exact(value, ['start', 'state', 'ownershipUnresolved', 'cleanupUnresolved']) && isSeatRuntimeRecord(value.start) &&
        ['running', 'stopping', 'stopped', 'exited', 'failed', 'unavailable'].includes(value.state) &&
        typeof value.ownershipUnresolved === 'boolean' && typeof value.cleanupUnresolved === 'boolean'
}
