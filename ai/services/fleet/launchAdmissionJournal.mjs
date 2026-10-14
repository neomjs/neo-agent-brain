import {randomUUID}          from 'node:crypto';
import fs                    from 'fs-extra';
import path                  from 'node:path';
import {acquireFileLease}    from '../../daemons/shared/fileLease.mjs';
import {writeFileAtomicSync} from '../shared/atomicFileWrite.mjs';

/**
 * @module ai/services/fleet/launchAdmissionJournal
 * @summary Serializes durable issuer transitions under the existing exclusive file lease.
 * The separate fence consumes a clean handoff before the next issuer can mutate authority.
 * An active record after a crash, or an older record replayed against a newer fence, recovers nothing.
 * The issuer supplies the closed non-secret snapshot schema; this module owns publication, not grants.
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
    if (fileSystem.realpathSync(directory) !== path.resolve(directory)) throw refused('directory-custody');
    const directoryStat = fileSystem.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.uid !== uid || directoryStat.mode & 0o022) throw refused('directory-custody');

    const lease = acquireLease({
        dir: directory, filename: 'issuer.lock', owner: 'fleet-launch-admission',
        fs : fileSystem, isHeldFresh, onCorrupt: 'refuse'
    });
    const statePath = path.join(directory, 'issuer.json'), fencePath = path.join(directory, 'fence.json');
    let   closed    = false, failed = false, state;

    /** @summary Reads one owner-only record without following a substituted symlink. */
    function read(file) {
        let descriptor;
        try {
            descriptor = fileSystem.openSync(file, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW);
            const before = fileSystem.fstatSync(descriptor, {bigint: true});
            if (!before.isFile() || before.uid !== BigInt(uid) || (before.mode & 0o7777n) !== 0o600n ||
                before.size > BigInt(MAX_BYTES)) throw refused('record-custody');
            const buffer = Buffer.alloc(Number(before.size) + 1);
            let   offset = 0;
            while (offset < buffer.length) {
                const read = fileSystem.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
                if (!read) break;
                offset += read;
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
        const previous   = read(statePath), fence = read(fencePath);
        const validFence = fence && fence.version === VERSION && isId(fence.issuer) && Number.isSafeInteger(fence.epoch) && fence.epoch > 0;
        const validState = previous && previous.version === VERSION && isId(previous.issuer) &&
            Number.isSafeInteger(previous.epoch) && previous.epoch > 0 &&
            ['active', 'handoff'].includes(previous.phase) && validateSnapshot(previous.snapshot) === true &&
            (previous.origin === null || isOrigin(previous.origin)) &&
            (previous.phase === 'active' ? previous.handoff === null : isId(previous.handoff));
        if ((previous && !validState) || (fence && !validFence) || Boolean(previous) !== Boolean(fence)) throw refused('record-invalid');

        const sameEpoch = validState && validFence && previous.issuer === fence.issuer && previous.epoch === fence.epoch;
        const recovery  = sameEpoch && previous.phase === 'handoff';
        const epoch     = Math.max(previous?.epoch ?? 0, fence?.epoch ?? 0) + 1;
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
            previous: previous ? {handoffProved: Boolean(recovery), reason: recovery ? null : sameEpoch ? 'unclean-issuer-exit' : 'handoff-replayed', origin: previous.origin, snapshot: previous.snapshot} : null,
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
             */
            handoff(snapshot, origin = state.origin) {
                if (!isOrigin(origin) || validateSnapshot(snapshot) !== true) throw refused('handoff-incomplete');
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
