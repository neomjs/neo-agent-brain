// ---------------------------------------------------------------------------------------------
// DELIBERATE, TEMPORARY SDK-BOUNDARY EXCEPTION — retirement is enforced mechanically, see below.
//
// The canonical entry point is `ai/services.mjs` and this file's own SDK-boundary note still
// describes the rule correctly. The barrel is an EAGER 65-import graph, and two of its leaves
// (`services/knowledge-base/ChromaManager.mjs`, `services/memory-core/managers/ChromaManager.mjs`)
// import `chromadb` at module scope. `chromadb` ships only in the Brain install tier, so merely
// LOADING the barrel fails in the Body-tier CI this script runs in:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'chromadb'
//     imported from ai/services/knowledge-base/ChromaManager.mjs
//   [DataSync] stage "GitHub Workflow corpus" failed
//
// That freezes `resources/content/issues` AND `resources/content/discussions` — the corpus the
// duplicate-sweep fallback and semantic retrieval both read — for as long as it stands.
//
// The correct fix defers those two leaf imports, which is a real initialization refactor of both
// managers with ~20 external readers of `.client` plus a documented test seam. That is deliberately
// NOT bundled into a pipeline restore. This exception is the bridge, and it is not trusted to a
// comment: `syncGithubWorkflowImportException.spec.mjs` FAILS the moment the barrel becomes safe to
// import, which is what makes this self-expiring rather than permanent.
// ---------------------------------------------------------------------------------------------

// Neo namespace bootstrap, normally supplied by the barrel. Both look unused and are not: they
// populate `globalThis.Neo` before any service module body runs `Neo.setupClass`.
import Neo       from 'neo.mjs/src/Neo.mjs';
import * as core from 'neo.mjs/src/core/_export.mjs';

import GH_Config from '../../mcp/server/github-workflow/config.mjs';
import AiConfig  from '../../config.mjs';
import fs        from 'node:fs/promises';
import path      from 'node:path';
import {validateSegment} from '../../services/github-workflow/shared/contentPath.mjs';

import {
    resolveHeavyMaintenanceLeasePath,
    withHeavyMaintenanceLease
} from '../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs';
import {fileURLToPath, pathToFileURL} from 'url';
import {
    buildSyncGithubWorkflowDevBranchGuard,
    defaultSyncGithubWorkflowBranchDetector
} from './syncGithubWorkflowBranchGuard.mjs';

/**
 * @module ai/scripts/maintenance/syncGithubWorkflow
 * @summary CLI for manual GitHub Workflow delivery and origin-qualified, pull-only corpus emission.
 *
 * **Why this operator CLI is the canonical manual entry point:**
 *
 * The scheduled Data Sync pipeline invokes this CLI with `--emit-only`, delegating to
 * `GH_SyncService.emitGeneratedContentAndDerive({pushLocalChanges: false})`. Operators
 * retain the default `GH_SyncService.runFullSync()` mode, including its intentional
 * local-to-GitHub issue push. Native Graph projection is absent: the container-plane
 * core-corpus projection owner is its only admitted writer. The long-running emission is absent from the
 * agent MCP surface: clean-slate emission can span
 * ~8.5k issues + ~2.8k PRs + ~165 discussions + ~166 release notes and must stay
 * behind the shared heavy-maintenance lease rather than an MCP request timeout.
 * `--corpus-only` instead emits the three conversation facets into an explicitly declared external
 * corpus root, with a corpus-local shared lease and no git publication or consumer derivation.
 *
 * Corpus publishers pin a Brain checkout by immutable commit, run `npm ci` and `npm run prepare`,
 * then invoke this script from that installation. `NEO_MCP_GITHUB_OWNER` and `NEO_MCP_GITHUB_REPO`
 * select the source (defaults: `neomjs` / `neo`); `GH_TOKEN` supplies GitHub read access.
 * `NEO_MCP_GITHUB_CONTENT_ROOT` must name an existing absolute destination outside the runtime.
 * The destination owns shared `_index.json`, `<repo>/{issues,pulls,discussions,archive}/...`, and
 * `<repo>/.sync-metadata.json`. Publish all of them in one revision only after exit 0. Any nonzero
 * exit, including partial facet failure or a held lease, forbids publication of that attempt.
 * `.corpus-sync.lock` is transient and must not be published. Progress stays in the destination;
 * the publisher owns cleanup of unsuccessful attempts and serialization across jobs.
 *
 * Ordinary invocation retains its existing local directory layout and consumer derivation.
 * Both modes write origin-qualified index identities. Bootstrapping an unqualified legacy index
 * requires explicit `NEO_MCP_GITHUB_LEGACY_REPO_SLUG`; the current source is never guessed as owner.
 *
 * The CLI:
 * - avoids an MCP request-timeout ceiling
 * - uses declared `NEO_LOG_LEVEL` for syncer diagnostics; `--verbose` prints context and full results
 * - keeps scheduled CI read-only at the GitHub API boundary while preserving the
 *   operator's full bi-directional mode
 *
 * **SDK boundary exception:** the file header owns the temporary direct-import rationale and its
 * self-expiring test. Neo/core imports preserve namespace bootstrap. There is no sync-on-startup
 * override anymore: that config leaf and its service branch were retired with the exclusive
 * container-plane projection owner.
 *
 * The authority boundary is the regeneratable-cache model: this script exists
 * to rebuild workflow mirrors outside the MCP request-timeout envelope.
 *
 * @example
 *   npm run ai:sync-github-workflow
 *   npm run ai:sync-github-workflow -- --verbose
 *   npm run ai:sync-github-workflow -- --emit-only
 *   NEO_MCP_GITHUB_OWNER=neomjs NEO_MCP_GITHUB_REPO=neo \
 *     NEO_MCP_GITHUB_CONTENT_ROOT=/checkout/corpus npm run ai:sync-github-workflow -- --corpus-only
 *
 *   # Full output streamed to stdout/stderr (no MCP timeout ceiling).
 *   # Exit code 0 on success / 1 on failure.
 */

/**
 * @summary Asserts that the GitHub Workflow sync CLI is running from dev.
 * @returns {Promise<void>}
 */
async function assertSyncGithubWorkflowDevBranch() {
    const
        projectRoot = GH_Config.projectRoot,
        guard       = buildSyncGithubWorkflowDevBranchGuard(
            async () => true,
            () => defaultSyncGithubWorkflowBranchDetector({projectRoot})
        );

    await guard();
}

/**
 * @summary Resolves existing ancestors so an unwritten child cannot hide a symlink escape.
 * @param {String} candidate Absolute candidate path.
 * @returns {Promise<String>}
 */
async function resolveDestinationPath(candidate) {
    try {
        return await fs.realpath(candidate);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw error;
        return path.join(await resolveDestinationPath(parent), path.basename(candidate));
    }
}

/**
 * @summary Refuses an undeclared or escaping corpus destination before loading the emitter.
 * @returns {Promise<void>}
 * @throws {Error} If a required declaration is absent or a path leaves its admitted owner.
 */
async function assertCorpusDestination() {
    const required = GH_Config.validateRequiredEnv({entrypoint: 'sync-github-workflow', mode: 'corpus-only'});
    if (!required.ok) {
        throw new Error('Corpus emission requires an explicit destination: ' +
            required.findings.map(finding => finding.leafPath).join(', '));
    }
    validateSegment(GH_Config.owner, 'owner');
    validateSegment(GH_Config.repo, 'repo');
    if ([GH_Config.owner, GH_Config.repo].some(value => value === '.' || !/^[\w.-]+$/.test(value))) {
        throw new Error('Corpus source owner and repo must be GitHub name segments.');
    }
    if (!path.isAbsolute(GH_Config.issueSync.contentRoot)) {
        throw new Error('Corpus contentRoot must be absolute.');
    }

    const root = await fs.realpath(GH_Config.issueSync.contentRoot),
          runtimeRoots = [
              await fs.realpath(fileURLToPath(new URL('../../../', import.meta.url))),
              await fs.realpath(path.dirname(fileURLToPath(import.meta.resolve('neo.mjs/package.json'))))
          ],
          contains = (parent, child) => {
              const relative = path.relative(parent, child);
              return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
          };

    if (!(await fs.stat(root)).isDirectory() || runtimeRoots.some(runtime => contains(runtime, root))) {
        throw new Error('Corpus contentRoot must be a directory outside the installed runtime and Engine.');
    }

    const origin = await resolveDestinationPath(GH_Config.issueSync.originRoot);
    if (origin !== path.join(root, GH_Config.repo)) {
        throw new Error('Corpus originRoot must be its own directory inside contentRoot.');
    }
    try {
        const entries = await fs.readdir(origin, {recursive: true, withFileTypes: true});
        if (entries.some(entry => entry.isSymbolicLink())) {
            throw new Error('Corpus origin tree must not contain symbolic links.');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    for (const key of ['issuesDir', 'discussionsDir', 'pullsDir', 'archiveRoot', 'metadataFile']) {
        const target = await resolveDestinationPath(GH_Config.issueSync[key]);
        if (!contains(origin, target)) throw new Error(`Corpus ${key} escapes its origin root.`);
    }
    for (const target of [path.join(root, '_index.json'), GH_Config.issueSync.corpusLeaseFile]) {
        if (!contains(root, await resolveDestinationPath(target))) {
            throw new Error('Corpus index or lease escapes contentRoot.');
        }
    }
}

/**
 * @summary CLI entry point for full manual sync or scheduled pull-only corpus emission.
 * @returns {Promise<void>}
 */
async function syncGithubWorkflow() {
    const
        corpusOnly = process.argv.includes('--corpus-only'),
        emitOnly   = process.argv.includes('--emit-only'),
        verbose    = process.argv.includes('--verbose');

    try {
        if (corpusOnly && emitOnly) throw new Error('Choose either --corpus-only or --emit-only.');
        if (corpusOnly) await assertCorpusDestination();
        else await assertSyncGithubWorkflowDevBranch();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    const {default: GH_SyncService} = await import('../../services/github-workflow/SyncService.mjs');

    if (verbose) console.log('Corpus context:', {
        source: `${GH_Config.owner}/${GH_Config.repo}`,
        contentRoot: GH_Config.issueSync.contentRoot
    });

    console.log(corpusOnly ? '🔄 Starting origin-qualified conversation corpus emission...' : emitOnly
        ? '🔄 Starting pull-only GitHub Workflow corpus emission...'
        : '🔄 Starting full GitHub Workflow sync via GH_SyncService.runFullSync()...');

    // Run the full workflow sync under the shared heavy-maintenance lease so this CLI
    // cannot collide with orchestrator maintenance tasks or another manual graph-heavy
    // script. The whole-run guard keeps graph ingestion protected until the sync stages
    // have a narrower concurrency boundary.
    let outcome;
    try {
        outcome = await withHeavyMaintenanceLease(
            async () => corpusOnly
                ? GH_SyncService.emitConversationCorpus()
                : emitOnly
                ? GH_SyncService.emitGeneratedContentAndDerive({pushLocalChanges: false})
                : GH_SyncService.runFullSync(),
            {
                leasePath   : corpusOnly ? GH_Config.issueSync.corpusLeaseFile :
                    resolveHeavyMaintenanceLeasePath({dataDir: AiConfig.orchestrator.dataDir}),
                owner       : 'syncGithubWorkflow',
                reason      : 'manual-cli',
                staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
                metadata    : {corpusOnly, emitOnly, script: 'ai/scripts/maintenance/syncGithubWorkflow.mjs', verbose}
            }
        );
    } catch (e) {
        console.error('❌ Sync failed:', e);
        process.exit(1);
    }

    if (outcome.status === 'held') {
        const held = outcome.lease;
        console.log(`⏸️  Deferred: heavy-maintenance lease held by '${held.owner}' (reason='${held.reason}', pid=${held.pid}, acquiredAt=${held.acquiredAt}).`);
        console.log('   This script will not run while another heavy-maintenance task is active.');
        process.exit(emitOnly || corpusOnly ? 1 : 0);
    }

    console.log(emitOnly || corpusOnly ? '✅ Corpus emission complete:' : '✅ Sync complete:',
        verbose ? JSON.stringify(outcome.result, null, 2) : outcome.result);
    process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    syncGithubWorkflow();
}

export {assertCorpusDestination, assertSyncGithubWorkflowDevBranch, syncGithubWorkflow};
