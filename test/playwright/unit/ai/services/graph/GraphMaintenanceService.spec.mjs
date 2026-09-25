import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'GraphMaintenanceServiceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import fs             from 'fs-extra';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

if (!Neo.get) Neo.get = () => null;

/**
 * The REM cycle's graph garbage collection against a graph whose node cache holds only part of
 * storage, which is the dream process's normal state: the cache is lazy and LRU-bounded. The GC may
 * sever an edge only when an endpoint is gone from storage. A node that is merely not loaded anchors
 * its edges like any other, so neither the edge nor the node the edge keeps alive is deleted. The
 * orphan pass after it purges a node's vectors only together with the node itself, and never touches
 * a session summary. The vector stores are stubs that record every delete.
 */
test.describe('Neo.ai.services.graph.GraphMaintenanceService', () => {
    test.describe.configure({mode: 'serial'});

    let GraphMaintenanceService, GraphService, LifecycleService, StorageRouter, TestLifecycleHelper, logger, originalAutoSave, originals, vectors;

    const
        stubVectorStores = ({fail = false} = {}) => {
            const
                deleted    = {graph: [], summary: []},
                collection = name => ({
                    delete: async ({ids}) => {
                        if (fail) throw new Error('vector store refused the delete');
                        deleted[name].push(...ids)
                    }
                });

            StorageRouter.getGraphCollection   = async () => collection('graph');
            StorageRouter.getSummaryCollection = async () => collection('summary');

            return deleted
        },
        edgeRow   = id => GraphService.db.storage.db.prepare(`SELECT json_extract(data, '$.properties.readAt') AS readAt FROM Edges WHERE id = ?`).get(id),
        nodeRow   = id => GraphService.db.storage.db.prepare('SELECT id FROM Nodes WHERE id = ?').get(id),
        // the LRU eviction path: the node leaves the cache, storage keeps it
        evict     = id => {
            const autoSave = GraphService.db.autoSave;

            GraphService.db.autoSave = false;
            GraphService.db.nodes.remove(id);
            GraphService.db.autoSave = autoSave
        },
        seedReceipt = () => {
            GraphService.db.addNode({id: 'MESSAGE:gc-broadcast', label: 'MESSAGE', properties: {subject: 'a read broadcast'}});
            GraphService.db.addNode({id: '@gc-recipient', label: 'AgentIdentity', properties: {}});
            GraphService.db.addEdge({
                id        : 'gc-delivered-to',
                source    : 'MESSAGE:gc-broadcast',
                target    : '@gc-recipient',
                type      : 'DELIVERED_TO',
                properties: {readAt: '2026-09-25T17:49:47.000Z'}
            })
        };

    test.beforeAll(async () => {
        GraphService            = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        LifecycleService        = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        GraphMaintenanceService = (await import('../../../../../../ai/services/graph/GraphMaintenanceService.mjs')).default;
        StorageRouter           = (await import('../../../../../../ai/services.mjs')).Memory_StorageRouter;
        logger                  = (await import('../../../../../../ai/mcp/server/memory-core/logger.mjs')).default;
        ({TestLifecycleHelper}  = await import('../memory-core/util.mjs'));

        originals = {
            getGraphCollection  : StorageRouter.getGraphCollection,
            getSummaryCollection: StorageRouter.getSummaryCollection,
            warn                : logger.warn
        };

        await TestLifecycleHelper.cleanupGraphService(GraphService, LifecycleService, null, fs, 'clear');

        if (!LifecycleService._initPromise) { await LifecycleService.initAsync() } else { await LifecycleService.ready() }

        originalAutoSave         = GraphService.db.autoSave;
        GraphService.db.autoSave = true
    });

    test.afterAll(async () => {
        const {cleanupChromaManager} = await import('../memory-core/util.mjs');

        await cleanupChromaManager();
        GraphService.db.autoSave = originalAutoSave;
        await TestLifecycleHelper.cleanupGraphService(GraphService, LifecycleService, null, fs, 'clear')
    });

    test.beforeEach(async () => {
        GraphService.db.nodes.clear();
        GraphService.db.edges.clear();
        GraphService.db.vicinityLoadedNodes.clear();

        if (GraphService.db.storage?.db) {
            await GraphService.db.storage.clear();
            GraphService.db.storage.db.exec('DELETE FROM GraphLog')
        }

        vectors = stubVectorStores()
    });

    test.afterEach(() => {
        StorageRouter.getGraphCollection   = originals.getGraphCollection;
        StorageRouter.getSummaryCollection = originals.getSummaryCollection;
        logger.warn                        = originals.warn
    });

    test('an edge whose endpoint is only evicted from the cache survives, with its receipt and both nodes', async () => {
        seedReceipt();
        evict('MESSAGE:gc-broadcast');

        expect(GraphService.db.nodes.get('MESSAGE:gc-broadcast'), 'precondition: the cache no longer holds the message').toBeFalsy();

        await GraphMaintenanceService.runGarbageCollection();

        expect(edgeRow('gc-delivered-to')?.readAt, 'the delivery edge and its committed readAt survive').toBe('2026-09-25T17:49:47.000Z');
        expect(nodeRow('MESSAGE:gc-broadcast'), 'the message is not stranded into an orphan').toBeDefined()
    });

    test('control: an edge whose endpoint is gone from storage is still severed', async () => {
        seedReceipt();
        evict('@gc-recipient');
        // gone from storage too; the foreign-key cascade removes the stored edge row with it
        GraphService.db.storage.db.prepare('DELETE FROM Nodes WHERE id = ?').run('@gc-recipient');

        expect(GraphService.db.edges.get('gc-delivered-to'), 'precondition: the cache still holds the stale edge').toBeTruthy();

        await GraphMaintenanceService.runGarbageCollection();

        expect(GraphService.db.edges.get('gc-delivered-to'), 'the unanchored edge leaves the cache').toBeFalsy();
        expect(edgeRow('gc-delivered-to'), 'and storage holds no row for it').toBeUndefined()
    });

    test('an edgeless session summary is not an orphan: the node and its vector both stay', async () => {
        GraphService.db.addNode({id: 'summary_gc-session', label: 'SESSION_SUMMARY', properties: {semanticVectorId: 'summary_gc-session'}});

        expect(GraphService.getOrphanedNodes(), 'the orphan query skips it').not.toContain('summary_gc-session');

        await GraphMaintenanceService.runGarbageCollection();

        expect(nodeRow('summary_gc-session'), 'the summary node stays').toBeDefined();
        expect(vectors.summary, 'and query_summaries keeps its vector').not.toContain('summary_gc-session')
    });

    test('an edgeless durable record is not an orphan, whatever its label', async () => {
        const records = {
            'AGENT_MEMORY:gc-turn'     : 'AGENT_MEMORY',
            'MESSAGE:gc-severed'       : 'MESSAGE',
            'SYSTEM_CLOCK:gc'          : 'SYSTEM_CLOCK',
            'kb-tenant-manifest:gc'    : 'KnowledgeBaseTenantManifest',
            'nl-transaction-archive:gc': 'nl-transaction-archive'
        };

        Object.entries(records).forEach(([id, label]) => GraphService.db.addNode({id, label, properties: {}}));

        const orphaned = GraphService.getOrphanedNodes();

        await GraphMaintenanceService.runGarbageCollection();

        expect(Object.keys(records).filter(id => !orphaned.includes(id) && nodeRow(id)), 'every record stays out of the orphan query and in storage')
            .toEqual(Object.keys(records))
    });

    test('an orphan loses its vectors only together with its node', async () => {
        GraphService.db.addNode({id: 'CONCEPT:gc-cached', label: 'CONCEPT', properties: {}});
        GraphService.db.addNode({id: 'CONCEPT:gc-stored', label: 'CONCEPT', properties: {}});
        evict('CONCEPT:gc-stored');

        await GraphMaintenanceService.runGarbageCollection();

        expect(nodeRow('CONCEPT:gc-cached'), 'precondition: the cached orphan left storage').toBeUndefined();

        for (const id of ['CONCEPT:gc-cached', 'CONCEPT:gc-stored']) {
            const leftStorage = !nodeRow(id);

            expect(vectors.graph.includes(id), `${id}: graph vector purged exactly when the node left storage`).toBe(leftStorage);
            expect(vectors.summary.includes(id), `${id}: summary vector purged exactly when the node left storage`).toBe(leftStorage)
        }
    });

    test('a failed vector purge is logged, not swallowed', async () => {
        const warnings = [];

        stubVectorStores({fail: true});
        logger.warn = message => warnings.push(message);
        GraphService.db.addNode({id: 'CONCEPT:gc-unpurged', label: 'CONCEPT', properties: {}});

        await GraphMaintenanceService.runGarbageCollection();

        expect(warnings.some(message => message.includes('vector store refused the delete')), 'the pass warns with the store\'s error').toBe(true)
    });
});
