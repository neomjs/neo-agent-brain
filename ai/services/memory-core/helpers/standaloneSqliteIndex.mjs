import fs             from 'node:fs';
import path           from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const WAL_SEGMENT_FILE_RE = /^wal-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * @summary Parses JSON safely with a fallback value on malformed input.
 * @param {String|null|undefined} raw Raw JSON string.
 * @param {*} fallback Fallback value.
 * @returns {*}
 */
function safeParseJson(raw, fallback) {
    if (typeof raw !== 'string' || raw.length === 0) {
        return fallback;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

/**
 * @summary Normalizes stored `toolsUsed` metadata into a clean string array when available.
 * @param {*} rawTools Raw tools array or JSON string.
 * @returns {String[]|undefined}
 */
function parseToolsUsed(rawTools) {
    if (Array.isArray(rawTools)) {
        return rawTools.map(item => String(item));
    }
    if (typeof rawTools === 'string' && rawTools.trim().length > 0) {
        const parsed = safeParseJson(rawTools, null);
        if (Array.isArray(parsed)) {
            return parsed.map(item => String(item));
        }
        return rawTools.split(',').map(item => item.trim()).filter(Boolean);
    }
    return undefined;
}

/**
 * @summary Produces a deterministic bounded turn excerpt without requiring an LLM summarizer.
 * @param {Object} turn Turn text fields.
 * @param {String} [turn.prompt=''] Turn prompt.
 * @param {String} [turn.response=''] Turn response.
 * @param {Number} [maxChars=280] Maximum character length.
 * @returns {String}
 */
export function buildDeterministicSummary({prompt = '', response = ''} = {}, maxChars = 280) {
    const cleanPrompt   = String(prompt || '').replace(/\s+/g, ' ').trim();
    const cleanResponse = String(response || '').replace(/\s+/g, ' ').trim();
    const combined      = cleanPrompt && cleanResponse
        ? `Prompt: ${cleanPrompt} | Response: ${cleanResponse}`
        : (cleanPrompt || cleanResponse);

    if (combined.length <= maxChars) {
        return combined;
    }

    return `${combined.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/**
 * @summary Compiles an arbitrary user query string into a syntax-safe FTS5 MATCH expression.
 * @param {String} rawQuery User-supplied natural-language query.
 * @returns {String|null} FTS5 query expression or null when no indexable tokens exist.
 */
export function buildSafeFts5MatchExpression(rawQuery) {
    if (typeof rawQuery !== 'string') {
        return null;
    }

    const matches = rawQuery.match(/[\p{L}\p{N}_]+/gu);
    if (!matches || matches.length === 0) {
        return null;
    }

    const seen   = new Set();
    const tokens = [];

    for (const token of matches) {
        const lower = token.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            tokens.push(`"${token.replace(/"/g, '""')}"`);
            if (tokens.length >= 32) {
                break;
            }
        }
    }

    return tokens.length > 0 ? tokens.join(' OR ') : null;
}

/**
 * @summary Normalizes epoch milliseconds and ISO 8601 strings from a WAL record timestamp.
 * @param {Number|String|undefined} rawTimestamp Timestamp input.
 * @returns {{epochMs: Number, isoTimestamp: String}}
 */
function normalizeTimestamp(rawTimestamp) {
    if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
        const epochMs = Math.trunc(rawTimestamp);
        return {epochMs, isoTimestamp: new Date(epochMs).toISOString()};
    }

    if (typeof rawTimestamp === 'string' && rawTimestamp.trim().length > 0) {
        const numeric = Number(rawTimestamp);
        if (Number.isFinite(numeric)) {
            const epochMs = Math.trunc(numeric);
            return {epochMs, isoTimestamp: new Date(epochMs).toISOString()};
        }
        const parsed = Date.parse(rawTimestamp);
        if (Number.isFinite(parsed)) {
            return {epochMs: parsed, isoTimestamp: new Date(parsed).toISOString()};
        }
    }

    const fallback = Date.now();
    return {epochMs: fallback, isoTimestamp: new Date(fallback).toISOString()};
}

/**
 * @summary Derived `node:sqlite` WAL/FTS5 index over canonical Memory Core JSONL WAL segments.
 */
export class StandaloneSqliteIndex {
    #countMemoriesStmt = null;
    #countSessionStmt  = null;
    #deleteFtsStmt     = null;
    #getMetaStmt       = null;
    #insertFtsStmt     = null;
    #listMetaStmt      = null;
    #queryFtsStmt      = null;
    #recentCursorStmt  = null;
    #recentHeadStmt    = null;
    #sessionPageStmt   = null;
    #setMetaStmt       = null;
    #upsertMemoryStmt  = null;

    /**
     * @summary Opens or initializes the derived SQLite WAL/FTS5 index and replays pending WAL bytes.
     * @param {Object} options
     * @param {String} options.indexPath Absolute path to `index.sqlite`.
     * @param {String} options.walDir Absolute path to the WAL segment directory.
     */
    constructor({indexPath, walDir}) {
        if (typeof indexPath !== 'string' || indexPath.trim().length === 0) {
            throw new Error('StandaloneSqliteIndex requires a non-empty indexPath.');
        }
        if (typeof walDir !== 'string' || walDir.trim().length === 0) {
            throw new Error('StandaloneSqliteIndex requires a non-empty walDir.');
        }

        this.indexPath = path.resolve(indexPath);
        this.walDir    = path.resolve(walDir);

        fs.mkdirSync(path.dirname(this.indexPath), {recursive: true});

        this.db = new DatabaseSync(this.indexPath);
        this.#initializeSchema();
        this.#prepareStatements();
        this.syncFromWalWatermark();
    }

    /**
     * @summary Creates SQLite WAL pragmas, core tables, indexes, and the `memories_fts` virtual table.
     */
    #initializeSchema() {
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                iso_timestamp TEXT NOT NULL,
                workspace TEXT NOT NULL,
                workspace_source TEXT NOT NULL,
                agent TEXT,
                model TEXT,
                prompt TEXT NOT NULL,
                thought TEXT NOT NULL,
                response TEXT NOT NULL,
                type TEXT NOT NULL,
                tools_used_json TEXT,
                amount_tool_calls INTEGER,
                segment_key TEXT,
                plane_id TEXT,
                metadata_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_memories_workspace_ts
                ON memories (workspace, timestamp DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_memories_session_ts
                ON memories (session_id, timestamp ASC, id ASC);

            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                id UNINDEXED,
                workspace UNINDEXED,
                session_id UNINDEXED,
                prompt,
                thought,
                response,
                tokenize = 'unicode61'
            );

            CREATE TABLE IF NOT EXISTS index_meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    }

    /**
     * @summary Prepares parameterized SQL statements using `?` bindings and single-quoted SQL literals.
     */
    #prepareStatements() {
        this.#upsertMemoryStmt = this.db.prepare(`
            INSERT INTO memories (
                id, session_id, timestamp, iso_timestamp, workspace, workspace_source,
                agent, model, prompt, thought, response, type,
                tools_used_json, amount_tool_calls, segment_key, plane_id, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                session_id        = excluded.session_id,
                timestamp         = excluded.timestamp,
                iso_timestamp     = excluded.iso_timestamp,
                workspace         = excluded.workspace,
                workspace_source  = excluded.workspace_source,
                agent             = excluded.agent,
                model             = excluded.model,
                prompt            = excluded.prompt,
                thought           = excluded.thought,
                response          = excluded.response,
                type              = excluded.type,
                tools_used_json   = excluded.tools_used_json,
                amount_tool_calls = excluded.amount_tool_calls,
                segment_key       = COALESCE(excluded.segment_key, memories.segment_key),
                plane_id          = COALESCE(excluded.plane_id, memories.plane_id),
                metadata_json     = excluded.metadata_json
        `);

        this.#deleteFtsStmt = this.db.prepare('DELETE FROM memories_fts WHERE id = ?');
        this.#insertFtsStmt = this.db.prepare(`
            INSERT INTO memories_fts (id, workspace, session_id, prompt, thought, response)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        this.#countMemoriesStmt = this.db.prepare('SELECT COUNT(*) AS cnt FROM memories');
        this.#getMetaStmt       = this.db.prepare('SELECT value FROM index_meta WHERE key = ?');
        this.#listMetaStmt      = this.db.prepare('SELECT key, value FROM index_meta');
        this.#setMetaStmt       = this.db.prepare(`
            INSERT INTO index_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);

        this.#recentHeadStmt = this.db.prepare(`
            SELECT * FROM memories
            WHERE (? = '*' OR workspace = ?)
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
        `);

        this.#recentCursorStmt = this.db.prepare(`
            SELECT * FROM memories
            WHERE (? = '*' OR workspace = ?)
              AND (timestamp < ? OR (timestamp = ? AND id < ?))
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
        `);

        this.#queryFtsStmt = this.db.prepare(`
            SELECT
                m.*,
                bm25(memories_fts) AS bm25_score
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.id
            WHERE memories_fts MATCH ?
              AND (? = '*' OR m.workspace = ?)
              AND (? IS NULL OR m.session_id = ?)
            ORDER BY bm25_score ASC, m.timestamp DESC, m.id DESC
            LIMIT ?
        `);

        this.#countSessionStmt = this.db.prepare(`
            SELECT COUNT(*) AS cnt FROM memories
            WHERE session_id = ?
              AND (? = '*' OR workspace = ?)
        `);

        this.#sessionPageStmt = this.db.prepare(`
            SELECT * FROM memories
            WHERE session_id = ?
              AND (? = '*' OR workspace = ?)
            ORDER BY timestamp ASC, id ASC
            LIMIT ? OFFSET ?
        `);
    }

    /**
     * @summary Normalizes a WAL JSON record into column values for `memories` and `memories_fts`.
     * @param {Object} record Raw WAL record.
     * @param {String|null} [fallbackSegmentKey=null] Optional segment key (`YYYY-MM-DD`).
     * @returns {Object|null} Normalized row object or null if `record.id` is missing.
     */
    #normalizeWalRecord(record, fallbackSegmentKey = null) {
        if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !record.id.trim()) {
            return null;
        }

        const metadata                = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
        const {epochMs, isoTimestamp} = normalizeTimestamp(record.timestamp ?? metadata.timestamp);
        const sessionId               = String(metadata.sessionId || record.sessionId || 'standalone-session');
        const workspace               = String(record.workspace || metadata.workspace || 'default');
        const workspaceSource         = String(record.workspaceSource || metadata.workspaceSource || 'wal');
        const prompt                  = String(metadata.prompt ?? record.prompt ?? '');
        const thought                 = String(metadata.thought ?? metadata.decisionContext ?? record.thought ?? '');
        const response                = String(metadata.response ?? record.response ?? '');
        const type                    = String(metadata.type || record.type || 'agent-interaction');
        const agent                   = metadata.agent ?? record.agent ?? null;
        const model                   = metadata.model ?? record.model ?? null;
        const rawTools                = metadata.toolsUsed ?? record.toolsUsed;
        const parsedTools             = parseToolsUsed(rawTools);
        const toolsUsedJson           = parsedTools ? JSON.stringify(parsedTools) : null;
        const rawAmount               = metadata.amountToolCalls ?? record.amountToolCalls;
        const amountToolCalls         = Number.isInteger(rawAmount) ? rawAmount : null;
        const segmentKey              = record.segmentKey ?? fallbackSegmentKey ?? isoTimestamp.slice(0, 10);
        const planeId                 = record.planeId ?? null;

        return {
            id             : record.id.trim(),
            sessionId,
            timestamp      : epochMs,
            isoTimestamp,
            workspace,
            workspaceSource,
            agent          : agent != null ? String(agent) : null,
            model          : model != null ? String(model) : null,
            prompt,
            thought,
            response,
            type,
            toolsUsedJson,
            amountToolCalls,
            segmentKey     : segmentKey ? String(segmentKey) : null,
            planeId        : planeId ? String(planeId) : null,
            metadataJson   : JSON.stringify(metadata)
        };
    }

    /**
     * @summary Writes a single normalized row into both `memories` and `memories_fts` within the active transaction.
     * @param {Object} row Normalized row object.
     */
    #writeNormalizedRow(row) {
        this.#upsertMemoryStmt.run(
            row.id,
            row.sessionId,
            row.timestamp,
            row.isoTimestamp,
            row.workspace,
            row.workspaceSource,
            row.agent,
            row.model,
            row.prompt,
            row.thought,
            row.response,
            row.type,
            row.toolsUsedJson,
            row.amountToolCalls,
            row.segmentKey,
            row.planeId,
            row.metadataJson
        );
        this.#deleteFtsStmt.run(row.id);
        this.#insertFtsStmt.run(
            row.id,
            row.workspace,
            row.sessionId,
            row.prompt,
            row.thought,
            row.response
        );
    }

    /**
     * @summary Enumerates canonical `wal-YYYY-MM-DD.jsonl` filenames in ascending order, ignoring marker/lock files.
     * @returns {String[]}
     */
    #listWalSegmentFiles() {
        if (!fs.existsSync(this.walDir)) {
            return [];
        }

        return fs.readdirSync(this.walDir)
            .filter(name => WAL_SEGMENT_FILE_RE.test(name))
            .sort();
    }

    /**
     * @summary Incrementally catches up new WAL bytes across segments or rebuilds from byte 0 when empty.
     * @returns {{replayedRecords: Number, segmentsChecked: Number}}
     */
    syncFromWalWatermark() {
        if (!this.db) {
            return {replayedRecords: 0, segmentsChecked: 0};
        }

        const segmentFiles = this.#listWalSegmentFiles();
        if (segmentFiles.length === 0) {
            return {replayedRecords: 0, segmentsChecked: 0};
        }

        // Read outside BEGIN IMMEDIATE: a concurrent writer regressing this map only triggers safe idempotent re-upserts.
        const memoryCount   = Number(this.#countMemoriesStmt.get()?.cnt || 0);
        const storedMapRaw  = this.#getMetaStmt.get('walFileSizesJson')?.value ?? null;
        const prevSizesMap  = memoryCount === 0 ? {} : safeParseJson(storedMapRaw, {});
        const nextSizesMap  = {};
        const rowsToUpsert  = [];
        let   metaChanged   = memoryCount === 0 || storedMapRaw === null;

        for (const fileName of segmentFiles) {
            const match      = fileName.match(WAL_SEGMENT_FILE_RE);
            const segmentKey = match ? match[1] : null;
            const filePath   = path.join(this.walDir, fileName);
            let   stat;

            try {
                stat = fs.statSync(filePath);
            } catch {
                continue;
            }

            const recordedOffset = prevSizesMap[fileName];
            const startOffset    = (
                Number.isInteger(recordedOffset) &&
                recordedOffset >= 0 &&
                recordedOffset <= stat.size
            ) ? recordedOffset : 0;

            if (startOffset !== recordedOffset) {
                metaChanged = true;
            }

            if (stat.size <= startOffset) {
                nextSizesMap[fileName] = startOffset;
                continue;
            }

            const byteLength = stat.size - startOffset;
            const buffer     = Buffer.allocUnsafe(byteLength);
            const fd         = fs.openSync(filePath, 'r');
            let   bytesRead  = 0;

            try {
                bytesRead = fs.readSync(fd, buffer, 0, byteLength, startOffset);
            } finally {
                fs.closeSync(fd);
            }

            const slice          = buffer.subarray(0, bytesRead);
            const lastNewlineIdx = slice.lastIndexOf(0x0a);

            if (lastNewlineIdx === -1) {
                nextSizesMap[fileName] = startOffset;
                continue;
            }

            const consumedBytes = lastNewlineIdx + 1;
            const textChunk     = slice.subarray(0, consumedBytes).toString('utf8');
            const lines         = textChunk.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                const parsed = safeParseJson(trimmed, null);
                const row    = this.#normalizeWalRecord(parsed, segmentKey);
                if (row) {
                    rowsToUpsert.push(row);
                }
            }

            nextSizesMap[fileName] = startOffset + consumedBytes;
            metaChanged            = true;
        }

        if (rowsToUpsert.length === 0 && !metaChanged) {
            return {replayedRecords: 0, segmentsChecked: segmentFiles.length};
        }

        const latestFileName     = segmentFiles[segmentFiles.length - 1];
        const latestMatch        = latestFileName.match(WAL_SEGMENT_FILE_RE);
        const latestSegmentKey   = latestMatch ? latestMatch[1] : '';
        const latestSegmentBytes = String(nextSizesMap[latestFileName] ?? 0);

        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of rowsToUpsert) {
                this.#writeNormalizedRow(row);
            }
            this.#setMetaStmt.run('walFileSizesJson', JSON.stringify(nextSizesMap));
            this.#setMetaStmt.run('latestSegmentKey', latestSegmentKey);
            this.#setMetaStmt.run('latestSegmentBytes', latestSegmentBytes);
            this.db.exec('COMMIT');
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {}
            throw error;
        }

        return {
            replayedRecords: rowsToUpsert.length,
            segmentsChecked: segmentFiles.length
        };
    }

    /**
     * @summary Indexes a single WAL record immediately and advances byte watermarks.
     * @param {Object} record Canonical WAL record.
     * @returns {Boolean} True when indexed.
     */
    upsertMemory(record) {
        const row = this.#normalizeWalRecord(record);
        if (!row) {
            return false;
        }

        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.#writeNormalizedRow(row);
            this.db.exec('COMMIT');
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch {}
            throw error;
        }

        this.syncFromWalWatermark();
        return true;
    }

    /**
     * @summary Queries recent turns in reverse-chronological order with deterministic summary fallback.
     * @param {Object} [options={}]
     * @param {String} [options.workspace='*'] Workspace key or `'*'` for cross-workspace recall.
     * @param {Number} [options.limit=20] Maximum turns (`1..100`).
     * @param {('summary'|'full')} [options.detail='summary'] Output detail level.
     * @param {{timestamp: (String|Number), id?: String}} [options.before] Pagination cursor.
     * @param {('public'|'private')} [options.projection='private'] Field projection policy.
     * @returns {Object}
     */
    queryRecentTurns({
        workspace  = '*',
        limit      = 20,
        detail     = 'summary',
        before,
        projection = 'private'
    } = {}) {
        this.syncFromWalWatermark();

        const effectiveWorkspace = typeof workspace === 'string' && workspace.trim() ? workspace.trim() : '*';
        const clampedLimit       = Math.min(100, Math.max(1, Math.trunc(Number(limit) || 20)));
        const fetchLimit         = clampedLimit + 1;
        let   rows;

        if (before && before.timestamp !== undefined && before.timestamp !== null) {
            const {epochMs} = normalizeTimestamp(before.timestamp);
            const cursorId  = typeof before.id === 'string' && before.id.length > 0 ? before.id : '\uffff';
            rows = this.#recentCursorStmt.all(
                effectiveWorkspace,
                effectiveWorkspace,
                epochMs,
                epochMs,
                cursorId,
                fetchLimit
            );
        } else {
            rows = this.#recentHeadStmt.all(effectiveWorkspace, effectiveWorkspace, fetchLimit);
        }

        const hasMore   = rows.length > clampedLimit;
        const pageRows  = hasMore ? rows.slice(0, clampedLimit) : rows;
        const turns     = pageRows.map(row => {
            const excerpt = buildDeterministicSummary({prompt: row.prompt, response: row.response});
            const base    = {
                id             : row.id,
                sessionId      : row.session_id,
                timestamp      : row.iso_timestamp,
                workspace      : row.workspace,
                workspaceSource: row.workspace_source,
                type           : row.type,
                summary        : excerpt,
                miniSummary    : excerpt,
                summaryFallback: true
            };

            if (detail === 'full') {
                const toolsUsed = parseToolsUsed(row.tools_used_json);
                return {
                    ...base,
                    prompt         : row.prompt,
                    ...(projection !== 'public' ? {decisionContext: row.thought, thought: row.thought} : {}),
                    response       : row.response,
                    agent          : row.agent,
                    model          : row.model,
                    ...(toolsUsed ? {toolsUsed} : {}),
                    ...(row.amount_tool_calls != null ? {amountToolCalls: row.amount_tool_calls} : {})
                };
            }

            return base;
        });

        const lastTurn   = turns.length > 0 ? turns[turns.length - 1] : null;
        const nextCursor = hasMore && lastTurn
            ? {timestamp: lastTurn.timestamp, id: lastTurn.id}
            : null;

        return {
            count          : turns.length,
            workspace      : effectiveWorkspace,
            retrievalMode  : 'wal-sqlite',
            summaryFallback: true,
            turns,
            nextCursor
        };
    }

    /**
     * @summary Executes lexical FTS5 BM25 search over `memories_fts`, omitting vector `distance` and `compositeScore`.
     * @param {Object} [options={}]
     * @param {String} options.query Natural-language query string.
     * @param {String} [options.workspace='*'] Workspace filter or `'*'` for all workspaces.
     * @param {Number} [options.nResults=10] Maximum results (`1..100`).
     * @param {String} [options.sessionId] Optional session filter.
     * @param {('summary'|'full')} [options.detail='full'] Output detail level.
     * @param {('public'|'private')} [options.projection='private'] Field projection policy.
     * @returns {Object}
     */
    queryRawMemories({
        query,
        workspace  = '*',
        nResults   = 10,
        sessionId,
        detail     = 'full',
        projection = 'private'
    } = {}) {
        this.syncFromWalWatermark();

        const effectiveWorkspace = typeof workspace === 'string' && workspace.trim() ? workspace.trim() : '*';
        const clampedResults     = Math.min(100, Math.max(1, Math.trunc(Number(nResults) || 10)));
        const matchExpr          = buildSafeFts5MatchExpression(query);

        if (!matchExpr) {
            return {
                query        : String(query ?? ''),
                retrievalMode: 'lexical-fts5',
                workspace    : effectiveWorkspace,
                count        : 0,
                results      : []
            };
        }

        const sessionFilter = typeof sessionId === 'string' && sessionId.trim().length > 0
            ? sessionId.trim()
            : null;

        const rows = this.#queryFtsStmt.all(
            matchExpr,
            effectiveWorkspace,
            effectiveWorkspace,
            sessionFilter,
            sessionFilter,
            clampedResults
        );

        const results = rows.map(row => {
            const rawBm25          = Number(row.bm25_score);
            const bm25Score        = Object.is(rawBm25, -0) ? 0 : rawBm25;
            const absBm25          = Math.abs(bm25Score);
            const lexicalRankScore = bm25Score < 0
                ? Number((absBm25 / (1 + absBm25)).toFixed(6))
                : 0;
            const excerpt          = buildDeterministicSummary({prompt: row.prompt, response: row.response});

            const item = {
                id             : row.id,
                sessionId      : row.session_id,
                timestamp      : row.iso_timestamp,
                workspace      : row.workspace,
                workspaceSource: row.workspace_source,
                type           : row.type,
                agent          : row.agent,
                model          : row.model,
                bm25Score,
                lexicalRankScore,
                miniSummary    : excerpt,
                summaryFallback: true
            };

            if (detail !== 'summary') {
                item.prompt   = row.prompt;
                item.response = row.response;
                item.metadata = safeParseJson(row.metadata_json, {});
                if (projection !== 'public') {
                    item.decisionContext = row.thought;
                    item.thought         = row.thought;
                }
            }

            return item;
        });

        return {
            query        : String(query ?? ''),
            retrievalMode: 'lexical-fts5',
            workspace    : effectiveWorkspace,
            count        : results.length,
            results
        };
    }

    /**
     * @summary Lists memories for a specific `sessionId` in ascending chronological order.
     * @param {Object} [options={}]
     * @param {String} options.sessionId Target session identifier.
     * @param {String} [options.workspace='*'] Workspace filter or `'*'` for all workspaces.
     * @param {Number} [options.limit=100] Page size (`1..1000`).
     * @param {Number} [options.offset=0] Zero-based row offset.
     * @returns {Object}
     */
    getSessionMemories({
        sessionId,
        workspace = '*',
        limit     = 100,
        offset    = 0
    } = {}) {
        this.syncFromWalWatermark();

        const targetSession      = String(sessionId ?? '').trim();
        const effectiveWorkspace = typeof workspace === 'string' && workspace.trim() ? workspace.trim() : '*';
        const clampedLimit       = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 100)));
        const safeOffset         = Math.max(0, Math.trunc(Number(offset) || 0));

        if (!targetSession) {
            return {
                sessionId: '',
                workspace: effectiveWorkspace,
                count    : 0,
                total    : 0,
                limit    : clampedLimit,
                offset   : safeOffset,
                memories : []
            };
        }

        const total = Number(
            this.#countSessionStmt.get(targetSession, effectiveWorkspace, effectiveWorkspace)?.cnt || 0
        );
        const rows  = this.#sessionPageStmt.all(
            targetSession,
            effectiveWorkspace,
            effectiveWorkspace,
            clampedLimit,
            safeOffset
        );

        const memories = rows.map(row => {
            const excerpt = buildDeterministicSummary({prompt: row.prompt, response: row.response});
            return {
                id             : row.id,
                sessionId      : row.session_id,
                timestamp      : row.iso_timestamp,
                workspace      : row.workspace,
                workspaceSource: row.workspace_source,
                type           : row.type,
                agent          : row.agent,
                model          : row.model,
                prompt         : row.prompt,
                decisionContext: row.thought,
                thought        : row.thought,
                response       : row.response,
                miniSummary    : excerpt,
                summaryFallback: true,
                metadata       : safeParseJson(row.metadata_json, {})
            };
        });

        return {
            sessionId: targetSession,
            workspace: effectiveWorkspace,
            count    : memories.length,
            total,
            limit    : clampedLimit,
            offset   : safeOffset,
            memories
        };
    }

    /**
     * @summary Computes WAL segment bytes, SQLite index file bytes, and indexed memory count.
     * @returns {{walBytes: Number, indexBytes: Number, memoryCount: Number}}
     */
    getStorageStats() {
        this.syncFromWalWatermark();

        let walBytes = 0;
        for (const fileName of this.#listWalSegmentFiles()) {
            try {
                walBytes += fs.statSync(path.join(this.walDir, fileName)).size;
            } catch {}
        }

        let indexBytes = 0;
        for (const candidate of [this.indexPath, `${this.indexPath}-wal`, `${this.indexPath}-shm`]) {
            try {
                indexBytes += fs.statSync(candidate).size;
            } catch {}
        }

        const memoryCount = Number(this.#countMemoriesStmt.get()?.cnt || 0);

        return {walBytes, indexBytes, memoryCount};
    }

    /**
     * @summary Reads persisted `index_meta` key-value pairs for watermark inspection.
     * @returns {Object<String,String>}
     */
    getIndexMeta() {
        const rows = this.#listMetaStmt.all();
        const meta = {};
        for (const row of rows) {
            meta[row.key] = row.value;
        }
        return meta;
    }

    /**
     * @summary Closes the underlying `node:sqlite` `DatabaseSync` handle idempotently.
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

export default StandaloneSqliteIndex;
