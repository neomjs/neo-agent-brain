import Database    from 'better-sqlite3';
import protobuf    from 'protobufjs/minimal.js';
import path        from 'node:path';
import crypto      from 'node:crypto';
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

/**
 * @summary Reads only the native summary identity fields; malformed or ambiguous wire data is unavailable.
 * The observed schema is CascadeTrajectorySummary { trajectory_id:4, trajectory_metadata:17,
 * fork_parent_conversation_id:24 }; metadata has parent:5, root:6, nesting_depth:17, project_id:18.
 * Proto3 omits empty optional parent/fork and zero depth. Required tuple fields must be present.
 */
function nativeIdentity(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 1024 * 1024) return null;
    try {
        const parse = (reader, fields) => {
            const seen = new Set(), result = {};
            while (reader.pos < reader.len) {
                const tag = reader.uint32(), field = tag >>> 3, wire = tag & 7;
                if (!field || wire === 3 || wire === 4 || wire > 5) throw new Error('invalid wire');
                const spec = fields[field];
                if (spec) {
                    if (seen.has(field) || wire !== spec.wire) throw new Error('duplicate or wrong wire');
                    seen.add(field);
                    result[spec.name] = spec.wire === 2 ? reader.bytes() : reader.uint32();
                } else {
                    reader.skipType(wire)
                }
                if (reader.pos > reader.len) throw new Error('truncated wire');
            }
            return result;
        };
        const summary = parse(protobuf.Reader.create(raw), {
            4:{name:'id',wire:2}, 17:{name:'metadata',wire:2}, 24:{name:'fork',wire:2}
        });
        if (!summary.id || !summary.metadata) return null;
        const metadata = parse(protobuf.Reader.create(summary.metadata), {
            5:{name:'parent',wire:2}, 6:{name:'root',wire:2},
            17:{name:'depth',wire:0}, 18:{name:'project',wire:2}
        });
        if (!metadata.root || !metadata.project) return null;
        const decoder = new TextDecoder('utf-8', {fatal:true});
        const string  = value => value ? decoder.decode(value) : '';
        return {id:string(summary.id),fork:string(summary.fork),parent:string(metadata.parent),
            root:string(metadata.root),project:string(metadata.project),depth:metadata.depth ?? 0};
    } catch { return null }
}

/** @summary Distinguishes a proven copied root from an unavailable candidate; unknown never falls back. */
function rootDisposition(row) {
    if (!row || !UUID.test(row.conversation_id || '')) return 'unknown';
    const metadata = nativeIdentity(row.raw_summary);
    if (!metadata || !UUID.test(metadata.id) || metadata.project !== row.project_id ||
        metadata.root !== row.conversation_id || metadata.parent !== row.parent_conversation_id ||
        metadata.depth !== row.nesting_depth) return 'unknown';
    if (metadata.fork) return UUID.test(metadata.fork) ? 'fork' : 'unknown';
    return row.parent_conversation_id === '' && row.nesting_depth === 0 && row.killed === 0 &&
        row.source === '' && STATES.has(row.status) ? 'root' : 'unknown';
}
function eligible(row) {
    return rootDisposition(row) === 'root';
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
        const row = db.prepare('SELECT conversation_id, project_id, parent_conversation_id, nesting_depth, killed, source, status, raw_summary FROM conversation_summaries WHERE conversation_id = ? AND project_id = ?').get(threadId, projectId);
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
        const length = Math.min(64,stat.size), tail = Buffer.alloc(length);
        if (length && fs.readSync(fd,tail,0,length,stat.size-length) !== length) throw new Error('Cursor unreadable');
        return {dev:stat.dev,ino:stat.ino,offset:stat.size,tailHash:crypto.createHash('sha256').update(tail).digest('hex')};
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

/**
 * @summary Streams complete post-cursor JSONL records with bounded line and chunk memory.
 * A cursor captured in an unfinished record skips its remainder; malformed or oversized records
 * yield null so callers discard earlier correlation. File replacement and truncation fail closed.
 * @private
 */
function* transcriptRecords({appDataDir,threadId,cursor}) {
    const fd = fs.openSync(transcriptFor(appDataDir,threadId),fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.dev !== cursor.dev || stat.ino !== cursor.ino || stat.size < cursor.offset ||
            !/^[0-9a-f]{64}$/.test(cursor.tailHash || '')) throw new Error('Transcript changed');
        const tailLength = Math.min(64,cursor.offset), tail = Buffer.alloc(tailLength);
        if ((tailLength && fs.readSync(fd,tail,0,tailLength,cursor.offset-tailLength) !== tailLength) ||
            crypto.createHash('sha256').update(tail).digest('hex') !== cursor.tailHash) throw new Error('Cursor content changed');
        const chunk  = Buffer.allocUnsafe(64 * 1024), limit = 1024 * 1024;
        let   offset = cursor.offset, parts = [], size = 0, skipping = false;
        if (offset > 0) {
            const previous = Buffer.allocUnsafe(1);
            if (fs.readSync(fd,previous,0,1,offset-1) !== 1) throw new Error('Cursor unreadable');
            skipping = previous[0] !== 10;
        }
        while (offset < stat.size) {
            const count = fs.readSync(fd,chunk,0,Math.min(chunk.length,stat.size-offset),offset);
            if (!count) throw new Error('Transcript shortened');
            offset += count;
            let begin = 0;
            for (let i=0;i<count;i++) {
                if (chunk[i] !== 10) continue;
                if (!skipping) {
                    const piece = chunk.subarray(begin,i);
                    if (size + piece.length <= limit) {
                        parts.push(Buffer.from(piece));
                        try { yield JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { yield null }
                    } else { yield null }
                } else { yield null }
                parts=[]; size=0; skipping=false; begin=i+1;
            }
            const rest = chunk.subarray(begin,count);
            if (!skipping && rest.length) {
                size += rest.length;
                if (size > limit) { parts=[]; skipping=true } else { parts.push(Buffer.from(rest)) }
            }
        }
        // An incomplete trailing record is not evidence.
    } finally { fs.closeSync(fd) }
}

/** @summary Looks for the exact native opaque message after a pre-send same-file cursor. */
export function hasAntigravityPendingSystemWake({appDataDir,threadId,text,cursor}) {
    if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || typeof text !== 'string') return false;
    try {
        let latest = false;
        for (const item of transcriptRecords({appDataDir,threadId,cursor})) {
            if (!item || item.truncated_fields) latest = false;
            else if (item.type === 'USER_INPUT' || item.type === 'SYSTEM_MESSAGE') latest = isAntigravityWakeSystemMessage(item,text);
        }
        return latest;
    } catch { return false }
}

/**
 * @summary Recognizes the exact post-cursor wake followed by the private model acknowledgment.
 * @returns {Object} A bounded model-response observation, or unknown.
 */
export function readAntigravityWakeReceipt({appDataDir,threadId,text,cursor,receiptToken}) {
    const unknown = {outcome:'unknown'};
    if (typeof text !== 'string' || !text || !cursor || !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 || !UUID.test(receiptToken || '')) return unknown;
    try {
        let matched = null;
        for (const item of transcriptRecords({appDataDir,threadId,cursor})) {
            if (!item || item.truncated_fields) { matched = null; continue }
            if (((item.type === 'USER_INPUT' && item.source === 'USER_EXPLICIT' && item.status === 'DONE' && item.content === text) ||
                isAntigravityWakeSystemMessage(item,text)) && Number.isSafeInteger(item.step_index)) {
                matched = item.step_index;
            } else if (matched !== null && (item.type === 'USER_INPUT' || item.type === 'SYSTEM_MESSAGE')) {
                matched = null;
            } else if (matched !== null && item.type === 'PLANNER_RESPONSE' && item.source === 'MODEL' &&
                item.status === 'DONE' && Number.isSafeInteger(item.step_index) && item.step_index > matched) {
                const lines = typeof item.content === 'string' ? item.content.split(/\r?\n/) : [];
                if (lines.some(line => line === '[NEO_WAKE_RECEIVED:' + receiptToken + ']')) {
                    return {outcome:'observed',reason:'private-model-ack'};
                }
            }
        }
        return unknown;
    } catch { return unknown }
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

        const prior     = new Set(state.priorThreadIds);
        const additions = withDatabase(databasePath, db => {
            const ids  = db.prepare("SELECT conversation_id FROM conversation_summaries WHERE project_id=? AND parent_conversation_id='' AND nesting_depth=0").all(projectId);
            const load = db.prepare('SELECT conversation_id, project_id, parent_conversation_id, nesting_depth, killed, source, status, raw_summary FROM conversation_summaries WHERE project_id=? AND conversation_id=?');
            return ids.filter(row => !prior.has(row.conversation_id))
                .map(row => {
                    const value = load.get(projectId,row.conversation_id);
                    return {row:value, disposition:rootDisposition(value)};
                });
        });
        const ignored    = additions.filter(item => item.disposition === 'fork').map(item => item.row);
        const candidates = additions.filter(item => item.disposition !== 'fork');
        // A positively identified fork may be retired from the pending census. Unknown, killed,
        // malformed or multiple possible roots stay pending and must not reactivate an older root.
        state.priorThreadIds.push(...ignored.map(row => row.conversation_id));
        const candidate = candidates.length === 1 ? candidates[0] : null;
        const row       = candidate?.row;
        const accepted  = row && row.conversation_id === input.conversationId && candidate.disposition === 'root';
        if (accepted) {
            state.priorThreadIds.push(row.conversation_id);
            state.threadId = row.conversation_id;
            state.sequence = (state.sequence || 0) + 1;
            state.witness = false;
        }
        if (ignored.length || accepted) writeFileAtomicSync(file,JSON.stringify(state),{mode:0o600,fsync:true});
        return accepted ? {threadId:row.conversation_id,projectId:row.project_id,status:row.status} : null;
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
