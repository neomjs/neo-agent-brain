import {monitorEventLoopDelay}         from 'node:perf_hooks';
import Base                            from 'neo.mjs/src/core/Base.mjs';
import AiConfig                        from '../../../../config.mjs';
import {collectProcessHeapObservation} from '../../../../services/shared/processHeapObservation.mjs';

/**
 * @summary Reports this process's event loop: a WARN for each stall above the bound, and one line at
 * exit saying whether the loop drained and which handles were still open.
 *
 * An exit called with the listener up lists `TCPServerWrap`; a loop that ran out of work lists only
 * its stdio pipes and sets `drained`. The line goes through `logger.writeSync()`, because an entry
 * queued on the file stream during `exit` never lands.
 * @extends Neo.core.Base
 */
class EventLoopReporterService extends Base {
    static config = {
        /** @member {String} className='Neo.ai.mcp.server.shared.services.EventLoopReporterService' */
        className: 'Neo.ai.mcp.server.shared.services.EventLoopReporterService',
        /** @member {Boolean} singleton=true */
        singleton: true
    }

    /** @member {Boolean} drained=false Whether `beforeExit` fired: the loop ran out of work. */
    drained = false
    /** @member {Object|null} histogram=null */
    histogram = null
    /** @member {Object|null} listeners=null The armed `process` listeners, by event. */
    listeners = null
    /** @member {Object|null} timer=null */
    timer = null
    /** @member {Number|null} windowStartedAt=null Epoch ms at which the current window began. */
    windowStartedAt = null

    /**
     * @summary Closes the current window, WARNing when its longest delay reached `stallWarnMs`, and
     * starts the next, so one stall produces one WARN. A stall is measured when the loop resumes and
     * the sampler fires late, so the WARN follows the stall it describes.
     * @param {Object} options
     * @param {String} options.serviceKey
     * @param {Object} options.logger
     * @param {Number} options.stallWarnMs
     * @returns {void}
     */
    check({serviceKey, logger, stallWarnMs}) {
        const reading = this.read();

        this.histogram.reset();
        this.windowStartedAt = Date.now();

        if (reading.maxMs >= stallWarnMs) {
            logger.warn(`[EventLoopReporter] ${serviceKey}: the event loop stalled for up to ${reading.maxMs} ms since ${reading.windowStartedAt} (p99 ${reading.p99Ms} ms, bound ${stallWarnMs} ms)`)
        }
    }

    /**
     * @summary The fields the exit line carries.
     * @param {Number} code The code `exit` was emitted with.
     * @returns {Object}
     */
    describeExit(code) {
        const heap = collectProcessHeapObservation();

        return {
            code,
            drained           : this.drained,
            uptimeMs          : Math.round(process.uptime() * 1000),
            usedHeapBytes     : heap.usedHeapBytes,
            heapSizeLimitBytes: heap.heapSizeLimitBytes,
            activeResources   : process.getActiveResourcesInfo(),
            loopDelay         : this.histogram ? this.read() : null
        }
    }

    /**
     * @summary The current window's reading, in whole milliseconds.
     * @returns {{windowStartedAt: String, maxMs: Number, p99Ms: Number}}
     */
    read() {
        const {histogram} = this;

        return {
            windowStartedAt: new Date(this.windowStartedAt).toISOString(),
            maxMs          : Math.round(histogram.max / 1e6),
            p99Ms          : Math.round(histogram.percentile(99) / 1e6)
        }
    }

    /**
     * @summary Writes the exit line. Total: an `exit` handler that throws buries the exit it explains.
     * @param {Object} options
     * @param {String} options.serviceKey
     * @param {Object} options.logger
     * @param {Number} options.code
     * @returns {void}
     */
    reportExit({serviceKey, logger, code}) {
        try {
            logger.writeSync('info', `[EventLoopReporter] ${serviceKey} exiting`, this.describeExit(code))
        } catch {
            // Nothing runs after an exit handler that could report this.
        }
    }

    /**
     * @summary Starts sampling and arms the exit line. Total: returns, never throws.
     *
     * Nothing here holds the process open: the histogram's timer and the check interval are both
     * unref'd, or they would hide the drained-loop exit this reports. `readConfig` is a thunk so the
     * config read happens inside the guard, and a spec swaps the reader instead of mutating `AiConfig`.
     * @param {Object}   options
     * @param {String}   options.serviceKey   Stable service identity, e.g. `mc-server`.
     * @param {Object}   options.logger       The server's logger; needs `warn()` and `writeSync()`.
     * @param {Function} [options.readConfig] Returns the resolved `eventLoop` leaves.
     * @returns {Boolean} Whether reporting started.
     */
    start({serviceKey, logger, readConfig = () => AiConfig.eventLoop}) {
        try {
            const {checkIntervalMs, stallWarnMs} = readConfig();

            this.stop();

            this.drained         = false;
            this.histogram       = monitorEventLoopDelay();
            this.windowStartedAt = Date.now();
            this.histogram.enable();

            this.timer = setInterval(() => this.check({serviceKey, logger, stallWarnMs}), checkIntervalMs);
            this.timer.unref();

            this.listeners = {
                beforeExit: () => {this.drained = true},
                exit      : code => this.reportExit({serviceKey, logger, code})
            };

            Object.entries(this.listeners).forEach(([event, listener]) => process.on(event, listener));

            return true
        } catch (error) {
            try {
                logger.warn(`[EventLoopReporter] NOT started for ${serviceKey}: ${error.message}. Stalls and the exit reason stay unobservable.`)
            } catch {
                // A server must not fail to boot because it could not watch its own loop.
            }

            return false
        }
    }

    /**
     * @summary Stops sampling and disarms the exit line. Idempotent.
     * @returns {void}
     */
    stop() {
        const {histogram, listeners, timer} = this;

        this.histogram = null;
        this.listeners = null;
        this.timer     = null;

        timer     && clearInterval(timer);
        histogram && histogram.disable();
        listeners && Object.entries(listeners).forEach(([event, listener]) => process.off(event, listener))
    }
}

export default Neo.setupClass(EventLoopReporterService);
