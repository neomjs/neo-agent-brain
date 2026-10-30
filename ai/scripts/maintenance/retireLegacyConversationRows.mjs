// Bootstrap Neo namespace BEFORE the CLI imports Knowledge Base services; runtime config evaluates
// through the Neo singleton namespace during service setup.
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import {Command}       from 'commander';
import {isEntryModule} from '../../services/shared/isEntryModule.mjs';

/**
 * @module ai.scripts.maintenance.retireLegacyConversationRows
 * @summary Dry-run-first retirement of the frozen conversation rows the retired Sources left under the
 * default `{tenantId, repoSlug}` stamp.
 *
 * The retired Sources stamped the tickets, pull requests and discussions mirrored under `resources/content/`
 * with the same tuple as the Engine's source code. The corpus now arrives as its own tenant repository, so
 * those rows are frozen duplicates that nothing emits or reconciles any more. This script deletes exactly
 * them: rows in the default stamp whose `type` is a conversation type. Everything else in that stamp,
 * including the Engine profile's rows, is the preservation population, and its count must be identical
 * after the delete.
 *
 * Refusals are checked before anything is deleted:
 * - a selected row whose `source` is outside `resources/content/` (the filter would reach a non-mirror row);
 * - no replacement: the configured tenant repository that is the corpus source must have an accepted
 *   manifest from its configured extraction identity, and conversation rows of its own.
 *
 * Destructive execution requires `--apply` and the confirmation token. The CLI holds the shared
 * heavy-maintenance lease, so no Knowledge Base writer runs between the census and the recount. Chroma
 * has no transaction: once deletion has begun, an interruption or a changed preserved count exits
 * non-zero with the receipt of what was confirmed, and the pre-run backup is the way back.
 *
 * Usage, inside the orchestrator container:
 *   node ai/scripts/maintenance/retireLegacyConversationRows.mjs
 *   node ai/scripts/maintenance/retireLegacyConversationRows.mjs --apply --confirm CONFIRM_RETIRE_LEGACY_CONVERSATION_ROWS
 */

export const APPLY_CONFIRMATION_TOKEN = 'CONFIRM_RETIRE_LEGACY_CONVERSATION_ROWS';
export const CONVERSATION_TYPES       = Object.freeze(['ticket', 'pull', 'discussion']);
export const DEFAULT_PAGE_SIZE        = 2000;
export const LEGACY_SOURCE_ROOT       = 'resources/content/';

/**
 * @summary Creates an Error carrying a stable refusal code.
 * @param {String} code
 * @param {String} message
 * @returns {Error}
 */
function refuse(code, message) {
    const error = new Error(message);

    error.code = code;
    return error
}

/**
 * @summary Builds the Chroma `where` clause for one stamp, optionally narrowed to the conversation types.
 * @param {Object}  scope
 * @param {String}  scope.tenantId
 * @param {String}  scope.repoSlug
 * @param {Boolean} [conversationOnly=false]
 * @returns {Object}
 */
export function scopeWhere({tenantId, repoSlug}, conversationOnly = false) {
    const clauses = [{tenantId: {$eq: tenantId}}, {repoSlug: {$eq: repoSlug}}];

    if (conversationOnly) {
        clauses.push({type: {$in: [...CONVERSATION_TYPES]}})
    }

    return {$and: clauses}
}

/**
 * @summary Pages through every row matching `where`, handing each id and metadata to `onRow`.
 * @param {Object}   options
 * @param {Object}   options.collection Chroma collection or compatible seam.
 * @param {Object}   options.where
 * @param {Function} [options.onRow]
 * @param {Boolean}  [options.withMetadata=false] Metadata is fetched only when a caller reads it.
 * @param {Number}   [options.pageSize=DEFAULT_PAGE_SIZE]
 * @returns {Promise<Number>} The number of rows visited.
 */
export async function scanRows({collection, where, onRow, withMetadata = false, pageSize = DEFAULT_PAGE_SIZE}) {
    let offset = 0;

    for (;;) {
        const page = await collection.get({where, include: withMetadata ? ['metadatas'] : [], limit: pageSize, offset});

        page.ids.forEach((id, index) => onRow?.(id, page.metadatas?.[index]));
        offset += page.ids.length;

        if (page.ids.length < pageSize) {
            return offset
        }
    }
}

/**
 * @summary Judges the observed replacement corpus before anything is deleted.
 *
 * The replacement is the configured tenant repository whose clone URL is the corpus source. It counts only
 * with an accepted manifest (a proof-bound extraction snapshot from the repository's configured extraction
 * identity) and conversation rows of its own. Another repository's conversation rows prove nothing about it.
 * @param {Object} options
 * @param {Object} options.collection Chroma collection or compatible seam.
 * @param {Object} options.scope The legacy stamp `{tenantId, repoSlug}`.
 * @param {Object} options.replacement The observation: `{repoSlug, extractionIdentity, manifest}`, `{repoSlug: null}`
 * when no configured repository is the corpus source, or `{error}` when the configuration or manifest was unreadable.
 * @returns {Promise<{refusal: Object|null, evidence: Object|null}>}
 */
export async function assessReplacement({collection, scope, replacement}) {
    if (replacement?.error) {
        return {refusal: {code: 'KB_LEGACY_RETIRE_CORPUS_UNREADABLE', message: `The corpus configuration or manifest could not be read: ${replacement.error}`}, evidence: null}
    }

    if (!replacement?.repoSlug) {
        return {refusal: {code: 'KB_LEGACY_RETIRE_CORPUS_UNCONFIGURED', message: `No configured repository of tenant '${scope.tenantId}' is the corpus source.`}, evidence: null}
    }

    if (replacement.repoSlug === scope.repoSlug) {
        return {refusal: {code: 'KB_LEGACY_RETIRE_CORPUS_IS_LEGACY_STAMP', message: `The corpus resolves to the legacy stamp '${scope.repoSlug}' itself.`}, evidence: null}
    }

    const {manifest} = replacement,
          snapshot   = manifest?.source === 'graph' ? manifest.extractionSnapshot : null;

    if (!snapshot) {
        return {refusal: {code: 'KB_LEGACY_RETIRE_CORPUS_MANIFEST_ABSENT', message: `'${replacement.repoSlug}' has no accepted manifest.`}, evidence: null}
    }

    const evidence = {
        repoSlug          : replacement.repoSlug,
        manifestUpdatedAt : manifest.updatedAt,
        extractionIdentity: snapshot.extractionIdentity,
        attemptId         : snapshot.proof.attemptId,
        envelopeDigest    : snapshot.proof.envelopeDigest,
        recordedAt        : snapshot.proof.recordedAt
    };

    if (snapshot.extractionIdentity !== replacement.extractionIdentity) {
        return {refusal: {code: 'KB_LEGACY_RETIRE_CORPUS_MANIFEST_STALE', message: `'${replacement.repoSlug}' was last extracted with ${snapshot.extractionIdentity}, not its configured ${replacement.extractionIdentity}.`}, evidence}
    }

    const rows = await collection.get({where: scopeWhere({tenantId: scope.tenantId, repoSlug: replacement.repoSlug}, true), include: [], limit: 1});

    if (rows.ids.length === 0) {
        return {refusal: {code: 'KB_LEGACY_RETIRE_NO_REPLACEMENT_CORPUS', message: `'${replacement.repoSlug}' holds no conversation rows to answer in place of the retired ones.`}, evidence}
    }

    return {refusal: null, evidence}
}

/**
 * @summary Reads the stamp's population and every reason to refuse, without deleting anything.
 * @param {Object} options
 * @param {Object} options.collection Chroma collection or compatible seam.
 * @param {Object} options.scope The default stamp `{tenantId, repoSlug}` the legacy Sources wrote.
 * @param {Object} options.replacement The replacement observation, see {@link assessReplacement}.
 * @param {Number} [options.pageSize=DEFAULT_PAGE_SIZE]
 * @returns {Promise<Object>} `{scopeTotal, preserved, conversationByType, ids, replacement, refusals}`
 */
export async function buildRetirementPlan({collection, scope, replacement, pageSize = DEFAULT_PAGE_SIZE}) {
    const conversationByType = {},
          ids                = [],
          outside            = [],
          refusals           = [];

    const scopeTotal = await scanRows({collection, where: scopeWhere(scope), pageSize});

    await scanRows({
        collection,
        where       : scopeWhere(scope, true),
        withMetadata: true,
        pageSize,
        onRow(id, metadata) {
            ids.push(id);
            conversationByType[metadata.type] = (conversationByType[metadata.type] || 0) + 1;

            if (!String(metadata.source).startsWith(LEGACY_SOURCE_ROOT)) {
                outside.push({id, type: metadata.type, source: metadata.source})
            }
        }
    });

    if (outside.length > 0) {
        refusals.push({
            code   : 'KB_LEGACY_RETIRE_SOURCE_OUTSIDE_LEGACY_ROOT',
            message: `${outside.length} selected rows live outside ${LEGACY_SOURCE_ROOT}; the filter would reach rows that are not the frozen mirror.`,
            sample : outside.slice(0, 5)
        })
    }

    const {refusal, evidence} = await assessReplacement({collection, scope, replacement});

    refusal && refusals.push(refusal);

    return {scopeTotal, preserved: scopeTotal - ids.length, conversationByType, ids, replacement: evidence, refusals}
}

/**
 * @summary Requires the explicit destructive confirmation token.
 * @param {String} confirmation
 */
export function assertApplyConfirmed(confirmation) {
    if (confirmation !== APPLY_CONFIRMATION_TOKEN) {
        throw refuse('KB_LEGACY_RETIRE_UNCONFIRMED', `Refusing to delete without --confirm ${APPLY_CONFIRMATION_TOKEN}.`)
    }
}

/**
 * @summary Plans the retirement and, with `apply`, deletes the selected rows and proves the preservation count.
 * @param {Object}  options
 * @param {Object}  options.collection Chroma collection or compatible seam.
 * @param {Object}  options.scope The default stamp `{tenantId, repoSlug}`.
 * @param {Object}  options.replacement The replacement observation, see {@link assessReplacement}.
 * @param {Boolean} [options.apply=false]
 * @param {String}  [options.confirmation='']
 * @param {Number}  [options.pageSize=DEFAULT_PAGE_SIZE]
 * @returns {Promise<Object>} The receipt: scope, replacement, before, refusals, retired, after.
 * @throws {Error} `KB_LEGACY_RETIRE_INTERRUPTED` or `KB_LEGACY_RETIRE_PRESERVATION_VIOLATED`, each carrying `receipt`.
 */
export async function runRetirement({collection, scope, replacement, apply = false, confirmation = '', pageSize = DEFAULT_PAGE_SIZE}) {
    if (apply) {
        assertApplyConfirmed(confirmation)
    }

    const plan    = await buildRetirementPlan({collection, scope, replacement, pageSize}),
          receipt = {
              apply,
              scope,
              replacement: plan.replacement,
              before     : {scopeTotal: plan.scopeTotal, preserved: plan.preserved, conversationByType: plan.conversationByType},
              refusals   : plan.refusals,
              retired    : 0,
              after      : null
          };

    if (!apply || plan.refusals.length > 0 || plan.ids.length === 0) {
        return receipt
    }

    let stage          = 'delete',
        confirmedPages = 0;

    try {
        for (let index = 0; index < plan.ids.length; index += pageSize) {
            const ids = plan.ids.slice(index, index + pageSize);

            await collection.delete({ids});
            receipt.retired += ids.length;
            confirmedPages++
        }

        stage = 'recount';

        const scopeTotal   = await scanRows({collection, where: scopeWhere(scope), pageSize}),
              conversation = await scanRows({collection, where: scopeWhere(scope, true), pageSize});

        receipt.after = {scopeTotal, preserved: scopeTotal - conversation, conversation}
    } catch (cause) {
        receipt.failure = stage === 'delete'
            ? {stage, confirmedPages, uncertainRows: Math.min(pageSize, plan.ids.length - receipt.retired), message: cause.message}
            : {stage, message: cause.message};

        const error = refuse(
            'KB_LEGACY_RETIRE_INTERRUPTED',
            `Stopped during ${stage} after ${receipt.retired} confirmed deletes; the failing page's outcome is unknown. Recount with a dry run, or restore from the pre-run backup.`
        );

        error.receipt = receipt;
        error.cause   = cause;
        throw error
    }

    if (receipt.after.preserved !== plan.preserved || receipt.after.conversation !== 0) {
        const error = refuse(
            'KB_LEGACY_RETIRE_PRESERVATION_VIOLATED',
            `Preserved rows went ${plan.preserved} -> ${receipt.after.preserved} and ${receipt.after.conversation} conversation rows remain; restore from the pre-run backup.`
        );

        error.receipt = receipt;
        throw error
    }

    return receipt
}

/**
 * @summary The JSON the CLI prints on failure: the code, the message and whatever receipt the failure carries.
 * @param {Error} error
 * @returns {Object}
 */
export function failureReport(error) {
    return {code: error.code, message: error.message, receipt: error.receipt}
}

/**
 * @summary Creates the CLI command object.
 * @returns {Command}
 */
export function createCommand() {
    return new Command()
        .name('retireLegacyConversationRows')
        .description('Dry-run-first retirement of the frozen conversation rows under the default Knowledge Base stamp.')
        .option('--apply', 'Delete the selected rows. Without it the script only reports.', false)
        .option('--confirm <token>', `Required with --apply: ${APPLY_CONFIRMATION_TOKEN}.`, '')
        .option('--page-size <n>', 'Rows per Chroma get/delete call.', String(DEFAULT_PAGE_SIZE));
}

/**
 * @summary Runs the retirement from process argv under the heavy-maintenance lease and prints the JSON receipt.
 * @param {String[]} [argv=process.argv]
 * @returns {Promise<Object>}
 */
export async function runCli(argv = process.argv) {
    const options  = createCommand().parse(argv).opts(),
          pageSize = Number(options.pageSize);

    if (!Number.isInteger(pageSize) || pageSize <= 0) {
        throw new Error(`page-size must be a positive integer; received ${options.pageSize}`)
    }

    const {default: AiConfig}                                           = await import('../../config.mjs'),
          {default: ChromaManager}                                      = await import('../../services/knowledge-base/ChromaManager.mjs'),
          {default: IngestionService}                                   = await import('../../services/knowledge-base/IngestionService.mjs'),
          {default: VectorService}                                      = await import('../../services/knowledge-base/VectorService.mjs'),
          {deriveRepoSlugFromCloneUrl}                                  = await import('../../services/knowledge-base/helpers/tenantRepoAccessContract.mjs'),
          {resolveHeavyMaintenanceLeasePath, withHeavyMaintenanceLease} = await import('../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs');

    const {tenantId, repoSlug} = VectorService.resolveTenantStamp();

    // host/owner/name, so `.git` and trailing-slash spellings of one repository compare equal
    const repositoryKey = url => {
        try {
            return deriveRepoSlugFromCloneUrl(url)
        } catch (e) {
            return null
        }
    };

    await ChromaManager.ready();

    const outcome = await withHeavyMaintenanceLease(
        async () => {
            let replacement;

            try {
                const corpusKey     = repositoryKey(AiConfig.orchestrator.corpusProjection.sourceRepository),
                      {tenantRepos} = await IngestionService.listConfiguredTenantRepos(),
                      corpus        = corpusKey && tenantRepos.find(repo => repo.tenantId === tenantId && repositoryKey(repo.cloneUrl) === corpusKey);

                replacement = corpus ? {
                    repoSlug          : corpus.repoSlug,
                    extractionIdentity: corpus.extractionIdentity,
                    manifest          : await IngestionService.getTenantManifest({tenantId, repoSlug: corpus.repoSlug})
                } : {repoSlug: null}
            } catch (error) {
                replacement = {error: error.message}
            }

            return runRetirement({
                collection  : await ChromaManager.getKnowledgeBaseCollection(),
                scope       : {tenantId, repoSlug},
                replacement,
                apply       : options.apply,
                confirmation: options.confirm,
                pageSize
            })
        },
        {
            leasePath   : resolveHeavyMaintenanceLeasePath({dataDir: AiConfig.orchestrator.dataDir}),
            owner       : 'kbLegacyConversationRetirement',
            reason      : 'manual-cli',
            staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
            metadata    : {script: 'ai/scripts/maintenance/retireLegacyConversationRows.mjs'}
        }
    );

    if (outcome.status === 'held') {
        throw refuse('KB_LEGACY_RETIRE_LEASE_HELD', `The heavy-maintenance lease is held by ${outcome.lease.owner}; nothing was read or deleted.`)
    }

    console.log(JSON.stringify(outcome.result, null, 2));

    if (outcome.result.apply && outcome.result.refusals.length > 0) {
        process.exitCode = 1
    }

    return outcome.result
}

if (isEntryModule(import.meta.url)) {
    try {
        await runCli()
    } catch (error) {
        console.error(JSON.stringify(failureReport(error), null, 2));
        process.exitCode = 1
    }
}
