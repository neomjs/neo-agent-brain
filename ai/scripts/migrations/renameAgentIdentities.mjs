#!/usr/bin/env node
/**
 * @summary One-shot migration script that renames canonical Neo maintainer identities
 * across the SQLite Native Edge Graph and ChromaDB memory metadata.
 *
 * This handles GitHub handle renames while preserving model-version facts in
 * `learn/agentos/ModelStats.md` and AgentIdentity capability fields:
 *
 * - `@neo-opus-4-7` → `@neo-opus-ada`
 * - `@neo-gemini-3-1-pro` → `@neo-gemini-pro` → `@neo-gemini-julia`
 * - `@neo-claude-opus` → `@neo-opus-grace`
 * - `@neo-gpt` → `@neo-gpt-euclid`
 * - `@neo-fable` → `@neo-fable-mnemosyne`
 *
 * A token is rewritten only where it is a whole handle: `@neo-gpt-emmy` keeps its prefix,
 * `neo-fable@neomjs.com` keeps its address, and a chain resolves to its last handle in one
 * pass, so a second run finds nothing left to do.
 *
 * The migration updates identity-keyed graph columns, mirrored JSON fields, and
 * Chroma metadata only. It deliberately does not rewrite memory documents,
 * message bodies, summaries, or other historical prose.
 *
 * Usage:
 *   node ai/scripts/migrations/renameAgentIdentities.mjs                # dry-run (default)
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --apply        # commit migration
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --db <path>    # override SQLite path
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --host <host>  # override ChromaDB host
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --port <port>  # override ChromaDB port
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --graph-only   # skip ChromaDB
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --chroma-only  # skip SQLite graph
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --memory-only  # update neo-agent-memory only
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --session-only # update neo-agent-sessions only
 *   node ai/scripts/migrations/renameAgentIdentities.mjs --help
 *
 * Idempotent: re-running after `--apply` is safe. If both old and new graph nodes
 * exist, the old node is merged into the new node and the old `createdAt` is
 * preserved on the canonical node.
 */

import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    createDynamicTextEmbeddingFunction,
    registerNeoChromaEmbeddingFunctions
} from '../../services/shared/vector/chromaClientPrimitives.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const neoRoot    = path.resolve(__dirname, '../../..');

export const IDENTITY_RENAMES = Object.freeze([
    Object.freeze({
        fromNodeId: '@neo-opus-4-7',
        toNodeId  : '@neo-opus-ada',
        fromUserId: 'neo-opus-4-7',
        toUserId  : 'neo-opus-ada'
    }),
    Object.freeze({
        fromNodeId: '@neo-gemini-3-1-pro',
        toNodeId  : '@neo-gemini-pro',
        fromUserId: 'neo-gemini-3-1-pro',
        toUserId  : 'neo-gemini-pro'
    }),
    Object.freeze({
        fromNodeId: '@neo-claude-opus',
        toNodeId  : '@neo-opus-grace',
        fromUserId: 'neo-claude-opus',
        toUserId  : 'neo-opus-grace'
    }),
    // 2026-10-18: the first seat of each family carries its Social Name, like every seat hatched since.
    // Listed after the pair it continues: a chain is walked in this order.
    Object.freeze({
        fromNodeId: '@neo-gpt',
        toNodeId  : '@neo-gpt-euclid',
        fromUserId: 'neo-gpt',
        toUserId  : 'neo-gpt-euclid'
    }),
    Object.freeze({
        fromNodeId: '@neo-gemini-pro',
        toNodeId  : '@neo-gemini-julia',
        fromUserId: 'neo-gemini-pro',
        toUserId  : 'neo-gemini-julia'
    }),
    Object.freeze({
        fromNodeId: '@neo-fable',
        toNodeId  : '@neo-fable-mnemosyne',
        fromUserId: 'neo-fable',
        toUserId  : 'neo-fable-mnemosyne'
    })
]);

const COLLECTION_MEMORY  = 'neo-agent-memory';
const COLLECTION_SESSION = 'neo-agent-sessions';
const BATCH_SIZE         = 500;

const IDENTITY_METADATA_KEYS = new Set([
    'agentIdentity',
    'agentIdentityNodeId',
    'agentIdentityNodeIds',
    'agentIdentities',
    'agentIds',
    'assignee',
    'assignees',
    'author',
    'canonicalIdentityId',
    'coordinator',
    'coordinator_recommendation',
    'deliveredTo',
    'from',
    'githubLogin',
    'grantedBy',
    'id',
    'identity',
    'identityKey',
    'identityLogin',
    'identityLogins',
    'owner',
    'participatingAgents',
    'recipient',
    'recipients',
    'requiredA2aMailboxAddress',
    'requiredGithubLogin',
    'sender',
    'sentBy',
    'siblingOf',
    'source',
    'sourceAgentIdentities',
    'target',
    'to',
    'userId'
]);

registerNeoChromaEmbeddingFunctions();

/**
 * @summary Parses CLI flags for the identity rename migration runner.
 * @param {String[]} argv Node process argv array.
 * @returns {Object}
 */
export function parseArgs(argv) {
    const args = {
        apply     : false,
        chromaOnly: false,
        db        : null,
        graphOnly : false,
        help      : false,
        // null = "resolve from the KB server config at run time": the config transitively pulls
        // the Neo class system, so its import is LAZY inside main() behind the bootstrap — flag
        // parsing (and `--help`) must stay runnable in a bare fresh process.
        host       : null,
        memoryOnly : false,
        port       : null,
        sessionOnly: false
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply')             args.apply = true;
        else if (arg === '--chroma-only')  args.chromaOnly = true;
        else if (arg === '--graph-only')   args.graphOnly = true;
        else if (arg === '--help')         args.help = true;
        else if (arg === '--memory-only')  args.memoryOnly = true;
        else if (arg === '--session-only') args.sessionOnly = true;
        else if (arg === '--db')           args.db = argv[++i];
        else if (arg === '--host')         args.host = argv[++i];
        else if (arg === '--port')         args.port = Number(argv[++i]);
        else {
            console.error(`Unknown argument: ${arg}`);
            args.help = true;
        }
    }

    if (args.graphOnly && args.chromaOnly) {
        console.error('Cannot combine --graph-only and --chroma-only.');
        args.help = true;
    }
    if (args.memoryOnly && args.sessionOnly) {
        console.error('Cannot combine --memory-only and --session-only.');
        args.help = true;
    }

    return args;
}

function printUsage() {
    console.log(`
Usage: node ai/scripts/migrations/renameAgentIdentities.mjs [options]

Renames versioned Neo maintainer handles across graph identity metadata and
ChromaDB metadata without touching historical document/message text.

Options:
  (no flags)         Dry-run mode — print the migration plan without committing
  --apply            Commit the migration
  --db <path>        Override SQLite graph path (default: .neo-ai-data/sqlite/memory-core-graph.sqlite)
  --host <host>      Override ChromaDB host (default: the KB server config's chroma endpoint; NEO_CHROMA_HOST binds through its leaf)
  --port <port>      Override ChromaDB port (default: the KB server config's chroma endpoint; NEO_CHROMA_PORT binds through its leaf)
  --graph-only       Update only the SQLite Native Edge Graph
  --chroma-only      Update only ChromaDB metadata
  --memory-only      Update only neo-agent-memory Chroma metadata
  --session-only     Update only neo-agent-sessions Chroma metadata
  --help             Print this usage message
`);
}

/**
 * @summary Maps every rename token (`@` node id and bare user id) to the last handle of its chain,
 * so `@neo-gemini-3-1-pro` resolves to `@neo-gemini-julia` in one step rather than stopping at the
 * intermediate `@neo-gemini-pro`.
 * @param {ReadonlyArray<Object>} renames Rename descriptors in chain order.
 * @returns {Map<String,String>}
 */
export function buildRenameTargets(renames) {
    const next = new Map();

    for (const rename of renames) {
        next.set(rename.fromNodeId, rename.toNodeId);
        next.set(rename.fromUserId, rename.toUserId);
    }

    const resolve = token => {
        let current = token;
        for (let hops = 0; next.has(current) && hops < next.size; hops++) {
            current = next.get(current);
        }
        return current;
    };

    return new Map([...next.keys()].map(token => [token, resolve(token)]));
}

/**
 * @summary Builds one global alternation over every rename token, longest first, with the boundary
 * rule in lookarounds so a rejected position is never consumed. A handle is made of `[A-Za-z0-9-]`;
 * neither form may run on into a handle character or an `@`, which keeps `@neo-gpt-emmy` whole and
 * `neo-fable@neomjs.com` untouched. The `@` form may follow any non-alphanumeric character
 * (`AGENT:@neo-gpt`, `identity-state-@neo-fable`); the bare form may not follow `@` or a handle character.
 * @param {Map<String,String>} targets Output of {@link buildRenameTargets}.
 * @returns {RegExp}
 */
export function buildTokenPattern(targets) {
    const escape  = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokens  = [...targets.keys()].sort((a, b) => b.length - a.length);
    const nodeIds = tokens.filter(token => token.startsWith('@')).map(token => escape(token.slice(1)));
    const userIds = tokens.filter(token => !token.startsWith('@')).map(escape);

    return new RegExp(
        `(?<![A-Za-z0-9])@(?:${nodeIds.join('|')})(?![A-Za-z0-9@-])` +
        `|(?<![A-Za-z0-9@-])(?:${userIds.join('|')})(?![A-Za-z0-9@-])`,
        'g'
    );
}

const RENAME_TARGETS = buildRenameTargets(IDENTITY_RENAMES);
const TOKEN_PATTERN  = buildTokenPattern(RENAME_TARGETS);

/**
 * @summary Rewrites whole-handle identity tokens inside a string value; applying it to its own output
 * changes nothing.
 * @param {String} value Source string.
 * @returns {String}
 */
export function rewriteIdentityString(value) {
    return value.replace(TOKEN_PATTERN, token => RENAME_TARGETS.get(token));
}

/**
 * @summary Rewrites a graph row id that embeds a handle: the whole-handle rule, plus the era-chain
 * shape `embodied-episode-<key>-<since>`, whose ISO `since` suffix hides the handle's right boundary
 * behind a hyphen. Row ids and the JSON `id` they mirror move together, never one without the other.
 * @param {String} id Node or edge row id.
 * @returns {String}
 */
export function rewriteNodeId(id) {
    const eraShapesMoved = id.replace(
        /embodied-episode-(.+?)(-\d{4}-\d{2}-\d{2}T[0-9:.Z+-]*)/g,
        (match, key, since) => `embodied-episode-${rewriteIdentityString(key)}${since}`
    );
    return rewriteIdentityString(eraShapesMoved);
}

/**
 * @summary Rewrites identity tokens in a value known to represent identity metadata.
 * @param {*} value Metadata value.
 * @returns {*}
 */
export function rewriteIdentityValue(value) {
    if (typeof value === 'string') {
        return rewriteIdentityString(value);
    }
    if (Array.isArray(value)) {
        return value.map(item => rewriteIdentityValue(item));
    }
    if (value && typeof value === 'object') {
        return rewriteIdentityFields(value);
    }
    return value;
}

/**
 * @summary Rewrites only identity-keyed fields inside graph/Chroma metadata objects.
 * @param {*} value Source metadata value.
 * @returns {*}
 */
export function rewriteIdentityFields(value) {
    if (Array.isArray(value)) {
        return value.map(item => {
            if (item && typeof item === 'object') return rewriteIdentityFields(item);
            return item;
        });
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (IDENTITY_METADATA_KEYS.has(key)) {
            out[key] = rewriteIdentityValue(child);
        } else if (child && typeof child === 'object') {
            out[key] = rewriteIdentityFields(child);
        } else {
            out[key] = child;
        }
    }
    return out;
}

/**
 * @summary Returns true when JSON serialization differs after identity metadata rewrite.
 * @param {*} before Source value.
 * @param {*} after Rewritten value.
 * @returns {Boolean}
 */
function changedJson(before, after) {
    return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * @summary Rewrites a SQLite row `user_id` column if it stores an old user id.
 * @param {String|null} userId Source user id.
 * @returns {String|null}
 */
function rewriteUserIdColumn(userId) {
    if (typeof userId !== 'string') return userId;
    return RENAME_TARGETS.get(userId) ?? userId;
}

/**
 * @summary Parses graph JSON defensively for migration reads.
 * @param {String} raw JSON string from SQLite.
 * @returns {Object}
 */
function parseGraphData(raw) {
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`Invalid graph JSON row: ${e.message}`);
    }
}

/**
 * @summary Merges an old AgentIdentity node into the current canonical node data.
 * @param {Object} oldData Old node data.
 * @param {Object} targetData Canonical node data.
 * @returns {Object}
 */
function mergeIdentityNodeData(oldData, targetData) {
    const merged = rewriteIdentityFields({...targetData});
    merged.id = rewriteIdentityString(String(merged.id));
    merged.properties = {...(merged.properties || {})};

    const oldCreatedAt = oldData?.properties?.createdAt;
    if (oldCreatedAt) {
        merged.properties.createdAt = oldCreatedAt;
    }

    return merged;
}

/**
 * @summary Inserts or updates the target AgentIdentity node before edge rewrites.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Object} rename Rename descriptor.
 * @param {Boolean} apply True to write, false for dry-run.
 * @param {Object} stats Mutable stats object.
 */
function ensureTargetIdentityNode(db, rename, apply, stats) {
    const oldRow    = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get(rename.fromNodeId);
    const targetRow = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get(rename.toNodeId);

    if (!oldRow && !targetRow) {
        stats.graph.skipped.push(`missing:${rename.fromNodeId}`);
        return;
    }

    if (!oldRow && targetRow) {
        const targetData = parseGraphData(targetRow.data);
        const nextData   = rewriteIdentityFields(targetData);
        const nextUserId = rewriteUserIdColumn(targetRow.user_id);

        if (changedJson(targetData, nextData) || nextUserId !== targetRow.user_id) {
            if (apply) {
                db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?')
                    .run(nextUserId, JSON.stringify(nextData), targetRow.id);
            }
            stats.graph.nodeMetadataRowsUpdated++;
        }
        return;
    }

    const oldData  = parseGraphData(oldRow.data);
    const nextData = targetRow
        ? mergeIdentityNodeData(oldData, parseGraphData(targetRow.data))
        : rewriteIdentityFields({...oldData, id: rename.toNodeId});

    if (targetRow) {
        if (apply) {
            db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?')
                .run(rewriteUserIdColumn(targetRow.user_id) || rename.toUserId, JSON.stringify(nextData), rename.toNodeId);
        }
        stats.graph.nodesMerged++;
    } else {
        if (apply) {
            db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)')
                .run(rename.toNodeId, rewriteUserIdColumn(oldRow.user_id) || rename.toUserId, JSON.stringify(nextData));
        }
        stats.graph.nodesInserted++;
    }
}

/**
 * @summary Rewrites or drops edges that structurally point at the old identity node.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Object} rename Rename descriptor.
 * @param {Boolean} apply True to write, false for dry-run.
 * @param {Object} stats Mutable stats object.
 */
function rewriteIdentityEdges(db, rename, apply, stats) {
    const edges = db.prepare(
        'SELECT id, user_id, source, target, type, data FROM Edges WHERE source = ? OR target = ?'
    ).all(rename.fromNodeId, rename.fromNodeId);

    for (const edge of edges) {
        const nextSource = edge.source === rename.fromNodeId ? rename.toNodeId : edge.source;
        const nextTarget = edge.target === rename.fromNodeId ? rename.toNodeId : edge.target;
        const duplicate  = db.prepare(
            'SELECT id FROM Edges WHERE source = ? AND target = ? AND type = ? AND id != ?'
        ).get(nextSource, nextTarget, edge.type, edge.id);

        if (duplicate) {
            if (apply) {
                db.prepare('DELETE FROM Edges WHERE id = ?').run(edge.id);
            }
            stats.graph.edgesDropped++;
            stats.graph.duplicateCollisions++;
            continue;
        }

        const original = parseGraphData(edge.data);
        const data     = rewriteIdentityFields(original);
        data.source = nextSource;
        data.target = nextTarget;
        // The JSON id mirrors the SQL id; the metadata pass re-keys both together or neither.
        if (original.id === edge.id) data.id = edge.id;

        if (apply) {
            db.prepare('UPDATE Edges SET user_id = ?, source = ?, target = ?, data = ? WHERE id = ?')
                .run(rewriteUserIdColumn(edge.user_id), nextSource, nextTarget, JSON.stringify(data), edge.id);
        }
        stats.graph.edgesRewritten++;
    }
}

const STRUCTURAL_NODE_IDS = new Set(IDENTITY_RENAMES.map(rename => rename.fromNodeId));

/**
 * @summary Moves every edge that names `fromId` onto `toId`; an edge that would duplicate one already
 * on the surviving row is dropped, as in {@link rewriteIdentityEdges}.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {String} fromId The row id the edges still name.
 * @param {String} toId The surviving row id.
 * @param {Boolean} apply True to write, false for dry-run.
 * @param {Object} stats Mutable stats object.
 */
function moveEdges(db, fromId, toId, apply, stats) {
    for (const edge of db.prepare('SELECT id, source, target, type FROM Edges WHERE source = ? OR target = ?').all(fromId, fromId)) {
        const nextSource = edge.source === fromId ? toId : edge.source;
        const nextTarget = edge.target === fromId ? toId : edge.target;
        const duplicate  = db.prepare('SELECT id FROM Edges WHERE source = ? AND target = ? AND type = ? AND id != ?')
            .get(nextSource, nextTarget, edge.type, edge.id);

        if (duplicate) {
            if (apply) {
                db.prepare('DELETE FROM Edges WHERE id = ?').run(edge.id);
            }
            stats.graph.edgesDropped++;
            stats.graph.duplicateCollisions++;
            continue;
        }
        if (apply) {
            db.prepare('UPDATE Edges SET source = ?, target = ? WHERE id = ?').run(nextSource, nextTarget, edge.id);
        }
    }
}

/**
 * @summary Rewrites identity metadata in all graph rows after structural node moves. A row whose id
 * embeds a handle (`identity-state-@…`, `embodied-episode-@…-<since>`, `AGENT:@…`) is re-keyed as
 * insert, move, delete: the `Edges` foreign keys (`REFERENCES Nodes(id) ON DELETE CASCADE`, no
 * `ON UPDATE`) refuse a primary-key update on a connected row, so the surviving row exists before any
 * edge names it and nothing still names the old row when it goes. When both ids already exist, the
 * old row merges into the surviving one ({@link mergeCompoundNodeData}): its edges move over and it
 * goes. The edge pass mirrors the moved SQL columns into the JSON, never an independent rewrite, so
 * the SQLite id, the JSON id and the edge endpoints never disagree. The AgentIdentity rows themselves
 * moved structurally above.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Boolean} apply True to write, false for dry-run.
 * @param {Object} stats Mutable stats object.
 */
function rewriteGraphMetadataRows(db, apply, stats) {
    const moved = new Map(); // old row id → surviving row id

    for (const snapshot of db.prepare('SELECT id FROM Nodes').all()) {
        if (STRUCTURAL_NODE_IDS.has(snapshot.id)) continue;

        // Re-read before deciding: a merge earlier in this pass may have rewritten or removed this row,
        // and the snapshot taken before the pass is no authority over merged data.
        const row = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get(snapshot.id);
        if (!row) continue;

        const data       = parseGraphData(row.data);
        const nextData   = rewriteIdentityFields(data);
        const nextUserId = rewriteUserIdColumn(row.user_id);
        const nextId     = rewriteNodeId(row.id);

        if (nextId !== row.id) {
            const survivor = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get(nextId);
            if (survivor) {
                const {merged, conflicts} = mergeCompoundNodeData(nextData, rewriteIdentityFields(parseGraphData(survivor.data)));
                if (conflicts.length > 0) {
                    // Fail closed for this row: nothing moves, nothing is written, the plan names the keys.
                    stats.graph.duplicateCollisions++;
                    stats.graph.skipped.push(`conflict:${row.id}→${nextId} [${conflicts.join(', ')}]`);
                    continue;
                }
                moved.set(row.id, nextId);
                moveEdges(db, row.id, nextId, apply, stats);
                if (apply) {
                    db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?')
                        .run(rewriteUserIdColumn(survivor.user_id) ?? nextUserId, JSON.stringify(merged), nextId);
                    db.prepare('DELETE FROM Nodes WHERE id = ?').run(row.id);
                }
                stats.graph.nodesMerged++;
                continue;
            }

            moved.set(row.id, nextId);
            if (data.id === row.id) nextData.id = nextId;
            if (apply) {
                db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)')
                    .run(nextId, nextUserId, JSON.stringify(nextData));
            }
            moveEdges(db, row.id, nextId, apply, stats);
            if (apply) {
                db.prepare('DELETE FROM Nodes WHERE id = ?').run(row.id);
            }
            stats.graph.nodesRekeyed++;
            continue;
        }

        if (nextUserId !== row.user_id || changedJson(data, nextData)) {
            if (apply) {
                db.prepare('UPDATE Nodes SET user_id = ?, data = ? WHERE id = ?')
                    .run(nextUserId, JSON.stringify(nextData), row.id);
            }
            stats.graph.nodeMetadataRowsUpdated++;
        }
    }

    for (const snapshot of db.prepare('SELECT id FROM Edges').all()) {
        // Re-read: the node moves above rewrote endpoints and dropped duplicates.
        const row = db.prepare('SELECT id, user_id, source, target, data FROM Edges WHERE id = ?').get(snapshot.id);
        if (!row) continue;

        const data       = parseGraphData(row.data);
        const nextData   = rewriteIdentityFields(data);
        const nextUserId = rewriteUserIdColumn(row.user_id);
        let   nextId     = rewriteNodeId(row.id);

        if (nextId !== row.id && db.prepare('SELECT id FROM Edges WHERE id = ?').get(nextId)) {
            // Another edge already carries the re-keyed id: this row keeps its own, and one mapping
            // still governs its SQL id, its JSON id and its endpoints.
            stats.graph.duplicateCollisions++;
            stats.graph.skipped.push(`collision:${row.id}→${nextId}`);
            nextId = row.id;
        }

        // Endpoints mirror the SQL columns after the node moves (in a dry run, the moves they would make).
        if (typeof data.source === 'string') nextData.source = moved.get(row.source) ?? row.source;
        if (typeof data.target === 'string') nextData.target = moved.get(row.target) ?? row.target;
        if (data.id === row.id) nextData.id = nextId;

        if (nextId !== row.id || nextUserId !== row.user_id || changedJson(data, nextData)) {
            if (apply) {
                db.prepare('UPDATE Edges SET id = ?, user_id = ?, data = ? WHERE id = ?')
                    .run(nextId, nextUserId, JSON.stringify(nextData), row.id);
            }
            if (nextId !== row.id) stats.graph.edgesRekeyed++;
            else stats.graph.edgeMetadataRowsUpdated++;
        }
    }
}

/**
 * @summary Merges an old compound row into the row already living under its new id under one explicit
 * policy: a key present on one row only is kept, a key present on both must agree, and
 * `properties.createdAt` keeps the older value. A disagreement is a conflict the caller fails closed
 * on — nothing is written and the plan names the keys — because deleting the old row would discard
 * a value nobody reconciled.
 * @param {Object} oldData The old row's data, identity tokens already rewritten.
 * @param {Object} survivingData The surviving row's data.
 * @returns {{merged: Object, conflicts: String[]}}
 */
function mergeCompoundNodeData(oldData, survivingData) {
    const conflicts = [];

    const mergeLevel = (a, b, prefix) => {
        const out = {...a, ...b};

        for (const key of Object.keys(a)) {
            if (!(key in b) || key === 'properties') continue;
            if (prefix === 'properties.' && key === 'createdAt') {
                out.createdAt = a.createdAt < b.createdAt ? a.createdAt : b.createdAt;
                continue;
            }
            if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
                conflicts.push(`${prefix}${key}`);
            }
        }
        return out;
    };

    const merged = mergeLevel(oldData, survivingData, '');
    merged.properties = mergeLevel(oldData.properties || {}, survivingData.properties || {}, 'properties.');

    return {merged, conflicts};
}

/**
 * @summary Removes the old identity node after all incoming/outgoing edges moved.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Object} rename Rename descriptor.
 * @param {Boolean} apply True to write, false for dry-run.
 * @param {Object} stats Mutable stats object.
 */
function deleteOldIdentityNode(db, rename, apply, stats) {
    const oldRow = db.prepare('SELECT id FROM Nodes WHERE id = ?').get(rename.fromNodeId);
    if (!oldRow) return;

    if (apply) {
        db.prepare('DELETE FROM Nodes WHERE id = ?').run(rename.fromNodeId);
    }
    stats.graph.nodesDeleted++;
}

/**
 * @summary Runs the SQLite graph portion of the identity rename migration.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Boolean} apply True to write, false for dry-run.
 * @returns {Object}
 */
export function runGraphMigration(db, apply) {
    const stats = {
        graph: {
            duplicateCollisions    : 0,
            edgeMetadataRowsUpdated: 0,
            edgesDropped           : 0,
            edgesRekeyed           : 0,
            edgesRewritten         : 0,
            nodeMetadataRowsUpdated: 0,
            nodesDeleted           : 0,
            nodesInserted          : 0,
            nodesMerged            : 0,
            nodesRekeyed           : 0,
            skipped                : []
        }
    };

    const work = () => {
        for (const rename of IDENTITY_RENAMES) {
            ensureTargetIdentityNode(db, rename, apply, stats);
            rewriteIdentityEdges(db, rename, apply, stats);
            deleteOldIdentityNode(db, rename, apply, stats);
        }
        rewriteGraphMetadataRows(db, apply, stats);
    };

    if (apply) {
        db.transaction(work)();
    } else {
        work();
    }

    return stats.graph;
}

/**
 * @summary Finds Chroma records whose metadata still contains old identity tokens.
 * @param {Object} collection Chroma collection.
 * @returns {Promise<Object>}
 */
export async function findChromaMetadataUpdates(collection) {
    const updates = [];
    let   scanned = 0;
    let   offset  = 0;

    while (true) {
        const batch = await collection.get({
            limit  : BATCH_SIZE,
            offset,
            include: ['metadatas']
        });

        if (!batch.ids || batch.ids.length === 0) break;

        batch.ids.forEach((id, index) => {
            const metadata = batch.metadatas[index] || {};
            const next     = rewriteIdentityFields(metadata);
            scanned++;

            if (changedJson(metadata, next)) {
                updates.push({id, metadata: next});
            }
        });

        if (batch.ids.length < BATCH_SIZE) break;
        offset += BATCH_SIZE;
    }

    return {scanned, updates};
}

/**
 * @summary Applies Chroma metadata updates in bounded batches.
 * @param {Object} collection Chroma collection.
 * @param {Object[]} updates Update records.
 * @returns {Promise<Number>}
 */
async function applyChromaMetadataUpdates(collection, updates) {
    let applied = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const slice = updates.slice(i, i + BATCH_SIZE);
        await collection.update({
            ids      : slice.map(record => record.id),
            metadatas: slice.map(record => record.metadata)
        });
        applied += slice.length;
        process.stdout.write(`\r    updated ${applied}/${updates.length}`);
    }
    process.stdout.write('\n');
    return applied;
}

/**
 * @summary Processes one Chroma collection in dry-run or apply mode.
 * @param {Object} client ChromaDB client.
 * @param {String} collectionName Collection name.
 * @param {Boolean} apply True to write, false for dry-run.
 * @returns {Promise<Object>}
 */
async function processChromaCollection(client, collectionName, apply) {
    console.log(`\n[${collectionName}]`);
    const embeddingFunction = createDynamicTextEmbeddingFunction();
    const collection        = await client.getOrCreateCollection({
        name: collectionName,
        embeddingFunction
    });

    const total              = await collection.count();
    const {scanned, updates} = await findChromaMetadataUpdates(collection);

    console.log(`  total records: ${total}`);
    console.log(`  scanned:       ${scanned}`);
    console.log(`  to update:     ${updates.length}`);

    if (updates.length === 0) {
        console.log('  → no work needed');
        return {scanned, planned: 0, applied: 0};
    }

    if (!apply) {
        console.log(`  → DRY-RUN: would update ${updates.length} metadata record(s)`);
        return {scanned, planned: updates.length, applied: 0};
    }

    console.log(`  → APPLY: updating ${updates.length} metadata record(s)...`);
    const applied = await applyChromaMetadataUpdates(collection, updates);
    return {scanned, planned: updates.length, applied};
}

/**
 * @summary Runs the ChromaDB metadata portion of the identity rename migration.
 * @param {Object} args Parsed CLI args.
 * @returns {Promise<Object>}
 */
async function runChromaMigration(args) {
    const {ChromaClient} = await import('chromadb');
    const client         = new ChromaClient({host: args.host, port: args.port, ssl: false});

    try {
        await client.heartbeat();
    } catch (e) {
        throw new Error(`cannot reach ChromaDB at ${args.host}:${args.port}: ${e.message}`);
    }

    const targetMemory  = !args.sessionOnly;
    const targetSession = !args.memoryOnly;
    const summary       = {memory: null, session: null};

    if (targetMemory) {
        summary.memory = await processChromaCollection(client, COLLECTION_MEMORY, args.apply);
    }
    if (targetSession) {
        summary.session = await processChromaCollection(client, COLLECTION_SESSION, args.apply);
    }

    return summary;
}

/**
 * @summary CLI entrypoint for the identity rename migration.
 * @returns {Promise<void>}
 */
async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printUsage();
        process.exit(0);
    }

    // The KB server config OWNS the chroma endpoint (default + the NEO_CHROMA_* env bindings) —
    // consumed at the use site. Its import chain evaluates Neo class modules, which need the
    // runtime global first, so the bootstrap + config import are LAZY and sequenced here: the
    // module import and the `--help` path above stay runnable in a bare fresh process.
    if (args.host == null || args.port == null) {
        await import('neo.mjs/src/Neo.mjs');
        await import('neo.mjs/src/core/_export.mjs');
        const {default: kbConfig} = await import('../../mcp/server/knowledge-base/config.mjs');
        args.host ??= kbConfig.engines.chroma.host;
        args.port ??= kbConfig.engines.chroma.port;
    }

    const dbPath = args.db || path.resolve(neoRoot, '.neo-ai-data/sqlite/memory-core-graph.sqlite');
    console.log(`[renameAgentIdentities] mode:        ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`[renameAgentIdentities] graph:       ${args.chromaOnly ? 'skip' : dbPath}`);
    console.log(`[renameAgentIdentities] chroma:      ${args.graphOnly ? 'skip' : `${args.host}:${args.port}`}`);
    console.log(`[renameAgentIdentities] renames:     ${IDENTITY_RENAMES.map(r => `${r.fromNodeId} → ${r.toNodeId}`).join(', ')}`);

    if (!args.chromaOnly) {
        const Database = (await import('better-sqlite3')).default;
        const db       = new Database(dbPath, {verbose: null});
        try {
            const graphStats = runGraphMigration(db, args.apply);
            console.log('\n[SQLite graph]');
            console.log(`  nodes inserted:          ${graphStats.nodesInserted}`);
            console.log(`  nodes merged:            ${graphStats.nodesMerged}`);
            console.log(`  nodes deleted:           ${graphStats.nodesDeleted}`);
            console.log(`  edges rewritten:         ${graphStats.edgesRewritten}`);
            console.log(`  edges dropped (dupes):   ${graphStats.edgesDropped}`);
            console.log(`  duplicate collisions:    ${graphStats.duplicateCollisions}`);
            console.log(`  node metadata updated:   ${graphStats.nodeMetadataRowsUpdated}`);
            console.log(`  edge metadata updated:   ${graphStats.edgeMetadataRowsUpdated}`);
            console.log(`  nodes re-keyed:          ${graphStats.nodesRekeyed}`);
            console.log(`  edges re-keyed:          ${graphStats.edgesRekeyed}`);
            console.log(`  skipped:                 ${graphStats.skipped.length}`);
        } finally {
            db.close();
        }
    }

    let chromaSummary = null;
    if (!args.graphOnly) {
        chromaSummary = await runChromaMigration(args);
    }

    console.log('\n[renameAgentIdentities] summary:');
    if (!args.chromaOnly) {
        console.log(`  graph:  ${args.apply ? 'applied' : 'dry-run complete'}`);
    }
    if (chromaSummary?.memory) {
        console.log(`  memory: scanned=${chromaSummary.memory.scanned}, ${args.apply ? `updated=${chromaSummary.memory.applied}` : `would-update=${chromaSummary.memory.planned}`}`);
    }
    if (chromaSummary?.session) {
        console.log(`  session: scanned=${chromaSummary.session.scanned}, ${args.apply ? `updated=${chromaSummary.session.applied}` : `would-update=${chromaSummary.session.planned}`}`);
    }

    if (!args.apply) {
        console.log('\n[renameAgentIdentities] DRY-RUN complete. No changes applied.');
        console.log('[renameAgentIdentities] Re-run with --apply to commit.');
    } else {
        console.log('\n[renameAgentIdentities] APPLY complete. Restart MCP harnesses to refresh identity caches.');
    }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === __filename) {
    main().catch(err => {
        console.error('[renameAgentIdentities] FATAL:', err);
        process.exit(1);
    });
}
