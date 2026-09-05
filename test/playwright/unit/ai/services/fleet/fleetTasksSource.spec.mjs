import {expect, test} from '@playwright/test';
import {
    createFleetTasksSource,
    extractDeploymentRows,
    extractIngestionRows,
    extractRemRows
} from '../../../../../../ai/services/fleet/fleetTasksSource.mjs';

const
    NOW    = '2026-08-22T12:30:00.000Z',
    NOW_MS = Date.parse(NOW);

/**
 * @summary A deployment-state payload in the live verb's shape (identity hashes only — the fixture
 * carries a tenant hash precisely so the leak witness can prove it never leaves the reducer).
 * @returns {Object}
 */
function deploymentPayload() {
    return {
        ok          : true,
        status      : 'available',
        ageMs       : 30000,
        staleAfterMs: 120000,
        snapshot    : {
            generatedAt   : Date.parse('2026-08-22T12:29:30.000Z'),
            tenantRepoSync: {
                status   : 'completed',
                enabled  : true,
                scheduler: {globalCadenceMs: 1800000, sweepCadenceMs: 60000, due: true},
                task     : {
                    running      : false,
                    pid          : null,
                    lastRunAt    : '2026-08-22T12:11:42.258Z',
                    lastSuccessAt: '2026-08-22T12:11:42.269Z',
                    lastReason   : 'periodic-sweep:60000',
                    lastCompletion: {status: 'completed', reason: 'periodic-sweep:60000', repoCount: 3, completedCount: 0, failedCount: 0, notDueCount: 3}
                },
                repos: [
                    {identityHash: 'cbff435fe549', tenantHash: 'cf744f16ee7f', disabled: false, status: 'not-due', due: true,  nextDueAt: '2026-08-22T12:34:23.859Z', lastIngestedRev: 'd8ae9ffa41ac', consecutiveFailures: 0, corpusOutstanding: {state: 'complete', observable: true, settled: 0,   remaining: 0,  outstanding: 0}},
                    {identityHash: 'ba41470c1d2e', tenantHash: 'cf744f16ee7f', disabled: false, status: 'not-due', due: false, nextDueAt: '2026-08-22T12:40:00.000Z', lastIngestedRev: '0123456789ab', consecutiveFailures: 2, corpusOutstanding: {state: 'pending',  observable: true, settled: 120, remaining: 30, outstanding: 30}},
                    {identityHash: 'd15ab1ed0000', disabled: true,  nextDueAt: '2026-08-22T12:50:00.000Z'},
                    {identityHash: 'n0due0000000', disabled: false, nextDueAt: null}
                ]
            },
            maintenance : {retry: {phase: 'exhausted', nextAttemptAtMs: Date.parse('2026-08-22T12:36:55.189Z'), retriesRemaining: 0}},
            recoveryRuns: {
                status : 'available',
                entries: [
                    {recoveryRunId: 'recovery-actuator:backup:record:2026-08-21T12:58:37.764Z', status: 'recorded',  targetIdentity: {kind: 'supervised-task', id: 'backup'},    startedAt: Date.parse('2026-08-21T12:58:37.764Z'), updatedAt: Date.parse('2026-08-21T12:58:37.774Z'), completedAt: Date.parse('2026-08-21T12:58:37.774Z'), details: {reasonCode: 'maintenance-task-failure'}},
                    {recoveryRunId: 'recovery-actuator:mc-server:restart:2026-08-22T12:20:00.000Z', status: 'in-flight', targetIdentity: {kind: 'service', id: 'mc-server'}, startedAt: Date.parse('2026-08-22T12:20:00.000Z'), updatedAt: Date.parse('2026-08-22T12:20:05.000Z'), completedAt: null, details: {reasonCode: 'crash-loop'}}
                ]
            },
            selfHeal: {status: 'available', summary: {total: 3, byStatus: {recorded: 3}, currentlyFrozen: ['turns']}}
        }
    }
}

/**
 * @summary The Knowledge Base ingestion verb's idle shape, tenant identifiers included so the
 * leak witness can prove they never render.
 * @returns {Object}
 */
function idleIngestion() {
    return {
        status        : 'idle',
        active        : false,
        phase         : 'idle',
        observedScope : 'this-process-only',
        crossProcessHint: 'Pull-mode tenant-repo ingestion runs in the orchestrator process and is NOT reflected here.',
        startedAt     : null,
        completedAt   : '2026-08-22T12:24:32.967Z',
        stalled       : false,
        totalChunks   : 0,
        embeddedChunks: 0,
        errorCount    : 1,
        lastRunSummary: {status: 'completed_with_errors', tenantId: 'tenant-alpha', repoSlug: 'org/secret-repo', completedAt: '2026-08-22T12:24:32.967Z', embeddedChunks: 0, errorCount: 1}
    }
}

const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));

test.describe('fleetTasksSource — extractDeploymentRows', () => {
    test('reduces the snapshot to provenance-labeled rows across all three sections', () => {
        const {rows, state, reason, observedAt} = extractDeploymentRows(deploymentPayload()),
              map = byId(rows);

        expect(state).toBe('wired');
        expect(reason).toBeNull();
        expect(observedAt).toBe('2026-08-22T12:29:30.000Z');

        // the sweep is idle → its last completion is a RECENT row carrying the repo counts
        expect(map['orchestrator:tenant-sync:last']).toEqual({
            id: 'orchestrator:tenant-sync:last', section: 'recent', name: 'Tenant repo sync', source: 'orchestrator',
            state: 'completed', at: '2026-08-22T12:11:42.269Z', progress: null, detail: '0 synced · 3 not due · 0 failed'
        });

        // one QUEUED row per enabled repo with a nextDueAt, labeled by identity hash only
        expect(map['orchestrator:tenant-sync:cbff435fe549']).toEqual({
            id: 'orchestrator:tenant-sync:cbff435fe549', section: 'queued', name: 'Repo sync · cbff435f', source: 'orchestrator',
            state: 'due', at: '2026-08-22T12:34:23.859Z', progress: null, detail: 'rev d8ae9ff'
        });
        expect(map['orchestrator:tenant-sync:ba41470c1d2e']).toEqual({
            id: 'orchestrator:tenant-sync:ba41470c1d2e', section: 'queued', name: 'Repo sync · ba41470c', source: 'orchestrator',
            state: 'scheduled', at: '2026-08-22T12:40:00.000Z', progress: {kind: 'backlog', done: 120, total: 150}, detail: 'rev 0123456 · 2 consecutive failures'
        });
        expect(map['orchestrator:tenant-sync:d15ab1ed0000'], 'a disabled repo is not scheduled').toBeUndefined();
        expect(map['orchestrator:tenant-sync:n0due0000000'], 'no nextDueAt → no queued claim').toBeUndefined();

        // the backup lane is one queued row under the writer's phase word, at its next attempt
        expect(map['orchestrator:maintenance:backup']).toEqual({
            id: 'orchestrator:maintenance:backup', section: 'queued', name: 'Backup lane', source: 'orchestrator',
            state: 'exhausted', at: '2026-08-22T12:36:55.189Z', progress: null, detail: '0 retries remaining'
        });

        // recovery runs: finished → recent, in flight → running
        expect(map['orchestrator:recovery:recovery-actuator:backup:record:2026-08-21T12:58:37.764Z']).toMatchObject({
            section: 'recent', name: 'Recovery · supervised-task backup', state: 'recorded', at: '2026-08-21T12:58:37.774Z', detail: 'maintenance-task-failure'
        });
        expect(map['orchestrator:recovery:recovery-actuator:mc-server:restart:2026-08-22T12:20:00.000Z']).toMatchObject({
            section: 'running', name: 'Recovery · service mc-server', state: 'in-flight', at: '2026-08-22T12:20:05.000Z', detail: 'crash-loop'
        });

        // a frozen collection is held-open work
        expect(map['orchestrator:self-heal:frozen:turns']).toMatchObject({section: 'running', name: 'Self-heal freeze · turns', state: 'frozen', at: null});

        expect(rows).toHaveLength(7)
    });

    test('a running sweep is a RUNNING row and suppresses the last-completion row', () => {
        const payload = deploymentPayload();

        payload.snapshot.tenantRepoSync.task.running = true;

        const map = byId(extractDeploymentRows(payload).rows);

        expect(map['orchestrator:tenant-sync:run']).toEqual({
            id: 'orchestrator:tenant-sync:run', section: 'running', name: 'Tenant repo sync', source: 'orchestrator',
            state: 'in progress', at: '2026-08-22T12:11:42.258Z', progress: null, detail: 'periodic-sweep:60000'
        });
        expect(map['orchestrator:tenant-sync:last']).toBeUndefined()
    });

    test('tenant identifiers never leave the reducer', () => {
        const text = JSON.stringify(extractDeploymentRows(deploymentPayload()).rows);

        expect(text).not.toContain('cf744f16ee7f');
        expect(text).not.toContain('tenantHash')
    });

    test('an unusable payload is the typed unavailable axis — with the producer reason when it gave one', () => {
        expect(extractDeploymentRows(null)).toEqual({rows: [], state: 'unavailable', reason: 'deployment-snapshot-unavailable', observedAt: null, scheduler: null});
        // the reader's own unavailable envelope: ok:false, snapshot:null, a named reason
        expect(extractDeploymentRows({ok: false, status: 'unavailable', snapshot: null, reason: 'snapshot-missing'})).toEqual({rows: [], state: 'unavailable', reason: 'snapshot-missing', observedAt: null, scheduler: null});
        expect(extractDeploymentRows({ok: true, status: 'available'}), 'ok without a snapshot is still nothing').toMatchObject({state: 'unavailable'});
        expect(extractDeploymentRows({ok: false, status: 'mystery', snapshot: deploymentPayload().snapshot, reason: 'x'}), 'ok:false with a snapshot under an unknown status fails closed').toMatchObject({state: 'unavailable', reason: 'x'})
    });

    test('the reader\'s REAL stale envelope — ok:false with the snapshot retained — keeps its rows under the stale word', () => {
        const payload = {...deploymentPayload(), ok: false, status: 'stale', reason: 'snapshot-stale', ageMs: 400000};
        const result  = extractDeploymentRows(payload);

        expect(result.state).toBe('stale');
        expect(result.reason).toBeNull();
        expect(result.rows).toHaveLength(7);
        expect(result.observedAt).toBe('2026-08-22T12:29:30.000Z')
    });

    test('the reader\'s degraded envelope (schema diagnostics, snapshot retained) keeps its rows under the degraded word', () => {
        const payload = {...deploymentPayload(), ok: false, status: 'degraded', reason: 'missing-sections'};

        expect(extractDeploymentRows(payload)).toMatchObject({state: 'degraded', reason: null});
        expect(extractDeploymentRows(payload).rows.length).toBeGreaterThan(0)
    });

    test('a FAILED completion is stamped by the current attempt\'s error time, never by the preserved older success', () => {
        const payload = deploymentPayload(),
              {task}  = payload.snapshot.tenantRepoSync;

        task.lastRunAt      = '2026-08-22T12:20:00.000Z';
        task.lastErrorAt    = '2026-08-22T12:20:03.000Z';
        task.lastSuccessAt  = '2026-08-22T12:11:42.269Z';
        task.lastCompletion = {status: 'failed', reason: 'periodic-sweep:60000', repoCount: 3, completedCount: 0, failedCount: 1, notDueCount: 2};

        const row = byId(extractDeploymentRows(payload).rows)['orchestrator:tenant-sync:last'];

        expect(row).toMatchObject({section: 'recent', state: 'failed', at: '2026-08-22T12:20:03.000Z', detail: '0 synced · 2 not due · 1 failed'})
    });

    test('a SKIPPED sweep is stamped by the attempt itself', () => {
        const payload = deploymentPayload(),
              {task}  = payload.snapshot.tenantRepoSync;

        task.lastRunAt      = '2026-08-22T12:21:00.000Z';
        task.lastSuccessAt  = '2026-08-22T12:11:42.269Z';
        task.lastCompletion = {status: 'skipped', reason: 'access-not-ready'};

        const row = byId(extractDeploymentRows(payload).rows)['orchestrator:tenant-sync:last'];

        expect(row).toMatchObject({state: 'skipped', at: '2026-08-22T12:21:00.000Z', detail: 'access-not-ready'})
    });

    test('an empty-but-valid snapshot yields zero rows, not a failure', () => {
        expect(extractDeploymentRows({ok: true, status: 'available', snapshot: {generatedAt: NOW_MS}})).toEqual({rows: [], state: 'wired', reason: null, observedAt: NOW, scheduler: null})
    })
});

/**
 * @summary The live plane read at 2026-09-05T12:49:36Z, verbatim: three heavy-maintenance waiters
 * starved behind the `summary` lease (this plane's writer predates the per-waiter reason fields, so
 * they are absent and the reducer must not invent them), the backup lane exhausted with no success
 * on record, and the maintenance block's leak bait (durability prose, bundle name, staging residue).
 * One tenant repo is queued beside them so the queue counts across producers.
 * @returns {Object}
 */
function starvedPlane() {
    return {
        ok: true, status: 'available', ageMs: 28159, staleAfterMs: 120000,
        snapshot: {
            generatedAt: 1788612875668,
            heavyMaintenanceStarvation: {
                taskName: 'heavy-maintenance-starvation-watchdog', posture: 'degraded', checkedAt: '2026-09-05T12:49:36.362Z',
                degradeAfterMs: 3600000, waiterCount: 5, unreadableCount: 0, leaseHolder: 'summary',
                breaches: [
                    {taskName: 'dream',                   priorityZero: false, bootstrapCritical: false, deferredSince: '2026-09-05T10:05:51.967Z', starvedForMs: 9824395,  leaseHolder: 'summary'},
                    {taskName: 'kbSync',                  priorityZero: false, bootstrapCritical: false, deferredSince: '2026-09-05T11:29:12.439Z', starvedForMs: 4823923,  leaseHolder: 'summary'},
                    {taskName: 'message-concept-harvest', priorityZero: false, bootstrapCritical: false, deferredSince: '2026-09-05T06:13:43.059Z', starvedForMs: 23753303, leaseHolder: 'summary'}
                ]
            },
            maintenance: {
                durability    : {cloudDeployment: true, configErrorCode: null, offHostBackupRequired: true, offHostSyncConfigured: false, offHostSyncConfigValid: true, posture: 'unmet', reason: 'This cloud deployment requires an off-host copy of the backup bundle, but no off-host sync command is configured. The bundle and the data it protects share one failure domain.'},
                stagingResidue: {status: 'ok', count: 2, bytes: 2289510815, oldestMtimeMs: 1785792866107.185, errorCode: null},
                retry         : {interruptedAt: null, lastSuccessAgeMs: null, lastSuccessAt: null, nextAttemptAtMs: 1788626336430, retriesRemaining: 0, streakStartedAtMs: 1785831744707, windowEndsAtMs: 1785835344707, phase: 'exhausted'},
                lastBackup    : {backup: {durationMs: 149102, error: null, status: 'success'}, bundleCompletedAt: '2026-09-04T16:41:27.461Z', bundleName: 'backup-2026-09-04T16-38-58.555Z', finishedAt: '2026-09-04T16:41:27.657Z', offHostSync: {completionScope: 'direct-child', descendants: 'unknown', durationMs: null, exitCode: null, signal: null, status: 'disabled', stderrTail: '', terminatedVia: null}, schemaVersion: 1},
                health        : {observationStatus: 'observed', reasonCodes: ['off-host-durability-unmet', 'backup-retry-exhausted', 'backup-never-succeeded'], staleAfterMs: 90000000, status: 'degraded'}
            },
            tenantRepoSync: {repos: [{identityHash: 'cbff435fe549', tenantHash: 'cf744f16ee7f', disabled: false, due: false, nextDueAt: '2026-09-05T13:10:00.000Z'}]}
        }
    }
}

const NEXT_BACKUP_ATTEMPT = new Date(1788626336430).toISOString();

test.describe('fleetTasksSource — the heavy-maintenance queue (#322)', () => {
    test('the live receipt reduces to one starved row per breach — the wait and the cause ride the row, the lease is the section\'s summary, the backup lane is one row', () => {
        const {rows, scheduler} = extractDeploymentRows(starvedPlane()),
              map = byId(rows);

        expect(map['orchestrator:starvation:dream']).toEqual({
            id: 'orchestrator:starvation:dream', section: 'queued', name: 'dream', source: 'orchestrator', state: 'starved',
            at: '2026-09-05T10:05:51.967Z', progress: null, detail: null,
            waitMs: 9824395, thresholdMs: 3600000, checkedAt: '2026-09-05T12:49:36.362Z',
            reasonCode: null, blockingTaskName: null, leaseOwner: null, priorityZero: false, bootstrapCritical: false
        });
        expect(map['orchestrator:starvation:message-concept-harvest']).toMatchObject({state: 'starved', at: '2026-09-05T06:13:43.059Z', waitMs: 23753303});
        expect(map['orchestrator:starvation:kbSync']).toMatchObject({state: 'starved', waitMs: 4823923});

        // the check-time facts live ONCE, on the summary — the older writer sends no leaseStatus, so none is invented
        expect(scheduler).toEqual({
            leaseHolder: 'summary', leaseStatus: null, checkedAt: '2026-09-05T12:49:36.362Z', degradeAfterMs: 3600000,
            posture: 'degraded', starvedTotal: 3, unreadableCount: 0
        });

        // the backup lane: the writer's phase word, the next attempt as its instant, the health codes as its words
        expect(map['orchestrator:maintenance:backup']).toEqual({
            id: 'orchestrator:maintenance:backup', section: 'queued', name: 'Backup lane', source: 'orchestrator',
            state: 'exhausted', at: NEXT_BACKUP_ATTEMPT, progress: null,
            detail: 'off host durability unmet · backup retry exhausted · backup never succeeded · 0 retries remaining'
        });

        expect(rows, 'three starved + the backup lane + one repo').toHaveLength(5)
    });

    test('a breach with a reason code words its own cause from its own fields; the flags ride as words; a nameless breach is skipped', () => {
        const payload = starvedPlane();

        payload.snapshot.heavyMaintenanceStarvation.breaches = [
            {taskName: 'graphlog-compaction', reasonCode: 'heavy-maintenance-backpressure', blockingTaskName: 'core-corpus-projection', leaseOwner: null, priorityZero: true, deferredSince: '2026-09-05T12:05:50.000Z', starvedForMs: 3610000},
            {taskName: 'kbSync', reasonCode: 'heavy-maintenance-lease-held', leaseOwner: 'summary', bootstrapCritical: true, deferredSince: '2026-09-05T11:29:12.439Z', starvedForMs: 4823923, leaseStatus: 'active'},
            {reasonCode: 'heavy-maintenance-lease-held', deferredSince: '2026-09-05T11:00:00.000Z', starvedForMs: 1}
        ];

        const {rows, scheduler} = extractDeploymentRows(payload),
              map = byId(rows);

        expect(map['orchestrator:starvation:graphlog-compaction']).toMatchObject({
            detail: 'heavy-maintenance-backpressure · behind core-corpus-projection · priority zero',
            reasonCode: 'heavy-maintenance-backpressure', blockingTaskName: 'core-corpus-projection', leaseOwner: null, priorityZero: true, bootstrapCritical: false
        });
        expect(map['orchestrator:starvation:kbSync']).toMatchObject({
            detail: 'heavy-maintenance-lease-held · lease owner summary · bootstrap critical',
            reasonCode: 'heavy-maintenance-lease-held', leaseOwner: 'summary', blockingTaskName: null, bootstrapCritical: true
        });
        expect(rows.filter(row => row.state === 'starved')).toHaveLength(2);
        expect(scheduler.starvedTotal, 'the nameless entry is not a breach the pane can name').toBe(2)
    });

    test('no receipt → no starved rows and no summary; a disabled watchdog reduces to none even with breaches on the wire', () => {
        const absent = starvedPlane();

        delete absent.snapshot.heavyMaintenanceStarvation;

        const withoutBlock = extractDeploymentRows(absent);

        expect(withoutBlock.rows.filter(row => row.state === 'starved')).toHaveLength(0);
        expect(withoutBlock.scheduler).toBeNull();

        const disabled = starvedPlane();

        disabled.snapshot.heavyMaintenanceStarvation.posture = 'disabled';

        const off = extractDeploymentRows(disabled);

        expect(off.rows.filter(row => row.state === 'starved')).toHaveLength(0);
        expect(off.scheduler).toBeNull()
    });

    test('control (a): a fresh envelope with the same watchdog stamp reduces to identical rows, summary and counts — only the snapshot\'s own instant moved', () => {
        const later = starvedPlane();

        later.snapshot.generatedAt += 60_000;

        const first  = extractDeploymentRows(starvedPlane()),
              second = extractDeploymentRows(later);

        expect(second.rows).toEqual(first.rows);
        expect(second.scheduler).toEqual(first.scheduler);
        expect(second.observedAt).not.toBe(first.observedAt)
    });

    test('control (b): no active holder keeps the readable breaches and says so; an unknown posture with unreadable entries is a summary that says exactly that, never an empty queue', () => {
        const holderless = starvedPlane();

        holderless.snapshot.heavyMaintenanceStarvation.leaseHolder = null;

        const degraded = extractDeploymentRows(holderless);

        expect(degraded.rows.filter(row => row.state === 'starved')).toHaveLength(3);
        expect(degraded.scheduler).toMatchObject({leaseHolder: null, posture: 'degraded', starvedTotal: 3});

        const unreadable = starvedPlane();

        Object.assign(unreadable.snapshot.heavyMaintenanceStarvation, {posture: 'unknown', breaches: [], unreadableCount: 2, leaseHolder: null});

        const unknown = extractDeploymentRows(unreadable);

        expect(unknown.rows.filter(row => row.state === 'starved')).toHaveLength(0);
        expect(unknown.scheduler).toEqual({
            leaseHolder: null, leaseStatus: null, checkedAt: '2026-09-05T12:49:36.362Z', degradeAfterMs: 3600000,
            posture: 'unknown', starvedTotal: 0, unreadableCount: 2
        })
    });

    test('the backup lane is visible without an instant: a never-anchored lane and an unreachable receipt keep their state and reasons under the queue with a null instant — no next attempt or completion is invented', () => {
        const unanchored = starvedPlane();

        // the writer's shape for a lane that never succeeded: no retry window open, no success to anchor to
        unanchored.snapshot.maintenance = {
            retry : {interruptedAt: null, lastSuccessAgeMs: null, lastSuccessAt: null, nextAttemptAtMs: null, retriesRemaining: null, streakStartedAtMs: null, windowEndsAtMs: null, phase: 'unanchored'},
            health: {observationStatus: 'observed', reasonCodes: ['backup-never-succeeded'], staleAfterMs: 90000000, status: 'pending'}
        };

        expect(byId(extractDeploymentRows(unanchored).rows)['orchestrator:maintenance:backup']).toEqual({
            id: 'orchestrator:maintenance:backup', section: 'queued', name: 'Backup lane', source: 'orchestrator',
            state: 'unanchored', at: null, progress: null, detail: 'backup never succeeded'
        });

        // the observer could not reach the receipt: the writer's own shape carries no instant at all
        const unreachable = starvedPlane();

        unreachable.snapshot.maintenance = {
            lastBackup: {finishedAt: null, kind: 'enoent', status: 'unreachable'},
            health    : {observationStatus: 'partial', reasonCodes: ['backup-receipt-unreachable'], staleAfterMs: null, status: 'degraded'}
        };

        expect(byId(extractDeploymentRows(unreachable).rows)['orchestrator:maintenance:backup']).toEqual({
            id: 'orchestrator:maintenance:backup', section: 'queued', name: 'Backup lane', source: 'orchestrator',
            state: 'degraded', at: null, progress: null, detail: 'backup receipt unreachable'
        });

        // a receipt alone, with neither a phase nor a verdict: the receipt's own word is the state
        const receiptOnly = starvedPlane();

        receiptOnly.snapshot.maintenance = {lastBackup: {finishedAt: null, kind: 'eacces', status: 'unreachable'}};

        expect(byId(extractDeploymentRows(receiptOnly).rows)['orchestrator:maintenance:backup']).toMatchObject({section: 'queued', state: 'unreachable', at: null, detail: null})
    });

    test('controls: absent maintenance → no backup row; a dated success with nothing scheduled → ONE recent row at the bundle\'s instant', () => {
        const absent = starvedPlane();

        delete absent.snapshot.maintenance;
        expect(byId(extractDeploymentRows(absent).rows)['orchestrator:maintenance:backup']).toBeUndefined();

        const healthy = starvedPlane();

        healthy.snapshot.maintenance = {
            retry     : {interruptedAt: null, lastSuccessAgeMs: 3600000, lastSuccessAt: '2026-09-05T11:49:36.362Z', nextAttemptAtMs: null, retriesRemaining: null, streakStartedAtMs: null, windowEndsAtMs: null, phase: 'healthy'},
            lastBackup: {backup: {durationMs: 149102, error: null, status: 'success'}, bundleCompletedAt: '2026-09-05T11:49:36.100Z', bundleName: 'backup-2026-09-05T11-47-07.000Z', finishedAt: '2026-09-05T11:49:36.362Z', schemaVersion: 1},
            health    : {observationStatus: 'observed', reasonCodes: [], staleAfterMs: 90000000, status: 'healthy'}
        };

        const {rows} = extractDeploymentRows(healthy);

        expect(rows.filter(row => row.id === 'orchestrator:maintenance:backup')).toHaveLength(1);
        expect(byId(rows)['orchestrator:maintenance:backup']).toEqual({
            id: 'orchestrator:maintenance:backup', section: 'recent', name: 'Backup lane', source: 'orchestrator',
            state: 'healthy', at: '2026-09-05T11:49:36.362Z', progress: null, detail: null
        })
    });

    test('no path, prose, bundle name, residue figure or tenant identifier crosses the wire', () => {
        const text = JSON.stringify(extractDeploymentRows(starvedPlane()));

        for (const bait of ['This cloud deployment', 'backup-2026-09-04', 'stagingResidue', 'stderrTail', '2289510815', 'cf744f16ee7f', 'tenantHash', '/app']) {
            expect(text, bait).not.toContain(bait)
        }
    })
});

test.describe('fleetTasksSource — extractRemRows', () => {
    /**
     * @summary The producer's shape verbatim (`HealthService.buildRemPipelineState`): completed-cycle
     * summaries with a duration and an outcome — no instant, no active flag.
     * @returns {Object}
     */
    const remState = () => ({
        undigested: 960, digested: 1040, sessionNodes: 4166, topologyConflicts: 0,
        recentCycles: [
            {runId: 'rem-2026-08-22T12-00-00', wallClockMs: 48210, cycleOverflowSignal: false, cycleOverflowRatio: 0.31, outcome: 'completed'},
            {runId: 'rem-2026-08-22T11-30-00', wallClockMs: 51002, cycleOverflowSignal: true,  cycleOverflowRatio: 1.08, outcome: 'overflow'}
        ]
    });

    test('the digest backlog is ONE queue fact under the backlog word — never a running claim, never a time, the latest outcome as detail', () => {
        expect(extractRemRows(remState())).toEqual({
            rows: [{
                id: 'mc:rem:digest', section: 'queued', name: 'REM digest', source: 'mc', state: 'backlog', at: null,
                progress: {kind: 'backlog', done: 1040, total: 2000}, detail: '960 undigested · 1040 digested · last cycle completed'
            }],
            state : 'wired',
            reason: null
        })
    });

    test('no cycles → the gauge alone', () => {
        const [row] = extractRemRows({undigested: 5, digested: 10, recentCycles: []}).rows;

        expect(row).toMatchObject({section: 'queued', state: 'backlog', at: null, detail: '5 undigested · 10 digested'})
    });

    test('axisErrors red control: a failed count axis falls back to 0 upstream — here it is the typed unavailable axis, never a wired "0 undigested"', () => {
        const state  = {...remState(), undigested: 0, axisErrors: {undigested: new Error('graph read timed out Authorization: Bearer sk-live-AAAABBBB1234')}},
              result = extractRemRows(state);

        expect(result.rows).toEqual([]);
        expect(result.state).toBe('unavailable');
        expect(result.reason).toBe('rem-axis-error');
        expect(result.detail).toContain('undigested:');
        expect(result.detail).toContain('[redacted]');
        expect(result.detail).not.toContain('sk-live-AAAABBBB1234')
    });

    test('an axisError on a non-count axis (recentCycles) does not veto the gauge', () => {
        const state = {...remState(), recentCycles: [], axisErrors: {recentCycles: new Error('run-state dir unreadable')}};

        expect(extractRemRows(state)).toMatchObject({state: 'wired'});
        expect(extractRemRows(state).rows[0]).toMatchObject({detail: '960 undigested · 1040 digested'})
    });

    test('a fully digested corpus renders no gauge (a zero total is not a fraction)', () => {
        const [row] = extractRemRows({undigested: 0, digested: 0, recentCycles: []}).rows;

        expect(row.progress).toBeNull()
    });

    test('an unrecognized payload is the typed unavailable axis', () => {
        expect(extractRemRows({})).toEqual({rows: [], state: 'unavailable', reason: 'rem-payload-unrecognized'});
        expect(extractRemRows(null).state).toBe('unavailable')
    })
});

test.describe('fleetTasksSource — extractIngestionRows', () => {
    test('an active run is a RUNNING row with a determinate fraction and its scope as detail', () => {
        const {rows, state, scope} = extractIngestionRows({
            status: 'running', active: true, phase: 'embedding', observedScope: 'this-process-only', stalled: false,
            startedAt: '2026-08-22T12:25:00.000Z', totalChunks: 400, embeddedChunks: 100
        });

        expect(state).toBe('wired');
        expect(scope).toBe('this-process-only');
        expect(rows).toEqual([{
            id: 'kb:ingestion:run', section: 'running', name: 'KB ingestion', source: 'kb', state: 'embedding',
            at: '2026-08-22T12:25:00.000Z', progress: {kind: 'determinate', done: 100, total: 400}, detail: 'this-process-only'
        }])
    });

    test('a stalled run earns the wedged WORD, not a hue', () => {
        const [row] = extractIngestionRows({status: 'running', active: true, phase: 'embedding', stalled: true, totalChunks: 10, embeddedChunks: 3}).rows;

        expect(row.state).toBe('stalled')
    });

    test('an idle process contributes its last run as a RECENT row — and never its tenant identifiers', () => {
        const result = extractIngestionRows(idleIngestion());

        expect(result.rows).toEqual([{
            id: 'kb:ingestion:last', section: 'recent', name: 'KB ingestion', source: 'kb', state: 'completed_with_errors',
            at: '2026-08-22T12:24:32.967Z', progress: null, detail: '0 chunks · 1 errors · this-process-only'
        }]);

        const text = JSON.stringify(result);

        expect(text).not.toContain('tenant-alpha');
        expect(text).not.toContain('secret-repo')
    });

    test('an unrecognized payload is the typed unavailable axis', () => {
        expect(extractIngestionRows({})).toEqual({rows: [], state: 'unavailable', reason: 'ingestion-payload-unrecognized', scope: null})
    })
});

test.describe('fleetTasksSource — createFleetTasksSource', () => {
    function harness({
        viewer     = '@neo-fable-clio',
        deployment = () => deploymentPayload(),
        rem        = () => ({undigested: 960, digested: 1040, recentCycles: []}),
        ingestion  = undefined
    } = {}) {
        const calls = [];

        const wrap = (label, fn) => async args => {
            calls.push([label, args]);

            const value = fn();

            if (value instanceof Error) throw value;

            return value
        };

        const source = createFleetTasksSource({
            getDeploymentStateSnapshot: wrap('deployment', deployment),
            getRemPipelineState       : wrap('rem', rem),
            ...(ingestion ? {getIngestionProgress: wrap('ingestion', ingestion)} : {}),
            resolveViewerIdentity     : () => viewer,
            now                       : () => new Date(NOW)
        });

        return {calls, source}
    }

    test('requires its operations and the viewer resolver', () => {
        expect(() => createFleetTasksSource({})).toThrow(/getDeploymentStateSnapshot, getRemPipelineState, resolveViewerIdentity, and now are required/);
        expect(() => createFleetTasksSource({
            getDeploymentStateSnapshot: async () => ({}), getRemPipelineState: async () => ({}), resolveViewerIdentity: () => '@a', getIngestionProgress: 'nope'
        })).toThrow(/getIngestionProgress must be a function/)
    });

    test('every axis answered → a wired envelope, ordered and capped sections, the viewer stamped', async () => {
        const {calls, source} = harness({ingestion: () => idleIngestion()}),
              envelope        = await source.readTasks();

        expect(envelope.capability).toEqual({state: 'wired', capturedAt: NOW});
        expect(envelope.viewer).toBe('@neo-fable-clio');
        expect(envelope.sources).toEqual({
            deployment: {state: 'wired', reason: null, observedAt: '2026-08-22T12:29:30.000Z'},
            rem       : {state: 'wired', reason: null},
            ingestion : {state: 'wired', reason: null, scope: 'this-process-only'}
        });

        // queued soonest-first: the due repo, the backup lane at its next attempt, the later repo,
        // then the instant-less backlog gauge sinks to the end
        expect(envelope.queued.map(row => row.id)).toEqual([
            'orchestrator:tenant-sync:cbff435fe549',
            'orchestrator:maintenance:backup',
            'orchestrator:tenant-sync:ba41470c1d2e',
            'mc:rem:digest'
        ]);
        // running newest-first, the instant-less freeze last
        expect(envelope.running.map(row => row.id)).toEqual([
            'orchestrator:recovery:recovery-actuator:mc-server:restart:2026-08-22T12:20:00.000Z',
            'orchestrator:self-heal:frozen:turns'
        ]);
        // recent newest-first
        expect(envelope.recent.map(row => row.id)).toEqual([
            'kb:ingestion:last',
            'orchestrator:tenant-sync:last',
            'orchestrator:recovery:recovery-actuator:backup:record:2026-08-21T12:58:37.764Z'
        ]);
        expect(envelope.counts).toEqual({running: 2, queued: 4, recent: 3, queuedKnown: 4});

        // the operations receive no viewer claim — an empty argument object each
        expect(calls).toEqual([['deployment', {}], ['rem', {}], ['ingestion', {}]])
    });

    test('an absent ingestion operation is the typed unwired axis and does NOT degrade the envelope', async () => {
        const {source}  = harness(),
              envelope  = await source.readTasks();

        expect(envelope.capability.state).toBe('wired');
        expect(envelope.sources.ingestion).toEqual({state: 'unwired', reason: 'ingestion-verb-unreachable-from-this-process', scope: null});
        expect(envelope.recent.map(row => row.id)).not.toContain('kb:ingestion:last')
    });

    test('a DEGRADED deployment envelope still counts as ANSWERED at the fold: capability stays wired, the axis carries its own word, the rows survive', async () => {
        const {source}  = harness({deployment: () => ({...deploymentPayload(), ok: false, status: 'degraded', reason: 'missing-sections'})}),
              envelope  = await source.readTasks();

        expect(envelope.capability.state, 'degraded is a retained-snapshot measurement, not a failure').toBe('wired');
        expect(envelope.sources.deployment).toMatchObject({state: 'degraded', reason: null});
        expect(envelope.queued.map(row => row.id)).toContain('orchestrator:tenant-sync:cbff435fe549')
    });

    test('a throwing axis is partial — its reason and a redacted detail ride the envelope, its rows are absent', async () => {
        const {source}  = harness({rem: () => new Error('plane get_rem_pipeline_state failed: Authorization: Bearer sk-live-AAAABBBB1234 rejected')}),
              envelope  = await source.readTasks();

        expect(envelope.capability.state).toBe('partial');
        expect(envelope.sources.rem.state).toBe('unavailable');
        expect(envelope.sources.rem.reason).toBe('rem-read-failed');
        expect(envelope.sources.rem.detail).toContain('[redacted]');
        expect(envelope.sources.rem.detail).not.toContain('sk-live-AAAABBBB1234');
        expect(envelope.queued.map(row => row.id)).not.toContain('mc:rem:digest');
        expect(envelope.sources.deployment.state).toBe('wired')
    });

    test('no axis answered → unavailable with its own reason, every section empty', async () => {
        const {source}  = harness({deployment: () => new Error('boom'), rem: () => new Error('boom')}),
              envelope  = await source.readTasks();

        expect(envelope.capability).toEqual({state: 'unavailable', capturedAt: NOW, reason: 'no-task-source-answered'});
        expect(envelope.running).toEqual([]);
        expect(envelope.queued).toEqual([]);
        expect(envelope.recent).toEqual([]);
        expect(envelope.counts).toEqual({running: 0, queued: 0, recent: 0, queuedKnown: 0});
        expect(envelope.scheduler, 'no receipt answered → no summary key at all').toBeUndefined()
    });

    test('a section is capped at twelve rows — a glance, not a dump', async () => {
        const payload = deploymentPayload();

        payload.snapshot.recoveryRuns.entries = Array.from({length: 15}, (_, index) => ({
            recoveryRunId: `run-${index}`, status: 'recorded', targetIdentity: {kind: 'service', id: `svc-${index}`},
            completedAt: Date.parse('2026-08-22T12:00:00.000Z') + index * 1000
        }));

        const {source}  = harness({deployment: () => payload}),
              envelope  = await source.readTasks();

        // 15 recoveries + the sweep's last completion = 16 candidates, capped to 12, newest first:
        // the 12:11 sweep completion outranks the 12:00:14 newest recovery
        expect(envelope.recent).toHaveLength(12);
        expect(envelope.recent[0].id, 'newest first').toBe('orchestrator:tenant-sync:last');
        expect(envelope.recent[1].id).toBe('orchestrator:recovery:run-14');
        expect(envelope.recent.at(-1).id, 'the oldest survivors are cut').toBe('orchestrator:recovery:run-4')
    });

    test('the queue counts say known and shown, the scheduler summary rides the envelope, and starved rows lead the queue longest-wait-first', async () => {
        const {source}  = harness({deployment: () => starvedPlane()}),
              envelope  = await source.readTasks();

        expect(envelope.scheduler).toMatchObject({leaseHolder: 'summary', posture: 'degraded', starvedTotal: 3});
        // three starved + the backup lane + one repo + the REM digest backlog: all known, all shown
        expect(envelope.counts).toEqual({running: 0, queued: 6, recent: 0, queuedKnown: 6});
        expect(envelope.queued.slice(0, 3).map(row => row.id)).toEqual([
            'orchestrator:starvation:message-concept-harvest',
            'orchestrator:starvation:dream',
            'orchestrator:starvation:kbSync'
        ]);
        expect(envelope.queued[3].id, 'the due repo follows the waiters').toBe('orchestrator:tenant-sync:cbff435fe549');
        expect(envelope.queued[4].id, 'the backup lane at its next attempt').toBe('orchestrator:maintenance:backup')
    });

    test('the per-section cap keeps the longest-starved rows and the counts name the omission: queuedKnown − queued', async () => {
        const payload = starvedPlane();

        payload.snapshot.heavyMaintenanceStarvation.breaches = Array.from({length: 15}, (_, index) => ({
            taskName: `starved-${String(index).padStart(2, '0')}`, priorityZero: false, bootstrapCritical: false,
            deferredSince: new Date(Date.parse('2026-09-05T00:00:00.000Z') + index * 60_000).toISOString(), starvedForMs: (15 - index) * 3_600_000
        }));

        const {source} = harness({deployment: () => payload}),
              envelope = await source.readTasks();

        // 15 breaches + the backup lane + one repo + the REM backlog = 18 known, 12 shown
        expect(envelope.counts).toEqual({running: 0, queued: 12, recent: 0, queuedKnown: 18});
        expect(envelope.counts.queuedKnown - envelope.counts.queued, 'the omission is readable from the counts').toBe(6);
        expect(envelope.queued.every(row => row.state === 'starved'), 'the blocked rows take the glance').toBe(true);
        expect(envelope.queued[0].id, 'longest wait first').toBe('orchestrator:starvation:starved-00');
        expect(envelope.queued.at(-1).id).toBe('orchestrator:starvation:starved-11');
        expect(envelope.scheduler.starvedTotal, 'the summary counts before the cap').toBe(15);
        expect(envelope.queued.every(row => ['orchestrator', 'mc', 'kb'].includes(row.source))).toBe(true)
    });

    test('blocked-first is display priority, never chronology: one waiter deferred AFTER twelve older due repos still leads the queue and survives the cap', async () => {
        const payload = starvedPlane();

        // twelve ordinary rows, every one of them due BEFORE the waiter's own instant
        payload.snapshot.tenantRepoSync = {repos: Array.from({length: 12}, (_, index) => ({
            identityHash: `${String(index).padStart(2, '0')}cafe0000ab`, disabled: false, due: true, nextDueAt: '2026-09-05T09:00:00.000Z'
        }))};
        payload.snapshot.heavyMaintenanceStarvation.breaches = [
            {taskName: 'dream', priorityZero: false, bootstrapCritical: false, deferredSince: '2026-09-05T10:00:00.000Z', starvedForMs: 7200000, leaseHolder: 'summary'}
        ];
        delete payload.snapshot.maintenance;

        const {source} = harness({deployment: () => payload}),
              envelope = await source.readTasks();

        // twelve repos + the waiter + the REM backlog = 14 known, 12 shown — the waiter is never the one cut
        expect(envelope.counts).toEqual({running: 0, queued: 12, recent: 0, queuedKnown: 14});
        expect(envelope.scheduler.starvedTotal).toBe(1);
        expect(envelope.queued[0].id, 'the blocked row leads although every repo row is older').toBe('orchestrator:starvation:dream');
        expect(envelope.queued.slice(1).every(row => row.state === 'due'), 'the ordinary rows follow, soonest first').toBe(true)
    });

    test('an ingress that bound no canonical viewer is refused, never defaulted', async () => {
        const {source} = harness({viewer: 'operator'});

        await expect(source.readTasks()).rejects.toThrow(/did not bind a canonical viewer identity/)
    })
});
