import fs   from 'node:fs/promises';
import path from 'node:path';
import {
    RUNTIME_GENERATION_PAYLOAD,
    RUNTIME_GENERATION_RECORD,
    completeRuntimeGenerationRecord,
    createRuntimeGenerationRecord,
    inventoryRuntimePayload,
    runtimeGenerationIdentity
} from '../../../../../../../ai/services/fleet/runtimeGeneration.mjs';

/**
 * @module test/playwright/unit/ai/services/fleet/fixtures/sealedRuntimeGeneration
 * @summary One sealed runtime generation in a disposable root, built with the format constructors the host consumes.
 */

/**
 * @summary Builds and seals one generation under `root`, its directory named by its identity.
 * @param {String} root A canonical (realpath) disposable directory.
 * @returns {Promise<{directory: String, runtimeRoot: String, executable: String, retainedVerifier: String, record: Object}>}
 */
export async function sealRuntimeGeneration(root) {
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

/** @summary Rewrites the executable after publication with its mode kept: only a payload re-hash can tell. */
export async function changePayloadBytes({executable}) {
    await fs.chmod(executable, 0o755);
    await fs.writeFile(executable, 'changed payload');
    await fs.chmod(executable, 0o555);
}

/** @summary Unlocks only fixture directories, never following links during cleanup. */
export async function removeSealed(file) {
    const stat = await fs.lstat(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await fs.chmod(file, 0o700);
        for (const name of await fs.readdir(file)) await removeSealed(path.join(file, name));
    }
    await fs.rm(file, {recursive: true, force: true});
}
