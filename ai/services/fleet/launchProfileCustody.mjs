import {createHash}          from 'node:crypto';
import {constants}           from 'node:fs';
import fs                    from 'node:fs/promises';
import path                  from 'node:path';
import {parse as parseToml}  from 'smol-toml';
import {MCP_SERVERS}         from '../../../src/fleet/contract/mcpServers.mjs';
import {ANTIGRAVITY_MCP_DIRECTORY, ANTIGRAVITY_MCP_WORKSPACE_FILE, generateAntigravityMcpFiles, parseAntigravityMcpInvoker}
    from './generateAntigravityMcpFiles.mjs';
import {
    LAUNCH_GRANT_ENV_VAR,
    LAUNCH_ISSUER_ENV_VAR,
    canonicalJson,
    isLaunchIdentity,
    parseLaunchCapability
} from './mcpLaunchAdmission.mjs';

/**
 * @module ai/services/fleet/launchProfileCustody
 * @summary Binds an original Start to its native profile carrier and reads its existing capabilities.
 * Only hashes enter the binding; capabilities are returned transiently to the admission issuer.
 * A verified read supplies no Start or succession authority by itself.
 */
export const DESKTOP_PROFILE_RECEIPT = '.neo-fleet-claude-desktop-profile.json';
/** @summary A Codex seat's own config in its `CODEX_HOME`, the carrier of its capability-bearing tables. */
export const CODEX_HOME_CONFIG = 'config.toml';
const PROFILE = 'claude_desktop_config.json', PREFIX = 'neo-mjs-', MAX_BYTES = 8 * 1024 * 1024;
const CODEX_PROJECT_CONFIG = path.join('.codex', 'config.toml');
const digest  = value => createHash('sha256').update(value).digest('hex');
const isHash  = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact   = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const absolute   = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value;
const serverKeys = new Set(MCP_SERVERS.map(row => row.key));

/** @summary A bounded refusal that never carries profile contents or parser diagnostics. */
function refuse(reason) {
    return Object.assign(new Error(`Launch profile is unverified: ${reason}.`), {
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
 * @summary Captures hashes of the original compiled invokers and their neutral workspace projection.
 * Mutable convergence receipts cannot substitute for this original-Start binding. No capability or
 * benign process-environment value is persisted; the caller verifies the actual files before Start.
 * @param {Object} options Original identity, issuer, canonical profile/workspace and compiled files.
 * @param {String} options.identity Original forge login.
 * @param {String} options.issuer Original loopback admission origin.
 * @param {String} options.instanceHome Canonical native profile selected by preparation.
 * @param {String} options.workspaceRoot Canonical original workspace.
 * @param {Object[]} options.files Exact file descriptors returned by the trusted invoker compiler.
 * @returns {Object} Closed non-secret native-profile binding.
 */
export function createAntigravityLaunchBinding({identity, issuer, instanceHome, workspaceRoot, files}) {
    if (!absolute(instanceHome) || !absolute(workspaceRoot) || !Array.isArray(files)) throw refuse('invalid-binding');
    const rows = {}, invokerSha256 = {};
    for (const file of files) {
        if (!file || typeof file.path !== 'string') throw refuse('invalid-binding');
        const key = path.basename(file.path, '.sh');
        if (!serverKeys.has(key) || Object.hasOwn(invokerSha256, key) || file.mode !== 0o600 ||
            file.path !== path.join(instanceHome, ANTIGRAVITY_MCP_DIRECTORY, `${key}.sh`)) throw refuse('invalid-binding');
        try { rows[PREFIX + key] = parseAntigravityMcpInvoker({profileHome: instanceHome, key, source: file.content}) }
        catch { throw refuse('invalid-invoker') }
        invokerSha256[key] = digest(file.content);
    }
    const {grants}     = createDesktopLaunchBinding({rows, identity, issuer});
    const {mcpServers} = generateAntigravityMcpFiles({profileHome: instanceHome, rows, processEnvironment: {}});
    return {version: 2, kind: 'antigravity', identity, issuer, instanceHome, workspaceRoot,
        workspaceSha256: digest(canonicalJson(mcpServers)), invokerSha256, grants};
}

/**
 * @summary The canonical Neo-owned MCP tables of a Codex config, the projection binding and recovery both hash.
 * A table's `enabled` key is the seat's own switch, which the Codex app writes into this layer, so it stays
 * outside the projection; a table holding nothing else is the switch alone.
 * @param {String} source TOML.
 * @returns {Object} The `neo-mjs-*` server tables.
 */
export function codexProfileProjection(source) {
    let parsed;
    try { parsed = parseToml(source) } catch { throw refuse('invalid-toml') }
    const table = value => value && typeof value === 'object' && !Array.isArray(value);
    return JSON.parse(canonicalJson(Object.fromEntries(Object.entries(parsed?.mcp_servers || {})
        .filter(([name]) => name.startsWith(PREFIX))
        .map(([name, value]) => [name, table(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'enabled')) : value])
        .filter(([, value]) => !table(value) || Object.keys(value).length))))
}

/**
 * @summary Binds a Codex seat's original Start to the capability-bearing tables of its home config.
 * The home config is the carrier because it lives outside every checkout; a project config would win over
 * it for a table both name, so recovery also proves the original workspace names none of them.
 * @param {Object} options
 * @param {String} options.identity Validated forge login.
 * @param {String} options.issuer The original loopback origin.
 * @param {String} options.codexHome Canonical `CODEX_HOME` preparation wrote the config into.
 * @param {String} options.workspaceRoot Canonical original workspace.
 * @param {String} options.source The home config exactly as preparation writes it.
 * @returns {Object} Closed non-secret binding: hashes, identity, issuer and the two roots.
 */
export function createCodexLaunchBinding({identity, issuer, codexHome, workspaceRoot, source}) {
    if (!absolute(codexHome) || !absolute(workspaceRoot) || typeof source !== 'string') throw refuse('invalid-binding');
    const {projectionSha256, grants} = createDesktopLaunchBinding({rows: codexProfileProjection(source), identity, issuer});
    return {version: 3, kind: 'codex', identity, issuer, codexHome, workspaceRoot, projectionSha256, grants}
}

/**
 * @summary Validates the closed Claude JSON (v1), Antigravity invoker (v2) or Codex TOML (v3) binding without file access.
 * @param {*} value Candidate non-secret original-Start profile metadata.
 * @returns {Boolean} Unknown fields, formats, paths and server sets refuse.
 */
export function isLaunchProfileBinding(value) {
    const origin = typeof value?.issuer === 'string' && value.issuer.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/);
    if (!value || !isLaunchIdentity(value.identity) || !origin || Number(origin[1]) > 65535 ||
        !value.grants || typeof value.grants !== 'object' || Array.isArray(value.grants) ||
        !Object.entries(value.grants).every(([key, grant]) => /^[a-z][a-z0-9-]{0,63}$/.test(key) &&
            exact(grant, ['id', 'sha256']) && typeof grant.id === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(grant.id) && isHash(grant.sha256))) return false;
    if (value.version === 1) return exact(value, ['version', 'identity', 'issuer', 'projectionSha256', 'grants']) && isHash(value.projectionSha256);
    if (value.version === 3) {
        return exact(value, ['version', 'kind', 'identity', 'issuer', 'codexHome', 'workspaceRoot', 'projectionSha256', 'grants']) &&
            value.kind === 'codex' && absolute(value.codexHome) && absolute(value.workspaceRoot) && isHash(value.projectionSha256)
    }
    return Boolean(value.version === 2 && exact(value, ['version', 'kind', 'identity', 'issuer', 'instanceHome', 'workspaceRoot', 'workspaceSha256', 'invokerSha256', 'grants']) &&
        value.kind === 'antigravity' && absolute(value.instanceHome) && absolute(value.workspaceRoot) && isHash(value.workspaceSha256) &&
        value.invokerSha256 && typeof value.invokerSha256 === 'object' && !Array.isArray(value.invokerSha256) &&
        Object.entries(value.invokerSha256).every(([key, hash]) => serverKeys.has(key) && isHash(hash)) &&
        canonicalJson(Object.keys(value.invokerSha256).sort()) === canonicalJson(Object.keys(value.grants).sort()));
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
 * @summary Recovers unchanged original capabilities from their native profile carrier.
 * Bounded descriptor reads retain their handles through final path/UID/mode/change-stamp checks.
 * Antigravity additionally binds its exact profile, workspace and enabled invoker set; Codex binds its
 * home config and proves the original workspace leaves the bound tables to it. Workspace reads inspect
 * only canonical Fleet rows; unrelated project settings remain outside the binding.
 * @param {Object} options
 * @param {String} options.managedRoot Canonical lifecycle-owned profile root.
 * @param {String} options.instanceHome Expected home derived from the original lifecycle record.
 * @param {String} [options.workspaceRoot] Original Start's working directory, required for Antigravity and Codex.
 * @param {Object} options.binding Original non-secret profile binding.
 * @param {Object} [options.fileSystem=fs] Promise filesystem seam.
 * @param {Number} [options.uid=process.getuid()] Expected owner.
 * @returns {Promise<Object<String,String>>} Transient per-server capabilities, never persisted.
 */
export async function recoverLaunchProfileGrants({managedRoot, instanceHome, workspaceRoot, binding, fileSystem = fs, uid = process.getuid?.()}) {
    const handles = [], files = [], directories = [], absent = [];
    try {
        if (!Number.isInteger(uid) || !path.isAbsolute(managedRoot || '') || !path.isAbsolute(instanceHome || '') ||
            !isLaunchProfileBinding(binding)) throw refuse('invalid-binding');
        const root = path.resolve(managedRoot), home = path.resolve(instanceHome), relative = path.relative(root, home);
        if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
            await fileSystem.realpath(root) !== root) throw refuse('managed-root-mismatch');

        /** @summary Pins a real owned directory, including native invoker/workspace subdirectories. */
        async function directory(file) {
            const stat = await fileSystem.lstat(file, {bigint: true});
            if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid) || stat.mode & 0o022n) throw refuse('directory-custody');
            directories.push({file, stat});
        }
        let current = root;
        for (const part of ['', ...relative.split(path.sep)]) {
            if (part) current = path.join(current, part);
            await directory(current);
        }

        /** @summary Whether a path exists. A proven absence is re-checked with the final stamps; any other error refuses. */
        async function present(file) {
            try {
                await fileSystem.lstat(file);
                return true
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
                absent.push(file);
                return false
            }
        }

        /** @summary Reads bounded bytes without following links and retains the descriptor for final checks. */
        async function read(file, secret = true) {
            const handle = await fileSystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            handles.push(handle);
            const stat = await handle.stat({bigint: true});
            if (!stat.isFile() || stat.uid !== BigInt(uid) || (secret ? (stat.mode & 0o7777n) !== 0o600n : !!(stat.mode & 0o022n)) ||
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
            return buffer.subarray(0, offset);
        }

        /** @summary Matches the recovered value against the original capability hash, identity and issuer. */
        function capability(row, key) {
            const value = row?.env?.[LAUNCH_GRANT_ENV_VAR], grant = parseLaunchCapability(value), expected = binding.grants[key];
            if (!grant || grant.id !== expected.id || digest(value) !== expected.sha256 ||
                row.env.NEO_AGENT_IDENTITY !== binding.identity || row.env[LAUNCH_ISSUER_ENV_VAR] !== binding.issuer) throw refuse('grant-mismatch');
            return value;
        }

        const capabilities = {};
        if (binding.version === 1) {
            const profile = parseUnambiguous((await read(path.join(home, PROFILE))).toString('utf8'));
            const receipt = parseUnambiguous((await read(path.join(home, DESKTOP_PROFILE_RECEIPT))).toString('utf8'));
            if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.mcpServers ||
                typeof profile.mcpServers !== 'object' || Array.isArray(profile.mcpServers)) throw refuse('invalid-profile');
            const rows = desktopProfileProjection(JSON.stringify(profile));
            if (receipt?.version !== 2 || receipt.artifact !== PROFILE || receipt.sha256 !== binding.projectionSha256 ||
                digest(canonicalJson(rows)) !== binding.projectionSha256) throw refuse('receipt-mismatch');
            if (canonicalJson(Object.keys(rows).sort()) !== canonicalJson(Object.keys(binding.grants).map(key => PREFIX + key).sort())) throw refuse('row-set-mismatch');
            for (const key of Object.keys(binding.grants)) capabilities[key] = capability(rows[PREFIX + key], key);
        } else if (binding.version === 3) {
            const below = path.relative(home, binding.codexHome);
            if (below.startsWith('..') || path.isAbsolute(below) || workspaceRoot !== binding.workspaceRoot ||
                await fileSystem.realpath(workspaceRoot) !== workspaceRoot) throw refuse('profile-binding-mismatch');
            let current = home;
            for (const part of below ? below.split(path.sep) : []) {
                current = path.join(current, part);
                await directory(current);
            }
            const rows = codexProfileProjection((await read(path.join(binding.codexHome, CODEX_HOME_CONFIG))).toString('utf8'));
            if (digest(canonicalJson(rows)) !== binding.projectionSha256) throw refuse('projection-mismatch');
            if (canonicalJson(Object.keys(rows).sort()) !== canonicalJson(Object.keys(binding.grants).map(key => PREFIX + key).sort())) throw refuse('row-set-mismatch');
            for (const key of Object.keys(binding.grants)) capabilities[key] = capability(rows[PREFIX + key], key);
            // A project config wins over home for a table both name: the workspace must leave the bound ones to home.
            await directory(workspaceRoot);
            const project = path.join(workspaceRoot, CODEX_PROJECT_CONFIG);
            if (await present(path.dirname(project))) {
                await directory(path.dirname(project));
                if (await present(project)) {
                    const named = codexProfileProjection((await read(project, false)).toString('utf8'));
                    if (Object.keys(binding.grants).some(key => Object.hasOwn(named, PREFIX + key))) throw refuse('workspace-mismatch');
                }
            }
        } else {
            if (home !== binding.instanceHome || workspaceRoot !== binding.workspaceRoot ||
                await fileSystem.realpath(workspaceRoot) !== workspaceRoot) throw refuse('profile-binding-mismatch');
            const invokers      = path.join(home, ANTIGRAVITY_MCP_DIRECTORY);
            const expectedNames = Object.keys(binding.grants).map(key => key + '.sh').sort();
            await directory(invokers);
            const beforeNames = await fileSystem.readdir(invokers);
            if (canonicalJson(beforeNames.sort()) !== canonicalJson(expectedNames)) throw refuse('invoker-set-mismatch');
            for (const key of Object.keys(binding.grants)) {
                const source  = await read(path.join(invokers, key + '.sh'));
                const receipt = parseUnambiguous((await read(path.join(home, '.neo-fleet-antigravity-' + key + '.json'))).toString('utf8'));
                if (digest(source) !== binding.invokerSha256[key] || receipt?.version !== 1 || receipt.artifact !== key + '.sh' ||
                    receipt.sha256 !== binding.invokerSha256[key]) throw refuse('invoker-mismatch');
                let row;
                try { row = parseAntigravityMcpInvoker({profileHome: home, key, source: source.toString('utf8')}) }
                catch { throw refuse('invalid-invoker') }
                capabilities[key] = capability(row, key);
            }
            await directory(workspaceRoot);
            await directory(path.join(workspaceRoot, path.dirname(ANTIGRAVITY_MCP_WORKSPACE_FILE)));
            const workspace = parseUnambiguous((await read(path.join(workspaceRoot, ANTIGRAVITY_MCP_WORKSPACE_FILE), false)).toString('utf8'));
            if (!workspace?.mcpServers || typeof workspace.mcpServers !== 'object' || Array.isArray(workspace.mcpServers)) throw refuse('workspace-mismatch');
            const owned = Object.fromEntries(Object.entries(workspace.mcpServers).filter(([name]) =>
                name.startsWith(PREFIX) && serverKeys.has(name.slice(PREFIX.length))));
            if (digest(canonicalJson(owned)) !== binding.workspaceSha256) throw refuse('workspace-mismatch');
            if (canonicalJson((await fileSystem.readdir(invokers)).sort()) !== canonicalJson(expectedNames)) throw refuse('invoker-set-mismatch');
        }
        for (const {file, stat, handle} of files) {
            if (!sameFile(stat, await handle.stat({bigint: true})) || !sameFile(stat, await fileSystem.lstat(file, {bigint: true}))) throw refuse('file-changed');
        }
        for (const {file, stat} of directories) {
            if (!sameFile(stat, await fileSystem.lstat(file, {bigint: true}), false)) throw refuse('directory-changed');
        }
        for (const file of absent) {
            const appeared = await fileSystem.lstat(file).then(() => true, error => {
                if (error?.code === 'ENOENT') return false;
                throw error
            });
            if (appeared) throw refuse('file-changed');
        }
        return capabilities;
    } catch (error) {
        throw error?.code === 'FLEET_LAUNCH_PROFILE_UNVERIFIED' ? error : refuse('custody-unavailable');
    } finally {
        await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    }
}
