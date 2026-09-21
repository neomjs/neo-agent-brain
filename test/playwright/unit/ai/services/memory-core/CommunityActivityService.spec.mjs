import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'CommunityActivityServiceTest',
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
import Ajv            from 'ajv';
import * as yaml      from 'js-yaml';

import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';

test.describe('Neo.ai.services.memory-core.CommunityActivityService', () => {
    let ActivityService, AdmissionService, SourceRegistryService;
    let Database, registryDb, admissionDb, activityDb, testDbPath, tempRoot;
    let originalActivityDb, originalAdmissionDb, originalAttentionPolicy, originalLocalSubjectId, originalRegistryDb;
    let originalEnv;
    let originalContentAdapter;

    const
        SUBJECT = 'community-tenant',
        WINDOW  = {
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        },
        SOURCE  = {
            canonicalProviderHost: 'github.com',
            displayLocator       : 'neomjs/neo',
            provider             : 'github',
            providerResourceId   : 'neomjs/neo',
            resourceKind         : 'repository'
        },
        ATTENTION_POLICY = {
            recordedActorDispositions: {},
            responseBearingKinds     : ['issue.comment', 'discussion.comment', 'pull_request.comment'],
            rosteredActorIds         : []
        },
        observation = (providerEntityId, occurredAt, over = {}) => ({
            actorId             : `external-${providerEntityId}`,
            actorKind           : 'user',
            occurredAt,
            occurrenceCoordinate: `${providerEntityId}:created`,
            occurrenceKind      : 'issue.comment',
            providerEntityId,
            sourceAssociation   : 'NONE',
            ...over
        }),
        batchAt = (sourceInstanceId, observations, {
            baseCheckpointVersion = 0,
            baseInventoryHash     = null,
            batchId               = `batch-${Date.now()}-${Math.random()}`,
            nextInventoryHash     = `inventory-${batchId}`,
            coverage              = {complete: true, fromBasis: 'from', toBasis: 'to'},
            registrationEpoch    = 2
        } = {}) => ({
            adapterSchemaVersion      : 'github-issue.v1',
            baseCheckpointVersion,
            baseInventoryHash,
            batchId,
            coverage,
            nextInventoryHash,
            nextProviderState         : {cursor: batchId},
            observations,
            providerStateSchemaVersion: 'github-issue-state.v1',
            registrationEpoch,
            resourceFamily            : 'issues',
            schemaVersion             : 'community-activity-batch.v1',
            sourceInstanceId
        });

    function activeSource(overrides = {}) {
        const {sourceInstanceId} = SourceRegistryService.register({...SOURCE, ...overrides});

        SourceRegistryService.transitionLifecycle(sourceInstanceId, 'PROVISIONED', {
            expectedEpoch: 1,
            expectedState: 'REQUESTED'
        });
        SourceRegistryService.transitionLifecycle(sourceInstanceId, 'ACTIVE', {
            expectedEpoch: 2,
            expectedState: 'PROVISIONED'
        });

        return sourceInstanceId
    }

    function admit(sourceInstanceId, observations, options) {
        return AdmissionService.admitBatch(batchAt(sourceInstanceId, observations, options))
    }

    async function inTenant(callback) {
        return RequestContextService.run({userId: SUBJECT}, callback)
    }

    test.beforeAll(async () => {
        originalEnv = {
            NEO_MEMORY_DB_PATH_TEST: process.env.NEO_MEMORY_DB_PATH_TEST,
            UNIT_TEST_MODE         : process.env.UNIT_TEST_MODE
        };
        process.env.UNIT_TEST_MODE          = 'true';
        Database = (await import('better-sqlite3')).default;

        SourceRegistryService = (await import('../../../../../../ai/services/memory-core/SourceRegistryService.mjs')).default;
        AdmissionService      = (await import('../../../../../../ai/services/memory-core/CommunityBatchAdmissionService.mjs')).default;
        ActivityService       = (await import('../../../../../../ai/services/memory-core/CommunityActivityService.mjs')).default;

        await Promise.all([
            SourceRegistryService.ready(),
            AdmissionService.ready(),
            ActivityService.ready()
        ]);

        originalActivityDb      = ActivityService.db;
        originalRegistryDb      = SourceRegistryService.db;
        originalAdmissionDb     = AdmissionService.db;
        originalLocalSubjectId  = SourceRegistryService.localSubjectId;
        originalAttentionPolicy = AdmissionService.attentionPolicy;
        originalContentAdapter  = ActivityService.contentAdapter;
    });

    test.beforeEach(async () => {
        tempRoot   = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neo-community-activity-'));
        testDbPath = path.join(tempRoot, 'memory-core.sqlite');
        process.env.NEO_MEMORY_DB_PATH_TEST = testDbPath;

        registryDb  = new Database(testDbPath, {verbose: null});
        admissionDb = new Database(testDbPath, {verbose: null});
        activityDb  = new Database(testDbPath, {verbose: null});
        registryDb.pragma('journal_mode = WAL');
        registryDb.pragma('busy_timeout = 5000');
        admissionDb.pragma('busy_timeout = 5000');
        activityDb.pragma('busy_timeout = 5000');

        SourceRegistryService.set({db: registryDb});
        AdmissionService.set({db: admissionDb});
        ActivityService.set({db: activityDb, contentAdapter: null});
        SourceRegistryService.ensureSchema();
        AdmissionService.ensureSchema();
        ActivityService.ensureSchema();
        SourceRegistryService.localSubjectId = SUBJECT;
        AdmissionService.attentionPolicy     = ATTENTION_POLICY;
    });

    test.afterEach(async () => {
        ActivityService.set({db: originalActivityDb, contentAdapter: originalContentAdapter});
        SourceRegistryService.set({db: originalRegistryDb, localSubjectId: originalLocalSubjectId});
        AdmissionService.set({db: originalAdmissionDb, attentionPolicy: originalAttentionPolicy});
        activityDb.close();
        registryDb.close();
        admissionDb.close();
        await fs.promises.rm(tempRoot, {force: true, recursive: true});
    });

    test.afterAll(() => {
        Object.entries(originalEnv).forEach(([key, value]) => {
            value === undefined ? delete process.env[key] : (process.env[key] = value)
        });
    });

    test('uses half-open occurredAt bounds and excludes popularity-shaped rows', async () => {
        const sourceId = activeSource();

        const admitted = admit(sourceId, [
            observation('before', '2026-09-18T23:59:59.999Z'),
            observation('start',  '2026-09-19T00:00:00.000Z'),
            observation('inside', '2026-09-19T12:00:00.000Z'),
            observation('end',    '2026-09-20T00:00:00.000Z')
        ]);

        expect(admitted.status).toBe('accepted');

        const result = await inTenant(() => ActivityService.query({
            limit      : 20,
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        }));

        expect(new Set(result.items.map(item => item.providerEntityId))).toEqual(new Set(['start', 'inside']));

        const popularity = observation('star', '2026-09-19T13:00:00.000Z', {
            occurrenceKind: 'repository.starred'
        });
        expect(admit(sourceId, [observation('popularity-seed', '2026-09-19T13:00:00.000Z')], {
            baseCheckpointVersion: admitted.receipt.nextCheckpointVersion,
            baseInventoryHash    : admitted.receipt.nextInventoryHash
        }).status).toBe('accepted');
        const popularityRow = admissionDb.prepare(
            'SELECT occurrence_identity FROM mc_community_observation WHERE provider_entity_id = ?'
        ).get('popularity-seed');
        admissionDb.prepare(
            `UPDATE mc_community_observation
             SET occurrence_kind = ?, attention_disposition = ?
             WHERE occurrence_identity = ?`
        ).run(popularity.occurrenceKind, 'eligible', popularityRow.occurrence_identity);

        const afterPopularity = await inTenant(() => ActivityService.query({
            limit      : 20,
            windowEnd  : '2026-09-20T00:00:00.000Z',
            windowStart: '2026-09-19T00:00:00.000Z'
        }));

        expect(afterPopularity.items.some(item => item.providerEntityId === 'popularity-seed')).toBe(false);
        expect(afterPopularity.coverage.totalResolved).toBe(result.coverage.totalResolved);
        await expect(inTenant(() => ActivityService.markSeen({sourceEventId: popularityRow.occurrence_identity})))
            .resolves.toMatchObject({status: 'ineligible'});
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: popularityRow.occurrence_identity})))
            .resolves.toMatchObject({status: 'unknown'});
        expect(admissionDb.prepare('SELECT count(*) AS count FROM mc_community_seen').get().count).toBe(0);
    });

    test('continues same-batch rows with the admitted-sequence plus row-id tuple', async () => {
        const sourceId = activeSource();

        expect(admit(sourceId, [
            observation('first', '2026-09-19T10:00:00.000Z'),
            observation('second', '2026-09-19T10:00:00.000Z')
        ]).status).toBe('accepted');

        const first = await inTenant(() => ActivityService.query({
            ...WINDOW,
            limit: 1
        }));
        const second = await inTenant(() => ActivityService.query({
            ...WINDOW,
            cursor: first.nextCursor,
            limit : 1
        }));

        expect(first.items).toHaveLength(1);
        expect(second.items).toHaveLength(1);
        expect(new Set([first.items[0].providerEntityId, second.items[0].providerEntityId]))
            .toEqual(new Set(['first', 'second']));
    });

    test('keeps an admission after page one outside the fixed snapshot cutoff', async () => {
        const sourceId       = activeSource();
        const firstAdmission = admit(sourceId, [
            observation('page-one', '2026-09-19T10:00:00.000Z'),
            observation('page-two', '2026-09-19T10:01:00.000Z')
        ]);
        const first = await inTenant(() => ActivityService.query({...WINDOW, limit: 1}));

        expect(admit(sourceId, [observation('later-batch', '2026-09-19T10:02:00.000Z')], {
            baseCheckpointVersion: firstAdmission.receipt.nextCheckpointVersion,
            baseInventoryHash    : firstAdmission.receipt.nextInventoryHash
        }).status).toBe('accepted');

        const second = await inTenant(() => ActivityService.query({
            ...WINDOW,
            cursor: first.nextCursor,
            limit : 10
        }));

        expect(second.items).toHaveLength(1);
        expect(['page-one', 'page-two']).toContain(second.items[0].providerEntityId);
        expect(second.items.some(item => item.providerEntityId === 'later-batch')).toBe(false);
    });

    test('seen is idempotent per viewer and does not change the source manifest', async () => {
        const sourceId = activeSource();
        admit(sourceId, [observation('seen-event', '2026-09-19T10:00:00.000Z')]);

        const receiptsBefore    = admissionDb.prepare('SELECT * FROM mc_community_batch_receipt').all();
        const checkpointsBefore = admissionDb.prepare('SELECT * FROM mc_community_checkpoint').all();
        const before            = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.query({...WINDOW, limit: 10})
        );
        const firstSeen = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.markSeen({sourceEventId: before.items[0].sourceEventId})
        );
        const secondSeen = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.markSeen({sourceEventId: before.items[0].sourceEventId})
        );
        const after = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-a'}, () =>
            ActivityService.query({...WINDOW, limit: 10})
        );

        expect(firstSeen.status).toBe('seen');
        expect(secondSeen.status).toBe('seen');
        expect(after.items[0].seen).toBe(true);
        expect(after.sourceManifestHash).toBe(before.sourceManifestHash);
        expect(after.coverage.totalResolved).toBe(before.coverage.totalResolved);
        expect(admissionDb.prepare('SELECT count(*) AS count FROM mc_community_seen').get().count).toBe(1);
        expect(admissionDb.prepare('SELECT * FROM mc_community_batch_receipt').all()).toEqual(receiptsBefore);
        expect(admissionDb.prepare('SELECT * FROM mc_community_checkpoint').all()).toEqual(checkpointsBefore);

        const otherViewer = await RequestContextService.run({userId: SUBJECT, agentIdentityNodeId: '@viewer-b'}, () =>
            ActivityService.query({...WINDOW, limit: 10})
        );

        expect(otherViewer.sourceManifestHash).toBe(before.sourceManifestHash);
        expect(otherViewer.items[0].seen).toBe(false);
    });

    test('discards content when source registration changes during the adapter read', async () => {
        const sourceId       = activeSource();
        const firstAdmission = admit(sourceId, [observation('content-event', '2026-09-19T10:00:00.000Z')]);

        let releaseAdapter;
        const adapterStarted = new Promise(resolve => {
            ActivityService.contentAdapter = {
                read: async () => {
                    resolve();
                    await new Promise(release => { releaseAdapter = release });
                    return {
                        citation    : {contentVersion: 'current-provider-read'},
                        contentTrust: {sourceRelative: 'OWNER', tier: 'repo-trusted'},
                        content     : {body: {sanitized: 'transient prose'}},
                        status      : 'available'
                    }
                }
            }
        });

        const listed         = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const contentPromise = inTenant(() => ActivityService.getContent({sourceEventId: listed.items[0].sourceEventId}));

        await adapterStarted;
        SourceRegistryService.transitionLifecycle(sourceId, 'REVOKED', {
            expectedEpoch: 2,
            expectedState: 'ACTIVE'
        });
        releaseAdapter();

        await expect(contentPromise).resolves.toMatchObject({
            notAuthority : true,
            sourceEventId: listed.items[0].sourceEventId,
            status       : 'inaccessible'
        });

        const reprovisioned = sourceId;
        SourceRegistryService.transitionLifecycle(reprovisioned, 'PROVISIONED', {
            expectedEpoch: 2,
            expectedState: 'REVOKED'
        });
        SourceRegistryService.transitionLifecycle(reprovisioned, 'ACTIVE', {
            expectedEpoch: 3,
            expectedState: 'PROVISIONED'
        });
        expect(admit(reprovisioned, [observation('reprovisioned-event', '2026-09-19T10:00:00.000Z')], {
            baseCheckpointVersion: firstAdmission.receipt.nextCheckpointVersion,
            baseInventoryHash    : firstAdmission.receipt.nextInventoryHash,
            registrationEpoch    : 3
        }).status).toBe('accepted');
        ActivityService.contentAdapter = {read: async () => ({
            content     : {body: {sanitized: 'current prose'}},
            status      : 'available',
            notAuthority: true
        })};

        const reprovisionedPage    = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const reprovisionedContent = await inTenant(() => ActivityService.getContent({
            sourceEventId: reprovisionedPage.items.find(item => item.providerEntityId === 'reprovisioned-event').sourceEventId
        }));

        expect(reprovisionedContent.status).toBe('available');
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: listed.items[0].sourceEventId})))
            .resolves.toMatchObject({status: 'available'});

        let releaseRefresh;
        const refreshStarted = new Promise(resolve => {
            ActivityService.contentAdapter = {
                read: async () => {
                    resolve();
                    await new Promise(release => { releaseRefresh = release });
                    return {content: {body: {sanitized: 'stale grant'}}, status: 'available'}
                }
            }
        });
        const refreshEvent   = reprovisionedPage.items.find(item => item.providerEntityId === 'reprovisioned-event');
        const refreshPromise = inTenant(() => ActivityService.getContent({sourceEventId: refreshEvent.sourceEventId}));

        await refreshStarted;
        SourceRegistryService.register({...SOURCE, grantRef: 'refreshed-grant'});
        releaseRefresh();

        await expect(refreshPromise).resolves.toMatchObject({
            notAuthority : true,
            sourceEventId: refreshEvent.sourceEventId,
            status       : 'inaccessible'
        });
    });

    test('keeps real coverage gaps and unsupported source families degraded', async () => {
        const sourceId  = activeSource(),
              unknownId = activeSource({
                  canonicalProviderHost: 'gitlab.com',
                  displayLocator       : 'example/project',
                  provider             : 'gitlab',
                  providerResourceId   : 'example/project'
              });

        admit(sourceId, [observation('coverage-event', '2026-09-19T10:00:00.000Z')], {
            coverage: {
                complete : false,
                fromBasis: 'from',
                gaps     : [{axis: 'comments', reason: 'provider-gap'}],
                toBasis  : 'to'
            }
        });

        const result        = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const unknownSource = result.coverage.sources.find(source => source.sourceInstanceId === unknownId);

        expect(result.coverage.degraded).toBe(true);
        expect(result.coverage.degradedReasons).toEqual(expect.arrayContaining([
            'source-coverage-incomplete',
            'source-coverage-unknown',
            'source-unsupported'
        ]));
        expect(unknownSource.degradedReasons).toContain('source-unsupported');
    });

    test('reports invalid durable occurrence time and keeps default reads provider-free', async () => {
        const sourceId = activeSource();
        admit(sourceId, [observation('invalid-time', '2026-09-19T10:00:00.000Z'),
            observation('valid-metadata', '2026-09-19T11:00:00.000Z')]);
        admissionDb.prepare('UPDATE mc_community_observation SET occurred_at = ? WHERE provider_entity_id = ?')
            .run('not-a-date', 'invalid-time');

        let adapterCalls = 0;
        ActivityService.contentAdapter = {read: async () => {
            adapterCalls++;
            return {status: 'available', content: {body: {sanitized: 'must not be read'}}}
        }};

        const result = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));

        expect(result.coverage.invalidTimes).toBe(1);
        expect(result.coverage.degraded).toBe(true);
        expect(result.items.map(item => item.providerEntityId)).toEqual(['valid-metadata']);
        expect(adapterCalls).toBe(0);
        expect(result.synthesis).toBeNull();
        expect(JSON.stringify(result)).not.toContain('title');
        expect(JSON.stringify(result)).not.toContain('body');
        expect(JSON.stringify(result)).not.toContain('excerpt');
    });

    test('requires a bound viewer even when local tenant fallback exists', async () => {
        const sourceId = activeSource();
        admit(sourceId, [observation('viewer-event', '2026-09-19T10:00:00.000Z')]);

        await expect(ActivityService.markSeen({sourceEventId: 'missing-event'}))
            .rejects.toThrow('COMMUNITY_SEEN_CONTEXT_REQUIRED');
    });

    test('requires explicit tombstone evidence and never fetches deleted content', async () => {
        const sourceId = activeSource();
        admit(sourceId, [
            observation('tombstone-event', '2026-09-19T10:00:00.000Z', {
                absence         : 'deleted',
                deletionEvidence: {deletedAt: '2026-09-19T11:00:00.000Z', tombstoneId: 't-1'}
            }),
            observation('no-evidence-event', '2026-09-19T10:01:00.000Z')
        ]);
        admissionDb.prepare('UPDATE mc_community_observation SET absence = ?, deletion_evidence = NULL WHERE provider_entity_id = ?')
            .run('deleted', 'no-evidence-event');

        let adapterCalls = 0;
        ActivityService.contentAdapter = {read: async () => {
            adapterCalls++;
            return {status: 'available', content: {body: {sanitized: 'current'}}}
        }};
        const listed     = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        const tombstone  = listed.items.find(item => item.providerEntityId === 'tombstone-event');
        const noEvidence = listed.items.find(item => item.providerEntityId === 'no-evidence-event');

        await expect(inTenant(() => ActivityService.getContent({sourceEventId: tombstone.sourceEventId})))
            .resolves.toMatchObject({sourceEventId: tombstone.sourceEventId, status: 'deleted'});
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: noEvidence.sourceEventId})))
            .resolves.toMatchObject({sourceEventId: noEvidence.sourceEventId, status: 'available'});
        expect(adapterCalls).toBe(1);
    });

    test('later non-attention deletion evidence explains an earlier attention handle', async () => {
        const sourceId = activeSource(),
              first    = admit(sourceId, [observation('deleted-later', '2026-09-19T10:00:00Z')]),
              page     = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));

        expect(admit(sourceId, [observation('deleted-later', '2026-09-19T11:00:00Z', {
            occurrenceKind: 'issue.deleted', occurrenceCoordinate: 'later-tombstone',
            actorId       : 'internal', absence: 'deleted', deletionEvidence: {deletedAt: '2026-09-19T11:00:00Z'}
        })], {baseCheckpointVersion: first.receipt.nextCheckpointVersion,
            baseInventoryHash: first.receipt.nextInventoryHash}).status).toBe('accepted');

        let calls = 0;
        ActivityService.contentAdapter = {read: () => { calls++; return {status: 'unknown'} }};
        await expect(inTenant(() => ActivityService.getContent({sourceEventId: page.items[0].sourceEventId})))
            .resolves.toMatchObject({status: 'deleted'});
        expect(calls).toBe(0);
        expect((await inTenant(() => ActivityService.query({...WINDOW, limit: 10}))).items).toHaveLength(1);
    });

    test('real query, seen and current-content outputs satisfy the published OpenAPI response schemas', async () => {
        const document = yaml.load(fs.readFileSync(new URL('../../../../../../ai/mcp/server/memory-core/openapi.yaml', import.meta.url), 'utf8')),
              ajv      = new Ajv({allErrors: true, strict: false, validateFormats: false});

        ajv.addSchema({components: document.components}, 'community-api');

        const assertSchema = (name, value) => {
            const validate = ajv.compile({$ref: `community-api#/components/schemas/${name}`});
            expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
        };
        const sourceId = activeSource();
        admit(sourceId, [observation('schema-event', '2026-09-19T10:00:00Z')]);

        const page = await inTenant(() => ActivityService.query({...WINDOW, limit: 10}));
        assertSchema('CommunityActivityQueryResponse', page);
        assertSchema('CommunityActivitySeenResponse', await inTenant(() => ActivityService.markSeen({sourceEventId: page.items[0].sourceEventId})));

        const adapter = (await import('../../../../../../ai/services/github-workflow/GitHubCommunityContentService.mjs')).default;
        ActivityService.contentAdapter = {read: options => adapter.read({...options, graphqlService: {
            query: async () => ({node: {__typename: 'IssueComment', id: 'schema-event',
                repository: {nameWithOwner: 'neomjs/neo'}, url: 'https://github.com/neomjs/neo/issues/1#issuecomment-1',
                updatedAt : '2026-09-19T10:00:00Z',
                body      : 'I can provide a hosted MCP endpoint. https://external.example/content', authorAssociation: 'NONE'}})
        }})};
        const content = await inTenant(() => ActivityService.getContent({sourceEventId: page.items[0].sourceEventId}));
        expect(content.status).toBe('available');
        assertSchema('CommunityActivityContentResponse', content);
        expect(content.content.body).toContain('QUARANTINED_URL');
        expect(content.contentTrust).toEqual({
            tier      : 'external', sourceRelative: 'NONE', wasModified: true,
            redactions: [{at: 'body', type: 'url', domain: 'external.example'}],
            signals   : [{at: 'body', id: 'external-endpoint-offer',
                note: 'offer to stand up an external endpoint / index our repo (external-infra-on-our-content)'}]
        });
        expect(JSON.stringify(content)).not.toContain('https://external.example');
    });

    test('wrong tenants cannot reuse cursors, read content, or mark events seen', async () => {
        const sourceId = activeSource();
        admit(sourceId, [
            observation('tenant-event', '2026-09-19T10:00:00.000Z'),
            observation('tenant-event-2', '2026-09-19T10:01:00.000Z')
        ]);

        const ownerPage = await RequestContextService.run({userId: SUBJECT}, () =>
            ActivityService.query({...WINDOW, limit: 1})
        );

        await expect(RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.query({...WINDOW, cursor: ownerPage.nextCursor, limit: 1})
        )).rejects.toThrow(/COMMUNITY_CURSOR_(INVALID|SCOPE_MISMATCH)/);

        const foreignContent = await RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.getContent({sourceEventId: ownerPage.items[0].sourceEventId})
        );
        const foreignSeen = await RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.markSeen({sourceEventId: ownerPage.items[0].sourceEventId})
        );
        const foreignPage = await RequestContextService.run({userId: 'other-tenant'}, () =>
            ActivityService.query({...WINDOW, limit: 1})
        );

        expect(foreignContent.status).toBe('unknown');
        expect(foreignSeen.status).toBe('ineligible');
        expect(foreignPage.items).toEqual([]);
    });

    test('rejects invalid dates and malformed cursors before reading a page', async () => {
        activeSource();

        await expect(inTenant(() => ActivityService.query({
            ...WINDOW,
            limit      : 1,
            windowStart: 'not-a-date'
        }))).rejects.toThrow(/parseable windowStart/);

        await expect(inTenant(() => ActivityService.query({
            ...WINDOW,
            cursor: '%%%not-a-cursor%%%',
            limit : 1
        }))).rejects.toThrow('COMMUNITY_CURSOR_INVALID');
    });
});
