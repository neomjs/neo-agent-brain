import {setup} from '../../../../setup.mjs';

const appName = 'QueryRecentTurnsTest';

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

import {test, expect}                           from '@playwright/test';
import Neo                                      from 'neo.mjs/src/Neo.mjs';
import * as core                                from 'neo.mjs/src/core/_export.mjs';
import {execFile}                               from 'node:child_process';
import {promisify}                              from 'node:util';
import {mkdtemp, rm}                            from 'node:fs/promises';
import os                                       from 'node:os';
import path                                     from 'node:path';
import {appendWalMemory, readPendingWalRecords} from '../../../../../../ai/services/memory-core/helpers/memoryWalStore.mjs';
import RequestContextService                    from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';


/**
 * @summary Materialize one deployment sharing policy before canonical config construction in a
 * separate process. Its graph is in memory and its WAL is an exclusively owned temporary fixture.
 * @param {String} policy private or legacy
 * @param {Function} probe Self-contained child control, with no model or plane calls.
 * @returns {Promise<Object>} The child's last-line evidence.
 */
async function runIsolatedRecencySharingProbe(policy, probe) {
    const dir    = await mkdtemp(path.join(os.tmpdir(), 'neo-recency-sharing-741-'));
    const source = [
        "const {setup} = await import('./test/playwright/setup.mjs');",
        "await import('neo.mjs/src/Neo.mjs');",
        "await import('neo.mjs/src/core/_export.mjs');",
        "await import('neo.mjs/src/manager/Instance.mjs');",
        "setup({neoConfig: {unitTestMode: true}, appConfig: {name: 'QueryRecentSharingIsolatedProbe', isMounted: () => true, vnodeInitialising: false}});",
        "await import('./ai/config.template.mjs');",
        "const config = (await import('./ai/mcp/server/memory-core/config.template.mjs')).default;",
        "if (config.storagePaths.graph !== ':memory:' || config.memoryWal.dir !== process.env.NEO_MEMORY_WAL_DIR_TEST) throw new Error('recency probe storage was not isolated');",
        "await (" + probe.toString() + ")();",
        "process.exit(0);"
    ].join('\n');
    try {
        const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
            cwd: process.cwd(),
            env: {...process.env, UNIT_TEST_MODE: 'true', NEO_TEST_CONFIG_TEMPLATES: 'false',
                NEO_MEMORY_SHARING_DEFAULT_POLICY: policy, NEO_MEMORY_WAL_DIR_TEST: dir},
            killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, timeout: 20_000
        });
        return JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
}

/**
 * query_recent_turns recency-recall primitive — falsifier coverage for the graduated design.
 *
 * Test isolation by construction: under UNIT_TEST_MODE the config resolves storagePaths.graph
 * (→ ':memory:') + collections.{memory,session} (→ test-*) to test values — never mutate the
 * shared singleton.
 *
 *   AC6  freshness  — add_memory → immediately query_recent_turns → visible (NO REM cycle).
 *   AC7a isolation  — tenant A writes → tenant B query → A's turns NOT visible (cross-tenant fail-closed).
 *   AC7b no-scope   — no resolvable userId → EMPTY, never a deployment-wide read (the test that
 *                     mechanically prevents the fail-open default — AC7a alone passes even if this path is broken).
 */
test.describe('Neo.ai.services.memory-core.queryRecentTurns', () => {
    test.describe.configure({mode: 'serial'});

    let MemoryService, GraphService, LifecycleService, TextEmbeddingService, StorageRouter, originalGetMemoryCollection, originalEmbedText, memStore, withTimeoutCode, withTimeout, testWalDir, testPlaneId;

    test.beforeAll(async () => {
        const memoryServiceModule = await import('../../../../../../ai/services/memory-core/MemoryService.mjs');
        const config              = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default;
        testWalDir = config.memoryWal.dir;
        testPlaneId = config.plane.id;

        // Read the code off the module rather than repeating the literal: a rename must break this spec
        // instead of leaving it green while the production classifier matches nothing.
        withTimeoutCode      = memoryServiceModule.WITH_TIMEOUT_CODE;
        withTimeout          = memoryServiceModule.withTimeout;
        GraphService         = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MemoryService        = memoryServiceModule.default;
        LifecycleService     = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        TextEmbeddingService = (await import('../../../../../../ai/services/memory-core/TextEmbeddingService.mjs')).default;
        StorageRouter        = (await import('../../../../../../ai/services/memory-core/managers/StorageRouter.mjs')).default;

        // CI unit has no ChromaDB server. The Chroma embed is DEFERRED after the durable WAL append,
        // so a missing Chroma no longer fails addMemory — but the deferred embed and the detail:'full'
        // join still hit the content store. Back it with an in-memory fake so the spec exercises the
        // real addMemory→queryRecentTurns flow without a live Chroma. The recency query reads graph-
        // projected rows plus WAL-pending rows whose graph projection has not caught up yet; content
        // comes from the fake store or, for not-yet-embedded turns, the WAL pending-overlay.
        memStore = new Map();
        originalGetMemoryCollection = StorageRouter.getMemoryCollection;
        StorageRouter.getMemoryCollection = async () => ({
            add: async ({ids = [], metadatas = []} = {}) => { ids.forEach((id, i) => memStore.set(id, metadatas[i] || {})); },
            get: async ({ids = []} = {}) => {
                const found = ids.filter(id => memStore.has(id));
                return {ids: found, metadatas: found.map(id => memStore.get(id))};
            }
        });

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }

        // Offline tests cannot hit a real embedder. Save the original first so afterAll can restore
        // it: an unrestored embedText mock leaks a 4096-length vector into sibling specs sharing the
        // worker (e.g. the retry spec asserting a [0.1, 0.2, 0.3] return), reddening their unit run.
        originalEmbedText              = TextEmbeddingService.embedText;
        TextEmbeddingService.embedText = async () => new Array(4096).fill(0.1);

        // Seed the AgentIdentity nodes the AUTHORED_BY edge + '@me' resolution depend on.
        GraphService.upsertNode({id: '@agent-a', type: 'AgentIdentity', name: 'AgentA', properties: {}});
        GraphService.upsertNode({id: '@agent-b', type: 'AgentIdentity', name: 'AgentB', properties: {}});
    });

    test.afterAll(async () => {
        if (originalGetMemoryCollection) StorageRouter.getMemoryCollection = originalGetMemoryCollection;
        if (originalEmbedText)           TextEmbeddingService.embedText     = originalEmbedText;
        const {cleanupChromaManager} = await import('./util.mjs');
        await cleanupChromaManager();
    });

    test('AC6 freshness: a just-written memory is visible immediately, without a REM cycle', async () => {
        const result = await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () => {
            await MemoryService.addMemory({prompt: 'fresh prompt', response: 'fresh response', thought: 'fresh thought'});
            return MemoryService.queryRecentTurns({agentIdentity: '@me', limit: 1});
        });

        expect(result.count).toBe(1);
        expect(result.turns[0].sessionId).toBeTruthy();
        // No live summarizer in unit → summary falls back to truncated raw (never content-empty).
        expect(result.turns[0].summary).toBeTruthy();
        expect(result.turns[0].summaryFallback).toBe(true);
        // summary projection does not surface raw prompt/thought directly
        expect(result.turns[0].prompt).toBeUndefined();
        expect(result.turns[0].thought).toBeUndefined();
    });

    test('AC7a isolation: tenant B cannot see tenant A\'s recent turns', async () => {
        await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () => {
            await MemoryService.addMemory({prompt: 'A-only prompt', response: 'A-only response', thought: 'A-only thought'});
        });

        const bResult = await RequestContextService.run({userId: 'tenant-b', agentIdentityNodeId: '@agent-b'}, async () =>
            MemoryService.queryRecentTurns({agentIdentity: '@agent-a', limit: 50})
        );

        // Tenant B's userId scope fail-closes — A's tenant-a-tagged rows are invisible even when
        // B explicitly asks for @agent-a's turns.
        expect(bResult.count).toBe(0);
    });

    test('AC7b no-scope fail-closed: no resolvable userId returns EMPTY, not all', async () => {
        // Seed real tenant data so there IS something a fail-open bug could leak.
        await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () => {
            await MemoryService.addMemory({prompt: 'tenant data', response: 'r', thought: 't'});
        });

        // Query with NO request context (no resolvable userId) — must be empty, never deployment-wide.
        const result = await MemoryService.queryRecentTurns({agentIdentity: '@agent-a', limit: 50});

        expect(result.count).toBe(0);
        expect(result.turns).toEqual([]);
    });

    test('detail:full joins Chroma content and the public projection excludes thought', async () => {
        const result = await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () => {
            await MemoryService.addMemory({prompt: 'full prompt', response: 'full response', thought: 'secret thought'});
            return MemoryService.queryRecentTurns({agentIdentity: '@me', limit: 1, detail: 'full', projection: 'public'});
        });

        expect(result.count).toBe(1);
        expect(result.turns[0].prompt).toBe('full prompt');
        expect(result.turns[0].response).toBe('full response');
        // AC5 — public projection must NOT surface the private thought field.
        expect(result.turns[0].thought).toBeUndefined();
    });

    test('AC8 fail-soft: add_memory succeeds and the turn is recallable (raw fallback) when summarization is unavailable', async () => {
        // Unit tests reach no chat-model provider (gemini has no API key) → buildMiniSummary returns
        // null. The write MUST still succeed; the turn MUST still be recallable; and the summary
        // projection falls back to truncated raw so the feed is never content-empty.
        const result = await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () => {
            const write = await MemoryService.addMemory({prompt: 'no-summarizer prompt', response: 'r', thought: 't'});
            expect(write.error).toBeUndefined();
            return MemoryService.queryRecentTurns({agentIdentity: '@me', limit: 1});
        });

        expect(result.count).toBe(1);
        expect(result.turns[0].summary).toBeTruthy();
        expect(result.turns[0].summaryFallback).toBe(true);
    });

    test('RA1 privacy: own-agent private projection includes thought', async () => {
        const result = await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () => {
            await MemoryService.addMemory({prompt: 'own prompt', response: 'own response', thought: 'own secret'});
            return MemoryService.queryRecentTurns({agentIdentity: '@me', limit: 1, detail: 'full', projection: 'private'});
        });

        expect(result.count).toBe(1);
        expect(result.turns[0].thought).toBe('own secret');   // own-agent → private grants thought
    });

    test('RA1 privacy: a peer cannot read another agent\'s thought via private (downgraded to public)', async () => {
        // agent-b writes in tenant-a.
        await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-b'}, async () => {
            await MemoryService.addMemory({prompt: 'b prompt', response: 'b response', thought: 'b secret'});
        });
        // agent-a (same tenant) requests agent-b's turns with private → must be forced to public.
        const result = await RequestContextService.run({userId: 'tenant-a', agentIdentityNodeId: '@agent-a'}, async () =>
            MemoryService.queryRecentTurns({agentIdentity: '@agent-b', limit: 1, detail: 'full', projection: 'private'})
        );

        expect(result.count).toBe(1);
        expect(result.turns[0].response).toBe('b response');   // same-tenant content is visible
        expect(result.turns[0].thought).toBeUndefined();        // but thought NEVER crosses to a non-owner
    });

    test('RA2 cursor: (timestamp,id) pagination disambiguates equal timestamps (no dup, no skip)', async () => {
        // Two AGENT_MEMORY nodes, SAME timestamp, distinct ids, under an isolated identity so other
        // tests' memories can't interfere. miniSummary set → summary projection stays graph-only.
        const ts   = '2026-01-01T00:00:00.000Z';
        const seed = id => GraphService.upsertNode({
            id, type: 'AGENT_MEMORY', name: `Memory: ${ts}`, description: 'cursor test', semanticVectorId: id,
            properties: {agentIdentity: '@agent-cursor', userId: 'tenant-cursor', sessionId: 'cur-sess', timestamp: ts, miniSummary: id}
        });
        seed('mem-cursor-2');   // lexically-greater id → first under ORDER BY (timestamp DESC, id DESC)
        seed('mem-cursor-1');

        const ctx   = {userId: 'tenant-cursor', agentIdentityNodeId: '@agent-cursor'};
        const page1 = await RequestContextService.run(ctx, async () => MemoryService.queryRecentTurns({agentIdentity: '@me', limit: 1}));
        expect(page1.count).toBe(1);
        expect(page1.turns[0].id).toBe('mem-cursor-2');
        expect(page1.nextCursor).toEqual({timestamp: ts, id: 'mem-cursor-2'});

        const page2 = await RequestContextService.run(ctx, async () => MemoryService.queryRecentTurns({agentIdentity: '@me', limit: 1, before: page1.nextCursor}));
        expect(page2.count).toBe(1);
        expect(page2.turns[0].id).toBe('mem-cursor-1');   // the OTHER equal-timestamp turn — no dup, no skip
    });

    test('backfillMiniSummaries summarizes pending rows most-recent-first and preserves tenant metadata', async () => {
        const oldTs = '2099-01-01T00:00:00.000Z';
        const newTs = '2099-01-02T00:00:00.000Z';

        memStore.set('backfill-old', {prompt: 'old prompt', response: 'old response'});
        memStore.set('backfill-new', {prompt: 'new prompt', response: 'new response'});

        GraphService.upsertNode({
            id              : 'backfill-old', type: 'AGENT_MEMORY', name: 'Memory: old', description: 'old',
            semanticVectorId: 'backfill-old',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'backfill', timestamp: oldTs}
        });
        GraphService.upsertNode({
            id              : 'backfill-new', type: 'AGENT_MEMORY', name: 'Memory: new', description: 'new',
            semanticVectorId: 'backfill-new',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'backfill', timestamp: newTs}
        });

        const calls  = [];
        const result = await MemoryService.backfillMiniSummaries({
            limit           : 1,
            buildMiniSummary: async ({prompt}) => {
                calls.push(prompt);
                return `summary:${prompt}`;
            }
        });
        expect(calls).toEqual(['new prompt']);
        expect(result).toEqual({processed: 1, updated: 1, deferred: 0, missingContent: 0, exhausted: 0, runBudgetHit: false, failedInner: 0, failedOuter: 0, failureCauses: {}});

        const row  = GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('backfill-new');
        const data = JSON.parse(row.data);
        expect(data.properties.miniSummary).toBe('summary:new prompt');
        expect(data.properties.userId).toBe('tenant-a');
        expect(data.properties.agentIdentity).toBe('@agent-a');

        const oldRow  = GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('backfill-old');
        const oldData = JSON.parse(oldRow.data);
        expect(oldData.properties.miniSummary).toBeUndefined();
    });

    test('backfillMiniSummaries leaves provider failures retryable without aborting the batch', async () => {
        const ts = '2099-01-03T00:00:00.000Z';

        memStore.set('backfill-failure', {prompt: 'failure prompt', response: 'failure response'});
        GraphService.upsertNode({
            id              : 'backfill-failure', type: 'AGENT_MEMORY', name: 'Memory: failure', description: 'failure',
            semanticVectorId: 'backfill-failure',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'backfill', timestamp: ts}
        });

        const result = await MemoryService.backfillMiniSummaries({
            limit           : 1,
            buildMiniSummary: async () => {
                throw new Error('provider unavailable');
            }
        });
        // failedOuter, not failedInner: this fixture THROWS, so it escapes to the sweep's catch — the
        // same branch the real outer `miniSummaryTimeoutMs` rejection takes. A falsy-returning summarizer
        // would count as failedInner instead, which is the distinction the split exists to make.
        expect(result).toEqual({processed: 1, updated: 0, deferred: 1, missingContent: 0, exhausted: 0, runBudgetHit: false, failedInner: 0, failedOuter: 1, failureCauses: {'provider-error': 1}});

        const row  = GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('backfill-failure');
        const data = JSON.parse(row.data);
        expect(data.properties.miniSummary).toBeUndefined();
    });

    test('failure causes are tallied by what the summarizer reported, never inferred from a branch (#16388)', async () => {
        const ts = Date.now();

        // Three rows, three distinct causes. The point is that all three land on the SAME branch
        // (`failedInner`) and are still told apart — which is exactly what a branch counter cannot do.
        for (const id of ['cause-timeout', 'cause-no-model', 'cause-empty']) {
            memStore.set(id, {prompt: `${id} prompt`, response: `${id} response`});
            GraphService.upsertNode({
                id, type: 'AGENT_MEMORY', name: `Memory: ${id}`, description: id,
                semanticVectorId: id,
                properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'causes', timestamp: ts}
            });
        }

        const result = await MemoryService.backfillMiniSummaries({
            limit           : 50,
            buildMiniSummary: async ({prompt}) => {
                if (prompt.startsWith('cause-timeout')) {
                    return {summary: null, cause: 'timeout-inner'};
                }
                if (prompt.startsWith('cause-no-model')) {
                    return {summary: null, cause: 'no-model'};
                }
                if (prompt.startsWith('cause-empty')) {
                    return {summary: null, cause: 'empty-output'};
                }
                return {summary: null, cause: 'provider-error'};
            }
        });

        expect(result.failureCauses['timeout-inner']).toBe(1);
        expect(result.failureCauses['no-model']).toBe(1);
        expect(result.failureCauses['empty-output']).toBe(1);

        // All three arrived on the falsy branch. A consumer reading `failedInner` as "the inner window
        // is binding" would be wrong for two of the three — which is why the branch cannot carry a
        // timeout verdict and the cause must.
        expect(result.failedInner).toBeGreaterThanOrEqual(3);
        expect(result.failedOuter).toBe(0);
    });

    test('the real buildMiniSummary names each cause at the frame that creates it (#16388)', async () => {
        // The gap this closes: every other cause spec INJECTS a summarizer returning the expected cause
        // string, which proves the sweep's tally and nothing about the producer's vocabulary. These drive
        // the real method — its own `no-model` branch, its own normalization, its own catch — through the
        // `buildModel` seam, so the cause strings come from production code rather than from the fixture.
        const {PROVIDER_TIMEOUT_CODE,
               createTimeoutError} = await import('../../../../../../ai/provider/createTimeoutError.mjs');

        const noModel = await MemoryService.buildMiniSummary({
            prompt: 'p', response: 'r', buildModel: () => null
        });

        expect(noModel).toEqual({summary: null, cause: 'no-model'});

        // The defect Emmy found: whitespace is TRUTHY, so a raw check passed it as usable and it
        // normalized to '' — returned as a success with an empty summary, then tallied `unspecified`.
        const whitespace = await MemoryService.buildMiniSummary({
            prompt    : 'p', response: 'r',
            buildModel: () => ({generateContent: async () => ({response: {text: () => '   \n\t  '}})})
        });

        expect(whitespace).toEqual({summary: null, cause: 'empty-output'});

        const emptyString = await MemoryService.buildMiniSummary({
            prompt    : 'p', response: 'r',
            buildModel: () => ({generateContent: async () => ({response: {text: () => ''}})})
        });

        expect(emptyString.cause).toBe('empty-output');

        // A genuine one-line answer must still succeed, or the three assertions above would also pass
        // against a producer that had stopped summarizing at all.
        let usableOptions;
        const usable = await MemoryService.buildMiniSummary({
            prompt    : 'p', response: 'r',
            buildModel: () => ({generateContent: async (prompt, options) => {
                usableOptions = options;
                return {response: {text: () => '  a real   summary  '}};
            }})
        });

        expect(usable).toEqual({summary: 'a real summary', cause: null});
        expect(usableOptions).toMatchObject({
            operationStage: 'mc-mini-summary',
            priority      : 'batch'
        });

        const providerError = await MemoryService.buildMiniSummary({
            prompt    : 'p', response: 'r',
            buildModel: () => ({generateContent: async () => { throw new Error('upstream exploded') }})
        });

        expect(providerError.cause).toBe('provider-error');

        // timeout-inner reached through a REAL provider timeout object, not a hand-set `.code`: the
        // rejection is built by `createTimeoutError`, one of the three producers the classifier names.
        const providerTimeout = await MemoryService.buildMiniSummary({
            prompt    : 'p', response: 'r',
            buildModel: () => ({
                generateContent: async () => {
                    // `createTimeoutError` sets the code itself, so nothing here is forged.
                    throw createTimeoutError({
                        provider: 'openAiCompatible', operationLabel: 'miniSummary generation', timeoutMs: 1
                    })
                }
            })
        });

        expect(providerTimeout.cause).toBe('timeout-inner');
        expect(providerTimeout.timeoutCode).toBe(PROVIDER_TIMEOUT_CODE);
    });

    test('timeout-outer is reached by a real withTimeout rejection, not a forged code (#16388)', async () => {
        const ts = Date.now();

        memStore.set('cause-real-outer', {prompt: 'real outer prompt', response: 'real outer response'});
        GraphService.upsertNode({
            id              : 'cause-real-outer', type: 'AGENT_MEMORY', name: 'Memory: real outer', description: 'real outer',
            semanticVectorId: 'cause-real-outer',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'real-outer', timestamp: ts}
        });

        // @neo-gpt-emmy falsified my first attempt at this: returning `withTimeout(never, 5, 'spec outer
        // window')` FROM the summarizer times a wrapper the SPEC created, which rejects long before the
        // real outer window — and the classifier then labelled it `timeout-outer` on the code family
        // alone. It passed while proving nothing. The real witness makes backfill's OWN wrapper reject,
        // by bounding its window instead of substituting one.
        const result = await MemoryService.backfillMiniSummaries({
            limit           : 50,
            outerTimeoutMs  : 10,
            buildMiniSummary: () => new Promise(() => {})
        });

        expect(result.failureCauses['timeout-outer']).toBeGreaterThanOrEqual(1);
        expect(result.failureCauses['provider-error']).toBeUndefined();
    });

    test('a nested wrapper timeout that escapes the summarizer is a provider-error, not the outer window (#16388)', async () => {
        const ts = Date.now();

        memStore.set('cause-nested', {prompt: 'nested prompt', response: 'nested response'});
        GraphService.upsertNode({
            id              : 'cause-nested', type: 'AGENT_MEMORY', name: 'Memory: nested', description: 'nested',
            semanticVectorId: 'cause-nested',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'nested', timestamp: ts}
        });

        // The counterexample for the code-family confusion. This rejection is genuinely produced by a real
        // `withTimeout` and genuinely carries WITH_TIMEOUT_CODE — but it is a DIFFERENT wrapper instance,
        // so it escaped the summarizer's guard rather than exhausting this window. Calling it
        // `timeout-outer` would tell a widening consumer to widen a window that was never binding.
        const result = await MemoryService.backfillMiniSummaries({
            limit           : 50,
            outerTimeoutMs  : 5000,
            buildMiniSummary: () => withTimeout(new Promise(() => {}), 5, 'some unrelated nested wrapper')
        });

        expect(result.failureCauses['provider-error']).toBeGreaterThanOrEqual(1);
        expect(result.failureCauses['timeout-outer']).toBeUndefined();
    });

    test('the completion log carries the cause tally on a failing run and omits it when clean (#16388)', async () => {
        const ts       = Date.now(),
              captured = [],
              original = console.error;

        console.error = (...args) => captured.push(args.join(' '));

        try {
            memStore.set('log-clean', {prompt: 'clean prompt', response: 'clean response'});
            GraphService.upsertNode({
                id              : 'log-clean', type: 'AGENT_MEMORY', name: 'Memory: clean', description: 'clean',
                semanticVectorId: 'log-clean',
                properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'log-clean', timestamp: ts}
            });

            await MemoryService.backfillMiniSummaries({
                limit: 50, buildMiniSummary: async () => ({summary: 'ok', cause: null})
            });

            const cleanLine = captured.filter(line => line.includes('backfill complete')).at(-1);

            expect(cleanLine).toBeTruthy();
            expect(cleanLine).not.toContain('causes:');

            memStore.set('log-failed', {prompt: 'failed prompt', response: 'failed response'});
            GraphService.upsertNode({
                id              : 'log-failed', type: 'AGENT_MEMORY', name: 'Memory: failed', description: 'failed',
                semanticVectorId: 'log-failed',
                properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'log-failed', timestamp: ts}
            });

            await MemoryService.backfillMiniSummaries({
                limit: 50, buildMiniSummary: async () => ({summary: null, cause: 'timeout-inner'})
            });

            // The operator-facing half of the contract: on a live plane the starvation is read out of captured
            // stderr, so a cause that only reaches the return value is invisible where it is needed.
            expect(captured.filter(line => line.includes('backfill complete')).at(-1))
                .toContain('[causes: timeout-inner=');
        } finally {
            console.error = original;
        }
    });

    test('a summarizer that reports no cause is recorded as unspecified, never as a plausible one (#16388)', async () => {
        const ts = Date.now();

        memStore.set('cause-legacy', {prompt: 'legacy prompt', response: 'legacy response'});
        GraphService.upsertNode({
            id              : 'cause-legacy', type: 'AGENT_MEMORY', name: 'Memory: legacy', description: 'legacy',
            semanticVectorId: 'cause-legacy',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'legacy', timestamp: ts}
        });

        // The pre-contract shape: a bare null with no cause attached. Guessing `timeout-inner` here
        // would recreate the defect this contract closes — a cause nothing observed — so it must be
        // `unspecified`, which correctly denies any downstream timeout verdict.
        const result = await MemoryService.backfillMiniSummaries({
            limit: 50, buildMiniSummary: async () => null
        });

        expect(result.failureCauses.unspecified).toBeGreaterThanOrEqual(1);
        expect(result.failureCauses['timeout-inner']).toBeUndefined();
    });

    test('an escaped throw is only a timeout when it carries the wrapper code (#16388)', async () => {
        const ts = Date.now();

        memStore.set('cause-thrown', {prompt: 'thrown prompt', response: 'thrown response'});
        GraphService.upsertNode({
            id              : 'cause-thrown', type: 'AGENT_MEMORY', name: 'Memory: thrown', description: 'thrown',
            semanticVectorId: 'cause-thrown',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'thrown', timestamp: ts}
        });

        // A plain throw is a provider error, NOT a timeout — even though it reaches the same catch the
        // outer window's rejection would. Classifying by code rather than by arrival point is what keeps
        // these apart; a message-matching guard would call both timeouts on the wrong day.
        const plain = await MemoryService.backfillMiniSummaries({
            limit: 50, buildMiniSummary: async () => { throw new Error('provider exploded') }
        });

        expect(plain.failureCauses['provider-error']).toBeGreaterThanOrEqual(1);
        expect(plain.failureCauses['timeout-outer']).toBeUndefined();

        // The positive control the negative case above cannot supply: without this, the classifier's true
        // branch is never exercised, so a wrong constant would keep the whole suite green while
        // `timeout-outer` became unreachable — the one cause a window-widening consumer can act on.
        //
        // What the SECOND half asserts changed after review: a forged code alone is deliberately NOT
        // enough any more. Classification requires this window's label too, so a rejection carrying the
        // code family without the label is a provider-error. The real outer witness lives in its own
        // test, where backfill's own wrapper does the rejecting.
        memStore.set('cause-timed-out', {prompt: 'timed out prompt', response: 'timed out response'});
        GraphService.upsertNode({
            id              : 'cause-timed-out', type: 'AGENT_MEMORY', name: 'Memory: timed out', description: 'timed out',
            semanticVectorId: 'cause-timed-out',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'thrown', timestamp: ts}
        });

        const timedOut = await MemoryService.backfillMiniSummaries({
            limit           : 50,
            buildMiniSummary: async () => {
                const error = new Error('miniSummary summarize timed out after 30000ms');

                error.code = withTimeoutCode;
                throw error
            }
        });

        // Same code family, no label from this window: an error, not a window problem.
        expect(timedOut.failureCauses['provider-error']).toBeGreaterThanOrEqual(1);
        expect(timedOut.failureCauses['timeout-outer']).toBeUndefined();
    });

    test('the two failure branches are counted separately, so a branch flip is visible (#16223)', async () => {
        const ts = Date.now();

        // Two rows, one per branch: a falsy return (what the INNER generateMiniSummaryTimeoutMs produces,
        // because buildMiniSummary catches its own timeout) and a throw (what the OUTER miniSummaryTimeoutMs
        // produces, because it wraps summarize() from outside and its rejection escapes).
        for (const id of ['branch-falsy', 'branch-thrown']) {
            memStore.set(id, {prompt: `${id} prompt`, response: `${id} response`});
            GraphService.upsertNode({
                id, type: 'AGENT_MEMORY', name: `Memory: ${id}`, description: id,
                semanticVectorId: id,
                properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'branch-split', timestamp: ts}
            });
        }

        // Deliberately order-independent: earlier tests leave their own pending rows in the shared store,
        // so this cannot assume which rows the sweep selects. Exactly ONE row throws (mine); everything
        // else returns falsy. That pins the split without pinning the population.
        const result = await MemoryService.backfillMiniSummaries({
            limit           : 50,
            buildMiniSummary: async ({prompt}) => {
                if (prompt.startsWith('branch-thrown')) {
                    throw new Error('escaped the inner guard');
                }
                return null;
            }
        });

        // The totals CANNOT tell these apart — both land in `deferred` — which is exactly why the split
        // exists. Widening the inner leaf past the outer one moves every failure from one branch to the
        // other while `deferred` stays put, so a consumer reading only totals sees no change at the moment
        // the failure mode actually changed.
        expect(result.updated).toBe(0);
        expect(result.failedOuter).toBe(1);
        expect(result.failedInner).toBeGreaterThanOrEqual(1);
        expect(result.failedInner + result.failedOuter).toBe(result.deferred + result.exhausted);
    });

    test('backfillMiniSummaries archives a row once the attempt budget is spent, and tallies it (#16313)', async () => {
        const ts = '2099-12-31T23:59:54.000Z';

        memStore.set('budget-exhausted', {prompt: 'p', response: 'r'});
        GraphService.upsertNode({
            id              : 'budget-exhausted', type: 'AGENT_MEMORY', name: 'Memory: budget', description: 'budget',
            semanticVectorId: 'budget-exhausted',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'budget', timestamp: ts}
        });

        const budget      = Neo.config.aiConfig?.memoryService?.miniSummaryMaxAttempts ?? 5;
        const alwaysFails = async () => { throw new Error('provider unavailable'); };
        let last;

        // Sweep repeatedly, as the scheduler does. Each pass records ONE attempt; the row must leave
        // the pending set at the budget instead of being retried forever — the defect is precisely
        // that consecutive passes cannot see each other, so a single-pass assertion cannot catch it.
        for (let pass = 0; pass < budget; pass++) {
            last = await MemoryService.backfillMiniSummaries({limit: 1, buildMiniSummary: alwaysFails});
        }

        expect(last.exhausted).toBe(1);
        expect(last.deferred).toBe(0);

        const data = JSON.parse(GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('budget-exhausted').data);

        expect(data.properties.archivedAt).toBeTruthy();
        expect(data.properties.archivedReason).toBe('generation-timeout');
        expect(data.properties.miniSummaryAttempts).toBe(budget);
        // Reversible, and distinguishable from the no-content exit — a widened window must be able
        // to restore exactly these rows.
        expect(data.properties.archivedReason).not.toBe('no-content');
    });

    test('a THROWN failure counts toward the budget as well (#16313)', async () => {
        // NOT the dominant path — buildMiniSummary catches its own 20s timeout and returns null, so
        // the observed production timeout lands on the falsy branch. This covers what escapes that
        // catch, so neither path can loop; both are pinned rather than assumed equivalent.
        const ts = '2099-12-31T23:59:55.000Z';

        memStore.set('budget-throws', {prompt: 'p', response: 'r'});
        GraphService.upsertNode({
            id              : 'budget-throws', type: 'AGENT_MEMORY', name: 'Memory: throws', description: 'throws',
            semanticVectorId: 'budget-throws',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'budget', timestamp: ts}
        });

        await MemoryService.backfillMiniSummaries({
            limit           : 1,
            buildMiniSummary: async () => { throw new Error('timed out'); }
        });

        const data = JSON.parse(GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('budget-throws').data);

        expect(data.properties.miniSummaryAttempts).toBe(1);

        // Leaves the pending set deliberately, so drop it: a still-pending row with a high timestamp
        // out-sorts later fixtures and silently steals their limited batch.
        GraphService.db.storage.db.prepare('DELETE FROM Nodes WHERE id = ?').run('budget-throws');
    });

    test('a falsy return counts toward the budget too (#16313)', async () => {
        const ts = '2099-12-31T23:59:56.000Z';

        memStore.set('budget-falsy', {prompt: 'p', response: 'r'});
        GraphService.upsertNode({
            id              : 'budget-falsy', type: 'AGENT_MEMORY', name: 'Memory: falsy', description: 'falsy',
            semanticVectorId: 'budget-falsy',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'budget', timestamp: ts}
        });

        await MemoryService.backfillMiniSummaries({limit: 1, buildMiniSummary: async () => null});

        const data = JSON.parse(GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('budget-falsy').data);

        expect(data.properties.miniSummaryAttempts).toBe(1);

        GraphService.db.storage.db.prepare('DELETE FROM Nodes WHERE id = ?').run('budget-falsy');
    });

    test('a successful pass leaves no attempt marker — only failures count (#16313)', async () => {
        const ts = '2099-12-31T23:59:57.000Z';

        memStore.set('budget-ok', {prompt: 'p', response: 'r'});
        GraphService.upsertNode({
            id              : 'budget-ok', type: 'AGENT_MEMORY', name: 'Memory: ok', description: 'ok',
            semanticVectorId: 'budget-ok',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'budget', timestamp: ts}
        });

        await MemoryService.backfillMiniSummaries({limit: 1, buildMiniSummary: async () => 'summary'});

        const data = JSON.parse(GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('budget-ok').data);

        expect(data.properties.miniSummaryAttempts).toBeUndefined();
        expect(data.properties.archivedAt).toBeFalsy();
    });

    test('every exit carries exhausted — including the zero-row and no-SQLite early returns (#16313)', async () => {
        // The Contract Ledger claims `exhausted` is on EVERY exit so no caller sees a shape that
        // sometimes lacks it. Both early returns bypass the tally entirely, so they are the two places
        // that claim could be false — and it WAS false when first published. Pinned as exact objects:
        // `toMatchObject` would pass on a missing key and re-open exactly this gap.
        // Drain first: the pending set is shared fixture state, so an empty one must be CONSTRUCTED,
        // not assumed. Asserting straight away picked up a leftover row from an earlier spec and
        // measured the normal path while claiming to measure the zero-row exit.
        const drain = await MemoryService.backfillMiniSummaries({
            limit           : 500,
            buildMiniSummary: async () => 'drained'
        });

        const zeroRow = await MemoryService.backfillMiniSummaries({
            limit           : 1,
            buildMiniSummary: async () => 'unused'
        });

        // Positive control: the drain did real work, so the zero below is an emptied set rather than a
        // sweep that never ran.
        expect(drain.processed).toBeGreaterThan(0);
        expect(zeroRow).toEqual({processed: 0, updated: 0, deferred: 0, missingContent: 0, exhausted: 0, runBudgetHit: false, failedInner: 0, failedOuter: 0, failureCauses: {}});

        // No-SQLite: the sweep reads `GraphService.db?.storage?.db` once at entry. Swapped rather than
        // mocked so the real guard runs, and restored in a finally so a failure here cannot cascade
        // into every later spec in the file.
        const realDb = GraphService.db;

        try {
            GraphService.db = null;

            const noSqlite = await MemoryService.backfillMiniSummaries({
                limit           : 1,
                buildMiniSummary: async () => 'unused'
            });

            expect(noSqlite).toEqual({processed: 0, updated: 0, deferred: 0, missingContent: 0, exhausted: 0, runBudgetHit: false, failedInner: 0, failedOuter: 0, failureCauses: {}});
        } finally {
            GraphService.db = realDb;
        }

        // Positive control: the restore worked and the suite is not silently running against a dead
        // handle for every subsequent test.
        expect(GraphService.db?.storage?.db).toBeTruthy();
    });

    test('#12671 AC5: private thought never reaches the summarizer, and no public read echoes it (#16313)', async () => {
        // Deterministic echo falsifier. The summarizer returns its ENTIRE input verbatim, so any field
        // the sweep hands it becomes the stored `miniSummary` — which both public shapes return ungated
        // (`_hydrateRecentTurnSummaries` takes no projection, and the full projection emits miniSummary
        // before the `projection === 'private'` gate). If `thought` is ever re-added to the summarizer
        // input, the secret lands in a default/public read and these assertions go red.
        //
        // Asserted at BOTH ends deliberately: the input assertion names the cause, the read assertions
        // name the consequence. Only checking the input would pass if a future path fed `thought` in by
        // another route; only checking the read would not say which field leaked.
        const ts     = '2099-12-31T23:59:58.000Z',
              secret = 'CANARY-THOUGHT-b7f3e1';
        let seen;

        memStore.set('budget-thought', {prompt: 'p', thought: secret, response: 'r'});
        GraphService.upsertNode({
            id              : 'budget-thought', type: 'AGENT_MEMORY', name: 'Memory: thought', description: 'thought',
            semanticVectorId: 'budget-thought',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'budget', timestamp: ts}
        });

        await MemoryService.backfillMiniSummaries({
            limit           : 1,
            buildMiniSummary: async options => { seen = options; return JSON.stringify(options); }
        });

        // Cause: the private field never crosses into the summarizer's input at all.
        expect(seen.thought).toBeUndefined();
        expect(JSON.stringify(seen)).not.toContain(secret);

        // Consequence: a same-tenant PEER reading @agent-a's turns receives the row and it is
        // secret-free. Read as @agent-b inside a bound request context on purpose:
        //   - Without `RequestContextService.run`, `queryRecentTurns` takes its fail-closed no-tenant
        //     exit (an empty result), and `not.toContain` would pass on nothing at all. That is how
        //     the first version of this spec was vacuous — green, and proving only that the reader
        //     returned no rows.
        //   - Reading as a PEER rather than the owner exercises the branch that forces
        //     `projection: 'public'`, which is the boundary the canary is testing.
        const peerCtx     = {userId: 'tenant-a', agentIdentityNodeId: '@agent-b'},
              summaryRead = await RequestContextService.run(peerCtx, async () =>
                  MemoryService.queryRecentTurns({agentIdentity: '@agent-a', detail: 'summary', limit: 50})),
              fullRead    = await RequestContextService.run(peerCtx, async () =>
                  MemoryService.queryRecentTurns({agentIdentity: '@agent-a', detail: 'full', limit: 50}));

        // POSITIVE CONTROL on the read itself — a negative privacy assertion is worthless until the
        // protected row is proven observed. Both reads must actually return `budget-thought`, and its
        // summary must be non-empty, or the `not.toContain` assertions below cannot fail.
        expect(summaryRead.turns.some(turn => turn.id === 'budget-thought')).toBe(true);
        expect(fullRead.turns.some(turn => turn.id === 'budget-thought')).toBe(true);
        expect(summaryRead.turns.find(turn => turn.id === 'budget-thought').summary).toBeTruthy();

        // The peer sees the row, and the row carries no private reasoning.
        expect(JSON.stringify(summaryRead)).not.toContain(secret);
        expect(JSON.stringify(fullRead)).not.toContain(secret);
        expect(fullRead.turns.find(turn => turn.id === 'budget-thought').thought).toBeUndefined();

        // And the fixture genuinely carried a secret, so green means the boundary held rather than the
        // canary never having been written.
        expect(memStore.get('budget-thought').thought).toBe(secret);
    });

    test('backfillMiniSummaries bounds a run by maxRunMs and defers the remainder to the next sweep', async () => {
        // Seed 3 pending rows with the highest timestamps so they sort first under the
        // (timestamp DESC, id DESC) scan and are exactly the rows this limited fetch returns.
        const ids = ['budget-row-a', 'budget-row-b', 'budget-row-c'];
        ids.forEach((id, i) => {
            memStore.set(id, {prompt: `p-${id}`, response: `r-${id}`});
            GraphService.upsertNode({
                id, type: 'AGENT_MEMORY', name: `Memory: ${id}`, description: id, semanticVectorId: id,
                properties: {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'budget', timestamp: `2099-12-31T23:59:5${2 - i}.000Z`}
            });
        });

        // Clock seam advanced by each summarize call: the first row runs while elapsed (0) is under the
        // 100ms budget; that one call pushes elapsed to 1000ms, so the next iteration exits the loop.
        let   fakeNow = 0;
        const calls   = [];
        const result  = await MemoryService.backfillMiniSummaries({
            limit           : 3,
            maxRunMs        : 100,
            now             : () => fakeNow,
            buildMiniSummary: async ({prompt}) => {
                calls.push(prompt);
                fakeNow += 1000;
                return `summary:${prompt}`;
            }
        });

        // Exactly one row processed before the budget bounded the run; the rest deferred to a later sweep.
        expect(result.runBudgetHit).toBe(true);
        expect(result.processed).toBe(1);
        expect(result.updated).toBe(1);
        expect(calls.length).toBe(1);

        // The two unprocessed rows retain no miniSummary, so a subsequent sweep drains them.
        const summarized = ids.filter(id => {
            const seeded = GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get(id);
            return JSON.parse(seeded.data).properties.miniSummary !== undefined;
        });
        expect(summarized.length).toBe(1);
    });

    test('#13638: backfillMiniSummaries splits the batch across fresh + aged ends so the tail converges', async () => {
        // A newest-only (LIFO) fetch starves the aged tail forever. The split takes BOTH ends:
        // freshReserve newest + the remainder oldest. Extreme timestamps make the picks unambiguous
        // against rows left pending by sibling serial tests; the MIDDLE row proves the window is the
        // two ENDS, not a contiguous newest slice.
        const seedRow = (id, ts) => {
            memStore.set(id, {prompt: `p-${id}`, response: `r-${id}`});
            GraphService.upsertNode({
                id, type: 'AGENT_MEMORY', name: id, description: id, semanticVectorId: id,
                properties: {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'split', timestamp: ts}
            });
        };
        seedRow('split-aged',   '2000-01-01T00:00:00.000Z');  // oldest globally → the aged-drain pick
        seedRow('split-middle', '2050-01-01T00:00:00.000Z');  // neither end → left for a later sweep
        seedRow('split-fresh',  '2100-01-01T00:00:00.000Z');  // newest globally → the fresh-reserve pick

        const calls  = [];
        const result = await MemoryService.backfillMiniSummaries({
            limit           : 2, freshReserve: 1,
            buildMiniSummary: async ({prompt}) => { calls.push(prompt); return `summary:${prompt}`; }
        });

        // Both ends summarized in one run; the middle row deliberately untouched.
        expect(result.updated).toBe(2);
        expect(calls.sort()).toEqual(['p-split-aged', 'p-split-fresh']);

        const mid = JSON.parse(GraphService.db.storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('split-middle').data);
        expect(mid.properties.miniSummary).toBeUndefined();
    });

    test('#13566/#13638: backfillMiniSummaries skips rows already archived as un-summarizable', async () => {
        // An archived row keeps miniSummary:NULL; the fetch must exclude it (the scheduler + count
        // already do) so the aged drain does not burn budget re-archiving. Seed it as the NEWEST row,
        // so a green test proves the filter rather than ordering luck.
        memStore.set('arch-live', {prompt: 'live prompt', response: 'live response'});
        GraphService.upsertNode({
            id              : 'arch-archived', type: 'AGENT_MEMORY', name: 'arch-archived', description: 'archived',
            semanticVectorId: 'arch-archived',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'arch',
                         timestamp: '2103-01-01T00:00:00.000Z', archivedAt: '2103-01-02T00:00:00.000Z'}
        });
        GraphService.upsertNode({
            id              : 'arch-live', type: 'AGENT_MEMORY', name: 'arch-live', description: 'live',
            semanticVectorId: 'arch-live',
            properties      : {agentIdentity: '@agent-a', userId: 'tenant-a', sessionId: 'arch',
                         timestamp: '2102-01-01T00:00:00.000Z'}
        });

        const calls = [];
        await MemoryService.backfillMiniSummaries({
            limit           : 1, freshReserve: 1,
            buildMiniSummary: async ({prompt}) => { calls.push(prompt); return `summary:${prompt}`; }
        });

        // The archived row is the newest, yet excluded by the fetch filter; only the live row runs.
        expect(calls).toEqual(['live prompt']);
    });
    test('explicit public-summary sharing admits peer and same-identity foreign-tenant rows without changing recovery', async () => {
        const identity = '@sharing-recovery-741', secret = 'FOREIGN-THOUGHT-741';
        const seed     = (id, userId, timestamp) => {
            memStore.set(id, {prompt: 'public prompt', response: 'public response',
                thought: userId === 'sharing-caller' ? 'OWN-THOUGHT-741' : secret});
            GraphService.upsertNode({id, type: 'AGENT_MEMORY', name: id, description: id, semanticVectorId: id,
                properties: {agentIdentity: identity, userId, sessionId: 'sharing-recovery-741', timestamp, miniSummary: id}});
        };
        seed('sharing-own-741', 'sharing-caller', '2031-01-01T00:00:00.000Z');
        seed('sharing-foreign-741', 'sharing-other', '2031-01-02T00:00:00.000Z');
        const read = options => RequestContextService.run({userId: 'sharing-caller', agentIdentityNodeId: identity}, () =>
            MemoryService.queryRecentTurns({agentIdentity: identity, limit: 10, ...options}));
        const recovery = await read({});
        expect(recovery.turns.map(turn => turn.id)).toEqual(['sharing-own-741']);
        const ownPrivate = await read({detail: 'full', projection: 'private'});
        expect(ownPrivate.turns.map(turn => turn.id)).toEqual(['sharing-own-741']);
        expect(ownPrivate.turns[0].thought).toBe('OWN-THOUGHT-741');
        expect(JSON.stringify(ownPrivate)).not.toContain(secret);
        const shared = await read({memorySharing: 'team'});
        expect(shared.turns.map(turn => turn.id)).toEqual(['sharing-foreign-741', 'sharing-own-741']);
        expect(shared.memorySharing).toEqual({policy: 'team', clamped: false});
        expect(JSON.stringify(shared)).not.toContain(secret);
        expect(shared.turns.every(turn => turn.prompt === undefined && turn.response === undefined && turn.thought === undefined)).toBe(true);
    });

    test('a widened full/private request refuses before SQL, WAL or content reads', async () => {
        const sqlite  = GraphService.db.storage.db, prepare = sqlite.prepare;
        const pending = MemoryService._readPendingWalRecencyRows, hydrate = MemoryService._hydrateRecentTurnSummaries;
        const calls   = {sql: 0, wal: 0, content: 0};
        sqlite.prepare = function(...args) { calls.sql++; return prepare.apply(this, args) };
        MemoryService._readPendingWalRecencyRows = async () => { calls.wal++; return [] };
        MemoryService._hydrateRecentTurnSummaries = async () => { calls.content++; return [] };
        try {
            for (const memorySharing of ['team', 'legacy']) {
                for (const options of [{detail: 'full'}, {projection: 'private'}]) {
                    const result = await RequestContextService.run({userId: 'sharing-caller', agentIdentityNodeId: '@sharing-caller'}, () =>
                        MemoryService.queryRecentTurns({agentIdentity: '@sharing-peer', memorySharing, ...options}));
                    expect(result).toMatchObject({code: 'RECENT_TURNS_ERROR'});
                    expect(result.message).toContain('public summaries');
                }
            }
            expect(calls).toEqual({sql: 0, wal: 0, content: 0});
        } finally {
            sqlite.prepare = prepare;
            MemoryService._readPendingWalRecencyRows = pending;
            MemoryService._hydrateRecentTurnSummaries = hydrate;
        }
    });

    test('legacy ownership is filtered before graph pagination, including shared and untagged rows', async () => {
        const {SHARED_USER_ID} = await import('../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs');
        const identity         = '@sharing-legacy-741';
        const seed             = (id, userId, day) => GraphService.upsertNode({
            id, type: 'AGENT_MEMORY', name: id, description: id, semanticVectorId: id,
            properties: {agentIdentity: identity, ...(userId === undefined ? {} : {userId}), sessionId: 'sharing-legacy-741',
                timestamp: '2032-01-0'+day+'T00:00:00.000Z', miniSummary: id}
        });
        seed('legacy-denied-741', 'other', 4);
        seed('legacy-shared-741', SHARED_USER_ID, 3);
        seed('legacy-own-741', 'sharing-caller', 2);
        seed('legacy-untagged-741', undefined, 1);
        const read = before => RequestContextService.run({userId: 'sharing-caller', agentIdentityNodeId: '@sharing-caller'}, () =>
            MemoryService.queryRecentTurns({agentIdentity: identity, memorySharing: 'legacy', limit: 1, before}));
        const first = await read();
        expect(first.turns.map(turn => turn.id)).toEqual(['legacy-shared-741']);
        const second = await read(first.nextCursor);
        expect(second.turns.map(turn => turn.id)).toEqual(['legacy-own-741']);
        const third = await read(second.nextCursor);
        expect(third.turns.map(turn => turn.id)).toEqual(['legacy-untagged-741']);
        expect((await read(third.nextCursor)).count).toBe(0);
    });

    test('the registered schema admits explicit sharing while omitted input retains the recovery default', async () => {
        const {fileURLToPath}          = await import('node:url');
        const {makeSafe, safeLoadYaml} = await import('../../../../../../ai/services/shared/serviceProxy.mjs');
        const spec                     = safeLoadYaml(fileURLToPath(new URL('../../../../../../ai/mcp/server/memory-core/openapi.yaml', import.meta.url)));
        const parameter                = spec.paths['/memories/recent'].get.parameters.find(entry => entry.name === 'memorySharing');
        expect(parameter.schema.enum).toEqual(['private', 'team', 'legacy']);
        expect(parameter.schema.default).toBeUndefined();
        GraphService.upsertNode({id: 'operation-foreign-741', type: 'AGENT_MEMORY', name: 'operation', description: 'operation',
            semanticVectorId: 'operation-foreign-741', properties: {agentIdentity: '@operation-peer-741', userId: 'operation-other',
                sessionId: 'operation-741', timestamp: '2037-01-01T00:00:00.000Z', miniSummary: 'operation public summary'}});
        const operation = makeSafe(MemoryService, spec);
        const result    = await RequestContextService.run({userId: 'sharing-caller', agentIdentityNodeId: '@sharing-caller'}, () =>
            operation.queryRecentTurns({agentIdentity: '@operation-peer-741', memorySharing: 'team'}));
        expect(result.turns.some(turn => turn.id === 'operation-foreign-741')).toBe(true);
        expect(result.memorySharing).toEqual({policy: 'team', clamped: false});
    });

    test('configured private and legacy policies clamp explicit sharing across graph and real pending WAL before the page bound', async () => {
        test.setTimeout(60_000);
        const probe = async () => {
            const config                                   = (await import('./ai/mcp/server/memory-core/config.template.mjs')).default;
            const {default: Context, SHARED_USER_ID}       = await import('./ai/mcp/server/shared/services/RequestContextService.mjs');
            const Graph                                    = (await import('./ai/services/memory-core/GraphService.mjs')).default;
            const Memory                                   = (await import('./ai/services/memory-core/MemoryService.mjs')).default;
            const Storage                                  = (await import('./ai/services/memory-core/managers/StorageRouter.mjs')).default;
            const Lifecycle                                = (await import('./ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
            const {appendWalMemory, readPendingWalRecords} = await import('./ai/services/memory-core/helpers/memoryWalStore.mjs');
            Storage.getMemoryCollection = async () => ({get: async () => ({ids: [], metadatas: []})});
            await Lifecycle.initAsync();
            const identity  = '@policy-subject-741', caller = 'policy-caller-741';
            const graphRows = [
                ['graph-own', caller, 1], ['graph-shared', SHARED_USER_ID, 2],
                ['graph-untagged', undefined, 3], ['graph-blank', '', 4],
                ['graph-false', false, 5], ['graph-zero', 0, 6],
                ['graph-foreign', 'foreign-741', 14], ['graph-alias', '@' + SHARED_USER_ID, 15]
            ];
            for (const [id, userId, second] of graphRows) Graph.upsertNode({
                id, type: 'AGENT_MEMORY', name: id, description: id, semanticVectorId: id,
                properties: {agentIdentity: identity, ...(userId === undefined ? {} : {userId}),
                    sessionId: 'policy-741', timestamp: new Date(Date.UTC(2034, 0, 1, 0, 0, second)).toISOString(), miniSummary: id}
            });
            const walRows = [
                ['wal-own', caller, 7], ['wal-shared', SHARED_USER_ID, 8],
                ['wal-untagged', undefined, 9], ['wal-blank', '', 10],
                ['wal-false', false, 11], ['wal-zero', 0, 12],
                ['wal-foreign', 'foreign-741', 16], ['wal-alias', '@' + SHARED_USER_ID, 17]
            ];
            for (const [id, userId, second] of walRows) {
                const timestamp = Date.UTC(2034, 0, 1, 0, 0, second);
                await appendWalMemory({id, timestamp, graphProjectionVersion: 1, document: id,
                    metadata: {agentIdentity: identity, ...(userId === undefined ? {} : {userId}),
                        sessionId: 'policy-741', timestamp, miniSummary: id, prompt: 'public', response: 'public',
                        thought  : 'POLICY-PRIVATE-CANARY-741'}}, {dir: config.memoryWal.dir, planeId: config.plane.id});
            }
            const read = options => Context.run({userId: caller, agentIdentityNodeId: '@policy-caller-741'}, () =>
                Memory.queryRecentTurns({agentIdentity: identity, limit: 30, ...options}));
            const recovery = await read({});
            const clamped  = await read({memorySharing: 'team'});
            const first    = await read({memorySharing: 'team', limit: 1});
            const narrowed = await read({memorySharing: 'private'});
            const pending  = await readPendingWalRecords({dir: config.memoryWal.dir, markerType: 'graph'});
            console.log(JSON.stringify({configuredPolicy: config.memorySharing.defaultPolicy, graph: config.storagePaths.graph,
                walCount: pending.length, aliasStored: pending.find(row => row.id === 'wal-alias').metadata.userId,
                recovery, clamped, first, narrowed}));
        };
        const own    = ['wal-own', 'graph-own'];
        const legacy = ['wal-zero', 'wal-false', 'wal-blank', 'wal-untagged', 'wal-shared', 'wal-own',
            'graph-zero', 'graph-false', 'graph-blank', 'graph-untagged', 'graph-shared', 'graph-own'];
        for (const policy of ['private', 'legacy']) {
            const result   = await runIsolatedRecencySharingProbe(policy, probe);
            const expected = policy === 'private' ? own : legacy;
            expect(result).toMatchObject({configuredPolicy: policy, graph: ':memory:', walCount: 8});
            const {SHARED_USER_ID} = await import('../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs');
            expect(result.aliasStored).toBe('@' + SHARED_USER_ID);
            expect(result.recovery.turns.map(turn => turn.id)).toEqual(own);
            expect(result.recovery.memorySharing).toBeUndefined();
            expect(result.clamped.memorySharing).toEqual({policy, clamped: true});
            expect(result.clamped.turns.map(turn => turn.id)).toEqual(expected);
            expect(result.clamped.turns.filter(turn => turn.projectionPending).map(turn => turn.id))
                .toEqual(expected.filter(id => id.startsWith('wal-')));
            expect(result.first.turns.map(turn => turn.id)).toEqual([expected[0]]);
            expect(result.narrowed.turns.map(turn => turn.id)).toEqual(own);
            expect(result.narrowed.memorySharing).toEqual({policy: 'private', clamped: false});
            expect(JSON.stringify(result)).not.toContain('POLICY-PRIVATE-CANARY-741');
        }
    });

    test('explicit shared recency takes the newest real pending WAL before bounding, uses public fallback, and fails closed without a tenant', async () => {
        const identity = '@sharing-wal-741', secret = 'WAL-PRIVATE-CANARY-741';
        expect(path.isAbsolute(testWalDir)).toBe(true);
        expect(testWalDir.startsWith(os.tmpdir())).toBe(true);
        GraphService.upsertNode({id: 'sharing-wal-graph', type: 'AGENT_MEMORY', name: 'graph', description: 'graph',
            semanticVectorId: 'sharing-wal-graph', properties: {agentIdentity: identity, userId: 'wal-foreign-741',
                sessionId: 'sharing-wal-741', timestamp: '2035-01-01T00:00:00.000Z', miniSummary: 'older graph summary'}});
        for (const index of [1, 2, 3]) {
            const timestamp = Date.UTC(2035, 0, 1, 0, 0, index);
            await appendWalMemory({id: 'sharing-wal-' + index, timestamp, graphProjectionVersion: 1,
                document: 'stored document includes ' + secret,
                metadata: {agentIdentity: identity, userId: 'wal-foreign-741', sessionId: 'sharing-wal-741', timestamp,
                    prompt: 'public wal prompt ' + index, response: 'public wal response ' + index, thought: secret}},
            {dir: testWalDir, planeId: testPlaneId});
        }
        const pending = await readPendingWalRecords({dir: testWalDir, markerType: 'graph'});
        expect(pending.filter(row => row.metadata.agentIdentity === identity).map(row => row.id))
            .toEqual(['sharing-wal-1', 'sharing-wal-2', 'sharing-wal-3']);
        expect(pending.find(row => row.id === 'sharing-wal-3').metadata.thought).toBe(secret);
        const result = await RequestContextService.run({userId: 'wal-caller-741', agentIdentityNodeId: '@wal-caller-741'}, () =>
            MemoryService.queryRecentTurns({agentIdentity: identity, memorySharing: 'team', limit: 2}));
        expect(result.turns.map(turn => turn.id)).toEqual(['sharing-wal-3', 'sharing-wal-2']);
        expect(result.turns.every(turn => turn.projectionPending && turn.summaryFallback)).toBe(true);
        expect(result.turns[0].summary).toContain('public wal prompt 3');
        expect(result.turns[0].summary).toContain('public wal response 3');
        expect(result.turns[0]).not.toHaveProperty('prompt');
        expect(result.turns[0]).not.toHaveProperty('response');
        expect(result.turns[0]).not.toHaveProperty('thought');
        expect(JSON.stringify(result)).not.toContain(secret);
        const second = await RequestContextService.run({userId: 'wal-caller-741', agentIdentityNodeId: '@wal-caller-741'}, () =>
            MemoryService.queryRecentTurns({agentIdentity: identity, memorySharing: 'team', limit: 2, before: result.nextCursor}));
        expect(second.turns.map(turn => turn.id)).toEqual(['sharing-wal-1', 'sharing-wal-graph']);
        const unbound = await MemoryService.queryRecentTurns({agentIdentity: identity, memorySharing: 'team', limit: 2});
        expect(unbound).toMatchObject({count: 0, turns: [], nextCursor: null, scope: 'fail-closed: no resolvable tenant'});
    });

    test('archived graph and real pending WAL rows and a pending identity tombstone stay outside explicit sharing', async () => {
        const identity = '@sharing-archive-741', archivedAt = '2036-01-04T00:00:00.000Z';
        const read     = agentIdentity => RequestContextService.run({userId: 'archive-caller-741', agentIdentityNodeId: '@archive-caller-741'}, () =>
            MemoryService.queryRecentTurns({agentIdentity, memorySharing: 'team', limit: 10}));
        for (const [id, timestamp, archived] of [
            ['sharing-archive-live', '2036-01-01T00:00:00.000Z', false],
            ['sharing-archive-graph', '2036-01-03T00:00:00.000Z', true]
        ]) GraphService.upsertNode({id, type: 'AGENT_MEMORY', name: id, description: id, semanticVectorId: id,
            properties: {agentIdentity: identity, userId: 'archive-foreign-741', sessionId: 'archive-741',
                timestamp, miniSummary: id, ...(archived ? {archivedAt} : {})}});
        const timestamp = Date.UTC(2036, 0, 4);
        await appendWalMemory({id: 'sharing-archive-wal', timestamp, graphProjectionVersion: 1, document: 'archived',
            metadata: {agentIdentity: identity, userId: 'archive-foreign-741', sessionId: 'archive-741', timestamp,
                miniSummary: 'archived WAL', archivedAt}}, {dir: testWalDir, planeId: testPlaneId});
        const pending = await readPendingWalRecords({dir: testWalDir, markerType: 'graph'});
        expect(pending.some(row => row.id === 'sharing-archive-wal')).toBe(true);
        expect((await read(identity)).turns.map(turn => turn.id)).toEqual(['sharing-archive-live']);
        const tombstoned = '@sharing-tombstone-741';
        await appendWalMemory({id: 'sharing-tombstone-wal', timestamp, graphProjectionVersion: 1, document: 'pending',
            metadata: {agentIdentity: tombstoned, userId: 'archive-foreign-741', sessionId: 'archive-741',
                timestamp, miniSummary: 'pending identity'}}, {dir: testWalDir, planeId: testPlaneId});
        expect((await read(tombstoned)).turns.map(turn => turn.id)).toEqual(['sharing-tombstone-wal']);
        GraphService.upsertGlobalNode({id: 'ARCHIVED_AGENT_IDENTITY:' + tombstoned, type: 'ARCHIVED_AGENT_IDENTITY',
            name: 'Archived identity', description: 'pending archive fixture', properties: {agentIdentity: tombstoned, archivedAt}});
        expect((await read(tombstoned)).turns).toEqual([]);
    });

    test('explicit graph unavailability is an error, while default recovery keeps its empty fallback', async () => {
        const db = GraphService.db;
        try {
            GraphService.db = null;
            const read = options => RequestContextService.run({userId: 'sharing-caller', agentIdentityNodeId: '@sharing-caller'}, () =>
                MemoryService.queryRecentTurns({agentIdentity: '@sharing-peer', ...options}));
            expect(await read({})).toMatchObject({count: 0, turns: [], nextCursor: null});
            const explicit = await read({memorySharing: 'team'});
            expect(explicit).toMatchObject({code: 'RECENT_TURNS_ERROR'});
            expect(explicit.message).toContain('unavailable');
        } finally {
            GraphService.db = db;
        }
    });

    test('an unreadable WAL fails an explicit read instead of claiming an empty shared stream', async () => {
        const fs     = (await import('node:fs/promises')).default;
        const config = (await import('../../../../../../ai/mcp/server/memory-core/config.template.mjs')).default;
        const dir    = config.memoryWal.dir, readdir = fs.readdir;
        fs.readdir = async (...args) => {
            if (args[0] === dir) throw Object.assign(new Error('fixture WAL unreadable'), {code: 'EACCES'});
            return readdir.apply(fs, args);
        };
        try {
            const read = options => RequestContextService.run({userId: 'sharing-caller', agentIdentityNodeId: '@sharing-caller'}, () =>
                MemoryService.queryRecentTurns({agentIdentity: '@availability-wal-741', ...options}));
            const defaultRead = await read({});
            expect(defaultRead.turns.some(turn => turn.id === 'availability-own-741')).toBe(true);
            const shared = await read({memorySharing: 'team'});
            expect(shared).toMatchObject({code: 'RECENT_TURNS_ERROR'});
            expect(shared.message).toContain('WAL unreadable');
            expect(shared.turns).toBeUndefined();
        } finally {
            fs.readdir = readdir;
        }
    });

});
