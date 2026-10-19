import {expect, test} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {
    RUNTIME_GENERATION_RECORD,
    bindCurrentRuntime,
    isRuntimeGenerationPin,
    readRuntimeGeneration,
    readRuntimeGenerationRecord,
    runtimeGenerationIdentity,
    runtimeGenerationArguments,
    runtimeGenerationPin,
    PACKAGE_SLOTS_RECORD,
    PACKAGE_RECEIPT_PATH,
    readPackageSlotRecord,
    readInstalledRuntimeGeneration,
    validatePackageSlotRecord
} from '../../../../../../ai/services/fleet/runtimeGeneration.mjs';
import {changePayloadBytes, removeSealed, sealRuntimeGeneration} from './fixtures/sealedRuntimeGeneration.mjs';

let root;
test.beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-verifier-'))); });
test.afterEach(async () => { await removeSealed(root); });

/** @summary Writes the installer's existing location format in a private disposable root. */
async function slotsFixture() {
    const installed = path.join(root, 'Installed.app'), rollback = path.join(root, 'Rollback'), parked = path.join(root, 'Parked');
    const receipt   = {electronVersion: '43.5.0', owners: Object.fromEntries(['product', 'brain', 'engine'].map((name, i) =>
        [name, {revision: String(i + 1).repeat(40)}]))};
    const file = path.join(installed, PACKAGE_RECEIPT_PATH);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, JSON.stringify(receipt));
    const record = {version: 1, directory: root, completedAt: '2026-10-15T13:00:00Z',
        completionId: '12345678-1234-4234-8234-123456789abc', selectedPaths: [installed, rollback, parked],
        slots       : [{path: installed, exists: true, receipt}, {path: rollback, exists: false, receipt: null},
            {path: parked, exists: false, receipt: null}]};
    await fs.writeFile(path.join(root, PACKAGE_SLOTS_RECORD), JSON.stringify(record), {mode: 0o600});
    return {record, file, receipt};
}

test('installed identity comes from the verified slot receipt, independently of a serving runtime', async () => {
    expect(readInstalledRuntimeGeneration({directory: root})).toMatchObject({state: 'unknown', reason: 'package-slots-unrecorded'});
    const {record, receipt} = await slotsFixture();
    expect(readPackageSlotRecord({directory: root})).toEqual(record);
    expect(readInstalledRuntimeGeneration({directory: root})).toEqual({state: 'observed', ...runtimeGenerationIdentity(receipt), reason: null});
    expect(validatePackageSlotRecord(record, root)).toEqual(record);
});

test('changed installed contents, redirected metadata and malformed location records stay unknown', async () => {
    const {record, file, receipt} = await slotsFixture();
    await fs.writeFile(file, JSON.stringify({...receipt, changed: true}));
    expect(readInstalledRuntimeGeneration({directory: root})).toMatchObject({state: 'unknown', reason: 'installed-slot-changed'});
    await fs.writeFile(file, JSON.stringify(receipt));
    const slotFile = path.join(root, PACKAGE_SLOTS_RECORD);
    await fs.chmod(slotFile, 0o666);
    expect(readInstalledRuntimeGeneration({directory: root}).state).toBe('unknown');
    await fs.chmod(slotFile, 0o600);
    await fs.writeFile(slotFile, JSON.stringify({...record, extra: true}));
    expect(readInstalledRuntimeGeneration({directory: root}).state).toBe('unknown');
});

const fixture = () => sealRuntimeGeneration(root);

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

test('the record read returns the full read\'s descriptor and leaves changed payload bytes to the full read', async () => {
    const input = await fixture(), verified = await readRuntimeGeneration({directory: input.directory});
    expect(await readRuntimeGenerationRecord({directory: input.directory})).toEqual(verified);
    await changePayloadBytes(input);
    await expect(readRuntimeGeneration({directory: input.directory})).rejects.toMatchObject({code: 'runtime-integrity-failed'});
    expect(await readRuntimeGenerationRecord({directory: input.directory})).toEqual(verified)
});

// Both reads refuse everything but the payload's bytes alike.
for (const read of [readRuntimeGeneration, readRuntimeGenerationRecord]) {
    test(`${read.name}: missing or incompatible launcher protocol refuses a sealed generation`, async () => {
        const input = await fixture(), file = path.join(input.directory, RUNTIME_GENERATION_RECORD);
        await fs.chmod(file, 0o600);
        for (const protocol of [undefined, 'unsupported']) {
            const record = structuredClone(input.record);
            record.compatibility.launchProtocol = protocol;
            await fs.writeFile(file, JSON.stringify(record));
            await expect(read({directory: input.directory})).rejects.toMatchObject({code: 'runtime-compatibility-failed'});
        }
    });

    test(`${read.name}: missing, unsealed and incompatible generations remain distinct refusals`, async () => {
        expect(await read({directory: path.join(root, 'absent')})).toBeNull();
        const input = await fixture();
        await expect(read({directory: input.directory, arch: 'different'}))
            .rejects.toMatchObject({code: 'runtime-compatibility-failed'});
        await fs.chmod(input.directory, 0o700);
        await expect(read({directory: input.directory})).rejects.toMatchObject({code: 'runtime-generation-invalid'});
    });

    test(`${read.name}: an escaping executable binding cannot be made valid by retaining the payload digest`, async () => {
        const input = await fixture(), file = path.join(input.directory, RUNTIME_GENERATION_RECORD);
        await fs.chmod(file, 0o600);
        await fs.writeFile(file, JSON.stringify({...input.record, executableRelativePath: '../../outside'}));
        await fs.chmod(file, 0o400);
        await expect(read({directory: input.directory})).rejects.toMatchObject({code: 'runtime-binding-invalid'});
    });
}

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
