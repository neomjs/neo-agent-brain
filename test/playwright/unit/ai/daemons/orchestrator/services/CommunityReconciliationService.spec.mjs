import {setup} from '../../../../../setup.mjs';

setup({neoConfig: {unitTestMode: true}, appConfig: {name: 'CommunityReconciliationServiceTest'}});

import {test, expect}                 from '@playwright/test';
import Neo                            from 'neo.mjs/src/Neo.mjs';
import * as core                      from 'neo.mjs/src/core/_export.mjs';
import CommunityReconciliationService from '../../../../../../../ai/daemons/orchestrator/services/CommunityReconciliationService.mjs';
import fs                             from 'node:fs';
import path                           from 'node:path';
import {spawnSync}                    from 'node:child_process';
import RequestContextService          from '../../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import AdmissionService               from '../../../../../../../ai/services/memory-core/CommunityBatchAdmissionService.mjs';
import RegistryService                from '../../../../../../../ai/services/memory-core/SourceRegistryService.mjs';

test.describe('CommunityReconciliationService', () => {
    let Database, admissionDb, registryDb, oldAdmissionDb, oldRegistryDb, oldPolicy, oldSubject, dbPath;
    const registration = {sourceInstanceId: 'src-1', provider: 'github', canonicalProviderHost: 'github.com', resourceKind: 'repository', displayLocator: 'neomjs/neo', lifecycleState: 'ACTIVE', registrationEpoch: 2};
    const registry     = (rows = [registration]) => ({
        resolveTenantId  : () => 'tenant-a',
        listRegistrations: () => rows,
        getRegistration  : id => rows.find(row => row.sourceInstanceId === id) || null
    });
    const batch = {observations: [], coverage: {complete: true}};

    test.beforeAll(async () => {
        Database = (await import('better-sqlite3')).default;
        await AdmissionService.ready(); await RegistryService.ready();
        oldAdmissionDb = AdmissionService.db; oldRegistryDb = RegistryService.db;
        oldPolicy = AdmissionService.attentionPolicy; oldSubject = RegistryService.localSubjectId;
        dbPath = path.join(process.cwd(), 'tmp', `community-coordinator-${process.pid}-${Date.now()}.sqlite`);
        fs.mkdirSync(path.dirname(dbPath), {recursive: true});
        admissionDb = new Database(dbPath); registryDb = new Database(dbPath);
        RegistryService.set({db: registryDb, localSubjectId: 'tenant-real'});
        AdmissionService.set({db: admissionDb, attentionPolicy: {responseBearingKinds: ['issue.comment'], rosteredActorIds: []}});
        RegistryService.ensureSchema(); AdmissionService.ensureSchema();
    });

    test.afterAll(() => {
        RegistryService.set({db: oldRegistryDb, localSubjectId: oldSubject});
        AdmissionService.set({db: oldAdmissionDb, attentionPolicy: oldPolicy});
        registryDb.close(); admissionDb.close();
        for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(`${dbPath}${suffix}`) } catch {}
    });

    test.beforeEach(() => {
        admissionDb.exec('DELETE FROM mc_community_batch_receipt; DELETE FROM mc_community_observation; DELETE FROM mc_community_checkpoint;');
        registryDb.exec('DELETE FROM mc_source_registration_audit; DELETE FROM mc_source_registration;');
        RegistryService.localSubjectId = 'tenant-real';
        AdmissionService.attentionPolicy = {responseBearingKinds: ['issue.comment'], rosteredActorIds: []};
    });

    function activeRealSource() {
        const source = RegistryService.register({provider: 'github', canonicalProviderHost: 'github.com', resourceKind: 'repository', providerResourceId: 'neomjs/neo', displayLocator: 'neomjs/neo'});
        RegistryService.transitionLifecycle(source.sourceInstanceId, 'PROVISIONED', {expectedState: 'REQUESTED', expectedEpoch: 1});
        return RegistryService.transitionLifecycle(source.sourceInstanceId, 'ACTIVE', {expectedState: 'PROVISIONED', expectedEpoch: 2});
    }

    function realBatch({sourceInstanceId, resourceFamily, batchId, registrationEpoch, checkpoint}) {
        return {
            schemaVersion        : 'community-activity-batch.v1', sourceInstanceId, resourceFamily,
            adapterSchemaVersion : 'test.v1', providerStateSchemaVersion: 'test.v1', registrationEpoch,
            baseCheckpointVersion: checkpoint?.checkpointVersion ?? 0, baseInventoryHash: checkpoint?.inventoryHash ?? null,
            batchId, observations: [{providerEntityId: 'C_1', occurrenceKind: 'issue.comment', occurrenceCoordinate: 'C_1:created', occurredAt: '2026-09-20T00:00:00Z', actorId: 'external', actorKind: 'user', sourceAssociation: 'CONTRIBUTOR'}],
            nextProviderState: {cursor: batchId}, nextInventoryHash: `inventory-${batchId}`, coverage: {fromBasis: 'genesis', toBasis: batchId, complete: true}
        }
    }

    test('replays a real committed batch after lost response, then a fresh UUID advances basis without duplicating facts', async () => {
        const source            = activeRealSource();
        let   firstResponseLost = true, ids = ['run-1', 'run-2'];
        const facade            = {
            getCheckpoint   : (...args) => AdmissionService.getCheckpoint(...args),
            listObservations: (...args) => AdmissionService.listObservations(...args),
            admitBatch(batchValue) {
                const result = AdmissionService.admitBatch(batchValue);
                if (firstResponseLost) { firstResponseLost = false; throw new Error('response lost after commit') }
                return result
            },
            getReceipt: (...args) => AdmissionService.getReceipt(...args)
        };
        const reconciler = {reconcile: async ({sourceInstanceId, resourceFamily, batchId, admissionService}) => {
            const current = admissionService.getCheckpoint(sourceInstanceId, resourceFamily);
            return admissionService.admitBatch(realBatch({sourceInstanceId, resourceFamily, batchId, registrationEpoch: source.registrationEpoch, checkpoint: current}));
        }};

        await RequestContextService.run({userId: 'tenant-real'}, async () => {
            const first = await CommunityReconciliationService.runOnce({registryService: RegistryService, admissionService: facade, reconcilers: {issues: reconciler}, maxAdmissionAttempts: 2, uuid: () => ids.shift()});
            expect(first.results.find(row => row.resourceFamily === 'issues')).toMatchObject({status: 'idempotent', checkpointVersion: 1});
            expect(AdmissionService.listObservations(source.sourceInstanceId)).toHaveLength(1);
            const second = await CommunityReconciliationService.runOnce({registryService: RegistryService, admissionService: AdmissionService, reconcilers: {issues: reconciler}, maxAdmissionAttempts: 1, uuid: () => ids.shift()});
            expect(second.results.find(row => row.resourceFamily === 'issues')).toMatchObject({status: 'accepted', checkpointVersion: 2});
            expect(AdmissionService.listObservations(source.sourceInstanceId)).toHaveLength(1);
        });
    });

    test('retries a lost admission response with the exact captured batch and returns its receipt', async () => {
        const calls = [], admission = {
            getCheckpoint   : () => null,
            listObservations: () => [],
            admitBatch      : value => { calls.push(value); if (calls.length === 1) throw new Error('lost response'); return {status: 'accepted', receipt: {receiptId: 'r', observationCount: 0, coverage: value.coverage}} }
        };
        const reconciler = {reconcile: async ({admissionService}) => admissionService.admitBatch(batch)};

        const result = await CommunityReconciliationService.runOnce({
            registryService: registry(), admissionService: admission,
            reconcilers    : {issues: reconciler}, maxAdmissionAttempts: 2, uuid: () => 'u', now: () => 1
        });

        expect(calls).toEqual([batch, batch]);
        expect(result.results.find(row => row.resourceFamily === 'issues')).toMatchObject({status: 'accepted', attempts: 2, receiptId: 'r'});
    });

    test('isolates family failure, refuses unknown selectors, and does not leak provider text', async () => {
        const admission = {getCheckpoint: () => null, listObservations: () => [], admitBatch: () => ({status: 'accepted', receipt: {receiptId: 'ok', coverage: {gaps: []}}})};
        const result    = await CommunityReconciliationService.runOnce({
            registryService     : registry(), admissionService: admission,
            reconcilers         : {issues: {reconcile: async () => { throw new Error('secret provider prose') }}, pulls: {reconcile: async ({admissionService}) => admissionService.admitBatch(batch)}},
            maxAdmissionAttempts: 1, uuid: () => 'u', now: () => 1
        });
        expect(result.status).toBe('partial');
        expect(JSON.stringify(result)).not.toContain('secret provider prose');
        await expect(CommunityReconciliationService.runOnce({registryService: registry(), admissionService: admission, reconcilers: {}, sourceInstanceIds: ['unknown'], maxAdmissionAttempts: 1, uuid: () => 'u'})).rejects.toThrow('COMMUNITY_RECONCILIATION_UNKNOWN_SOURCE');
    });

    test('fences inactive/changed sources before provider work and shadows without a durable write', async () => {
        let   calls      = 0, writes = 0;
        const inactive   = {...registration, lifecycleState: 'REVOKED'};
        const admission  = {getCheckpoint: () => null, listObservations: () => [], admitBatch: () => { writes++ }};
        const reconciler = {reconcile: async () => { calls++ }};
        const skipped    = await CommunityReconciliationService.runOnce({registryService: registry([inactive]), admissionService: admission, reconcilers: {issues: reconciler}, maxAdmissionAttempts: 1, uuid: () => 'u'});
        expect(calls).toBe(0);
        expect(skipped.results.every(row => row.status === 'skipped')).toBe(true);

        const shadow = await CommunityReconciliationService.runOnce({registryService: registry(), admissionService: admission, reconcilers: {issues: {reconcile: async ({admissionService}) => admissionService.admitBatch(batch)}}, mode: 'shadow', maxAdmissionAttempts: 1, uuid: () => 'u'});
        expect(writes).toBe(0);
        expect(shadow.results.find(row => row.resourceFamily === 'issues').status).toBe('shadow');
    });

    test('treats a conflict as terminal and refuses explicitly selected unsupported sources', async () => {
        let   writes    = 0;
        const admission = {getCheckpoint: () => null, listObservations: () => [], admitBatch: () => {
            writes++; return {status: 'conflict', reason: 'STALE_BASIS'}
        }};
        const reconciler   = {reconcile: async ({admissionService}) => admissionService.admitBatch(batch)};
        const dependencies = {registryService: registry(), admissionService: admission,
            reconcilers: {issues: reconciler, pulls: reconciler, discussions: reconciler}, maxAdmissionAttempts: 7};
        const result = await CommunityReconciliationService.runOnce(dependencies);
        expect(result.status).toBe('failed');
        expect(writes).toBe(3);
        expect(result.results.every(row => row.attempts === 1 && row.reasonCode === 'STALE_BASIS')).toBe(true);

        const unsupported = {...registration, provider: 'gitlab'};
        await expect(CommunityReconciliationService.runOnce({...dependencies,
            registryService: registry([unsupported]), sourceInstanceIds: ['src-1']}))
            .rejects.toThrow('COMMUNITY_RECONCILIATION_UNSUPPORTED_SOURCE');
        expect(writes).toBe(3);
    });

    test('generates fresh family/run IDs and preserves unrelated sources after a registration read failure', async () => {
        const ids    = [], second = {...registration, sourceInstanceId: 'src-2'};
        const scoped = registry([registration, second]);
        scoped.getRegistration = id => {
            if (id === 'src-1') throw new Error('private failure');
            return second
        };
        const admission = {getCheckpoint: () => null, listObservations: () => [],
            admitBatch: () => ({status: 'accepted', receipt: {receiptId: 'r', observationCount: 0}})};
        const reconciler = {reconcile: async ({batchId, admissionService}) => {
            ids.push(batchId); return admissionService.admitBatch({...batch, batchId})
        }};
        const options = {registryService: scoped, admissionService: admission,
            reconcilers: {issues: reconciler, pulls: reconciler, discussions: reconciler}, maxAdmissionAttempts: 1};
        for (let i = 0; i < 2; i++) {
            const result = await CommunityReconciliationService.runOnce(options);
            expect(result.status).toBe('partial');
            expect(result.results.filter(row => row.status === 'accepted')).toHaveLength(3);
            expect(JSON.stringify(result)).not.toContain('private failure');
        }
        expect(new Set(ids).size).toBe(6);
    });

    test('fences an epoch change before acquisition and reports an unbound tenant as failure', async () => {
        let   acquisitions = 0;
        const scoped       = registry();
        scoped.getRegistration = () => ({...registration, registrationEpoch: 3});
        const deps = {registryService: scoped, admissionService: {}, maxAdmissionAttempts: 1,
            reconcilers: {issues: {reconcile: async () => { acquisitions++ }}}};
        const result = await CommunityReconciliationService.runOnce(deps);
        expect(result.results.every(row => row.reasonCode === 'SOURCE_REGISTRATION_CHANGED')).toBe(true);
        expect(acquisitions).toBe(0);
        scoped.resolveTenantId = () => null;
        expect(await CommunityReconciliationService.runOnce(deps)).toMatchObject({
            status: 'failed', reasonCode: 'COMMUNITY_RECONCILIATION_TENANT_UNBOUND'
        });
    });

    test('reports connector calls without copying query text or variables into health', async () => {
        const calls    = [];
        const provider = {
            query: (...args) => { calls.push(args); return {} },
            rest : (...args) => { calls.push(args); return [] }
        };
        const reconciler = {reconcile: async ({graphqlService, admissionService}) => {
            await graphqlService.query('private query text', {value: 'private variables'});
            await graphqlService.rest('GET', '/private/path');
            return admissionService.admitBatch(batch)
        }};
        const result = await CommunityReconciliationService.runOnce({
            registryService : registry(), reconcilers: {issues: reconciler}, graphqlService: provider,
            admissionService: {getCheckpoint: () => null, listObservations: () => [],
                admitBatch: () => ({status: 'accepted', receipt: {receiptId: 'r', admittedAt: 5}})},
            maxAdmissionAttempts: 1, now: () => 10
        });
        expect(calls).toHaveLength(2);
        expect(result.results[0]).toMatchObject({providerCalls: 2, observationCount: 0, receiptAgeMs: 5});
        expect(JSON.stringify(result)).not.toContain('private');
    });

    test('scheduled execution binds its deployment tenant and persists partial and thrown outcomes', () => {
        const script = `
            await import('neo.mjs/src/Neo.mjs');
            await import('neo.mjs/src/core/_export.mjs');
            const {default: service} = await import('./ai/daemons/orchestrator/services/CommunityReconciliationService.mjs');
            const {default: context} = await import('./ai/mcp/server/shared/services/RequestContextService.mjs');
            const calls = [], health = [], tenants = [];
            const options = {taskName: 'community-reconciliation', reason: 'fixture',
                taskStateService: {markStarted: (...args) => calls.push(['started', ...args]),
                    markFailed: (...args) => calls.push(['failed', ...args])},
                healthService: {recordTaskOutcome: (...args) => health.push(args)}};
            service.runOnce = async () => {
                tenants.push(context.getUserId());
                return {status: 'partial', sourceCount: 2, results: [{sourceInstanceId: 'one', status: 'failed'}]}
            };
            await service.runTask(options);
            service.runOnce = async () => { throw new Error('private error text') };
            await service.runTask(options);
            console.log(JSON.stringify({calls, health, tenants, restored: context.getUserId()}));
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
            env: {...process.env, NEO_ORCHESTRATOR_COMMUNITY_RECONCILIATION_TENANT_ID: 'configured-tenant'}
        });
        expect(child.status, child.stderr).toBe(0);
        const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
        expect(output.tenants).toEqual(['configured-tenant']);
        expect(output.restored ?? null).toBeNull();
        expect(output.calls[1]).toMatchObject(['failed', 'community-reconciliation', 1, {status: 'partial', sourceCount: 2}]);
        expect(output.calls[3]).toMatchObject(['failed', 'community-reconciliation', 1, {status: 'failed'}]);
        expect(output.health[0][2].results).toEqual([{sourceInstanceId: 'one', status: 'failed'}]);
        expect(output.health[0][1]).toBe('failed');
        expect(child.stdout).not.toContain('private error text');
    });

    test('rejects absent or invalid attempt policy before work', async () => {
        const deps = {registryService: registry(), admissionService: {}, reconcilers: {}, uuid: () => 'u'};
        await expect(CommunityReconciliationService.runOnce({...deps, maxAdmissionAttempts: null})).rejects.toThrow('COMMUNITY_RECONCILIATION_MAX_ADMISSION_ATTEMPTS_REQUIRED');
        await expect(CommunityReconciliationService.runOnce({...deps, maxAdmissionAttempts: 0})).rejects.toThrow('COMMUNITY_RECONCILIATION_MAX_ADMISSION_ATTEMPTS_REQUIRED');
    });
});
