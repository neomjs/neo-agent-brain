import {test, expect}              from '@playwright/test';
import {performance}               from 'node:perf_hooks';
import {createEventLoopBlockProbe} from '../../../../../../../ai/services/memory-core/helpers/eventLoopBlockProbe.mjs';

// Nothing on a blocked loop can report the block while it lasts; the probe measures it from the late
// tick after it, so the culprit has usually returned by then and must still be named.

const
    busyWait = ms => {
        const end = performance.now() + ms;

        while (performance.now() < end) { /* the block */ }
    },
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test.describe('ai/services/memory-core/helpers/eventLoopBlockProbe', () => {
    test('a synchronous block past the threshold is reported once, with its GC time and every call in flight across it', async () => {
        const blocks = [],
              probe  = createEventLoopBlockProbe({onBlock: block => blocks.push(block), thresholdMs: 150, intervalMs: 20});

        try {
            probe.callStarted('ended-before');
            probe.callEnded('ended-before');
            await sleep(200);

            probe.callStarted('in-flight');
            probe.callStarted('culprit');
            probe.noteGc(performance.now() + 10, 40);
            busyWait(400);
            // the blocking call returns before the late tick runs
            probe.callEnded('culprit');

            await expect.poll(() => blocks.length, {timeout: 2_000}).toBe(1);
            // the ticks after it run on time
            await sleep(100);

            expect(blocks).toHaveLength(1);
            expect(blocks[0].durationMs).toBeGreaterThanOrEqual(350);
            expect(blocks[0].gcMs).toBeGreaterThanOrEqual(40);
            expect(blocks[0].callIds.sort()).toEqual(['culprit', 'in-flight']);
            expect(Math.abs(Date.now() - blocks[0].endedAt)).toBeLessThan(2_000);
        } finally {
            probe.stop()
        }
    });

    test('an on-time loop reports nothing', async () => {
        const blocks = [],
              probe  = createEventLoopBlockProbe({onBlock: block => blocks.push(block), thresholdMs: 150, intervalMs: 20});

        try {
            probe.callStarted('quiet');
            await sleep(200);
            expect(blocks).toEqual([]);
        } finally {
            probe.stop()
        }
    });

    test('a block inside a tracked job names the job, and a block inside an untracked timer names nothing', async () => {
        const blocks = [],
              probe  = createEventLoopBlockProbe({onBlock: block => blocks.push(block), thresholdMs: 150, intervalMs: 20});

        try {
            await sleep(100);

            const result = await probe.trackJob('drain', async () => {
                await sleep(10);
                busyWait(400);
                return 'drained'
            });

            expect(result).toBe('drained');
            await expect.poll(() => blocks.length, {timeout: 2_000}).toBe(1);
            expect(blocks[0].callIds).toEqual(['job:drain:1']);

            // the job ended before this block's window opened, so nothing in flight names it
            await new Promise(resolve => setTimeout(() => {busyWait(400); resolve()}, 50));
            await expect.poll(() => blocks.length, {timeout: 2_000}).toBe(2);
            expect(blocks[1].callIds).toEqual([])
        } finally {
            probe.stop()
        }
    });

    test('a job that throws still ends, so it stops naming later blocks, and its error reaches the caller', async () => {
        const blocks = [],
              probe  = createEventLoopBlockProbe({onBlock: block => blocks.push(block), thresholdMs: 150, intervalMs: 20});

        try {
            await expect(probe.trackJob('canary', () => {throw new Error('canary failed')})).rejects.toThrow('canary failed');

            // a job its throw left open would be in flight across this block and name it
            await sleep(100);
            busyWait(400);
            await expect.poll(() => blocks.length, {timeout: 2_000}).toBe(1);
            expect(blocks[0].callIds).toEqual([])
        } finally {
            probe.stop()
        }
    });
});
