import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'PromoteStandaloneWalUnitSpec',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}  from '@playwright/test';
import {spawnSync}     from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {DatabaseSync}  from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import InstanceManager from 'neo.mjs/src/manager/Instance.mjs';
import {
    DEFAULT_STANDALONE_PLANE_ID,
    parseStandaloneArgs,
    runPromoteCli
}                             from '../../../../../../../ai/mcp/server/memory-core/standalone.mjs';
import {
    appendWalMemory,
    getWalRecordsFileName,
    readPendingWalRecords
}                             from '../../../../../../../ai/services/memory-core/helpers/memoryWalStore.mjs';
import {
    promoteStandaloneWal,
    resolveRosteredPromotionOwner
}                             from '../../../../../../../ai/services/memory-core/helpers/promoteStandaloneWal.mjs';
import {composeTurnDocumentText} from '../../../../../../../ai/services/memory-core/helpers/turnDocumentText.mjs';

void Neo;
void core;
void InstanceManager;

const STANDALONE_BIN = fileURLToPath(
    new URL('../../../../../../../ai/mcp/server/memory-core/standalone.mjs', import.meta.url)
);
const REPO_ROOT = path.resolve(path.dirname(STANDALONE_BIN), '../../../..');

/**
 * @summary Creates a disposable temporary directory for isolated WAL and SQLite test fixtures.
 * @param {String} prefix Directory name prefix.
 * @returns {String}
 */
function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @summary Builds a standalone-shaped WAL turn record matching `standaloneToolService#add_memory`.
 * @param {Object} options
 * @param {String} options.id Memory UUID.
 * @param {Number} options.timestamp Epoch-ms timestamp.
 * @param {String} options.workspace Canonical workspace key.
 * @param {String} [options.sessionId='session-standalone-1'] Session ID.
 * @param {String} [options.agent='codex-cli'] Display agent string.
 * @returns {Object}
 */
function buildStandaloneRecord({
    id,
    timestamp,
    workspace,
    sessionId = 'session-standalone-1',
    agent     = 'codex-cli'
}) {
    const prompt   = `Prompt for ${id}`;
    const thought  = `Decision context for ${id}`;
    const response = `Response for ${id}`;

    return {
        id,
        timestamp,
        workspace,
        workspaceSource: 'git-remote',
        metadata       : {
            prompt,
            response,
            thought,
            sessionId,
            timestamp,
            type           : 'agent-interaction',
            workspace,
            workspaceSource: 'git-remote',
            agent
        },
        document              : composeTurnDocumentText({prompt, thought, response}),
        graphProjectionVersion: 1,
        graphProjection       : {
            requestIdentity : null,
            memoryProperties: {
                sessionId,
                timestamp: new Date(timestamp).toISOString(),
                workspace
            }
        }
    };
}

/**
 * @summary Creates a real `node:sqlite` graph DB matching `ai/graph/storage/SQLite.mjs`'s `Nodes` schema.
 * @param {String} dbPath Target SQLite file path.
 * @param {Array<{id: String, label: String, properties?: Object}>} nodes Seeded graph nodes.
 */
function createCustomGraphDb(dbPath, nodes) {
    const db = new DatabaseSync(dbPath);
    try {
        db.exec(`
            CREATE TABLE Nodes (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                data TEXT NOT NULL
            );
            CREATE INDEX idx_nodes_label ON Nodes(json_extract(data, '$.label'));
        `);

        const insert = db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)');
        for (const entry of nodes) {
            const payload = {
                id        : entry.id,
                label     : entry.label,
                properties: entry.properties || {}
            };
            insert.run(entry.id, payload.properties.userId ?? null, JSON.stringify(payload));
        }
    } finally {
        db.close();
    }
}

/**
 * @summary Builds a writable fake `GraphService.db` supporting `upsertNode`, `linkNodes`, and RLS reads without mutating `AiConfig`.
 * @param {{value: (String|null)}} requester Active requester holder.
 * @returns {Object}
 */
function makeTopologyDb(requester) {
    const nodeMap  = new Map();
    const edges    = [];
    const sqliteDb = {
        prepare(sql) {
            return {
                get(...args) {
                    if (sql.includes('FROM Nodes')) {
                        const [a, b] = args;
                        return {count: (nodeMap.has(a) ? 1 : 0) + (a === b ? 0 : (nodeMap.has(b) ? 1 : 0))};
                    }
                    return undefined;
                }
            };
        }
    };

    return {
        getAdjacentNodes() {},
        nodes: nodeMap,
        edges: {
            getByIndex(field, id) {
                return edges.filter(edge => edge[field] === id);
            }
        },
        addNode(spec) {
            nodeMap.set(spec.id, {id: spec.id, label: spec.label, properties: spec.properties});
        },
        addEdge(spec) {
            edges.push({
                id        : spec.id,
                source    : spec.source,
                target    : spec.target,
                type      : spec.type,
                properties: spec.properties
            });
        },
        transaction(fn) {
            return fn();
        },
        autoSave: false,
        storage : {
            db                   : sqliteDb,
            dbPath               : '/tmp/promote-standalone-rls-fake.db',
            RequestContextService: {
                getAgentIdentityNodeId: () => requester.value
            }
        }
    };
}

test.describe('Neo.ai.services.memory-core.helpers.promoteStandaloneWal (#1717)', () => {
    const DAY_UTC = Date.UTC(2026, 10, 15, 12, 0, 0);

    test('AC-1: fails closed on missing --target-graph-db or missing, sentinel, or unrostered --owner before touching targetWalDir', async () => {
        const sandbox      = makeTempDir('mc-promote-ac1-');
        const sourceWalDir = path.join(sandbox, 'source-wal');
        const targetWalDir = path.join(sandbox, 'untouched-target-wal');
        const customDbPath = path.join(sandbox, 'custom-graph.sqlite');

        try {
            await appendWalMemory(
                buildStandaloneRecord({
                    id       : 'mem-ac1-1',
                    timestamp: DAY_UTC,
                    workspace: 'github.com/neomjs/neo-agent-brain'
                }),
                {dir: sourceWalDir, planeId: DEFAULT_STANDALONE_PLANE_ID}
            );

            expect(fs.existsSync(targetWalDir)).toBe(false);

            // Seed a real SQLite graph DB with a custom team seat (plus @system / AGENT:* sentinels).
            createCustomGraphDb(customDbPath, [
                {id: '@system', label: 'System'},
                {id: 'AGENT:*', label: 'BroadcastSentinel'},
                {id: '@custom-team-seat', label: 'AgentIdentity', properties: {displayName: 'Custom Seat'}}
            ]);

            // Missing or blank `--target-graph-db` rejects naming `--target-graph-db` before touching targetWalDir.
            for (const missingGraphDb of [undefined, null, '', '   ']) {
                expect(() => resolveRosteredPromotionOwner({
                    owner        : '@custom-team-seat',
                    targetGraphDb: missingGraphDb
                })).toThrow(/--target-graph-db/);

                await expect(
                    promoteStandaloneWal({
                        sourceWalDir,
                        targetWalDir,
                        owner        : '@custom-team-seat',
                        targetGraphDb: missingGraphDb
                    })
                ).rejects.toThrow(/--target-graph-db/);
                expect(fs.existsSync(targetWalDir)).toBe(false);
            }

            // Invalid, sentinel, or unrostered `--owner` (including `@neo-gemini-julia`, proving `identityRoots.mjs` is never read) rejects before touching targetWalDir.
            for (const invalidOwner of [
                undefined,
                '',
                '   ',
                '@',
                '@system',
                'system',
                'AGENT:*',
                'role:maintainer',
                'human:outsider',
                '@random-outsider',
                '@neo-gemini-julia'
            ]) {
                await expect(
                    promoteStandaloneWal({
                        sourceWalDir,
                        targetWalDir,
                        owner        : invalidOwner,
                        targetGraphDb: customDbPath
                    })
                ).rejects.toThrow(/--owner/);
                expect(fs.existsSync(targetWalDir)).toBe(false);
            }

            await expect(
                promoteStandaloneWal({
                    sourceWalDir,
                    targetWalDir,
                    owner        : '@neo-gemini-julia',
                    targetGraphDb: customDbPath
                })
            ).rejects.toThrow(/not a rostered AgentIdentity in target graph/);
            expect(fs.existsSync(targetWalDir)).toBe(false);

            // Sentinels remain refused even when present in Nodes.
            expect(() => resolveRosteredPromotionOwner({
                owner        : '@system',
                targetGraphDb: customDbPath
            })).toThrow(/invalid or sentinel --owner/);

            // Empty `--user-id`, non-existent `--target-graph-db`, and directory `--target-graph-db` also reject before touching targetWalDir.
            await expect(
                promoteStandaloneWal({
                    sourceWalDir,
                    targetWalDir,
                    owner        : '@custom-team-seat',
                    targetGraphDb: customDbPath,
                    userId       : '   '
                })
            ).rejects.toThrow(/--user-id/);
            expect(fs.existsSync(targetWalDir)).toBe(false);

            await expect(
                promoteStandaloneWal({
                    sourceWalDir,
                    targetWalDir,
                    owner        : '@custom-team-seat',
                    targetGraphDb: path.join(sandbox, 'does-not-exist.sqlite')
                })
            ).rejects.toThrow(/--target-graph-db/);
            expect(fs.existsSync(targetWalDir)).toBe(false);

            await expect(
                promoteStandaloneWal({
                    sourceWalDir,
                    targetWalDir,
                    owner        : '@custom-team-seat',
                    targetGraphDb: sandbox
                })
            ).rejects.toThrow(/--target-graph-db/);
            expect(fs.existsSync(targetWalDir)).toBe(false);

            // Rostered AgentIdentity present in `--target-graph-db` succeeds and normalizes bare handle.
            const customTargetWalDir = path.join(sandbox, 'custom-target-wal');
            const customReceipt      = await promoteStandaloneWal({
                sourceWalDir,
                targetWalDir : customTargetWalDir,
                owner        : 'custom-team-seat',
                targetGraphDb: customDbPath
            });

            expect(customReceipt).toEqual({
                promotedCount        : 1,
                skippedDuplicateCount: 0,
                segmentsTouched      : ['2026-11-15'],
                owner                : '@custom-team-seat',
                userId               : 'custom-team-seat'
            });
        } finally {
            fs.rmSync(sandbox, {recursive: true, force: true});
        }
    });

    test('AC-2: merges same-day UTC segments without clobbering existing plane records, filters --workspace, preserves standalone planeId, writes zero markers, and is idempotent on re-run', async () => {
        const sandbox            = makeTempDir('mc-promote-ac2-');
        const fakeHome           = path.join(sandbox, 'home');
        const defaultWalDir      = path.join(fakeHome, '.neo-ai', 'memory-core', 'wal');
        const targetWalDir       = path.join(sandbox, 'plane-wal');
        const fixtureGraphDbPath = path.join(sandbox, 'plane-graph.sqlite');
        const workspaceRepoDir   = path.join(sandbox, 'checkout-brain');
        fs.mkdirSync(workspaceRepoDir, {recursive: true});

        try {
            createCustomGraphDb(fixtureGraphDbPath, [
                {id: '@neo-gemini-julia', label: 'AgentIdentity'},
                {id: '@neo-opus-grace', label: 'AgentIdentity'}
            ]);

            // Seed standalone WAL in default `<homedir>/.neo-ai/memory-core/wal` across two workspaces.
            await appendWalMemory(
                buildStandaloneRecord({
                    id       : 'mem-brain-1',
                    timestamp: DAY_UTC + 1000,
                    workspace: 'github.com/neomjs/neo-agent-brain',
                    sessionId: 'sess-brain-a'
                }),
                {dir: defaultWalDir, planeId: DEFAULT_STANDALONE_PLANE_ID}
            );
            await appendWalMemory(
                buildStandaloneRecord({
                    id       : 'mem-other-ws',
                    timestamp: DAY_UTC + 2000,
                    workspace: 'github.com/neomjs/neo',
                    sessionId: 'sess-neo-b'
                }),
                {dir: defaultWalDir, planeId: DEFAULT_STANDALONE_PLANE_ID}
            );
            await appendWalMemory(
                buildStandaloneRecord({
                    id       : 'mem-brain-2',
                    timestamp: DAY_UTC + 3000,
                    workspace: 'github.com/neomjs/neo-agent-brain',
                    sessionId: 'sess-brain-a'
                }),
                {dir: defaultWalDir, planeId: DEFAULT_STANDALONE_PLANE_ID}
            );

            // Pre-populate target plane WAL in the SAME `wal-2026-11-15.jsonl` segment.
            await appendWalMemory(
                {
                    id       : 'existing-plane-turn-0',
                    timestamp: DAY_UTC,
                    metadata : {
                        prompt       : 'Existing full-plane memory',
                        thought      : 'Written directly by full Agent OS plane',
                        response     : 'Must stay byte-identical on promotion merge',
                        sessionId    : 'sess-plane-0',
                        timestamp    : DAY_UTC,
                        type         : 'agent-interaction',
                        agentIdentity: '@neo-opus-grace',
                        userId       : 'neo-opus-grace'
                    },
                    document              : 'User Prompt: Existing full-plane memory\nAgent Thought: Written directly by full Agent OS plane\nAgent Response: Must stay byte-identical on promotion merge',
                    graphProjectionVersion: 1,
                    graphProjection       : {
                        requestIdentity : '@neo-opus-grace',
                        memoryProperties: {
                            agentIdentity: '@neo-opus-grace',
                            userId       : 'neo-opus-grace',
                            sessionId    : 'sess-plane-0',
                            timestamp    : new Date(DAY_UTC).toISOString()
                        }
                    }
                },
                {dir: targetWalDir, planeId: 'neo-local-canonical'}
            );

            const targetSegmentPath = path.join(targetWalDir, getWalRecordsFileName('2026-11-15'));
            const originalFirstLine = fs.readFileSync(targetSegmentPath, 'utf8').trimEnd();

            // Promote using default sourceWalDir (`homedir`) and filesystem-path `--workspace` resolved via git remote.
            const firstRun = await promoteStandaloneWal({
                homedir      : fakeHome,
                targetWalDir,
                targetGraphDb: fixtureGraphDbPath,
                owner        : 'neo-gemini-julia',
                workspace    : workspaceRepoDir,
                execGit      : args => args.includes('get-url') ? 'git@github.com:NeoMJS/Neo-Agent-Brain.git' : null
            });

            expect(firstRun).toEqual({
                promotedCount        : 2,
                skippedDuplicateCount: 0,
                segmentsTouched      : ['2026-11-15'],
                owner                : '@neo-gemini-julia',
                userId               : 'neo-gemini-julia',
                workspace            : 'github.com/neomjs/neo-agent-brain'
            });

            // Marker files MUST NOT be created or touched by promotion.
            const targetFiles = fs.readdirSync(targetWalDir);
            expect(targetFiles).toEqual(['wal-2026-11-15.jsonl']);
            expect(targetFiles.some(name => name.endsWith('.embedded.jsonl'))).toBe(false);
            expect(targetFiles.some(name => name.endsWith('.graph.jsonl'))).toBe(false);

            const mergedLines = fs.readFileSync(targetSegmentPath, 'utf8').trimEnd().split('\n');
            expect(mergedLines).toHaveLength(3);
            // Existing plane record preserved byte-for-byte!
            expect(mergedLines[0]).toBe(originalFirstLine);

            const promotedRecords = mergedLines.slice(1).map(line => JSON.parse(line));
            expect(promotedRecords.map(rec => rec.id)).toEqual(['mem-brain-1', 'mem-brain-2']);

            for (const rec of promotedRecords) {
                expect(rec.planeId).toBe(DEFAULT_STANDALONE_PLANE_ID);
                expect(rec.agentIdentity).toBe('@neo-gemini-julia');
                expect(rec.userId).toBe('neo-gemini-julia');
                expect(rec.workspace).toBe('github.com/neomjs/neo-agent-brain');
                expect(rec.metadata.agentIdentity).toBe('@neo-gemini-julia');
                expect(rec.metadata.userId).toBe('neo-gemini-julia');
                expect(rec.metadata.planeId).toBe(DEFAULT_STANDALONE_PLANE_ID);
                expect(rec.metadata.agent).toBe('codex-cli');
                expect(rec.graphProjectionVersion).toBe(1);
                expect(rec.graphProjection).toMatchObject({
                    requestIdentity : '@neo-gemini-julia',
                    memoryProperties: {
                        agentIdentity: '@neo-gemini-julia',
                        userId       : 'neo-gemini-julia',
                        planeId      : DEFAULT_STANDALONE_PLANE_ID,
                        sessionId    : 'sess-brain-a',
                        workspace    : 'github.com/neomjs/neo-agent-brain'
                    }
                });
            }

            const snapshotAfterFirstRun = fs.readFileSync(targetSegmentPath, 'utf8');

            // Re-run with identical inputs: 100% idempotent, 0 writes, 0 touched segments.
            const secondRun = await promoteStandaloneWal({
                homedir      : fakeHome,
                targetWalDir,
                targetGraphDb: fixtureGraphDbPath,
                owner        : '@neo-gemini-julia',
                workspace    : 'github.com/neomjs/neo-agent-brain'
            });

            expect(secondRun).toEqual({
                promotedCount        : 0,
                skippedDuplicateCount: 2,
                segmentsTouched      : [],
                owner                : '@neo-gemini-julia',
                userId               : 'neo-gemini-julia',
                workspace            : 'github.com/neomjs/neo-agent-brain'
            });
            expect(fs.readFileSync(targetSegmentPath, 'utf8')).toBe(snapshotAfterFirstRun);
        } finally {
            fs.rmSync(sandbox, {recursive: true, force: true});
        }
    });

    test('AC-3: runs `neo-memory-core promote` CLI end-to-end and enforces `@me` owner visibility vs cross-tenant RLS isolation on projected AGENT_MEMORY nodes', async () => {
        const GraphService  = (await import('../../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        const MemoryService = (await import('../../../../../../../ai/services/memory-core/MemoryService.mjs')).default;

        const originalDb = GraphService.db;
        const requester  = {value: null};
        const sandbox    = makeTempDir('mc-promote-ac3-');

        try {
            const sourceWalDir    = path.join(sandbox, 'standalone-wal');
            const targetWalDir    = path.join(sandbox, 'plane-wal');
            const badTargetWalDir = path.join(sandbox, 'bad-plane-wal');
            const cliGraphDbPath  = path.join(sandbox, 'cli-plane-graph.sqlite');
            const promotedId      = 'mem-cli-promoted-1717';

            createCustomGraphDb(cliGraphDbPath, [
                {id: '@neo-gemini-julia', label: 'AgentIdentity'},
                {id: '@neo-opus-ada', label: 'AgentIdentity'}
            ]);

            // Verify CLI argument parser supports both `--flag value` and `--flag=value` forms for promote.
            expect(parseStandaloneArgs([
                'promote',
                '--target-wal-dir=/tmp/target',
                '--source-wal-dir', '/tmp/source',
                '--owner=neo-gemini-julia',
                '--target-graph-db', '/tmp/graph.sqlite',
                '--user-id=neo-gemini-julia',
                '--workspace=github.com/neomjs/neo-agent-brain'
            ])).toMatchObject({
                mode         : 'promote',
                targetWalDir : '/tmp/target',
                sourceWalDir : '/tmp/source',
                owner        : 'neo-gemini-julia',
                targetGraphDb: '/tmp/graph.sqlite',
                userId       : 'neo-gemini-julia',
                workspace    : 'github.com/neomjs/neo-agent-brain'
            });

            // Verify `neo-memory-core promote --help` exits 0 and documents required promote flags.
            const helpRun = spawnSync(process.execPath, [STANDALONE_BIN, 'promote', '--help'], {
                cwd     : REPO_ROOT,
                encoding: 'utf8'
            });
            expect(helpRun.status).toBe(0);
            expect(helpRun.stdout).toContain('neo-memory-core promote --target-wal-dir <dir> --target-graph-db <path> --owner <agentIdentity> [options]');
            expect(helpRun.stdout).toContain('--target-graph-db <path>');
            expect(helpRun.stdout).toContain('(required)');

            await appendWalMemory(
                buildStandaloneRecord({
                    id       : promotedId,
                    timestamp: DAY_UTC + 5000,
                    workspace: 'github.com/neomjs/neo-agent-brain',
                    sessionId: 'sess-cli-promote'
                }),
                {dir: sourceWalDir, planeId: DEFAULT_STANDALONE_PLANE_ID}
            );

            // Missing `--target-graph-db` via CLI exits 1 naming `--target-graph-db` and writes nothing to `badTargetWalDir`.
            const missingGraphCli = spawnSync(
                process.execPath,
                [
                    STANDALONE_BIN,
                    'promote',
                    '--source-wal-dir', sourceWalDir,
                    '--target-wal-dir', badTargetWalDir,
                    '--owner', 'neo-gemini-julia'
                ],
                {cwd: REPO_ROOT, encoding: 'utf8'}
            );
            expect(missingGraphCli.status).toBe(1);
            expect(missingGraphCli.stderr).toContain('--target-graph-db');
            expect(fs.existsSync(badTargetWalDir)).toBe(false);

            // Unrostered `--owner` via CLI exits 1 naming `not a rostered AgentIdentity` and writes nothing to `badTargetWalDir`.
            const rejectedCli = spawnSync(
                process.execPath,
                [
                    STANDALONE_BIN,
                    'promote',
                    '--source-wal-dir', sourceWalDir,
                    '--target-wal-dir', badTargetWalDir,
                    '--target-graph-db', cliGraphDbPath,
                    '--owner', '@unrostered-outsider'
                ],
                {cwd: REPO_ROOT, encoding: 'utf8'}
            );
            expect(rejectedCli.status).toBe(1);
            expect(rejectedCli.stderr).toContain('not a rostered AgentIdentity');
            expect(fs.existsSync(badTargetWalDir)).toBe(false);

            // Rostered `--owner` with `--target-graph-db` via CLI exits 0 and emits JSON receipt on stdout.
            const okCli = spawnSync(
                process.execPath,
                [
                    STANDALONE_BIN,
                    'promote',
                    '--source-wal-dir', sourceWalDir,
                    '--target-wal-dir', targetWalDir,
                    '--target-graph-db', cliGraphDbPath,
                    '--owner', 'neo-gemini-julia'
                ],
                {cwd: REPO_ROOT, encoding: 'utf8'}
            );
            expect(okCli.status).toBe(0);
            const cliReceipt = JSON.parse(okCli.stdout.trim());
            expect(cliReceipt).toEqual({
                promotedCount        : 1,
                skippedDuplicateCount: 0,
                segmentsTouched      : ['2026-11-15'],
                owner                : '@neo-gemini-julia',
                userId               : 'neo-gemini-julia'
            });

            // Also verify in-process `runPromoteCli` idempotent re-run emits JSON receipt cleanly.
            let capturedStdout = '';
            await runPromoteCli(
                parseStandaloneArgs([
                    'promote',
                    `--source-wal-dir=${sourceWalDir}`,
                    `--target-wal-dir=${targetWalDir}`,
                    `--target-graph-db=${cliGraphDbPath}`,
                    '--owner=@neo-gemini-julia'
                ]),
                {stdout: {write: chunk => { capturedStdout += chunk; }}}
            );
            expect(JSON.parse(capturedStdout.trim())).toMatchObject({
                promotedCount        : 0,
                skippedDuplicateCount: 1,
                segmentsTouched      : []
            });

            // Prior to graph projection marker append, both graph and embed pending WAL readers surface the promoted record!
            const graphPendingBefore = await readPendingWalRecords({dir: targetWalDir, markerType: 'graph'});
            const embedPendingBefore = await readPendingWalRecords({dir: targetWalDir, markerType: 'embed'});
            expect(graphPendingBefore).toHaveLength(1);
            expect(embedPendingBefore).toHaveLength(1);

            const promotedRecord = graphPendingBefore[0];
            expect(promotedRecord.id).toBe(promotedId);
            expect(promotedRecord.planeId).toBe(DEFAULT_STANDALONE_PLANE_ID);
            expect(promotedRecord.graphProjectionVersion).toBe(1);

            // Project into GraphService using MemoryService's real WAL projection helpers + B4-safe fake topology DB.
            GraphService.db = makeTopologyDb(requester);
            GraphService.upsertGlobalNode({id: 'frontier', type: 'SYSTEM_ANCHOR', name: 'Frontier'});
            GraphService.upsertGlobalNode({id: '@neo-gemini-julia', type: 'AgentIdentity', name: 'Julia'});
            GraphService.upsertGlobalNode({id: '@neo-opus-ada', type: 'AgentIdentity', name: 'Ada'});

            const projectionOpts = MemoryService.constructor.prototype._graphProjectionOptionsFromWalRecord.call(
                MemoryService,
                promotedRecord
            );
            await MemoryService._projectMemoryToGraph({
                ...projectionOpts,
                walDir: targetWalDir
            });

            // Graph marker is now written; embed marker remains untouched awaiting embed drain.
            expect(await readPendingWalRecords({dir: targetWalDir, markerType: 'graph'})).toEqual([]);
            expect((await readPendingWalRecords({dir: targetWalDir, markerType: 'embed'})).map(r => r.id)).toEqual([promotedId]);

            // 1. `@me` owner (`@neo-gemini-julia`) sees the projected AGENT_MEMORY node, its properties, and its AUTHORED_BY edge!
            requester.value = '@neo-gemini-julia';

            const ownerNode = GraphService.getNode({id: promotedId});
            expect(ownerNode).not.toBeNull();
            expect(ownerNode.id).toBe(promotedId);
            expect(ownerNode.type).toBe('AGENT_MEMORY');

            const ownerRecord = GraphService.getNodeRecord({id: promotedId});
            expect(ownerRecord).not.toBeNull();
            expect(ownerRecord.properties).toMatchObject({
                agentIdentity: '@neo-gemini-julia',
                userId       : 'neo-gemini-julia',
                planeId      : DEFAULT_STANDALONE_PLANE_ID,
                sessionId    : 'sess-cli-promote',
                workspace    : 'github.com/neomjs/neo-agent-brain'
            });

            const outboundNeighbors = GraphService.getNeighbors({id: promotedId, direction: 'outbound'}).neighbors;
            expect(outboundNeighbors.some(n => n.id === '@neo-gemini-julia' && n.relationship === 'AUTHORED_BY')).toBe(true);

            // 2. Second rostered identity (`@neo-opus-ada`) is denied by `GraphService#isRlsVisible`!
            requester.value = '@neo-opus-ada';
            expect(GraphService.getNode({id: promotedId})).toBeNull();
            expect(GraphService.getNodeRecord({id: promotedId})).toBeNull();

            // 3. Unauthenticated null requester is also denied!
            requester.value = null;
            expect(GraphService.getNode({id: promotedId})).toBeNull();
            expect(GraphService.getNodeRecord({id: promotedId})).toBeNull();
        } finally {
            GraphService.db = originalDb;
            requester.value = null;
            fs.rmSync(sandbox, {recursive: true, force: true});
        }
    });
});
