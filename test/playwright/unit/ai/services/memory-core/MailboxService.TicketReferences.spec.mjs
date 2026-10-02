import {setup} from '../../../../setup.mjs';
setup({appConfig: {name: 'MailboxTicketReferencesTest'}, neoConfig: {unitTestMode: true}});

import {test, expect} from '@playwright/test';
import Neo from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import 'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';

/** @summary Real mailbox projection links typed tickets while its public reader preserves authored references. */
test.describe.configure({mode: 'serial'});
test.describe('MailboxService ticket references', () => {
    let MailboxService, GraphService, originalAutoSave;
    let sequence = 0;
    const sender = '@ticket-reference-sender', recipient = '@ticket-reference-recipient';
    const issueId = 'issue-9925471', prId = 'pr-9925472', conceptId = '9925473';
    const owned = new Set([sender, recipient, issueId, prId, conceptId]);

    test.beforeAll(async () => {
        GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        const LifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        await LifecycleService.ready();
        originalAutoSave = GraphService.db.autoSave;
        GraphService.db.autoSave = true;
        for (const [id, type] of [[sender, 'AgentIdentity'], [recipient, 'AgentIdentity'], [issueId, 'ISSUE'], [prId, 'PULL_REQUEST'], [conceptId, 'CONCEPT']]) {
            GraphService.upsertNode({id, type, name: id, properties: {sharedEntity: true, accountType: type === 'AgentIdentity' ? 'agent' : undefined}})
        }
    });

    test.afterAll(() => {
        GraphService.removeNodes([...owned]);
        GraphService.db.autoSave = originalAutoSave
    });

    const record = relatedTickets => {
        const id = 'MESSAGE:ticket-reference-' + ++sequence;
        const sentAt = new Date().toISOString();
        owned.add(id);
        return {
            id, timestamp: Date.parse(sentAt), sentAt, graphProjectionVersion: 1,
            message: {id, type: 'MESSAGE', name: 'ticket references', properties: {
                subject: 'ticket references', bodyText: '', sentAt, readAt: null,
                from: sender, to: recipient, userId: sender.slice(1), sharedEntity: true, relatedTickets
            }},
            routing: {sentBy: sender, to: recipient, senderUserId: sender.slice(1), broadcastRecipients: []},
            optionalEdges: {relatedTickets}
        }
    };
    const references = id => GraphService.db.edges.items.filter(edge => edge.source === id && edge.type === 'REFERENCES_TICKET');
    const read = id => RequestContextService.run({agentIdentityNodeId: recipient}, () => MailboxService.getMessage({messageId: id}));

    test('projection resolves issue and PR nodes, refuses concept and foreign collisions, and reports its resolution receipt', async () => {
        const authored = ['neomjs/neo#9925471', '#9925472', '#9925473', 'neomjs/neo-agent-brain#9925471', '#9925474'];
        const input = record(authored);
        const receipt = await MailboxService._projectMessageWalRecord(input, {pumpWake: false, appendMarker: false});
        expect(references(input.id).map(edge => [edge.target, edge.properties.externalRef]).sort()).toEqual([
            [issueId, authored[0]], [prId, authored[1]]
        ].sort());
        expect(receipt.ticketReferences).toEqual({requested: 5, resolved: 2, unresolved: {conceptCollision: 1, foreignRepository: 1, notIngested: 1}});
        expect((await read(input.id)).relatedTickets).toEqual([...authored].sort())
    });

    test('a corrected edge alone cannot leak its canonical id through the served field', async () => {
        const authored = 'neomjs/neo#9925471';
        const input = record([authored]);
        await MailboxService._projectMessageWalRecord(input, {pumpWake: false, appendMarker: false});
        GraphService.linkNodes(input.id, issueId, 'REFERENCES_TICKET', 1, {externalRef: authored, userId: sender.slice(1), sharedEntity: true});
        expect((await read(input.id)).relatedTickets).toEqual([authored])
    });


    test('ticket lookups use stored owner authority and do not hydrate ticket vicinities', async () => {
        const privateId = 'issue-9925475';
        owned.add(privateId);
        GraphService.upsertNode({id: privateId, type: 'ISSUE', name: 'private fixture', properties: {userId: 'ticket-owner-a', sharedEntity: false}});
        GraphService.db.storage.db.prepare('UPDATE Nodes SET user_id = ? WHERE id = ?').run('ticket-owner-b', privateId);
        const input = record(['#9925475', '#9925474']);
        const db = GraphService.db;
        const original = db.getAdjacentNodes;
        const ticketReads = [];
        db.getAdjacentNodes = function(id, ...args) {
            if (/^(issue-|pr-|992547)/.test(String(id))) ticketReads.push(id);
            return original.call(this, id, ...args)
        };
        try {
            const receipt = await RequestContextService.run({agentIdentityNodeId: sender, userId: 'ticket-owner-a'}, () =>
                MailboxService._projectMessageWalRecord(input, {pumpWake: false, appendMarker: false}));
            expect(references(input.id)).toEqual([]);
            expect(receipt.ticketReferences).toEqual({requested: 2, resolved: 0, unresolved: {notIngested: 2}});
            expect(ticketReads).toEqual([])
        } finally {
            db.getAdjacentNodes = original
        }
    });


    test('a failed optional lookup does not prevent delivery-critical projection', async () => {
        const input = record(['neomjs/neo#9925471']);
        const sqlite = GraphService.db.storage.db;
        const original = sqlite.prepare;
        sqlite.prepare = function(sql, ...args) {
            if (sql === 'SELECT id, user_id, data FROM Nodes WHERE id = ?') throw new Error('fixture lookup unavailable');
            return original.call(this, sql, ...args)
        };
        try {
            const receipt = await MailboxService._projectMessageWalRecord(input, {pumpWake: false, appendMarker: false});
            expect(receipt.ticketReferences).toEqual({requested: 1, resolved: 0, unresolved: {lookupFailed: 1}});
            expect(references(input.id)).toEqual([]);
            expect(GraphService.db.edges.items.some(edge => edge.source === input.id && edge.type === 'SENT_TO' && edge.target === recipient)).toBe(true)
        } finally {
            sqlite.prepare = original
        }
    });

    test('surgical repair reports that semantic references were not consulted', async () => {
        const input = record(['neomjs/neo#9925471']);
        const receipt = await MailboxService._projectMessageWalRecord(input, {pumpWake: false, onlyIssues: ['missing-message-node'], appendMarker: false});
        expect(receipt.ticketReferences).toBeNull();
        expect(references(input.id)).toEqual([])
    });

    test('legacy edges without an external reference retain their public spelling', async () => {
        const authored = '#9925472';
        const input = record([authored]);
        await MailboxService._projectMessageWalRecord(input, {pumpWake: false, appendMarker: false});
        GraphService.upsertNode({id: 'neomjs/neo#9925472', type: 'ISSUE', name: 'legacy reference', properties: {sharedEntity: true}});
        owned.add('neomjs/neo#9925472');
        GraphService.linkNodes(input.id, 'neomjs/neo#9925472', 'REFERENCES_TICKET', 1, {sharedEntity: true});
        expect((await read(input.id)).relatedTickets).toEqual(['#9925472', 'neomjs/neo#9925472'])
    });
});
