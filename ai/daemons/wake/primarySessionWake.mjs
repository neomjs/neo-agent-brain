import fs                from 'node:fs/promises';
import {randomUUID}      from 'node:crypto';
import {withOutboxLock}  from './outboxLock.mjs';
import {writeFileAtomic} from '../../services/shared/atomicFileWrite.mjs';

const UUID     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAT     = /^@[a-z0-9][a-z0-9-]*$/;
const FAMILIES = new Set(['codex-desktop', 'antigravity']);

/** @summary Reads the host-owned binding and the single outstanding delivery receipt. */
export async function readPrimarySessionWake({statePath}) {
    try {
        const stat = await fs.lstat(statePath);
        if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('primary wake state must be a private regular file');
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        if (!Number.isSafeInteger(state.version) || state.version < 1 || !('binding' in state) || !('inflight' in state)) {
            throw new Error('invalid primary wake state');
        }
        return state
    } catch (error) {
        if (error.code === 'ENOENT') return {version: 0, binding: null, inflight: null};
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
        if (state.inflight?.status === 'delivered' && typeof isRecordedDelivered === 'function') {
            let recorded = false;
            try { recorded = await isRecordedDelivered(state.inflight.recordKey) === true } catch { /* retain receipt */ }
            if (recorded) {
                state = {...state, inflight: null};
                await save(statePath, state)
            }
        }
        if (state.inflight) return {status: 'unknown', reason: 'delivery unresolved', version: state.version};
        let proof;
        try { proof = await proveTarget(binding) } catch { return {status: 'pending', reason: 'target proof unavailable', version: state.version} }
        if (!matchesProof(binding, proof)) return {status: 'pending', reason: 'target not proven', version: state.version};
        const next = {version: state.version + 1, binding, inflight: null};
        await save(statePath, next);
        return {status: 'bound', version: next.version, binding}
    })
}

/** @summary Revokes the selected binding only after every prior effect is reconciled. */
export async function revokePrimarySession({statePath, seat, expectedVersion}) {
    return withOutboxLock(statePath, async () => {
        const state = await readPrimarySessionWake({statePath});
        if (state.version !== expectedVersion || state.binding?.seat !== seat) return {status: 'pending', reason: 'binding changed', version: state.version};
        if (state.inflight) return {status: 'unknown', reason: 'delivery unresolved', version: state.version};
        const next = {version: state.version + 1, binding: null, inflight: null};
        await save(statePath, next);
        return {status: 'revoked', version: next.version}
    })
}

function receiptMatches(receipt, binding, attempt) {
    return receipt?.seat === binding.seat && receipt.generation === binding.generation &&
        receipt.threadId === binding.threadId && receipt.recordKey === attempt.recordKey && receipt.nonce === attempt.nonce
}

/**
 * @summary Serializes binding, durable admission, native effect and receipt reconciliation per seat.
 * A crash or ambiguous send retains the attempt; only a correlated authoritative receipt can settle it.
 * Receiver record persistence owns long-term deduplication; the last receipt stays until that record is delivered.
 */
export async function deliverPrimarySessionWake({statePath, seat, generation, family, recordKey,
    readTarget, send, readReceipt, isRecordedDelivered}) {
    if (!/^[a-f0-9]{64}$/.test(recordKey ?? '') ||
        ![readTarget, send, readReceipt, isRecordedDelivered].every(fn => typeof fn === 'function')) {
        return {status: 'pending', reason: 'invalid delivery'}
    }
    // The effect mutex serializes send/reconcile callers without blocking the owner lock that
    // the recipient hook needs. A dead sender's mutex is reclaimed only after process death.
    return withOutboxLock(`${statePath}.effect`, async () => {
    const phase = await withOutboxLock(statePath, async () => {
        let state = await readPrimarySessionWake({statePath}), binding = state.binding, attempt = state.inflight;
        if (!binding || binding.seat !== seat || binding.generation !== generation || binding.family !== family) {
            return {status: 'pending', reason: 'binding unavailable'}
        }
        if (attempt?.status === 'delivered') {
            let recorded = false;
            try { recorded = await isRecordedDelivered(attempt.recordKey) === true } catch { /* preserve receipt */ }
            if (!recorded) return attempt.recordKey === recordKey ? {status: 'delivered', nonce: attempt.nonce} : {status: 'unknown', reason: 'receiver receipt not committed'};
            state = {...state, inflight: null};
            await save(statePath, state);
            if (attempt.recordKey === recordKey) return {status: 'delivered', nonce: attempt.nonce};
            attempt = null;
        }
        if (attempt && attempt.recordKey !== recordKey) return {status: 'unknown', reason: 'another delivery unresolved'};
        if (!attempt) {
            let recorded;
            try { recorded = await isRecordedDelivered(recordKey) } catch { return {status: 'unknown', reason: 'receiver state unavailable'} }
            if (recorded === true) return {status: 'delivered', reason: 'receiver already recorded'};
            if (recorded !== false) return {status: 'unknown', reason: 'receiver state unavailable'};
            let target;
            try { target = await readTarget(binding) } catch { return {status: 'pending', reason: 'target unavailable'} }
            if (!matchesProof(binding, target)) return {status: 'pending', reason: 'target not proven'};
            attempt = {status: 'unknown', recordKey, nonce: randomUUID()};
            state = {...state, inflight: attempt};
            await save(statePath, state);
            return {binding, attempt, initiate: true}
        }
        return {binding, attempt, initiate: false}
    });
    if (!phase.attempt) return phase;
    const {binding, attempt} = phase;
    let sent;
    if (phase.initiate) {
        try { sent = await send({binding, recordKey, nonce: attempt.nonce}) } catch { /* effect may have happened */ }
    }
    let receipt;
    if (sent?.status === 'not-sent') {
        receipt = {status: 'not-sent', ...binding, recordKey, nonce: attempt.nonce}
    } else {
        try { receipt = await readReceipt({binding, recordKey, nonce: attempt.nonce}) } catch { /* unresolved */ }
    }
    return withOutboxLock(statePath, async () => {
        const state = await readPrimarySessionWake({statePath}), current = state.inflight;
        if (!current || current.recordKey !== recordKey || current.nonce !== attempt.nonce ||
            state.binding?.seat !== binding.seat || state.binding?.generation !== binding.generation ||
            state.binding?.threadId !== binding.threadId) return {status: 'unknown', reason: 'attempt changed', nonce: attempt.nonce};
        if (current.status === 'delivered') return {status: 'delivered', nonce: current.nonce};
        if (!receiptMatches(receipt, binding, attempt)) return {status: 'unknown', reason: 'receipt unproven', nonce: attempt.nonce};
        if (receipt.status === 'not-sent') {
            await save(statePath, {...state, inflight: null});
            return {status: 'pending', reason: 'effect proven not sent'}
        }
        if (receipt.status !== 'consumed') return {status: 'unknown', reason: 'delivery unresolved', nonce: attempt.nonce};
        await save(statePath, {...state, inflight: {...current, status: 'delivered'}});
        return {status: 'delivered', nonce: attempt.nonce}
    })
    })
}
