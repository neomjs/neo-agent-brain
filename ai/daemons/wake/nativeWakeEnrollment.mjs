import {constants}       from 'node:fs';
import fs                from 'node:fs/promises';
import path              from 'node:path';
import {writeFileAtomic} from '../../services/shared/atomicFileWrite.mjs';
import {withOutboxLock}  from './outboxLock.mjs';

const FAMILIES = new Set(['antigravity', 'codex-desktop']);
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && value !== path.parse(value).root;

function optInPath(manifestPath, agentId) {
    if (!absolute(manifestPath)) throw new Error('Expected an absolute receiver manifest path');
    if (typeof agentId !== 'string' || !/^(?!\.{1,2}$)(?!-)[a-z0-9._-]{1,100}$/.test(agentId)) {
        throw new Error('Invalid primary session agent id')
    }
    return path.join(path.dirname(manifestPath), 'primary-session-seats', agentId + '.json')
}

/** @summary Reads a private regular host record without following a final symlink. */
export async function readPrivateWakeJson(file) {
    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error('Invalid private wake record');
        return JSON.parse(await handle.readFile('utf8'))
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error
    } finally { await handle?.close() }
}

/** @summary Reads one host-scoped native wake canary, or null when absent. */
export async function readNativeWakeOptIn({manifestPath, agentId, family}) {
    const value = await readPrivateWakeJson(optInPath(manifestPath, agentId));
    if (value === null) return null;
    if (value.version !== 1 || value.agentId !== agentId || !FAMILIES.has(family) ||
        value.family !== family || !absolute(value.stateDir)) throw new Error('Invalid native wake enrollment');
    return value
}

/** @summary Enrolls an explicitly selected seat; no hook, app or route is changed here. */
export async function enrollNativeWake({manifestPath, stateDir, agentId, family}) {
    if (!absolute(stateDir) || !FAMILIES.has(family)) throw new Error('Expected receiver state directory and native desktop family');
    const file = optInPath(manifestPath, agentId), state = await fs.lstat(stateDir);
    if (!state.isDirectory() || (state.mode & 0o077) || !(await readPrivateWakeJson(manifestPath))?.routes) {
        throw new Error('Expected an initialized private receiver')
    }
    await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
    return withOutboxLock(file, async () => {
        const previous = await readNativeWakeOptIn({manifestPath, agentId, family});
        if (previous && previous.stateDir !== stateDir) throw new Error('A different receiver owns this enrollment');
        if (previous) return previous;
        const enrollment = {version: 1, family, agentId, stateDir};
        await writeFileAtomic(file, JSON.stringify(enrollment), {mode: 0o600, fsync: true});
        return enrollment
    })
}
