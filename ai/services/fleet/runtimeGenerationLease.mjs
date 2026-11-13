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
 * @summary How long a seat Start waits for the lease itself before refusing. A healthy retirement pass
 * holds it for seconds (a payload verify takes about 6 s, a census at most 10 s). The wait begins after
 * repository preparation and dependency installation, so the cockpit's 30 s round trip shows the
 * refusal only when those finished within about 10 s; otherwise the Start still ends at the bound.
 */
export const RUNTIME_REFERENCE_START_WAIT_MS = 20000;

/**
 * @summary A bounded wait's refusal. It names the holder, so the seat row says who keeps the lease and
 * since when, never its owner token.
 */
export class RuntimeReferencesHeldError extends Error {
    constructor({holder, waitedMs}) {
        super(`Runtime reference lease held by ${holder.owner} pid ${holder.pid} since ${holder.startedAt} ` +
            `(last progress ${holder.lastPulse}); waited ${waitedMs} ms.`);
        this.name     = 'RuntimeReferencesHeldError';
        this.code     = 'RUNTIME_REFERENCES_HELD';
        this.holder   = {owner: holder.owner, pid: holder.pid, startedAt: holder.startedAt, lastPulse: holder.lastPulse};
        this.waitedMs = waitedMs;
    }
}

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
 * @param {Number|null} [options.deadlineMs=null] Longest wait on a live holder; `null` waits until release or abort.
 * @returns {Promise<{assertCurrent: Function, release: Function}>} The caller owns release.
 * @throws {RuntimeReferencesHeldError} When the holder still holds the lease at the deadline.
 */
export async function waitForRuntimeGenerationReferences({signal, deadlineMs = null, ...options} = {}) {
    const startedAt = Date.now();
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
            const waitedMs = Date.now() - startedAt;
            if (deadlineMs !== null && waitedMs >= deadlineMs) throw new RuntimeReferencesHeldError({holder: error.holder, waitedMs});
            await delay(25, undefined, {signal});
        }
    }
}
