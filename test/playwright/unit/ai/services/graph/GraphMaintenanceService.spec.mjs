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
 * its edges like any other, so neither the edge nor the node the edge keeps alive is deleted.
 */
test.describe('Neo.ai.services.graph.GraphMaintenanceService', () => {
    test.describe.configure({mode: 'serial'});

    let GraphMaintenanceService, GraphService, LifecycleService, TestLifecycleHelper, originalAutoSave;

    const
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
        ({TestLifecycleHelper}  = await import('../memory-core/util.mjs'));

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
});
