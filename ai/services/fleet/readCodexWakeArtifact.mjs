import {createHash}                                                                                                                   from 'node:crypto';
import {bundleFs}                                                                                                                     from './inspectAppBundle.mjs';
import path                                                                                                                           from 'node:path';
import {inventoryRuntimePayload, isRuntimeGenerationPin, RUNTIME_GENERATION_PAYLOAD, RUNTIME_GENERATION_RECORD, runtimeGenerationPin} from './runtimeGeneration.mjs';
import {CODEX_WAKE_ARTIFACT_DECLARATION, CODEX_WAKE_ARTIFACT_ROOT, CODEX_WAKE_EXECUTABLE, CODEX_WAKE_MODULE,
    CODEX_WAKE_ORGANISM, CODEX_WAKE_PROTOCOL, CODEX_WAKE_WIRE, describeCodexWakeArtifact} from './codexWakeArtifact.mjs';

const fs      = bundleFs.promises;
const digest  = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(new Error('Codex wake package or retained artifact is unproven'), {code:'CODEX_WAKE_COMPATIBILITY_UNPROVEN'});

/** @summary Compare the kernel identities of every inventoried entry, including directories and symlinks. */
async function stamps(files) {
    const result = [];
    for (let offset = 0; offset < files.length; offset += 64) {
        const batch = await Promise.all(files.slice(offset, offset + 64).map(file => fs.lstat(file, {bigint:true})));
        for (const stat of batch) result.push([stat.dev, stat.ino, stat.ctimeNs, stat.mode, stat.size].join(':'))
    }
    return result.join('\n')
}

/** @summary Read one canonical, sealed, regular file. A missing manifest member never means legacy. */
async function member(root, name, entries) {
    const file = path.join(root, name), row = entries.find(([key]) => key === name);
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error });
    if (!row && !stat) return undefined;
    if (row?.[1] !== 'file' || !stat?.isFile() || stat.mode & 0o222 || stat.size !== row[3] ||
        await fs.realpath(file) !== file) throw invalid();
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== row[4]) throw invalid();
    return JSON.parse(bytes)
}

/**
 * @summary Resolves a packaged Start's wake artifact. The held pin authenticates the generation manifest;
 * its sealed declaration selects the required inventory, which must match the shared tree in full.
 * Only an absent declaration in both the sealed tree and manifest selects legacy preparation.
 * @param {Object} generation The trusted Start generation or its closed pin.
 * @param {Function} [retain] Accepts a cheap custody recheck scoped to this Start, for its receiver sends.
 * @returns {Promise<Object|null>} Executable and hook paths, or null for an earlier package.
 */
export async function readCodexWakeArtifact(generation, retain) {
    try {
        const pin       = isRuntimeGenerationPin(generation) ? generation : runtimeGenerationPin(generation);
        const directory = pin.directory, payload = path.join(directory, RUNTIME_GENERATION_PAYLOAD);
        const stat      = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.mode & 0o222 || await fs.realpath(directory) !== directory) throw invalid();
        const manifestPath = path.join(directory, RUNTIME_GENERATION_RECORD), manifestStat = await fs.lstat(manifestPath);
        if (!manifestStat.isFile() || manifestStat.mode & 0o222) throw invalid();
        const record = JSON.parse(await fs.readFile(manifestPath,'utf8'));
        if (record.id !== pin.id || record.payloadDigest !== pin.payloadDigest || digest(JSON.stringify(record.entries)) !== pin.payloadDigest) throw invalid();
        const relative = path.relative(payload, pin.runtimeRoot);
        if (record.runtimeRelativePath !== relative || record.executableRelativePath !== path.relative(payload, pin.executable)) throw invalid();
        const declarationPath = path.join(relative, CODEX_WAKE_ARTIFACT_DECLARATION);
        const declaration     = await member(payload, declarationPath, record.entries);
        if (declaration === undefined) return null;
        if (pin.runtimeRoot !== path.join(payload, CODEX_WAKE_ORGANISM) || pin.executable !== path.join(payload,CODEX_WAKE_EXECUTABLE) ||
            record.runtimeRelativePath !== CODEX_WAKE_ORGANISM || record.executableRelativePath !== CODEX_WAKE_EXECUTABLE ||
            (await member(payload, CODEX_WAKE_ORGANISM + '/' + CODEX_WAKE_PROTOCOL, record.entries))?.wire !== CODEX_WAKE_WIRE) throw invalid();
        const wanted = describeCodexWakeArtifact({declaration, entries:record.entries});
        const root   = path.join(path.dirname(directory), CODEX_WAKE_ARTIFACT_ROOT, wanted.digest);
        if (await fs.realpath(root) !== root) throw invalid();
        const files = retain && [directory, path.join(directory, RUNTIME_GENERATION_RECORD), path.join(payload,declarationPath),
            ...wanted.entries.map(([name]) => path.join(root, name))];
        const before = files && await stamps(files);
        if ((await inventoryRuntimePayload(root)).digest !== wanted.digest) throw invalid();
        if (retain) {
            const unchanged = async () => await fs.realpath(root) === root && await stamps(files) === before;
            if (!await unchanged()) throw invalid();
            retain(unchanged)
        }
        return {nodePath:path.join(root, CODEX_WAKE_EXECUTABLE), hookModulePath:path.join(root, CODEX_WAKE_ORGANISM, CODEX_WAKE_MODULE)}
    } catch { throw invalid() }
}
