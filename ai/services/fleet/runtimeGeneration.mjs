import {createHash}       from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs                 from 'node:fs/promises';
import path               from 'node:path';

/**
 * @module ai/services/fleet/runtimeGeneration
 * @summary The runtime-generation format and read-only verifier shared by publication and admission.
 * The caller's trusted package loads this module; code from the tree being verified is never imported.
 * Copying, compatibility execution, publication and retirement remain host lifecycle operations.
 */
export const RUNTIME_GENERATION_RECORD = 'generation.json';
export const RUNTIME_GENERATION_PAYLOAD = 'host.runtime';

const RECORD = RUNTIME_GENERATION_RECORD, PAYLOAD = RUNTIME_GENERATION_PAYLOAD;

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
 * @summary Verifies a published generation before returning any executable binding.
 * @param {Object} options
 * @param {String} options.directory Generation directory, whose basename is its identity.
 * @param {String} [options.platform=process.platform]
 * @param {String} [options.arch=process.arch]
 * @returns {Promise<Object|null>} Null only when the whole directory is absent.
 */
export async function readRuntimeGeneration({directory, platform = process.platform, arch = process.arch}) {
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
        record.compatibility?.electronVersion !== record.identity[3]) {
        throw refusal('runtime-compatibility-failed', 'generation is not verified for this host and Electron version')
    }
    const result  = runtimeGenerationDescriptor(directory, record);
    const payload = await inventoryRuntimePayload(path.join(directory, PAYLOAD));
    if (payload.digest !== record.payloadDigest || JSON.stringify(payload.entries) !== JSON.stringify(record.entries)) {
        throw refusal('runtime-integrity-failed', 'published bytes, modes or links differ from their manifest')
    }
    const actual     = runtimeGenerationIdentity(await readJson(path.join(result.runtimeRoot, 'organism-build-info.json')));
    const executable = await fs.stat(result.executable);
    if (actual.id !== record.id || !executable.isFile() || !(executable.mode & 0o111) ||
        !(await fs.stat(result.runtimeRoot)).isDirectory()) {
        throw refusal('runtime-binding-invalid', 'receipt, runtime or executable does not match the generation')
    }
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
        ['platform', 'arch', 'electronVersion', 'nodeVersion', 'moduleAbi'].map(key => [key, compatibility[key]])
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
