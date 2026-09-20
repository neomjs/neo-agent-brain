import 'dotenv/config';
import Neo                 from 'neo.mjs/src/Neo.mjs';
import * as core           from 'neo.mjs/src/core/_export.mjs';
import fs                  from 'node:fs';
import {pathToFileURL}     from 'node:url';
import {classifyAttention} from '../../services/memory-core/communityAttentionClassifier.mjs';

/**
 * @module ai/scripts/maintenance/reconcileGithubCommunity
 * @summary Co-located operator entry for one tenant's manual or shadow community reconciliation.
 * Tenant scope is bound at this trusted deployment entry, never accepted by an MCP caller or
 * the coordinator itself. Importing the CLI or requesting help opens no Memory Core storage.
 */

/** @summary Parses explicit operator choices without reading storage or resolving credentials. */
export function parseArgs(argv) {
    const args = {mode: 'manual', tenantId: null, maxAdmissionAttempts: null,
        sourceInstanceIds: [], attentionPolicyFile: null, help: false};
    const fields = {
        '--mode'                  : 'mode', '--tenant-id': 'tenantId',
        '--max-admission-attempts': 'maxAdmissionAttempts', '--attention-policy-file': 'attentionPolicyFile'
    };

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') {
            args.help = true;
            continue
        }
        if (!fields[flag] && flag !== '--source-instance-id') {
            throw new Error('COMMUNITY_RECONCILIATION_UNKNOWN_ARGUMENT')
        }
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error('COMMUNITY_RECONCILIATION_ARGUMENT_VALUE_REQUIRED');
        if (flag === '--source-instance-id') args.sourceInstanceIds.push(value);
        else args[fields[flag]] = flag === '--max-admission-attempts' ? Number(value) : value;
    }

    return args
}

/** @summary Refuses incomplete operator policy before any runtime dependency is imported. */
export function validateArgs(args) {
    const errors = [];
    if (!args.tenantId?.trim()) errors.push('--tenant-id is required at this co-located operator entry.');
    if (!['manual', 'shadow'].includes(args.mode)) errors.push('--mode must be manual or shadow.');
    if (!Number.isInteger(args.maxAdmissionAttempts) || args.maxAdmissionAttempts < 1) {
        errors.push('--max-admission-attempts must be an explicit positive integer.')
    }
    if (args.mode === 'manual' && !args.attentionPolicyFile) {
        errors.push('--attention-policy-file is required for durable admission.')
    }
    return errors
}

/**
 * @summary Loads the local process's collaborators only after argument and policy validation.
 * @returns {Promise<Object>}
 */
async function loadRuntime() {
    const [coordinator, context, admission] = await Promise.all([
        import('../../daemons/orchestrator/services/CommunityReconciliationService.mjs'),
        import('../../mcp/server/shared/services/RequestContextService.mjs'),
        import('../../services/memory-core/CommunityBatchAdmissionService.mjs')
    ]);
    await admission.default.ready();
    return {coordinator: coordinator.default, context: context.default, admission: admission.default}
}

/**
 * @summary Runs one trusted operator invocation; the coordinator receives no caller tenant field.
 * The supplied attention policy binds this dedicated CLI process once. It does not alter AiConfig,
 * source registration, or a running server's policy. Shadow execution needs no admission policy.
 * @param {Object} options
 * @param {Object} options.args Parsed and validated operator arguments.
 * @param {Function} [options.runtimeLoader] Isolated test seam for runtime collaborators.
 * @param {Function} [options.readPolicy] Isolated test seam for the reviewed policy document.
 * @returns {Promise<Object>} Metadata-only coordinator outcome.
 */
export async function runOperatorReconciliation({args, runtimeLoader = loadRuntime,
    readPolicy = file => JSON.parse(fs.readFileSync(file, 'utf8'))}) {
    if (validateArgs(args).length) throw new Error('COMMUNITY_RECONCILIATION_ARGUMENTS_INVALID');

    let policy;
    if (args.mode === 'manual') {
        policy = readPolicy(args.attentionPolicyFile);
        classifyAttention({actorKind: 'unknown'}, policy);
    }

    const {coordinator, context, admission} = await runtimeLoader();
    if (policy) {
        if (admission.attentionPolicy !== null && admission.attentionPolicy !== undefined) {
            throw new Error('COMMUNITY_RECONCILIATION_POLICY_ALREADY_BOUND')
        }
        admission.attentionPolicy = policy;
    }

    return context.run({userId: args.tenantId}, () => coordinator.runOnce({
        mode                : args.mode,
        maxAdmissionAttempts: args.maxAdmissionAttempts,
        sourceInstanceIds   : args.sourceInstanceIds.length ? args.sourceInstanceIds : null
    }))
}

/** @summary Keeps partial failure visible to operator automation. */
export function resolveExitCode(result) {
    return result?.status === 'completed' || result?.status === 'skipped' ? 0 : 1
}

/** @summary Prints the co-located entry contract without selecting a production policy. */
function printHelp() {
    console.log(`Usage: npm run ai:community-reconcile -- --tenant-id <tenant> --mode <manual|shadow>
  --max-admission-attempts <count> [--source-instance-id <id>]...
  [--attention-policy-file <reviewed-policy.json>]

Run inside the deployment holding Memory Core's database and GitHub connector credentials.
Tenant selection is a deployment-operator authority, not a tenant self-service API.
Manual mode requires a reviewed attention policy file; shadow mode acquires metadata without
admitting batches. No cadence or retry count is selected by this command. Restart starts a new
exhaustive reconciliation; exact transport retries retain only the current in-memory batch.
Exit 0: completed or explicitly skipped. Exit 1: partial/failed execution. Exit 2: invalid input.`)
}

/** @summary Executes the CLI while keeping provider errors and policy contents out of output. */
async function main() {
    let args;
    try { args = parseArgs(process.argv.slice(2)) }
    catch { console.error('COMMUNITY_RECONCILIATION_ARGUMENTS_INVALID'); process.exitCode = 2; return }
    if (args.help) { printHelp(); return }
    const errors = validateArgs(args);
    if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 2; return }
    try {
        const result = await runOperatorReconciliation({args});
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = resolveExitCode(result)
    } catch {
        console.error('COMMUNITY_RECONCILIATION_FAILED');
        process.exitCode = 1
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
