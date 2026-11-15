import fsSync                                                           from 'node:fs';
import fs                                                               from 'node:fs/promises';
import os                                                               from 'node:os';
import path                                                             from 'node:path';
import {DatabaseSync}                                                   from 'node:sqlite';
import {IDENTITIES}                                                     from '../../../graph/identityRoots.mjs';
import {BROADCAST_SENTINEL, SYSTEM_SENDER}                              from '../../../graph/mailboxRoots.mjs';
import {normalizeAgentIdentityNodeId}                                   from '../../../graph/normalizeAgentIdentityNodeId.mjs';
import {DEFAULT_STANDALONE_PLANE_ID, standalonePlacement}               from '../../../mcp/server/memory-core/standalone.mjs';
import {isOpaquePlaneId}                                                from '../../../planeConfig.mjs';
import {deleteReconciledWalSegmentCacheEntries, getWalRecordsFileName}  from './memoryWalStore.mjs';
import {normalizeRawMemoryUserId}                                       from './rawMemoryGraphIdentity.mjs';
import {resolveStandaloneWorkspaceKey}                                  from './standaloneWorkspaceKey.mjs';
import {withAppendLock}                                                 from './walAppendLock.mjs';

/**
 * @module ai/services/memory-core/helpers/promoteStandaloneWal
 * @summary Promotes standalone Memory Core JSONL WAL segments into a full Agent OS plane WAL with fail-closed rostered-owner and RLS tenant stamping.
 */

const WAL_SEGMENT_RE = /^wal-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * @summary Resolves a path through its nearest existing realpath ancestor so symlinked directories compare identically.
 * @param {String} targetPath Candidate filesystem path.
 * @returns {String} Canonical comparable absolute path.
 */
function resolveComparablePath(targetPath) {
    let   current = path.resolve(targetPath);
    const tail    = [];

    for (;;) {
        try {
            return path.join(fsSync.realpathSync(current), ...tail);
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
                return path.resolve(targetPath);
            }
            const parent = path.dirname(current);
            if (parent === current) {
                return path.resolve(targetPath);
            }
            tail.unshift(path.basename(current));
            current = parent;
        }
    }
}

/**
 * @summary Checks whether a normalized identity handle is a direct, non-sentinel AgentIdentity candidate.
 * @param {*} candidate Normalized identity string.
 * @returns {Boolean}
 */
function isDirectNonSentinelIdentity(candidate) {
    return (
        typeof candidate === 'string' &&
        candidate.length > 1 &&
        candidate !== '@' &&
        candidate !== SYSTEM_SENDER.id &&
        candidate !== BROADCAST_SENTINEL.id &&
        !candidate.includes(':')
    );
}

/**
 * @summary Queries rostered `AgentIdentity` node IDs from a target SQLite graph database via `node:sqlite`.
 * @param {String} resolvedGraphDbPath Absolute SQLite graph file path.
 * @returns {Set<String>} Canonical rostered `@<identity>` node IDs.
 */
function readRosteredIdentitiesFromGraphDb(resolvedGraphDbPath) {
    let stat;
    try {
        stat = fsSync.statSync(resolvedGraphDbPath);
        fsSync.accessSync(resolvedGraphDbPath, fsSync.constants.R_OK);
    } catch (error) {
        throw new Error(
            `promoteStandaloneWal: --target-graph-db "${resolvedGraphDbPath}" does not exist or is not readable (${error?.message || String(error)}).`
        );
    }

    if (!stat.isFile()) {
        throw new Error(
            `promoteStandaloneWal: --target-graph-db "${resolvedGraphDbPath}" must reference a regular SQLite file.`
        );
    }

    let db = null;
    try {
        db = new DatabaseSync(resolvedGraphDbPath, {open: true, readOnly: true});
        // `SQLite.mjs` persists node types under `json_extract(data, '$.label')` (`idx_nodes_label`).
        const rows     = db.prepare("SELECT id FROM Nodes WHERE json_extract(data, '$.label') = 'AgentIdentity'").all();
        const rostered = new Set();

        for (const row of rows) {
            if (typeof row?.id !== 'string') continue;
            const normalized = normalizeAgentIdentityNodeId(row.id);
            if (isDirectNonSentinelIdentity(normalized)) {
                rostered.add(normalized);
            }
        }

        return rostered;
    } catch (error) {
        throw new Error(
            `promoteStandaloneWal: failed to read AgentIdentity roster from --target-graph-db "${resolvedGraphDbPath}": ${error?.message || String(error)}`
        );
    } finally {
        try {
            db?.close();
        } catch {}
    }
}

/**
 * @summary Validates `--owner` fail-closed against `--target-graph-db` (when supplied) or `IDENTITIES` in `identityRoots.mjs`.
 * @param {Object} options
 * @param {*} options.owner Raw `--owner` input.
 * @param {String} [options.targetGraphDb] Optional SQLite graph DB path.
 * @returns {String} Canonical `@<identity>` node ID.
 */
export function resolveRosteredPromotionOwner({owner, targetGraphDb} = {}) {
    if (typeof owner !== 'string' || owner.trim().length === 0) {
        throw new Error(
            'promoteStandaloneWal: --owner is required and must name a rostered AgentIdentity (for example "@neo-gemini-julia").'
        );
    }

    const canonicalOwner = normalizeAgentIdentityNodeId(owner);

    if (!isDirectNonSentinelIdentity(canonicalOwner)) {
        throw new Error(
            `promoteStandaloneWal: invalid or sentinel --owner "${owner}" (normalized: "${String(canonicalOwner)}"). ` +
            'Only direct rostered AgentIdentity handles are permitted.'
        );
    }

    if (targetGraphDb !== undefined && targetGraphDb !== null) {
        if (typeof targetGraphDb !== 'string' || targetGraphDb.trim().length === 0) {
            throw new Error('promoteStandaloneWal: --target-graph-db must be a non-empty path when provided.');
        }

        const resolvedGraphDbPath = path.resolve(targetGraphDb.trim());
        const rosteredIds         = readRosteredIdentitiesFromGraphDb(resolvedGraphDbPath);

        if (!rosteredIds.has(canonicalOwner)) {
            throw new Error(
                `promoteStandaloneWal: --owner "${canonicalOwner}" is not a rostered AgentIdentity in target graph "${resolvedGraphDbPath}".`
            );
        }

        return canonicalOwner;
    }

    const rosteredIds = new Set(
        IDENTITIES
            .filter(entry =>
                entry?.type === 'AgentIdentity' &&
                typeof entry.id === 'string' &&
                entry.id !== SYSTEM_SENDER.id &&
                entry.id !== BROADCAST_SENTINEL.id
            )
            .map(entry => normalizeAgentIdentityNodeId(entry.id))
            .filter(isDirectNonSentinelIdentity)
    );

    if (!rosteredIds.has(canonicalOwner)) {
        throw new Error(
            `promoteStandaloneWal: --owner "${canonicalOwner}" is not a rostered AgentIdentity in identityRoots.mjs ` +
            '(pass --target-graph-db to validate against a custom plane graph).'
        );
    }

    return canonicalOwner;
}

/**
 * @summary Resolves the canonical normalized RLS `userId` (without leading `@`), failing closed on empty overrides.
 * @param {String} canonicalOwner Verified `@<identity>` owner handle.
 * @param {String} [explicitUserId] Optional `--user-id` override.
 * @returns {String} Non-empty normalized RLS `userId`.
 */
function resolvePromotionUserId(canonicalOwner, explicitUserId) {
    if (explicitUserId === undefined || explicitUserId === null) {
        const derived = normalizeRawMemoryUserId(canonicalOwner);
        if (!derived || derived.trim().length === 0) {
            throw new Error('promoteStandaloneWal: unable to derive non-empty userId from --owner.');
        }
        return derived;
    }

    if (typeof explicitUserId !== 'string') {
        throw new Error('promoteStandaloneWal: --user-id must be a non-empty string when provided.');
    }

    const collapsed  = explicitUserId.trim().replace(/^@+/, match => match ? '@' : '');
    const normalized = normalizeRawMemoryUserId(collapsed)?.trim() || '';

    if (normalized.length === 0) {
        throw new Error('promoteStandaloneWal: --user-id must resolve to a non-empty tenant identifier.');
    }

    return normalized;
}

/**
 * @summary Derives an ISO-8601 timestamp for `graphProjection.memoryProperties.timestamp` from a WAL record.
 * @param {Object} record Source WAL record.
 * @param {Object} metadata Record metadata object.
 * @param {Object} memoryProperties Existing `graphProjection.memoryProperties` object.
 * @returns {String} ISO-8601 timestamp string.
 */
function resolveIsoTimestamp(record, metadata, memoryProperties) {
    if (typeof memoryProperties.timestamp === 'string' && memoryProperties.timestamp.trim().length > 0) {
        return memoryProperties.timestamp;
    }

    const raw     = metadata.timestamp ?? record.timestamp;
    const numeric = Number(raw);

    if (Number.isFinite(numeric)) {
        return new Date(numeric).toISOString();
    }

    if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) {
            return new Date(parsed).toISOString();
        }
    }

    return new Date().toISOString();
}

/**
 * @summary Stamps verified owner identity, RLS `userId`, and v1 graph-projection metadata onto one promoted WAL record while preserving standalone provenance.
 * @param {Object} record Source standalone WAL record.
 * @param {Object} options
 * @param {String} options.canonicalOwner Verified `@<identity>` owner handle.
 * @param {String} options.resolvedUserId Normalized RLS `userId`.
 * @param {String} options.segmentKey UTC-day `YYYY-MM-DD` segment key.
 * @returns {Object} Stamped WAL record ready for append into the target plane segment.
 */
export function stampPromotedWalRecord(record, {canonicalOwner, resolvedUserId, segmentKey}) {
    const existingMeta            = (record.metadata && typeof record.metadata === 'object') ? record.metadata : {};
    const existingGraphProjection = (record.graphProjection && typeof record.graphProjection === 'object')
        ? record.graphProjection
        : {};
    const existingMemoryProps     = (existingGraphProjection.memoryProperties && typeof existingGraphProjection.memoryProperties === 'object')
        ? existingGraphProjection.memoryProperties
        : {};

    const resolvedPlaneId   = isOpaquePlaneId(record.planeId) ? record.planeId : DEFAULT_STANDALONE_PLANE_ID;
    const resolvedSessionId = existingMemoryProps.sessionId ?? existingMeta.sessionId ?? record.sessionId;
    const resolvedWorkspace = record.workspace ?? existingMeta.workspace ?? existingMemoryProps.workspace;
    const isoTimestamp      = resolveIsoTimestamp(record, existingMeta, existingMemoryProps);

    return {
        ...record,
        segmentKey            : record.segmentKey || segmentKey,
        planeId               : resolvedPlaneId,
        agentIdentity         : canonicalOwner,
        userId                : resolvedUserId,
        metadata              : {
            ...existingMeta,
            planeId      : isOpaquePlaneId(existingMeta.planeId) ? existingMeta.planeId : resolvedPlaneId,
            agentIdentity: canonicalOwner,
            userId       : resolvedUserId
        },
        graphProjectionVersion: 1,
        graphProjection       : {
            ...existingGraphProjection,
            requestIdentity : canonicalOwner,
            memoryProperties: {
                ...existingMemoryProps,
                ...(resolvedSessionId ? {sessionId: resolvedSessionId} : {}),
                timestamp    : isoTimestamp,
                ...(resolvedWorkspace ? {workspace: resolvedWorkspace} : {}),
                planeId      : isOpaquePlaneId(existingMemoryProps.planeId) ? existingMemoryProps.planeId : resolvedPlaneId,
                agentIdentity: canonicalOwner,
                userId       : resolvedUserId
            }
        }
    };
}

/**
 * @summary Lists `YYYY-MM-DD` segment keys in chronological (ascending) order, ignoring marker and lock files.
 * @param {String} walDir WAL directory path.
 * @returns {Promise<String[]>}
 */
async function listChronologicalSegmentKeys(walDir) {
    let entries;
    try {
        entries = await fs.readdir(walDir);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    return entries
        .map(name => name.match(WAL_SEGMENT_RE)?.[1])
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * @summary Parses valid record objects from a JSONL WAL segment file, skipping corrupt or torn lines.
 * @param {String} filePath Segment JSONL file path.
 * @returns {Promise<{rawText: String, records: Object[]}>}
 */
async function readWalSegmentRecords(filePath) {
    let rawText;
    try {
        rawText = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {rawText: '', records: []};
        }
        throw error;
    }

    const records = [];
    for (const line of rawText.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && parsed.id.length > 0) {
                records.push(parsed);
            }
        } catch {
            // Skip torn or corrupt JSONL lines (sibling discipline to memoryWalStore).
        }
    }

    return {rawText, records};
}

/**
 * @summary Promotes standalone WAL records into a target Agent OS plane WAL directory idempotently under per-segment append locks.
 * @param {Object} [options={}]
 * @param {String} options.targetWalDir Target plane WAL directory (`--target-wal-dir`).
 * @param {String} options.owner Rostered owner identity (`--owner`).
 * @param {String} [options.sourceWalDir] Explicit standalone source WAL directory (`--source-wal-dir`).
 * @param {String} [options.dataRoot] Optional standalone `--data-root` used when `sourceWalDir` is omitted.
 * @param {String} [options.targetGraphDb] Optional target plane SQLite graph path (`--target-graph-db`) for custom team rosters.
 * @param {String} [options.userId] Optional explicit RLS `userId` override (`--user-id`).
 * @param {String} [options.workspace] Optional workspace slug or directory filter (`--workspace`).
 * @param {String} [options.cwd=process.cwd()] Working directory used when resolving path-shaped `--workspace` filters.
 * @param {String} [options.homedir=os.homedir()] Home directory used for default standalone placement and `~` expansion.
 * @param {Function} [options.execGit] Injectable git runner forwarded to {@link resolveStandaloneWorkspaceKey}.
 * @param {Object} [options.lockOptions] Injectable lock options forwarded to {@link withAppendLock}.
 * @returns {Promise<{owner: String, promotedCount: Number, segmentsTouched: String[], skippedDuplicateCount: Number, userId: String, workspace?: String}>}
 */
export async function promoteStandaloneWal({
    targetWalDir,
    owner,
    sourceWalDir,
    dataRoot,
    targetGraphDb,
    userId,
    workspace,
    cwd     = process.cwd(),
    homedir = os.homedir(),
    execGit,
    lockOptions
} = {}) {
    if (typeof targetWalDir !== 'string' || targetWalDir.trim().length === 0) {
        throw new Error('promoteStandaloneWal: --target-wal-dir is required.');
    }

    if (sourceWalDir !== undefined && sourceWalDir !== null) {
        if (typeof sourceWalDir !== 'string' || sourceWalDir.trim().length === 0) {
            throw new Error('promoteStandaloneWal: --source-wal-dir must be a non-empty path when provided.');
        }
    }

    const canonicalOwner       = resolveRosteredPromotionOwner({owner, targetGraphDb});
    const resolvedUserId       = resolvePromotionUserId(canonicalOwner, userId);
    const defaultSourceWalDir  = standalonePlacement({homedir, dataRoot}).NEO_MEMORY_WAL_DIR;
    const resolvedSourceWalDir = path.resolve(sourceWalDir ? sourceWalDir.trim() : defaultSourceWalDir);
    const resolvedTargetWalDir = path.resolve(targetWalDir.trim());

    if (resolveComparablePath(resolvedSourceWalDir) === resolveComparablePath(resolvedTargetWalDir)) {
        throw new Error(
            `promoteStandaloneWal: sourceWalDir and targetWalDir must not resolve to the same directory ("${resolvedTargetWalDir}").`
        );
    }

    let resolvedWorkspace = null;
    if (workspace !== undefined && workspace !== null) {
        if (typeof workspace !== 'string' || workspace.trim().length === 0) {
            throw new Error('promoteStandaloneWal: --workspace must be a non-empty string when provided.');
        }
        resolvedWorkspace = resolveStandaloneWorkspaceKey({
            explicitWorkspace: workspace,
            cwd,
            homedir,
            ...(execGit ? {execGit} : {})
        }).workspace;
    }

    const segmentKeys         = await listChronologicalSegmentKeys(resolvedSourceWalDir);
    const segmentsTouched     = [];
    let   promotedCount         = 0;
    let   skippedDuplicateCount = 0;

    for (const segmentKey of segmentKeys) {
        const sourceSegmentPath = path.join(resolvedSourceWalDir, getWalRecordsFileName(segmentKey));
        const {records}         = await readWalSegmentRecords(sourceSegmentPath);

        const matchingRecords = resolvedWorkspace
            ? records.filter(record => (record.workspace ?? record.metadata?.workspace) === resolvedWorkspace)
            : records;

        if (matchingRecords.length === 0) {
            continue;
        }

        const targetSegmentPath = path.join(resolvedTargetWalDir, getWalRecordsFileName(segmentKey));
        await fs.mkdir(resolvedTargetWalDir, {recursive: true});

        await withAppendLock(targetSegmentPath, async () => {
            const {rawText: existingRaw, records: existingRecords} = await readWalSegmentRecords(targetSegmentPath);
            const seenIds  = new Set(existingRecords.map(entry => entry.id));
            const toAppend = [];

            for (const sourceRecord of matchingRecords) {
                if (seenIds.has(sourceRecord.id)) {
                    skippedDuplicateCount++;
                    continue;
                }

                seenIds.add(sourceRecord.id);
                toAppend.push(stampPromotedWalRecord(sourceRecord, {
                    canonicalOwner,
                    resolvedUserId,
                    segmentKey
                }));
            }

            if (toAppend.length === 0) {
                return;
            }

            const leadingNewline = existingRaw.length > 0 && !existingRaw.endsWith('\n') ? '\n' : '';
            const payload        = `${leadingNewline}${toAppend.map(item => JSON.stringify(item)).join('\n')}\n`;

            await fs.appendFile(targetSegmentPath, payload, 'utf8');
            deleteReconciledWalSegmentCacheEntries(resolvedTargetWalDir, segmentKey);

            promotedCount += toAppend.length;
            segmentsTouched.push(segmentKey);
        }, lockOptions);
    }

    return {
        promotedCount,
        skippedDuplicateCount,
        segmentsTouched,
        owner : canonicalOwner,
        userId: resolvedUserId,
        ...(resolvedWorkspace ? {workspace: resolvedWorkspace} : {})
    };
}
