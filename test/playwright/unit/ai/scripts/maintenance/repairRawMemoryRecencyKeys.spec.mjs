import {setup} from '../../../../setup.mjs';

setup();

import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    applyRecencyRepair,
    createDryRunRuntime,
    parseArgs,
    planRecencyRepair,
    readRecencyGraphState,
    runCli
} from '../../../../../../ai/scripts/maintenance/repairRawMemoryRecencyKeys.mjs';

void Neo;
void core;

const
    iso  = '2026-01-13T12:53:27.852Z',
    mira = {agentIdentity: 'neo-test-mira', timestamp: Date.parse(iso)},
    row  = (id, metadata = {}) => ({id, metadata: {sessionId: 'session-a', ...metadata}});

/**
 * @param {Object[]} nodes Serialized as the graph stores them: `{id, label, properties}`.
 * @returns {Object} An in-memory better-sqlite3 graph.
 */
function graphDb(nodes) {
    const db = new Database(':memory:');

    db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT)');
    nodes.forEach(node => db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(node.id, JSON.stringify(node)));

    return db
}

test.describe('ai/scripts/maintenance/repairRawMemoryRecencyKeys', () => {
    test('a dry run is the default, and an apply without --offline is refused before any runtime starts', async () => {
        const errors = [];

        expect(parseArgs([])).toEqual({apply: false, help: false, offline: false});
        expect(() => parseArgs(['--db'])).toThrow('unknown argument: --db');
        expect(await runCli(['--apply'], {
            runtimeFactory: () => {throw new Error('runtime started')},
            stderr        : message => errors.push(message)
        })).toBe(2);
        expect(errors).toEqual(['[repairRawMemoryRecencyKeys] --apply requires --offline after every Memory Core graph writer is stopped']);
    });

    // ChromaManager's cached getters create a missing collection; an inspection must refuse one instead
    test('a dry run against a missing raw-memory collection refuses, and creates nothing', async () => {
        const
            {default: ChromaManager}   = await import('../../../../../../ai/services/memory-core/managers/ChromaManager.mjs'),
            {resetMemoryCoreLifecycle} = await import('../../services/memory-core/util.mjs'),
            calls                      = [];

        let originalClient;

        try {
            await ChromaManager.ready();

            originalClient       = ChromaManager.client;
            ChromaManager.client = {
                async getCollection({name}) {
                    calls.push('getCollection');
                    throw new Error(`Collection [${name}] does not exist`)
                },
                async createCollection()      { calls.push('createCollection') },
                async getOrCreateCollection() { calls.push('getOrCreateCollection') }
            };

            await expect(createDryRunRuntime()).rejects.toThrow('does not exist');
            expect(calls).toEqual(['getCollection']);
        } finally {
            if (originalClient) ChromaManager.client = originalClient;
            await resetMemoryCoreLifecycle();
        }
    });

    test('a dry run only reads the collection it scans', async () => {
        const
            calls      = [],
            out        = [],
            collection = {
                async get({offset}) {
                    calls.push('get');
                    return offset ? {ids: [], metadatas: []} : {ids: ['mem-1'], metadatas: [{...mira, sessionId: 'session-a'}]}
                }
            };

        ['add', 'delete', 'modify', 'update', 'upsert'].forEach(method => collection[method] = async () => calls.push(method));

        expect(await runCli([], {runtimeFactory: () => ({graphDb: graphDb([]), memoryCollection: collection}), stdout: line => out.push(line)})).toBe(0);
        expect(new Set(calls)).toEqual(new Set(['get']));
        expect(JSON.parse(out[0])).toMatchObject({counts: {project: 1}, mode: 'dry-run'});
    });

    test('each row is classified against the graph from the row itself', () => {
        const plan = planRecencyRepair({
            chromaRows: [
                row('mem-current', mira),
                row('mem-bare', mira),
                row('mem-stale', mira),
                row('mem-legacy', mira),
                row('mem-new', mira),
                row('mem-anonymous', {timestamp: mira.timestamp})
            ],
            graph: readRecencyGraphState(graphDb([
                {id: 'mem-current',       label: 'AGENT_MEMORY', properties: {agentIdentity: '@neo-test-mira', timestamp: iso}},
                {id: 'mem-bare',          label: 'AGENT_MEMORY', properties: {sessionId: 'session-a'}},
                {id: 'mem-stale',         label: 'AGENT_MEMORY', properties: {agentIdentity: '@neo-test-other', timestamp: iso}},
                {id: 'memory:mem-legacy', label: 'MEMORY',       properties: {chromaId: 'mem-legacy'}}
            ]))
        });

        expect(plan.counts).toEqual({current: 1, legacyOnly: 1, project: 1, reproject: 2, rows: 6, unattributed: 1});
        expect(plan.reproject.map(({id}) => id)).toEqual(['mem-bare', 'mem-stale']);
        expect(plan.project.map(({id}) => id)).toEqual(['mem-new']);
    });

    test('each session is synced once with exactly its planned rows, and what cannot be repaired is reported', async () => {
        const
            calls    = [],
            ingestor = {
                async syncSessionToGraph(session, {rawMemories}) {
                    calls.push(['sync', session.id, rawMemories.ids]);
                    return {errors: [], memoriesUpserted: rawMemories.ids.length}
                },
                async ingestSingleRow(graphNodeId) {
                    calls.push(['project', graphNodeId]);
                    return graphNodeId === 'memory:mem-taken' ? {reason: 'canonical-label-conflict', error: 'occupied'} : {reason: 'backfilled'}
                }
            },
            summaryCollection = {
                async get({where}) {
                    return where.sessionId === 'session-a' ? {ids: ['summary-a'], metadatas: [{sessionId: 'session-a'}]} : {ids: [], metadatas: []}
                }
            };

        const result = await applyRecencyRepair({
            project  : [row('mem-new'), row('mem-taken')],
            reproject: [row('mem-1'), row('mem-unsummarized', {sessionId: 'session-b'}), row('mem-2')]
        }, {memoryCollection: {}, memorySessionIngestor: ingestor, summaryCollection});

        expect(calls).toEqual([
            ['sync', 'summary-a', ['mem-1', 'mem-2']],
            ['project', 'memory:mem-new'],
            ['project', 'memory:mem-taken']
        ]);
        expect(result).toEqual({failed: [{error: 'occupied', id: 'mem-taken', reason: 'canonical-label-conflict'}], noSummary: 1, projected: 1, reprojected: 2});
    });
});
