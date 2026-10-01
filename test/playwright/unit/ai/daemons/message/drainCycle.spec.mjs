import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {mkdtemp, rm}  from 'fs/promises';
import os             from 'os';
import path           from 'path';

import {appendWalMessage} from '../../../../../../ai/services/memory-core/helpers/messageWalStore.mjs';
import {
    createMessageGraphIntegrityRepairCadence,
    createMessageGraphProjectionProcessor,
    drainMessageWalOnce,
    getMessageDrainBackoffDelayMs,
    processMessageBatch,
    startMessageDrainLoop
} from '../../../../../../ai/daemons/message/drainCycle.mjs';

/**
 * Message WAL drain topology — host-agnostic cycle coverage. The replay processor is deliberately
 * injected because idempotent mailbox graph projection is a separate concern.
 */
test.describe('Neo.ai.daemons.message.drainCycle', () => {
    let tmpDir;

    test.beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(os.tmpdir(), 'neo-message-drain-'));
    });

    test.afterEach(async () => {
        await rm(tmpDir, {recursive: true, force: true});
    });

    const record = id => ({
        id,
        timestamp             : Date.now(),
        graphProjectionVersion: 1,
        message               : {
            id,
            type      : 'MESSAGE',
            name      : `subject ${id}`,
            properties: {subject: `subject ${id}`}
        },
        routing      : {sentBy: '@alice', to: '@bob', senderUserId: 'alice', broadcastRecipients: []},
        optionalEdges: {relatedTickets: [], relatedSessions: [], taggedConcepts: []}
    });

    const seed = id => appendWalMessage(record(id), {dir: tmpDir, planeId: 'test-message-plane'});

    test('the integrity repair rides the drain host at its cadence: at once on the first cycle, joined while in flight, then only past the interval (#563)', async () => {
        const
            calls   = [],
            logs    = [],
            clock   = {now: 1_000},
            summary = {scanned: 1, intact: 0, repaired: 1, failed: 0},
            hook    = createMessageGraphIntegrityRepairCadence({
                async repairMessageGraphIntegrity(options) {
                    calls.push(options);
                    return summary
                }
            }, {intervalMs: 500, now: () => clock.now, log: (level, message) => logs.push(`${level} ${message}`)});

        const first = hook({drained: 0});

        expect(hook({drained: 0}), 'a run in flight is joined, never doubled').toBe(first);
        expect(await first, 'the first cycle runs it at once').toBe(summary);
        expect(calls).toEqual([{box: 'all'}]);
        expect(hook.getLastSummary()).toBe(summary);
        expect(logs, 'a pass that repaired something is logged with its counters').toEqual([`INFO Message graph integrity repair: ${JSON.stringify(summary)}`]);

        clock.now += 100;
        expect(await hook({drained: 0}), 'inside the interval nothing runs').toBeNull();
        expect(calls).toHaveLength(1);

        clock.now += 500;
        await hook({drained: 0});
        expect(calls, 'past the interval it runs again').toHaveLength(2);
    });

    test('clean passes are silent but counted: the digest folds every pass since the last digest, and a stamped cohort counts as a change', async () => {
        const
            logs      = [],
            clock     = {now: 10_000},
            summaries = [
                {scanned: 3, intact: 3, repaired: 0, failed: 0, cohortStamped: 0, deferredCandidateCount: 0},
                {scanned: 3, intact: 3, repaired: 0, failed: 0, cohortStamped: 0, deferredCandidateCount: 2},
                {scanned: 3, intact: 2, repaired: 0, failed: 0, cohortStamped: 1, deferredCandidateCount: 0}
            ],
            hook      = createMessageGraphIntegrityRepairCadence({
                async repairMessageGraphIntegrity() {
                    return summaries.shift()
                }
            }, {intervalMs: 100, digestMs: 1_000, now: () => clock.now, log: (level, message) => logs.push(`${level} ${message}`)});

        await hook({drained: 0});
        expect(logs, 'the first pass is logged even when clean — the boot receipt').toHaveLength(1);

        clock.now += 100;
        await hook({drained: 0});
        expect(logs, 'a deferred-only pass past the first is silent').toHaveLength(1);
        expect(hook.getDigest(), 'but counted').toMatchObject({passes: 2, clean: 2, changed: 0, deferred: 2});

        clock.now += 900;
        await hook({drained: 0});
        expect(logs, 'a stamped cohort is a change, and the hour is up').toHaveLength(3);
        expect(logs[1]).toContain('"cohortStamped":1');
        expect(logs[2]).toMatch(/^INFO Message graph integrity repair digest: /);
        expect(JSON.parse(logs[2].replace(/^INFO Message graph integrity repair digest: /, '')))
            .toMatchObject({passes: 3, clean: 2, changed: 1, errors: 0, scanned: 9, cohortStamped: 1, deferred: 2, sinceAt: 10_000, untilAt: 11_000});
        expect(hook.getDigest(), 'a fresh digest starts at the line').toMatchObject({sinceAt: 11_000, passes: 0});
    });

    test('the loop host runs the after-cycle hook once per completed cycle', async () => {
        const summaries = [];
        const loop      = startMessageDrainLoop({
            getConfig   : () => ({dir: tmpDir, batchSize: 5, maxRetries: 0, backoffBaseMs: 1, pollIntervalMs: 10}),
            getProcessor: () => async () => ({drained: 0, failed: 0, deferred: 0}),
            afterCycle  : async summary => { summaries.push(summary) }
        });

        // Wait for the cycles the loop has published, not for a wall-clock window a loaded runner spends
        // inside the first poll.
        await expect.poll(() => summaries.length).toBeGreaterThanOrEqual(2);
        loop.stop();

        expect(summaries[0]).toMatchObject({observed: 0, drained: 0, outstanding: 0, inactive: false});
    });

    test('without a replay processor, the cycle skips WAL reads instead of doing active no-op work', async () => {
        await seed('MESSAGE:deferred');

        let   readCalled = false;
        const summary    = await drainMessageWalOnce({
            dir          : tmpDir,
            batchSize    : 20,
            maxRetries   : 1,
            backoffBaseMs: 1000,
            readMessages : async () => {
                readCalled = true;
                throw new Error('readMessages should not be called without a processor');
            }
        });

        expect(summary).toEqual({observed: 0, drained: 0, failed: 0, deferred: 0, inactive: true, outstanding: 0});
        expect(readCalled).toBe(false);
    });

    test('batchSize bounds the records passed to the replay processor', async () => {
        await seed('MESSAGE:a');
        await seed('MESSAGE:b');
        await seed('MESSAGE:c');

        const seen    = [];
        const summary = await drainMessageWalOnce({
            dir          : tmpDir,
            batchSize    : 2,
            maxRetries   : 1,
            backoffBaseMs: 1000,
            processRecords(records) {
                seen.push(...records.map(item => item.id));
                return {drained: records.length, failed: 0, deferred: 0};
            }
        });

        // Three observed, two batched-and-drained → the one batch-overflowed record is the residue.
        expect(summary).toEqual({observed: 3, inactive: false, outstanding: 1, drained: 2, failed: 0, deferred: 0});
        expect(seen).toHaveLength(2);
    });

    test('processor failures retry with exponential backoff, then succeed', async () => {
        const records  = [record('MESSAGE:retry')];
        const sleeps   = [];
        let   attempts = 0;

        const summary = await processMessageBatch({
            records,
            maxRetries   : 2,
            backoffBaseMs: 1000,
            sleep        : async ms => sleeps.push(ms),
            processRecords() {
                attempts++;
                if (attempts < 3) throw new Error('graph temporarily down');
                return {drained: 1, failed: 0, deferred: 0};
            }
        });

        expect(summary).toEqual({drained: 1, failed: 0, deferred: 0});
        expect(attempts).toBe(3);
        expect(sleeps).toEqual([
            getMessageDrainBackoffDelayMs(1000, 0),
            getMessageDrainBackoffDelayMs(1000, 1)
        ]);
    });

    test('exhausted processor failures leave the whole batch failed and retryable', async () => {
        const records = [record('MESSAGE:failed')];

        const summary = await processMessageBatch({
            records,
            maxRetries   : 1,
            backoffBaseMs: 1000,
            sleep        : async () => {},
            processRecords() {
                throw new Error('still down');
            }
        });

        expect(summary).toEqual({drained: 0, failed: 1, deferred: 0});
    });

    test('projection processor adapts mailbox drain summaries to cycle counters', async () => {
        const processRecords = createMessageGraphProjectionProcessor({
            async drainPendingMessageGraphProjections({ids, limit}) {
                expect(ids).toEqual(['MESSAGE:a', 'MESSAGE:b']);
                expect(limit).toBe(2);

                return {pending: 2, projected: 1, failed: 1};
            }
        });

        const summary = await processRecords([record('MESSAGE:a'), record('MESSAGE:b')]);

        expect(summary).toEqual({drained: 1, failed: 1, deferred: 0});
    });
});
