import {setup} from '../../../../../setup.mjs';

const appName = 'TaskExpirySweepTest';

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

import {test, expect}  from '@playwright/test';
import Neo             from 'neo.mjs/src/Neo.mjs';
import * as core       from 'neo.mjs/src/core/_export.mjs';
import GraphService    from '../../../../../../../ai/services/memory-core/GraphService.mjs';
import {Orchestrator}  from '../../../../../../../ai/daemons/orchestrator/Orchestrator.mjs';
import {TASK_REGISTRY} from '../../../../../../../ai/daemons/orchestrator/scheduling/registry.mjs';
import {
    buildSchedulingContext,
    executeCandidate,
    runSchedulingPipeline
} from '../../../../../../../ai/daemons/orchestrator/scheduling/pipeline.mjs';
import {
    CONTINUOUS_TASK_REGISTRY,
    ORCHESTRATOR_AUTHORITY_CLASS,
    ORCHESTRATOR_AUTHORITY_PROFILE,
    TARGET_ORCHESTRATOR_AUTHORITY_PROFILES,
    auditAuthorityTopology,
    buildAuthorityLaneInventory,
    buildAuthorityReceipt,
    getTaskAuthorityClass
} from '../../../../../../../ai/daemons/orchestrator/taskAuthority.mjs';

/**
 * @summary Unit coverage for the `task-expiry-sweep` lane: the container plane owns the
 * Task expiry sweep, runs it on its own cadence without the heavy-maintenance lease, and records a
 * run that fails, including the one where the graph is missing and the sweep alone would report success.
 */

const LANE       = 'task-expiry-sweep';
const CADENCE_MS = 10 * 60 * 1000;
const descriptor = TASK_REGISTRY.find(entry => entry.taskName === LANE);

/**
 * @param {Object} options
 * @param {Function} options.sweepExpiredTasks The lane's sweep.
 * @returns {Object} Services, runtime, the records the fakes keep, and a promise for the run's end.
 */
function makeLaneHarness({sweepExpiredTasks}) {
    const records = {completed: [], failed: [], leases: 0, logs: [], outcomes: []};
    let   settle;
    const settled = new Promise(resolve => { settle = resolve });

    return {
        records,
        settled,
        runtime : {writeLog: (level, message) => records.logs.push({level, message})},
        services: {
            healthService: {
                recordTaskOutcome: (taskName, status, details) => records.outcomes.push({taskName, status, details})
            },
            maintenanceBackpressureService: {
                acquireLeaseAndExecute       : () => { records.leases++ },
                getActiveHeavyMaintenanceTask: () => null,
                isHeavyMaintenanceTask       : () => false,
                recordDeferral               : () => {}
            },
            taskStateService: {
                getTaskState : () => ({}),
                markStarted  : () => {},
                markCompleted: (taskName, details) => { records.completed.push({taskName, details}); settle() },
                markFailed   : (taskName, code)    => { records.failed.push({taskName, code}); settle() },
                markSkipped  : () => {}
            },
            sweepExpiredTasks
        }
    };
}

test.describe('task-expiry-sweep lane (#1679)', () => {
    test('the lane is due once per cadence and off at a cadence of 0', () => {
        expect(descriptor).toMatchObject({executionKind: 'in-process-async', maintenanceClass: 'lightweight-signal', backpressure: 'none'});

        const due = ({lastRunAt, now, cadence = CADENCE_MS}) => descriptor.getDueTask({
            state    : lastRunAt === undefined ? {} : {[LANE]: {lastRunAt}},
            now,
            intervals: {taskExpirySweep: cadence}
        });

        const now = Date.parse('2026-11-13T20:00:00.000Z');

        expect(due({now})).toEqual({
            taskName: LANE,
            source  : 'periodic-task-expiry-sweep',
            reason  : `periodic-task-expiry-sweep:${CADENCE_MS}`
        });
        expect(due({lastRunAt: now, now: now + CADENCE_MS - 1})).toBeNull();
        expect(due({lastRunAt: now, now: now + CADENCE_MS})).not.toBeNull();
        expect(due({now, cadence: 0})).toBeNull();
    });

    test('AC-1 + AC-4: the authority audit and both receipts name the lane as container-plane work with one owner', () => {
        expect(getTaskAuthorityClass(LANE)).toBe(ORCHESTRATOR_AUTHORITY_CLASS.containerPlane);

        const ownership = auditAuthorityTopology({
            lanes   : buildAuthorityLaneInventory({continuousRegistry: CONTINUOUS_TASK_REGISTRY, scheduledRegistry: TASK_REGISTRY}),
            profiles: TARGET_ORCHESTRATOR_AUTHORITY_PROFILES
        });

        expect(ownership.find(entry => entry.task === LANE)).toEqual({
            task          : LANE,
            kind          : 'scheduled',
            authorityClass: 'container-plane',
            effectiveOwner: 'container-plane'
        });

        const receiptTask = profile => buildAuthorityReceipt({
            profile,
            continuousRegistry: CONTINUOUS_TASK_REGISTRY,
            scheduledRegistry : TASK_REGISTRY
        }).tasks.find(entry => entry.task === LANE);

        expect(receiptTask(ORCHESTRATOR_AUTHORITY_PROFILE.containerPlane)).toMatchObject({authorityClass: 'container-plane', effectiveOwner: 'container-plane', active: true});
        expect(receiptTask(ORCHESTRATOR_AUTHORITY_PROFILE.hostEdge)).toMatchObject({authorityClass: 'container-plane', effectiveOwner: 'container-plane', active: false});
    });

    test('AC-2: one pipeline run moves a Task past its expiresAt to Expired and records the count', async () => {
        await GraphService.ready();

        const taskId = `MESSAGE:task-expiry-sweep-spec-${Date.now()}`;

        GraphService.upsertNode({
            id        : taskId,
            type      : 'MESSAGE',
            properties: {
                from   : '@task-expiry-sweep-spec-a',
                to     : '@task-expiry-sweep-spec-b',
                subject: 'an ask whose deadline passed',
                task   : {state: 'Submitted', assignee: '@task-expiry-sweep-spec-b', expiresAt: '2020-01-01T00:00:00Z'}
            }
        });

        const readState = () => GraphService.db.storage.db.prepare(
            `SELECT json_extract(data, '$.properties.task.state') AS state FROM Nodes WHERE id = ?`
        ).get(taskId)?.state;

        expect(readState()).toBe('Submitted');

        const harness = makeLaneHarness({sweepExpiredTasks: () => Orchestrator.prototype.sweepExpiredTasks.call(null)});

        const {winner} = runSchedulingPipeline({
            registry: [descriptor],
            context : buildSchedulingContext({db: {}, state: {}, now: Date.now(), intervals: {taskExpirySweep: CADENCE_MS}, enables: {}, hooks: {}}),
            services: harness.services,
            runtime : harness.runtime
        });

        expect(winner?.taskName).toBe(LANE);
        await harness.settled;

        expect(readState()).toBe('Expired');
        expect(GraphService.db.nodes.get(taskId).properties.task.state).toBe('Expired');
        expect(harness.records.failed).toEqual([]);
        expect(harness.records.completed[0].details.sweptCount).toBeGreaterThanOrEqual(1);
        expect(harness.records.logs.some(({level, message}) => level === 'INFO' && message.includes('task-expiry-sweep'))).toBe(true);
        expect(harness.records.leases).toBe(0);
    });

    test('AC-2: a throwing sweep is recorded on the lane as failed and reaches no caller', async () => {
        const harness = makeLaneHarness({sweepExpiredTasks: async () => { throw new Error('graph locked') }});

        await expect(executeCandidate({
            candidate      : {taskName: LANE, descriptor, trigger: {reason: 'spec'}},
            activeHeavyTask: {name: null},
            services       : harness.services,
            runtime        : harness.runtime
        })).resolves.toBeUndefined();

        expect(harness.records.failed).toEqual([{taskName: LANE, code: 1}]);
        expect(harness.records.outcomes.at(-1)).toMatchObject({taskName: LANE, status: 'failed', details: {error: 'graph locked'}});
        expect(harness.records.leases).toBe(0);
    });

    test('Orchestrator#sweepExpiredTasks throws without a graph, where the sweep alone reports success', async () => {
        await GraphService.ready();

        const db = GraphService.db;
        GraphService.db = null;

        try {
            await expect(Orchestrator.prototype.sweepExpiredTasks.call(null))
                .rejects.toThrow('[Orchestrator.sweepExpiredTasks] GraphService unavailable');
        } finally {
            GraphService.db = db;
        }
    });
});
