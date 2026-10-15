import {setTimeout as delay}               from 'node:timers/promises';
import {FileLeaseHeldError, holdFileLease} from '../../daemons/shared/fileLease.mjs';

/**
 * @module ai/services/fleet/runtimeGenerationLease
 * @summary Serializes new runtime references with host retirement through the existing file lease.
 * The lease carries no reference count or retention authority. The lifecycle/admission records and
 * the host's package/process observations still decide whether any generation is unused.
 */
export const RUNTIME_REFERENCE_LEASE = '.runtime-references.lock';
const heldDirectories = new WeakMap();

/**
 * @summary Acquires exclusion in the verified generation parent, refusing unknown custody or holders.
 * @param {Object} options The existing holdFileLease filesystem and ownership seams.
 * @param {String} options.directory Canonical protected runtime-generation parent.
 * @returns {{assertCurrent: Function, release: Function}} Release must be observed in a finally block.
 */
export function holdRuntimeGenerationReferences({directory, fileSystem, acquireLease, uid} = {}) {
    const guard = holdFileLease({directory, filename: RUNTIME_REFERENCE_LEASE, owner: 'fleet-runtime-references',
        fileSystem, acquireLease, uid});
    heldDirectories.set(guard, directory);
    return Object.freeze(guard);
}

/**
 * @summary Refuses an unguarded or differently rooted acquisition, including direct lifecycle callers.
 * @param {Object} guard Capability returned by this process's runtime-reference owner.
 * @param {String} directory The exact generation parent being referenced.
 */
export function assertRuntimeGenerationReferences(guard, directory) {
    if (!guard || heldDirectories.get(guard) !== directory) {
        throw new Error('Runtime reference acquisition refused: the generation parent is not guarded.');
    }
    guard.assertCurrent();
}

/**
 * @summary Lets an existing cancelable Start wait for known contention without creating a retry obligation.
 * Corrupt/unknown holders and lost custody refuse immediately; only a positively identified holder
 * is waited on. Stop cancels the wait through the same signal that owns the pending Start.
 * @param {Object} options Same ownership seams as holdRuntimeGenerationReferences.
 * @param {AbortSignal} [options.signal] Existing managed Start or host lifecycle cancellation.
 * @returns {Promise<{assertCurrent: Function, release: Function}>} The caller owns release.
 */
export async function waitForRuntimeGenerationReferences({signal, ...options} = {}) {
    while (true) {
        signal?.throwIfAborted();
        try {
            const guard = holdRuntimeGenerationReferences(options);
            try {
                signal?.throwIfAborted();
                return guard;
            } catch (error) {
                guard.release();
                throw error;
            }
        } catch (error) {
            if (!(error instanceof FileLeaseHeldError) || !error.holder) throw error;
            await delay(25, undefined, {signal});
        }
    }
}
