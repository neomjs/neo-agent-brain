/**
 * @module ai/daemons/wake/primaryWakeSelection
 * @summary Generation-bound monotonic selection of a proven native wake root.
 */
import fs                from 'node:fs/promises';
import path              from 'node:path';
import {withOutboxLock}  from './outboxLock.mjs';
import {writeFileAtomic} from '../../services/shared/atomicFileWrite.mjs';

const UUID  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = {'codex-desktop': 'codex-start', antigravity: 'antigravity-sequence'};

/**
 * @summary Reads the allocation millisecond of a native Codex UUIDv7. Its random suffix does not order tied roots.
 * @param {String} threadId
 * @returns {Number|null} Null for an ID without a usable allocation clock.
 */
export function codexThreadStartMs(threadId) {
    if (typeof threadId !== 'string' || !UUID.test(threadId) || threadId[14] !== '7' || !/[89ab]/i.test(threadId[19])) return null;
    return Number.parseInt(threadId.slice(0, 8) + threadId.slice(9, 13), 16) || null
}

/** @summary Reads a private selection record; only an absent file means no observation. */
async function readSelection(file) {
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('selection must be private regular file');
        return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
}

/** @summary Checks the identity and both order fields before a persisted selection can participate. */
function validSelection(row, seat, family) {
    return row?.version === 1 && row.seat === seat && row.family === family && row.kind === KINDS[family] &&
        typeof row.generation === 'string' && UUID.test(row.threadId ?? '') && Number.isSafeInteger(row.order) && row.order > 0 &&
        (row.threadStartMs === undefined || (family === 'codex-desktop' && row.threadStartMs > 0 && row.threadStartMs === codexThreadStartMs(row.threadId)))
}

/**
 * @summary Observes one proven root selection without letting an observed successor disappear back to its predecessor.
 * The caller must prove the live Fleet process generation and supply a vendor-start value for Codex or
 * a gap-free, generation-local observer sequence for Antigravity. A native timestamp is not an Antigravity sequence.
 * This watermark cannot detect a successor that was never observed before its native record disappeared.
 * @param {Object} options Host-owned path, authenticated seat/family, generation, selected root, order and proof.
 * @param {Function} [options.verifyContinuity] Re-reads the binding for this exact already-selected root under the selection lock.
 * @returns {Promise<Object>} Accepted selection or held reason; never guesses on a tie or regression.
 */
export async function observePrimaryWakeSelection({selectionPath, seat, family, generation, threadId, order, proof, verifyGeneration, verifyContinuity}) {
    const threadStartMs = proof?.threadStartMs, isCodex = family === 'codex-desktop';
    if (!path.isAbsolute(selectionPath || '') || path.normalize(selectionPath) !== selectionPath ||
        !/^@[a-z0-9][a-z0-9-]*$/.test(seat ?? '') || !KINDS[family] || typeof generation !== 'string' || !generation ||
        !UUID.test(threadId ?? '') || !Number.isSafeInteger(order) || order < 1 ||
        proof?.verified !== true || proof.kind !== KINDS[family] || typeof verifyGeneration !== 'function' ||
        (threadStartMs !== undefined && (family !== 'codex-desktop' || !threadStartMs || threadStartMs !== codexThreadStartMs(threadId)))) {
        return {status: 'held', reason: 'selection proof unavailable'}
    }
    return withOutboxLock(selectionPath, async () => {
        let live;
        try { live = await verifyGeneration({seat, family, generation}) } catch { return {status: 'held', reason: 'generation proof unavailable'} }
        if (live !== true) return {status: 'held', reason: 'generation not current'};
        const witnessPath = selectionPath + '.codex-witness.json',
              prior       = await readSelection(selectionPath),
              witness     = isCodex ? await readSelection(witnessPath) : undefined,
              records     = [witness, prior].filter(row => row !== undefined);
        if (records.some(row => !validSelection(row, seat, family)) || (witness !== undefined && witness.threadStartMs === undefined)) {
            return {status:'held', reason:'stored selection invalid'}
        }
        const current   = records.filter(row => row.generation === generation),
              nextStart = isCodex ? codexThreadStartMs(threadId) : null;
        for (const row of current) {
            if (row.threadId === threadId) {
                if (!isCodex && order < row.order) return {status:'held', reason:'selection regressed or tied'};
            } else {
                const earlierStart = isCodex ? codexThreadStartMs(row.threadId) : null;
                if (order <= row.order || (earlierStart !== null && nextStart !== null && nextStart <= earlierStart)) {
                    return {status:'held', reason:'selection regressed or tied'}
                }
            }
        }
        if (current.some(row => row.threadId === threadId && row.order !== order)) {
            let continuous = false;
            if (threadStartMs !== undefined && typeof verifyContinuity === 'function') {
                try { continuous = await verifyContinuity() === true } catch { /* unavailable binding stays held */ }
            }
            if (!continuous) return {status:'held', reason:'root start changed'};
            // The v1 hook rejects a downward correction until upgraded. Never lower its index watermark.
            for (const row of current) order = Math.max(order, row.order)
        }
        if (threadStartMs === undefined && current.some(row => row.threadStartMs !== undefined)) {
            return {status:'held', reason:'selection proof unavailable'}
        }
        const selection = {version: 1, seat, family, generation, threadId, order, kind: KINDS[family],
            ...(threadStartMs === undefined ? {} : {threadStartMs})},
              matches = row => row?.generation === generation && row.threadId === threadId && row.order === order && row.threadStartMs === threadStartMs;
        // An installed v1 hook can replace its file. Persist the verified successor first, under their shared lock.
        const save = file => writeFileAtomic(file, JSON.stringify(selection) + '\n', {mode:0o600, fsync:true});
        if (threadStartMs !== undefined && !matches(witness)) await save(witnessPath);
        if (!matches(prior)) await save(selectionPath);
        return {status: 'accepted', selection}
    })
}
