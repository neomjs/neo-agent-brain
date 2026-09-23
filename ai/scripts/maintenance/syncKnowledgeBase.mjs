// Neo namespace bootstrap (entry-point invariant) — orchestrator spawn-child.
// `InstanceManager` binds Neo.find/findFirst/get aliases + consumes pre-singleton
// `Neo.idMap`; required for any consumer of the Neo singleton API.
import Neo                                 from 'neo.mjs/src/Neo.mjs';
import AiConfig                            from '../../config.mjs';
import * as core                           from 'neo.mjs/src/core/_export.mjs';
import InstanceManager                     from 'neo.mjs/src/manager/Instance.mjs';
import KB_Config                           from '../../mcp/server/knowledge-base/config.mjs';
import KB_DatabaseService                  from '../../services/knowledge-base/DatabaseService.mjs';
import KB_ChromaManager                    from '../../services/knowledge-base/ChromaManager.mjs';
import KB_LifecycleService                 from '../../services/knowledge-base/DatabaseLifecycleService.mjs';
import {resolveCleanBrainCheckoutRevision} from '../../services/knowledge-base/helpers/imageRevisionReader.mjs';
import {
    createLeaseYieldVoter,
    resolveHeavyMaintenanceLeasePath,
    withHeavyMaintenanceLease
} from '../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs';
import {execFileSync}  from 'node:child_process';
import {existsSync}    from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * @module ai/scripts/maintenance/syncKnowledgeBase
 *
 * Progress/diagnostic logs go to STDERR; STDOUT carries exactly one structured outcome JSON
 * the orchestrator's `ProcessSupervisorService` captures (`captureStdoutJson`). A lease-held
 * deferral therefore records `skipped` (not a false-green `completed` that refreshes
 * `lastSuccessAt`) — the kb-sync half of the deferred-as-completed fix.
 */

/**
 * Logs supervised-child progress to STDERR (STDOUT carries the single structured outcome JSON),
 * prefixed `[INFO]` so the orchestrator's `ProcessSupervisorService` classifies it as INFO. Its
 * `getChildLogLevel` defaults UNPREFIXED child stderr to ERROR, which otherwise mis-stamps routine
 * progress as errors and camouflages real failures. Genuine failures stay on raw `console.error`
 * (unprefixed → ERROR).
 * @param {...*} args
 */
const logProgress = (...args) => console.error('[INFO]', ...args);

/**
 * @summary Binds an unstamped developer checkout to its exact clean Brain revision.
 *
 * Production images carry `.neo-revision` and the image reader verifies it directly. A local
 * checkout has no stamp, so the CLI entrypoint supplies its explicit root and HEAD only after
 * refusing tracked edits; the repository reader never guesses from cwd or a moving branch name.
 *
 * @param {Object} [options]
 * @param {String} [options.root=AiConfig.neoRootDir] Explicit Brain checkout root.
 * @param {Function} [options.runGit=execFileSync] Injectable Git command for tests.
 * @param {Function} [options.hasStamp=existsSync] Injectable stamp probe for tests.
 * @returns {String|undefined} Exact Git SHA for a checkout, or undefined for a stamped image.
 */
export function resolveCoreBrainRevision({
    root = AiConfig.neoRootDir,
    runGit = execFileSync,
    hasStamp = existsSync
} = {}) {
    if (hasStamp(path.join(root, '.neo-revision'))) {
        return
    }

    return resolveCleanBrainCheckoutRevision({root, runGit})
}

/**
 * Adapts the shared lease yield voter to the bare predicate this script's embed loop consults.
 * Kept exported so the existing boundary test still asserts THIS script reaches the correct config
 * branch — `orchestrator.heavyMaintenance` (which holds `maxActiveHoldMs`), NOT the sibling
 * `orchestrator.heavyMaintenanceLease` (which holds only `staleAfterMs`); the direct VectorService
 * embed seam cannot prove the script-level config wiring.
 *
 * The reading itself moved to `createLeaseYieldVoter`, which is now the single site that knows the
 * branch. Two copies of one config read is how the sibling-leaf trap gets fixed in one place and
 * left standing in the other.
 *
 * The no-lease fallback is `() => false` rather than the voter's `null`, and that is not a widening:
 * `shouldYieldHeavyMaintenanceLease` returns `false` for a missing lease (`!lease` is its first
 * guard), so the previous body answered `false` on that input too. This loop wants a callable.
 *
 * @param {{lease: Object}} acquisition The `withHeavyMaintenanceLease` descriptor (`{status, acquired, lease}`).
 * @returns {Function} A zero-arg predicate the additive embed loop consults between batches.
 */
export function buildLeaseYieldPredicate(acquisition) {
    return createLeaseYieldVoter(acquisition)?.vote ?? (() => false);
}

/**
 * Maps the `withHeavyMaintenanceLease` outcome to the structured stdout envelope that
 * `ProcessSupervisorService.classifySuccessfulChildOutcome` and `PrimaryRepoSyncService.runKbSync` consume.
 * A lease-HELD run and a cooperative lease-YIELD are both PARTIAL (no full sync completed), so both carry
 * `{deferred: true, reason}` — the consumers record `skipped`, never a false-green `completed` that would
 * refresh kbSync's lastSuccessAt. A real run carries `{deferred: false, ...counts}`. Pure (no I/O) so it is
 * unit-testable without the script's Neo bootstrap.
 * @param {Object} outcome The `withHeavyMaintenanceLease` return (`{status, result, lease}`).
 * @returns {Object} The structured stdout object.
 */
export function classifyKbSyncOutcome(outcome) {
    if (outcome.status === 'held') {
        const held = outcome.lease;
        return {
            deferred: true,
            reason  : 'heavy-maintenance-lease-held',
            holder  : {owner: held.owner, reason: held.reason, pid: held.pid, acquiredAt: held.acquiredAt}
        };
    }

    const result = outcome.result || {};

    if (result.yielded === true) {
        return {deferred: true, reason: 'heavy-maintenance-lease-yield', ...result};
    }

    return {deferred: false, ...result};
}

async function syncKnowledgeBase() {
    // Enable debug logging to see progress. B4-safe activation: drive NEO_DEBUG via the Provider
    // override API, never mutate the read-only reactive Provider.
    KB_Config.setEnvOverride('NEO_DEBUG', true);
    const staleStrategy = process.env.NEO_KB_STALE_STRATEGY || undefined;
    const brainRevision = resolveCoreBrainRevision();

    logProgress('⏳ Initializing Knowledge Base Services...');
    if (staleStrategy) {
        logProgress(`   Using explicit stale strategy: ${staleStrategy}`);
    }

    // Run the full sync under the shared heavy-maintenance lease so this CLI cannot
    // collide with the orchestrator's own kbSync task or with other manual graph-heavy
    // scripts.
    let outcome;
    try {
        outcome = await withHeavyMaintenanceLease(
            async (acquisition) => {
                logProgress('   Waiting for Lifecycle Service...');
                await KB_LifecycleService.ready();
                logProgress('   Lifecycle Service Ready. Database should be running.');

                logProgress('   Waiting for Chroma Manager...');
                await KB_ChromaManager.ready();
                logProgress('   Chroma Manager Ready.');

                logProgress('   Waiting for Database Service...');
                await KB_DatabaseService.ready();
                logProgress('   Database Service Ready.');

                logProgress('✅ Services Ready. Starting Synchronization...');

                // Execute the additive profile sync (create + embed). Until the full re-embed /
                // legacy-row migration receipt lands, an explicit stale strategy refuses rather
                // than allowing the old neo-owned conversation or source-code rows to be deleted.
                // The cooperative lease-yield predicate lets a long additive embed release the lease
                // at a batch boundary; the next sweep skips rows already durably upserted.
                return KB_DatabaseService.syncDatabase({
                    staleStrategy,
                    brainRevision,
                    shouldYield: buildLeaseYieldPredicate(acquisition)
                });
            },
            {
                leasePath   : resolveHeavyMaintenanceLeasePath({dataDir: AiConfig.orchestrator.dataDir}),
                owner       : 'kbSync',
                reason      : 'manual-cli',
                staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
                metadata    : {script: 'ai/scripts/maintenance/syncKnowledgeBase.mjs'}
            }
        );
    } catch (e) {
        console.error('❌ Synchronization Failed:', e);
        process.exit(1);
    }

    // A lease-HELD run and a cooperative lease-YIELD are both PARTIAL → classifyKbSyncOutcome emits a
    // `{deferred: true, reason}` envelope so ProcessSupervisorService + PrimaryRepoSyncService record
    // `skipped`, not a false-green `completed` that would refresh kbSync's lastSuccessAt.
    const classified = classifyKbSyncOutcome(outcome);

    if (classified.reason === 'heavy-maintenance-lease-held') {
        const held = classified.holder;
        logProgress(`⏸️  Deferred: heavy-maintenance lease held by '${held.owner}' (reason='${held.reason}', pid=${held.pid}, acquiredAt=${held.acquiredAt}).`);
        logProgress('   This script will not run while another heavy-maintenance task is active. Re-invoke once the active owner completes.');
    } else if (classified.reason === 'heavy-maintenance-lease-yield') {
        logProgress(`⏸️  Yielded: released the heavy-maintenance lease at a batch boundary; the next sweep resumes the additive profile writes.`);
    } else {
        logProgress(`✅ Synchronization Complete: ${JSON.stringify(outcome.result)}`);
    }

    console.log(JSON.stringify(classified));
    process.exit(0);
}

// Auto-run only when invoked directly (CLI / orchestrator spawn-child) — NOT when imported by a boundary
// test that exercises the exported `buildLeaseYieldPredicate` / `classifyKbSyncOutcome` units.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
    syncKnowledgeBase();
}
