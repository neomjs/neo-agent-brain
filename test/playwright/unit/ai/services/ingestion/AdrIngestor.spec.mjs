import {setup} from '../../../../setup.mjs';

const appName = 'AdrIngestorTest';

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

import {test, expect}        from '@playwright/test';
import Neo                   from 'neo.mjs/src/Neo.mjs';
import * as core             from 'neo.mjs/src/core/_export.mjs';
import fs                    from 'fs';
import path                  from 'path';
import os                    from 'os';
import {TestLifecycleHelper} from '../../services/memory-core/util.mjs';

test.describe('Neo.ai.daemons.services.AdrIngestor', () => {
    let GraphService;
    let AdrIngestor;
    let logger;
    let SystemLifecycleService;

    let tmpRoot;
    let decisionsDir;
    let StorageRouter;
    let upsertedDocs  = [];
    let embeddedStore = new Map();
    let _originalGetGraphCollection;

    let originalWarn;
    let warnMessages = [];

    test.beforeAll(async () => {
        const aiConfig = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default;

        const tmpDir = path.resolve(process.cwd(), 'tmp');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, {recursive: true});
        }
        aiConfig.autoIngestFileSystem = false;
        aiConfig.handoffFilePath      = path.join(tmpDir, 'mock_sandman_handoff_adr_ingestor.md');

        GraphService           = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        AdrIngestor            = (await import('../../../../../../ai/services/ingestion/AdrIngestor.mjs')).default;
        logger                 = (await import('../../../../../../ai/mcp/server/memory-core/logger.mjs')).default;
        SystemLifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        StorageRouter          = (await import('../../../../../../ai/services.mjs')).Memory_StorageRouter;

        // Reactive provider SSOT: under UNIT_TEST_MODE the Memory Core config resolves
        // storagePaths.graph to `:memory:` by construction. Do not mutate the shared AiConfig
        // DB path; just clear singleton lifecycle/cache state before booting this spec.
        await TestLifecycleHelper.cleanupGraphService(GraphService, SystemLifecycleService, null, null, 'clear');

        if (!SystemLifecycleService._initPromise) {
            await SystemLifecycleService.initAsync();
        } else {
            await SystemLifecycleService.ready();
        }

        if (!GraphService.db) {
            GraphService._initPromise = null;
            await GraphService.initAsync();
        }
    });

    test.beforeEach(() => {
        tmpRoot      = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-adr-ingestor-test-'));
        decisionsDir = path.join(tmpRoot, 'learn/agentos/decisions');
        fs.mkdirSync(decisionsDir, {recursive: true});

        if (GraphService.db) {
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.vicinityLoadedNodes.clear();

            if (GraphService.db.storage?.db) {
                GraphService.db.storage.clear();
                GraphService.db.storage.db.exec('DELETE FROM GraphLog');
                GraphService.db.lastSyncId = 0;
            }
        }

        warnMessages = [];
        originalWarn = logger.warn;
        logger.warn  = (...args) => {
            warnMessages.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
        };

        // Stub the graph collection so the embed-write records documents WITHOUT invoking the
        // real embedder (which would otherwise embed every ADR and time the corpus ingest out).
        upsertedDocs                = [];
        _originalGetGraphCollection = StorageRouter.getGraphCollection;

        embeddedStore.clear();
        AdrIngestor.resetCatalog();
        StorageRouter.getGraphCollection = async () => ({
            get   : async ({ids = []} = {}) => {
                const targetIds = ids.length > 0 ? ids : [...embeddedStore.keys()];
                const out       = {ids: [], metadatas: []};
                for (const id of targetIds) {
                    if (embeddedStore.has(id)) { out.ids.push(id); out.metadatas.push(embeddedStore.get(id)); }
                }
                return out;
            },
            upsert: async ({ids, documents, metadatas}) => {
                ids.forEach((id, i) => embeddedStore.set(id, metadatas[i]));
                upsertedDocs.push({ids, documents, metadatas});
            }
        });
    });

    test.afterEach(() => {
        if (originalWarn) logger.warn = originalWarn;
        if (_originalGetGraphCollection) StorageRouter.getGraphCollection = _originalGetGraphCollection;

        if (tmpRoot && fs.existsSync(tmpRoot)) {
            try { fs.rmSync(tmpRoot, {recursive: true}); } catch (e) {}
        }
    });

    test.afterAll(async () => {
        await TestLifecycleHelper.cleanupGraphService(GraphService, SystemLifecycleService, null, null, 'clear');
    });

    function writeAdr(fileName, body) {
        fs.writeFileSync(path.join(decisionsDir, fileName), body.trim() + '\n', 'utf8');
    }

    function syncOptions() {
        return {
            decisionsDir: 'learn/agentos/decisions',
            sourceRoot  : tmpRoot
        };
    }

    test('should upsert ADR nodes with normalized metadata and payload hashes', async () => {
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Proposed - transitions to Accepted on merge |
| **Supersedes** | old decision; obsolete note |

Body.
        `);

        const stats = await AdrIngestor.syncAdrsToGraph(syncOptions());

        expect(stats.adrsProcessed).toBe(1);
        expect(stats.adrsUpserted).toBe(1);
        expect(stats.adrsSkipped).toBe(0);
        expect(stats.errors).toEqual([]);

        const node = GraphService.db.nodes.get('adr-0099');
        expect(node).toBeDefined();
        expect(node.label).toBe('ADR');
        expect(node.properties.title).toBe('Test Decision Shape');
        expect(node.properties.status).toBe('Draft');
        expect(node.properties.rawStatus).toBe('Proposed - transitions to Accepted on merge');
        expect(node.properties.adrNumber).toBe('0099');
        expect(node.properties.adrNumberValue).toBe(99);
        expect(node.properties.source).toBe('learn/agentos/decisions/0099-test-decision.md');
        expect(node.properties.supersedes).toEqual(['old decision', 'obsolete note']);
        expect(node.properties.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('a redirect at a moved record\'s old path yields no ADR node, no edge and no vector', async () => {
        writeAdr('0098-moved-record.md', `
---
type: redirect
target: adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0098
---

# Moved to neomjs/neo-agent-institution

See Issue #1181 for why this is not a record.
        `);
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Accepted |
        `);

        const stats = await AdrIngestor.syncAdrsToGraph(syncOptions());

        expect(stats.adrsProcessed).toBe(1);
        expect(stats.adrsUpserted).toBe(1);
        expect(stats.errors).toEqual([]);
        expect(GraphService.db.nodes.get('adr-0099')).toBeDefined();
        expect(GraphService.db.nodes.get('adr-0098')).toBeNull();
        expect(GraphService.db.edges.items.some(edge => edge.source === 'adr-0098' || edge.target === 'adr-0098')).toBe(false);
        expect(upsertedDocs.some(upsert => upsert.ids.includes('adr-0098'))).toBe(false);
    });

    test('should embed each ADR document into the graph collection (idempotent)', async () => {
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Proposed |

Body content for embedding.
        `);

        await AdrIngestor.syncAdrsToGraph(syncOptions());

        // The ADR document is upserted into the graph collection → semantically queryable.
        const adrUpsert = upsertedDocs.find(u => u.ids[0] === 'adr-0099');
        expect(adrUpsert).toBeTruthy();
        expect(adrUpsert.documents[0]).toContain('Test Decision Shape');
        expect(adrUpsert.metadatas[0].type).toBe('ADR');
        expect(adrUpsert.metadatas[0].hash).toMatch(/^[a-f0-9]{32}$/); // md5 content hash

        // The SQLite node carries semanticVectorId → the node knows it is embedded (not detached).
        expect(GraphService.db.nodes.get('adr-0099').properties.semanticVectorId).toBe('adr-0099');

        // Idempotent: a re-sync of unchanged content (node + body) writes no new vector.
        upsertedDocs.length = 0;
        await AdrIngestor.syncAdrsToGraph(syncOptions());
        expect(upsertedDocs.find(u => u.ids[0] === 'adr-0099')).toBeFalsy();
    });

    test('should re-embed on a body-only edit even when payloadHash (metadata) is unchanged', async () => {
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Proposed |

Original body.
        `);
        await AdrIngestor.syncAdrsToGraph(syncOptions());

        // Edit ONLY the body (title/status/metadata unchanged → payloadHash identical).
        upsertedDocs.length = 0;
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Proposed |

Completely different body content.
        `);
        await AdrIngestor.syncAdrsToGraph(syncOptions());

        // The vector MUST update — the old guard skipped before the md5 check, stranding a stale vector.
        const reEmbed = upsertedDocs.find(u => u.ids[0] === 'adr-0099');
        expect(reEmbed).toBeTruthy();
        expect(reEmbed.documents[0]).toContain('different body content');
    });

    test('should emit only deterministic ADR 0006 edge taxonomy rows', async () => {
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Accepted - 2026-06-14 |
| **Implementation ticket** | #456 |

## Related

- Ticket #456
- Issue #789
- Epic #1000
- PR #123
- Origin Session ID: \`agent-session-abc\`
- CONCEPT:mx-loop
        `);

        const stats = await AdrIngestor.syncAdrsToGraph(syncOptions());

        expect(stats.edgesReplaced).toBe(9);

        const edgeKeys = GraphService.db.edges.items
            .map(edge => `${edge.source}|${edge.target}|${edge.type}`)
            .sort();

        expect(edgeKeys).toEqual([
            'adr-0099|issue-1000|GOVERNS',
            'adr-0099|issue-456|GOVERNS',
            'adr-0099|issue-789|GOVERNS',
            'adr-0099|mx-loop|CODIFIES_CONCEPT',
            'adr-0099|session:agent-session-abc|GRADUATED_FROM',
            'issue-1000|adr-0099|CITES_AUTHORITY',
            'issue-456|adr-0099|CITES_AUTHORITY',
            'issue-789|adr-0099|CITES_AUTHORITY',
            'pr-123|adr-0099|IMPLEMENTS_DECISION'
        ].sort());

        expect(GraphService.db.nodes.get('issue-456').label).toBe('ISSUE');
        expect(GraphService.db.nodes.get('pr-123').label).toBe('PULL_REQUEST');
        expect(GraphService.db.nodes.get('session:agent-session-abc').label).toBe('SESSION');
        expect(GraphService.db.nodes.get('mx-loop').label).toBe('CONCEPT');
    });

    test('should skip unchanged ADRs via payload hash match', async () => {
        writeAdr('0099-test-decision.md', `
# ADR 0099: Test Decision Shape

| **Status** | Accepted - 2026-06-14 |

Ticket #456
        `);

        const first           = await AdrIngestor.syncAdrsToGraph(syncOptions());
        const edgesAfterFirst = GraphService.db.edges.items.length;
        const second          = await AdrIngestor.syncAdrsToGraph(syncOptions());

        expect(first.adrsUpserted).toBe(1);
        expect(second.adrsUpserted).toBe(0);
        expect(second.adrsSkipped).toBe(1);
        expect(second.edgesReplaced).toBe(0);
        expect(GraphService.db.edges.items.length).toBe(edgesAfterFirst);
    });

    test('CODIFIES_CONCEPT edge targets canonicalize through the concept-spine SSOT — PascalCase ref → kebab node (#14540)', () => {
        const edges    = AdrIngestor.parseEdges('adr-0026', 'Codifies CONCEPT:GoldenPath and CONCEPT:mx-loop.'),
              codifies = edges.filter(edge => edge.type === 'CODIFIES_CONCEPT').map(edge => edge.target);

        // GoldenPath → the canonical kebab node the session/mailbox mints also target, not the raw PascalCase ref
        expect(codifies).toContain('golden-path');
        expect(codifies).not.toContain('GoldenPath');
        // an already-canonical ref passes through unchanged
        expect(codifies).toContain('mx-loop');
    });

    test('should read the colon-inside Status spelling rather than defaulting it to Draft', async () => {
        writeAdr('0099-inner-colon.md', `
# ADR 0099: Colon Inside The Bold

**Status:** Accepted — 2026-07-03 (PR #14527)
        `);

        await AdrIngestor.syncAdrsToGraph(syncOptions());

        const node = GraphService.db.nodes.get('adr-0099');

        // The corpus carries three Status spellings. An unmatched one used to fall through to the
        // `'Draft'` default, so the graph reported an accepted record as pending — a parse failure
        // wearing a status claim, which is the one outcome indistinguishable from a real reading.
        expect(node.properties.status).toBe('Accepted');
        expect(node.properties.rawStatus).toBe('Accepted — 2026-07-03 (PR #14527)');
    });

    test('should isolate malformed files as errors while ingesting valid ADRs', async () => {
        writeAdr('0099-valid.md', `
# ADR 0099: Valid

**Status**: Accepted
        `);
        writeAdr('not-an-adr.md', '# Ignored');

        const stats = await AdrIngestor.syncAdrsToGraph(syncOptions());

        expect(stats.adrsProcessed).toBe(1);
        expect(stats.adrsUpserted).toBe(1);
        expect(stats.errors).toEqual([]);
        expect(warnMessages).toEqual([]);
        expect(GraphService.db.nodes.get('adr-0099')).toBeDefined();
    });

    test('should ingest the current ADR corpus without parse errors', async () => {
        const
            repoRoot     = process.cwd(),
            repoAdrDir   = path.resolve(repoRoot, 'learn/agentos/decisions'),
            expectedAdrs = fs.readdirSync(repoAdrDir).filter(file => /^\d{4}-.*\.md$/.test(file)).length;

        const stats = await AdrIngestor.syncAdrsToGraph({
            decisionsDir: 'learn/agentos/decisions',
            sourceRoot  : repoRoot
        });

        expect(stats.adrsProcessed).toBe(expectedAdrs);
        expect(stats.errors).toEqual([]);
        expect(GraphService.db.nodes.items.filter(node => node.label === 'ADR').length).toBe(expectedAdrs);
    });

    test('AC1 / Vector 23: non-ADR writers (SemanticGraphExtractor / CONCEPT upsert) never overwrite ADR type, semanticVectorId, or authority properties', async () => {
        const {GRAPH_NODE_WRITER_INVENTORY} = await import('../../../../../../ai/services/memory-core/GraphService.mjs');

        expect(Array.isArray(GRAPH_NODE_WRITER_INVENTORY)).toBe(true);
        expect(GRAPH_NODE_WRITER_INVENTORY.some(w => w.id === 'AdrIngestor' && w.canMutateAdrAuthority === true)).toBe(true);
        expect(GRAPH_NODE_WRITER_INVENTORY.some(w => w.id === 'SemanticGraphExtractor' && w.canMutateAdrAuthority === false)).toBe(true);

        writeAdr('0038-canonical-adr.md', `
# ADR 0038: Canonical ADR Identity
| **Status** | Accepted |

Codifies CONCEPT:adr-0038 and CONCEPT:golden-path.
        `);

        await AdrIngestor.syncAdrsToGraph(syncOptions());

        const beforeNode = GraphService.db.nodes.get('adr-0038');
        expect(beforeNode).toBeDefined();
        expect(beforeNode.label).toBe('ADR');
        expect(beforeNode.properties.semanticVectorId).toBe('adr-0038');
        expect(beforeNode.properties.canonicalKey).toBe('adr-0038');
        expect(beforeNode.properties.title).toBe('Canonical ADR Identity');
        expect(beforeNode.properties.status).toBe('Accepted');

        // Simulate SemanticGraphExtractor / DreamService upserting a CONCEPT node with the same id
        // and pointing semanticVectorId at a session summary vector.
        GraphService.upsertNode({
            id              : 'adr-0038',
            type            : 'CONCEPT',
            name            : 'Overwritten Concept Name',
            description     : 'Session summary description',
            semanticVectorId: 'summary_hijacked_vector_999',
            properties      : {
                title       : 'Hijacked Title',
                status      : 'Draft',
                source      : 'session:hijack',
                canonicalKey: 'adr:evil:1:evil%2Frepo:0038',
                payloadHash : 'deadbeef'
            }
        });

        const afterNode = GraphService.db.nodes.get('adr-0038');
        expect(afterNode.label).toBe('ADR');
        expect(afterNode.properties.semanticVectorId).toBe('adr-0038');
        expect(afterNode.properties.canonicalKey).toBe('adr-0038');
        expect(afterNode.properties.title).toBe('Canonical ADR Identity');
        expect(afterNode.properties.status).toBe('Accepted');
        expect(afterNode.properties.source).toBe('learn/agentos/decisions/0038-canonical-adr.md');

        // Read-modify-write CONCEPT upsert echoing existing properties (including adrAuthority) must keep label === 'ADR'
        GraphService.upsertNode({
            id        : 'adr-0038',
            type      : 'CONCEPT',
            properties: {...afterNode.properties}
        });
        expect(GraphService.db.nodes.get('adr-0038').label).toBe('ADR');

        // Undeclared competing authoritative ADR claim from a different canonicalKey must be refused by GraphService.upsertNode
        expect(() => {
            GraphService.upsertNode({
                id        : 'adr-0038',
                type      : 'ADR',
                properties: {
                    adrAuthority: {
                        admitted    : true,
                        canonicalKey: 'adr:github.com:999999:neomjs%2Fother-repo:0038'
                    }
                }
            });
        }).toThrow(/Undeclared competing canonical ADR claim refused/);

        // Explicit CONCEPT reference emits CODIFIES_CONCEPT to golden-path without collapsing the ADR node into CONCEPT
        const codifiesEdges = GraphService.db.edges.items.filter(
            e => e.source === 'adr-0038' && e.type === 'CODIFIES_CONCEPT'
        );
        expect(codifiesEdges.map(e => e.target)).toContain('golden-path');
        expect(GraphService.db.nodes.get('adr-0038').label).toBe('ADR');
    });

    test('AC2 / Vectors 1–4: canonical ADR key encoding, special-character injectivity, and malformed input rejection', async () => {
        const {
            buildCanonicalAdrKey,
            decodeAdrKeyField,
            encodeAdrKeyField,
            parseCanonicalAdrKey,
            validateAdrIdentityFields
        } = await import('../../../../../../ai/services/ingestion/AdrIngestor.mjs');

        // Vector 1: Normal input round-trip
        const normalKey = buildCanonicalAdrKey({
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain',
            number      : '0038'
        });
        expect(normalKey).toBe('adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0038');
        expect(parseCanonicalAdrKey(normalKey)).toEqual({
            canonicalKey: 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0038',
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain',
            number      : '0038'
        });

        // Vector 2: Inputs containing ':', '%', '/', and non-unreserved bytes round-trip losslessly
        const rawField = 'org:name%2Fwith space/and:colons';
        const encoded  = encodeAdrKeyField(rawField);
        expect(encoded).not.toContain(':');
        expect(encoded).not.toContain('/');
        expect(encoded).not.toContain(' ');
        expect(decodeAdrKeyField(encoded)).toBe(rawField);

        const specialInput = {
            forge       : 'git.example.org:8443',
            repositoryId: 'repo:id%99',
            namespace   : 'org:name%1/repo:name%2',
            number      : '0007'
        };
        const specialKey = buildCanonicalAdrKey(specialInput);
        expect(specialKey.split(':').length).toBe(5);
        expect(parseCanonicalAdrKey(specialKey)).toEqual({
            canonicalKey: specialKey,
            ...specialInput
        });

        // Vector 3: Injectivity across distinct tuples containing delimiter/escape sequences
        const tupleA = {
            forge       : 'github.com',
            repositoryId: '100:a',
            namespace   : 'neomjs/neo:sub',
            number      : '0001'
        };
        const tupleB = {
            forge       : 'github.com',
            repositoryId: '100%3Aa',
            namespace   : 'neomjs/neo%3Asub',
            number      : '0001'
        };
        const keyA = buildCanonicalAdrKey(tupleA);
        const keyB = buildCanonicalAdrKey(tupleB);
        expect(keyA).not.toBe(keyB);
        expect(parseCanonicalAdrKey(keyA)).toEqual({canonicalKey: keyA, ...tupleA});
        expect(parseCanonicalAdrKey(keyB)).toEqual({canonicalKey: keyB, ...tupleB});

        // Vector 4: Malformed inputs rejected before key construction
        expect(() => validateAdrIdentityFields({
            forge       : 'https://github.com',
            repositoryId: '1',
            namespace   : 'neomjs/neo',
            number      : '0001'
        })).toThrow(/Invalid or noncanonical forge authority/);

        expect(() => validateAdrIdentityFields({
            forge       : 'github.com:443',
            repositoryId: '1',
            namespace   : 'neomjs/neo',
            number      : '0001'
        })).toThrow(/Invalid or noncanonical forge authority/);

        expect(() => validateAdrIdentityFields({
            forge       : 'github.com',
            repositoryId: 'neomjs/neo',
            namespace   : 'neomjs/neo',
            number      : '0001'
        })).toThrow(/Missing or invalid stable repositoryId proof/);

        expect(() => validateAdrIdentityFields({
            forge       : 'github.com',
            repositoryId: '1',
            namespace   : 'invalid-repo-without-slash',
            number      : '0001'
        })).toThrow(/Invalid ADR namespace/);

        expect(() => validateAdrIdentityFields({
            forge       : 'github.com',
            repositoryId: '1',
            namespace   : 'neomjs/neo',
            number      : '0000'
        })).toThrow(/Invalid ADR number/);

        expect(() => decodeAdrKeyField('neomjs%2fneo')).toThrow(/Noncanonical or malformed encoded ADR key field/);
        expect(() => parseCanonicalAdrKey('not-an-adr-key')).toThrow(/Invalid canonical ADR key/);
    });

    test('AC3 / Vectors 5, 7, 15: repository-qualified human slugs, filename & opening alias grammar, and <= 2 author actions', async () => {
        const {
            parseAdrFilename,
            parseAdrOpeningAliases
        } = await import('../../../../../../ai/services/ingestion/AdrIngestor.mjs');

        // Vector 7: Filename grammar [0-9]{4}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md
        expect(parseAdrFilename('0038-adrs-as-graph-entities.md')).toEqual({
            adrNumber: '0038',
            slug     : 'adrs-as-graph-entities'
        });
        expect(() => parseAdrFilename('0038-UpperCase.md')).toThrow(/Invalid ADR filename slug/);
        expect(() => parseAdrFilename('0038-double--hyphen.md')).toThrow(/Invalid ADR filename slug/);
        expect(() => parseAdrFilename('0038_underscore.md')).toThrow(/Invalid ADR file name/);
        expect(() => parseAdrFilename('0000-zero.md')).toThrow(/Invalid ADR number/);
        expect(() => parseAdrFilename('0038-trailing-.md')).toThrow(/Invalid ADR filename slug/);
        expect(() => parseAdrFilename('0038-.md')).toThrow(/Invalid ADR file name/);

        // Vector 15: Canonical two-column Attribute | Value opening table between H1 and H2
        const rawWithAliases = `
# ADR 0038: Graph Entities

| Attribute | Value |
| --- | --- |
| **Status** | Accepted |
| **Aliases** | \`graph-entities-v1\`, \`legacy-adr-entities\` |

## Context

| Attribute | Value |
| --- | --- |
| **Aliases** | \`ignored-after-h2\` |
`;
        const parsedAliases = parseAdrOpeningAliases(rawWithAliases);
        expect(parsedAliases).toEqual({
            aliases                 : ['graph-entities-v1', 'legacy-adr-entities'],
            hasCanonicalOpeningTable: true,
            hasAliasesRow           : true
        });

        // Reject prose Aliases outside a canonical opening table and duplicate Aliases rows
        expect(() => parseAdrOpeningAliases(`
# ADR 0038: Prose Alias
**Aliases:** \`prose-alias\`
## Context
        `)).toThrow(/Aliases declaration requires a canonical two-column Attribute \| Value opening table/);

        expect(() => parseAdrOpeningAliases(`
# ADR 0038: Duplicate Rows
| Attribute | Value |
| --- | --- |
| **Aliases** | \`slug-one\` |
| **Aliases** | \`slug-one\` |
## Context
        `)).toThrow(/Duplicate Aliases rows/);

        // Vector 15: Author-action measurement (1 file edit for create, 1 file + 1 alias row edit for rename)
        const createAction = AdrIngestor.measureAuthorActions({operation: 'create'});
        expect(createAction.actualFileEdits).toBe(1);
        expect(createAction.aliasRowEdits).toBe(0);
        expect(createAction.additionalRegistrationSurfaces).toBe(0);
        expect(createAction.manifestEditsRequired).toBe(0);

        const renameAction = AdrIngestor.measureAuthorActions({operation: 'rename'});
        expect(renameAction.actualFileEdits).toBe(1);
        expect(renameAction.aliasRowEdits).toBe(1);
        expect(renameAction.sameSourceEdit).toBe(true);
        expect(renameAction.additionalRegistrationSurfaces).toBe(0);

        // Ingest the decision record with repository identity and lineage evidence for its historical aliases
        writeAdr('0038-graph-entities.md', rawWithAliases);
        const brainRepo = {
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain'
        };
        const stats = await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository           : brainRepo,
            sourceLineageEvidence: [
                {adrNumber: '0038', alias: 'graph-entities-v1'},
                {adrNumber: '0038', alias: 'legacy-adr-entities'}
            ]
        });
        expect(stats.errors).toEqual([]);

        const expectedCanonical = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0038';

        // All 3 scoped human slug forms (D19816):
        // 1. adr:<slug> with repository_artifact context
        const localSlugRes = AdrIngestor.resolveAdrReference('adr:graph-entities', {
            surface     : 'repository_artifact',
            sourceOrigin: brainRepo
        });
        // 2. <org>/<repo>#adr:<slug> with forge context
        const orgRepoSlugRes = AdrIngestor.resolveAdrReference('neomjs/neo-agent-brain#adr:graph-entities', {
            surface  : 'organization_discussion',
            webOrigin: {forge: 'github.com'}
        });
        // 3. <forge>/<org>/<repo>#adr:<slug> (fully qualified)
        const fullSlugRes = AdrIngestor.resolveAdrReference('github.com/neomjs/neo-agent-brain#adr:graph-entities-v1', {
            surface: 'memory_or_a2a'
        });

        expect(localSlugRes.status).toBe('resolved');
        expect(localSlugRes.canonicalKey).toBe(expectedCanonical);
        expect(orgRepoSlugRes.status).toBe('resolved');
        expect(orgRepoSlugRes.canonicalKey).toBe(expectedCanonical);
        expect(fullSlugRes.status).toBe('resolved');
        expect(fullSlugRes.canonicalKey).toBe(expectedCanonical);

        // Bare repository basename without organization must be rejected
        const bareRepoRes = AdrIngestor.resolveAdrReference('neo-agent-brain#adr:graph-entities', {
            surface  : 'organization_discussion',
            webOrigin: {forge: 'github.com'}
        });
        expect(bareRepoRes.status).toBe('unresolved');
        expect(bareRepoRes.reasonCode).toBe('INVALID_REPOSITORY_LOCATOR');
    });

    test('AC4 / Vectors 5–6, 8–9: surface context rules and legacy bare numeric citations (unambiguous vs colliding)', async () => {
        const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-stage-adr-test-'));
        const stageDir  = path.join(stageRoot, 'learn/decisions');
        fs.mkdirSync(stageDir, {recursive: true});

        const brainRepo = {
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain'
        };
        const stageRepo = {
            forge       : 'github.com',
            repositoryId: '1500000001',
            namespace   : 'neomjs/neo-stage'
        };

        try {
            writeAdr('0001-brain-contract.md', `
# ADR 0001: Brain Contract
| **Status** | Accepted |
            `);
            writeAdr('0038-brain-only.md', `
# ADR 0038: Brain Only Number
| **Status** | Accepted |
            `);

            fs.writeFileSync(path.join(stageDir, '0001-the-engine-contract.md'), `
# ADR 0001: The Engine Contract
| **Status** | Accepted |
            `.trim() + '\n', 'utf8');

            await AdrIngestor.syncAdrsToGraph({
                sources: [
                    {decisionsDir: 'learn/agentos/decisions', sourceRoot: tmpRoot, repository: brainRepo},
                    {decisionsDir: 'learn/decisions', sourceRoot: stageRoot, repository: stageRepo}
                ]
            });

            // Vector 5: Repository-scoped citation inside neomjs/neo-stage resolves to neo-stage's 0001
            const stageLocal = AdrIngestor.resolveAdrReference('adr-0001', {
                surface     : 'repository_artifact',
                sourceOrigin: stageRepo
            });
            expect(stageLocal.status).toBe('resolved');
            expect(stageLocal.canonicalKey).toBe('adr:github.com:1500000001:neomjs%2Fneo-stage:0001');

            // Vector 6 & Vector 9: Bare numeric reference on organization_discussion or memory_or_a2a returns ambiguous with both candidates
            const orgAmbiguous = AdrIngestor.resolveAdrReference('adr-0001', {
                surface          : 'organization_discussion',
                hostingRepository: brainRepo,
                webOrigin        : {forge: 'github.com'}
            });
            expect(orgAmbiguous.status).toBe('ambiguous');
            expect(orgAmbiguous.reasonCode).toBe('MISSING_REPOSITORY_CONTEXT');
            expect(orgAmbiguous.candidates.sort()).toEqual([
                'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001',
                'adr:github.com:1500000001:neomjs%2Fneo-stage:0001'
            ]);

            const a2aAmbiguous = AdrIngestor.resolveAdrReference('adr-0001', {
                surface              : 'memory_or_a2a',
                seat                 : '@neo-gemini-julia',
                cwd                  : '/Users/tobiasuhlig/neomjs/neo-agent-brain',
                relatedTickets       : ['neomjs/neo-agent-brain#1012'],
                hostingImplementation: brainRepo,
                originEnvelope       : {forge: 'github.com'}
            });
            expect(a2aAmbiguous.status).toBe('ambiguous');
            expect(a2aAmbiguous.reasonCode).toBe('MISSING_REPOSITORY_CONTEXT');
            expect(a2aAmbiguous.candidates.length).toBe(2);

            // Historical content uses evidencedCitationOrigin and ignores currentCustody
            const histResolved = AdrIngestor.resolveAdrReference('adr-0001', {
                surface                : 'historical_content',
                evidencedCitationOrigin: stageRepo,
                currentCustody         : brainRepo
            });
            expect(histResolved.status).toBe('resolved');
            expect(histResolved.canonicalKey).toBe('adr:github.com:1500000001:neomjs%2Fneo-stage:0001');

            const histMissingOrigin = AdrIngestor.resolveAdrReference('adr-0001', {
                surface       : 'historical_content',
                currentCustody: brainRepo
            });
            expect(histMissingOrigin.status).toBe('ambiguous');
            expect(histMissingOrigin.reasonCode).toBe('MISSING_REPOSITORY_CONTEXT');
        } finally {
            fs.rmSync(stageRoot, {recursive: true, force: true});
        }
    });

    test('AC5 / Vectors 10–11: per-repository allocation floor and historical reservation floor in neomjs/neo', async () => {
        const brainRepo = {
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain'
        };
        const stageRepo = {
            forge       : 'github.com',
            repositoryId: '1500000001',
            namespace   : 'neomjs/neo-stage'
        };

        writeAdr('0038-brain-record.md', `
# ADR 0038: Brain Record
| **Status** | Accepted |
        `);
        await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository: brainRepo
        });

        // Vector 10: Independent per-repository allocation counters
        AdrIngestor.reserveHistoricalNumbers({
            ...stageRepo,
            reservations: ['0001']
        });
        expect(AdrIngestor.allocateNextAdrNumber(stageRepo)).toBe('0002');
        expect(AdrIngestor.allocateNextAdrNumber(brainRepo)).toBe('0039');

        // Vector 11: neomjs/neo (repoId 220867748) has historical reservation floor up to 0038;
        // even with only local 0019 present, next allocated number in neomjs/neo is 0039.
        AdrIngestor.reserveHistoricalNumbers({
            forge       : 'github.com',
            repositoryId: '220867748',
            namespace   : 'neomjs/neo',
            reservations: [{
                number   : '0038',
                slug     : 'moved-to-brain',
                targetKey: 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0038'
            }]
        });
        expect(AdrIngestor.allocateNextAdrNumber({
            forge       : 'github.com',
            repositoryId: '220867748'
        })).toBe('0039');

        // Candidate observation floor surfaces incomplete history under AD filter vs unfiltered history
        const adObservation = AdrIngestor.observeCandidateAllocationFloor({
            presentFiles     : ['0019-local.md'],
            gitHistoryEntries: [{status: 'R092', oldPath: '0041-old.md', newPath: '0042-renamed.md'}],
            historyComplete  : true,
            historyFilter    : 'AD',
            forge            : 'github.com',
            repositoryId     : '220867748'
        });
        expect(adObservation.incompleteHistory).toBe(true);
        expect(adObservation.historyFloor).toBe('0041');
        expect(adObservation.advisoryOnly).toBe(true);
        expect(adObservation.certifiedByAdmission).toBe(false);
        expect(adObservation.certifiedEligibleNumber).toBe('0039');

        const fullObservation = AdrIngestor.observeCandidateAllocationFloor({
            presentFiles     : ['0019-local.md'],
            gitHistoryEntries: [{status: 'R092', oldPath: '0041-old.md', newPath: '0042-renamed.md'}],
            historyComplete  : true,
            historyFilter    : 'all',
            forge            : 'github.com',
            repositoryId     : '220867748'
        });
        expect(fullObservation.incompleteHistory).toBe(false);
        expect(fullObservation.historyFloor).toBe('0042');
        expect(fullObservation.nextCandidateNumber).toBe('0043');
    });

    test('AC6 / Vectors 12–13: repository rename continuity and old-name reuse namespace occupancy conflict refusal', async () => {
        const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-stage-rename-test-'));
        const stageDir  = path.join(stageRoot, 'learn/decisions');
        fs.mkdirSync(stageDir, {recursive: true});

        try {
            fs.writeFileSync(path.join(stageDir, '0001-stage-contract.md'), `
# ADR 0001: Stage Contract
| **Status** | Accepted |
            `.trim() + '\n', 'utf8');

            await AdrIngestor.syncAdrsToGraph({
                decisionsDir: 'learn/decisions',
                sourceRoot  : stageRoot,
                repository  : {
                    forge       : 'github.com',
                    repositoryId: '1500000001',
                    namespace   : 'neomjs/neo-stage'
                }
            });

            // Missing continuity proof must be refused
            expect(() => AdrIngestor.recordRepositoryRename({
                forge            : 'github.com',
                repositoryId     : '1500000001',
                previousNamespace: 'neomjs/neo-stage',
                currentNamespace : 'neomjs/neo-theatrical-stage'
            })).toThrow(/requires continuity proof/);

            // Vector 12: Proved rename neomjs/neo-stage (repoId 1500000001) -> neomjs/neo-theatrical-stage
            // Canonical key is immutable (never rekeyed) and both old and new qualified locators resolve to it.
            AdrIngestor.recordRepositoryRename({
                forge            : 'github.com',
                repositoryId     : '1500000001',
                previousNamespace: 'neomjs/neo-stage',
                currentNamespace : 'neomjs/neo-theatrical-stage',
                proof            : {event: 'github.repository.renamed', repositoryId: '1500000001'}
            });

            const immutableCanonical = 'adr:github.com:1500000001:neomjs%2Fneo-stage:0001';

            const oldSlugResolve = AdrIngestor.resolveAdrReference('neomjs/neo-stage#adr:stage-contract', {
                surface  : 'organization_discussion',
                webOrigin: {forge: 'github.com'}
            });
            expect(oldSlugResolve.status).toBe('resolved');
            expect(oldSlugResolve.canonicalKey).toBe(immutableCanonical);

            const newSlugResolve = AdrIngestor.resolveAdrReference('neomjs/neo-theatrical-stage#adr:stage-contract', {
                surface  : 'organization_discussion',
                webOrigin: {forge: 'github.com'}
            });
            expect(newSlugResolve.status).toBe('resolved');
            expect(newSlugResolve.canonicalKey).toBe(immutableCanonical);

            // Vector 13: A new repository (repoId 9999999999) now occupies the old name neomjs/neo-stage
            const reuseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-stage-reuse-test-'));
            const reuseDir  = path.join(reuseRoot, 'learn/decisions');
            fs.mkdirSync(reuseDir, {recursive: true});

            try {
                fs.writeFileSync(path.join(reuseDir, '0001-new-occupant.md'), `
# ADR 0001: New Occupant Contract
| **Status** | Accepted |
                `.trim() + '\n', 'utf8');

                await AdrIngestor.syncAdrsToGraph({
                    decisionsDir: 'learn/decisions',
                    sourceRoot  : reuseRoot,
                    repository  : {
                        forge       : 'github.com',
                        repositoryId: '9999999999',
                        namespace   : 'neomjs/neo-stage'
                    }
                });

                // Historical locator under the reused namespace must NOT silently retarget; it returns RESERVED_NAMESPACE_OCCUPANCY_CONFLICT
                const conflictRes = AdrIngestor.resolveAdrReference('neomjs/neo-stage#adr-0001', {
                    surface  : 'organization_discussion',
                    webOrigin: {forge: 'github.com'}
                });
                expect(conflictRes.status).toBe('conflict');
                expect(conflictRes.reasonCode).toBe('RESERVED_NAMESPACE_OCCUPANCY_CONFLICT');
                expect(conflictRes.requiresCanonicalKey).toBe(true);
                expect(conflictRes.candidates.sort()).toEqual([
                    'adr:github.com:1500000001:neomjs%2Fneo-stage:0001',
                    'adr:github.com:9999999999:neomjs%2Fneo-stage:0001'
                ]);

                // Canonical keys resolve both repositories unambiguously
                const byOldRepoId = AdrIngestor.resolveAdrReference(immutableCanonical);
                expect(byOldRepoId.status).toBe('resolved');
                expect(byOldRepoId.record.assignmentEvidence.repositoryId).toBe('1500000001');

                const newCanonical = 'adr:github.com:9999999999:neomjs%2Fneo-stage:0001';
                const byNewRepoId  = AdrIngestor.resolveAdrReference(newCanonical);
                expect(byNewRepoId.status).toBe('resolved');
                expect(byNewRepoId.record.assignmentEvidence.repositoryId).toBe('9999999999');
            } finally {
                fs.rmSync(reuseRoot, {recursive: true, force: true});
            }
        } finally {
            fs.rmSync(stageRoot, {recursive: true, force: true});
        }
    });

    test('AC7 / Vector 14: unauthorized readers never observe private repository metadata, titles, aliases, or existence', async () => {
        const privRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-private-adr-test-'));
        const privDir  = path.join(privRoot, 'learn/decisions');
        fs.mkdirSync(privDir, {recursive: true});

        const brainRepo = {
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain'
        };
        const privRepo = {
            forge       : 'github.com',
            repositoryId: '777777',
            namespace   : 'neomjs/private-vault'
        };

        try {
            writeAdr('0001-public-brain.md', `
# ADR 0001: Public Brain Decision
| **Status** | Accepted |
            `);

            fs.writeFileSync(path.join(privDir, '0001-secret-architecture.md'), `
# ADR 0001: Top Secret Vault Architecture
| **Status** | Accepted |
            `.trim() + '\n', 'utf8');

            fs.writeFileSync(path.join(privDir, '0077-only-in-private.md'), `
# ADR 0077: Exclusive Secret Record
| **Status** | Accepted |
            `.trim() + '\n', 'utf8');

            await AdrIngestor.syncAdrsToGraph({
                sources: [
                    {decisionsDir: 'learn/agentos/decisions', sourceRoot: tmpRoot, repository: brainRepo},
                    {decisionsDir: 'learn/decisions', sourceRoot: privRoot, repository: privRepo}
                ]
            });

            // Reader authorized ONLY for public neomjs/neo-agent-brain (1344062228)
            const publicOnlyReader = {
                surface                : 'organization_discussion',
                webOrigin              : {forge: 'github.com'},
                authorizedRepositoryIds: ['1344062228']
            };

            // Querying 0077 (exists only in private repo) -> unresolved with zero candidate metadata
            const secretLookup = AdrIngestor.resolveAdrReference('neomjs/private-vault#adr-0077', publicOnlyReader);
            expect(secretLookup.status).toBe('unresolved');
            expect(secretLookup.candidates).toEqual([]);
            expect(JSON.stringify(secretLookup)).not.toContain('private-vault');
            expect(JSON.stringify(secretLookup)).not.toContain('Secret');

            // Querying private slug directly -> unresolved with zero leakage
            const aliasLookup = AdrIngestor.resolveAdrReference('neomjs/private-vault#adr:secret-architecture', publicOnlyReader);
            expect(aliasLookup.status).toBe('unresolved');
            expect(aliasLookup.candidates).toEqual([]);
            expect(JSON.stringify(aliasLookup)).not.toContain('private-vault');

            // Querying private canonical key directly -> unresolved with zero leakage
            const keyLookup = AdrIngestor.resolveAdrReference('adr:github.com:777777:neomjs%2Fprivate-vault:0001', publicOnlyReader);
            expect(keyLookup.status).toBe('unresolved');
            expect(keyLookup.candidates).toEqual([]);
            expect(JSON.stringify(keyLookup)).not.toContain('private-vault');

            // Querying colliding numeric reference on unscoped surface -> only the authorized public candidate is visible
            const collidingLookup = AdrIngestor.resolveAdrReference('adr-0001', publicOnlyReader);
            expect(collidingLookup.candidates).toEqual(['adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001']);
            expect(JSON.stringify(collidingLookup)).not.toContain('private-vault');
            expect(JSON.stringify(collidingLookup)).not.toContain('Top Secret');
        } finally {
            fs.rmSync(privRoot, {recursive: true, force: true});
        }
    });

    test('AC8 / Vectors 16–18: batch conflict refusal, competing claim refusal, and admitted alias immutability', async () => {
        const brainRepo = {
            forge       : 'github.com',
            repositoryId: '1344062228',
            namespace   : 'neomjs/neo-agent-brain'
        };
        const canonical50 = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0050';
        const canonical60 = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0060';

        // Seed an admitted decision record first
        writeAdr('0050-original-owner.md', `
# ADR 0050: Original Owner
| Attribute | Value |
| --- | --- |
| **Status** | Accepted |
        `);
        const initialStats = await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository: brainRepo
        });
        expect(initialStats.adrsUpserted).toBe(1);
        expect(GraphService.db.nodes.get(canonical50).properties.title).toBe('Original Owner');

        // Rename 0050-original-owner.md -> 0050-renamed-owner.md preserving `original-owner` in Aliases
        fs.unlinkSync(path.join(decisionsDir, '0050-original-owner.md'));
        writeAdr('0050-renamed-owner.md', `
# ADR 0050: Original Owner
| Attribute | Value |
| --- | --- |
| **Status** | Accepted |
| **Aliases** | \`original-owner\` |
        `);
        const renameStats = await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository: brainRepo
        });
        expect(renameStats.errors).toEqual([]);

        // Simulate a process restart (clear in-memory admissionCatalog while GraphService.db stays intact):
        // resolveAdrReference and subsequent syncs must rehydrate from persisted adrAdmissionRecord on the graph node.
        AdrIngestor.resetCatalog();
        expect(AdrIngestor.admissionCatalog.size).toBe(0);
        expect(AdrIngestor.resolveAdrReference('neomjs/neo-agent-brain#adr:original-owner', {
            surface  : 'organization_discussion',
            webOrigin: {forge: 'github.com'}
        }).canonicalKey).toBe(canonical50);

        // Vector 16: Two new files claiming the same ADR number (0060) in one batch -> both refused (ADR_BATCH_CONFLICT), neither admitted
        AdrIngestor.resetCatalog();
        writeAdr('0060-claimant-a.md', `
# ADR 0060: Claimant A
| **Status** | Proposed |
        `);
        writeAdr('0060-claimant-b.md', `
# ADR 0060: Claimant B
| **Status** | Proposed |
        `);

        const batchConflictStats = await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository: brainRepo
        });
        expect(batchConflictStats.refused.filter(r => r.code === 'ADR_BATCH_CONFLICT').length).toBe(2);
        expect(GraphService.db.nodes.get(canonical60)).toBeNull();

        fs.unlinkSync(path.join(decisionsDir, '0060-claimant-a.md'));
        fs.unlinkSync(path.join(decisionsDir, '0060-claimant-b.md'));

        // Vector 17: Competing file 0050-hijacker.md alongside admitted owner 0050-renamed-owner.md across resetCatalog() -> refused (ADR_COMPETING_CLAIM_REFUSED)
        AdrIngestor.resetCatalog();
        writeAdr('0050-hijacker.md', `
# ADR 0050: Hijacker Title
| **Status** | Accepted |
        `);

        const competingStats = await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository: brainRepo
        });
        expect(competingStats.refused.some(r => r.code === 'ADR_COMPETING_CLAIM_REFUSED' && r.file === '0050-hijacker.md')).toBe(true);
        expect(GraphService.db.nodes.get(canonical50).properties.title).toBe('Original Owner');

        fs.unlinkSync(path.join(decisionsDir, '0050-hijacker.md'));

        // Vector 18: Removing previously admitted alias 'original-owner' from 0050-renamed-owner.md across resetCatalog() is refused (ADR_REMOVED_ADMITTED_ALIAS)
        AdrIngestor.resetCatalog();
        writeAdr('0050-renamed-owner.md', `
# ADR 0050: Original Owner Mutated Without Alias
| Attribute | Value |
| --- | --- |
| **Status** | Accepted |
        `);

        const removedAliasStats = await AdrIngestor.syncAdrsToGraph({
            ...syncOptions(),
            repository: brainRepo
        });
        expect(removedAliasStats.refused.some(r => r.code === 'ADR_REMOVED_ADMITTED_ALIAS' && r.file === '0050-renamed-owner.md')).toBe(true);
        // Existing node title and historical alias mapping remain preserved
        expect(GraphService.db.nodes.get(canonical50).properties.title).toBe('Original Owner');
        expect(AdrIngestor.resolveAdrReference('neomjs/neo-agent-brain#adr:original-owner', {
            surface  : 'organization_discussion',
            webOrigin: {forge: 'github.com'}
        }).canonicalKey).toBe(canonical50);
    });

    test('AC9 / Vectors 19–22: qualified cross-repo Issue/PR citations, unadmitted adr-* endpoint typing, and 4-state reconciliation', async () => {
        // Vector 19: Qualified Issue/PR citations across repositories produce distinct targets via qualifyOriginId
        const crossRepoEdges = AdrIngestor.parseEdges(
            'adr-0090',
            'Resolves Issue neomjs/neo-stage#42 and Issue neomjs/neo-agent-brain#42, implemented in [PR #15](https://github.com/neomjs/neo-stage/pull/15).',
            {citationOrigin: {namespace: 'neomjs/neo-agent-brain'}}
        );
        const governsTargets = crossRepoEdges.filter(e => e.type === 'GOVERNS').map(e => e.target).sort();
        expect(governsTargets).toEqual([
            'neo-agent-brain#issue-42',
            'neo-stage#issue-42'
        ]);
        const prSources = crossRepoEdges.filter(e => e.type === 'IMPLEMENTS_DECISION').map(e => e.source);
        expect(prSources).toEqual(['neo-stage#pr-15']);

        // Vector 20: Historical unqualified issue reference in a moved record with citationOrigin 'neomjs/neo-agent-institution'
        // resolves to neo-agent-institution#issue-42 (and 'neomjs/neo' resolves to bare 'issue-42'),
        // while a moved record lacking citationOrigin records MISSING_CITATION_ORIGIN and emits no fabricated edge.
        const historicalEdges = AdrIngestor.parseEdges(
            'adr-0010',
            'Related to Ticket #42 and PR #99.',
            {movedCustody: true, citationOrigin: {namespace: 'neomjs/neo-agent-institution'}}
        );
        expect(historicalEdges.filter(e => e.type === 'GOVERNS').map(e => e.target)).toEqual(['neo-agent-institution#issue-42']);
        expect(historicalEdges.filter(e => e.type === 'IMPLEMENTS_DECISION').map(e => e.source)).toEqual(['neo-agent-institution#pr-99']);

        const neoOriginEdges = AdrIngestor.parseEdges(
            'adr-0010',
            'Related to Ticket #42.',
            {movedCustody: true, citationOrigin: {namespace: 'neomjs/neo'}}
        );
        expect(neoOriginEdges.filter(e => e.type === 'GOVERNS').map(e => e.target)).toEqual(['issue-42']);

        const unresolvedRefs     = [];
        const unprovedMovedEdges = AdrIngestor.parseEdges(
            'adr-0010',
            'Related to Ticket #42.',
            {movedCustody: true, citationOrigin: null, unresolvedReferences: unresolvedRefs}
        );
        expect(unprovedMovedEdges).toEqual([]);
        expect(unresolvedRefs).toEqual([{
            kind      : 'issue',
            number    : '42',
            raw       : '#42',
            reasonCode: 'MISSING_CITATION_ORIGIN'
        }]);

        // Vector 21: Unadmitted adr-* / *#adr:* reference returns null from resolveEndpointType and ensureNodeExists
        // (neither minting a phantom ADR node nor collapsing an unadmitted authority reference into CONCEPT)
        expect(AdrIngestor.resolveEndpointType('adr-9999')).toBeNull();
        expect(AdrIngestor.resolveEndpointType('neomjs/neo#adr:unadmitted')).toBeNull();
        expect(AdrIngestor.ensureNodeExists('adr-9999')).toBeNull();
        expect(GraphService.db.nodes.get('adr-9999')).toBeNull();

        // Vector 22: Source, SQLite, and Chroma reconciliation & shared summary vector protection
        const brainRepo   = {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain'};
        const canonical81 = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0081';
        const canonical82 = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0082';

        writeAdr('0081-reconcile-a.md', `
# ADR 0081: Reconcile A
| **Status** | Accepted |

Body A.
        `);
        writeAdr('0082-reconcile-b.md', `
# ADR 0082: Reconcile B
| **Status** | Accepted |

Body B.
        `);
        await AdrIngestor.syncAdrsToGraph({...syncOptions(), repository: brainRepo});

        // (a) Delete canonical81 vector from Chroma and hijack canonical82's semanticVectorId to a shared summary vector
        embeddedStore.delete(canonical81);
        embeddedStore.set('summary_shared_1', {type: 'SESSION_SUMMARY', sessionId: 's1'});

        GraphService.upsertNode({
            id              : 'session:s1',
            type            : 'SESSION',
            name            : 'Session 1',
            semanticVectorId: 'summary_shared_1'
        });

        const node82  = GraphService.db.nodes.get(canonical82);
        const props82 = Object.assign({}, node82.properties, {semanticVectorId: 'summary_shared_1'});
        node82.set({properties: props82});

        expect(AdrIngestor.inventoryVectorOwners('summary_shared_1').map(o => o.nodeId).sort()).toEqual([
            canonical82,
            'session:s1'
        ]);

        // (b) Re-sync repairs missing vector on 0081 and restores 0082's semanticVectorId while preserving summary_shared_1
        const repairStats = await AdrIngestor.syncAdrsToGraph({...syncOptions(), repository: brainRepo});
        expect(embeddedStore.has(canonical81)).toBe(true);
        expect(GraphService.db.nodes.get(canonical82).properties.semanticVectorId).toBe(canonical82);
        expect(repairStats.preservedSharedVectors).toEqual([{
            adrId         : canonical82,
            sharedVectorId: 'summary_shared_1',
            retainedOwners: ['session:s1']
        }]);
        expect(embeddedStore.get('summary_shared_1')).toEqual({type: 'SESSION_SUMMARY', sessionId: 's1'});

        // (c) Remove 0081-reconcile-a.md from disk without redirect -> retained as stale, never silently deleted
        fs.unlinkSync(path.join(decisionsDir, '0081-reconcile-a.md'));
        const staleStats = await AdrIngestor.syncAdrsToGraph({...syncOptions(), repository: brainRepo});
        expect(staleStats.staleRecords).toEqual([canonical81]);

        const retained81 = GraphService.db.nodes.get(canonical81);
        expect(retained81).toBeDefined();
        expect(retained81.label).toBe('ADR');
        expect(retained81.properties.stale).toBe(true);
        expect(retained81.properties.documentAvailable).toBe(false);

        // (d) Reconstruct without retained admission evidence must refuse with ADR_ADMISSION_EVIDENCE_MISSING
        expect(() => AdrIngestor.reconcileSourceAndEvidence({
            retainedRecord : null,
            survivingSource: {fileName: '0081-reconcile-a.md', content: '# ADR 0081: Fake'}
        })).toThrow(/Cannot reconstruct ADR authority without retained assignment and scope admission evidence/);
    });
});
