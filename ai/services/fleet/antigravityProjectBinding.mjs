import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import {
    AntigravityProjectRegistryRefusal,
    proveRegisteredAntigravityProject as proveRegisteredProject,
    readAntigravityProjectRecord
} from './antigravityProjectRegistry.mjs';

export {readAntigravityProjectRecord};

const
    ACTIVE_PORT_FILE = 'DevToolsActivePort',
    BROWSER_PATH     = /^\/devtools\/browser\/[A-Za-z0-9_-]+$/,
    MAX_PORT_FILE    = 512,
    MAX_WS_MESSAGE   = 4 * 1024 * 1024,
    DEFAULT_TIMEOUT  = 60000,
    MAX_TIMEOUT      = 120000,
    POLL_INTERVAL    = 100;

/**
 * @summary A closed refusal from the one-shot Antigravity project-binding proof.
 */
export class AntigravityProjectBindingRefusal extends Error {
    /**
     * @param {String} code Stable failure class; never contains profile or project contents.
     */
    constructor(code) {
        super(`Antigravity project binding refused (${code}).`);
        this.name = 'AntigravityProjectBindingRefusal';
        this.code = code
    }
}

/**
 * @summary Select one registered project in the running seat's Antigravity renderer.
 * A Start-owned listener proof, native capability proof, registry proof, exact section route and
 * visible selector name are all required. It never scans ports or starts a process.
 * @param {Object} options Exact profile/project/process identity and required proof callbacks.
 * @param {String} options.profileDirectory Electron `--user-data-dir` for the running seat.
 * @param {{id: String, name: String, root: String}} options.project Assigned native project tuple.
 * @param {{pid: Number, startedAt: String}} options.expectedProcess Lifecycle-owned process identity.
 * @param {Function} [options.readRegisteredProject] Read-only native registry adapter.
 * @param {String} [options.registryDirectory] Explicit native `config/projects` directory.
 * @param {Function} options.verifyProfileListener Proves this exact profile endpoint and process tree.
 * @param {Function} options.verifyNativeCapability Proves app version, route capability and project tuple.
 * @param {Object} [options.fileSystem=fs] Filesystem seam for deterministic tests.
 * @param {Function} [options.WebSocketCtor=WebSocket] RFC6455 client seam.
 * @param {AbortSignal} [options.signal] Start-owned cancellation signal.
 * @param {Number} [options.timeoutMs=60000] Total budget, capped at 120000 ms.
 * @returns {Promise<Object>} Project proof and observed renderer route/version.
 * @throws {AntigravityProjectBindingRefusal} On absent proof, ambiguity, timeout or cancellation.
 */
export async function bindAntigravityProject({
    profileDirectory,
    project,
    expectedProcess,
    readRegisteredProject,
    registryDirectory,
    verifyProfileListener,
    verifyNativeCapability,
    fileSystem  = fs,
    WebSocketCtor = WebSocket,
    signal,
    timeoutMs   = DEFAULT_TIMEOUT
} = {}) {
    const profile = absoluteDirectory(profileDirectory),
          projectProof = validProject(project),
          owner = validExpectedProcess(expectedProcess),
          deadline = Date.now() + boundedTimeout(timeoutMs);

    const projectReader = readRegisteredProject ?? (typeof registryDirectory === 'string'
        ? options => readAntigravityProjectRecord({...options, registryDirectory, fileSystem})
        : null);

    if (!projectReader) throw refuse('project-registry-reader-required');

    if (typeof verifyProfileListener !== 'function' || typeof verifyNativeCapability !== 'function') throw refuse('verifier-required');
    if (typeof fileSystem?.lstat !== 'function' || typeof fileSystem?.readFile !== 'function' ||
        typeof fileSystem?.realpath !== 'function') {
        throw refuse('filesystem-unavailable')
    }
    if (typeof WebSocketCtor !== 'function') throw refuse('websocket-unavailable');

    checkAbort(signal);

    const registeredProjectProof = await within(Promise.resolve().then(() => proveRegisteredProject({
        profileDirectory: profile,
        projectId: projectProof.id,
        projectName: projectProof.name,
        projectRoot: projectProof.root,
        readRegisteredProject: projectReader,
        registryDirectory,
        fileSystem,
        timeoutMs: Math.max(100, Math.min(2000, remaining(deadline))),
        signal
    })), deadline, signal).catch(error => {
        if (error instanceof AntigravityProjectRegistryRefusal) throw refuse(error.code);
        throw preserveRefusal(error, 'project-registry-unproven')
    });

    const activePortPath = path.join(profile, ACTIVE_PORT_FILE);
    const {endpoint, listenerProof} = await waitForOwnedProfileEndpoint({
        profile,
        activePortPath,
        fileSystem,
        verifyProfileListener,
        owner,
        deadline,
        signal
    });

    checkAbort(signal);

    const socketUrl = `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`;
    let socket;

    try {
        socket = new WebSocketCtor(socketUrl, {maxPayload: MAX_WS_MESSAGE});
    } catch {
        throw refuse('browser-unavailable')
    }

    const cdp = createCdpConnection(socket);

    try {
        await waitForSocketOpen(socket, deadline, signal);

        const version = await cdp.call('Browser.getVersion', {}, null, deadline, signal)
            .catch(error => { throw preserveRefusal(error, 'browser-unavailable') });

        if (typeof version?.product !== 'string' || !version.product) throw refuse('browser-unavailable');

        const renderers = await waitForUniqueRenderer({cdp, deadline, signal});

        const renderer = renderers[0], rendererUrl = canonicalRendererUrl(renderer.url), capabilityProof =
            await within(Promise.resolve().then(() => verifyNativeCapability({
                profileDirectory: profile,
                project         : projectProof,
                registeredProjectProof,
                browserProduct  : version.product,
                rendererUrl,
                listenerProof,
                signal
            })), deadline, signal).catch(error => { throw preserveRefusal(error, 'native-capability-unproven') });

        if (!capabilityMatches(capabilityProof, projectProof, version.product)) {
            throw refuse(capabilityProof?.reason === 'unsupported-app-version' ? 'unsupported-version' : 'native-capability-unproven')
        }

        const routeUrl = projectRoute(rendererUrl, projectProof.id),
              attached = await cdp.call('Target.attachToTarget', {targetId: renderer.targetId, flatten: true}, null, deadline, signal)
                  .catch(error => { throw preserveRefusal(error, 'renderer-unproven') });

        if (typeof attached?.sessionId !== 'string' || !attached.sessionId) throw refuse('renderer-unproven');

        const sessionId = attached.sessionId;

        await cdp.call('Page.enable', {}, sessionId, deadline, signal);
        const loadEvent = cdp.waitForEvent('Page.loadEventFired', sessionId, deadline, signal),
              handledLoadEvent = loadEvent.then(() => ({ok: true}), error => ({ok: false, error}));
        const navigation = await cdp.call('Page.navigate', {url: routeUrl}, sessionId, deadline, signal)
            .catch(error => { throw preserveRefusal(error, 'route-refused') });

        if (navigation?.errorText) throw refuse('route-refused');

        const loaded = await handledLoadEvent;
        if (!loaded.ok) throw preserveRefusal(loaded.error, 'route-timeout');

        const expectedUrl = new URL(routeUrl).href;
        let observedUrl = await readRendererUrl(cdp, sessionId, deadline, signal);

        if (observedUrl !== expectedUrl) throw refuse('route-mismatch');

        const marker = `Select project, current: ${projectProof.name}`;

        await waitForProjectMarker({cdp, sessionId, marker, deadline, signal});
        observedUrl = await readRendererUrl(cdp, sessionId, deadline, signal);

        if (observedUrl !== expectedUrl) throw refuse('route-mismatch');

        return {
            browserProduct: version.product,
            capabilityVersion: capabilityProof.capabilityVersion,
            projectId: projectProof.id,
            projectRoot: projectProof.root,
            registeredProjectProof,
            rendererUrl: observedUrl
        }
    } finally {
        cdp.dispose();
        terminateSocket(socket)
    }
}

/** @summary Expose native registry proof through the binder's stable refusal contract. */
export async function proveRegisteredAntigravityProject(options) {
    try {
        return await proveRegisteredProject(options)
    } catch (error) {
        if (error instanceof AntigravityProjectRegistryRefusal) throw refuse(error.code);
        throw error
    }
}

/** @summary Require one absolute, NUL-free profile path. @private */
function absoluteDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw refuse('profile-invalid');
    return path.resolve(value)
}

/** @summary Normalize the registered project fields this binding must preserve. @private */
function validProject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.id !== 'string' || !value.id.trim() ||
        typeof value.name !== 'string' || !value.name.trim() ||
        typeof value.root !== 'string' || !path.isAbsolute(value.root) || value.root.includes('\0')) {
        throw refuse('project-invalid')
    }

    return {id: value.id, name: value.name, root: path.resolve(value.root)}
}

/** @summary Require the lifecycle's positive PID and birth identity. @private */
function validExpectedProcess(value) {
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
        typeof value.startedAt !== 'string' || !value.startedAt) {
        throw refuse('process-identity-required')
    }

    return {pid: value.pid, startedAt: value.startedAt}
}

/** @summary Bound one operation to a short, valid wall-clock budget. @private */
function boundedTimeout(value) {
    if (!Number.isSafeInteger(value) || value < 100 || value > MAX_TIMEOUT) throw refuse('timeout-invalid');
    return value
}

/** @summary Parse the exact profile-local DevTools port/browser pair. @private */
function parseActivePort(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PORT_FILE) throw refuse('stale-endpoint');
    const lines = value.trim().split(/\r?\n/);

    if (lines.length !== 2 || !/^[1-9]\d{0,4}$/.test(lines[0]) || !BROWSER_PATH.test(lines[1])) {
        throw refuse('stale-endpoint')
    }

    const port = Number(lines[0]);

    if (port < 1 || port > 65535) throw refuse('stale-endpoint');

    return {port, browserPath: lines[1]}
}

/** @summary Wait only on the supplied profile until its endpoint is owned by the original Start. @private */
async function waitForOwnedProfileEndpoint({profile, activePortPath, fileSystem, verifyProfileListener, owner, deadline, signal}) {
    let lastRefusal = 'stale-endpoint';

    while (remaining(deadline) > 0) {
        checkAbort(signal);

        try {
            const
                profileStat = await within(Promise.resolve().then(() => fileSystem.lstat(profile)), deadline, signal),
                portStat    = await within(Promise.resolve().then(() => fileSystem.lstat(activePortPath)), deadline, signal);

            if (!profileStat.isDirectory() || profileStat.isSymbolicLink() ||
                !portStat.isFile() || portStat.isSymbolicLink()) {
                throw refuse('stale-endpoint')
            }

            const activePortText = await within(Promise.resolve().then(() => fileSystem.readFile(activePortPath, 'utf8')), deadline, signal),
                  endpoint = parseActivePort(activePortText),
                  listenerProof = await within(Promise.resolve().then(() => verifyProfileListener({
                      profileDirectory: profile,
                      port: endpoint.port,
                      browserPath: endpoint.browserPath,
                      expectedProcess: owner,
                      signal
                  })), deadline, signal).catch(error => { throw preserveRefusal(error, 'listener-unproven') }),
                  refusalCode = listenerRefusal(listenerProof, {profileDirectory: profile, endpoint, owner});

            if (!refusalCode) return {endpoint, listenerProof};
            if (refusalCode !== 'stale-endpoint' && refusalCode !== 'listener-unproven') throw refuse(refusalCode);
            lastRefusal = refusalCode
        } catch (error) {
            if (error instanceof AntigravityProjectBindingRefusal) {
                if (error.code !== 'stale-endpoint' && error.code !== 'listener-unproven') throw error;
                lastRefusal = error.code
            } else if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
                if (error?.code === 'canceled' || error?.code === 'timeout') throw error;
                lastRefusal = 'stale-endpoint'
            }
        }

        await within(new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL, remaining(deadline)))), deadline, signal)
    }

    throw refuse(lastRefusal)
}

/** @summary Wait for the first unique Antigravity renderer without selecting an ambiguous page. @private */
async function waitForUniqueRenderer({cdp, deadline, signal}) {
    while (remaining(deadline) > 0) {
        checkAbort(signal);
        const targets = await cdp.call('Target.getTargets', {}, null, deadline, signal)
            .catch(error => { throw preserveRefusal(error, 'browser-unavailable') });
        const renderers = (Array.isArray(targets?.targetInfos) ? targets.targetInfos : [])
            .filter(target => target.type === 'page' && rendererOrigin(target.url));

        if (renderers.length > 1) throw refuse('renderer-ambiguous');
        if (renderers.length === 1) return renderers;

        await within(new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL, remaining(deadline)))), deadline, signal)
    }

    throw refuse('renderer-unproven')
}

/** @summary Classify the injected profile listener receipt without accepting PID or endpoint drift. @private */
function listenerRefusal(proof, {profileDirectory, endpoint, owner}) {
    if (proof?.verified !== true) return 'listener-unproven';
    if (proof.pid !== owner.pid || proof.startedAt !== owner.startedAt) return 'listener-pid-mismatch';
    if (proof.profileDirectory !== profileDirectory || proof.port !== endpoint.port || proof.browserPath !== endpoint.browserPath) {
        return 'stale-endpoint'
    }
    if (proof.processTreeVerified !== true) return 'process-tree-unproven';

    return null
}

/** @summary Require the injected capability receipt to bind build, project ID/name/root, and renderer. @private */
function capabilityMatches(proof, project, browserProduct) {
    return Boolean(proof?.verified === true && proof.projectId === project.id && proof.projectName === project.name &&
        proof.projectRoot === project.root && proof.browserProduct === browserProduct &&
        typeof proof.capabilityVersion === 'string' && proof.capabilityVersion.trim())
}

/** @summary Recognize only a root HTTPS renderer hosted on the loopback address. @private */
function rendererOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === '127.0.0.1' &&
            /^[1-9]\d{0,4}$/.test(url.port) && Number(url.port) <= 65535 && url.pathname === '/' &&
            !url.username && !url.password && !url.hash
    } catch {
        return false
    }
}

/** @summary Strip an old section query before constructing the requested project route. @private */
function canonicalRendererUrl(value) {
    const url = new URL(value);
    url.search = '';
    return url.href
}

/** @summary Construct the one same-origin project section route proved by the native capability. @private */
function projectRoute(rendererUrl, projectId) {
    const url = new URL(rendererUrl);
    url.searchParams.set('section', projectId);
    return url.href
}

/** @summary Correlate bounded CDP commands/events over the one profile-owned WebSocket. @private */
function createCdpConnection(socket) {
    let nextId = 0;
    const pending = new Map(), eventListeners = new Set();

    const onMessage = data => {
        let message;
        try { message = JSON.parse(data.toString()) } catch { return }

        if (Number.isSafeInteger(message.id)) {
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            message.error
                ? entry.reject(refuse(entry.method === 'Page.navigate' ? 'route-refused' : 'devtools-command-failed'))
                : entry.resolve(message.result || {});
            return
        }

        for (const listener of eventListeners) {
            if (listener.method === message.method && listener.sessionId === (message.sessionId ?? null)) {
                eventListeners.delete(listener);
                listener.resolve(message.params || {})
            }
        }
    };
    const onError = () => failAll(refuse('browser-unavailable'));
    const onClose = () => failAll(refuse('browser-unavailable'));
    const failAll = error => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
        for (const entry of eventListeners) entry.reject(error);
        eventListeners.clear()
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);

    return {
        call(method, params, sessionId, deadline, signal) {
            const id = ++nextId;
            return boundedWait({deadline, signal, subscribe: (resolve, reject) => {
                pending.set(id, {method, resolve, reject});
                try {
                    socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}))
                } catch {
                    reject(refuse('browser-unavailable'))
                }
                return () => pending.delete(id)
            }})
        },
        waitForEvent(method, sessionId, deadline, signal) {
            return boundedWait({deadline, signal, subscribe: (resolve, reject) => {
                const entry = {method, sessionId, resolve, reject};
                eventListeners.add(entry)
                return () => eventListeners.delete(entry)
            }})
        },
        dispose() {
            socket.off('message', onMessage);
            socket.off('error', onError);
            socket.off('close', onClose);
            failAll(refuse('browser-unavailable'))
        }
    }
}

/** @summary Await the exact browser WebSocket without leaking listeners on abort or timeout. @private */
function waitForSocketOpen(socket, deadline, signal) {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();

    return boundedWait({deadline, signal, subscribe: (resolve, reject) => {
        const open = () => resolve(),
              error = () => reject(refuse('browser-unavailable')),
              close = () => reject(refuse('browser-unavailable'));

        socket.once('open', open);
        socket.once('error', error);
        socket.once('close', close);

        return () => {
            socket.off('open', open);
            socket.off('error', error);
            socket.off('close', close)
        }
    }});
}

/** @summary Read the page's main-frame URL through CDP metadata, never renderer JavaScript. @private */
async function readRendererUrl(cdp, sessionId, deadline, signal) {
    const result = await cdp.call('Page.getFrameTree', {}, sessionId, deadline, signal)
        .catch(error => { throw preserveRefusal(error, 'route-mismatch') });

    return result?.frameTree?.frame?.url
}

/** @summary Wait boundedly for one visible project selector with the exact registered project name. @private */
async function waitForProjectMarker({cdp, sessionId, marker, deadline, signal}) {
    while (Date.now() < deadline) {
        checkAbort(signal);
        const response = await cdp.call('Accessibility.getFullAXTree', {}, sessionId, deadline, signal)
            .catch(error => { throw error instanceof AntigravityProjectBindingRefusal ? error : refuse('marker-unavailable') });
        const matches = (Array.isArray(response.nodes) ? response.nodes : []).filter(node =>
            node.ignored !== true && ['button', 'combobox'].includes(node.role?.value) && node.name?.value === marker);

        if (matches.length > 1) throw refuse('marker-ambiguous');
        if (matches.length === 1) return;

        await within(new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL, remaining(deadline)))), deadline, signal)
    }

    throw refuse('marker-mismatch')
}

/** @summary Race an injected asynchronous step against the operation deadline and Start cancellation. @private */
function within(promise, deadline, signal) {
    return boundedWait({deadline, signal, subscribe: (resolve, reject) => {
        Promise.resolve(promise).then(resolve, reject)
    }})
}

/** @summary Share one timeout, cancellation, and unsubscription path for a bounded asynchronous wait. @private */
function boundedWait({deadline, signal, subscribe}) {
    if (signal?.aborted) return Promise.reject(refuse('canceled'));
    const timeout = remaining(deadline);
    if (!timeout) return Promise.reject(refuse('timeout'));

    return new Promise((resolve, reject) => {
        let settled = false, detach = () => {};
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            const cleanup = detach;
            detach = () => {};
            cleanup();
            fn(value)
        };
        const timer = setTimeout(() => finish(reject, refuse('timeout')), timeout),
              abort = () => finish(reject, refuse('canceled'));

        signal?.addEventListener('abort', abort, {once: true});

        try {
            const cleanup = subscribe(value => finish(resolve, value), error => finish(reject, error));
            if (typeof cleanup === 'function') {
                if (settled) cleanup();
                else detach = cleanup
            }
        } catch (error) {
            finish(reject, error)
        }
    })
}

/** @summary Return the remaining milliseconds without extending an operation's original deadline. @private */
function remaining(deadline) {
    return Math.max(0, deadline - Date.now())
}

/** @summary Refuse an already-canceled Start before doing further work. @private */
function checkAbort(signal) {
    if (signal?.aborted) throw refuse('canceled')
}

/** @summary Create one closed refusal with a stable reason code. @private */
function refuse(code) {
    return new AntigravityProjectBindingRefusal(code)
}

/** @summary Preserve typed refusals and collapse unknown collaborator failures to one closed code. @private */
function preserveRefusal(error, fallback) {
    return error instanceof AntigravityProjectBindingRefusal ? error : refuse(fallback)
}

/** @summary Terminate only the owned CDP client while consuming a late close-time socket error. @private */
function terminateSocket(socket) {
    if (!socket) return;

    const consumeError = () => {},
          cleanup = () => {
              socket.off('error', consumeError);
              socket.off('close', cleanup)
          };

    socket.on('error', consumeError);
    socket.once('close', cleanup);

    try {
        if (socket.readyState === 3) {
            cleanup()
        } else if (typeof socket.terminate === 'function') {
            socket.terminate()
        } else {
            socket.close()
        }
    } catch {
        cleanup()
    }
}
