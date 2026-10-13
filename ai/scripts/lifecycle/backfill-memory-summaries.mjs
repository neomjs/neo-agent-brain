#!/usr/bin/env node
/**
 * @summary Lifecycle child that backfills `AGENT_MEMORY.miniSummary` in bounded batches.
 *
 * The Orchestrator schedules this as a supervised child process, mirroring
 * `summarize-sessions.mjs`. The business logic remains in `MemoryService` so this entry point is
 * a thin bootstrap + observability wrapper and can also be run manually for recovery.
 *
 * For an operator-selected owner, inspect exact false no-content archives with:
 * `node ai/scripts/lifecycle/backfill-memory-summaries.mjs --reconcile-no-content <id,...>
 * --user-id <tenant> --agent-identity <identity>`. Add `--apply` after checking the per-id results.
 * This local maintenance command selects an explicit scope; it does not authenticate a remote user.
 * No options retains ordinary backfill. Reconciliation clears only eligible graph archive markers;
 * unavailable evidence is not proof of missing content, and retry-exhausted/intentional archives stay.
 * Startup retains the lifecycle's normal projection work. A dry-run means the reconciliation itself
 * makes no repair writes. Unit/CI receipts do not certify deployment or repair of live incident rows.
 *
 * Exit codes:
 *  - 0: batch completed (including successful no-op or fail-soft deferred rows)
 *  - 1: lifecycle or storage failure prevented the batch from running
 *
 * @see ai/services/memory-core/MemoryService.backfillMiniSummaries
 * @see ai/scripts/lifecycle/summarize-sessions.mjs
 */
import Neo       from 'neo.mjs/src/Neo.mjs';
import AiConfig  from '../../config.mjs';
import * as core from 'neo.mjs/src/core/_export.mjs';
import {
    resolveHeavyMaintenanceLeasePath,
    withHeavyMaintenanceLease
} from '../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs';
import LifecycleService      from '../../services/memory-core/lifecycle/SystemLifecycleService.mjs';
import MemoryService         from '../../services/memory-core/MemoryService.mjs';
import RequestContextService from '../../mcp/server/shared/services/RequestContextService.mjs';
import {parseArgs}           from 'node:util';
import {pathToFileURL}       from 'node:url';
import path                  from 'node:path';

/**
 * @summary Parses the operator's exact-id reconciliation request; no options retains normal backfill.
 * @param {String[]} argv Command arguments, excluding node and script.
 * @returns {Object|null} Explicit owner scope and repair selection, or null for normal backfill.
 */
export function parseReconciliationArgs(argv) {
    if (!argv.length) return null;
    const {values} = parseArgs({args: argv, allowPositionals: false, options: {
        'reconcile-no-content': {type: 'string'},
        'user-id'             : {type: 'string'},
        'agent-identity'      : {type: 'string'},
        apply                 : {type: 'boolean', default: false}
    }});
    if (!values['reconcile-no-content']?.trim() || !values['user-id']?.trim() || !values['agent-identity']?.trim()) {
        throw new Error('Reconciliation requires --reconcile-no-content <id,...> --user-id <owner> --agent-identity <identity> [--apply]');
    }
    const ids = values['reconcile-no-content'].split(',').map(id => id.trim());
    if (ids.some(id => !id) || ids.length > 100) throw new Error('Select 1–100 non-empty memory ids');
    return {ids, userId: values['user-id'].trim(), agentIdentity: values['agent-identity'].trim(), apply: values.apply};
}

/**
 * @summary Runs the existing backfill or an explicitly owner-scoped operator reconciliation.
 * @param {Object|null} reconciliation Parsed operator selection, not an authenticated remote identity.
 * @returns {Promise<Object>} The service outcome.
 */
export async function runMemorySummaryTask(reconciliation) {
    await LifecycleService.ready();
    return reconciliation ? RequestContextService.run({
        userId             : reconciliation.userId,
        agentIdentityNodeId: reconciliation.agentIdentity,
        source             : 'operator-memory-reconciliation'
    }, () => MemoryService.reconcileNoContentArchives({ids: reconciliation.ids, apply: reconciliation.apply})) :
        MemoryService.backfillMiniSummaries();
}

/** @summary Holds the existing maintenance lease and prints the selected task's result. */
async function main() {
    const reconciliation = parseReconciliationArgs(process.argv.slice(2));
    const outcome        = await withHeavyMaintenanceLease(
        () => runMemorySummaryTask(reconciliation),
        {
            leasePath   : resolveHeavyMaintenanceLeasePath({dataDir: AiConfig.orchestrator.dataDir}),
            owner       : 'memory-summary-backfill',
            reason      : 'manual-cli',
            staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
            metadata    : {script: 'ai/scripts/lifecycle/backfill-memory-summaries.mjs'}
        }
    );

    if (outcome.status === 'held') {
        const held = outcome.lease;
        console.log(JSON.stringify({
            success : true,
            deferred: true,
            reason  : 'heavy-maintenance-lease-held',
            holder  : held ? {
                owner     : held.owner,
                reason    : held.reason,
                pid       : held.pid,
                acquiredAt: held.acquiredAt
            } : null
        }));
        process.exit(0)
    }

    console.log(JSON.stringify({success: true, ...(outcome.result || {})}));
    process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error('backfill-memory-summaries failed:', error.message);
        process.exit(1)
    });
}
