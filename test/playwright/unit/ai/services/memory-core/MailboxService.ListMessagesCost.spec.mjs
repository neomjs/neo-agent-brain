import {setup} from '../../../../setup.mjs';

const appName = 'MailboxListCostTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import {performance}  from 'node:perf_hooks';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import                        'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';

/**
 * @summary A page hydrates what the page holds, not what the mailbox holds.
 *
 * `listMessages` served `limit` rows by evaluating every message the identity could see: it
 * hydrated every broadcast's vicinity, read each candidate's receipt state, built each summary,
 * sorted them all and sliced last. On the plane that was one storage read per candidate for
 * thousands of candidates per page, on every cockpit tick and every turn start.
 *
 * The observer counts the two things that scaled with the mailbox: vicinity loads from storage and
 * prepared SQLite statements. The bound is a constant per served row plus a constant per call —
 * generous, so a page-first read passes with room, and a mailbox-wide walk cannot: the fixture
 * seeds many more candidates than the bound admits, both direct and broadcast, because the
 * broadcast fan-out is the path that hydrated `AGENT:*` wholesale. What the bound does NOT claim:
 * the match set is still named, counted and sorted inside SQLite (one statement each, a temporary
 * B-tree for the order), so that work grows with the matches — the per-message reads and the
 * hydration are what the page bounds.
 *
 * `NEO_LIST_COST_SEED` sets the fixture size (an even number, half direct, half broadcast); the
 * default keeps CI short, and a 10k run is recorded on the PR that landed the bound. Seeding goes
 * through the real accept path, which is why the fixture is not larger by default.
 */
test.describe.configure({mode: 'serial'});

const
    SENDER           = '@list-cost-sender',
    RECIPIENT        = '@list-cost-recipient',
    SEEDED           = Math.max(2, Number(process.env.NEO_LIST_COST_SEED) || 1_000),
    SEEDED_DIRECT    = Math.ceil(SEEDED / 2),
    SEEDED_BROADCAST = Math.floor(SEEDED / 2),
    LIMIT            = 50,
    READS_PER_ROW    = 8,
    READS_PER_CALL   = 32,
    READ_BOUND       = READS_PER_CALL + READS_PER_ROW * LIMIT;

test.describe('MailboxService.listMessages — the cost of a page is bounded by the page', () => {
    let MailboxService, GraphService, LifecycleService;

    const asRecipient = callback => RequestContextService.run({agentIdentityNodeId: RECIPIENT}, callback);

    /**
     * @summary Runs `callback` while counting storage vicinity loads and prepared SQLite statements.
     * @param {Function} callback
     * @returns {Promise<{result: *, vicinityLoads: Number, statements: Number, ms: Number}>}
     */
    async function observeStorage(callback) {
        const storage = GraphService.db.storage,
              sqlite  = storage.db,
              counts  = {vicinityLoads: 0, statements: 0},
              started = performance.now();

        expect(typeof storage.loadNodeVicinitySync, 'the unit graph must be storage-backed for this arm to observe anything').toBe('function');
        expect(typeof sqlite?.prepare).toBe('function');

        storage.loadNodeVicinitySync = function(...args) {
            counts.vicinityLoads++;
            return Object.getPrototypeOf(storage).loadNodeVicinitySync.apply(this, args)
        };
        sqlite.prepare = function(...args) {
            counts.statements++;
            return Object.getPrototypeOf(sqlite).prepare.apply(this, args)
        };

        try {
            return {result: await callback(), ...counts, ms: Math.round(performance.now() - started)}
        } finally {
            delete storage.loadNodeVicinitySync;
            delete sqlite.prepare
        }
    }

    /**
     * @summary Records one observation on the report and the console, so a run at any fixture size
     * leaves its numbers behind.
     * @param {String} label
     * @param {Object} observed
     */
    function report(label, observed) {
        const line = `${label} (${SEEDED} seeded, limit ${LIMIT}): ${observed.vicinityLoads} vicinity loads, ${observed.statements} statements, ${observed.ms} ms; bound ${READ_BOUND}`;

        test.info().annotations.push({type: 'reads', description: line});
        console.log(`[list-messages-cost] ${line}`);
    }

    test.beforeAll(async () => {
        test.setTimeout(Math.max(60_000, SEEDED * 20));

        GraphService     = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService   = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        LifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }

        GraphService.upsertNode({id: SENDER,    type: 'AgentIdentity', name: 'List Cost Sender',    properties: {accountType: 'agent'}});
        GraphService.upsertNode({id: RECIPIENT, type: 'AgentIdentity', name: 'List Cost Recipient', properties: {accountType: 'agent'}});

        const started = performance.now();

        for (let i = 0; i < Math.max(SEEDED_DIRECT, SEEDED_BROADCAST); i++) {
            if (i < SEEDED_DIRECT) {
                await RequestContextService.run({agentIdentityNodeId: SENDER}, () => MailboxService.addMessage({
                    to     : RECIPIENT,
                    subject: `cost fixture direct ${String(i).padStart(5, '0')}`,
                    body   : 'one of many direct rows the page will not show'
                }));
            }
            if (i < SEEDED_BROADCAST) {
                await RequestContextService.run({agentIdentityNodeId: SENDER}, () => MailboxService.addMessage({
                    to     : 'AGENT:*',
                    subject: `cost fixture broadcast ${String(i).padStart(5, '0')}`,
                    body   : 'one of many broadcast rows the page will not show'
                }));
            }
        }

        console.log(`[list-messages-cost] seeded ${SEEDED} messages through addMessage in ${Math.round(performance.now() - started)} ms`);
    });

    test('a warm-cache page reads a bounded number of rows and statements, whatever the mailbox holds', async () => {
        // The first read warms the vicinity cache; the second is the steady state every cockpit
        // tick pays. Both are recorded, the bound is asserted on the steady state.
        const cold = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', limit: LIMIT}))),
              warm = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', limit: LIMIT})));

        expect(warm.result.messages).toHaveLength(LIMIT);
        expect(warm.result.totalCount, 'the count stays the count of the filter').toBe(SEEDED_DIRECT + SEEDED_BROADCAST);
        expect(warm.result.truncated).toBe(true);

        report('cold page', cold);
        report('warm page', warm);

        expect(warm.statements, `prepared statements for a page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND);
        expect(warm.vicinityLoads, `vicinity loads for a page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND)
    });

    test('an unread-only page is bounded the same way — the status filter must not reintroduce the walk', async () => {
        const page = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', status: 'unread', limit: LIMIT})));

        expect(page.result.messages).toHaveLength(LIMIT);
        expect(page.result.totalCount).toBe(SEEDED_DIRECT + SEEDED_BROADCAST);

        report('unread page', page);

        expect(page.statements, `prepared statements for an unread page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND)
    });

    test('the MCP adapter\'s page — `recordSeen: true` stamps the rows it serves — is bounded by the same page', async () => {
        // The tool is the caller the plane metric measures: its SEEN stamps are one write per served
        // row and must not cost more than the page either.
        const page = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', limit: LIMIT}, {recordSeen: true})));

        expect(page.result.messages).toHaveLength(LIMIT);
        expect(page.result.totalCount).toBe(SEEDED_DIRECT + SEEDED_BROADCAST);

        report('recordSeen page', page);

        expect(page.statements, `prepared statements for a recordSeen page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND);
        expect(page.vicinityLoads, `vicinity loads for a recordSeen page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND)
    });

    test('drives candidate selection from idx_edges_target and primary-key Nodes lookup without scanning idx_nodes_label (#1954)', async () => {
        const {buildMailboxMatchQuery} = await import('../../../../../../ai/services/memory-core/MailboxService.mjs'),
              sqlite                   = GraphService.db.storage.db;

        for (const view of [
            {box: 'all',    status: 'all',    target: RECIPIENT},
            {box: 'inbox',  status: 'unread', target: RECIPIENT},
            {box: 'outbox', status: 'all',    target: SENDER},
            {box: 'all',    status: 'unread', target: RECIPIENT, statusOnOutbox: false},
            {
                box                : 'all',
                status             : 'all',
                target             : RECIPIENT,
                fromIdentity       : SENDER,
                threadId           : 'MESSAGE:thread-1',
                taggedConceptGroups: [['lane-claim', 'lane_claim']]
            }
        ]) {
            const {matchesSql, params} = buildMailboxMatchQuery(view),
                  planRows             = sqlite.prepare(
                      `EXPLAIN QUERY PLAN ${matchesSql} SELECT messageId, COUNT(*) OVER () AS _totalCount FROM matches ORDER BY sentAt DESC, messageId DESC LIMIT 50 OFFSET 0`
                  ).all(params),
                  details              = planRows.map(row => row.detail);

            expect(details.some(d => d.includes('idx_nodes_label')), `idx_nodes_label scan in ${JSON.stringify(view)}: ${details.join(' | ')}`).toBe(false);
            expect(details.some(d => d.includes('SEARCH e USING INDEX idx_edges_target')), `idx_edges_target missing in ${JSON.stringify(view)}`).toBe(true);
            expect(details.some(d => d.includes('sqlite_autoindex_Nodes_1')), `Nodes PK lookup missing in ${JSON.stringify(view)}`).toBe(true);

            if (view.fromIdentity) {
                expect(details.some(d => d.startsWith('SEARCH sb ') && d.includes('USING INDEX idx_edges_source'))).toBe(true);
                expect(details.some(d => d.startsWith('SEARCH th ') && d.includes('USING INDEX idx_edges_source'))).toBe(true);
                expect(details.some(d => d.startsWith('SEARCH tc ') && d.includes('USING INDEX idx_edges_source'))).toBe(true);
            }
        }
    });

    test('preserves exact row order, counts, out-of-range offset totalCount, and legacy + cohort broadcast parity on box:all (#1954)', async () => {
        const sqlite    = GraphService.db.storage.db,
              PEER_A    = '@parity-peer-a',
              PEER_B    = '@parity-peer-b',
              BYSTANDER = '@parity-bystander';

        GraphService.upsertNode({id: PEER_A,    type: 'AgentIdentity', name: 'Parity Peer A',    properties: {accountType: 'agent'}});
        GraphService.upsertNode({id: PEER_B,    type: 'AgentIdentity', name: 'Parity Peer B',    properties: {accountType: 'agent'}});
        GraphService.upsertNode({id: BYSTANDER, type: 'AgentIdentity', name: 'Parity Bystander', properties: {accountType: 'agent'}});

        // 1. Direct message to PEER_A (unread)
        const directMsg = await RequestContextService.run({agentIdentityNodeId: PEER_B}, () => MailboxService.addMessage({
            to     : PEER_A,
            subject: 'parity direct unread',
            body   : 'direct body'
        }));

        // 2. Cohort broadcast delivered to PEER_A (unread for PEER_A)
        const cohortMsg = await RequestContextService.run({agentIdentityNodeId: PEER_B}, () => MailboxService.addMessage({
            to     : 'AGENT:*',
            subject: 'parity cohort broadcast',
            body   : 'cohort body'
        }));

        // 3. Outbox message sent by PEER_A to PEER_B, then marked read by PEER_B
        const outboxReadMsg = await RequestContextService.run({agentIdentityNodeId: PEER_A}, () => MailboxService.addMessage({
            to     : PEER_B,
            subject: 'parity outbox read by recipient',
            body   : 'outbox body'
        }));
        await RequestContextService.run({agentIdentityNodeId: PEER_B}, () => MailboxService.markRead({messageId: outboxReadMsg.messageId}));

        // 4. Legacy broadcast (SENT_TO AGENT:* with broadcastCohort: 'legacy-unknown' and zero DELIVERED_TO edges)
        const legacyId   = 'MESSAGE:parity-legacy-unknown-001',
              legacySent = '2099-01-01T00:00:00.000Z';
        sqlite.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(legacyId, JSON.stringify({
            id        : legacyId,
            label     : 'MESSAGE',
            properties: {subject: 'parity legacy broadcast', bodyText: 'legacy', priority: 'normal', sentAt: legacySent, readAt: null, archivedAt: null}
        }));
        sqlite.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)').run(
            `${legacyId}:sb`, legacyId, PEER_B, 'SENT_BY', JSON.stringify({id: `${legacyId}:sb`, source: legacyId, target: PEER_B, type: 'SENT_BY', properties: {}})
        );
        sqlite.prepare('INSERT INTO Edges (id, source, target, type, data) VALUES (?, ?, ?, ?, ?)').run(
            `${legacyId}:st`, legacyId, 'AGENT:*', 'SENT_TO', JSON.stringify({id: `${legacyId}:st`, source: legacyId, target: 'AGENT:*', type: 'SENT_TO', properties: {broadcastCohort: 'legacy-unknown'}})
        );

        // 5. Unrelated bystander direct message (must never leak into PEER_A's view)
        await RequestContextService.run({agentIdentityNodeId: PEER_B}, () => MailboxService.addMessage({
            to     : BYSTANDER,
            subject: 'bystander private',
            body   : 'hidden'
        }));

        const asPeerA = fn => RequestContextService.run({agentIdentityNodeId: PEER_A}, fn);

        // Single-statement readSnapshot (`COUNT(*) OVER ()` => <= 4 SQLite statements when limit=4, zero vicinity loads on warm second call)
        await asPeerA(() => MailboxService.listMessages({box: 'all', status: 'all', limit: 10}));
        const allObserved = await observeStorage(() => asPeerA(() => MailboxService.listMessages({box: 'all', status: 'all', limit: 2, offset: 0})));

        expect(allObserved.result.totalCount).toBe(4);
        expect(allObserved.result.truncated).toBe(true);
        expect(allObserved.result.nextOffset).toBe(2);
        expect(allObserved.result.messages.map(m => m.messageId)).toEqual([legacyId, outboxReadMsg.messageId]);

        const page2 = await asPeerA(() => MailboxService.listMessages({box: 'all', status: 'all', limit: 2, offset: 2}));
        expect(page2.totalCount).toBe(4);
        expect(page2.truncated).toBe(false);
        expect(page2.nextOffset).toBeNull();
        expect(page2.messages.map(m => m.messageId)).toEqual([cohortMsg.messageId, directMsg.messageId]);

        // Out-of-range offset (> totalCount) still returns exact totalCount via fallback COUNT(*)
        const pastEnd = await asPeerA(() => MailboxService.listMessages({box: 'all', status: 'all', limit: 10, offset: 50}));
        expect(pastEnd.messages).toEqual([]);
        expect(pastEnd.totalCount).toBe(4);
        expect(pastEnd.truncated).toBe(false);

        // status: 'unread' on listMessages applies to outbox too (`outboxReadMsg` excluded => 3 unread),
        // whereas countMessages({box: 'outbox', status: 'unread'}) sets statusOnOutbox: false (`outboxReadMsg` included => 1)
        const listUnread  = await asPeerA(() => MailboxService.listMessages({box: 'all', status: 'unread', limit: 10})),
              countOutbox = await asPeerA(() => MailboxService.countMessages({box: 'outbox', status: 'unread'})),
              countsProj  = await asPeerA(() => MailboxService.listMessages({box: 'inbox', status: 'unread', projection: 'counts'}));

        expect(listUnread.totalCount).toBe(3);
        expect(listUnread.messages.map(m => m.messageId)).toEqual([legacyId, cohortMsg.messageId, directMsg.messageId]);
        expect(countOutbox.count).toBe(1);
        expect(countsProj.unreadCount).toBe(3);
    });
});
