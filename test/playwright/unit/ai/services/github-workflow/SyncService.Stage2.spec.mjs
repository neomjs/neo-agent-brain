import { setup } from '../../../../setup.mjs';

const appName = 'SyncServiceStage2Test';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}     from '@playwright/test';
import fs                 from 'fs/promises';
import os                 from 'os';
import path               from 'path';
import Neo                from 'neo.mjs/src/Neo.mjs';
import * as core          from 'neo.mjs/src/core/_export.mjs';
import {snapshotAiConfig} from '../../services/memory-core/util.mjs';

test.describe('SyncService — Stage 2 Ingestion', () => {
    test.describe.configure({mode: 'serial'});

    let aiConfig;
    let restoreAiConfig;
    let SyncService;
    let IssueSyncer;
    let ReleaseNotesSyncer;
    let DiscussionSyncer;
    let PullRequestSyncer;
    let GraphqlService;
    let MetadataManager;
    let IssueIngestor;

    let originalReconcileArchived;
    let originalPull;
    let originalReconcileIssueIndex;
    let originalFetchReleases;
    let originalSyncNotes;
    // Captured because the prerequisite witnesses MUTATE it, and it lives on a singleton — an
    // unrestored `sortedReleases` leaks into every later test in this serial file and into any other
    // spec sharing the worker.
    let originalSortedReleases;
    let originalSyncDiscussions;
    let originalSyncPullRequests;
    let originalReconcileClosedPulls;
    let originalRepairPullDuplicates;
    let originalReconcilePullIndex;
    let originalVerifyPullIntegrity;

    let originalIngestIssueStates;
    let originalIngestDiscussionStates;
    let originalIngestPullRequestFeedback;
    let originalLoadMetadata;
    let originalSaveMetadata;

    let stage2Calls = {
        issueStates        : 0,
        discussionStates   : 0,
        pullRequestFeedback: 0
    };

    test.beforeAll(async () => {
        // Pre-load the unified services bundle to ensure correct initialization order
        // and avoid ReferenceErrors from circular dependencies in dynamic imports.
        await import('../../../../../../ai/services.mjs');

        aiConfig           = (await import('../../../../../../ai/mcp/server/github-workflow/config.template.mjs')).default;
        SyncService        = (await import('../../../../../../ai/services/github-workflow/SyncService.mjs')).default;
        IssueSyncer        = (await import('../../../../../../ai/services/github-workflow/sync/IssueSyncer.mjs')).default;
        ReleaseNotesSyncer = (await import('../../../../../../ai/services/github-workflow/sync/ReleaseNotesSyncer.mjs')).default;
        DiscussionSyncer   = (await import('../../../../../../ai/services/github-workflow/sync/DiscussionSyncer.mjs')).default;
        PullRequestSyncer  = (await import('../../../../../../ai/services/github-workflow/sync/PullRequestSyncer.mjs')).default;
        GraphqlService     = (await import('../../../../../../ai/services/github-workflow/GraphqlService.mjs')).default;
        MetadataManager    = (await import('../../../../../../ai/services/github-workflow/sync/MetadataManager.mjs')).default;
        IssueIngestor      = (await import('../../../../../../ai/services/ingestion/IssueIngestor.mjs')).default;
    });

    test.beforeEach(() => {
        stage2Calls = { issueStates: 0, discussionStates: 0, pullRequestFeedback: 0 };

        originalReconcileArchived = IssueSyncer.reconcileClosedIssueLocations;
        originalPull = IssueSyncer.pullFromGitHub;
        originalReconcileIssueIndex = IssueSyncer.reconcileIssueIndex;
        originalFetchReleases = ReleaseNotesSyncer.fetchAndCacheReleases;
        originalSyncNotes = ReleaseNotesSyncer.syncNotes;
        originalSortedReleases = ReleaseNotesSyncer.sortedReleases;
        originalSyncDiscussions = DiscussionSyncer.syncDiscussions;
        originalSyncPullRequests = PullRequestSyncer.syncPullRequests;
        originalReconcileClosedPulls = PullRequestSyncer.reconcileClosedPullRequestLocations;
        originalRepairPullDuplicates = PullRequestSyncer.repairDuplicateArtifacts;
        originalReconcilePullIndex = PullRequestSyncer.reconcilePullRequestIndex;
        originalVerifyPullIntegrity = PullRequestSyncer.verifyCorpusIntegrity;
        originalLoadMetadata = MetadataManager.load;
        originalSaveMetadata = MetadataManager.save;

        IssueSyncer.reconcileClosedIssueLocations = async () => ({ count: 0 });
        IssueSyncer.pullFromGitHub = async (md) => ({ newMetadata: md || { issues: {}, releases: {}, discussions: {}, pullRequests: {} }, stats: { pulled: { count: 0, created: 0, updated: 0, moved: 0 }, dropped: { count: 0 } } });
        IssueSyncer.reconcileIssueIndex = async () => ({ reindexed: 0, unchanged: 0, removed: 0, skippedAmbiguous: [] });
        ReleaseNotesSyncer.fetchAndCacheReleases = async () => {};
        ReleaseNotesSyncer.syncNotes = async () => ({ count: 0 });
        DiscussionSyncer.syncDiscussions = async () => ({ count: 0 });
        PullRequestSyncer.syncPullRequests = async () => ({ count: 0 });
        // These specs exercise Stage-2 SEQUENCING, so every orchestration step is stubbed — otherwise
        // the emission runs the real pass against the configured corpus root. Both pull passes below
        // were previously unstubbed and merely appeared harmless: the relocate pass bails early because
        // `fetchAndCacheReleases` is stubbed to a no-op and it refuses to bucket without releases. That
        // is luck, not isolation — the index reconcile needs no network and would rewrite live entries.
        PullRequestSyncer.reconcileClosedPullRequestLocations = async () => ({ count: 0, pullRequests: [], indexed: 0 });
        PullRequestSyncer.repairDuplicateArtifacts = async () => ({ repaired: [], removed: 0, failed: [] });
        PullRequestSyncer.reconcilePullRequestIndex = async () => ({ reindexed: 0, unchanged: 0, removed: 0, skippedAmbiguous: [] });
        PullRequestSyncer.verifyCorpusIntegrity = async () => ({ ok: true, staleIndexEntries: [], inconsistentIndexEntries: [], duplicateIndexEntryIds: [], unindexedIds: [], identicalDuplicateIds: [], divergentDuplicateIds: [] });
        MetadataManager.load = async () => ({ issues: {}, releases: {}, discussions: {}, pullRequests: {} });
        MetadataManager.save = async () => {};

        originalIngestIssueStates = IssueIngestor.ingestIssueStates;
        originalIngestDiscussionStates = IssueIngestor.ingestDiscussionStates;
        originalIngestPullRequestFeedback = IssueIngestor.ingestPullRequestFeedback;

        IssueIngestor.ingestIssueStates = async () => { stage2Calls.issueStates++; };
        IssueIngestor.ingestDiscussionStates = async () => { stage2Calls.discussionStates++; };
        IssueIngestor.ingestPullRequestFeedback = async () => { stage2Calls.pullRequestFeedback++; };

        // Every arm runs against a declared corpus root, isolated via snapshotAiConfig.
        // The refusal arm below swaps in an undeclared one.
        restoreAiConfig = snapshotAiConfig(aiConfig, {
            'issueSync.contentRootOverride': '/mock/corpus'
        });
    });

    test.afterEach(() => {
        restoreAiConfig?.();
        IssueSyncer.reconcileClosedIssueLocations = originalReconcileArchived;
        IssueSyncer.pullFromGitHub = originalPull;
        IssueSyncer.reconcileIssueIndex = originalReconcileIssueIndex;
        ReleaseNotesSyncer.fetchAndCacheReleases = originalFetchReleases;
        ReleaseNotesSyncer.syncNotes = originalSyncNotes;
        ReleaseNotesSyncer.sortedReleases = originalSortedReleases;
        DiscussionSyncer.syncDiscussions = originalSyncDiscussions;
        PullRequestSyncer.syncPullRequests = originalSyncPullRequests;
        PullRequestSyncer.reconcileClosedPullRequestLocations = originalReconcileClosedPulls;
        PullRequestSyncer.repairDuplicateArtifacts = originalRepairPullDuplicates;
        PullRequestSyncer.reconcilePullRequestIndex = originalReconcilePullIndex;
        PullRequestSyncer.verifyCorpusIntegrity = originalVerifyPullIntegrity;
        MetadataManager.load = originalLoadMetadata;
        MetadataManager.save = originalSaveMetadata;

        IssueIngestor.ingestIssueStates = originalIngestIssueStates;
        IssueIngestor.ingestDiscussionStates = originalIngestDiscussionStates;
        IssueIngestor.ingestPullRequestFeedback = originalIngestPullRequestFeedback;
    });

    test('an undeclared corpus root is refused by name before any metadata loads', async () => {
        let loads = 0;

        snapshotAiConfig(aiConfig, {
            'issueSync.contentRootOverride': null
        });
        MetadataManager.load = async () => { loads++; return {issues: {}, releases: {}, discussions: {}, pulls: {}} };

        await expect(SyncService.emitGeneratedContent()).rejects.toThrow(
            /SyncService#emitGeneratedContent:.*issueSync\.contentRootOverride \/ NEO_MCP_GITHUB_CONTENT_ROOT/
        );
        expect(loads).toBe(0);
    });

    test('an unclean pull-corpus verdict fails the run, and the pull facet does not advance', async () => {
        // Every pass reports its own outcome and degrades softly on its own terms, which is exactly
        // how a corpus reaches publication with each step reporting success and the whole known-broken.
        // The verdict is only worth taking if something consumes it: a published corpus is what every
        // consumer then reads as truth, and unlike a failed run it cannot be retried away.
        //
        // A failure in one facet must not discard the facets that already succeeded, or a deterministic
        // failure anywhere freezes the entire corpus indefinitely. So the protected property is narrow:
        // **the run fails**, so the publisher never publishes it, and **the pull slice does not advance**.
        const savedPulls = [];

        MetadataManager.save = async metadata => {
            savedPulls.push(structuredClone(metadata.pulls ?? null))
        };

        PullRequestSyncer.verifyCorpusIntegrity = async () => ({
            ok                      : false,
            staleIndexEntries       : [{id: 9537}],
            inconsistentIndexEntries: [],
            duplicateIndexEntryIds  : [],
            unindexedIds            : [],
            identicalDuplicateIds   : [],
            divergentDuplicateIds   : [10124]
        });

        await expect(SyncService.emitGeneratedContent()).rejects.toThrow(/integrity is not clean/);

        // The pull facet is the one that failed, so it contributed no save of its own. Any save that did
        // happen came from an earlier facet — which is the point — and none of them may carry pull
        // mutations made after the last good state.
        expect(savedPulls.every(pulls => !pulls || !Object.keys(pulls).length)).toBe(true);
    });

    test('a FAILED duplicate repair fails the run too, even when the verdict is otherwise clean', async () => {
        // The repair reports its failures rather than throwing, so a soft-failed restoration would
        // otherwise sail past a verdict that cannot see it.
        PullRequestSyncer.repairDuplicateArtifacts = async () => ({
            repaired: [], removed: 0, failed: [{id: 10124, reason: 'network down'}]
        });

        await expect(SyncService.emitGeneratedContent()).rejects.toThrow(/integrity is not clean/);
    });

    test('a clean verdict lets the run proceed — the gate can PASS', async () => {
        // Otherwise the two failures above prove only that the emission can throw.
        const result = await SyncService.emitGeneratedContent();

        expect(result.facetOutcomes.every(outcome => outcome.advanced)).toBe(true);
    });

    test('the issues facet reconciles closed issues, then pulls, then reconciles the issue index, and pushes nothing to GitHub', async () => {
        const order = [];

        ReleaseNotesSyncer.sortedReleases = [{tagName: 'v13.0.0', publishedAt: '2026-05-10T00:00:00Z'}];
        IssueSyncer.reconcileClosedIssueLocations = async () => { order.push('reconcile'); return {count: 0} };
        IssueSyncer.pullFromGitHub = async metadata => {
            order.push('pull');
            return {
                newMetadata: metadata,
                stats      : {pulled: {count: 0, created: 0, updated: 0, moved: 0}, dropped: {count: 0}}
            }
        };
        IssueSyncer.reconcileIssueIndex = async () => {
            order.push('reconcileIndex');
            return {reindexed: 0, unchanged: 0, removed: 0, skippedAmbiguous: []}
        };

        const result = await SyncService.emitGeneratedContent();

        expect(order).toEqual(['reconcile', 'pull', 'reconcileIndex']);
        expect(result).not.toHaveProperty('pushStats');
    });

    test('the corpus emits the conversation facets and the release notes, fetching releases with their notes in view', async () => {
        let fetchOptions     = null,
            releaseNoteCalls = 0;

        ReleaseNotesSyncer.sortedReleases = [{tagName: 'v13.0.0', publishedAt: '2026-05-10T00:00:00Z'}];
        ReleaseNotesSyncer.fetchAndCacheReleases = async (metadata, options) => { fetchOptions = options };
        ReleaseNotesSyncer.syncNotes = async () => { releaseNoteCalls++ };

        const result = await SyncService.emitConversationCorpus();

        expect(result.facetOutcomes.map(({name}) => name)).toEqual(['releases', 'issues', 'releaseNotes', 'discussions', 'pulls']);
        expect(fetchOptions).toEqual({needNotes: true});
        expect(releaseNoteCalls).toBe(1);
    });

    test('conversation corpus retains successful facet progress and rejects its failed facet', async () => {
        const saved = [];

        ReleaseNotesSyncer.sortedReleases = [{tagName: 'v13.0.0', publishedAt: '2026-05-10T00:00:00Z'}];
        MetadataManager.save = async metadata => saved.push(structuredClone(metadata));
        DiscussionSyncer.syncDiscussions = async metadata => {
            metadata.discussions[1] = {number: 1, contentHash: 'partial'};
            throw new Error('discussion index write failed');
        };

        await expect(SyncService.emitConversationCorpus()).rejects.toThrow(/discussions \(discussion index write failed\)/);

        expect(saved.some(metadata => metadata.releasesLastFetched)).toBe(true);
        expect(saved.every(metadata => !metadata.discussions[1])).toBe(true);
    });

    test('the emission never invokes Native Graph projection — the container-plane owner is exclusive', async () => {
        const result = await SyncService.emitGeneratedContent();

        expect(result.facetOutcomes.every(outcome => outcome.advanced)).toBe(true);
        expect(stage2Calls.issueStates).toBe(0);
        expect(stage2Calls.discussionStates).toBe(0);
        expect(stage2Calls.pullRequestFeedback).toBe(0);
    });

    /**
     * Regression coverage for metadata persistence carry-over.
     *
     * Empirical bug: `IssueSyncer.pullFromGitHub` returns a FRESH `newMetadata` object
     * carrying only `{issues, lastSync}`. Subsequent calls to
     * `DiscussionSyncer.syncDiscussions(metadata)` and `PullRequestSyncer.syncPullRequests(metadata)`
     * mutate the OLD `metadata` argument's `.discussions` and `.pulls` fields. Without explicit
     * carry-over in `SyncService.emitGeneratedContent`, those mutations were dropped at `save(newMetadata)`,
     * leaving `metadata.discussions = {}` and `metadata.pulls = {}` on disk after every sync.
     *
     * This test mocks the production behavior exactly:
     * - `pullFromGitHub` returns a NEW object (not the same reference as input).
     * - `syncDiscussions` mutates `metadata.discussions[id] = {...}` on its argument.
     * - `syncPullRequests` mutates `metadata.pulls[id] = {...}` on its argument.
     *
     * Asserts that the metadata captured at `save()` retains both syncers' mutations.
     */
    test('the emission carries metadata.discussions + metadata.pulls from per-syncer mutations onto newMetadata before save', async () => {
        let savedMetadata = null;

        // Mock pullFromGitHub returns a FRESH newMetadata, as the real pull does.
        IssueSyncer.pullFromGitHub = async () => ({
            newMetadata: {
                issues  : {42: {state: 'OPEN'}},
                lastSync: '2026-05-18T04:42:00Z'
            },
            stats: {pulled: {count: 0, created: 0, updated: 0, moved: 0}, dropped: {count: 0}}
        });

        // DiscussionSyncer mutates the input `metadata` (matches DiscussionSyncer.mjs:317-340).
        DiscussionSyncer.syncDiscussions = async (md) => {
            md.discussions = md.discussions || {};
            md.discussions[11089] = {
                number     : 11089,
                closed     : false,
                closedAt   : null,
                contentHash: 'hash-11089',
                path       : 'resources/content/discussions/chunk-1/discussion-11089.md'
            };
            md.discussions[5408] = {
                number     : 5408,
                closed     : true,
                closedAt   : '2024-08-03T00:00:00Z',
                contentHash: 'hash-5408',
                path       : 'resources/content/archive/discussions/v8.30.0/chunk-1/discussion-5408.md'
            };
            return {count: 2};
        };

        // PullRequestSyncer mutates the input `metadata` (matches PullRequestSyncer.mjs:333-339).
        PullRequestSyncer.syncPullRequests = async (md) => {
            md.pulls = md.pulls || {};
            md.pulls[10001] = {state: 'OPEN', contentHash: 'hash-pr-10001'};
            return {count: 1};
        };

        // Capture the metadata that lands in save().
        MetadataManager.save = async (md) => {
            savedMetadata = md;
        };

        await SyncService.emitGeneratedContent();

        // Metadata persistence carry-over: both syncers' mutations survived.
        expect(savedMetadata, 'MetadataManager.save received an argument').not.toBeNull();
        expect(savedMetadata.discussions[11089]).toMatchObject({
            number  : 11089,
            closed  : false,
            closedAt: null
        });
        expect(savedMetadata.discussions[5408]).toMatchObject({
            number  : 5408,
            closed  : true,
            closedAt: '2024-08-03T00:00:00Z'
        });
        expect(savedMetadata.pulls[10001]).toMatchObject({state: 'OPEN'});
    });

    /**
     * Regression coverage for explicit empty-input safety.
     *
     * Verifies that when DiscussionSyncer / PullRequestSyncer leave metadata.discussions
     * or metadata.pulls undefined (e.g., early-exit path), the carry-over still produces
     * `{}` rather than `undefined` on `newMetadata`. MetadataManager.save then renders
     * an empty object in the JSON file rather than a missing key.
     */
    test('the emission produces metadata.discussions = {} when syncers leave fields undefined', async () => {
        let savedMetadata = null;

        IssueSyncer.pullFromGitHub = async () => ({
            newMetadata: {issues: {}, lastSync: '2026-05-18T04:42:00Z'},
            stats      : {pulled: {count: 0, created: 0, updated: 0, moved: 0}, dropped: {count: 0}}
        });

        // Syncers don't mutate metadata at all (early-exit path).
        DiscussionSyncer.syncDiscussions = async () => ({count: 0});
        PullRequestSyncer.syncPullRequests = async () => ({count: 0});

        MetadataManager.save = async (md) => { savedMetadata = md; };

        await SyncService.emitGeneratedContent();

        expect(savedMetadata.discussions).toEqual({});
        expect(savedMetadata.pulls).toEqual({});
    });

    /**
     * Facet isolation. The chain was a bare sequential `await` list with one save at the end, so one
     * facet throwing discarded every facet that had already succeeded AND skipped every facet after it.
     * With a deterministic trigger that is not "slowly falling behind" — it is a corpus frozen while
     * each facet's own code works correctly, and it is why two content facets were starved by one fault.
     */
    test('a failing facet does not skip the facets AFTER it', async () => {
        let pullSyncCalled = 0;

        DiscussionSyncer.syncDiscussions = async () => { throw new Error('discussion page cost ceiling') };
        PullRequestSyncer.syncPullRequests = async () => { pullSyncCalled++; return {count: 0} };

        await expect(SyncService.emitGeneratedContent()).rejects.toThrow(/did not advance/);

        // The whole point: pull requests are fetched even though discussions threw first. Before
        // isolation this was 0, and that single fact is why `pulls/` went stale from a discussions bug.
        expect(pullSyncCalled).toBe(1);
    });

    test('a failing facet advances NOTHING while the facets that succeeded are persisted', async () => {
        const saved = [];

        MetadataManager.load = async () => ({
            issues     : {},
            releases   : {},
            discussions: {1: {number: 1, path: 'd-1.md', contentHash: 'PRE-EXISTING'}},
            pulls      : {}
        });
        MetadataManager.save = async md => saved.push(structuredClone(md));

        // The facet mutates the shared accumulator and THEN throws — the ordering that makes per-slice
        // rollback load-bearing. Without it, this half-write is persisted by the next facet's save.
        DiscussionSyncer.syncDiscussions = async md => {
            md.discussions[2] = {number: 2, path: 'd-2.md', contentHash: 'HALF-WRITTEN'};
            throw new Error('failed after mutating')
        };

        await expect(SyncService.emitGeneratedContent()).rejects.toThrow(/did not advance/);

        expect(saved.length).toBeGreaterThan(0);

        // No save anywhere may carry the failed facet's partial mutation, and the pre-existing entry
        // must survive: the failed facet keeps its previous high-water mark rather than losing it.
        saved.forEach((md, index) => {
            expect(Object.keys(md.discussions), `save #${index}`).toEqual(['1']);
            expect(md.discussions[1].contentHash, `save #${index}`).toBe('PRE-EXISTING')
        });
    });

    test('the aggregate verdict NAMES every facet that did not advance', async () => {
        // Partial progress is the point, but a partial run must never report as a clean one — exiting 0
        // would trade total loss for silent loss, where the corpus looks synced while a facet sits stale.
        DiscussionSyncer.syncDiscussions = async () => { throw new Error('cost ceiling') };
        ReleaseNotesSyncer.syncNotes = async () => { throw new Error('release notes boom') };

        const error = await SyncService.emitGeneratedContent().then(() => null, e => e);

        expect(error).toBeTruthy();
        expect(error.message).toMatch(/discussions/);
        expect(error.message).toMatch(/releaseNotes/);
        expect(error.message).toMatch(/cost ceiling/);
        expect(error.message).toMatch(/2 of \d+ sync facets/);
    });

    test('a failed release PREREQUISITE skips the dependent facets instead of mis-bucketing (#16010)', async () => {
        // Release history is not an independent facet. `ReleaseNotesSyncer.sortedReleases` is the bucketing
        // reference every closed-artifact planner reads, and an ABSENT reference does not throw — it
        // resolves to "no release version applies", which places closed artifacts in the ACTIVE bucket. So
        // catching a release failure and continuing does not isolate one facet; it silently mis-buckets the
        // corpus, and per-facet persistence then writes that placement to disk.
        //
        // The old sequential chain was accidentally safe here: a release throw aborted everything after it.
        // Isolation REMOVED that implicit guard, which is the trap this asserts against — caught and
        // independent are different properties.
        const ran = [];

        ReleaseNotesSyncer.fetchAndCacheReleases = async () => { throw new Error('releases endpoint down') };
        ReleaseNotesSyncer.sortedReleases        = null;

        IssueSyncer.pullFromGitHub         = async md => { ran.push('issues');      return {newMetadata: md, stats: {pulled: {count: 0, created: 0, updated: 0, moved: 0}, dropped: {count: 0}}} };
        ReleaseNotesSyncer.syncNotes       = async () => { ran.push('releaseNotes'); return {count: 0} };
        DiscussionSyncer.syncDiscussions   = async () => { ran.push('discussions');  return {count: 0} };
        PullRequestSyncer.syncPullRequests = async () => { ran.push('pulls');        return {count: 0} };

        const error = await SyncService.emitGeneratedContent().then(() => null, e => e);

        // NONE of the dependents may execute without the bucketing reference.
        expect(ran).toEqual([]);

        // And they must be REPORTED, not silently dropped — otherwise skipping shrinks the denominator
        // and a run that did one of six things could read as clean.
        expect(error).toBeTruthy();
        expect(error.message).toMatch(/5 of \d+ sync facets did not advance/);
        for (const name of ['releases', 'issues', 'releaseNotes', 'discussions', 'pulls']) {
            expect(error.message, `${name} must appear in the verdict`).toMatch(new RegExp(name));
        }
    });

    test('a CACHED bucketing reference lets the dependents run even when the fetch fails (#16010)', async () => {
        // The prerequisite is satisfiable two ways, because a fetch failure is not the same as an absent
        // reference: `fetchAndCacheReleases` populates `sortedReleases` from a cached fast-path BEFORE its
        // network call. If that survived, placement is still resolvable and gating the dependents would be
        // a false negative that strands the corpus on a transient outage.
        const ran = [];

        ReleaseNotesSyncer.fetchAndCacheReleases = async () => { throw new Error('releases endpoint down') };
        ReleaseNotesSyncer.sortedReleases        = [{tagName: 'v13.0.0', publishedAt: '2026-05-10T00:00:00Z'}];

        DiscussionSyncer.syncDiscussions   = async () => { ran.push('discussions'); return {count: 0} };
        PullRequestSyncer.syncPullRequests = async () => { ran.push('pulls');       return {count: 0} };

        await expect(SyncService.emitGeneratedContent()).rejects.toThrow(/did not advance/);

        expect(ran).toContain('discussions');
        expect(ran).toContain('pulls');
    });

    test('an integrity abort withholds the PULL facet only — sibling facets still advance', async () => {
        // The narrowed guarantee. A pull corpus measured broken must not advance, and that must no
        // longer take the discussion facet down with it.
        const saved = [];

        MetadataManager.save = async md => saved.push(structuredClone(md));

        DiscussionSyncer.syncDiscussions = async md => {
            md.discussions[7] = {number: 7, path: 'd-7.md', contentHash: 'ADVANCED'};
            return {count: 1}
        };
        PullRequestSyncer.syncPullRequests = async md => {
            md.pulls[9] = {state: 'MERGED', path: 'p-9.md', contentHash: 'SHOULD-NOT-PERSIST'};
            return {count: 1}
        };
        PullRequestSyncer.verifyCorpusIntegrity = async () => ({
            ok                      : false,
            staleIndexEntries       : [{id: 9}],
            inconsistentIndexEntries: [],
            duplicateIndexEntryIds  : [],
            unindexedIds            : [],
            identicalDuplicateIds   : [],
            divergentDuplicateIds   : []
        });

        const error = await SyncService.emitGeneratedContent().then(() => null, e => e),
              last  = saved.at(-1);

        expect(error).toBeTruthy();
        expect(last.discussions[7]?.contentHash).toBe('ADVANCED');
        expect(last.pulls).toEqual({});

        // The rollback assertions above hold even under a whole-run abort, so on their own they witness
        // ROLLBACK rather than ISOLATION. This is the part that separates the two: the failure must be
        // reported through the per-facet accounting, naming `pulls` as the ONLY facet withheld. A
        // re-throwing chain surfaces the bare integrity message with no accounting and fails here.
        expect(error.message).toMatch(/1 of \d+ sync facets did not advance/);
        expect(error.message).toMatch(/pulls \(/);
        expect(error.message).not.toMatch(/discussions \(/);
        expect(error.message).toMatch(/integrity is not clean/);
    });

    test.describe('the corpus emit path enforces one artifact per logical name (#457)', () => {
        let tempRoot;

        const writeOriginArchived = async (relative, body = '# artifact\n') => {
            const absolute = path.join(aiConfig.issueSync.archiveRoot, relative);

            await fs.mkdir(path.dirname(absolute), {recursive: true});
            await fs.writeFile(absolute, body, 'utf8');
            return absolute
        };

        test.beforeEach(async () => {
            tempRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'neo-emit-corpus-'));

            snapshotAiConfig(aiConfig, {
                'issueSync.contentRootOverride': tempRoot
            });
            ReleaseNotesSyncer.sortedReleases = [{tagName: 'v13.0.0', publishedAt: '2026-05-10T00:00:00Z'}]
        });

        test.afterEach(async () => {
            await fs.rm(tempRoot, {force: true, recursive: true})
        });

        test('AC-1: an emit run that writes a second artifact under an existing logical name rejects', async () => {
            await writeOriginArchived('issues/v13.0.0/chunk-1/issue-42.md');

            IssueSyncer.pullFromGitHub = async metadata => {
                await writeOriginArchived('issues/v13.0.0/chunk-2/issue-42.md');
                return {
                    newMetadata: metadata,
                    stats      : {pulled: {count: 1, created: 0, updated: 1, moved: 0}, dropped: {count: 0}}
                }
            };

            await expect(SyncService.emitConversationCorpus())
                .rejects.toThrow(/two artifacts claiming one logical name — issues\/issue-42\.md \(2 copies\)/)
        });

        test('AC-2: a clean emit run passes, and a pre-existing collision outside the files this run wrote passes', async () => {
            await writeOriginArchived('pulls/v13.0.0/chunk-1/pr-100.md');
            await writeOriginArchived('pulls/v13.0.0/chunk-9/pr-100.md');

            IssueSyncer.pullFromGitHub = async metadata => {
                await writeOriginArchived('issues/v13.0.0/chunk-1/issue-200.md');
                return {
                    newMetadata: metadata,
                    stats      : {pulled: {count: 1, created: 1, updated: 0, moved: 0}, dropped: {count: 0}}
                }
            };

            const result = await SyncService.emitConversationCorpus();

            expect(result.facetOutcomes.every(outcome => outcome.advanced)).toBe(true)
        });

        test('AC-3: SyncService no longer imports check-content-logical-identity from neo.mjs and isolates test config via snapshotAiConfig', async () => {
            const source                      = await fs.readFile(path.resolve(process.cwd(), 'ai/services/github-workflow/SyncService.mjs'), 'utf8'),
                  specSource                  = await fs.readFile(path.resolve(process.cwd(), 'test/playwright/unit/ai/services/github-workflow/SyncService.Stage2.spec.mjs'), 'utf8'),
                  {findSharedConfigMutations} = await import('../../../../../../ai/scripts/lint/check-aiconfig-test-mutation.mjs');

            expect(source).not.toMatch(/check-content-logical-identity/);
            expect(findSharedConfigMutations(specSource)).toEqual([]);
            expect('configSnapshot' in SyncService).toBe(false)
        })
    })
});
