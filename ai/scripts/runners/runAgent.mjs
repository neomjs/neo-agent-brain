import Neo               from 'neo.mjs/src/Neo.mjs';
import * as core         from 'neo.mjs/src/core/_export.mjs';
import InstanceManager   from 'neo.mjs/src/manager/Instance.mjs';
import AgentOrchestrator from '../../agent/AgentOrchestrator.mjs';
import AiConfig          from '../../config.mjs';
import path              from 'node:path';
import {fileURLToPath}   from 'node:url';

/**
 * @module ai/scripts/runners/runAgent
 */

const isDryRun = process.argv.includes('--dry-run');

/**
 * @summary Resolves AgentOrchestrator's durable files from the configured plane root.
 *
 * The class owns no environment read. This entrypoint consumes the resolved Tier-1 leaf and injects
 * both paths, keeping the Golden Path writer and runner on the same relocated plane.
 *
 * @param {Object} config Resolved Tier-1 Agent OS config.
 * @returns {{handoffPath:String,outcomePath:String}}
 */
export function resolveAgentOrchestratorPaths(config = AiConfig) {
    const dataRoot = config?.plane?.dataRoot;

    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
        throw new TypeError('runAgent requires an absolute configured plane.dataRoot')
    }

    return {
        handoffPath: path.join(dataRoot, 'handoff/sandman_handoff.md'),
        outcomePath: path.join(dataRoot, 'agent-orchestrator/golden-path-outcomes.jsonl')
    }
}

/**
 * @summary Creates and runs one headless agent against the resolved plane-local artifacts.
 * @param {Object} [options]
 * @param {Object} [options.config=AiConfig] Resolved Tier-1 config.
 * @param {Function} [options.create] AgentOrchestrator factory seam.
 * @returns {Promise<void>}
 */
export async function startOrchestrator({
    config = AiConfig,
    create = (Class, classConfig) => Neo.create(Class, classConfig)
} = {}) {
    try {
        const orchestrator = create(AgentOrchestrator, resolveAgentOrchestratorPaths(config));
        await orchestrator.execute({dryRun: isDryRun});
    } catch (err) {
        console.error('❌ AgentOrchestrator failed:', err);
        process.exit(1);
    }
}

// CLI entrypoint guard; tests can import helpers without launching the orchestrator.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startOrchestrator();
}
