/**
 * @module ai/daemons/wake/receiverLiveness
 * @summary The wake receiver's own account of its liveness, kept where a plane can read it.
 *
 * The dispatch records say what happened to each wake. They cannot say that the receiver stopped
 * accepting any, which is how a hung accept path stayed invisible for hours: it answered other routes
 * and recorded nothing. This account can. It holds when the process started, when it last accepted a
 * wake, when its manifest sweep last completed a pass (every 30 s, with or without traffic), and
 * which steps the stuck-step watchdog last exited on.
 *
 * It lives in the records directory, because that is the directory a plane mounts, under a name the
 * record readers skip: both read only `.json`. The receiver is its only writer. It holds the account
 * in memory and replaces the file whole and atomically on each event. A start reads the previous file
 * first, so the stuck exit that caused a restart survives the restart.
 */
import fs                                     from 'node:fs/promises';
import path                                   from 'node:path';
import {writeFileAtomic, writeFileAtomicSync} from '../../services/shared/atomicFileWrite.mjs';

/**
 * The account's file name inside the records directory. Not `.json`, so no record reader takes it.
 * @type {String}
 */
export const RECEIVER_LIVENESS_FILE = 'receiver.liveness';

/**
 * How many starts and stuck exits the account keeps: enough to read an hour of a crash loop.
 * @type {Number}
 */
const KEPT_EVENTS = 20;

/**
 * @type {Number}
 */
const HOUR_MS = 60 * 60 * 1000;

/**
 * @summary Reads the liveness account, or `null` when it is absent or will not parse.
 * @param {String} recordsDir
 * @param {Object} [options]
 * @param {Object} [options.fsModule=fs]
 * @returns {Promise<Object|null>}
 */
export async function readReceiverLiveness(recordsDir, {fsModule = fs} = {}) {
    try {
        const account = JSON.parse(await fsModule.readFile(path.join(recordsDir, RECEIVER_LIVENESS_FILE), 'utf8'));

        return account && typeof account === 'object' ? account : null
    } catch {
        return null
    }
}

/**
 * @summary Projects an account into what a reader acts on: ages, and the last hour's starts and stuck
 * exits. An absent account is `unknown`, never fresh, and a missing timestamp has no age.
 * @param {Object|null} account {@link readReceiverLiveness}'s result.
 * @param {Number} nowMs
 * @returns {Object} `{state: 'unknown'}`, or `{state: 'observed', startedAt, lastAcceptAt,
 *     lastAcceptAgeMs, lastSweepAt, lastSweepAgeMs, startsLastHour, stuckExitsLastHour, lastStuckExit}`.
 */
export function projectReceiverLiveness(account, nowMs) {
    if (!account) return {state: 'unknown'};

    const
        ageOf      = at => {
            const ms = Date.parse(at);

            return Number.isFinite(ms) ? nowMs - ms : null
        },
        inLastHour = at => {
            const age = ageOf(at);

            return age !== null && age <= HOUR_MS
        },
        starts     = Array.isArray(account.starts)     ? account.starts     : [],
        stuckExits = Array.isArray(account.stuckExits) ? account.stuckExits : [];

    return {
        state             : 'observed',
        startedAt         : starts.at(-1) ?? null,
        lastAcceptAt      : account.lastAcceptAt ?? null,
        lastAcceptAgeMs   : ageOf(account.lastAcceptAt),
        lastSweepAt       : account.lastSweepAt ?? null,
        lastSweepAgeMs    : ageOf(account.lastSweepAt),
        startsLastHour    : starts.filter(inLastHour).length,
        stuckExitsLastHour: stuckExits.filter(exit => inLastHour(exit?.at)).length,
        lastStuckExit     : stuckExits.at(-1) ?? null
    }
}

/**
 * @summary The receiver's writer for its liveness account. A failed write is logged and never thrown,
 * because liveness is an observation and never a precondition for accepting a wake.
 * @param {Object} options
 * @param {String} options.recordsDir
 * @param {Function} [options.now] Clock seam.
 * @param {Object} [options.logger=console]
 * @param {Object} [options.fsModule=fs]
 * @returns {{start: Function, accepted: Function, swept: Function, stuck: Function}}
 */
export function createReceiverLiveness({recordsDir, now = () => new Date(), logger = console, fsModule = fs} = {}) {
    const
        file  = path.join(recordsDir, RECEIVER_LIVENESS_FILE),
        stamp = () => now().toISOString(),
        keep  = list => list.slice(-KEPT_EVENTS);

    let
        account = {starts: [], lastAcceptAt: null, lastSweepAt: null, stuckExits: []},
        writes  = Promise.resolve();

    // Chained, and each write serializes the account as it is when the write runs, so the last write
    // to land is always the newest account.
    const persist = () => {
        writes = writes
            .then(() => writeFileAtomic(file, JSON.stringify(account) + '\n', {fsModule}))
            .catch(error => logger.error?.(`[Wake Receiver] liveness write failed: ${error.message}`));

        return writes
    };

    return {
        /**
         * @summary Records this process's start, carrying the previous account forward.
         * @returns {Promise<void>}
         */
        async start() {
            const previous = await readReceiverLiveness(recordsDir, {fsModule});

            account = {
                starts      : keep([...(previous?.starts ?? []), stamp()]),
                lastAcceptAt: previous?.lastAcceptAt ?? null,
                lastSweepAt : previous?.lastSweepAt ?? null,
                stuckExits  : keep(previous?.stuckExits ?? [])
            };

            return persist()
        },

        /**
         * @summary Stamps a completed accept.
         * @returns {Promise<void>}
         */
        accepted() {
            account.lastAcceptAt = stamp();

            return persist()
        },

        /**
         * @summary Stamps a completed pass of the manifest sweep.
         * @returns {Promise<void>}
         */
        swept() {
            account.lastSweepAt = stamp();

            return persist()
        },

        /**
         * @summary Records a stuck step. Synchronous, because the process exits right after it.
         * @param {Object} stuck
         * @param {String} stuck.step
         * @param {String} [stuck.subscriptionId]
         */
        stuck({step, subscriptionId} = {}) {
            account.stuckExits = keep([...account.stuckExits, {step, ...(subscriptionId ? {subscriptionId} : {}), at: stamp()}]);

            try {
                writeFileAtomicSync(file, JSON.stringify(account) + '\n')
            } catch (error) {
                logger.error?.(`[Wake Receiver] liveness write failed: ${error.message}`)
            }
        }
    }
}
