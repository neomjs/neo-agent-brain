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

import {expect, test}              from '@playwright/test';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import GraphService                from '../../../../../../ai/services/memory-core/GraphService.mjs';
import MemoryService               from '../../../../../../ai/services/memory-core/MemoryService.mjs';
import {formatTurnDocumentForRead} from '../../../../../../ai/services/memory-core/helpers/turnDocumentText.mjs';
import StorageRouter               from '../../../../../../ai/services/memory-core/managers/StorageRouter.mjs';

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
            const view               = await MemoryService.listMemories({sessionId, limit: 10}),
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
    });

    test('#1580 serializes decisionContext without thought on listMemories and rewrites Agent Thought: headers at read boundaries only', async () => {
        const sessionId = `list-dc-${process.pid}`,
              legacyId  = `${sessionId}-legacy`,
              legacyRow = {
                  sessionId,
                  timestamp: 1,
                  prompt   : 'Prompt text',
                  thought  : 'Decided X because Y',
                  response : 'Response text',
                  type     : 'agent-interaction'
              };

        collection.rows.set(legacyId, {id: legacyId, metadata: legacyRow});

        const listed = await MemoryService.listMemories({sessionId, limit: 10});
        expect(listed.memories).toHaveLength(1);
        expect(listed.memories[0].decisionContext).toBe('Decided X because Y');
        expect('thought' in listed.memories[0]).toBe(false);
        expect(legacyRow.thought).toBe('Decided X because Y');

        const legacyDoc = 'User Prompt: P\nAgent Thought: Decided X because Y\nAgent Response: R';
        expect(formatTurnDocumentForRead(legacyDoc))
            .toBe('User Prompt: P\nDecision Context: Decided X because Y\nAgent Response: R');
        expect(formatTurnDocumentForRead('Inline mention of Agent Thought: inside prose stays untouched'))
            .toBe('Inline mention of Agent Thought: inside prose stays untouched');

        const origGetSummaryCollection = StorageRouter.getSummaryCollection,
              targetId                 = `brief-target-${process.pid}`,
              neighborId               = `brief-mem-${process.pid}`;

        StorageRouter.getSummaryCollection = async () => ({
            get: async () => ({
                documents: [null],
                metadatas: [legacyRow]
            })
        });

        GraphService.upsertNode({id: targetId, type: 'EPIC', name: 'Target Epic'});
        GraphService.upsertNode({
            id              : neighborId,
            type            : 'AGENT_MEMORY',
            name            : 'Neighbor Mem',
            semanticVectorId: neighborId,
            properties      : {sessionId}
        });
        GraphService.linkNodes(targetId, neighborId, 'DISCUSSED_IN', 0.9);

        try {
            const brief = await MemoryService.preBriefSession({targetId, limit: 5});
            const ctx   = brief.context.find(c => c.id === neighborId);
            expect(ctx.episodicContext).toContain('Decision Context: Decided X because Y');
            expect(ctx.episodicContext).not.toContain('Agent Thought:');
            expect(legacyRow.thought).toBe('Decided X because Y');
        } finally {
            StorageRouter.getSummaryCollection = origGetSummaryCollection;
            GraphService.db?.removeNode(neighborId);
            GraphService.db?.removeNode(targetId)
        }
    })
});
