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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_ID          = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PS_LSTART_UTC            = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const MAX_PENDING_OBSERVATIONS = 8;
const STATES                   = new Set(['CASCADE_RUN_STATUS_IDLE', 'CASCADE_RUN_STATUS_RUNNING']);
const EXTERNAL_SYSTEM_ENVELOPE = /^The following is a <SYSTEM_MESSAGE> not actually sent by the user\. It is provided by the system as important information to pay attention to\.\n\n<SYSTEM_MESSAGE>\n\[Message\] timestamp=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) sender=system priority=(MESSAGE_PRIORITY_[A-Z_]+) content=(.*)$/s;

function isTruncatedField(item, field) {
    return Array.isArray(item?.truncated_fields) && item.truncated_fields.includes(field);
}

/** @summary Recognizes only external system-dispatched envelopes, not Plan Mode or task/subagent notices. */
export function isAntigravityExternalSystemMessage(item) {
    if (item?.type !== 'SYSTEM_MESSAGE' || item.source !== 'SYSTEM' || item.status !== 'DONE' ||
        typeof item.content !== 'string') return false;
    const match = item.content.match(EXTERNAL_SYSTEM_ENVELOPE);
    return Boolean(match && !Number.isNaN(Date.parse(match[1])));
}

function validateInputs(databasePath, projectId) {
    if (!path.isAbsolute(databasePath || '') || typeof projectId !== 'string' || !projectId.trim()) {
        throw new TypeError('Absolute database path and explicit project ID required');
    }
}

/**
 * @summary Reads only the native summary identity fields; malformed or ambiguous wire data is unavailable.
 * The observed schema is CascadeTrajectorySummary { trajectory_id:4, created_time:7, trajectory_metadata:17,
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
            4:{name:'id',wire:2}, 7:{name:'created',wire:2}, 17:{name:'metadata',wire:2}, 24:{name:'fork',wire:2}
        });
        if (!summary.id || !summary.metadata) return null;
        let createdAtMs = null;
        if (summary.created) {
            const tsReader = protobuf.Reader.create(summary.created), seenTs = new Set();
            let   seconds  = 0, nanos = 0;
            while (tsReader.pos < tsReader.len) {
                const tag = tsReader.uint32(), field = tag >>> 3, wire = tag & 7;
                if (seenTs.has(field) || wire !== 0 || (field !== 1 && field !== 2)) throw new Error('invalid timestamp');
                seenTs.add(field);
                if (field === 1) seconds = Number(tsReader.int64().toString());
                else nanos = tsReader.uint32();
            }
            if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) {
                throw new Error('invalid timestamp');
            }
            createdAtMs = seconds * 1000 + Math.floor(nanos / 1_000_000);
        }
        const metadata = parse(protobuf.Reader.create(summary.metadata), {
            5:{name:'parent',wire:2}, 6:{name:'root',wire:2},
            17:{name:'depth',wire:0}, 18:{name:'project',wire:2}
        });
        if (!metadata.root || !metadata.project) return null;
        const decoder = new TextDecoder('utf-8', {fatal:true});
        const string  = value => value ? decoder.decode(value) : '';
        return {id:string(summary.id),fork:string(summary.fork),parent:string(metadata.parent),
            root:string(metadata.root),project:string(metadata.project),depth:metadata.depth ?? 0,createdAtMs};
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
            if (!item) latest = false;
            else if (item.type === 'USER_INPUT' || isAntigravityExternalSystemMessage(item)) latest = isAntigravityWakeSystemMessage(item,text);
        }
        return latest;
    } catch { return false }
}

/**
 * @summary Recognizes the exact post-cursor wake followed by the private model acknowledgment, or settled unacknowledged finish.
 * @param {Object} options
 * @param {String} options.appDataDir Antigravity appData root directory
 * @param {String} options.threadId Conversation UUID of the target thread
 * @param {String} options.text Exact opaque wake marker text
 * @param {Object} options.cursor Pre-send transcript cursor (`{path, offset}`)
 * @param {String|null} [options.receiptToken=null] Per-attempt private acknowledgment token
 * @param {String|null} [options.targetStatus=null] Live conversation cascade status (e.g. `'CASCADE_RUN_STATUS_IDLE'`)
 * @param {Boolean} [options.settleUnacknowledged=false] Set true to settle finished idle or superseded unacknowledged turns
 * @returns {Object} A bounded model-response observation, `turn-unacknowledged`, or `unknown`.
 */
export function readAntigravityWakeReceipt({appDataDir,threadId,text,cursor,receiptToken=null,targetStatus=null,settleUnacknowledged=false}) {
    const unknown = {outcome:'unknown'};
    if (typeof text !== 'string' || !text || !cursor || !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 || (receiptToken !== null ? !UUID.test(receiptToken || '') : !settleUnacknowledged)) return unknown;
    try {
        let matched = null, wakeSeen = false, superseded = false, terminalResponse = false;
        for (const item of transcriptRecords({appDataDir,threadId,cursor})) {
            if (!item) { matched = null; terminalResponse = false; continue }
            if (((item.type === 'USER_INPUT' && item.source === 'USER_EXPLICIT' && item.status === 'DONE' &&
                !isTruncatedField(item,'content') && item.content === text) ||
                isAntigravityWakeSystemMessage(item,text)) && Number.isSafeInteger(item.step_index)) {
                matched = item.step_index; wakeSeen = true; superseded = false; terminalResponse = false;
            } else if (matched !== null && (item.type === 'USER_INPUT' || isAntigravityExternalSystemMessage(item))) {
                matched = null; superseded = true; terminalResponse = false;
            } else if (matched !== null && item.type === 'PLANNER_RESPONSE' && item.source === 'MODEL' &&
                item.status === 'DONE' && Number.isSafeInteger(item.step_index) && item.step_index > matched) {
                terminalResponse = !isTruncatedField(item,'tool_calls') && (!Array.isArray(item.tool_calls) || item.tool_calls.length === 0);
                if (receiptToken && !isTruncatedField(item,'content')) {
                    const lines = typeof item.content === 'string' ? item.content.split(/\r?\n/) : [];
                    if (lines.some(line => line === '[NEO_WAKE_RECEIVED:' + receiptToken + ']')) {
                        return {outcome:'observed',reason:'private-model-ack'};
                    }
                }
            } else if (matched !== null) {
                terminalResponse = false;
            }
        }
        if (settleUnacknowledged && wakeSeen && (superseded || (matched !== null && terminalResponse && targetStatus === 'CASCADE_RUN_STATUS_IDLE'))) {
            return {outcome:'turn-unacknowledged'};
        }
        return unknown;
    } catch { return unknown }
}

/** @summary Parses `<pid>:<startedAt>` (`TZ=UTC` `ps lstart` or ISO-8601) into epoch ms, or `null`. */
function parseGenerationStartedAtMs(generation) {
    if (typeof generation !== 'string') return null;
    const idx = generation.indexOf(':');
    if (idx <= 0) return null;
    const raw = generation.slice(idx + 1).trim();
    if (PS_LSTART_UTC.test(raw)) {
        const ms = Date.parse(raw + ' UTC');
        return Number.isFinite(ms) ? ms : null;
    }
    const iso = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
    return Number.isFinite(iso) ? iso : null;
}

/** @summary Reads an owner-only (`0600`), non-symlink JSON state file (`<= 1 MiB`), returning `null` on `ENOENT`. */
function readPrivateStartsJson(file) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 1024 * 1024) {
            throw new Error('Invalid private wake starts record');
        }
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

/** @summary Resolves `<stateDir>/primary-session-launches/<agentId>.json` after validating path and `AGENT_ID`. */
function launchCensusPath(stateDir, agentId) {
    if (!path.isAbsolute(stateDir || '') || !AGENT_ID.test(agentId || '')) {
        throw new TypeError('Absolute state directory and valid agentId required');
    }
    return path.join(stateDir, 'primary-session-launches', agentId + '.json');
}

/** @summary Lists verified UUIDs of top-level (`parent === ''`, `nesting_depth === 0`) project summaries for pre-launch exclusion. */
function censusRootIds(databasePath, projectId, {allowMissingDb = false} = {}) {
    validateInputs(databasePath, projectId);
    if (allowMissingDb && !fs.existsSync(databasePath)) return [];
    const ids = withDatabase(databasePath, db => db.prepare("SELECT conversation_id FROM conversation_summaries WHERE project_id=? AND parent_conversation_id='' AND nesting_depth=0").all(projectId).map(x => x.conversation_id));
    if (ids.some(id => !UUID.test(id))) throw new Error('Invalid root census');
    return ids;
}

/** @summary Reads `step_index === 0` `created_at` from a canonical, non-symlink transcript (`null` if not flushed yet; `'invalid'` on corruption/tamper). */
function transcriptCreatedAtMs(appDataDir, threadId) {
    if (!appDataDir) return null;
    if (!path.isAbsolute(appDataDir) || !UUID.test(threadId || '')) return 'invalid';
    let root;
    try { root = fs.realpathSync(appDataDir) } catch (error) { return error.code === 'ENOENT' ? null : 'invalid' }
    let current = root;
    for (const part of ['brain', threadId, '.system_generated', 'logs']) {
        current = path.join(current, part);
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) return 'invalid';
        } catch (error) { return error.code === 'ENOENT' ? null : 'invalid' }
    }
    const file = path.join(current, 'transcript.jsonl');
    let fd;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW) }
    catch (error) { return error.code === 'ENOENT' ? null : 'invalid' }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) return 'invalid';
        if (stat.size === 0) return null;
        const limit = Math.min(stat.size, 16 * 1024), buf = Buffer.alloc(limit);
        const count = fs.readSync(fd, buf, 0, limit, 0);
        const nl    = buf.subarray(0, count).indexOf(10);
        if (nl < 0) return stat.size >= 16 * 1024 ? 'invalid' : null;
        const first = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        if (!first || first.step_index !== 0 || typeof first.created_at !== 'string') return 'invalid';
        const ms = Date.parse(first.created_at);
        return Number.isFinite(ms) ? ms : 'invalid';
    } catch { return 'invalid' }
    finally { fs.closeSync(fd) }
}

/**
 * @summary Classifies a summary row's creation provenance into `'created'`, `'historical'`, `'unattested'`, or `'unknown'`.
 * Rule & thresholds: (1) rejects corrupt protobuf/transcript or `> 5000` ms skew between protobuf `created_time` (`sCreated`,
 * floored to seconds) and `step_index === 0` transcript `created_at` (`tCreated`) as `'unknown'`, blocking imported/restored
 * historical roots replayed into SQLite while tolerating normal App summary-to-log write jitter; (2) `sCreated + 1 >= baselineAtMs`
 * tolerates sub-millisecond `Math.floor(nanos / 1e6)` truncation against a `Date.now()` ms baseline without admitting earlier ms;
 * (3) `tCreated >= Math.floor(baselineAtMs / 1000) * 1000` safely compares second-granularity timestamps (`ps lstart` or whole-second
 * ISO) because pre-existing roots are already excluded by `priorThreadIds`. Returns `'historical'` if either witness precedes the
 * baseline, `'created'` if at least one proves post-baseline creation, and `'unattested'` when neither timestamp is present yet.
 */
function creationDisposition(row, appDataDir, baselineAtMs) {
    const metadata = nativeIdentity(row?.raw_summary);
    if (!metadata) return 'unknown';
    const tCreated = transcriptCreatedAtMs(appDataDir, row.conversation_id);
    if (tCreated === 'invalid') return 'unknown';
    const sCreated = metadata.createdAtMs;
    if (sCreated !== null && Number.isFinite(tCreated) && Math.abs(Math.floor(sCreated / 1000) * 1000 - tCreated) > 5000) {
        return 'unknown';
    }
    if (!Number.isFinite(baselineAtMs)) return 'unattested';
    const sFresh = sCreated !== null ? sCreated + 1 >= baselineAtMs : null;
    const tFresh = Number.isFinite(tCreated) ? tCreated >= Math.floor(baselineAtMs / 1000) * 1000 : null;
    if (sFresh === false || tFresh === false) return 'historical';
    return (sFresh === true || tFresh === true) ? 'created' : 'unattested';
}

/** @summary Deduplicates up to `MAX_PENDING_OBSERVATIONS` UUID start entries, keeping `deferred: false` once observed synchronously. */
function normalizePendingStarts(entries) {
    if (!Array.isArray(entries)) return [];
    const byId = new Map();
    for (const item of entries) {
        const id       = typeof item === 'string' ? item : item?.id;
        const deferred = typeof item === 'object' && item !== null ? item.deferred !== false : true;
        if (!UUID.test(id || '')) continue;
        const prev = byId.get(id);
        byId.set(id, {id, deferred: prev ? (prev.deferred && deferred) : deferred});
    }
    return [...byId.values()].slice(-MAX_PENDING_OBSERVATIONS);
}

/** @summary Deduplicates and bounds (`MAX_PENDING_OBSERVATIONS`) UUID `PreInvocation` witness candidates. */
function normalizePendingWitnesses(entries) {
    if (!Array.isArray(entries)) return [];
    return [...new Set(entries.filter(id => UUID.test(id || '')))].slice(-MAX_PENDING_OBSERVATIONS);
}

/** @summary Canonicalizes `.starts.json` schema fields, bounds pending queues, and defaults missing counters fail-closed. */
function normalizeStartsState(state) {
    return {
        version         : 1,
        ...(UUID.test(state?.launchId || '') ? {launchId: state.launchId} : {}),
        generation      : state.generation,
        projectId       : state.projectId,
        priorThreadIds  : [...new Set(state.priorThreadIds)],
        baselineAtMs    : Number.isFinite(state.baselineAtMs) ? state.baselineAtMs : null,
        pendingStarts   : normalizePendingStarts(state.pendingStarts),
        pendingWitnesses: normalizePendingWitnesses(state.pendingWitnesses),
        threadId        : state.threadId || null,
        sequence        : Number.isSafeInteger(state.sequence) && state.sequence >= 0 ? state.sequence : 0,
        witness         : state.witness === true
    };
}

/** @summary Fetches one `(projectId, conversationId)` summary row read-only, or `null` when DB/row is not materialized yet. */
function inspectConversationRow(databasePath, projectId, conversationId) {
    if (!databasePath || !fs.existsSync(databasePath)) return null;
    return withDatabase(databasePath, db => db.prepare('SELECT conversation_id, project_id, parent_conversation_id, nesting_depth, killed, source, status, raw_summary FROM conversation_summaries WHERE project_id=? AND conversation_id=?').get(projectId, conversationId) || null);
}

/**
 * @summary Reconciles pending `SessionStart`/`PreInvocation` observations against readable SQLite summary metadata.
 * Acceptance conjunction: forks move permanently into `priorThreadIds`, helper/subagent rows (`nonRoots`) are evicted, and a
 * root binds `state.threadId` iff it is the *sole* non-fork post-census addition (`candidates.length === 1`), has a matching
 * `pendingStarts` entry, passes `rootDisposition === 'root'`, and is neither `'historical'` nor `'unknown'`. A synchronous start
 * (`deferred: false`, row already flushed during `SessionStart`) safely accepts `'unattested'` because pre-start `priorThreadIds`
 * + live callback already bracket its creation; a deferred start (`deferred: true`, row flushed after `SessionStart`) requires
 * `creation === 'created'` so a late SQLite backfill or workspace import without post-baseline creation proof can never self-promote.
 */
function reconcileAntigravityStartsState(state, {databasePath, appDataDir = null, projectId}) {
    if (!databasePath || !fs.existsSync(databasePath)) return null;
    const before         = JSON.stringify(state);
    const prior          = new Set(state.priorThreadIds);
    let   acceptedTarget = null;
    const snapshot       = withDatabase(databasePath, db => {
        const ids      = db.prepare("SELECT conversation_id FROM conversation_summaries WHERE project_id=? AND parent_conversation_id='' AND nesting_depth=0").all(projectId);
        const load     = db.prepare('SELECT conversation_id, project_id, parent_conversation_id, nesting_depth, killed, source, status, raw_summary FROM conversation_summaries WHERE project_id=? AND conversation_id=?');
        const nonRoots = new Set();
        for (const pendingId of [...state.pendingStarts.map(x => x.id), ...state.pendingWitnesses]) {
            const row = load.get(projectId, pendingId);
            if (row && (row.parent_conversation_id !== '' || row.nesting_depth !== 0)) nonRoots.add(pendingId);
        }
        const additions = ids.filter(row => !prior.has(row.conversation_id)).map(row => {
            const value = load.get(projectId, row.conversation_id);
            return {row: value, disposition: rootDisposition(value)};
        });
        return {additions, nonRoots};
    });
    const ignored    = snapshot.additions.filter(item => item.disposition === 'fork').map(item => item.row);
    const candidates = snapshot.additions.filter(item => item.disposition !== 'fork');
    for (const row of ignored) {
        if (!prior.has(row.conversation_id)) {
            prior.add(row.conversation_id);
            state.priorThreadIds.push(row.conversation_id);
        }
    }
    state.pendingStarts    = state.pendingStarts.filter(entry => !prior.has(entry.id) && !snapshot.nonRoots.has(entry.id));
    state.pendingWitnesses = state.pendingWitnesses.filter(id => (id === state.threadId || !prior.has(id)) && !snapshot.nonRoots.has(id));

    if (candidates.length === 1) {
        const candidate  = candidates[0], row = candidate.row, id = row?.conversation_id;
        const startEntry = state.pendingStarts.find(entry => entry.id === id);
        const creation   = row && candidate.disposition === 'root' ? creationDisposition(row, appDataDir, state.baselineAtMs) : 'unknown';
        if (startEntry && candidate.disposition === 'root' && creation !== 'historical' && creation !== 'unknown' &&
            (!startEntry.deferred || creation === 'created')) {
            state.priorThreadIds.push(id);
            prior.add(id);
            state.threadId         = id;
            state.sequence         = (state.sequence || 0) + 1;
            state.witness          = state.pendingWitnesses.includes(id);
            state.pendingStarts    = state.pendingStarts.filter(entry => entry.id !== id);
            state.pendingWitnesses = state.pendingWitnesses.filter(w => w !== id);
            acceptedTarget         = {threadId: id, projectId: row.project_id, status: row.status};
        } else if (creation === 'historical') {
            state.pendingStarts    = state.pendingStarts.filter(entry => entry.id !== id);
            state.pendingWitnesses = state.pendingWitnesses.filter(w => w !== id);
        }
    }

    if (state.threadId && !state.witness && state.pendingWitnesses.includes(state.threadId)) {
        state.witness          = true;
        state.pendingWitnesses = state.pendingWitnesses.filter(w => w !== state.threadId);
    }

    return {changed: JSON.stringify(state) !== before, acceptedTarget};
}

/** @summary Acquires `outboxLock` in fixed `launchFile -> startsFile` order (matching `cleanupAntigravityLaunchCensus`) to prevent deadlock. */
async function withStartsLocks({statePath, stateDir = null, agentId = null}, fn) {
    const startsFile            = statePath + '.starts.json';
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    const candidateLaunchFile   = stateDir && agentId ? launchCensusPath(stateDir, agentId) : null;
    const launchFile            = candidateLaunchFile && fs.existsSync(path.dirname(candidateLaunchFile)) ? candidateLaunchFile : null;
    const run                   = () => withOutboxLock(startsFile, () => fn({startsFile, launchFile, writeFileAtomicSync}));
    return launchFile ? withOutboxLock(launchFile, run) : run();
}

/**
 * @summary Loads current-generation `.starts.json` or one-shot adopts a Fleet-staged pre-spawn launch census (`launchFile`).
 * Rule: a staged launch with `generation === null` (written before child PID/start exists) is adopted and unlinked by the first
 * caller matching `(authorized: true, projectId)` — safe because every caller (`initializeAntigravityStarts` on verified route
 * publication, or hook callbacks verified against `.neo-fleet-seat-lease.json` + ancestor PID/start) has already authenticated
 * `generation` as the Fleet-leased child for that `instanceHome` and `projectId`, while mismatched generations evict stale files.
 */
function loadOrAdoptStarts({startsFile, launchFile, databasePath, projectId, generation, baselineAtMs = null, createCensusIfMissing = false}) {
    const old    = readPrivateStartsJson(startsFile);
    const launch = launchFile ? readPrivateStartsJson(launchFile) : null;
    let   dirty  = false, state = null;

    if (launch && launch.generation !== null && launch.generation !== generation) {
        fs.rmSync(launchFile, {force: true});
    } else if (launch?.version === 1 && launch.authorized === true && launch.projectId === projectId &&
        (launch.generation === null || launch.generation === generation)) {
        if (!old || old.generation !== generation || old.projectId !== projectId || launch.resetGeneration === true) {
            state = normalizeStartsState({
                version         : 1,
                launchId        : launch.launchId,
                generation,
                projectId,
                priorThreadIds  : launch.priorThreadIds,
                baselineAtMs    : launch.baselineAtMs,
                pendingStarts   : launch.pendingStarts,
                pendingWitnesses: launch.pendingWitnesses,
                threadId        : null,
                sequence        : 0,
                witness         : false
            });
        } else {
            state                  = normalizeStartsState(old);
            state.pendingStarts    = normalizePendingStarts([...state.pendingStarts, ...(launch.pendingStarts || [])]);
            state.pendingWitnesses = normalizePendingWitnesses([...state.pendingWitnesses, ...(launch.pendingWitnesses || [])]);
        }
        fs.rmSync(launchFile, {force: true});
        dirty = true;
    } else if (old?.generation === generation && old.projectId === projectId && Array.isArray(old.priorThreadIds)) {
        state = normalizeStartsState(old);
    } else if (createCensusIfMissing) {
        const ids = censusRootIds(databasePath, projectId);
        state = normalizeStartsState({
            version         : 1,
            generation,
            projectId,
            priorThreadIds  : ids,
            baselineAtMs    : baselineAtMs ?? parseGenerationStartedAtMs(generation) ?? Date.now(),
            pendingStarts   : [],
            pendingWitnesses: [],
            threadId        : null,
            sequence        : 0,
            witness         : false
        });
        dirty = true;
    }

    return {state, dirty};
}

/**
 * @summary Captures a pre-spawn or activation root census bound to one managed Start attempt.
 * @param {Object} options Start-scoped seat, project and receiver paths.
 * @returns {Promise<Object|null>} The staged launch census, or null when native wake is not authorized.
 */
export async function stageAntigravityLaunchCensus({stateDir, databasePath, appDataDir, launchId, agentId, instanceHome,
    projectId, projectRoot, generation = null, resetGeneration = false, authorized = false, baselineAtMs = Date.now()}) {
    if (!authorized) return null;
    if (!UUID.test(launchId || '') || !path.isAbsolute(instanceHome || '') || !path.isAbsolute(projectRoot || '')) {
        throw new TypeError('Valid launchId, instanceHome and projectRoot required');
    }
    const dbFile = databasePath || path.join(appDataDir || '', 'conversation_summaries.db');
    const file   = launchCensusPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file, async () => {
        const priorThreadIds = censusRootIds(dbFile, projectId, {allowMissingDb: true});
        const record         = {
            version         : 1,
            launchId,
            agentId,
            instanceHome,
            projectId,
            projectRoot,
            authorized      : true,
            generation      : generation || null,
            resetGeneration : resetGeneration === true,
            priorThreadIds,
            baselineAtMs,
            pendingStarts   : [],
            pendingWitnesses: []
        };
        writeFileAtomicSync(file, JSON.stringify(record), {mode: 0o600, fsync: true});
        return record;
    });
}

/**
 * @summary Binds a pending cold-launch census to the verified child lease generation.
 * @param {Object} options Launch and live child generation coordinates.
 * @returns {Promise<Object|null>} Updated launch record, or null when already adopted.
 */
export async function bindAntigravityLaunchGeneration({stateDir, agentId, launchId, instanceHome, projectId, projectRoot, generation}) {
    if (!generation || !UUID.test(launchId || '')) return null;
    const file = launchCensusPath(stateDir, agentId);
    if (!fs.existsSync(path.dirname(file))) return null;
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file, async () => {
        const launch = readPrivateStartsJson(file);
        if (!launch || launch.launchId !== launchId) return null;
        if (launch.agentId !== agentId || launch.instanceHome !== instanceHome ||
            launch.projectId !== projectId || launch.projectRoot !== projectRoot ||
            (launch.generation !== null && launch.generation !== generation)) {
            fs.rmSync(file, {force: true});
            throw new Error('Antigravity launch census does not match child lease');
        }
        if (launch.generation !== generation) {
            launch.generation = generation;
            writeFileAtomicSync(file, JSON.stringify(launch), {mode: 0o600, fsync: true});
        }
        return launch;
    });
}

/**
 * @summary Withdraws any pending or adopted start baseline belonging to a canceled/failed Start attempt.
 * @param {Object} options Receiver state directory, agentId and attempt launchId.
 * @returns {Promise<void>}
 */
export async function cleanupAntigravityLaunchCensus({stateDir, agentId, launchId}) {
    if (!path.isAbsolute(stateDir || '') || !AGENT_ID.test(agentId || '') || !UUID.test(launchId || '')) return;
    const file             = launchCensusPath(stateDir, agentId);
    const {withOutboxLock} = await import('./outboxLock.mjs');
    if (fs.existsSync(path.dirname(file))) {
        await withOutboxLock(file, async () => {
            const launch = readPrivateStartsJson(file);
            if (launch?.launchId === launchId) fs.rmSync(file, {force: true});
        });
    }
    const sessionsDir = path.join(stateDir, 'primary-sessions');
    let   entries     = [];
    try { entries = fs.readdirSync(sessionsDir) } catch { return }
    for (const name of entries) {
        if (!name.endsWith('.json.starts.json')) continue;
        const startsFile = path.join(sessionsDir, name);
        await withOutboxLock(startsFile, async () => {
            const state = readPrivateStartsJson(startsFile);
            if (state?.launchId === launchId) fs.rmSync(startsFile, {force: true});
        });
    }
}

/**
 * @summary Retains an authenticated ordinary hook observation arriving after lease bind but before manifest publication.
 * @param {Object} options Verified App ancestor, lease, project receipt and hook payload.
 * @returns {Promise<Boolean>} True only when matched to an active Fleet Start census.
 */
export async function observeAntigravityPendingLaunchHook({event, stateDir, appDataDir = null, databasePath = null,
    agentId, instanceHome, projectId, projectRoot, generation, input}) {
    if ((event !== 'SessionStart' && event !== 'PreInvocation') || !generation ||
        !Array.isArray(input?.workspacePaths) || !input.workspacePaths.includes(projectRoot) ||
        !UUID.test(input?.conversationId || '')) return false;
    if (event === 'PreInvocation') {
        const invocationNum = input?.invocationNum === undefined ? 0 : input.invocationNum;
        if (!Number.isSafeInteger(invocationNum) || invocationNum < 0) return false;
    }
    const file = launchCensusPath(stateDir, agentId);
    if (!fs.existsSync(path.dirname(file))) return false;
    const {withOutboxLock}      = await import('./outboxLock.mjs');
    const {writeFileAtomicSync} = await import('../../services/shared/atomicFileWrite.mjs');
    return withOutboxLock(file, async () => {
        const launch = readPrivateStartsJson(file);
        if (!launch || launch.version !== 1 || launch.authorized !== true || launch.agentId !== agentId ||
            launch.instanceHome !== instanceHome || launch.projectId !== projectId || launch.projectRoot !== projectRoot ||
            (launch.generation !== null && launch.generation !== generation)) {
            return false;
        }
        launch.generation = generation;
        const id = input.conversationId;
        if (launch.priorThreadIds.includes(id)) {
            writeFileAtomicSync(file, JSON.stringify(launch), {mode: 0o600, fsync: true});
            return false;
        }
        const dbFile = databasePath || (appDataDir ? path.join(appDataDir, 'conversation_summaries.db') : null);
        const row    = inspectConversationRow(dbFile, projectId, id);
        if (row && (row.parent_conversation_id !== '' || row.nesting_depth !== 0)) {
            writeFileAtomicSync(file, JSON.stringify(launch), {mode: 0o600, fsync: true});
            return false;
        }
        if (row && rootDisposition(row) === 'fork') {
            launch.priorThreadIds.push(id);
            writeFileAtomicSync(file, JSON.stringify(launch), {mode: 0o600, fsync: true});
            return false;
        }
        if (event === 'SessionStart') {
            launch.pendingStarts = normalizePendingStarts([...(launch.pendingStarts || []), {id, deferred: !row}]);
        } else {
            launch.pendingWitnesses = normalizePendingWitnesses([...(launch.pendingWitnesses || []), id]);
        }
        writeFileAtomicSync(file, JSON.stringify(launch), {mode: 0o600, fsync: true});
        return true;
    });
}

/** @summary Initializes or reconciles the generation census and adopts any matching Start baseline. */
export async function initializeAntigravityStarts({databasePath, appDataDir = null, projectId, generation, statePath, stateDir = null, agentId = null, baselineAtMs = null}) {
    validateInputs(databasePath, projectId);
    if (!generation || !path.isAbsolute(statePath || '')) throw new TypeError('Generation and state path required');
    return withStartsLocks({statePath, stateDir, agentId}, async ({startsFile, launchFile, writeFileAtomicSync}) => {
        const {state, dirty} = loadOrAdoptStarts({startsFile, launchFile, databasePath, projectId, generation, baselineAtMs, createCensusIfMissing: true});
        let   changed        = dirty;
        if (state.pendingStarts.length || state.pendingWitnesses.length) {
            const reconciled = reconcileAntigravityStartsState(state, {databasePath, appDataDir, projectId});
            if (reconciled?.changed) changed = true;
        }
        if (changed) writeFileAtomicSync(startsFile, JSON.stringify(state), {mode: 0o600, fsync: true});
        return state;
    });
}

/** @summary Reconciles an already-initialized or Start-staged census without inventing an untrusted baseline. */
export async function reconcileAntigravityStarts({databasePath, appDataDir = null, projectId, generation, statePath, stateDir = null, agentId = null}) {
    if (!databasePath || !projectId || !generation || !path.isAbsolute(statePath || '')) return null;
    return withStartsLocks({statePath, stateDir, agentId}, async ({startsFile, launchFile, writeFileAtomicSync}) => {
        const {state, dirty} = loadOrAdoptStarts({startsFile, launchFile, databasePath, projectId, generation, createCensusIfMissing: false});
        if (!state) return null;
        let changed = dirty;
        if (state.pendingStarts.length || state.pendingWitnesses.length) {
            const reconciled = reconcileAntigravityStartsState(state, {databasePath, appDataDir, projectId});
            if (reconciled?.changed) changed = true;
        }
        if (changed) writeFileAtomicSync(startsFile, JSON.stringify(state), {mode: 0o600, fsync: true});
        return state;
    });
}

/** @summary Records an authenticated SessionStart after census/Start baseline and reconciles readable root metadata. */
export async function observeAntigravitySessionStart({databasePath, appDataDir = null, projectId, projectRoot, generation, statePath, stateDir = null, agentId = null, input}) {
    if (!Array.isArray(input?.workspacePaths) || !input.workspacePaths.includes(projectRoot) || !UUID.test(input?.conversationId || '')) return null;
    return withStartsLocks({statePath, stateDir, agentId}, async ({startsFile, launchFile, writeFileAtomicSync}) => {
        let state, dirty;
        try { ({state, dirty} = loadOrAdoptStarts({startsFile, launchFile, databasePath, projectId, generation, createCensusIfMissing: false})) }
        catch { return null }
        if (!state) return null;

        const id      = input.conversationId;
        let   changed = dirty;
        if (!state.priorThreadIds.includes(id)) {
            const row = inspectConversationRow(databasePath, projectId, id);
            if (!row || (row.parent_conversation_id === '' && row.nesting_depth === 0)) {
                state.pendingStarts = normalizePendingStarts([...state.pendingStarts, {id, deferred: !row}]);
                changed = true;
            }
        }
        const reconciled = reconcileAntigravityStartsState(state, {databasePath, appDataDir, projectId});
        if (reconciled?.changed) changed = true;
        if (changed) writeFileAtomicSync(startsFile, JSON.stringify(state), {mode: 0o600, fsync: true});
        if (reconciled?.acceptedTarget?.threadId === id) return reconciled.acceptedTarget;
        if (state.threadId === id && fs.existsSync(databasePath)) {
            return readAntigravityWakeTarget({databasePath, projectId, threadId: id});
        }
        return null;
    });
}

/** @summary Returns only a host-observed current-generation root, revalidated against App metadata. */
export function latestAntigravityWakeTarget({databasePath, projectId, generation, statePath}) {
    try {
        const state = JSON.parse(fs.readFileSync(statePath + '.starts.json', 'utf8'));
        if (state.version !== 1 || state.projectId !== projectId || state.generation !== generation || !state.threadId ||
            !Array.isArray(state.priorThreadIds)) return null;
        const roots = withDatabase(databasePath, db => db.prepare("SELECT conversation_id FROM conversation_summaries WHERE project_id=? AND parent_conversation_id='' AND nesting_depth=0").all(projectId));
        if (roots.some(row => !state.priorThreadIds.includes(row.conversation_id))) return null;
        const target = readAntigravityWakeTarget({databasePath, projectId, threadId: state.threadId});
        return target && Number.isSafeInteger(state.sequence) && state.sequence > 0 ? {...target, root: true, startSequence: state.sequence} : null;
    } catch { return null }
}

/** @summary Reports a PreInvocation witness only for the selected current-generation root. */
export function verifyAntigravityWakeAdmission({databasePath, appDataDir, projectId, threadId, generation, statePath}) {
    try {
        const state = JSON.parse(fs.readFileSync(statePath + '.starts.json', 'utf8'));
        const root  = latestAntigravityWakeTarget({databasePath: databasePath || path.join(appDataDir, 'conversation_summaries.db'), projectId, generation, statePath});
        return {verified: state.witness === true && root?.threadId === threadId};
    } catch { return {verified: false} }
}

/** @summary Marks or retains a native PreInvocation observation and reconciles any deferred SessionStart. */
export async function observeAntigravityPreInvocation({databasePath, appDataDir = null, projectId, projectRoot, generation, statePath, stateDir = null, agentId = null, allowPendingWitness = true, input}) {
    const invocationNum = input?.invocationNum === undefined ? 0 : input.invocationNum;
    if (!Array.isArray(input?.workspacePaths) || !input.workspacePaths.includes(projectRoot) ||
        !Number.isSafeInteger(invocationNum) || invocationNum < 0 || !UUID.test(input?.conversationId || '')) return false;
    return withStartsLocks({statePath, stateDir, agentId}, async ({startsFile, launchFile, writeFileAtomicSync}) => {
        let state, dirty;
        try { ({state, dirty} = loadOrAdoptStarts({startsFile, launchFile, databasePath, projectId, generation, createCensusIfMissing: false})) }
        catch { return false }
        if (!state) return false;

        const id      = input.conversationId;
        let   changed = dirty;
        if (allowPendingWitness && (state.threadId === id || !state.priorThreadIds.includes(id))) {
            const row = inspectConversationRow(databasePath, projectId, id);
            if (!row || (row.parent_conversation_id === '' && row.nesting_depth === 0)) {
                const next = normalizePendingWitnesses([...state.pendingWitnesses, id]);
                if (JSON.stringify(next) !== JSON.stringify(state.pendingWitnesses)) {
                    state.pendingWitnesses = next;
                    changed                = true;
                }
            }
        }
        const reconciled = reconcileAntigravityStartsState(state, {databasePath, appDataDir, projectId});
        if (reconciled?.changed) changed = true;
        if (changed) writeFileAtomicSync(startsFile, JSON.stringify(state), {mode: 0o600, fsync: true});
        const root = latestAntigravityWakeTarget({databasePath, projectId, generation, statePath});
        if (!root || root.threadId !== id) return false;
        if (!state.witness) {
            state.witness          = true;
            state.pendingWitnesses = state.pendingWitnesses.filter(w => w !== id);
            writeFileAtomicSync(startsFile, JSON.stringify(state), {mode: 0o600, fsync: true});
        }
        return true;
    });
}

/** @summary Redeems a reserved wake before model invocation; ordinary prompts pass unchanged. */
export async function handleAntigravityPreInvocation({input,consume,...context}) {
    const text = input?.lastUserInput;
    if (typeof text !== 'string' || !text.startsWith('[NEO_WAKE_V1:')) return {};
    const match         = text.match(/^\[NEO_WAKE_V1:([0-9a-f-]{36})\] \[WAKE\]$/i);
    const deny          = {terminationBehavior:'terminate',injectSteps:[{errorMessage:{userMessage:'Wake admission refused.'}}]};
    const invocationNum = input?.invocationNum === undefined ? 0 : input.invocationNum;
    if (!match || !UUID.test(match[1])) return deny;
    let observed = false;
    try { observed = await observeAntigravityPreInvocation({...context, allowPendingWitness: false, input}) } catch { /* Refuse and reconcile only an authenticated spent wake. */ }
    if (!observed) {
        if (Array.isArray(input.workspacePaths) && input.workspacePaths.includes(context.projectRoot) &&
            Number.isSafeInteger(invocationNum) && invocationNum >= 0 && UUID.test(input.conversationId || '')) {
            // The App/lease-authenticated caller has witnessed this exact native marker. This
            // request can only write a negative claim after host route and nonce checks; it cannot
            // disclose the digest. Unknown/foreign invocations never reach this path.
            try { await consume({threadId:input.conversationId,nonce:match[1],denyOnly:true}) } catch { /* Leave unknown for safe retry. */ }
        }
        return deny
    }
    if (invocationNum > 0) {
        for (const suffix of ['.urgent.claim.json', '.claim.json']) {
            try {
                const claim = JSON.parse(fs.readFileSync(context.statePath + suffix,'utf8'));
                if (claim.admitted === true && claim.nonce === match[1] && claim.threadId === input.conversationId &&
                    claim.generation === context.generation) return {};
            } catch { /* Inspect remaining claim slot. */ }
        }
        return deny
    }
    const result = await consume({threadId:input.conversationId,nonce:match[1]});
    if (!result?.admitted || typeof result.digest !== 'string') return deny;
    return {injectSteps:[{systemMessage:{systemMessage:result.digest + '\nWhen you respond, repeat the exact NEO_WAKE_RECEIVED line above on its own line to acknowledge receipt.'}}]};
}
