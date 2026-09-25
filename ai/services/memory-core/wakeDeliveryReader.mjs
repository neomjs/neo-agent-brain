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
 * **On the state directory, stated plainly because it is a contract gap and not an implementation
 * detail.** The receiver takes its state directory as a `--state-dir` CLI flag with no config leaf
 * and no default, and this health surface runs in a *different process* from the receiver. So
 * nothing in the substrate currently lets one find the other: this module resolves the directory
 * from the same host convention its sibling `claudeCourierTransport` already uses
 * (`~/Library/Application Support/Neo/AgentOS/wake/…`), which is correct on the deployed host and is
 * an *assumption* everywhere else. That assumption is a second instance of the envelope-contract
 * drift in the sibling ticket's half 1 — a deployment fact both sides must agree on, held in
 * neither — and it is reported rather than papered over. When the two are unified, this reader
 * should take its directory from that single declaration, not from a convention.
 *
 * @module ai/services/memory-core/wakeDeliveryReader
 */

import fs                  from 'fs/promises';
import os                  from 'os';
import path                from 'path';
import {projectWakeDelivery} from './wakeDeliveryProjection.mjs';

/**
 * @summary The conventional receiver state directories on a host.
 *
 * Mirrors `defaultCourierDirs` in `ai/daemons/wake/claudeCourierTransport.mjs`, which resolves the
 * sibling spool beside the same root. `homedir` is injectable so a test never touches the real one.
 *
 * This host-AgentOS root is NOT the config plane-member family: those resolve under
 * `<repo>/.neo-ai-data` (see `resolvePlaneDataRoot`), so the receiver state, the routes manifest and
 * the courier spool all live outside every declared config leaf. That is a real gap and it is
 * reported, not papered over — see this module's header. What this function does provide is the
 * env override below, so the assumption is at least overridable and testable rather than hardcoded.
 *
 * @param {Function} [homedir=os.homedir]
 * @returns {{stateDir: String, recordsDir: String}}
 */
export function defaultWakeReceiverDirs(homedir = os.homedir) {
    const stateDir = path.join(homedir(), 'Library/Application Support/Neo/AgentOS/wake/state');

    return {stateDir, recordsDir: path.join(stateDir, 'records')}
}

/**
 * @summary Reads every dispatch record and projects one delivery verdict per subscription.
 *
 * **Never throws, and an unreadable directory is `unknown` rather than empty.** An absent records
 * directory means no dispatch has ever been attempted, which is a measured fact about *absence of
 * attempts* and not evidence that any seat is reachable — so it projects to an empty verdict rather
 * than a healthy one. A directory that exists but cannot be read (a permission wall, a path
 * belonging to another container's realm) is the "I could not look" case rather than the "I looked
 * and found nothing" one: the question could not be ASKED, and reporting that as healthy would be
 * the same conflation that made this invisible in the first place. The distinction is surfaced as
 * `deliveryReadable: false` so a caller can tell "nothing attempted" from "could not look".
 *
 * A malformed record is skipped rather than guessed at, matching the receiver's own reader: a
 * record that will not parse is not evidence in either direction.
 *
 * @param {Object} [options]
 * @param {String} [options.recordsDir] Records directory. Defaults to
 * `NEO_WAKE_RECEIVER_RECORDS_DIR`, then to the host convention.
 * @param {Function} [options.homedir=os.homedir] Injected for tests.
 * @returns {Promise<{deliveryReadable: Boolean, deliveryReadReason: String, subscriptions: Object}>}
 */
export async function readWakeDelivery({recordsDir, homedir = os.homedir} = {}) {
    const directory = recordsDir
        || process.env.NEO_WAKE_RECEIVER_RECORDS_DIR
        || defaultWakeReceiverDirs(homedir).recordsDir;

    let entries;

    try {
        entries = await fs.readdir(directory);
    } catch (error) {
        // ENOENT is a measured absence: nothing has ever been dispatched from here. Anything else
        // is an unanswerable question, and the two must not read the same way.
        return error?.code === 'ENOENT'
            ? {deliveryReadable: true, deliveryReadReason: 'no-records', subscriptions: {}}
            : {deliveryReadable: false, deliveryReadReason: 'unreadable', subscriptions: {}};
    }

    const records = [];

    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;

        try {
            records.push(JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8')));
        } catch {
            // A record that will not parse is not evidence in either direction — not a delivery,
            // and not a failure. Skipping it is the receiver's own rule and this inherits it.
        }
    }

    return {
        deliveryReadable   : true,
        deliveryReadReason : records.length > 0 ? 'observed' : 'no-records',
        subscriptions     : projectWakeDelivery(records)
    };
}
