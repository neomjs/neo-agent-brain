/**
 * @module ai/services/fleet/boundRosterRead
 * @summary Shared axis-deadline wrapper for Fleet plane reads so a slow `mc-server` axis either
 * returns an unexpired retained observation or fails fast with its axis wait while the plane call
 * runs on to refresh retention and log its late completion.
 */

/**
 * @summary Bounds one of the Fleet's plane-sourced reads: past `timeoutMs` it serves an unexpired
 * retained observation when configured, else rejects naming the wait while the plane call runs on.
 * A call that settles after the bound refreshes retention and logs its duration once.
 * @param {Function} read `() => Promise`, the axis's reader
 * @param {String} axis Axis label named in the timeout error and late-settlement log line
 * @param {Number} timeoutMs Axis deadline in milliseconds
 * @param {Object} [retention={}]
 * @param {Number} [retention.maxRetainedAgeMs=0] Maximum age in ms for a retained observation
 * @param {Function} [retention.now=Date.now] Clock seam returning epoch ms, Date, or ISO string
 * @param {Function|null} [retention.readRetained=null] Returns `{payload, settledAtMs}|null`
 * @param {Function|null} [retention.writeRetained=null] Persists `(payload, settledAtMs)` when answered
 * @returns {Function} The bounded reader
 */
export function boundRosterRead(read, axis, timeoutMs, {
    maxRetainedAgeMs = 0,
    now              = Date.now,
    readRetained     = null,
    writeRetained    = null
} = {}) {
    const nowMs = () => {
        const value = now();

        return typeof value === 'number' ? value : new Date(value).getTime()
    };

    return () => {
        const startedAt = nowMs(), call = Promise.resolve().then(read);
        let   late      = false, timerId;

        const settled = outcome => late && console.log(`[fleet] roster ${axis} read ${outcome} after ${nowMs() - startedAt} ms (bound ${timeoutMs} ms)`);

        call.then(payload => {
            writeRetained?.(payload, nowMs());
            settled('answered')
        }, () => settled('failed'));

        return Promise.race([
            call.finally(() => clearTimeout(timerId)),
            new Promise((resolve, reject) => {
                timerId = setTimeout(() => {
                    late = true;

                    const retained = readRetained?.();

                    if (retained && nowMs() - retained.settledAtMs <= maxRetainedAgeMs) {
                        resolve(retained.payload);
                        return
                    }

                    reject(Object.assign(new Error(`${axis} read still pending after ${timeoutMs} ms`), {code: 'FLEET_AXIS_TIMEOUT'}))
                }, timeoutMs);
                timerId.unref?.()
            })
        ])
    }
}

export default boundRosterRead;
