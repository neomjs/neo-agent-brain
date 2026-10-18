import {spawnSync}                    from 'node:child_process';
import fs                             from 'node:fs';
import path                           from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual}            from 'node:util';
import {parse as parseToml}           from 'smol-toml';
import {deriveAgentRepoPath}          from './deriveAgentRepoPath.mjs';

/**
 * @module ai/services/fleet/seatJourney
 * @summary Drives one fleet server through its own wire, the way the cockpit does, along a seat's life: Start, Stop,
 * Start again, an unclean Fleet restart with the seat gone, and Start once more.
 *
 * The seats run a stand-in harness (`ai/scripts/fleet/seatStandIn.mjs`) instead of the real app, so a Start goes end
 * to end without opening a window: provisioning, workspace preparation, launch admission, the spawn, and every MCP row
 * the stand-in starts from the config the Fleet wrote. The journey owns no process. Its caller starts the fleet
 * server, hands over a wire client, and restarts the server on request, so the same journey runs against a checkout
 * in CI and against a packaged candidate before it is installed.
 *
 * Each step yields one row `{seat, family, step, ok, reason, detail}`. The rows are the verdict: the journey never
 * throws for a failed step, so one red step still leaves the rest of the evidence.
 * @see ai/scripts/fleet/seatStandIn.mjs
 */

const
    __dirname       = path.dirname(fileURLToPath(import.meta.url)),
    STAND_IN_SCRIPT = path.resolve(__dirname, '../../scripts/fleet/seatStandIn.mjs');

/**
 * The record file the stand-in appends to inside its instance home. The journey reads it as data and does not import
 * the stand-in, whose MCP client has no business in the journey's process.
 * @type {String}
 */
export const STAND_IN_RECORD_FILE = 'seat-stand-in.json';

/**
 * The prefix of the MCP rows the Fleet owns in a harness config (`neo-mjs-<server>`). Everything else in the file is
 * the operator's and must survive every Start, even though the Fleet's own rows carry fresh launch grants each time.
 * @type {String}
 */
export const FLEET_ROW_PREFIX = 'neo-mjs-';

/**
 * @summary Writes the executable a family's harness-binary leaf points at: a module whose shebang names the
 * runtime by absolute path and which runs the stand-in's `main`.
 *
 * The Fleet proves a seat's process by its command line: the launch binary itself, or a script behind exactly
 * the interpreter its shebang names (`runsSeatLaunch`). A shell launcher that `exec`s another program fails
 * that proof, which then refuses every MCP launch as `process-unknown`; this shape passes it the way a real
 * app binary does.
 * @param {Object} options
 * @param {String} options.directory Where the launcher goes; created when missing.
 * @param {String} [options.runtime=process.execPath] An absolute Node runtime.
 * @returns {String} The launcher's absolute path.
 */
export function writeStandInLauncher({directory, runtime = process.execPath}) {
    const file = path.join(directory, 'seat-stand-in.mjs');

    fs.mkdirSync(directory, {recursive: true});
    // a dynamic import, so the launcher also runs where its name carries no `.mjs` (an app bundle's main binary)
    fs.writeFileSync(file, [
        `#!${runtime}`,
        `import(${JSON.stringify(pathToFileURL(STAND_IN_SCRIPT).href)}).then(({main}) => main({argv: process.argv.slice(2), env: process.env}))`,
        "    .catch(error => {process.stderr.write(`seatStandIn: ${error.message}\\n`); process.exit(1)});",
        ''
    ].join('\n'), {mode: 0o755});
    return file
}

/**
 * @summary Wraps the stand-in in the app-bundle shape Codex Desktop's capability probe requires
 * (`probeCodexDesktopCapabilities`): the launcher as `Contents/MacOS/Codex`, an `app.asar` and a Chromium framework
 * carrying the contract markers the probe scans for, and an executable Crashpad helper. Should the probe's contract
 * move, the Start refuses with the probe's named reason, and the journey reports that row.
 * @param {Object} options
 * @param {String} options.directory Where `Codex.app` goes.
 * @param {String} [options.runtime=process.execPath]
 * @returns {String} The bundle's main binary, for `NEO_FLEET_CODEX_DESKTOP_BIN`.
 */
export function writeCodexStandInBundle({directory, runtime = process.execPath}) {
    const
        contents  = path.join(directory, 'Codex.app', 'Contents'),
        framework = path.join(contents, 'Frameworks', 'Codex Framework.framework'),
        main      = path.join(contents, 'MacOS', 'Codex'),
        launcher  = writeStandInLauncher({directory: path.dirname(main), runtime});

    fs.renameSync(launcher, main);
    fs.mkdirSync(path.join(contents, 'Resources'), {recursive: true});
    fs.writeFileSync(path.join(contents, 'Resources', 'app.asar'),
        'CODEX_ELECTRON_USER_DATA_PATH --open-project shouldIncludeSparkle enableUpdater CODEX_SPARKLE_ENABLED==="false"\n');
    fs.mkdirSync(path.join(framework, 'Helpers'), {recursive: true});
    fs.writeFileSync(path.join(framework, 'Codex Framework'), 'user-data-dir\n');
    fs.writeFileSync(path.join(framework, 'Helpers', 'browser_crashpad_handler'), '#!/bin/sh\n', {mode: 0o755});
    return main
}

/**
 * @summary Creates the checkout a seat's Start will reuse, so provisioning needs no clone and no network:
 * `ensureAgentRepo` reuses an existing valid checkout as-is.
 * @param {Object} options
 * @param {String} options.managedRoot The fleet's agents root.
 * @param {String} options.agentId
 * @param {String} options.repoSlug
 * @returns {String} The checkout path.
 */
export function seedSeatCheckout({managedRoot, agentId, repoSlug}) {
    const repoPath = deriveAgentRepoPath({managedRoot, agentId, repoSlug});

    fs.mkdirSync(repoPath, {recursive: true});
    const result = spawnSync('git', ['init', '-q', repoPath], {encoding: 'utf8'});

    if (result.status !== 0) throw new Error(`seedSeatCheckout: git init failed: ${result.stderr}`);
    return repoPath
}

/**
 * @summary A harness config as data, without the Fleet's own rows: what an operator owns in the file. JSON for
 * Claude Desktop, TOML for Codex Desktop.
 * @param {String} file
 * @returns {Object}
 */
export function readOperatorContent(file) {
    const
        text    = fs.readFileSync(file, 'utf8'),
        isToml  = file.endsWith('.toml'),
        data    = isToml ? parseToml(text) : JSON.parse(text),
        servers = isToml ? data.mcp_servers : data.mcpServers;

    Object.keys(servers ?? {}).filter(name => name.startsWith(FLEET_ROW_PREFIX)).forEach(name => delete servers[name]);
    return data
}

/**
 * @summary Adds content the Fleet does not own, as an operator would between two Starts.
 * @param {String} file
 * @param {String} marker
 */
export function seedOperatorContent(file, marker) {
    if (file.endsWith('.toml')) {
        fs.appendFileSync(file, `\n[neo_seat_journey]\nmarker = ${JSON.stringify(marker)}\n`)
    } else {
        fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), neoSeatJourney: {marker}}, null, 2))
    }
}

/**
 * @summary Whether a Start left the operator's content of every config as it was.
 * @param {Object} before `{[file]: content}` from {@link readOperatorContent}, taken before the Start.
 * @returns {{ok: Boolean, changed: String[]}}
 */
export function compareOperatorContent(before) {
    const changed = Object.entries(before).filter(([file, content]) => {
        try {
            return !isDeepStrictEqual(readOperatorContent(file), content)
        } catch {
            return true
        }
    }).map(([file]) => file);

    return {ok: changed.length === 0, changed}
}

/**
 * @summary Judges one stand-in record: every row answered all three asks, and Neural Link reports a connected Bridge
 * on the port the run owns. A seat reaching any other Bridge, the host's default among them, fails: the Fleet carries
 * its configured port into every seat (`NEO_NL_PORT`).
 * @param {Object} record
 * @param {Number|null} [bridgePort=null] The run's Bridge port; `null` skips the port check.
 * @returns {{ok: Boolean, reason: String|null}}
 */
export function judgeRecord(record, bridgePort = null) {
    const failed = record.rows.filter(row => !row.ok);

    if (failed.length) {
        return {ok: false, reason: failed.map(row => `${row.name} failed at ${row.step}: ${row.reason}`).join('; ')}
    }

    const bridge = record.rows.find(row => row.name.includes('neural-link'))?.healthcheck?.bridge;

    if (bridge && bridgePort !== null && bridge.port !== bridgePort) {
        return {ok: false, reason: `neural-link reached the Bridge on port ${bridge.port}, not the run's ${bridgePort}`}
    }

    if (bridge && !bridge.connected) {
        return {ok: false, reason: `neural-link answered without a connected Bridge on port ${bridge.port}`}
    }

    return {ok: true, reason: null}
}

/**
 * @summary Polls until `read` returns a value, or the budget ends with `null`.
 * @param {Function} read
 * @param {Number}   timeoutMs
 * @returns {Promise<*>}
 */
async function waitFor(read, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 250))
    }

    return null
}

/**
 * @summary The stand-in record a launch wrote, read from the instance home the Fleet reported.
 * @param {String} instanceHome
 * @param {Number} pid
 * @returns {Object|null}
 */
function readRecord(instanceHome, pid) {
    try {
        return JSON.parse(fs.readFileSync(path.join(instanceHome, STAND_IN_RECORD_FILE), 'utf8')).records.find(record => record.pid === pid) ?? null
    } catch {
        return null
    }
}

/**
 * @summary The roster row the cockpit reads for one seat.
 * @param {Object} fleet
 * @param {String} id
 * @returns {Promise<Object|null>}
 */
async function rosterRow(fleet, id) {
    return (await fleet.fleetRuntimeStatus()).find(row => row.agentId === id) ?? null
}

/**
 * @summary Whether a pid still names a live process.
 * @param {Number} pid
 * @returns {Boolean}
 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true
    } catch {
        return false
    }
}

/**
 * @summary Runs the journey for every seat and returns its rows.
 * @param {Object}   options
 * @param {Object}   options.fleet        A Fleet wire client (`createFleetRegistryBridge` shape).
 * @param {Function} options.restartFleet `async ({beforeBoot}) => client`: stops the fleet server uncleanly, awaits
 *     `beforeBoot()`, then boots a fresh one on the same root.
 * @param {Object[]} options.seats        `{definition, repo: {repoSlug, cloneUrl}}`; `definition` goes to
 *     `defineAgent` as given.
 * @param {Number}   [options.bridgePort=null] The Bridge the run owns; Neural Link must reach exactly it.
 * @param {Number}   [options.timeoutMs=90000] Budget for each wait.
 * @param {Function} [options.log]
 * @returns {Promise<{ok: Boolean, rows: Object[]}>}
 */
export async function runSeatJourney({fleet, restartFleet, seats, bridgePort = null, timeoutMs = 90_000, log = () => {}}) {
    const
        rows   = [],
        starts = new Map(),
        add    = (seat, step, ok, reason = null, detail = null) => {
            const row = {seat: seat.definition.id, family: seat.definition.harnessType, step, ok, reason, detail};
            rows.push(row);
            log(`${row.seat} ${step}: ${ok ? 'ok' : `FAILED ${reason}`}`);
            return ok
        };

    /**
     * @summary One Start, judged: the wire's answer, the roster's `running`, then the stand-in's record.
     * @param {Object} seat
     * @param {String} step
     * @returns {Promise<Object|null>} The record, when the Start went end to end.
     */
    async function start(seat, step) {
        const {id} = seat.definition, status = await fleet.startAgent(id);

        if (status?.status === 'rejected' || !status?.pid) {
            add(seat, step, false, `Start refused: ${status?.reason ?? JSON.stringify(status)}`);
            return null
        }

        const row = await waitFor(async () => {
            const current = await rosterRow(fleet, id);
            return current && current.state !== 'starting' ? current : null
        }, timeoutMs);

        if (row?.state !== 'running') {
            add(seat, step, false, `seat reached '${row?.state ?? 'no state'}'${row?.failureReason ? `: ${row.failureReason}` : ''}`, row);
            return null
        }

        const record = await waitFor(() => readRecord(status.instanceHome, status.pid), timeoutMs);

        if (!record) {
            add(seat, step, false, 'the stand-in wrote no record for this launch', {instanceHome: status.instanceHome, pid: status.pid});
            return null
        }

        starts.set(id, record);
        const verdict = judgeRecord(record, bridgePort);
        add(seat, step, verdict.ok, verdict.reason, {pid: status.pid, rows: record.rows});
        return verdict.ok ? record : null
    }

    for (const seat of seats) {
        try {
            await fleet.defineAgent(seat.definition);
            await fleet.setRepo({id: seat.definition.id, ...seat.repo});
            add(seat, 'define', true)
        } catch (error) {
            add(seat, 'define', false, error.message)
        }
    }

    const defined = seats.filter(seat => rows.some(row => row.seat === seat.definition.id && row.step === 'define' && row.ok));

    for (const seat of defined) {
        const first = await start(seat, 'start');
        if (!first) continue;

        await fleet.stopAgent(seat.definition.id);
        const stopped = await waitFor(async () => !isAlive(first.pid) && (await rosterRow(fleet, seat.definition.id))?.state === 'stopped', timeoutMs);
        if (!add(seat, 'stop', Boolean(stopped), stopped ? null : 'the seat did not reach stopped')) continue;

        // What an operator adds between two Starts must survive the second, while the Fleet's rows take fresh grants.
        first.configs.forEach(config => seedOperatorContent(config.path, `${seat.definition.id}:${first.pid}`));
        const before = Object.fromEntries(first.configs.map(config => [config.path, readOperatorContent(config.path)]));

        if (!await start(seat, 'start-again')) continue;

        const preserved = compareOperatorContent(before);
        add(seat, 'operator-content', preserved.ok, preserved.ok ? null : `changed by the second Start: ${preserved.changed.join(', ')}`)
    }

    // The unclean restart: the Fleet dies with its seats up, and the seats are gone by the next boot. Recovery must
    // read them as stopped, the state the roster offers Start for.
    const running = defined.filter(seat => starts.has(seat.definition.id));

    if (running.length) {
        fleet = await restartFleet({beforeBoot: async () => {
            const pids = running.map(seat => starts.get(seat.definition.id).pid).filter(isAlive);

            pids.forEach(pid => process.kill(pid, 'SIGTERM'));
            await waitFor(() => pids.every(pid => !isAlive(pid)), timeoutMs)
        }});

        for (const seat of running) {
            const row = await rosterRow(fleet, seat.definition.id);

            if (add(seat, 'recover', row?.state === 'stopped', row?.state === 'stopped' ? null : `recovered as '${row?.state ?? 'absent'}'`, row)) {
                await start(seat, 'start-after-recovery')
            }
        }
    }

    await Promise.allSettled(defined.map(seat => fleet.stopAgent(seat.definition.id)));

    return {ok: rows.every(row => row.ok), rows}
}
