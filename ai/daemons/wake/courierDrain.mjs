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
export const PLAN_STATUSES = ['ready', 'no-live-session', 'ambiguous', 'unaddressable-session', 'unreadable-entry', 'unroutable-entry'];

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
        planned = listOutboxEntries({outboxDir, fs: userFs}).map(row => planOne({...row, live, now}));

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
 * @param {String} params.file Absolute spool path; reduced to an opaque handle for the caller.
 * @param {Array<Object>} params.live Live registry rows.
 * @param {Function} params.now Clock.
 * @returns {Object} One plan row; `status` is one of {@link PLAN_STATUSES}.
 */
function planOne({entry, error, file, live, now}) {
    if (!entry) {
        // Surfaced, not swallowed, and deliberately NOT deleted: a file we cannot parse may still be
        // a wake somebody is waiting on, and this component is the last thing that should decide a
        // delivery is disposable.
        return {
            handle : path.basename(file),
            eventId: null,
            status : 'unreadable-entry',
            detail : `spool entry could not be read or parsed: ${error || 'unknown error'}`
        }
    }

    const base = {
        // The caller receives a NAME, never a path. A path handed back as `--handle` would be
        // authority: whatever it pointed at would be deleted. A basename can only ever resolve
        // inside the configured outbox, and is still authenticated by its persisted event id.
        handle      : path.basename(file),
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

    // `readSessionRegistry` normalizes a missing name to '', so a row can resolve and still carry no
    // address. `SendMessage` addresses BY NAME, so promoting this to `ready` would hand the courier a
    // plan it cannot execute — a failure that would surface as a send error rather than as a blocked
    // row naming its own cause.
    if (typeof session.name !== 'string' || !session.name) {
        return {
            ...base,
            status: 'unaddressable-session',
            detail: `session ${session.pid} under ${entry.targetCwd} carries no name to address`
        }
    }

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
 * @summary Resolves an opaque spool handle to a proven outbox entry, or refuses before any effect.
 *
 * Completion writes a receipt AND deletes a file, so its target has to be proven rather than
 * supplied. An absolute path accepted from the caller is authority: whatever it names is what gets
 * removed, and pairing a forged path with any event id would receipt one event while deleting an
 * unrelated file. Two independent facts are therefore required, both before anything is written:
 *
 * 1. the handle is a plain entry NAME that resolves to a direct child of the configured outbox, and
 * 2. the entry it names carries the very `eventId` being receipted.
 *
 * The regular-file check closes the remaining escape: a name cannot traverse, but a symlink planted
 * inside the outbox could still point outward, and `lstat` sees the link rather than its target.
 *
 * @param {Object} params
 * @param {String} params.outboxDir
 * @param {String} params.handle Opaque entry name from {@link planCourierPass}.
 * @param {String} params.eventId The event this completion claims to be for.
 * @param {Object} [params.fs] Injectable filesystem for hermetic tests.
 * @returns {String} Absolute path of the proven entry.
 * @protected
 */
function resolveOutboxEntry({outboxDir, handle, eventId, fs: userFs = fs}) {
    if (typeof handle !== 'string' || !handle || handle !== path.basename(handle) || !handle.endsWith('.json')) {
        throw new Error(`courier handle must be a plain .json entry name, got ${JSON.stringify(handle)}`)
    }

    const
        root = path.resolve(outboxDir),
        file = path.resolve(root, handle);

    if (path.dirname(file) !== root) {
        throw new Error(`courier handle must resolve inside ${root}, got ${file}`)
    }

    // A missing file must reach the readable-entry refusal below rather than surface as a raw
    // ENOENT, so absence is not an error here — only a present non-file is.
    let stats = null;

    try {
        stats = userFs.lstatSync?.(file)
    } catch {
        stats = null
    }

    if (stats && !stats.isFile()) {
        throw new Error(`courier handle ${handle} does not name a regular file`)
    }

    let parsed;

    try {
        parsed = JSON.parse(userFs.readFileSync(file, 'utf8'))
    } catch {
        throw new Error(`courier handle does not name a readable outbox entry: ${handle}`)
    }

    if (parsed?.eventId !== eventId) {
        throw new Error(`courier handle ${handle} carries event ${JSON.stringify(parsed?.eventId)}, not ${JSON.stringify(eventId)}`)
    }

    return file
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
 * @param {String} params.outboxDir
 * @param {String} params.handle Opaque entry name from {@link planCourierPass}.
 * @param {String} params.eventId
 * @param {String} params.outcome One of {@link RECEIPT_OUTCOMES}.
 * @param {String} [params.detail]
 * @param {Object} [params.fs] Injectable filesystem for hermetic tests.
 * @returns {{receipt: String, retired: Boolean}}
 */
export function recordCourierOutcome({outboxDir, receiptsDir, handle, eventId, outcome, detail = '', fs: userFs = fs}) {
    // Proven first. Every refusal happens before the receipt exists, so a rejected completion leaves
    // no trace and retires nothing.
    const file = resolveOutboxEntry({outboxDir, handle, eventId, fs: userFs});

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
        if (!args.handle || !args.eventId || !args.outcome) {
            console.error('complete requires --handle, --event-id and --outcome');
            return 2
        }

        if (!RECEIPT_OUTCOMES.includes(args.outcome)) {
            console.error(`--outcome must be one of ${RECEIPT_OUTCOMES.join(' / ')}`);
            return 2
        }

        // A refused completion is an ordinary non-zero exit with the reason, not a stack trace: the
        // courier is a session reading this output, and it must be able to tell "you may not do that"
        // from "the tool broke".
        try {
            console.log(JSON.stringify(recordCourierOutcome({
                outboxDir,
                receiptsDir,
                handle : args.handle,
                eventId: args.eventId,
                outcome: args.outcome,
                detail : typeof args.detail === 'string' ? args.detail : ''
            }), null, 4))
        } catch (error) {
            console.error(`complete refused: ${error.message}`);
            return 2
        }

        return 0
    }

    console.error('usage: courierDrain.mjs list | complete --handle <entry> --event-id <id> --outcome <outcome> [--detail <text>]');
    return 2
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    process.exitCode = runCourierCli(process.argv.slice(2))
}
