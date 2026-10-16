import {expect, test}                           from '@playwright/test';
import {createHash}                             from 'node:crypto';
import {planOpenWorkWakes, wakeGateOf}          from '../../../../../../ai/services/fleet/openWorkWakes.mjs';
import {OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL} from '../../../../../../ai/services/github-workflow/queries/openWorkQueries.mjs';

const
    START   = Date.parse('2026-10-13T12:00:00.000Z'),
    HEAD    = 'a'.repeat(40),
    ADA     = '@neo-opus-ada',
    GPT     = '@neo-gpt',
    at      = minute => START + minute * 60000,
    iso     = minute => new Date(at(minute)).toISOString(),
    opinion = (state, onHead = true) => ({reviewer: GPT, state, onHead}),
    judged  = state => ({opinions: [opinion(state)], reviews: [opinion(state)]}),
    state   = (minute, rows = [{}], overrides = {}) => ({
        observedAt: iso(minute), coverage: 'complete', transitions: [],
        snapshot  : {closed: {}, complete: true, rows: Object.fromEntries(rows.map(overrides => {
            const row = {
                repo     : 'acme/app', number: 7, head: HEAD, ci: 'pending', verdict: null,
                mergeable: 'MERGEABLE', draft: false, owner: {kind: 'seat', seat: ADA},
                requested: [], reviews: [], opinions: [], partial: false, observedAt: iso(minute), ...overrides
            };
            row.key = `${row.repo}#${row.number}`;
            return [row.key, row]
        }))}, ...overrides
    }),
    merged = (minute, overrides = {}) => ({
        id  : `acme/app#7@${HEAD}:merged:open->merged#${iso(minute)}`,
        key : 'acme/app#7', repo: 'acme/app', number: 7, head: HEAD, owner: {kind: 'seat', seat: ADA},
        kind: 'merged', pulse: iso(minute), ...overrides
    });

function journey() {
    let ledger = null;

    return {
        step(minute, rows = [{}], extra = {}, options = {}) {
            const result = planOpenWorkWakes({state: state(minute, rows, extra), ledger, now: at(minute), ...options});
            // Every step crosses the saved-ledger boundary, not an in-memory identity shortcut.
            ledger = JSON.parse(JSON.stringify(result.ledger));
            return result
        },
        ledger: () => ledger
    }
}

test.describe('openWorkWakes — pure holder-action episodes (#761)', () => {
    test('pending → red → green → red yields 0, 1, 1, 1 with different stable task identities', () => {
        const run = journey(), results = ['pending', 'red', 'green', 'red'].map((ci, minute) => run.step(minute, [{ci}]));

        expect(results.map(result => result.wakes.length)).toEqual([0, 1, 1, 1]);
        expect(results.slice(1).map(result => result.wakes[0].kind)).toEqual(['repair-ci', 'route-review', 'repair-ci']);
        expect(new Set(results.slice(1).map(result => result.wakes[0].key)).size).toBe(3);
        expect(run.step(3, [{ci: 'red'}]).wakes).toEqual([]);
        expect(run.step(4, [{ci: 'red'}]).wakes).toEqual([])
    });

    test('a verdict change under the same red head leaves the admitted repair episode unchanged', () => {
        const run = journey();
        run.step(0);
        const first = run.step(1, [{ci: 'red'}]);
        const again = run.step(2, [{ci: 'red', ...judged('CHANGES_REQUESTED')}]);

        expect(first.wakes).toHaveLength(1);
        expect(again.wakes).toEqual([]);
        expect(Object.values(again.ledger.holding)[0]).toEqual(Object.values(first.ledger.holding)[0])
    });

    test('two reviewers wake once each; removed and re-added seats get a new episode alone', () => {
        const run = journey();
        run.step(0);
        const first = run.step(1, [{ci: 'green', requested: [GPT, ADA]}]);

        expect(first.wakes.map(wake => wake.to)).toEqual([GPT, ADA]);
        expect(run.step(2, [{ci: 'green', requested: [GPT, ADA]}]).wakes).toEqual([]);
        expect(run.step(3, [{ci: 'green', requested: [ADA]}]).wakes).toEqual([]);
        const readded = run.step(4, [{ci: 'green', requested: [GPT, ADA]}]);

        expect(readded.wakes.map(wake => wake.to)).toEqual([GPT]);
        expect(readded.wakes[0].key).not.toBe(first.wakes[0].key)
    });

    test('the full head scopes an action even when the seat, kind and first seven characters agree', () => {
        const run = journey(), otherHead = 'a'.repeat(39) + 'b';
        run.step(0);
        const first  = run.step(1, [{ci: 'red'}]).wakes[0];
        const second = run.step(2, [{ci: 'red', head: otherHead}]).wakes[0];

        expect(second.kind).toBe(first.kind);
        expect(first.head).toBe(HEAD);
        expect(second.head).toBe(otherHead);
        expect(first.key).not.toBe(second.key);
        expect(JSON.parse(second.key)).toContain(otherHead)
    });

    test('partial, missing-opinion and stale rows cannot end and restart the same holding', () => {
        const run = journey();
        run.step(0);
        run.step(1, [{ci: 'red'}]);
        const before = run.ledger().holding;

        expect(run.step(2, [{ci: 'pending', partial: true}]).wakes).toEqual([]);
        expect(run.ledger().holding).toEqual(before);
        expect(run.step(3, [{ci: 'pending', opinions: undefined}]).wakes).toEqual([]);
        expect(run.ledger().holding).toEqual(before);
        expect(run.step(10, [{ci: 'pending', observedAt: iso(1)}]).wakes).toEqual([]);
        expect(run.ledger().holding).toEqual(before);
        expect(run.step(11, [{ci: 'red'}]).wakes).toEqual([])
    });

    test('a row absent from a partial pulse retains its holding, while a complete absence ends it', () => {
        const run = journey();
        run.step(0);
        const first = run.step(1, [{ci: 'red'}]).wakes[0];

        expect(run.step(2, [], {coverage: 'partial'}).wakes).toEqual([]);
        expect(run.step(3, [{ci: 'red'}]).wakes).toEqual([]);
        run.step(4, []);
        const returned = run.step(5, [{ci: 'red'}]).wakes[0];

        expect(returned.key).not.toBe(first.key)
    });

    test('a complete fresh row is eligible inside a globally partial pulse; a partial row is not', () => {
        const run = journey();
        run.step(0);
        expect(run.step(1, [{ci: 'red', partial: true}], {coverage: 'partial'}).wakes).toEqual([]);
        expect(run.step(2, [{ci: 'red'}], {coverage: 'partial'}).wakes.map(wake => wake.kind)).toEqual(['repair-ci'])
    });

    test('expired rows and invalid or future row timestamps cannot wake', () => {
        for (const observedAt of [iso(0), 'invalid', null, iso(71)]) {
            const run = journey();
            run.step(60);
            expect(run.step(70, [{ci: 'red', observedAt}]).wakes).toEqual([])
        }
    });

    test('a stale producer or a failed-read envelope admits nothing and does not advance the handled pulse', () => {
        const run = journey();
        run.step(0);
        const ledger = run.ledger();

        for (const observed of [state(0, [{ci: 'red'}]), state(6, [{ci: 'red'}], {coverage: 'stale'})]) {
            expect(planOpenWorkWakes({state: observed, ledger, now: at(6)})).toEqual({wakes: [], ledger})
        }
    });

    test('an older producer observation cannot roll the ledger back or produce an action', () => {
        const run = journey();
        run.step(2);
        const ledger = run.ledger();

        expect(planOpenWorkWakes({state: state(1, [{ci: 'red'}]), ledger, now: at(2)})).toEqual({wakes: [], ledger})
    });

    test('initial and quiet observations baseline without a later backlog burst', () => {
        const run = journey();
        expect(run.step(0, [{ci: 'red'}]).wakes).toEqual([]);
        expect(run.step(1, [{ci: 'red'}]).wakes).toEqual([]);
        expect(run.step(2, [{ci: 'green'}], {}, {quiet: true}).wakes).toEqual([]);
        expect(run.step(3, [{ci: 'green'}]).wakes).toEqual([]);
        expect(run.step(4, [{ci: 'red'}]).wakes.map(wake => wake.kind)).toEqual(['repair-ci'])
    });

    test('an initial unknown row baselines its first complete action once, without hiding its next action', () => {
        const run = journey();
        run.step(0, [{ci: 'red', partial: true}]);
        expect(run.ledger().baselines).toEqual({'acme/app#7': HEAD});
        expect(run.step(1, [{ci: 'red'}]).wakes).toEqual([]);
        expect(run.ledger().baselines).toEqual({});
        expect(run.step(2, [{ci: 'green'}]).wakes.map(wake => wake.kind)).toEqual(['route-review'])
    });

    test('a quiet unknown row baselines once, while a newly observed active row still wakes', () => {
        const run = journey();
        run.step(0);
        run.step(1, [{number: 8, ci: 'red', partial: true}], {}, {quiet: true});
        expect(run.step(2, [{number: 8, ci: 'red'}]).wakes).toEqual([]);
        run.step(3, [{number: 8, ci: 'red'}, {number: 9, ci: 'red', partial: true}], {coverage: 'partial'});
        expect(run.step(4, [{number: 8, ci: 'red'}, {number: 9, ci: 'red'}]).wakes.map(wake => wake.number)).toEqual([9])
    });

    test('an unknown baseline is bound to its full head, never a later head or another PR', () => {
        const run = journey(), otherHead = 'a'.repeat(39) + 'b';
        run.step(0, [{ci: 'red', partial: true}]);
        const result = run.step(1, [{ci: 'red', head: otherHead}, {number: 8, ci: 'red'}]);

        expect(result.wakes.map(wake => [wake.number, wake.head])).toEqual([[7, otherHead], [8, HEAD]]);
        expect(result.ledger.baselines).toEqual({})
    });

    test('authoritative removal cleans an unknown baseline, while a partial absence preserves it', () => {
        const run = journey();
        run.step(0, [{ci: 'red', partial: true}]);
        run.step(1, [], {coverage: 'partial'});
        expect(run.ledger().baselines).toEqual({'acme/app#7': HEAD});
        run.step(2, []);
        expect(run.ledger().baselines).toEqual({});
        expect(run.step(3, [{ci: 'red'}]).wakes.map(wake => wake.kind)).toEqual(['repair-ci'])
    });

    test('a first complete no-holder observation consumes the unknown baseline before a later red action', () => {
        const run = journey();
        run.step(0, [{partial: true}]);
        expect(run.step(1).wakes).toEqual([]);
        expect(run.ledger().baselines).toEqual({});
        expect(run.step(2, [{ci: 'red'}]).wakes.map(wake => wake.kind)).toEqual(['repair-ci'])
    });

    test('unreachable is retryable on the original episode; an unknown route does not assert unreachable', () => {
        const run = journey();
        run.step(0);
        const skipped = run.step(1, [{ci: 'red'}], {}, {routeOf: () => 'unreachable'});
        const pending = Object.values(skipped.ledger.holding)[0];

        expect(skipped.wakes).toEqual([]);
        expect(pending.status).toBe('pending');
        const recovered = run.step(2, [{ci: 'red'}]);

        expect(recovered.wakes).toEqual([pending.wake]);
        expect(Object.values(recovered.ledger.holding)[0].status).toBe('admitted');
        expect(run.step(3, [{ci: 'red'}]).wakes).toEqual([])
    });

    test('quiet suppresses an already skipped action instead of sending it when the gate reopens', () => {
        const run = journey();
        run.step(0);
        run.step(1, [{ci: 'red'}], {}, {routeOf: () => 'unreachable'});
        run.step(2, [{ci: 'red', partial: true}], {}, {quiet: true});
        expect(run.step(3, [{ci: 'red'}]).wakes).toEqual([])
    });

    test('quiet with stale or invalid producer evidence preserves pending open and merge work unchanged', () => {
        const run = journey(), terminal = merged(1);
        run.step(0, [{number: 7}, {number: 8}]);
        run.step(1, [{number: 8, ci: 'red'}], {transitions: [terminal]}, {routeOf: () => 'unreachable'});
        const ledger = run.ledger();

        expect(Object.values(ledger.holding)[0].status).toBe('pending');
        expect(ledger.pendingMerges[terminal.id]).toBeDefined();
        for (const observed of [
            state(1, [{number: 8, ci: 'red'}]),
            state(7, [{number: 8, ci: 'red'}], {coverage: 'stale'}),
            state(7, [{number: 8, ci: 'red'}], {observedAt: 'invalid'}),
            null
        ]) {
            expect(planOpenWorkWakes({state: observed, ledger, now: at(7), quiet: true}))
                .toEqual({wakes: [], ledger})
        }
    });

    test('operator, rotation and authors without a seat never wake; requested native reviewers still do', () => {
        const run = journey();
        run.step(0, []);
        const rows = [
            {number: 1, ci: 'green', ...judged('APPROVED')},
            {number: 2, ci: 'green', owner: {kind: 'outside', seat: null}},
            {number: 3, ci: 'red', owner: {kind: 'unowned', seat: null}},
            {number: 4, ci: 'green', owner: {kind: 'outside', seat: null}, requested: [GPT, 'login:outside', 'team:acme/core']},
            {number: 5, ci: 'green', owner: {kind: 'unowned', seat: null}, requested: [ADA]}
        ];
        expect(run.step(1, rows).wakes.map(({number, to, kind}) => ({number, to, kind}))).toEqual([
            {number: 4, to: GPT, kind: 'review'}, {number: 5, to: ADA, kind: 'review'}
        ])
    });

    test('a skipped merge keeps its terminal observation when the transition rolls out, then admits once', () => {
        const run = journey(), terminal = merged(1);
        run.step(0);
        const skipped = run.step(1, [], {transitions: [terminal]}, {routeOf: () => 'unreachable'});
        const pending = skipped.ledger.pendingMerges[terminal.id];

        expect(skipped.wakes).toEqual([]);
        expect(pending.episode).toBe(terminal.id);
        expect(pending.kind).toBe('post-merge');
        const recovered = run.step(20, []);

        expect(recovered.wakes).toEqual([pending]);
        expect(recovered.ledger.pendingMerges).toEqual({});
        expect(run.step(20, [], {transitions: [terminal]}).wakes).toEqual([]);
        expect(run.step(21, [], {transitions: [terminal]}).wakes).toEqual([])
    });

    test('a quiet round suppresses skipped merges and initial retained merges never become catch-up wakes', () => {
        const run = journey(), terminal = merged(1);
        expect(run.step(1, [], {transitions: [terminal]}).wakes).toEqual([]);
        expect(run.step(2, [], {transitions: [terminal]}).wakes).toEqual([]);

        const retry = journey();
        retry.step(0);
        retry.step(1, [], {transitions: [terminal]}, {routeOf: () => 'unreachable'});
        retry.step(2, [], {}, {quiet: true});
        expect(retry.step(3, []).wakes).toEqual([])
    });

    test('only newer terminal observations are selected, with their original full identity', () => {
        const run = journey();
        run.step(2, []);
        const terminal = merged(3), result = run.step(3, [], {transitions: [merged(1), terminal, merged(4)]});

        expect(result.wakes).toHaveLength(1);
        expect(result.wakes[0]).toMatchObject({head: HEAD, episode: terminal.id, kind: 'post-merge'});
        expect(JSON.parse(result.wakes[0].key)).toEqual(['acme/app', 7, HEAD, ADA, 'post-merge', terminal.id]);
        expect(result.ledger.pulse).toBe(iso(3))
    });

    test('an older retained close cannot retire the holding of a row observed open again afterwards', () => {
        const run = journey(), closed = merged(1, {kind: 'closed', id: 'closed-at-1'});
        run.step(0);
        expect(run.step(2, [{ci: 'green'}], {transitions: [closed]}).wakes).toHaveLength(1);
        expect(run.step(3, [{ci: 'green'}], {transitions: [closed]}).wakes).toEqual([])
    });

    test('each admitted action has text naming that kind, never the old author-role fallback', () => {
        const cases = [
            [{ci: 'red'}, 'repair-ci', 'CI is red on your head'],
            [{ci: 'pending', ...judged('CHANGES_REQUESTED')}, 'address-changes', 'changes are requested on your head'],
            [{ci: 'green', ...judged('APPROVED'), mergeable: 'CONFLICTING'}, 'rebase', 'your approved head has conflicts to rebase'],
            [{ci: 'green', requested: [GPT]}, 'review', 'your review is due on the current head'],
            [{ci: 'green'}, 'route-review', 'CI is green; request a reviewer for your head']
        ];

        for (const [row, kind, reason] of cases) {
            const run = journey();
            run.step(0);
            expect(run.step(1, [row]).wakes[0]).toMatchObject({kind, reason})
        }

        const run = journey();
        run.step(0);
        expect(run.step(1, [], {transitions: [merged(1)]}).wakes[0].reason).toBe('your pull request was merged')
    });

    test('planning does not mutate producer state or a saved ledger', () => {
        const freeze = value => {
            if (value && typeof value === 'object') {
                Object.values(value).forEach(freeze);
                Object.freeze(value)
            }
            return value
        };
        const initial  = planOpenWorkWakes({state: state(0), ledger: null, now: at(0)}).ledger;
        const observed = freeze(state(1, [{ci: 'red'}])), ledger = freeze(initial);
        const before   = JSON.stringify({observed, ledger});

        expect(planOpenWorkWakes({state: observed, ledger, now: at(1)}).wakes).toHaveLength(1);
        expect(JSON.stringify({observed, ledger})).toBe(before)
    });
});

test.describe('wakeGateOf — elapsed coverage and issuer quota evidence (#761)', () => {
    const
        completeSeat = (seat = ADA) => ({
            seat, benched: false, outcome: 'complete',
            authored: {complete: true, rows: 0}, held: {complete: true, rows: 0},
            terminal: {required: true, complete: true, rows: 0}
        }),
        pulse = (minute, {phase = 0, issuers = [{viewerId: 'U_ADA', limit: 1000, cost: 3, calls: 3}]} = {}) => ({
            telemetryVersion: 1, at: iso(minute), finishedAt: new Date(at(minute) + 1000).toISOString(), intervalMs: 4 * 60000,
            seats           : [completeSeat()],
            quota           : issuers.map(issuer => ({
                apiBase  : 'https://api.github.com', viewerId: issuer.viewerId,
                resetAt  : iso(Math.floor((minute - phase) / 60) * 60 + phase + 60),
                limit    : issuer.limit, cost: issuer.cost, calls: issuer.calls, failed: 0, unknown: false,
                firstAt  : new Date(at(minute) + 200).toISOString(), lastAt: new Date(at(minute) + 800).toISOString(),
                remaining: issuer.limit, ...issuer
            }))
        }),
        history = ({start = 0, end = 1440, phase = 0, issuers} = {}) => {
            const pulses = [];
            for (let minute = start; minute <= end; minute += 4) pulses.push(pulse(minute, {phase, issuers}));
            if (pulses.at(-1)?.at !== iso(end)) pulses.push(pulse(end, {phase, issuers}));
            return {observedAt: pulses.at(-1).at, coverage: 'complete', readers: {'neo-opus-ada': {}}, pulses}
        },
        gate = observed => wakeGateOf(observed, {now: Date.parse(observed.pulses.at(-1).finishedAt) + 1000});

    const snapshotHash = createHash('sha256').update(OPEN_WORK_SNAPSHOT).digest('hex'),
        terminalHash   = createHash('sha256').update(OPEN_WORK_TERMINAL).digest('hex'),
        classified     = (quota, overrides = {}) => ({...quota, queryHash: snapshotHash, reported: true,
            maxMeasuredCost: quota.cost, zeroCostFailedCalls: 0, firstAttemptAt: quota.firstAt,
            firstOrdinal   : 1, lastOrdinal: quota.calls, ...overrides});

    test('operational accounting keeps measured, estimated and unattributed ledgers separate', () => {
        const observed = history();
        for (const index of [100, 101, 102]) {
            const item = observed.pulses[index], original = item.quota[0];
            item.seats[0] = {seat: ADA, benched: false, outcome: 'failed', authored: {complete: false, rows: 0}, held: null,
                terminal: {required: true, complete: false, rows: 0}};
            item.costUnknown = true;
            item.quota = [classified({...original, viewerId: null, resetAt: null, limit: null, remaining: null,
                cost: 0, calls: 1, failed: 1, unknown: true}, {reported: false, maxMeasuredCost: null})];
        }
        observed.pulses.splice(20, 11);
        const result = gate(observed);
        expect(result).toMatchObject({holds: true, certification: {version: 1, policy: 'open-work-operational-estimate-v1'}});
        const bucket = result.certification.buckets.find(item => item.resetAt === iso(420));
        expect(bucket).toMatchObject({measured: 36, estimated: 0, unattributed: 9, unattributedCalls: 3, decision: 'operational-estimate'});
        expect(result.certification.estimates).toContainEqual(expect.objectContaining({queryHash: snapshotHash, formulaCost: 3, reservePerCall: 3}));
        observed.pulses.at(-1).seats[0].outcome = 'failed';
        expect(gate(observed).holds).toBe(false);
    });

    test('query-specific reserves use formula and measured maximum, with no positive-cost double charge', () => {
        const observed = history(), item = observed.pulses[100], base = item.quota[0];
        item.quota = [
            classified({...base, cost: 30}, {maxMeasuredCost: 11}),
            classified({...base, cost: 0, calls: 1, failed: 1, unknown: true}, {reported: false, maxMeasuredCost: null, firstOrdinal: 4, lastOrdinal: 4}),
            classified({...base, cost: 0, calls: 1, failed: 1, unknown: true}, {queryHash: terminalHash, reported: false, maxMeasuredCost: null, firstOrdinal: 5, lastOrdinal: 5}),
            classified({...base, cost: 5, calls: 1, failed: 1}, {firstOrdinal: 6, lastOrdinal: 6}),
            classified({...base, cost: 0, calls: 1, failed: 1}, {zeroCostFailedCalls: 1, firstOrdinal: 7, lastOrdinal: 7})
        ];
        item.costUnknown = true;
        const result = gate(observed), bucket = result.certification?.buckets.find(row => row.resetAt === base.resetAt);
        expect(result.holds).toBe(true);
        expect(bucket).toMatchObject({measured: 77, estimated: 23, estimatedCalls: 3, unattributed: 0});
        expect(result.certification.estimates).toContainEqual(expect.objectContaining({queryHash: terminalHash, formulaCost: 1, reservePerCall: 1}));
        item.quota[1].queryHash = 'f'.repeat(64);
        expect(gate(observed)).toMatchObject({holds: false, reason: expect.stringContaining('query')});
    });

    test('unattributed failures charge all intersecting endpoint windows and stay pending without one', () => {
        const observed = history(), item = observed.pulses[15], base = item.quota[0];
        item.at = iso(59); item.finishedAt = iso(61);
        item.quota = [classified({...base, viewerId: null, resetAt: null, limit: null, remaining: null,
            cost: 7, calls: 1, failed: 1, unknown: true, firstAt: iso(61), lastAt: iso(61)},
            {firstAttemptAt: iso(59), firstOrdinal: 1, lastOrdinal: 1})];
        item.seats[0] = {seat: ADA, benched: false, outcome: 'failed', authored: {complete: false, rows: 0}, held: null,
            terminal: {required: true, complete: false, rows: 0}};
        const result = gate(observed);
        expect(result.holds).toBe(true);
        for (const resetAt of [iso(60), iso(120)]) {
            expect(result.certification.buckets.find(row => row.resetAt === resetAt)).toMatchObject({unattributed: 7, unattributedCalls: 1});
        }
        item.quota[0].apiBase = 'https://unknown.example/api';
        expect(gate(observed)).toMatchObject({holds: false, reason: expect.stringContaining('unattributed')});
        item.quota[0].apiBase = null;
        expect(gate(observed).holds).toBe(false);
    });

    test('only a later successful same-window account total may override every charged attempt', () => {
        const observed = history(), failed = observed.pulses[10], original = failed.quota[0];
        failed.costUnknown = true;
        failed.quota = [classified({...original, cost: 0, calls: 100, failed: 100, unknown: true},
            {reported: false, maxMeasuredCost: null})];
        // With no measured account total after all attempts, 200 reserved points exceed the share.
        expect(gate(observed).holds).toBe(false);
        const earlier = observed.pulses[5];
        earlier.quota[0] = classified({...earlier.quota[0], remaining: 950});
        expect(gate(observed).holds).toBe(false);
        const later = observed.pulses[14];
        later.quota[0] = classified({...later.quota[0], remaining: 920});
        let result = gate(observed), bucket = result.certification?.buckets.find(row => row.resetAt === iso(60));
        expect(result.holds).toBe(true);
        expect(bucket).toMatchObject({estimated: 300, decision: 'reported-user-total', userTotal: {used: 80, remaining: 920}});
        // Same-millisecond failure after that successful response defeats its claimed coverage.
        later.costUnknown = true;
        later.quota.push(classified({...later.quota[0], cost: 0, calls: 1, failed: 1, unknown: true},
            {reported: false, maxMeasuredCost: null, firstOrdinal: 4, lastOrdinal: 4}));
        expect(gate(observed).holds).toBe(false);
    });

    test('exactly 24 elapsed hours with complete zero-row reads and full quota prefixes holds', () => {
        expect(gate(history())).toMatchObject({holds: true, reason: null});
        const partial = history();
        partial.coverage = 'partial';
        partial.pulses[100].coverage = 'partial';
        expect(gate(partial)).toMatchObject({holds: true, reason: null})
    });

    test('1,440 burst observations are not an elapsed day', () => {
        const observed = history();
        observed.pulses = Array.from({length: 1440}, (_, index) => pulse(index / 60));
        observed.observedAt = observed.pulses.at(-1).at;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('24 elapsed hours')})
    });

    test('a cutoff through a quota window requires its prefix, and charges before the cutoff count', () => {
        expect(gate(history({phase: 30}))).toEqual({holds: false, reason: expect.stringContaining('prefix')});
        const prefixed = history({start: -32, phase: 30});
        expect(gate(prefixed).holds).toBe(true);
        prefixed.pulses.find(item => item.at === iso(-28)).quota[0].cost = 250;
        expect(gate(prefixed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('separate issuers get their own measured limits; one shared issuer must fit the combined cost', () => {
        const distinct = history({issuers: [
            {viewerId: 'U_ADA', limit: 1000, cost: 13, calls: 3},
            {viewerId: 'U_GPT', limit: 1000, cost: 13, calls: 3}
        ]});
        expect(gate(distinct).holds).toBe(true);

        const shared = history({issuers: [{viewerId: 'U_SHARED', limit: 1000, cost: 26, calls: 6}]});
        expect(gate(shared)).toEqual({holds: false, reason: expect.stringContaining('20%')});

        for (const item of distinct.pulses) item.quota[1].limit = item.quota[1].remaining = 900;
        expect(gate(distinct)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('issuer identity includes the API endpoint, and PAT changes cannot split the same viewer quota', () => {
        const observed = history({issuers: [
            {viewerId: 'U_SAME', limit: 1000, cost: 13, calls: 3},
            {viewerId: 'U_SAME', apiBase: 'https://forge.example/api/v3', limit: 1000, cost: 13, calls: 3}
        ]});
        expect(gate(observed).holds).toBe(true);
        for (const item of observed.pulses) item.quota[1].apiBase = 'https://api.github.com/';
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('exactly 20% of the measured limit is allowed, while the next point refuses', () => {
        const observed = history();
        // The first full reset window has fifteen three-point receipts.
        observed.pulses[0].quota[0].cost = 158;
        expect(gate(observed).holds).toBe(true);
        observed.pulses[0].quota[0].cost++;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('conflicting limits for the same issuer reset window are refused', () => {
        const observed = history();
        observed.pulses[2].quota[0].limit = observed.pulses[2].quota[0].remaining = 2000;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('conflicting measured limits')})
    });

    test('a reset during one pulse retains each query cost in its observed reset window', () => {
        const observed = history(), crossing = observed.pulses[15], boundary = at(60);
        crossing.at = new Date(boundary - 1000).toISOString();
        crossing.finishedAt = new Date(boundary + 1000).toISOString();
        crossing.quota = [
            {...crossing.quota[0], calls: 2, cost: 2, resetAt: iso(60),
                firstAt: new Date(boundary - 900).toISOString(), lastAt: new Date(boundary - 100).toISOString()},
            {...crossing.quota[0], calls: 1, cost: 1, resetAt: iso(120),
                firstAt: new Date(boundary + 100).toISOString(), lastAt: new Date(boundary + 900).toISOString()}
        ];
        expect(gate(observed).holds).toBe(true);
        crossing.quota[0].cost = 201;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('a delayed response keeps its known cost in the returned issuer window after that window resets', () => {
        const observed = history(), delayed = observed.pulses[15].quota[0];
        // This response arrived just after minute 60, but the issuer charged the ending window.
        delayed.resetAt = iso(60);
        expect(gate(observed).holds).toBe(true);
        // 45 prior points + 158 is over budget. Reassigning it by client receipt time would
        // incorrectly combine it with the next window's 42 points and pass at exactly 200.
        delayed.cost = 158;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('an old-window receipt inside the day is budgeted even when its issuer window ended before the cutoff', () => {
        const observed = history({start: -64});
        observed.pulses.find(item => item.at === iso(-60)).quota[0].resetAt = iso(-1);
        const delayed = observed.pulses.find(item => item.at === iso(4)).quota[0];
        delayed.resetAt = iso(-1);
        expect(gate(observed).holds).toBe(true);
        delayed.cost = 198; // plus the three retained prefix points is over the 200-point share
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')});

        const missingPrefix = history({start: -60});
        missingPrefix.pulses.find(item => item.at === iso(4)).quota[0].resetAt = iso(-1);
        expect(gate(missingPrefix)).toEqual({holds: false, reason: expect.stringContaining('prefix')})
    });

    test('missing or unknown cost is never a free query; remaining is not a cost substitute', () => {
        const corruptions = [
            quota => delete quota.cost,
            quota => quota.cost = NaN,
            quota => quota.cost = -1,
            quota => quota.limit = undefined,
            quota => quota.viewerId = null,
            quota => quota.apiBase = 'not an endpoint',
            quota => quota.unknown = true,
            quota => quota.calls = 0
        ];
        for (const corrupt of corruptions) {
            const observed = history();
            corrupt(observed.pulses[100].quota[0]);
            expect(gate(observed).holds).toBe(false)
        }

        const noRemaining = history();
        for (const item of noRemaining.pulses) delete item.quota[0].remaining;
        expect(gate(noRemaining).holds).toBe(true);
        const unattributed = history();
        unattributed.pulses[100].costUnknown = true;
        expect(gate(unattributed).holds).toBe(false);
        const phantom = history();
        phantom.pulses[100].quota = [];
        expect(gate(phantom)).toEqual({holds: false, reason: expect.stringContaining('no complete attributed')})
    });

    test('known failed-call charges count even when their owner is benched', () => {
        const observed = history(), item = observed.pulses[100];
        item.seats.push({seat: GPT, benched: true, outcome: 'failed', authored: null, held: null, terminal: null});
        item.quota[0].calls += 1;
        item.quota[0].failed = 1;
        item.quota[0].cost += 10;
        expect(gate(observed).holds).toBe(true);
        item.quota[0].cost += 201;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('every current participating seat owes latest complete reads, including terminal catch-up', () => {
        const variants = [
            seat => seat.outcome = 'failed',
            seat => seat.outcome = 'credential-unread',
            seat => seat.authored.complete = false,
            seat => seat.held.complete = false,
            seat => seat.terminal.complete = false,
            seat => seat.terminal = null
        ];
        for (const mutate of variants) {
            const observed = history();
            mutate(observed.pulses.at(-1).seats[0]);
            expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('owed read')})
        }
    });

    test('a roster join owes current complete reads, not a new 24-hour enrollment wait', () => {
        const observed = history();
        observed.readers['neo-gpt'] = {};
        for (const item of observed.pulses.slice(300)) {
            item.seats.push(completeSeat(GPT));
            item.quota[0].calls += 3;
            item.quota[0].cost += 3
        }
        expect(gate(observed).holds).toBe(true);
        observed.pulses.at(-1).seats.pop();
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('current producer readers')})
    });

    test('new unread seats and duplicate or malformed seat receipts cannot disappear behind an old reader map', () => {
        const observed = history();
        observed.pulses.at(-1).seats.push({seat: GPT, benched: false, outcome: 'credential-unread', authored: null, held: null, terminal: null});
        expect(gate(observed).holds).toBe(false);
        const repeated = history();
        repeated.pulses[100].seats.push({...repeated.pulses[100].seats[0]});
        expect(gate(repeated).holds).toBe(false);
        const malformed = history();
        malformed.pulses[100].seats[0].authored.rows = undefined;
        expect(gate(malformed).holds).toBe(false)
    });

    test('producer gaps owe no reads or costs, including gaps within the retained quota prefix', () => {
        const observed = history();
        observed.pulses.splice(100, 11);
        expect(gate(observed)).toMatchObject({holds: true, reason: null});
        const prefixed = history({start: -32, phase: 30});
        prefixed.pulses = prefixed.pulses.filter(item => item.at === iso(-32) || Date.parse(item.at) >= at(0));
        expect(gate(prefixed)).toMatchObject({holds: true, reason: null})
    });

    test('known-cost failed history and transient unread seats certify after successful current reads', () => {
        const observed = history();
        for (const index of [100, 101, 102]) {
            const item = observed.pulses[index];
            item.seats[0] = {seat: ADA, benched: false, outcome: 'failed', authored: {complete: false, rows: 0},
                held: null, terminal: {required: true, complete: false, rows: 0}};
            item.quota[0].calls = item.quota[0].failed = 1;
            item.quota[0].cost = 2;
        }
        const unread = observed.pulses[150];
        unread.seats[0] = {seat: ADA, benched: false, outcome: 'credential-unread', authored: null, held: null, terminal: null};
        unread.quota = [];
        observed.pulses.splice(20, 11);
        expect(gate(observed)).toMatchObject({holds: true, reason: null});
        observed.pulses.find(item => item.at === iso(400)).quota[0].cost = 201;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('a current seat whose reads never succeed cannot certify', () => {
        const observed = history();
        for (const item of observed.pulses) {
            item.seats[0] = {seat: ADA, benched: false, outcome: 'failed', authored: {complete: false, rows: 0},
                held: null, terminal: {required: true, complete: false, rows: 0}};
            item.quota[0].calls = item.quota[0].failed = 1;
        }
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('owed read')})
    });

    test('a removed seat owes no current read but its historical issuer charges still count', () => {
        const observed = history();
        for (const item of observed.pulses.slice(0, -1)) {
            item.seats.push({seat: GPT, benched: false, outcome: 'failed', authored: {complete: false, rows: 0},
                held: null, terminal: {required: true, complete: false, rows: 0}});
            item.quota.push({...item.quota[0], viewerId: 'U_REMOVED', calls: 1, failed: 1, cost: 2});
        }
        expect(gate(observed)).toMatchObject({holds: true, reason: null});
        observed.pulses[0].quota[1].cost = 201;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('20%')})
    });

    test('version-one receipts need an elapsed day after legacy telemetry, not a legacy sample count', () => {
        const observed = history();
        delete observed.pulses[10].telemetryVersion;
        expect(gate(observed)).toEqual({holds: false, reason: expect.stringContaining('24 elapsed hours')})
    });

    test('stale, future, malformed, unordered and mismatched observations fail closed', () => {
        const variants = [
            observed => observed.coverage = 'stale',
            observed => observed.observedAt = iso(1441),
            observed => observed.pulses[10].finishedAt = iso(2000),
            observed => observed.pulses[10].at = observed.pulses[9].at,
            observed => observed.pulses[10].intervalMs = 0,
            observed => observed.pulses[10].at = at(40),
            observed => observed.pulses[10].quota[0].firstAt = at(40),
            observed => observed.pulses[10].quota[0].resetAt = 'invalid',
            observed => observed.pulses[10].quota[0].firstAt = iso(0),
            observed => observed.pulses[10].quota[0].lastAt = iso(2000)
        ];
        for (const mutate of variants) {
            const observed = history();
            mutate(observed);
            expect(wakeGateOf(observed, {now: at(1440) + 2000}).holds).toBe(false)
        }
        expect(wakeGateOf(history(), {now: at(1446)}).holds).toBe(false)
    });
});
