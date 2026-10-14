import {expect, test} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {
    RUNTIME_GENERATION_PAYLOAD,
    RUNTIME_GENERATION_RECORD,
    bindCurrentRuntime,
    completeRuntimeGenerationRecord,
    createRuntimeGenerationRecord,
    inventoryRuntimePayload,
    isRuntimeGenerationPin,
    readRuntimeGeneration,
    runtimeGenerationIdentity,
    runtimeGenerationArguments,
    runtimeGenerationPin
} from '../../../../../../ai/services/fleet/runtimeGeneration.mjs';

let root;
test.beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-verifier-'))); });

/** @summary Unlocks only fixture directories, never following links during cleanup. */
async function remove(file) {
    const stat = await fs.lstat(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await fs.chmod(file, 0o700);
        for (const name of await fs.readdir(file)) await remove(path.join(file, name));
    }
    await fs.rm(file, {recursive: true, force: true});
}
test.afterEach(async () => { await remove(root); });

/** @summary Builds one sealed fixture using the same format constructor the host consumes. */
async function fixture() {
    const receipt = {electronVersion: '43.5.0', owners: {
        product: {revision: 'a'.repeat(40)}, brain: {revision: 'b'.repeat(40)}, engine: {revision: 'c'.repeat(40)}
    }};
    const identity         = runtimeGenerationIdentity(receipt), directory = path.join(root, identity.id);
    const payloadRoot      = path.join(directory, RUNTIME_GENERATION_PAYLOAD);
    const runtimeRoot      = path.join(payloadRoot, 'Contents/Resources/organism');
    const executable       = path.join(payloadRoot, 'Contents/MacOS/Host');
    const retainedVerifier = path.join(runtimeRoot, 'ai/services/fleet/runtimeGeneration.mjs');
    await fs.mkdir(path.dirname(retainedVerifier), {recursive: true});
    await fs.mkdir(path.dirname(executable), {recursive: true});
    await fs.writeFile(path.join(runtimeRoot, 'organism-build-info.json'), JSON.stringify(receipt));
    await fs.writeFile(executable, 'fixture executable', {mode: 0o755});
    await fs.writeFile(retainedVerifier, 'throw Error("the retained verifier must never be loaded");');
    const payload = await inventoryRuntimePayload(payloadRoot, true);
    for (const [relative, kind, mode] of [...payload.entries].reverse()) {
        if (kind !== 'link') await fs.chmod(path.join(payloadRoot, relative), mode);
    }
    const draft = createRuntimeGenerationRecord({
        identity, payload, runtimeRelativePath: path.relative(payloadRoot, runtimeRoot),
        executableRelativePath: path.relative(payloadRoot, executable), createdAt: '2026-10-14T00:00:00.000Z'
    });
    const record = completeRuntimeGenerationRecord(draft, {
        platform      : process.platform, arch: process.arch, electronVersion: '43.5.0', nodeVersion: '24.19.0', moduleAbi: '148',
        launchProtocol: 'neo-fleet-mcp-launch/v1',
        unclassified  : 'not part of the format'
    });
    await fs.writeFile(path.join(directory, RUNTIME_GENERATION_RECORD), JSON.stringify(record), {mode: 0o400});
    await fs.chmod(directory, 0o500);
    return {directory, runtimeRoot, executable, retainedVerifier, record};
}

test('the producer and reader share one format and preserve the distinct runtime and executable bindings', async () => {
    const input = await fixture();
    expect(await readRuntimeGeneration({directory: input.directory})).toMatchObject({
        id           : path.basename(input.directory), runtimeRoot: input.runtimeRoot, executable: input.executable,
        payloadDigest: input.record.payloadDigest, compatibility: {nodeVersion: '24.19.0', moduleAbi: '148', launchProtocol: 'neo-fleet-mcp-launch/v1'}
    });
    expect(input.record.compatibility).not.toHaveProperty('unclassified');
    const pin = runtimeGenerationPin(await readRuntimeGeneration({directory: input.directory}));
    expect(isRuntimeGenerationPin(pin)).toBe(true);
    expect(isRuntimeGenerationPin({...pin, env: {secret: 'not permitted'}})).toBe(false);
    expect(() => runtimeGenerationPin({...pin, executable: '/outside/node'})).toThrow(/runtime-binding-invalid/);
});

test('a tampered retained verifier cannot approve another changed payload byte', async () => {
    const input = await fixture();
    await fs.chmod(input.retainedVerifier, 0o644);
    await fs.writeFile(input.retainedVerifier, 'globalThis.retainedVerifierRan=true; export async function readRuntimeGeneration(){return {approved:true}}');
    await fs.chmod(input.retainedVerifier, 0o444);
    await fs.chmod(input.executable, 0o755);
    await fs.writeFile(input.executable, 'changed payload');
    await fs.chmod(input.executable, 0o555);
    await expect(readRuntimeGeneration({directory: input.directory})).rejects.toMatchObject({code: 'runtime-integrity-failed'});
    expect(globalThis.retainedVerifierRan).toBeUndefined();
});

test('missing, unsealed and incompatible generations remain distinct refusals', async () => {
    expect(await readRuntimeGeneration({directory: path.join(root, 'absent')})).toBeNull();
    const input = await fixture();
    await expect(readRuntimeGeneration({directory: input.directory, arch: 'different'}))
        .rejects.toMatchObject({code: 'runtime-compatibility-failed'});
    await fs.chmod(input.directory, 0o700);
    await expect(readRuntimeGeneration({directory: input.directory})).rejects.toMatchObject({code: 'runtime-generation-invalid'});
});

test('an escaping executable binding cannot be made valid by retaining the payload digest', async () => {
    const input = await fixture(), file = path.join(input.directory, RUNTIME_GENERATION_RECORD);
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, JSON.stringify({...input.record, executableRelativePath: '../../outside'}));
    await fs.chmod(file, 0o400);
    await expect(readRuntimeGeneration({directory: input.directory})).rejects.toMatchObject({code: 'runtime-binding-invalid'});
});

test('Fleet binds the exact running generation and a packaged process cannot omit it', async () => {
    const input      = await fixture();
    const generation = await readRuntimeGeneration({directory: input.directory});
    const options    = {runtimeRoot: input.runtimeRoot, executable: input.executable};
    await expect(bindCurrentRuntime({...options, args: runtimeGenerationArguments(generation)}))
        .resolves.toEqual({...options, generation});
    await expect(bindCurrentRuntime({...options, args: []})).rejects.toMatchObject({code: 'runtime-generation-required'});
    await expect(bindCurrentRuntime({...options, args: runtimeGenerationArguments(generation), executable: process.execPath}))
        .rejects.toMatchObject({code: 'runtime-binding-invalid'});
    await expect(bindCurrentRuntime({...options, args: [...runtimeGenerationArguments(generation), ...runtimeGenerationArguments(generation)]}))
        .rejects.toMatchObject({code: 'runtime-binding-invalid'});
});

test('a real checkout stays explicit and an invalid package marker never becomes checkout mode', async () => {
    const options = {runtimeRoot: root, executable: await fs.realpath(process.execPath), args: []};
    await expect(bindCurrentRuntime(options)).resolves.toEqual({runtimeRoot: root, executable: options.executable, generation: null});
    await fs.writeFile(path.join(root, 'organism-build-info.json'), '{broken');
    await expect(bindCurrentRuntime(options)).rejects.toMatchObject({code: 'runtime-receipt-invalid'});
});
