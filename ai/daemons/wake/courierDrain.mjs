/**
 * @summary The courier half of the focus-free wake transport: plans a drain pass over the spool
 * and records the outcome of each delivery, so a wake is observable end to end instead of trusted
 * on silence.
 *
 * **Why this is a CLI and not a daemon.** Delivery happens through `SendMessage`, which is a
 * Claude Code *tool* rather than a Node API — no host process can call it. The courier is
 * therefore a long-lived Claude session, and this module is the surface it drives: `list` hands
 * it a ready-to-send plan, the session performs the sends with its own tool, and `complete`
 * records what happened. Splitting it this way keeps every filesystem invariant (atomicity,
 * ordering, path safety) in testable Node code and leaves the session with only the one step it
 * alone can do.
 *
 * **Why the pass re-resolves instead of trusting the spool.** {@link deliverClaudeCourier} writes
 * `targetPid` and `targetSocket` as they looked at *enqueue* time, and both are ephemeral: a seat
 * can exit and restart between spooling and draining, and pids are reused. Addressing a wake by a
 * snapshotted pid would deliver one seat's coordination traffic into whatever now holds that
 * number — a misdelivery, which is strictly worse than the non-delivery this transport replaces.
 * So the pass re-resolves from `targetCwd`, which is the *stable* half of the binding, and treats
 * the snapshotted pid purely as staleness telemetry. Snapshot what is stable, re-resolve what is
 * ephemeral.
 *
 * **What this module will not do.** It never decides that an unresolvable entry is undeliverable
 * and quietly drops it. An entry stays in the outbox until a caller records an explicit outcome,
 * because the only thing worse than a late wake is a wake that was silently discarded by the
 * component whose entire purpose is proving delivery.
 *
 * @see ai/daemons/wake/claudeCourierTransport.mjs — the producer half and the shared primitives
 */

import fs   from 'fs';
import os   from 'os';
import path from 'path';

import {
    RECEIPT_OUTCOMES,
    completeOutboxEntry,
    defaultCourierDirs,
    listOutboxEntries,
    readSessionRegistry,
    resolveSessionForIdentity,
    writeCourierReceipt
} from './claudeCourierTransport.mjs';

/**
 * Per-entry plan states. `ready` is the only one a courier may send; every other value names a
 * reason the entry could not be addressed, in the caller's vocabulary rather than an exception.
 * @type {String[]}
 */
export const PLAN_STATUSES = ['ready', 'no-live-session', 'ambiguous', 'unroutable-entry'];

/**
 * @summary Plans one drain pass: what the courier should send, and what it must not.
 *
 * Resolution reuses {@link resolveSessionForIdentity} through a single-binding table rather than
 * re-implementing prefix matching. That is deliberate — the prefix rule and its fail-closed tie
 * handling are the parts most likely to misroute, and a second copy of them would be a second
 * chance to get them subtly different. A worktree session running inside a seat's clone resolves
 * here for exactly the same reason it resolves at enqueue time.
 *
 * @param {Object} params
 * @param {String} params.outboxDir Spool directory to plan over.
 * @param {Array<{pid: Number, cwd: String, name: String}>} [params.sessions] Live registry rows;
 *   read from the default registry when omitted.
 * @param {Object} [params.fs] Injectable filesystem for hermetic tests.
 * @param {Function} [params.homedir] Injectable home resolver for hermetic tests.
 * @param {Function} [params.now] Injectable clock, for deterministic ages.
 * @returns {{entries: Object[], readyCount: Number, blockedCount: Number}}
 */
export function planCourierPass({outboxDir, sessions, fs: userFs = fs, homedir = os.homedir, now = Date.now}) {
    const
        live    = Array.isArray(sessions) ? sessions : readSessionRegistry({fs: userFs, sessionsDir: path.join(homedir(), '.claude/sessions')}),
        planned = listOutboxEntries({outboxDir, fs: userFs}).map(({entry, file}) => planOne({entry, file, live, now}));

    return {
        entries     : planned,
        readyCount  : planned.filter(item => item.status === 'ready').length,
        blockedCount: planned.filter(item => item.status !== 'ready').length
    }
}

/**
 * @summary Plans a single spool entry against the live session registry.
 * @param {Object} params
 * @param {Object} params.entry Parsed spool entry.
 * @param {String} params.file Absolute spool path, the handle `complete` takes back.
 * @param {Array<Object>} params.live Live registry rows.
 * @param {Function} params.now Clock.
 * @returns {Object} One plan row; `status` is one of {@link PLAN_STATUSES}.
 */
function planOne({entry, file, live, now}) {
    const base = {
        file,
        eventId     : entry?.eventId || null,
        identity    : entry?.targetIdentity || null,
        subject     : entry?.subject || '',
        pidAtEnqueue: entry?.targetPid ?? null,
        ageMs       : entry?.enqueuedAt ? Math.max(0, now() - Date.parse(entry.enqueuedAt)) : null
    };

    // A pre-`targetCwd` entry cannot be re-resolved, and guessing from `targetIdentity` would mean
    // re-deriving a binding whose authority lives on the route. Reported, never inferred.
    if (!base.identity || !entry?.targetCwd || typeof entry.digest !== 'string') {
        return {
            ...base,
            status: 'unroutable-entry',
            detail: !base.identity      ? 'entry carries no targetIdentity'
                  : !entry?.targetCwd   ? 'entry carries no targetCwd; it predates re-resolvable spooling and must be dispositioned by hand'
                  :                       'entry carries no string digest'
        }
    }

    const resolution = resolveSessionForIdentity({
        identity: base.identity,
        map     : [{identity: base.identity, cwd: entry.targetCwd}],
        sessions: live
    });

    if (resolution.status === 'no-live-session') {
        return {...base, status: 'no-live-session', detail: `no live session under ${entry.targetCwd}`}
    }

    if (resolution.status === 'ambiguous') {
        return {
            ...base,
            status: 'ambiguous',
            detail: `${resolution.candidates.length} equally deep sessions under ${entry.targetCwd}: ${resolution.candidates.map(candidate => candidate.pid).join('+')}`
        }
    }

    const {session} = resolution;

    // A name is never carried across the spool hop — it is read here, at send time, from the live
    // registry. Names are derived per session and change when a seat restarts, so a cached one can
    // come to belong to a different seat entirely.
    return {
        ...base,
        status     : 'ready',
        sessionName: session.name,
        pidNow     : session.pid,
        // Not an error: the seat restarted and the wake is still for that seat. Surfaced so a
        // receipt can say so, because "delivered to a different process than we spooled for" is
        // exactly the kind of detail that is obvious in hindsight and invisible in a log.
        pidChanged: base.pidAtEnqueue !== null && base.pidAtEnqueue !== session.pid,
        message   : entry.digest
    }
}

/**
 * @summary Records one delivery outcome and retires the spool entry.
 *
 * **The write order is the crash-safety property.** The receipt is written first and the spool
 * entry removed second, so a crash in between leaves the entry to be re-drained and the receipt to
 * be overwritten — receipts are explicitly latest-outcome records, so a repeat is harmless. The
 * reverse order would retire the entry and lose the proof, turning a crash into a wake that is
 * both undelivered and unrecorded.
 *
 * @param {Object} params
 * @param {String} params.receiptsDir
 * @param {String} params.file Spool path from {@link planCourierPass}.
 * @param {String} params.eventId
 * @param {String} params.outcome One of {@link RECEIPT_OUTCOMES}.
 * @param {String} [params.detail]
 * @param {Object} [params.fs] Injectable filesystem for hermetic tests.
 * @returns {{receipt: String, retired: Boolean}}
 */
export function recordCourierOutcome({receiptsDir, file, eventId, outcome, detail = '', fs: userFs = fs}) {
    const {file: receipt} = writeCourierReceipt({receiptsDir, eventId, outcome, detail, fs: userFs});

    // A transient outcome keeps its entry: the seat may be back on the next pass, and discarding
    // the wake here would be this transport making the very failure it exists to remove.
    const retire = outcome !== 'error';

    retire && completeOutboxEntry({file, fs: userFs});

    return {receipt, retired: retire}
}

/**
 * @summary Minimal flag parser for the courier CLI.
 * @param {String[]} argv
 * @returns {Object}
 */
function parseArgs(argv) {
    const out = {};

    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;

        const key = argv[i].slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());

        out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }

    return out
}

/**
 * @summary CLI entry point: `list` prints a drain plan as JSON, `complete` records one outcome.
 * @param {String[]} argv
 * @returns {Number} Process exit code.
 */
export function runCourierCli(argv) {
    const
        [command]   = argv,
        args        = parseArgs(argv.slice(1)),
        dirs        = defaultCourierDirs(),
        outboxDir   = args.outboxDir   || dirs.outboxDir,
        receiptsDir = args.receiptsDir || dirs.receiptsDir;

    if (command === 'list') {
        console.log(JSON.stringify(planCourierPass({outboxDir}), null, 4));
        return 0
    }

    if (command === 'complete') {
        if (!args.file || !args.eventId || !args.outcome) {
            console.error('complete requires --file, --event-id and --outcome');
            return 2
        }

        if (!RECEIPT_OUTCOMES.includes(args.outcome)) {
            console.error(`--outcome must be one of ${RECEIPT_OUTCOMES.join(' / ')}`);
            return 2
        }

        console.log(JSON.stringify(recordCourierOutcome({
            receiptsDir,
            file   : args.file,
            eventId: args.eventId,
            outcome: args.outcome,
            detail : typeof args.detail === 'string' ? args.detail : ''
        }), null, 4));

        return 0
    }

    console.error('usage: courierDrain.mjs list | complete --file <path> --event-id <id> --outcome <outcome> [--detail <text>]');
    return 2
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    process.exitCode = runCourierCli(process.argv.slice(2))
}
