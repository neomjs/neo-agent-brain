import {setup} from '../../../../setup.mjs';

setup();

import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    applyRecencyRepair,
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
