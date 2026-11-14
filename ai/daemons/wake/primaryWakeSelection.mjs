import fs                from 'node:fs/promises';
import path              from 'node:path';
import {withOutboxLock}  from './outboxLock.mjs';
import {writeFileAtomic} from '../../services/shared/atomicFileWrite.mjs';

const UUID  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = {'codex-desktop': 'codex-start', antigravity: 'antigravity-sequence'};

/**
 * @summary Observes one proven root selection without letting an observed successor disappear back to its predecessor.
 * The caller must prove the live Fleet process generation and supply a vendor-start value for Codex or
 * a gap-free, generation-local observer sequence for Antigravity. A native timestamp is not an Antigravity sequence.
 * This watermark cannot detect a successor that was never observed before its native record disappeared.
 * @param {Object} options Host-owned path, authenticated seat/family, generation, selected root, order and proof.
 * @returns {Promise<Object>} Accepted selection or held reason; never guesses on a tie or regression.
 */
export async function observePrimaryWakeSelection({selectionPath, seat, family, generation, threadId, order, proof, verifyGeneration}) {
    if (!path.isAbsolute(selectionPath || '') || path.normalize(selectionPath) !== selectionPath ||
        !/^@[a-z0-9][a-z0-9-]*$/.test(seat ?? '') || !KINDS[family] || typeof generation !== 'string' || !generation ||
        !UUID.test(threadId ?? '') || !Number.isSafeInteger(order) || order < 1 ||
        proof?.verified !== true || proof.kind !== KINDS[family] || typeof verifyGeneration !== 'function') {
        return {status: 'held', reason: 'selection proof unavailable'}
    }
    return withOutboxLock(selectionPath, async () => {
        let live;
        try { live = await verifyGeneration({seat, family, generation}) } catch { return {status: 'held', reason: 'generation proof unavailable'} }
        if (live !== true) return {status: 'held', reason: 'generation not current'};
        let prior;
        try {
            const stat = await fs.lstat(selectionPath);
            if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('selection must be private regular file');
            prior = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (prior && (prior.version !== 1 || prior.seat !== seat || prior.family !== family ||
            typeof prior.generation !== 'string' || !UUID.test(prior.threadId ?? '') ||
            !Number.isSafeInteger(prior.order) || prior.order < 1 || prior.kind !== KINDS[family])) {
            return {status: 'held', reason: 'stored selection invalid'}
        }
        if (prior?.generation === generation) {
            if (order < prior.order || (order === prior.order && threadId !== prior.threadId)) {
                return {status: 'held', reason: 'selection regressed or tied'}
            }
            if (order === prior.order && threadId === prior.threadId) return {status: 'accepted', selection: prior};
            // A root cannot acquire a different start order in the same process lifetime.
            if (threadId === prior.threadId) return {status: 'held', reason: 'root start changed'};
        }
        const selection = {version: 1, seat, family, generation, threadId, order, kind: KINDS[family]};
        await writeFileAtomic(selectionPath, JSON.stringify(selection) + '\n', {mode: 0o600, fsync: true});
        return {status: 'accepted', selection}
    })
}
