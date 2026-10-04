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
 * in memory and replaces the file whole and atomically on each event.
 *
 * **It is an observation, never a precondition.** The receiver starts without waiting for it. A
 * start reads the previous account within a bound, so the stuck exit that caused a restart survives
 * the restart; an account that cannot be read in time, or is not a valid account, is replaced by a
 * fresh one. A failed write is logged and never thrown.
 *
 * The account's shape: `{starts: String[], lastAcceptAt: String|null, lastSweepAt: String|null,
 * stuckExits: {step: String, subscriptionId?: String, at: String}[]}`, every timestamp ISO-8601, at
 * least one start, and both lists bounded at {@link KEPT_EVENTS}.
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
 * How long a start waits for the previous account before it starts a fresh one.
 * @type {Number}
 */
const READ_TIMEOUT_MS = 2000;

/**
 * @type {Number}
 */
const HOUR_MS = 60 * 60 * 1000;

/**
 * @summary Whether a value is an ISO timestamp a reader can age.
 * @param {*} value
 * @returns {Boolean}
 */
const isStamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * @summary Validates a parsed account against the shape above, or answers `null`. Lists must be lists
 * and hold at least one start; an entry that is not a valid start or stuck exit is dropped, and a
 * timestamp that is not one reads `null`.
 * @param {*} raw
 * @returns {Object|null}
 */
export function normalizeReceiverLiveness(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.starts) || !Array.isArray(raw.stuckExits)) {
        return null
    }

    const starts = raw.starts.filter(isStamp);

    if (starts.length === 0) return null;

    return {
        starts,
        lastAcceptAt: isStamp(raw.lastAcceptAt) ? raw.lastAcceptAt : null,
        lastSweepAt : isStamp(raw.lastSweepAt)  ? raw.lastSweepAt  : null,
        stuckExits  : raw.stuckExits
            .filter(exit => exit && typeof exit.step === 'string' && isStamp(exit.at))
            .map(({step, subscriptionId, at}) => ({step, ...(typeof subscriptionId === 'string' ? {subscriptionId} : {}), at}))
    }
}

/**
 * @summary Reads the liveness account, or `null` when it is absent, will not parse, or is not a valid
 * account.
 * @param {String} recordsDir
 * @param {Object} [options]
 * @param {Object} [options.fsModule=fs]
 * @returns {Promise<Object|null>}
 */
export async function readReceiverLiveness(recordsDir, {fsModule = fs} = {}) {
    try {
        return normalizeReceiverLiveness(JSON.parse(await fsModule.readFile(path.join(recordsDir, RECEIVER_LIVENESS_FILE), 'utf8')))
    } catch {
        return null
    }
}

/**
 * @summary Projects a valid account into what a reader acts on: ages, and the last hour's starts and
 * stuck exits. No account is `unknown`, never fresh.
 * @param {Object|null} account {@link readReceiverLiveness}'s result.
 * @param {Number} nowMs
 * @returns {Object} `{state: 'unknown'}`, or `{state: 'observed', startedAt, lastAcceptAt,
 *     lastAcceptAgeMs, lastSweepAt, lastSweepAgeMs, startsLastHour, stuckExitsLastHour, lastStuckExit}`.
 */
export function projectReceiverLiveness(account, nowMs) {
    if (!account) return {state: 'unknown'};

    const
        ageOf      = at => at === null ? null : nowMs - Date.parse(at),
        inLastHour = at => nowMs - Date.parse(at) <= HOUR_MS;

    return {
        state             : 'observed',
        startedAt         : account.starts.at(-1),
        lastAcceptAt      : account.lastAcceptAt,
        lastAcceptAgeMs   : ageOf(account.lastAcceptAt),
        lastSweepAt       : account.lastSweepAt,
        lastSweepAgeMs    : ageOf(account.lastSweepAt),
        startsLastHour    : account.starts.filter(inLastHour).length,
        stuckExitsLastHour: account.stuckExits.filter(exit => inLastHour(exit.at)).length,
        lastStuckExit     : account.stuckExits.at(-1) ?? null
    }
}

/**
 * @summary The receiver's writer for its liveness account. Its start is stamped at creation; nothing
 * here throws, and nothing here may hold up the receiver.
 * @param {Object} options
 * @param {String} options.recordsDir
 * @param {Function} [options.now] Clock seam.
 * @param {Object} [options.logger=console]
 * @param {Object} [options.fsModule=fs]
 * @param {Number} [options.readTimeoutMs=READ_TIMEOUT_MS] How long a start waits for the previous account.
 * @returns {{start: Function, accepted: Function, swept: Function, stuck: Function}}
 */
export function createReceiverLiveness({recordsDir, now = () => new Date(), logger = console, fsModule = fs, readTimeoutMs = READ_TIMEOUT_MS} = {}) {
    const
        file  = path.join(recordsDir, RECEIVER_LIVENESS_FILE),
        stamp = () => now().toISOString(),
        keep  = list => list.slice(-KEPT_EVENTS);

    let
        account = {starts: [stamp()], lastAcceptAt: null, lastSweepAt: null, stuckExits: []},
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
         * @summary Carries the previous account forward under this process's own stamps, then writes.
         * Every later write waits for it, so none can replace the previous account before it is read.
         * @returns {Promise<void>}
         */
        start() {
            const previous = new Promise(resolve => {
                setTimeout(() => resolve(null), readTimeoutMs).unref?.();
                readReceiverLiveness(recordsDir, {fsModule}).then(resolve)
            });

            writes = writes.then(() => previous).then(prior => {
                if (!prior) return;

                account = {
                    starts      : keep([...prior.starts, ...account.starts]),
                    lastAcceptAt: account.lastAcceptAt ?? prior.lastAcceptAt,
                    lastSweepAt : account.lastSweepAt  ?? prior.lastSweepAt,
                    stuckExits  : keep([...prior.stuckExits, ...account.stuckExits])
                }
            });

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
