/**
 * @module ai/daemons/wake/primarySessionWake
 * @summary Durable native wake binding, dispatch serialization and receipt reconciliation.
 */
import fs                from 'node:fs/promises';
import {randomUUID}      from 'node:crypto';
import {withOutboxLock}  from './outboxLock.mjs';
import {writeFileAtomic} from '../../services/shared/atomicFileWrite.mjs';

const UUID     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAT     = /^@[a-z0-9][a-z0-9-]*$/;
const FAMILIES = new Set(['codex-desktop', 'antigravity']);

/** @summary Reads the host-owned binding and outstanding ordinary/urgent delivery correlation slots. */
export async function readPrimarySessionWake({statePath}) {
    try {
        const stat = await fs.lstat(statePath);
        if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('primary wake state must be a private regular file');
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (!Number.isSafeInteger(state.version) || state.version < 1 || !('binding' in state) || !('inflight' in state)) {
            throw new Error('invalid primary wake state');
        }
        return 'urgentInflight' in state ? state : {...state, urgentInflight: null}
    } catch (error) {
        if (error.code === 'ENOENT') return {version: 0, binding: null, inflight: null, urgentInflight: null};
        throw error
    }
}

async function save(statePath, state) {
    await writeFileAtomic(statePath, JSON.stringify(state) + '\n', {mode: 0o600, fsync: true})
}

function validBinding({seat, generation, family, threadId}) {
    return SEAT.test(seat ?? '') && typeof generation === 'string' && generation.length > 0 &&
        FAMILIES.has(family) && UUID.test(threadId ?? '')
}

function matchesProof(binding, proof) {
    return proof?.root === true && proof.threadId === binding.threadId
}

async function retireRecordedSlot(statePath, state, slotKey, isRecordedDelivered) {
    const attempt = state[slotKey];
    if (attempt?.status !== 'delivered' || typeof isRecordedDelivered !== 'function') {
        return {state, retired: null, unrecorded: attempt?.status === 'delivered' ? attempt : null}
    }
    let recorded = false;
    try { recorded = await isRecordedDelivered(attempt.recordKey) === true } catch { /* retain receipt */ }
    if (!recorded) {
        return {state, retired: null, unrecorded: attempt}
    }
    const next = {...state, [slotKey]: null};
    await save(statePath, next);
    return {state: next, retired: attempt, unrecorded: null}
}

/**
 * @summary Binds an explicitly selected root under version CAS after the host proves its identity.
 * `proveTarget` is a host authority boundary, not an agent claim or a most-recent-thread heuristic.
 */
export async function bindPrimarySession({statePath, seat, generation, family, threadId, expectedVersion, proveTarget, isRecordedDelivered}) {
    const binding = {seat, generation, family, threadId};
    if (!validBinding(binding) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || typeof proveTarget !== 'function') {
        return {status: 'pending', reason: 'invalid binding'}
    }
    return withOutboxLock(statePath, async () => {
        let state = await readPrimarySessionWake({statePath});
        if (state.version !== expectedVersion) return {status: 'pending', reason: 'binding version changed', version: state.version};
        if (state.binding && state.binding.seat !== seat) return {status: 'pending', reason: 'seat mismatch', version: state.version};
        ({state} = await retireRecordedSlot(statePath, state, 'inflight', isRecordedDelivered));
        ({state} = await retireRecordedSlot(statePath, state, 'urgentInflight', isRecordedDelivered));
        if (state.inflight || state.urgentInflight) {
            return {status: 'unknown', reason: 'delivery unresolved', version: state.version}
        }
        let proof;
        try { proof = await proveTarget(binding) } catch { return {status: 'pending', reason: 'target proof unavailable', version: state.version} }
        if (!matchesProof(binding, proof)) return {status: 'pending', reason: 'target not proven', version: state.version};
        const next = {version: state.version + 1, binding, inflight: null, urgentInflight: null};
        await save(statePath, next);
        return {status: 'bound', version: next.version, binding}
    })
}

/** @summary Revokes the selected binding only after every prior effect is reconciled. */
export async function revokePrimarySession({statePath, seat, expectedVersion}) {
    return withOutboxLock(statePath, async () => {
        const state = await readPrimarySessionWake({statePath});
        if (state.version !== expectedVersion || state.binding?.seat !== seat) return {status: 'pending', reason: 'binding changed', version: state.version};
        if (state.inflight || state.urgentInflight) return {status: 'unknown', reason: 'delivery unresolved', version: state.version};
        const next = {version: state.version + 1, binding: null, inflight: null, urgentInflight: null};
        await save(statePath, next);
        return {status: 'revoked', version: next.version}
    })
}

function receiptMatches(receipt, binding, attempt) {
    return receipt?.seat === binding.seat && receipt.generation === binding.generation &&
        receipt.threadId === binding.threadId && receipt.recordKey === attempt.recordKey && receipt.nonce === attempt.nonce
}

function deliveredResult(attempt) {
    return {
        status: 'delivered',
        nonce : attempt.nonce,
        ...(typeof attempt.recipientObservedAt === 'string' ? {recipientObservedAt: attempt.recipientObservedAt} : {}),
        ...(attempt.acknowledged === false ? {acknowledged: false} : {})
    }
}

/**
 * @summary Serializes binding, durable admission, native effect and receipt reconciliation per seat.
 * Ordinary records use `inflight`; distinct urgent records use `urgentInflight` without evicting an
 * ambiguous ordinary attempt. Receiver record persistence owns long-term deduplication.
 * An `unacknowledged` receipt (the wake started a turn that ended without the hook redeeming it,
 * or an admitted Antigravity idle wake whose finished turn never echoed its private receipt)
 * settles the slot as delivered with `acknowledged: false`, so no later wake waits behind it.
 */
export async function deliverPrimarySessionWake({statePath, seat, generation, family, recordKey, urgent = false,
    readTarget, send, readReceipt, isRecordedDelivered}) {
    if (!/^[a-f0-9]{64}$/.test(recordKey ?? '') ||
        ![readTarget, send, readReceipt, isRecordedDelivered].every(fn => typeof fn === 'function')) {
        return {status: 'pending', reason: 'invalid delivery'}
    }
    // The effect mutex serializes send/reconcile callers without blocking the owner lock that
    // the recipient hook needs. A dead sender's mutex is reclaimed only after process death.
    return withOutboxLock(`${statePath}.effect`, async () => {
        const phase = await withOutboxLock(statePath, async () => {
            let   state     = await readPrimarySessionWake({statePath});
            const {binding} = state;
            if (!binding || binding.seat !== seat || binding.generation !== generation || binding.family !== family) {
                return {status: 'pending', reason: 'binding unavailable'}
            }

            const preferredSlot = urgent ? 'urgentInflight' : 'inflight',
                  otherSlot     = urgent ? 'inflight' : 'urgentInflight',
                  activeSlotKey = state[otherSlot]?.recordKey === recordKey ? otherSlot : preferredSlot;

            for (const slotKey of ['inflight', 'urgentInflight']) {
                const retiredCheck = await retireRecordedSlot(statePath, state, slotKey, isRecordedDelivered);
                state = retiredCheck.state;
                if (retiredCheck.retired?.recordKey === recordKey) {
                    return deliveredResult(retiredCheck.retired)
                }
                if (retiredCheck.unrecorded) {
                    if (retiredCheck.unrecorded.recordKey === recordKey) {
                        return deliveredResult(retiredCheck.unrecorded)
                    }
                    if (slotKey === activeSlotKey) {
                        return {status: 'unknown', reason: 'receiver receipt not committed'}
                    }
                }
            }

            let attempt = state[activeSlotKey];
            if (attempt && attempt.recordKey !== recordKey) {
                return {
                    status: 'unknown',
                    reason: activeSlotKey === 'urgentInflight' ? 'another urgent delivery unresolved' : 'another delivery unresolved'
                }
            }

            if (!attempt) {
                if (!urgent && state.urgentInflight) {
                    return {status: 'pending', reason: 'urgent delivery in progress'}
                }
                let recorded;
                try { recorded = await isRecordedDelivered(recordKey) } catch { return {status: 'unknown', reason: 'receiver state unavailable'} }
                if (recorded === true) return {status: 'delivered', reason: 'receiver already recorded'};
                if (recorded !== false) return {status: 'unknown', reason: 'receiver state unavailable'};
                let target;
                try {
                    target = await readTarget(binding, {
                        urgent           : activeSlotKey === 'urgentInflight',
                        hasNormalInflight: Boolean(state.inflight),
                        normalInflight   : state.inflight || null
                    })
                } catch {
                    return {status: 'pending', reason: 'target unavailable'}
                }
                if (target && typeof target === 'object' && target.root !== true && typeof target.reason === 'string') {
                    return {
                        status: 'pending',
                        reason: target.reason,
                        ...(target.dependency ? {dependency: target.dependency} : {})
                    }
                }
                if (!matchesProof(binding, target)) return {status: 'pending', reason: 'target not proven'};
                attempt = {
                    status: 'unknown',
                    recordKey,
                    nonce : randomUUID(),
                    ...(target.deliveryMode ? {deliveryMode: target.deliveryMode} : {})
                };
                state = {...state, [activeSlotKey]: attempt};
                await save(statePath, state);
                return {binding, attempt, activeSlotKey, target, initiate: true}
            }
            return {binding, attempt, activeSlotKey, target: null, initiate: false}
        });
        if (!phase.attempt) return phase;
        const {binding, attempt, activeSlotKey, target} = phase,
              slotUrgent                                = activeSlotKey === 'urgentInflight';
        let sent;
        if (phase.initiate) {
            try { sent = await send({binding, recordKey, nonce: attempt.nonce, urgent: slotUrgent, attempt, target}) } catch { /* effect may have happened */ }
        }
        let receipt;
        if (sent?.status === 'not-sent') {
            receipt = {status: 'not-sent', ...binding, recordKey, nonce: attempt.nonce}
        } else {
            try { receipt = await readReceipt({binding, recordKey, nonce: attempt.nonce, urgent: slotUrgent, attempt}) } catch { /* unresolved */ }
        }
        return withOutboxLock(statePath, async () => {
            const state = await readPrimarySessionWake({statePath}), current = state[activeSlotKey];
            if (!current || current.recordKey !== recordKey || current.nonce !== attempt.nonce ||
                state.binding?.seat !== binding.seat || state.binding?.generation !== binding.generation ||
                state.binding?.threadId !== binding.threadId) return {status: 'unknown', reason: 'attempt changed', nonce: attempt.nonce};
            if (current.status === 'delivered') return deliveredResult(current);
            if (!receiptMatches(receipt, binding, attempt)) return {status: 'unknown', reason: 'receipt unproven', nonce: attempt.nonce};
            if (receipt.status === 'not-sent') {
                await save(statePath, {...state, [activeSlotKey]: null});
                return {status: 'pending', reason: 'effect proven not sent'}
            }
            if (!['consumed', 'unacknowledged'].includes(receipt.status)) return {status: 'unknown', reason: 'delivery unresolved', nonce: attempt.nonce};
            const recipientObservedAt = typeof receipt.observedAt === 'string' ? receipt.observedAt : null,
                  settledAttempt      = {
                      ...current,
                      status: 'delivered',
                      ...(recipientObservedAt ? {recipientObservedAt} : {}),
                      ...(receipt.status === 'unacknowledged' ? {acknowledged: false} : {})
                  };
            await save(statePath, {...state, [activeSlotKey]: settledAttempt});
            return deliveredResult(settledAttempt)
        })
    })
}
