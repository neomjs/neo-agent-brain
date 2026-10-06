#!/usr/bin/env node
import 'dotenv/config';
import {Command}       from 'commander';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import os              from 'os';
import {pathToFileURL} from 'url';
import ForgeConnectionRegistryService, {FORGE_AUTH_PROVIDERS} from '../../services/fleet/ForgeConnectionRegistryService.mjs';

/**
 * @module ai/scripts/fleet/forgeConnections
 * @summary The plane-local administrative path for the Fleet's forge connections: the only writer of
 * the connection registry. Host access to the Fleet data root is its authority, so it runs
 * on the plane host and nowhere else. Every mutation is a dry run unless `--apply` is given.
 *
 * ```
 * forgeConnections.mjs init                                         [--apply]
 * forgeConnections.mjs register      --provider github --endpoint https://api.github.com [--apply]
 * forgeConnections.mjs approve-alias --connection <id> --endpoint <url>                  [--apply]
 * forgeConnections.mjs detach        --endpoint <url>                                    [--apply]
 * forgeConnections.mjs list
 * forgeConnections.mjs status
 * ```
 *
 * An endpoint is the API base admissions present (`https://api.github.com` for GitHub), never the forge's
 * web origin. `status` reads, for this plane's own auth mode, the forge it declares and that endpoint's
 * binding; it always exits 0, because a corrupt store is its answer, not its failure.
 */

const COMMANDS = Object.freeze(['init', 'register', 'approve-alias', 'detach', 'list', 'status']);

/**
 * @summary Parses one invocation.
 * @param {String[]} argv
 * @returns {Object} `{command, apply, connectionId, endpoint, provider, actor}`, with `help` or `parseError` when set.
 */
function parseArgs(argv) {
    const program = new Command();

    program
        .name('forge-connections')
        .description(`The Fleet's forge connections, written on the plane host. Commands: ${COMMANDS.join(', ')}.`)
        .exitOverride()
        .configureOutput({writeErr: () => {}})
        .allowExcessArguments(false)
        .argument('[command]', COMMANDS.join(' | '))
        .option('--apply', 'write the change; without it the command reports what it would do')
        .option('--connection <id>', 'the connection an alias joins')
        .option('--endpoint <url>', 'the forge base URL, as admissions present it')
        .option('--provider <forge>', `the forge: ${FORGE_AUTH_PROVIDERS.join(' or ')}`);

    try {
        program.parse(argv, {from: 'user'})
    } catch (error) {
        return error.code === 'commander.helpDisplayed' ? {help: true} : {parseError: error.message}
    }

    const options = program.opts();

    return {
        command     : program.args[0] ?? null,
        apply       : options.apply === true,
        connectionId: options.connection ?? null,
        endpoint    : options.endpoint ?? null,
        provider    : options.provider ?? null,
        actor       : `os-user:${os.userInfo().username}`
    }
}

/**
 * @summary What is wrong with an invocation, before the store is touched.
 * @param {Object} args
 * @returns {String[]}
 */
function validateArgs(args) {
    if (args.parseError) return [args.parseError];

    const errors = [];

    if (!COMMANDS.includes(args.command))                                  errors.push(`the command must be one of ${COMMANDS.join(', ')}.`);
    if (['register', 'approve-alias', 'detach'].includes(args.command) && !args.endpoint) errors.push(`${args.command} needs --endpoint.`);
    if (args.command === 'register' && !args.provider)                     errors.push('register needs --provider.');
    if (args.command === 'approve-alias' && !args.connectionId)            errors.push('approve-alias needs --connection.');

    return errors
}

/**
 * @summary Runs one validated command against the registry.
 * @param {Object} options
 * @param {Object} options.args
 * @param {Object} [options.registry=ForgeConnectionRegistryService]
 * @returns {Object} The registry's result; `list` adds the data root it read.
 */
function runCli({args, registry = ForgeConnectionRegistryService}) {
    const {actor, apply, command, connectionId, endpoint, provider} = args;

    switch (command) {
        case 'init'         : return registry.initialize({actor, apply});
        case 'register'     : return registry.register({actor, apply, authProvider: provider, endpoint});
        case 'approve-alias': return registry.approveAlias({actor, apply, connectionId, endpoint});
        case 'detach'       : return registry.detach({actor, apply, endpoint});
        case 'status'       : return {ok: true, dataDir: registry.getDataDir(), ...registry.status()};
        default: {
            const read = registry.read();

            return {ok: read.state !== 'corrupt', dataDir: registry.getDataDir(), ...read}
        }
    }
}

/**
 * @summary CLI entry point: prints the result as JSON and exits non-zero on a refusal.
 */
function forgeConnections() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) process.exit(0);

    const errors = validateArgs(args);

    if (errors.length) {
        errors.forEach(error => console.error(`Error: ${error}`));
        process.exit(1)
    }

    const result = runCli({args});

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    forgeConnections()
}

export {parseArgs, runCli, validateArgs};
