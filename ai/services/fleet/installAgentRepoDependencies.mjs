import {writeFileAtomic}   from '../shared/atomicFileWrite.mjs';
import {redactReadFailure} from './redactReadFailure.mjs';
import {execFile, spawn}   from 'node:child_process';
import crypto              from 'node:crypto';
import fs                  from 'node:fs';
import path                from 'node:path';
import {promisify}         from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The seat-home receipt of the installs this Fleet started: `{[repoSlug]: {state, at, lock?, adoptedFrom?, reason?}}`,
 * where `state` is `installing`, `installed` or `failed`, `lock` is the {@link lockDigest} an `installed` tree was
 * built from, and `adoptedFrom: 'unverified'` marks a tree the Fleet took over instead of cloning. Beside the memory
 * import's receipt, outside every checkout.
 * @type {String}
 */
export const DEPENDENCY_RECEIPT = '.neo-fleet-seat-dependencies.json';

/**
 * The fast-forward outcomes that leave a checkout at its remote's tip, trusted, on its default branch, with no tracked
 * change and no local commit: the only checkouts whose unowned tree the Fleet adopts.
 * @type {String[]}
 * @private
 */
const CURRENT = ['fast-forwarded', 'up-to-date'];

/**
 * The install outcomes that leave a checkout a tree its {@link SEAT_START_SCRIPT} can run on.
 * @type {String[]}
 * @private
 */
const READY = ['installed', 'present', 'unverified', 'not-applicable'];

/**
 * The bound on one checkout's `npm ci`. Past it `npm` is stopped and the checkout's row reads `failed`.
 * @type {Number}
 */
export const INSTALL_TIMEOUT_MS = 600_000;

/**
 * How long a stopped command's process group gets between `SIGTERM` and `SIGKILL`.
 * @type {Number}
 */
export const KILL_GRACE_MS = 5_000;

/**
 * The bound on reading the operator's login shell: a profile that blocks is a failure, not a wait.
 * @type {Number}
 */
export const SHELL_RESOLUTION_TIMEOUT_MS = 15_000;

/**
 * The only variables the login shell and `npm` inherit. The Fleet's own environment carries plane, forge
 * and bridge credentials, and `npm ci` runs every dependency's install scripts.
 * @type {String[]}
 */
const INHERITED_ENV = ['HOME', 'LANG', 'LOGNAME', 'SHELL', 'TMPDIR', 'USER'];

const NPM_ARGS    = ['ci', '--include=dev', '--no-audit', '--no-fund'],
      NPM_MARKER  = '__NEO_NPM__',
      PATH_MARKER = '__NEO_PATH__';

/**
 * @summary The environment a login shell or `npm` starts with: {@link INHERITED_ENV}, nothing else.
 * @param {Object} env The Fleet's environment.
 * @returns {Object}
 * @private
 */
function inheritedEnv(env) {
    return Object.fromEntries(INHERITED_ENV.filter(key => env[key] != null).map(key => [key, env[key]]))
}

/**
 * @summary Resolves `npm`, and the `PATH` it must run with, from the operator's login shell.
 *
 * The Fleet runs inside a GUI app whose `PATH` holds the organism's `node` shim and the system directories,
 * and no `npm`. A seat's own shell resolves its toolchain through the operator's shell profile, so an install
 * run anywhere else would build native addons for a runtime the seat never uses. The shell is interactive as
 * well as a login shell, because version managers hook into the interactive profile. Markers find the two
 * values in output a profile may also write to.
 *
 * @param {Object}   [options]
 * @param {Object}   [options.env=process.env]       The Fleet's environment; only `SHELL` and {@link INHERITED_ENV} are read.
 * @param {Function} [options.execute=execFileAsync] Node's promisified subprocess boundary.
 * @returns {Promise<{npm: String, PATH: String}|{reason: String}>}
 */
export async function resolveLoginShellNpm({env = process.env, execute = execFileAsync} = {}) {
    const shell = env.SHELL;

    if (!shell) return {reason: 'no login shell (SHELL) to resolve npm from'};

    try {
        const
            {stdout} = await execute(shell, ['-ilc', `printf '${NPM_MARKER}%s\\n${PATH_MARKER}%s\\n' "$(command -v npm)" "$PATH"`], {
                env      : inheritedEnv(env),
                timeout  : SHELL_RESOLUTION_TIMEOUT_MS,
                maxBuffer: 1 << 20
            }),
            npm      = stdout.match(new RegExp(`${NPM_MARKER}(.*)`))?.[1].trim(),
            PATH     = stdout.match(new RegExp(`${PATH_MARKER}(.*)`))?.[1].trim();

        return npm && path.isAbsolute(npm) && PATH
            ? {npm, PATH}
            : {reason: `npm is not on the PATH of the login shell ${shell}`}
    } catch (error) {
        return {reason: `the login shell ${shell} could not resolve npm: ${redactReadFailure(error) ?? 'no legible error'}`}
    }
}

/**
 * How often a command whose leader has exited is checked for the rest of its process group.
 * @type {Number}
 */
const GROUP_POLL_MS = 50;

/**
 * @summary Runs one command to its exit, the whole of it. The command leads its own process group, because `npm`
 * runs lifecycle scripts as children that can outlive it: a stop, from the Start's signal or the timeout, signals
 * the group, and the answer waits until no process of the group is left. So a canceled Start never spawns its
 * harness beside a still-running install, and a Skip never launches beside one. A process that outlives a leader's
 * ordinary exit is ended the same way.
 * @param {String}      file
 * @param {String[]}    args
 * @param {Object}      options
 * @param {String}      options.cwd
 * @param {Object}      options.env
 * @param {AbortSignal} [options.signal]
 * @param {Number}      [options.timeout=INSTALL_TIMEOUT_MS]
 * @param {Number}      [options.killGraceMs=KILL_GRACE_MS] Between `SIGTERM` and `SIGKILL`.
 * @returns {Promise<void>} Resolves on exit code 0. Rejects with the exit code and the end of stderr, or, after a
 *     stop, with `{canceled}` set for the signal and unset for the timeout.
 */
export function runToExit(file, args, {cwd, env, signal, timeout = INSTALL_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS}) {
    const command = `${path.basename(file)} ${args[0]}`;

    if (signal?.aborted) return Promise.reject(Object.assign(new Error(`${command} canceled before it started`), {canceled: true}));

    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe']});

        let stderr = '', stopped = null, escalation = null, settled = false;

        const
            signalGroup = name => { try { process.kill(-child.pid, name) } catch {} },
            groupAlive  = () => {
                try {
                    process.kill(-child.pid, 0);
                    return true
                } catch (error) {
                    return error.code === 'EPERM'
                }
            },
            terminate   = () => {
                if (escalation) return;

                escalation = setTimeout(() => signalGroup('SIGKILL'), killGraceMs);
                signalGroup('SIGTERM')
            },
            stop        = why => {
                if (stopped) return;

                stopped = why;
                terminate()
            },
            onAbort     = () => stop('canceled'),
            timer       = setTimeout(() => stop(`timed out after ${timeout} ms`), timeout),
            settle      = (fn, value) => {
                if (settled) return;

                settled = true;
                clearTimeout(timer);
                clearTimeout(escalation);
                signal?.removeEventListener('abort', onAbort);
                fn(value)
            };

        signal?.addEventListener('abort', onAbort, {once: true});
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) });
        child.on('error', error => settle(reject, error));
        child.on('exit', (code, exitSignal) => {
            const
                [fn, value] = stopped    ? [reject, Object.assign(new Error(`${command} ${stopped}`), {canceled: stopped === 'canceled'})]
                            : code === 0 ? [resolve]
                            :              [reject, new Error(`${command} exited ${code ?? exitSignal}: ${stderr.trim()}`)],
                drain       = () => groupAlive() ? setTimeout(drain, GROUP_POLL_MS) : settle(fn, value);

            groupAlive() && terminate();
            drain()
        })
    })
}

/**
 * @summary The digest of a checkout's `package-lock.json`, which an owned install records so a changed lockfile
 * installs again.
 * @param {String} repoPath
 * @returns {String}
 */
export function lockDigest(repoPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(repoPath, 'package-lock.json'))).digest('hex').slice(0, 16)
}

/**
 * @summary The packages in a checkout's `node_modules` that are symlinks its lockfile does not mark `link: true`.
 * Such a link is an `npm link` to other work, which no `git status` sees and `npm ci` would remove; a declared one,
 * such as a `file:` dependency, `npm ci` recreates.
 * @param {String} repoPath
 * @returns {String[]}
 * @private
 */
function undeclaredLinks(repoPath) {
    const
        {packages = {}} = JSON.parse(fs.readFileSync(path.join(repoPath, 'package-lock.json'), 'utf8')),
        root            = path.join(repoPath, 'node_modules'),
        links           = [];

    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
        if (entry.isSymbolicLink()) links.push(entry.name);
        else if (entry.isDirectory() && entry.name.startsWith('@')) {
            for (const scoped of fs.readdirSync(path.join(root, entry.name), {withFileTypes: true})) {
                scoped.isSymbolicLink() && links.push(`${entry.name}/${scoped.name}`)
            }
        }
    }

    return links.filter(name => packages[`node_modules/${name}`]?.link !== true)
}

/**
 * @summary Installs one seat checkout's locked dependencies before the harness that works in it starts.
 *
 * A fresh managed clone has no `node_modules`, and in the Engine that is where the skills every instruction file
 * names come from: `npm ci` runs `prepare`, which materializes them. The rule is absence-based, like clone-or-reuse.
 * A checkout without a `package-lock.json` is `not-applicable`. A tree this Fleet finished installing from the same
 * lockfile is `present`; a changed lockfile, or an entry that predates the digest, installs again. A tree whose owned
 * install never finished (`installing` or `failed` in the receipt) is the Fleet's own, so it installs again rather
 * than reading a half-built tree as ready.
 *
 * A tree the Fleet did not install is `unverified` and stays untouched, because `npm ci` deletes `node_modules` first
 * and could pull files out from under a seat's own work. The one exception is a checkout its fast-forward just left
 * {@link CURRENT}, whose `node_modules` holds no undeclared link: nothing there is a seat's, so the Fleet adopts it,
 * and the receipt records `adoptedFrom: 'unverified'`.
 *
 * The outcome is data, never a throw, and a failure's reason is credential-redacted and bounded
 * ({@link module:ai/services/fleet/redactReadFailure}). An install its signal stopped reads `failed` with
 * `canceled: true`, and the caller decides what the stop meant.
 *
 * @param {Object}      options
 * @param {String}      options.repoPath               The checkout's absolute path.
 * @param {Object|null} [options.prior=null]           This checkout's entry in the seat's {@link DEPENDENCY_RECEIPT}.
 * @param {Object|null} [options.update=null]          This Start's fast-forward outcome for the checkout
 *                                                     ({@link module:ai/services/fleet/ensureAgentRepo.fastForwardAgentRepo}).
 * @param {AbortSignal} [options.signal]               The Start's signal; aborting it stops `npm`.
 * @param {Object}      [options.env=process.env]      The Fleet's environment; `npm` inherits only {@link INHERITED_ENV} from it.
 * @param {Function}    [options.run=runToExit]        `(file, args, {cwd, env, signal}) => Promise<void>`.
 * @param {Function}    [options.resolveNpm]           `() => Promise<{npm, PATH}|{reason}>`, called only when an install is
 *                                                     due; defaults to {@link resolveLoginShellNpm} over the same `env`.
 * @param {Function}    [options.record]               `entry => Promise<void>`, the receipt writer: `{state: 'installing'}`
 *                                                     before `npm` starts, then its outcome. A rejected `installing` write
 *                                                     keeps `npm` from running; a rejected outcome write leaves the receipt at
 *                                                     `installing`, so the next Start installs again.
 * @returns {Promise<{state: 'installed'|'present'|'unverified'|'not-applicable'|'failed', reason?: String, canceled?: Boolean}>}
 */
export async function installAgentRepoDependencies({
    repoPath,
    prior      = null,
    update     = null,
    signal,
    env        = process.env,
    run        = runToExit,
    resolveNpm = () => resolveLoginShellNpm({env}),
    record     = async () => {}
}) {
    if (!fs.existsSync(path.join(repoPath, 'package-lock.json'))) return {state: 'not-applicable'};

    let lock, adoptedFrom = prior?.adoptedFrom;

    try {
        lock = lockDigest(repoPath)
    } catch (error) {
        return {state: 'failed', reason: `the lockfile could not be read: ${redactReadFailure(error) ?? 'no legible error'}`}
    }

    if (fs.existsSync(path.join(repoPath, 'node_modules'))) {
        if (prior?.state === 'installed' && prior.lock === lock) return {state: 'present'};

        if (!['installed', 'installing', 'failed'].includes(prior?.state)) {
            if (!CURRENT.includes(update?.state)) return {state: 'unverified'};

            let links;

            try {
                links = undeclaredLinks(repoPath)
            } catch (error) {
                return {state: 'unverified', reason: `its links could not be checked: ${redactReadFailure(error) ?? 'no legible error'}`}
            }

            if (links.length) return {state: 'unverified', reason: `node_modules holds links its lockfile does not declare: ${links.join(', ')}`};

            adoptedFrom = 'unverified'
        }
    }

    const
        resolution = await resolveNpm(),
        provenance = adoptedFrom ? {adoptedFrom} : {};

    if (!resolution.npm) return {state: 'failed', reason: resolution.reason};

    // `npm ci` rebuilds the tree, so the ownership must be on record first: a receipt still saying
    // `installed` would vouch for whatever a failed install leaves behind.
    try {
        await record({state: 'installing', ...provenance});
    } catch (error) {
        return {state: 'failed', reason: `the seat receipt could not record the install, so npm did not run: ${redactReadFailure(error) ?? 'no legible error'}`}
    }

    let outcome;

    try {
        await run(resolution.npm, NPM_ARGS, {cwd: repoPath, env: {...inheritedEnv(env), PATH: resolution.PATH}, signal});
        outcome = {state: 'installed'}
    } catch (error) {
        outcome = {state: 'failed', reason: redactReadFailure(error) ?? 'npm ci failed with no legible error', ...(error?.canceled ? {canceled: true} : {})}
    }

    try {
        // the digest is written only once `npm ci` has exited 0, so a failed install never vouches for its lockfile
        await record(outcome.state === 'installed' ? {state: 'installed', lock, ...provenance} : {state: 'failed', reason: outcome.reason, ...provenance});
    } catch (error) {
        if (outcome.state === 'installed') {
            return {state: 'installed', reason: `the seat receipt could not record it, so the next Start installs again: ${redactReadFailure(error) ?? 'no legible error'}`}
        }
    }

    return outcome
}

/**
 * The npm script in which a repository declares what a fresh Start needs beyond its dependencies, such as built assets
 * or a config migration. Fleet runs it after the checkout's install, so Fleet itself names no repository's build.
 * @type {String}
 */
export const SEAT_START_SCRIPT = 'seat:start';

/**
 * @summary Runs a checkout's {@link SEAT_START_SCRIPT} when its `package.json` declares one, with the install's own
 * login-shell `npm`, `PATH` and environment.
 *
 * The outcome is data, never a throw: `null` when the checkout declares no such script, otherwise `{state: 'ran'}` or
 * `{state: 'failed', reason, canceled?}`.
 * @param {Object}      options
 * @param {String}      options.repoPath              The checkout's absolute path.
 * @param {AbortSignal} [options.signal]              The Start's signal; aborting it stops the script.
 * @param {Object}      [options.env=process.env]     The Fleet's environment; the script inherits only {@link INHERITED_ENV}.
 * @param {Function}    [options.run=runToExit]
 * @param {Function}    [options.resolveNpm]          Called only when the script is declared.
 * @returns {Promise<Object|null>}
 */
export async function runSeatStart({repoPath, signal, env = process.env, run = runToExit, resolveNpm = () => resolveLoginShellNpm({env})}) {
    let scripts;

    try {
        ({scripts} = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')))
    } catch {
        return null
    }

    if (typeof scripts?.[SEAT_START_SCRIPT] !== 'string') return null;

    const resolution = await resolveNpm();

    if (!resolution.npm) return {state: 'failed', reason: resolution.reason};

    try {
        await run(resolution.npm, ['run', SEAT_START_SCRIPT], {cwd: repoPath, env: {...inheritedEnv(env), PATH: resolution.PATH}, signal});
        return {state: 'ran'}
    } catch (error) {
        return {state: 'failed', reason: redactReadFailure(error) ?? `npm run ${SEAT_START_SCRIPT} failed with no legible error`,
            ...(error?.canceled ? {canceled: true} : {})}
    }
}

/**
 * @summary Reads the seat's dependency receipt; a missing or unreadable one reads as no owned install at all.
 * @param {String} receiptPath
 * @returns {Object}
 */
export function readDependencyReceipt(receiptPath) {
    try {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));

        return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : {}
    } catch {
        return {}
    }
}

/**
 * @summary Installs every checkout of one seat in parallel, resolving `npm` at most once and keeping the seat's
 * {@link DEPENDENCY_RECEIPT}. Receipt writes are serialized; one that fails keeps the previous receipt in place, and
 * its failure reaches the install that asked for it ({@link installAgentRepoDependencies} `record`).
 *
 * Each row is reported as it changes (`installing`, then its outcome), so a pending Start can show its install
 * phase. Every install that leaves a tree is followed by the checkout's {@link SEAT_START_SCRIPT}
 * ({@link runSeatStart}), whose outcome the row carries as `seatStart`. A Skip stops every running `npm` and waits for
 * its exit: an install or start step it interrupted reads `skipped`, one that had already finished keeps its outcome,
 * and the caller goes on to launch. A Stop wins over a Skip, and what it interrupted reads `canceled`: an operator's
 * act, not a failure.
 *
 * @param {Object}      options
 * @param {Object[]}    options.checkouts    `[{repoSlug, repoPath, update?}]`, the seat's working checkout first;
 *                                           `update` is its fast-forward outcome, which its row carries.
 * @param {String}      options.seatRoot     The seat's folder, which holds the receipt.
 * @param {AbortSignal} [options.signal]     The Start's signal.
 * @param {AbortSignal} [options.skipSignal] The operator's Skip: stops the installs, never the Start.
 * @param {Function}    [options.onRows]     `rows => void`, each change's rows in checkout order, undecided ones left out.
 * @param {Function}    [options.install=installAgentRepoDependencies]
 * @param {Function}    [options.seatStart=runSeatStart]
 * @param {Function}    [options.resolveNpm=resolveLoginShellNpm]
 * @param {Function}    [options.now]        ISO timestamp source for the receipt.
 * @param {Function}    [options.write=writeFileAtomic] `(path, text) => Promise<void>`, the receipt's atomic write.
 * @returns {Promise<Object[]>} `[{repoSlug, state, reason?, update?, seatStart?}]`, one row per checkout, in checkout order.
 */
export async function installSeatDependencies({
    checkouts,
    seatRoot,
    signal,
    skipSignal,
    onRows     = () => {},
    install    = installAgentRepoDependencies,
    seatStart  = runSeatStart,
    resolveNpm = resolveLoginShellNpm,
    now        = () => new Date().toISOString(),
    write      = writeFileAtomic
}) {
    const
        receiptPath = path.join(seatRoot, DEPENDENCY_RECEIPT),
        receipt     = readDependencyReceipt(receiptPath),
        stops       = [signal, skipSignal].filter(Boolean),
        rows        = checkouts.map(() => null),
        report      = (index, row) => {
            rows[index] = row;
            onRows(rows.filter(Boolean).map(entry => ({...entry})))
        };

    let resolution,
        writes = Promise.resolve();

    await Promise.all(checkouts.map(async ({repoSlug, repoPath, update}, index) => {
        const
            row      = fields => update ? {repoSlug, ...fields, update} : {repoSlug, ...fields},
            stop     = stops.length > 1 ? AbortSignal.any(stops) : stops[0],
            stopped  = (phase, fields) => signal?.aborted     ? {state: 'canceled', reason: `stopped during ${phase}`}
                                        : skipSignal?.aborted ? {state: 'skipped',  reason: `skipped during ${phase}`}
                                        :                       fields,
            npm      = () => resolution ??= resolveNpm();

        const {canceled, ...outcome} = await install({
            repoPath,
            prior     : receipt[repoSlug] ?? null,
            update    : update ?? null,
            signal    : stop,
            resolveNpm: npm,
            record    : entry => {
                entry.state === 'installing' && report(index, row({state: 'installing'}));
                receipt[repoSlug] = {...entry, at: now()};

                const written = writes.then(() => write(receiptPath, `${JSON.stringify(receipt, null, 4)}\n`));

                writes = written.catch(() => {});
                return written
            }
        });

        const installed = row(canceled ? stopped('the install', outcome) : outcome);

        report(index, installed);

        // the repository's own start step needs a tree, so it follows every install that left one
        if (!READY.includes(installed.state) || stop?.aborted) return;

        const started = await seatStart({repoPath, signal: stop, resolveNpm: npm});

        if (started) {
            const {canceled: interrupted, ...ran} = started;

            report(index, {...installed, seatStart: interrupted ? stopped(SEAT_START_SCRIPT, ran) : ran})
        }
    }));

    await writes;

    return rows
}
