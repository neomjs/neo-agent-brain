/**
 * @module ai/services/fleet/prepareFleetNativeWake
 * @summary Prepares native wake files for one trusted Fleet seat without enrolling it.
 */
import fs                                                                                          from 'node:fs/promises';
import {constants as fsConstants}                                                                  from 'node:fs';
import path                                                                                        from 'node:path';
import {fileURLToPath}                                                                             from 'node:url';
import {createHash}                                                                                from 'node:crypto';
import {isDeepStrictEqual}                                                                         from 'node:util';
import {deriveCodexHome}                                                                           from './deriveHarnessLaunchSpec.mjs';
import {materializeCodexWakeAdmission}                                                             from '../../daemons/wake/codexSessionWake.mjs';
import {inspectAntigravitySidecar, materializeAntigravitySidecar, materializeAntigravityWakeHooks} from '../../daemons/wake/antigravityWakeSidecar.mjs';
import {readPrivateWakeJson}                                                                       from '../../daemons/wake/nativeWakeEnrollment.mjs';
import {withOutboxLock}                                                                            from '../../daemons/wake/outboxLock.mjs';
import {writeFileAtomic}                                                                           from '../shared/atomicFileWrite.mjs';
import {assertUntrackedManagedWorkspaceFile, excludeManagedNativeWakeHook}                         from './excludeManagedWorkspaceFiles.mjs';
import {isRuntimeGenerationPin, readRuntimeGeneration, runtimeGenerationPin}                       from './runtimeGeneration.mjs';
import {readCodexWakeArtifact}                                                                     from './readCodexWakeArtifact.mjs';
import {CODEX_WAKE_ARTIFACT_DECLARATION, CODEX_WAKE_WIRE}                                          from './codexWakeArtifact.mjs';

const wakeModule = name => fileURLToPath(new URL(`../../daemons/wake/${name}.mjs`, import.meta.url));
const absolute   = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root;

/**
 * @summary Selects only a live Start's retained hook, or a previously enrolled current-host hook.
 * The lifecycle owner must have proved the Start and its immutable runtime before calling this reader.
 * The declaration binds the opaque nonce, redemption, root/turn, receipt and denial/restaging wire.
 * @param {Object} options Fleet-proven seat, enrollment, current host and original Start pin.
 * @param {String} options.agentId Managed seat identifier.
 * @param {String} options.instanceHome Managed instance home.
 * @param {String} options.workspaceRoot Verified Start workspace.
 * @param {String} options.manifestPath Receiver manifest.
 * @param {String} options.stateDir Receiver state directory.
 * @param {Object|null} options.runtime Original Start's held runtime pin.
 * @param {Boolean} options.enrolled Whether this seat is already enrolled.
 * @param {Function} [options.verifyRuntime] Operation-scoped sealed-runtime verifier.
 * @param {Function} [options.retainArtifact] Keeps the verified shared tree's custody check for this Start.
 * @returns {Promise<{nodePath: String, hookModulePath: String}>} The one selected executable and hook.
 */
export async function resolveCodexWakeRuntime({agentId, instanceHome, workspaceRoot, manifestPath, stateDir, runtime, enrolled,
    verifyRuntime = readRuntimeGeneration, retainArtifact}) {
    const current  = {nodePath: process.execPath, hookModulePath:wakeModule('codexWakeHook')};
    const expected = {version:1, family:'codex-desktop', agentId, instanceHome, workspaceRoot, manifestPath, stateDir, configDir:null};
    const previous = await readPrivateWakeJson(path.join(stateDir, 'native-wake-preparation', agentId + '.json'));
    if (previous && !matchesReceipt(previous, expected, 'codex-desktop')) throw new Error('Mismatched seat preparation record');
    if (runtime?.id || runtime?.pin === 'held') {
        const {pin, ...claimed} = runtime;
        if (!isRuntimeGenerationPin(claimed)) throw new Error('Codex wake Start runtime is unproven');
        const artifact = await readCodexWakeArtifact(claimed, retainArtifact);
        if (artifact) {
            if (pin !== 'held') throw new Error('Codex wake artifact is not retained');
            if (previous && (previous.nodePath !== artifact.nodePath || previous.modulePath !== artifact.hookModulePath)) {
                throw new Error('Codex wake migration is not retained')
            }
            return artifact
        }
    } else {
        // A packaged artifact cannot authorize the current-process shortcut for a seat with no original Start.
        const packaged = new URL('../../../' + CODEX_WAKE_ARTIFACT_DECLARATION, import.meta.url);
        const present  = await fs.lstat(packaged).catch(error => { if (error.code !== 'ENOENT') throw error });
        if (present) throw new Error('Codex wake artifact has no retained Start')
    }
    if (!enrolled && !previous) return current;
    // Explicit pilot migration stays on the host-owned tuple when that same host is still live.
    if (previous?.nodePath === current.nodePath && previous?.modulePath === current.hookModulePath) return current;
    if (!runtime) throw new Error('Codex wake Start runtime is unproven');
    const {pin, ...claimed} = runtime;
    if (pin !== 'held' || !isRuntimeGenerationPin(claimed)) throw new Error('Codex wake Start runtime is unproven');
    // This is a setup/re-arm boundary, not wake dispatch: prove the complete executable closure.
    const compatibilityError = () => Object.assign(new Error('Codex wake compatibility is unproven'), {code:'CODEX_WAKE_COMPATIBILITY_UNPROVEN'});
    const verified           = await verifyRuntime({directory:claimed.directory, pin:claimed}).catch(() => { throw compatibilityError() });
    if (!verified || !isDeepStrictEqual(runtimeGenerationPin(verified), claimed)) throw new Error('Codex wake Start runtime changed');
    const hookModulePath = path.join(runtime.runtimeRoot, 'ai/daemons/wake/codexWakeHook.mjs');
    if (previous && (previous.nodePath !== runtime.executable || previous.modulePath !== hookModulePath)) throw new Error('Codex wake migration is not retained');
    if (runtime.executable === current.nodePath && hookModulePath === current.hookModulePath) return current;
    const declaration = path.join(runtime.runtimeRoot, 'ai/daemons/wake/codexWakeProtocol.json');
    const stat        = await fs.lstat(declaration).catch(() => { throw compatibilityError() });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o222 || await fs.realpath(declaration) !== declaration ||
        await fs.realpath(hookModulePath) !== hookModulePath || !(await fs.stat(hookModulePath)).isFile()) {
        throw new Error('Codex wake file does not match its sealed generation')
    }
    const handle = await fs.open(declaration, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let declarationBytes;
    try {
        const opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.mode !== stat.mode || opened.size !== stat.size) {
            throw new Error('Codex wake declaration changed while opening')
        }
        declarationBytes = await handle.readFile()
    } finally { await handle.close() }
    if (JSON.parse(declarationBytes).wire !== CODEX_WAKE_WIRE) {
        throw compatibilityError()
    }
    return {nodePath:runtime.executable, hookModulePath}
}

/** @summary Validates a host-owned receipt against its exact seat or shared-sidecar binding. */
function matchesReceipt(record, expected, family) {
    const keys           = [...Object.keys(expected), 'nodePath', 'modulePath', ...(family === 'antigravity' ? ['hookPath'] : [])].sort();
    const expectedModule = family === 'antigravity' ? 'antigravityWakeSidecar.mjs' : 'codexWakeHook.mjs';
    return record && Object.keys(record).sort().join('\0') === keys.join('\0') &&
        Object.entries(expected).every(([key, value]) => record[key] === value) &&
        absolute(record.nodePath) && absolute(record.modulePath) && path.basename(record.modulePath) === expectedModule &&
        (family !== 'antigravity' || absolute(record.hookPath) &&
            record.hookPath === path.join(path.dirname(record.modulePath), 'antigravityWakeHook.mjs'))
}

/** @summary Persists a changed receipt while keeping an identical one untouched. */
async function writeReceipt(file, current, previous) {
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
        await writeFileAtomic(file, JSON.stringify(current), {mode:0o600, fsync:true})
    }
}

/** @summary Performs the serialized preparation and records only successful owned configurations. */
async function prepareOwned({agent, instanceHome, workspaceRoot, manifestPath, stateDir, configDir, nodePath, hookModulePath, recordsDir, completed}) {
    const seatFile   = path.join(recordsDir, agent.id + '.json');
    const sharedFile = agent.harnessType === 'antigravity'
        ? path.join(recordsDir, 'shared-' + createHash('sha256').update(configDir).digest('hex') + '.json') : null;
    const previous      = await readPrivateWakeJson(seatFile), shared = sharedFile ? await readPrivateWakeJson(sharedFile) : null;
    const family        = agent.harnessType;
    const binding       = {version:1, family, agentId:agent.id, instanceHome, workspaceRoot, manifestPath, stateDir, configDir:family === 'antigravity' ? configDir : null};
    const sharedBinding = {version:1, family:'antigravity', configDir, manifestPath, stateDir};
    if (previous && !matchesReceipt(previous, binding, family)) throw new Error('Mismatched seat preparation record');
    if (shared && !matchesReceipt(shared, sharedBinding, family)) throw new Error('Mismatched shared preparation record');
    const current = {...binding, nodePath, modulePath:hookModulePath || wakeModule(family === 'antigravity' ? 'antigravityWakeSidecar' : 'codexWakeHook'),
        ...(family === 'antigravity' ? {hookPath:wakeModule('antigravityWakeHook')} : {})};
    if (family === 'codex-desktop') {
        const home = deriveCodexHome({harnessType:family, instanceHome});
        if (!(await fs.lstat(home)).isDirectory()) throw new Error('Codex home unavailable');
        await materializeCodexWakeAdmission({home, workspaceRoot, nodePath, modulePath:current.modulePath, manifestPath, stateDir, agentId:agent.id,
            ...(previous ? {previous:{...previous, home}} : {})});
        completed.push('hook')
    } else {
        const sidecarPrevious = shared && {nodePath:shared.nodePath, modulePath:shared.modulePath};
        const hooksPrevious   = previous && {nodePath:previous.nodePath, hookPath:previous.hookPath};
        inspectAntigravitySidecar({configDir, nodePath, modulePath:current.modulePath, manifestPath, stateDir, previous:sidecarPrevious});
        excludeManagedNativeWakeHook({targetRepoRoot:workspaceRoot});
        await materializeAntigravityWakeHooks({workspaceRoot, nodePath, hookPath:current.hookPath, manifestPath, stateDir, previous:hooksPrevious});
        completed.push('hooks');
        await materializeAntigravitySidecar({configDir, nodePath, modulePath:current.modulePath, manifestPath, stateDir, previous:sidecarPrevious});
        completed.push('sidecar')
    }
    if (sharedFile) await writeReceipt(sharedFile, {...sharedBinding, nodePath, modulePath:current.modulePath, hookPath:current.hookPath}, shared);
    await writeReceipt(seatFile, current, previous);
    return {state:'prepared', completed}
}

/**
 * @summary Prepares the vendor hook and, with explicit host consent, the shared App sidecar.
 * Preparation is idempotent and never enrolls the seat or grants conversation ownership. If a later
 * write fails, the completed stages are reported; retrying the same inputs completes them.
 * @param {Object} options Trusted Fleet-selected paths and seat definition.
 * @param {Object} options.agent Seat definition, including id and harnessType.
 * @param {String} options.instanceHome Absolute seat instance directory.
 * @param {String} options.workspaceRoot Absolute workspace directory.
 * @param {String} options.manifestPath Absolute receiver manifest path.
 * @param {String} options.stateDir Absolute receiver state directory.
 * @param {String} [options.configDir] Shared Antigravity configuration directory.
 * @param {String} [options.nodePath=process.execPath] Fleet runtime executable.
 * @param {String} [options.hookModulePath] Hook selected from the verified retained Start runtime.
 * @param {Boolean} [options.allowSharedConfig=false] Explicit host authorization for shared config.
 * @returns {Promise<Object>} Prepared or a bounded refusal, including completed stages.
 */
export async function prepareFleetNativeWake({agent, instanceHome, workspaceRoot, manifestPath, stateDir,
    configDir, nodePath = process.execPath, hookModulePath = null, allowSharedConfig = false} = {}) {
    const completed = [];
    if (!agent || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(agent.id || '') ||
        !['codex-desktop', 'antigravity'].includes(agent.harnessType) ||
        ![instanceHome, workspaceRoot, manifestPath, stateDir, nodePath].every(absolute) || (hookModulePath && !absolute(hookModulePath))) {
        return {state: 'refused', reason: 'invalid-input', completed}
    }
    if (agent.harnessType === 'antigravity' && (!allowSharedConfig || !absolute(configDir))) {
        return {state: 'refused', reason: 'shared-config-not-authorized', completed}
    }
    try {
        if (agent.harnessType === 'antigravity') {
            assertUntrackedManagedWorkspaceFile({targetRepoRoot:workspaceRoot, target:'.agents/hooks.json'})
        }
        for (const dir of [instanceHome, workspaceRoot, stateDir, ...(agent.harnessType === 'antigravity' ? [configDir] : [])]) {
            const stat = await fs.lstat(dir);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a regular trusted directory')
        }
        const stateStat = await fs.lstat(stateDir);
        if ((stateStat.mode & 0o077) || await fs.realpath(stateDir) !== stateDir) throw new Error('Receiver state is not private');
        if (!(await fs.stat(nodePath)).isFile() || !(await fs.stat(manifestPath)).isFile()) throw new Error('Required file unavailable');
        const recordsDir = path.join(stateDir,'native-wake-preparation');
        await fs.mkdir(recordsDir,{recursive:true,mode:0o700});
        const directory = await fs.lstat(recordsDir);
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('Unsafe preparation directory');
        return await withOutboxLock(path.join(recordsDir,'preparation'), () =>
            prepareOwned({agent, instanceHome, workspaceRoot, manifestPath, stateDir, configDir, nodePath, hookModulePath, recordsDir, completed}))
    } catch (error) {
        // Config parsing errors may contain private file contents; never return exception text to callers.
        return {state:'refused', reason:error?.code === 'FLEET_WAKE_HOOK_TRACKED' ? 'workspace-hook-tracked' : 'preparation-failed', completed}
    }
}
