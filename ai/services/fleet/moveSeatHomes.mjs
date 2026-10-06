import crypto                        from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import fs                            from 'node:fs/promises';
import path                          from 'node:path';
import {pipeline}                    from 'node:stream/promises';
import {deriveAgentInstanceHome}     from './deriveAgentInstanceHome.mjs';
import {SEAT_LEASE_FILE}             from './FleetLifecycleService.mjs';

/**
 * @summary Moves the Fleet's seat homes from one agents root to another, when the installed shell changes
 * its agents root. A materialized home is copied, never moved. The copy goes
 * into a staging folder beside its destination, is proven identical, and is then published under its own
 * name. Only then is the row's binding relocated, with its exact `from`
 * ({@link Neo.ai.services.fleet.FleetRegistryService#relocateSeatHome}). No seat file is rewritten here: the
 * first Start at the new root re-derives what Fleet rendered at the old one, from the row's `previousSeatHome`.
 *
 * A home is materialized when it holds the harness homes the Fleet provisions. Nothing changes when:
 * - the two roots resolve to the same folder or one inside the other, so a copy would not be independent;
 * - a source folder holds no harness home;
 * - a destination holds anything but a verified copy of its source, or a staging folder this move did not
 *   leave;
 * - a seat may still be running, because its lease names a live process or cannot be read.
 *
 * Run again after an interruption at any step, the move completes: its own staging folder (marked with
 * `moveId`) is discarded and copied again, a published copy is verified and kept, and a row already at its
 * destination reads `done`. Sockets and pipes, which a harness leaves behind and no copy can carry, are not
 * copied; each row names the ones it skipped.
 *
 * The caller runs it while no seat runs: the shell's boot, before the fleet child starts. A `moved` result
 * covers the rows it moved. Before committing anything installation-wide, the caller still reads the
 * registry back and accounts for every row.
 * @param {Object}  options
 * @param {Object}  options.registry       The Fleet registry: `listAgents()` and `relocateSeatHome()`.
 * @param {String}  options.from           The agents root the seats live under now.
 * @param {String}  options.to             The agents root they move to.
 * @param {String}  [options.moveId]       The caller's id for this move: a staging folder carrying it is this
 *     move's own, and any other staging folder stops the move.
 * @param {Boolean} [options.dryRun=false] Report each row's plan and change nothing.
 * @returns {Promise<{state: 'moved'|'planned'|'refused', reason?: String, rows: Object[]}>} Each row is
 *     `{id, seatHome, destination, materialized, state, reason?, skipped?}`. A finished move reports `done`,
 *     `moved`, `rebound` (bound but never materialized, so only the binding moved) or `untouched` (bound
 *     elsewhere or not at all, with the reason). A plan or a refusal reports `copy`, `relocate` (a verified
 *     copy is already published) or `rebind`, and a refusing row carries its reason.
 * @throws {Error} For roots that are not absolute or are the same, or a copy that is not identical to its
 *     source; rows relocated before the throw stay relocated.
 */
export async function moveSeatHomes({registry, from, to, moveId = null, dryRun = false}) {
    for (const [name, root] of [['from', from], ['to', to]]) {
        if (typeof root !== 'string' || !path.isAbsolute(root)) {
            throw new Error(`moveSeatHomes: '${name}' must be an absolute agents root.`)
        }
    }

    const
        source      = path.resolve(from),
        destination = path.resolve(to);

    if (source === destination) throw new Error(`moveSeatHomes: the seats already live under '${source}'.`);

    const [realSource, realDestination] = await Promise.all([realLocation(source), realLocation(destination)]);

    if (realSource === realDestination || realSource.startsWith(realDestination + path.sep) || realDestination.startsWith(realSource + path.sep)) {
        return {state: 'refused', reason: `'${destination}' and '${source}' resolve to overlapping folders, so a copy would not be independent`, rows: []}
    }

    const rows = [];

    for (const agent of registry.listAgents()) rows.push(await planRow({agent, source, destination, moveId}));

    const refusal = rows.find(row => row.refusal);

    if (refusal || dryRun) {
        return {state: refusal ? 'refused' : 'planned', ...(refusal && {reason: refusal.refusal}), rows: rows.map(publicRow)}
    }

    const token = moveId ?? crypto.randomUUID();

    for (const row of rows) await applyRow({row, registry, destination, token});

    return {state: 'moved', rows: rows.map(publicRow)}
}

/**
 * @summary What the move does with one registry row, read before anything changes.
 * @param {Object} options
 * @param {Object} options.agent       The row's public definition.
 * @param {String} options.source      The resolved root the seats leave.
 * @param {String} options.destination The resolved root they move to.
 * @param {String|null} options.moveId  The caller's id for this move.
 * @returns {Promise<Object>} The row with its `state`, and a `refusal` when it stops the move.
 * @private
 */
async function planRow({agent, source, destination, moveId}) {
    const
        seatHome = agent.seatHome ?? null,
        target   = path.join(destination, agent.id),
        row      = {id: agent.id, seatHome, destination: target, materialized: false};

    if (seatHome === target) return {...row, state: 'done'};

    if (seatHome !== path.join(source, agent.id)) {
        return {...row, state: 'untouched', reason: seatHome ? `it is bound to '${seatHome}', outside '${source}'` : 'it is bound to no seat home'}
    }

    const
        home     = await lstatOrNull(seatHome),
        occupant = await lstatOrNull(target);

    if (!home) {
        return {...row, state: 'rebind', ...(occupant && {refusal: `seat '${agent.id}' was never materialized, but '${target}' already exists`})}
    }

    if (!home.isDirectory()) return {...row, state: 'copy', refusal: `seat '${agent.id}' names '${seatHome}', which is not a real folder`};

    // materialized means the Fleet provisioned it: a folder without the harness homes it derives is not adopted
    const harnessRoot = path.dirname(deriveAgentInstanceHome({instanceRoot: source, agentId: agent.id, harnessType: agent.harnessType}));

    if (!(await lstatOrNull(harnessRoot))?.isDirectory()) {
        return {...row, state: 'copy', refusal: `seat '${agent.id}' names '${seatHome}', which holds no harness home the Fleet provisioned; rename it aside, then move again`}
    }

    row.materialized = true;

    const running = await leaseEvidence({agent, source});

    if (running) {
        return {...row, state: 'copy', refusal: `seat '${agent.id}' may still be running: ${running}. Quit it, or remove a lease you know is stale, then move again`}
    }

    if (!occupant) {
        const {staging, marker} = stagingPaths(destination, agent.id), stage = await lstatOrNull(staging);

        // a staging folder is this move's own only when it is a real folder carrying this move's id
        const own = stage?.isDirectory() && moveId !== null && await fs.readFile(marker, 'utf8').then(id => id === moveId, () => false);

        return stage && !own
            ? {...row, state: 'copy', refusal: `'${staging}' holds something this move did not leave; remove it, then move again`}
            : {...row, state: 'copy', ownStage: !!stage}
    }

    return occupant.isDirectory() && await sameTree(seatHome, target)
        ? {...row, state: 'relocate'}
        : {...row, state: 'copy', refusal: `'${target}' holds something other than a verified copy of seat '${agent.id}'`}
}

/**
 * @summary Carries out one row's plan: copy, prove and publish its home, then relocate its binding.
 * @param {Object} options
 * @param {Object} options.row         A planned row ({@link planRow}).
 * @param {Object} options.registry    The Fleet registry.
 * @param {String} options.destination The resolved root the seats move to.
 * @param {String} options.token       The id this move marks its staging folders with.
 * @returns {Promise<void>}
 * @private
 */
async function applyRow({row, registry, destination, token}) {
    if (row.state === 'copy') {
        const {staging, marker} = stagingPaths(destination, row.id);

        await fs.mkdir(destination, {recursive: true, mode: 0o700});
        // this move's own interrupted copy is never published, so it is discarded
        row.ownStage && await fs.rm(staging, {recursive: true});
        await fs.writeFile(marker, token, {mode: 0o600});

        const skipped = await copyTree(row.seatHome, staging);

        if (!await sameTree(row.seatHome, staging)) {
            await fs.rm(staging, {recursive: true, force: true});
            throw new Error(`moveSeatHomes: the copy of seat '${row.id}' differs from its source; its binding was not moved.`)
        }

        await fs.rename(staging, row.destination);
        await fs.rm(marker, {force: true});
        skipped.length && (row.skipped = skipped)
    }

    // a run interrupted after publishing its copy left the copy's marker behind
    row.state === 'relocate' && await fs.rm(stagingPaths(destination, row.id).marker, {force: true});

    if (['copy', 'relocate', 'rebind'].includes(row.state)) {
        registry.relocateSeatHome(row.id, {from: row.seatHome, to: row.destination});
        row.state = row.state === 'rebind' ? 'rebound' : 'moved'
    }
}

/**
 * @summary Copies a seat home, cloning files where the volume can, and keeping links as they are written.
 * @param {String} from An existing seat home.
 * @param {String} to   A path that does not exist yet.
 * @returns {Promise<String[]>} The sockets and pipes left behind, relative to `from`.
 * @private
 */
async function copyTree(from, to) {
    const skipped = [];

    await fs.cp(from, to, {
        recursive         : true,
        verbatimSymlinks  : true,
        preserveTimestamps: true,
        errorOnExist      : true,
        force             : false,
        mode              : constants.COPYFILE_FICLONE,
        filter            : async entry => {
            const stat = await fs.lstat(entry);

            if (stat.isSocket() || stat.isFIFO()) {
                skipped.push(path.relative(from, entry));
                return false
            }

            return true
        }
    });

    return skipped
}

/**
 * @summary Where a seat's copy is staged before it is published, and the file marking that stage as a move's own.
 * @param {String} destination
 * @param {String} id
 * @returns {{staging: String, marker: String}}
 * @private
 */
function stagingPaths(destination, id) {
    const staging = path.join(destination, `.moving-${id}`);

    return {staging, marker: `${staging}.owner`}
}

/**
 * @summary The real location of a path that may not exist yet: its nearest existing ancestor resolved through
 * links, joined with the rest.
 * @param {String} file
 * @returns {Promise<String>}
 * @private
 */
async function realLocation(file) {
    const rest    = [];
    let   current = file;

    for (;;) {
        try {
            return path.join(await fs.realpath(current), ...rest)
        } catch (error) {
            if (error?.code !== 'ENOENT' || path.dirname(current) === current) throw error;

            rest.unshift(path.basename(current));
            current = path.dirname(current)
        }
    }
}

/**
 * @summary Whether two folders hold the same tree: the folder itself and every entry beneath it of the same
 * kind and permission bits, files with the same bytes, links with the same target. Sockets and pipes do not
 * count.
 * @param {String} a
 * @param {String} b
 * @returns {Promise<Boolean>}
 * @private
 */
async function sameTree(a, b) {
    const [left, right] = await Promise.all([treeManifest(a), treeManifest(b)]);

    return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * @summary One line for the folder and one per entry beneath it, sorted: its relative path, kind, permission
 * bits, and its content's sha256 or its link target.
 * @param {String} root
 * @returns {Promise<String[]>}
 * @private
 */
async function treeManifest(root) {
    const lines = [`.\0dir\0${((await fs.lstat(root)).mode & 0o7777).toString(8)}`];

    for (const entry of await fs.readdir(root, {recursive: true, withFileTypes: true})) {
        const
            file     = path.join(entry.parentPath, entry.name),
            stat     = await fs.lstat(file),
            relative = path.relative(root, file),
            mode     = (stat.mode & 0o7777).toString(8);

        if (stat.isSymbolicLink()) lines.push(`${relative}\0link\0${mode}\0${await fs.readlink(file)}`);
        else if (stat.isDirectory()) lines.push(`${relative}\0dir\0${mode}`);
        else if (stat.isFile()) lines.push(`${relative}\0file\0${mode}\0${await sha256(file)}`)
    }

    return lines.sort()
}

/** @private */
async function sha256(file) {
    const hash = crypto.createHash('sha256');

    await pipeline(createReadStream(file), hash);

    return hash.digest('hex')
}

/**
 * @summary Why a seat may still be running, or `null` when nothing says so. A lease outlives its server, so a
 * seat whose app still runs writes into the home it started in. Only a missing lease, or one naming a process
 * that is gone, says the seat is not running; a lease that cannot be read or names no process leaves it open.
 * @param {Object} options
 * @param {Object} options.agent  The row's public definition.
 * @param {String} options.source The root the seat's home lives under.
 * @returns {Promise<String|null>}
 * @private
 */
async function leaseEvidence({agent, source}) {
    const leasePath = path.join(deriveAgentInstanceHome({instanceRoot: source, agentId: agent.id, harnessType: agent.harnessType}), SEAT_LEASE_FILE);
    let   raw, pid;

    try {
        raw = await fs.readFile(leasePath, 'utf8')
    } catch (error) {
        return error?.code === 'ENOENT' ? null : `its lease cannot be read (${error?.code ?? error?.message})`
    }

    try {
        pid = JSON.parse(raw)?.pid
    } catch {
        return 'its lease is not valid JSON'
    }

    if (!Number.isInteger(pid) || pid <= 0) return 'its lease names no process';

    try {
        process.kill(pid, 0);
        return `its lease names live pid ${pid}`
    } catch (error) {
        if (error?.code === 'ESRCH') return null;

        // a process this user may not signal is still alive
        return error?.code === 'EPERM' ? `its lease names live pid ${pid}` : `its lease's process cannot be probed (${error?.code})`
    }
}

/** @private */
function lstatOrNull(file) {
    return fs.lstat(file).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error
    })
}

/** @private */
function publicRow({refusal, ownStage, ...row}) {
    return refusal ? {...row, reason: refusal} : row
}
