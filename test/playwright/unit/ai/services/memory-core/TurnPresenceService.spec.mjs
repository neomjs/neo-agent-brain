import {setup} from '../../../../setup.mjs';

const appName = 'TurnPresenceServiceTest';

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

import {test, expect}         from '@playwright/test';
import Neo                    from 'neo.mjs/src/Neo.mjs';
import * as core              from 'neo.mjs/src/core/_export.mjs';
import RequestContextService  from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import fs                     from 'fs';
import path                   from 'path';
import * as yaml              from 'js-yaml';
import {fileURLToPath}        from 'url';
import {buildOutputZodSchema, buildZodSchema} from '../../../../../../ai/mcp/validation/openApiValidator.mjs';

// Stub Neo.get to keep data-record boot behavior from masking turn-presence coverage.
// The setup regression is outside this spec's delivery contract.
if (!Neo.get) Neo.get = () => null;

// The tool's DECLARED output schema (memory-core openapi.yaml), built with the SAME validator the MCP
// server applies to structured content (`buildOutputZodSchema` — the locus of the client-side -32602).
// A prior version of this spec validated a hand-written response shape, never the declared schema, so a
// buggy `terminalState: null` on `start` passed CI while the live tool errored. Parsing every action's
// real response against this schema is the drift guard that catches that class of divergence.
const repoRoot                 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
      memoryCoreOpenApi        = yaml.load(fs.readFileSync(path.join(repoRoot, 'ai/mcp/server/memory-core/openapi.yaml'), 'utf8')),
      recordTurnPresenceOp     = Object.values(memoryCoreOpenApi.paths['/turn-presence/record']).find(op => op?.operationId === 'record_turn_presence'),
      turnPresenceOutputSchema = buildOutputZodSchema(memoryCoreOpenApi, recordTurnPresenceOp);

/**
 * @summary Unit coverage for the turn-started presence writer substrate.
 *
 * The writer is deliberately independent from wake-route process presence and completed-turn
 * memory writes. It records an active interval at turn start, refreshes it during long turns, and
 * terminalizes it when a lifecycle terminal proof such as `add_memory` succeeds.
 */
let MEMORY_ACCEPTED_MESSAGE;

test.describe('Neo.ai.services.memory-core.TurnPresenceService', () => {
    test.describe.configure({mode: 'serial'});

    let GraphService, LifecycleService, MemoryService, StorageRouter, TextEmbeddingService, TurnPresenceService,
        originalGetMemoryCollection, originalEmbedText, originalBuildMiniSummary, originalSchedule, originalAutoSave;

    const ctx = {userId: 'agent-turn', agentIdentityNodeId: '@agent-turn'};

    test.beforeAll(async () => {
        GraphService         = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        LifecycleService     = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        ({default: MemoryService, MEMORY_ACCEPTED_MESSAGE} =
            await import('../../../../../../ai/services/memory-core/MemoryService.mjs'));
        StorageRouter        = (await import('../../../../../../ai/services/memory-core/managers/StorageRouter.mjs')).default;
        TextEmbeddingService = (await import('../../../../../../ai/services/memory-core/TextEmbeddingService.mjs')).default;
        TurnPresenceService  = (await import('../../../../../../ai/services/memory-core/TurnPresenceService.mjs')).default;

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }

        originalAutoSave                 = GraphService.db.autoSave;
        GraphService.db.autoSave         = true;
        originalGetMemoryCollection      = StorageRouter.getMemoryCollection;
        originalEmbedText                = TextEmbeddingService.embedText;
        originalBuildMiniSummary         = MemoryService.buildMiniSummary;
        originalSchedule                 = MemoryService._scheduleMemoryGraphProjection;
        StorageRouter.getMemoryCollection = async () => ({
            add: async () => {},
            get: async () => ({ids: [], metadatas: []})
        });
        TextEmbeddingService.embedText        = async () => new Array(4096).fill(0.1);
        MemoryService.buildMiniSummary        = async () => null;
        MemoryService._scheduleMemoryGraphProjection = () => {};
    });

    test.afterAll(async () => {
        StorageRouter.getMemoryCollection       = originalGetMemoryCollection;
        TextEmbeddingService.embedText          = originalEmbedText;
        MemoryService.buildMiniSummary          = originalBuildMiniSummary;
        MemoryService._scheduleMemoryGraphProjection = originalSchedule;
        GraphService.db.autoSave                = originalAutoSave;

        const {cleanupChromaManager} = await import('./util.mjs');
        await cleanupChromaManager();
    });

    test.beforeEach(async () => {
        if (GraphService.db) {
            GraphService.db.nodes.clear();
            GraphService.db.edges.clear();
            GraphService.db.vicinityLoadedNodes.clear();

            if (GraphService.db.storage?.db) {
                await GraphService.db.storage.clear();
                GraphService.db.storage.db.exec('DELETE FROM GraphLog');
            }
        }

        GraphService.upsertNode({id: '@agent-turn', type: 'AgentIdentity', name: 'Agent Turn', properties: {}});
    });

    const asAgent = fn => RequestContextService.run(ctx, fn);
    const getNode = turnId => GraphService.db.nodes.get(`AGENT_TURN_PRESENCE:@agent-turn:${turnId}`);

    test('records a bounded active turn interval at start', async () => {
        const result = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'turn-start',
            source: 'spec',
            now   : '2026-06-19T00:00:00.000Z'
        }));

        expect(result.status).toBe('recorded');
        expect(result.turnId).toBe('turn-start');
        expect(result.startedAt).toBe('2026-06-19T00:00:00.000Z');
        expect(result.lastProgressAt).toBe('2026-06-19T00:00:00.000Z');
        expect(result.freshUntil).toBe('2026-06-19T00:30:00.000Z');
        expect(result.expiresAt).toBe('2026-06-19T01:00:00.000Z');
        expect(result.terminalState).toBeUndefined();
        expect(result.status).toBe('recorded');

        const node = getNode('turn-start');
        expect(node.label).toBe('AGENT_TURN_PRESENCE');
        expect(node.properties.status).toBe('active');
        expect(node.properties.source).toBe('spec');
    });

    test('getFreshTurnPresence vouches the beacon horizons verbatim; a legacy horizonless row vouches null', async () => {
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'turn-horizons',
            source: 'spec',
            now   : '2026-06-19T00:00:00.000Z'
        }));

        const beacon = await asAgent(() => TurnPresenceService.getFreshTurnPresence('@agent-turn', '2026-06-19T00:10:00.000Z'));

        expect(beacon.turnId).toBe('turn-horizons');
        expect(beacon.fresh).toBe(true);
        // the horizons are vouched VERBATIM from the beacon the service itself wrote — a banded
        // consumer (active-turn / fresh / recent / dark) grades recency from these without
        // minting a second clock authority; the derived boolean keeps its own contract beside them
        expect(beacon.freshUntil).toBe('2026-06-19T00:30:00.000Z');
        expect(beacon.expiresAt).toBe('2026-06-19T01:00:00.000Z');

        // a legacy beacon written before the horizons existed: vouched as null, never a
        // fabricated timestamp — and still discoverable (an expiresAt-less row stays active to
        // the finder by design, so the fail-honest path is exercised on the REAL query)
        GraphService.upsertNode({
            id        : 'AGENT_TURN_PRESENCE:@agent-turn:turn-legacy',
            type      : 'AGENT_TURN_PRESENCE',
            name      : 'legacy beacon',
            properties: {
                agentIdentity : '@agent-turn',
                lastProgressAt: '2026-06-19T00:20:00.000Z',
                startedAt     : '2026-06-19T00:20:00.000Z',
                status        : 'active',
                turnId        : 'turn-legacy'
            }
        });

        const legacy = await asAgent(() => TurnPresenceService.getFreshTurnPresence('@agent-turn', '2026-06-19T00:21:00.000Z'));

        expect(legacy.turnId).toBe('turn-legacy');   // newest by lastProgressAt wins
        expect(legacy.fresh).toBe(false);            // no freshUntil can never read fresh
        expect(legacy.freshUntil).toBeNull();
        expect(legacy.expiresAt).toBeNull()
    });

    test('the liveness read is the finder\'s one row: no second, owner-scoped read (#1400)', async () => {
        await asAgent(() => TurnPresenceService.recordTurnPresence({action: 'start', turnId: 'turn-one-read', now: '2026-06-19T00:00:00.000Z'}));

        const getNodeRecord = GraphService.getNodeRecord;
        let   scopedReads   = 0;
        GraphService.getNodeRecord = (...args) => (scopedReads++, getNodeRecord.apply(GraphService, args));

        try {
            // no request context: a roster reader is not the beacon's owner, and the read must not need to be
            const beacon = TurnPresenceService.getFreshTurnPresence('@agent-turn', '2026-06-19T00:10:00.000Z');

            expect(beacon).toMatchObject({turnId: 'turn-one-read', fresh: true, freshUntil: '2026-06-19T00:30:00.000Z'});
            expect(scopedReads).toBe(0)
        } finally {
            GraphService.getNodeRecord = getNodeRecord
        }
    });

    test('refreshes progress without changing startedAt', async () => {
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'turn-progress',
            now   : '2026-06-19T00:00:00.000Z'
        }));

        const result = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'progress',
            turnId: 'turn-progress',
            now   : '2026-06-19T00:10:00.000Z'
        }));

        expect(result.startedAt).toBe('2026-06-19T00:00:00.000Z');
        expect(result.lastProgressAt).toBe('2026-06-19T00:10:00.000Z');
        expect(result.freshUntil).toBe('2026-06-19T00:40:00.000Z');
        expect(result.expiresAt).toBe('2026-06-19T01:10:00.000Z');
        expect(getNode('turn-progress').properties.status).toBe('active');
    });

    test('terminal update without turnId closes the newest active interval', async () => {
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'older-turn',
            now   : '2026-06-19T00:00:00.000Z'
        }));
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'newer-turn',
            now   : '2026-06-19T00:05:00.000Z'
        }));

        const result = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action       : 'terminal',
            terminalState: 'blocked',
            source       : 'blocked-task-state',
            now          : '2026-06-19T00:06:00.000Z'
        }));

        expect(result.turnId).toBe('newer-turn');
        expect(result.terminalState).toBe('blocked');
        expect(result.source).toBe('blocked-task-state');
        expect(getNode('newer-turn').properties.status).toBe('terminal');
        expect(getNode('older-turn').properties.status).toBe('active');
    });

    test('terminal update returns noop when no active turn exists', async () => {
        const result = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action       : 'terminal',
            terminalState: 'completed',
            now          : '2026-06-19T00:00:00.000Z'
        }));

        expect(result).toEqual({
            status       : 'noop',
            reason       : 'no-active-turn',
            action       : 'terminal',
            agentIdentity: '@agent-turn'
        });
    });

    test('a start landing after its turn completed opens a fresh active interval: the caller must deliver start first', async () => {
        // Why a harness keeps the start hook in the prompt's path (the Claude manifest does): completion finds
        // no interval to close, and the late start then opens one that reads fresh for a finished turn.
        const completed = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action       : 'terminal',
            terminalState: 'completed',
            now          : '2026-06-19T00:00:00.500Z'
        }));

        await asAgent(() => TurnPresenceService.recordTurnPresence({action: 'start', now: '2026-06-19T00:00:01.000Z'}));

        const presence = await asAgent(() => TurnPresenceService.getFreshTurnPresence('@agent-turn', '2026-06-19T00:00:01.100Z'));

        expect(completed.status).toBe('noop');
        expect(presence?.fresh).toBe(true)
    });

    test('progress without turnId joins the newest active interval instead of refusing', async () => {
        // A harness hook reaching this over MCP holds no turn id — it stopped querying a database to get
        // one. Requiring the id from a client that cannot know it is precisely what pushed the hook into
        // opening the store directly, so this widening is what removes the incentive for that bypass.
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'hookless-older',
            now   : '2026-06-19T02:00:00.000Z'
        }));
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'hookless-newer',
            now   : '2026-06-19T02:05:00.000Z'
        }));

        const result = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'progress',
            source: 'claude-post-tool-use',
            now   : '2026-06-19T02:06:00.000Z'
        }));

        expect(result.turnId).toBe('hookless-newer');
        expect(result.startedAt).toBe('2026-06-19T02:05:00.000Z');
        expect(result.lastProgressAt).toBe('2026-06-19T02:06:00.000Z');
        // It must JOIN an interval, never mint a second one for the same turn.
        expect(getNode('hookless-older').properties.lastProgressAt).toBe('2026-06-19T02:00:00.000Z');
    });

    test('progress with no open interval is a no-op, not an error', async () => {
        const result = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'progress',
            now   : '2026-06-19T03:00:00.000Z'
        }));

        // The turn it would refresh has already expired or closed. Refusing the call would turn an
        // ordinary race into a failed write on a path that must never break a session.
        expect(result).toEqual({
            status       : 'noop',
            reason       : 'no-active-turn',
            action       : 'progress',
            agentIdentity: '@agent-turn'
        });
    });

    test('wakeSubmitNonce persists, survives a later progress, and is rejected when malformed', async () => {
        const nonce = '7ac7f929-0e77-4f61-92d2-1f078e871fe4';

        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action         : 'start',
            turnId         : 'turn-nonce',
            wakeSubmitNonce: nonce,
            now            : '2026-06-19T04:00:00.000Z'
        }));

        expect(getNode('turn-nonce').properties.wakeSubmitNonce).toBe(nonce);

        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'progress',
            turnId: 'turn-nonce',
            now   : '2026-06-19T04:01:00.000Z'
        }));

        // The wake daemon's delivery proof matches on this exact value. A progress event that omitted the
        // nonce must not erase the correlation mid-turn, or the proof degrades to `wake-submit-unknown`
        // for a delivery that demonstrably happened.
        expect(getNode('turn-nonce').properties.wakeSubmitNonce).toBe(nonce);

        // Rejected rather than dropped: a stored-but-unmatchable nonce is indistinguishable from an
        // absent one, so silently normalising it away would report correlation that can never fire.
        // Synchronous throw — asserted through a thunk, because `asAgent(...)` would raise before
        // `expect` ever received a promise to reject.
        expect(() => asAgent(() => TurnPresenceService.recordTurnPresence({
            action         : 'start',
            turnId         : 'turn-bad-nonce',
            wakeSubmitNonce: 'not-a-uuid',
            now            : '2026-06-19T04:02:00.000Z'
        }))).toThrow(/Invalid wakeSubmitNonce/);

        // And nothing was persisted for the rejected call — the validation runs BEFORE the upsert, so a
        // malformed nonce cannot leave a half-written interval behind.
        expect(getNode('turn-bad-nonce')).toBeFalsy();
    });

    test('a capacity reading lands per seat, reads observed, then stale past capacityStaleMs; a seat that never reported reads unobserved', async () => {
        const poolKey = 'a'.repeat(32);

        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action  : 'start',
            turnId  : 'turn-capacity',
            capacity: {
                observedAt: '2026-06-19T05:00:00.000Z',
                source    : 'spec',
                poolKey,
                windows   : [{kind: 'five-hour', percentUsed: 19}, {kind: 'weekly', percentUsed: 90}]
            },
            now: '2026-06-19T05:00:30.000Z'
        }));

        const observed = TurnPresenceService.getCapacity('@agent-turn', '2026-06-19T06:00:00.000Z');

        expect(observed).toMatchObject({state: 'observed', observedAt: '2026-06-19T05:00:00.000Z', source: 'spec', poolKey, model: null});
        expect(observed.windows).toEqual([
            {kind: 'five-hour', model: null, percentUsed: 19, resetsAt: null, observedAt: '2026-06-19T05:00:00.000Z', stale: false},
            {kind: 'weekly',    model: null, percentUsed: 90, resetsAt: null, observedAt: '2026-06-19T05:00:00.000Z', stale: false}
        ]);

        // The default bound is six hours: one millisecond past it, the reading stops routing anything.
        expect(TurnPresenceService.getCapacity('@agent-turn', '2026-06-19T11:00:00.001Z').state).toBe('stale');
        expect(TurnPresenceService.getCapacity('@another-seat', '2026-06-19T06:00:00.000Z')).toEqual({state: 'unobserved'});
    });

    test('a report replaces only its own windows, never with an older observation; a reset carries over only while it lies ahead', async () => {
        const report = (observedAt, windows, extra = {}) => asAgent(() => TurnPresenceService.recordTurnPresence({
            action  : 'progress',
            capacity: {observedAt, source: 'spec', windows, ...extra},
            now     : observedAt
        }));
        const weekly = now => TurnPresenceService.getCapacity('@agent-turn', now).windows.find(window => window.kind === 'weekly');

        // The seat's own usage report: reset instants and the window that caps one model. No turn is open,
        // so the event is a no-op, and the reading lands anyway: it describes the plan, not the turn.
        const noop = await report('2026-06-19T05:00:00.000Z', [
            {kind: 'weekly',       percentUsed: 88, resetsAt: '2026-06-25T19:00:00.000Z'},
            {kind: 'weekly-model', percentUsed: 58, resetsAt: '2026-06-25T19:00:00.000Z', model: 'fable'}
        ], {model: 'opus'});
        expect(noop.status).toBe('noop');

        // A later hook sample carries no reset instants and no model window.
        await report('2026-06-19T07:00:00.000Z', [{kind: 'five-hour', percentUsed: 24}, {kind: 'weekly', percentUsed: 90}]);
        // An older sample delivered late must not roll a window back.
        await report('2026-06-19T04:00:00.000Z', [{kind: 'weekly', percentUsed: 80}]);

        const capacity = TurnPresenceService.getCapacity('@agent-turn', '2026-06-19T07:30:00.000Z'),
              byKind   = Object.fromEntries(capacity.windows.map(window => [window.kind, window]));

        expect(capacity).toMatchObject({state: 'observed', observedAt: '2026-06-19T07:00:00.000Z', model: 'opus'});
        expect(byKind.weekly).toMatchObject({percentUsed: 90, resetsAt: '2026-06-25T19:00:00.000Z', observedAt: '2026-06-19T07:00:00.000Z'});
        expect(byKind['weekly-model']).toMatchObject({model: 'fable', percentUsed: 58, resetsAt: '2026-06-25T19:00:00.000Z'});
        expect(byKind['five-hour']).toMatchObject({percentUsed: 24, resetsAt: null});

        // Once the stored reset has passed, a sample without one leaves the window without a reset.
        await report('2026-06-25T20:00:00.000Z', [{kind: 'weekly', percentUsed: 3}]);
        expect(weekly('2026-06-25T20:30:00.000Z')).toMatchObject({percentUsed: 3, resetsAt: null});
    });

    test('two pool keys are two accounts: a newer report from another pool starts the windows afresh, an older one changes nothing', async () => {
        const poolA  = 'a'.repeat(32),
              poolB  = 'b'.repeat(32),
              report = (observedAt, windows, extra = {}) => asAgent(() => TurnPresenceService.recordTurnPresence({
                  action  : 'progress',
                  capacity: {observedAt, source: 'spec', windows, ...extra},
                  now     : observedAt
              })),
              read   = () => TurnPresenceService.getCapacity('@agent-turn', '2026-06-19T10:30:00.000Z'),
              shown  = () => read().windows.map(window => [window.kind, window.percentUsed, window.resetsAt]);

        await report('2026-06-19T06:00:00.000Z', [
            {kind: 'weekly',       percentUsed: 70,  resetsAt: '2026-06-25T19:00:00.000Z'},
            {kind: 'weekly-model', percentUsed: 100, resetsAt: '2026-06-25T19:00:00.000Z', model: 'fable'}
        ], {poolKey: poolA, model: 'claude-fable-5-2'});

        // The seat moves to pool B: neither pool A's capped model nor its reset comes along.
        await report('2026-06-19T10:00:00.000Z', [{kind: 'weekly', percentUsed: 10}], {poolKey: poolB, model: 'claude-opus-5-5'});
        expect(read()).toMatchObject({observedAt: '2026-06-19T10:00:00.000Z', poolKey: poolB, model: 'claude-opus-5-5'});
        expect(shown()).toEqual([['weekly', 10, null]]);

        // A pool-A report delivered late describes an account the seat has left.
        await report('2026-06-19T08:00:00.000Z', [{kind: 'five-hour', percentUsed: 50}, {kind: 'weekly', percentUsed: 80}], {poolKey: poolA, model: 'claude-fable-5-2'});
        expect(read()).toMatchObject({observedAt: '2026-06-19T10:00:00.000Z', poolKey: poolB, model: 'claude-opus-5-5'});
        expect(shown()).toEqual([['weekly', 10, null]]);

        // A late report from the same pool still adds a window the newer one lacks, and leaves the newer metadata.
        await report('2026-06-19T09:00:00.000Z', [{kind: 'five-hour', percentUsed: 40}], {poolKey: poolB, model: 'claude-haiku-5-5'});
        expect(read()).toMatchObject({observedAt: '2026-06-19T10:00:00.000Z', poolKey: poolB, model: 'claude-opus-5-5'});
        expect(shown()).toEqual([['weekly', 10, null], ['five-hour', 40, null]]);

        // The seat's own usage report names no pool: the same seat on the same account, so it merges.
        await report('2026-06-19T10:15:00.000Z', [{kind: 'weekly', percentUsed: 12, resetsAt: '2026-06-25T19:00:00.000Z'}]);
        expect(read()).toMatchObject({observedAt: '2026-06-19T10:15:00.000Z', poolKey: poolB, model: 'claude-opus-5-5'});
        expect(shown()).toEqual([['weekly', 12, '2026-06-25T19:00:00.000Z'], ['five-hour', 40, null]]);
    });

    test('a malformed reading refuses the call before anything is written, and an account key never passes as a pool key', async () => {
        const attempt = capacity => () => asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'turn-refused',
            capacity,
            now   : '2026-06-19T08:00:00.000Z'
        }));

        expect(attempt({poolKey: '00000000-0000-4000-8000-000000000000', windows: [{kind: 'weekly', percentUsed: 1}]})).toThrow(/capacity\.poolKey/);
        expect(attempt({windows: [{kind: 'monthly', percentUsed: 1}]})).toThrow(/window kind 'monthly'/);
        expect(attempt({windows: [{kind: 'weekly-model', percentUsed: 1}]})).toThrow(/must name its model/);
        expect(attempt({windows: [{kind: 'weekly', percentUsed: -1}]})).toThrow(/percentUsed/);
        expect(attempt({windows: []})).toThrow(/1 to 8 windows/);

        expect(getNode('turn-refused')).toBeFalsy();
        expect(TurnPresenceService.getCapacity('@agent-turn')).toEqual({state: 'unobserved'});
    });

    test('the declared request schema keeps a capacity reading: the non-strict root strips what it does not declare', () => {
        const inputSchema = buildZodSchema(memoryCoreOpenApi, recordTurnPresenceOp),
              capacity    = {observedAt: '2026-06-19T05:00:00.000Z', poolKey: 'b'.repeat(32), windows: [{kind: 'weekly', percentUsed: 90, resetsAt: '2026-06-25T19:00:00.000Z'}]};

        expect(inputSchema.parse({action: 'start', capacity}).capacity).toEqual(capacity);
    });

    test('successful add_memory terminalizes the active turn interval', async () => {
        await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start',
            turnId: 'memory-turn',
            source: 'spec'
        }));

        const result = await asAgent(() => MemoryService.addMemory({
            prompt         : 'turn-presence prompt',
            decisionContext: 'turn-presence thought',
            response       : 'turn-presence response'
        }));

        expect(result.message).toBe(MEMORY_ACCEPTED_MESSAGE);

        const node = getNode('memory-turn');
        expect(node.properties.status).toBe('terminal');
        expect(node.properties.terminalState).toBe('completed');
        expect(node.properties.source).toBe('add_memory');
    });

    // Schema↔handler drift guard — validates every action's REAL emitted response against the tool's
    // DECLARED output schema (not a hand-written shape). `terminalState` is a terminal-only enum with no
    // null member, so a non-terminal `terminalState: null` fails the MCP structured-content validator and
    // errors every call. start/progress must OMIT it; terminal must carry it for all four states.
    test('every action response parses against the DECLARED output schema — start/progress omit terminalState, terminal carries all four states; the pre-fix null shape is rejected (#14582 AC3/AC4)', async () => {
        const start = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'start', turnId: 'schema-turn', source: 'spec', now: '2026-06-19T00:00:00.000Z'
        }));
        expect(() => turnPresenceOutputSchema.parse(start), 'start response must satisfy the declared output schema').not.toThrow();
        expect('terminalState' in start).toBe(false);

        const progress = await asAgent(() => TurnPresenceService.recordTurnPresence({
            action: 'progress', turnId: 'schema-turn', now: '2026-06-19T00:05:00.000Z'
        }));
        expect(() => turnPresenceOutputSchema.parse(progress), 'progress response must satisfy the declared output schema').not.toThrow();
        expect('terminalState' in progress).toBe(false);

        // The full terminal enum — the ticket's AC3 ("terminal verified for all four terminal states").
        for (const terminalState of ['completed', 'blocked', 'aborted', 'stale']) {
            await asAgent(() => TurnPresenceService.recordTurnPresence({
                action: 'start', turnId: `term-${terminalState}`, now: '2026-06-19T00:00:00.000Z'
            }));
            const terminal = await asAgent(() => TurnPresenceService.recordTurnPresence({
                action: 'terminal', turnId: `term-${terminalState}`, terminalState, now: '2026-06-19T00:01:00.000Z'
            }));
            expect(() => turnPresenceOutputSchema.parse(terminal), `terminal:${terminalState} must satisfy the declared output schema`).not.toThrow();
            expect(terminal.terminalState).toBe(terminalState);
        }

        // The exact pre-fix shape: a non-terminal response carrying `terminalState: null` is what the live
        // MCP client rejected with -32602. The declared schema MUST reject it here — proving this fixture
        // catches the drift the old hand-written `toBe(null)` assertion silently encoded.
        expect(() => turnPresenceOutputSchema.parse({...start, terminalState: null})).toThrow();
    });
});
