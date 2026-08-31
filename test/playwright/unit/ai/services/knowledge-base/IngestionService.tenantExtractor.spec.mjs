import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : 'IngestionServiceTenantExtractorTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import aiConfig       from '../../../../../../ai/mcp/server/knowledge-base/config.template.mjs';

test.describe.configure({mode: 'serial'});

function createGraphStub() {
    const store = new Map();

    return {
        store,
        async ready() {},
        getNodeRecord({id}) {
            return store.get(id) || null
        },
        listNodeRecordsByType({type}) {
            return {
                records: [...store.values()].filter(record => record.type === type)
            }
        },
        async upsertNode({id, type, properties}) {
            store.set(id, {id, type, properties: {...properties}})
        }
    }
}

function repo(extractionProfile) {
    return {
        cloneUrl     : 'https://github.com/acme/docs.git',
        credentialRef: 'env:ACME_DOCS_TOKEN',
        ...(extractionProfile ? {extractionProfile} : {})
    }
}

function customProfile(extractorId) {
    return {
        profileSchemaVersion: 1,
        routes              : [{
            territory: {
                roots  : ['docs'],
                include: ['**/*.md']
            },
            extractorId
        }],
        fallback: {action: 'exclude'}
    }
}

test.describe('IngestionService tenant extraction projection (#262)', () => {
    let Service, graphStub, originals, tmpRoot, extractorRoot;

    test.beforeAll(async () => {
        Service       = (await import('../../../../../../ai/services/knowledge-base/IngestionService.mjs')).default;
        tmpRoot       = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tenant-extractor-'));
        extractorRoot = path.join(tmpRoot, 'kb-extractors');

        fs.mkdirSync(extractorRoot, {recursive: true});
        fs.writeFileSync(path.join(extractorRoot, 'DocsV1.mjs'), `
export default {
    extractorId: 'TenantDocs',
    version: '1.0.0',
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
        fs.writeFileSync(path.join(extractorRoot, 'DocsV2.mjs'), `
export default {
    extractorId: 'TenantDocs',
    version: '2.0.0',
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
        fs.writeFileSync(path.join(extractorRoot, 'Collision.mjs'), `
export default {
    extractorId: 'RawRepoSource',
    version: '9.0.0',
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
        fs.writeFileSync(path.join(extractorRoot, 'UnsafeDelta.mjs'), `
export default {
    extractorId: 'UnsafeDelta',
    version: '1.0.0',
    deltaSafe: true,
    async extract() { return {count: 0, yieldedSourcePaths: []} }
};
`);
    });

    test.afterAll(() => {
        aiConfig.setEnvOverride('NEO_KB_TENANT_EXTRACTOR_ROOT', '');
        fs.rmSync(tmpRoot, {recursive: true, force: true});
    });

    test.beforeEach(() => {
        graphStub = createGraphStub();
        originals = {
            graphService         : Service.graphService,
            readKbConfigBootstrap: Service.readKbConfigBootstrap,
            requestContextService: Service.requestContextService
        };

        Service.graphService          = graphStub;
        Service.readKbConfigBootstrap = () => null;
        Service.requestContextService = {
            getAgentIdentityNodeId: () => '@tenant-a',
            getUserId             : () => 'tenant-a'
        };
        aiConfig.setEnvOverride('NEO_KB_TENANT_EXTRACTOR_ROOT', extractorRoot);
    });

    test.afterEach(() => Object.assign(Service, originals));

    test('one projection canonicalizes graph config and derives module-owned extraction identity', async () => {
        const write = await Service.setTenantConfig({
            tenantId: 'tenant-a',
            config  : {
                customExtractors: [{extractorModule: 'DocsV1.mjs'}],
                tenantRepos     : [repo(customProfile('TenantDocs'))]
            }
        });

        expect(write).toMatchObject({tenantId: 'tenant-a', version: 1});

        const stored   = graphStub.store.get('kb-config:tenant-a').properties;
        const resolved = await Service.getTenantConfig({tenantId: 'tenant-a'});
        const listed   = await Service.listConfiguredTenantRepos();

        expect(stored.customExtractors).toEqual([{extractorModule: 'DocsV1.mjs'}]);
        expect(stored.tenantRepos[0]).not.toHaveProperty('extractionIdentity');
        expect(resolved.customExtractors).toEqual(stored.customExtractors);
        expect(resolved.tenantRepos[0].extractionProfile).toEqual(stored.tenantRepos[0].extractionProfile);
        expect(resolved.tenantRepos[0].extractionIdentity).toMatch(/^[a-f0-9]{64}$/u);
        expect(listed.tenantRepos[0].extractionIdentity).toBe(resolved.tenantRepos[0].extractionIdentity);
    });

    test('synthesizes and digests the RawRepoSource compatibility profile when absent', async () => {
        await Service.setTenantConfig({
            tenantId: 'tenant-a',
            config  : {
                sourcePaths: {
                    RawRepoSource: {
                        excludePaths: ['dist'],
                        rootKind    : 'bare-repo'
                    }
                },
                tenantRepos: [repo()]
            }
        });

        const resolvedRepo = (await Service.getTenantConfig({tenantId: 'tenant-a'})).tenantRepos[0];

        expect(resolvedRepo.extractionProfile).toMatchObject({
            profileSchemaVersion: 1,
            routes              : [{
                territory  : {roots: [{path: '.', optional: false}], include: ['**/*']},
                extractorId: 'RawRepoSource',
                options    : {excludePaths: ['dist'], rootKind: 'bare-repo'}
            }],
            fallback: {action: 'exclude'}
        });
        expect(resolvedRepo.extractionIdentity).toMatch(/^[a-f0-9]{64}$/u);
    });

    test('synthesizes ParserSource for a declared parser and binds parserVersion into identity', async () => {
        const firstProjection = await Service.projectTenantConfig({
            tenantId: 'tenant-a',
            source  : 'fixture',
            config  : {
                tenantRepos: [{
                    ...repo(),
                    parserId     : 'tenant-markdown',
                    parserVersion: '1.0.0'
                }]
            }
        });
        const secondProjection = await Service.projectTenantConfig({
            tenantId: 'tenant-a',
            source  : 'fixture',
            config  : {
                tenantRepos: [{
                    ...repo(),
                    parserId     : 'tenant-markdown',
                    parserVersion: '2.0.0'
                }]
            }
        });

        expect(firstProjection.tenantRepos[0].extractionProfile).toMatchObject({
            routes: [{
                extractorId: 'ParserSource',
                options    : {
                    parserId     : 'tenant-markdown',
                    parserVersion: '1.0.0'
                }
            }]
        });
        expect(secondProjection.tenantRepos[0].extractionIdentity)
            .not.toBe(firstProjection.tenantRepos[0].extractionIdentity);
    });

    test('adapts a route-bound legacy chunk with distinct extractor and parser provenance', async () => {
        const
            sourcePath         = 'docs/guide.md',
            extractionIdentity = 'a'.repeat(64);
        const chunks = await Service.resolveFileChunks({
            file: {
                sourcePath,
                repoSlug        : 'org/repo',
                rootKind        : 'bare-repo',
                extractionIdentity,
                extractorId     : 'ParserSource',
                extractorVersion: '1.0.0',
                parserId        : 'tenant-markdown',
                parserVersion   : '2.0.0',
                profileChunk    : {
                    hash      : 'legacy-hash-must-drop',
                    kind      : 'heading',
                    name      : 'Guide',
                    content   : '# Guide',
                    source    : sourcePath,
                    sectionKey: 'intro'
                }
            },
            fileIndex             : 0,
            tenantContext         : {tenantId: 'tenant-a', repoSlug: 'org/repo'},
            trustedProfileEnvelope: true
        });

        expect(chunks).toEqual([{
            schemaVersion   : '1.0.0',
            tenantId        : 'tenant-a',
            repoSlug        : 'org/repo',
            rootKind        : 'bare-repo',
            sourcePath,
            content         : '# Guide',
            hashInputs      : ['kind', 'name', 'content', 'sourcePath', 'parserId', 'parserVersion', 'extractionIdentity'],
            parserId        : 'tenant-markdown',
            parserVersion   : '2.0.0',
            extractorId     : 'ParserSource',
            extractorVersion: '1.0.0',
            extractionIdentity,
            kind            : 'heading',
            name            : 'Guide',
            customMeta      : {sectionKey: 'intro'}
        }]);
        expect(chunks[0]).not.toHaveProperty('hash');
    });

    test('same content under a changed profile produces a replacement chunk id', () => {
        const
            tenantContext = {tenantId: 'tenant-a', repoSlug: 'org/repo'},
            chunk         = {
                kind   : 'heading',
                name   : 'Guide',
                content: '# Guide',
                source : 'docs/guide.md'
            },
            createRecord = extractionIdentity => Service.legacyChunkToParsedRecord({
                chunk,
                file: {
                    sourcePath      : 'docs/guide.md',
                    repoSlug        : 'org/repo',
                    rootKind        : 'bare-repo',
                    extractorId     : 'ParserSource',
                    extractorVersion: '1.0.0',
                    parserId        : 'tenant-markdown',
                    parserVersion   : '1.0.0',
                    extractionIdentity
                },
                parserId: 'tenant-markdown',
                tenantContext
            }),
            first  = createRecord('1'.repeat(64)),
            second = createRecord('2'.repeat(64));

        expect(first.content).toBe(second.content);
        expect(Service.createChunkHash(first, tenantContext))
            .not.toBe(Service.createChunkHash(second, tenantContext));
    });

    test('ownership scope remains exactly tenant plus repo when extraction identity is present', async () => {
        const VectorService = (await import('../../../../../../ai/services/knowledge-base/VectorService.mjs')).default;

        expect(VectorService.buildOwnedScopeFilter({
            tenantId          : 'tenant-a',
            repoSlug          : 'org/repo',
            extractionIdentity: '3'.repeat(64)
        })).toEqual({
            $and: [
                {tenantId: {$eq: 'tenant-a'}},
                {repoSlug: {$eq: 'org/repo'}}
            ]
        });
    });

    test('fails closed before profile normalization on built-in collision and custom deltaSafe true', async () => {
        const collision = await Service.setTenantConfig({
            tenantId: 'tenant-a',
            config  : {
                customExtractors: [{extractorModule: 'Collision.mjs'}],
                tenantRepos     : [repo(customProfile('RawRepoSource'))]
            }
        });

        expect(collision.code).toBe('KB_TENANT_CONFIG_WRITE_FAILED');
        expect(collision.message).toMatch(/Duplicate extractor/u);

        const unsafe = await Service.setTenantConfig({
            tenantId: 'tenant-a',
            config  : {
                customExtractors: [{extractorModule: 'UnsafeDelta.mjs'}],
                tenantRepos     : [repo(customProfile('UnsafeDelta'))]
            }
        });

        expect(unsafe.code).toBe('KB_TENANT_EXTRACTOR_DELTA_SAFE_UNPROVEN');
    });

    test('declaration-keyed catalogue cache observes a module/export change', async () => {
        await Service.setTenantConfig({
            tenantId: 'tenant-a',
            config  : {
                customExtractors: [{extractorModule: 'DocsV1.mjs'}],
                tenantRepos     : [repo(customProfile('TenantDocs'))]
            }
        });
        const first = (await Service.getTenantConfig({tenantId: 'tenant-a'})).tenantRepos[0].extractionIdentity;

        await Service.setTenantConfig({
            tenantId: 'tenant-a',
            config  : {
                customExtractors: [{extractorModule: 'DocsV2.mjs'}],
                tenantRepos     : [repo(customProfile('TenantDocs'))]
            }
        });
        const second = (await Service.getTenantConfig({tenantId: 'tenant-a'})).tenantRepos[0].extractionIdentity;

        expect(second).not.toBe(first);
    });
});
