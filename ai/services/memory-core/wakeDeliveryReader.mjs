/**
 * @summary Reads the wake receiver's dispatch records and projects them into delivery verdicts.
 *
 * **This module is the I/O half; `wakeDeliveryProjection` is the pure half.** The split is the
 * testability story: what a set of records *means* is answered without a receiver, a filesystem or
 * a running daemon, and only the act of reading them needs one. Anything that wants the verdict —
 * `healthcheck`, `who_is_online`, a CLI — goes through here rather than re-reading the directory,
 * so "what counts as a failure" and "what counts as delivered" are decided in exactly one place.
 *
 * **The records are not the defect and this does not treat them as one.** The receiver has been
 * persisting one complete record per dispatch all along, correctly, including an `outcomeReason` on
 * every failure. Nothing read them. That is the whole gap: the substrate kept an accurate account of
 * what happened to every wake and no surface carried it, so a subscription whose every dispatch
 * failed continued to report itself armed and deliverable.
 *
 * **The directory is a declaration, never a guess.** The receiver runs in a different process and
 * takes its state directory as a `--state-dir` flag, so this reader finds the records only through
 * the deployment's declaration: the `fleet.wakeReceiverRecordsDir` leaf. A process that declares
 * none reads `unconfigured`, distinct from a declared directory holding no records.
 *
 * @module ai/services/memory-core/wakeDeliveryReader
 */

import fs       from 'fs/promises';
import path     from 'path';
import aiConfig from '../../mcp/server/memory-core/config.mjs';
import {
    RETIRED_INDEX_FILE,
    TERMINAL_STATES
} from '../../daemons/wake/receiverState.mjs';
import {
    projectMessageDelivery,
    projectWakeDelivery,
    projectWakeDeliveryStages
} from './wakeDeliveryProjection.mjs';
import {
    projectReceiverLiveness,
    readReceiverLiveness
} from '../../daemons/wake/receiverLiveness.mjs';

/**
 * What every answer that could not read the directory says about the receiver: unknown, never fresh.
 * @type {Object}
 */
const RECEIVER_UNKNOWN = Object.freeze({state: 'unknown'});

/**
 * @summary Per records directory: the terminal records already read, by file name, the read in flight
 * and how many listings completed; the retired index's records by message id, and its read in flight
 * with the listing count it started after.
 * @type {Map<String, {held: Map<String, Object>, reading: Promise<Object>|null, listings: Number, retired: {stamp: String|null, byId: Map<String, Object[]>}|null, retiredReading: {after: Number, promise: Promise<Map|null>}|null}>}
 */
const directories = new Map();

/**
 * @summary Reads every dispatch record and projects one delivery verdict per subscription.
 *
 * **A repeat call reads only what can have changed.** A terminal record's file is final
 * (`TERMINAL_STATES`), so it is read once and held by file name; each call lists the directory and
 * reads only the names it does not hold, which are new records and `pending` or `dispatching`
 * ones. A name the directory no longer lists leaves the held set. Overlapping calls join the read
 * already running, so a burst of `who_is_online` calls costs one directory read, not one each.
 *
 * **Never throws, and four outcomes stay distinct:**
 * - `unconfigured`: no records directory is declared, so there is nothing to look at.
 * - `no-records`: the declared directory is absent or holds no record. That is a measured absence of
 *   dispatch attempts, not evidence that any seat is reachable, so it projects no subscriptions.
 * - `unreadable`: the declared directory exists but cannot be read (a permission wall, another
 *   container's realm). The question could not be asked, and reporting that as healthy is the
 *   conflation that once let a 19-day delivery outage read healthy.
 * - `observed`: records were read and projected.
 *
 * A malformed record is skipped rather than guessed at, matching the receiver's own reader: a
 * record that will not parse is not evidence in either direction.
 *
 * `receiver` is the receiver's own liveness account (`receiverLiveness`), which it keeps in the same
 * directory: when it last accepted a wake and completed a sweep pass, and how often it started or
 * exited stuck in the last hour. It is read on every call and is `unknown` whenever it cannot be read.
 *
 * `messageIds` adds `messages`, one verdict per wake message (`projectMessageDelivery`), projected per
 * call from the shared read; a directory that could not be read leaves every message `unknown`. A
 * message's verdict outlives its record's retention window: the receiver keeps each retired record's
 * fate in `RETIRED_INDEX_FILE`, which only a call with `messageIds` reads, re-reading it only after
 * the receiver rewrote it. A call never joins an index read that began before its own listing: the
 * receiver writes a fate before it unlinks the record, so only a later read holds every record the
 * listing misses. An index that exists and cannot be read leaves every message `unknown`.
 *
 * @param {Object} [options]
 * @param {String} [options.recordsDir] Records directory; tests isolate through it. Defaults to the
 * `fleet.wakeReceiverRecordsDir` leaf.
 * @param {String[]} [options.messageIds] Wake message ids to answer a delivery verdict for.
 * @param {Boolean} [options.includeStages=false] Whether to project stage and split-latency breakdowns.
 * @param {Boolean} [options.includePendingRecords=false] Whether to attach `pendingRecords` for settled-source reconciliation.
 * @param {Object|Object[]} [options.policyQueue] Optional pending coalescing policy snapshot.
 * @param {Number|String|Date|null} [options.now=null] Optional observation clock for open wait durations.
 * @returns {Promise<{deliveryReadable: Boolean, deliveryReadReason: String, subscriptions: Object, receiver: Object, messages?: Object, messageStages?: Object, pendingRecords?: Object[]}>}
 */
export async function readWakeDelivery({recordsDir, messageIds, includeStages = false, includePendingRecords = false, policyQueue = {}, now = null} = {}) {
    const directory = recordsDir ?? aiConfig.fleet.wakeReceiverRecordsDir;

    if (!directory) {
        return {deliveryReadable: false, deliveryReadReason: 'unconfigured', subscriptions: {}, receiver: RECEIVER_UNKNOWN,
            ...(messageIds ? {messages: projectMessageDelivery(null, messageIds)} : {}),
            ...(includeStages ? {messageStages: projectWakeDeliveryStages(null, {messageIds, policyQueue, now})} : {}),
            ...(includePendingRecords ? {pendingRecords: []} : {})};
    }

    let state = directories.get(directory);

    if (!state) {
        state = {held: new Map(), reading: null, listings: 0, retired: null, retiredReading: null};
        directories.set(directory, state)
    }

    state.reading ??= readDirectory(directory, state.held).then(read => ({...read, listing: ++state.listings})).finally(() => {
        state.reading = null
    });

    const {result, records, listing} = await state.reading;

    if (!messageIds && !includeStages && !includePendingRecords) return result;

    let scoped = result.deliveryReadable ? records : null;

    if (scoped && messageIds) {
        if (!(state.retiredReading?.after >= listing)) {
            const entry = {after: state.listings};

            entry.promise = readRetired(directory, state).finally(() => {
                if (state.retiredReading === entry) state.retiredReading = null
            });
            state.retiredReading = entry
        }

        const retired = await state.retiredReading.promise;

        scoped = retired && [...records, ...new Set(messageIds.flatMap(id => retired.get(id) ?? []))]
    }

    return {
        ...result,
        ...(messageIds ? {messages: projectMessageDelivery(scoped, messageIds)} : {}),
        ...(includeStages ? {messageStages: projectWakeDeliveryStages(scoped, {messageIds, policyQueue, now})} : {}),
        ...(includePendingRecords ? {pendingRecords: result.deliveryReadable ? records.filter(record => record?.state === 'pending') : []} : {})
    }
}

/**
 * @summary The retired index's records by message id. The receiver rewrites the index whole, so a
 * changed size or modification time is a new index and an unchanged one is the index already read.
 * @param {String} directory
 * @param {Object} state The directory's reader state, which holds the parsed index.
 * @returns {Promise<Map<String, Object[]>|null>} `null` when the index exists and cannot be read.
 */
async function readRetired(directory, state) {
    const file = path.join(directory, RETIRED_INDEX_FILE);
    let stat;

    try {
        stat = await fs.stat(file);
    } catch (error) {
        if (error?.code !== 'ENOENT') return null;

        // nothing has retired yet
        state.retired = null;
        return new Map()
    }

    const stamp = `${stat.size}:${stat.mtimeMs}`;

    if (state.retired?.stamp !== stamp) {
        let text;

        try {
            text = await fs.readFile(file, 'utf8')
        } catch {
            return null
        }

        const byId = new Map();

        for (const line of text.split('\n')) {
            let record;

            try {
                record = JSON.parse(line)
            } catch {
                continue
            }

            for (const id of Array.isArray(record?.sourceEventIds) ? record.sourceEventIds : []) {
                byId.has(id) ? byId.get(id).push(record) : byId.set(id, [record])
            }
        }

        state.retired = {stamp, byId}
    }

    return state.retired.byId
}

/**
 * @summary One read of a records directory: list it, read the names not held, hold the terminal
 * records, and project.
 * @param {String} directory
 * @param {Map<String, Object>} held The directory's terminal records, by file name.
 * @returns {Promise<{result: Object, records: Object[]}>} The shared answer, and the records it was
 * projected from for a caller's per-message verdicts.
 */
async function readDirectory(directory, held) {
    let entries;

    try {
        entries = await fs.readdir(directory);
    } catch (error) {
        // a directory that cannot be listed holds nothing this reader may still vouch for
        held.clear();

        // ENOENT is a measured absence: nothing has ever been dispatched from here. Anything else
        // is an unanswerable question, and the two must not read the same way.
        return {records: [], result: error?.code === 'ENOENT'
            ? {deliveryReadable: true, deliveryReadReason: 'no-records', subscriptions: {}, receiver: RECEIVER_UNKNOWN}
            : {deliveryReadable: false, deliveryReadReason: 'unreadable', subscriptions: {}, receiver: RECEIVER_UNKNOWN}};
    }

    const
        listed  = new Set(),
        records = [];

    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;

        listed.add(entry);

        let record = held.get(entry);

        if (!record) {
            try {
                record = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'));
            } catch {
                // A record that will not parse is not evidence in either direction — not a delivery,
                // and not a failure. Skipping it is the receiver's own rule and this inherits it.
                continue
            }

            TERMINAL_STATES.has(record?.state) && held.set(entry, record)
        }

        records.push(record)
    }

    for (const name of held.keys()) {
        listed.has(name) || held.delete(name)
    }

    return {records, result: {
        deliveryReadable  : true,
        deliveryReadReason: records.length > 0 ? 'observed' : 'no-records',
        subscriptions     : projectWakeDelivery(records),
        receiver          : projectReceiverLiveness(await readReceiverLiveness(directory), Date.now())
    }};
}
