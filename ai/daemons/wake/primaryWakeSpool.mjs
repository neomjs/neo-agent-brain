/**
 * @module ai/daemons/wake/primaryWakeSpool
 * @summary Exchanges record keys and receipted outcomes across the receiver/Fleet boundary.
 * The graphless receiver persists the signed envelope. Fleet alone inspects harness databases.
 */
import fs                                                        from 'node:fs/promises';
import path                                                      from 'node:path';
import {withOutboxLock}                                          from './outboxLock.mjs';
import {matchesPrimaryWakeMember, MAX_PRIMARY_WAKE_BATCH_EVENTS} from './primaryWakeBatch.mjs';
import {primaryWakeAttemptRecorded, readPrimarySessionWake}      from './primarySessionWake.mjs';
import {readPrivateWakeJson}                                     from './nativeWakeEnrollment.mjs';
import {writeFileAtomic}                                         from '../../services/shared/atomicFileWrite.mjs';
import {deriveAgentInstanceHome}                                 from '../../services/fleet/deriveAgentInstanceHome.mjs';
import {deriveHarnessWakeAddress}                                from '../../services/fleet/deriveHarnessLaunchSpec.mjs';

const keyPattern = /^[a-f0-9]{64}$/;
const uuid       = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const ACTIVE_TURN_UNAVAILABLE_REASON = 'native-recipient:active-turn-adapter-unavailable';
export const ACTIVE_TURN_ADAPTER_DEPENDENCY = '#1741';
export const ROOT_START_CHANGED             = 'selection-root-start-changed';
export const NATIVE_DISPATCH_REASONS        = Object.freeze([
    'native-recipient:resident-unavailable',
    'native-recipient:selection-unavailable',
    `native-recipient:${ROOT_START_CHANGED}`,
    ACTIVE_TURN_UNAVAILABLE_REASON
]);
export const NATIVE_DIAGNOSTIC_REASONS      = Object.freeze([
    ...NATIVE_DISPATCH_REASONS,
    'native-recipient:receipt-unproven',
    'native-recipient:awaiting-readiness'
]);

/** @summary Validates a native receipt against the exact signed record and mailbox principal. */
export function hasPrimaryWakeRecipient(recipient, {seat, recordKey}) {
    return recipient?.seat === seat && recipient.recordKey === recordKey &&
        typeof recipient.generation === 'string' && recipient.generation.length > 0 &&
        uuid.test(recipient.threadId ?? '') && uuid.test(recipient.nonce ?? '')
}

/** @summary Resolves a native profile only when its address is the canonical Fleet seat layout. */
export function primaryWakeSeatForAddress({family, instanceAddress, agentId, allowUnmatchedProfile = false} = {}) {
    if (!['codex-desktop', 'antigravity'].includes(family) || typeof instanceAddress !== 'string' ||
        !path.isAbsolute(instanceAddress) || path.normalize(instanceAddress) !== instanceAddress) return null;
    const home   = family === 'codex-desktop' ? path.dirname(instanceAddress) : instanceAddress,
          parent = path.dirname(home), seat = path.basename(path.dirname(parent)), root = path.dirname(path.dirname(parent));
    try {
        if ((agentId !== undefined && agentId !== seat) ||
            deriveAgentInstanceHome({instanceRoot:root, agentId:seat, harnessType:family}) !== home ||
            (!allowUnmatchedProfile && deriveHarnessWakeAddress({harnessType:family,instanceHome:home})?.instanceAddress !== instanceAddress)) return null;
        return {agentId:seat, instanceHome:home}
    } catch { return null }
}

/** @summary Derives the ordinary outstanding pointer for a validated mailbox principal. */
export function primaryWakeSpoolPath(stateDir, seat) {
    if (!path.isAbsolute(stateDir || '') || !/^@[a-z0-9][a-z0-9-]*$/.test(seat ?? '')) throw new Error('Invalid native wake spool');
    return path.join(stateDir, 'primary-sessions', seat.slice(1) + '.request.json')
}

/** @summary Derives the independent urgent pointer for a validated mailbox principal. */
export function urgentPrimaryWakeSpoolPath(stateDir, seat) {
    if (!path.isAbsolute(stateDir || '') || !/^@[a-z0-9][a-z0-9-]*$/.test(seat ?? '')) throw new Error('Invalid native wake spool');
    return path.join(stateDir, 'primary-sessions', seat.slice(1) + '.urgent.request.json')
}

/**
 * @summary Defer reasons emitted by the host wake spool when another in-flight or staged wake
 * already occupies the target slot (`waiting-for-spool`, before the host chat boundary is reached).
 */
export const SPOOL_CONTENTION_REASONS = Object.freeze([
    'earlier urgent native wake outstanding',
    'urgent native wake outstanding',
    'earlier native wake outstanding'
]);

/**
 * @summary Returns whether a receiver record explicitly carries the stamped `urgent` flag.
 * Pre-PR records lacking `record.urgent` evaluate deterministically to `false` so stale legacy
 * records cannot re-enter urgent preemption or wedge a seat across restarts.
 * @param {Object|null} record
 * @returns {Boolean}
 */
export function isUrgentWakeRecord(record) {
    return record?.urgent === true
}

/**
 * @summary Keeps a staged pointer occupied until its persisted receipt covers every linked record.
 * @param {Object|null} entry The selected spool pointer.
 * @param {Object} state The receiver's record store.
 * @param {Object|null} [attempt] The corresponding native attempt, when present.
 * @returns {Promise<Boolean>}
 */
export async function isSpoolPointerActive(entry, state, attempt) {
    if (!entry) return false;
    if (!keyPattern.test(entry.recordKey)) return true;
    try {
        if (attempt?.recordKey === entry.recordKey && attempt.members) {
            return attempt.status !== 'delivered' ||
                !await primaryWakeAttemptRecorded(attempt, async key => (await state.read(key)).state === 'delivered')
        }

        return (await state.read(entry.recordKey)).state !== 'delivered'
    } catch {
        return true
    }
}

async function readSpoolOutcome(pointer, record, seat, key) {
    const outcome = await readPrivateWakeJson(pointer + '.result');
    if (outcome?.recordKey === key && outcome.subscriptionId === record.subscriptionId &&
        hasPrimaryWakeRecipient(outcome.recipient, {seat, recordKey: key})) {
        return {
            status   : 'delivered',
            recipient: outcome.recipient,
            ...(typeof outcome.recipientObservedAt === 'string' ? {recipientObservedAt: outcome.recipientObservedAt} : {}),
            ...(outcome.acknowledged === false ? {acknowledged: false} : {})
        }
    }
    const diagnostic = await readPrivateWakeJson(pointer + '.status');
    if (diagnostic?.recordKey === key && diagnostic.subscriptionId === record.subscriptionId &&
        NATIVE_DIAGNOSTIC_REASONS.includes(diagnostic.reason)) {
        return {
            status: 'pending',
            reason: diagnostic.reason,
            ...(diagnostic.dependency ? {dependency: diagnostic.dependency} : {})
        }
    }
    return {status: 'pending', reason: 'awaiting the native recipient'}
}

/**
 * @summary Reads a completed native batch's authoritative receipt for an original receiver record.
 * The Fleet slot survives a lost spool publication or a removed subscription. Reading it cannot
 * admit a future send. Legacy dispatch and ordinary singleton settlements still use spool results.
 * @param {Object} record The immutable signed envelope's receiver record.
 * @param {String} stateDir The receiver's local state directory.
 * @param {Map} receipts Pass-local cache of each seat's private attempt snapshot.
 * @returns {Promise<Object|null>}
 */
export async function readPrimaryWakeBatchReceipt(record, stateDir, receipts) {
    if (!record.nativeStatus || isUrgentWakeRecord(record)) return null;
    const seat      = record.route?.agentIdentity,
          statePath = path.join(path.dirname(primaryWakeSpoolPath(stateDir, seat)), seat.slice(1) + '.json');
    if (!receipts.has(seat)) receipts.set(seat, readPrimarySessionWake({statePath}));
    return batchReceipt(record, await receipts.get(seat))
}

/** @summary Projects one member from the exact completed native attempt and its immutable binding. */
function batchReceipt(record, sessionState) {
    const {binding, inflight} = sessionState ?? {};
    if (inflight?.status !== 'delivered' || !Array.isArray(inflight.members) ||
        !inflight.members.some(member => matchesPrimaryWakeMember(record, member)) ||
        binding?.family !== 'codex-desktop' || binding.seat !== record.route?.agentIdentity ||
        binding.seat !== record.envelope?.agentIdentity) return null;

    const recipient = {seat:binding.seat, generation:binding.generation, threadId:binding.threadId,
        recordKey:record.recordKey, nonce:inflight.nonce};
    if (!hasPrimaryWakeRecipient(recipient, {seat:binding.seat, recordKey:record.recordKey})) return null;
    return {
        status: 'delivered',
        recipient,
        ...(typeof inflight.recipientObservedAt === 'string' ? {recipientObservedAt:inflight.recipientObservedAt} : {}),
        ...(inflight.acknowledged === false ? {acknowledged:false} : {})
    }
}

/** @summary Stages a signed record for host consumption, preempting unsent ordinary pointers while preserving in-flight ones. */
export async function stagePrimaryWake(record, {state, stateDir}) {
    const
        seat             = record.route?.agentIdentity,
        key              = record.recordKey,
        normalPointer    = primaryWakeSpoolPath(stateDir, seat),
        urgentPointer    = urgentPrimaryWakeSpoolPath(stateDir, seat),
        sessionStatePath = path.join(stateDir, 'primary-sessions', seat.slice(1) + '.json');

    if (!keyPattern.test(key)) throw new Error('Invalid wake record key');
    await fs.mkdir(path.dirname(normalPointer), {recursive: true, mode: 0o700});

    return withOutboxLock(normalPointer, async () => {
        const
            currentNormal = await readPrivateWakeJson(normalPointer),
            currentUrgent = await readPrivateWakeJson(urgentPointer),
            sessionState  = await readPrivateWakeJson(sessionStatePath),
            urgent        = isUrgentWakeRecord(record) || currentUrgent?.recordKey === key || sessionState?.urgentInflight?.recordKey === key;

        if (urgent) {
            if (currentUrgent?.recordKey !== key) {
                if (await isSpoolPointerActive(currentUrgent, state)) {
                    return {status: 'pending', reason: 'earlier urgent native wake outstanding'}
                }
                if (currentNormal?.recordKey && currentNormal.recordKey !== key &&
                    sessionState?.inflight?.recordKey !== currentNormal.recordKey) {
                    await fs.rm(normalPointer, {force: true});
                    await fs.rm(normalPointer + '.status', {force: true});
                }
                await writeFileAtomic(urgentPointer, JSON.stringify({recordKey: key, urgent: true}), {mode: 0o600, fsync: true})
            }
            return readSpoolOutcome(urgentPointer, record, seat, key)
        }

        const receipt = batchReceipt(record, sessionState);
        if (receipt) return receipt;
        if (currentNormal?.recordKey === key) return readSpoolOutcome(normalPointer, record, seat, key);
        const attempt = sessionState?.inflight;

        if (sessionState?.inflight?.recordKey !== key && currentUrgent?.recordKey !== key && await isSpoolPointerActive(currentUrgent, state)) {
            return {status: 'pending', reason: 'urgent native wake outstanding'}
        }

        if (await isSpoolPointerActive(currentNormal, state, attempt)) {
            // The receiver adds candidates only after admitting the original record to its native adapter.
            // Once Fleet commits the attempt, the queue can no longer change its membership.
            if (record.route?.adapterConfig?.primarySession?.family === 'codex-desktop' &&
                attempt?.recordKey !== currentNormal.recordKey && !record.expectedRecipient && !record.nativeInitiatedAt) {
                const candidates = Array.isArray(currentNormal.candidates) ? currentNormal.candidates : [];
                if (candidates.length < MAX_PRIMARY_WAKE_BATCH_EVENTS - 1 && !candidates.includes(key)) {
                    const anchor = await state.read(currentNormal.recordKey).catch(() => null);

                    if (anchor?.subscriptionId === record.subscriptionId) {
                        await writeFileAtomic(normalPointer, JSON.stringify({...currentNormal, candidates: [...candidates, key]}),
                            {mode: 0o600, fsync: true})
                    }
                }
            }

            return {status: 'pending', reason: 'earlier native wake outstanding'}
        }

        await writeFileAtomic(normalPointer, JSON.stringify({recordKey: key}), {mode: 0o600, fsync: true});
        return readSpoolOutcome(normalPointer, record, seat, key)
    })
}
