import {createHash} from 'node:crypto';
import {constants}  from 'node:fs';
import fs           from 'node:fs/promises';
import path         from 'node:path';
import {
    LAUNCH_GRANT_ENV_VAR,
    LAUNCH_ISSUER_ENV_VAR,
    canonicalJson,
    isLaunchIdentity,
    parseLaunchCapability
} from './mcpLaunchAdmission.mjs';

/**
 * @module ai/services/fleet/desktopLaunchProfile
 * @summary Binds an original Start to its owned Desktop rows and reads their existing capabilities.
 * Only hashes enter the binding; capabilities are returned transiently to the admission issuer.
 * A verified read supplies no Start or succession authority by itself.
 */
export const DESKTOP_PROFILE_RECEIPT = '.neo-fleet-claude-desktop-profile.json';
const PROFILE = 'claude_desktop_config.json', PREFIX = 'neo-mjs-', MAX_BYTES = 8 * 1024 * 1024;
const digest  = value => createHash('sha256').update(value).digest('hex');
const isHash  = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** @summary A bounded refusal that never carries profile contents or parser diagnostics. */
function refuse(reason) {
    return Object.assign(new Error(`Desktop launch profile is unverified: ${reason}.`), {
        code: 'FLEET_LAUNCH_PROFILE_UNVERIFIED', reason
    })
}

/**
 * @summary The canonical Neo-owned projection used by both preparation receipts and recovery.
 * @param {String} source Profile JSON.
 * @returns {Object} An invalid marker for malformed JSON, matching preparation's existing contract.
 */
export function desktopProfileProjection(source) {
    let parsed;
    try { parsed = JSON.parse(source) } catch { return {__invalidJson: true} }
    return JSON.parse(canonicalJson(Object.fromEntries(
        Object.entries(parsed?.mcpServers || {}).filter(([name]) => name.startsWith(PREFIX))
    )))
}

/**
 * @summary Records only the original Start's row digest, identity, issuer and capability hashes.
 * @param {Object} options
 * @param {Object} options.rows The exact canonical rows preparation writes.
 * @param {String} options.identity Validated forge login.
 * @param {String} options.issuer The original loopback origin.
 * @returns {Object} Non-secret binding for the durable original-Start record.
 */
export function createDesktopLaunchBinding({rows, identity, issuer}) {
    const origin = typeof issuer === 'string' && issuer.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/);
    if (!isLaunchIdentity(identity) || !origin || Number(origin[1]) > 65535) throw refuse('invalid-binding');
    const grants = {};
    for (const [name, row] of Object.entries(rows)) {
        const key   = name.slice(PREFIX.length), capability = row?.env?.[LAUNCH_GRANT_ENV_VAR];
        const grant = parseLaunchCapability(capability);
        if (!name.startsWith(PREFIX) || !/^[a-z][a-z0-9-]{0,63}$/.test(key) || !grant ||
            row.env.NEO_AGENT_IDENTITY !== identity || row.env[LAUNCH_ISSUER_ENV_VAR] !== issuer) {
            throw refuse('invalid-binding')
        }
        grants[key] = {id: grant.id, sha256: digest(capability)};
    }
    return {version: 1, identity, issuer, projectionSha256: digest(canonicalJson(rows)), grants}
}

/**
 * @summary Parses JSON while rejecting duplicate object keys, including escaped spellings.
 * JSON.parse validates syntax first; the token pass detects ambiguity it otherwise discards.
 * @param {String} source
 * @returns {Object}
 */
function parseUnambiguous(source) {
    let result;
    try { result = JSON.parse(source) } catch { throw refuse('invalid-json') }
    const stack = [];
    for (const [token] of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const frame = stack.at(-1);
        if (token === '{' || token === '[') stack.push({object: token === '{', key: true, names: new Set()});
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && frame?.object) frame.key = true;
        else if (token.startsWith('"') && frame?.object && frame.key) {
            const name = JSON.parse(token);
            if (frame.names.has(name)) throw refuse('duplicate-json-key');
            frame.names.add(name);
            frame.key = false;
        }
    }
    return result
}

/** @summary Compares descriptor identity and, for a file, its complete observed change stamp. */
function sameFile(a, b, content = true) {
    return ['dev', 'ino', 'uid', 'mode', ...(content ? ['size', 'mtimeNs', 'ctimeNs'] : [])]
        .every(key => a[key] === b[key])
}

/**
 * @summary Recovers existing grants only from unchanged, receipt-matching files under the managed root.
 * Files remain open while custody is checked again. O_NOFOLLOW, directory identity checks, descriptor
 * stamps, UID and exact 0600 modes reject symlink, rename and in-place rewrite races. Each file
 * is bounded to 8 MiB, including the extra-byte read that detects concurrent growth.
 * @param {Object} options
 * @param {String} options.managedRoot Canonical root owned by the host lifecycle.
 * @param {String} options.instanceHome Expected seat home derived from the registry, not the record.
 * @param {Object} options.binding The original Start's {@link createDesktopLaunchBinding} result.
 * @param {Object} [options.fileSystem=fs] Filesystem seam.
 * @param {Number} [options.uid=process.getuid()] Expected operator UID.
 * @returns {Promise<Object<String,String>>} Transient capability per server; never a persistable record.
 */
export async function recoverDesktopLaunchGrants({managedRoot, instanceHome, binding, fileSystem = fs, uid = process.getuid?.()}) {
    const handles = [], files = [], directories = [];
    try {
        if (!Number.isInteger(uid) || !path.isAbsolute(managedRoot || '') || !path.isAbsolute(instanceHome || '') ||
            !binding || binding.version !== 1 || !isHash(binding.projectionSha256) || !isLaunchIdentity(binding.identity) ||
            !binding.grants || typeof binding.grants !== 'object' || Array.isArray(binding.grants)) throw refuse('invalid-binding');
        const root = path.resolve(managedRoot), home = path.resolve(instanceHome), relative = path.relative(root, home);
        if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
            await fileSystem.realpath(root) !== root) throw refuse('managed-root-mismatch');
        let current = root;
        for (const part of ['', ...relative.split(path.sep)]) {
            if (part) current = path.join(current, part);
            const stat = await fileSystem.lstat(current, {bigint: true});
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid)) throw refuse('directory-custody');
            directories.push({file: current, stat});
        }

        /** @summary Opens one bounded JSON file and retains its descriptor until final path checks. */
        async function read(file) {
            const handle = await fileSystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            handles.push(handle);
            const stat = await handle.stat({bigint: true});
            if (!stat.isFile() || stat.uid !== BigInt(uid) || (stat.mode & 0o7777n) !== 0o600n ||
                stat.size > BigInt(MAX_BYTES)) throw refuse('file-custody');
            const buffer = Buffer.alloc(Number(stat.size) + 1);
            let   offset = 0;
            while (offset < buffer.length) {
                const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset);
                if (!bytesRead) break;
                offset += bytesRead;
            }
            if (offset !== Number(stat.size) || !sameFile(stat, await handle.stat({bigint: true}))) throw refuse('file-changed');
            files.push({file, stat, handle});
            return parseUnambiguous(buffer.subarray(0, offset).toString('utf8'))
        }

        const profile = await read(path.join(home, PROFILE)), receipt = await read(path.join(home, DESKTOP_PROFILE_RECEIPT));
        if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.mcpServers ||
            typeof profile.mcpServers !== 'object' || Array.isArray(profile.mcpServers)) throw refuse('invalid-profile');
        const rows = desktopProfileProjection(JSON.stringify(profile));
        if (receipt?.version !== 2 || receipt.artifact !== PROFILE || receipt.sha256 !== binding.projectionSha256 ||
            digest(canonicalJson(rows)) !== binding.projectionSha256) throw refuse('receipt-mismatch');
        if (canonicalJson(Object.keys(rows).sort()) !== canonicalJson(Object.keys(binding.grants).map(key => PREFIX + key).sort())) {
            throw refuse('row-set-mismatch')
        }
        const capabilities = {};
        for (const [key, expected] of Object.entries(binding.grants)) {
            const row = rows[PREFIX + key], capability = row?.env?.[LAUNCH_GRANT_ENV_VAR], grant = parseLaunchCapability(capability);
            if (!grant || !isHash(expected?.sha256) || grant.id !== expected.id || digest(capability) !== expected.sha256 ||
                row.env.NEO_AGENT_IDENTITY !== binding.identity || row.env[LAUNCH_ISSUER_ENV_VAR] !== binding.issuer) {
                throw refuse('grant-mismatch')
            }
            capabilities[key] = capability;
        }
        for (const {file, stat, handle} of files) {
            if (!sameFile(stat, await handle.stat({bigint: true})) || !sameFile(stat, await fileSystem.lstat(file, {bigint: true}))) {
                throw refuse('file-changed')
            }
        }
        for (const {file, stat} of directories) {
            if (!sameFile(stat, await fileSystem.lstat(file, {bigint: true}), false)) throw refuse('directory-changed');
        }
        return capabilities
    } catch (error) {
        throw error?.code === 'FLEET_LAUNCH_PROFILE_UNVERIFIED' ? error : refuse('custody-unavailable')
    } finally {
        await Promise.all(handles.map(handle => handle.close().catch(() => {})))
    }
}
