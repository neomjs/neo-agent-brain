#!/usr/bin/env node

import {spawn}                        from 'node:child_process';
import crypto                         from 'node:crypto';
import fs                             from 'node:fs';
import http                           from 'node:http';
import path                           from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
    LAUNCH_ADMISSION_CREDENTIALS as CREDENTIALS,
    LAUNCH_ADMISSION_OUTCOMES    as OUTCOMES,
    LAUNCH_ADMISSION_REASONS     as REASONS,
    LAUNCH_ADMISSION_REFUSALS    as REFUSALS,
    isLaunchAdmissionProofReason
}                                               from '../../../src/fleet/contract/launchAdmission.mjs';
import {
    LAUNCH_ADMISSION_MAX_BYTES,
    LAUNCH_ADMISSION_PATH,
    LAUNCH_GRANT_ENV_VAR,
    LAUNCH_ISSUER_ENV_VAR,
    createLaunchRequest,
    isAdmissibleEnvName,
    isLaunchIdentity,
    parseLaunchCapability,
    verifyLaunchResponse
}                                               from '../../services/fleet/mcpLaunchAdmission.mjs';

export const
    REFRESH_ENV_MESSAGE_TYPE        = 'neo-fleet-mcp-refresh-env',
    REFRESH_ENV_RESULT_MESSAGE_TYPE = 'neo-fleet-mcp-refresh-env-result';

const
    // The installation this launcher belongs to: an admitted target must be one of its files.
    INSTALL_ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    // Longer than the issuer's own bounds together: a Start still in progress, then a credential proof.
    REQUEST_TIMEOUT_MS = 45000,
    STARTUP_BUDGET_MS  = 60000,
    PARENT_IPC_ENV_VAR = 'NEO_FLEET_MCP_PARENT_IPC',
    TRANSIENT_CODES    = new Set([REFUSALS.PROOF_UNAVAILABLE, REFUSALS.ISSUER_UNAVAILABLE, REFUSALS.PENDING_TIMEOUT]),
    FORWARDED_SIGNALS  = ['SIGHUP', 'SIGINT', 'SIGTERM'],
    REFUSAL_CODES      = new Set(Object.values(REFUSALS)),
    REFUSAL_REASONS    = new Set([...Object.values(REASONS), ...Object.values(CREDENTIALS)]);

/**
 * @summary A refusal the launcher reports on its one stderr line: a code and the issuer's reason, each from
 * its closed vocabulary. Never a value from the environment or other text an answer carries.
 */
export class LaunchRefusal extends Error {
    /**
     * @param {String} code A `LAUNCH_ADMISSION_REFUSALS` value.
     * @param {String|null} [reason=null] A `LAUNCH_ADMISSION_REASONS` value for `revoked`, a
     *     `LAUNCH_ADMISSION_CREDENTIALS` value for a credential refusal.
     */
    constructor(code, reason = null) {
        // a restart does not mend a credential: its owner does, and the next child redeems it again
        const restart = code !== REFUSALS.CREDENTIAL_MISSING && code !== REFUSALS.CREDENTIAL_UNPROVEN && code !== REFUSALS.PROOF_UNAVAILABLE;

        super(`Neo MCP launch refused (${code}${reason ? `, ${reason}` : ''}). Fleet Manager shows this seat's admission${restart ? '; restart the seat there' : code === REFUSALS.PROOF_UNAVAILABLE ? '; retry when the credential service is available' : ''}.`);

        this.name   = 'LaunchRefusal';
        this.code   = code;
        this.reason = reason
    }
}

/**
 * @summary The launcher's grammar: exactly `--server <key>`. Everything else arrives through the row's
 * environment, and nothing secret crosses argv.
 * @param {String[]} argv Arguments after the script path.
 * @returns {{server: String}}
 */
export function parseLauncherArgs(argv) {
    if (argv.length !== 2 || argv[0] !== '--server' || !/^[a-z][a-z0-9-]{0,63}$/.test(argv[1])) {
        throw new LaunchRefusal(REFUSALS.MALFORMED)
    }

    return {server: argv[1]}
}

/**
 * @param {*} value The row's issuer slot.
 * @returns {String|null} The loopback origin it names, or `null`: the hop is local TCP and nothing else.
 */
export function issuerOrigin(value) {
    const match = typeof value === 'string' && /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value);

    return match && Number(match[1]) > 0 && Number(match[1]) < 65536 ? value : null
}

/**
 * @summary The target's argv, held to this installation: the first argument is a file under the launcher's
 * own root, so an answer can name only a server this installation ships.
 * @param {*} args The admitted argv, without the executable.
 * @param {String} [root=INSTALL_ROOT]
 * @returns {String[]}
 */
export function resolveTarget(args, root = INSTALL_ROOT) {
    const valid = Array.isArray(args) && args.length > 0 && args.every(arg => typeof arg === 'string' && !arg.includes('\0'));

    if (!valid || !path.isAbsolute(args[0]) || path.extname(args[0]) !== '.mjs') throw new LaunchRefusal(REFUSALS.TARGET_INVALID);

    let entry, base;

    try {
        entry = fs.realpathSync(args[0]);
        base  = fs.realpathSync(root)
    } catch {
        throw new LaunchRefusal(REFUSALS.TARGET_INVALID)
    }

    if (path.relative(base, entry).startsWith('..') || !fs.statSync(entry).isFile()) throw new LaunchRefusal(REFUSALS.TARGET_INVALID);

    return [...args]
}

/**
 * @summary The target's environment: the row's own, without the two admission slots, plus the admitted
 * values. An admitted name the row already sets is refused rather than chosen, so neither side silently wins.
 * @param {Object} env The launcher's environment.
 * @param {*} admitted The admitted values.
 * @returns {Object}
 */
export function composeTargetEnv(env, admitted) {
    if (!admitted || typeof admitted !== 'object' || Array.isArray(admitted)) throw new LaunchRefusal(REFUSALS.MALFORMED);

    const result = {...env};

    delete result[LAUNCH_GRANT_ENV_VAR];
    delete result[LAUNCH_ISSUER_ENV_VAR];

    for (const [name, value] of Object.entries(admitted)) {
        if (!isAdmissibleEnvName(name) || typeof value !== 'string' || Object.hasOwn(result, name)) {
            throw new LaunchRefusal(REFUSALS.MALFORMED)
        }

        result[name] = value
    }

    return result
}

/**
 * @summary Redeem the grant, retrying transient failures within one 60s wall-clock budget including requests.
 * @param {Object} options
 * @param {String[]} options.argv
 * @param {Object} options.env
 * @param {String} [options.root=INSTALL_ROOT]
 * @param {Function} [options.request=postAdmission] `(origin, body, {timeoutMs}) => Promise<parsed answer>`.
 * @param {Function} [options.now=performance.now] Monotonic clock seam for deadline controls.
 * @param {Function} [options.sleep] Backoff seam; production waits with a timer.
 * @returns {Promise<{args: String[], env: Object, admittedEnv: Object, generationRoot: String}>}
 * @throws {LaunchRefusal}
 */
export async function admitLaunch({argv, env, root = INSTALL_ROOT, request = postAdmission, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
    const
        {server} = parseLauncherArgs(argv),
        grant    = parseLaunchCapability(env[LAUNCH_GRANT_ENV_VAR]),
        origin   = issuerOrigin(env[LAUNCH_ISSUER_ENV_VAR]);

    if (!grant || !origin || !isLaunchIdentity(env.NEO_AGENT_IDENTITY)) throw new LaunchRefusal(REFUSALS.MALFORMED);

    const deadline = now() + STARTUP_BUDGET_MS;
    let   delay    = 1000, last = new LaunchRefusal(REFUSALS.ISSUER_UNAVAILABLE);

    while (now() < deadline) {
        try {
            const
                body     = createLaunchRequest({grant, server, identity: env.NEO_AGENT_IDENTITY}),
                response = await request(origin, body, {timeoutMs: Math.min(REQUEST_TIMEOUT_MS, deadline - now())}),
                payload  = verifyLaunchResponse(grant.secret, body, response);

            if (now() >= deadline) throw last;

            if (!payload) {
                // Nothing unsigned admits; only closed refusal codes may cause another bounded attempt.
                throw new LaunchRefusal(response?.outcome === OUTCOMES.REFUSED && REFUSAL_CODES.has(response.code) ? response.code : REFUSALS.UNAUTHENTICATED)
            }

            if (payload.outcome !== OUTCOMES.ADMITTED) {
                throw new LaunchRefusal(REFUSAL_CODES.has(payload.code) ? payload.code : REFUSALS.UNAUTHENTICATED,
                    REFUSAL_REASONS.has(payload.reason) || isLaunchAdmissionProofReason(payload.reason) ? payload.reason : null)
            }

            let generationRoot;
            try {
                if (typeof payload.generationRoot !== 'string' || !path.isAbsolute(payload.generationRoot)) throw Error();
                generationRoot = fs.realpathSync(payload.generationRoot);
                if (generationRoot !== fs.realpathSync(root)) throw Error();
            } catch {
                throw new LaunchRefusal(REFUSALS.TARGET_INVALID)
            }
            return {
                args       : resolveTarget(payload.args, root),
                env        : composeTargetEnv(env, payload.env),
                admittedEnv: {...payload.env},
                generationRoot
            }
        } catch (error) {
            if (!(error instanceof LaunchRefusal) || !TRANSIENT_CODES.has(error.code)) throw error;
            last = error
        }

        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining));
        delay = Math.min(delay * 2, 8000)
    }

    throw last
}

/**
 * @summary Start the admitted target on Desktop's own stdio and wait for it. Signals reach it as they reach
 * the launcher, and its exit is the launcher's exit. When `refreshEnv` is supplied, opens a 4th IPC descriptor
 * (`stdio: ['inherit', 'inherit', 'inherit', 'ipc']`) so the child can ask the parent launcher to re-redeem
 * fresh admitted credentials without exposing `NEO_FLEET_LAUNCH_GRANT` or `NEO_FLEET_LAUNCH_ISSUER` to the child.
 * @param {Object} options
 * @param {String[]} options.args
 * @param {Object} options.env
 * @param {String} [options.execPath=process.execPath] The executable the row runs, Node or Electron as Node.
 * @param {Function} [options.spawnFn=spawn]
 * @param {Function|null} [options.refreshEnv=null] Optional `() => Promise<{admittedEnv?: Object, env?: Object}>` callback.
 * @returns {Promise<{code: Number|null, signal: String|null}>}
 */
export function runTarget({args, env, execPath = process.execPath, spawnFn = spawn, refreshEnv = null}) {
    return new Promise((resolve, reject) => {
        const hasRefreshIpc = typeof refreshEnv === 'function';
        let child;

        try {
            child = spawnFn(execPath, args, {
                stdio: hasRefreshIpc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
                env  : hasRefreshIpc ? {...env, [PARENT_IPC_ENV_VAR]: '1'} : env
            })
        } catch {
            reject(new LaunchRefusal(REFUSALS.SPAWN_FAILED));
            return
        }

        let inFlight = null, onMessage = null;

        if (hasRefreshIpc && typeof child?.on === 'function') {
            onMessage = async msg => {
                if (!msg || typeof msg !== 'object' || msg.type !== REFRESH_ENV_MESSAGE_TYPE || typeof msg.id !== 'string') {
                    return
                }

                try {
                    inFlight ??= Promise.resolve().then(() => refreshEnv()).finally(() => { inFlight = null });
                    const result       = await inFlight,
                          refreshedEnv = result?.admittedEnv ?? result?.env ?? {};

                    if (child.connected !== false) {
                        child.send?.({
                            type: REFRESH_ENV_RESULT_MESSAGE_TYPE,
                            id  : msg.id,
                            ok  : true,
                            env : refreshedEnv && typeof refreshedEnv === 'object' ? {...refreshedEnv} : {}
                        })
                    }
                } catch (error) {
                    if (child.connected !== false) {
                        child.send?.({
                            type  : REFRESH_ENV_RESULT_MESSAGE_TYPE,
                            id    : msg.id,
                            ok    : false,
                            code  : error?.code ?? null,
                            reason: error?.reason ?? null
                        })
                    }
                }
            };

            child.on('message', onMessage)
        }

        const forward  = signal => () => child.kill(signal);
        const handlers = FORWARDED_SIGNALS.map(signal => [signal, forward(signal)]);

        handlers.forEach(([signal, handler]) => process.on(signal, handler));

        const settle = () => {
            if (onMessage) child.off?.('message', onMessage);
            handlers.forEach(([signal, handler]) => process.off(signal, handler))
        };

        child.once('error', () => {
            settle();
            reject(new LaunchRefusal(REFUSALS.SPAWN_FAILED))
        });
        child.once('exit', (code, signal) => {
            settle();
            resolve({code, signal})
        })
    })
}

/**
 * @summary Ask the parent `fleetMcpLauncher` process over Node IPC to re-redeem the launch grant and return
 * fresh admitted environment values (such as a renewed `NEO_FLEET_BRIDGE_TOKEN`) without exposing
 * `NEO_FLEET_LAUNCH_GRANT` or `NEO_FLEET_LAUNCH_ISSUER` to the child process.
 * @param {Object} [options={}]
 * @param {Object} [options.proc=process] Process-like IPC endpoint (`send`, `on`, `off`).
 * @param {Number} [options.timeoutMs=15000] Maximum wait for the parent reply.
 * @returns {Promise<Object|null>} Fresh admitted env map, or `null` when IPC is unavailable or refused.
 */
export function requestParentEnvRefresh({proc = process, timeoutMs = 15000} = {}) {
    if (
        typeof proc?.send !== 'function' ||
        typeof proc?.on !== 'function' ||
        proc.connected === false ||
        (proc === process && process.env[PARENT_IPC_ENV_VAR] !== '1')
    ) {
        return Promise.resolve(null)
    }

    return new Promise(resolve => {
        const id      = crypto.randomUUID();
        let   settled = false, timer = null;

        const finish = value => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            proc.off?.('message', onMessage);
            proc.off?.('disconnect', onDisconnect);
            resolve(value)
        };

        const onMessage = msg => {
            if (!msg || typeof msg !== 'object' || msg.type !== REFRESH_ENV_RESULT_MESSAGE_TYPE || msg.id !== id) {
                return
            }

            finish(msg.ok && msg.env && typeof msg.env === 'object' && !Array.isArray(msg.env) ? {...msg.env} : null)
        };

        const onDisconnect = () => finish(null);

        timer = setTimeout(() => finish(null), timeoutMs);
        timer.unref?.();

        proc.on('message', onMessage);
        proc.on('disconnect', onDisconnect);

        try {
            proc.send({type: REFRESH_ENV_MESSAGE_TYPE, id})
        } catch {
            finish(null)
        }
    })
}

/**
 * @summary POST one request to the issuer and parse its answer. A connection that fails is
 * `issuer-unavailable`, an answer that is not bounded JSON is `unauthenticated-response`.
 * @param {String} origin
 * @param {Object} body
 * @param {Object} options
 * @param {Number} options.timeoutMs Remaining startup budget, capped by the per-request maximum.
 * @returns {Promise<*>}
 * @private
 */
export function postAdmission(origin, body, {timeoutMs}) {
    let timer;
    return new Promise((resolve, reject) => {
        const
            payload = JSON.stringify(body),
            req     = http.request(new URL(LAUNCH_ADMISSION_PATH, origin), {
                method : 'POST',
                headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)},
                timeout: timeoutMs
            }, res => {
                const chunks = [];
                let   size   = 0;

                res.on('data', chunk => {
                    size += chunk.length;

                    if (size <= LAUNCH_ADMISSION_MAX_BYTES) {
                        chunks.push(chunk)
                    } else {
                        res.destroy();
                        reject(new LaunchRefusal(REFUSALS.UNAUTHENTICATED))
                    }
                });
                res.on('error', () => reject(new LaunchRefusal(REFUSALS.ISSUER_UNAVAILABLE)));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
                    } catch {
                        reject(new LaunchRefusal(REFUSALS.UNAUTHENTICATED))
                    }
                })
            });

        req.on('timeout', () => req.destroy());
        req.on('error', () => reject(new LaunchRefusal(REFUSALS.ISSUER_UNAVAILABLE)));
        // Socket inactivity alone does not bound a peer that keeps streaming a partial answer.
        timer = setTimeout(() => req.destroy(), timeoutMs);
        timer.unref?.();
        req.end(payload)
    }).finally(() => clearTimeout(timer))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const launchArgs = process.argv.slice(2);

    admitLaunch({argv: launchArgs, env: process.env})
        .then(launch => {
            process.stderr.write(`NEO_MCP_LAUNCH_ADMITTED ${JSON.stringify({generationRoot: launch.generationRoot})}\n`);
            return runTarget({
                ...launch,
                refreshEnv: () => admitLaunch({argv: launchArgs, env: process.env})
            })
        })
        .then(({code, signal}) => {
            if (signal) process.kill(process.pid, signal);
            else process.exitCode = code ?? 1
        })
        .catch(error => {
            process.stderr.write(`${error instanceof LaunchRefusal ? error.message : new LaunchRefusal(REFUSALS.SPAWN_FAILED).message}\n`);
            process.exitCode = 1
        })
}
