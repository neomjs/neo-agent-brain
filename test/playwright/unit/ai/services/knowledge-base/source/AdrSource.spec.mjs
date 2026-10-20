import {setup} from '../../../../../setup.mjs';

const appName = 'AdrSourceTest';

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

import {test, expect}  from '@playwright/test';
import fs              from 'fs-extra';
import path            from 'path';
import {fileURLToPath} from 'url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '../../../../../../..');
const redirect   = `---
type: redirect
target: adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0002
---

# Moved to neomjs/neo-agent-institution
`;

test.describe('Neo.ai.services.knowledge-base.source.AdrSource', () => {
    let AdrSource;
    let aiConfig;
    let originalRoot;
    let mockRoot;

    test.beforeAll(async () => {
        aiConfig    = (await import('../../../../../../../ai/mcp/server/knowledge-base/config.template.mjs')).default;
        AdrSource = (await import('../../../../../../../ai/services/knowledge-base/source/AdrSource.mjs')).default;

        originalRoot = aiConfig.neoRootDir;

        const tmpDir = path.resolve(process.cwd(), 'tmp');
        fs.ensureDirSync(tmpDir);
        mockRoot = path.join(tmpDir, `adr-source-mock-${process.pid}-${Date.now()}`);

        const adrDir = path.join(mockRoot, 'learn/agentos/decisions');
        fs.ensureDirSync(adrDir);

        fs.writeFileSync(path.join(adrDir, '0001-example-adr.md'),
`# ADR 1
Example decision.`);

        fs.writeFileSync(path.join(adrDir, 'not-an-adr.md'),
`# Not an ADR
This should be skipped.`);

        fs.writeFileSync(path.join(adrDir, '0002-moved-record.md'), redirect);

        aiConfig.neoRootDir = mockRoot;
    });

    test.afterAll(() => {
        aiConfig.neoRootDir = originalRoot;
        if (mockRoot && fs.existsSync(mockRoot)) fs.removeSync(mockRoot);
    });

    test('is a Neo.setupClass singleton with the expected className and extract() method', () => {
        expect(AdrSource, 'default export must resolve').toBeDefined();
        expect(AdrSource.className).toBe('Neo.ai.services.knowledge-base.source.AdrSource');
        expect(typeof AdrSource.extract).toBe('function');
    });

    test('extract() emits correctly typed and chunked ADRs, skipping non-matching files and redirects', async () => {
        const written     = [];
        const writeStream = {
            write(chunkStr) {
                written.push(JSON.parse(chunkStr.trim()));
                return true;
            }
        };
        const createHashFn = chunk => 'hash:' + chunk.name;

        const count = await AdrSource.extract(writeStream, createHashFn);

        expect(count).toBe(1);
        expect(written).toHaveLength(1);

        const chunk = written[0];
        expect(chunk).toMatchObject({
            type   : 'adr',
            kind   : 'adr',
            name   : '0001-example-adr',
            content: '# ADR 1\nExample decision.'
        });
    });

    test('extractFromRepository() indexes the record and reports the redirect beside it as skipped', async () => {
        const
            files   = {
                'learn/agentos/decisions/0001-example-adr.md' : '# ADR 1\nExample decision.',
                'learn/agentos/decisions/0002-moved-record.md': redirect,
                'learn/agentos/decisions/README.md'           : '# Decisions'
            },
            written = [],
            result  = await AdrSource.extractFromRepository({
                context: {
                    repositoryReader: {readText: async sourcePath => files[sourcePath]},
                    territory       : {
                        assignments: Object.keys(files).map(sourcePath => ({
                            entry       : {sourcePath},
                            relativePath: path.posix.basename(sourcePath)
                        }))
                    }
                },
                writeStream : {write: line => written.push(JSON.parse(line))},
                createHashFn: chunk => 'hash:' + chunk.name
            });

        expect(result.count).toBe(1);
        expect(result.yieldedSourcePaths).toEqual(['learn/agentos/decisions/0001-example-adr.md']);
        expect(written.map(chunk => chunk.name)).toEqual(['0001-example-adr']);
        expect(result.skippedSourcePaths).toEqual([
            {sourcePath: 'learn/agentos/decisions/0002-moved-record.md', reason: 'redirect'},
            {sourcePath: 'learn/agentos/decisions/README.md',            reason: 'not-adr'}
        ]);
    });

    test('AC1 & AC2: shares the admitted catalog with AdrIngestor and classifies redirects identically across extract() and extractFromRepository()', async () => {
        const
            {default: AdrIngestor} = await import('../../../../../../../ai/services/ingestion/AdrIngestor.mjs'),
            {parseAdrRedirect}     = await import('../../../../../../../ai/services/shared/adrRedirect.mjs');

        AdrSource.resetCatalog();
        expect(AdrSource.getAdmissionCatalog()).toBe(AdrIngestor.admissionCatalog);

        const validPointer = parseAdrRedirect(redirect);
        expect(validPointer).toMatchObject({
            isRedirect: true,
            valid     : true,
            target    : 'adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0002',
            reasonCode: null
        });

        const forbiddenMetaPointer = parseAdrRedirect([
            '---',
            'type: redirect',
            'target: adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0002',
            'status: Accepted',
            '---',
            '# Moved'
        ].join('\n'));
        expect(forbiddenMetaPointer).toMatchObject({
            isRedirect: true,
            valid     : false,
            reasonCode: 'REDIRECT_METADATA_FORBIDDEN'
        });

        const
            canonicalKey0034 = 'adr:github.com:220867748:neomjs%2Fneo:0034',
            pointer0034      = [
                '---',
                'type: redirect',
                `target: ${canonicalKey0034}`,
                '---',
                '# Moved to neomjs/neo-agent-institution'
            ].join('\n'),
            full0034 = [
                '# ADR 0034: Electron Shell Architecture',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '| **Aliases** | `electron-shell-v1` |',
                '',
                '## 1. Context',
                'Moved from Engine to Institution.'
            ].join('\n'),
            neoFiles  = {'learn/agentos/decisions/0034-electron-shell-architecture.md': pointer0034},
            instFiles = {'learn/agentos/decisions/0034-electron-shell-architecture.md': full0034},
            chunks    = [];

        const neoResult = await AdrSource.extractFromRepository({
            context: {
                repository      : {forge: 'github.com', repositoryId: '220867748', namespace: 'neomjs/neo'},
                repositoryReader: {readText: async p => neoFiles[p]},
                territory       : {
                    assignments: [{
                        entry       : {sourcePath: 'learn/agentos/decisions/0034-electron-shell-architecture.md'},
                        relativePath: '0034-electron-shell-architecture.md'
                    }]
                }
            },
            writeStream : {write: line => chunks.push(JSON.parse(line))},
            createHashFn: c => `hash:${c.name}`
        });

        expect(neoResult.count).toBe(0);
        expect(neoResult.redirects).toHaveLength(1);
        expect(neoResult.redirects[0].target).toBe(canonicalKey0034);

        const instResult = await AdrSource.extractFromRepository({
            context: {
                repository        : {forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution'},
                custodyTransitions: [{
                    adrNumber       : '0034',
                    canonicalKey    : canonicalKey0034,
                    fromRepositoryId: '220867748',
                    toRepositoryId  : '1347756127',
                    toNamespace     : 'neomjs/neo-agent-institution'
                }],
                sourceLineageEvidence: [{canonicalKey: canonicalKey0034, adrNumber: '0034', alias: 'electron-shell-v1'}],
                repositoryReader     : {readText: async p => instFiles[p]},
                territory            : {
                    assignments: [{
                        entry       : {sourcePath: 'learn/agentos/decisions/0034-electron-shell-architecture.md'},
                        relativePath: '0034-electron-shell-architecture.md'
                    }]
                }
            },
            writeStream : {write: line => chunks.push(JSON.parse(line))},
            createHashFn: c => `hash:${c.name}`
        });

        expect(instResult.count).toBe(1);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].canonicalKey).toBe(canonicalKey0034);
        expect(AdrIngestor.admissionCatalog.get(canonicalKey0034)?.sourceTuple.namespace).toBe('neomjs/neo-agent-institution');
    });

    test('AC4: reconciles old-only, new-only, both-present, neither-present, and interrupted/retried states while refusing undeclared duplicate full ADR claims', async () => {
        AdrSource.resetCatalog();

        const
            key0020  = 'adr:github.com:220867748:neomjs%2Fneo:0020',
            body0020 = [
                '# ADR 0020: Agent Harness Concept',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '',
                '## 1. Context',
                'The harness concept.'
            ].join('\n'),
            pointer0020 = [
                '---',
                'type: redirect',
                `target: ${key0020}`,
                '---',
                '# Moved to neomjs/neo-agent-institution'
            ].join('\n'),
            neoRepo  = {forge: 'github.com', repositoryId: '220867748', namespace: 'neomjs/neo'},
            instRepo = {forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution'},
            custodyTransitions = [{
                adrNumber       : '0020',
                canonicalKey    : key0020,
                fromRepositoryId: '220867748',
                toRepositoryId  : '1347756127',
                toNamespace     : 'neomjs/neo-agent-institution'
            }];

        // 1. old-only: full ADR only in neomjs/neo
        const oldOnly = await AdrSource.reconcileDecisionStates({
            repositories: [{
                repository: neoRepo,
                files     : {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}
            }]
        });
        expect(oldOnly.reconciliation[key0020]).toMatchObject({
            state            : 'old-only',
            identityResolved : true,
            documentAvailable: true,
            kbAvailable      : true,
            redirectSkipped  : false
        });
        expect(oldOnly.chunks).toHaveLength(1);

        // 2. neither-present: redirect in neo, destination not yet synced
        const neitherPresent = await AdrSource.reconcileDecisionStates({
            repositories: [{
                repository: neoRepo,
                files     : {'learn/agentos/decisions/0020-agent-harness-concept.md': pointer0020}
            }]
        });
        expect(neitherPresent.reconciliation[key0020]).toMatchObject({
            state            : 'neither-present',
            identityResolved : true,
            documentAvailable: false,
            kbAvailable      : false,
            redirectSkipped  : true
        });
        expect(neitherPresent.chunks).toHaveLength(0);
        expect(AdrSource.resolveAdrReference(key0020)).toMatchObject({
            identityResolved : true,
            documentAvailable: false,
            kbAvailable      : false
        });

        // 3. new-only: moved record in neo-agent-institution with custody transition
        const newOnly = await AdrSource.reconcileDecisionStates({
            custodyTransitions,
            repositories: [{
                repository: instRepo,
                files     : {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}
            }]
        });
        expect(newOnly.reconciliation[key0020]).toMatchObject({
            state            : 'new-only',
            identityResolved : true,
            documentAvailable: true,
            kbAvailable      : true
        });
        expect(newOnly.chunks).toHaveLength(1);

        // 4. both-present (valid redirect at old path + full ADR at new path)
        const bothWithRedirect = await AdrSource.reconcileDecisionStates({
            custodyTransitions,
            repositories: [
                {repository: neoRepo,  files: {'learn/agentos/decisions/0020-agent-harness-concept.md': pointer0020}},
                {repository: instRepo, files: {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}}
            ]
        });
        expect(bothWithRedirect.reconciliation[key0020]).toMatchObject({
            state            : 'both-present',
            identityResolved : true,
            documentAvailable: true,
            kbAvailable      : true,
            redirectSkipped  : true
        });
        expect(bothWithRedirect.chunks).toHaveLength(1);

        // 5. both-present (undeclared competing full ADR claim in another repo without custody transition)
        const undeclaredDuplicate = await AdrSource.reconcileDecisionStates({
            repositories: [
                {repository: instRepo, files: {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}},
                {
                    repository: {...neoRepo, claimedCanonicalKey: key0020},
                    files     : {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}
                }
            ]
        });
        expect(undeclaredDuplicate.refusedSourcePaths).toHaveLength(1);
        expect(undeclaredDuplicate.refusedSourcePaths[0].code).toBe('ADR_COMPETING_CLAIM_REFUSED');
        expect(undeclaredDuplicate.chunks).toHaveLength(1);

        // 6. interrupted/retried: retryAttempt > 1 idempotently converges to 1 chunk
        const retried = await AdrSource.reconcileDecisionStates({
            custodyTransitions,
            retryAttempt: 2,
            repositories: [
                {repository: neoRepo,  files: {'learn/agentos/decisions/0020-agent-harness-concept.md': pointer0020}},
                {repository: instRepo, files: {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}}
            ]
        });
        expect(retried.reconciliation[key0020]).toMatchObject({
            state            : 'interrupted/retried',
            identityResolved : true,
            documentAvailable: true,
            kbAvailable      : true,
            retryAttempt     : 2
        });
        expect(retried.chunks).toHaveLength(1);
    });

    test('AC5, AC6, AC7 & AC8: coexists across repositories on bare number 0001, discovers evidenced territories, enforces private neo-stage reader bounds, resolves case-insensitive forge locators, and enforces canonical Aliases opening-table rules', async () => {
        AdrSource.resetCatalog();

        const
            brainRepo = {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', visibility: 'public'},
            stageRepo = {forge: 'github.com', repositoryId: '1350000001', namespace: 'neomjs/neo-stage', tenantId: 'stage-private', visibility: 'private'},
            brain0001 = [
                '# ADR 0001: Cross-Process Cache Coherence',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '| **Aliases** | `cache-coherence-v1`, `graph-cache-sync` |',
                '',
                '> **Aliases**: `ignored-blockquote-alias`',
                '- **Aliases**: `ignored-list-alias`',
                '```markdown',
                '| Attribute | Value |',
                '|---|---|',
                '| **Aliases** | `ignored-fenced-alias` |',
                '```',
                '',
                '## 1. Context',
                '| Attribute | Value |',
                '|---|---|',
                '| **Aliases** | `ignored-body-table-alias` |'
            ].join('\n'),
            stage0001 = [
                '# ADR 0001: The Engine Contract',
                '',
                '**Status:** Accepted — 2026-10-18',
                '**Context:** Stage 3D renderer contract.',
                '',
                '## 1. Context',
                'Stage uses prose metadata without an opening table.'
            ].join('\n'),
            engine0032Legacy = [
                '# ADR 0032: Institution-Cockpit Render-Model',
                '',
                '| | |',
                '|---|---|',
                '| **Status** | Accepted |',
                '',
                '## 1. Context',
                'Blank-header opening table without Aliases.'
            ].join('\n'),
            engine0032InvalidAliases = [
                '# ADR 0032: Institution-Cockpit Render-Model',
                '',
                '| | |',
                '|---|---|',
                '| **Status** | Accepted |',
                '| **Aliases** | `forbidden-in-blank-header-table` |',
                '',
                '## 1. Context',
                'Must be refused until normalized to Attribute | Value.'
            ].join('\n');

        // AC8: Discover evidenced ADR territories (learn/agentos/decisions and learn/decisions)
        const brainDiscovery = await AdrSource.discoverRepositoryAdrTerritories({
            repository: brainRepo,
            entries   : ['learn/agentos/decisions/0001-cross-process-cache-coherence.md', 'README.md']
        });
        expect(brainDiscovery.matchedRoots).toEqual(['learn/agentos/decisions']);

        const stageDiscovery = await AdrSource.discoverRepositoryAdrTerritories({
            repository: stageRepo,
            tenantId  : 'stage-private',
            visibility: 'private',
            entries   : ['learn/decisions/0001-the-engine-contract.md', 'src/gl/AvatarScene.mjs']
        });
        expect(stageDiscovery.matchedRoots).toEqual(['learn/decisions']);
        expect(stageDiscovery.visibility).toBe('private');
        expect(stageDiscovery.tenantId).toBe('stage-private');

        // AC5 & AC7: Reconcile Brain 0001, Stage 0001, and Engine 0032 legacy table shapes
        const reconciled = await AdrSource.reconcileDecisionStates({
            sourceLineageEvidence: [
                {adrNumber: '0001', alias: 'cache-coherence-v1'},
                {adrNumber: '0001', alias: 'graph-cache-sync'}
            ],
            repositories: [
                {
                    repository: brainRepo,
                    files     : {'learn/agentos/decisions/0001-cross-process-cache-coherence.md': brain0001}
                },
                {
                    repository: stageRepo,
                    files     : {'learn/decisions/0001-the-engine-contract.md': stage0001}
                },
                {
                    repository: {forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution'},
                    files     : {
                        'learn/agentos/decisions/0032-institution-cockpit-render-model.md': engine0032Legacy,
                        'learn/agentos/decisions/0033-invalid-legacy-aliases.md'          : engine0032InvalidAliases
                    }
                }
            ]
        });

        expect(reconciled.chunks).toHaveLength(3);
        expect(reconciled.refusedSourcePaths).toEqual([
            expect.objectContaining({
                file: '0033-invalid-legacy-aliases.md',
                code: 'ADR_NONCANONICAL_OPENING_TABLE'
            })
        ]);

        const
            brainKey = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001',
            stageKey = 'adr:github.com:1350000001:neomjs%2Fneo-stage:0001';

        expect(AdrSource.getAdmissionCatalog().has(brainKey)).toBe(true);
        expect(AdrSource.getAdmissionCatalog().has(stageKey)).toBe(true);

        // AC6: Case-insensitive human locator + historical alias resolution + repository rename without rewriting canonicalKey
        expect(AdrSource.resolveAdrReference('NeoMjs/Neo-Agent-Brain#adr:cache-coherence-v1', {forge: 'github.com'})).toMatchObject({
            resolved    : true,
            canonicalKey: brainKey,
            kbAvailable : true
        });
        expect(AdrSource.resolveAdrReference('neomjs/neo-agent-brain#adr:ignored-blockquote-alias', {forge: 'github.com'}).resolved).toBe(false);
        expect(AdrSource.resolveAdrReference('neomjs/neo-agent-brain#adr:ignored-body-table-alias', {forge: 'github.com'}).resolved).toBe(false);

        AdrSource.recordRepositoryRename({
            forge            : 'github.com',
            repositoryId     : '1344062228',
            previousNamespace: 'neomjs/neo-agent-brain',
            currentNamespace : 'neomjs/agent-os-brain',
            proof            : 'github-repo-id-1344062228'
        });

        const resolvedViaNewName = AdrSource.resolveAdrReference('NeoMjs/Agent-Os-Brain#adr:graph-cache-sync', {forge: 'github.com'});
        expect(resolvedViaNewName).toMatchObject({
            resolved    : true,
            canonicalKey: brainKey,
            kbAvailable : true
        });

        // AC5 & AC8: Unqualified 0001 never silently picks a winner, and private neo-stage is hidden from unauthorized readers
        const unqualifiedForPublic = AdrSource.resolveAdrReference('adr-0001', {surface: 'organization_discussion', forge: 'github.com'});
        expect(unqualifiedForPublic.resolved).toBe(false);
        expect(unqualifiedForPublic.reasonCode).toBe('MISSING_REPOSITORY_CONTEXT');
        expect(unqualifiedForPublic.candidates).toEqual([brainKey]);

        expect(AdrSource.resolveAdrReference('neomjs/neo-stage#adr:the-engine-contract', {forge: 'github.com'})).toMatchObject({
            resolved  : false,
            reasonCode: 'NOT_FOUND'
        });

        expect(AdrSource.resolveAdrReference('neomjs/neo-stage#adr:the-engine-contract', {
            forge   : 'github.com',
            tenantId: 'stage-private'
        })).toMatchObject({
            resolved    : true,
            canonicalKey: stageKey,
            kbAvailable : true
        });
    });
});
