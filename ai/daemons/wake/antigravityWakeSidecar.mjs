import {execFileSync}  from 'node:child_process';
import path            from 'node:path';
import fs              from 'node:fs';
import {fileURLToPath} from 'node:url';

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
        const match   = command.match(/^(.*?)\/Contents\/MacOS\/Antigravity(?:\s|$)/);
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

/** @summary Validates sidecar native endpoint and executable against the discovered App bundle. */
export function validateAntigravitySidecarCapability({environment, appBundle, realpath = fs.realpathSync}) {
    try {
        const endpoint = new URL(environment.ANTIGRAVITY_LS_ADDRESS);
        if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
            endpoint.username || endpoint.password || !endpoint.port) return false;
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
        if (!app || !validateCapability({environment, appBundle:app.appBundle})) throw new Error('Antigravity App capability unavailable');
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
    main().catch(() => { console.error('Antigravity sidecar stopped'); process.exitCode = 1 });
}

/**
 * @summary Installs the same send-only sidecar definition into an explicit isolated configuration root.
 * Existing unrelated configuration is preserved. A different existing owned definition is refused.
 * The caller owns App generation selection and must not invoke this for a live, unconsented seat.
 */
export async function materializeAntigravitySidecar({configDir, nodePath, modulePath, manifestPath, stateDir}) {
    for (const value of [configDir, nodePath, modulePath, manifestPath, stateDir]) {
        if (!path.isAbsolute(value || '')) throw new TypeError('Absolute sidecar paths required');
    }
    const id         = 'neo-primary-session', sidecarDir = path.join(configDir, 'sidecars', id);
    const configPath = path.join(configDir, 'config.json'), definitionPath = path.join(sidecarDir, 'sidecar.json');
    const definition = {description:'Neo primary session wake', command:nodePath,
        args:[modulePath,'--manifest',manifestPath,'--state',stateDir],
        env:{ELECTRON_RUN_AS_NODE:'1'}, restart_policy:'on-failure'};
    fs.mkdirSync(sidecarDir, {recursive:true, mode:0o700});
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(configPath, async () => {
        const readRegular = file => {
            try {
                const stat = fs.lstatSync(file);
                if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe configuration file');
                return fs.readFileSync(file, 'utf8');
            } catch (error) { if (error.code === 'ENOENT') return null; throw error }
        };
        const previousDefinition = readRegular(definitionPath), previousConfig = readRegular(configPath);
        if (previousDefinition !== null && JSON.stringify(JSON.parse(previousDefinition)) !== JSON.stringify(definition)) {
            throw new Error('Conflicting owned sidecar definition');
        }
        const config = previousConfig === null ? {} : JSON.parse(previousConfig);
        if (!config || typeof config !== 'object' || Array.isArray(config) ||
            (config.sidecars !== undefined && (!config.sidecars || typeof config.sidecars !== 'object' || Array.isArray(config.sidecars)))) {
            throw new Error('Invalid sidecar configuration');
        }
        const existing = config.sidecars?.[id];
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify({enabled:true})) {
            throw new Error('Conflicting owned sidecar configuration');
        }
        config.sidecars = {...config.sidecars, [id]:{enabled:true}};
        if (previousDefinition === null) writeFileAtomicSync(definitionPath, JSON.stringify(definition, null, 2) + '\n', {mode:0o600});
        writeFileAtomicSync(configPath, JSON.stringify(config, null, 2) + '\n', {mode:0o600, preserveMode:true});
        return {state:'configured', sidecarId:id, definitionPath};
    });
}

/** @summary Prepares the two hook registrations in an explicit workspace, preserving other hooks. */
export async function materializeAntigravityWakeHooks({workspaceRoot,nodePath,hookPath,manifestPath,stateDir}) {
    for (const value of [workspaceRoot,nodePath,hookPath,manifestPath,stateDir]) {
        if (!path.isAbsolute(value || '') || value.includes('\0')) throw new TypeError('Absolute hook paths required');
    }
    const quote    = value => "'" + value.replace(/'/g, "'\\\\''") + "'";
    const hooksDir = path.join(workspaceRoot,'.agents'), file=path.join(hooksDir,'hooks.json');
    const command  = event => 'ELECTRON_RUN_AS_NODE=1 ' + [nodePath,hookPath,'--event',event,'--manifest',manifestPath,'--state',stateDir].map(quote).join(' ');
    const desired  = {SessionStart:[{command:command('SessionStart')}],PreInvocation:[{command:command('PreInvocation')}]};
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
        if (config['neo-primary-session'] !== undefined &&
            JSON.stringify(config['neo-primary-session']) !== JSON.stringify(desired)) throw new Error('Conflicting owned hooks');
        config['neo-primary-session']=desired;
        writeFileAtomicSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600,preserveMode:true});
        return {state:'configured',path:file};
    });
}
