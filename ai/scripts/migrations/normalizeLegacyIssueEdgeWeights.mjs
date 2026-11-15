#!/usr/bin/env node
import Database                  from 'better-sqlite3';
import {Command}                 from 'commander';
import {isEntryModule}           from '../../services/shared/isEntryModule.mjs';
import {assertTestWriteIsolated} from '../../services/shared/storeWriteGuard.mjs';
import {
    ANCHORED_ISSUE_EDGE_TYPES,
    PROTECTED_EDGE_TYPES,
    getComputedIssueEmphasisMultiplier,
    isMessageRecordEdge,
    readInternalAuthorLogins
} from '../../graph/issueEdgeWeightSchema.mjs';

/**
 * @module ai/scripts/migrations/normalizeLegacyIssueEdgeWeights
 * @summary Idempotent upgrade migration CLI that normalizes legacy anchor-weighted `ISSUE` edges in
 * the Memory Core SQLite graph store and stamps `SchemaVersion` (`issue_ingestor_legacy_anchor_reset_v1`).
 *
 * Deployments that upgraded an existing persistent `memory-core-graph.sqlite` volume without running
 * the retired inline `IssueIngestor` transition pass can execute this script once to strip historical
 * `bug` / community write-time emphasis multipliers and `0.05` open-blocker discounts from `ISSUE`
 * edges while preserving unboosted decayed scent weights (`0.1..1.0`), retired-goal `ADVANCED_BY`
 * weights (`0.1`), `frontier -> GUIDES` synthesis edges, and non-`ISSUE` edges.
 *
 * Deployments whose store already carries `SchemaVersion.id = 'issue_ingestor_legacy_anchor_reset_v1'`
 * short-circuit immediately with `status: 'already-normalized'` and zero writes unless `--force` is
 * supplied, ensuring post-cutover multi-session `linkNodes` reinforcements above `1.0` are never
 * flattened on repeat runs.
 *
 * Usage:
 *   node ai/scripts/migrations/normalizeLegacyIssueEdgeWeights.mjs [--db <path>] [--apply] [--force] [--json]
 */

export const LEGACY_ANCHOR_RESET_MARKER_ID = 'issue_ingestor_legacy_anchor_reset_v1';
export const MIGRATION_VERSION             = '1.0.0';
export const SAMPLE_LIMIT                  = 20;

const ANCHORED_ISSUE_EDGE_TYPE_SET = new Set(ANCHORED_ISSUE_EDGE_TYPES);
const PROTECTED_EDGE_TYPE_SET      = new Set(PROTECTED_EDGE_TYPES);

/**
 * @summary Checks whether a named SQLite table exists in the target database.
 * @param {Object} sqliteDb Open `better-sqlite3` database handle.
 * @param {String} tableName Table identifier.
 * @returns {Boolean}
 */
function hasTable(sqliteDb, tableName) {
    return Boolean(
        sqliteDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .get(tableName)
    );
}

/**
 * @summary Builds a fresh Commander `Command` instance for CLI parsing and test assertions.
 * @returns {Command}
 */
export function createProgram() {
    const program = new Command();

    program
        .name('normalizeLegacyIssueEdgeWeights')
        .description(
            'Idempotent SQLite graph upgrade migration that resets legacy anchor-weighted ISSUE edges ' +
            'and stamps SchemaVersion (issue_ingestor_legacy_anchor_reset_v1).'
        )
        .version(MIGRATION_VERSION)
        .allowExcessArguments(false)
        .option(
            '--apply',
            'Commit edge-weight updates and the SchemaVersion marker atomically (default: dry-run).',
            false
        )
        .option(
            '--dry-run',
            'Explicit dry-run mode (default behavior; mutates nothing).',
            false
        )
        .option(
            '--db <path>',
            'Explicit SQLite graph database file path override (defaults to AiConfig.storagePaths.graph).'
        )
        .option(
            '--force',
            'Re-evaluate ISSUE edges even when SchemaVersion already carries the reset marker.',
            false
        )
        .option(
            '--json',
            'Emit structured JSON output only without human status notes on stderr.',
            false
        );

    return program;
}

/**
 * @summary Parses CLI `argv` tokens into normalized migration options via Commander `exitOverride()`.
 * @param {String[]} [argv=process.argv.slice(2)] User argument tokens excluding `node` and script path.
 * @returns {{apply: Boolean, db: String|null, force: Boolean, json: Boolean}}
 */
export function parseArgs(argv = process.argv.slice(2)) {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({writeOut: () => {}, writeErr: () => {}});
    program.parse(argv, {from: 'user'});

    const options = program.opts();
    if (options.apply && options.dryRun) {
        throw new Error('Cannot combine --apply and --dry-run.');
    }

    return {
        apply: Boolean(options.apply),
        db   : options.db || null,
        force: Boolean(options.force),
        json : Boolean(options.json)
    };
}

/**
 * @summary Resolves the normalized weight for an issue-adjacent edge under the scent-decay contract,
 * or `null` when the stored weight already satisfies the post-cutover invariants.
 *
 * @param {Object} edge Edge descriptor `{source, target, type, properties}`.
 * @param {Map<String, Object>} issueNodesById Hydrated `ISSUE` node map keyed by graph node id.
 * @param {Set<String>} internalAuthorLogins Plane internal author logins.
 * @returns {Number|null}
 */
export function resolveNormalizedLegacyIssueEdgeWeight(edge, issueNodesById, internalAuthorLogins) {
    const {source, target, type, properties} = edge || {},
          issueEndpoints                     = [source, target].filter(
              id => typeof id === 'string' && id.startsWith('issue-')
          );

    if (issueEndpoints.length === 0) return null;

    const rawWeight = Number(properties?.weight);
    if (!Number.isFinite(rawWeight) || rawWeight <= 0) return null;

    if (source === 'frontier' && type === 'GUIDES') return null;

    if (isMessageRecordEdge({source})) {
        return rawWeight !== 1.0 ? 1.0 : null;
    }

    if (ANCHORED_ISSUE_EDGE_TYPE_SET.has(type)) {
        return (rawWeight < 0.1 || rawWeight > 1.0) ? 1.0 : null;
    }

    if (PROTECTED_EDGE_TYPE_SET.has(type)) {
        return (rawWeight < 0.1 || rawWeight > 1.0) ? 1.0 : null;
    }

    if (rawWeight < 0.1) {
        return 1.0;
    }

    if (rawWeight > 1.0) {
        const multiplier = Math.max(
            1.0,
            ...issueEndpoints.map(id => {
                const rawNode = issueNodesById?.get?.(id),
                      node    = rawNode?.isRecord
                          ? {id: rawNode.get('id'), type: rawNode.get('label'), properties: rawNode.get('properties')}
                          : rawNode;

                return node ? getComputedIssueEmphasisMultiplier(node, internalAuthorLogins) : 1.0;
            })
        );

        return Math.min(1.0, Number((rawWeight / multiplier).toFixed(6)));
    }

    return null;
}

/**
 * @summary Evaluates or atomically applies the legacy `ISSUE` edge-weight normalization against a
 * Memory Core SQLite graph store.
 *
 * @param {Object} [options={}]
 * @param {Object|null} [options.db=null] Open `better-sqlite3` database handle.
 * @param {String|null} [options.dbPath=null] Explicit SQLite file path when `options.db` is omitted.
 * @param {Boolean} [options.apply=false] Commit updates and `SchemaVersion` stamp when `true`.
 * @param {Boolean} [options.force=false] Re-evaluate edges even when `SchemaVersion` already has the marker.
 * @param {Number} [options.sampleLimit=SAMPLE_LIMIT] Maximum sample edge diffs returned in `sample`.
 * @param {Function|null} [options.onWarning=null] Optional warning sink for degraded `AgentIdentity` reads.
 * @returns {{
 *   status: 'already-normalized'|'dry-run'|'applied',
 *   markerId: String,
 *   markerPresent: Boolean,
 *   markerUpdatedAt: String|null,
 *   scannedIssueEdges: Number,
 *   candidateUpdates: Number,
 *   updatedEdges: Number,
 *   byEdgeType: Record<String, Number>,
 *   sample: Array<{id: String, source: String, target: String, type: String, previousWeight: Number|null, nextWeight: Number}>
 * }}
 */
export function normalizeLegacyIssueEdgeWeights({
    db          = null,
    dbPath      = null,
    apply       = false,
    force       = false,
    sampleLimit = SAMPLE_LIMIT,
    onWarning   = null
} = {}) {
    if (!db && !dbPath) {
        throw new Error('normalizeLegacyIssueEdgeWeights requires either an open SQLite db handle or an explicit dbPath.');
    }

    if (apply && dbPath) {
        assertTestWriteIsolated({
            storePath: dbPath,
            subsystem: 'normalizeLegacyIssueEdgeWeights'
        });
    }

    const ownsHandle = !db,
          sqliteDb   = db || new Database(dbPath, dbPath === ':memory:' ? {} : {fileMustExist: true});

    try {
        const markerRow = hasTable(sqliteDb, 'SchemaVersion')
            ? sqliteDb
                .prepare('SELECT id, version, updated_at FROM SchemaVersion WHERE id = ? LIMIT 1')
                .get(LEGACY_ANCHOR_RESET_MARKER_ID)
            : null;
        const markerPresent = Boolean(markerRow);

        if (markerPresent && !force) {
            return {
                status           : 'already-normalized',
                markerId         : LEGACY_ANCHOR_RESET_MARKER_ID,
                markerPresent    : true,
                markerUpdatedAt  : markerRow.updated_at || null,
                scannedIssueEdges: 0,
                candidateUpdates : 0,
                updatedEdges     : 0,
                byEdgeType       : {},
                sample           : []
            };
        }

        const internalAuthorLogins = hasTable(sqliteDb, 'Nodes')
            ? readInternalAuthorLogins(sqliteDb, onWarning)
            : new Set();
        const issueNodesById = new Map();

        if (hasTable(sqliteDb, 'Nodes')) {
            const nodeRows = sqliteDb.prepare("SELECT id, data FROM Nodes WHERE id LIKE 'issue-%'").all();
            for (const row of nodeRows) {
                try {
                    const parsed = JSON.parse(row.data);
                    issueNodesById.set(row.id, {...parsed, id: parsed?.id || row.id});
                } catch {
                    // Ignore malformed node payloads; default 1.0 multiplier applies.
                }
            }
        }

        const edgeRows = hasTable(sqliteDb, 'Edges')
            ? sqliteDb
                .prepare("SELECT id, source, target, type, data FROM Edges WHERE source LIKE 'issue-%' OR target LIKE 'issue-%' ORDER BY id ASC")
                .all()
            : [];
        const byEdgeType = {},
              candidates = [],
              sample     = [];
        let scannedIssueEdges = 0;

        for (const row of edgeRows) {
            scannedIssueEdges++;

            let parsed;
            try {
                parsed = JSON.parse(row.data);
            } catch {
                continue;
            }

            const previousWeight = Number(parsed?.properties?.weight),
                  nextWeight     = resolveNormalizedLegacyIssueEdgeWeight({
                      source    : row.source,
                      target    : row.target,
                      type      : row.type,
                      properties: parsed?.properties
                  }, issueNodesById, internalAuthorLogins);

            if (nextWeight === null) continue;

            byEdgeType[row.type] = (byEdgeType[row.type] || 0) + 1;
            candidates.push({id: row.id, parsed, nextWeight});

            if (sample.length < sampleLimit) {
                sample.push({
                    id            : row.id,
                    source        : row.source,
                    target        : row.target,
                    type          : row.type,
                    previousWeight: Number.isFinite(previousWeight) ? previousWeight : null,
                    nextWeight
                });
            }
        }

        if (!apply) {
            return {
                status          : 'dry-run',
                markerId        : LEGACY_ANCHOR_RESET_MARKER_ID,
                markerPresent,
                markerUpdatedAt : markerRow?.updated_at || null,
                scannedIssueEdges,
                candidateUpdates: candidates.length,
                updatedEdges    : 0,
                byEdgeType,
                sample
            };
        }

        sqliteDb.transaction(() => {
            if (candidates.length > 0) {
                const updateEdgeStmt = sqliteDb.prepare('UPDATE Edges SET data = ? WHERE id = ?');

                for (const candidate of candidates) {
                    candidate.parsed.properties = {
                        ...(candidate.parsed.properties || {}),
                        weight: candidate.nextWeight
                    };
                    updateEdgeStmt.run(JSON.stringify(candidate.parsed), candidate.id);
                }
            }

            sqliteDb.exec(`
                CREATE TABLE IF NOT EXISTS SchemaVersion (
                    id TEXT PRIMARY KEY,
                    version INTEGER NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
            `);
            sqliteDb.prepare(`
                INSERT INTO SchemaVersion (id, version, updated_at)
                VALUES (?, 1, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    version = excluded.version,
                    updated_at = excluded.updated_at
            `).run(LEGACY_ANCHOR_RESET_MARKER_ID);
        })();

        const updatedMarkerRow = sqliteDb
            .prepare('SELECT updated_at FROM SchemaVersion WHERE id = ? LIMIT 1')
            .get(LEGACY_ANCHOR_RESET_MARKER_ID);

        return {
            status          : 'applied',
            markerId        : LEGACY_ANCHOR_RESET_MARKER_ID,
            markerPresent   : true,
            markerUpdatedAt : updatedMarkerRow?.updated_at || null,
            scannedIssueEdges,
            candidateUpdates: candidates.length,
            updatedEdges    : candidates.length,
            byEdgeType,
            sample
        };
    } finally {
        if (ownsHandle) {
            sqliteDb.close();
        }
    }
}

/**
 * @summary CLI entrypoint resolving `AiConfig.storagePaths.graph` lazily when `--db` is omitted.
 * @returns {Promise<void>}
 */
async function main() {
    const program = createProgram();
    program.parse(process.argv);

    const options = program.opts();
    if (options.apply && options.dryRun) {
        throw new Error('Cannot combine --apply and --dry-run.');
    }

    let dbPath = options.db || null;
    if (!dbPath) {
        await import('neo.mjs/src/Neo.mjs');
        await import('neo.mjs/src/core/_export.mjs');
        const {default: aiConfig} = await import('../../mcp/server/memory-core/config.mjs');
        dbPath = aiConfig.storagePaths.graph;
    }

    const result = normalizeLegacyIssueEdgeWeights({
        dbPath,
        apply    : Boolean(options.apply),
        force    : Boolean(options.force),
        onWarning: error => console.warn(
            `[normalizeLegacyIssueEdgeWeights] AgentIdentity lookup degraded: ${error.message}`
        )
    });

    console.log(JSON.stringify({dbPath, ...result}, null, 2));

    if (!options.json && result.status === 'dry-run') {
        console.error(
            'Dry-run complete (0 writes). Re-run with --apply to commit edge updates and record the SchemaVersion marker.'
        );
    }
}

if (isEntryModule(import.meta.url)) {
    main().catch(error => {
        console.error(`[normalizeLegacyIssueEdgeWeights] FATAL: ${error.message}`);
        process.exitCode = 1;
    });
}
