import {test, expect} from '@playwright/test';
import Database       from 'better-sqlite3';
import {
    buildSummaryTrigger,
    buildFocusItemsDefect,
    parseFocusItemsReceipt,
    hasDrainableMemorySummaryBackfill,
    getPendingSummarizationJobs,
    getPendingSessionSummaryCount,
    getDueTask
} from '../../../../../../../ai/daemons/orchestrator/scheduling/summary.mjs';
import {foldDefectObservations, parseDefectNote} from '../../../../../../../ai/services/memory-core/helpers/defectObservationFold.mjs';
import {getUnreadSunsetHandovers}                from '../../../../../../../ai/daemons/wake/queries.mjs';

test.describe('orchestrator/scheduling/summary (#11864 / Epic #11831)', () => {
    test('buildSummaryTrigger prioritizes unread sunset handovers over the periodic sweep', () => {
        expect(buildSummaryTrigger({
            now       : 1200000,
            lastRunAt : 0,
            intervalMs: 600000,
            handovers : [{id: 'MESSAGE:1'}, {id: 'MESSAGE:2'}]
        })).toEqual({
            taskName     : 'summary',
            source       : 'sunset-handover',
            reason       : 'sunset-handover:2',
            handoverCount: 2
        });
    });

    test('#12199: buildSummaryTrigger prioritizes pending summarization markers before the periodic sweep', () => {
        expect(buildSummaryTrigger({
            now        : 600000,
            lastRunAt  : 0,
            intervalMs : 600000,
            handovers  : [],
            pendingJobs: ['session-1', 'session-2']
        })).toEqual({
            taskName    : 'summary',
            source      : 'pending-summarization',
            reason      : 'pending-summarization:2',
            pendingCount: 2
        });
    });

    test('#12199: sunset handovers stay higher priority than pending summarization markers', () => {
        expect(buildSummaryTrigger({
            now        : 600000,
            lastRunAt  : 0,
            intervalMs : 600000,
            handovers  : [{id: 'MESSAGE:1'}],
            pendingJobs: ['session-1']
        })).toEqual({
            taskName     : 'summary',
            source       : 'sunset-handover',
            reason       : 'sunset-handover:1',
            handoverCount: 1
        });
    });

    test('buildSummaryTrigger returns a periodic sweep trigger only when the interval is due', () => {
        expect(buildSummaryTrigger({now: 599999, lastRunAt: 0, intervalMs: 600000, handovers: []})).toBeNull();

        expect(buildSummaryTrigger({now: 600000, lastRunAt: 0, intervalMs: 600000, handovers: []})).toEqual({
            taskName: 'summary',
            source  : 'periodic-sweep',
            reason  : 'periodic-sweep:600000'
        });
    });

    test('buildSummaryTrigger does not schedule disabled periodic sweeps', () => {
        expect(buildSummaryTrigger({now: 600000, lastRunAt: 0, intervalMs: 0, handovers: []})).toBeNull();
    });

    test('getDueTask returns null when no handovers and interval not elapsed', () => {
        const result = getDueTask({
            db                        : 'mock-db',
            state                     : {summary: {lastRunAt: 0}},
            now                       : 100,
            summarySweepIntervalMs    : 600000,
            getUnreadSunsetHandoversFn: () => []
        });
        expect(result).toBeNull();
    });

    test('getDueTask returns periodic-sweep trigger (no onSuccess) when interval elapsed', () => {
        const result = getDueTask({
            db                        : 'mock-db',
            state                     : {summary: {lastRunAt: 0}},
            now                       : 600000,
            summarySweepIntervalMs    : 600000,
            getUnreadSunsetHandoversFn: () => []
        });
        expect(result).toEqual({
            taskName: 'summary',
            source  : 'periodic-sweep',
            reason  : 'periodic-sweep:600000'
        });
        expect(result.onSuccess).toBeUndefined();
    });

    test('#12199: getDueTask reads pending markers when no handover is waiting', () => {
        const result = getDueTask({
            db                           : 'mock-db',
            state                        : {summary: {lastRunAt: 0}},
            now                          : 100,
            summarySweepIntervalMs       : 600000,
            getUnreadSunsetHandoversFn   : () => [],
            getPendingSummarizationJobsFn: () => ['session-1']
        });

        expect(result).toEqual({
            taskName    : 'summary',
            source      : 'pending-summarization',
            reason      : 'pending-summarization:1',
            pendingCount: 1
        });
    });

    test('getDueTask records valid sunset receipts before completing each handover', async () => {
        const markCalls = [];
        const receipts  = [];
        const handovers = [{id: 'MESSAGE:1', properties: {subject: 'focus items: 2, 2 placed'}},
            {id: 'MESSAGE:2', properties: {subject: 'focus items: 0, 0 placed'}}];
        const result = getDueTask({
            db                                   : 'mock-db',
            state                                : {summary: {lastRunAt: 0}},
            now                                  : 100,
            summarySweepIntervalMs               : 600000,
            getUnreadSunsetHandoversFn           : () => handovers,
            markSunsetHandoversSummaryProcessedFn: (db, nodes) => markCalls.push({db, nodes}),
            writeSunsetFocusItemsReceiptFn       : (db, id, receipt) => receipts.push({id, receipt}),
            publishFocusItemsDefect              : () => {throw new Error('valid receipt must not publish')},
            log                                  : () => {}
        });
        expect(result.source).toBe('sunset-handover');
        expect(result.handoverCount).toBe(2);
        expect(typeof result.onSuccess).toBe('function');

        await result.onSuccess();
        expect(markCalls).toEqual(handovers.map(node => ({db: 'mock-db', nodes: [node]})));
        expect(receipts).toEqual([{id: 'MESSAGE:1', receipt: {named: 2, placed: 2}},
            {id: 'MESSAGE:2', receipt: {named: 0, placed: 0}}]);
    });

    test('focus receipt parser retains short counts and rejects malformed or unsafe counts', () => {
        expect(parseFocusItemsReceipt('[sunset] focus items: 3, 2 placed')).toEqual({named: 3, placed: 2});
        expect(parseFocusItemsReceipt('focus items: 0, 0 placed')).toEqual({named: 0, placed: 0});
        for (const subject of [undefined, '', 'focus items: -1, 0 placed', 'focus items: 1.5, 1 placed',
            'focus items: 1, 2 placed', 'focus items: 9007199254740992, 0 placed', 'focus items: 2, x placed']) {
            expect(parseFocusItemsReceipt(subject), String(subject)).toBeNull();
        }
    });

    test('defects use the real fold grammar and a stable sender/symptom identity without private content', () => {
        const handover = {id: 'MESSAGE:one', properties: {from: '@peer', bodyText: 'private operator details'}},
              missing  = buildFocusItemsDefect(handover, null),
              short    = buildFocusItemsDefect(handover, {named: 3, placed: 2}),
              again    = buildFocusItemsDefect({...handover, id: 'MESSAGE:two'}, {named: 4, placed: 1}),
              now      = Date.now(),
              folded   = foldDefectObservations([missing, short, again].map(note => ({...note, sentAt: new Date(now).toISOString()})), {now});

        expect(parseDefectNote(missing.subject)).toMatchObject({parseable: true, surface: 'sunset handover from @peer'});
        expect(parseDefectNote(short.subject).parseable).toBe(true);
        expect(folded).toHaveLength(2);
        expect(folded.find(row => row.symptom.includes('unplaced')).count).toBe(2);
        expect(JSON.stringify([missing, short, again])).not.toContain('private operator details');
        expect(short.body).toContain('names 3, places 2');
        expect(buildFocusItemsDefect({...handover, properties: {bodyText: '- not placed: deployment — needs operator'}}, {named: 3, placed: 2})).toBeNull();
        expect(buildFocusItemsDefect({...handover, properties: {bodyText: 'not placed:   '}}, {named: 3, placed: 2})).not.toBeNull();
    });

    test('a rejected publication leaves receipt admission pending and the next attempt completes it', async () => {
        const publication = Promise.withResolvers(), writes = [], marked = [],
              handovers   = [{id: 'MESSAGE:pending', properties: {from: '@peer', subject: '[sunset]'}}];
        let   attempts = 0;
        const trigger  = getDueTask({
            db                                   : {}, state: {summary: {}}, now: 100, summarySweepIntervalMs: 1000,
            getUnreadSunsetHandoversFn           : () => handovers,
            writeSunsetFocusItemsReceiptFn       : (db, id, receipt) => writes.push({id, receipt}),
            markSunsetHandoversSummaryProcessedFn: (db, nodes) => marked.push(nodes),
            publishFocusItemsDefect              : () => ++attempts === 1 ? publication.promise : Promise.resolve()
        });
        const completing = trigger.onSuccess();
        expect(writes).toEqual([{id: 'MESSAGE:pending', receipt: 'missing'}]);
        expect(marked).toEqual([]);
        publication.reject(new Error('mailbox unavailable'));
        await expect(completing).rejects.toThrow('mailbox unavailable');
        expect(marked).toEqual([]);
        await trigger.onSuccess();
        expect(marked).toEqual([handovers]);
        expect(attempts).toBe(2);
    });

    test('an aborted completion cannot mark a handover processed after a late mailbox response', async () => {
        const publication = Promise.withResolvers(), controller = new AbortController(), marked = [],
              trigger     = getDueTask({
                  db                        : {}, state: {summary: {}}, now: 100, summarySweepIntervalMs: 1000,
                  getUnreadSunsetHandoversFn: () => [{id: 'MESSAGE:late', properties: {subject: '[sunset]'}}],
                  writeSunsetFocusItemsReceiptFn() {},
                  markSunsetHandoversSummaryProcessedFn: (db, nodes) => marked.push(nodes),
                  publishFocusItemsDefect              : () => publication.promise
              }),
              completing = trigger.onSuccess({signal: controller.signal});

        controller.abort(new Error('completion expired'));
        publication.resolve();
        await expect(completing).rejects.toThrow('completion expired');
        expect(marked).toEqual([]);
    });

    test('a failed first publication keeps a later read handover admitted for retry', async () => {
        const db = new Database(':memory:');

        try {
            db.exec('CREATE TABLE Nodes (id TEXT PRIMARY KEY, data TEXT)');
            for (const id of ['MESSAGE:A', 'MESSAGE:B']) {
                db.prepare('INSERT INTO Nodes (id, data) VALUES (?, ?)').run(id, JSON.stringify({
                    id, type: 'MESSAGE', properties: {
                        subject: '[sunset]', taggedConcepts: ['sunset-protocol-handover']
                    }
                }));
            }

            const options = {db, state: {summary: {}}, now: 100, summarySweepIntervalMs: 1000},
                  trigger = getDueTask({...options, publishFocusItemsDefect: async () => {
                      throw new Error('first publication rejected')
                  }});

            await expect(trigger.onSuccess()).rejects.toThrow('first publication rejected');
            db.prepare("UPDATE Nodes SET data = json_set(data, '$.properties.readAt', ?) WHERE id = ?")
                .run('2026-11-06T07:00:00Z', 'MESSAGE:B');

            const pending = getUnreadSunsetHandovers(db);

            expect(pending.map(node => node.id).sort()).toEqual(['MESSAGE:A', 'MESSAGE:B']);
            expect(pending.every(node => node.properties.focusItemsReceipt === 'missing')).toBe(true);
            expect(pending.every(node => !node.properties.handoverSummaryProcessedAt)).toBe(true);

            const published = [];
            await getDueTask({...options, publishFocusItemsDefect: async note => published.push(note)}).onSuccess();

            expect(published).toHaveLength(2);
            expect(getUnreadSunsetHandovers(db)).toEqual([]);
            expect(JSON.parse(db.prepare('SELECT data FROM Nodes WHERE id = ?').get('MESSAGE:B').data)
                .properties.readAt).toBe('2026-11-06T07:00:00Z');
        } finally {
            db.close()
        }
    });

    test('#12199: getPendingSummarizationJobs reads pending session ids only', () => {
        const calls = [];
        const db    = {
            prepare: (sql) => {
                calls.push(sql);
                return {
                    all: (limit) => {
                        calls.push(limit);
                        return [{session_id: 'session-1'}, {session_id: 'session-2'}, {session_id: null}];
                    }
                };
            }
        };

        expect(getPendingSummarizationJobs(db, {limit: 2})).toEqual(['session-1', 'session-2']);
        expect(calls[0]).toContain("WHERE status = 'pending'");
        expect(calls[1]).toBe(2);
    });

    test('#12809: buildSummaryTrigger reports the TRUE backlog depth, not the fetch limit', () => {
        const fetched = Array.from({length: 50}, (_, i) => `session-${i}`);
        expect(buildSummaryTrigger({
            now        : 600000, lastRunAt: 0, intervalMs: 600000, handovers: [],
            pendingJobs: fetched, totalPending: 730
        })).toEqual({
            taskName    : 'summary',
            source      : 'pending-summarization',
            reason      : 'pending-summarization:730',
            pendingCount: 50
        });
    });

    test('#12809: getDueTask threads the uncapped pending count into the reason', () => {
        const result = getDueTask({
            db                            : 'mock-db',
            state                         : {summary: {lastRunAt: 0}},
            now                           : 100,
            summarySweepIntervalMs        : 600000,
            getUnreadSunsetHandoversFn    : () => [],
            getPendingSummarizationJobsFn : () => ['session-1', 'session-2'],
            getPendingSummarizationCountFn: () => 730
        });
        expect(result).toMatchObject({
            reason      : 'pending-summarization:730',
            pendingCount: 2
        });
    });

    test('#12821/#13590: buildSummaryTrigger appends the graph-backed session-summary count to the periodic-sweep reason', () => {
        expect(buildSummaryTrigger({now: 600000, lastRunAt: 0, intervalMs: 600000, handovers: [], unsummarizedCount: 42})).toEqual({
            taskName: 'summary',
            source  : 'periodic-sweep',
            reason  : 'periodic-sweep:600000 graph-pending-session-summary:42'
        });
    });

    test('#12821: periodic-sweep reason omits the count when not provided (backward-compatible)', () => {
        expect(buildSummaryTrigger({now: 600000, lastRunAt: 0, intervalMs: 600000, handovers: []})).toEqual({
            taskName: 'summary',
            source  : 'periodic-sweep',
            reason  : 'periodic-sweep:600000'
        });
    });

    test('#12821/#13590: getDueTask threads the graph-backed session-summary backlog count into the periodic-sweep reason', () => {
        const result = getDueTask({
            db                             : 'mock-db',
            state                          : {summary: {lastRunAt: 0}},
            now                            : 600000,
            summarySweepIntervalMs         : 600000,
            getUnreadSunsetHandoversFn     : () => [],
            getPendingSummarizationJobsFn  : () => [],
            getPendingSessionSummaryCountFn: () => 42
        });
        expect(result).toMatchObject({
            source: 'periodic-sweep',
            reason: 'periodic-sweep:600000 graph-pending-session-summary:42'
        });
    });

    test('#13590: periodic drift sweep yields while miniSummary backfill has drainable work', () => {
        const result = getDueTask({
            db   : 'mock-db',
            state: {
                summary                  : {lastRunAt: 0},
                'memory-summary-backfill': {}
            },
            now                                   : 600000,
            summarySweepIntervalMs                : 600000,
            getUnreadSunsetHandoversFn            : () => [],
            getPendingSummarizationJobsFn         : () => [],
            getPendingMemorySummaryBackfillJobsFn : () => ['memory-1'],
            isMemorySummaryBackfillBackoffActiveFn: () => false,
            getPendingSessionSummaryCountFn       : () => 42
        });

        expect(result).toBeNull();
    });

    test('#13590: periodic drift sweep proceeds when miniSummary backfill is in no-progress backoff', () => {
        const result = getDueTask({
            db   : 'mock-db',
            state: {
                summary                  : {lastRunAt: 0},
                'memory-summary-backfill': {noProgressBackoffUntilMs: 700000}
            },
            now                                   : 600000,
            summarySweepIntervalMs                : 600000,
            getUnreadSunsetHandoversFn            : () => [],
            getPendingSummarizationJobsFn         : () => [],
            getPendingMemorySummaryBackfillJobsFn : () => ['memory-1'],
            isMemorySummaryBackfillBackoffActiveFn: () => true,
            getPendingSessionSummaryCountFn       : () => 42
        });

        expect(result).toMatchObject({
            source: 'periodic-sweep',
            reason: 'periodic-sweep:600000 graph-pending-session-summary:42'
        });
    });

    test('#13590: sunset handovers are not blocked by miniSummary backfill', () => {
        const result = getDueTask({
            db                                    : 'mock-db',
            state                                 : {summary: {lastRunAt: 0}},
            now                                   : 600000,
            summarySweepIntervalMs                : 600000,
            getUnreadSunsetHandoversFn            : () => [{id: 'MESSAGE:1'}],
            getPendingMemorySummaryBackfillJobsFn : () => ['memory-1'],
            isMemorySummaryBackfillBackoffActiveFn: () => false,
            markNodesAsReadFn                     : () => {}
        });

        expect(result).toMatchObject({
            source       : 'sunset-handover',
            reason       : 'sunset-handover:1',
            handoverCount: 1
        });
    });

    test('#13590: explicit pending summarization markers are not blocked by miniSummary backfill', () => {
        const result = getDueTask({
            db                                    : 'mock-db',
            state                                 : {summary: {lastRunAt: 0}},
            now                                   : 600000,
            summarySweepIntervalMs                : 600000,
            getUnreadSunsetHandoversFn            : () => [],
            getPendingSummarizationJobsFn         : () => ['session-1'],
            getPendingSummarizationCountFn        : () => 1,
            getPendingMemorySummaryBackfillJobsFn : () => ['memory-1'],
            isMemorySummaryBackfillBackoffActiveFn: () => false
        });

        expect(result).toMatchObject({
            source      : 'pending-summarization',
            reason      : 'pending-summarization:1',
            pendingCount: 1
        });
    });

    test('#13590: hasDrainableMemorySummaryBackfill reflects pending work minus no-progress backoff', () => {
        expect(hasDrainableMemorySummaryBackfill({
            db                                    : 'mock-db',
            state                                 : {},
            now                                   : 600000,
            getPendingMemorySummaryBackfillJobsFn : () => [],
            isMemorySummaryBackfillBackoffActiveFn: () => false
        })).toBe(false);

        expect(hasDrainableMemorySummaryBackfill({
            db                                    : 'mock-db',
            state                                 : {'memory-summary-backfill': {}},
            now                                   : 600000,
            getPendingMemorySummaryBackfillJobsFn : () => ['memory-1'],
            isMemorySummaryBackfillBackoffActiveFn: () => false
        })).toBe(true);

        expect(hasDrainableMemorySummaryBackfill({
            db                                    : 'mock-db',
            state                                 : {'memory-summary-backfill': {noProgressBackoffUntilMs: 700000}},
            now                                   : 600000,
            getPendingMemorySummaryBackfillJobsFn : () => ['memory-1'],
            isMemorySummaryBackfillBackoffActiveFn: () => true
        })).toBe(false);
    });

    test('#12821: getPendingSessionSummaryCount is fail-soft when the graph table is unavailable', () => {
        const db = {prepare() { throw new Error('no graph table'); }};
        expect(getPendingSessionSummaryCount(db)).toBeNull();
        expect(getPendingSessionSummaryCount(null)).toBeNull();
    });
});
