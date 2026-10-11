// Bootstrap Neo namespace BEFORE the CLI imports Knowledge Base services; runtime config evaluates
// through the Neo singleton namespace during service setup.
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import {Command}       from 'commander';
import {pathToFileURL} from 'url';

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
 * - no conversation rows under any other repository of the tenant (nothing would answer in their place).
 *
 * Destructive execution requires `--apply` and the confirmation token. The CLI holds the shared
 * heavy-maintenance lease, so no Knowledge Base writer runs between the census and the recount.
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
 * @param {Object}  scope.repoSlug An exact slug, or a Chroma operator object such as `{$ne: 'neo'}`.
 * @param {Boolean} [conversationOnly=false]
 * @returns {Object}
 */
export function scopeWhere({tenantId, repoSlug}, conversationOnly = false) {
    const clauses = [
        {tenantId: {$eq: tenantId}},
        {repoSlug: typeof repoSlug === 'string' ? {$eq: repoSlug} : repoSlug}
    ];

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
 * @summary Reads the stamp's population and every reason to refuse, without deleting anything.
 * @param {Object} options
 * @param {Object} options.collection Chroma collection or compatible seam.
 * @param {Object} options.scope The default stamp `{tenantId, repoSlug}` the legacy Sources wrote.
 * @param {Number} [options.pageSize=DEFAULT_PAGE_SIZE]
 * @returns {Promise<Object>} `{scopeTotal, preserved, conversationByType, ids, refusals}`
 */
export async function buildRetirementPlan({collection, scope, pageSize = DEFAULT_PAGE_SIZE}) {
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

    const replacement = await collection.get({
        where  : scopeWhere({tenantId: scope.tenantId, repoSlug: {$ne: scope.repoSlug}}, true),
        include: [],
        limit  : 1
    });

    if (replacement.ids.length === 0) {
        refusals.push({
            code   : 'KB_LEGACY_RETIRE_NO_REPLACEMENT_CORPUS',
            message: `No conversation rows exist under another repository of tenant '${scope.tenantId}'; nothing would answer in place of the retired rows.`
        })
    }

    return {scopeTotal, preserved: scopeTotal - ids.length, conversationByType, ids, refusals}
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
 * @param {Boolean} [options.apply=false]
 * @param {String}  [options.confirmation='']
 * @param {Number}  [options.pageSize=DEFAULT_PAGE_SIZE]
 * @returns {Promise<Object>} The receipt: scope, before, refusals, retired, after.
 */
export async function runRetirement({collection, scope, apply = false, confirmation = '', pageSize = DEFAULT_PAGE_SIZE}) {
    if (apply) {
        assertApplyConfirmed(confirmation)
    }

    const plan    = await buildRetirementPlan({collection, scope, pageSize}),
          receipt = {
              apply,
              scope,
              before  : {scopeTotal: plan.scopeTotal, preserved: plan.preserved, conversationByType: plan.conversationByType},
              refusals: plan.refusals,
              retired : 0,
              after   : null
          };

    if (!apply || plan.refusals.length > 0 || plan.ids.length === 0) {
        return receipt
    }

    for (let index = 0; index < plan.ids.length; index += pageSize) {
        const ids = plan.ids.slice(index, index + pageSize);

        await collection.delete({ids});
        receipt.retired += ids.length
    }

    const scopeTotal   = await scanRows({collection, where: scopeWhere(scope), pageSize}),
          conversation = await scanRows({collection, where: scopeWhere(scope, true), pageSize});

    receipt.after = {scopeTotal, preserved: scopeTotal - conversation, conversation};

    if (receipt.after.preserved !== plan.preserved || conversation !== 0) {
        const error = refuse(
            'KB_LEGACY_RETIRE_PRESERVATION_VIOLATED',
            `Preserved rows went ${plan.preserved} -> ${receipt.after.preserved} and ${conversation} conversation rows remain; restore from the pre-run backup.`
        );

        error.receipt = receipt;
        throw error
    }

    return receipt
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

    const {default: AiConfig}      = await import('../../config.mjs'),
          {default: ChromaManager} = await import('../../services/knowledge-base/ChromaManager.mjs'),
          {default: VectorService} = await import('../../services/knowledge-base/VectorService.mjs'),
          {resolveHeavyMaintenanceLeasePath, withHeavyMaintenanceLease} = await import('../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs');

    const {tenantId, repoSlug} = VectorService.resolveTenantStamp();

    await ChromaManager.ready();

    const outcome = await withHeavyMaintenanceLease(
        async () => runRetirement({
            collection  : await ChromaManager.getKnowledgeBaseCollection(),
            scope       : {tenantId, repoSlug},
            apply       : options.apply,
            confirmation: options.confirm,
            pageSize
        }),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await runCli()
    } catch (error) {
        console.error(JSON.stringify({code: error.code, message: error.message, receipt: error.receipt}, null, 2));
        process.exitCode = 1
    }
}
