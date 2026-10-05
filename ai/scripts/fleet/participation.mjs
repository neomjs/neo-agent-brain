#!/usr/bin/env node
import {Command}                      from 'commander';
import Neo                            from 'neo.mjs/src/Neo.mjs';
import * as core                      from 'neo.mjs/src/core/_export.mjs';
import InstanceManager                from 'neo.mjs/src/manager/Instance.mjs';
import os                             from 'os';
import {pathToFileURL}                from 'url';
import {normalizeAgentIdentityNodeId} from '../../graph/normalizeAgentIdentityNodeId.mjs';
import {readParticipation,
        recordParticipation}          from '../../services/memory-core/recordParticipation.mjs';

/**
 * @module ai/scripts/fleet/participation
 * @summary The plane-host path for an identity's participation: bench it with a reason, return it to
 * active, or show what its node records. Benching is identity-wide, so the plane host decides it: on the
 * plane this runs in the Memory Core container, against the graph that container serves. Every mutation
 * is a dry run unless `--apply` is given.
 *
 * ```
 * participation.mjs bench    --identity <id> --reason <text> [--apply]
 * participation.mjs activate --identity <id>                 [--apply]
 * participation.mjs show     --identity <id>
 * ```
 */

const COMMANDS = Object.freeze(['bench', 'activate', 'show']);

/**
 * @summary Parses one invocation.
 * @param {String[]} argv
 * @returns {Object} `{command, apply, identity, reason, actor}`, with `help` or `parseError` when set.
 */
function parseArgs(argv) {
    const program = new Command();

    program
        .name('participation')
        .description(`An identity's participation, recorded on the plane host. Commands: ${COMMANDS.join(', ')}.`)
        .exitOverride()
        .configureOutput({writeErr: () => {}})
        .allowExcessArguments(false)
        .argument('[command]', COMMANDS.join(' | '))
        .option('--apply', 'write the change; without it the command reports what it would do')
        .option('--identity <id>', 'the identity, e.g. @neo-kimi-iris')
        .option('--reason <text>', 'why the operator benches it; required for bench');

    try {
        program.parse(argv, {from: 'user'})
    } catch (error) {
        return error.code === 'commander.helpDisplayed' ? {help: true} : {parseError: error.message}
    }

    const options = program.opts();

    return {
        command : program.args[0] ?? null,
        apply   : options.apply === true,
        identity: options.identity ? normalizeAgentIdentityNodeId(options.identity) : null,
        reason  : options.reason ?? null,
        actor   : `os-user:${os.userInfo().username}`
    }
}

/**
 * @summary What is wrong with an invocation, before the graph is opened.
 * @param {Object} args
 * @returns {String[]}
 */
function validateArgs(args) {
    if (args.parseError) return [args.parseError];

    const errors = [];

    if (!COMMANDS.includes(args.command))                 errors.push(`the command must be one of ${COMMANDS.join(', ')}.`);
    if (!args.identity)                                   errors.push('--identity is required.');
    if (args.command === 'bench' && !args.reason?.trim()) errors.push('bench needs --reason.');

    return errors
}

/**
 * @summary Runs one validated command against the graph.
 * @param {Object} options
 * @param {Object} options.args
 * @param {Object} options.graphService A ready GraphService.
 * @returns {Object} The write's result; `show` answers the node's participation fields.
 */
function runCli({args, graphService}) {
    const {actor, apply, command, identity, reason} = args;

    if (command === 'show') {
        const node = graphService.getNodeRecord({id: identity});

        return node?.type === 'AgentIdentity'
            ? {ok: true, identity, ...readParticipation(node.properties)}
            : {ok: false, refused: 'unknown-identity', reason: `no AgentIdentity node ${identity}`}
    }

    return recordParticipation({
        graphService,
        identityId: identity,
        status    : command === 'bench' ? 'operator_benched' : 'active',
        reason,
        actor,
        apply
    })
}

/**
 * @summary CLI entry point: prints the result as JSON and exits non-zero on a refusal.
 * @returns {Promise<void>}
 */
async function participation() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) process.exit(0);

    const errors = validateArgs(args);

    if (errors.length) {
        errors.forEach(error => console.error(`Error: ${error}`));
        process.exit(1)
    }

    // the environment loads here, not at import, so a spec can import this module without the checkout's .env
    await import('dotenv/config');

    const {default: graphService} = await import('../../services/memory-core/GraphService.mjs');

    await graphService.ready();

    if (!graphService.db) {
        console.error(`Error: the graph is not open: ${graphService.graphInitError?.message ?? 'unknown reason'}`);
        process.exit(1)
    }

    const result = runCli({args, graphService});

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    participation()
}

export {parseArgs, runCli, validateArgs};
