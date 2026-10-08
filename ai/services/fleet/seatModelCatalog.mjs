import {execFile}                              from 'node:child_process';
import {promisify}                             from 'node:util';
import {codexHomeInUse, readCodexModelCatalog} from './codexModelCatalog.mjs';
import {deriveAgentInstanceHome}               from './deriveAgentInstanceHome.mjs';
import {deriveCodexHome}                       from './deriveHarnessLaunchSpec.mjs';
import {resolveHarnessSeatSettings}            from '../../../src/fleet/contract/harnessTypes.mjs';

/**
 * @module ai/services/fleet/seatModelCatalog
 * @summary What a seat's harness offers to declare, asked of the harness itself and never kept as a Fleet list. A
 * Codex seat answers its app-server's `model/list` in its own logged-in home
 * ({@link module:ai/services/fleet/codexModelCatalog.readCodexModelCatalog}). `claude-code` answers the effort
 * levels its CLI names in `--help`, and takes any model id or alias it accepts. Other families have no
 * supported catalog reader; that does not decide whether an individual setting can be declared.
 */

const execFileAsync = promisify(execFile);

/**
 * @summary The effort levels a `claude-code` CLI names for `--effort` in its own help.
 * @param {String}   binaryPath
 * @param {Function} [runHelp] `binaryPath => Promise<String>`, the help text
 * @returns {Promise<{state: String, models: Object[], efforts: String[]|null, reason: String|null}>}
 */
async function readClaudeCodeCatalog(binaryPath, runHelp = async binary => (await execFileAsync(binary, ['--help'], {timeout: 10000})).stdout) {
    let help;

    try {
        help = await runHelp(binaryPath)
    } catch (error) {
        return {state: 'unavailable', models: [], efforts: null, reason: `the CLI did not answer --help: ${error.message}`}
    }

    const levels = /--effort <level>[^(]*\(([^)]*)\)/.exec(help)?.[1].split(',').map(level => level.trim()).filter(Boolean);

    return levels?.length
        ? {state: 'complete', models: [], efforts: levels, reason: null}
        : {state: 'unavailable', models: [], efforts: null, reason: 'the CLI\'s --help names no effort levels'}
}

/**
 * @summary What a complete catalog lacks of a seat's declaration. Only a complete read proves an absence, so any
 * other answer refuses nothing. A CLI that names its levels and takes any model id can only lack the effort. A Codex
 * catalog can lack the model, or the effort on that model; an effort declared without a model is not checked there,
 * because the model it runs on is the harness's own choice.
 * @param {Object|null} catalog A {@link readSeatModelCatalog} answer
 * @param {Object}      seat    The seat's record, read for `model` and `reasoningEffort`
 * @returns {String|null} The refusal's reason, such as `model gpt-x is not available`, or `null`
 */
export function unofferedDeclaration(catalog, {model, reasoningEffort} = {}) {
    if (catalog?.state !== 'complete') return null;

    if (Array.isArray(catalog.efforts)) {
        return reasoningEffort && !catalog.efforts.includes(reasoningEffort) ? `reasoning effort ${reasoningEffort} is not available` : null
    }

    if (!model) return null;

    const offered = catalog.models.find(entry => entry.id === model || entry.slug === model);

    if (!offered) return `model ${model} is not available`;

    return reasoningEffort && !offered.efforts.includes(reasoningEffort)
        ? `reasoning effort ${reasoningEffort} is not available for model ${model}`
        : null
}

/**
 * @summary What a seat's harness offers to declare. A Codex home without a login answers the bundled catalog, which
 * proves nothing about the account, so it reads as unavailable until the seat has one.
 * @param {Object}   options
 * @param {Object}   options.agent            The seat's record
 * @param {String}   options.instanceRoot     The harness-home root
 * @param {Object}   options.lifecycleService Supplies the harness binaries and the per-home login check
 * @param {Function} [options.readCodex]      Codex catalog seam
 * @param {Function} [options.runHelp]        `claude-code` help seam
 * @returns {Promise<Object>} `{state: 'complete'|'partial'|'unavailable'|'unsupported', models, efforts?, reason}`
 */
export async function readSeatModelCatalog({agent, instanceRoot, lifecycleService, readCodex = readCodexModelCatalog, runHelp}) {
    const via = resolveHarnessSeatSettings(agent?.harnessType);

    if (via === 'args') {
        return readClaudeCodeCatalog(lifecycleService.getHarnessBinaryPath('claude-code'), runHelp)
    }

    if (via !== 'codex-config') {
        return {state: 'unsupported', models: [], reason: `a '${agent?.harnessType}' seat has no supported model/effort catalog reader`}
    }

    const
        codexHome = deriveCodexHome({harnessType: agent.harnessType, instanceHome: deriveAgentInstanceHome({instanceRoot, agentId: agent.id, harnessType: agent.harnessType})}),
        // asked before the login, which can be gone while the server an earlier read started still runs
        inUse     = codexHomeInUse(codexHome);

    if (inUse) return inUse;

    if (lifecycleService.authRequiredForHome(agent.harnessType, codexHome) !== false) {
        return {state: 'unavailable', models: [], reason: 'the seat has no Codex login yet; its catalog is read once it has one'}
    }

    return readCodex({binaryPath: lifecycleService.getHarnessBinaryPath('codex'), codexHome})
}
