import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MAX_PROJECT_FILE = 256 * 1024,
      MAX_TIMEOUT = 8000;

/** @summary A closed refusal from the read-only Antigravity project registry. */
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

    let handle, abandoned = false, openedHandle;
    const opening = Promise.resolve().then(() => fileSystem.open(path.join(directory, `${projectId}.json`), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));

    // If open resolves after its caller has timed out or canceled, close the late descriptor.
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

        if (!stat.isFile() || stat.size > MAX_PROJECT_FILE) throw refuse('project-record-invalid');

        let document;

        try { document = JSON.parse(await within(handle.readFile('utf8'), deadline, signal)) }
        catch (error) { throw preserveRefusal(error, 'project-record-invalid') }

        return normalizeNativeProjectRecord(document, projectId)
    } catch (error) {
        abandoned = true;
        if (openedHandle) {
            const lateHandle = openedHandle;
            openedHandle = null;
            await lateHandle.close().catch(() => {})
        }
        throw preserveRefusal(error, 'project-registry-unproven')
    } finally {
        if (handle) await handle.close().catch(() => {})
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
