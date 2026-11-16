import fs   from 'node:fs/promises';
import path from 'node:path';
import {
    RUNTIME_GENERATION_PAYLOAD,
    RUNTIME_GENERATION_RECORD,
    completeRuntimeGenerationRecord,
    createRuntimeGenerationRecord,
    describeCodexWakeArtifact,
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
 * @param {Object} [options]
 * @param {String} [options.revision='a'] One hex digit of the product revision, so one root can hold distinct generations.
 * @param {Boolean} [options.codexWake=false] Include a sealed test hook and its protocol declaration.
 * @param {String|null} [options.codexWire='neo-codex-primary-wake-v1'] The declared protocol, or null to omit it.
 * @param {String} [options.artifactConsumer] Stage a declared shared artifact with these consumer bytes.
 * @returns {Promise<{directory: String, runtimeRoot: String, executable: String, retainedVerifier: String, record: Object}>}
 */
export async function sealRuntimeGeneration(root, {revision = 'a', codexWake = false,
    codexWire = 'neo-codex-primary-wake-v1', artifactConsumer} = {}) {
    const receipt = {electronVersion: '43.5.0', owners: {
        product: {revision: revision.repeat(40)}, brain: {revision: 'b'.repeat(40)}, engine: {revision: 'c'.repeat(40)}
    }};
    const identity         = runtimeGenerationIdentity(receipt), directory = path.join(root, identity.id);
    const payloadRoot      = path.join(directory, RUNTIME_GENERATION_PAYLOAD);
    const runtimeRoot      = path.join(payloadRoot, 'Contents/Resources/organism');
    const executable       = path.join(payloadRoot, 'Contents/MacOS', artifactConsumer ? 'Neo Harness' : 'Host');
    const retainedVerifier = path.join(runtimeRoot, 'ai/services/fleet/runtimeGeneration.mjs');
    await fs.mkdir(path.dirname(retainedVerifier), {recursive: true});
    await fs.mkdir(path.dirname(executable), {recursive: true});
    await fs.writeFile(path.join(runtimeRoot, 'organism-build-info.json'), JSON.stringify(receipt));
    await fs.writeFile(executable, 'fixture executable', {mode: 0o755});
    await fs.writeFile(retainedVerifier, 'throw Error("the retained verifier must never be loaded");');
    let declaration;
    if (codexWake || artifactConsumer) {
        const wake = path.join(runtimeRoot, 'ai/daemons/wake');
        await fs.mkdir(wake, {recursive: true});
        await fs.writeFile(path.join(wake, 'codexWakeHook.mjs'), '// sealed test hook\n');
        await fs.writeFile(path.join(wake, 'fleetPrimarySessionWake.mjs'), artifactConsumer || '// sealed test consumer\n');
        if (codexWire !== null) {
            await fs.writeFile(path.join(wake, 'codexWakeProtocol.json'), JSON.stringify({wire: codexWire}))
        }
    }
    if (artifactConsumer) {
        declaration = {version:1, wire:codexWire, files:['ai/daemons/wake/codexWakeHook.mjs','ai/daemons/wake/fleetPrimarySessionWake.mjs'], packages:[]};
        await fs.writeFile(path.join(runtimeRoot, 'codex-wake-artifact.json'), JSON.stringify(declaration));
        await fs.writeFile(path.join(runtimeRoot, 'package.json'), JSON.stringify({productRevision:revision}));
        await fs.mkdir(path.join(payloadRoot, 'Contents/Frameworks'));
        for (const file of ['Info.plist','PkgInfo']) await fs.writeFile(path.join(payloadRoot,'Contents',file),file)
    }
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
    let artifactRoot;
    if (declaration) {
        const {entries,digest} = describeCodexWakeArtifact({declaration,entries:payload.entries});
        artifactRoot = path.join(root, 'wake-artifacts-v1', digest);
        try {
            await fs.access(artifactRoot)
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            for (const [name,kind] of entries) {
                const file = path.join(artifactRoot,name);
                if (kind === 'directory') await fs.mkdir(file,{recursive:true});
                else await fs.copyFile(path.join(payloadRoot,name),file)
            }
            for (const [name,,mode] of [...entries].reverse()) await fs.chmod(path.join(artifactRoot,name),mode)
        }
    }
    return {directory, runtimeRoot, executable, retainedVerifier, record, artifactRoot};
}

/** @summary Rewrites the executable after publication with its mode kept: only a payload re-hash can tell. */
export async function changePayloadBytes({executable}) {
    await fs.chmod(executable, 0o755);
    await fs.writeFile(executable, 'changed payload');
    await fs.chmod(executable, 0o555);
}

/** @summary Adds a link escaping the payload after publication; the record and every binding stay intact. */
export async function addEscapingLink({runtimeRoot}) {
    const mode = (await fs.stat(runtimeRoot)).mode & 0o777;
    await fs.chmod(runtimeRoot, 0o755);
    await fs.symlink('/etc', path.join(runtimeRoot, 'escape'));
    await fs.chmod(runtimeRoot, mode);
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
