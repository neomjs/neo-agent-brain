/**
 * @module ai/services/fleet/prepareFleetNativeWake
 * @summary Prepares native wake files for one trusted Fleet seat without enrolling it.
 */
import fs                                                                                          from 'node:fs/promises';
import path                                                                                        from 'node:path';
import {fileURLToPath}                                                                             from 'node:url';
import {createHash}                                                                                from 'node:crypto';
import {deriveCodexHome}                                                                           from './deriveHarnessLaunchSpec.mjs';
import {materializeCodexWakeAdmission}                                                             from '../../daemons/wake/codexSessionWake.mjs';
import {inspectAntigravitySidecar, materializeAntigravitySidecar, materializeAntigravityWakeHooks} from '../../daemons/wake/antigravityWakeSidecar.mjs';
import {readPrivateWakeJson}                                                                       from '../../daemons/wake/nativeWakeEnrollment.mjs';
import {withOutboxLock}                                                                            from '../../daemons/wake/outboxLock.mjs';
import {writeFileAtomic}                                                                           from '../shared/atomicFileWrite.mjs';
import {assertUntrackedManagedWorkspaceFile, excludeManagedNativeWakeHook}                         from './excludeManagedWorkspaceFiles.mjs';

const wakeModule = name => fileURLToPath(new URL(`../../daemons/wake/${name}.mjs`, import.meta.url));
const absolute   = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root;

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
async function prepareOwned({agent, instanceHome, workspaceRoot, manifestPath, stateDir, configDir, nodePath, recordsDir, completed}) {
    const seatFile   = path.join(recordsDir, agent.id + '.json');
    const sharedFile = agent.harnessType === 'antigravity'
        ? path.join(recordsDir, 'shared-' + createHash('sha256').update(configDir).digest('hex') + '.json') : null;
    const previous      = await readPrivateWakeJson(seatFile), shared = sharedFile ? await readPrivateWakeJson(sharedFile) : null;
    const family        = agent.harnessType;
    const binding       = {version:1, family, agentId:agent.id, instanceHome, workspaceRoot, manifestPath, stateDir, configDir:family === 'antigravity' ? configDir : null};
    const sharedBinding = {version:1, family:'antigravity', configDir, manifestPath, stateDir};
    if (previous && !matchesReceipt(previous, binding, family)) throw new Error('Mismatched seat preparation record');
    if (shared && !matchesReceipt(shared, sharedBinding, family)) throw new Error('Mismatched shared preparation record');
    const current = {...binding, nodePath, modulePath:wakeModule(family === 'antigravity' ? 'antigravityWakeSidecar' : 'codexWakeHook'),
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
 * @param {Boolean} [options.allowSharedConfig=false] Explicit host authorization for shared config.
 * @returns {Promise<Object>} Prepared or a bounded refusal, including completed stages.
 */
export async function prepareFleetNativeWake({agent, instanceHome, workspaceRoot, manifestPath, stateDir,
    configDir, nodePath = process.execPath, allowSharedConfig = false} = {}) {
    const completed = [];
    if (!agent || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(agent.id || '') ||
        !['codex-desktop', 'antigravity'].includes(agent.harnessType) ||
        ![instanceHome, workspaceRoot, manifestPath, stateDir, nodePath].every(absolute)) {
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
            prepareOwned({agent, instanceHome, workspaceRoot, manifestPath, stateDir, configDir, nodePath, recordsDir, completed}))
    } catch (error) {
        // Config parsing errors may contain private file contents; never return exception text to callers.
        return {state:'refused', reason:error?.code === 'FLEET_WAKE_HOOK_TRACKED' ? 'workspace-hook-tracked' : 'preparation-failed', completed}
    }
}
