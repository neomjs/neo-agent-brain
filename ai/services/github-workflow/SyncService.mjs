import aiConfig              from '../../mcp/server/github-workflow/config.mjs';
import Base                  from 'neo.mjs/src/core/Base.mjs';
import logger                from '../../mcp/server/github-workflow/logger.mjs';
import IssueSyncer           from './sync/IssueSyncer.mjs';
import MetadataManager       from './sync/MetadataManager.mjs';
import ReleaseNotesSyncer    from './sync/ReleaseNotesSyncer.mjs';
import DiscussionSyncer      from './sync/DiscussionSyncer.mjs';
import PullRequestSyncer     from './sync/PullRequestSyncer.mjs';
import reconcileActiveChunks from './shared/reconcileActiveChunks.mjs';
import {
    collectWrittenArchiveTargets,
    findLogicalIdentityCollisions,
    formatIntegrityReport,
    snapshotArchiveTree
} from './shared/contentInventory.mjs';

/**
 * @summary Emits one origin's GitHub conversation corpus — issues, pull requests, discussions and
 * release notes — as Markdown into the declared corpus root. The emission is pull-only.
 *
 * This service is the core engine for the GitHub sync workflow. Its primary responsibilities include:
 * - **Orchestration:** It calls the specialized syncers (`ReleaseNotesSyncer`, `IssueSyncer`,
 *   `DiscussionSyncer`, `PullRequestSyncer`) in dependency order, releases first.
 * - **Metadata Management:** It uses the `MetadataManager` to load metadata at the start of a run,
 *   and each facet saves it as that facet completes.
 *
 * The entry point is `emitConversationCorpus`, which the corpus CLI runs under its lease.
 *
 * @class Neo.ai.services.github-workflow.SyncService
 * @extends Neo.core.Base
 * @singleton
 */
class SyncService extends Base {
    static config = {
        /**
         * @member {String} className='Neo.ai.services.github-workflow.SyncService'
         * @protected
         */
        className: 'Neo.ai.services.github-workflow.SyncService',
        /**
         * @member {Boolean} singleton=true
         * @protected
         */
        singleton: true
    }

    /**
     * @summary Emits the generated GitHub Workflow content.
     *
     * Portal indexes and SEO are not derived here: the Portal's deploy derives them from the published
     * corpus. Nothing is written back to GitHub, and nothing is committed: the corpus publisher owns
     * publication.
     *
     * This method orchestrates the emission in a specific order to ensure data integrity.
     *
     * **The facets are ISOLATED and persist independently.** Each runs through `#runFacet`, which saves
     * metadata the moment that facet completes and rolls back only that facet's own slices when it does
     * not. So one facet's failure neither discards the facets before it nor skips the facets after it.
     *
     * Scope note: that is BETWEEN-facet independence only. Within-facet page-level resume — a single
     * facet too large for one pass converging across runs — is deliberately not implemented here.
     *
     * **Isolation is sound only over the dependency graph.** Release history is a PREREQUISITE, not an
     * independent facet: `sortedReleases` is the bucketing reference every closed-artifact planner reads,
     * and an absent reference does not fail — it silently places closed artifacts in the active bucket.
     * The dependent facets are therefore gated, because catching a prerequisite failure and continuing is
     * how a caught error gets mistaken for an independent one.
     *
     * 1. Loads the persistent metadata via `MetadataManager` — one accumulator every facet mutates.
     * 2. Prerequisite `releases`: fetches release data and caches it (`ReleaseNotesSyncer`). Dependent
     *    facets run only if this advanced or a non-empty cached bucketing reference survived.
     * 3. Facet `issues`: reconciles closed issue locations, then **pulls** remote changes, merging the
     *    returned metadata into the accumulator (`IssueSyncer`).
     * 4. Facet `releaseNotes`: syncs release notes into local Markdown (`ReleaseNotesSyncer`).
     * 5. Facet `discussions`: syncs discussions into local Markdown (`DiscussionSyncer`).
     * 6. Facet `pulls`: reconciles closed pull locations, syncs pulls, repairs duplicates, realigns
     *    `_index.json`, and takes the integrity verdict that decides whether the facet advances at all
     *    (`PullRequestSyncer`).
     * 7. Re-chunks every corpus facet to its canonical ordinal-100 layout.
     * 8. Throws one aggregate verdict naming every facet that did not advance — partial progress must
     *    never report as a clean run.
     * @param {Object} [options]
     * @param {Number[]} [options.refetchDiscussions=[]] Discussions the `discussions` facet force-refetches
     * in this run, failing the facet unless each comes back (`DiscussionSyncer#syncDiscussions`).
     * @param {Number[]} [options.refetchIssues=[]] Issues the `issues` facet force-refetches in this run,
     * failing the facet unless each comes back (`IssueSyncer#pullFromGitHub`).
     * @param {Number[]} [options.refetchPulls=[]] Pull requests the `pulls` facet force-refetches in this
     * run, before its integrity verdict, failing the facet unless each comes back (`PullRequestSyncer#syncPullRequests`).
     * @returns {Promise<object>} Statistics for the emitted generated content, plus `facetOutcomes`.
     * @throws {Error} When no corpus root is declared, before any metadata loads or request is made.
     */
    async emitGeneratedContent({refetchDiscussions = [], refetchIssues = [], refetchPulls = []} = {}) {
        if (!aiConfig.issueSync.contentRoot) {
            throw new Error(
                'SyncService#emitGeneratedContent: no GitHub workflow contentRoot is configured ' +
                '(set issueSync.contentRootOverride / NEO_MCP_GITHUB_CONTENT_ROOT).'
            );
        }

        const
            metadata = await MetadataManager.load(),
            outcomes = [],
            facet    = (name, owns, run) => this.#runFacet({metadata, name, outcomes, owns, run}),
            advanced = name => outcomes.some(outcome => outcome.name === name && outcome.advanced),
            // A facet that never RAN is still a facet that did not advance, and it has to appear in the
            // aggregate verdict — otherwise skipping a dependent silently shrinks the denominator and a
            // run that did four of six things reports as clean.
            skip     = (name, reason) => {
                outcomes.push({advanced: false, name, reason});
                logger.error(`[SyncService] facet "${name}" was SKIPPED: ${reason}`)
            };

        // Normalized ONCE, here, instead of coerced with `|| {}` at the save site. `load()` supplies all
        // four on both its paths, but a hand-written metadata file or a stub may not — and then every
        // facet downstream has to defend against `undefined`, which is how the empty-object guarantee
        // gets lost: one site forgets the coercion and a consumer reads `undefined` where the contract
        // promises `{}`. One normalization makes the accumulator's shape an invariant rather than a
        // habit, and it is also what lets `MetadataManager.save` read `metadata.issues` unguarded.
        metadata.discussions ??= {};
        metadata.issues      ??= {};
        metadata.pulls       ??= {};
        metadata.releases    ??= {};

        // 1. Release history is a PREREQUISITE, not an independent facet.
        //
        //    `ReleaseNotesSyncer.sortedReleases` is the bucketing reference for closed issues, pulls and
        //    discussions — its own JSDoc says so. Every one of those planners resolves `closedAt` against
        //    it, and an ABSENT reference does not fail: it resolves to "no release version applies", which
        //    places closed artifacts in the ACTIVE bucket. So a failed release fetch does not merely skip
        //    release notes, it silently mis-buckets the entire corpus — and per-facet persistence would
        //    then write that placement to disk and to metadata.
        //
        //    The old sequential chain was accidentally safe here: a release throw aborted everything
        //    downstream. Isolating the facets REMOVED that implicit guard, which is the trap in treating a
        //    caught failure as an independent one. Caught and independent are different properties, and
        //    isolation is only sound over the dependency graph.
        await facet('releases', ['releases', 'releasesLastFetched'], async () => {
            await ReleaseNotesSyncer.fetchAndCacheReleases(metadata, {needNotes: true});

            // Cached HERE rather than at the end of the chain. These two assignments used to live after
            // every facet had run, so any later throw discarded a fetch that had already succeeded and
            // the next run paid for it again.
            metadata.releases            = ReleaseNotesSyncer.releases;
            metadata.releasesLastFetched = new Date().toISOString()
        });

        // Satisfiable two ways, because a fetch failure is not the same as an absent reference:
        // the facet advanced, OR a non-empty reference survived from the cached fast-path that runs
        // before the network call. An EMPTY array after a SUCCESSFUL fetch is legitimate — a repo with no
        // releases genuinely has nothing to bucket into — which is why this checks the failure case
        // against the reference rather than against emptiness alone.
        const bucketingReady = advanced('releases') ||
            (Array.isArray(ReleaseNotesSyncer.sortedReleases) && ReleaseNotesSyncer.sortedReleases.length > 0);

        // Every facet below places closed artifacts by release, so none of them may run — or persist as
        // advanced — without the reference. Skipping is the safe direction: a facet that did not run leaves
        // its previous high-water mark intact and retries next run, whereas one that ran without the
        // reference writes wrong placements that look like progress.
        const dependentFacet = (name, owns, run) => bucketingReady
            ? facet(name, owns, run)
            : Promise.resolve(skip(name, 'release history unavailable and no cached bucketing reference — ' +
                'closed artifacts would be placed in the active bucket'));

        // 2 + 3. Reconcile closed issue locations (archiving stale closed issues BEFORE the pull), then
        //     pull remote changes. One facet, because the ordering between them is load-bearing:
        //     splitting them would let a run persist a pull whose reconcile never ran.
        let reconcileStats  = null,
            pullStats       = null,
            issueIndexStats = null;

        await dependentFacet('issues', ['issues', 'lastSync'], async () => {
            reconcileStats = await IssueSyncer.reconcileClosedIssueLocations(metadata);

            const {newMetadata, stats} = await IssueSyncer.pullFromGitHub(metadata, {refetchIssues});

            pullStats = stats;

            // MERGED into the accumulator rather than replacing it. `pullFromGitHub` returns a fresh
            // object carrying only `{issues, lastSync}`, and the old chain saved THAT object at the
            // very end — so discussion and pull populations had to be hand-copied back onto it or they
            // were silently dropped. Merging makes the carry-over structural: a syncer that populates
            // a new slice cannot lose it to a save that does not know the slice exists.
            Object.assign(metadata, newMetadata);

            issueIndexStats = await IssueSyncer.reconcileIssueIndex();
        });

        // 5. Sync release notes, in every mode: a reader of the corpus alone has them too. The release
        //    fetch above brought the bodies whenever a note is missing on disk.
        const releaseStats = await dependentFacet('releaseNotes', ['releases'], () => ReleaseNotesSyncer.syncNotes(metadata));

        // 6. Sync discussions
        const discussionStats = await dependentFacet('discussions', ['discussions'], () => DiscussionSyncer.syncDiscussions(metadata, {refetchDiscussions}));

        // 7. The pull facet: reconcile, sync, repair, project, and the integrity verdict that decides
        //    whether any of it counts. All one facet because 7c's abort must revert THIS facet and only
        //    this facet — the whole point of the verdict is that a pull corpus measured broken does not
        //    advance, and the whole point of the isolation is that it no longer takes the other facets
        //    down with it.
        let pullReconcileStats = null,
            pullDuplicateStats = null,
            pullIndexStats     = null,
            pullIntegrity      = null;

        const pullStats2 = await dependentFacet('pulls', ['pulls'], async () => {
            // 7-a. Reconcile closed PULL locations — the sibling reconcile that was missing. The
            //      delta-only pull sync skips PRs untouched since the last cutoff, so old merged PRs
            //      marooned in active pulls/ are never re-bucketed; this per-sync reconcile (mirroring
            //      the issue one) archives them and keeps pulls archived going forward. It ran before
            //      the ISSUE push/pull previously; it belongs with the pull corpus it reconciles, and
            //      what its own rationale requires is only that it precede `syncPullRequests`.
            pullReconcileStats = await PullRequestSyncer.reconcileClosedPullRequestLocations(metadata);

            const stats = await PullRequestSyncer.syncPullRequests(metadata, {refetchPulls});

            // 7-b. Restore any pull request owning more than one artifact from canonical GitHub state.
            //      A divergent pair cannot be resolved locally — both files are real renderings and
            //      nothing on disk says which is current — so neither is trusted and the artifact is
            //      re-derived from the source of truth. Runs BEFORE the index realign so the restored
            //      placement is what gets indexed, and is a no-op on a corpus with no duplicates.
            pullDuplicateStats = await PullRequestSyncer.repairDuplicateArtifacts(metadata);

            // 7-c. Realign `_index.json` with the pull corpus now that placement is final for this run.
            //      Preventing new drift does not remove old drift: entries that went stale when a move
            //      did not carry its upsert name files that are ALREADY archived, so the relocate pass
            //      never revisits them and the delta sync never fetches them — no existing mechanism
            //      could ever have healed them. The index is a projection of the corpus, so this
            //      recomputes it from disk. Idempotent and silent on a healthy corpus (it upserts only
            //      entries that disagree), so the generated-content diff stays empty when nothing drifted.
            pullIndexStats = await PullRequestSyncer.reconcilePullRequestIndex();

            // 7-d. One terminal integrity verdict, CONSUMED. Every pass above reports its own outcome and
            //      degrades softly on its own terms, which is exactly how a corpus reaches the commit with
            //      each step reporting success and the whole known-broken: a repair that fails logs and
            //      returns, an unrepaired duplicate stays unindexed, and nothing downstream asks. So the
            //      verdict is taken AFTER placement, restoration and projection are final, and it aborts
            //      before this facet's metadata save. Publishing a corpus we have already measured as
            //      broken is worse than failing the run: the run can be retried, but a published corpus
            //      is what every consumer then reads as truth.
            //
            //      What ISOLATION changed and did not change: the abort no longer discards the issue,
            //      release and discussion facets that already succeeded. It still prevents this facet
            //      from advancing, so the next run re-fetches exactly these pulls. The `_index.json`
            //      realign above has already touched disk by this point and is not rolled back — that is
            //      acceptable only because it is idempotent by construction (its own note above), and it
            //      is the reason the verdict must stay inside this facet rather than becoming advisory.
            pullIntegrity = await PullRequestSyncer.verifyCorpusIntegrity();

            if (pullDuplicateStats.failed.length > 0 || !pullIntegrity.ok) {
                logger.error(formatIntegrityReport(pullIntegrity));

                throw new Error(
                    'Pull corpus integrity is not clean after repair — refusing to advance the pull facet. ' +
                    `stale=${pullIntegrity.staleIndexEntries.length} ` +
                    `inconsistent=${pullIntegrity.inconsistentIndexEntries.length} ` +
                    `duplicateIndexRows=${pullIntegrity.duplicateIndexEntryIds.length} ` +
                    `unindexed=${pullIntegrity.unindexedIds.length} ` +
                    `divergentDuplicates=${pullIntegrity.divergentDuplicateIds.length} ` +
                    `failedRepairs=${pullDuplicateStats.failed.length}`
                );
            }

            return stats
        });

        // 7.5 Ordinal-100 enforcement: re-rank the full active corpus into exact-100 folders. Position-
        //     dependent chunking drifts whenever the delta sync re-places only the items it touched; this
        //     idempotent pass belongs HERE, with the corpus writer — the emitter leaves the corpus
        //     canonical, so no reader has to repair layout it never wrote. It runs before the verdict
        //     below, so a failed facet does not leave the facets that advanced in a drifted layout. The
        //     `issueSync` block is read at the use site; only its `contentRoot` leaf is consumed.
        await reconcileActiveChunks(aiConfig.issueSync, {repoSlug: aiConfig.repo, type: 'pulls',       filePrefix: 'pr-'});
        await reconcileActiveChunks(aiConfig.issueSync, {repoSlug: aiConfig.repo, type: 'issues',      filePrefix: 'issue-'});
        await reconcileActiveChunks(aiConfig.issueSync, {repoSlug: aiConfig.repo, type: 'discussions', filePrefix: 'discussion-'});

        const failedFacets = outcomes.filter(outcome => !outcome.advanced);

        // 8. One aggregate verdict, AFTER every facet has had its turn.
        //
        //    Partial progress is the point — a corpus too large for one pass must converge across runs
        //    rather than failing whole — but a partial run must never REPORT as a clean one. Exiting 0
        //    here would trade total loss for silent loss: the corpus would look synced while a facet sat
        //    stale, and no consumer could tell. So the progress is partial and the verdict is not.
        if (failedFacets.length > 0) {
            throw new Error(
                `[SyncService] ${failedFacets.length} of ${outcomes.length} sync facets did not advance: ` +
                failedFacets.map(({name, reason}) => `${name} (${reason})`).join('; ') + '. ' +
                'Facets that advanced were persisted as they completed; the failed facets kept their ' +
                'previous high-water marks, so the next run retries exactly those and nothing else.'
            );
        }

        return {
            reconcileStats,
            issueIndexStats,
            pullReconcileStats,
            pullStats,
            releaseStats,
            discussionStats,
            pullStats2,
            pullDuplicateStats,
            pullIndexStats,
            pullIntegrity,
            facetOutcomes: outcomes
        };
    }

    /**
     * @summary Emits one origin-qualified corpus — the conversations and the release notes — without
     * consumer derivation or delivery, and asserts logical identity over the archive files this run wrote.
     *
     * Release history remains the prerequisite for issue, discussion and pull bucketing, and the
     * notes are written beside the conversations, so a reader of the corpus alone has them. Portal/SEO
     * output and git publication stay outside this producer-only boundary.
     * @param {Object} [options] The items to force-refetch in this emission, per facet, for corpus files
     * that drifted from GitHub without an `updatedAt` change.
     * @param {Number[]} [options.refetchDiscussions=[]] Discussion numbers.
     * @param {Number[]} [options.refetchIssues=[]] Issue numbers.
     * @param {Number[]} [options.refetchPulls=[]] Pull-request numbers.
     * @returns {Promise<object>} Facet statistics and truthful aggregate outcome.
     * @throws {Error} When a facet fails to advance or this run writes a logical-identity collision in the archive.
     */
    async emitConversationCorpus({refetchDiscussions = [], refetchIssues = [], refetchPulls = []} = {}) {
        const
            archiveRoot     = aiConfig.issueSync.archiveRoot,
            baselineArchive = snapshotArchiveTree(archiveRoot),
            result          = await this.emitGeneratedContent({refetchDiscussions, refetchIssues, refetchPulls}),
            targets         = collectWrittenArchiveTargets(archiveRoot, baselineArchive),
            collisions      = findLogicalIdentityCollisions({archiveRoot, targets});

        if (collisions.length > 0) {
            throw new Error(
                'Conversation corpus emission rejected: this run wrote two artifacts claiming one logical ' +
                `name — ${collisions.map(item => `${item.key} (${item.paths.length} copies)`).join('; ')}. ` +
                'Publishing this state would hand duplicate logical identities to downstream corpus consumers. ' +
                'Repair via PullRequestSyncer.repairDuplicateArtifacts before retrying.'
            );
        }

        return result;
    }

    /**
     * @summary Runs one sync facet in isolation — persisting its progress the moment it completes, and
     * rolling back only ITS OWN metadata slices when it fails.
     *
     * The chain this replaces was a bare sequential `await` list with a single `MetadataManager.save`
     * at the very end. One facet throwing therefore discarded every facet that had already succeeded
     * AND skipped every facet after it: a deterministic failure in discussions meant pull requests were
     * never fetched at all and the run wrote nothing, so consecutive runs made no progress rather than
     * partial progress. With a deterministic trigger that is not "slowly falling behind" — it is a
     * corpus frozen indefinitely while every individual facet's own code works correctly.
     *
     * Rollback is per-SLICE, not whole-object, because facets mutate the shared accumulator in place.
     * Without restoring its slices, a facet that failed its integrity verdict would still have its
     * partial mutations persisted by the NEXT facet's save — which would make "this facet advanced" and
     * "this facet did not" inseparable claims, and publish exactly the broken corpus the verdict exists
     * to withhold.
     *
     * @param {Object}   args
     * @param {Object}   args.metadata The shared accumulator, mutated in place by the facet.
     * @param {String}   args.name Facet name, used in the log line and the aggregate failure.
     * @param {Object[]} args.outcomes Accumulator for per-facet results.
     * @param {String[]} args.owns The metadata keys this facet may advance; restored verbatim on failure.
     * @param {Function} args.run The facet body.
     * @returns {Promise<*>} The facet's return value, or `null` when it did not advance.
     * @private
     */
    async #runFacet({metadata, name, outcomes, owns, run}) {
        // A Map rather than an object literal so an ABSENT key snapshots as absent instead of being
        // fabricated into `null` — `MetadataManager.save` reads `metadata.issues` unguarded, and a
        // restore that invented a value would be a different bug than the one being prevented.
        const snapshot = new Map(owns.map(key => [key, structuredClone(metadata[key])]));

        try {
            const value = await run();

            await MetadataManager.save(metadata);
            outcomes.push({advanced: true, name});

            return value
        } catch (error) {
            owns.forEach(key => {
                metadata[key] = snapshot.get(key)
            });

            outcomes.push({advanced: false, name, reason: error.message});
            logger.error(`[SyncService] facet "${name}" did not advance; its previous state is kept: ${error.message}`);

            return null
        }
    }

    /**
     * @summary Force-refetches the given issues from GitHub, bypassing delta-sync `updatedAt` gating.
     *
     * The sync engine normally relies on `issue.updatedAt` to decide which issues need a fresh
     * pull. That gate is blind to several classes of drift: `timelineItems` truncation past the
     * page cap, comment deletions (GitHub does not bump `updatedAt` on delete), and
     * relationship events where both sides fall outside the delta window. This endpoint is the
     * surgical recovery primitive — it force-refetches the listed issues, exhausts their full
     * timelineItems connection, rewrites the local markdown, and persists updated metadata.
     *
     * Intended callers: diagnostic scripts such as `ai/scripts/diagnostics/detectTruncatedTimelines.mjs` —
     * not the corpus emission. Keeps the delta-sync cost model intact for routine
     * emissions while giving admin tooling a narrow, auditable healing path.
     *
     * @param {object}   params
     * @param {number[]} params.numbers Issue numbers to force-refetch.
     * @returns {Promise<{refetched: {count: number, issues: number[]}, errors: Array<{issueNumber: number, error: string}>}>}
     */
    async refetchIssuesByNumber({numbers}) {
        if (!Array.isArray(numbers) || numbers.length === 0) {
            return {refetched: {count: 0, issues: []}, errors: []};
        }

        const metadata = await MetadataManager.load();
        const stats    = await IssueSyncer.refetchIssuesByNumber(numbers, metadata);
        await MetadataManager.save(metadata);

        logger.info(`✨ Force-refetch complete: ${stats.refetched.count}/${numbers.length} issues refetched`);

        return stats;
    }

    /**
     * @summary Facade for the standalone pull-request force-refetch (archive-mirror drift healing).
     *
     * Loads metadata, delegates to `PullRequestSyncer.refetchPullsByNumber`, persists the updated
     * metadata. Bypasses the bulk delta-by-`updatedAt` gate so known-stale closed/merged PR mirrors
     * — which the pull-only bulk sync never re-pulls once their `updatedAt` is past the high-water
     * mark — can be re-rendered from current GitHub state. Invoked out-of-band by
     * `ai/scripts/migrations/refetchStalePulls.mjs` — never the corpus emission.
     *
     * @param {object}   params
     * @param {number[]} params.numbers Pull-request numbers to force-refetch.
     * @returns {Promise<{refetched: {count: number, pulls: number[]}, errors: Array<{prNumber: number, error: string}>}>}
     */
    async refetchPullsByNumber({numbers}) {
        if (!Array.isArray(numbers) || numbers.length === 0) {
            return {refetched: {count: 0, pulls: []}, errors: []};
        }

        const metadata = await MetadataManager.load();
        const stats    = await PullRequestSyncer.refetchPullsByNumber(numbers, metadata);
        await MetadataManager.save(metadata);

        logger.info(`✨ Force-refetch complete: ${stats.refetched.count}/${numbers.length} pull requests refetched`);

        return stats;
    }

    /**
     * @summary Facade for the standalone discussion force-refetch (archive-mirror drift healing).
     *
     * Loads metadata, delegates to `DiscussionSyncer.refetchDiscussionsByNumber`, persists the updated
     * metadata. Bypasses the bulk delta-by-`updatedAt` gate so known-stale discussion mirrors — which
     * the pull-only bulk sync never re-pulls once their `updatedAt` is past the high-water mark — can be
     * re-rendered from current GitHub state. Invoked out-of-band by
     * `ai/scripts/migrations/refetchStaleDiscussions.mjs` — never the corpus emission.
     *
     * @param {object}   params
     * @param {number[]} params.numbers Discussion numbers to force-refetch.
     * @returns {Promise<{refetched: {count: number, discussions: number[]}, errors: Array<{discussionNumber: number, error: string}>}>}
     */
    async refetchDiscussionsByNumber({numbers}) {
        if (!Array.isArray(numbers) || numbers.length === 0) {
            return {refetched: {count: 0, discussions: []}, errors: []};
        }

        const metadata = await MetadataManager.load();
        const stats    = await DiscussionSyncer.refetchDiscussionsByNumber(numbers, metadata);
        await MetadataManager.save(metadata);

        logger.info(`✨ Force-refetch complete: ${stats.refetched.count}/${numbers.length} discussions refetched`);

        return stats;
    }

    /**
     * Facade for the one-time archive re-bucket migration. Loads metadata, delegates to
     * `IssueSyncer.migrateArchiveBuckets`, then persists the updated metadata (unless `dryRun`).
     * Invoked out-of-band by `ai/scripts/migrations/rebucketArchive.mjs` — never the regular sync loop.
     * @param {object} [opts]
     * @param {boolean} [opts.dryRun=false] Preview the redistribution without moving files.
     * @returns {Promise<object>} The migration summary from `IssueSyncer.migrateArchiveBuckets`.
     */
    async migrateArchiveBuckets({dryRun = false} = {}) {
        const metadata = await MetadataManager.load();
        const result   = await IssueSyncer.migrateArchiveBuckets(metadata, {dryRun});
        if (!dryRun) await MetadataManager.save(metadata);
        return result;
    }
}

export default Neo.setupClass(SyncService);
