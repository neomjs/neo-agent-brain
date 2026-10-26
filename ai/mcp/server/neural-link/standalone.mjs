#!/usr/bin/env node
/**
 * @module ai/mcp/server/neural-link/standalone
 * @summary The launcher of the standalone Neural Link package: the `bin` an outside developer's
 * MCP client runs (`npx -y <package>`) with no Brain checkout and no Agent OS.
 *
 * It does two things before the server starts, and nothing else:
 *
 * 1. **Declares the standalone placement**, the AiConfig plane profile of this package. The plane goes to
 *    one per-user root, and the server's one plane member, `logPath`, is placed beneath it. The
 *    package itself sits in an npx cache: writable, so no placement guard refuses it, but ephemeral
 *    — without this declaration the logs would land in the cache and vanish with it. The placement
 *    is the launcher's, never inferred from where the code happens to be installed, and it is
 *    process serialization (env handed to the child), as in the packaged Fleet Manager's own mode.
 * 2. **Supplies `--cwd` as the package root.** The package's `package.json` declares
 *    `ai:server-neural-link`, so `ConnectionService#spawnBridge` starts the packaged Bridge through
 *    its existing path, with both of its refusals intact. A Fleet bridge token in the environment
 *    still dials the host-edge Bridge and spawns nothing.
 *
 * The server runs as a child with inherited stdio, because MCP speaks over this process's stdin and
 * stdout and `mcp-server.mjs` runs its program on load rather than behind an entry guard.
 */

import {spawn}         from 'node:child_process';
import {realpathSync}  from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * @summary The env that places a standalone Neural Link's plane beneath one per-user root.
 * @param {Object} options
 * @param {String} options.homedir
 * @returns {{NEO_NL_LOG_PATH: String, NEO_PLANE_DATA_ROOT: String}}
 */
export function standalonePlacement({homedir}) {
    const root = path.join(homedir, '.neo-ai', 'neural-link');

    return {
        NEO_NL_LOG_PATH    : path.join(root, 'logs'),
        NEO_PLANE_DATA_ROOT: root
    }
}

/**
 * @summary Starts the packaged MCP server with the standalone placement and the package root as
 * `--cwd`.
 *
 * The placement is spread AFTER the caller's environment on purpose: a standalone package is its
 * own plane, so an exported `NEO_PLANE_DATA_ROOT` belonging to some other deployment must not be
 * able to point it at that deployment's data.
 * @param {Object} [options]
 * @param {String[]} [options.argv=process.argv.slice(2)] Extra server flags, passed through.
 * @param {Object} [options.env=process.env]
 * @param {String} [options.homedir=os.homedir()]
 * @param {String} [options.root=packageRoot]
 * @param {Function} [options.spawnFn=spawn]
 * @returns {import('node:child_process').ChildProcess}
 */
export function launch({argv = process.argv.slice(2), env = process.env, homedir = os.homedir(), root = packageRoot, spawnFn = spawn} = {}) {
    const server = path.join(root, 'ai/mcp/server/neural-link/mcp-server.mjs');

    return spawnFn(process.execPath, [server, '--cwd', root, ...argv], {
        env  : {...env, ...standalonePlacement({homedir})},
        stdio: 'inherit'
    })
}

// `npx` runs a `bin` through a symlink, so both sides are realpathed: comparing the link path with
// the module URL would never match, and the launcher would load, do nothing and exit 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    const child = launch();

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => child.kill(signal))
    }

    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}
