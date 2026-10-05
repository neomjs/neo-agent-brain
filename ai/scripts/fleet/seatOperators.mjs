#!/usr/bin/env node
import 'dotenv/config';
import {Command}                   from 'commander';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import os                          from 'os';
import {pathToFileURL}             from 'url';
import FleetRegistryService        from '../../services/fleet/FleetRegistryService.mjs';
import SeatOperatorRegistryService from '../../services/fleet/SeatOperatorRegistryService.mjs';

/**
 * @module ai/scripts/fleet/seatOperators
 * @summary The plane-local administrative path for which principal operates each Fleet seat: the only
 * writer of the operator store besides the seat a `defineAgent` creates. Host access to the Fleet data
 * root is its authority, so it runs on the plane host and nowhere else. Every mutation is a dry run
 * unless `--apply` is given.
 *
 * ```
 * seatOperators.mjs assign   --seat <id> [--seat <id>…] --principal owner:<connectionId>:<providerUserId> [--apply]
 * seatOperators.mjs transfer --seat <id> --from <principal> --to <principal>                            [--apply]
 * seatOperators.mjs list
 * ```
 */

const COMMANDS = Object.freeze(['assign', 'transfer', 'list']);

/**
 * @summary Parses one invocation.
 * @param {String[]} argv
 * @returns {Object} `{command, apply, seats, principal, from, to, actor}`, with `help` or `parseError` when set.
 */
function parseArgs(argv) {
    const program = new Command();

    program
        .name('seat-operators')
        .description(`Which principal operates each Fleet seat, written on the plane host. Commands: ${COMMANDS.join(', ')}.`)
        .exitOverride()
        .configureOutput({writeErr: () => {}})
        .allowExcessArguments(false)
        .argument('[command]', COMMANDS.join(' | '))
        .option('--apply', 'write the change; without it the command reports what it would do')
        .option('--seat <id>', 'a seat id; repeat it to assign several', (value, seats) => [...seats, value], [])
        .option('--principal <principal>', 'the owner principal assign records')
        .option('--from <principal>', 'the principal a transfer moves the seat from')
        .option('--to <principal>', 'the principal a transfer moves the seat to');

    try {
        program.parse(argv, {from: 'user'})
    } catch (error) {
        return error.code === 'commander.helpDisplayed' ? {help: true} : {parseError: error.message}
    }

    const options = program.opts();

    return {
        command  : program.args[0] ?? null,
        apply    : options.apply === true,
        seats    : options.seat,
        principal: options.principal ?? null,
        from     : options.from ?? null,
        to       : options.to ?? null,
        actor    : `os-user:${os.userInfo().username}`
    }
}

/**
 * @summary What is wrong with an invocation, before any store is touched.
 * @param {Object} args
 * @returns {String[]}
 */
function validateArgs(args) {
    if (args.parseError) return [args.parseError];

    const errors = [];

    if (!COMMANDS.includes(args.command))                                    errors.push(`the command must be one of ${COMMANDS.join(', ')}.`);
    if (args.command === 'assign'   && !args.seats.length)                   errors.push('assign needs at least one --seat.');
    if (args.command === 'assign'   && !args.principal)                      errors.push('assign needs --principal.');
    if (args.command === 'transfer' && args.seats.length !== 1)              errors.push('transfer needs exactly one --seat.');
    if (args.command === 'transfer' && (!args.from || !args.to))             errors.push('transfer needs --from and --to.');

    return errors
}

/**
 * @summary Runs one validated command against the operator store, with the seat registry deciding which
 * seats exist.
 * @param {Object} options
 * @param {Object} options.args
 * @param {Object} [options.operators=SeatOperatorRegistryService]
 * @param {Object} [options.registry=FleetRegistryService]
 * @returns {Object} The store's result; `list` adds the data root it read.
 */
function runCli({args, operators = SeatOperatorRegistryService, registry = FleetRegistryService}) {
    const {actor, apply, command, from, principal, seats, to} = args;

    switch (command) {
        case 'assign'  : return operators.assign({actor, apply, principal, seats, seatExists: seatId => registry.getAgent(seatId) !== null});
        case 'transfer': return operators.transfer({actor, apply, from, seat: seats[0], to});
        default: {
            const read = operators.read();

            return {ok: read.state !== 'corrupt', dataDir: operators.getDataDir(), ...read}
        }
    }
}

/**
 * @summary CLI entry point: prints the result as JSON and exits non-zero on a refusal.
 */
function seatOperators() {
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
    seatOperators()
}

export {parseArgs, runCli, validateArgs};
