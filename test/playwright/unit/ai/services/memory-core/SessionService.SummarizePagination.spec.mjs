import {setup} from '../../../../setup.mjs';

const appName = 'SessionServiceSummarizePaginationTest';

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

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * Closed-loop proof for the session-summary re-loop fix: `summarizeSession` must paginate its
 * per-session memory fetch. A single bounded `.get` gathered only the first page, so the written
 * `memoryCount` fell below `findSessionsToSummarize`'s full (paginated) count — the count-equality
 * drift check never reconciled and the session was re-summarized every sweep.
 *
 * This reproduces the whole loop offline with a batch limit of 2 over a 5-turn session: fetch all 5
 * across multiple pages → write `memoryCount: 5` → re-run `findSessionsToSummarize` and confirm the
 * session is no longer selected. Pre-fix the fetch stopped at the first page (`memoryCount: 2`), so
 * the drift selector kept returning the session forever.
 */
test.describe('SessionService.summarizeSession — memory-fetch pagination (closed loop)', () => {
    test.describe.configure({mode: 'serial'});

    let SDK;

    test.beforeAll(async () => {
        SDK = await import('../../../../../../ai/services.mjs');

        if (!SDK.Memory_LifecycleService._initPromise) {
            await SDK.Memory_LifecycleService.initAsync();
        } else {
            await SDK.Memory_LifecycleService.ready();
        }
    });

    test('paginates the fetch, writes the full memoryCount, and the drift selector stops returning the session', async () => {
        const svc          = SDK.Memory_SessionService,
              aiConfig     = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default,
              origMemGet   = svc.memoryCollection.get,
              origModel    = svc.model,
              origSessions = svc.sessionsCollection,
              origLimit    = aiConfig.summarizationBatchLimit;

        // Shrink the per-get batch to 2 so a 5-turn session forces multiple pages. Both summarizeSession
        // (advance-by-actual-page) and findSessionsToSummarize (advance-by-limit) read with THIS limit.
        aiConfig.summarizationBatchLimit = 2;

        const SESSION = 'pg-pagination';

        const ALL = Array.from({length: 5}, (_, i) => ({
            id      : `m${i}`,
            document: `turn ${i}`,
            metadata: {sessionId: SESSION, timestamp: i + 1}
        }));

        const memGetOffsets = [];
        const summaryStore  = [];

        // memoryCollection.get serves BOTH summarizeSession's per-session fetch AND
        // findSessionsToSummarize's full count scan. It RESPECTS the requested limit (real Chroma
        // behavior) — so with limit=2 each page holds 2, and both callers must paginate to see all 5.
        svc.memoryCollection.get = async ({offset = 0, limit} = {}) => {
            memGetOffsets.push(offset);

            const page = ALL.slice(offset, offset + limit);

            return {
                ids      : page.map(r => r.id),
                documents: page.map(r => r.document),
                metadatas: page.map(r => r.metadata)
            };
        };

        // A parseable summary so summarizeSession proceeds past synthesis to the memoryCount write.
        svc.model = {
            generateContent: async () => ({
                response: {
                    text: () => JSON.stringify({
                        summary     : 'mock summary',
                        title       : 'Mock Session',
                        category    : 'test',
                        quality     : 5,
                        productivity: 5,
                        impact      : 5,
                        complexity  : 5,
                        technologies: []
                    })
                }
            })
        };

        // Fake summary collection: upsert captures the written metadata, get replays it (paginated) so
        // findSessionsToSummarize reads the reconciled memoryCount back — no Chroma/embedding needed.
        svc.sessionsCollection = {
            upsert: async ({metadatas}) => { (metadatas || []).forEach(m => summaryStore.push({...m})); },
            get   : async ({offset = 0, limit = 2} = {}) => {
                const page = summaryStore.slice(offset, offset + limit);
                return {ids: page.map((_, i) => `summary_${offset + i}`), metadatas: page};
            }
        };

        try {
            const result = await svc.summarizeSession(SESSION);

            // 1. Fetched all 5 turns across pages of 2 (advance-by-actual, stop on the empty page).
            expect(memGetOffsets).toEqual([0, 2, 4, 5]);

            // 2. Wrote the FULL paginated count, not the first-page undercount — the exact AC the pre-fix
            //    violated (it wrote 2, so the drift never reconciled).
            expect(summaryStore).toHaveLength(1);
            expect(summaryStore[0].memoryCount).toBe(5);
            expect(summaryStore[0].dreamInputRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
            expect(result?.memoryCount).toBe(5);

            // 3. Closed loop: with memoryCount=5 written, the drift selector (count === summaryCount) no
            //    longer returns the session. Pre-fix (memoryCount=2 ≠ 5) it re-selected it every sweep.
            const toSummarize = await svc.findSessionsToSummarize();
            expect(toSummarize).not.toContain(SESSION);
        } finally {
            svc.memoryCollection.get         = origMemGet;
            svc.model                        = origModel;
            svc.sessionsCollection           = origSessions;
            aiConfig.summarizationBatchLimit = origLimit;
        }
    });

    test('#15126: consumes discovery metadata page-locally while preserving candidate semantics', async () => {
        const svc            = SDK.Memory_SessionService,
              aiConfig       = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default,
              batchLimit     = aiConfig.summarizationBatchLimit,
              currentSession = svc.currentSessionId || 'fixture-current',
              origMemGet     = svc.memoryCollection.get,
              origSessions   = svc.sessionsCollection,
              origActiveRead = svc.getExternallyActiveSessionIds,
              origLegacyId   = svc._legacySessionId;

        if (!svc.currentSessionId) {
            svc.currentSessionId = currentSession
        }

        /**
         * Returns metadata proxies that expire when the next page is requested. A consumer that
         * retains full-scan pages and reads them after pagination completes fails deterministically;
         * a page-local aggregator consumes every row before requesting the next page.
         * @param {String} label
         * @param {Object[][]} pages
         * @returns {{get: Function, stats: Object}}
         */
        const createPageLocalFixture = (label, pages) => {
            let activeRows = [], pageIndex = 0;

            const stats = {
                maxPageRows: 0,
                pageCount  : 0,
                totalRows  : 0
            };

            return {
                async get({limit, offset = 0}) {
                    expect(limit).toBe(batchLimit);
                    expect(offset).toBe(pageIndex * batchLimit);

                    activeRows.forEach(row => { row.active = false });

                    const page = pages[pageIndex++] || [];

                    activeRows = page.map(metadata => ({active: true, metadata}));
                    stats.maxPageRows = Math.max(stats.maxPageRows, page.length);
                    stats.pageCount++;
                    stats.totalRows += page.length;

                    return {
                        ids      : page.map((_, index) => `${label}-${offset + index}`),
                        metadatas: activeRows.map(row => new Proxy(row.metadata, {
                            get(target, key, receiver) {
                                if (!row.active) {
                                    throw new Error(`${label} metadata from an expired page was retained`)
                                }

                                return Reflect.get(target, key, receiver)
                            }
                        }))
                    }
                },
                stats
            }
        };

        const
            fullPage      = metadata => Array.from({length: batchLimit}, () => ({...metadata})),
            memoryFixture = createPageLocalFixture('memory', [
                fullPage({sessionId: 'stable',   timestamp: 100}),
                fullPage({sessionId: 'mismatch', timestamp: 200}),
                fullPage({sessionId: 'missing',  timestamp: 300}),
                fullPage({timestamp: 400}),
                [
                    {sessionId: 'stable',   timestamp: 1001},
                    {sessionId: 'mismatch', timestamp: 1002},
                    {sessionId: 'missing',  timestamp: 1003},
                    {sessionId: currentSession, timestamp: 1004},
                    {sessionId: 'external', timestamp: 1005}
                ]
            ]),
            summaryFixture = createPageLocalFixture('summary', [
                [
                    {sessionId: 'stable', memoryCount: batchLimit + 1},
                    {sessionId: 'mismatch', memoryCount: 1},
                    ...Array.from({length: batchLimit - 2}, () => ({}))
                ],
                [{sessionId: 'mismatch', memoryCount: batchLimit}]
            ]);

        svc.memoryCollection.get          = memoryFixture.get;
        svc.sessionsCollection            = {get: summaryFixture.get};
        svc.getExternallyActiveSessionIds = () => new Set(['external']);

        try {
            const candidates = await svc.findSessionsToSummarize({now: Date.now() + 60 * 60 * 1000});

            // Stable is reconciled (2001 === 2001). Mismatch sees the last summary row across
            // pages (2001 !== 2000). Missing has no summary. The current and externally-active
            // sessions stay excluded, and candidate order remains newest-first.
            expect(candidates).toEqual(['missing', 'mismatch']);
            expect(memoryFixture.stats).toEqual({maxPageRows: batchLimit, pageCount: 5, totalRows: batchLimit * 4 + 5});
            expect(summaryFixture.stats).toEqual({maxPageRows: batchLimit, pageCount: 2, totalRows: batchLimit + 1});
        } finally {
            svc.memoryCollection.get          = origMemGet;
            svc.sessionsCollection            = origSessions;
            svc.getExternallyActiveSessionIds = origActiveRead;
            svc._legacySessionId               = origLegacyId
        }
    });

    test('reconstructs a dropped turn-document from split metadata before synthesis (#14211 de-dup read)', async () => {
        const svc        = SDK.Memory_SessionService,
              aiConfig   = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default,
              origMemGet = svc.memoryCollection.get,
              origModel  = svc.model,
              origSess   = svc.sessionsCollection,
              origLimit  = aiConfig.summarizationBatchLimit;

        aiConfig.summarizationBatchLimit = 10;

        const SESSION = 'pg-dropped-doc';

        // A de-duped turn (post-slice-4): the stored Chroma document is DROPPED (null); only the split
        // metadata fields remain. The paging reader must reconstruct it, not feed null context to synthesis.
        const TURN = {
            id      : 'd0',
            metadata: {type: 'agent-interaction', sessionId: SESSION, timestamp: 1, prompt: 'PROMPT-X', thought: 'THOUGHT-Y', response: 'RESPONSE-Z'}
        };

        let synthesisPrompt = null;

        svc.memoryCollection.get = async ({offset = 0, limit} = {}) => {
            const page = offset === 0 ? [TURN] : [];
            return {
                ids      : page.map(r => r.id),
                documents: page.map(() => null),          // ← dropped document
                metadatas: page.map(r => r.metadata)
            };
        };

        svc.model = {
            generateContent: async prompt => {
                synthesisPrompt = prompt;
                return {response: {text: () => JSON.stringify({
                    summary: 's', title: 't', category: 'test', quality: 5, productivity: 5, impact: 5, complexity: 5, technologies: []
                })}};
            }
        };

        svc.sessionsCollection = {upsert: async () => {}, get: async () => ({ids: [], metadatas: []})};

        try {
            await svc.summarizeSession(SESSION);

            // The dropped document was reconstructed from split metadata (via resolveTurnDocumentForRead) and
            // fed to synthesis as the byte-exact canonical turn-document text — NOT null context.
            expect(synthesisPrompt).toContain('User Prompt: PROMPT-X');
            expect(synthesisPrompt).toContain('Agent Thought: THOUGHT-Y');
            expect(synthesisPrompt).toContain('Agent Response: RESPONSE-Z');
        } finally {
            svc.memoryCollection.get         = origMemGet;
            svc.model                        = origModel;
            svc.sessionsCollection           = origSess;
            aiConfig.summarizationBatchLimit = origLimit;
        }
    });

    test('#1395: summarizeSession links DISCUSSED_IN only for qualified neo issues or bare #N in a single-repo neo session', async () => {
        const svc                               = SDK.Memory_SessionService,
              graphSvc                          = SDK.Memory_GraphService,
              {extractSessionDiscussedIssueIds} = await import('../../../../../../ai/services/memory-core/SessionService.mjs'),
              origMemGet                        = svc.memoryCollection.get,
              origModel                         = svc.model,
              origSess                          = svc.sessionsCollection,
              origLink                          = graphSvc.linkNodes;

        // 1. Direct contract checks across all repository-qualification cases:
        //    a) Foreign qualified forms (owner/repo, short alias, URL) never link issue-N, even with bare issue tokens in the same session.
        expect(extractSessionDiscussedIssueIds(
            'Reviewed neomjs/neo-stage#552 and Stage #560; follow-up on #552.',
            'Opened https://github.com/neomjs/neo-stage/issues/552 in /Users/dev/neomjs/neo-stage.'
        )).toEqual([]);

        //    b) Bare issue references without repository context create no edge.
        expect(extractSessionDiscussedIssueIds(
            'Investigated #552 and issue-553 during the review turn.',
            'No repository path or owner/repo qualifier in this turn.'
        )).toEqual([]);

        //    c) Bare issue references in a multi-repository session (neo + neo-stage) stay unlinked; only qualified neo references link.
        expect(extractSessionDiscussedIssueIds(
            'Coordinated neomjs/neo#20150 with neomjs/neo-stage#552 and checked #552.',
            'Cross-repo turn.'
        )).toEqual(['issue-20150']);

        //    d) Qualified neomjs/neo references (and URL form) link issue-N; bare references in a single-repo neo session also link,
        //       while foreign "Stage PR #N" / "Brain PR #N" / "stage #N" phrasings stay unlinked and mark the session multi-repo.
        expect(extractSessionDiscussedIssueIds(
            'Resolved neomjs/neo#552 and verified #553.',
            'Working in /Users/dev/neomjs/neo on https://github.com/neomjs/neo/issues/554.'
        )).toEqual(['issue-552', 'issue-554', 'issue-553']);

        expect(extractSessionDiscussedIssueIds(
            'Approved Stage PR #552 and Brain PR #1393; also reviewed stage #560.',
            'Working in /Users/dev/neomjs/neo on neomjs/neo#20150.'
        )).toEqual(['issue-20150']);

        //    e) Linear-time guard on large alphanumeric runs (mirrors SessionSummaryDegradedFallback's 1.5M-char fixture).
        const startMs     = Date.now(),
              largeResult = extractSessionDiscussedIssueIds('x'.repeat(1_500_000));
        expect(largeResult).toEqual([]);
        expect(Date.now() - startMs).toBeLessThan(1000);

        // 2. Closed-loop summarizeSession integration check on GraphService.linkNodes:
        const discussedEdges = [];
        let   currentTurnDoc = '',
              currentSummary = '';

        svc.memoryCollection.get = async ({offset = 0} = {}) => {
            if (offset > 0) return {ids: [], documents: [], metadatas: []};
            return {
                ids      : ['m-1395'],
                documents: [currentTurnDoc],
                metadatas: [{sessionId: 'sess-1395', timestamp: 1000}]
            };
        };

        svc.model = {
            generateContent: async () => ({
                response: {
                    text: () => JSON.stringify({
                        summary     : currentSummary,
                        title       : 'Repo-qualified issue scent test',
                        category    : 'bugfix',
                        quality     : 90,
                        productivity: 90,
                        impact      : 80,
                        complexity  : 40,
                        technologies: ['neo.mjs']
                    })
                }
            })
        };

        svc.sessionsCollection = {upsert: async () => {}, get: async () => ({ids: [], metadatas: []})};

        graphSvc.linkNodes = (sourceId, targetId, type, weight, properties) => {
            if (type === 'DISCUSSED_IN') {
                discussedEdges.push({sourceId, targetId, type, weight});
            }
            return origLink.call(graphSvc, sourceId, targetId, type, weight, properties);
        };

        try {
            // Case A: Stage session mentioning foreign qualified and bare references -> zero DISCUSSED_IN edges
            discussedEdges.length = 0;
            currentTurnDoc = 'Reviewed https://github.com/neomjs/neo-stage/issues/552 and Stage #552; fixed #552.';
            currentSummary = 'Completed neomjs/neo-stage#552 review and verified #552.';
            await svc.summarizeSession('stage-session-1395');
            expect(discussedEdges).toEqual([]);

            // Case B: Unqualified session mentioning bare references with no repo context -> zero DISCUSSED_IN edges
            discussedEdges.length = 0;
            currentTurnDoc = 'Checked #552 and issue-552 status.';
            currentSummary = 'Checked #552.';
            await svc.summarizeSession('unqualified-session-1395');
            expect(discussedEdges).toEqual([]);

            // Case C: Single-repo neomjs/neo session with qualified and bare references -> links both
            discussedEdges.length = 0;
            currentTurnDoc = 'Working in /Users/dev/neomjs/neo on neomjs/neo#552 and follow-up #553.';
            currentSummary = 'Resolved neomjs/neo#552 and #553.';
            await svc.summarizeSession('neo-session-1395');
            expect(discussedEdges).toEqual([
                {sourceId: 'summary_neo-session-1395', targetId: 'issue-552', type: 'DISCUSSED_IN', weight: 0.8},
                {sourceId: 'summary_neo-session-1395', targetId: 'issue-553', type: 'DISCUSSED_IN', weight: 0.8}
            ]);
        } finally {
            svc.memoryCollection.get = origMemGet;
            svc.model                = origModel;
            svc.sessionsCollection   = origSess;
            graphSvc.linkNodes       = origLink;
        }
    });
});
