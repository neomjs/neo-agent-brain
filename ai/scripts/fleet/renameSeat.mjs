#!/usr/bin/env node
import 'dotenv/config';
import {Command}            from 'commander';
import Neo                  from 'neo.mjs/src/Neo.mjs';
import * as core            from 'neo.mjs/src/core/_export.mjs';
import FleetRegistryService from '../../services/fleet/FleetRegistryService.mjs';
import FleetTenantService   from '../../services/fleet/FleetTenantService.mjs';
import {renameSeat}         from '../../services/fleet/renameSeat.mjs';
import {isEntryModule}      from '../../services/shared/isEntryModule.mjs';

/**
 * @module ai/scripts/fleet/renameSeat
 * @summary The plane-host path for renaming one seat's Fleet id ({@link Neo.ai.services.fleet.renameSeat}).
 * Host access to the Fleet data root is its authority, so it runs on the plane host and nowhere else. Quit the
 * Fleet Manager and the seat first; the other seats may keep running. Without `--apply` it reports the plan and
 * changes nothing. Run it again after an interruption to complete the rename.
 *
 * ```
 * renameSeat.mjs --id <current id> --to <new id> [--apply]
 * ```
 */

/**
 * @summary Parses one invocation.
 * @param {String[]} argv
 * @returns {Object} `{id, to, apply}`, with `help` or `parseError` when set.
 */
function parseArgs(argv) {
    const program = new Command();

    program
        .name('rename-seat')
        .description('Renames one seat\'s Fleet id and the folder named after it, on the plane host, with the Fleet Manager quit.')
        .exitOverride()
        .configureOutput({writeErr: () => {}})
        .allowExcessArguments(false)
        .option('--id <id>', 'the seat\'s current Fleet id')
        .option('--to <id>', 'its new Fleet id')
        .option('--apply', 'rename it; without it the command reports the plan');

    try {
        program.parse(argv, {from: 'user'})
    } catch (error) {
        return error.code === 'commander.helpDisplayed' ? {help: true} : {parseError: error.message}
    }

    const options = program.opts();

    return {id: options.id ?? null, to: options.to ?? null, apply: options.apply === true}
}

/**
 * @summary What is wrong with an invocation, before any store is touched.
 * @param {Object} args
 * @returns {String[]}
 */
function validateArgs(args) {
    if (args.parseError) return [args.parseError];

    return [
        !args.id && 'name the seat with --id.',
        !args.to && 'name its new id with --to.'
    ].filter(Boolean)
}

/**
 * @summary Runs one validated rename against the Fleet's own stores.
 * @param {Object} options
 * @param {Object} options.args
 * @param {Object} [options.registry=FleetRegistryService]
 * @param {Object} [options.tenants=FleetTenantService]
 * @returns {Promise<Object>} The rename's result.
 */
function runCli({args, registry = FleetRegistryService, tenants = FleetTenantService}) {
    // one id per rename, so a re-run adopts the staging folder an interrupted run left
    return renameSeat({registry, tenants, id: args.id, to: args.to, moveId: `rename-${args.id}-${args.to}`, dryRun: !args.apply})
}

/**
 * @summary CLI entry point: prints the result as JSON and exits non-zero on a refusal.
 */
async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) process.exit(0);

    const errors = validateArgs(args);

    if (errors.length) {
        errors.forEach(error => console.error(`Error: ${error}`));
        process.exit(1)
    }

    const result = await runCli({args});

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.state === 'refused' ? 1 : 0)
}

if (isEntryModule(import.meta.url)) {
    await main()
}

export {parseArgs, runCli, validateArgs};
