import {pathToFileURL} from 'node:url';

import {armSeatWakePull, connectSeatPlane} from '../../../../daemons/wake/armSeatWakePull.mjs';
import {readSeatConfig}                    from '../seatConfig.mjs';

/**
 * The `timeout` this hook is registered with on `SessionStart` in `hooks/claude/events.manifest.json`,
 * which `projectSeatHooks` reconciles into the seat's `.claude/settings.json`. Two places hold the
 * number, so `projectSeatHooks.spec.mjs` asserts they agree.
 * @type {Number}
 */
export const HOOK_TIMEOUT_MS = 15000;

/**
 * Time left after the arming deadline to print the outcome and exit. The harness discards the output
 * of a hook it cancels at its timeout, so a slow plane must be reported before then, not killed.
 * @type {Number}
 */
export const REPORT_MARGIN_MS = 2000;

/**
 * @summary Arms this seat for pull at session start, reporting the outcome without ever failing the session.
 *
 * A Claude seat is woken by its own `wakeListenerHook`, which polls the seat's pull route. Arming makes
 * that the only route: it subscribes the pull route and unsubscribes the seat's routes that type into
 * a window (`armSeatWakePull`). Running on every session start keeps the switch idempotent and undoes
 * drift, such as a Fleet Start subscribing an `osascript` route again.
 *
 * **This is the entrypoint, and the only place config is resolved.** It reads the seat's plane and
 * identity (`seatConfig.readSeatConfig`) and injects them. An unconfigured plane is a NAMED SKIP, never
 * a localhost guess.
 *
 * @param {Object} [options]
 * @param {Object} [options.config] Injected `{planeBase, planeBearer, identity}`; read from the seat leaves when absent.
 * @param {Function} [options.connect=connectSeatPlane] Plane-session seam.
 * @param {Function} [options.arm=armSeatWakePull] Arming seam.
 * @returns {Promise<Object>} `{armed: true, identity, subscriptionId, retired}` or `{armed: false, reason}`.
 */
export async function armClaudeSeat({
    config,
    connect = connectSeatPlane,
    arm     = armSeatWakePull
} = {}) {
    const seat = await connect(config ?? await readSeatConfig());

    if (!seat.client) return {armed: false, reason: seat.reason};

    try {
        return {armed: true, identity: seat.identity, ...await arm({client: seat.client, identity: seat.identity})}
    } finally {
        await Promise.resolve(seat.client.close?.()).catch(() => {})
    }
}

/**
 * @summary Formats the arming outcome as the one stderr line the harness shows.
 * @param {Object} result An {@link armClaudeSeat} result.
 * @returns {String}
 */
export function describeArming(result) {
    if (!result?.armed) return `[WARN] [wake-arming] seat is UNARMED — ${result?.reason || 'no reason reported'}`;

    const retired = result.retired?.length
        ? `; unsubscribed ${result.retired.length} route(s) that typed into a window`
        : '';

    return `[INFO] [wake-arming] ${result.identity} armed for pull on ${result.subscriptionId}${retired}`
}

async function main() {
    const deadlineMs = HOOK_TIMEOUT_MS - REPORT_MARGIN_MS;

    // Never rejects: a seat that cannot arm still boots and says so on stderr, where the harness
    // captures it. Wake is an enhancement, not a precondition for starting work.
    const result = await Promise.race([
        armClaudeSeat().catch(error => ({armed: false, reason: `wake arming threw: ${error?.message || error}`})),
        new Promise(resolve => setTimeout(
            () => resolve({armed: false, reason: `arming did not finish within ${deadlineMs}ms`}),
            deadlineMs
        ).unref())
    ]);

    console.error(describeArming(result));

    // An unfinished exchange keeps sockets open; exit so the report lands before the harness timeout.
    process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
