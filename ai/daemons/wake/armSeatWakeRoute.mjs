import fsPromises   from 'node:fs/promises';
import os           from 'node:os';
import path         from 'node:path';
import {randomUUID} from 'node:crypto';

import {runManifestBuilder, wakeRouteWithdrawalReasonFor} from './buildReceiverManifest.mjs';

/**
 * Per-harness parent directory holding one GUI instance directory per seat, keyed by bare identity.
 *
 * These are the two conventions in use on the fleet today (`~/.claude-instances/neo-opus-vega`,
 * `~/.codex-instances/neo-gpt-emmy`). A seat whose directory is absent produces a NAMED SKIP rather
 * than a guessed address — the manifest builder refuses an `osascript` route without an explicit
 * tuple precisely because a guessed one wakes the wrong seat on a multi-instance host, and a wrong
 * route is worse than no route. Note the Claude parent also contains a non-identity `Neo` directory,
 * so existence of the parent proves nothing about a given seat.
 * @type {Object}
 */
export const INSTANCE_DIR_BY_HARNESS = Object.freeze({
    claude: '.claude-instances',
    codex : '.codex-instances',
    // A seat's OpenCode instance dir is a symlink to its real data home, so the string the
    // resolver matches in `--user-data-dir=` and the string the manifest publishes are the
    // same one, while the app keeps reading and writing where its data actually lives.
    // Bridge, not a destination: the pre-layout instance paths are being retired in favour of
    // the Fleet seat layout, and GUI seats are migrating onto a session hook instead.
    opencode: '.opencode-instances'
});

/**
 * The adapter this arming path exists to produce. Every harness in {@link INSTANCE_DIR_BY_HARNESS}
 * is a GUI harness, and the reason the arm carries a `userDataDir` tuple instead of a pid or a port
 * is restart durability. Named as a constant because the adapter is declared by the subscription
 * rather than by this module, so arming can only VERIFY the switch, never perform it.
 * @type {String}
 */
export const ARMED_ADAPTER = 'osascript';

/**
 * `userDataDir` rather than `pid`: a pid tuple is invalidated by the next harness restart, which is
 * the exact event this arming path exists to survive.
 * @type {String}
 */
export const INSTANCE_TYPE = 'userDataDir';

/**
 * @summary Strips a leading `@` so an identity can address a filesystem directory.
 * @param {String} identity Either `@neo-opus-vega` or `neo-opus-vega`.
 * @returns {String|null}
 */
export function toBareIdentity(identity) {
    if (typeof identity !== 'string') return null;

    const trimmed = identity.trim();
    return trimmed ? trimmed.replace(/^@/, '') : null
}

/**
 * @summary Derives the seat's GUI instance tuple from the live boot environment, or names why it cannot.
 *
 * Derivation is candidate-then-verify, never candidate-alone: the directory must exist on disk before
 * the tuple is returned. An absent directory is reported as a skip with a reason, so a caller emits
 * "unarmed, because X" instead of publishing a route pointed at a seat that is not there.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] Environment source.
 * @param {String} [options.harness='claude'] Key into `INSTANCE_DIR_BY_HARNESS`.
 * @param {String} [options.homeDir] Overrides `os.homedir()` for deterministic tests.
 * @param {Object} [options.fs=fsPromises] Filesystem seam.
 * @returns {Promise<{instanceType: String, instanceAddress: String, identity: String}|{skipped: true, reason: String}>}
 */
export async function resolveInstanceTuple({
    env     = process.env,
    harness = 'claude',
    homeDir = os.homedir(),
    fs      = fsPromises
} = {}) {
    const identity = toBareIdentity(env.NEO_AGENT_IDENTITY);

    if (!identity) {
        return {skipped: true, reason: 'NEO_AGENT_IDENTITY is not set, so the seat cannot name itself'};
    }

    const parentName = INSTANCE_DIR_BY_HARNESS[harness];

    if (!parentName) {
        return {skipped: true, reason: `no instance-directory convention is known for harness '${harness}'`};
    }

    const instanceAddress = path.join(homeDir, parentName, identity);

    try {
        const stats = await fs.stat(instanceAddress);

        if (!stats.isDirectory()) {
            return {skipped: true, reason: `${instanceAddress} exists but is not a directory`};
        }
    } catch {
        return {skipped: true, reason: `${instanceAddress} does not exist, so the tuple would be a guess`};
    }

    return {identity: `@${identity}`, instanceAddress, instanceType: INSTANCE_TYPE}
}

/**
 * @summary Checks a caller-supplied instance tuple the way {@link resolveInstanceTuple} checks its own:
 * a seat that cannot name itself, or an address that is not absolute, is a named skip, never a route.
 * @param {Object} tuple `{identity, instanceAddress, instanceType}`
 * @returns {{identity: String, instanceAddress: String, instanceType: String}|{skipped: true, reason: String}}
 */
export function validateKnownTuple({identity, instanceAddress, instanceType} = {}) {
    const bare = toBareIdentity(identity);

    if (!bare) {
        return {skipped: true, reason: 'the supplied tuple names no identity'};
    }

    if (instanceType !== INSTANCE_TYPE || typeof instanceAddress !== 'string' || !path.isAbsolute(instanceAddress)) {
        return {skipped: true, reason: `the supplied tuple is not an absolute ${INSTANCE_TYPE} address`};
    }

    return {identity: `@${bare}`, instanceAddress, instanceType}
}

/**
 * @summary Arms this seat's wake route: publishes its subscriptions into the receiver manifest.
 *
 * **Subscriptions are read over the Memory Core's MCP surface, never by opening a graph database by
 * path.** A host process cannot reach the containerized Memory Core's SQLite at all — that database
 * is a Docker named volume whose data lives inside the Docker Desktop VM — so a file read resolves
 * to a *different*, diverged store and succeeds while returning the wrong route set — measured: a
 * deliverable webhook route absent, retired relics still reading active. The builder's own contract
 * anticipates this by staying graphless and requiring the caller to hold an authenticated session.
 *
 * Publishing is the whole job. The receiver watches its manifest's directory, so a successful publish
 * is itself the reload trigger — there is no signal step to forget.
 *
 * Fail-soft by construction: every failure path returns a reason and none throws, because a seat that
 * cannot arm must still boot. Wake is an enhancement, not a precondition.
 *
 * Idempotent: the builder starts from what is already published and merges additively, so re-running
 * neither duplicates this seat's route nor withdraws a peer's.
 *
 * @param {Object} options
 * @param {Function} options.listSubscriptions Returns this seat's subscription records (the MCP call).
 * @param {String} options.manifestPath Absolute manifest destination the receiver reads.
 * @param {Object} [options.tuple] An already-known `{identity, instanceAddress, instanceType}`. A
 *     caller that launched the seat knows the address its window runs at, so the convention-directory
 *     derivation is skipped rather than allowed to guess a different one.
 * @param {Object} [options.env=process.env] Environment source.
 * @param {String} [options.harness='claude'] Harness key for tuple derivation.
 * @param {String} [options.homeDir] Overrides `os.homedir()` for deterministic tests.
 * @param {Object} [options.fs=fsPromises] Filesystem seam.
 * @param {Function} [options.runBuilder=runManifestBuilder] Publish seam.
 * @param {String} [options.tmpDir] Overrides the OS temp directory.
 * @param {Object} [options.logger=console]
 * @returns {Promise<Object>} `armed` whether a route was published · `reason` why not, when it was not ·
 * `identity` the seat, once derived · `routeCount` routes published · `subscriptionIds` which ones, when
 * armed · `skipped` the builder's named skips.
 */
export async function armSeatWakeRoute({
    listSubscriptions,
    manifestPath,
    tuple: knownTuple,
    adapterConfigById,
    desiredSubscriptionId,
    desiredAdapter,
    env        = process.env,
    harness    = 'claude',
    homeDir,
    fs         = fsPromises,
    runBuilder = runManifestBuilder,
    tmpDir     = os.tmpdir(),
    logger     = console
} = {}) {
    if (typeof listSubscriptions !== 'function') {
        return {armed: false, reason: 'no subscription reader was supplied'};
    }

    if (!manifestPath) {
        return {armed: false, reason: 'no manifest path was supplied'};
    }

    const tuple = knownTuple
        ? validateKnownTuple(knownTuple)
        : await resolveInstanceTuple({env, fs, harness, homeDir});

    if (tuple.skipped) {
        return {armed: false, reason: tuple.reason};
    }

    let subscriptionsPath;

    try {
        const subscriptions = await listSubscriptions({identity: tuple.identity});

        if (!Array.isArray(subscriptions)) {
            return {armed: false, reason: 'the subscription reader returned no array, so the set is unverifiable'};
        }

        // The subscription set is scoped by the AUTHENTICATED identity (whose credential the reader
        // presented), while the instance tuple is derived from this seat's environment. Those are two
        // different facts and nothing upstream makes them agree — presenting another seat's token
        // returns THAT seat's subscriptions, which the builder would then publish against THIS seat's
        // address. Measured: a run holding a peer's token published the peer's subscription pointed at
        // my own userDataDir, i.e. the wrong-seat mis-wake the builder refuses a guessed tuple to avoid.
        // Fail closed on disagreement rather than filtering silently: a mismatch means the credential
        // and the seat disagree about who this is, and no route should be published under that doubt.
        const foreign = subscriptions.filter(record => {
            const owner = toBareIdentity(record?.agentIdentity);
            return owner && owner !== toBareIdentity(tuple.identity)
        });

        if (foreign.length) {
            const owners = [...new Set(foreign.map(record => record.agentIdentity))].join(', ');

            return {
                armed   : false,
                identity: tuple.identity,
                reason  : `the authenticated credential returned subscriptions owned by ${owners}, not ${tuple.identity} — refusing to publish another seat's route against this seat's address`
            };
        }

        // A temp file rather than stdin: the builder accepts either, and a path keeps the failing input
        // inspectable when a publish goes wrong.
        subscriptionsPath = path.join(tmpDir, `neo-wake-arm-${randomUUID()}.json`);
        await fs.writeFile(subscriptionsPath, JSON.stringify(subscriptions), 'utf8');

        const result = await runBuilder({
            identity       : tuple.identity,
            instanceAddress: tuple.instanceAddress,
            instanceType   : tuple.instanceType,
            logger,
            manifestPath,
            subscriptionsPath,
            adapterConfigById
        });

        // "The builder returned" is NOT "this seat is reachable". The builder withdraws the caller's own
        // absent route while preserving every peer's, so an empty subscription set publishes a manifest
        // that still has nine healthy-looking routes and none of them this seat's — reporting `armed` on
        // that recreates the exact lie this whole path exists to remove: infrastructure that reads fine
        // while the seat cannot be woken. Admission needs a published route OWNED BY this seat, not a
        // successful call. Counting `routeSummaries` alone is not enough either: it is the merged table,
        // so a peer's surviving route would otherwise be counted as evidence of mine.
        const ownRoutes = (result?.routeSummaries ?? []).filter(route =>
            toBareIdentity(route?.agentIdentity) === toBareIdentity(tuple.identity)
        );

        const nativeIds = new Set(subscriptions.filter(row => row?.harnessTargetMetadata?.adapter === 'primary-session' &&
            !wakeRouteWithdrawalReasonFor(row)).map(row => row.id));
        const refusedNative = (result?.skipped ?? []).find(row => nativeIds.has(row.subscriptionId));
        if (refusedNative) {
            return {armed: false, identity: tuple.identity, routeCount: ownRoutes.length,
                reason: `native route ${refusedNative.subscriptionId} was not admitted`, skipped: result.skipped}
        }

        if (!ownRoutes.length) {
            return {
                armed     : false,
                identity  : tuple.identity,
                routeCount: 0,
                reason    : `the publish succeeded but produced no route owned by ${tuple.identity} — this seat is NOT reachable`,
                skipped   : result?.skipped ?? []
            };
        }

        if (desiredSubscriptionId && !ownRoutes.some(route => route.subscriptionId === desiredSubscriptionId)) {
            return {armed: false, identity: tuple.identity, routeCount: ownRoutes.length,
                reason: `the publish carried no route for ${desiredSubscriptionId}`, skipped: result?.skipped ?? []}
        }
        if (desiredSubscriptionId && !['osascript', 'primary-session'].includes(desiredAdapter)) {
            return {armed: false, identity: tuple.identity, routeCount: ownRoutes.length,
                reason: 'the desired subscription adapter is invalid', skipped: result?.skipped ?? []}
        }

        // Check every published own route, not the requested subscription's input alone. Fleet may
        // retain a separately host-admitted native wake beside a GUI rotation; all other adapters,
        // including a missing one, fail closed. Untargeted legacy callers remain osascript-only.
        const publishedAdapters = [...new Set(ownRoutes
            .map(route => route?.adapter)
            .filter(Boolean))];
        const nonArmedRoutes = ownRoutes.filter(route => {
            const expected = route.subscriptionId === desiredSubscriptionId ? desiredAdapter : null;
            if (expected && route.adapter !== expected) return true;
            if (route.adapter === ARMED_ADAPTER) return false;
            return route.adapter !== 'primary-session' || !desiredSubscriptionId || !route.hostNativeAdmitted ||
                (expected === 'primary-session' && !adapterConfigById?.[route.subscriptionId]?.primarySession)
        });

        if (nonArmedRoutes.length) {
            const foreignAdapters = publishedAdapters.filter(adapter => adapter !== ARMED_ADAPTER);

            // Two named shapes, because they need different repairs: a single stale route is a
            // mis-pointed subscription, while a mixed set means the seat is half-migrated.
            const reason = desiredSubscriptionId
                ? `published routes for ${tuple.identity} do not satisfy the requested ${desiredAdapter} route ${desiredSubscriptionId} or a separately host-admitted native route`
                : publishedAdapters.length > 1
                ? `${nonArmedRoutes.length} of ${ownRoutes.length} route(s) for ${tuple.identity} are published on adapter '${foreignAdapters.join(', ')}' while arming harness '${harness}' arms '${ARMED_ADAPTER}' — this is a MIXED route set, and a seat with any route on another adapter is NOT reliably reachable; the delivery path was NOT switched for those routes, so update EVERY subscription for this seat to '${ARMED_ADAPTER}' with this instanceAddress and re-arm`
                : `the route for ${tuple.identity} is published on adapter '${publishedAdapters.join(', ') || 'none'}', but arming harness '${harness}' arms '${ARMED_ADAPTER}' — the instance tuple was derived and the delivery path was NOT switched; update the subscription's adapter to '${ARMED_ADAPTER}' with this instanceAddress and re-arm`;

            return {
                armed     : false,
                identity  : tuple.identity,
                routeCount: ownRoutes.length,
                adapter   : publishedAdapters.join(', ') || 'none',
                reason,
                skipped   : result?.skipped ?? []
            };
        }

        return {
            armed          : true,
            identity       : tuple.identity,
            routeCount     : ownRoutes.length,
            subscriptionIds: ownRoutes.map(route => route.subscriptionId),
            adapter        : desiredAdapter || ARMED_ADAPTER,
            skipped        : result?.skipped ?? []
        }
    } catch (error) {
        return {armed: false, identity: tuple.identity, reason: `arming failed: ${error?.message || error}`};
    } finally {
        if (subscriptionsPath) {
            // The file carries subscription records; remove it rather than leaving it in a world-readable
            // temp directory for the lifetime of the host.
            await fs.rm(subscriptionsPath, {force: true}).catch(() => {});
        }
    }
}
