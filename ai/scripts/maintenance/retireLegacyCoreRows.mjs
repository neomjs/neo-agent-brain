import fs                                                   from 'node:fs/promises';
import path                                                 from 'node:path';
import {fileURLToPath}                                      from 'node:url';
import Neo                                                  from 'neo.mjs/src/Neo.mjs';
import * as core                                            from 'neo.mjs/src/core/_export.mjs';
import {Command}                                            from 'commander';
import {isEntryModule}                                      from '../../services/shared/isEntryModule.mjs';
import {writeFileAtomic}                                    from '../../services/shared/atomicFileWrite.mjs';
import {applyCoreRowRetirement, validateCoreRetirementPlan} from './coreRowRetirement.mjs';
import {buildCoreRowRetirementPlan, fingerprint}            from './coreRowRetirementPlan.mjs';

/**
 * @module ai.scripts.maintenance.retireLegacyCoreRows
 * @summary Manual, dry-run-first retirement of exact replacement-proven legacy core rows.
 *
 * A private plan contains old snapshots and a byte-bound correspondence. Applying it requires its
 * exact digest and the shared heavy-maintenance lease. Current artifact bytes, source revisions and
 * landed replacement metadata are rechecked before the executor dispatches any captured old ID.
 * No scheduler or embedding operation is enabled. Preserve a restorable pre-run backup separately:
 * a Chroma delete is irreversible, and an interrupted application retains its durable journal.
 *
 * Usage in the selected, configured Brain runtime:
 *   node ai/scripts/maintenance/retireLegacyCoreRows.mjs --plan-file /private/core-retirement.json
 *   node ai/scripts/maintenance/retireLegacyCoreRows.mjs --plan-file /private/core-retirement.json --apply --confirm <planDigest>
 *
 * The private plan holds full metadata snapshots and the exact ID preview; publish only the bounded
 * stdout receipt. A retry uses the same plan and adjacent progress journal. Runtime service loading
 * may initialize recorder telemetry after lease acquisition; dry run never embeds or mutates KB rows.
 * The shared lease serializes orchestrator maintenance, not every direct KB writer. Before applying,
 * require a verified admission block and drained writers for the whole window. Boundary checks can
 * detect a moving population or changed replacement, but Chroma provides no rollback or transaction.
 */

const PLAN_SCHEMA = 'neo.legacy-core-retirement-file/v1';
export const DEFAULT_PAGE_SIZE = 2000;

/** @summary Creates a bounded refusal without including corpus content. */
function refuse(code) {
    return Object.assign(new Error(code), {code});
}

/** @summary Reads only a regular private file, refusing symlink and permissive file carriers. */
async function readPrivateFile(filePath, fsModule, missing = false) {
    try {
        const stat = await fsModule.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
            throw refuse('KB_CORE_RETIRE_FILE_NOT_PRIVATE');
        }
        return await fsModule.readFile(filePath, 'utf8');
    } catch (error) {
        if (missing && error.code === 'ENOENT') return null;
        throw error;
    }
}

/** @summary Requires an unused output name so planning cannot replace a captured plan or journal. */
async function assertAbsent(filePath, fsModule) {
    try {
        await fsModule.lstat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    throw refuse('KB_CORE_RETIRE_FILE_EXISTS');
}

/** @summary Validates private plan bytes and the correspondence that its digest binds. */
function parsePlanFile(text) {
    const envelope = JSON.parse(text);
    if (envelope.schemaVersion !== PLAN_SCHEMA || !envelope.correspondence
        || typeof envelope.correspondence.text !== 'string') throw refuse('KB_CORE_RETIRE_FILE_INVALID');
    validateCoreRetirementPlan(envelope.plan);
    if (envelope.correspondence.sha256 !== envelope.plan.binding.correspondenceSha256) {
        throw refuse('KB_CORE_RETIRE_CORRESPONDENCE_CHANGED');
    }
    return envelope;
}

/** @summary Produces counts and fingerprints for stdout; the private file retains exact preview IDs. */
function planReceipt(plan) {
    const scope    = plan.binding.scope, legacyByFamily = {};
    const profiles = plan.binding.artifacts.map(artifact => {
        const ids = plan.census.filter(row => row.metadata.tenantId === artifact.tenantId
            && row.metadata.repoSlug === artifact.repoSlug && row.metadata.extractionIdentity === artifact.extractionIdentity)
            .map(row => row.id).sort();
        return {repoSlug: artifact.repoSlug, revision: artifact.revision, extractionIdentity: artifact.extractionIdentity,
            artifactSha256: artifact.sha256, artifactCount: artifact.count, landedCount: ids.length, landedIdDigest: fingerprint(ids)};
    });
    for (const row of plan.census) {
        if (row.metadata.tenantId === scope.tenantId && row.metadata.repoSlug === scope.repoSlug
            && !Object.hasOwn(row.metadata, 'extractionIdentity')) {
            const family = row.metadata.type || 'unknown';
            legacyByFamily[family] = (legacyByFamily[family] || 0) + 1;
        }
    }
    return {
        planDigest: plan.planDigest,
        scope, collectionId: plan.binding.collectionId,
        populationIdDigest: plan.binding.populationIdDigest,
        manifestSha256    : plan.binding.manifestSha256, profiles, legacyByFamily,
        candidateCount    : plan.retirementIds.length,
        noOp              : plan.retirementIds.length === 0,
        retainedCount     : plan.retained.length,
        refusalCount      : plan.refusals.length,
        executable        : plan.executable,
        preservation      : {count: plan.preservation.count, digest: plan.preservation.digest}
    };
}

/**
 * @summary Plans or resumes one retirement inside the caller's maintenance lease.
 * @param {Object} options
 * @param {Object} options.collection Existing selected collection; never created by this operation.
 * @param {Function} options.prepareInputs Reads current selected source artifacts and landed rows.
 * @param {String} options.planPath Explicit absolute private plan path.
 * @param {Boolean} [options.apply=false]
 * @param {String} [options.confirmation=''] Exact plan digest.
 * @param {Number} [options.pageSize=DEFAULT_PAGE_SIZE]
 * @param {Object} [options.fsModule=fs]
 * @param {Function} [options.writeAtomic=writeFileAtomic]
 * @returns {Promise<Object>} Bounded operational receipt.
 */
export async function runCoreRetirement({
    collection, prepareInputs, planPath, apply = false, confirmation = '',
    pageSize = DEFAULT_PAGE_SIZE, fsModule = fs, writeAtomic = writeFileAtomic
}) {
    if (typeof planPath !== 'string' || !path.isAbsolute(planPath)) throw refuse('KB_CORE_RETIRE_PLAN_PATH_REQUIRED');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw refuse('KB_CORE_RETIRE_PAGE_SIZE_INVALID');
    const progressPath = planPath + '.progress.json';
    const persist      = (target, value) => writeAtomic(target, JSON.stringify(value) + '\n', {
        fsync: true, mode: 0o600, fsModule
    });
    if (!apply) {
        await assertAbsent(planPath, fsModule);
        await assertAbsent(progressPath, fsModule);
        const inputs = await prepareInputs();
        const plan   = buildCoreRowRetirementPlan(inputs);
        await persist(planPath, {schemaVersion: PLAN_SCHEMA, plan, correspondence: inputs.correspondence});
        return {apply: false, ...planReceipt(plan)};
    }
    const text     = await readPrivateFile(planPath, fsModule);
    const envelope = parsePlanFile(text), {plan} = envelope;
    if (confirmation !== plan.planDigest) throw refuse('KB_CORE_RETIRE_UNCONFIRMED');
    const correspondence = Object.freeze({...envelope.correspondence});
    const receipt        = await applyCoreRowRetirement({
        collection, plan, confirmation, pageSize,
        async revalidate(captured) {
            if (await readPrivateFile(planPath, fsModule) !== text) throw refuse('KB_CORE_RETIRE_FILE_CHANGED');
            const current = await prepareInputs();
            if (current.collectionId !== captured.binding.collectionId
                || fingerprint(current.scope) !== fingerprint(captured.binding.scope)) {
                throw refuse('KB_CORE_RETIRE_COLLECTION_CHANGED');
            }
            const observed = new Map(current.census.map(row => [row.id, row]));
            const targets  = new Set(captured.candidates.flatMap(candidate =>
                candidate.replacements.flatMap(replacement => replacement.ids)));
            const census = captured.census.flatMap(row => {
                if (!targets.has(row.id)) return [{id: row.id, metadata: row.metadata}];
                const fresh = observed.get(row.id);
                return fresh ? [{id: row.id, metadata: fresh.metadata}] : [];
            });
            return buildCoreRowRetirementPlan({
                ...current, census, correspondence, protectedIds: captured.binding.protectedIds
            }).planDigest;
        },
        async readProgress() {
            const saved = await readPrivateFile(progressPath, fsModule, true);
            return saved === null ? null : JSON.parse(saved);
        },
        async writeProgress(progress) {
            // Refuse an existing unsafe carrier; atomicFileWrite owns strict file + directory fsync.
            await readPrivateFile(progressPath, fsModule, true);
            await persist(progressPath, progress);
        }
    });
    return {apply: true, ...receipt};
}

/** @summary Defines the manual CLI without loading any runtime service. */
export function createCommand() {
    return new Command()
        .name('retireLegacyCoreRows')
        .description('Plan or explicitly apply replacement-proven legacy core-row retirement.')
        .requiredOption('--plan-file <absolute-path>', 'Private frozen plan; planning refuses an existing file.')
        .option('--apply', 'Apply the captured plan; requires its exact digest.', false)
        .option('--confirm <digest>', 'Exact plan digest returned by the dry run.', '')
        .option('--brain-revision <sha>', 'Exact checkout revision when the Brain image is unstamped.')
        .option('--page-size <n>', 'Maximum IDs per read/delete batch.', String(DEFAULT_PAGE_SIZE));
}

/**
 * @summary Resolves selected runtime configuration and executes under the shared maintenance lease.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const options = createCommand().parse(argv).opts(), pageSize = Number(options.pageSize);
    if (!path.isAbsolute(options.planFile)) throw refuse('KB_CORE_RETIRE_PLAN_PATH_REQUIRED');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw refuse('KB_CORE_RETIRE_PAGE_SIZE_INVALID');
    if (options.apply) {
        const saved = parsePlanFile(await readPrivateFile(options.planFile, fs));
        if (options.confirm !== saved.plan.planDigest) throw refuse('KB_CORE_RETIRE_UNCONFIRMED');
    }
    const {default: AiConfig} = await import('../../config.mjs');
    const {resolveHeavyMaintenanceLeasePath, withHeavyMaintenanceLease} =
        await import('../../daemons/orchestrator/services/heavyMaintenanceLeasePrimitives.mjs');
    const outcome = await withHeavyMaintenanceLease(async () => {
        const {default: kbConfig}              = await import('../../mcp/server/knowledge-base/config.mjs');
        const {default: VectorService}         = await import('../../services/knowledge-base/VectorService.mjs');
        const {default: ChromaManager}         = await import('../../services/knowledge-base/ChromaManager.mjs');
        const {prepareCoreRowRetirementInputs} = await import('./coreRowRetirementInputs.mjs');
        await VectorService.ready();
        // Deliberately bypass canonical get-or-create: an absent collection is a refusal.
        const collection = await ChromaManager.client.getCollection({
            name: kbConfig.collectionName, embeddingFunction: kbConfig.dummyEmbeddingFunction
        });
        const scope = VectorService.resolveTenantStamp();
        return runCoreRetirement({
            collection, planPath: options.planFile, apply: options.apply,
            confirmation : options.confirm, pageSize,
            prepareInputs: () => prepareCoreRowRetirementInputs({
                collection, vectorService: VectorService,
                scope        : {tenantId: scope.tenantId, repoSlug: scope.repoSlug},
                dataPath     : kbConfig.dataPath,
                brainRoot    : fileURLToPath(new URL('../../../', import.meta.url)),
                brainRevision: options.brainRevision, pageSize
            })
        });
    }, {
        leasePath   : resolveHeavyMaintenanceLeasePath({dataDir: AiConfig.orchestrator.dataDir}),
        owner       : 'kbLegacyCoreRetirement', reason: 'manual-cli',
        staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
        metadata    : {script: 'ai/scripts/maintenance/retireLegacyCoreRows.mjs'}
    });
    if (!['completed', 'inherited'].includes(outcome.status)) throw refuse('KB_CORE_RETIRE_LEASE_UNAVAILABLE');
    console.log(JSON.stringify(outcome.result, null, 2));
    if (outcome.result.refusalCount) process.exitCode = 1;
    return outcome.result;
}

if (isEntryModule(import.meta.url)) {
    try {
        await runCli();
    } catch (error) {
        console.error(JSON.stringify({code: error.code || 'KB_CORE_RETIRE_INTERRUPTED', receipt: error.receipt}));
        process.exitCode = 1;
    }
}
