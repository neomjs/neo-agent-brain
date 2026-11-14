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

/** @summary Derives the single outstanding pointer for a validated mailbox principal. */
export function primaryWakeSpoolPath(stateDir, seat) {
    if (!path.isAbsolute(stateDir || '') || !/^@[a-z0-9][a-z0-9-]*$/.test(seat ?? '')) throw new Error('Invalid native wake spool');
    return path.join(stateDir, 'primary-sessions', seat.slice(1) + '.request.json')
}

/** @summary Makes a signed record discoverable by the host, leaving predecessors queued in receiver order. */
export async function stagePrimaryWake(record, {state,stateDir}) {
    const seat    = record.route?.agentIdentity, key = record.recordKey;
    const pointer = primaryWakeSpoolPath(stateDir,seat);
    if (!keyPattern.test(key)) throw new Error('Invalid wake record key');
    await fs.mkdir(path.dirname(pointer),{recursive:true,mode:0o700});
    return withOutboxLock(pointer, async () => {
        const current = await readPrivateWakeJson(pointer);
        if (current?.recordKey !== key) {
            if (current && (!keyPattern.test(current.recordKey) || (await state.read(current.recordKey)).state !== 'delivered')) {
                return {status:'pending',reason:'earlier native wake outstanding'}
            }
            await writeFileAtomic(pointer,JSON.stringify({recordKey:key}),{mode:0o600,fsync:true})
        }
        const outcome = await readPrivateWakeJson(pointer+'.result');
        if (outcome?.recordKey === key && outcome.subscriptionId === record.subscriptionId &&
            hasPrimaryWakeRecipient(outcome.recipient, {seat, recordKey:key})) {
            return {status:'delivered',recipient:outcome.recipient}
        }
        const diagnostic = await readPrivateWakeJson(pointer+'.status');
        if (diagnostic?.recordKey === key && diagnostic.subscriptionId === record.subscriptionId &&
            ['native-recipient:resident-unavailable', 'native-recipient:selection-unavailable',
                'native-recipient:receipt-unproven', 'native-recipient:awaiting-readiness'].includes(diagnostic.reason)) {
            return {status:'pending',reason:diagnostic.reason}
        }
        return {status:'pending',reason:'awaiting the native recipient'}
    })
}
