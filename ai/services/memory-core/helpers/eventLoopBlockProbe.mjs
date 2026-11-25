/**
 * @module ai/services/memory-core/helpers/eventLoopBlockProbe
 * @summary Names an event-loop block after it ends: how long it lasted, how much of it was garbage
 * collection, and which tool calls were in flight across it.
 *
 * A synchronous query or a GC pause stops every other call in the process, and nothing that runs on
 * the blocked loop can say so while it lasts. The probe samples instead: an unref'd interval notes
 * when its timer ran late, so a block is measured the moment the loop frees. The start row of each
 * call (`MemoryCoreRecorderService#beginToolCall`) already names the query shape; the probe adds the
 * other half, whether the CPU went to that query or to the collector.
 *
 * A late tick is reported on the tick after it, so the `gc` performance entries from inside the window
 * have been delivered. The window runs from the last on-time tick to the late one, so it can name a
 * call that ended up to one interval before the block began.
 */
import {PerformanceObserver, performance} from 'node:perf_hooks';

/**
 * @summary How late a sample may run before it is a block. Below a second the plane only slows; a
 * stall that holds it lasts minutes.
 * @type {Number}
 */
export const BLOCK_THRESHOLD_MS = 1000;

/**
 * @summary The sampling interval: the probe's resolution and its only steady cost.
 * @type {Number}
 */
export const BLOCK_SAMPLE_INTERVAL_MS = 500;

/**
 * @summary How long an ended call or a GC entry stays attributable to a block found later.
 * @type {Number}
 */
const ATTRIBUTION_MS = 60 * 1000;

/**
 * @summary Starts sampling event-loop lag and observing `gc` entries.
 * @param {Object} options
 * @param {Function} options.onBlock `({endedAt, durationMs, gcMs, callIds})`: `endedAt` is wall-clock
 * epoch ms, `durationMs` how late the sample ran, `gcMs` the collection time inside the window, and
 * `callIds` the calls in flight across it.
 * @param {Number} [options.thresholdMs=BLOCK_THRESHOLD_MS] Tests shorten it.
 * @param {Number} [options.intervalMs=BLOCK_SAMPLE_INTERVAL_MS] Tests shorten it.
 * @returns {{callStarted: Function, callEnded: Function, noteGc: Function, stop: Function}} `noteGc`
 * takes `(startedAt, durationMs)` in `performance.now()` time; the observer feeds it, and so can a test.
 */
export function createEventLoopBlockProbe({onBlock, thresholdMs = BLOCK_THRESHOLD_MS, intervalMs = BLOCK_SAMPLE_INTERVAL_MS}) {
    const
        calls = new Map(),
        gcs   = [];

    let lastTick = performance.now(),
        pending  = null;

    const noteGc = (startedAt, durationMs) => {
        gcs.push({startedAt, endedAt: startedAt + durationMs})
    };

    const report = ({from, to, lateMs}) => {
        const overlap = (start, end) => Math.max(0, Math.min(to, end) - Math.max(from, start));

        onBlock({
            endedAt   : Math.round(Date.now() - (performance.now() - to)),
            durationMs: Math.round(lateMs),
            gcMs      : Math.round(gcs.reduce((sum, gc) => sum + overlap(gc.startedAt, gc.endedAt), 0)),
            callIds   : [...calls].filter(([, call]) => call.startedAt <= to && (call.endedAt === null || call.endedAt >= from)).map(([id]) => id)
        })
    };

    const tick = () => {
        const time   = performance.now(),
              lateMs = time - lastTick - intervalMs;

        if (pending) {
            report(pending);
            pending = null
        }

        if (lateMs >= thresholdMs) pending = {from: lastTick, to: time, lateMs};

        lastTick = time;

        for (const [id, call] of calls) {
            if (call.endedAt !== null && call.endedAt < time - ATTRIBUTION_MS) calls.delete(id)
        }

        while (gcs.length > 0 && gcs[0].endedAt < time - ATTRIBUTION_MS) gcs.shift()
    };

    const
        timer    = setInterval(tick, intervalMs),
        observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) noteGc(entry.startTime, entry.duration)
        });

    timer.unref?.();
    observer.observe({entryTypes: ['gc']});

    return {
        callStarted(id) {
            calls.set(id, {startedAt: performance.now(), endedAt: null})
        },
        callEnded(id) {
            const call = calls.get(id);

            if (call) call.endedAt = performance.now()
        },
        noteGc,
        stop() {
            clearInterval(timer);
            observer.disconnect()
        }
    }
}
