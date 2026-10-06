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
 * Nothing changes when a destination holds anything but a verified copy of its source, or when a seat may
 * still be running: its home holds a seat lease whose process is alive. Run again after an interruption at
 * any step, the move completes. A staging folder is discarded and copied again, a published copy is verified
 * and kept, and a row already at its destination reads `done`. Sockets and pipes, which a harness leaves
 * behind and no copy can carry, are not copied; each row names the ones it skipped.
 *
 * The caller runs it while no seat runs: the shell's boot, before the fleet child starts.
 * @param {Object}  options
 * @param {Object}  options.registry       The Fleet registry: `listAgents()` and `relocateSeatHome()`.
 * @param {String}  options.from           The agents root the seats live under now.
 * @param {String}  options.to             The agents root they move to.
 * @param {Boolean} [options.dryRun=false] Report each row's plan and change nothing.
 * @returns {Promise<{state: 'moved'|'planned'|'refused', reason?: String, rows: Object[]}>} Each row is
 *     `{id, seatHome, destination, materialized, state, reason?, skipped?}`. A finished move reports `done`,
 *     `moved`, `rebound` (bound but never materialized, so only the binding moved) or `untouched` (bound
 *     elsewhere or not at all, with the reason). A plan or a refusal reports `copy`, `relocate` (a verified
 *     copy is already published) or `rebind`, and a refusing row carries its reason.
 * @throws {Error} For roots that are not absolute or are the same, or a copy that is not identical to its
 *     source; rows relocated before the throw stay relocated.
 */
export async function moveSeatHomes({registry, from, to, dryRun = false}) {
    for (const [name, root] of [['from', from], ['to', to]]) {
        if (typeof root !== 'string' || !path.isAbsolute(root)) {
            throw new Error(`moveSeatHomes: '${name}' must be an absolute agents root.`)
        }
    }

    const
        source      = path.resolve(from),
        destination = path.resolve(to);

    if (source === destination) throw new Error(`moveSeatHomes: the seats already live under '${source}'.`);

    const rows = [];

    for (const agent of registry.listAgents()) rows.push(await planRow({agent, source, destination}));

    const refusal = rows.find(row => row.refusal);

    if (refusal || dryRun) {
        return {state: refusal ? 'refused' : 'planned', ...(refusal && {reason: refusal.refusal}), rows: rows.map(publicRow)}
    }

    for (const row of rows) await applyRow({row, registry, destination});

    return {state: 'moved', rows: rows.map(publicRow)}
}

/**
 * @summary What the move does with one registry row, read before anything changes.
 * @param {Object} options
 * @param {Object} options.agent       The row's public definition.
 * @param {String} options.source      The resolved root the seats leave.
 * @param {String} options.destination The resolved root they move to.
 * @returns {Promise<Object>} The row with its `state`, and a `refusal` when it stops the move.
 * @private
 */
async function planRow({agent, source, destination}) {
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

    row.materialized = true;

    if (!home.isDirectory()) return {...row, state: 'copy', refusal: `seat '${agent.id}' names '${seatHome}', which is not a real folder`};

    const livePid = await liveLeasePid({agent, source});

    if (livePid) {
        return {...row, state: 'copy', refusal: `seat '${agent.id}' may still be running (its lease names live pid ${livePid}); quit it, then move again`}
    }

    if (!occupant) return {...row, state: 'copy'};

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
 * @returns {Promise<void>}
 * @private
 */
async function applyRow({row, registry, destination}) {
    if (row.state === 'copy') {
        const staging = path.join(destination, `.moving-${row.id}`);

        await fs.mkdir(destination, {recursive: true, mode: 0o700});
        // an interrupted run's partial copy is never published, so it is discarded
        await fs.rm(staging, {recursive: true, force: true});

        const skipped = await copyTree(row.seatHome, staging);

        if (!await sameTree(row.seatHome, staging)) {
            await fs.rm(staging, {recursive: true, force: true});
            throw new Error(`moveSeatHomes: the copy of seat '${row.id}' differs from its source; its binding was not moved.`)
        }

        await fs.rename(staging, row.destination);
        skipped.length && (row.skipped = skipped)
    }

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
 * @summary Whether two folders hold the same tree: the same entries, each of the same kind and permission
 * bits, files with the same bytes, links with the same target. Sockets and pipes do not count.
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
 * @summary One line per entry beneath a folder, sorted: its relative path, kind, permission bits, and its
 * content's sha256 or its link target.
 * @param {String} root
 * @returns {Promise<String[]>}
 * @private
 */
async function treeManifest(root) {
    const lines = [];

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
 * @summary The pid a seat's lease names, when that process is alive. A lease outlives its server, so a seat
 * whose app still runs writes into the home it started in; a missing, unreadable or dead lease names none.
 * @param {Object} options
 * @param {Object} options.agent  The row's public definition.
 * @param {String} options.source The root the seat's home lives under.
 * @returns {Promise<Number|null>}
 * @private
 */
async function liveLeasePid({agent, source}) {
    let pid;

    try {
        const leasePath = path.join(deriveAgentInstanceHome({instanceRoot: source, agentId: agent.id, harnessType: agent.harnessType}), SEAT_LEASE_FILE);

        pid = JSON.parse(await fs.readFile(leasePath, 'utf8')).pid
    } catch {
        return null
    }

    if (!Number.isInteger(pid) || pid <= 0) return null;

    try {
        process.kill(pid, 0);
        return pid
    } catch (error) {
        // a process this user may not signal is still alive
        return error?.code === 'EPERM' ? pid : null
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
function publicRow({refusal, ...row}) {
    return refusal ? {...row, reason: refusal} : row
}
