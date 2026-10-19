import {createHash}                from 'node:crypto';
import nodeFs                      from 'node:fs';
import {createRequire}             from 'node:module';
import path                        from 'node:path';
import {isDeepStrictEqual}         from 'node:util';
import {LAUNCH_ADMISSION_PROTOCOL} from './mcpLaunchAdmission.mjs';

export {LAUNCH_ADMISSION_PROTOCOL};

/**
 * @module ai/services/fleet/runtimeGeneration
 * @summary The runtime-generation format and read-only verifier shared by publication and admission.
 * The caller's trusted package loads this module; code from the tree being verified is never imported.
 * Copying, compatibility execution, publication and retirement remain host lifecycle operations.
 */
export const RUNTIME_GENERATION_RECORD = 'generation.json';
export const RUNTIME_GENERATION_PAYLOAD = 'host.runtime';
export const PACKAGE_SLOTS_RECORD = '.package-slots.json';
export const PACKAGE_RECEIPT_PATH = path.join('Contents', 'Resources', 'organism', 'organism-build-info.json');
export const MAX_PACKAGE_SLOT_BYTES = 262144;
const RUNTIME_ARGUMENT = '--neo-runtime-generation=';

const RECORD = RUNTIME_GENERATION_RECORD, PAYLOAD = RUNTIME_GENERATION_PAYLOAD;

// The manifest describes physical package bytes. Electron's ASAR view synthesizes inode values
// and turns archives into directories; retain the original filesystem without a global noAsar toggle.
const fsSync = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;
const fs     = fsSync.promises, {createReadStream} = fsSync;

/** @summary Creates a named refusal without turning an unknown binding into a fallback. */
function refusal(code, detail, cause) {
    return Object.assign(new Error(code + ': ' + detail, cause ? {cause} : undefined), {code})
}

/** @summary Hashes one canonical manifest or identity serialization. */
function hash(value) {
    return createHash('sha256').update(value).digest('hex')
}

/**
 * @summary Derives the ADR's package identity, excluding location and staging timestamps.
 * @param {Object} receipt The embedded organism-build-info.json record.
 * @returns {{id: String, identity: String[]}}
 */
export function runtimeGenerationIdentity(receipt) {
    const identity = ['product', 'brain', 'engine'].map(owner => receipt?.owners?.[owner]?.revision);
    identity.push(receipt?.electronVersion);

    if (identity.slice(0, 3).some(value => typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) ||
        typeof identity[3] !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(identity[3])) {
        throw refusal('runtime-receipt-invalid', 'complete product, Brain, Engine revisions and Electron version are required')
    }

    return {id: hash(JSON.stringify(identity)), identity}
}

/** @summary Tests containment without accepting sibling paths with a shared string prefix. */
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}

/** @summary Resolves a manifest-relative binding, rejecting traversal and alternate spellings. */
function binding(root, relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) ||
        path.normalize(relative) !== relative || !inside(root, path.resolve(root, relative))) {
        throw refusal('runtime-binding-invalid', 'runtime bindings must be canonical relative paths')
    }
    return path.resolve(root, relative)
}

/** @summary Reads a record; a missing or malformed record is never inferred from directory contents. */
async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (cause) {
        throw refusal('runtime-record-invalid', file + ' cannot be read as a complete record', cause)
    }
}

/**
 * @summary Inventories bytes, permission modes and verbatim internal links in deterministic order.
 * @param {String} root Payload root, never followed through a symlink.
 * @param {Boolean} readonlyMode Compare a source tree as it will be sealed.
 * @returns {Promise<{entries: Array, digest: String}>}
 */
export async function inventoryRuntimePayload(root, readonlyMode = false) {
    const entries = [];

    /** @summary Visits one entry without following directory symlinks. */
    async function visit(relative) {
        const file = path.join(root, relative), stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) {
            const target = await fs.readlink(file);
            if (path.isAbsolute(target) || !inside(root, await fs.realpath(file))) {
                throw refusal('runtime-payload-invalid', relative + ' has a non-relocatable link')
            }
            entries.push([relative, 'link', target]);
            return
        }
        if (stat.mode & 0o7000) throw refusal('runtime-payload-invalid', relative + ' has special permission bits');
        const mode = stat.mode & (readonlyMode ? 0o555 : 0o777);
        if (stat.isDirectory()) {
            entries.push([relative, 'directory', mode]);
            for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
        } else if (stat.isFile()) {
            const digest = createHash('sha256');
            for await (const chunk of createReadStream(file)) digest.update(chunk);
            const after = await fs.lstat(file);
            if (after.ino !== stat.ino || after.size !== stat.size || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs) {
                throw refusal('runtime-payload-changed', relative + ' changed while being read')
            }
            entries.push([relative, 'file', mode, stat.size, digest.digest('hex')]);
        } else {
            throw refusal('runtime-payload-invalid', relative + ' is neither a file, directory nor internal link')
        }
    }

    try {
        await visit('');
    } catch (cause) {
        if (cause.code?.startsWith('runtime-')) throw cause;
        throw refusal('runtime-payload-invalid', 'payload cannot be fully inventoried', cause)
    }
    return {entries, digest: hash(JSON.stringify(entries))}
}

/** @summary Exposes distinct generation-directory, organism-root and executable authorities. */
export function runtimeGenerationDescriptor(directory, record) {
    const payload = path.join(directory, PAYLOAD);
    return Object.freeze({
        id           : record.id,
        identity     : Object.freeze([...record.identity]),
        directory,
        runtimeRoot  : binding(payload, record.runtimeRelativePath),
        executable   : binding(payload, record.executableRelativePath),
        payloadDigest: record.payloadDigest,
        createdAt    : record.createdAt,
        compatibility: Object.freeze({...record.compatibility})
    })
}

/**
 * @summary Projects only the verified runtime facts an original Start may persist.
 * This projection does not verify a payload or establish authority to recover a Start.
 * @param {Object} generation Descriptor returned by the trusted verifier.
 * @returns {Object} Closed non-secret runtime pin.
 */
export function runtimeGenerationPin(generation) {
    const pin = Object.fromEntries(['id', 'directory', 'runtimeRoot', 'executable', 'payloadDigest']
        .map(key => [key, generation?.[key]]));
    if (!isRuntimeGenerationPin(pin)) throw refusal('runtime-binding-invalid', 'a complete verified runtime pin is required');
    return Object.freeze(pin)
}

/**
 * @summary Checks the closed persisted pin shape and canonical containment, without importing code.
 * @param {*} pin
 * @returns {Boolean}
 */
export function isRuntimeGenerationPin(pin) {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
        Object.keys(pin).sort().join(',') !== 'directory,executable,id,payloadDigest,runtimeRoot' ||
        ![pin.id, pin.payloadDigest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
        ![pin.directory, pin.runtimeRoot, pin.executable].every(value =>
            typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value)) return false;
    const payload = path.join(pin.directory, PAYLOAD);
    return path.basename(pin.directory) === pin.id && pin.runtimeRoot !== payload && pin.executable !== payload &&
        inside(payload, pin.runtimeRoot) && inside(payload, pin.executable)
}

/** @summary The sealed directory's record, checked for identity and host compatibility; null when absent. */
async function readSealedRecord(directory, platform, arch) {
    let stat;
    try { stat = await fs.lstat(directory) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o222) {
        throw refusal('runtime-generation-invalid', 'the published directory is not sealed')
    }
    const record = await readJson(path.join(directory, RECORD));
    if (record.version !== 1 || !Array.isArray(record.identity) || record.identity.length !== 4 ||
        record.id !== path.basename(directory) || record.id !== hash(JSON.stringify(record.identity)) ||
        !/^[a-f0-9]{64}$/u.test(record.payloadDigest ?? '') || typeof record.createdAt !== 'string') {
        throw refusal('runtime-record-invalid', 'generation identity or manifest header is inconsistent')
    }
    if (record.compatibility?.platform !== platform || record.compatibility?.arch !== arch ||
        record.compatibility?.electronVersion !== record.identity[3] ||
        record.compatibility?.launchProtocol !== LAUNCH_ADMISSION_PROTOCOL) {
        throw refusal('runtime-compatibility-failed', 'generation is not verified for this host, Electron version and launch protocol')
    }
    return record
}

/** @summary Refuses a descriptor whose receipt, organism root or executable does not match its generation. */
async function assertRuntimeBindings(result) {
    const actual     = runtimeGenerationIdentity(await readJson(path.join(result.runtimeRoot, 'organism-build-info.json')));
    const executable = await fs.stat(result.executable);
    if (actual.id !== result.id || !executable.isFile() || !(executable.mode & 0o111) ||
        !(await fs.stat(result.runtimeRoot)).isDirectory()) {
        throw refusal('runtime-binding-invalid', 'receipt, runtime or executable does not match the generation')
    }
}

/**
 * @summary Verifies a published generation before returning any executable binding.
 * @param {Object} options
 * @param {String} options.directory Generation directory, whose basename is its identity.
 * @param {String} [options.platform=process.platform]
 * @param {String} [options.arch=process.arch]
 * @returns {Promise<Object|null>} Null only when the whole directory is absent.
 */
export async function readRuntimeGeneration({directory, platform = process.platform, arch = process.arch}) {
    const record = await readSealedRecord(directory, platform, arch);
    if (!record) return null;
    const result  = runtimeGenerationDescriptor(directory, record);
    const payload = await inventoryRuntimePayload(path.join(directory, PAYLOAD));
    if (payload.digest !== record.payloadDigest || JSON.stringify(payload.entries) !== JSON.stringify(record.entries)) {
        throw refusal('runtime-integrity-failed', 'published bytes, modes or links differ from their manifest')
    }
    await assertRuntimeBindings(result);
    return result
}

/**
 * @summary Proves a published generation's identity, host compatibility and bindings without re-hashing its payload.
 * Only for a caller whose consumer re-verifies the bytes before trusting them: the continuity handoff, whose
 * successor runs {@link readRuntimeGeneration} in recovery before any generation is active again.
 * @param {Object} options Same as {@link readRuntimeGeneration}.
 * @returns {Promise<Object|null>} The same descriptor; null only when the whole directory is absent.
 */
export async function readRuntimeGenerationRecord({directory, platform = process.platform, arch = process.arch}) {
    const record = await readSealedRecord(directory, platform, arch);
    if (!record) return null;
    const result = runtimeGenerationDescriptor(directory, record);
    await assertRuntimeBindings(result);
    return result
}


/**
 * @summary Creates the one manifest format the verifier reads, before or after the host's compatibility probe.
 * @param {Object} options Explicit identity, inventory, relative bindings and capture time.
 * @returns {Object} A generation record; the host publishes it only after a successful compatibility probe.
 */
export function createRuntimeGenerationRecord({identity, payload, runtimeRelativePath, executableRelativePath, createdAt, compatibility}) {
    const record = {
        version      : 1, id: identity.id, identity: [...identity.identity],
        payloadDigest: payload.digest, entries: payload.entries,
        runtimeRelativePath, executableRelativePath, createdAt
    };
    if (compatibility) record.compatibility = Object.fromEntries(
        ['platform', 'arch', 'electronVersion', 'nodeVersion', 'moduleAbi', 'launchProtocol'].map(key => [key, compatibility[key]])
    );
    return record
}

/**
 * @summary Completes the manifest with the host's observed compatibility fields, using the same format owner.
 * @param {Object} record Manifest created before the compatibility probe.
 * @param {Object} compatibility The host's completed executable/native-module observation.
 * @returns {Object}
 */
export function completeRuntimeGenerationRecord(record, compatibility) {
    return createRuntimeGenerationRecord({
        identity           : {id: record.id, identity: record.identity},
        payload            : {digest: record.payloadDigest, entries: record.entries},
        runtimeRelativePath: record.runtimeRelativePath, executableRelativePath: record.executableRelativePath,
        createdAt          : record.createdAt, compatibility
    })
}

/**
 * @summary Carries a verified generation into the Fleet child as a non-secret process argument.
 * @param {Object} generation The host's verified descriptor.
 * @returns {String[]}
 */
export function runtimeGenerationArguments(generation) {
    if (!generation || !path.isAbsolute(generation.directory || '')) {
        throw refusal('runtime-binding-invalid', 'a verified generation directory is required')
    }
    return [RUNTIME_ARGUMENT + generation.directory]
}

/**
 * @summary Binds Fleet boot to the runtime it actually executes, refusing a missing packaged binding.
 * A checkout without a package receipt remains explicit checkout mode. No ancestor search or bundle
 * fallback discovers authority; the host supplies exactly one directory and the verifier checks it.
 * @param {Object} options
 * @param {String[]} options.args Script arguments, after Node's own options.
 * @param {String} options.runtimeRoot This entrypoint's own code root.
 * @param {String} options.executable The actual process executable.
 * @returns {Promise<{runtimeRoot:String, executable:String, generation:Object|null}>}
 */
export async function bindCurrentRuntime({args, runtimeRoot, executable}) {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') ||
        !path.isAbsolute(runtimeRoot || '') || !path.isAbsolute(executable || '')) {
        throw refusal('runtime-binding-invalid', 'explicit arguments, code root and executable are required')
    }
    const roots = args.filter(arg => arg.startsWith(RUNTIME_ARGUMENT));
    if (roots.length > 1) throw refusal('runtime-binding-invalid', 'only one runtime generation may bind this process');
    const root = await fs.realpath(runtimeRoot), binary = await fs.realpath(executable);
    let receipt;
    try {
        receipt = JSON.parse(await fs.readFile(path.join(root, 'organism-build-info.json'), 'utf8'));
        runtimeGenerationIdentity(receipt);
    } catch (error) {
        if (error.code !== 'ENOENT') throw refusal('runtime-receipt-invalid', 'the current package receipt is unreadable or invalid');
    }
    if (!roots.length) {
        if (receipt) throw refusal('runtime-generation-required', 'a packaged Fleet must carry its verified generation');
        return {runtimeRoot: root, executable: binary, generation: null}
    }
    const directory = roots[0].slice(RUNTIME_ARGUMENT.length);
    if (!path.isAbsolute(directory)) throw refusal('runtime-binding-invalid', 'the generation directory must be absolute');
    const generation = await readRuntimeGeneration({directory});
    if (!generation || generation.runtimeRoot !== root || generation.executable !== binary) {
        throw refusal('runtime-binding-invalid', 'the generation does not bind this code root and executable')
    }
    return {runtimeRoot: root, executable: binary, generation}
}

/**
 * @summary Validates the installer's bounded location record without duplicating its write authority.
 * selectedPaths orders the installed, rollback and interrupted-restore slots; retained prior slots
 * remain in slots. This ordering belongs to the versioned format, not a consumer's path convention.
 * @param {Object} record Installer-produced location metadata.
 * @param {String} directory Expected canonical runtime parent.
 * @returns {Object} The validated record, without observing package contents.
 */
export function validatePackageSlotRecord(record, directory) {
    const absolute = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value;
    if (!record || Object.keys(record).sort().join(',') !== 'completedAt,completionId,directory,selectedPaths,slots,version' ||
        record.version !== 1 || record.directory !== directory || !absolute(directory) ||
        !/^[a-f0-9-]{36}$/.test(record.completionId) || typeof record.completedAt !== 'string' || !Number.isFinite(Date.parse(record.completedAt)) ||
        !Array.isArray(record.selectedPaths) || record.selectedPaths.length !== 3 ||
        !Array.isArray(record.slots) || record.slots.length < 3 || record.slots.length > 64 ||
        new Set(record.selectedPaths).size !== 3 || new Set(record.slots.map(slot => slot?.path)).size !== record.slots.length) {
        throw refusal('package-slots-invalid', 'package slot record is invalid');
    }
    for (const slot of record.slots) {
        if (!slot || Object.keys(slot).sort().join(',') !== 'exists,path,receipt' || !absolute(slot.path) ||
            typeof slot.exists !== 'boolean' || !slot.exists && slot.receipt !== null) throw refusal('package-slots-invalid', 'package slot binding is invalid');
        if (slot.exists) runtimeGenerationIdentity(slot.receipt);
    }
    if (record.selectedPaths.some(selected => !record.slots.some(slot => slot.path === selected))) throw refusal('package-slots-invalid', 'selected package slot is missing');
    return record;
}

/** @summary Reads bounded JSON while proving its descriptor still names the same non-link file. */
function readPackageJson(file, {fileSystem, maxBytes, privateOwner = false}) {
    const descriptor = fileSystem.openSync(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    try {
        const before = fileSystem.fstatSync(descriptor, {bigint: true});
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes) ||
            before.mode & (privateOwner ? 0o077n : 0o022n) || privateOwner && before.uid !== BigInt(process.getuid())) {
            throw refusal('package-slots-unverified', 'package record custody is invalid');
        }
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let   offset = 0;
        while (offset < buffer.length) {
            const count = fileSystem.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (!count) break;
            offset += count;
        }
        const after = fileSystem.fstatSync(descriptor, {bigint: true}), named = fileSystem.lstatSync(file, {bigint: true});
        if (offset !== Number(before.size) || [after, named].some(stat =>
            ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key] !== before[key]))) {
            throw refusal('package-slots-unverified', 'package record changed while reading');
        }
        return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    } finally { fileSystem.closeSync(descriptor) }
}

/**
 * @summary Reads the installer-owned slot record through the shared read-only codec.
 * Null means unrecorded, never no installed package or no protected runtime.
 * @param {Object} options
 * @param {String} options.directory Canonical runtime-generation parent.
 * @param {Object} [options.fileSystem] Synchronous filesystem seam.
 * @returns {Object|null} Valid record structure, still requiring fresh slot observations.
 */
export function readPackageSlotRecord({directory, fileSystem = fsSync}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) throw refusal('package-slots-invalid', 'canonical runtime parent is required');
    let before, record;
    try {
        before = fileSystem.lstatSync(directory, {bigint: true});
        if (!before.isDirectory() || before.uid !== BigInt(process.getuid()) || before.mode & 0o022n ||
            fileSystem.realpathSync(directory) !== directory) throw refusal('package-slots-unverified', 'package slot parent custody is invalid');
        record = readPackageJson(path.join(directory, PACKAGE_SLOTS_RECORD), {fileSystem, maxBytes: MAX_PACKAGE_SLOT_BYTES, privateOwner: true});
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    const after = fileSystem.lstatSync(directory, {bigint: true});
    if (before.dev !== after.dev || before.ino !== after.ino) throw refusal('package-slots-unverified', 'package slot parent changed');
    return validatePackageSlotRecord(record, directory);
}

/**
 * @summary Observes the installed slot separately from the serving Fleet's next-Start selection.
 * This reads package identity metadata, not an executable/payload integrity guarantee. The host
 * remains the only writer; changed, missing or unreadable evidence stays explicitly unknown.
 * @param {Object} options Canonical generation parent and optional filesystem seam.
 * @returns {Object} Closed observed identity or a bounded unknown reason, without host paths.
 */
export function readInstalledRuntimeGeneration({directory, fileSystem = fsSync}) {
    try {
        const record = readPackageSlotRecord({directory, fileSystem});
        if (!record) return {state: 'unknown', id: null, identity: null, reason: 'package-slots-unrecorded'};
        const installed = record.slots.find(slot => slot.path === record.selectedPaths[0]);
        if (!installed.exists) return {state: 'unknown', id: null, identity: null, reason: 'installed-slot-empty'};
        const file = path.join(installed.path, PACKAGE_RECEIPT_PATH);
        if (!fileSystem.lstatSync(installed.path).isDirectory() || fileSystem.realpathSync(installed.path) !== installed.path ||
            fileSystem.realpathSync(file) !== file) throw Error('redirected installed slot');
        const receipt = readPackageJson(file, {fileSystem, maxBytes: MAX_PACKAGE_SLOT_BYTES});
        if (!isDeepStrictEqual(receipt, installed.receipt) || !isDeepStrictEqual(readPackageSlotRecord({directory, fileSystem}), record)) {
            return {state: 'unknown', id: null, identity: null, reason: 'installed-slot-changed'};
        }
        const identity = runtimeGenerationIdentity(receipt);
        return {state: 'observed', id: identity.id, identity: [...identity.identity], reason: null};
    } catch {
        return {state: 'unknown', id: null, identity: null, reason: 'installed-slot-unverified'};
    }
}
