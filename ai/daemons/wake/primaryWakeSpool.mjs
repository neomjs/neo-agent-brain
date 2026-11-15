/**
 * @module ai/daemons/wake/primaryWakeSpool
 * @summary Exchanges record keys and receipted outcomes across the receiver/Fleet boundary.
 * The graphless receiver persists the signed envelope. Fleet alone inspects harness databases.
 */
import fs                         from 'node:fs/promises';
import path                       from 'node:path';
import {withOutboxLock}           from './outboxLock.mjs';
import {readPrivateWakeJson}      from './nativeWakeEnrollment.mjs';
import {writeFileAtomic}          from '../../services/shared/atomicFileWrite.mjs';
import {deriveAgentInstanceHome}  from '../../services/fleet/deriveAgentInstanceHome.mjs';
import {deriveHarnessWakeAddress} from '../../services/fleet/deriveHarnessLaunchSpec.mjs';

const keyPattern = /^[a-f0-9]{64}$/;
const uuid       = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const ACTIVE_TURN_UNAVAILABLE_REASON = 'native-recipient:active-turn-adapter-unavailable';
export const ACTIVE_TURN_ADAPTER_DEPENDENCY = '#1741';
export const NATIVE_DIAGNOSTIC_REASONS      = Object.freeze([
    'native-recipient:resident-unavailable',
    'native-recipient:selection-unavailable',
    'native-recipient:receipt-unproven',
    'native-recipient:awaiting-readiness',
    ACTIVE_TURN_UNAVAILABLE_REASON
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

async function isSpoolPointerActive(entry, state) {
    if (!entry) return false;
    if (!keyPattern.test(entry.recordKey)) return true;
    try {
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
            ...(typeof outcome.recipientObservedAt === 'string' ? {recipientObservedAt: outcome.recipientObservedAt} : {})
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

        if (currentNormal?.recordKey !== key) {
            if (sessionState?.inflight?.recordKey !== key && currentUrgent?.recordKey !== key && await isSpoolPointerActive(currentUrgent, state)) {
                return {status: 'pending', reason: 'urgent native wake outstanding'}
            }
            if (await isSpoolPointerActive(currentNormal, state)) {
                return {status: 'pending', reason: 'earlier native wake outstanding'}
            }
            await writeFileAtomic(normalPointer, JSON.stringify({recordKey: key}), {mode: 0o600, fsync: true})
        }
        return readSpoolOutcome(normalPointer, record, seat, key)
    })
}
