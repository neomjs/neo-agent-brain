import {execFileSync}  from 'node:child_process';
import path            from 'node:path';
import fs              from 'node:fs';
import {fileURLToPath} from 'node:url';

/** @summary Refuses symbolic-link ancestors before creating or opening a vendor config directory. */
function assertDirectoryChain(directory) {
    for (let current = directory; ; current = path.dirname(current)) {
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe configuration directory');
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (current === path.dirname(current)) break
    }
}

/** @module ai/daemons/wake/antigravityWakeSidecar
 * @summary App-launched per-instance pump; the host dispatcher owns lease and request authority.
 */

/** @summary Finds the unique Antigravity App main ancestor in a host process census. */
export function resolveAntigravitySidecarAncestor({sidecarPid, rows}) {
    if (!Number.isSafeInteger(sidecarPid) || sidecarPid <= 0 || !Array.isArray(rows)) return null;
    const byPid = new Map();
    for (const row of rows) {
        if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid) || byPid.has(row.pid)) return null;
        byPid.set(row.pid, row);
    }
    let   current = byPid.get(sidecarPid);
    const seen    = new Set();
    while (current && !seen.has(current.pid)) {
        seen.add(current.pid);
        const command = current.command || '';
        const match   = command.match(/^(.*?\/Antigravity\.app)\/Contents\/MacOS\/Antigravity(?:\s|$)/);
        if (match) {
            const profile = command.match(/(?:^|\s)--user-data-dir=(.*?)(?=\s--|$)/);
            if (!profile || !path.isAbsolute(profile[1]) || !current.startedAt || !path.isAbsolute(match[1])) return null;
            return {appPid:current.pid, appStart:current.startedAt, appBundle:match[1], instanceHome:profile[1]};
        }
        current = byPid.get(current.ppid);
    }
    return null;
}

/** @summary Reads only process metadata needed to bind the sidecar to its App ancestor. */
export function readAntigravityProcessRows() {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {encoding:'utf8', maxBuffer:8*1024*1024, env:{LC_ALL:'C',TZ:'UTC'}});
    return output.split('\n').map(line => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/);
        return m && {pid:Number(m[1]), ppid:Number(m[2]), startedAt:m[3].replace(/\s+/g,' '), command:m[4]};
    }).filter(Boolean);
}

/**
 * @summary Validates the vendor's bare loopback host:port or an HTTP(S) loopback origin.
 * The original environment is never rewritten; this only gates the App-provided capability.
 */
export function validateAntigravitySidecarCapability({environment, appBundle, realpath = fs.realpathSync}) {
    try {
        const address = environment?.ANTIGRAVITY_LS_ADDRESS;
        if (typeof address !== 'string') return false;
        const match = /^(?:(?:https?):\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})(?:\/)?$/.exec(address);
        if (!match || Number(match[1]) > 65535) return false;
        // A bare address has no path, including a slash; a URL may use its canonical root slash.
        if (!address.includes('://') && address.endsWith('/')) return false;
        const bundle = realpath(appBundle), exe = realpath(environment.ANTIGRAVITY_AGENTAPI_EXE);
        return exe === path.join(bundle, 'Contents', 'Resources', 'bin', 'language_server');
    } catch { return false }
}

/**
 * @summary Calls the host dispatcher for one attested App ancestor and one fixed receiver state.
 * The host dispatcher independently verifies the App lease, registered profile, current root and
 * request nonce before sending; a discovered App process alone confers no routing authority.
 */
export async function runAntigravitySidecar({stateDir, manifestPath, environment = process.env, sidecarPid = process.pid,
    signal, intervalMs = 1000, readRows = readAntigravityProcessRows, validateCapability = validateAntigravitySidecarCapability, dispatch}) {
    if (!path.isAbsolute(stateDir || '') || !path.isAbsolute(manifestPath || '') ||
        !Number.isSafeInteger(intervalMs) || intervalMs < 100 || typeof dispatch !== 'function') throw new TypeError('Invalid sidecar configuration');
    while (!signal?.aborted) {
        const app = resolveAntigravitySidecarAncestor({sidecarPid, rows:readRows()});
        if (!app) {
            const error = new Error('Antigravity App ancestor unavailable');
            error.code = 'AGY_ANCESTOR_UNAVAILABLE';
            throw error
        }
        if (!validateCapability({environment, appBundle:app.appBundle})) {
            const error = new Error('Antigravity App capability unavailable');
            error.code = 'AGY_CAPABILITY_UNAVAILABLE';
            throw error
        }
        await dispatch({stateDir, manifestPath, environment, sidecarPid, ...app});
        if (signal?.aborted) break;
        await new Promise(resolve => {
            const timer = setTimeout(done, intervalMs);
            function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
            signal?.addEventListener('abort', done, {once:true});
            if (signal?.aborted) done();
        });
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--state') throw new Error('Expected --manifest and --state');
    const {dispatchAntigravitySidecarRecords} = await import('./fleetPrimarySessionWake.mjs');
    const controller                          = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('SIGINT', () => controller.abort());
    await runAntigravitySidecar({manifestPath:args[1], stateDir:args[3], signal:controller.signal,
        dispatch:dispatchAntigravitySidecarRecords});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        const reason = ['AGY_ANCESTOR_UNAVAILABLE', 'AGY_CAPABILITY_UNAVAILABLE'].includes(error?.code)
            ? error.code : 'AGY_STARTUP_FAILURE';
        console.error('Antigravity sidecar stopped: ' + reason);
        process.exitCode = 1
    });
}

/**
 * @summary Validates the send-only sidecar definition without writing the configuration root.
 * Existing unrelated configuration is preserved. A different existing owned definition is refused.
 * The caller owns App generation selection and must not invoke this for a live, unconsented seat.
 */
export function inspectAntigravitySidecar({configDir, nodePath, modulePath, manifestPath, stateDir, previous}) {
    for (const value of [configDir, nodePath, modulePath, manifestPath, stateDir]) {
        if (!path.isAbsolute(value || '')) throw new TypeError('Absolute sidecar paths required');
    }
    const id         = 'neo-primary-session', sidecarDir = path.join(configDir, 'sidecars', id);
    assertDirectoryChain(sidecarDir);
    const configPath = path.join(configDir, 'config.json'), definitionPath = path.join(sidecarDir, 'sidecar.json');
    const definition = {description:'Neo primary session wake', command:nodePath,
        args:[modulePath,'--manifest',manifestPath,'--state',stateDir],
        env:{ELECTRON_RUN_AS_NODE:'1'}, restart_policy:'on-failure'};
    if (previous && (!path.isAbsolute(previous.nodePath || '') || !path.isAbsolute(previous.modulePath || ''))) throw new TypeError('Invalid previous runtime');
    const oldDefinition = previous && {...definition, command:previous.nodePath,
        args:[previous.modulePath,'--manifest',manifestPath,'--state',stateDir]};
    const readRegular = file => {
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe configuration file');
            return fs.readFileSync(file, 'utf8');
        } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    };
    const previousDefinition = readRegular(definitionPath), previousConfig = readRegular(configPath);
    const actualDefinition   = previousDefinition === null ? null : JSON.parse(previousDefinition);
    const replacing          = actualDefinition !== null && JSON.stringify(actualDefinition) !== JSON.stringify(definition);
    if (replacing && (!oldDefinition || JSON.stringify(actualDefinition) !== JSON.stringify(oldDefinition))) {
        throw new Error('Conflicting owned sidecar definition');
    }
    const config = previousConfig === null ? {} : JSON.parse(previousConfig);
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config.sidecars !== undefined && (!config.sidecars || typeof config.sidecars !== 'object' || Array.isArray(config.sidecars)))) {
        throw new Error('Invalid sidecar configuration');
    }
    const existing = config.sidecars?.[id];
    // projectId selects where the App would create a conversation. This sidecar only sends to
    // a verified existing conversation, so it preserves that preference without using it.
    if (existing !== undefined && (!actualDefinition || existing?.enabled !== true ||
        Object.keys(existing).some(key => !['enabled', 'projectId', 'schemaVersion'].includes(key)) ||
        (Object.hasOwn(existing, 'projectId') && (typeof existing.projectId !== 'string' || !existing.projectId.trim())) ||
        (Object.hasOwn(existing, 'schemaVersion') && existing.schemaVersion !== 1))) {
        throw new Error('Conflicting owned sidecar configuration');
    }
    if (replacing && existing === undefined) throw new Error('Previous sidecar is not enabled');
    return {id, sidecarDir, configPath, definitionPath, definition, previousDefinition, replacing, config, existing}
}

/** @summary Installs an inspected sidecar, rechecking ownership under the config lock. */
export async function materializeAntigravitySidecar(options) {
    const initial = inspectAntigravitySidecar(options);
    fs.mkdirSync(initial.sidecarDir, {recursive:true, mode:0o700});
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(initial.configPath, async () => {
        const {id, configPath, definitionPath, definition, previousDefinition, replacing, config, existing} = inspectAntigravitySidecar(options);
        if (previousDefinition === null || replacing) writeFileAtomicSync(definitionPath, JSON.stringify(definition, null, 2) + '\n', {mode:0o600});
        if (existing === undefined) {
            config.sidecars = {...config.sidecars, [id]:{enabled:true}};
            writeFileAtomicSync(configPath, JSON.stringify(config, null, 2) + '\n', {mode:0o600, preserveMode:true});
        }
        return {state:'configured', sidecarId:id, definitionPath};
    });
}

/** @summary Prepares the two hook registrations in an explicit workspace, preserving other hooks. */
export async function materializeAntigravityWakeHooks({workspaceRoot,nodePath,hookPath,manifestPath,stateDir,previous}) {
    for (const value of [workspaceRoot,nodePath,hookPath,manifestPath,stateDir]) {
        if (!path.isAbsolute(value || '') || value.includes('\0')) throw new TypeError('Absolute hook paths required');
    }
    const quote    = value => "'" + value.replace(/'/g, "'\\\\''") + "'";
    const hooksDir = path.join(workspaceRoot,'.agents'), file=path.join(hooksDir,'hooks.json');
    assertDirectoryChain(hooksDir);
    if (previous && (!path.isAbsolute(previous.nodePath || '') || !path.isAbsolute(previous.hookPath || ''))) throw new TypeError('Invalid previous runtime');
    const entries = (node, hook) => {
        const command = event => 'ELECTRON_RUN_AS_NODE=1 ' + [node,hook,'--event',event,'--manifest',manifestPath,'--state',stateDir].map(quote).join(' ');
        return {SessionStart:[{command:command('SessionStart')}],PreInvocation:[{command:command('PreInvocation')}]}
    };
    const desired = entries(nodePath,hookPath), old = previous && entries(previous.nodePath,previous.hookPath);
    fs.mkdirSync(hooksDir,{recursive:true,mode:0o700});
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file,async()=>{
        let config = {};
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe hooks file');
            config=JSON.parse(fs.readFileSync(file,'utf8'));
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid hooks file');
        const actual = config['neo-primary-session'];
        if (actual !== undefined && JSON.stringify(actual) !== JSON.stringify(desired) &&
            (!old || JSON.stringify(actual) !== JSON.stringify(old))) throw new Error('Conflicting owned hooks');
        if (JSON.stringify(actual) === JSON.stringify(desired)) return {state:'configured',path:file};
        config['neo-primary-session']=desired;
        writeFileAtomicSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600,preserveMode:true});
        return {state:'configured',path:file};
    });
}
