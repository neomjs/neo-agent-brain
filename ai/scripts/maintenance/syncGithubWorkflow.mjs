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

import GH_Config         from '../../mcp/server/github-workflow/config.mjs';
import AiConfig          from '../../config.mjs';
import fs                from 'node:fs/promises';
import path              from 'node:path';
import {validateSegment} from '../../services/github-workflow/shared/contentPath.mjs';

import {withHeavyMaintenanceLease}    from '../../daemons/orchestrator/services/HeavyMaintenanceLeaseService.mjs';
import {fileURLToPath, pathToFileURL} from 'url';

/**
 * @module ai/scripts/maintenance/syncGithubWorkflow
 * @summary CLI for origin-qualified, pull-only corpus emission.
 *
 * The scheduled corpus pipeline (`neomjs/github-content-sync`'s `publish-corpus.yml`) invokes this
 * CLI with `--corpus-only`, the one mode it runs: the three conversation facets and the release notes,
 * emitted into an explicitly declared external corpus root under a corpus-local lease, with no git
 * publication. Without the flag the CLI refuses before any lease or request. No mode derives Portal
 * indexes or SEO: the Portal's deploy derives them from the published corpus. Native Graph projection
 * is absent: the container-plane core-corpus projection owner is its only admitted writer. The
 * long-running emission is absent from the agent MCP surface: clean-slate emission can span
 * ~8.5k issues + ~2.8k PRs + ~165 discussions + ~166 release notes and must stay behind a lease
 * rather than an MCP request timeout.
 *
 * Corpus publishers pin a Brain checkout by immutable commit, run `npm ci` and `npm run prepare`,
 * then invoke this script from that installation. `NEO_MCP_GITHUB_OWNER` and `NEO_MCP_GITHUB_REPO`
 * select the source (defaults: `neomjs` / `neo`); `GH_TOKEN` supplies GitHub read access.
 * `NEO_MCP_GITHUB_CONTENT_ROOT` must name an existing absolute destination outside the runtime.
 * The destination owns shared `_index.json`, `<repo>/{issues,pulls,discussions,archive,release-notes}/...`, and
 * `<repo>/.sync-metadata.json`. Publish all of them in one revision only after exit 0. Any nonzero
 * exit, including partial facet failure or a held lease, forbids publication of that attempt.
 * `.corpus-sync.lock` is transient and must not be published. Progress stays in the destination;
 * the publisher owns cleanup of unsuccessful attempts and serialization across jobs.
 *
 * `--refetch-issues=<n,…>` heals corpus files that drifted from GitHub without an `updatedAt` change,
 * which the delta sync never revisits: the issues facet force-refetches the named numbers of the
 * selected source in the same emission, so they publish with it. Every token must be a positive
 * integer, checked before the emitter loads; a named issue that does not come back fails the run.
 *
 * The emission writes origin-qualified index identities. Bootstrapping an unqualified legacy index
 * requires explicit `NEO_MCP_GITHUB_LEGACY_REPO_SLUG`; the current source is never guessed as owner.
 *
 * The CLI:
 * - avoids an MCP request-timeout ceiling
 * - uses declared `NEO_LOG_LEVEL` for syncer diagnostics; `--verbose` prints context and full results
 * - stays read-only at the GitHub API boundary
 *
 * **SDK boundary exception:** the file header owns the temporary direct-import rationale and its
 * self-expiring test. Neo/core imports preserve namespace bootstrap. There is no sync-on-startup
 * override anymore: that config leaf and its service branch were retired with the exclusive
 * container-plane projection owner.
 *
 * The authority boundary is the regeneratable-cache model: this script exists
 * to rebuild the corpus outside the MCP request-timeout envelope.
 *
 * @example
 *   NEO_MCP_GITHUB_OWNER=neomjs NEO_MCP_GITHUB_REPO=neo \
 *     NEO_MCP_GITHUB_CONTENT_ROOT=/checkout/corpus npm run ai:sync-github-workflow -- --corpus-only
 *   NEO_MCP_GITHUB_CONTENT_ROOT=/checkout/corpus \
 *     npm run ai:sync-github-workflow -- --corpus-only --verbose --refetch-issues=19565,19637
 *
 *   # Full output streamed to stdout/stderr (no MCP timeout ceiling).
 *   # Exit code 0 on success / 1 on failure.
 */

/**
 * @summary Reads `--refetch-issues=<n,…>` into issue numbers, refusing anything but positive integers.
 * @param {String[]} argv CLI arguments.
 * @returns {Number[]} The named issue numbers, deduplicated; empty when the flag is absent.
 * @throws {Error} If the flag repeats, has no `=` value, or holds a token that is not a positive integer.
 */
function parseRefetchIssues(argv) {
    const flags = argv.filter(arg => arg === '--refetch-issues' || arg.startsWith('--refetch-issues='));

    if (flags.length === 0) return [];
    if (flags.length > 1 || flags[0] === '--refetch-issues') {
        throw new Error('--refetch-issues takes one comma-separated list: --refetch-issues=<n,…>.');
    }

    const
        tokens  = flags[0].slice('--refetch-issues='.length).split(','),
        invalid = tokens.find(token => !/^[1-9]\d*$/.test(token) || !Number.isSafeInteger(Number(token)));

    if (invalid !== undefined) {
        throw new Error(`--refetch-issues takes positive issue numbers, not "${invalid}".`);
    }

    return [...new Set(tokens.map(Number))]
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

    const root         = await fs.realpath(GH_Config.issueSync.contentRoot),
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

    for (const key of ['issuesDir', 'discussionsDir', 'pullsDir', 'archiveRoot', 'releaseNotesDir', 'metadataFile']) {
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
 * @summary CLI entry point for scheduled, pull-only corpus emission.
 * @returns {Promise<void>}
 */
async function syncGithubWorkflow() {
    const verbose = process.argv.includes('--verbose');

    let refetchIssues;

    try {
        if (!process.argv.includes('--corpus-only') || process.argv.includes('--emit-only')) {
            throw new Error('syncGithubWorkflow emits the corpus only: run it with --corpus-only. ' +
                'The full sync and --emit-only modes are retired.');
        }
        refetchIssues = parseRefetchIssues(process.argv);
        await assertCorpusDestination();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    const {default: GH_SyncService} = await import('../../services/github-workflow/SyncService.mjs');

    if (verbose) console.log('Corpus context:', {
        source     : `${GH_Config.owner}/${GH_Config.repo}`,
        contentRoot: GH_Config.issueSync.contentRoot,
        ...(refetchIssues.length > 0 && {refetchIssues})
    });

    console.log('🔄 Starting origin-qualified conversation corpus emission...');

    // The corpus-local lease serializes emissions into one destination.
    let outcome;
    try {
        outcome = await withHeavyMaintenanceLease(
            async () => GH_SyncService.emitConversationCorpus({refetchIssues}),
            {
                leasePath   : GH_Config.issueSync.corpusLeaseFile,
                owner       : 'syncGithubWorkflow',
                reason      : 'manual-cli',
                staleAfterMs: AiConfig.orchestrator.heavyMaintenanceLease.staleAfterMs,
                metadata    : {script: 'ai/scripts/maintenance/syncGithubWorkflow.mjs', verbose}
            }
        );
    } catch (e) {
        console.error('❌ Sync failed:', e);
        process.exit(1);
    }

    // A held lease fails the run: any nonzero exit forbids publishing the attempt.
    if (outcome.status === 'held') {
        const held = outcome.lease;
        console.log(`⏸️  Deferred: heavy-maintenance lease held by '${held.owner}' (reason='${held.reason}', pid=${held.pid}, acquiredAt=${held.acquiredAt}).`);
        console.log('   This script will not run while another heavy-maintenance task is active.');
        process.exit(1);
    }

    console.log('✅ Corpus emission complete:', verbose ? JSON.stringify(outcome.result, null, 2) : outcome.result);
    process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    syncGithubWorkflow();
}

export {assertCorpusDestination, parseRefetchIssues, syncGithubWorkflow};
