import {setup} from '../../../../setup.mjs';

const appName             = 'MemoryCoreSessionResumeValidationTest';
const skipCiSubstrateData = !!process.env.NEO_TEST_SKIP_CI;

process.env.NEO_MODEL_PROVIDER = 'openAiCompatible';
process.env.NEO_OPENAI_COMPATIBLE_MODEL = 'gemma4';

setup({
    neoConfig: {
        allowVdomUpdatesInTests: false,
        unitTestMode           : true,
        useDomApiRenderer      : false
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}  from '@playwright/test';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import path            from 'path';
import {fileURLToPath} from 'url';
import dotenv          from 'dotenv';
import crypto          from 'crypto';
import {execFileSync}  from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({path: path.resolve(__dirname, '../../../../../../.env'), quiet: true});

test.describe('SessionService validateSessionForResume (#10725)', () => {
    test.skip(skipCiSubstrateData, 'CI-skip: Memory Core substrate data not seeded - bucket C (#10903)');

    let SDK, TextEmbeddingService, originalEmbedText;

    test.beforeAll(async () => {
        SDK                  = await import('../../../../../../ai/services.mjs');
        TextEmbeddingService = (await import('../../../../../../ai/services/memory-core/TextEmbeddingService.mjs')).default;

        originalEmbedText = TextEmbeddingService.embedText;
        TextEmbeddingService.embedText = async () => new Array(4096).fill(Math.random());
    });

    test.afterAll(async () => {
        try {
            const {cleanupChromaManager} = await import('./util.mjs');
            await cleanupChromaManager(SDK);
        } finally {
            TextEmbeddingService.embedText = originalEmbedText;
        }
    });

    test.beforeEach(async () => {
        if (!SDK.Memory_LifecycleService._initPromise) {
            await SDK.Memory_LifecycleService.initAsync();
        } else {
            await SDK.Memory_LifecycleService.ready();
        }
        await SDK.Memory_SessionService.ready();
        await SDK.Memory_ChromaManager.ready();
    });

    test('SESSION_NOT_FOUND when no memories and no SummarizationJobs row', async () => {
        const sessionId = `nonexistent-${crypto.randomUUID()}`;

        const result = await SDK.Memory_SessionService.validateSessionForResume({sessionId});

        expect(result.success).toBeUndefined();
        expect(result.code).toBe('SESSION_NOT_FOUND');
        expect(result.sessionId).toBe(sessionId);
    });

    test('#13458: stalled Chroma metadata read falls through to graph fallback', async () => {
        const sessionId     = `graph-fallback-${crypto.randomUUID()}`;
        const memoryNodeId  = crypto.randomUUID();
        const timestamp     = new Date().toISOString();
        const GraphService  = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        const StorageRouter = (await import('../../../../../../ai/services/memory-core/managers/StorageRouter.mjs')).default;

        await GraphService.ready();
        const originalGetMemoryCollection = StorageRouter.getMemoryCollection;

        StorageRouter.getMemoryCollection = async () => ({
            get: async () => new Promise(() => {})
        });

        GraphService.upsertNode({
            id        : memoryNodeId,
            type      : 'AGENT_MEMORY',
            properties: {
                sessionId,
                timestamp
            }
        });

        try {
            const result = await SDK.Memory_SessionService.validateSessionForResume({
                sessionId,
                chromaTimeoutMs: 5
            });

            expect(result).toMatchObject({
                success            : true,
                sessionId,
                status             : 'resumable',
                memoryCount        : 1,
                lastActivityAt     : timestamp,
                summarizationStatus: 'none'
            });
        } finally {
            StorageRouter.getMemoryCollection = originalGetMemoryCollection;
            GraphService.db?.storage?.db?.prepare('DELETE FROM Nodes WHERE id = ?').run(memoryNodeId);
            GraphService.db?.nodes?.delete?.(memoryNodeId);
        }
    });

    test('#12199: queueSummarizationJob writes an idempotent pending marker', async () => {
        const sessionId    = `pending-marker-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        try {
            expect(SDK.Memory_SessionService.queueSummarizationJob(sessionId)).toBe(true);
            expect(SDK.Memory_SessionService.queueSummarizationJob(sessionId)).toBe(true);

            const row = sqlite.prepare('SELECT status, lease_token, expires_at, retry_count FROM SummarizationJobs WHERE session_id = ?').get(sessionId);

            expect(row.status).toBe('pending');
            expect(row.lease_token).toBeNull();
            expect(row.expires_at).toBeNull();
            expect(row.retry_count).toBe(0);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#12199: queueSummarizationJob does not steal an active summarization lease', async () => {
        const sessionId    = `active-lease-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        const futureExpiresAt = Date.now() + 60_000;
        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'in_progress', 'active-token', ?, 3)
        `).run(sessionId, futureExpiresAt);

        try {
            expect(SDK.Memory_SessionService.queueSummarizationJob(sessionId)).toBe(true);

            const row = sqlite.prepare('SELECT status, lease_token, expires_at, retry_count FROM SummarizationJobs WHERE session_id = ?').get(sessionId);

            expect(row.status).toBe('in_progress');
            expect(row.lease_token).toBe('active-token');
            expect(row.expires_at).toBe(futureExpiresAt);
            expect(row.retry_count).toBe(3);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#12199: queueSummarizationJob does not reopen a completed summary', async () => {
        const sessionId    = `completed-summary-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'completed', NULL, NULL, 2)
        `).run(sessionId);

        try {
            expect(SDK.Memory_SessionService.queueSummarizationJob(sessionId)).toBe(true);

            const row = sqlite.prepare('SELECT status, lease_token, expires_at, retry_count FROM SummarizationJobs WHERE session_id = ?').get(sessionId);

            expect(row.status).toBe('completed');
            expect(row.lease_token).toBeNull();
            expect(row.expires_at).toBeNull();
            expect(row.retry_count).toBe(2);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#13462: claimSummarizationJob keeps completed rows terminal by default', async () => {
        const sessionId    = `completed-terminal-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'completed', NULL, NULL, 2)
        `).run(sessionId);

        try {
            expect(SDK.Memory_SessionService.claimSummarizationJob(sessionId, 'default-token')).toBe(false);

            const row = sqlite.prepare('SELECT status, lease_token, expires_at, retry_count FROM SummarizationJobs WHERE session_id = ?').get(sessionId);

            expect(row.status).toBe('completed');
            expect(row.lease_token).toBeNull();
            expect(row.expires_at).toBeNull();
            expect(row.retry_count).toBe(2);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#13462: claimSummarizationJob can repair completed rows when drift was proven', async () => {
        const sessionId    = `completed-repair-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        sqlite.prepare(`
            INSERT INTO SummarizationJobs (
                session_id,
                status,
                lease_token,
                expires_at,
                retry_count,
                result_envelope,
                result_encoding,
                result_staged_at,
                result_acknowledged_at,
                result_last_replayed_at
            )
            VALUES (?, 'completed', NULL, NULL, 2, ?, 'gzip-json-v1', 100, 101, 102)
        `).run(sessionId, Buffer.from('superseded-receipt'));

        try {
            expect(SDK.Memory_SessionService.claimSummarizationJob(sessionId, 'repair-token', {allowCompletedRepair: true})).toBe(true);

            const row = sqlite.prepare(`
                SELECT
                    status,
                    lease_token,
                    expires_at,
                    retry_count,
                    result_envelope,
                    result_encoding,
                    result_staged_at,
                    result_acknowledged_at,
                    result_last_replayed_at
                FROM SummarizationJobs
                WHERE session_id = ?
            `).get(sessionId);

            expect(row.status).toBe('in_progress');
            expect(row.lease_token).toBe('repair-token');
            expect(row.expires_at).toBeGreaterThan(Date.now());
            expect(row.retry_count).toBe(3);
            expect(row.result_envelope).toBeNull();
            expect(row.result_encoding).toBeNull();
            expect(row.result_staged_at).toBeNull();
            expect(row.result_acknowledged_at).toBeNull();
            expect(row.result_last_replayed_at).toBeNull();
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#438: a failed job backs off 30 min, doubling with each claim since its last success, capped at 24 h', async () => {
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const
            sqlite    = GraphService.db.storage.db,
            service   = SDK.Memory_SessionService,
            sessionId = `failure-backoff-${crypto.randomUUID()}`,
            now       = 1_000_000,
            minute    = 60_000,
            expiresAt = () => sqlite.prepare('SELECT expires_at FROM SummarizationJobs WHERE session_id = ?').pluck().get(sessionId),
            retries   = count => sqlite.prepare('UPDATE SummarizationJobs SET retry_count = ? WHERE session_id = ?').run(count, sessionId);

        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'in_progress', 'token', ?, 0)
        `).run(sessionId, now + 5 * minute);

        try {
            service.failSummarizationJob(sessionId, now);
            expect(expiresAt()).toBe(now + 30 * minute);
            expect(service.getSessionIdsInFailureBackoff(now + 30 * minute - 1).has(sessionId)).toBe(true);
            expect(service.getSessionIdsInFailureBackoff(now + 30 * minute).has(sessionId), 'eligible once the not-before passes').toBe(false);

            retries(3);
            service.failSummarizationJob(sessionId, now);
            expect(expiresAt()).toBe(now + 240 * minute);

            retries(9);
            service.failSummarizationJob(sessionId, now);
            expect(expiresAt(), 'capped at 24 h').toBe(now + 24 * 60 * minute);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#438: acknowledging a summary resets the backoff exponent', async () => {
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const
            sqlite    = GraphService.db.storage.db,
            service   = SDK.Memory_SessionService,
            sessionId = `failure-reset-${crypto.randomUUID()}`,
            now       = 1_000_000;

        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count, result_envelope, result_encoding, result_staged_at)
            VALUES (?, 'in_progress', 'token', ?, 4, ?, 'gzip-json-v1', 100)
        `).run(sessionId, now, Buffer.from('staged-receipt'));

        try {
            service.completeSummarizationJob(sessionId);

            const row = sqlite.prepare('SELECT status, retry_count FROM SummarizationJobs WHERE session_id = ?').get(sessionId);

            expect(row).toEqual({status: 'completed', retry_count: 0});

            sqlite.prepare(`UPDATE SummarizationJobs SET status = 'in_progress' WHERE session_id = ?`).run(sessionId);
            service.failSummarizationJob(sessionId, now);

            expect(sqlite.prepare('SELECT expires_at FROM SummarizationJobs WHERE session_id = ?').pluck().get(sessionId), 'the ladder starts again at 30 min').toBe(now + 30 * 60_000);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#438: a disconnect re-queues a failed job only once its backoff has passed', async () => {
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const
            sqlite    = GraphService.db.storage.db,
            service   = SDK.Memory_SessionService,
            now       = 1_000_000,
            backedOff = `failure-queue-held-${crypto.randomUUID()}`,
            expired   = `failure-queue-expired-${crypto.randomUUID()}`,
            row       = id => sqlite.prepare('SELECT status, expires_at FROM SummarizationJobs WHERE session_id = ?').get(id);

        const insertFailed = sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'failed', NULL, ?, 1)
        `);

        insertFailed.run(backedOff, now + 1);
        insertFailed.run(expired,   now);

        try {
            expect(service.queueSummarizationJob(backedOff, now)).toBe(true);
            expect(service.queueSummarizationJob(expired,   now)).toBe(true);

            expect(row(backedOff), 'the pending drain must not bypass the backoff').toEqual({status: 'failed', expires_at: now + 1});
            expect(row(expired)).toEqual({status: 'pending', expires_at: null});
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id IN (?, ?)').run(backedOff, expired);
        }
    });

    test('#438: backed-off sessions are dropped before the cap, and the drift line counts failures and backoff', async () => {
        const
            service   = SDK.Memory_SessionService,
            originals = {
                findSessionsToSummarize      : service.findSessionsToSummarize,
                getSessionIdsInFailureBackoff: service.getSessionIdsInFailureBackoff,
                claimSummarizationJob        : service.claimSummarizationJob,
                summarizeSession             : service.summarizeSession,
                failSummarizationJob         : service.failSummarizationJob
            },
            originalConsoleError = console.error,
            fresh                = ['f1', 'f2', 'f3', 'f4', 'f5'],
            claimed              = [],
            failed               = [],
            lines                = [];

        Object.assign(service, {
            findSessionsToSummarize      : async () => ['backed-off', ...fresh],
            getSessionIdsInFailureBackoff: () => new Set(['backed-off']),
            claimSummarizationJob        : sessionId => claimed.push(sessionId) > 0,
            summarizeSession             : async () => null,
            failSummarizationJob         : sessionId => failed.push(sessionId)
        });
        console.error = (...args) => lines.push(args.join(' '));

        try {
            await service.summarizeSessions();

            // The default per-sweep cap is 5 (config.template.spec): six candidates, one backed off.
            expect(claimed, 'the backed-off session never takes one of the five slots').toEqual(fresh);
            expect(failed).toEqual(fresh);
            expect(lines.find(line => line.includes('drift complete'))).toContain('candidates=5; processed=0; failed=5; skippedClaims=0; backoff=1');
        } finally {
            Object.assign(service, originals);
            console.error = originalConsoleError;
        }
    });

    test('#13462: summarizeSessions enables completed-row repair for drift candidates', async () => {
        const originalFind      = SDK.Memory_SessionService.findSessionsToSummarize;
        const originalClaim     = SDK.Memory_SessionService.claimSummarizationJob;
        const originalSummarize = SDK.Memory_SessionService.summarizeSession;
        const claimCalls        = [];

        SDK.Memory_SessionService.findSessionsToSummarize = async () => ['drift-repair-candidate'];
        SDK.Memory_SessionService.claimSummarizationJob = (sessionId, leaseToken, options) => {
            claimCalls.push({sessionId, leaseToken, options});
            return false;
        };
        SDK.Memory_SessionService.summarizeSession = async () => {
            throw new Error('summarizeSession should not be called when claim fails');
        };

        try {
            const result = await SDK.Memory_SessionService.summarizeSessions();

            expect(result.processed).toBe(0);
            expect(claimCalls).toHaveLength(1);
            expect(claimCalls[0].sessionId).toBe('drift-repair-candidate');
            expect(claimCalls[0].options).toEqual({allowCompletedRepair: true});
        } finally {
            SDK.Memory_SessionService.findSessionsToSummarize = originalFind;
            SDK.Memory_SessionService.claimSummarizationJob   = originalClaim;
            SDK.Memory_SessionService.summarizeSession        = originalSummarize;
        }
    });

    test('#16105: summarizeSessions recovers an exact receipt before any claim or model path', async () => {
        const originalRecover   = SDK.Memory_SessionService.recoverSessionSummaryReceipts;
        const originalClaim     = SDK.Memory_SessionService.claimSummarizationJob;
        const originalSummarize = SDK.Memory_SessionService.summarizeSession;
        const order             = [];

        SDK.Memory_SessionService.recoverSessionSummaryReceipts = async ({sessionId}) => {
            order.push(`recover:${sessionId}`);
            return {replayed: 1, completed: 1};
        };
        SDK.Memory_SessionService.claimSummarizationJob = sessionId => {
            order.push(`claim:${sessionId}`);
            return false;
        };
        SDK.Memory_SessionService.summarizeSession = async sessionId => {
            order.push(`model:${sessionId}`);
            throw new Error('summary model must not run after recovery finalized the job');
        };

        try {
            const result = await SDK.Memory_SessionService.summarizeSessions({
                sessionId: 'receipt-first'
            });

            expect(result.processed).toBe(0);
            expect(order).toEqual([
                'recover:receipt-first',
                'claim:receipt-first'
            ]);
        } finally {
            SDK.Memory_SessionService.recoverSessionSummaryReceipts = originalRecover;
            SDK.Memory_SessionService.claimSummarizationJob         = originalClaim;
            SDK.Memory_SessionService.summarizeSession              = originalSummarize;
        }
    });

    test('#16105: missing durable envelope cannot produce processed/completed receipt', async () => {
        const sessionId       = `receipt-required-${crypto.randomUUID()}`;
        const GraphService    = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        const sqlite          = GraphService.db?.storage?.db;
        const originalRecover = SDK.Memory_SessionService.recoverSessionSummaryReceipts;
        const originalClaim   = SDK.Memory_SessionService.claimSummarizationJob;
        const originalSummary = SDK.Memory_SessionService.summarizeSession;

        expect(sqlite).toBeTruthy();
        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status)
            VALUES (?, 'pending')
        `).run(sessionId);

        SDK.Memory_SessionService.recoverSessionSummaryReceipts = async () => ({replayed: 0});
        SDK.Memory_SessionService.claimSummarizationJob         = () => true;
        SDK.Memory_SessionService.summarizeSession              = async () => ({
            sessionId,
            summaryId: `summary_${sessionId}`
        });

        try {
            const result = await SDK.Memory_SessionService.summarizeSessions({sessionId});

            expect(result.processed).toBe(0);
            expect(result.sessions).toEqual([]);
            expect(sqlite.prepare(`
                SELECT status, result_envelope
                FROM SummarizationJobs
                WHERE session_id = ?
            `).get(sessionId)).toEqual({
                status         : 'failed',
                result_envelope: null
            });
        } finally {
            SDK.Memory_SessionService.recoverSessionSummaryReceipts = originalRecover;
            SDK.Memory_SessionService.claimSummarizationJob         = originalClaim;
            SDK.Memory_SessionService.summarizeSession              = originalSummary;
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('#12199: summarizePendingSessions drains explicit pending ids through summarizeSessions', async () => {
        const calls              = [];
        const originalGetPending = SDK.Memory_SessionService.getPendingSummarizationJobIds;
        const originalSummarize  = SDK.Memory_SessionService.summarizeSessions;

        SDK.Memory_SessionService.getPendingSummarizationJobIds = ({limit}) => {
            calls.push({type: 'getPending', limit});
            return ['pending-session-1', 'pending-session-2'];
        };
        SDK.Memory_SessionService.summarizeSessions = async ({sessionId}) => {
            calls.push({type: 'summarize', sessionId});
            return {processed: 1, sessions: [{sessionId}]};
        };

        try {
            const result = await SDK.Memory_SessionService.summarizePendingSessions({limit: 2});

            expect(result).toEqual({
                pending  : 2,
                processed: 2,
                sessions : [{sessionId: 'pending-session-1'}, {sessionId: 'pending-session-2'}]
            });
            expect(calls).toEqual([
                {type: 'getPending', limit: 2},
                {type: 'summarize', sessionId: 'pending-session-1'},
                {type: 'summarize', sessionId: 'pending-session-2'}
            ]);
        } finally {
            SDK.Memory_SessionService.getPendingSummarizationJobIds = originalGetPending;
            SDK.Memory_SessionService.summarizeSessions = originalSummarize;
        }
    });

    test('resumable success when memories exist with no SummarizationJobs row', async () => {
        const sessionId             = `resumable-memories-${crypto.randomUUID()}`;
        const RequestContextService = (await import('../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs')).default;

        await RequestContextService.run({sessionId}, async () => {
            await SDK.Memory_Service.addMemory({
                prompt  : 'resume validation prompt',
                response: 'resume validation response',
                thought : 'resume validation thought'
            });
        });

        const result = await SDK.Memory_SessionService.validateSessionForResume({sessionId});

        expect(result.success).toBe(true);
        expect(result.sessionId).toBe(sessionId);
        expect(result.status).toBe('resumable');
        expect(result.memoryCount).toBe(1);
        expect(result.summarizationStatus).toBe('none');
        expect(result.lastActivityAt).toBeTruthy();
    });

    test('SESSION_FINALIZED when SummarizationJobs.status === completed', async () => {
        const sessionId    = `finalized-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        // Plant a completed-status row directly to simulate a finalized session.
        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'completed', NULL, NULL, 0)
        `).run(sessionId);

        try {
            const result = await SDK.Memory_SessionService.validateSessionForResume({sessionId});

            expect(result.success).toBeUndefined();
            expect(result.code).toBe('SESSION_FINALIZED');
            expect(result.sessionId).toBe(sessionId);
            expect(result.summarizationStatus).toBe('completed');
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('SESSION_BUSY when SummarizationJobs.status === in_progress with future expires_at', async () => {
        const sessionId    = `busy-${crypto.randomUUID()}`;
        const GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        const futureExpiresAt = Date.now() + 60_000;
        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'in_progress', 'test-lease', ?, 0)
        `).run(sessionId, futureExpiresAt);

        try {
            const result = await SDK.Memory_SessionService.validateSessionForResume({sessionId});

            expect(result.success).toBeUndefined();
            expect(result.code).toBe('SESSION_BUSY');
            expect(result.sessionId).toBe(sessionId);
            expect(result.summarizationStatus).toBe('in_progress');
            expect(result.leaseExpiresAt).toBeTruthy();
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });

    test('resumable when SummarizationJobs.status === in_progress but lease has expired', async () => {
        const sessionId             = `expired-lease-${crypto.randomUUID()}`;
        const GraphService          = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        const RequestContextService = (await import('../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs')).default;
        await GraphService.ready();

        const sqlite = GraphService.db?.storage?.db;
        expect(sqlite).toBeTruthy();

        // Plant a memory so the resumable path has a non-zero count + last activity.
        await RequestContextService.run({sessionId}, async () => {
            await SDK.Memory_Service.addMemory({
                prompt  : 'expired-lease prompt',
                response: 'expired-lease response',
                thought : 'expired-lease thought'
            });
        });

        // Plant an in_progress row with expired lease — should be treated as resumable.
        const expiredAt = Date.now() - 60_000;
        sqlite.prepare(`
            INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count)
            VALUES (?, 'in_progress', 'expired-lease-token', ?, 0)
        `).run(sessionId, expiredAt);

        try {
            const result = await SDK.Memory_SessionService.validateSessionForResume({sessionId});

            expect(result.success).toBe(true);
            expect(result.sessionId).toBe(sessionId);
            expect(result.status).toBe('resumable');
            expect(result.summarizationStatus).toBe('in_progress');
            expect(result.memoryCount).toBe(1);
        } finally {
            sqlite.prepare('DELETE FROM SummarizationJobs WHERE session_id = ?').run(sessionId);
        }
    });
});

test.describe('SessionService failure backoff under a declared policy (#438)', () => {
    test('a non-default policy drives the delays, and its cap binds whatever the ratio', () => {
        const script = `
            import 'neo.mjs/src/Neo.mjs';
            const {default: GraphService}   = await import('./ai/services/memory-core/GraphService.mjs');
            const {default: SessionService} = await import('./ai/services/memory-core/SessionService.mjs');
            await GraphService.ready();
            const db = GraphService.db.storage.db, now = 1000000, id = 'failure-backoff-policy';
            db.prepare("INSERT INTO SummarizationJobs (session_id, status, lease_token, expires_at, retry_count) VALUES (?, 'in_progress', 'token', ?, 0)").run(id, now);
            const delays = [0, 3, 20].map(retries => {
                db.prepare('UPDATE SummarizationJobs SET retry_count = ? WHERE session_id = ?').run(retries, id);
                SessionService.failSummarizationJob(id, now);
                return db.prepare('SELECT expires_at FROM SummarizationJobs WHERE session_id = ?').pluck().get(id) - now;
            });
            console.log('DELAYS=' + JSON.stringify(delays));
            process.exit(0);
        `;

        // A fresh process resolves the policy at construction, on its own in-memory graph; the
        // shared singleton is never touched.
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd     : process.cwd(),
            encoding: 'utf8',
            env     : {
                ...process.env,
                NEO_MC_SUMMARY_FAILURE_BACKOFF_BASE_MS: '60000',
                NEO_MC_SUMMARY_FAILURE_BACKOFF_MAX_MS : '86400000',
                UNIT_TEST_MODE                        : 'true'
            }
        });

        // 1 min, 8 min, then the 24 h cap at retry 20 — a doubling clamped at six steps stops at 64 min.
        expect(output).toContain('DELAYS=[60000,480000,86400000]')
    });
});
