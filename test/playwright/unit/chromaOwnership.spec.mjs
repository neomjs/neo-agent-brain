import {test, expect}                    from '@playwright/test';
import {spawn, spawnSync}                from 'node:child_process';
import {once}                            from 'node:events';
import fs                                from 'node:fs';
import os                                from 'node:os';
import path                              from 'node:path';
import {
    recordUnitChromaOwnership, reapUnitChromaOrphans
} from '../chromaOwnership.mjs';
import {stopDetachedProcess}             from '../chromaProcess.mjs';

test.describe('unit Chroma ownership receipts', () => {
    test.skip(process.platform === 'win32', 'Inherited cleanup requires POSIX process birth identities.');

    let tempRoot, repoRoot;

    const lstartOf = pid => spawnSync('ps', ['-p', String(pid), '-o', 'lstart=']).stdout.toString().trim() || null;

    test.beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-ownership-'));
        repoRoot = fs.realpathSync(path.resolve(import.meta.dirname, '../../..'));
    });

    test.afterEach(async () => {
        fs.rmSync(tempRoot, {force: true, recursive: true});
    });

    /** @summary Creates one isolated generated data/log pair for a reap fixture. */
    function candidate(name = 'neo-chroma-unit-test-dead') {
        const dataDir = path.join(tempRoot, name), logPath = path.join(tempRoot, `${name}.log`);
        fs.mkdirSync(dataDir);
        fs.writeFileSync(logPath, 'test');
        return {dataDir, logPath}
    }

    /** @summary Supplies controlled process identities without querying unrelated host processes. */
    function writeReceipt({dataDir, logPath, receiptRepoRoot = repoRoot, runner = {pid: 11001, startedAt: 'runner'}, chroma = {pid: 11002, startedAt: 'chroma'}}) {
        fs.writeFileSync(path.join(dataDir, '.neo-unit-chroma-owner.json'), JSON.stringify({
            version: 1, repoRoot: receiptRepoRoot, dataDir, logPath, ownsDataDir: true, runner, chroma
        }));
    }

    /** @summary Models the OS response for an absent process or group. */
    function deadKill() {
        const error = new Error('gone');
        error.code = 'ESRCH';
        throw error
    }

    test('reaps a real detached disposable child only after its birth-verified owner exits', async () => {
        const {dataDir, logPath} = candidate('neo-chroma-unit-test-live-child');
        const owner = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
            {stdio: ['pipe', 'ignore', 'ignore']});
        const ownerExited = once(owner, 'exit');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
        child.unref();

        try {
            const ownerBirth = lstartOf(owner.pid), chromaBirth = lstartOf(child.pid);
            expect(ownerBirth).toBeTruthy();
            expect(chromaBirth).toBeTruthy();
            writeReceipt({dataDir, logPath, runner: {pid: owner.pid, startedAt: ownerBirth}, chroma: {pid: child.pid, startedAt: chromaBirth}});
            owner.stdin.end();
            await ownerExited;

            const result = await reapUnitChromaOrphans({repoRoot, tempRoot});

            expect(result).toEqual([{dataDir, status: 'reaped'}]);
            expect(fs.existsSync(dataDir)).toBe(false);
        } finally {
            owner.stdin.end();
            await ownerExited;
            await stopDetachedProcess(child.pid, {graceMs: 20, pollMs: 5, killWaitMs: 20});
        }
    });

    test('a real live runner protects its same-checkout detached child after setup would have exited', async () => {
        const {dataDir, logPath} = candidate('neo-chroma-unit-test-live-runner');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
        child.unref();

        try {
            writeReceipt({
                dataDir,
                logPath,
                runner: {pid: process.pid, startedAt: lstartOf(process.pid)},
                chroma: {pid: child.pid, startedAt: lstartOf(child.pid)}
            });

            const result = await reapUnitChromaOrphans({repoRoot, tempRoot});

            expect(result).toEqual([{dataDir, status: 'owner-live-or-unknown'}]);
            expect(fs.existsSync(dataDir)).toBe(true);
            process.kill(-child.pid, 0);
        } finally {
            await stopDetachedProcess(child.pid, {graceMs: 20, pollMs: 5, killWaitMs: 20});
        }
    });

    test('a live owner protects its artifacts and proves the no-op did not mutate them', async () => {
        const {dataDir, logPath} = candidate(), cleanup = [];
        writeReceipt({dataDir, logPath});

        const result = await reapUnitChromaOrphans({
            repoRoot, tempRoot,
            killFn: () => {},
            lstartOf: pid => pid === 11001 ? 'runner' : 'chroma',
            cleanupArtifacts: options => cleanup.push(options)
        });

        expect(result).toEqual([{dataDir, status: 'owner-live-or-unknown'}]);
        expect(cleanup).toEqual([]);
        expect(fs.existsSync(dataDir)).toBe(true);
    });

    test('a reused Chroma PID is protected before any stop or cleanup', async () => {
        const {dataDir, logPath} = candidate(), calls = [];
        writeReceipt({dataDir, logPath});

        const result = await reapUnitChromaOrphans({
            repoRoot, tempRoot,
            killFn: pid => { if (pid === 11001) return deadKill(pid, 0) },
            lstartOf: () => 'different-birth',
            stopProcess: async () => { calls.push('stop'); return {groupEmpty: true} },
            cleanupArtifacts: () => calls.push('cleanup')
        });

        expect(result).toEqual([{dataDir, status: 'chroma-live-or-unknown'}]);
        expect(calls).toEqual([]);
    });

    test('an already-dead Chroma cleans only after its group is proven empty', async () => {
        const {dataDir, logPath} = candidate('neo-chroma-unit-test-already-dead'), calls = [];
        writeReceipt({dataDir, logPath});

        const result = await reapUnitChromaOrphans({
            repoRoot, tempRoot,
            killFn: deadKill,
            lstartOf: () => null,
            stopProcess: async () => { calls.push('stop'); return {groupEmpty: true} },
            cleanupArtifacts: () => calls.push('cleanup')
        });

        expect(result).toEqual([{dataDir, status: 'reaped'}]);
        expect(calls).toEqual(['cleanup']);
    });

    test('EPERM and a failed group stop stay protected', async () => {
        const eperm = candidate('neo-chroma-unit-test-eperm'), failed = candidate('neo-chroma-unit-test-failed-group');
        writeReceipt({dataDir: eperm.dataDir, logPath: eperm.logPath});
        writeReceipt({dataDir: failed.dataDir, logPath: failed.logPath, runner: {pid: 12001, startedAt: 'runner-2'}, chroma: {pid: 12002, startedAt: 'chroma-2'}});

        const cleanup = [];
        const result = await reapUnitChromaOrphans({
            repoRoot, tempRoot,
            killFn: pid => {
                if (pid === 11001) { const error = new Error('denied'); error.code = 'EPERM'; throw error }
                if (pid === 12001) return deadKill(pid, 0);
            },
            lstartOf: pid => pid === 12002 ? 'chroma-2' : null,
            stopProcess: async () => ({groupEmpty: false}),
            cleanupArtifacts: () => cleanup.push('cleanup')
        });

        expect(result.map(item => item.status).sort()).toEqual(['group-not-empty', 'owner-live-or-unknown']);
        expect(cleanup).toEqual([]);
    });

    test('foreign, malformed, legacy, and symlink candidates stay untouched', async () => {
        const foreign = candidate('neo-chroma-unit-test-foreign'), malformed = candidate('neo-chroma-unit-test-malformed'), legacy = candidate('neo-chroma-unit-test-legacy');
        writeReceipt({dataDir: foreign.dataDir, logPath: foreign.logPath, receiptRepoRoot: path.join(tempRoot, 'other-checkout')});
        fs.writeFileSync(path.join(malformed.dataDir, '.neo-unit-chroma-owner.json'), '{bad json');
        const target = path.join(tempRoot, 'neo-chroma-unit-test-target');
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(tempRoot, 'neo-chroma-unit-test-symlink'));

        const result = await reapUnitChromaOrphans({repoRoot, tempRoot, killFn: deadKill, lstartOf: () => null});

        expect(result.map(item => item.status).sort()).toEqual(['untrusted-receipt', 'untrusted-receipt', 'untrusted-receipt', 'untrusted-receipt']);
        for (const dir of [foreign.dataDir, malformed.dataDir, legacy.dataDir, target]) expect(fs.existsSync(dir)).toBe(true);
    });

    test('a same-prefix log from another generated run, a held lock, and a changed second identity are no-ops', async () => {
        const logMismatch = candidate('neo-chroma-unit-test-log-a'), other = candidate('neo-chroma-unit-test-log-b'), locked = candidate('neo-chroma-unit-test-locked'), changed = candidate('neo-chroma-unit-test-changed');
        writeReceipt({dataDir: logMismatch.dataDir, logPath: other.logPath});
        writeReceipt({dataDir: locked.dataDir, logPath: locked.logPath});
        writeReceipt({dataDir: changed.dataDir, logPath: changed.logPath, runner: {pid: 13001, startedAt: 'runner-3'}, chroma: {pid: 13002, startedAt: 'chroma-3'}});
        const lockFd = fs.openSync(path.join(locked.dataDir, '.neo-unit-chroma-reap.lock'), 'wx');
        let chromaReads = 0, cleanup = 0, stops = 0;

        try {
            const result = await reapUnitChromaOrphans({
                repoRoot, tempRoot,
                killFn: pid => { if (pid === 13001) return deadKill(pid, 0) },
                lstartOf: pid => pid === 13002 ? (++chromaReads === 1 ? 'chroma-3' : 'reused-birth') : null,
                stopProcess: async () => { stops++; return {groupEmpty: true} },
                cleanupArtifacts: () => { cleanup++ }
            });

            expect(result.map(item => item.status).sort()).toEqual(['identity-changed', 'locked-or-unavailable', 'untrusted-receipt', 'untrusted-receipt']);
            expect({cleanup, stops}).toEqual({cleanup: 0, stops: 0});
        } finally {
            fs.closeSync(lockFd);
            fs.unlinkSync(path.join(locked.dataDir, '.neo-unit-chroma-reap.lock'));
        }
    });

    test('recording returns false for explicit pins and unsupported platforms', () => {
        const {dataDir, logPath} = candidate();

        expect(recordUnitChromaOwnership({repoRoot, dataDir, logPath, ownsDataDir: false, runnerPid: 1, chromaPid: 2})).toBe(false);
        expect(recordUnitChromaOwnership({repoRoot, dataDir, logPath, ownsDataDir: true, runnerPid: 1, chromaPid: 2, platform: 'win32'})).toBe(false);
    });

    test('records a live direct-temp receipt and rejects a mutated receipt without touching artifacts', async () => {
        const dataDir = path.join(os.tmpdir(), `neo-chroma-unit-test-record-${process.pid}-${Date.now()}`), logPath = `${dataDir}.log`;
        fs.mkdirSync(dataDir);
        fs.writeFileSync(logPath, 'record');

        try {
            expect(recordUnitChromaOwnership({
                repoRoot, dataDir, logPath, ownsDataDir: true,
                runnerPid: process.pid, chromaPid: process.pid, lstartOf: () => null
            })).toBe(false);

            const receiptPath = recordUnitChromaOwnership({
                repoRoot, dataDir, logPath, ownsDataDir: true, runnerPid: process.pid, chromaPid: process.pid
            });
            expect(receiptPath).toBe(path.join(dataDir, '.neo-unit-chroma-owner.json'));

            const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
            receipt.repoRoot = `${receipt.repoRoot}-mutated`;
            fs.writeFileSync(receiptPath, JSON.stringify(receipt));

            const result = await reapUnitChromaOrphans({
                repoRoot,
                tempRoot: os.tmpdir(),
                readdirSync: () => [{name: path.basename(dataDir), isDirectory: () => true, isSymbolicLink: () => false}]
            });

            expect(result).toEqual([{dataDir, status: 'untrusted-receipt'}]);
            expect(fs.existsSync(dataDir)).toBe(true);
        } finally {
            fs.rmSync(dataDir, {force: true, recursive: true});
            fs.rmSync(logPath, {force: true});
        }
    });
});
