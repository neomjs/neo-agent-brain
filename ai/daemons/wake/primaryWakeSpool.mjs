/**
 * @module ai/daemons/wake/primaryWakeSpool
 * @summary Exchanges record keys and receipted outcomes across the receiver/Fleet boundary.
 * The graphless receiver persists the signed envelope. Fleet alone inspects harness databases.
 */
import fs                    from 'node:fs/promises';
import path                  from 'node:path';
import {withOutboxLock}      from './outboxLock.mjs';
import {readPrivateWakeJson} from './nativeWakeEnrollment.mjs';
import {writeFileAtomic}     from '../../services/shared/atomicFileWrite.mjs';

const keyPattern = /^[a-f0-9]{64}$/;
const uuid       = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

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
        if (outcome?.recordKey === key && outcome.subscriptionId === record.subscriptionId && outcome.recipient?.seat === seat &&
            outcome.recipient.recordKey === key && uuid.test(outcome.recipient.threadId ?? '') && uuid.test(outcome.recipient.nonce ?? '') &&
            typeof outcome.recipient.generation === 'string' && outcome.recipient.generation) {
            return {status:'delivered',recipient:outcome.recipient}
        }
        return {status:'pending',reason:'awaiting the native recipient'}
    })
}
