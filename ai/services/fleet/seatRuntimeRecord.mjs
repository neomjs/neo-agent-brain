import {createHash}                                   from 'node:crypto';
import path                                           from 'node:path';
import {canonicalJson, isLaunchIdentity}              from './mcpLaunchAdmission.mjs';
import {isRuntimeGenerationPin, runtimeGenerationPin} from './runtimeGeneration.mjs';

/**
 * @module ai/services/fleet/seatRuntimeRecord
 * @summary The closed original process/runtime binding stored with the existing Fleet journal.
 * Only an actual prepared Start creates it. A lease observation cannot create or repair one.
 * This record retains code and corroborates a Start; admission recovery also needs positive issuer
 * succession, profile custody and the original input owners. It contains no environment or credential.
 */
const keys = ['version', 'agentId', 'identity', 'harnessType', 'pid', 'pidStartedAt', 'startedAt',
    'cwd', 'instanceHome', 'launchCommand', 'launchInterpreter', 'profileArg', 'leaseRequired',
    'runtime', 'planSha256', 'profile', 'admissionGeneration'];
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(',');
const text     = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const absolute = value => text(value) && path.isAbsolute(value) && path.resolve(value) === value;
const hash     = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const optional = (value, check) => value === null || check(value);

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
    return exact(value, keys) && value.version === 1 && text(value.agentId) && isLaunchIdentity(value.identity) &&
        text(value.harnessType) && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        optional(value.pidStartedAt, text) && text(value.startedAt) && Number.isFinite(Date.parse(value.startedAt)) &&
        [value.cwd, value.instanceHome, value.launchCommand].every(absolute) &&
        optional(value.launchInterpreter, text) && optional(value.profileArg, text) &&
        typeof value.leaseRequired === 'boolean' && (!value.leaseRequired || text(value.pidStartedAt)) &&
        isRuntimeGenerationPin(value.runtime) && hash(value.planSha256) &&
        optional(value.admissionGeneration, text) && optional(value.profile, isProfileBinding) &&
        (!value.profile || value.profile.identity === value.identity) &&
        (value.harnessType !== 'claude-desktop' || value.profile !== null && value.admissionGeneration !== null)
}

/**
 * @summary Captures only named process facts and hashes from the Start that prepared this runtime.
 * @param {Object} options
 * @param {Object} options.record The lifecycle's fresh process record, after any required lease commit.
 * @param {String} options.identity Validated forge identity actually injected into this Start.
 * @param {Object[]} options.plan The exact prepared plan; only its canonical digest persists here.
 * @param {Object|null} [options.profile=null] Preparation's non-secret Desktop profile binding.
 * @param {Boolean} options.leaseRequired Whether this harness survives Fleet exit.
 * @returns {Object} A detached binding; never a secret-bearing lifecycle-record copy.
 */
export function createSeatRuntimeRecord({record, identity, plan, profile = null, leaseRequired}) {
    if (!Array.isArray(plan)) throw new Error('Original runtime Start requires its prepared plan.');
    const value = {
        version          : 1, agentId: record.id, identity, harnessType: record.harnessType,
        pid              : record.pid, pidStartedAt: record.pidStartedAt ?? null, startedAt: record.startedAt,
        cwd              : record.cwd, instanceHome: record.instanceHome, launchCommand: record.launchCommand,
        launchInterpreter: record.launchInterpreter ?? null, profileArg: record.profileArg ?? null,
        leaseRequired, runtime: runtimeGenerationPin(record.runtimeGeneration),
        planSha256         : createHash('sha256').update(canonicalJson(plan)).digest('hex'),
        profile            : profile === null ? null : structuredClone(profile),
        admissionGeneration: record.admissionGeneration ?? null
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
