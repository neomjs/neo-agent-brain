import {writeFileAtomic}   from '../shared/atomicFileWrite.mjs';
import {redactReadFailure} from './redactReadFailure.mjs';
import {execFile, spawn}   from 'node:child_process';
import fs                  from 'node:fs';
import path                from 'node:path';
import {promisify}         from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The seat-home receipt of the installs this Fleet started: `{[repoSlug]: {state, at, reason?}}`, where `state` is
 * `installing`, `installed` or `failed`. Beside the memory import's receipt, outside every checkout.
 * @type {String}
 */
export const DEPENDENCY_RECEIPT = '.neo-fleet-seat-dependencies.json';

/**
 * The bound on one checkout's `npm ci`. Past it `npm` is stopped and the checkout's row reads `failed`.
 * @type {Number}
 */
export const INSTALL_TIMEOUT_MS = 600_000;

/**
 * How long a stopped `npm` gets between `SIGTERM` and `SIGKILL`.
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
 * @summary Runs one command to its exit. A stop, from the Start's signal or the timeout, terminates the command and
 * still waits for it to exit, so a canceled Start never spawns its harness beside a still-running install.
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
        const child = spawn(file, args, {cwd, env, stdio: ['ignore', 'ignore', 'pipe']});

        let stderr = '', stopped = null, escalation = null, settled = false;

        const
            stop    = why => {
                if (stopped) return;

                stopped    = why;
                escalation = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
                child.kill('SIGTERM')
            },
            onAbort = () => stop('canceled'),
            timer   = setTimeout(() => stop(`timed out after ${timeout} ms`), timeout),
            settle  = (fn, value) => {
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
            if (stopped)    return settle(reject, Object.assign(new Error(`${command} ${stopped}`), {canceled: stopped === 'canceled'}));
            if (code === 0) return settle(resolve);

            settle(reject, new Error(`${command} exited ${code ?? exitSignal}: ${stderr.trim()}`))
        })
    })
}

/**
 * @summary Installs one seat checkout's locked dependencies before the harness that works in it starts.
 *
 * A fresh managed clone has no `node_modules`, and in the Engine that is where the skills every instruction file
 * names come from: `npm ci` runs `prepare`, which materializes them. The rule is absence-based, like clone-or-reuse.
 * A checkout without a `package-lock.json` is `not-applicable`. A tree this Fleet finished installing is `present`.
 * A tree it did not install is `unverified` and stays untouched: `npm ci` deletes `node_modules` first, which could
 * pull files out from under a seat's own work. A tree whose owned install never finished (`installing` or `failed`
 * in the receipt) is the Fleet's own, so it installs again rather than reading a half-built tree as ready.
 *
 * The outcome is data, never a throw, and a failure's reason is credential-redacted and bounded
 * ({@link module:ai/services/fleet/redactReadFailure}). An install its signal stopped reads `failed` with
 * `canceled: true`, and the caller decides what the stop meant.
 *
 * @param {Object}      options
 * @param {String}      options.repoPath               The checkout's absolute path.
 * @param {Object|null} [options.prior=null]           This checkout's entry in the seat's {@link DEPENDENCY_RECEIPT}.
 * @param {AbortSignal} [options.signal]               The Start's signal; aborting it stops `npm`.
 * @param {Object}      [options.env=process.env]      The Fleet's environment; `npm` inherits only {@link INHERITED_ENV} from it.
 * @param {Function}    [options.run=runToExit]        `(file, args, {cwd, env, signal}) => Promise<void>`.
 * @param {Function}    [options.resolveNpm]           `() => Promise<{npm, PATH}|{reason}>`, called only when an install is
 *                                                     due; defaults to {@link resolveLoginShellNpm} over the same `env`.
 * @param {Function}    [options.record]               `entry => Promise<void>`, the receipt writer: `{state: 'installing'}`
 *                                                     before `npm` starts, then its outcome.
 * @returns {Promise<{state: 'installed'|'present'|'unverified'|'not-applicable'|'failed', reason?: String, canceled?: Boolean}>}
 */
export async function installAgentRepoDependencies({
    repoPath,
    prior      = null,
    signal,
    env        = process.env,
    run        = runToExit,
    resolveNpm = () => resolveLoginShellNpm({env}),
    record     = async () => {}
}) {
    if (!fs.existsSync(path.join(repoPath, 'package-lock.json'))) return {state: 'not-applicable'};

    if (fs.existsSync(path.join(repoPath, 'node_modules'))) {
        if (prior?.state === 'installed')                               return {state: 'present'};
        if (prior?.state !== 'installing' && prior?.state !== 'failed') return {state: 'unverified'}
    }

    const resolution = await resolveNpm();

    if (!resolution.npm) return {state: 'failed', reason: resolution.reason};

    await record({state: 'installing'});

    try {
        await run(resolution.npm, NPM_ARGS, {cwd: repoPath, env: {...inheritedEnv(env), PATH: resolution.PATH}, signal});
        await record({state: 'installed'});

        return {state: 'installed'}
    } catch (error) {
        const reason = redactReadFailure(error) ?? 'npm ci failed with no legible error';

        await record({state: 'failed', reason});

        return {state: 'failed', reason, ...(error?.canceled ? {canceled: true} : {})}
    }
}

/**
 * @summary Reads the seat's dependency receipt; a missing or unreadable one reads as no owned install at all.
 * @param {String} receiptPath
 * @returns {Object}
 * @private
 */
function readReceipt(receiptPath) {
    try {
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));

        return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : {}
    } catch {
        return {}
    }
}

/**
 * @summary Installs every checkout of one seat in parallel, resolving `npm` at most once and keeping the seat's
 * {@link DEPENDENCY_RECEIPT}. Receipt writes are serialized; one that fails keeps the previous receipt in place.
 *
 * Each row is reported as it changes (`installing`, then its outcome), so a pending Start can show its install
 * phase. A Skip stops every running `npm` and waits for its exit: an install it interrupted reads `skipped`, one
 * that had already finished keeps its outcome, and the caller goes on to launch. A Stop wins over a Skip, and the
 * installs it interrupted read `canceled`: an operator's act, not a failure.
 *
 * @param {Object}      options
 * @param {Object[]}    options.checkouts    `[{repoSlug, repoPath}]`, the seat's working checkout first.
 * @param {String}      options.seatRoot     The seat's folder, which holds the receipt.
 * @param {AbortSignal} [options.signal]     The Start's signal.
 * @param {AbortSignal} [options.skipSignal] The operator's Skip: stops the installs, never the Start.
 * @param {Function}    [options.onRows]     `rows => void`, each change's rows in checkout order, undecided ones left out.
 * @param {Function}    [options.install=installAgentRepoDependencies]
 * @param {Function}    [options.resolveNpm=resolveLoginShellNpm]
 * @param {Function}    [options.now]        ISO timestamp source for the receipt.
 * @returns {Promise<Object[]>} `[{repoSlug, state, reason?}]`, one row per checkout, in checkout order.
 */
export async function installSeatDependencies({
    checkouts,
    seatRoot,
    signal,
    skipSignal,
    onRows     = () => {},
    install    = installAgentRepoDependencies,
    resolveNpm = resolveLoginShellNpm,
    now        = () => new Date().toISOString()
}) {
    const
        receiptPath = path.join(seatRoot, DEPENDENCY_RECEIPT),
        receipt     = readReceipt(receiptPath),
        stops       = [signal, skipSignal].filter(Boolean),
        rows        = checkouts.map(() => null),
        report      = (index, row) => {
            rows[index] = row;
            onRows(rows.filter(Boolean).map(entry => ({...entry})))
        };

    let resolution,
        writes = Promise.resolve();

    await Promise.all(checkouts.map(async ({repoSlug, repoPath}, index) => {
        const {canceled, ...outcome} = await install({
            repoPath,
            prior     : receipt[repoSlug] ?? null,
            signal    : stops.length > 1 ? AbortSignal.any(stops) : stops[0],
            resolveNpm: () => resolution ??= resolveNpm(),
            record    : entry => {
                entry.state === 'installing' && report(index, {repoSlug, state: 'installing'});
                receipt[repoSlug] = {...entry, at: now()};
                writes = writes.then(() => writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 4)}\n`)).catch(() => {});

                return writes
            }
        });

        report(index, canceled && signal?.aborted     ? {repoSlug, state: 'canceled', reason: 'stopped during the install'}
                    : canceled && skipSignal?.aborted ? {repoSlug, state: 'skipped',  reason: 'skipped during the install'}
                    :                                   {repoSlug, ...outcome})
    }));

    await writes;

    return rows
}
