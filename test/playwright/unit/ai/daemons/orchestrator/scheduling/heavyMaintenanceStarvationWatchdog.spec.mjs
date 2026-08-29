import {test, expect} from '@playwright/test';
import {
    describeStarvationReceiptReachability,
    evaluateWaiterStarvation,
    getDueTask
} from '../../../../../../../ai/daemons/orchestrator/scheduling/heavyMaintenanceStarvationWatchdog.mjs';
import {listActiveWaitersSync} from '../../../../../../../ai/daemons/orchestrator/services/heavyMaintenanceWaiterLedger.mjs';

const HOUR = 60 * 60 * 1000;

function waiterEntry({taskName, deferredSince, updatedAt = deferredSince, priorityZero = false, bootstrapCritical = false, reasonCode = null, blockingTaskName = null}) {
    return {taskName, deferredSince, updatedAt, priorityZero, bootstrapCritical, reasonCode, blockingTaskName, pid: 4242};
}

test.describe('orchestrator/scheduling/heavyMaintenanceStarvationWatchdog (#17049 / #16561)', () => {
    test('a waiter deferred past the bound degrades with the full receipt (#17049 AC1)', () => {
        const now        = 10 * HOUR;
        const evaluation = evaluateWaiterStarvation({
            ledgerReading: {
                waiters: [
                    waiterEntry({taskName: 'backup', deferredSince: new Date(now - 2 * HOUR).toISOString(), priorityZero: true}),
                    waiterEntry({taskName: 'summary', deferredSince: new Date(now - 10 * 60 * 1000).toISOString()})
                ],
                unreadable: []
            },
            now,
            degradeAfterMs: HOUR,
            leaseHolder   : 'dream'
        });

        expect(evaluation.posture).toBe('degraded');
        expect(evaluation.degraded).toBe(true);
        expect(evaluation.waiterCount).toBe(2);
        expect(evaluation.breaches).toHaveLength(1);
        // Exact-shape on purpose: this is the receipt contract, so a field arriving or leaving is a
        // deliberate change rather than a silent one. #239 added the four causal fields below — the
        // fixture supplies no cause, so they read `null`, which is the honest value for a waiter
        // whose reason was never recorded.
        expect(evaluation.breaches[0]).toEqual({
            taskName         : 'backup',
            priorityZero     : true,
            bootstrapCritical: false,
            deferredSince    : new Date(now - 2 * HOUR).toISOString(),
            starvedForMs     : 2 * HOUR,
            leaseHolder      : 'dream',
            reasonCode       : null,
            blockingTaskName : null,
            leaseOwner       : null,
            leaseStatus      : null
        });
    });

    test('a deferred core-corpus projection becomes a named starvation breach rather than silent staleness (#17627)', () => {
        const now           = 10 * HOUR;
        const deferredSince = new Date(now - 5 * HOUR).toISOString();
        const evaluation    = evaluateWaiterStarvation({
            ledgerReading: {
                waiters   : [waiterEntry({taskName: 'core-corpus-projection', deferredSince})],
                unreadable: []
            },
            now,
            degradeAfterMs: 4 * HOUR,
            leaseHolder   : 'backup'
        });

        expect(evaluation).toMatchObject({
            posture : 'degraded',
            breaches: [{
                taskName    : 'core-corpus-projection',
                deferredSince,
                starvedForMs: 5 * HOUR,
                leaseHolder : 'backup'
            }]
        });
    });

    test('the degrade clears on acquisition — recomputed from the live ledger, never latched (#17049 AC3)', () => {
        const now      = 10 * HOUR;
        const breacher = waiterEntry({taskName: 'backup', deferredSince: new Date(now - 2 * HOUR).toISOString(), priorityZero: true});

        // Check N: the waiter is starved past the bound.
        expect(evaluateWaiterStarvation({
            ledgerReading : {waiters: [breacher], unreadable: []},
            now,
            degradeAfterMs: HOUR,
            leaseHolder   : 'dream'
        }).degraded).toBe(true);

        // Check N+1: the waiter acquired, so `clearWaiterSync` removed its entry — the identical
        // evaluation over the live ledger reads green with no state to clear.
        const cleared = evaluateWaiterStarvation({
            ledgerReading : {waiters: [], unreadable: []},
            now           : now + 60000,
            degradeAfterMs: HOUR,
            leaseHolder   : 'backup'
        });

        expect(cleared.posture).toBe('healthy');
        expect(cleared.degraded).toBe(false);
        expect(cleared.breaches).toEqual([]);
    });

    test('stale and corrupt ledger entries never reach the breach scan — proven through the REAL ledger read (#17049 AC3/AC4)', () => {
        const now          = 10 * HOUR;
        const staleAfterMs = 6 * HOUR;
        const files        = {
            'fresh.json' : JSON.stringify(waiterEntry({taskName: 'summary', deferredSince: new Date(now - 30 * 60 * 1000).toISOString(), updatedAt: new Date(now - 60000).toISOString()})),
            // A dead waiter: deferred long past the degrade bound, but its heartbeat stopped past the
            // ledger TTL — expiry drops it BEFORE evaluation, so a corpse cannot hold health red.
            'stale.json' : JSON.stringify(waiterEntry({taskName: 'backup', deferredSince: new Date(now - 9 * HOUR).toISOString(), updatedAt: new Date(now - 7 * HOUR).toISOString(), priorityZero: true})),
            'broken.json': '{not json'
        };
        const fsModule = {
            readdirSync : () => Object.keys(files),
            readFileSync: filePath => {
                const name = Object.keys(files).find(candidate => String(filePath).endsWith(candidate));
                return files[name];
            }
        };

        const ledgerReading = listActiveWaitersSync({leasePath: '/tmp/lease/heavy.lease', staleAfterMs, fsModule, now});

        expect(ledgerReading.waiters.map(entry => entry.taskName)).toEqual(['summary']);
        expect(ledgerReading.unreadable).toEqual(['broken.json']);

        const evaluation = evaluateWaiterStarvation({ledgerReading, now, degradeAfterMs: HOUR, leaseHolder: null});

        // One clean waiter under the bound beside one unreadable file: nothing breached, but the
        // reading cannot assert green — unknown, which never authorizes degradation.
        expect(evaluation.posture).toBe('unknown');
        expect(evaluation.degraded).toBe(false);
        expect(evaluation.waiterCount).toBe(1);
        expect(evaluation.unreadableCount).toBe(1);
    });

    test('a readable breach beside unreadable noise still degrades — readable evidence wins (#17049)', () => {
        const now        = 10 * HOUR;
        const evaluation = evaluateWaiterStarvation({
            ledgerReading: {
                waiters   : [waiterEntry({taskName: 'backup', deferredSince: new Date(now - 2 * HOUR).toISOString(), priorityZero: true})],
                unreadable: ['broken.json']
            },
            now,
            degradeAfterMs: HOUR,
            leaseHolder   : 'dream'
        });

        expect(evaluation.posture).toBe('degraded');
        expect(evaluation.breaches).toHaveLength(1);
        expect(evaluation.unreadableCount).toBe(1);
    });

    test('a fully corrupt ledger fails OPEN to green with the skip surfaced, never a throw (#17049 AC4)', () => {
        const now      = 10 * HOUR;
        const fsModule = {
            readdirSync : () => ['a.json', 'b.json'],
            readFileSync: () => '<<corrupt>>'
        };

        const ledgerReading = listActiveWaitersSync({leasePath: '/tmp/lease/heavy.lease', staleAfterMs: 6 * HOUR, fsModule, now});
        const evaluation    = evaluateWaiterStarvation({ledgerReading, now, degradeAfterMs: HOUR, leaseHolder: 'dream'});

        expect(evaluation.posture).toBe('unknown');
        expect(evaluation.degraded).toBe(false);
        expect(evaluation.waiterCount).toBe(0);
        expect(evaluation.unreadableCount).toBe(2);
    });

    test('a non-positive or non-finite bound disables the degrade — fail-open, never fail-loud', () => {
        const now     = 10 * HOUR;
        const starved = {waiters: [waiterEntry({taskName: 'backup', deferredSince: new Date(0).toISOString()})], unreadable: []};

        for (const degradeAfterMs of [0, -1, NaN, undefined]) {
            const evaluation = evaluateWaiterStarvation({ledgerReading: starved, now, degradeAfterMs});

            expect(evaluation.posture).toBe('disabled');
            expect(evaluation.degraded).toBe(false);
            expect(evaluation.breaches).toEqual([]);
        }
    });

    test('getDueTask fires on cadence and treats <= 0 as disabled', () => {
        expect(getDueTask({
            state                                    : {lastRunAt: 0},
            now                                      : 600000,
            heavyMaintenanceStarvationWatchdogCheckMs: 600000
        })).toEqual({
            taskName: 'heavy-maintenance-starvation-watchdog',
            source  : 'periodic-health-check',
            reason  : 'periodic-health-check:600000'
        });

        expect(getDueTask({
            state                                    : {lastRunAt: 0},
            now                                      : 599999,
            heavyMaintenanceStarvationWatchdogCheckMs: 600000
        })).toBeNull();

        expect(getDueTask({
            state                                    : {lastRunAt: 0},
            now                                      : 999999999,
            heavyMaintenanceStarvationWatchdogCheckMs: 0
        })).toBeNull();
    });
});

test.describe('describeStarvationReceiptReachability — the producer/consumer pairing (#17290)', () => {
    test('the shipped pair is UNREACHABLE: 10min restamp against a 2min window', () => {
        const result = describeStarvationReceiptReachability({checkMs: 600000, staleAfterMs: 120000});

        expect(result.reachable).toBe(false);
        // 8 of every 10 minutes a stamped verdict is already stale — the measured duty cycle.
        expect(result.unreadableMs).toBe(480000);
    });

    test('the derived default is reachable and leaves no unreadable gap', () => {
        const result = describeStarvationReceiptReachability({checkMs: 600000, staleAfterMs: 1200000});

        expect(result.reachable).toBe(true);
        expect(result.unreadableMs).toBe(0);
    });

    test('a window EQUAL to the cadence is the floor — reachable, with zero slack', () => {
        expect(describeStarvationReceiptReachability({checkMs: 600000, staleAfterMs: 600000})).toMatchObject({
            reachable: true, unreadableMs: 0
        });

        expect(describeStarvationReceiptReachability({checkMs: 600000, staleAfterMs: 599999})).toMatchObject({
            reachable: false, unreadableMs: 1
        });
    });

    test('a DISABLED producer is reachable by definition — a verdict never stamped cannot go unread', () => {
        expect(describeStarvationReceiptReachability({checkMs: 0, staleAfterMs: 0})).toMatchObject({
            reachable: true, unreadableMs: 0
        });

        expect(describeStarvationReceiptReachability({checkMs: -1, staleAfterMs: 120000})).toMatchObject({
            reachable: true
        });
    });

    test('non-finite input fails closed rather than passing on a NaN comparison', () => {
        for (const pair of [{checkMs: NaN, staleAfterMs: 120000}, {checkMs: 600000, staleAfterMs: undefined}]) {
            expect(describeStarvationReceiptReachability(pair).reachable).toBe(false);
        }
    });
});

// #239. `leaseHolder` describes ONE of the three reason classes that can register a waiter
// (`lease-held`, `backpressure`, `yield-to-waiter`), so a breach carrying only the holder cannot say
// why any particular waiter is waiting. Three live plane samples of one starvation produced three
// different mechanisms for exactly this reason — sampling a surface that reports only the symptom
// cannot converge on the cause.
test.describe('the waiter\'s OWN cause reaches the breach (#239)', () => {
    const NOW = Date.parse('2026-08-30T00:00:00.000Z'),
          OLD = new Date(NOW - 4 * HOUR).toISOString(),

          evaluate = (waiters, extra = {}) => evaluateWaiterStarvation({
              ledgerReading : {waiters, unreadable: []},
              now           : NOW,
              degradeAfterMs: HOUR,
              ...extra
          });

    test('two waiters with the SAME null holder are distinguishable by their own reason codes', () => {
        const {breaches} = evaluate([
            waiterEntry({taskName: 'dream',  deferredSince: OLD, reasonCode: 'heavy-maintenance-lease-held'}),
            waiterEntry({taskName: 'kbSync', deferredSince: OLD, reasonCode: 'heavy-maintenance-backpressure', blockingTaskName: 'summary'})
        ], {leaseHolder: null});

        // The field that used to be the only causal one is identical across both.
        expect(breaches.map(b => b.leaseHolder)).toEqual([null, null]);

        // The field that discriminates them is not.
        expect(breaches.map(b => b.reasonCode))
            .toEqual(['heavy-maintenance-lease-held', 'heavy-maintenance-backpressure']);
        expect(breaches[1].blockingTaskName).toBe('summary');
    });

    test('a waiter whose cause was never recorded reports null, never a guessed one', () => {
        const {breaches} = evaluate([waiterEntry({taskName: 'dream', deferredSince: OLD})], {leaseHolder: 'summary'});

        // An entry written before the field existed still reads — the ledger projects the whole
        // entry rather than an allowlist — and its unknown cause stays unknown.
        expect(breaches[0].reasonCode).toBe(null);
        expect(breaches[0].blockingTaskName).toBe(null);
        expect(breaches[0].leaseHolder).toBe('summary');
    });

    // #224 shipped `leaseStatus` to qualify a null holder, but it landed on the maintenance block —
    // so the two halves of "why is nothing running" lived on different objects.
    test('the holder-side discriminator travels WITH the breach, not beside it', () => {
        const {breaches, leaseStatus} = evaluate(
            [waiterEntry({taskName: 'dream', deferredSince: OLD, reasonCode: 'heavy-maintenance-lease-held'})],
            {leaseHolder: null, leaseStatus: 'stale'}
        );

        expect(breaches[0].leaseStatus).toBe('stale');
        expect(leaseStatus).toBe('stale');
    });

    // 🔴 THE FALSIFIER THIS EXISTS TO ENABLE. A payload whose breaches report a null holder and no
    // cause must not be readable as a lease finding. If this passes while every causal field is
    // absent, the exposure did not do its job.
    test('a holder-only breach carries no evidence for ANY specific mechanism', () => {
        const {breaches} = evaluate([waiterEntry({taskName: 'dream', deferredSince: OLD})], {leaseHolder: null});
        const causal     = ['reasonCode', 'blockingTaskName', 'leaseStatus'].filter(k => breaches[0][k] != null);

        // Nothing here identifies a mechanism — and the shape says so explicitly rather than
        // leaving `leaseHolder: null` to be read as "the lease is the problem".
        expect(causal).toEqual([]);
        expect(breaches[0].leaseHolder).toBe(null);
    });
});

// #242 RA-3. The OpenAPI block is the contract a plane consumer reads instead of this source, and it
// had advertised six breach fields while the shipped breach carried ten — a consumer building
// against the published schema could not know `reasonCode` existed. A doc that describes a
// superseded shape is worse than no doc: it is a confident wrong answer. Same drift class as the
// recognized-codes list, so it gets the same treatment — a comparison, not a comment.
test.describe('the published breach schema equals the shipped breach (#242 RA-3)', () => {
    test('every field the evaluator emits is advertised, and nothing is advertised that it does not emit', async () => {
        const {parse} = await import('yaml'),
              fs      = (await import('node:fs')).default,
              url     = await import('node:url'),
              here    = url.fileURLToPath(import.meta.url),
              root    = here.slice(0, here.indexOf('/test/playwright/')),
              doc     = parse(fs.readFileSync(`${root}/ai/mcp/server/memory-core/openapi.yaml`, 'utf8'));

        function findBreachSchema(node) {
            if (node && typeof node === 'object') {
                if (typeof node.description === 'string' && node.description.startsWith('Starved-waiter receipt')) return node;

                for (const key of Object.keys(node)) {
                    const found = findBreachSchema(node[key]);
                    if (found) return found
                }
            }

            return null
        }

        const schema = findBreachSchema(doc);

        // Positive control: a walk that found nothing would make both comparisons below vacuous.
        expect(schema, 'breach schema not found in openapi.yaml').toBeTruthy();

        const now        = Date.parse('2026-08-30T12:00:00.000Z'),
              evaluation = evaluateWaiterStarvation({
                  ledgerReading : {waiters: [{
                      taskName        : 'tenant-repo-sync',
                      priorityZero    : true,
                      deferredSince   : new Date(now - 4 * 60 * 60 * 1000).toISOString(),
                      updatedAt       : new Date(now).toISOString(),
                      reasonCode      : 'heavy-maintenance-lease-held',
                      blockingTaskName: null,
                      leaseOwner      : 'dream'
                  }], unreadable: []},
                  now,
                  degradeAfterMs: 30 * 60 * 1000,
                  leaseHolder   : 'dream',
                  leaseStatus   : 'active'
              });

        const emitted    = Object.keys(evaluation.breaches[0]).sort(),
              advertised = Object.keys(schema.items.properties).sort();

        expect(advertised).toEqual(emitted)
    })
});
