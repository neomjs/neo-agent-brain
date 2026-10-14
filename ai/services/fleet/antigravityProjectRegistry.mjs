import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {writeFileAtomic} from '../shared/atomicFileWrite.mjs';
import {MCP_SERVERS} from '../../../src/fleet/contract/mcpServers.mjs';

const MAX_PROJECT_FILE = 256 * 1024,
      MAX_TIMEOUT = 8000;

/** @summary A closed refusal from Antigravity project registry operations. */
export class AntigravityProjectRegistryRefusal extends Error {
    constructor(code) {
        super(`Antigravity project registry refused (${code}).`);
        this.name = 'AntigravityProjectRegistryRefusal';
        this.code = code
    }
}

/**
 * @summary Read one UUID-named native project file from an explicitly supplied registry directory.
 * Grants, settings and other project data are parsed but never returned or changed.
 */
export async function readAntigravityProjectRecord({registryDirectory, projectId, fileSystem = fs, signal, timeoutMs = 2000} = {}) {
    const document = await readNativeProjectDocument({registryDirectory, projectId, fileSystem, signal, timeoutMs});

    return normalizeNativeProjectRecord(document, projectId)
}

/** @summary Bind a managed root to a create-only, profile-receipted Antigravity project. */
export async function registerAntigravityProject({
    registryDirectory,
    profileDirectory,
    projectRoot,
    name,
    projectMcpAllowRules,
    fileSystem = fs,
    writeAtomic = writeFileAtomic,
    idFactory = randomUUID,
    signal,
    timeoutMs = 2000
} = {}) {
    const directory = absoluteDirectory(registryDirectory), profile = absoluteDirectory(profileDirectory),
          root = absoluteDirectory(projectRoot), deadline = Date.now() + boundedTimeout(timeoutMs);

    validateProjectName(name);
    validateMcpAllowRules(projectMcpAllowRules);
    if (typeof idFactory !== 'function' || typeof writeAtomic !== 'function') throw refuse('writer-unavailable');
    checkAbort(signal);

    const [registryStat, registryRealPath, profileStat, profileRealPath, rootStat, rootRealPath] = await Promise.all([
        within(fileSystem.lstat(directory), deadline, signal), within(fileSystem.realpath(directory), deadline, signal),
        within(fileSystem.lstat(profile), deadline, signal), within(fileSystem.realpath(profile), deadline, signal),
        within(fileSystem.lstat(root), deadline, signal), within(fileSystem.realpath(root), deadline, signal)
    ]).catch(error => { throw preserveRefusal(error, 'project-path-unproven') });

    if (!registryStat.isDirectory() || registryStat.isSymbolicLink() || registryRealPath !== directory ||
        !profileStat.isDirectory() || profileStat.isSymbolicLink() || profileRealPath !== profile ||
        !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootRealPath !== root) throw refuse('project-path-unproven');

    const receiptPath = path.join(profile, '.neo-fleet-project-binding.json');
    let receipt = await readSmallJsonFile(receiptPath, {fileSystem, deadline, signal, missingOk: true, requirePrivate: true}),
        created = false;

    if (receipt === null) {
        const projectId = idFactory();

        if (!isSafeProjectId(projectId)) throw refuse('project-id-invalid');
        receipt = {version: 1, projectId, projectName: name, projectRoot: root};
        await writeJson(writeAtomic, receiptPath, receipt, deadline, signal)
    } else if (!validReceipt(receipt, name, root)) {
        throw refuse('project-receipt-mismatch')
    }

    const projectId = receipt.projectId,
          projectPath = path.join(directory, `${projectId}.json`),
          current = await readSmallJsonFile(projectPath, {fileSystem, deadline, signal, missingOk: true});
    let document;

    if (current === null) {
        document = newProjectRecord({projectId, name, root, projectMcpAllowRules});
        created = true
    } else {
        if (!matchesRegisteredRoot(current, projectId, name, root)) throw refuse('project-registry-mismatch');
        document = mergeProjectAllowRules(current, projectMcpAllowRules)
    }

    if (created || JSON.stringify(document) !== JSON.stringify(current)) {
        await writeJson(writeAtomic, projectPath, document, deadline, signal)
    }

    return Object.freeze({verified: true, created, projectId, projectName: name, projectRoot: root, receiptPath})
}

/** @summary Read one bounded native record from the explicitly selected registry. @private */
async function readNativeProjectDocument({registryDirectory, projectId, fileSystem = fs, signal, timeoutMs = 2000} = {}) {
    const directory = absoluteDirectory(registryDirectory), deadline = Date.now() + boundedTimeout(timeoutMs);

    if (!isSafeProjectId(projectId)) throw refuse('project-id-invalid');
    if (typeof fileSystem?.lstat !== 'function' || typeof fileSystem?.realpath !== 'function' ||
        typeof fileSystem?.open !== 'function' || !Number.isSafeInteger(fsConstants.O_NOFOLLOW)) throw refuse('filesystem-unavailable');

    checkAbort(signal);

    let directoryStat, directoryRealPath;

    try {
        [directoryStat, directoryRealPath] = await Promise.all([
            within(fileSystem.lstat(directory), deadline, signal),
            within(fileSystem.realpath(directory), deadline, signal)
        ])
    } catch (error) {
        throw preserveRefusal(error, 'project-registry-unproven')
    }

    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryRealPath !== directory) {
        throw refuse('project-registry-unproven')
    }

    const document = await readJsonFile(path.join(directory, `${projectId}.json`), {fileSystem, deadline, signal});

    if (!document || typeof document !== 'object' || Array.isArray(document) || document.id !== projectId) {
        throw refuse('project-record-invalid')
    }

    return document
}

/** @summary Read one bounded no-follow JSON file, optionally treating only ENOENT as absent. @private */
async function readSmallJsonFile(filePath, {fileSystem, deadline, signal, missingOk = false, requirePrivate = false}) {
    try {
        return await readJsonFile(filePath, {fileSystem, deadline, signal, requirePrivate})
    } catch (error) {
        if (missingOk && error?.code === 'ENOENT') return null;
        throw preserveRefusal(error, 'project-file-unproven')
    }
}

/** @summary Read bounded JSON without following links or leaking a descriptor on a late open. @private */
async function readJsonFile(filePath, {fileSystem, deadline, signal, requirePrivate = false}) {
    if (typeof fileSystem?.open !== 'function' || !Number.isSafeInteger(fsConstants.O_NOFOLLOW)) throw refuse('filesystem-unavailable');

    let handle, abandoned = false, openedHandle;
    const opening = Promise.resolve().then(() => fileSystem.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));

    opening.then(value => {
        openedHandle = value;
        if (abandoned) {
            openedHandle = null;
            value.close().catch(() => {})
        }
    }, () => {});

    try {
        handle = await within(opening, deadline, signal);
        openedHandle = null;
        const stat = await within(handle.stat(), deadline, signal);

        if (!stat.isFile() || stat.size > MAX_PROJECT_FILE || requirePrivate && (stat.mode & 0o077) !== 0) {
            throw refuse('project-file-invalid')
        }

        try { return JSON.parse(await within(handle.readFile('utf8'), deadline, signal)) }
        catch (error) { throw preserveRefusal(error, 'project-file-invalid') }
    } catch (error) {
        abandoned = true;
        if (openedHandle) {
            const lateHandle = openedHandle;
            openedHandle = null;
            await lateHandle.close().catch(() => {})
        }
        if (error?.code === 'ENOENT') throw error;
        throw preserveRefusal(error, 'project-file-unproven')
    } finally {
        if (handle) await handle.close().catch(() => {})
    }
}

/** @summary Create the native JSON using only project-scoped authorization and no seat identity. @private */
function newProjectRecord({projectId, name, root, projectMcpAllowRules}) {
    return {
        id: projectId,
        name,
        projectResources: {resources: [{folderUri: pathToFileURL(root).href}]},
        permissionGrants: {permissionGrants: {allow: [...projectMcpAllowRules]}, v2Migrated: true},
        settings: {},
        isWorkspaceOnly: false
    }
}

/** @summary Preserve all native fields while adding only exact canonical project-scope permissions. @private */
function mergeProjectAllowRules(document, projectMcpAllowRules) {
    const outer = document.permissionGrants ?? {};
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) throw refuse('project-grants-invalid');
    const grants = outer.permissionGrants ?? {};
    if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw refuse('project-grants-invalid');
    const allow = grants.allow ?? [];
    if (!Array.isArray(allow) || allow.some(rule => typeof rule !== 'string')) throw refuse('project-grants-invalid');
    const merged = [...allow, ...projectMcpAllowRules.filter(rule => !allow.includes(rule))];

    return {...document, permissionGrants: {...outer, permissionGrants: {...grants, allow: merged}}}
}

/** @summary Match a receipt-owned native row to one exact registered project root. @private */
function matchesRegisteredRoot(document, projectId, name, root) {
    if (!document || typeof document !== 'object' || document.id !== projectId || document.name !== name) return false;

    try {
        const normalized = normalizeNativeProjectRecord(document, projectId), uri = new URL(normalized.folderUris[0]);

        return uri.protocol === 'file:' && !uri.username && !uri.password && !uri.search && !uri.hash &&
            (!uri.hostname || uri.hostname === 'localhost') && path.resolve(fileURLToPath(uri)) === root
    } catch {
        return false
    }
}

/** @summary Validate only the profile-local create-only receipt tuple. @private */
function validReceipt(receipt, name, root) {
    return Boolean(receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
        Object.keys(receipt).length === 4 && receipt.version === 1 && isSafeProjectId(receipt.projectId) &&
        receipt.projectName === name && receipt.projectRoot === root)
}

/** @summary Require the exact MCP allow rules generated for the project's canonical server set. @private */
function validateMcpAllowRules(value) {
    const expected = MCP_SERVERS.map(({key}) => `mcp(neo-mjs-${key}/*)`);

    if (!Array.isArray(value) || value.length !== expected.length || value.some((rule, index) => rule !== expected[index])) {
        throw refuse('project-mcp-rules-invalid')
    }
}

/** @summary Require one non-empty, NUL-free project name. @private */
function validateProjectName(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw refuse('project-name-invalid')
}

/** @summary Persist one JSON value through the shared atomic write primitive. @private */
async function writeJson(writeAtomic, filePath, value, deadline, signal) {
    checkAbort(signal);
    if (deadline <= Date.now()) throw refuse('timeout');

    try {
        await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
        checkAbort(signal);
        if (deadline <= Date.now()) throw refuse('timeout')
    } catch (error) {
        throw preserveRefusal(error, 'project-write-failed')
    }
}

/** @summary Verify one native project record against the exact profile and assigned real checkout. */
export async function proveRegisteredAntigravityProject({
    profileDirectory,
    projectId,
    projectName,
    projectRoot,
    readRegisteredProject,
    registryDirectory,
    fileSystem = fs,
    signal,
    timeoutMs = 2000
} = {}) {
    const profile = absoluteDirectory(profileDirectory), root = absoluteDirectory(projectRoot),
          project = {id: projectId, name: projectName, root}, deadline = Date.now() + boundedTimeout(timeoutMs),
          reader = resolveReader({readRegisteredProject, registryDirectory, fileSystem});

    if (typeof project.id !== 'string' || !project.id.trim() || typeof project.name !== 'string' || !project.name.trim() ||
        typeof fileSystem?.lstat !== 'function' || typeof fileSystem?.realpath !== 'function') throw refuse('project-invalid');

    let profileStat, profileRealPath, record;

    try {
        [profileStat, profileRealPath, record] = await Promise.all([
            within(fileSystem.lstat(profile), deadline, signal),
            within(fileSystem.realpath(profile), deadline, signal),
            within(reader({profileDirectory: profile, projectId: project.id, signal}), deadline, signal)
        ])
    } catch (error) {
        throw preserveRefusal(error, 'project-registry-unproven')
    }

    if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || profileRealPath !== profile) throw refuse('profile-invalid');
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== project.id || record.name !== project.name ||
        !Array.isArray(record.folderUris) || record.folderUris.length !== 1 || !Object.hasOwn(record.folderUris, 0)) {
        throw refuse('project-registry-mismatch')
    }

    let registeredRoot;

    try {
        const uri = new URL(record.folderUris[0]);

        if (uri.protocol !== 'file:' || uri.username || uri.password || uri.search || uri.hash ||
            (uri.hostname && uri.hostname !== 'localhost')) throw refuse('project-folder-mismatch');

        registeredRoot = path.resolve(fileURLToPath(uri))
    } catch (error) {
        throw preserveRefusal(error, 'project-folder-mismatch')
    }

    if (registeredRoot !== root) throw refuse('project-folder-mismatch');

    let rootStat, realRoot;

    try {
        [rootStat, realRoot] = await Promise.all([
            within(fileSystem.lstat(root), deadline, signal),
            within(fileSystem.realpath(root), deadline, signal)
        ])
    } catch (error) {
        throw preserveRefusal(error, 'project-folder-unproven')
    }

    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realRoot !== root) throw refuse('project-folder-unproven');

    return Object.freeze({verified: true, profileDirectory: profile, projectId: project.id, projectName: project.name, projectRoot: root})
}

/** @summary Select the explicitly supplied read-only registry adapter. @private */
function resolveReader({readRegisteredProject, registryDirectory, fileSystem}) {
    if (typeof readRegisteredProject === 'function') return readRegisteredProject;
    if (typeof registryDirectory !== 'string') throw refuse('project-registry-reader-required');

    return ({projectId, signal}) => readAntigravityProjectRecord({registryDirectory, projectId, fileSystem, signal})
}

/** @summary Normalize one supported Antigravity folder resource without copying grants/settings. @private */
function normalizeNativeProjectRecord(document, expectedId) {
    if (!document || typeof document !== 'object' || Array.isArray(document) || document.id !== expectedId ||
        typeof document.name !== 'string' || !document.name.trim() || !document.projectResources ||
        typeof document.projectResources !== 'object' || Array.isArray(document.projectResources) ||
        !Array.isArray(document.projectResources.resources) || document.projectResources.resources.length !== 1 ||
        !Object.hasOwn(document.projectResources.resources, 0)) throw refuse('project-record-invalid');

    const resource = document.projectResources.resources[0];

    if (!resource || typeof resource !== 'object' || Array.isArray(resource) || Object.keys(resource).length !== 1) {
        throw refuse('project-resource-unsupported')
    }

    const nested = resource.gitFolder;
    const folderUri = typeof resource.folderUri === 'string' ? resource.folderUri
        : nested && typeof nested === 'object' && !Array.isArray(nested) && Object.keys(nested).length === 1 &&
          typeof nested.folderUri === 'string' ? nested.folderUri : null;

    if (!folderUri) throw refuse('project-resource-unsupported');

    return {id: document.id, name: document.name, folderUris: [folderUri]}
}

/** @summary Require a UUID-shaped filename segment. @private */
function isSafeProjectId(value) {
    return typeof value === 'string' && /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/.test(value)
}

/** @summary Require an absolute, NUL-free filesystem path. @private */
function absoluteDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw refuse('project-path-invalid');
    return path.resolve(value)
}

/** @summary Bound the registry operation to a short positive deadline. @private */
function boundedTimeout(value) {
    if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT) throw refuse('timeout-invalid');
    return value
}

/** @summary Race an operation against the absolute deadline and caller cancellation. @private */
function within(promise, deadline, signal) {
    const timeout = Math.max(0, deadline - Date.now());

    if (signal?.aborted) return Promise.reject(refuse('canceled'));
    if (!timeout) return Promise.reject(refuse('timeout'));

    return new Promise((resolve, reject) => {
        const finish = (fn, value) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            fn(value)
        };
        const timer = setTimeout(() => finish(reject, refuse('timeout')), timeout),
              abort = () => finish(reject, refuse('canceled'));

        signal?.addEventListener('abort', abort, {once: true});
        Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error))
    })
}

/** @summary Check cancellation without starting another filesystem operation. @private */
function checkAbort(signal) {
    if (signal?.aborted) throw refuse('canceled')
}

/** @summary Preserve classified refusals and hide filesystem/JSON failure detail. @private */
function preserveRefusal(error, fallback) {
    return error instanceof AntigravityProjectRegistryRefusal ? error : refuse(fallback)
}

/** @summary Create a stable, content-free registry refusal. @private */
function refuse(code) {
    return new AntigravityProjectRegistryRefusal(code)
}
