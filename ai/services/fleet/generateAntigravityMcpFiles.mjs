import path from 'node:path';
import {MCP_SERVERS} from '../../../src/fleet/contract/mcpServers.mjs';
import {LAUNCH_GRANT_ENV_VAR, LAUNCH_ISSUER_ENV_VAR, isLaunchIdentity, parseLaunchCapability} from './mcpLaunchAdmission.mjs';

/** @type {String} Profile-local carrier; the workspace declaration contains no seat path. */
export const ANTIGRAVITY_MCP_DIRECTORY = '.neo-fleet-mcp';

const
    HEADER = '# Neo Fleet Antigravity MCP invoker v1',
    SERVER_KEYS = new Set(MCP_SERVERS.map(({key}) => key)),
    PROCESS_ENV = new Set(['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']),
    REFUSAL = 'Neo MCP is unavailable for this Antigravity profile; start the seat from Fleet Manager.';

/**
 * @summary Compile resolved admission rows into owner-only profile invokers and neutral workspace MCP rows.
 * Antigravity assigns AGY_BROWSER_ACTIVE_PORT_FILE from Electron userData after its login-shell overlay.
 * The workspace command uses that version-probed anchor; identity, grants and the original runtime remain
 * inside the profile. Each invoker starts with an empty environment, so shell credentials and aliases
 * cannot compete with the existing launcher's authenticated admission. The caller owns capability
 * probing, atomic writes, divergence checks and removal of retired invokers. Every canonical server
 * is declared: an absent enabled row becomes an explicit disabled entry, so a global row cannot fill it.
 * @param {Object} options
 * @param {String} options.profileHome Validated absolute Electron profile directory.
 * @param {Object} options.rows Existing per-server admission rows: {command, args, env}.
 * @param {Object} options.processEnvironment Original Start's selected benign process-runtime values.
 * @returns {{files: Object[], mcpServers: Object}} No filesystem or environment is read here.
 */
export function generateAntigravityMcpFiles({profileHome, rows, processEnvironment}) {
    if (typeof profileHome !== 'string' || !path.isAbsolute(profileHome) || profileHome.includes('\0')) {
        throw new TypeError('Antigravity MCP profile must be an absolute path.')
    }
    assertEnvironment(processEnvironment, name => PROCESS_ENV.has(name));

    const files = [], mcpServers = Object.fromEntries(MCP_SERVERS.map(({key}) => [
        `neo-mjs-${key}`, {command: '/usr/bin/false', disabled: true}
    ]));

    for (const [name, row] of Object.entries(rows)) {
        const key = name.startsWith('neo-mjs-') ? name.slice(8) : '';

        if (!SERVER_KEYS.has(key) || typeof row.command !== 'string' || !path.isAbsolute(row.command) ||
            !Array.isArray(row.args) || row.args.length !== 3 || !path.isAbsolute(row.args[0]) ||
            path.basename(row.args[0]) !== 'fleetMcpLauncher.mjs' || row.args[1] !== '--server' || row.args[2] !== key) {
            throw new TypeError('Antigravity MCP row must invoke the selected Fleet launcher and server.')
        }
        assertEnvironment(row.env, name => name === 'ELECTRON_RUN_AS_NODE' ||
            name.startsWith('NEO_') && !/(?:TOKEN|API_KEY|PASSWORD|SECRET|PAT)$/.test(name));
        if (!isLaunchIdentity(row.env.NEO_AGENT_IDENTITY) || !parseLaunchCapability(row.env[LAUNCH_GRANT_ENV_VAR]) ||
            !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(row.env[LAUNCH_ISSUER_ENV_VAR] || '')) {
            throw new TypeError('Antigravity MCP row requires a seat identity and per-server launch admission.')
        }

        const environment = {...processEnvironment, ...row.env};
        files.push({
            path: path.join(profileHome, ANTIGRAVITY_MCP_DIRECTORY, `${key}.sh`),
            mode: 0o600,
            content: `${HEADER}\n[ "\${AGY_BROWSER_ACTIVE_PORT_FILE-}" = ${quote(path.join(profileHome, 'DevToolsActivePort'))} ] || exit 78\nexec /usr/bin/env -i ${[
                ...Object.keys(environment).sort().map(key => `${key}=${environment[key]}`),
                row.command, ...row.args
            ].map(quote).join(' ')}\n`
        });
        mcpServers[name] = {
            command: '/bin/sh',
            args: ['-p', '-c', neutralCommand(key)]
        }
    }

    return {files, mcpServers}
}

/** @summary Quote one literal POSIX argument, including shell metacharacters and newlines. @param {String} value @returns {String} */
function quote(value) {
    if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid Antigravity MCP argument.');
    return `'${value.replaceAll("'", "'\\''")}'`
}

/** @summary Refuse uncurated environment slots before they become a profile artifact. @private */
function assertEnvironment(values, allows) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Antigravity MCP environment must be a record.');
    for (const [name, value] of Object.entries(values)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !allows(name) || typeof value !== 'string' || value.includes('\0')) {
            throw new TypeError(`Antigravity MCP environment slot '${name}' is not admitted to the profile.`)
        }
    }
}

/**
 * @summary The identical workspace entry for this server, with no identity, capability or runtime path.
 * Both shells use privileged mode to ignore imported functions and startup/tracing options before
 * the secret-bearing invoker runs; clearing the environment only on its final exec would be too late.
 * @private
 */
function neutralCommand(key) {
    return [
        `refuse() { printf '%s\\n' ${quote(REFUSAL)} >&2; exit 78; }`,
        'case "${AGY_BROWSER_ACTIVE_PORT_FILE-}" in /*/DevToolsActivePort) ;; *) refuse ;; esac',
        `invoker="\${AGY_BROWSER_ACTIVE_PORT_FILE%/*}/${ANTIGRAVITY_MCP_DIRECTORY}/${key}.sh"`,
        '[ -f "$invoker" ] && [ -r "$invoker" ] && [ ! -L "$invoker" ] || refuse',
        'IFS= read -r marker < "$invoker" || refuse',
        `[ "$marker" = ${quote(HEADER)} ] || refuse`,
        'exec /bin/sh -p "$invoker"'
    ].join('\n')
}
