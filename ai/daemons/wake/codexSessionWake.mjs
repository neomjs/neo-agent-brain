/**
 * @module ai/daemons/wake/codexSessionWake
 * @summary Codex Desktop's explicitly selected root-thread queue transport.
 * Rollout identity is evidence of a root, never of current ownership. The caller owns the
 * selection and its generation fence. A successful queue command is not a delivery receipt.
 */
import Database                        from 'better-sqlite3';
import fs                              from 'node:fs/promises';
import {constants as fsConstants}      from 'node:fs';
import path                            from 'node:path';
import {execFile, execFileSync, spawn} from 'node:child_process';
import {createHash}                    from 'node:crypto';
import {promisify}                     from 'node:util';

const run        = promisify(execFile), UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      MAX_HEADER = 1024 * 1024, MAX_TAIL = 4 * 1024 * 1024;
const HOOK_STATUS = 'Neo Codex wake admission';
const shellQuote  = value => `'${value.replaceAll("'", "'\\''")}'`;

function wakeHookCommand({nodePath, modulePath, manifestPath, stateDir, agentId}) {
    return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${shellQuote(nodePath)} ${shellQuote(modulePath)} --manifest ${shellQuote(manifestPath)} --state-dir ${shellQuote(stateDir)} --agent-id ${shellQuote(agentId)}`
}

/**
 * @summary Merges the canary submit hook into a seat's private hook configuration without granting trust.
 * @param {Object} options
 * @param {String} options.home Absolute Codex seat home.
 * @param {String} options.workspaceRoot Absolute trusted Fleet workspace.
 * @param {String} options.nodePath Absolute trusted Node binary.
 * @param {String} options.modulePath Absolute trusted admission module.
 * @returns {Promise<Object>} Installed command and source path; not a trust or runtime receipt.
 */
export async function materializeCodexWakeAdmission({home, workspaceRoot, nodePath, modulePath, manifestPath, stateDir, agentId}) {
    if (![home, workspaceRoot, nodePath, modulePath, manifestPath, stateDir].every(value => typeof value === 'string' && path.isAbsolute(value)) || typeof agentId !== 'string' || !agentId) {
        throw new Error('Codex hook materialization requires absolute trusted paths')
    }
    const sourcePath = path.join(home, 'hooks.json'), lock = `${sourcePath}.neo-wake-lock`;
    const lockHandle = await fs.open(lock, 'wx', 0o600);
    try {
        let config = {};
        try {
            const stat = await fs.lstat(sourcePath);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex hooks config must be a regular file');
            config = JSON.parse(await fs.readFile(sourcePath, 'utf8'))
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (!config || typeof config !== 'object' || Array.isArray(config) ||
            (config.hooks && (typeof config.hooks !== 'object' || Array.isArray(config.hooks)))) throw new Error('Invalid Codex hooks config');
        config.hooks ||= {};
        const groups = config.hooks.UserPromptSubmit || [];
        if (!Array.isArray(groups)) throw new Error('Invalid Codex submit hooks');
        const command = wakeHookCommand({nodePath, modulePath, manifestPath, stateDir, agentId});
        let   count   = 0;
        for (const group of groups) {
            if (!Array.isArray(group?.hooks)) throw new Error('Invalid Codex hook group');
            group.hooks = group.hooks.filter(hook => { if (hook.statusMessage === HOOK_STATUS) { count++; return false } return true })
        }
        if (count > 1) throw new Error('Ambiguous existing Codex wake hooks');
        groups.push({hooks: [{type: 'command', command, statusMessage: HOOK_STATUS, timeout: 10}]});
        config.hooks.UserPromptSubmit = groups.filter(group => group.hooks.length);
        const tmp = `${sourcePath}.${process.pid}.${Date.now()}.tmp`;
        try { await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); await fs.rename(tmp, sourcePath) }
        finally { await fs.rm(tmp, {force: true}) }
        return {sourcePath, command}
    } finally { await lockHandle.close(); await fs.rm(lock, {force: true}) }
}

function validate(home, threadId) {
    if (!path.isAbsolute(home || '') || !UUID.test(threadId || '')) {
        throw new Error('Codex wake requires an absolute home and exact thread UUID')
    }
}
async function queryHookInventory({binary, home, workspaceRoot}) {
    return new Promise((resolve, reject) => {
        const child  = spawn(binary, ['app-server'], {cwd: workspaceRoot, env: {HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin'}, stdio: ['pipe', 'pipe', 'ignore']});
        let   buffer = '', done = false;
        const timer  = setTimeout(() => finish(new Error('Codex hook inventory timeout')), 10000);
        function finish(error, value) {
            if (done) return;
            done = true; clearTimeout(timer); child.kill();
            error ? reject(error) : resolve(value)
        }
        child.on('error', error => finish(error));
        child.on('exit', () => finish(new Error('Codex hook inventory exited')));
        child.stdout.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > 1024 * 1024) return finish(new Error('Codex hook inventory exceeds bound'));
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                let message;
                try { message = JSON.parse(line) } catch { return finish(new Error('Invalid Codex hook inventory')) }
                if (message.id === 1 && message.result) {
                    child.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
                    child.stdin.write(JSON.stringify({id: 2, method: 'hooks/list', params: {cwds: [workspaceRoot]}}) + '\n')
                } else if (message.id === 1 && message.error) return finish(new Error('Codex initialization refused'));
                else if (message.id === 2) return message.result ? finish(null, message.result) : finish(new Error('Codex hooks/list refused'))
            }
        });
        child.stdin.write(JSON.stringify({id: 1, method: 'initialize', params: {clientInfo: {name: 'neo-wake-hook-check', version: '1'}, capabilities: {}}}) + '\n')
    })
}

/**
 * @summary Verifies current hook configuration and an ordinary-hook invocation from the same Desktop process epoch.
 * Same-user host ownership is assumed; this does not defend against a malicious local user.
 * @param {Object} options Trusted seat paths, current thread, hook command and Fleet runtime PID.
 * @returns {Promise<Object>} Verified only on exact trusted inventory and matching live process epoch.
 */
export async function verifyCodexWakeAdmission(options) {
    const {home, workspaceRoot, binary, threadId, stateDir, agentId, nodePath, modulePath, manifestPath, runtimePid,
        readInventory = queryHookInventory} = options;
    try {
        validate(home, threadId);
        if (![workspaceRoot, binary, stateDir, nodePath, modulePath, manifestPath].every(p => path.isAbsolute(p || '')) ||
            !agentId || !Number.isSafeInteger(runtimePid) || runtimePid <= 1) return {verified: false};
        const sourcePath                                    = path.join(home, 'hooks.json'), command = wakeHookCommand({nodePath, modulePath, manifestPath, stateDir, agentId});
        const [inventory, config, moduleBytes, markerBytes] = await Promise.all([
            readInventory({binary, home, workspaceRoot}), fs.readFile(sourcePath), fs.readFile(modulePath),
            fs.readFile(path.join(stateDir, 'codex-hook-presence', `${threadId}.json`))
        ]);
        const hash    = value => createHash('sha256').update(value).digest('hex'), marker = JSON.parse(markerBytes);
        const hooks   = inventory?.data?.flatMap(entry => entry.cwd === workspaceRoot && !entry.errors?.length ? entry.hooks : []) || [];
        const matches = hooks.filter(h => h.sourcePath === sourcePath && h.eventName === 'userPromptSubmit' && h.command === command &&
            h.enabled === true && ['trusted', 'managed'].includes(h.trustStatus) && typeof h.currentHash === 'string' && h.currentHash);
        if (matches.length !== 1 || marker.sessionId !== threadId || marker.agentId !== agentId || marker.configHash !== hash(config) ||
            marker.moduleHash !== hash(moduleBytes) || !marker.turnId || !Number.isFinite(marker.observedAt)) return {verified: false};
        const ancestor = marker.ancestors?.find(item => item.pid === runtimePid);
        if (!ancestor) return {verified: false};
        const currentStart = execFileSync('/bin/ps', ['-p', String(runtimePid), '-o', 'lstart='], {encoding: 'utf8', timeout: 1000}).trim();
        return {verified: currentStart === ancestor.startedAt, hookHash: matches[0].currentHash}
    } catch { return {verified: false} }
}


function readIndex(home, query, ...params) {
    const db = new Database(path.join(home, 'state_5.sqlite'), {readonly: true, fileMustExist: true});
    try { return db.prepare(query).all(...params) } finally { db.close() }
}

async function openRollout(home, file, threadId) {
    const root = path.join(await fs.realpath(home), 'sessions');
    if (!(await fs.lstat(root)).isDirectory() || !path.isAbsolute(file) ||
        !file.startsWith(root + path.sep) || !file.endsWith(`-${threadId}.jsonl`) || await fs.realpath(file) !== file) {
        throw new Error('Codex rollout is outside the owned session tree')
    }
    const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Codex rollout is not a regular file');
        return {handle, size: stat.size}
    } catch (error) {
        await handle.close(); throw error
    }
}

/**
 * @summary Lists indexed, unarchived Desktop user roots in one workspace. No result asserts liveness or ownership.
 * @param {Object} options
 * @param {String} options.home Absolute seat home.
 * @param {String} options.workspaceRoot Absolute exact workspace path.
 * @returns {Promise<Object[]>} Plausible roots; the caller must establish the current owner independently.
 */
export async function listCodexWakeTargets({home, workspaceRoot}) {
    if (!path.isAbsolute(home || '') || !path.isAbsolute(workspaceRoot || '')) throw new Error('Absolute paths required');
    const rows    = readIndex(home, 'SELECT id, created_at_ms FROM threads WHERE cwd = ? AND source = ? AND thread_source = ? AND originator = ? AND attached_thread_parent_id IS NULL ORDER BY created_at_ms DESC LIMIT 101', workspaceRoot, 'vscode', 'user', 'Codex Desktop');
    const results = [];
    for (const row of rows) {
        if (results.length && row.created_at_ms < results[0].startedAt) break;
        try { results.push(await readCodexWakeTarget({home, threadId: row.id})) }
        catch (error) {
            if (error.code === 'CODEX_NON_ROOT') continue;
            throw error
        }
    if (!results.length && rows.length > 100) throw new Error('Codex candidate inventory exceeds bound');
    }
    if (results.length > 1 && results[0].startedAt === results[1].startedAt) throw new Error('Codex latest root start is ambiguous');
    return results
}

/**
 * @summary Proves the supplied UUID names one Desktop user root inside this seat home.
 * @param {Object} options
 * @param {String} options.home Absolute Codex home.
 * @param {String} options.threadId Explicit caller-selected thread UUID.
 * @returns {Promise<Object>} Root identity evidence, not ownership or liveness.
 */
export async function readCodexWakeTarget({home, threadId}) {
    validate(home, threadId);
    const rows = readIndex(home, 'SELECT rollout_path, cwd, created_at_ms, archived, source, thread_source, originator, attached_thread_parent_id FROM threads WHERE id = ?', threadId);
    const row  = rows[0];
    if (rows.length !== 1 || row.source !== 'vscode' || row.thread_source !== 'user' ||
        row.originator !== 'Codex Desktop' || row.attached_thread_parent_id !== null) throw new Error('Codex session is not a proven Desktop user root');
    const file = row.rollout_path, {handle, size} = await openRollout(home, file, threadId);
    let first;
    try {
        const buffer      = Buffer.alloc(Math.min(size, MAX_HEADER));
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
        const header      = buffer.subarray(0, bytesRead).toString('utf8');
        const end         = header.indexOf('\n');
        if (end < 0) throw new Error('header exceeds bound');
        first = JSON.parse(header.slice(0, end))
    } catch { throw new Error('Invalid Codex session metadata') } finally { await handle.close() }
    const meta = first?.payload;
    if (first?.type !== 'session_meta' || meta?.id !== threadId || meta?.session_id !== threadId ||
        meta?.source !== 'vscode' || meta?.thread_source !== 'user' || meta?.originator !== 'Codex Desktop') {
        throw new Error('Codex session is not a proven Desktop user root')
    }
    if (meta.forked_from_id != null || meta.parent_thread_id != null || meta.attached_thread === true) {
        const error = new Error('Codex session is a fork or attached child'); error.code = 'CODEX_NON_ROOT'; throw error
    }
    if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms <= 0) throw new Error('Codex root start is unavailable');
    if (row.archived !== 0) throw new Error('Codex session is not a proven eligible Desktop root');
    return {home, threadId, root: true, workspaceRoot: row.cwd, startedAt: row.created_at_ms, rolloutPath: file, receiptOffset: size}
}

/**
 * @summary Enqueues a caller-fenced wake without creating or resuming a thread.
 * @param {Object} options
 * @param {String} options.binary Absolute admitted Codex CLI binary.
 * @param {String} options.home Absolute seat Codex home.
 * @param {String} options.threadId Caller-selected root UUID.
 * @param {String} options.text Unique opaque wake text, not mailbox content.
 * @param {Function} [options.execute] Injected execFile-compatible test seam.
 * @returns {Promise<Object>} Enqueue evidence only; receipt is separately observed.
 */
/**
 * @summary Reads the latest observed root turn lifecycle; incomplete or oversized evidence is unknown.
 * @param {Object} options Codex home and thread UUID.
 * @returns {Promise<Object>} Idle, busy, or unknown; not a lock against a new turn.
 */
export async function readCodexWakeActivity({home, threadId}) {
    const target = await readCodexWakeTarget({home, threadId}), {handle, size} = await openRollout(home, target.rolloutPath, threadId);
    try {
        if (!size) return {state: 'unknown'};
        const initial = await handle.stat();
        const stable  = async state => {
            const after = await handle.stat();
            return initial.size === size && after.size === size && after.mtimeMs === initial.mtimeMs ? {state} : {state: 'unknown'}
        };
        const last = Buffer.alloc(1);
        if ((await handle.read(last, 0, 1, size - 1)).bytesRead !== 1 || last[0] !== 10) return {state: 'unknown'};
        const lower    = Math.max(0, size - 32 * 1024 * 1024), chunkSize = 64 * 1024;
        let   position = size - 1, pieces = [], lineBytes = 0;
        while (position > lower) {
            const length = Math.min(chunkSize, position - lower), start = position - length, chunk = Buffer.alloc(length);
            if ((await handle.read(chunk, 0, length, start)).bytesRead !== length) return {state: 'unknown'};
            let end = length;
            for (let i = length - 1; i >= 0; i--) {
                if (chunk[i] !== 10) continue;
                const part = chunk.subarray(i + 1, end);
                if (part.length) { pieces.unshift(part); lineBytes += part.length }
                if (lineBytes > 8 * 1024 * 1024) return {state: 'unknown'};
                if (lineBytes) {
                    let record;
                    try { record = JSON.parse(Buffer.concat(pieces, lineBytes).toString('utf8')) } catch { return {state: 'unknown'} }
                    const p = record.payload;
                    if (record.type === 'event_msg' && p?.turn_id && p.turn_id === p.root_turn_id) {
                        if (p.type === 'task_started' && p.turn_attribution?.parent_turn_id === null) return await stable('busy');
                        if (['task_complete', 'turn_aborted'].includes(p.type)) return await stable('idle')
                    }
                }
                pieces = []; lineBytes = 0; end = i
            }
            if (end) { pieces.unshift(chunk.subarray(0, end)); lineBytes += end }
            if (lineBytes > 8 * 1024 * 1024) return {state: 'unknown'};
            position = start
        }
        return {state: 'unknown'}
    } finally { await handle.close() }
}

export async function sendCodexSessionWake({binary, home, threadId, text, execute = run, verifyAdmission}) {
    if (!path.isAbsolute(binary || '') || typeof text !== 'string' || !/^\[NEO_WAKE_V1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\] \[WAKE\]$/i.test(text)) {
        throw new Error('Codex wake requires absolute binary and bounded opaque text')
    }
    const target     = await readCodexWakeTarget({home, threadId});
    const candidates = await listCodexWakeTargets({home, workspaceRoot: target.workspaceRoot});
    if (candidates[0]?.threadId !== threadId) throw new Error('Codex selected root is no longer latest');
    const activity = await readCodexWakeActivity({home, threadId});
    if (activity.state !== 'idle') throw new Error(`Codex root activity is ${activity.state}`);
    if (typeof verifyAdmission !== 'function' || (await verifyAdmission({home, threadId, workspaceRoot: target.workspaceRoot})).verified !== true)
        throw new Error('Codex wake admission is not runtime verified');
    const result = await execute(binary, ['queue', '--thread', threadId, '--message', text], {
        cwd: home, env: {HOME: home, CODEX_HOME: home, PATH: '/usr/bin:/bin'}, timeout: 10000, maxBuffer: 65536
    });
    const match = /^Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})\.\s*$/i.exec(result.stdout || '');
    if (!match || !UUID.test(match[1]) || match[2] !== threadId) throw new Error('Codex queue result is ambiguous');
    return {state: 'enqueued', threadId, queueId: match[1], receiptOffset: target.receiptOffset}
}

/**
 * @summary Finds an exact queued user message and matching started turn in the selected root rollout.
 * @param {Object} options
 * @param {String} options.home Absolute Codex home.
 * @param {String} options.threadId Root thread UUID.
 * @param {String} options.text Exact unique opaque text submitted to the queue.
 * @param {Number} [options.receiptOffset] File size captured before enqueue.
 * @returns {Promise<Object>} Observed turn start, or unknown while unobserved.
 */
export async function readCodexWakeReceipt({home, threadId, text, receiptOffset, receiptToken}) {
    const token = /^\[NEO_WAKE_V1:([0-9a-f-]{36})\] \[WAKE\]$/i.exec(text || '');
    if (!token || !UUID.test(token[1]) || !UUID.test(receiptToken || '') || receiptToken === token[1]) throw new Error('Invalid Codex receipt token');
    const acknowledgement = `[NEO_WAKE_RECEIVED:${receiptToken}]`;
    const target          = await readCodexWakeTarget({home, threadId}), {handle, size} = await openRollout(home, target.rolloutPath, threadId);
    let data, offset = receiptOffset ?? Math.max(0, size - MAX_TAIL);
    try {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || size - offset > MAX_TAIL) return {state: 'unknown'};
        const buffer = Buffer.alloc(size - offset), {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
        data = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close() }
    if (offset && receiptOffset === undefined) data = data.slice(data.indexOf('\n') + 1);
    const lines  = data.split('\n');
    const starts = new Set(), contexts = new Set(), messages = [];
    for (const line of lines) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line) } catch { continue }
        const p = record.payload;
        if (record.type === 'event_msg' && p?.type === 'task_started' && p.turn_attribution?.turn_trigger === 'queue' &&
            p.turn_attribution?.parent_turn_id === null && p.turn_id === p.root_turn_id) starts.add(p.turn_id);
        if (record.type === 'response_item' && p?.type === 'message' && p.role === 'user' &&
            p.content?.length === 1 && p.content[0]?.type === 'input_text' && p.content[0].text === text) {
            messages.push(p.internal_chat_message_metadata_passthrough?.turn_id)
        }
        if (record.type === 'response_item' && p?.type === 'message' && p.role === 'developer' &&
            p.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('hooks.additional_context') &&
            p.internal_chat_message_metadata_passthrough?.content_item_metadata?.some(item => item?.provenance?.type === 'harness' && item.provenance.hook === true) &&
            p.content?.some(item => item?.type === 'input_text' && typeof item.text === 'string' && item.text.split('\n').includes(acknowledgement))) {
            contexts.add(p.internal_chat_message_metadata_passthrough?.turn_id)
        }
    }
    const matches = messages.filter(id => id && starts.has(id) && contexts.has(id));
    if (matches.length > 1) throw new Error('Codex wake receipt is ambiguous');
    return matches.length ? {state: 'turn-started', threadId, turnId: matches[0]} : {state: 'unknown'}
}
