import Database    from 'better-sqlite3';
import path        from 'node:path';
import fs          from 'node:fs';
import {execFile}  from 'node:child_process';
import {promisify} from 'node:util';

/** @module ai/daemons/wake/antigravitySessionWake
 * Read-only target validation and sidecar-local Antigravity dispatch. Project membership does not
 * attest that a session is the current seat root: the host owns that binding and sidecar custody.
 */
const UUID   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['CASCADE_RUN_STATUS_IDLE', 'CASCADE_RUN_STATUS_RUNNING']);

function validateInputs(databasePath, projectId) {
    if (!path.isAbsolute(databasePath || '') || typeof projectId !== 'string' || !projectId.trim()) {
        throw new TypeError('Absolute database path and explicit project ID required');
    }
}
function eligible(row) {
    return row && UUID.test(row.conversation_id) && row.parent_conversation_id === '' &&
        row.nesting_depth === 0 && row.killed === 0 && row.source === '' && STATES.has(row.status);
}
function withDatabase(databasePath, fn) {
    const db = new Database(databasePath, {readonly: true, fileMustExist: true});
    try { return fn(db) } finally { db.close() }
}

/**
 * @summary Checks an explicitly selected session against non-content App summary metadata.
 * @returns {Object|null} The eligible metadata, or null. Database errors propagate.
 */
export function readAntigravityWakeTarget({databasePath, projectId, threadId}) {
    validateInputs(databasePath, projectId);
    if (!UUID.test(threadId || '')) return null;
    return withDatabase(databasePath, db => {
        const row = db.prepare('SELECT conversation_id, project_id, parent_conversation_id, nesting_depth, killed, source, status FROM conversation_summaries WHERE conversation_id = ? AND project_id = ?').get(threadId, projectId);
        return eligible(row) ? {threadId: row.conversation_id, projectId: row.project_id, status: row.status} : null;
    });
}

/**
 * @summary Sends only to the explicitly selected UUID through the App-provided sidecar executable.
 * The caller must independently prove sidecar-to-App process ancestry, seat/project/current-root
 * binding and generation immediately before this call. A zero exit is dispatch, not turn evidence.
 * @param {Object} options Sidecar-local invocation options.
 * @returns {Promise<Object>} A deliberately non-terminal dispatch observation.
 */
export async function sendAntigravitySessionWake({threadId, message, agentapiExecutable, environment = process.env, exec = promisify(execFile)}) {
    if (!UUID.test(threadId || '') || typeof message !== 'string' || !message || !path.isAbsolute(agentapiExecutable || '')) {
        throw new TypeError('Explicit UUID, message and absolute sidecar executable required');
    }
    // No shell and no conversation creation. Credentials remain in the App-provided child environment.
    await exec(agentapiExecutable, ['agentapi', 'send-message', threadId, message], {
        env: environment, timeout: 10000, maxBuffer: 1024 * 1024
    });
    return {outcome: 'unknown', reason: 'agentapi-dispatch-exited-zero'};
}

/**
 * @summary Captures a pre-dispatch transcript cursor, bound to a particular file identity.
 * Missing transcripts cannot provide a cursor and must leave delivery unconfirmed.
 * @returns {Object} Device, inode and byte offset; no conversation content.
 */
export function captureAntigravityWakeCursor({appDataDir, threadId}) {
    const transcriptPath = transcriptFor(appDataDir, threadId);
    const fd             = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error('Transcript is not a regular file');
        return {dev: stat.dev, ino: stat.ino, offset: stat.size};
    } finally { fs.closeSync(fd) }
}

function transcriptFor(appDataDir, threadId) {
    if (!path.isAbsolute(appDataDir || '') || !UUID.test(threadId || '')) throw new TypeError('Absolute App data directory and UUID required');
    const root   = fs.realpathSync(appDataDir);
    const parent = path.join(root, 'brain', threadId, '.system_generated', 'logs');
    if (fs.realpathSync(parent) !== parent) throw new Error('Transcript ancestry is not canonical');
    return path.join(parent, 'transcript.jsonl');
}


/** @summary Recognizes only the native sidecar system envelope containing the exact opaque wake. */
export function isAntigravityWakeSystemMessage(item, text) {
    if (item?.type !== 'SYSTEM_MESSAGE' || item.source !== 'SYSTEM' || item.status !== 'DONE' ||
        typeof item.content !== 'string' || item.truncated_fields) return false;
    const match = item.content.match(/^The following is a <SYSTEM_MESSAGE> not actually sent by the user\. It is provided by the system as important information to pay attention to\.\n\n<SYSTEM_MESSAGE>\n\[Message\] timestamp=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) sender=system priority=MESSAGE_PRIORITY_HIGH content=(.*)\n<\/SYSTEM_MESSAGE>$/);
    return Boolean(match && !Number.isNaN(Date.parse(match[1])) && match[2] === text);
}

/** @summary Looks for the exact native opaque message after a pre-send same-file cursor. */
export function hasAntigravityPendingSystemWake({appDataDir,threadId,text,cursor}) {
    if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof text !== 'string') return false;
    let fd;
    try {
        fd = fs.openSync(transcriptFor(appDataDir,threadId),fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd), bytes = stat.size - cursor.offset;
        if (!stat.isFile() || stat.dev !== cursor.dev || stat.ino !== cursor.ino || bytes < 0 || bytes > 4*1024*1024) return false;
        const buf = Buffer.alloc(bytes);
        if (fs.readSync(fd,buf,0,bytes,cursor.offset) !== bytes) return false;
        const lines = buf.toString('utf8').split('\n');
        lines.pop();
        let latest = false;
        for (const line of lines) {
            let item;
            try { item = JSON.parse(line) } catch { return false }
            if (item?.type === 'USER_INPUT' || item?.type === 'SYSTEM_MESSAGE') {
                latest = isAntigravityWakeSystemMessage(item,text);
            }
        }
        return latest;
    } catch { return false } finally { if (fd !== undefined) fs.closeSync(fd) }
}

/**
 * @summary Recognizes a new exact user input followed by a model planner response in the same transcript.
 * The cursor must be captured before dispatch. Observed App JSONL shapes are not a vendor API;
 * malformed, truncated, rotated, or incomplete records remain unconfirmed. No content is returned.
 * @returns {Object} A bounded model-response observation, or unknown.
 */
export function readAntigravityWakeReceipt({appDataDir, threadId, text, cursor, receiptToken}) {
    const unknown = {outcome: 'unknown'};
    if (typeof text !== 'string' || !text || !cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) return unknown;
    let fd;
    try {
        if (!UUID.test(receiptToken || '')) return unknown;
        fd = fs.openSync(transcriptFor(appDataDir, threadId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd), bytes = stat.size - cursor.offset;
        if (!stat.isFile() || stat.dev !== cursor.dev || stat.ino !== cursor.ino || bytes < 0 || bytes > 4 * 1024 * 1024) return unknown;
        const buffer = Buffer.alloc(bytes);
        if (fs.readSync(fd, buffer, 0, bytes, cursor.offset) !== bytes) return unknown;
        const data = buffer.toString('utf8'), lines = data.split('\n');
        lines.pop(); // Ignore a partial line, including an incomplete JSON object.
        let matched = null;
        for (const line of lines) {
            let item;
            try { item = JSON.parse(line) } catch { return unknown }
            if (!item || item.truncated_fields) continue;
            if (((item.type === 'USER_INPUT' && item.source === 'USER_EXPLICIT' && item.status === 'DONE' && item.content === text) ||
                isAntigravityWakeSystemMessage(item,text)) && Number.isSafeInteger(item.step_index)) {
                matched = item.step_index;
            } else if (matched !== null && item.type === 'USER_INPUT') {
                matched = null;
            } else if (matched !== null && item.type === 'PLANNER_RESPONSE' && item.source === 'MODEL' &&
                item.status === 'DONE' && Number.isSafeInteger(item.step_index) && item.step_index > matched) {
                const content = typeof item.content === 'string' ? item.content : '';
                const lines   = content.split(/\r?\n/);
                const proof   = lines.some(line => line === '[NEO_WAKE_RECEIVED:' + receiptToken + ']');
                if (proof) return {outcome:'observed',reason:'private-model-ack'};
            }
        }
        return unknown;
    } catch { return unknown } finally { if (fd !== undefined) fs.closeSync(fd) }
}

/**
 * @summary Validates a SessionStart candidate against a host-captured pre-creation census.
 * This is classification only: the supervisor must attest the hook's App ancestry and retain
 * the census under its generation-bound, single-use creation permit. A helper cannot bind.
 * Concurrent new roots are ambiguous, and a killed newest root never falls back to an older one.
 * @returns {Object|null} Candidate metadata if exactly one newly observed project root exists.
 */
export function classifyAntigravitySessionStart({databasePath, projectId, threadId, priorThreadIds}) {
    validateInputs(databasePath, projectId);
    if (!UUID.test(threadId || '') || !Array.isArray(priorThreadIds) ||
        priorThreadIds.some(id => !UUID.test(id)) || new Set(priorThreadIds).size !== priorThreadIds.length) return null;
    const previous = new Set(priorThreadIds);
    return withDatabase(databasePath, db => {
        const rows      = db.prepare('SELECT conversation_id, project_id, parent_conversation_id, nesting_depth, killed, source, status FROM conversation_summaries WHERE project_id = ? AND parent_conversation_id = ? AND nesting_depth = 0').all(projectId, '');
        const additions = rows.filter(row => !previous.has(row.conversation_id));
        if (additions.length !== 1 || additions[0].conversation_id !== threadId || !eligible(additions[0])) return null;
        return {threadId, projectId, status: additions[0].status};
    });
}

/** @summary Initializes the generation census before accepting any SessionStart event. */
export async function initializeAntigravityStarts({databasePath,projectId,generation,statePath}) {
    validateInputs(databasePath, projectId);
    if (!generation || !path.isAbsolute(statePath || '')) throw new TypeError('Generation and state path required');
    const file                  = statePath + '.starts.json';
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file, async () => {
        let old = null;
        try { old = JSON.parse(fs.readFileSync(file,'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (old?.generation === generation && old.projectId === projectId) return old;
        const ids = withDatabase(databasePath, db => db.prepare("SELECT conversation_id FROM conversation_summaries WHERE project_id=? AND parent_conversation_id='' AND nesting_depth=0").all(projectId).map(x=>x.conversation_id));
        if (ids.some(id=>!UUID.test(id))) throw new Error('Invalid root census');
        const state = {version:1, generation, projectId, priorThreadIds:ids, threadId:null, sequence:0, witness:false};
        writeFileAtomicSync(file, JSON.stringify(state), {mode:0o600,fsync:true});
        return state;
    });
}

/** @summary Records one unambiguous new SessionStart after the generation census. */
export async function observeAntigravitySessionStart({databasePath,projectId,projectRoot,generation,statePath,input}) {
    if (!Array.isArray(input?.workspacePaths) || !input.workspacePaths.includes(projectRoot)) return null;
    const file                  = statePath + '.starts.json';
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file, async () => {
        let state;
        try { state = JSON.parse(fs.readFileSync(file,'utf8')) } catch { return null }
        if (state?.generation !== generation || state.projectId !== projectId || !Array.isArray(state.priorThreadIds)) return null;
        const target = classifyAntigravitySessionStart({databasePath,projectId,threadId:input.conversationId,priorThreadIds:state.priorThreadIds});
        if (!target) return null;
        state.priorThreadIds.push(target.threadId);
        state.threadId = target.threadId;
        state.sequence = (state.sequence || 0) + 1;
        state.witness = false;
        writeFileAtomicSync(file,JSON.stringify(state),{mode:0o600,fsync:true});
        return target;
    });
}

/** @summary Returns only a host-observed current-generation root, revalidated against App metadata. */
export function latestAntigravityWakeTarget({databasePath,projectId,generation,statePath}) {
    try {
        const state = JSON.parse(fs.readFileSync(statePath + '.starts.json','utf8'));
        if (state.version !== 1 || state.projectId !== projectId || state.generation !== generation || !state.threadId ||
            !Array.isArray(state.priorThreadIds)) return null;
        const roots = withDatabase(databasePath, db => db.prepare("SELECT conversation_id FROM conversation_summaries WHERE project_id=? AND parent_conversation_id='' AND nesting_depth=0").all(projectId));
        if (roots.some(row => !state.priorThreadIds.includes(row.conversation_id))) return null;
        const target = readAntigravityWakeTarget({databasePath,projectId,threadId:state.threadId});
        return target && Number.isSafeInteger(state.sequence) && state.sequence > 0 ? {...target,root:true,startSequence:state.sequence} : null;
    } catch { return null }
}

/** @summary Reports a PreInvocation witness only for the selected current-generation root. */
export function verifyAntigravityWakeAdmission({databasePath,appDataDir,projectId,threadId,generation,statePath}) {
    try {
        const state = JSON.parse(fs.readFileSync(statePath + '.starts.json','utf8'));
        const root  = latestAntigravityWakeTarget({databasePath:databasePath || path.join(appDataDir,'conversation_summaries.db'),projectId,generation,statePath});
        return {verified:state.witness === true && root?.threadId === threadId};
    } catch { return {verified:false} }
}

/** @summary Marks a native PreInvocation observation for the currently selected root. */
export async function observeAntigravityPreInvocation({databasePath,projectId,projectRoot,generation,statePath,input}) {
    if (!Array.isArray(input?.workspacePaths) || !input.workspacePaths.includes(projectRoot) ||
        !Number.isSafeInteger(input.invocationNum) || input.invocationNum < 0) return false;
    const file                  = statePath + '.starts.json';
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file, async () => {
        const root = latestAntigravityWakeTarget({databasePath,projectId,generation,statePath});
        if (!root || root.threadId !== input.conversationId) return false;
        const state = JSON.parse(fs.readFileSync(file,'utf8'));
        state.witness = true;
        writeFileAtomicSync(file,JSON.stringify(state),{mode:0o600,fsync:true});
        return true;
    });
}

/** @summary Redeems a reserved wake before model invocation; ordinary prompts pass unchanged. */
export async function handleAntigravityPreInvocation({input,consume,...context}) {
    const text = input?.lastUserInput;
    if (typeof text !== 'string' || !text.startsWith('[NEO_WAKE_V1:')) return {};
    const match = text.match(/^\[NEO_WAKE_V1:([0-9a-f-]{36})\] \[WAKE\]$/i);
    const deny  = {terminationBehavior:'terminate',injectSteps:[{errorMessage:{userMessage:'Wake admission refused.'}}]};
    if (!match || !UUID.test(match[1]) || !await observeAntigravityPreInvocation({...context,input})) return deny;
    if (input.invocationNum > 0) {
        try {
            const claim = JSON.parse(fs.readFileSync(context.statePath + '.claim.json','utf8'));
            return claim.admitted === true && claim.nonce === match[1] && claim.threadId === input.conversationId &&
                claim.generation === context.generation ? {} : deny;
        } catch { return deny }
    }
    const result = await consume({threadId:input.conversationId,nonce:match[1]});
    if (!result?.admitted || typeof result.digest !== 'string') return deny;
    return {injectSteps:[{ephemeralMessage:result.digest + '\nWhen you respond, repeat the exact NEO_WAKE_RECEIVED line above on its own line to acknowledge receipt.'}]};
}
