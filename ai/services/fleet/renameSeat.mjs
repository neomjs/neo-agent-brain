import crypto                                                         from 'node:crypto';
import fs                                                             from 'node:fs/promises';
import path                                                           from 'node:path';
import {carrySeatSessions}                                            from './carrySeatSessions.mjs';
import {deriveAgentInstanceHome}                                      from './deriveAgentInstanceHome.mjs';
import {assertSeatSegment}                                            from './deriveAgentRepoPath.mjs';
import {copyTree, leaseEvidence, lstatOrNull, sameTree, stagingPaths} from './moveSeatHomes.mjs';
import {readSeatWindowRecord, writeSeatWindowRecord}                  from './seatWindowRect.mjs';

/**
 * @summary Renames one seat: its Fleet id, and the folder named after it under the same agents root. The
 * folder is copied, never moved. The copy is staged beside its destination, proven identical to the seat,
 * and published under the new name. Only then does the registry re-key the row
 * ({@link Neo.ai.services.fleet.FleetRegistryService#renameAgent}), and the seat's PAT and operator follow it.
 * Until that write the registry still reads the old row and folder, so a refusal or an interruption leaves the
 * seat startable under its old id. After it, the old folder is a cold copy the operator retires once the seat
 * has started green under its new id.
 *
 * The rename then carries what the registry does not hold: the seat's plane credentials, its window record,
 * and its harness sessions, which each harness indexes by the folder they ran in ({@link
 * module:ai/services/fleet/carrySeatSessions}), so the seat resumes them under its new id. Fleet-owned files
 * that embed the old path or id are not rewritten here. The first Start re-derives them from the row's
 * `previousId` and `previousSeatHome`, as it does after a seat-root move ({@link
 * Neo.ai.services.fleet.moveSeatHomes}).
 *
 * Nothing changes when:
 * - the new id already names a seat;
 * - the seat is bound to no folder named after its id;
 * - the destination holds anything but a verified copy of the seat, or a staging folder this rename did not
 *   leave;
 * - the seat may still be running, because its lease names a live process or cannot be read.
 *
 * The caller runs it with the Fleet child stopped, as the seat-root move requires; the other seats may keep
 * running. Run again after an interruption at any step, the rename completes: its own staging folder (marked
 * with `moveId`) is discarded and copied again, a published copy is verified and kept, and a row the registry
 * already re-keyed finishes the moves that follow the re-key.
 * @param {Object}  options
 * @param {Object}  options.registry       The Fleet registry: `listAgents()` and `renameAgent()`.
 * @param {Object}  [options.tenants]      The tenant service, for `renameSeatPlaneCredentials()`.
 * @param {String}  options.id             The seat's current id.
 * @param {String}  options.to             Its new id.
 * @param {String}  [options.moveId]       The caller's id for this rename: a staging folder carrying it is this
 *     rename's own, and any other staging folder stops it.
 * @param {Boolean} [options.dryRun=false] Report the plan and change nothing.
 * @param {String}  [options.homeDir]      The home of the account the harnesses run as, where some keep sessions.
 * @returns {Promise<{state: 'renamed'|'planned'|'refused', reason?: String, plan: Object}>} The plan is
 *     `{id, to, seatHome, destination, materialized, state}`, where `state` is `copy`, `relocate` (a verified copy
 *     is already published), `rebind` (never materialized, so only the row is re-keyed) or `done` (the registry
 *     already carries the rename). A finished rename adds `skipped` sockets, the re-keyed `planeCredentials`
 *     endpoints, the `windowRecord` outcome and the carried `sessions`.
 * @throws {Error} For an invalid id, or a copy that is not identical to its source; nothing was re-keyed then.
 */
export async function renameSeat({registry, tenants = null, id, to, moveId = null, dryRun = false, homeDir}) {
    assertSeatSegment(id, 'id', 'renameSeat');
    assertSeatSegment(to, 'to', 'renameSeat');

    if (id === to) throw new Error(`renameSeat: seat '${id}' already has that id.`);

    const
        agents  = registry.listAgents(),
        agent   = agents.find(row => row.id === id),
        renamed = agents.find(row => row.id === to);

    if (!agent) {
        if (renamed?.previousId !== id) return {state: 'refused', reason: `no seat '${id}' is defined`, plan: {id, to}};

        const plan = {
            id, to,
            seatHome    : renamed.previousSeatHome ?? null,
            destination : renamed.seatHome,
            materialized: !!(await lstatOrNull(renamed.seatHome))?.isDirectory(),
            state       : 'done'
        };

        if (dryRun) return {state: 'planned', plan};

        await finishRename({registry, tenants, harnessType: renamed.harnessType, plan, homeDir});

        return {state: 'renamed', plan}
    }

    if (renamed) return {state: 'refused', reason: `'${to}' already names a seat`, plan: {id, to}};

    const seatHome = agent.seatHome ?? null;

    if (!seatHome || path.basename(seatHome) !== id) {
        return {state: 'refused', reason: `seat '${id}' is bound to ${seatHome ? `'${seatHome}', a folder not named after it` : 'no seat home'}`, plan: {id, to, seatHome}}
    }

    const plan = await planRename({agent, to, moveId});

    if (plan.refusal || dryRun) {
        return {state: plan.refusal ? 'refused' : 'planned', ...(plan.refusal && {reason: plan.refusal}), plan: publicPlan(plan)}
    }

    await publishCopy({plan, token: moveId ?? crypto.randomUUID()});
    await finishRename({registry, tenants, harnessType: agent.harnessType, plan, homeDir});

    return {state: 'renamed', plan: publicPlan(plan)}
}

/**
 * @summary What the rename does with the seat's folder, read before anything changes.
 * @param {Object}      options
 * @param {Object}      options.agent  The row's public definition.
 * @param {String}      options.to     The new id.
 * @param {String|null} options.moveId The caller's id for this rename.
 * @returns {Promise<Object>} The plan with its `state`, and a `refusal` when it stops the rename.
 * @private
 */
async function planRename({agent, to, moveId}) {
    const
        root     = path.dirname(agent.seatHome),
        plan     = {id: agent.id, to, seatHome: agent.seatHome, destination: path.join(root, to), materialized: false},
        home     = await lstatOrNull(plan.seatHome),
        occupant = await lstatOrNull(plan.destination);

    if (!home) {
        return {...plan, state: 'rebind', ...(occupant && {refusal: `seat '${agent.id}' was never materialized, but '${plan.destination}' already exists`})}
    }

    if (!home.isDirectory()) return {...plan, state: 'copy', refusal: `seat '${agent.id}' names '${plan.seatHome}', which is not a real folder`};

    // materialized means the Fleet provisioned it: a folder without the harness home it derives is not adopted
    const harnessRoot = path.dirname(deriveAgentInstanceHome({instanceRoot: root, agentId: agent.id, harnessType: agent.harnessType}));

    if (!(await lstatOrNull(harnessRoot))?.isDirectory()) {
        return {...plan, state: 'copy', refusal: `seat '${agent.id}' names '${plan.seatHome}', which holds no harness home the Fleet provisioned`}
    }

    plan.materialized = true;

    const running = await leaseEvidence({agent, source: root});

    if (running) {
        return {...plan, state: 'copy', refusal: `seat '${agent.id}' may still be running: ${running}. Quit it, or remove a lease you know is stale, then rename again`}
    }

    // the stage and its marker are this rename's own only when the marker is a plain file carrying its id;
    // anything else at either path stays as it is and stops the rename
    const
        {staging, marker} = stagingPaths(root, to),
        [stage, mark]     = await Promise.all([lstatOrNull(staging), lstatOrNull(marker)]),
        ownMarker         = !!mark?.isFile() && moveId !== null && await fs.readFile(marker, 'utf8').then(value => value === moveId, () => false),
        state             = occupant ? 'relocate' : 'copy';

    if (mark && !ownMarker) return {...plan, state, refusal: `'${marker}' is not this rename's marker; remove it, then rename again`};

    if (stage && !(stage.isDirectory() && ownMarker)) {
        return {...plan, state, refusal: `'${staging}' holds something this rename did not leave; remove it, then rename again`}
    }

    if (!occupant) return {...plan, state, ownStage: !!stage, ownMarker};

    return occupant.isDirectory() && await sameTree(plan.seatHome, plan.destination)
        ? {...plan, state, ownStage: !!stage, ownMarker}
        : {...plan, state: 'copy', refusal: `'${plan.destination}' holds something other than a verified copy of seat '${agent.id}'`}
}

/**
 * @summary Copies, proves and publishes the seat's folder under its new name.
 * @param {Object} options
 * @param {Object} options.plan  A plan from {@link planRename}.
 * @param {String} options.token The id this rename marks its staging folder with.
 * @returns {Promise<void>}
 * @private
 */
async function publishCopy({plan, token}) {
    const {staging, marker} = stagingPaths(path.dirname(plan.seatHome), plan.to);

    // this rename's own leftovers from an interrupted run: an unpublished stage is discarded, and so is the
    // marker of one that was published (the plan admitted both, so nothing else is touched)
    plan.ownStage  && await fs.rm(staging, {recursive: true});
    plan.ownMarker && await fs.unlink(marker);

    if (plan.state !== 'copy') return;

    // created exclusively: an existing path, a link included, is never written through
    await fs.writeFile(marker, token, {flag: 'wx', mode: 0o600});

    const skipped = await copyTree(plan.seatHome, staging);

    if (!await sameTree(plan.seatHome, staging)) {
        await fs.rm(staging, {recursive: true, force: true});
        await fs.unlink(marker);
        throw new Error(`renameSeat: the copy of seat '${plan.id}' differs from its source; nothing was re-keyed.`)
    }

    await fs.rename(staging, plan.destination);
    await fs.unlink(marker);
    skipped.length && (plan.skipped = skipped)
}

/**
 * @summary The re-key and the moves that follow it: the registry row with its PAT and operator, the plane
 * credentials, the window record and the harness sessions. Each is a no-op once done, so a re-run completes
 * whatever an interruption left.
 * @param {Object} options
 * @param {Object} options.registry
 * @param {Object} [options.tenants]
 * @param {String} options.harnessType
 * @param {Object} options.plan
 * @param {String} [options.homeDir]
 * @returns {Promise<void>}
 * @private
 */
async function finishRename({registry, tenants, harnessType, plan, homeDir}) {
    registry.renameAgent(plan.id, {to: plan.to, from: plan.seatHome, seatHome: plan.destination});

    plan.planeCredentials = tenants ? tenants.renameSeatPlaneCredentials({from: plan.id, to: plan.to}).endpoints : [];

    if (!plan.materialized) return;

    const instanceHome = deriveAgentInstanceHome({instanceRoot: path.dirname(plan.destination), agentId: plan.to, harnessType});

    plan.windowRecord = rekeyWindowRecord({instanceHome, to: plan.to});
    plan.sessions     = await carrySeatSessions({harnessType, instanceHome, from: plan.seatHome, to: plan.destination, previousId: plan.id, id: plan.to, homeDir})
}

/**
 * @summary Re-keys the seat's window record, which names the seat by id, keeping its rectangle and capture time.
 * @param {Object} options
 * @param {String} options.instanceHome The renamed seat's harness home.
 * @param {String} options.to           The new id.
 * @returns {String} `renamed`, `current`, `absent`, or why it could not be written.
 * @private
 */
function rekeyWindowRecord({instanceHome, to}) {
    const record = readSeatWindowRecord(instanceHome);

    if (!record)             return 'absent';
    if (record.agentId === to) return 'current';

    return writeSeatWindowRecord({instanceHome, agentId: to, harnessType: record.harnessType, rect: record.rect, capturedAt: record.capturedAt}) ?? 'renamed'
}

/** @private */
function publicPlan({refusal, ownStage, ownMarker, ...plan}) {
    return plan
}
