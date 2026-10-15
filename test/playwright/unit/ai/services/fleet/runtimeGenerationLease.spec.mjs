import {expect, test}     from '@playwright/test';
import fs                 from 'node:fs/promises';
import os                 from 'node:os';
import path               from 'node:path';
import {spawn}            from 'node:child_process';
import {once}             from 'node:events';
import {acquireFileLease} from '../../../../../../ai/daemons/shared/fileLease.mjs';
import {assertRuntimeGenerationReferences, holdRuntimeGenerationReferences, RUNTIME_REFERENCE_LEASE,
        waitForRuntimeGenerationReferences} from '../../../../../../ai/services/fleet/runtimeGenerationLease.mjs';

let root;
test.beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-reference-lease-'))); });
test.afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });

/** @summary Signals actual lease contention rather than waiting an assumed amount of wall time. */
function contender() {
    let observed;
    const blocked = new Promise(resolve => { observed = resolve; });
    return {blocked, acquireLease(options) {
        try { return acquireFileLease(options); }
        catch (error) { observed(); throw error; }
    }};
}

test('a second reference transaction cannot enter before the first releases', async () => {
    const first   = holdRuntimeGenerationReferences({directory: root}), next = contender();
    let   entered = false;
    const pending = waitForRuntimeGenerationReferences({directory: root, acquireLease: next.acquireLease})
        .then(guard => { entered = true; return guard; });
    await next.blocked;
    expect(entered).toBe(false);
    first.assertCurrent();
    expect(first.release()).toBe(true);
    const second = await pending;
    second.assertCurrent();
    expect(second.release()).toBe(true);
    await expect(fs.stat(path.join(root, RUNTIME_REFERENCE_LEASE))).rejects.toMatchObject({code: 'ENOENT'});
});

test('Stop cancels a waiting Start without releasing the current holder', async () => {
    const held     = holdRuntimeGenerationReferences({directory: root}), next = contender(), abort = new AbortController();
    const pending  = waitForRuntimeGenerationReferences({directory: root, acquireLease: next.acquireLease, signal: abort.signal});
    const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await next.blocked;
    abort.abort();
    await rejected;
    held.assertCurrent();
    expect(held.release()).toBe(true);
});

test('unknown or redirected custody refuses instead of waiting or claiming vacancy', async () => {
    await fs.writeFile(path.join(root, RUNTIME_REFERENCE_LEASE), 'corrupt');
    await expect(waitForRuntimeGenerationReferences({directory: root})).rejects.toMatchObject({code: 'FILE_LEASE_HELD', holder: null});
    await fs.unlink(path.join(root, RUNTIME_REFERENCE_LEASE));
    const link = path.join(root, 'redirect');
    await fs.symlink(root, link);
    await expect(waitForRuntimeGenerationReferences({directory: link})).rejects.toMatchObject({code: 'FILE_LEASE_GUARD_REFUSED'});
});

test('an already canceled Start does not acquire a lease', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(waitForRuntimeGenerationReferences({directory: root, signal: abort.signal})).rejects.toMatchObject({name: 'AbortError'});
    await expect(fs.stat(path.join(root, RUNTIME_REFERENCE_LEASE))).rejects.toMatchObject({code: 'ENOENT'});
});

test('direct callers cannot forge, redirect or reuse a released guard', () => {
    expect(() => assertRuntimeGenerationReferences({assertCurrent() {}}, root)).toThrow(/not guarded/);
    const held = holdRuntimeGenerationReferences({directory: root});
    expect(() => assertRuntimeGenerationReferences(held, root + '-other')).toThrow(/not guarded/);
    assertRuntimeGenerationReferences(held, root);
    held.release();
    expect(() => assertRuntimeGenerationReferences(held, root)).toThrow(/guard-closed/);
});

test('a separate process observes the same reference exclusion and acquires only after release', async () => {
    const held      = holdRuntimeGenerationReferences({directory: root});
    const moduleUrl = new URL('../../../../../../ai/services/fleet/runtimeGenerationLease.mjs', import.meta.url).href;
    const leaseUrl  = new URL('../../../../../../ai/daemons/shared/fileLease.mjs', import.meta.url).href;
    const source    = `import {waitForRuntimeGenerationReferences} from ${JSON.stringify(moduleUrl)};
        import {acquireFileLease} from ${JSON.stringify(leaseUrl)};
        const guard = await waitForRuntimeGenerationReferences({directory: process.argv[1], acquireLease(options) {
            try { return acquireFileLease(options); }
            catch (error) { process.stdout.write('blocked\\n'); throw error; }
        }});
        process.stdout.write('acquired\\n');
        guard.release();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], {
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000
    });
    const ended   = once(child, 'exit');
    let   output  = '', errors = '', signalBlocked;
    const blocked = new Promise(resolve => { signalBlocked = resolve; });
    child.stdout.on('data', value => { output += value; if (output.includes('blocked\n')) signalBlocked(); });
    child.stderr.on('data', value => { errors += value; });
    try {
        await Promise.race([blocked, ended.then(() => { throw Error('contender exited before observing exclusion: ' + errors); })]);
        expect(output).not.toContain('acquired');
        held.assertCurrent();
        expect(held.release()).toBe(true);
        expect((await ended)[0]).toBe(0);
        expect(output).toContain('acquired\n');
        expect(errors).toBe('');
    } finally {
        held.release();
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
    }
});
