import {execFile}      from 'node:child_process';
import fsPromises      from 'node:fs/promises';
import os              from 'node:os';
import path            from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify}     from 'node:util';

import {connectSeatPlane, resolvePullRoute, seatPlaneGap} from '../../../../daemons/wake/armSeatWakePull.mjs';
import {toBareIdentity}                                   from '../../../../daemons/wake/armSeatWakeRoute.mjs';
import {withOutboxLock}                                   from '../../../../daemons/wake/outboxLock.mjs';
import {readHookPayload}                                  from '../../../../mcp/server/memory-core/helpers/TurnPresenceHookWriter.mjs';
import {readSeatConfig}                                   from './wakeArmingHook.mjs';

const execFileAsync = promisify(execFile);

/**
 * Where each seat's listener record lives: one file per identity, beside the receiver's own state, and
 * outside every checkout, because a seat's sessions may run in several.
 * @type {String}
 */
export const LISTENER_STATE_RELATIVE = 'Library/Application Support/Neo/AgentOS/wake/listeners';

/**
 * How often the owning listener polls. Each poll stamps `lastPollAt` on the subscription, which the
 * graph logs as one row, so the cadence is a cost as well as a latency.
 * @type {Number}
 */
export const POLL_INTERVAL_MS = 15000;

/**
 * Ceiling for the doubling back-off after a failed connect or poll.
 * @type {Number}
 */
export const MAX_BACKOFF_MS = 120000;

/**
 * Executables the harness may run a hook command through before it reaches `node`.
 * @type {Set<String>}
 */
const SHELLS = new Set(['bash', 'dash', 'env', 'fish', 'ksh', 'sh', 'zsh']);

/**
 * @summary Reads a process's parent, start time and command, or `null` once it is gone.
 *
 * The start time makes a pid an identity: a reused pid starts later, so it never matches a record.
 * @param {Number} pid
 * @param {Object} [options]
 * @param {Function} [options.exec=execFileAsync]
 * @returns {Promise<Object|null>} `{pid, ppid, startedAt, command}`
 */
export async function readProcess(pid, {exec = execFileAsync} = {}) {
    try {
        const {stdout} = await exec('ps', ['-o', 'ppid=,lstart=,command=', '-p', String(pid)], {env: {...process.env, LC_ALL: 'C'}}),
              match    = stdout.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);

        return match ? {pid, ppid: Number(match[1]), startedAt: match[2].replace(/\s+/g, ' '), command: match[3]} : null
    } catch {
        // `ps -p` exits non-zero for a pid that does not exist.
        return null
    }
}

/**
 * @summary Finds the harness session this hook runs under: the nearest ancestor that is not a shell.
 *
 * The harness runs a hook command through a shell, which may or may not exec into `node`, so the
 * parent is either the session or a shell beneath it. Each Claude Code session is its own long-lived
 * process, so its pid and start time name the session's life.
 * @param {Object} [options]
 * @param {Number} [options.ppid=process.ppid]
 * @param {Function} [options.read=readProcess]
 * @returns {Promise<Object|null>}
 */
export async function findSessionProcess({ppid = process.ppid, read = readProcess} = {}) {
    let pid = ppid;

    for (let depth = 0; pid > 1 && depth < 8; depth++) {
        const proc = await read(pid);

        if (!proc) return null;
        if (!SHELLS.has(path.basename(proc.command.split(/\s+/)[0]))) return proc;

        pid = proc.ppid
    }

    return null
}

/**
 * @summary Is the process a record names still the same live process?
 * @param {Object} [proc] `{pid, startedAt}`
 * @param {Function} [read=readProcess]
 * @returns {Promise<Boolean>}
 */
export async function isLive(proc, read = readProcess) {
    return Boolean(proc?.pid) && (await read(proc.pid))?.startedAt === proc.startedAt
}

/**
 * @summary Decides what one hook run does with the seat. Pure.
 *
 * The newest live session owns the seat. A newcomer takes it from an older or dead owner. An owning
 * session whose listener is already running arms nothing new, so a second `Stop` is a no-op. Owning
 * needs the recorded process alive: a resumed session keeps its id and may get the old PID back.
 * @param {Object} options
 * @param {Object|null} options.record The seat's listener record.
 * @param {Object} options.me `{sessionId, session: {pid, startedAt}}`
 * @param {Object} options.live `{owner, listener}` — whether the record's session and listener still run.
 * @returns {String} `listen`, `superseded` or `already-listening`.
 */
export function decideClaim({record, me, live}) {
    const owner = record?.owner;

    if (owner && owner.sessionId !== me.sessionId && live.owner &&
        Date.parse(owner.session.startedAt) >= Date.parse(me.session.startedAt)) {
        return 'superseded'
    }

    if (owner?.sessionId === me.sessionId && owner.session.pid === me.session.pid && live.owner && live.listener) {
        return 'already-listening'
    }

    return 'listen'
}

async function readRecord(statePath, fs) {
    try {
        return JSON.parse(await fs.readFile(statePath, 'utf8'))
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error
    }
}

async function writeRecord(statePath, record, fs) {
    const temp = `${statePath}.${process.pid}.tmp`;

    await fs.writeFile(temp, JSON.stringify(record, null, 2), 'utf8');
    await fs.rename(temp, statePath)
}

/**
 * @summary Runs this session's listener until it has a digest to wake with, or a reason to stop.
 *
 * One record per seat holds the owning session, its listener and the watermark, so a newer session
 * inherits where the last one stopped. A watermark is a position in one plane's GraphLog, so it is kept
 * with the plane that wrote it, and a session on another plane starts from a fresh baseline instead.
 * The record is only read and written under its lock, and never held across a network call.
 *
 * Polling stops with `exit: 0` when the plane is not configured, when the seat belongs to a newer
 * session, or when this session has ended. It returns `exit: 2` only with a digest, and only for
 * events past a stored watermark: a first poll records the baseline, because a seat's backlog is not
 * news. A credential the plane refuses for this seat stops it by name; any other connect or poll
 * failure backs off and retries.
 *
 * @param {Object} options
 * @param {Object} options.payload The hook's stdin: `session_id` names the session.
 * @param {String} [options.homeDir=os.homedir()]
 * @param {Object} [options.config] Injected `{planeBase, planeBearer, identity}`; read from `AiConfig` when absent.
 * @param {Function} [options.connect=connectSeatPlane]
 * @param {Function} [options.resolveRoute=resolvePullRoute]
 * @param {Function} [options.findSession=findSessionProcess]
 * @param {Function} [options.read=readProcess]
 * @param {Function} [options.lock=withOutboxLock]
 * @param {Object} [options.fs=fsPromises]
 * @param {Function} [options.sleep]
 * @param {Number} [options.pid=process.pid] This listener.
 * @param {Number} [options.pollIntervalMs=POLL_INTERVAL_MS]
 * @param {Number} [options.maxBackoffMs=MAX_BACKOFF_MS]
 * @returns {Promise<Object>} `{exit: 2, digest}` or `{exit: 0, reason}`.
 */
export async function runListener({
    payload,
    homeDir        = os.homedir(),
    config,
    connect        = connectSeatPlane,
    resolveRoute   = resolvePullRoute,
    findSession    = findSessionProcess,
    read           = readProcess,
    lock           = withOutboxLock,
    fs             = fsPromises,
    sleep          = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pid            = process.pid,
    pollIntervalMs = POLL_INTERVAL_MS,
    maxBackoffMs   = MAX_BACKOFF_MS
} = {}) {
    const sessionId = payload?.session_id;

    if (typeof sessionId !== 'string' || !sessionId) return {exit: 0, reason: 'the hook payload names no session_id'};

    const seat = config ?? await readSeatConfig(),
          gap  = seatPlaneGap(seat);

    if (gap) return {exit: 0, reason: gap};

    const session = await findSession({read});

    if (!session) return {exit: 0, reason: 'the session process this hook runs under could not be named'};

    const me        = {sessionId, session: {pid: session.pid, startedAt: session.startedAt}},
          listener  = {pid, startedAt: (await read(pid))?.startedAt},
          source    = String(seat.planeBase).trim().replace(/\/+$/, ''),
          statePath = path.join(homeDir, LISTENER_STATE_RELATIVE, `${toBareIdentity(seat.identity)}.json`),
          mine      = record => record?.owner?.sessionId === sessionId && record.listener?.pid === pid;

    await fs.mkdir(path.dirname(statePath), {recursive: true});

    const decision = await lock(statePath, async () => {
        const record = await readRecord(statePath, fs),
              live   = {owner: await isLive(record?.owner?.session, read), listener: await isLive(record?.listener, read)},
              claim  = decideClaim({record, me, live});

        if (claim === 'listen') {
            await writeRecord(statePath, {
                ...record, owner: me, listener, ...(record?.source === source ? {} : {source, watermark: null})
            }, fs)
        }

        return claim
    });

    if (decision !== 'listen') return {exit: 0, reason: decision};

    // `wakeArmingHook` runs beside this one at session start and subscribes the same route. `subscribe`
    // checks and creates in two steps, so give it the head start rather than race it into a duplicate.
    if (payload.hook_event_name === 'SessionStart') await sleep(pollIntervalMs);

    let backoff = 0, client = null, subscriptionId = null;

    try {
        for (;;) {
            const record = await lock(statePath, () => readRecord(statePath, fs));

            if (!mine(record))                return {exit: 0, reason: 'superseded'};
            if (!await isLive(me.session, read)) return {exit: 0, reason: 'its session ended'};

            try {
                if (!client) {
                    const session = await connect(seat);

                    if (session.refused) return {exit: 0, reason: session.reason};
                    if (!session.client) throw new Error(session.reason);

                    client         = session.client;
                    subscriptionId = await resolveRoute({client})
                }

                const baseline = record.watermark == null,
                      answer   = await client.callTool('manage_wake_subscription', {
                          action    : 'poll-digest',
                          sinceLogId: baseline ? 0 : record.watermark,
                          subscriptionId
                      }),
                      wake     = !baseline && answer.pending > 0 && typeof answer.digest === 'string';

                // Re-read before writing: a newer session that claimed during the poll keeps the old
                // watermark, and so receives these events itself.
                const kept = await lock(statePath, async () => {
                    const current = await readRecord(statePath, fs);

                    if (!mine(current)) return false;

                    await writeRecord(statePath, {
                        ...current,
                        watermark: answer.watermark ?? current.watermark,
                        listener : wake ? null : current.listener
                    }, fs);

                    return true
                });

                if (!kept) return {exit: 0, reason: 'superseded'};
                if (wake)  return {exit: 2, digest: answer.digest};

                backoff = 0;
                await sleep(pollIntervalMs)
            } catch {
                await Promise.resolve(client?.close?.()).catch(() => {});
                client  = null;
                backoff = Math.min(maxBackoffMs, backoff ? backoff * 2 : pollIntervalMs);
                await sleep(backoff)
            }
        }
    } finally {
        await Promise.resolve(client?.close?.()).catch(() => {})
    }
}

async function main() {
    let payload = null;

    try {
        payload = JSON.parse(await readHookPayload())
    } catch {
        // No payload means no session_id, which runListener reports.
    }

    const outcome = await runListener({payload})
        .catch(error => ({exit: 0, reason: `the listener threw: ${error?.message || error}`}));

    if (outcome.exit === 2) {
        // Exit 2 makes the harness wake the session with stderr as a system reminder. Write the digest
        // exactly, and exit only once it is flushed: a pipe on macOS is written asynchronously.
        process.stderr.write(outcome.digest, () => process.exit(2));
        return
    }

    console.error(`[INFO] [wake-listener] stopped: ${outcome.reason}`);
    process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
