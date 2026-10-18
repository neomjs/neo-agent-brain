import {setup} from '../../../../setup.mjs';

const appName = 'RenameAgentIdentitiesMigrationTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}                         from '@playwright/test';
import Database                               from 'better-sqlite3';
import {spawnSync}                            from 'node:child_process';
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import path                                   from 'node:path';
import Neo                                    from 'neo.mjs/src/Neo.mjs';
import * as core                              from 'neo.mjs/src/core/_export.mjs';
import {
    findChromaMetadataUpdates,
    rewriteIdentityFields,
    rewriteIdentityString,
    rewriteNodeId,
    runGraphMigration
} from '../../../../../../ai/scripts/migrations/renameAgentIdentities.mjs';
import {
    createEmbodiedEpisodeNode,
    createIdentityStateNode,
    validateEraChain
} from '../../../../../../ai/graph/identitySchema.mjs';

/**
 * @summary Creates the SQLite graph schema the identity rename runner migrates, with the production
 * `Edges` foreign keys (`ai/graph/storage/SQLite.mjs`: `REFERENCES Nodes(id) ON DELETE CASCADE`, no
 * `ON UPDATE`) and enforcement on, so a re-key that updates a connected row's primary key fails here
 * the way it fails on the plane.
 * @param {Object} db Open better-sqlite3 connection.
 */
function createGraphSchema(db) {
    db.exec(`
        CREATE TABLE Nodes (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            data TEXT NOT NULL
        );
        CREATE TABLE Edges (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            source TEXT NOT NULL,
            target TEXT NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL,
            FOREIGN KEY (source) REFERENCES Nodes(id) ON DELETE CASCADE,
            FOREIGN KEY (target) REFERENCES Nodes(id) ON DELETE CASCADE
        );
    `);
    db.pragma('foreign_keys = ON');
}

/**
 * @summary Inserts one graph node fixture into the in-memory database.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Object} node Node row.
 */
function insertNode(db, node) {
    db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, ?, ?)')
        .run(node.id, node.user_id || null, JSON.stringify(node.data));
}

/**
 * @summary Inserts one graph edge fixture into the in-memory database.
 * @param {Object} db Open better-sqlite3 connection.
 * @param {Object} edge Edge row.
 */
function insertEdge(db, edge) {
    db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(edge.id, edge.user_id || null, edge.source, edge.target, edge.type, JSON.stringify(edge.data));
}

/**
 * @summary Returns a POSIX-style path relative to the repository root.
 * @param {String} repoRoot Absolute repository root.
 * @param {String} filePath Absolute file path.
 * @returns {String} Repository-relative path.
 */
function getRelativePath(repoRoot, filePath) {
    return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

/**
 * @summary Determines whether a repository-relative path is outside the current-contract scan.
 * @param {String} relativePath Repository-relative path.
 * @returns {Boolean} True when the path should be skipped.
 */
function isExcludedPath(relativePath) {
    return [
        'resources/content/',
        'learn/agentos/incidents/',
        'learn/agentos/measurements/',
        'learn/agentos/decisions/',
        'node_modules/',
        'dist/'
    ].some(prefix => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

/**
 * @summary Scans selected repository paths for stale versioned identity handles.
 * @param {String} repoRoot Absolute repository root.
 * @param {String[]} entries Repository-relative files or directories to scan.
 * @param {RegExp} pattern Pattern to find.
 * @returns {String[]} Repository-relative files containing the pattern.
 */
function findFilesContaining(repoRoot, entries, pattern) {
    const matches = [];

    const visit = (filePath) => {
        const relativePath = getRelativePath(repoRoot, filePath);
        if (isExcludedPath(relativePath)) return;

        const stat = lstatSync(filePath);
        if (stat.isDirectory()) {
            for (const entry of readdirSync(filePath)) {
                visit(path.join(filePath, entry));
            }
            return;
        }
        if (!stat.isFile()) return;

        try {
            if (pattern.test(readFileSync(filePath, 'utf8'))) {
                matches.push(relativePath);
            }
        } catch (e) {
            // Non-text files inside broad roots are irrelevant to this identity-contract guard.
        }
    };

    for (const entry of entries) {
        visit(path.join(repoRoot, entry));
    }

    return matches;
}

test.describe('migration CLIs — fresh-process bootstrap contract', () => {
    test('both --help commands exit 0 with usage output in a BARE process — no Neo bootstrap, no Chroma/SQLite access', () => {
        // The load-bearing regression: Playwright preloads Neo/core before importing these
        // modules, so an in-process import can pass while the real CLI dies on the missing
        // runtime global. Only a spawned fresh process proves the standalone entrypoint contract.
        const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../..');

        for (const script of ['ai/scripts/migrations/renameAgentIdentities.mjs', 'ai/scripts/migrations/backfillChromaSharedUserId.mjs']) {
            const result = spawnSync(process.execPath, [script, '--help'], {cwd: repoRoot, encoding: 'utf-8', timeout: 30_000});

            expect(result.status, `${script} --help must exit 0 (stderr: ${result.stderr})`).toBe(0);
            expect(result.stdout).toContain('Usage:');
        }
    });
});

test.describe('ai/scripts/migrations/renameAgentIdentities', () => {
    test('stale versioned handles are confined to the migration runner and its fixtures', () => {
        const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../..');
        const output   = findFilesContaining(repoRoot, [
            'ai',
            '.github',
            'README.md',
            'learn',
            'test/playwright/unit/ai/mcp/server/shared/services/RequestContextService.spec.mjs',
            'test/playwright/unit/ai/scripts/lifecycle/resumeHarness.spec.mjs',
            'test/playwright/unit/ai/scripts/migrations/renameAgentIdentities.spec.mjs'
        ], /neo-opus-4-7|neo-gemini-3-1-pro|neo_opus_4_7|neo_gemini_3_1_pro/);

        const allowed = new Set([
            'ai/scripts/migrations/renameAgentIdentities.mjs',
            'test/playwright/unit/ai/scripts/migrations/renameAgentIdentities.spec.mjs',
            // The co-author roster carries `neo-opus-4-7@` and `neo-gemini-3-1-pro@` as live COMMIT
            // ADDRESSES, not as stale handles. They are observed in `origin/dev` history and are the
            // reason that module exists: two of the three logins whose email local part does NOT
            // match the login, so the mapping cannot be computed and a rename cannot rewrite them
            // without mis-crediting an account. Renaming these strings would reintroduce the exact
            // defect the file documents — 19 commits credited to an address nobody owns.
            //
            // It appears here only as of the engine/Brain Class B relocation: the file moved from
            // `buildScripts/util/` (outside every scan root above) into `ai/graph/`, beside the
            // registry it is keyed to. The guard
            // did not change and was not weakened — the relocation moved a real occurrence out of a
            // blind spot and into its view, which is the guard working, so it is allowlisted with
            // its reason rather than silenced.
            'ai/graph/agentCoAuthorEmails.mjs'
        ]);
        const unexpected = output
            .filter(file => !allowed.has(file));

        expect(unexpected).toEqual([]);
    });

    test('rewrites identity metadata without rewriting message/document prose', () => {
        const source = {
            id        : '@neo-opus-4-7',
            label     : 'MESSAGE',
            properties: {
                agentIdentity        : '@neo-opus-4-7',
                bodyText             : 'historical body mentions @neo-opus-4-7',
                participatingAgents  : '@neo-opus-4-7, @neo-gemini-3-1-pro',
                requiredGithubLogin  : '@neo-gemini-3-1-pro',
                sourceAgentIdentities: ['@neo-opus-4-7', '@neo-opus-vega'],
                subject              : 'historical subject mentions @neo-gemini-3-1-pro',
                userId               : 'neo-opus-4-7'
            }
        };

        const result = rewriteIdentityFields(source);

        expect(result.id).toBe('@neo-opus-ada');
        expect(result.properties.agentIdentity).toBe('@neo-opus-ada');
        // A chain resolves to its last handle in one pass: 3-1-pro → pro → julia.
        expect(result.properties.participatingAgents).toBe('@neo-opus-ada, @neo-gemini-julia');
        expect(result.properties.requiredGithubLogin).toBe('@neo-gemini-julia');
        expect(result.properties.sourceAgentIdentities).toEqual(['@neo-opus-ada', '@neo-opus-vega']);
        expect(result.properties.userId).toBe('neo-opus-ada');

        // Historical prose is intentionally preserved; only identity-keyed metadata changes.
        expect(result.properties.bodyText).toBe('historical body mentions @neo-opus-4-7');
        expect(result.properties.subject).toBe('historical subject mentions @neo-gemini-3-1-pro');
    });

    test('merges old graph identity nodes, rewrites edges, drops duplicate edges, and preserves createdAt', () => {
        const db = new Database(':memory:');
        createGraphSchema(db);

        insertNode(db, {
            id     : '@neo-opus-4-7',
            user_id: 'neo-opus-4-7',
            data   : {
                id        : '@neo-opus-4-7',
                label     : 'AgentIdentity',
                properties: {
                    createdAt  : '2026-01-01T00:00:00.000Z',
                    githubLogin: '@neo-opus-4-7',
                    userId     : 'neo-opus-4-7'
                }
            }
        });
        insertNode(db, {
            id     : '@neo-opus-ada',
            user_id: 'neo-opus-ada',
            data   : {
                id        : '@neo-opus-ada',
                label     : 'AgentIdentity',
                properties: {
                    createdAt  : '2026-06-05T00:00:00.000Z',
                    githubLogin: '@neo-opus-ada',
                    userId     : 'neo-opus-ada'
                }
            }
        });
        insertNode(db, {
            id  : '@neo-opus-vega',
            data: {
                id        : '@neo-opus-vega',
                label     : 'AgentIdentity',
                properties: {githubLogin: '@neo-opus-vega'}
            }
        });
        insertNode(db, {
            id     : 'MESSAGE:1',
            user_id: 'neo-opus-4-7',
            data   : {
                id        : 'MESSAGE:1',
                label     : 'MESSAGE',
                properties: {
                    bodyText: 'history keeps @neo-opus-4-7 in prose',
                    sentBy  : '@neo-opus-4-7',
                    userId  : 'neo-opus-4-7'
                }
            }
        });

        insertEdge(db, {
            id     : 'edge-old-duplicate',
            user_id: 'neo-opus-4-7',
            source : '@neo-opus-4-7',
            target : '@neo-opus-vega',
            type   : 'SENT_TO',
            data   : {
                id        : 'edge-old-duplicate',
                source    : '@neo-opus-4-7',
                target    : '@neo-opus-vega',
                type      : 'SENT_TO',
                properties: {userId: 'neo-opus-4-7'}
            }
        });
        insertEdge(db, {
            id    : 'edge-canonical-duplicate',
            source: '@neo-opus-ada',
            target: '@neo-opus-vega',
            type  : 'SENT_TO',
            data  : {
                id        : 'edge-canonical-duplicate',
                source    : '@neo-opus-ada',
                target    : '@neo-opus-vega',
                type      : 'SENT_TO',
                properties: {userId: 'neo-opus-ada'}
            }
        });
        insertEdge(db, {
            id     : 'edge-inbound',
            user_id: 'neo-opus-4-7',
            source : '@neo-opus-vega',
            target : '@neo-opus-4-7',
            type   : 'MENTIONS',
            data   : {
                id        : 'edge-inbound',
                source    : '@neo-opus-vega',
                target    : '@neo-opus-4-7',
                type      : 'MENTIONS',
                properties: {
                    bodyText: 'edge prose keeps @neo-opus-4-7',
                    userId  : 'neo-opus-4-7'
                }
            }
        });

        const dryRunStats = runGraphMigration(db, false);
        expect(dryRunStats.nodesMerged).toBe(1);
        expect(dryRunStats.edgesDropped).toBe(1);
        expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('@neo-opus-4-7')).toBeTruthy();

        const stats = runGraphMigration(db, true);
        expect(stats.nodesMerged).toBe(1);
        expect(stats.nodesDeleted).toBe(1);
        expect(stats.edgesDropped).toBe(1);
        expect(stats.edgesRewritten).toBe(1);

        expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('@neo-opus-4-7')).toBeUndefined();

        const canonical = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get('@neo-opus-ada').data);
        expect(canonical.properties.githubLogin).toBe('@neo-opus-ada');
        expect(canonical.properties.createdAt).toBe('2026-01-01T00:00:00.000Z');

        expect(db.prepare('SELECT id FROM Edges WHERE id = ?').get('edge-old-duplicate')).toBeUndefined();

        const inbound = db.prepare('SELECT user_id, source, target, data FROM Edges WHERE id = ?').get('edge-inbound');
        expect(inbound.user_id).toBe('neo-opus-ada');
        expect(inbound.source).toBe('@neo-opus-vega');
        expect(inbound.target).toBe('@neo-opus-ada');

        const inboundData = JSON.parse(inbound.data);
        expect(inboundData.target).toBe('@neo-opus-ada');
        expect(inboundData.properties.userId).toBe('neo-opus-ada');
        expect(inboundData.properties.bodyText).toBe('edge prose keeps @neo-opus-4-7');

        const message = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get('MESSAGE:1');
        expect(message.user_id).toBe('neo-opus-ada');

        const messageData = JSON.parse(message.data);
        expect(messageData.properties.sentBy).toBe('@neo-opus-ada');
        expect(messageData.properties.userId).toBe('neo-opus-ada');
        expect(messageData.properties.bodyText).toBe('history keeps @neo-opus-4-7 in prose');

        db.close();
    });

    test('findChromaMetadataUpdates rewrites metadata only', async () => {
        const collection = {
            async get({offset}) {
                if (offset > 0) {
                    return {ids: [], metadatas: []};
                }
                return {
                    ids      : ['memory-1', 'memory-2'],
                    metadatas: [
                        {
                            bodyText           : 'document prose keeps @neo-gemini-3-1-pro',
                            participatingAgents: '@neo-opus-4-7,@neo-gpt',
                            userId             : 'neo-opus-4-7'
                        },
                        {
                            participatingAgents: '@neo-opus-vega',
                            userId             : 'neo-opus-vega'
                        }
                    ]
                };
            }
        };

        const result = await findChromaMetadataUpdates(collection);

        expect(result.scanned).toBe(2);
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0]).toEqual({
            id      : 'memory-1',
            metadata: {
                bodyText           : 'document prose keeps @neo-gemini-3-1-pro',
                participatingAgents: '@neo-opus-ada,@neo-gpt-euclid',
                userId             : 'neo-opus-ada'
            }
        });
    });

    test('first-seat pairs rewrite whole handles once: no prefix chaining, siblings and addresses stay, chains resolve, a second pass is a no-op', () => {
        const cases = [
            ['@neo-fable',                        '@neo-fable-mnemosyne'],
            ['neo-fable',                         'neo-fable-mnemosyne'],
            ['@neo-gpt',                          '@neo-gpt-euclid'],
            ['@neo-gemini-pro',                   '@neo-gemini-julia'],
            ['@neo-gemini-3-1-pro',               '@neo-gemini-julia'],
            ['neo-gemini-3-1-pro',                'neo-gemini-julia'],
            ['@neo-fable-clio',                   '@neo-fable-clio'],
            ['@neo-gpt-emmy',                     '@neo-gpt-emmy'],
            ['neo-gpt-sophie',                    'neo-gpt-sophie'],
            ['neo-gemini-maryam',                 'neo-gemini-maryam'],
            ['@neo-fable-mnemosyne',              '@neo-fable-mnemosyne'],
            ['neo-fable@neomjs.com',              'neo-fable@neomjs.com'],
            ['AGENT:@neo-gpt',                    'AGENT:@neo-gpt-euclid'],
            ['identity-state-@neo-fable',         'identity-state-@neo-fable-mnemosyne'],
            ['@neo-opus-4-7, @neo-gpt',           '@neo-opus-ada, @neo-gpt-euclid'],
            ['@neo-gemini-pro,@neo-fable-clio',   '@neo-gemini-julia,@neo-fable-clio'],
            ['@agent-neo-gpt',                    '@agent-neo-gpt']
        ];

        for (const [input, expected] of cases) {
            const once = rewriteIdentityString(input);
            expect(once, input).toBe(expected);
            expect(rewriteIdentityString(once), `second pass over ${once}`).toBe(expected);
        }
    });

    test('a first seat moves once through the graph: node, edges and user_id follow, a sibling seat stays byte-identical, a second apply changes nothing', () => {
        const db = new Database(':memory:');
        createGraphSchema(db);

        insertNode(db, {
            id     : '@neo-gpt',
            user_id: 'neo-gpt',
            data   : {
                id        : '@neo-gpt',
                label     : 'AgentIdentity',
                properties: {createdAt: '2026-04-30T00:00:00.000Z', githubLogin: '@neo-gpt', userId: 'neo-gpt'}
            }
        });
        insertNode(db, {
            id     : '@neo-gpt-emmy',
            user_id: 'neo-gpt-emmy',
            data   : {
                id        : '@neo-gpt-emmy',
                label     : 'AgentIdentity',
                properties: {githubLogin: '@neo-gpt-emmy', userId: 'neo-gpt-emmy'}
            }
        });
        insertNode(db, {
            id     : 'MESSAGE:2',
            user_id: 'neo-gpt',
            data   : {
                id        : 'MESSAGE:2',
                label     : 'MESSAGE',
                properties: {
                    deliveredTo: ['@neo-gpt-emmy'],
                    sentBy     : '@neo-gpt',
                    subject    : 'Euclid (@neo-gpt) wrote this',
                    userId     : 'neo-gpt'
                }
            }
        });
        insertEdge(db, {
            id     : 'edge-first-seat',
            user_id: 'neo-gpt',
            source : '@neo-gpt',
            target : '@neo-gpt-emmy',
            type   : 'SENT_TO',
            data   : {
                id        : 'edge-first-seat',
                source    : '@neo-gpt',
                target    : '@neo-gpt-emmy',
                type      : 'SENT_TO',
                properties: {userId: 'neo-gpt'}
            }
        });

        const siblingBefore = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get('@neo-gpt-emmy');

        const first = runGraphMigration(db, true);
        expect(first).toMatchObject({nodesInserted: 1, nodesDeleted: 1, edgesRewritten: 1, duplicateCollisions: 0});

        expect(db.prepare('SELECT id FROM Nodes WHERE id = ?').get('@neo-gpt')).toBeUndefined();

        const renamed     = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get('@neo-gpt-euclid');
        const renamedData = JSON.parse(renamed.data);
        expect(renamed.user_id).toBe('neo-gpt-euclid');
        expect(renamedData.properties.githubLogin).toBe('@neo-gpt-euclid');
        expect(renamedData.properties.createdAt).toBe('2026-04-30T00:00:00.000Z');

        expect(db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get('@neo-gpt-emmy')).toEqual(siblingBefore);

        const edge = db.prepare('SELECT user_id, source, target, data FROM Edges WHERE id = ?').get('edge-first-seat');
        expect([edge.user_id, edge.source, edge.target]).toEqual(['neo-gpt-euclid', '@neo-gpt-euclid', '@neo-gpt-emmy']);
        expect(JSON.parse(edge.data).target).toBe('@neo-gpt-emmy');

        const message     = db.prepare('SELECT user_id, data FROM Nodes WHERE id = ?').get('MESSAGE:2');
        const messageData = JSON.parse(message.data);
        expect(message.user_id).toBe('neo-gpt-euclid');
        expect(messageData.properties.sentBy).toBe('@neo-gpt-euclid');
        expect(messageData.properties.deliveredTo).toEqual(['@neo-gpt-emmy']);
        expect(messageData.properties.subject).toBe('Euclid (@neo-gpt) wrote this');

        const second = runGraphMigration(db, true);
        expect(second).toMatchObject({
            duplicateCollisions    : 0,
            edgeMetadataRowsUpdated: 0,
            edgesDropped           : 0,
            edgesRekeyed           : 0,
            edgesRewritten         : 0,
            nodeMetadataRowsUpdated: 0,
            nodesDeleted           : 0,
            nodesInserted          : 0,
            nodesMerged            : 0,
            nodesRekeyed           : 0
        });

        db.close();
    });

    test('era-chain rows re-key with their JSON ids and edge endpoints, the anchor follows, and a second apply is a no-op', () => {
        // Euclid's falsifier on the first head: a schema-valid IdentityState + EmbodiedEpisode pair
        // kept its SQLite ids while the JSON ids and the anchor moved, and the edge pointed nowhere.
        const db = new Database(':memory:');
        createGraphSchema(db);

        const state   = createIdentityStateNode({identityKey: '@neo-gpt', socialLayer: {name: 'Euclid'}}).node;
        const episode = createEmbodiedEpisodeNode({identityKey: '@neo-gpt', model: 'GPT-5.5', family: 'gpt', since: '2026-01-01T00:00:00Z'}).node;
        const edgeId  = `HAS_EPISODE:${state.id}:${episode.id}`;

        expect(episode.id).toBe('embodied-episode-@neo-gpt-2026-01-01T00:00:00Z');
        expect(rewriteNodeId(episode.id)).toBe('embodied-episode-@neo-gpt-euclid-2026-01-01T00:00:00Z');
        expect(rewriteNodeId('embodied-episode-@neo-opus-4-7-2026-05-01T00:00:00.000Z')).toBe('embodied-episode-@neo-opus-ada-2026-05-01T00:00:00.000Z');

        insertNode(db, {id: '@neo-gpt', user_id: 'neo-gpt', data: {id: '@neo-gpt', label: 'AgentIdentity', properties: {githubLogin: '@neo-gpt', userId: 'neo-gpt'}}});
        insertNode(db, {id: state.id,   user_id: 'neo-gpt', data: state});
        insertNode(db, {id: episode.id, user_id: 'neo-gpt', data: episode});
        insertEdge(db, {
            id     : edgeId,
            user_id: 'neo-gpt',
            source : state.id,
            target : episode.id,
            type   : 'HAS_EPISODE',
            data   : {id: edgeId, source: state.id, target: episode.id, type: 'HAS_EPISODE', properties: {}}
        });

        const first = runGraphMigration(db, true);
        expect(first).toMatchObject({nodesRekeyed: 2, edgesRekeyed: 1, duplicateCollisions: 0});

        const stateRow   = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get('identity-state-@neo-gpt-euclid');
        const episodeRow = db.prepare('SELECT id, user_id, data FROM Nodes WHERE id = ?').get('embodied-episode-@neo-gpt-euclid-2026-01-01T00:00:00Z');
        expect(stateRow, 'the state row is re-keyed').toBeTruthy();
        expect(episodeRow, 'the episode row is re-keyed').toBeTruthy();
        expect(db.prepare('SELECT id FROM Nodes WHERE id IN (?, ?)').all(state.id, episode.id)).toEqual([]);

        const stateData   = JSON.parse(stateRow.data);
        const episodeData = JSON.parse(episodeRow.data);
        expect([stateData.id, episodeData.id]).toEqual([stateRow.id, episodeRow.id]);
        expect([stateData.identityKey, episodeData.identityKey]).toEqual(['@neo-gpt-euclid', '@neo-gpt-euclid']);
        expect([stateRow.user_id, episodeRow.user_id]).toEqual(['neo-gpt-euclid', 'neo-gpt-euclid']);
        expect(validateEraChain(stateData, [episodeData]).valid).toBe(true);

        const edge     = db.prepare('SELECT id, source, target, data FROM Edges').get();
        const edgeData = JSON.parse(edge.data);
        expect(edge.id).toBe(`HAS_EPISODE:${stateRow.id}:${episodeRow.id}`);
        expect([edge.source, edge.target]).toEqual([stateRow.id, episodeRow.id]);
        expect([edgeData.id, edgeData.source, edgeData.target]).toEqual([edge.id, stateRow.id, episodeRow.id]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM Edges e JOIN Nodes s ON s.id = e.source JOIN Nodes t ON t.id = e.target').get().n).toBe(1);

        const second = runGraphMigration(db, true);
        expect(second).toMatchObject({
            duplicateCollisions    : 0,
            edgeMetadataRowsUpdated: 0,
            edgesRekeyed           : 0,
            nodeMetadataRowsUpdated: 0,
            nodesRekeyed           : 0
        });
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

        db.close();
    });

    test('when old and new compound ids coexist, the old row merges into the surviving one: edges move, JSON mirrors SQL, keys hold, a second apply is a no-op', () => {
        // Sophie's falsifier on the third head: the node pass skipped the collision while the edge pass
        // still rewrote the JSON endpoint — a committed row with two names for its source.
        const db = new Database(':memory:');
        createGraphSchema(db);

        const oldState = createIdentityStateNode({identityKey: '@neo-gpt'}).node;
        const newState = createIdentityStateNode({identityKey: '@neo-gpt-euclid'}).node;
        const episode  = createEmbodiedEpisodeNode({identityKey: '@neo-gpt', model: 'GPT-5.5', family: 'gpt', since: '2026-01-01T00:00:00Z'}).node;
        const edgeId   = 'edge-state-episode';

        insertNode(db, {id: '@neo-gpt', user_id: 'neo-gpt', data: {id: '@neo-gpt', label: 'AgentIdentity', properties: {githubLogin: '@neo-gpt', userId: 'neo-gpt'}}});
        // The old row is older and carries a key the surviving row lacks; the surviving row's own values win.
        insertNode(db, {id: oldState.id, user_id: 'neo-gpt',        data: {...oldState, properties: {createdAt: '2026-01-01T00:00:00.000Z', note: 'from the old row', shared: 'old'}}});
        insertNode(db, {id: newState.id, user_id: 'neo-gpt-euclid', data: {...newState, properties: {createdAt: '2026-06-01T00:00:00.000Z', shared: 'new'}}});
        insertNode(db, {id: episode.id,  user_id: 'neo-gpt',        data: episode});
        insertEdge(db, {
            id     : edgeId,
            user_id: 'neo-gpt',
            source : oldState.id,
            target : episode.id,
            type   : 'HAS_EPISODE',
            data   : {id: edgeId, source: oldState.id, target: episode.id, type: 'HAS_EPISODE', properties: {}}
        });

        const first = runGraphMigration(db, true);
        expect(first).toMatchObject({nodesMerged: 1, nodesRekeyed: 1, duplicateCollisions: 0, edgesDropped: 0});

        const episodeNewId = 'embodied-episode-@neo-gpt-euclid-2026-01-01T00:00:00Z';
        expect(db.prepare('SELECT id FROM Nodes WHERE id IN (?, ?)').all(oldState.id, episode.id)).toEqual([]);
        expect(db.prepare('SELECT id FROM Nodes WHERE id IN (?, ?)').all(newState.id, episodeNewId)).toHaveLength(2);

        // The merge keeps the older age and the old row's extra key; the surviving row's values win.
        const survivor = JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get(newState.id).data);
        expect([survivor.id, survivor.identityKey]).toEqual([newState.id, '@neo-gpt-euclid']);
        expect(survivor.properties).toEqual({createdAt: '2026-01-01T00:00:00.000Z', note: 'from the old row', shared: 'new'});

        const edge     = db.prepare('SELECT user_id, source, target, data FROM Edges WHERE id = ?').get(edgeId);
        const edgeData = JSON.parse(edge.data);
        expect([edge.source, edge.target]).toEqual([newState.id, episodeNewId]);
        expect([edgeData.source, edgeData.target]).toEqual([newState.id, episodeNewId]);
        expect(edge.user_id).toBe('neo-gpt-euclid');
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM Edges e JOIN Nodes s ON s.id = e.source JOIN Nodes t ON t.id = e.target').get().n).toBe(1);

        const second = runGraphMigration(db, true);
        expect(second).toMatchObject({
            duplicateCollisions    : 0,
            edgeMetadataRowsUpdated: 0,
            edgesRekeyed           : 0,
            nodeMetadataRowsUpdated: 0,
            nodesMerged            : 0,
            nodesRekeyed           : 0
        });

        db.close();
    });

    test('an edge whose re-keyed id is already taken keeps its id and still takes its endpoints: one mapping for SQL id, JSON id and endpoints', () => {
        const db = new Database(':memory:');
        createGraphSchema(db);

        insertNode(db, {id: '@neo-gpt',       user_id: 'neo-gpt',       data: {id: '@neo-gpt',       label: 'AgentIdentity', properties: {githubLogin: '@neo-gpt',       userId: 'neo-gpt'}}});
        insertNode(db, {id: '@neo-opus-vega', user_id: 'neo-opus-vega', data: {id: '@neo-opus-vega', label: 'AgentIdentity', properties: {githubLogin: '@neo-opus-vega', userId: 'neo-opus-vega'}}});

        // Edge A's id re-keys onto edge B's existing id; distinct types and directions keep both through the
        // endpoint move, so only the ids collide.
        const edgeA = 'LINK:@neo-gpt:@neo-opus-vega';
        const edgeB = 'LINK:@neo-gpt-euclid:@neo-opus-vega';
        insertEdge(db, {id: edgeA, user_id: 'neo-gpt',       source: '@neo-gpt',       target: '@neo-opus-vega', type: 'SENT_TO',  data: {id: edgeA, source: '@neo-gpt',       target: '@neo-opus-vega', type: 'SENT_TO',  properties: {}}});
        insertEdge(db, {id: edgeB, user_id: 'neo-opus-vega', source: '@neo-opus-vega', target: '@neo-gpt',       type: 'MENTIONS', data: {id: edgeB, source: '@neo-opus-vega', target: '@neo-gpt',       type: 'MENTIONS', properties: {}}});

        const first = runGraphMigration(db, true);
        expect(first).toMatchObject({duplicateCollisions: 1, edgesRekeyed: 0, edgesDropped: 0});
        expect(first.skipped).toContain(`collision:${edgeA}→${edgeB}`);

        const a     = db.prepare('SELECT id, user_id, source, target, data FROM Edges WHERE id = ?').get(edgeA);
        const aData = JSON.parse(a.data);
        expect(a, 'edge A keeps its id').toBeTruthy();
        expect([a.user_id, a.source, a.target]).toEqual(['neo-gpt-euclid', '@neo-gpt-euclid', '@neo-opus-vega']);
        expect([aData.id, aData.source, aData.target]).toEqual([edgeA, '@neo-gpt-euclid', '@neo-opus-vega']);

        const b     = db.prepare('SELECT id, source, target, data FROM Edges WHERE id = ?').get(edgeB);
        const bData = JSON.parse(b.data);
        expect([b.source, b.target]).toEqual(['@neo-opus-vega', '@neo-gpt-euclid']);
        expect([bData.id, bData.source, bData.target]).toEqual([edgeB, '@neo-opus-vega', '@neo-gpt-euclid']);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

        // The collision is reported again on every run and nothing is written for it.
        const second = runGraphMigration(db, true);
        expect(second).toMatchObject({duplicateCollisions: 1, edgeMetadataRowsUpdated: 0, edgesRekeyed: 0, nodeMetadataRowsUpdated: 0, nodesMerged: 0, nodesRekeyed: 0});

        db.close();
    });
});
