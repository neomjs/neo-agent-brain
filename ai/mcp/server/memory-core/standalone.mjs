#!/usr/bin/env node
/**
 * @module ai/mcp/server/memory-core/standalone
 * @summary Standalone CLI launcher (`npx -y neo-memory-core`) placing `~/.neo-ai/memory-core` and its 3 plane members before booting stdio MCP.
 */

import {spawn}         from 'node:child_process';
import fs              from 'node:fs';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {isEntryModule} from '../../../services/shared/isEntryModule.mjs';

const __filename  = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(__filename), '../../../..');

export const DEFAULT_STANDALONE_PLANE_ID = 'neo-standalone-memory-core';

/**
 * @summary Reads the package version from the nearest manifest when available.
 * @returns {String}
 */
function readStandaloneVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
        return pkg.version || '1.0.0';
    } catch {
        return '1.0.0';
    }
}

/**
 * @summary Serializes the standalone Memory Core plane root and all 3 plane-member paths for child server boot.
 * @param {Object} [options={}]
 * @param {String} [options.homedir=os.homedir()] User home directory.
 * @param {String} [options.dataRoot] Explicit `--data-root` relocation override.
 * @param {String} [options.workspace] Explicit `--workspace` slug or path override.
 * @param {String} [options.sessionId] Explicit `--session-id` override.
 * @param {String} [options.planeId=DEFAULT_STANDALONE_PLANE_ID] Opaque plane identifier.
 * @returns {Object<String,String>}
 */
export function standalonePlacement({
    homedir   = os.homedir(),
    dataRoot,
    workspace,
    sessionId,
    planeId   = DEFAULT_STANDALONE_PLANE_ID
} = {}) {
    const root = typeof dataRoot === 'string' && dataRoot.trim().length > 0
        ? path.resolve(dataRoot.trim())
        : path.join(homedir, '.neo-ai', 'memory-core');

    return {
        NEO_PLANE_ID                : planeId,
        NEO_PLANE_DATA_ROOT         : root,
        NEO_MEMORY_WAL_DIR          : path.join(root, 'wal'),
        NEO_MC_STANDALONE_INDEX_PATH: path.join(root, 'index.sqlite'),
        NEO_MC_LOG_PATH             : path.join(root, 'logs'),
        ...(typeof workspace === 'string' && workspace.trim().length > 0
            ? {NEO_MC_WORKSPACE: workspace.trim()}
            : {}),
        ...(typeof sessionId === 'string' && sessionId.trim().length > 0
            ? {NEO_MC_SESSION_ID: sessionId.trim()}
            : {})
    };
}

/**
 * @summary Parses standalone CLI flags without external argument-parser overhead on the launcher path.
 * @param {String[]} [argv=process.argv.slice(2)] Raw CLI arguments.
 * @returns {{configFile: (String|null), dataRoot: (String|undefined), debug: Boolean, help: Boolean, mode: ('launch'|'promote'|'serve'), owner: (String|undefined), sessionId: (String|undefined), sourceWalDir: (String|undefined), targetGraphDb: (String|undefined), targetWalDir: (String|undefined), userId: (String|undefined), version: Boolean, workspace: (String|undefined)}}
 */
export function parseStandaloneArgs(argv = process.argv.slice(2)) {
    const parsed = {
        configFile   : null,
        dataRoot     : undefined,
        debug        : false,
        help         : false,
        mode         : 'launch',
        owner        : undefined,
        sessionId    : undefined,
        sourceWalDir : undefined,
        targetGraphDb: undefined,
        targetWalDir : undefined,
        userId       : undefined,
        version      : false,
        workspace    : undefined
    };

    const readValue = (flag, index) => {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('-')) {
            throw new Error(`Missing required argument for ${flag}.`);
        }
        return next;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === 'promote' && i === 0) {
            parsed.mode = 'promote';
            continue;
        }
        if (arg === '--serve') {
            parsed.mode = 'serve';
            continue;
        }
        if (arg === '-h' || arg === '--help') {
            parsed.help = true;
            continue;
        }
        if (arg === '-V' || arg === '--version') {
            parsed.version = true;
            continue;
        }
        if (arg === '-d' || arg === '--debug') {
            parsed.debug = true;
            continue;
        }
        if (arg === '--workspace') {
            parsed.workspace = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--workspace=')) {
            parsed.workspace = arg.slice('--workspace='.length);
            continue;
        }
        if (arg === '--data-root') {
            parsed.dataRoot = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--data-root=')) {
            parsed.dataRoot = arg.slice('--data-root='.length);
            continue;
        }
        if (arg === '--session-id') {
            parsed.sessionId = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--session-id=')) {
            parsed.sessionId = arg.slice('--session-id='.length);
            continue;
        }
        if (arg === '-c' || arg === '--config') {
            parsed.configFile = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--config=')) {
            parsed.configFile = arg.slice('--config='.length);
            continue;
        }
        if (arg === '--target-wal-dir') {
            parsed.targetWalDir = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--target-wal-dir=')) {
            parsed.targetWalDir = arg.slice('--target-wal-dir='.length);
            continue;
        }
        if (arg === '--source-wal-dir') {
            parsed.sourceWalDir = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--source-wal-dir=')) {
            parsed.sourceWalDir = arg.slice('--source-wal-dir='.length);
            continue;
        }
        if (arg === '--owner') {
            parsed.owner = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--owner=')) {
            parsed.owner = arg.slice('--owner='.length);
            continue;
        }
        if (arg === '--target-graph-db') {
            parsed.targetGraphDb = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--target-graph-db=')) {
            parsed.targetGraphDb = arg.slice('--target-graph-db='.length);
            continue;
        }
        if (arg === '--user-id') {
            parsed.userId = readValue(arg, i++);
            continue;
        }
        if (arg.startsWith('--user-id=')) {
            parsed.userId = arg.slice('--user-id='.length);
            continue;
        }
        if (parsed.mode === 'promote') {
            throw new Error(`Unknown promote argument: ${arg}`);
        }
    }

    return parsed;
}

/**
 * @summary Formats the `--help` usage text for the standalone Memory Core CLI.
 * @returns {String}
 */
export function formatStandaloneHelp() {
    return [
        'Usage: neo-memory-core [options]',
        '       neo-memory-core promote --target-wal-dir <dir> --owner <agentIdentity> [options]',
        '',
        'Standalone zero-daemon Neo.mjs Memory Core MCP server (JSONL WAL + node:sqlite FTS5).',
        '',
        'Server options:',
        '  --workspace <slug-or-path>  Explicit workspace slug or target directory',
        '  --data-root <dir>           Relocate standalone plane root (default: ~/.neo-ai/memory-core)',
        '  --session-id <id>           Default session identifier for add_memory calls',
        '  -c, --config <path>         Optional JSON/MJS config overlay path',
        '  --serve                     Run the stdio MCP server directly in-process with standalone placement',
        '  -d, --debug                 Mirror INFO/DEBUG logs to stderr',
        '  -V, --version               Print version and exit',
        '  -h, --help                  Print help and exit',
        '',
        'Promote options:',
        '  --target-wal-dir <dir>      Target full-plane Memory Core WAL directory (required)',
        '  --owner <agentIdentity>     Rostered AgentIdentity handle to stamp onto promoted records (required)',
        '  --source-wal-dir <dir>      Standalone source WAL directory (default: <data-root>/wal)',
        '  --data-root <dir>           Standalone plane root used when --source-wal-dir is omitted',
        '  --target-graph-db <path>    Optional SQLite graph DB path to validate custom team AgentIdentity rosters',
        '  --user-id <userId>          Optional explicit RLS userId override (default: normalized --owner)',
        '  --workspace <slug-or-path>  Promote only records matching the resolved workspace key'
    ].join('\n');
}

/**
 * @summary Spawns the standalone `--serve` child with serialized plane placement and inherited caller cwd/stdio.
 * @param {Object} [options={}]
 * @param {String[]} [options.argv=process.argv.slice(2)] Raw CLI flags.
 * @param {Object} [options.env=process.env] Parent environment.
 * @param {String} [options.homedir=os.homedir()] Home directory used for default placement.
 * @param {Function} [options.spawnFn=spawn] Injectable child-process spawner.
 * @returns {import('node:child_process').ChildProcess}
 */
export function launch({
    argv    = process.argv.slice(2),
    env     = process.env,
    homedir = os.homedir(),
    spawnFn = spawn
} = {}) {
    const parsed             = parseStandaloneArgs(argv);
    const effectiveWorkspace = parsed.workspace ?? env.NEO_MC_WORKSPACE;
    const effectiveSessionId = parsed.sessionId ?? env.NEO_MC_SESSION_ID;
    const placement          = standalonePlacement({
        homedir,
        dataRoot : parsed.dataRoot,
        workspace: effectiveWorkspace,
        sessionId: effectiveSessionId
    });

    const childArgs = [__filename, '--serve'];
    if (parsed.dataRoot) {
        childArgs.push('--data-root', parsed.dataRoot);
    }
    if (effectiveWorkspace) {
        childArgs.push('--workspace', effectiveWorkspace);
    }
    if (effectiveSessionId) {
        childArgs.push('--session-id', effectiveSessionId);
    }
    if (parsed.configFile) {
        childArgs.push('--config', parsed.configFile);
    }
    if (parsed.debug) {
        childArgs.push('--debug');
    }

    return spawnFn(process.execPath, childArgs, {
        env: {
            ...env,
            ...placement,
            ...(parsed.debug ? {NEO_DEBUG: 'true'} : {})
        },
        stdio: 'inherit'
    });
}

/**
 * @summary Checks whether a parent process PID remains alive.
 * @param {Number} ppid Parent PID.
 * @param {Object} [proc=process] Process object.
 * @returns {Boolean}
 */
export function isParentProcessAlive(ppid, proc = process) {
    if (!Number.isInteger(ppid) || ppid <= 1) {
        return false;
    }

    try {
        proc.kill(ppid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

/**
 * @summary Supervises the spawned `--serve` child and terminates it cleanly on signals or `npx` parent exit.
 * @param {import('node:child_process').ChildProcess} child Spawned server child.
 * @param {Object} [options={}]
 * @param {Number} [options.pollIntervalMs=200] Orphan-check interval in milliseconds.
 * @param {Object} [options.proc=process] Process handle.
 * @returns {Function} Cleanup disposer.
 */
export function superviseChild(child, {pollIntervalMs = 200, proc = process} = {}) {
    const initialPpid = proc.ppid;
    const signals     = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const listeners   = new Map();
    let   terminated  = false;

    const terminateChild = (signal = 'SIGTERM') => {
        if (terminated) {
            return;
        }
        terminated = true;
        try {
            child.kill(signal);
        } catch {}
    };

    for (const signal of signals) {
        const handler = () => terminateChild(signal);
        listeners.set(signal, handler);
        proc.on(signal, handler);
    }

    const onProcExit = () => terminateChild('SIGTERM');
    proc.once('exit', onProcExit);

    const parentTimer = Number.isInteger(initialPpid) && initialPpid > 1
        ? setInterval(() => {
            if (proc.ppid !== initialPpid || !isParentProcessAlive(initialPpid, proc)) {
                terminateChild('SIGTERM');
            }
        }, pollIntervalMs)
        : null;

    parentTimer?.unref();

    const dispose = () => {
        if (parentTimer) {
            clearInterval(parentTimer);
        }
        for (const [signal, handler] of listeners) {
            proc.off(signal, handler);
        }
        proc.off('exit', onProcExit);
    };

    child.on('exit', (code, signal) => {
        dispose();
        proc.exit(code ?? (signal ? 1 : 0));
    });

    return dispose;
}

/**
 * @summary Boots `StandaloneServer` in-process with explicit standalone placement winning over inherited plane env.
 * @param {Object} parsed Parsed CLI options.
 * @param {Object} [options={}]
 * @param {Object} [options.env=process.env] Process environment.
 * @param {String} [options.homedir=os.homedir()] Home directory used when `--data-root` is unset.
 * @returns {Promise<void>}
 */
async function startServeMode(parsed, {env = process.env, homedir = os.homedir()} = {}) {
    const {default: Neo} = await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');
    await import('neo.mjs/src/manager/Instance.mjs');
    const {createStandaloneConfig}    = await import('./standaloneConfigBase.mjs');
    const {default: StandaloneServer} = await import('./standaloneServer.mjs');

    const placement = standalonePlacement({
        homedir,
        dataRoot : parsed.dataRoot,
        workspace: parsed.workspace ?? env.NEO_MC_WORKSPACE,
        sessionId: parsed.sessionId ?? env.NEO_MC_SESSION_ID
    });

    const aiConfig = createStandaloneConfig({
        envOverrides: {
            ...placement,
            ...(parsed.debug ? {NEO_DEBUG: true} : {})
        }
    });

    const server = Neo.create(StandaloneServer, {
        aiConfig,
        configFile        : parsed.configFile,
        ownsConfigInstance: true
    });

    let   shuttingDown = false;
    const shutdown     = () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        try {
            server.destroy();
        } catch {}
        process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);

    await server.ready();
}

/**
 * @summary Executes the `neo-memory-core promote` CLI subcommand and writes the JSON summary receipt to stdout.
 * @param {Object} parsed Parsed CLI options from {@link parseStandaloneArgs}.
 * @param {Object} [options={}]
 * @param {String} [options.cwd=process.cwd()] Working directory for path-shaped `--workspace` resolution.
 * @param {Function} [options.execGit] Injectable git runner forwarded to workspace resolution.
 * @param {String} [options.homedir=os.homedir()] Home directory used when `--source-wal-dir` and `--data-root` are omitted.
 * @param {Object} [options.stdout=process.stdout] Writable stdout stream.
 * @returns {Promise<Object>} Promotion summary receipt.
 */
export async function runPromoteCli(parsed, {
    cwd     = process.cwd(),
    execGit,
    homedir = os.homedir(),
    stdout  = process.stdout
} = {}) {
    const {promoteStandaloneWal} = await import('../../../services/memory-core/helpers/promoteStandaloneWal.mjs');
    const result                 = await promoteStandaloneWal({
        cwd,
        dataRoot     : parsed.dataRoot,
        execGit,
        homedir,
        owner        : parsed.owner,
        sourceWalDir : parsed.sourceWalDir,
        targetGraphDb: parsed.targetGraphDb,
        targetWalDir : parsed.targetWalDir,
        userId       : parsed.userId,
        workspace    : parsed.workspace
    });

    stdout?.write?.(`${JSON.stringify(result)}\n`);
    return result;
}

if (isEntryModule(import.meta.url)) {
    const handleFatal = error => {
        const prefix = process.argv[2] === 'promote' ? 'Promotion error' : 'Fatal startup error';
        process.stderr.write(`[neo-memory-core] ${prefix}: ${error?.stack || error?.message || String(error)}\n`);
        process.exit(1);
    };

    try {
        const parsed = parseStandaloneArgs(process.argv.slice(2));

        if (parsed.help) {
            process.stdout.write(`${formatStandaloneHelp()}\n`);
            process.exit(0);
        }
        if (parsed.version) {
            process.stdout.write(`${readStandaloneVersion()}\n`);
            process.exit(0);
        }
        if (parsed.mode === 'promote') {
            runPromoteCli(parsed).then(
                () => process.exit(0),
                handleFatal
            );
        } else if (parsed.mode === 'serve') {
            startServeMode(parsed).catch(handleFatal);
        } else {
            superviseChild(launch());
        }
    } catch (error) {
        handleFatal(error);
    }
}
