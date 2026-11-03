import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import fs             from 'fs/promises';
import {mkdtemp, rm}  from 'fs/promises';
import os             from 'os';
import path           from 'path';

import {
    appendMessageWalEmbedMarker,
    appendMessageWalGraphProjectionMarker,
    appendWalMessage,
    getMessageWalEmbedMarkersFileName,
    getMessageWalGraphProjectionStats,
    getMessageWalGraphMarkersFileName,
    getMessageWalRecordsFileName,
    getMessageWalSegmentKey,
    pruneReconciledMessageWalSegments,
    readMessageWalProvenanceSegments,
    readPendingMessageWalEmbedRecords,
    readPendingMessageWalRecords,
    readWalMessages,
    readWalMessagesByIds,
    toMessageEmbedRecord
} from '../../../../../../../ai/services/memory-core/helpers/messageWalStore.mjs';

/**
 * @summary Focused accepted-message WAL contract: immutable server plane provenance, honest legacy
 * projection, strict parity evidence, and unchanged graph-drain reconciliation.
 */
test.describe('Neo.ai.services.memory-core.helpers.messageWalStore', () => {
    let tmpDir;

    const DAY      = Date.UTC(2026, 6, 30, 12);
    const PLANE_ID = 'test-message-plane';
    const record   = id => ({
        id,
        timestamp             : DAY,
        graphProjectionVersion: 1,
        message               : {id, type: 'MESSAGE', name: id, properties: {subject: id}},
        routing               : {sentBy: '@alice', to: '@bob', senderUserId: 'alice', broadcastRecipients: []},
        optionalEdges         : {relatedTickets: [], relatedSessions: [], taggedConcepts: []}
    });

    test.beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(os.tmpdir(), 'neo-message-wal-store-'));
    });

    test.afterEach(async () => {
        await rm(tmpDir, {recursive: true, force: true});
    });

    test('derives UTC segment names for payload and graph receipt files', () => {
        expect(getMessageWalSegmentKey(DAY)).toBe('2026-07-30');
        expect(getMessageWalRecordsFileName('2026-07-30')).toBe('message-wal-2026-07-30.jsonl');
        expect(getMessageWalGraphMarkersFileName('2026-07-30')).toBe('message-wal-2026-07-30.graph.jsonl');
    });

    test('projection markers preserve monotonic route/cohort evidence and surface conflicts (#16767)', async () => {
        const segmentKey = getMessageWalSegmentKey(DAY);

        await appendWalMessage(record('MESSAGE:known-zero'), {dir: tmpDir, planeId: PLANE_ID});
        await appendWalMessage(record('MESSAGE:legacy'), {dir: tmpDir, planeId: PLANE_ID});
        await appendWalMessage(record('MESSAGE:conflict'), {dir: tmpDir, planeId: PLANE_ID});

        await appendMessageWalGraphProjectionMarker({id: 'MESSAGE:known-zero', segmentKey}, {dir: tmpDir});

        let stats = await getMessageWalGraphProjectionStats({dir: tmpDir});
        expect(stats.broadcastCohortById.has('MESSAGE:known-zero')).toBe(false);

        // One later marker enriches the historical projection receipt without changing its
        // unique projected-id count or accepted-WAL segment coordinate.
        await appendMessageWalGraphProjectionMarker({
            id             : 'MESSAGE:known-zero',
            segmentKey,
            mailboxRouting : {disposition: 'known', sentBy: '@alice', to: 'AGENT:*'},
            broadcastCohort: {disposition: 'known', intendedRecipientCount: 0}
        }, {dir: tmpDir});
        await appendMessageWalGraphProjectionMarker({
            id             : 'MESSAGE:legacy',
            segmentKey,
            mailboxRouting : {disposition: 'legacy-unknown'},
            broadcastCohort: {disposition: 'legacy-unknown'}
        }, {dir: tmpDir});
        await appendMessageWalGraphProjectionMarker({
            id             : 'MESSAGE:conflict',
            segmentKey,
            mailboxRouting : {disposition: 'known', sentBy: '@alice', to: 'AGENT:*'},
            broadcastCohort: {disposition: 'known', intendedRecipientCount: 2}
        }, {dir: tmpDir});
        await appendMessageWalGraphProjectionMarker({
            id             : 'MESSAGE:conflict',
            segmentKey,
            mailboxRouting : {disposition: 'legacy-unknown'},
            broadcastCohort: {disposition: 'legacy-unknown'}
        }, {dir: tmpDir});
        await appendMessageWalGraphProjectionMarker({
            id             : 'MESSAGE:conflict',
            segmentKey,
            mailboxRouting : {disposition: 'known', sentBy: '@mallory', to: 'AGENT:*'},
            broadcastCohort: {disposition: 'known', intendedRecipientCount: 0}
        }, {dir: tmpDir});

        stats = await getMessageWalGraphProjectionStats({dir: tmpDir});

        expect(stats.projectedCount).toBe(3);
        expect(stats.segmentById.get('MESSAGE:known-zero')).toBe(segmentKey);
        expect(stats.mailboxRoutingById.get('MESSAGE:known-zero')).toEqual({
            disposition: 'known', sentBy: '@alice', to: 'AGENT:*'
        });
        expect(stats.broadcastCohortById.get('MESSAGE:known-zero')).toEqual({
            disposition           : 'known',
            intendedRecipientCount: 0
        });
        expect(stats.mailboxRoutingById.get('MESSAGE:legacy')).toEqual({disposition: 'legacy-unknown'});
        expect(stats.broadcastCohortById.get('MESSAGE:legacy')).toEqual({disposition: 'legacy-unknown'});
        expect(stats.mailboxRoutingById.get('MESSAGE:conflict')).toEqual({
            disposition: 'known', sentBy: '@alice', to: 'AGENT:*'
        });
        expect(stats.broadcastCohortById.get('MESSAGE:conflict')).toEqual({
            disposition           : 'known',
            intendedRecipientCount: 2
        });
        expect([...stats.markerConflicts.mailboxRoutingIds]).toEqual(['MESSAGE:conflict']);
        expect([...stats.markerConflicts.broadcastCohortIds]).toEqual(['MESSAGE:conflict']);
    });

    test('a surviving marker keeps a missing payload segment in the projected candidate population (#16767)', async () => {
        const durable   = await appendWalMessage(record('MESSAGE:missing-payload'), {dir: tmpDir, planeId: PLANE_ID}),
            payloadPath = path.join(tmpDir, getMessageWalRecordsFileName(durable.segmentKey));

        await appendMessageWalGraphProjectionMarker({
            id            : 'MESSAGE:missing-payload',
            segmentKey    : durable.segmentKey,
            mailboxRouting: {disposition: 'known', sentBy: '@alice', to: '@bob'}
        }, {dir: tmpDir});

        expect((await getMessageWalGraphProjectionStats({dir: tmpDir})).projectedCount).toBe(1);

        await fs.rm(payloadPath);

        const stats = await getMessageWalGraphProjectionStats({dir: tmpDir});
        expect(stats.projectedCount).toBe(1);
        expect(stats.projectedIds.has('MESSAGE:missing-payload')).toBe(true);
        expect(stats.segmentById.get('MESSAGE:missing-payload')).toBe(durable.segmentKey);
        expect(stats.payloadSignatureBySegment.get(durable.segmentKey)).toBe('unavailable:ENOENT');
        expect(await readWalMessagesByIds({dir: tmpDir, ids: ['MESSAGE:missing-payload']})).toEqual([]);
    });

    test('server plane provenance overrides a caller spoof and survives every read path', async () => {
        const {filePath, segmentKey} = await appendWalMessage(
            {...record('MESSAGE:stamped'), planeId: 'caller-spoof'},
            {dir: tmpDir, planeId: PLANE_ID}
        );
        const durable = JSON.parse((await fs.readFile(filePath, 'utf8')).trim()),
              serving = await readWalMessages({dir: tmpDir}),
              pending = await readPendingMessageWalRecords({dir: tmpDir}),
              strict  = await readMessageWalProvenanceSegments({dir: tmpDir});

        expect(segmentKey).toBe('2026-07-30');
        expect(durable.planeId).toBe(PLANE_ID);
        expect(serving[0].planeId).toBe(PLANE_ID);
        expect(pending[0].planeId).toBe(PLANE_ID);
        expect(strict.ok).toBe(true);
        expect(strict.segments[0].records[0].planeId).toBe(PLANE_ID);

        await appendMessageWalGraphProjectionMarker(
            {id: durable.id, segmentKey},
            {dir: tmpDir}
        );
        expect((await readWalMessagesByIds({dir: tmpDir, ids: [durable.id]}))[0].planeId).toBe(PLANE_ID);
    });

    test('missing, reserved, or path-shaped resolved plane identities reject before append', async () => {
        await expect(appendWalMessage(record('MESSAGE:missing'), {dir: tmpDir}))
            .rejects.toThrow('planeId must be an opaque resolved plane identity');
        await expect(appendWalMessage(record('MESSAGE:unknown'), {dir: tmpDir, planeId: 'unknown'}))
            .rejects.toThrow('planeId must be an opaque resolved plane identity');
        await expect(appendWalMessage(record('MESSAGE:path'), {dir: tmpDir, planeId: '../overlay'}))
            .rejects.toThrow('planeId must be an opaque resolved plane identity');
        expect(await fs.readdir(tmpDir)).toEqual([]);
    });

    test('legacy rows remain readable and drainable as unknown without rewriting durable history', async () => {
        const segmentKey = getMessageWalSegmentKey(DAY),
              filePath   = path.join(tmpDir, getMessageWalRecordsFileName(segmentKey)),
              legacy     = {...record('MESSAGE:legacy'), segmentKey};

        await fs.writeFile(filePath, `${JSON.stringify(legacy)}\n`, 'utf8');

        const serving = await readWalMessages({dir: tmpDir}),
              pending = await readPendingMessageWalRecords({dir: tmpDir}),
              durable = JSON.parse((await fs.readFile(filePath, 'utf8')).trim());

        expect(serving[0].planeId).toBe('unknown');
        expect(pending[0].planeId).toBe('unknown');
        expect(durable).not.toHaveProperty('planeId');

        await appendMessageWalGraphProjectionMarker(
            {id: legacy.id, segmentKey},
            {dir: tmpDir}
        );
        expect(await readPendingMessageWalRecords({dir: tmpDir})).toEqual([]);
    });

    test('strict evidence refuses a torn row while operational serving keeps valid records available', async () => {
        const {filePath} = await appendWalMessage(record('MESSAGE:valid'), {
            dir    : tmpDir,
            planeId: PLANE_ID
        });

        await fs.appendFile(filePath, '{"id":"MESSAGE:torn"', 'utf8');

        expect((await readWalMessages({dir: tmpDir})).map(item => item.id)).toEqual(['MESSAGE:valid']);

        const strict = await readMessageWalProvenanceSegments({dir: tmpDir});

        expect(strict.ok).toBe(false);
        expect(strict.reason).toContain('line 2 is not valid JSON');
    });

    test('readPendingMessageWalRecords skips re-reading unchanged reconciled segments and invalidates on file change (#1196)', async () => {
        const {segmentKey} = await appendWalMessage(record('MESSAGE:reconciled-1'), {
            dir    : tmpDir,
            planeId: PLANE_ID
        });
        await appendMessageWalGraphProjectionMarker({id: 'MESSAGE:reconciled-1', segmentKey}, {dir: tmpDir});

        expect(await readPendingMessageWalRecords({dir: tmpDir})).toEqual([]);

        const originalReadFile = fs.readFile;
        let   readCount        = 0;

        fs.readFile = async (filePath, ...args) => {
            if (String(filePath).startsWith(tmpDir)) readCount++;
            return originalReadFile(filePath, ...args);
        };

        try {
            expect(await readPendingMessageWalRecords({dir: tmpDir})).toEqual([]);
            expect(readCount).toBe(0);

            const recordsPath = path.join(tmpDir, getMessageWalRecordsFileName(segmentKey));
            await fs.appendFile(
                recordsPath,
                `${JSON.stringify({...record('MESSAGE:pending-2'), segmentKey, planeId: PLANE_ID})}\n`,
                'utf8'
            );

            const pending = await readPendingMessageWalRecords({dir: tmpDir});
            expect(pending.map(item => item.id)).toEqual(['MESSAGE:pending-2']);
            expect(readCount).toBeGreaterThan(0);

            await appendMessageWalGraphProjectionMarker({id: 'MESSAGE:pending-2', segmentKey}, {dir: tmpDir});
            expect(await readPendingMessageWalRecords({dir: tmpDir})).toEqual([]);

            readCount = 0;
            expect(await readPendingMessageWalRecords({dir: tmpDir})).toEqual([]);
            expect(readCount).toBe(0);
        } finally {
            fs.readFile = originalReadFile;
        }
    });

    test('pruneReconciledMessageWalSegments and appendWalMessage retentionLimit prune reconciled historical segments detached off the append return path (#1196)', async () => {
        const day0 = Date.UTC(2026, 6, 27, 12); // 2026-07-27 (pending — never pruned)
        const day1 = Date.UTC(2026, 6, 28, 12); // 2026-07-28 (reconciled oldest — pruned)
        const day2 = Date.UTC(2026, 6, 29, 12); // 2026-07-29 (reconciled within bound — kept)
        const day3 = Date.UTC(2026, 6, 30, 12); // 2026-07-30 (active — kept)

        await appendWalMessage({...record('MESSAGE:pending-0'), timestamp: day0}, {
            dir    : tmpDir,
            planeId: PLANE_ID,
            now    : day0
        });

        for (const [id, ms] of [['MESSAGE:done-1', day1], ['MESSAGE:done-2', day2]]) {
            const {segmentKey} = await appendWalMessage({...record(id), timestamp: ms}, {
                dir    : tmpDir,
                planeId: PLANE_ID,
                now    : ms
            });
            await appendMessageWalGraphProjectionMarker({id, segmentKey}, {dir: tmpDir});
            await appendMessageWalEmbedMarker({id, segmentKey}, {dir: tmpDir});
        }

        const originalReadFile = fs.readFile;
        let   releasePruneReadGate;
        const pruneReadGate = new Promise(resolve => {
            releasePruneReadGate = resolve;
        });
        let pruneReadsCompleted = false;

        fs.readFile = async (filePath, ...args) => {
            if (String(filePath).startsWith(tmpDir) && !String(filePath).endsWith('.lock')) {
                await pruneReadGate;
                pruneReadsCompleted = true;
            }
            return originalReadFile(filePath, ...args);
        };

        try {
            // Appending to the active segment with retentionLimit=1 resolves BEFORE detached prune segment reads complete.
            await appendWalMessage({...record('MESSAGE:active-3'), timestamp: day3}, {
                dir           : tmpDir,
                planeId       : PLANE_ID,
                now           : day3,
                retentionLimit: 1
            });

            expect(pruneReadsCompleted).toBe(false);
            releasePruneReadGate();

            await expect.poll(async () => {
                const currentNames = await fs.readdir(tmpDir);
                return !currentNames.includes('message-wal-2026-07-28.jsonl') &&
                    !currentNames.includes('message-wal-2026-07-28.graph.jsonl');
            }).toBe(true);
        } finally {
            releasePruneReadGate();
            fs.readFile = originalReadFile;
        }

        const names = await fs.readdir(tmpDir);
        expect(names).toContain('message-wal-2026-07-30.jsonl');
        expect(names).toContain('message-wal-2026-07-29.jsonl');
        expect(names).not.toContain('message-wal-2026-07-28.jsonl');
        expect(names).not.toContain('message-wal-2026-07-28.graph.jsonl');
        expect(names).not.toContain('message-wal-2026-07-28.embedded.jsonl');
        expect(names).toContain('message-wal-2026-07-27.jsonl');

        expect(await pruneReconciledMessageWalSegments({dir: tmpDir, retentionLimit: 0})).toBe(0);
        expect(await pruneReconciledMessageWalSegments({dir: path.join(tmpDir, 'missing'), retentionLimit: 5})).toBe(0);
    });

    test('a projected segment is retained until every record is embedded or retracted (#1439)', async () => {
        const days = [Date.UTC(2026, 6, 27, 12), Date.UTC(2026, 6, 28, 12), Date.UTC(2026, 6, 29, 12)];

        for (const [index, ms] of days.entries()) {
            const id           = `MESSAGE:day-${index}`,
                  {segmentKey} = await appendWalMessage({...record(id), timestamp: ms}, {dir: tmpDir, planeId: PLANE_ID, now: ms});

            await appendMessageWalGraphProjectionMarker({id, segmentKey}, {dir: tmpDir});
        }

        // Projected, never embedded: the embed drain still needs every one of them.
        expect(await pruneReconciledMessageWalSegments({dir: tmpDir, retentionLimit: 1, activeSegmentKey: '2026-07-30'})).toBe(0);

        await appendMessageWalEmbedMarker({id: 'MESSAGE:day-0', segmentKey: '2026-07-27', retracted: true}, {dir: tmpDir});
        await appendMessageWalEmbedMarker({id: 'MESSAGE:day-1', segmentKey: '2026-07-28'}, {dir: tmpDir});

        // Day 0 (retracted) and day 1 (embedded) now reconcile; day 2 is still pending. Retaining one
        // reconciled segment removes only the oldest, day 0.
        expect(await pruneReconciledMessageWalSegments({dir: tmpDir, retentionLimit: 1, activeSegmentKey: '2026-07-30'})).toBe(1);

        const names = await fs.readdir(tmpDir);
        expect(names).not.toContain('message-wal-2026-07-27.jsonl');
        expect(names).not.toContain(getMessageWalEmbedMarkersFileName('2026-07-27'));
        expect(names).toContain('message-wal-2026-07-28.jsonl');
        expect(names).toContain('message-wal-2026-07-29.jsonl');
    });

    test('toMessageEmbedRecord maps send-time routing into the metadata admission filters on (#1439)', () => {
        const message = (id, routing, properties = {}) => ({
            ...record(id),
            timestamp: DAY,
            message  : {id, type: 'MESSAGE', name: id, properties: {subject: `${id} subject`, bodyText: `${id} body`, ...properties}},
            routing  : {sentBy: '@alice', senderUserId: 'alice', ...routing}
        });

        const direct = toMessageEmbedRecord(message('MESSAGE:direct', {to: '@bob', broadcastRecipients: []}, {partOfThread: 'THREAD:1'}), '2026-07-30');
        expect(direct).toEqual({
            id        : 'MESSAGE:direct',
            segmentKey: '2026-07-30',
            document  : 'MESSAGE:direct subject\n\nMESSAGE:direct body',
            metadata  : {from: '@alice', to: '@bob', kind: 'direct', sentAt: DAY, threadId: 'THREAD:1'}
        });

        const known = toMessageEmbedRecord(message('MESSAGE:known', {to: 'AGENT:*', broadcastRecipients: ['@bob', '@carol']}), '2026-07-30');
        expect(known.metadata).toEqual({from: '@alice', to: 'AGENT:*', kind: 'broadcast', sentAt: DAY, cohort: 'known', recipientCount: 2, recipients: ['@bob', '@carol']});

        // A known audience of zero is counted, not listed: the count is what admits it to everyone.
        const knownZero = toMessageEmbedRecord(message('MESSAGE:zero', {to: 'AGENT:*', broadcastRecipients: []}), '2026-07-30');
        expect(knownZero.metadata).toMatchObject({cohort: 'known', recipientCount: 0});
        expect(knownZero.metadata).not.toHaveProperty('recipients');

        // A row older than the audience snapshot is legacy, never given guessed readers or a count.
        const legacy = toMessageEmbedRecord(message('MESSAGE:legacy', {to: 'AGENT:*', broadcastRecipients: undefined}), '2026-07-30');
        expect(legacy.metadata.cohort).toBe('legacy-unknown');
        expect(legacy.metadata).not.toHaveProperty('recipients');
        expect(legacy.metadata).not.toHaveProperty('recipientCount');
    });

    test('toMessageEmbedRecord stores identities canonical, so admission compares one spelling (#1445)', () => {
        const record = (id, routing) => toMessageEmbedRecord({
            id,
            timestamp: DAY,
            message  : {id, type: 'MESSAGE', name: id, properties: {subject: 's', bodyText: 'b'}},
            routing
        }, '2026-07-30').metadata;

        expect(record('MESSAGE:direct', {sentBy: 'AGENT:@alice', to: 'bob'})).toMatchObject({from: '@alice', to: '@bob'});
        expect(record('MESSAGE:broadcast', {sentBy: '@@alice', to: 'AGENT:*', broadcastRecipients: ['AGENT:bob', '@@carol']}))
            .toMatchObject({from: '@alice', to: 'AGENT:*', recipients: ['@bob', '@carol']});
    });

    test('readPendingMessageWalEmbedRecords returns unmarked records in drain shape and skips embedded and retracted ones (#1439)', async () => {
        for (const id of ['MESSAGE:pending', 'MESSAGE:embedded', 'MESSAGE:retracted']) {
            await appendWalMessage({...record(id), timestamp: DAY}, {dir: tmpDir, planeId: PLANE_ID, now: DAY});
        }

        const segmentKey = getMessageWalSegmentKey(DAY);

        await appendMessageWalEmbedMarker({id: 'MESSAGE:embedded', segmentKey}, {dir: tmpDir});
        await appendMessageWalEmbedMarker({id: 'MESSAGE:retracted', segmentKey, retracted: true}, {dir: tmpDir});

        const pending = await readPendingMessageWalEmbedRecords({dir: tmpDir});
        expect(pending.map(entry => entry.id)).toEqual(['MESSAGE:pending']);
        expect(pending[0]).toMatchObject({segmentKey, document: 'MESSAGE:pending', metadata: {from: '@alice', to: '@bob', kind: 'direct'}});

        // The reconciled-segment cache must not hide a record appended after a clean read.
        await appendMessageWalEmbedMarker({id: 'MESSAGE:pending', segmentKey}, {dir: tmpDir});
        expect(await readPendingMessageWalEmbedRecords({dir: tmpDir})).toEqual([]);
        await appendWalMessage({...record('MESSAGE:late'), timestamp: DAY}, {dir: tmpDir, planeId: PLANE_ID, now: DAY});
        expect((await readPendingMessageWalEmbedRecords({dir: tmpDir})).map(entry => entry.id)).toEqual(['MESSAGE:late']);

        expect(await readPendingMessageWalEmbedRecords({dir: tmpDir, ids: ['MESSAGE:embedded']})).toEqual([]);
    });
});
