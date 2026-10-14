import {randomUUID}                                                             from 'node:crypto';
import fs                                                                       from 'fs-extra';
import path                                                                     from 'node:path';
import {acquireFileLease}                                                       from '../../daemons/shared/fileLease.mjs';
import {writeFileAtomicSync}                                                    from '../shared/atomicFileWrite.mjs';
import {LAUNCH_ADMISSION_REASONS as REASONS, LAUNCH_ADMISSION_STATES as STATES} from '../../../src/fleet/contract/launchAdmission.mjs';
import {isRuntimeGenerationPin}                                                 from './runtimeGeneration.mjs';
import {isSeatRuntimeSnapshot}                                                  from './seatRuntimeRecord.mjs';
import {isLaunchCredentialBinding, isResidentMcpBinding}                        from './launchCredentialOwners.mjs';
import {isAdmissibleEnvName, isLaunchIdentity}                                  from './mcpLaunchAdmission.mjs';

/**
 * @module ai/services/fleet/launchAdmissionJournal
 * @summary Serializes durable issuer transitions under the existing exclusive file lease.
 * The separate fence consumes a clean handoff before the next issuer can mutate authority.
 * An active record after a crash, or an older record replayed against a newer fence, recovers nothing.
 * The closed non-secret snapshot format is shared by the issuer and read-only consumers; this module
 * owns publication and inspection, never the grants or their recovery.
 */
const VERSION  = 1, MAX_BYTES = 8 * 1024 * 1024;
const isId     = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const isOrigin = value => typeof value === 'string' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) && Number(value.split(':').at(-1)) <= 65535;

/** @summary Creates a stable refusal without including record contents. */
function refused(reason) {
    return Object.assign(new Error(`Launch admission journal refused: ${reason}.`), {
        code: 'FLEET_ADMISSION_JOURNAL_REFUSED', reason
    })
}

/** @summary Treats every process observation except a definite absent PID as held. */
function isHeldFresh({holder}) {
    try { process.kill(holder.pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/** @summary Reads one owner-only record without following a substituted symlink. */
function readOwnedRecord(file, fileSystem, uid) {
    let descriptor;
    try {
        descriptor = fileSystem.openSync(file, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW);
        const before = fileSystem.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.uid !== BigInt(uid) || (before.mode & 0o7777n) !== 0o600n ||
            before.size > BigInt(MAX_BYTES)) throw refused('record-custody');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let   offset = 0;
        while (offset < buffer.length) {
            const count = fileSystem.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (!count) break;
            offset += count;
        }
        if (offset !== Number(before.size)) throw refused('record-changed');
        const source = buffer.subarray(0, offset).toString('utf8');
        const after  = fileSystem.fstatSync(descriptor, {bigint: true}), named = fileSystem.lstatSync(file, {bigint: true});
        for (const key of ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs']) {
            if (before[key] !== after[key] || after[key] !== named[key]) throw refused('record-changed');
        }
        return JSON.parse(source)
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error.code === 'FLEET_ADMISSION_JOURNAL_REFUSED' ? error : refused('record-unreadable')
    } finally {
        if (descriptor !== undefined) fileSystem.closeSync(descriptor)
    }
}

/** @summary Verifies the canonical directory without creating it or changing its permissions. */
function readDirectoryCustody(directory, fileSystem, uid) {
    const stat = fileSystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o022 ||
        fileSystem.realpathSync(directory) !== path.resolve(directory)) throw refused('directory-custody');
    return stat
}

/**
 * @summary Inspects the existing journal through its format owner, without acquiring or consuming authority.
 * A matched clean handoff is a point-in-time observation, not proof of surviving processes, runtime
 * integrity or current input owners. The lifecycle still proves those before issuing a new child.
 * @param {Object} options
 * @param {String} options.directory Canonical Fleet-owned custody directory.
 * @param {Function} [options.validateSnapshot=isAdmissionSnapshot] The issuer's closed non-secret snapshot codec.
 * @param {Object} [options.fileSystem=fs] Synchronous filesystem seam.
 * @param {Number} [options.uid=process.getuid()] Expected host owner.
 * @returns {Object|null} Validated state, fence and handoff observation; null only for absent records.
 */
export function readLaunchAdmissionJournal({directory, validateSnapshot = isAdmissionSnapshot, fileSystem = fs, uid = process.getuid?.()}) {
    if (!path.isAbsolute(directory || '') || !Number.isInteger(uid) || typeof validateSnapshot !== 'function') {
        throw refused('invalid-binding')
    }
    let before;
    try { before = readDirectoryCustody(directory, fileSystem, uid) } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error
    }
    const statePath  = path.join(directory, 'issuer.json'), fencePath = path.join(directory, 'fence.json');
    const fence      = readOwnedRecord(fencePath, fileSystem, uid), state = readOwnedRecord(statePath, fileSystem, uid);
    const finalFence = readOwnedRecord(fencePath, fileSystem, uid), after = readDirectoryCustody(directory, fileSystem, uid);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
        JSON.stringify(fence) !== JSON.stringify(finalFence)) throw refused('record-changed');
    const validFence = fence && fence.version === VERSION && isId(fence.issuer) && Number.isSafeInteger(fence.epoch) && fence.epoch > 0;
    const validState = state && state.version === VERSION && isId(state.issuer) &&
        Number.isSafeInteger(state.epoch) && state.epoch > 0 &&
        ['active', 'handoff'].includes(state.phase) && validateSnapshot(state.snapshot) === true &&
        (state.origin === null || isOrigin(state.origin)) &&
        (state.phase === 'active' ? state.handoff === null : isId(state.handoff));
    if ((state && !validState) || (fence && !validFence) || Boolean(state) !== Boolean(fence)) throw refused('record-invalid');
    if (!state) return null;
    const sameEpoch     = state.issuer === fence.issuer && state.epoch === fence.epoch;
    const handoffProved = sameEpoch && state.phase === 'handoff';
    return {state, fence, handoffProved, reason: handoffProved ? null : sameEpoch ? 'handoff-not-completed' : 'handoff-replayed'}
}

/**
 * @summary Validates the complete non-secret lifecycle snapshot without accepting extra fields.
 * @param {*} value Persisted snapshot from the journal; unknown versions and unclassified fields refuse.
 * @returns {Boolean} Whether the snapshot uses the issuer's current closed format.
 */
export function isAdmissionSnapshot(value) {
    const exact = (row, keys) => row && typeof row === 'object' && !Array.isArray(row) &&
        Object.keys(row).sort().join(',') === [...keys].sort().join(',');
    const hash      = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text);
    const text      = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
    const timestamp = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
    const unique    = (rows, key) => new Set(rows.map(row => row[key])).size === rows.length;
    const phase     = row => Object.values(STATES).includes(row.state) &&
        (row.reason === null || Object.values(REASONS).includes(row.reason));
    return exact(value, ['version', 'generations', 'seats']) && value.version === 6 && Array.isArray(value.generations) &&
        Array.isArray(value.seats) && value.seats.every(isSeatRuntimeSnapshot) &&
        new Set(value.seats.map(row => row.start.agentId)).size === value.seats.length &&
        value.generations.every(row => exact(row, [
            'id', 'agentId', 'identity', 'state', 'reason', 'reservedAt', 'activatedAt', 'revokedAt', 'definitionHash', 'runtime', 'credentialBindings', 'residentBindings', 'servers'
        ]) && text(row.id) && text(row.agentId) && isLaunchIdentity(row.identity) && phase(row) && hash(row.definitionHash) &&
            (row.runtime === null || isRuntimeGenerationPin(row.runtime)) &&
            row.credentialBindings && typeof row.credentialBindings === 'object' && !Array.isArray(row.credentialBindings) &&
            Object.entries(row.credentialBindings).every(([name, binding]) => isAdmissibleEnvName(name) &&
                isLaunchCredentialBinding(binding) && binding.agentId === row.agentId && binding.identity === row.identity) &&
            row.residentBindings && typeof row.residentBindings === 'object' && !Array.isArray(row.residentBindings) &&
            Object.entries(row.residentBindings).every(([key, source]) => exact(source, ['binding', 'names']) &&
                isResidentMcpBinding(source.binding) && source.binding.server === key && Array.isArray(source.names) &&
                source.names.every(isAdmissibleEnvName) && new Set(source.names).size === source.names.length) &&
            ['reservedAt', 'activatedAt', 'revokedAt'].every(key => timestamp(row[key])) && Array.isArray(row.servers) &&
            row.servers.every(server => exact(server, ['key', 'grantId', 'state', 'reason', 'capabilityHash']) &&
                text(server.key) && text(server.grantId) && phase(server) && hash(server.capabilityHash)) &&
            unique(row.servers, 'key') && unique(row.servers, 'grantId')) &&
        unique(value.generations, 'id') && unique(value.generations, 'agentId')
}

/**
 * @summary Opens one exclusively owned issuer journal and durably fences its predecessor.
 * Opening returns the previous snapshot as evidence, with recovery allowed only for a clean handoff.
 * The caller must still prove the original Start, profile, runtime, endpoint and input owners.
 * @param {Object} options
 * @param {String} options.directory Canonical Fleet-owned admission custody directory.
 * @param {Function} options.validateSnapshot Closed non-secret schema check supplied by the issuer.
 * @param {Object} options.emptySnapshot Initial snapshot in that same schema.
 * @param {Object} [options.fileSystem=fs] Synchronous fs-extra-compatible filesystem seam.
 * @param {Function} [options.acquireLease=acquireFileLease] Existing exclusive-lease primitive.
 * @param {Function} [options.writeAtomic=writeFileAtomicSync] Existing strict durable writer.
 * @param {Number} [options.uid=process.getuid()] Expected host owner.
 * @returns {Object} Previous evidence, guarded publication, handoff and close operations.
 */
export function openLaunchAdmissionJournal({
    directory, validateSnapshot, emptySnapshot, fileSystem = fs,
    acquireLease = acquireFileLease, writeAtomic = writeFileAtomicSync, uid = process.getuid?.()
}) {
    if (!path.isAbsolute(directory || '') || !Number.isInteger(uid) || typeof validateSnapshot !== 'function' ||
        validateSnapshot(emptySnapshot) !== true) throw refused('invalid-binding');
    const firstCreated = fileSystem.mkdirSync(directory, {recursive: true, mode: 0o700});
    // The lease needs its directory before the atomic writer runs, so flush the entries this
    // earlier mkdir created. Later strict file writes cannot discover those new ancestors.
    if (firstCreated) {
        const last = path.dirname(firstCreated);
        for (let current = directory; ; current = path.dirname(current)) {
            const descriptor = fileSystem.openSync(current, 'r');
            try { fileSystem.fsyncSync(descriptor) } finally { fileSystem.closeSync(descriptor) }
            if (current === last) break;
        }
    }
    const directoryStat = readDirectoryCustody(directory, fileSystem, uid);

    const lease = acquireLease({
        dir: directory, filename: 'issuer.lock', owner: 'fleet-launch-admission',
        fs : fileSystem, isHeldFresh, onCorrupt: 'refuse'
    });
    const statePath = path.join(directory, 'issuer.json'), fencePath = path.join(directory, 'fence.json');
    let   closed    = false, failed = false, state;

    /** @summary Revalidates exclusion and the custody directory before every synchronous transition. */
    function assertOwner() {
        if (closed || failed) throw refused(closed ? 'issuer-closed' : 'durability-failed');
        try {
            const current = fileSystem.lstatSync(directory), pulse = lease.pulse();
            if (current.dev !== directoryStat.dev || current.ino !== directoryStat.ino ||
                current.uid !== uid || current.mode & 0o022 || !pulse.held) throw refused('ownership-unproved');
        } catch {
            failed = true;
            throw refused('ownership-unproved')
        }
    }

    /** @summary A failed publication permanently excludes this issuer from completing a handoff. */
    function publish(file, value) {
        assertOwner();
        try {
            const source = JSON.stringify(value) + '\n';
            if (Buffer.byteLength(source) > MAX_BYTES) throw refused('record-too-large');
            writeAtomic(file, source, {fsModule: fileSystem, mode: 0o600, fsync: true});
        } catch {
            failed = true;
            throw refused('durability-failed')
        }
    }

    try {
        const observed = readLaunchAdmissionJournal({directory, validateSnapshot, fileSystem, uid});
        const previous = observed?.state ?? null, fence = observed?.fence ?? null;
        const recovery = observed?.handoffProved === true;
        const epoch    = Math.max(previous?.epoch ?? 0, fence?.epoch ?? 0) + 1;
        if (!Number.isSafeInteger(epoch)) throw refused('epoch-exhausted');
        state = {
            version: VERSION, issuer: randomUUID(), epoch, phase: 'active', handoff: null,
            origin : recovery ? previous.origin : null, snapshot: previous?.snapshot ?? emptySnapshot
        };
        // Keep retention and revocation evidence across a crash during recovery. The consumed fence
        // and active phase deny authority; retaining these bytes does not make the next exit clean.
        // Consume the predecessor's proof FIRST. A crash before the state write leaves a mismatch,
        // so a later issuer cannot treat the older handoff as still unconsumed.
        publish(fencePath, {version: VERSION, issuer: state.issuer, epoch});
        publish(statePath, state);

        return {
            previous: previous ? {handoffProved: recovery,
                reason: observed.reason === 'handoff-not-completed' ? 'unclean-issuer-exit' : observed.reason,
                origin: previous.origin, snapshot: previous.snapshot} : null,
            assertOwner,
            /** @summary Durably publishes the issuer's validated non-secret snapshot. */
            write(snapshot, origin = state.origin) {
                if (validateSnapshot(snapshot) !== true) throw refused('snapshot-invalid');
                if (origin !== null && !isOrigin(origin)) throw refused('origin-invalid');
                const next = {...state, snapshot, origin};
                publish(statePath, next);
                state = next;
            },
            /**
             * @summary Publishes a clean handoff only after the caller awaited endpoint release and
             * froze all authority mutations. No write is permitted after this terminal transition.
             * A null origin carries no endpoint; the admission consumer refuses active authority without one.
             */
            handoff(snapshot, origin = state.origin) {
                if (origin !== null && !isOrigin(origin) || validateSnapshot(snapshot) !== true) throw refused('handoff-incomplete');
                const next = {...state, snapshot, origin, phase: 'handoff', handoff: randomUUID()};
                publish(statePath, next);
                state = next;
                closed = true;
                lease.release();
            },
            /** @summary Releases exclusion without a handoff; the next issuer observes an unclean exit. */
            close() {
                if (!closed) {
                    closed = true;
                    lease.release();
                }
            }
        }
    } catch (error) {
        lease.release();
        throw error
    }
}
