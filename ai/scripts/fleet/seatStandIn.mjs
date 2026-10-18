#!/usr/bin/env node
import crypto                                        from 'node:crypto';
import fs                                            from 'node:fs';
import path                                          from 'node:path';
import {fileURLToPath}                               from 'node:url';
import {parse as parseToml}                          from 'smol-toml';
import {Client}                                      from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport, getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport}               from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * @module ai/scripts/fleet/seatStandIn
 * @summary A harness stand-in for the seat journey: the executable a desktop family's harness binary points at, so a
 * Fleet Start runs end to end without opening the real app.
 *
 * The Fleet launches it with the family's own argv and env (`deriveHarnessLaunchSpec`). It reads the family's MCP
 * config where the real app reads it, starts every row the way the app would, and asks each one `initialize`,
 * `tools/list` and `healthcheck`. The answers land in `<instanceHome>/seat-stand-in.json`, one record per launch keyed
 * by pid. The process then holds its servers until SIGTERM, like a session.
 *
 * It parses the config itself (JSON for Claude Desktop, TOML for Codex Desktop) and never imports the Fleet writer
 * it checks: a reader sharing the writer's code would agree with any bug the writer has.
 * @see ai/services/fleet/seatJourney.mjs
 */

/**
 * The file each launch appends its record to, inside the instance home.
 * @type {String}
 */
export const STAND_IN_RECORD_FILE = 'seat-stand-in.json';

/**
 * Records kept per file; the journey reads only the launch it started.
 * @type {Number}
 */
const RECORD_LIMIT = 10;

/**
 * Per-row budget for each of the three asks.
 * @type {Number}
 */
const ROW_STEP_TIMEOUT_MS = 30_000;

/**
 * @summary Resolve the family, its instance home and its MCP rows from the launch the Fleet made.
 *
 * Claude Desktop is launched with `CLAUDE_USER_DATA_DIR` and reads `claude_desktop_config.json` there. Codex Desktop
 * is launched with `CODEX_HOME=<instanceHome>/codex-home` and `--open-project=<repo>`; it reads the home's
 * `config.toml` and then the project's `.codex/config.toml`, whose rows win by name.
 * @param {Object}   options
 * @param {String[]} options.argv
 * @param {Object}   options.env
 * @returns {{family: String, instanceHome: String, configPaths: String[], rows: Object[]}}
 */
export function resolveLaunch({argv, env}) {
    if (env.CLAUDE_USER_DATA_DIR) {
        const
            instanceHome = env.CLAUDE_USER_DATA_DIR,
            configPath   = path.join(instanceHome, 'claude_desktop_config.json'),
            servers      = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers ?? {};

        return {family: 'claude-desktop', instanceHome, configPaths: [configPath], rows: toRows(servers)}
    }

    if (env.CODEX_HOME) {
        const
            project     = argv.find(arg => arg.startsWith('--open-project='))?.slice('--open-project='.length),
            configPaths = [path.join(env.CODEX_HOME, 'config.toml'), project && path.join(project, '.codex', 'config.toml')]
                .filter(file => file && fs.existsSync(file)),
            servers     = Object.assign({}, ...configPaths.map(file => parseToml(fs.readFileSync(file, 'utf8')).mcp_servers ?? {}));

        return {family: 'codex-desktop', instanceHome: path.dirname(env.CODEX_HOME), configPaths, rows: toRows(servers)}
    }

    throw new Error('seatStandIn: no family launch found (expected CLAUDE_USER_DATA_DIR or CODEX_HOME).')
}

/**
 * @summary One row per configured server, in config order.
 * @param {Object} servers The family's `mcpServers` / `mcp_servers` map.
 * @returns {Object[]}
 */
function toRows(servers) {
    return Object.entries(servers).map(([name, server]) => ({name, ...server}))
}

/**
 * @summary Connect to one row as its harness would and ask `initialize`, `tools/list` and `healthcheck`.
 *
 * A stdio row runs its `command` with its `args` and its `env` over the client's default environment. A Codex `url`
 * row speaks streamable HTTP, with the bearer read from the variable `bearer_token_env_var` names.
 * @param {Object} options
 * @param {Object} options.row
 * @param {Object} options.env The stand-in's own environment, for a row's bearer variable.
 * @returns {Promise<{result: Object, client: Client|null}>} The client stays open on success.
 */
export async function probeRow({row, env}) {
    const
        started = Date.now(),
        client  = new Client({name: 'neo-seat-stand-in', version: '1.0.0'}),
        stderr  = [];
    let step = 'initialize';

    try {
        const transport = row.url
            ? new StreamableHTTPClientTransport(new URL(row.url), {
                requestInit: {headers: row.bearer_token_env_var ? {Authorization: `Bearer ${env[row.bearer_token_env_var] ?? ''}`} : {}}
            })
            : new StdioClientTransport({
                command: row.command,
                args   : row.args ?? [],
                env    : {...getDefaultEnvironment(), ...row.env},
                cwd    : row.cwd,
                stderr : 'pipe'
            });

        transport.stderr?.on('data', chunk => stderr.push(String(chunk)));

        await withTimeout(client.connect(transport), step);
        step = 'tools/list';
        const {tools} = await withTimeout(client.listTools(), step);
        step = 'healthcheck';
        const healthcheck = tools.some(tool => tool.name === 'healthcheck')
            ? readToolResult(await withTimeout(client.callTool({name: 'healthcheck', arguments: {}}), step))
            : null;

        return {client, result: {name: row.name, ok: true, tools: tools.length, healthcheck, ms: Date.now() - started}}
    } catch (error) {
        await client.close().catch(() => {});

        return {client: null, result: {
            name  : row.name,
            ok    : false,
            step,
            reason: error.message,
            stderr: stderr.join('').slice(-2000),
            ms    : Date.now() - started
        }}
    }
}

/**
 * @summary A tool result as data: its structured content, else its first text block parsed as JSON, else that text.
 * @param {Object} result
 * @returns {*}
 */
function readToolResult(result) {
    if (result.structuredContent) return result.structuredContent;

    const text = result.content?.find(block => block.type === 'text')?.text;

    try {
        return JSON.parse(text)
    } catch {
        return text ?? null
    }
}

/**
 * @summary Rejects a step that outlives its budget, naming the step.
 * @param {Promise} promise
 * @param {String}  step
 * @returns {Promise}
 */
function withTimeout(promise, step) {
    let timer;

    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${step} did not answer within ${ROW_STEP_TIMEOUT_MS} ms`)), ROW_STEP_TIMEOUT_MS)
        })
    ]).finally(() => clearTimeout(timer))
}

/**
 * @summary Append this launch's record, keeping the newest {@link RECORD_LIMIT}; written whole, then renamed.
 * @param {String} instanceHome
 * @param {Object} record
 */
export function appendRecord(instanceHome, record) {
    const file    = path.join(instanceHome, STAND_IN_RECORD_FILE);
    let   records = [];

    try {
        records = JSON.parse(fs.readFileSync(file, 'utf8')).records ?? []
    } catch {}

    records = [...records, record].slice(-RECORD_LIMIT);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({version: 1, records}, null, 2));
    fs.renameSync(`${file}.tmp`, file)
}

/**
 * @summary Run as the harness: probe every row, record the launch, then hold the servers until SIGTERM.
 * @param {Object}   options
 * @param {String[]} options.argv
 * @param {Object}   options.env
 */
export async function main({argv, env}) {
    if (argv.includes('--version')) {
        process.stdout.write('seat-stand-in 1.0.0\n');
        return
    }

    const
        startedAt = new Date().toISOString(),
        launch    = resolveLaunch({argv, env}),
        probes    = await Promise.all(launch.rows.map(row => probeRow({row, env}))),
        clients   = probes.map(probe => probe.client).filter(Boolean);

    appendRecord(launch.instanceHome, {
        family : launch.family,
        pid    : process.pid,
        startedAt,
        argv,
        configs: launch.configPaths.map(file => ({path: file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')})),
        rows   : probes.map(probe => probe.result)
    });

    const stop = async () => {
        await Promise.allSettled(clients.map(client => client.close()));
        process.exit(0)
    };

    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    setInterval(() => {}, 1 << 30)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main({argv: process.argv.slice(2), env: process.env}).catch(error => {
        process.stderr.write(`seatStandIn: ${error.message}\n`);
        process.exit(1)
    })
}
