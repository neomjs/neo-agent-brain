import {test, expect} from '@playwright/test';
import fs             from 'fs-extra';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    clearWaiterSync,
    findWaiterToYieldTo,
    listActiveWaitersSync,
    registerWaiterSync,
    resolveWaitersDir
} from '../../../../../../../ai/daemons/orchestrator/services/heavyMaintenanceWaiterLedger.mjs';
import {
    DEFAULT_HEAVY_MAINTENANCE_TASK_NAMES,
    MaintenanceBackpressureService,
    WAITER_ENTRY_STALE_AFTER_MS,
    recordDeferral
} from '../../../../../../../ai/daemons/orchestrator/services/MaintenanceBackpressureService.mjs';
import {evaluateWaiterStarvation}   from '../../../../../../../ai/daemons/orchestrator/scheduling/heavyMaintenanceStarvationWatchdog.mjs';
import DeploymentStateBridgeService from '../../../../../../../ai/daemons/orchestrator/services/DeploymentStateBridgeService.mjs';
import {PRIORITY_ZERO_TASKS}        from '../../../../../../../ai/daemons/orchestrator/scheduling/pipeline.mjs';
import {pickNextCandidate}          from '../../../../../../../ai/daemons/orchestrator/scheduling/picker.mjs';

const T0   = Date.parse('2026-08-13T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso  = ms => new Date(ms).toISOString();

function tmpLeasePath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiter-ledger-'));
    return path.join(dir, 'heavy-maintenance-lease.json');
}

    function buildService({leasePath, taskState = {}, acquireResult, dataDir}) {
        const outcomes = [];
        const service  = Neo.create(MaintenanceBackpressureService, {
            heavyMaintenanceTaskNames: DEFAULT_HEAVY_MAINTENANCE_TASK_NAMES,
            writeLog                 : () => {},
            dataDir                  : dataDir ?? null,
            // acquireLeaseAndExecute's fairness gate calls isBootstrapCriticalTask, which kicks
            // the lazy coverage refresh — without this seam these arms would run the real tiered
            // resolver in the background and touch the tenant sync lane's lease guards.
            resolveConfiguredTenantRepoLabelsFn: async () => null,
            healthService                      : {recordTaskOutcome: (name, status, payload) => outcomes.push({name, status, payload})},
            taskStateService                   : {
                getTaskState: name => taskState[name] ?? null,
                markDeferred: name => taskState[name]?.deferralStreakStartedAt ?? null
            },
            acquireLeaseFn: () => acquireResult,
            releaseLeaseFn: () => {}
        });

        service.resolveHeavyMaintenanceLeasePath = () => leasePath;
        return {service, outcomes};
    }

test.describe('Neo.ai.daemons.orchestrator.services.heavyMaintenanceWaiterLedger (#16561)', () => {

    test('register → list roundtrip carries the durable streak, and re-registering refreshes one entry', () => {
        const leasePath = tmpLeasePath();

        registerWaiterSync({leasePath, taskName: 'tenant-repo-sync', deferredSince: iso(T0 - 2 * HOUR), now: T0});
        registerWaiterSync({leasePath, taskName: 'tenant-repo-sync', deferredSince: iso(T0 - 2 * HOUR), now: T0 + 60_000});

        const {waiters, unreadable} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now: T0 + 60_000});

        expect(unreadable).toEqual([]);
        expect(waiters).toHaveLength(1);
        expect(waiters[0]).toMatchObject({
            taskName     : 'tenant-repo-sync',
            priorityZero : false,
            deferredSince: iso(T0 - 2 * HOUR),
            updatedAt    : iso(T0 + 60_000)
        })
    });

    test('a silent waiter expires — a dead process cannot veto acquisitions forever', () => {
        const leasePath = tmpLeasePath();

        registerWaiterSync({leasePath, taskName: 'backup', priorityZero: true, deferredSince: iso(T0 - HOUR), now: T0});

        const fresh = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now: T0 + WAITER_ENTRY_STALE_AFTER_MS});
        const stale = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now: T0 + WAITER_ENTRY_STALE_AFTER_MS + 1});

        expect(fresh.waiters).toHaveLength(1);
        expect(stale.waiters).toHaveLength(0)
    });

    test('clear removes the entry and tolerates absence; a corrupt entry is reported, never thrown', () => {
        const leasePath = tmpLeasePath();

        registerWaiterSync({leasePath, taskName: 'dream', deferredSince: iso(T0), now: T0});
        clearWaiterSync({leasePath, taskName: 'dream'});
        clearWaiterSync({leasePath, taskName: 'dream'});

        fs.writeFileSync(path.join(resolveWaitersDir({leasePath}), 'garbage.json'), '{not json');

        const {waiters, unreadable} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now: T0});

        expect(waiters).toHaveLength(0);
        expect(unreadable).toEqual(['garbage.json'])
    });

    test('an unmeasured wait must not register as a fresh one', () => {
        const leasePath = tmpLeasePath();

        expect(() => registerWaiterSync({leasePath, taskName: 'backup', deferredSince: undefined, now: T0})).toThrow(/durable ISO streak start/);
        expect(() => registerWaiterSync({leasePath, taskName: 'backup', deferredSince: 'not-a-date', now: T0})).toThrow(/durable ISO streak start/)
    });

    test.describe('findWaiterToYieldTo — the fairness decision matrix', () => {
        const bound = 30 * 60 * 1000;

        test('priority-0 waiter beats an ordinary acquirer regardless of streak age', () => {
            const waiters = [{taskName: 'backup', priorityZero: true, deferredSince: iso(T0 - 60_000)}];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})?.taskName).toBe('backup')
        });

        test('an ordinary waiter starving past the bound beats a fresh acquirer', () => {
            const waiters = [{taskName: 'tenant-repo-sync', priorityZero: false, deferredSince: iso(T0 - bound)}];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})?.taskName).toBe('tenant-repo-sync')
        });

        test('the waiter itself proceeds — self-entries never force a yield', () => {
            const waiters = [{taskName: 'tenant-repo-sync', priorityZero: false, deferredSince: iso(T0 - 2 * HOUR)}];

            expect(findWaiterToYieldTo({taskName: 'tenant-repo-sync', waiters, fairnessYieldAfterMs: bound, now: T0})).toBeNull()
        });

        test('an acquirer with the OLDER streak does not yield to a younger starving waiter', () => {
            const waiters = [{taskName: 'summary', priorityZero: false, deferredSince: iso(T0 - bound)}];

            expect(findWaiterToYieldTo({
                taskName: 'tenant-repo-sync', ownDeferredSince: iso(T0 - 2 * HOUR),
                waiters, fairnessYieldAfterMs: bound, now: T0
            })).toBeNull()
        });

        test('fresh same-class waiters do not force a yield — ordinary contention handles peers', () => {
            const waiters = [{taskName: 'summary', priorityZero: false, deferredSince: iso(T0 - 60_000)}];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})).toBeNull()
        });

        test('the OLDEST qualifying waiter wins when several qualify', () => {
            const waiters = [
                {taskName: 'summary',          priorityZero: false, deferredSince: iso(T0 - bound - 1)},
                {taskName: 'tenant-repo-sync', priorityZero: false, deferredSince: iso(T0 - 3 * HOUR)}
            ];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})?.taskName).toBe('tenant-repo-sync')
        });

        test('a bootstrap-critical waiter beats an ordinary acquirer IMMEDIATELY — no starvation bound', () => {
            const waiters = [{taskName: 'tenant-repo-sync', bootstrapCritical: true, deferredSince: iso(T0 - 60_000)}];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})?.taskName).toBe('tenant-repo-sync')
        });

        test('a bootstrap-critical waiter does not preempt a priority-0 acquirer', () => {
            const waiters = [{taskName: 'tenant-repo-sync', bootstrapCritical: true, deferredSince: iso(T0 - 60_000)}];

            expect(findWaiterToYieldTo({taskName: 'backup', priorityZero: true, waiters, fairnessYieldAfterMs: bound, now: T0})).toBeNull()
        });

        // Mixed-rank negatives. The original matrix tested each `outranks*` arm in isolation and
        // every arm was green, but the arms were ORed and then resolved by oldest-wins — so age
        // could promote a LOWER-ranked waiter across the class boundary. Each case below fails
        // against that shape and passes only when rank is evaluated strictly before age.
        test('an ancient ORDINARY waiter never preempts a priority-0 acquirer — age must not cross rank', () => {
            const waiters = [{taskName: 'summary', priorityZero: false, deferredSince: iso(T0 - 12 * HOUR)}];

            expect(findWaiterToYieldTo({
                taskName: 'backup', priorityZero: true,
                waiters, fairnessYieldAfterMs: bound, now: T0
            })).toBeNull()
        });

        test('an ancient ORDINARY waiter never preempts a bootstrap-critical acquirer', () => {
            const waiters = [{taskName: 'summary', priorityZero: false, deferredSince: iso(T0 - 12 * HOUR)}];

            expect(findWaiterToYieldTo({
                taskName: 'tenant-repo-sync', bootstrapCritical: true,
                waiters, fairnessYieldAfterMs: bound, now: T0
            })).toBeNull()
        });

        test('a YOUNGER priority-0 waiter outranks an older ordinary one — rank first, age only within rank', () => {
            const waiters = [
                {taskName: 'summary', priorityZero: false, deferredSince: iso(T0 - 6 * HOUR)},
                {taskName: 'backup',  priorityZero: true,  deferredSince: iso(T0 - 30_000)}
            ];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})?.taskName).toBe('backup')
        });

        test('age still breaks ties WITHIN a rank — oldest of two qualifying priority-0 waiters wins', () => {
            const waiters = [
                {taskName: 'backup',       priorityZero: true, deferredSince: iso(T0 - 60_000)},
                {taskName: 'other-backup', priorityZero: true, deferredSince: iso(T0 - 5 * HOUR)}
            ];

            expect(findWaiterToYieldTo({taskName: 'dream', waiters, fairnessYieldAfterMs: bound, now: T0})?.taskName).toBe('other-backup')
        });

        test('bootstrap-critical acquirer vs bootstrap-critical waiter falls through to the age rule', () => {
            const waiters = [{taskName: 'other-bootstrap', bootstrapCritical: true, deferredSince: iso(T0 - 60_000)}];

            expect(findWaiterToYieldTo({
                taskName: 'tenant-repo-sync', bootstrapCritical: true,
                waiters, fairnessYieldAfterMs: bound, now: T0
            })).toBeNull()
        })
    });

    test.describe('isBootstrapCriticalTask — the durable-manifest predicate', () => {

        function serviceWithManifest(manifest) {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-critical-'));

            if (manifest !== undefined) {
                fs.writeFileSync(path.join(dataDir, 'tenant-repo-sync-revisions.json'), manifest);
            }

            return Neo.create(MaintenanceBackpressureService, {
                dataDir,
                writeLog: () => {},
                // ALWAYS inject the resolver seam. `isBootstrapCriticalTask` kicks a lazy refresh,
                // so a service built without this would run the real tiered resolver in the
                // background — dynamically importing the tenant sync lane and touching its lease
                // guard directories after the test returns, which races other specs' temp-dir
                // teardown. Arms that care about resolution override this explicitly.
                resolveConfiguredTenantRepoLabelsFn: async () => null
            });
        }

        test('an uncheckpointed seeded repo makes tenant sync bootstrap-critical; full checkpoints end it', () => {
            const pending = serviceWithManifest(JSON.stringify({revisions: {
                'a/one': {lastIngestedRev: 'abc123'},
                'a/two': {lastIngestedRev: null}
            }}));
            const complete = serviceWithManifest(JSON.stringify({revisions: {
                'a/one': {lastIngestedRev: 'abc123'},
                'a/two': {lastIngestedRev: 'def456'}
            }}));

            expect(pending.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            expect(pending.isBootstrapCriticalTask('dream')).toBe(false);
            expect(complete.isBootstrapCriticalTask('tenant-repo-sync')).toBe(false);
            pending.destroy();
            complete.destroy()
        });

        test('a corrupt manifest never grants priority — fail-closed on unreadable evidence', () => {
            const corrupt = serviceWithManifest('{not json');

            expect(corrupt.isBootstrapCriticalTask('tenant-repo-sync')).toBe(false);
            corrupt.destroy()
        });

        test('an empty configured set is ordinary even before any manifest exists', () => {
            const service = serviceWithManifest(undefined);

            service.configuredTenantRepoLabels   = [];
            service.configuredTenantRepoLabelsAt = Date.now();

            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(false);
            service.destroy()
        });

        // Configured coverage, not the manifest alone, decides the class. The manifest only records
        // what the sync lane has already seen, so a manifest-only predicate reads "ordinary" in the
        // three states below — including a first deployment, which is when the class matters most.
        function serviceWithCoverage(manifest, labels) {
            const service = serviceWithManifest(manifest);

            // Seed the snapshot directly and stamp it fresh so the throttle suppresses a live
            // resolver call; the refresh path itself is covered by its own arm below.
            service.configuredTenantRepoLabels   = labels;
            service.configuredTenantRepoLabelsAt = Date.now();

            return service
        }

        test('first deployment — configured repos with no manifest at all is bootstrap-critical', () => {
            const service = serviceWithCoverage(undefined, ['a/one', 'a/two']);

            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            service.destroy()
        });

        test('a newly added repo absent from an existing manifest is bootstrap-critical', () => {
            const service = serviceWithCoverage(
                JSON.stringify({revisions: {'a/one': {lastIngestedRev: 'abc123'}}}),
                ['a/one', 'a/two']
            );

            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            service.destroy()
        });

        test('a removed repo\'s stale null entry no longer grants priority', () => {
            const service = serviceWithCoverage(
                JSON.stringify({revisions: {
                    'a/one' : {lastIngestedRev: 'abc123'},
                    'a/gone': {lastIngestedRev: null}
                }}),
                ['a/one']
            );

            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(false);
            service.destroy()
        });

        test('an empty configured set is ordinary even with a stale null-bearing manifest', () => {
            const service = serviceWithCoverage(
                JSON.stringify({revisions: {'a/gone': {lastIngestedRev: null}}}),
                []
            );

            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(false);
            service.destroy()
        });

        test('an unresolved snapshot falls back to the manifest-only predicate', () => {
            const service = serviceWithManifest(JSON.stringify({revisions: {'a/two': {lastIngestedRev: null}}}));

            expect(service.configuredTenantRepoLabels).toBeNull();
            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            service.destroy()
        });

        test('the snapshot refresh populates labels from the canonical resolver seam', async () => {
            const service = serviceWithManifest(JSON.stringify({revisions: {'a/one': {lastIngestedRev: 'abc123'}}}));

            service.resolveConfiguredTenantRepoLabelsFn = async () => ['a/one', 'a/two'];
            // Await the resolver promise rather than counting event-loop turns: tick-counting
            // couples the test to the refresh chain's internal depth.
            await service.ensureConfiguredTenantRepoLabels();

            expect(service.configuredTenantRepoLabels).toEqual(['a/one', 'a/two']);
            // 'a/two' is configured and uncheckpointed, so coverage now grants the class.
            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            service.destroy()
        });

        // The boot boundary. The arms above seed the snapshot or await a tick, which proves the
        // predicate but MASKS the first production decision: on a fresh deployment the snapshot is
        // unresolved at the first pick, and ranking ordinary there hands the heavy lease to a
        // more-stale REM cycle for its full duration — losing the one decision the class exists to
        // win. These two compose the real thing: real service, real async resolver, real absent
        // manifest, no seeding and no setImmediate.
        function bootCandidates() {
            return [
                {taskName: 'dream',            descriptor: {maintenanceClass: 'heavy', dependencies: []}},
                {taskName: 'tenant-repo-sync', descriptor: {maintenanceClass: 'heavy', dependencies: []}}
            ]
        }

        // dream is far more stale, so pure staleness picks dream.
        function bootPolicyContext(service) {
            return {
                now                    : 1_000_000,
                taskMeta               : {dream: {lastRunAt: 0, cadenceMs: 10_000}, 'tenant-repo-sync': {lastRunAt: 990_000, cadenceMs: 10_000}},
                priorityZeroTasks      : PRIORITY_ZERO_TASKS,
                isBootstrapCriticalTask: taskName => service.isBootstrapCriticalTask(taskName)
            }
        }

        test('first scheduling decision after boot ranks tenant sync over more-stale REM', async () => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-boot-'));
            const service = Neo.create(MaintenanceBackpressureService, {
                dataDir,
                writeLog                           : () => {},
                resolveConfiguredTenantRepoLabelsFn: async () => ['a/one']
            });

            // Exactly what Orchestrator.start() does before its first sweep.
            await service.ensureConfiguredTenantRepoLabels();

            const winner = pickNextCandidate({
                candidates   : bootCandidates(),
                runningTasks : [],
                policyContext: bootPolicyContext(service)
            });

            expect(winner.taskName).toBe('tenant-repo-sync');
            service.destroy()
        });

        test('CONTROL — with complete checkpoint coverage the more-stale REM lane wins that same decision', async () => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-boot-covered-'));

            fs.writeFileSync(
                path.join(dataDir, 'tenant-repo-sync-revisions.json'),
                JSON.stringify({revisions: {'a/one': {lastIngestedRev: 'abc123'}}})
            );

            const service = Neo.create(MaintenanceBackpressureService, {
                dataDir,
                writeLog                           : () => {},
                resolveConfiguredTenantRepoLabelsFn: async () => ['a/one']
            });

            await service.ensureConfiguredTenantRepoLabels();

            const winner = pickNextCandidate({
                candidates   : bootCandidates(),
                runningTasks : [],
                policyContext: bootPolicyContext(service)
            });

            // Establishes the arm above is not vacuous: staleness genuinely favours dream here.
            expect(winner.taskName).toBe('dream');
            service.destroy()
        });

        test('an expired coverage snapshot cannot dispatch REM while a canonical refresh discovers a new repo', async () => {
            const service = serviceWithManifest(JSON.stringify({revisions: {
                'a/one': {lastIngestedRev: 'abc123'}
            }}));

            // The last-known snapshot is complete but stale. The canonical resolver now exposes a
            // newly configured repo whose first checkpoint does not exist yet.
            service.configuredTenantRepoLabels           = ['a/one'];
            service.configuredTenantRepoLabelsAt         = 0;
            service.resolveConfiguredTenantRepoLabelsFn = async () => ['a/one', 'a/two'];

            const winner = pickNextCandidate({
                candidates   : bootCandidates(),
                runningTasks : [],
                policyContext: bootPolicyContext(service)
            });

            // The synchronous picker cannot await the canonical refresh. It must therefore fail
            // safe for THIS decision instead of handing the only heavy slot to more-stale REM.
            expect(winner.taskName).toBe('tenant-repo-sync');

            await service.ensureConfiguredTenantRepoLabels();
            expect(service.configuredTenantRepoLabels).toEqual(['a/one', 'a/two']);
            service.destroy()
        });

        test('an unresolved snapshot with no manifest fails SAFE — cannot prove the plane is initialized', () => {
            const service = serviceWithManifest(undefined);

            service.resolveConfiguredTenantRepoLabelsFn = () => new Promise(() => {}); // never settles

            expect(service.configuredTenantRepoLabels).toBeNull();
            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            service.destroy()
        });

        test('ensureConfiguredTenantRepoLabels is single-flight — concurrent callers share one resolver call', async () => {
            const service = serviceWithManifest(undefined);
            let   calls   = 0;

            service.resolveConfiguredTenantRepoLabelsFn = async () => { calls++; return ['a/one'] };

            const [a, b] = await Promise.all([
                service.ensureConfiguredTenantRepoLabels(),
                service.ensureConfiguredTenantRepoLabels()
            ]);

            expect(calls).toBe(1);
            expect(a).toEqual(['a/one']);
            expect(b).toEqual(['a/one']);
            service.destroy()
        });

        test('a failing resolver keeps the previous snapshot instead of downgrading coverage', async () => {
            const service = serviceWithCoverage(undefined, ['a/one']);

            service.resolveConfiguredTenantRepoLabelsFn = async () => { throw new Error('resolver down') };
            service.configuredTenantRepoLabelsAt        = 0;
            // Must not reject: boot awaits this call, so a resolver outage cannot block startup.
            await service.ensureConfiguredTenantRepoLabels();

            expect(service.configuredTenantRepoLabels).toEqual(['a/one']);
            expect(service.isBootstrapCriticalTask('tenant-repo-sync')).toBe(true);
            service.destroy()
        })
    });

    test('drift tripwire: the service priority-class mirror equals the scheduling module truth', () => {
        const service = Neo.create(MaintenanceBackpressureService, {writeLog: () => {}});

        expect([...service.priorityZeroTaskNames].sort()).toEqual([...PRIORITY_ZERO_TASKS].sort());
        service.destroy()
    });

    test('module recordDeferral returns the outcome payload carrying the durable streak', () => {
        const payload = recordDeferral({
            deferralLogKeys : new Set(),
            taskName        : 'tenant-repo-sync',
            reasonCode      : 'heavy-maintenance-lease-held',
            reasonText      : 'scheduled',
            holdingLease    : {owner: 'dream', pid: 1},
            taskStateService: {markDeferred: () => iso(T0 - 2 * HOUR)}
        });

        expect(payload.deferredSince).toBe(iso(T0 - 2 * HOUR));
        expect(payload.holdingOwner).toBe('dream')
    });

    test.describe('acquireLeaseAndExecute integration — the gate at the single acquisition point', () => {

        test('an acquirer yields to a registered starving waiter and records the deferral', () => {
            const leasePath = tmpLeasePath();

            registerWaiterSync({leasePath, taskName: 'tenant-repo-sync', deferredSince: iso(Date.now() - 2 * HOUR), now: Date.now()});

            const {service, outcomes} = buildService({leasePath, acquireResult: {acquired: true, lease: {token: 't1'}}});
            const executed            = [];

            const result = service.acquireLeaseAndExecute({
                taskName       : 'dream',
                executeFn      : name => { executed.push(name); return true; },
                reason         : 'scheduled',
                activeHeavyTask: {name: null}
            });

            expect(result).toBe(false);
            expect(executed).toEqual([]);
            expect(outcomes.some(o => o.payload?.reasonCode === 'heavy-maintenance-yield-to-waiter' && o.payload?.blockingTaskName === 'tenant-repo-sync')).toBe(true);
            service.destroy()
        });

        test('the starving waiter itself acquires, runs, and its ledger entry clears', () => {
            const leasePath = tmpLeasePath();
            const since     = iso(Date.now() - 2 * HOUR);

            registerWaiterSync({leasePath, taskName: 'tenant-repo-sync', deferredSince: since, now: Date.now()});

            const {service} = buildService({
                leasePath,
                taskState    : {'tenant-repo-sync': {deferralStreakStartedAt: since}},
                acquireResult: {acquired: true, lease: {token: 't2'}}
            });
            const executed = [];

            const result = service.acquireLeaseAndExecute({
                taskName       : 'tenant-repo-sync',
                executeFn      : name => { executed.push(name); return true; },
                reason         : 'scheduled',
                activeHeavyTask: {name: null}
            });

            expect(result).toBe(true);
            expect(executed).toEqual(['tenant-repo-sync']);

            const {waiters} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now: Date.now()});
            expect(waiters).toHaveLength(0);
            service.destroy()
        });

        test('a lease-held deferral with a measurable streak registers the waiter durably — carrying its bootstrap class', () => {
            const leasePath = tmpLeasePath();
            const since     = iso(Date.now() - HOUR);
            const dataDir   = path.dirname(leasePath);

            fs.writeFileSync(
                path.join(dataDir, 'tenant-repo-sync-revisions.json'),
                JSON.stringify({revisions: {'a/one': {lastIngestedRev: null}}})
            );

            const {service} = buildService({
                leasePath,
                dataDir,
                taskState    : {'tenant-repo-sync': {deferralStreakStartedAt: since}},
                acquireResult: {acquired: false, lease: {owner: 'dream', pid: 42}}
            });

            const result = service.acquireLeaseAndExecute({
                taskName       : 'tenant-repo-sync',
                executeFn      : () => true,
                reason         : 'scheduled',
                activeHeavyTask: {name: null}
            });

            expect(result).toBe(false);

            const {waiters} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now: Date.now()});
            expect(waiters).toHaveLength(1);
            // #242 RA-1. The bootstrap class alone left the cause fields unwitnessed at the only
            // place they are knowable: delete `reasonCode` / `blockingTaskName` / `leaseOwner` from
            // the production writer and this fixture still passed, because it asserted the two
            // fields that predate them.
            expect(waiters[0]).toMatchObject({
                taskName         : 'tenant-repo-sync',
                deferredSince    : since,
                bootstrapCritical: true,
                reasonCode       : 'heavy-maintenance-lease-held',
                blockingTaskName : null,
                leaseOwner       : 'dream'
            });
            service.destroy()
        })
    })
});

// #239. The ROUND TRIP, and it is the witness the watchdog specs cannot provide: they feed
// hand-built entries straight to the evaluator, so removing the write at registration is invisible
// to them. The cause is known only at registration — a cause not written there is unrecoverable by
// any later consumer, not merely unexposed.
test.describe('the waiter ledger carries the cause from writer to reader (#239)', () => {
    let leasePath, dir;

    test.beforeEach(async () => {
        dir       = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-waiter-cause-'));
        leasePath = path.join(dir, 'heavy-maintenance-lease.json');
    });

    test.afterEach(async () => {
        await fs.remove(dir);
    });

    test('reasonCode, blockingTaskName and leaseOwner survive the write/read round trip', () => {
        registerWaiterSync({
            leasePath,
            taskName        : 'dream',
            deferredSince   : new Date(Date.now() - 60_000).toISOString(),
            reasonCode      : 'heavy-maintenance-backpressure',
            blockingTaskName: 'summary',
            leaseOwner      : null
        });

        const {waiters} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS});

        expect(waiters).toHaveLength(1);
        expect(waiters[0].reasonCode).toBe('heavy-maintenance-backpressure');
        expect(waiters[0].blockingTaskName).toBe('summary');
    });

    test('the lease owner travels for the lease-held class, where blockingTaskName is not the blocker', () => {
        registerWaiterSync({
            leasePath,
            taskName     : 'kbSync',
            deferredSince: new Date(Date.now() - 60_000).toISOString(),
            reasonCode   : 'heavy-maintenance-lease-held',
            leaseOwner   : 'tenant-repo-sync'
        });

        const {waiters} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS});

        // Two reason classes, two different blocker fields: an intra-process conflict names a TASK,
        // a lease hold names an OWNER. One field could not carry both without lying about one.
        expect(waiters[0].reasonCode).toBe('heavy-maintenance-lease-held');
        expect(waiters[0].leaseOwner).toBe('tenant-repo-sync');
        expect(waiters[0].blockingTaskName).toBe(null);
    });

    test('an omitted cause reads null — an unknown reason is never a guessed one', () => {
        registerWaiterSync({
            leasePath,
            taskName     : 'summary',
            deferredSince: new Date(Date.now() - 60_000).toISOString()
        });

        const {waiters} = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS});

        expect(waiters[0].reasonCode).toBe(null);
        expect(waiters[0].blockingTaskName).toBe(null);
        expect(waiters[0].leaseOwner).toBe(null);
    });
});

// #242 RA-1. The specs above stop one hop short in BOTH directions: the round trip proves the ledger
// preserves what it was handed, and the watchdog specs prove the evaluator projects what it was
// handed — neither runs the production WRITER, so a cause the writer never passes is invisible to
// both. This is the full chain, once per cause class:
//
//   MaintenanceBackpressureService.recordDeferral  (the only place the cause is known)
//     → registerWaiterSync                         (durable ledger entry)
//     → listActiveWaitersSync                      (the admission-clock read the watchdog uses)
//     → evaluateWaiterStarvation                   (the breach)
//     → collectHeavyMaintenanceStarvationSnapshot  (what the plane actually serves)
//
// The two classes are here because they carry DIFFERENT blocker fields, and a witness for only one
// of them cannot tell a working chain from a chain that copies the wrong field: a lease hold names
// an OWNER with no blocking task, a fairness yield names a blocking TASK with no owner. Run either
// arm alone and swapping the two fields at any hop still passes.
test.describe('a waiter\'s cause survives writer → ledger → evaluator → bridge (#242 RA-1)', () => {
    const DEGRADE_AFTER_MS = 30 * 60 * 1000;

    /**
     * Drives the REAL evaluator over the REAL ledger read, then the REAL bridge projection — the
     * same three calls `scheduling/pipeline.mjs` makes, in the same order, over whatever the
     * production writer left on disk.
     */
    function projectFromLedger({leasePath, now}) {
        const ledgerReading = listActiveWaitersSync({leasePath, staleAfterMs: WAITER_ENTRY_STALE_AFTER_MS, now}),
              evaluation    = evaluateWaiterStarvation({ledgerReading, now, degradeAfterMs: DEGRADE_AFTER_MS, leaseHolder: null, leaseStatus: 'missing'}),
              verdict       = {posture: evaluation.posture, breaches: evaluation.breaches, leaseHolder: evaluation.leaseHolder, leaseStatus: evaluation.leaseStatus};

        return DeploymentStateBridgeService.prototype.collectHeavyMaintenanceStarvationSnapshot({watchdogTaskState: {starvation: verdict}});
    }

    test('the lease-held class carries its OWNER to the served snapshot, with no blocking task', () => {
        const leasePath = tmpLeasePath(),
              now       = Date.now(),
              since     = iso(now - 4 * HOUR);

        const {service} = buildService({
            leasePath,
            taskState    : {'tenant-repo-sync': {deferralStreakStartedAt: since}},
            acquireResult: {acquired: false, lease: {owner: 'dream', pid: 42}}
        });

        service.acquireLeaseAndExecute({taskName: 'tenant-repo-sync', executeFn: () => true, reason: 'scheduled', activeHeavyTask: {name: null}});

        const snapshot = projectFromLedger({leasePath, now});

        expect(snapshot.posture).toBe('degraded');
        expect(snapshot.breaches).toHaveLength(1);
        expect(snapshot.breaches[0]).toMatchObject({
            taskName        : 'tenant-repo-sync',
            reasonCode      : 'heavy-maintenance-lease-held',
            leaseOwner      : 'dream',
            blockingTaskName: null
        });
        service.destroy()
    });

    test('the fairness-yield class carries its blocking TASK, and names no owner', () => {
        const leasePath = tmpLeasePath(),
              now       = Date.now(),
              since     = iso(now - 4 * HOUR);

        // A starving waiter already registered is what makes the acquirer yield; the acquirer's own
        // deferral is the entry under test, so the pre-existing one is cleared before the read.
        registerWaiterSync({leasePath, taskName: 'tenant-repo-sync', deferredSince: since, now});

        // `dream`'s own streak must be SHORTER than the waiter's or fairness correctly refuses to
        // yield — an acquirer at least as starved as the queue is not the one that should step
        // aside. One hour still clears the 30-minute degrade bound, so the yield registers a
        // breaching waiter rather than a merely present one.
        const {service} = buildService({
            leasePath,
            taskState    : {dream: {deferralStreakStartedAt: iso(now - HOUR)}},
            acquireResult: {acquired: true, lease: {token: 't1'}}
        });

        service.acquireLeaseAndExecute({taskName: 'dream', executeFn: () => true, reason: 'scheduled', activeHeavyTask: {name: null}});
        clearWaiterSync({leasePath, taskName: 'tenant-repo-sync'});

        const snapshot = projectFromLedger({leasePath, now});

        expect(snapshot.breaches).toHaveLength(1);
        expect(snapshot.breaches[0]).toMatchObject({
            taskName        : 'dream',
            reasonCode      : 'heavy-maintenance-yield-to-waiter',
            blockingTaskName: 'tenant-repo-sync',
            leaseOwner      : null
        });
        service.destroy()
    });

    // 🔴 The discrimination the two arms exist for, asserted directly rather than left to a reader
    // comparing two tests: neither class's blocker field may leak into the other's.
    test('the two classes do not share a blocker field — a swap at any hop is visible', () => {
        const leasePath = tmpLeasePath(),
              now       = Date.now(),
              since     = iso(now - 4 * HOUR);

        registerWaiterSync({leasePath, taskName: 'seed', deferredSince: since, now});

        const {service} = buildService({
            leasePath,
            taskState    : {dream: {deferralStreakStartedAt: since}, 'tenant-repo-sync': {deferralStreakStartedAt: since}},
            acquireResult: {acquired: false, lease: {owner: 'rem', pid: 7}}
        });

        service.acquireLeaseAndExecute({taskName: 'tenant-repo-sync', executeFn: () => true, reason: 'scheduled', activeHeavyTask: {name: null}});
        clearWaiterSync({leasePath, taskName: 'seed'});

        const held = projectFromLedger({leasePath, now}).breaches.find(breach => breach.taskName === 'tenant-repo-sync');

        expect(held.leaseOwner).toBe('rem');
        expect(held.blockingTaskName).toBeNull();
        // …and the owner is NOT the task name, so a chain that copied `taskName` into `leaseOwner`
        // would fail here rather than read plausibly.
        expect(held.leaseOwner).not.toBe(held.taskName);
        service.destroy()
    })
});
