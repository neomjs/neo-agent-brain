import {setup} from '../../../../setup.mjs';

setup({
    appConfig: {
        name: 'AiRebuildMessageEdgesTest'
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import Database       from 'better-sqlite3';
import fs             from 'fs-extra';
import path           from 'path';
import {canReadMessage} from '../../../../../../ai/services/memory-core/helpers/messageAdmission.mjs';
import {
    rebuildMessageEdges,
    runRebuildMessageEdges,
    targetsOf
} from '../../../../../../ai/scripts/maintenance/rebuildMessageEdges.mjs';

/**
 * @summary The rebuild links only what a message's own fields name and the live graph lacks: a
 * present edge keeps its weight, a missing target is reported (a tag's concept node is created
 * instead), a dry run writes nothing, and a rerun links nothing.
 */
test.describe('rebuildMessageEdges maintenance script', () => {
    let tmpRoot, dbPath;
    const quiet = {log() {}};

    const node = (id, label, properties = {}) => ({id, label, properties});
    const message = (id, properties) => node(id, 'MESSAGE', {sentAt: '2026-09-25T10:00:00.000Z', userId: 'neo-opus-vega', sharedEntity: true, ...properties});

    const openDb = () => new Database(dbPath);

    const seedLive = ({nodes = [], edges = []}) => {
        const db = openDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS Nodes (id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS Edges (
                id TEXT PRIMARY KEY, user_id TEXT, source TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
                FOREIGN KEY (source) REFERENCES Nodes(id) ON DELETE CASCADE,
                FOREIGN KEY (target) REFERENCES Nodes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_edges_source ON Edges(source);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON Edges(target);
        `);
        const insertNode = db.prepare('INSERT INTO Nodes (id, user_id, data) VALUES (?, NULL, ?)'),
              insertEdge = db.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, NULL, ?, ?, ?, ?)');
        nodes.forEach(n => insertNode.run(n.id, JSON.stringify(n)));
        edges.forEach(e => insertEdge.run(e.id, e.source, e.target, e.type, JSON.stringify(e)));
        db.close();
    };

    const liveEdges = () => {
        const db = openDb();
        const rows = db.prepare("SELECT source, target, type, user_id AS userId, json_extract(data, '$.properties') AS properties FROM Edges ORDER BY type, source, target").all()
            .map(row => ({...row, properties: JSON.parse(row.properties)}));
        db.close();
        return rows;
    };

    const liveNode = id => {
        const db = openDb();
        const row = db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id);
        db.close();
        return row ? JSON.parse(row.data) : null;
    };

    test.beforeEach(async () => {
        tmpRoot = path.resolve(process.cwd(), 'tmp', `rebuild-message-edges-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        dbPath  = path.join(tmpRoot, 'memory-core-graph.sqlite');
        await fs.ensureDir(tmpRoot);
    });

    test.afterEach(async () => {
        await fs.remove(tmpRoot);
    });

    test('a missing reply, thread, ticket and tag edge is linked the way the projection links it', () => {
        seedLive({nodes: [
            message('MESSAGE:parent', {}),
            message('MESSAGE:child', {inReplyTo: 'MESSAGE:parent', partOfThread: 'MESSAGE:parent', relatedTickets: ['neomjs/neo#538'], taggedConcepts: ['merge-handoff']}),
            node('issue-538', 'ISSUE'), node('538', 'CONCEPT'), node('merge-handoff', 'CONCEPT')
        ]});

        const result = runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(result.messages).toBe(2);
        const {REFERENCES_TICKET, ...otherTypes} = result.types;

        expect(otherTypes).toEqual({
            IN_REPLY_TO   : {fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0},
            PART_OF_THREAD: {fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0},
            TAGGED_CONCEPT: {fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0}
        });
        expect(REFERENCES_TICKET).toMatchObject({fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0});
        expect(REFERENCES_TICKET.unresolved ?? {}).toEqual({});
        const rows = liveEdges();
        expect(rows.map(row => [row.type, row.target])).toEqual([
            ['IN_REPLY_TO', 'MESSAGE:parent'], ['PART_OF_THREAD', 'MESSAGE:parent'], ['REFERENCES_TICKET', 'issue-538'], ['TAGGED_CONCEPT', 'merge-handoff']
        ]);
        rows.forEach(row => {
            expect(row.source).toBe('MESSAGE:child');
            expect(row.userId).toBe('neo-opus-vega');
            expect(row.properties).toEqual({
                weight: 1, timestamp: '2026-09-25T10:00:00.000Z', userId: 'neo-opus-vega', sharedEntity: true,
                ...(row.type === 'REFERENCES_TICKET' ? {externalRef: 'neomjs/neo#538'} : {})
            });
        });
    });

    test('a present edge keeps its weight; a missing target is reported, and a tag\'s concept node is created instead', () => {
        seedLive({
            nodes: [
                message('MESSAGE:parent', {}),
                message('MESSAGE:child', {inReplyTo: 'MESSAGE:gone', partOfThread: 'MESSAGE:parent', relatedTickets: ['neomjs/neo#0'], taggedConcepts: ['new-tag', 'old-tag']}),
                node('old-tag', 'CONCEPT')
            ],
            edges: [{id: 'kept', source: 'MESSAGE:child', target: 'old-tag', type: 'TAGGED_CONCEPT', properties: {weight: 0.62}}]
        });

        const result = runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(result.types).toEqual({
            IN_REPLY_TO      : {fields: 1, linked: 0, present: 0, missingTarget: 1, conceptsCreated: 0},
            PART_OF_THREAD   : {fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0},
            REFERENCES_TICKET: {fields: 1, linked: 0, present: 0, missingTarget: 1, conceptsCreated: 0, unresolved: {invalidReference: 1}},
            TAGGED_CONCEPT   : {fields: 1, linked: 1, present: 1, missingTarget: 0, conceptsCreated: 1}
        });
        expect(liveEdges().find(row => row.target === 'old-tag').properties).toEqual({weight: 0.62});
        expect(liveNode('new-tag')).toEqual({id: 'new-tag', label: 'CONCEPT', properties: {name: 'new-tag', description: '', canonicalConceptId: 'new-tag', userId: null}});
        expect(liveEdges().map(row => row.type)).toEqual(['PART_OF_THREAD', 'TAGGED_CONCEPT', 'TAGGED_CONCEPT']);
    });

    test('a dry run counts the same work and writes nothing; a rerun after an apply links nothing', () => {
        seedLive({nodes: [
            message('MESSAGE:parent', {}),
            message('MESSAGE:child', {inReplyTo: 'MESSAGE:parent', relatedTickets: ['neomjs/neo#541'], taggedConcepts: ['a-tag']}),
            node('issue-541', 'ISSUE')
        ]});

        const dry = runRebuildMessageEdges({dbPath, logger: quiet});

        expect(dry.types.IN_REPLY_TO).toEqual({fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0});
        expect(dry.types.TAGGED_CONCEPT).toEqual({fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 1});
        expect(dry.types.REFERENCES_TICKET).toMatchObject({fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0});
        expect(dry.types.REFERENCES_TICKET.unresolved ?? {}).toEqual({});
        expect(liveEdges()).toEqual([]);
        expect(liveNode('a-tag')).toBeNull();

        runRebuildMessageEdges({dbPath, apply: true, logger: quiet});
        const applied = liveEdges(),
              again   = runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(again.types.IN_REPLY_TO).toEqual({fields: 1, linked: 0, present: 1, missingTarget: 0, conceptsCreated: 0});
        expect(again.types.TAGGED_CONCEPT).toEqual({fields: 1, linked: 0, present: 1, missingTarget: 0, conceptsCreated: 0});
        expect(again.types.REFERENCES_TICKET).toMatchObject({fields: 1, linked: 0, present: 1, missingTarget: 0, conceptsCreated: 0});
        expect(liveEdges()).toEqual(applied);
        expect(liveEdges()).toHaveLength(3);
        expect(applied.find(row => row.type === 'REFERENCES_TICKET')).toMatchObject({target: 'issue-541', properties: {externalRef: 'neomjs/neo#541'}});
    });

    test('--types links only the named types and counts nothing else', () => {
        seedLive({nodes: [message('MESSAGE:parent', {}), message('MESSAGE:child', {inReplyTo: 'MESSAGE:parent', taggedConcepts: ['a-tag']})]});

        const result = runRebuildMessageEdges({dbPath, apply: true, types: ['IN_REPLY_TO'], logger: quiet});

        expect(Object.keys(result.types)).toEqual(['IN_REPLY_TO']);
        expect(liveEdges().map(row => row.type)).toEqual(['IN_REPLY_TO']);
        expect(liveNode('a-tag')).toBeNull();
    });

    test('an apply that crosses the write batch size flushes without a cursor open on the connection', () => {
        const count = 1001;
        seedLive({nodes: [message('MESSAGE:parent', {}), ...Array.from({length: count}, (_, i) => message(`MESSAGE:child-${i}`, {inReplyTo: 'MESSAGE:parent'}))]});

        const result = runRebuildMessageEdges({dbPath, apply: true, types: ['IN_REPLY_TO'], logger: quiet});

        expect(result.types.IN_REPLY_TO).toEqual({fields: count, linked: count, present: 0, missingTarget: 0, conceptsCreated: 0});
        expect(liveEdges()).toHaveLength(count);
    });

    test('a qualified pull request resolves to its PULL_REQUEST node, never the numeric concept, and keeps the authored reference', () => {
        const externalRef = 'neomjs/neo#539';

        seedLive({nodes: [
            message('MESSAGE:pr-reference', {relatedTickets: externalRef}),
            node('pr-539', 'PULL_REQUEST'),
            node('539', 'CONCEPT')
        ]});

        const result = runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(result.types.REFERENCES_TICKET).toMatchObject({fields: 1, linked: 1, present: 0, missingTarget: 0, conceptsCreated: 0});
        expect(result.types.REFERENCES_TICKET.unresolved ?? {}).toEqual({});
        expect(liveEdges()).toEqual([{
            source    : 'MESSAGE:pr-reference',
            target    : 'pr-539',
            type      : 'REFERENCES_TICKET',
            userId    : 'neo-opus-vega',
            properties: {weight: 1, timestamp: '2026-09-25T10:00:00.000Z', userId: 'neo-opus-vega', sharedEntity: true, externalRef}
        }]);
    });

    test('foreign, absent, numeric-concept, invalid and ambiguous references stay unlinked and are counted by their unresolved class', () => {
        const refs = [
            'neomjs/neo-agent-brain#556',
            'neomjs/neo#557',
            'neomjs/neo#558',
            'neomjs/neo#bad',
            'neomjs/neo#559'
        ];

        seedLive({nodes: [
            message('MESSAGE:unresolved', {relatedTickets: refs}),
            node('issue-556', 'ISSUE'),
            node('neomjs/neo-agent-brain#556', 'ISSUE'),
            node('558', 'CONCEPT'),
            node('issue-559', 'ISSUE'),
            node('pr-559', 'PULL_REQUEST')
        ]});

        const result = runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(result.types).toEqual({
            REFERENCES_TICKET: {
                fields: 1, linked: 0, present: 0, missingTarget: 5, conceptsCreated: 0,
                unresolved: {foreignRepository: 1, notIngested: 1, conceptCollision: 1, invalidReference: 1, ambiguousTicket: 1}
            }
        });
        expect(liveEdges()).toEqual([]);
        expect(liveNode('558').label).toBe('CONCEPT');
        expect(liveNode('MESSAGE:unresolved').properties.relatedTickets).toEqual(refs);
    });

    test('a target lookup failure is counted rather than inventing an edge or aborting the rebuild', () => {
        seedLive({nodes: [
            message('MESSAGE:lookup-failure', {relatedTickets: ['neomjs/neo#562']}),
            node('issue-562', 'ISSUE')
        ]});

        const db = openDb();

        // Preserve SQLite's real statements and transactions; only the named target lookup fails.
        // Message enumeration and every other read still go through the fixture database.
        const wrapStatement = statement => new Proxy(statement, {
            get(target, property) {
                if (property === 'get') {
                    return (...args) => {
                        if (args[0] === 'issue-562') throw new Error('fixture ticket lookup failed');
                        return target.get(...args);
                    };
                }
                if (property === 'pluck') return (...args) => wrapStatement(target.pluck(...args));

                const value = target[property];

                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
        const failingDb = new Proxy(db, {
            get(target, property) {
                if (property === 'prepare') return sql => wrapStatement(target.prepare(sql));

                const value = target[property];

                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        try {
            const result = rebuildMessageEdges({db: failingDb, apply: true});

            expect(result.types).toEqual({
                REFERENCES_TICKET: {
                    fields: 1, linked: 0, present: 0, missingTarget: 1, conceptsCreated: 0,
                    unresolved: {lookupFailed: 1}
                }
            });
            expect(db.prepare('SELECT COUNT(*) FROM Edges').pluck().get()).toBe(0);
        } finally {
            db.close();
        }
    });

    const identity  = id => node(id, 'AgentIdentity'),
          broadcast = () => node('AGENT:*', 'BroadcastSentinel'),
          // the facts MailboxService.getMessage reads off one message's edges
          routeFacts = messageId => {
              const rows = liveEdges().filter(row => row.source === messageId);

              return {
                  sentBy        : rows.find(row => row.type === 'SENT_BY')?.target ?? null,
                  sentTo        : rows.filter(row => row.type === 'SENT_TO').map(row => row.target),
                  deliveredToMe : false,
                  hasDeliveries : false,
                  canReadInboxOf: () => false
              };
          };

    test('a message older than the WAL gains the carriers its fields name, normalized and stamped as the projection writes them', () => {
        seedLive({nodes: [
            message('MESSAGE:direct', {from: 'neo-opus-vega', to: '@neo-opus-ada'}),
            message('MESSAGE:broadcast', {from: '@neo-opus-ada', to: 'AGENT:*'}),
            identity('@neo-opus-vega'), identity('@neo-opus-ada'), broadcast()
        ]});

        const result = runRebuildMessageEdges({dbPath, apply: true, logger: quiet}),
              base   = {weight: 1, timestamp: '2026-09-25T10:00:00.000Z', userId: 'neo-opus-vega', sharedEntity: true};

        expect(result.types).toEqual({
            SENT_BY: {fields: 2, linked: 2, present: 0, missingTarget: 0, conceptsCreated: 0, invalid: 0},
            SENT_TO: {fields: 2, linked: 2, present: 0, missingTarget: 0, conceptsCreated: 0, invalid: 0}
        });
        expect(liveEdges().map(({source, target, type, properties}) => ({source, target, type, properties}))).toEqual([
            {source: 'MESSAGE:broadcast', target: '@neo-opus-ada',  type: 'SENT_BY', properties: base},
            {source: 'MESSAGE:direct',    target: '@neo-opus-vega', type: 'SENT_BY', properties: base},
            {source: 'MESSAGE:broadcast', target: 'AGENT:*',        type: 'SENT_TO', properties: {...base, broadcastCohort: 'legacy-unknown'}},
            {source: 'MESSAGE:direct',    target: '@neo-opus-ada',  type: 'SENT_TO', properties: base}
        ]);
    });

    test('a held carrier stays whatever it targets, an unknown identity is counted and never created, and a dry run writes nothing', () => {
        seedLive({
            nodes: [
                message('MESSAGE:held', {from: '@neo-opus-vega', to: '@neo-opus-ada'}),
                message('MESSAGE:stranger', {from: '@nobody', to: '@neo-opus-ada'}),
                identity('@neo-opus-vega'), identity('@neo-opus-ada'), identity('neo-opus-4-7')
            ],
            edges: [{id: 'kept', source: 'MESSAGE:held', target: 'neo-opus-4-7', type: 'SENT_BY', properties: {weight: 1}}]
        });

        const dry = runRebuildMessageEdges({dbPath, logger: quiet});

        expect(dry.types).toEqual({
            SENT_BY: {fields: 2, linked: 0, present: 1, missingTarget: 1, conceptsCreated: 0, invalid: 0},
            SENT_TO: {fields: 2, linked: 2, present: 0, missingTarget: 0, conceptsCreated: 0, invalid: 0}
        });
        expect(liveEdges().map(row => row.target)).toEqual(['neo-opus-4-7']);

        runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(liveEdges().filter(row => row.type === 'SENT_BY').map(row => row.target)).toEqual(['neo-opus-4-7']);
        expect(liveNode('@nobody')).toBeNull();
    });

    test('the rebuilt carriers let the sender and the recipient open a direct message, and nobody else', () => {
        seedLive({nodes: [
            message('MESSAGE:direct', {from: '@neo-opus-vega', to: '@neo-opus-ada'}),
            identity('@neo-opus-vega'), identity('@neo-opus-ada')
        ]});

        expect(canReadMessage('@neo-opus-vega', routeFacts('MESSAGE:direct'))).toBe(false);

        runRebuildMessageEdges({dbPath, apply: true, logger: quiet});

        expect(canReadMessage('@neo-opus-vega', routeFacts('MESSAGE:direct'))).toBe(true);
        expect(canReadMessage('@neo-opus-ada', routeFacts('MESSAGE:direct'))).toBe(true);
        expect(canReadMessage('@neo-gpt-emmy', routeFacts('MESSAGE:direct'))).toBe(false);
    });

    test('a route another writer adds between the scan and the flush stays the only one and counts as present', () => {
        seedLive({nodes: [
            message('MESSAGE:direct', {from: '@neo-opus-vega', to: '@neo-opus-ada'}),
            identity('@neo-opus-vega'), identity('@neo-opus-ada'), identity('@neo-gpt-emmy')
        ]});

        const db = openDb();

        // the precheck answers "no route" and, before the batch flushes, a competing writer links one
        const raced = new Proxy(db, {
            get(target, property) {
                if (property !== 'prepare') {
                    const value = target[property];
                    return typeof value === 'function' ? value.bind(target) : value;
                }

                return sql => {
                    const statement = target.prepare(sql);

                    if (!sql.startsWith('SELECT 1 FROM Edges WHERE source = ? AND type = ?')) return statement;

                    const precheck = statement.pluck();

                    return {pluck: () => ({get: (source, type) => {
                        const held = precheck.get(source, type);

                        if (type === 'SENT_TO') {
                            target.prepare('INSERT INTO Edges (id, user_id, source, target, type, data) VALUES (?, NULL, ?, ?, ?, ?)')
                                .run('competing', source, '@neo-gpt-emmy', type, JSON.stringify({id: 'competing', properties: {weight: 1}}));
                        }

                        return held;
                    }})};
                };
            }
        });

        try {
            const result = rebuildMessageEdges({db: raced, apply: true, types: ['SENT_TO']});

            expect(db.prepare("SELECT target FROM Edges WHERE source = 'MESSAGE:direct' AND type = 'SENT_TO'").pluck().all()).toEqual(['@neo-gpt-emmy']);
            expect(result.types.SENT_TO).toEqual({fields: 1, linked: 0, present: 1, missingTarget: 0, conceptsCreated: 0, invalid: 0});
        } finally {
            db.close();
        }
    });

    test('malformed routing never becomes a route, and the valid historical routes beside it still do', () => {
        seedLive({nodes: [
            message('MESSAGE:direct', {from: '@neo-opus-vega', to: '@neo-opus-ada'}),
            message('MESSAGE:broadcast', {from: '@neo-opus-ada', to: 'AGENT:*'}),
            message('MESSAGE:array-to', {from: '@neo-opus-vega', to: ['AGENT:*', '@neo-opus-ada']}),
            message('MESSAGE:concept-from', {from: '@a-concept', to: '@neo-opus-ada'}),
            node('MESSAGE:artifact', 'ARTIFACT_TASK', {from: '@neo-opus-vega', to: 'AGENT:*'}),
            identity('@neo-opus-vega'), identity('@neo-opus-ada'), broadcast(), node('@a-concept', 'CONCEPT')
        ]});

        const result = runRebuildMessageEdges({dbPath, apply: true, types: ['SENT_BY', 'SENT_TO'], logger: quiet});

        expect(canReadMessage('@neo-gpt-emmy', routeFacts('MESSAGE:array-to'))).toBe(false);
        expect(canReadMessage('@neo-gpt-emmy', routeFacts('MESSAGE:broadcast'))).toBe(true);
        expect(canReadMessage('@neo-opus-ada', routeFacts('MESSAGE:direct'))).toBe(true);
        expect(canReadMessage('@neo-gpt-emmy', routeFacts('MESSAGE:direct'))).toBe(false);
        expect(liveEdges().filter(row => ['MESSAGE:array-to', 'MESSAGE:artifact'].includes(row.source) && row.type === 'SENT_TO')).toEqual([]);
        expect(liveEdges().filter(row => ['MESSAGE:concept-from', 'MESSAGE:artifact'].includes(row.source) && row.type === 'SENT_BY')).toEqual([]);

        expect(result.types).toEqual({
            SENT_BY: {fields: 5, linked: 3, present: 0, missingTarget: 0, conceptsCreated: 0, invalid: 2},
            SENT_TO: {fields: 5, linked: 3, present: 0, missingTarget: 0, conceptsCreated: 0, invalid: 2}
        });
    });

    test('targetsOf reads one string or every string entry of an array, nothing else', () => {
        expect(targetsOf('MESSAGE:x')).toEqual(['MESSAGE:x']);
        expect(targetsOf(['a', '', 3, null, 'b'])).toEqual(['a', 'b']);
        expect(targetsOf(null)).toEqual([]);
        expect(targetsOf(undefined)).toEqual([]);
    });
});
