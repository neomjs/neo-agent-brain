import {spawnSync}                                      from 'node:child_process';
import fs                                               from 'node:fs';
import os                                               from 'node:os';
import path                                             from 'node:path';
import {
    assertSafeTemporaryPath, cleanupChromaArtifacts, stopDetachedProcess
} from './chromaProcess.mjs';

const RECEIPT_NAME = '.neo-unit-chroma-owner.json';

/** @summary Reads a PID's reuse-safe POSIX birth token, or null when unsupported/unknown. */
function defaultLstartOf(pid) {
    try {
        return spawnSync('ps', ['-p', String(pid), '-o', 'lstart=']).stdout?.toString().trim() || null
    } catch {
        return null
    }
}

/** @summary Distinguishes a live, absent, and inaccessible/unknown POSIX process identity. */
function processState(pid, {killFn = process.kill, platform = process.platform} = {}) {
    if (platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
    try {
        killFn(pid, 0);
        return 'alive'
    } catch (error) {
        return error?.code === 'ESRCH' ? 'dead' : 'unknown'
    }
}

/** @summary Verifies a POSIX detached process group is absent without collapsing unknown errors. */
function groupState(pid, {killFn = process.kill, platform = process.platform} = {}) {
    if (platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
    try {
        killFn(-pid, 0);
        return 'alive'
    } catch (error) {
        return error?.code === 'ESRCH' ? 'dead' : 'unknown'
    }
}

/** @summary Classifies a PID plus recorded birth token without trusting PID liveness alone. */
function identityState(identity, seams) {
    const state = processState(identity?.pid, seams);
    if (state !== 'alive') return state;

    const birth = seams.lstartOf(identity.pid);
    return birth && birth === identity.startedAt ? 'matching' : birth ? 'reused' : 'unknown'
}

/** @summary Accepts only a direct, non-symlink generated Chroma directory under one temp root. */
function isGeneratedDataDir(dataDir, tempRoot, {lstatSync = fs.lstatSync} = {}) {
    try {
        const resolved = assertSafeTemporaryPath(dataDir), stat = lstatSync(resolved);
        return path.dirname(resolved) === path.resolve(tempRoot) && stat.isDirectory() && !stat.isSymbolicLink()
    } catch {
        return false
    }
}

/** @summary Accepts only this generated data directory's exact sibling log path. */
function isGeneratedLogPath(logPath, dataDir) {
    try {
        return assertSafeTemporaryPath(logPath) === `${path.resolve(dataDir)}.log`
    } catch {
        return false
    }
}

/** @summary Reads a regular, non-symlink ownership receipt or returns null for untrusted input. */
function readReceipt(receiptPath, {lstatSync = fs.lstatSync, readFileSync = fs.readFileSync} = {}) {
    try {
        const stat = lstatSync(receiptPath);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;

        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
        if (receipt?.version !== 1 || typeof receipt.repoRoot !== 'string' || typeof receipt.dataDir !== 'string' ||
            typeof receipt.logPath !== 'string' || receipt.ownsDataDir !== true || !receipt.runner || !receipt.chroma ||
            !Number.isInteger(receipt.runner.pid) || receipt.runner.pid <= 0 || !Number.isInteger(receipt.chroma.pid) || receipt.chroma.pid <= 0 ||
            typeof receipt.runner.startedAt !== 'string' || !receipt.runner.startedAt || typeof receipt.chroma.startedAt !== 'string' || !receipt.chroma.startedAt) {
            return null
        }
        return receipt
    } catch {
        return null
    }
}

/**
 * @summary Writes one durable receipt for a generated, setup-owned Chroma process.
 * Unsupported platforms and unknown process births return false so explicit pins/Windows setup keep
 * their existing lifecycle. Filesystem write failures remain loud for setup to stop its owned PID.
 * @returns {String|false} Receipt path, or false when ownership cannot be established safely.
 */
export function recordUnitChromaOwnership({
    repoRoot, dataDir, logPath, ownsDataDir, runnerPid, chromaPid,
    platform = process.platform, lstartOf = defaultLstartOf,
    realpathSync = fs.realpathSync, writeFileSync = fs.writeFileSync
}) {
    if (platform === 'win32' || ownsDataDir !== true || !isGeneratedDataDir(dataDir, os.tmpdir()) || !isGeneratedLogPath(logPath, dataDir) ||
        processState(runnerPid, {platform}) !== 'alive' || processState(chromaPid, {platform}) !== 'alive') {
        return false
    }

    const runnerStartedAt = lstartOf(runnerPid), chromaStartedAt = lstartOf(chromaPid);
    if (!runnerStartedAt || !chromaStartedAt) return false;

    const receiptPath = path.join(dataDir, RECEIPT_NAME);
    writeFileSync(receiptPath, JSON.stringify({
        version: 1,
        repoRoot: realpathSync(repoRoot),
        dataDir : path.resolve(dataDir),
        logPath : path.resolve(logPath),
        ownsDataDir,
        runner : {pid: runnerPid, startedAt: runnerStartedAt},
        chroma : {pid: chromaPid, startedAt: chromaStartedAt}
    }, null, 2), {flag: 'wx'});

    return receiptPath
}

/**
 * @summary Reaps only abandoned, receipt-verified generated Chroma runs for this exact checkout.
 * Unknown ownership, live owners, PID reuse, foreign roots, symlinks, malformed receipts, and any
 * surviving group are fail-closed no-ops. The existing stop ladder remains the only terminator.
 * @returns {Promise<Array<{dataDir: String, status: String}>>}
 */
export async function reapUnitChromaOrphans({
    repoRoot,
    tempRoot = os.tmpdir(),
    platform = process.platform,
    readdirSync = fs.readdirSync,
    lstatSync = fs.lstatSync,
    readFileSync = fs.readFileSync,
    realpathSync = fs.realpathSync,
    openSync = fs.openSync,
    closeSync = fs.closeSync,
    unlinkSync = fs.unlinkSync,
    lstartOf = defaultLstartOf,
    killFn = process.kill,
    stopProcess = stopDetachedProcess,
    cleanupArtifacts = cleanupChromaArtifacts
} = {}) {
    if (platform === 'win32') return [];

    const canonicalRepo = realpathSync(repoRoot), outcomes = [];
    let entries;
    try { entries = readdirSync(tempRoot, {withFileTypes: true}) } catch { return outcomes }

    for (const entry of entries) {
        if (!entry.name.startsWith('neo-chroma-unit-test-') || !entry.isDirectory() || entry.isSymbolicLink()) continue;

        const dataDir = path.join(tempRoot, entry.name);
        if (!isGeneratedDataDir(dataDir, tempRoot, {lstatSync})) continue;

        const receipt = readReceipt(path.join(dataDir, RECEIPT_NAME), {lstatSync, readFileSync});
        if (!receipt || receipt.repoRoot !== canonicalRepo || path.resolve(receipt.dataDir) !== path.resolve(dataDir) ||
            !isGeneratedDataDir(receipt.dataDir, tempRoot, {lstatSync}) || !isGeneratedLogPath(receipt.logPath, receipt.dataDir)) {
            outcomes.push({dataDir, status: 'untrusted-receipt'});
            continue
        }

        const lockPath = path.join(dataDir, '.neo-unit-chroma-reap.lock');
        let lock;
        try { lock = openSync(lockPath, 'wx') } catch {
            outcomes.push({dataDir, status: 'locked-or-unavailable'});
            continue
        }

        try {
            const seams = {killFn, lstartOf, platform};
            let runner = identityState(receipt.runner, seams), chroma = identityState(receipt.chroma, seams);
            if (!['dead', 'reused'].includes(runner)) {
                outcomes.push({dataDir, status: 'owner-live-or-unknown'});
                continue
            }
            if (!['dead', 'matching'].includes(chroma)) {
                outcomes.push({dataDir, status: 'chroma-live-or-unknown'});
                continue
            }
            if (chroma === 'dead' && groupState(receipt.chroma.pid, seams) !== 'dead') {
                outcomes.push({dataDir, status: 'group-live-or-unknown'});
                continue
            }

            // Lock acquisition does not authenticate a PID. Re-read both identities at the stop edge.
            runner = identityState(receipt.runner, seams);
            chroma = identityState(receipt.chroma, seams);
            if (!['dead', 'reused'].includes(runner)) {
                outcomes.push({dataDir, status: 'identity-changed'});
                continue
            }
            if (chroma === 'matching') {
                const report = await stopProcess(receipt.chroma.pid);
                if (!report?.groupEmpty) {
                    outcomes.push({dataDir, status: 'group-not-empty'});
                    continue
                }
            } else if (chroma === 'dead' && groupState(receipt.chroma.pid, seams) === 'dead') {
                // The server is already absent and the group was rechecked empty: cleanup only.
            } else {
                outcomes.push({dataDir, status: 'identity-changed'});
                continue
            }

            cleanupArtifacts({dataDir: receipt.dataDir, logPath: receipt.logPath, ownsDataDir: true});
            outcomes.push({dataDir, status: 'reaped'});
        } finally {
            try { closeSync(lock) } catch {}
            try { unlinkSync(lockPath) } catch {}
        }
    }

    return outcomes
}
