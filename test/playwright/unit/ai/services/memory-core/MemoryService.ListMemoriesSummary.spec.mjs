import {setup} from '../../../../setup.mjs';

const appName = 'MemoryServiceListMemoriesSummaryTest';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {expect, test} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import GraphService   from '../../../../../../ai/services/memory-core/GraphService.mjs';
import MemoryService  from '../../../../../../ai/services/memory-core/MemoryService.mjs';
import StorageRouter  from '../../../../../../ai/services/memory-core/managers/StorageRouter.mjs';

/**
 * @summary In-memory Chroma read seam for the session-scoped summary contract.
 * @returns {{rows: Map, get: Function}}
 */
function createMemoryCollection() {
    const rows = new Map();

    return {
        rows,
        async get({ids} = {}) {
            const entries = ids ? ids.map(id => rows.get(id)).filter(Boolean) : [...rows.values()];

            return {
                ids      : entries.map(entry => entry.id),
                metadatas: entries.map(entry => entry.metadata)
            }
        }
    }
}

test.describe('MemoryService.listMemories compact summary contract', () => {
    let collection,
        originalGetMemoryCollection;

    test.beforeEach(() => {
        collection                       = createMemoryCollection();
        originalGetMemoryCollection       = StorageRouter.getMemoryCollection;
        StorageRouter.getMemoryCollection = async () => collection
    });

    test.afterEach(() => {
        StorageRouter.getMemoryCollection = originalGetMemoryCollection
    });

    test('joins the stored graph miniSummary and marks a bounded raw fallback', async () => {
        const sessionId = `list-summary-${process.pid}`,
              storedId  = `${sessionId}-stored`,
              freshId   = `${sessionId}-fresh`;

        collection.rows.set(storedId, {
            id      : storedId,
            metadata: {sessionId, timestamp: 1, prompt: 'Long stored prompt', response: 'Long stored response'}
        });
        collection.rows.set(freshId, {
            id      : freshId,
            metadata: {sessionId, timestamp: 2, prompt: 'Fresh prompt', response: 'Fresh response'}
        });
        GraphService.upsertNode({
            id        : storedId,
            type      : 'AGENT_MEMORY',
            name      : 'stored summary witness',
            properties: {sessionId, miniSummary: 'Tweet-sized stored title'}
        });

        try {
            const view              = await MemoryService.listMemories({sessionId, limit: 10}),
                  [stored, fallback] = view.memories;

            expect(stored).toMatchObject({
                id             : storedId,
                miniSummary    : 'Tweet-sized stored title',
                summaryFallback: false
            });
            expect(fallback).toMatchObject({
                id             : freshId,
                miniSummary    : 'Fresh prompt — Fresh response',
                summaryFallback: true
            })
        } finally {
            GraphService.db?.removeNode(storedId)
        }
    })
});
