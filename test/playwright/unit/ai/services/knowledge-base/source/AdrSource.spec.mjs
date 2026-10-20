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
import {execFileSync}  from 'child_process';
import Database        from 'better-sqlite3';
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

/**
 * @summary Builds a retained `adrAdmissionRecord` fixture representing prior graph admission evidence.
 * @param {Object} params
 * @returns {Object}
 */
function buildRetainedRecord({
    canonicalKey,
    adrNumber,
    title        = `ADR ${adrNumber}`,
    status       = 'Accepted',
    currentSlug,
    aliases      = [],
    forge        = 'github.com',
    repositoryId,
    namespace,
    sourcePath,
    tenantId     = null,
    visibility   = 'public'
}) {
    const allSlugs = [currentSlug, ...aliases.filter(a => a !== currentSlug)];
    return {
        canonicalKey,
        adrNumber,
        title,
        status,
        rawStatus         : status,
        supersedes        : [],
        currentSlug,
        historicalAliases : [...aliases],
        tenantId,
        visibility,
        assignmentEvidence: repositoryId ? {
            forge,
            repositoryId,
            namespace,
            number        : adrNumber,
            assignmentKind: 'created'
        } : null,
        sourceTuple: {
            forge,
            repositoryId: repositoryId || null,
            namespace   : namespace || null,
            path        : sourcePath
        },
        aliasBindings: repositoryId && namespace ? [
            ...allSlugs.map(slug => ({
                kind     : 'slug',
                value    : slug,
                forge,
                repositoryId,
                namespace,
                targetKey: canonicalKey,
                current  : slug === currentSlug
            })),
            {
                kind     : 'legacy-number',
                value    : adrNumber,
                forge,
                repositoryId,
                namespace,
                targetKey: canonicalKey,
                current  : true
            }
        ] : [],
        reservations: [],
        provenance  : {
            custodyTransitions: [],
            repositoryRenames : [],
            sourceLineage     : []
        },
        documentAvailable: true,
        kbAvailable      : true,
        stale            : false
    };
}

test.describe('Neo.ai.services.knowledge-base.source.AdrSource', () => {
    let AdrSource;
    let aiConfig;
    let originalRoot;
    let mockRoot;

    test.beforeAll(async () => {
        aiConfig  = (await import('../../../../../../../ai/mcp/server/knowledge-base/config.template.mjs')).default;
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
        AdrSource.resetCatalog();
        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: 'adr-0001',
                adrNumber   : '0001',
                currentSlug : 'example-adr',
                sourcePath  : 'learn/agentos/decisions/0001-example-adr.md'
            })
        ]);

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
        AdrSource.resetCatalog();
        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: 'adr-0001',
                adrNumber   : '0001',
                currentSlug : 'example-adr',
                sourcePath  : 'learn/agentos/decisions/0001-example-adr.md'
            })
        ]);

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
        expect(result.admissionAvailable).toBe(true);
        expect(result.yieldedSourcePaths).toEqual(['learn/agentos/decisions/0001-example-adr.md']);
        expect(written.map(chunk => chunk.name)).toEqual(['0001-example-adr']);
        expect(result.skippedSourcePaths).toEqual([
            {sourcePath: 'learn/agentos/decisions/0002-moved-record.md', reason: 'redirect'},
            {sourcePath: 'learn/agentos/decisions/README.md',            reason: 'not-adr'}
        ]);
    });

    test('AC1: AdrSource admits only against retained admission evidence, refuses unproved files when evidence is unavailable, and runs in a KB child process without AdrIngestor', async () => {
        const
            {default: AdrIngestor}       = await import('../../../../../../../ai/services/ingestion/AdrIngestor.mjs'),
            {bindSharedAdrRecordAliases} = await import('../../../../../../../ai/services/ingestion/adrAdmissionCatalog.mjs'),
            codecModule                  = await import('../../../../../../../ai/services/shared/adrIdentityCodec.mjs');

        AdrSource.resetCatalog();
        expect(AdrSource.getAdmissionCatalog()).toBe(AdrIngestor.admissionCatalog);

        // adrIdentityCodec.mjs stays a pure codec without mutable catalog state or alias binding exports
        expect(codecModule.SHARED_ADR_CATALOG_STATE).toBeUndefined();
        expect(codecModule.bindSharedAdrRecordAliases).toBeUndefined();

        // bindSharedAdrRecordAliases refuses records lacking an explicit <organization>/<repository> namespace
        expect(() => bindSharedAdrRecordAliases(
            {canonicalKey: 'adr-0001', aliasBindings: [], reservations: []},
            null,
            {canonicalKey: 'adr-0001', adrNumber: '0001', currentSlug: 'example-adr', historicalAliases: []}
        )).toThrow(/ADR_MISSING_SOURCE_NAMESPACE|without an explicit source namespace/u);

        // 1. In-process: without retained admission evidence, AdrSource refuses to admit from files
        const
            unprovedKey    = 'adr:github.com:220867748:neomjs%2Fneo:0099',
            unprovedChunks = [],
            unprovedResult = await AdrSource.extractFromRepository({
                context: {
                    repository      : {forge: 'github.com', repositoryId: '220867748', namespace: 'neomjs/neo'},
                    sqlitePath      : path.join(mockRoot, 'nonexistent-memory-core.sqlite'),
                    repositoryReader: {readText: async () => '# ADR 0099: Unadmitted Candidate\n\nBody.'},
                    territory       : {
                        assignments: [{
                            entry       : {sourcePath: 'learn/agentos/decisions/0099-unadmitted-candidate.md'},
                            relativePath: '0099-unadmitted-candidate.md'
                        }]
                    }
                },
                writeStream : {write: line => unprovedChunks.push(JSON.parse(line))},
                createHashFn: c => `hash:${c.name}`
            });

        expect(unprovedResult.count).toBe(0);
        expect(unprovedResult.admissionAvailable).toBe(false);
        expect(unprovedResult.code).toBe('ADR_ADMISSION_EVIDENCE_UNAVAILABLE');
        expect(unprovedChunks).toHaveLength(0);
        expect(unprovedResult.skippedSourcePaths).toEqual([{
            sourcePath: 'learn/agentos/decisions/0099-unadmitted-candidate.md',
            path      : 'learn/agentos/decisions/0099-unadmitted-candidate.md',
            reason    : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
            message   : 'Retained ADR admission evidence is unavailable for candidate decision'
        }]);
        expect(unprovedResult.refusedSourcePaths).toEqual([
            expect.objectContaining({
                sourcePath  : 'learn/agentos/decisions/0099-unadmitted-candidate.md',
                canonicalKey: unprovedKey,
                code        : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE'
            })
        ]);
        expect(unprovedResult.reconciliation[unprovedKey]).toMatchObject({
            state             : 'admission-unavailable',
            admissionAvailable: false,
            identityResolved  : false,
            documentAvailable : true,
            kbAvailable       : false
        });
        expect(AdrSource.getAdmissionCatalog().has(unprovedKey)).toBe(false);

        // 2. Cross-process: run ExtractorCatalogue('AdrSource') in a fresh Node process where AdrIngestor is NEVER loaded
        const
            canonicalKey0034 = 'adr:github.com:220867748:neomjs%2Fneo:0034',
            canonicalKey0042 = 'adr:github.com:220867748:neomjs%2Fneo:0042',
            sqliteFile       = path.join(mockRoot, 'cross-process-admission.sqlite'),
            missingSqlite    = path.join(mockRoot, 'missing-admission.sqlite'),
            retained0034     = buildRetainedRecord({
                canonicalKey: canonicalKey0034,
                adrNumber   : '0034',
                title       : 'Electron Shell Architecture',
                currentSlug : 'electron-shell-architecture',
                aliases     : ['electron-shell-v1'],
                repositoryId: '220867748',
                namespace   : 'neomjs/neo',
                sourcePath  : 'learn/agentos/decisions/0034-electron-shell-architecture.md'
            }),
            retained0042     = buildRetainedRecord({
                canonicalKey: canonicalKey0042,
                adrNumber   : '0042',
                title       : 'Live Admission Projection',
                currentSlug : 'live-admission-projection',
                repositoryId: '220867748',
                namespace   : 'neomjs/neo',
                sourcePath  : 'learn/agentos/decisions/0042-live-admission-projection.md'
            });

        const db = new Database(sqliteFile);
        db.exec(`CREATE TABLE Nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
        const insertNode = db.prepare(`INSERT INTO Nodes (id, data) VALUES (?, ?)`);
        insertNode.run(
            canonicalKey0034,
            JSON.stringify({
                id        : canonicalKey0034,
                label     : 'ADR',
                properties: {
                    adrAuthority      : {admitted: true, canonicalKey: canonicalKey0034},
                    adrAdmissionRecord: retained0034
                }
            })
        );
        insertNode.run(
            canonicalKey0042,
            JSON.stringify({
                id        : canonicalKey0042,
                label     : 'ADR',
                properties: {
                    adrAuthority      : {admitted: true, canonicalKey: canonicalKey0042},
                    adrAdmissionRecord: retained0042
                }
            })
        );
        db.close();

        const childScript = `
            import Neo from 'neo.mjs/src/Neo.mjs';
            import * as core from 'neo.mjs/src/core/_export.mjs';
            import {ExtractorCatalogue} from './ai/services/knowledge-base/source/ExtractorCatalogue.mjs';

            const descriptor = ExtractorCatalogue.get('AdrSource');
            const files = {
                'learn/agentos/decisions/0034-electron-shell-architecture.md': '# ADR 0034: Electron Shell Architecture\\n\\n| Attribute | Value |\\n|---|---|\\n| **Status** | Accepted |\\n| **Aliases** | \`electron-shell-v1\` |\\n\\n## 1. Context\\nBody.',
                'learn/agentos/decisions/0042-live-admission-projection.md': '# ADR 0042: Live Admission Projection\\n\\n| Attribute | Value |\\n|---|---|\\n| **Status** | Accepted |\\n\\n## 1. Context\\nNewly authored decision.',
                'learn/agentos/decisions/0002-moved-record.md': ${JSON.stringify(redirect)}
            };
            const chunks = [];
            const res = await descriptor.extract({
                context: {
                    repository: {forge: 'github.com', repositoryId: '220867748', namespace: 'neomjs/neo'},
                    sourceLineageEvidence: [{canonicalKey: '${canonicalKey0034}', adrNumber: '0034', alias: 'electron-shell-v1'}],
                    repositoryReader: {readText: async p => files[p]},
                    territory: {
                        assignments: Object.keys(files).map(sourcePath => ({
                            entry: {sourcePath},
                            relativePath: sourcePath.split('/').pop()
                        }))
                    }
                },
                writeStream: {write: line => chunks.push(JSON.parse(line))},
                createHashFn: c => 'hash:' + c.name
            });
            process.stdout.write(JSON.stringify({
                adrIngestorLoaded: Boolean(Neo.ai?.daemons?.services?.AdrIngestor),
                count: res.count,
                admissionAvailable: res.admissionAvailable,
                code: res.code || null,
                refusedCodes: res.refusedSourcePaths.map(r => r.code),
                redirectsCount: res.redirects.length,
                chunkKeys: chunks.map(c => c.canonicalKey)
            }));
        `;

        // 2a. Child process without AdrIngestor and with no retained admission evidence in SQLite
        // never admits from markdown files alone or a static code-list, reporting ADR_ADMISSION_EVIDENCE_UNAVAILABLE
        const unavailableStdout = execFileSync(
            process.execPath,
            ['--input-type=module', '-e', childScript],
            {
                cwd     : repoRoot,
                encoding: 'utf8',
                env     : {
                    ...process.env,
                    NEO_MEMORY_DB_PATH        : missingSqlite,
                    NEO_TELEMETRY_DB_PATH_TEST: missingSqlite
                }
            }
        );
        const unavailableChild = JSON.parse(unavailableStdout.trim().split('\n').pop());
        expect(unavailableChild).toEqual({
            adrIngestorLoaded : false,
            count             : 0,
            admissionAvailable: false,
            code              : 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE',
            refusedCodes      : ['ADR_ADMISSION_EVIDENCE_UNAVAILABLE', 'ADR_ADMISSION_EVIDENCE_UNAVAILABLE'],
            redirectsCount    : 1,
            chunkKeys         : []
        });

        // 2b. Child process without AdrIngestor rehydrates retained admission evidence from SQLite (aiConfig.memoryCoreDbPath),
        // admitting both 0034 and newly authored 0042 without any static code-list edit
        const admittedStdout = execFileSync(
            process.execPath,
            ['--input-type=module', '-e', childScript],
            {
                cwd     : repoRoot,
                encoding: 'utf8',
                env     : {
                    ...process.env,
                    NEO_MEMORY_DB_PATH        : sqliteFile,
                    NEO_TELEMETRY_DB_PATH_TEST: sqliteFile
                }
            }
        );
        const admittedChild = JSON.parse(admittedStdout.trim().split('\n').pop());
        expect(admittedChild).toEqual({
            adrIngestorLoaded : false,
            count             : 2,
            admissionAvailable: true,
            code              : null,
            refusedCodes      : [],
            redirectsCount    : 1,
            chunkKeys         : [canonicalKey0034, canonicalKey0042]
        });
    });

    test('AC2: reconciles old-only, new-only, both-present, neither-present, and interrupted/retried states while distinguishing identityResolved, documentAvailable, and kbAvailable', async () => {
        const {parseAdrRedirect} = await import('../../../../../../../ai/services/shared/adrRedirect.mjs');

        AdrSource.resetCatalog();

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

        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: key0020,
                adrNumber   : '0020',
                title       : 'Agent Harness Concept',
                currentSlug : 'agent-harness-concept',
                repositoryId: '220867748',
                namespace   : 'neomjs/neo',
                sourcePath  : 'learn/agentos/decisions/0020-agent-harness-concept.md'
            })
        ]);

        // 1. old-only: full ADR only in neomjs/neo
        const oldOnly = await AdrSource.reconcileDecisionStates({
            repositories: [{
                repository: neoRepo,
                files     : {'learn/agentos/decisions/0020-agent-harness-concept.md': body0020}
            }]
        });
        expect(oldOnly.reconciliation[key0020]).toMatchObject({
            state             : 'old-only',
            admissionAvailable: true,
            identityResolved  : true,
            documentAvailable : true,
            kbAvailable       : true,
            redirectSkipped   : false
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

    test('AC4: projects ADR chunks through TenantRepoIngestEnvelopeBuilder, createRepositoryRevisionReader, and diffTenantExtractionIdentity with unchanged-source no-op reruns and redirect source tombstones', async () => {
        const
            {buildIngestEnvelope}          = await import('../../../../../../../ai/services/knowledge-base/helpers/tenantRepoIngestEnvelopeBuilder.mjs'),
            {deriveTenantRepoMirrorPath}   = await import('../../../../../../../ai/services/knowledge-base/helpers/tenantRepoAccessContract.mjs'),
            {createCoreCorpusProfilePlan}  = await import('../../../../../../../ai/services/knowledge-base/helpers/coreCorpusProfilePlan.mjs'),
            {diffTenantExtractionIdentity} = await import('../../../../../../../ai/services/knowledge-base/helpers/kbReconciliationEngine.mjs');

        AdrSource.resetCatalog();

        const
            key0020    = 'adr:github.com:220867748:neomjs%2Fneo:0020',
            sourcePath = 'learn/agentos/decisions/0020-agent-harness-concept.md',
            rev1       = '1'.repeat(40),
            rev2       = '2'.repeat(40),
            rev3       = '3'.repeat(40),
            mirrorRoot = path.join(mockRoot, 'mirrors'),
            mirrorPath = deriveTenantRepoMirrorPath({mirrorRoot, tenantId: 'neo-shared', repoSlug: 'neomjs/neo'}),
            body0020   = [
                '# ADR 0020: Agent Harness Concept',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '',
                '## 1. Context',
                'Revision-bound KB projection test.'
            ].join('\n'),
            body0020Updated = [
                '# ADR 0020: Agent Harness Concept',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '',
                '## 1. Context',
                'Updated revision-bound KB projection test.'
            ].join('\n'),
            pointer0020 = [
                '---',
                'type: redirect',
                `target: ${key0020}`,
                '---',
                '# Moved to neomjs/neo-agent-institution'
            ].join('\n');

        fs.ensureDirSync(mirrorPath);

        const
            plan       = createCoreCorpusProfilePlan('neo'),
            adrProfile = {
                ...plan.profile,
                routes: plan.profile.routes.filter(route => route.extractorId === 'AdrSource')
            },
            revisions = {
                [rev1]: {[sourcePath]: body0020},
                [rev2]: {[sourcePath]: pointer0020},
                [rev3]: {[sourcePath]: body0020Updated}
            },
            gitMirror = {
                async resolveHead({ref}) {
                    return ref;
                },
                async isAncestor() {
                    return true;
                },
                async diffRevisions({baseRevision, headRevision}) {
                    if (baseRevision === headRevision) {
                        return {addedOrChanged: [], deleted: []};
                    }
                    return {
                        addedOrChanged: [sourcePath],
                        deleted       : []
                    };
                },
                async listRevisionEntries({revision}) {
                    const files = revisions[revision] || {};
                    return Object.keys(files).sort().map(p => ({
                        sourcePath: p,
                        mode      : '100644',
                        type      : 'blob',
                        oid       : revision
                    }));
                },
                async readRevisionBlob({revision, sourcePath: p}) {
                    return Buffer.from(revisions[revision][p], 'utf8');
                },
                async prefetchRevisionBlobs() {
                    return {status: 'local'};
                }
            };

        // 0. When retained admission evidence is absent, full and delta envelopes preserve existing admitted
        //    production data instead of masquerading as an empty extraction that tombstones prior documents.
        const unverifiedFullEnvelope = await buildIngestEnvelope({
            tenantId         : 'neo-shared',
            repoSlug         : 'neomjs/neo',
            mirrorRoot,
            rootKind         : 'bare-repo',
            lastIngestedRev  : null,
            newHead          : rev1,
            extractionProfile: adrProfile,
            gitMirror
        });
        expect(unverifiedFullEnvelope.admissionAvailable).toBe(false);
        expect(unverifiedFullEnvelope.admissionUnavailablePaths).toEqual([sourcePath]);
        expect(unverifiedFullEnvelope.files).toEqual([]);
        expect(unverifiedFullEnvelope.manifestSnapshot.yieldedSourcePaths).toBeUndefined();

        const unverifiedDeltaEnvelope = await buildIngestEnvelope({
            tenantId         : 'neo-shared',
            repoSlug         : 'neomjs/neo',
            mirrorRoot,
            rootKind         : 'bare-repo',
            lastIngestedRev  : rev1,
            newHead          : rev3,
            extractionProfile: adrProfile,
            gitMirror
        });
        expect(unverifiedDeltaEnvelope.admissionAvailable).toBe(false);
        expect(unverifiedDeltaEnvelope.admissionUnavailablePaths).toEqual([sourcePath]);
        expect(unverifiedDeltaEnvelope.files).toEqual([]);
        expect(unverifiedDeltaEnvelope.deleted).toEqual([]);

        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: key0020,
                adrNumber   : '0020',
                title       : 'Agent Harness Concept',
                currentSlug : 'agent-harness-concept',
                repositoryId: '220867748',
                namespace   : 'neomjs/neo',
                sourcePath
            })
        ]);

        // 1. Initial revision (rev1): revision-bound reader yields the admitted ADR chunk
        const rev1Envelope = await buildIngestEnvelope({
            tenantId         : 'neo-shared',
            repoSlug         : 'neomjs/neo',
            mirrorRoot,
            rootKind         : 'bare-repo',
            lastIngestedRev  : null,
            newHead          : rev1,
            extractionProfile: adrProfile,
            gitMirror
        });

        expect(rev1Envelope.headRevision).toBe(rev1);
        expect(rev1Envelope.admissionAvailable).toBe(true);
        expect(rev1Envelope.deleted).toBeUndefined();
        expect(rev1Envelope.files).toHaveLength(1);
        expect(rev1Envelope.files[0]).toMatchObject({
            sourcePath,
            repoSlug    : 'neomjs/neo',
            extractorId : 'AdrSource',
            profileChunk: {
                source      : sourcePath,
                name        : '0020-agent-harness-concept',
                canonicalKey: key0020,
                namespace   : 'neomjs/neo',
                revision    : rev1
            }
        });
        expect(rev1Envelope.manifestSnapshot.yieldedSourcePaths).toEqual([sourcePath]);

        // 2. Unchanged-source rerun (rev1 -> rev1): delta diff produces a complete no-op
        const noopEnvelope = await buildIngestEnvelope({
            tenantId         : 'neo-shared',
            repoSlug         : 'neomjs/neo',
            mirrorRoot,
            rootKind         : 'bare-repo',
            lastIngestedRev  : rev1,
            newHead          : rev1,
            extractionProfile: adrProfile,
            gitMirror
        });

        expect(noopEnvelope.headRevision).toBe(rev1);
        expect(noopEnvelope.files).toEqual([]);
        expect(noopEnvelope.deleted).toEqual([]);

        // 3. Move-out redirect revision (rev1 -> rev2): replacing ADR with redirect emits a source tombstone
        //    and diffTenantExtractionIdentity marks the prior rev1 chunk row as unyielded/actionable.
        const rev2Envelope = await buildIngestEnvelope({
            tenantId         : 'neo-shared',
            repoSlug         : 'neomjs/neo',
            mirrorRoot,
            rootKind         : 'bare-repo',
            lastIngestedRev  : rev1,
            newHead          : rev2,
            extractionProfile: adrProfile,
            gitMirror
        });

        expect(rev2Envelope.headRevision).toBe(rev2);
        expect(rev2Envelope.files).toEqual([]);
        expect(rev2Envelope.deleted).toEqual([
            {sourcePath, repoSlug: 'neomjs/neo'}
        ]);

        const
            priorExtractionIdentity = '0'.repeat(64),
            reconciliationDiff      = diffTenantExtractionIdentity({
                rows: [{
                    id      : `${key0020}@rev1`,
                    metadata: {
                        tenantId          : 'neo-shared',
                        repoSlug          : 'neomjs/neo',
                        sourcePath,
                        extractionIdentity: priorExtractionIdentity,
                        ingestedAt        : 100
                    }
                }],
                tenantId      : 'neo-shared',
                declaredByRepo: {
                    'neomjs/neo': {extractionIdentity: rev2Envelope.extractionIdentity}
                },
                extractionSnapshotsByRepo: {
                    'neomjs/neo': {
                        extractionIdentity: rev2Envelope.extractionIdentity,
                        yieldedSourcePaths: [],
                        updatedAt         : 200
                    }
                }
            });

        expect(reconciliationDiff.extractionOrphans).toEqual([
            expect.objectContaining({
                id      : `${key0020}@rev1`,
                repoSlug: 'neomjs/neo',
                sourcePath,
                tier    : 'unyielded',
                reason  : 'extraction-currency-mismatch'
            })
        ]);
        expect(reconciliationDiff.actionableIds).toEqual([`${key0020}@rev1`]);
    });

    test('AC5: coexists across repositories on bare number 0001 (neomjs/neo-agent-brain 0001 and neomjs/neo-stage 0001) without collision or silent unqualified winner selection', async () => {
        AdrSource.resetCatalog();

        const
            brainRepo = {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', visibility: 'public'},
            stageRepo = {forge: 'github.com', repositoryId: '1350000001', namespace: 'neomjs/neo-stage', tenantId: 'stage-private', visibility: 'private'},
            brainKey  = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001',
            stageKey  = 'adr:github.com:1350000001:neomjs%2Fneo-stage:0001',
            brain0001 = '# ADR 0001: Cross-Process Cache Coherence\n\n| Attribute | Value |\n|---|---|\n| **Status** | Accepted |\n\n## 1. Context\nBrain 0001.',
            stage0001 = '# ADR 0001: The Engine Contract\n\n**Status:** Accepted — 2026-10-18\n\n## 1. Context\nStage 0001.';

        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: brainKey,
                adrNumber   : '0001',
                title       : 'Cross-Process Cache Coherence',
                currentSlug : 'cross-process-cache-coherence',
                repositoryId: '1344062228',
                namespace   : 'neomjs/neo-agent-brain',
                sourcePath  : 'learn/agentos/decisions/0001-cross-process-cache-coherence.md'
            }),
            buildRetainedRecord({
                canonicalKey: stageKey,
                adrNumber   : '0001',
                title       : 'The Engine Contract',
                currentSlug : 'the-engine-contract',
                repositoryId: '1350000001',
                namespace   : 'neomjs/neo-stage',
                sourcePath  : 'learn/decisions/0001-the-engine-contract.md',
                tenantId    : 'stage-private',
                visibility  : 'private'
            })
        ]);

        const reconciled = await AdrSource.reconcileDecisionStates({
            repositories: [
                {repository: brainRepo, files: {'learn/agentos/decisions/0001-cross-process-cache-coherence.md': brain0001}},
                {repository: stageRepo, files: {'learn/decisions/0001-the-engine-contract.md': stage0001}}
            ]
        });

        expect(reconciled.chunks).toHaveLength(2);
        expect(AdrSource.getAdmissionCatalog().has(brainKey)).toBe(true);
        expect(AdrSource.getAdmissionCatalog().has(stageKey)).toBe(true);

        const unqualifiedForPublic = AdrSource.resolveAdrReference('adr-0001', {surface: 'organization_discussion', forge: 'github.com'});
        expect(unqualifiedForPublic.resolved).toBe(false);
        expect(unqualifiedForPublic.reasonCode).toBe('MISSING_REPOSITORY_CONTEXT');
        expect(unqualifiedForPublic.candidates).toEqual([brainKey]);
    });

    test('AC6: resolves case-insensitive human locators, historical opening-table Aliases, and proved repository renames without rewriting canonical keys', async () => {
        AdrSource.resetCatalog();

        const
            brainRepo = {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', visibility: 'public'},
            brainKey  = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001',
            brain0001 = [
                '# ADR 0001: Cross-Process Cache Coherence',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '| **Aliases** | `cache-coherence-v1`, `graph-cache-sync` |',
                '',
                '## 1. Context',
                'Body.'
            ].join('\n');

        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: brainKey,
                adrNumber   : '0001',
                title       : 'Cross-Process Cache Coherence',
                currentSlug : 'cross-process-cache-coherence',
                aliases     : ['cache-coherence-v1', 'graph-cache-sync'],
                repositoryId: '1344062228',
                namespace   : 'neomjs/neo-agent-brain',
                sourcePath  : 'learn/agentos/decisions/0001-cross-process-cache-coherence.md'
            })
        ]);

        await AdrSource.reconcileDecisionStates({
            sourceLineageEvidence: [
                {adrNumber: '0001', alias: 'cache-coherence-v1'},
                {adrNumber: '0001', alias: 'graph-cache-sync'}
            ],
            repositories: [
                {repository: brainRepo, files: {'learn/agentos/decisions/0001-cross-process-cache-coherence.md': brain0001}}
            ]
        });

        expect(AdrSource.resolveAdrReference('NeoMjs/Neo-Agent-Brain#adr:cache-coherence-v1', {forge: 'github.com'})).toMatchObject({
            resolved    : true,
            canonicalKey: brainKey,
            kbAvailable : true
        });

        AdrSource.recordRepositoryRename({
            forge            : 'github.com',
            repositoryId     : '1344062228',
            previousNamespace: 'neomjs/neo-agent-brain',
            currentNamespace : 'neomjs/agent-os-brain',
            proof            : 'github-repo-id-1344062228'
        });

        expect(AdrSource.resolveAdrReference('NeoMjs/Agent-Os-Brain#adr:graph-cache-sync', {forge: 'github.com'})).toMatchObject({
            resolved    : true,
            canonicalKey: brainKey,
            kbAvailable : true
        });
    });

    test('AC7: parses opening-table Aliases strictly from the single canonical Attribute | Value table while accepting prose-header and blank-header ADRs without Aliases', async () => {
        AdrSource.resetCatalog();

        const
            brainRepo   = {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', visibility: 'public'},
            instRepo    = {forge: 'github.com', repositoryId: '1347756127', namespace: 'neomjs/neo-agent-institution', visibility: 'public'},
            brainKey    = 'adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0001',
            instKey0032 = 'adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0032',
            brain0001   = [
                '# ADR 0001: Cross-Process Cache Coherence',
                '',
                '| Attribute | Value |',
                '|---|---|',
                '| **Status** | Accepted |',
                '| **Aliases** | `cache-coherence-v1` |',
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
            engine0033InvalidAliases = [
                '# ADR 0033: Invalid Legacy Aliases',
                '',
                '| | |',
                '|---|---|',
                '| **Status** | Accepted |',
                '| **Aliases** | `forbidden-in-blank-header-table` |',
                '',
                '## 1. Context',
                'Must be refused until normalized to Attribute | Value.'
            ].join('\n');

        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: brainKey,
                adrNumber   : '0001',
                title       : 'Cross-Process Cache Coherence',
                currentSlug : 'cross-process-cache-coherence',
                aliases     : ['cache-coherence-v1'],
                repositoryId: '1344062228',
                namespace   : 'neomjs/neo-agent-brain',
                sourcePath  : 'learn/agentos/decisions/0001-cross-process-cache-coherence.md'
            }),
            buildRetainedRecord({
                canonicalKey: instKey0032,
                adrNumber   : '0032',
                title       : 'Institution-Cockpit Render-Model',
                currentSlug : 'institution-cockpit-render-model',
                repositoryId: '1347756127',
                namespace   : 'neomjs/neo-agent-institution',
                sourcePath  : 'learn/agentos/decisions/0032-institution-cockpit-render-model.md'
            })
        ]);

        const reconciled = await AdrSource.reconcileDecisionStates({
            sourceLineageEvidence: [{adrNumber: '0001', alias: 'cache-coherence-v1'}],
            repositories         : [
                {
                    repository: brainRepo,
                    files     : {'learn/agentos/decisions/0001-cross-process-cache-coherence.md': brain0001}
                },
                {
                    repository: instRepo,
                    files     : {
                        'learn/agentos/decisions/0032-institution-cockpit-render-model.md': engine0032Legacy,
                        'learn/agentos/decisions/0033-invalid-legacy-aliases.md'          : engine0033InvalidAliases
                    }
                }
            ]
        });

        expect(reconciled.chunks).toHaveLength(2);
        expect(reconciled.refusedSourcePaths).toEqual([
            expect.objectContaining({
                file: '0033-invalid-legacy-aliases.md',
                code: 'ADR_NONCANONICAL_OPENING_TABLE'
            })
        ]);
        expect(AdrSource.resolveAdrReference('neomjs/neo-agent-brain#adr:ignored-blockquote-alias', {forge: 'github.com'}).resolved).toBe(false);
        expect(AdrSource.resolveAdrReference('neomjs/neo-agent-brain#adr:ignored-body-table-alias', {forge: 'github.com'}).resolved).toBe(false);
    });

    test('AC8: discovers evidenced ADR territories across learn/agentos/decisions and learn/decisions while enforcing private neo-stage reader authorization bounds', async () => {
        AdrSource.resetCatalog();

        const
            brainRepo = {forge: 'github.com', repositoryId: '1344062228', namespace: 'neomjs/neo-agent-brain', visibility: 'public'},
            stageRepo = {forge: 'github.com', repositoryId: '1350000001', namespace: 'neomjs/neo-stage', tenantId: 'stage-private', visibility: 'private'},
            stageKey  = 'adr:github.com:1350000001:neomjs%2Fneo-stage:0001',
            stage0001 = [
                '# ADR 0001: The Engine Contract',
                '',
                '**Status:** Accepted — 2026-10-18',
                '**Context:** Stage 3D renderer contract.',
                '',
                '## 1. Context',
                'Stage uses prose metadata without an opening table.'
            ].join('\n');

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

        AdrSource.hydrateAdmissionEvidence([
            buildRetainedRecord({
                canonicalKey: stageKey,
                adrNumber   : '0001',
                title       : 'The Engine Contract',
                currentSlug : 'the-engine-contract',
                repositoryId: '1350000001',
                namespace   : 'neomjs/neo-stage',
                sourcePath  : 'learn/decisions/0001-the-engine-contract.md',
                tenantId    : 'stage-private',
                visibility  : 'private'
            })
        ]);

        await AdrSource.reconcileDecisionStates({
            repositories: [
                {repository: stageRepo, files: {'learn/decisions/0001-the-engine-contract.md': stage0001}}
            ]
        });

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
