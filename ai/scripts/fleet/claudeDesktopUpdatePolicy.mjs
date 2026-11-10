#!/usr/bin/env node
import {Command}             from 'commander';
import path                  from 'node:path';
import {
    claudeDesktopUpdatePolicyProfile,
    readClaudeDesktopUpdatePolicy
} from '../../services/fleet/claudeDesktopUpdatePolicy.mjs';
import {writeFileAtomicSync} from '../../services/shared/atomicFileWrite.mjs';
import {isEntryModule}       from '../../services/shared/isEntryModule.mjs';

/**
 * @module ai/scripts/fleet/claudeDesktopUpdatePolicy
 * @summary The operator's path to Claude Desktop's updater off-switch
 * ({@link Neo.ai.services.fleet.claudeDesktopUpdatePolicy}): it writes the configuration profile and reports
 * whether the policy is in force. Installing the written profile (open it, then approve it in System Settings
 * → Privacy & Security → Profiles) is the operator's step; the Fleet never installs a profile itself.
 *
 * ```
 * claudeDesktopUpdatePolicy.mjs [--write <file.mobileconfig>]
 * ```
 */

/**
 * @summary Parses one invocation.
 * @param {String[]} argv
 * @returns {Object} `{write}`, with `help` or `parseError` when set.
 */
function parseArgs(argv) {
    const program = new Command();

    program
        .name('claude-desktop-update-policy')
        .description('Writes the profile that turns Claude Desktop\'s own updater off, and reports whether that policy is in force.')
        .exitOverride()
        .configureOutput({writeErr: () => {}})
        .allowExcessArguments(false)
        .option('--write <file>', 'write the profile to this .mobileconfig file');

    try {
        program.parse(argv, {from: 'user'})
    } catch (error) {
        return error.code === 'commander.helpDisplayed' ? {help: true} : {parseError: error.message}
    }

    return {write: program.opts().write ?? null}
}

/**
 * @summary What is wrong with an invocation, before anything is written.
 * @param {Object} args
 * @returns {String[]}
 */
function validateArgs(args) {
    if (args.parseError) return [args.parseError];

    return [
        args.write !== null && !args.write.endsWith('.mobileconfig') && 'macOS installs a profile only from a .mobileconfig file.'
    ].filter(Boolean)
}

/**
 * @summary Writes the profile when asked, then reads the policy.
 * @param {Object} options
 * @param {Object} options.args
 * @param {Function} [options.readPolicy=readClaudeDesktopUpdatePolicy]
 * @param {Function} [options.write=writeFileAtomicSync]
 * @returns {{written: String|null, inForce: Boolean, path: String, reason: String|null}}
 */
function runCli({args, readPolicy = readClaudeDesktopUpdatePolicy, write = writeFileAtomicSync}) {
    const written = args.write && path.resolve(args.write);

    // world-readable like any profile a user opens; it holds no secret
    if (written) write(written, claudeDesktopUpdatePolicyProfile(), {mode: 0o644});

    return {written, ...readPolicy()}
}

/**
 * @summary CLI entry point: prints the result as JSON.
 */
function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) process.exit(0);

    const errors = validateArgs(args);

    if (errors.length) {
        errors.forEach(error => console.error(`Error: ${error}`));
        process.exit(1)
    }

    console.log(JSON.stringify(runCli({args}), null, 2))
}

if (isEntryModule(import.meta.url)) {
    main()
}

export {parseArgs, runCli, validateArgs};
