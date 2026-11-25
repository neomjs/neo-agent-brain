import {expect, test}                                 from '@playwright/test';
import fs                                             from 'fs';
import {createHash}                                   from 'node:crypto';
import {createFleetOpenWorkSource}                    from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';
import {createOpenWorkProducer}                       from '../../../../../../ai/services/fleet/openWorkProducer.mjs';
import {normalizeCiRepair}                            from '../../../../../../ai/services/fleet/openWorkCiRepair.mjs';
import {activeCiRepairClassification}                 from '../../../../../../ai/services/fleet/openWorkHolder.mjs';
import {normalizePullRequest, normalizeUnblocked}     from '../../../../../../ai/services/fleet/openWorkReducer.mjs';
import {planOpenWorkWakes}                            from '../../../../../../ai/services/fleet/openWorkWakes.mjs';
import {createPrTransitionEvents, withProducerPrLane} from '../../../../../../ai/services/fleet/producerPrLaneEvents.mjs';
import * as queryDocuments                            from '../../../../../../ai/services/github-workflow/queries/openWorkQueries.mjs';
import {
    OPEN_WORK_CLOSEOUT, OPEN_WORK_OUTSIDE_SNAPSHOT, OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL, OPEN_WORK_UNBLOCKED, openWorkQueryCost
} from '../../../../../../ai/services/github-workflow/queries/openWorkQueries.mjs';

const identities = {
    byLogin: login => ({'neo-opus-ada': '@neo-opus-ada', 'neo-gpt': '@neo-gpt'})[login] ?? null,
    byName : name  => ({Ada: '@neo-opus-ada', Euclid: '@neo-gpt'})[name] ?? null
};

/**
 * @summary One open search node.
 * @param {Object} [overrides]
 * @returns {Object}
 */
const pr = ({number=7, verdict='REVIEW_REQUIRED', rollup='SUCCESS', partial=false, author='neo-opus-ada', name='Ada'}={}) => ({
    number,
    headRefOid              : 'a1',
    reviewDecision          : verdict,
    mergeable               : 'MERGEABLE',
    isDraft                 : false,
    body                    : `Authored by ${name} (Claude Opus 5, Claude Code).`,
    author                  : {login: author},
    repository              : {nameWithOwner: 'acme/app'},
    reviewRequests          : {pageInfo: {hasNextPage: partial}, nodes: [{requestedReviewer: {__typename: 'User', login: 'neo-gpt'}}]},
    latestReviews           : {pageInfo: {hasNextPage: false}, nodes: []},
    latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: []},
    commits                 : {nodes: [{commit: {oid: 'a1', statusCheckRollup: {state: rollup}}}]}
});

/**
 * @summary One closed or merged search node.
 * @param {Number} number
 * @param {String} closedAt
 * @param {String} [state]
 * @returns {Object}
 */
const closed = (number, closedAt, state='CLOSED') => ({
    number, state, headRefOid: 'a1', closedAt, mergedAt: state === 'MERGED' ? closedAt : null, body: 'Authored by Ada (Claude).', author: {login: 'neo-opus-ada'}, repository: {nameWithOwner: 'acme/app'}
});

/**
 * @summary The kind of search a read sent: a seat's authored or held open work, closed PRs, outside PRs, or closed issues.
 * @param {String} search
 * @returns {'open'|'held'|'terminal'|'outside'|'closeout'}
 */
const kindOf = search => search.startsWith('is:issue ') ? 'closeout' : !search.includes('is:open') ? 'terminal' : search.includes('review-requested:') ? 'held' : search.includes('-author:') ? 'outside' : 'open';

/**
 * @summary A GraphQL stub answering each search from a script: open (authored), held and terminal
 * pages. Held pages default to one empty page.
 * @param {Object} script `{open: Object[][], held: Object[][], terminal: Object[][]}`: nodes per page.
 * @returns {{query: Function, calls: Object[]}}
 */
function github(script) {
    const calls = [];

    return {
        calls,
        query: async (text, {query: search, cursor}) => {
            const
                kind  = kindOf(search),
                pages = script[kind] ?? [[]],
                index = cursor ? Number(cursor) : 0;

            calls.push({kind, search, cursor});

            return {
                rateLimit: {cost: 1},
                search   : {nodes: pages[index] ?? [], pageInfo: {hasNextPage: index < pages.length - 1, endCursor: String(index + 1)}}
            }
        }
    }
}

/**
 * @summary The readers for one seat, Ada, reading with `query`.
 * @param {Function} query
 * @returns {Function}
 */
const ada = query => async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query}];

const clock = start => {
    let ms = Date.parse(start);

    return () => new Date(ms += 60000)
};

const memoryStore = () => {
    const store = {saved: null, saves: 0};

    return Object.assign(store, {load: () => store.saved, save: state => { store.saves++; store.saved = JSON.parse(JSON.stringify(state)) }})
};

test.describe('openWorkProducer — compact measured quota evidence (#761)', () => {
    const answer = (id = 'issuer-1', resetAt = '2026-10-14T11:00:00Z', cost = 2) => ({
        viewer: {id}, rateLimit: {cost, limit: 1000, remaining: 900, resetAt},
        search: {nodes: [], pageInfo: {hasNextPage: false}}
    });
    const options = readers => ({readers, repos: async () => ['acme/app'], identities, now: () => new Date('2026-10-14T10:00:00Z')});

    test('shared issuer reads compact by query while zero-row seat coverage stays explicit', async () => {
        const producer = createOpenWorkProducer(options(async () => ['ada', 'gpt'].map(login => ({
            seat: '@' + login, login, apiBase: 'https://api.github.com', query: async () => answer()
        }))));
        const pulse = (await producer.pulse()).pulses.at(-1);
        expect(pulse).toMatchObject({telemetryVersion: 1, cost: 10, pages: 5, costUnknown: false, outside: {complete: true, rows: 0}});
        expect(pulse.quota).toHaveLength(2);
        expect(pulse.quota[0]).toMatchObject({apiBase: 'https://api.github.com', viewerId: 'issuer-1', resetAt: '2026-10-14T11:00:00.000Z', limit: 1000, cost: 8, calls: 4, failed: 0, unknown: false});
        expect(pulse.quota[1]).toMatchObject({viewerId: 'issuer-1', cost: 2, calls: 1,
            queryHash: createHash('sha256').update(OPEN_WORK_OUTSIDE_SNAPSHOT).digest('hex')});
        expect(Date.parse(pulse.quota[0].firstAt)).toBeLessThanOrEqual(Date.parse(pulse.quota[0].lastAt));
        expect(pulse.seats).toEqual(['ada', 'gpt'].map(login => ({seat: '@' + login, benched: false, outcome: 'complete',
            authored: {complete: true, rows: 0}, held: {complete: true, rows: 0}, terminal: {required: false, complete: true, rows: 0}})));
    });

    test('static query identity, reported-zero failures and attempt ordering survive compact capture', async () => {
        let   failing = false, calls = 0;
        const query   = async (text, variables) => {
            calls++;
            if (failing) throw Object.assign(new Error('failed with reported zero'), {quota: answer('issuer-1', '2026-10-14T11:00:00Z', 0)});
            return answer();
        };
        const producer = createOpenWorkProducer(options(async () => [{seat: '@ada', login: 'ada', apiBase: 'https://api.github.com', query}]));
        await producer.pulse();
        const ordinary = (await producer.pulse()).pulses.at(-1);
        expect(ordinary.quota.map(row => row.queryHash)).toEqual([OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL, OPEN_WORK_OUTSIDE_SNAPSHOT, OPEN_WORK_CLOSEOUT].map(text => createHash('sha256').update(text).digest('hex')));
        expect(ordinary.quota[0]).toMatchObject({reported: true, maxMeasuredCost: 2, firstOrdinal: 1, lastOrdinal: 2, zeroCostFailedCalls: 0});
        expect(ordinary.quota[1]).toMatchObject({firstOrdinal: 3, lastOrdinal: 3});
        expect(ordinary.quota[2]).toMatchObject({firstOrdinal: 4, lastOrdinal: 4});
        expect(ordinary.quota[3]).toMatchObject({firstOrdinal: 5, lastOrdinal: 5});
        failing = true;
        const failed = (await producer.pulse()).pulses.at(-1);
        expect(failed).toMatchObject({cost: 0, costUnknown: false, quota: [{reported: true, calls: 1, failed: 1, zeroCostFailedCalls: 1}]});
        expect(Date.parse(failed.quota[0].firstAttemptAt)).toBeLessThanOrEqual(Date.parse(failed.quota[0].firstAt));
        expect(calls).toBe(9);
    });

    test('a reset within a pulse, missing quota fields and known error costs remain separate evidence', async () => {
        let   calls = 0;
        const query = async () => {
            if (++calls === 2) throw Object.assign(new Error('GraphQL error'), {quota: answer('issuer-1', '2026-10-14T12:00:00Z', 3)});
            return answer();
        };
        const pulse = (await createOpenWorkProducer(options(async () => [
            {seat: '@ada', login: 'ada', apiBase: 'https://api.github.com', query},
            {seat: '@gpt', login: 'gpt', apiBase: 'https://api.github.com', query: async () => ({search: {nodes: [], pageInfo: {hasNextPage: false}}})},
            {seat: '@bench', login: 'bench', query: null, benched: true}
        ])).pulse()).pulses.at(-1);
        expect(pulse).toMatchObject({cost: 5, pages: 4, costUnknown: true});
        expect(pulse.quota.map(({resetAt, cost, calls, failed, unknown}) => ({resetAt, cost, calls, failed, unknown}))).toEqual([
            {resetAt: '2026-10-14T11:00:00.000Z', cost: 2, calls: 1, failed: 0, unknown: false},
            {resetAt: '2026-10-14T12:00:00.000Z', cost: 3, calls: 1, failed: 1, unknown: false},
            {resetAt: null, cost: 0, calls: 2, failed: 0, unknown: true},
            {resetAt: null, cost: 0, calls: 1, failed: 0, unknown: true}
        ]);
        expect(pulse.seats[0]).toMatchObject({outcome: 'failed', authored: {complete: true, rows: 0}, held: {complete: false, rows: 0}});
        expect(pulse.seats[1]).toMatchObject({outcome: 'complete', authored: {complete: true, rows: 0}});
        expect(pulse.seats[2]).toMatchObject({benched: true, outcome: 'credential-unread'});
    });

    test('invalid pages count their answered cost once and unknown issuer is not unknown cost', async () => {
        const pulse = (await createOpenWorkProducer(options(async () => [{seat: '@ada', login: 'ada', apiBase: 'https://api.github.com',
            query: async () => ({rateLimit: answer().rateLimit, search: {nodes: []}})}])).pulse()).pulses.at(-1);
        expect(pulse).toMatchObject({cost: 2, pages: 1, costUnknown: false, quota: [{calls: 1, cost: 2, failed: 1, unknown: true}]});
    });

    test('default history retains a 25-hour predecessor and bounded explicit pulseWindow still truncates', async () => {
        let   at       = Date.parse('2026-10-14T10:00:00Z');
        const make     = pulseWindow => createOpenWorkProducer({...options(async () => []), repos: async () => [], now: () => new Date(at), ...(pulseWindow ? {pulseWindow} : {})});
        const producer = make(), bounded = make(2);
        for (let count = 0; count < 1503; count++, at += 60000) { await producer.pulse(); await bounded.pulse(); }
        const pulses = producer.getState().pulses;
        expect(pulses).toHaveLength(1502);
        expect(Date.parse(pulses.at(-1).at) - Date.parse(pulses[0].at)).toBe(25 * 60 * 60 * 1000 + 60000);
        expect(bounded.getState().pulses).toHaveLength(2);
    });

    test('remaining is diagnostic, endpoints stay distinct, and a failed page preserves its successful prefix', async () => {
        let   calls = 0;
        const query = async () => {
            const result = answer();
            delete result.rateLimit.remaining;
            if (++calls === 2) throw new Error('network');
            if (calls === 1) result.search = {nodes: [pr()], pageInfo: {hasNextPage: true, endCursor: 'next'}};
            return result;
        };
        const pulse = (await createOpenWorkProducer(options(async () => [
            {seat: '@ada', login: 'ada', apiBase: 'https://api.github.com', query},
            {seat: '@gpt', login: 'gpt', apiBase: 'https://github.example/api', query}
        ])).pulse()).pulses.at(-1);
        expect(pulse.quota).toHaveLength(4);
        expect(pulse.quota[0]).toMatchObject({remaining: null, unknown: false, calls: 1, cost: 2});
        expect(pulse.quota[1]).toMatchObject({viewerId: null, unknown: true, failed: 1, calls: 1});
        expect(pulse.quota[2]).toMatchObject({apiBase: 'https://github.example/api', viewerId: 'issuer-1', calls: 2});
        expect(pulse.quota[3]).toMatchObject({apiBase: 'https://github.example/api', viewerId: 'issuer-1', calls: 1,
            queryHash: createHash('sha256').update(OPEN_WORK_OUTSIDE_SNAPSHOT).digest('hex')});
        expect(pulse.seats[0]).toMatchObject({outcome: 'failed', authored: {complete: false, rows: 1}, held: null});
    });

    test('search coverage stays complete beside a nested-partial row, and the other fresh row can wake', async () => {
        let   red  = false;
        const head = 'a'.repeat(40), query = async (text, {query: search}) => ({...answer(), search: {
            pageInfo: {hasNextPage: false},
            nodes   : kindOf(search) === 'open' ? [true, false].map((partial, index) => ({
                ...pr({number: 7 + index, partial}), headRefOid: head,
                commits: {nodes: [{commit: {oid: head, statusCheckRollup: {state: red ? 'FAILURE' : 'PENDING'}}}]}
            })) : []
        }});
        const producer = createOpenWorkProducer({...options(async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', apiBase: 'https://api.github.com', query}]), now: clock('2026-10-14T10:00:00Z')});
        const first    = await producer.pulse(), baseline = planOpenWorkWakes({state: first, ledger: null, now: Date.parse(first.observedAt)});
        red = true;
        const state = await producer.pulse();
        expect(state.coverage).toBe('partial');
        expect(state.pulses.at(-1).seats[0]).toMatchObject({outcome: 'complete', authored: {complete: true, rows: 2}, held: {complete: true, rows: 0}, terminal: {required: true, complete: true, rows: 0}});
        expect(state.snapshot.rows['acme/app#7'].partial).toBe(true);
        expect(state.snapshot.rows['acme/app#8']).toMatchObject({partial: false, observedAt: state.observedAt});
        const planned = planOpenWorkWakes({state, ledger: baseline.ledger, now: Date.parse(state.observedAt)});
        expect(planned.wakes).toHaveLength(1);
        expect(planned.wakes[0]).toMatchObject({number: 8, kind: 'repair-ci', to: '@neo-opus-ada'});
    });

    test('a response received after its old reset boundary retains the measured charged window', async () => {
        const pulse = (await createOpenWorkProducer(options(async () => [{seat: '@ada', login: 'ada', apiBase: 'https://api.github.com',
            query: async () => answer('issuer-1', '2026-10-14T09:59:59Z')
        }])).pulse()).pulses.at(-1);
        expect(pulse).toMatchObject({cost: 6, costUnknown: false, quota: [
            {resetAt: '2026-10-14T09:59:59.000Z', cost: 4, calls: 2, unknown: false},
            {resetAt: '2026-10-14T09:59:59.000Z', cost: 2, calls: 1, unknown: false}
        ]});
        for (const row of pulse.quota) expect(Date.parse(row.firstAt)).toBeGreaterThan(Date.parse(row.resetAt));
    });
});

test.describe('openWorkProducer — one producer observes, records, and wakes no one (#760)', () => {
    test('a pulse after the baseline records the verdict change, its cost and the seat it belongs to', async () => {
        let script = {open: [[pr()]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            producer = createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app', 'acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        await producer.pulse();
        script = {open: [[pr({verdict: 'APPROVED'})]], terminal: [[]]};

        const state = await producer.pulse();

        expect(state.coverage).toBe('complete');
        expect(state.transitions.map(({kind, to}) => [kind, to])).toEqual([['verdict', 'APPROVED']]);
        expect(state.pulses.at(-1)).toMatchObject({cost: 5, pages: 5, coverage: 'complete', transitions: {'@neo-opus-ada': 1}});
        // the seat reads what it authored and holds, one scope per repository; the terminal read is its
        // window of close times from its watermark, an overlap back
        expect(stub.calls.slice(0, 2).map(call => call.search)).toEqual([
            'is:pr is:open archived:false author:neo-opus-ada repo:acme/app',
            'is:pr is:open archived:false review-requested:neo-opus-ada repo:acme/app'
        ]);
        expect(stub.calls.find(call => call.kind === 'terminal').search).toBe('is:pr is:closed closed:2026-10-02T09:51:00Z..2026-10-02T10:02:00Z author:neo-opus-ada repo:acme/app')
    });

    test('a merge the search indexes after its window ended is read in the next window\'s overlap, once', async () => {
        let script = {open: [[pr()]], terminal: [[]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            producer = createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        // merged at 10:01:50, but the 10:02 pulse still reads it open and its window finds nothing
        await producer.pulse();
        await producer.pulse();
        script = {open: [[]], terminal: [[closed(7, '2026-10-02T10:01:50Z', 'MERGED')]]};
        await producer.pulse();

        const state = await producer.pulse();

        expect(state.transitions.map(({key, kind}) => [key, kind])).toEqual([['acme/app#7', 'merged']]);
        expect(stub.calls.filter(call => call.kind === 'terminal')[1].search).toBe('is:pr is:closed closed:2026-10-02T09:52:00Z..2026-10-02T10:03:00Z author:neo-opus-ada repo:acme/app')
    });

    test('a PR that leaves complete reads with no terminal row is vanished on its pulse, never a close', async () => {
        let script = {open: [[pr()]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            producer = createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        await producer.pulse();
        script = {open: [[]], terminal: [[]]};

        const state = await producer.pulse();

        expect(state).toMatchObject({transitions: [], snapshot: {rows: {}}});
        expect(state.pulses.at(-1)).toMatchObject({coverage: 'complete', vanished: ['acme/app#7']})
    });

    test('a pulse asked for while one runs is that pulse: an older read never lands over a newer one', async () => {
        let release;

        const
            calls    = [],
            gate     = new Promise(resolve => { release = resolve }),
            query    = async (text, variables) => (calls.push(variables), await gate, {rateLimit: {cost: 1}, search: {nodes: [pr()], pageInfo: {hasNextPage: false}}}),
            producer = createOpenWorkProducer({readers: ada(query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}),
            first    = producer.pulse(),
            second   = producer.pulse();

        await new Promise(resolve => setTimeout(resolve, 0));
        release();

        expect(await second).toBe(await first);
        // one pulse's two seat open reads plus the outside open read, never a second pulse's
        expect(calls).toHaveLength(3)
    });

    test('a page without its structure is a failed read: the snapshot stays and the watermark holds', async () => {
        let script = {open: [[pr()]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            query    = async (text, variables) => script.broken ? {rateLimit: {cost: 1}, search: {nodes: []}} : stub.query(text, variables),
            producer = createOpenWorkProducer({readers: ada(query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}),
            baseline = await producer.pulse();

        script = {broken: true};

        expect(await producer.pulse()).toMatchObject({coverage: 'stale', reason: 'the GitHub read failed for @neo-opus-ada: the next pulse reads again', watermark: baseline.watermark});
        expect(Object.keys(producer.getState().snapshot.rows)).toEqual(['acme/app#7'])
    });

    test('a page past the budget, or a truncated request list, leaves the pulse partial, and the first still starts the watermark', async () => {
        const budgeted = createOpenWorkProducer({readers: ada(github({open: [[pr()], [pr({number: 8})], [pr({number: 9})]]}).query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), pageBudget: 2});

        expect(await budgeted.pulse()).toMatchObject({coverage: 'partial', watermark: '2026-10-02T09:51:00.000Z'});

        const truncated = createOpenWorkProducer({readers: ada(github({open: [[pr({partial: true})]]}).query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        expect(await truncated.pulse()).toMatchObject({coverage: 'partial', watermark: '2026-10-02T09:51:00.000Z'})
    });

    test('a terminal backlog past the budget reaches its tail across pulses and a restart, then moves the watermark', async () => {
        const
            store    = memoryStore(),
            stub     = github({open: [[pr()]], terminal: [[closed(1, '2026-10-02T10:01:10Z')], [closed(2, '2026-10-02T10:01:20Z')], [closed(3, '2026-10-02T10:01:30Z')]]}),
            make     = start => createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: clock(start), store, pageBudget: 2}),
            baseline = await make('2026-10-02T10:00:00Z').pulse(),
            first    = await make('2026-10-02T10:01:00Z').pulse();

        expect(first).toMatchObject({coverage: 'partial', watermark: baseline.watermark});
        expect(first.readers['neo-opus-ada'].window).toMatchObject({since: baseline.watermark, until: '2026-10-02T10:02:00.000Z', cursor: '2'});

        // a restarted producer resumes the seat's window at the same cursor, so page 3 is finally read
        const tail = await make('2026-10-02T10:02:00Z').pulse();

        expect(stub.calls.filter(call => call.kind === 'terminal').map(call => call.cursor)).toEqual([null, '1', '2']);
        expect(tail).toMatchObject({coverage: 'complete', watermark: '2026-10-02T09:52:00.000Z', readers: {'neo-opus-ada': {window: null}}})
    });

    test('an hour of partial pulses after a complete baseline never makes the row they missed fresh', async () => {
        let script = {open: [[pr(), pr({number: 8})]], terminal: [[]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            every10  = (() => { let ms = Date.parse('2026-10-02T10:00:00Z'); return () => new Date(ms += 10 * 60000) })(),
            producer = createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: every10, pageBudget: 1});

        // a complete baseline at 10:10, then seven pulses to 11:20 that read only the first page
        await producer.pulse();
        script = {open: [[pr()], [pr({number: 8})]], terminal: [[]]};

        for (let pulse = 0; pulse < 7; pulse++) await producer.pulse();

        const read = createFleetOpenWorkSource({producer, now: () => Date.parse('2026-10-02T11:21:00Z')}).readOpenWork();

        expect(read).toMatchObject({state: 'ok', coverage: 'partial', unobserved: 1});
        expect(read.seats['@neo-opus-ada'].authored.map(({number}) => number)).toEqual([7])
    });

    test('a failed pulse records what its answered requests cost, and marks the rest unknown', async () => {
        const
            stub     = github({open: [[pr()]]}),
            query    = async (text, variables) => { if (variables.query.includes('is:closed')) throw new Error('timeout'); return stub.query(text, variables) },
            producer = createOpenWorkProducer({readers: ada(query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        await producer.pulse();
        await producer.pulse();

        expect(producer.getState().pulses.at(-1)).toMatchObject({failed: true, cost: 2, pages: 2, costUnknown: true})
    });

    test('a failed read is stale over a snapshot and unavailable without one, its reason naming the seat and the next step, its detail redacted', async () => {
        let fail = true;

        const
            query    = async (...args) => { if (fail) throw new Error('Bad credentials for ghp_privateCanary0123456789abcdefABCDEF'); return github({open: [[pr()]]}).query(...args) },
            producer = createOpenWorkProducer({readers: ada(query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        const first = await producer.pulse();

        expect(first).toMatchObject({coverage: 'unavailable', reason: 'the GitHub read failed for @neo-opus-ada: the next pulse reads again'});
        expect(first.detail).toContain('Bad credentials');
        expect(JSON.stringify(first)).not.toContain('privateCanary');

        fail = false;
        await producer.pulse();
        fail = true;

        expect((await producer.pulse()).coverage).toBe('stale');
        expect(producer.getState().snapshot.rows['acme/app#7']).toBeTruthy()
    });

    test('no seat on a GitHub repository is unavailable with its reason, not an empty board', async () => {
        const producer = createOpenWorkProducer({readers: ada(github({}).query), repos: async () => [], identities});

        expect(await producer.pulse()).toMatchObject({coverage: 'unavailable', reason: 'no seat works on a GitHub repository'})
    });

    test('the store carries the snapshot across a restart, so the next pulse diffs instead of re-baselining', async () => {
        const store = memoryStore();

        await createOpenWorkProducer({readers: ada(github({open: [[pr()]]}).query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), store}).pulse();

        const restarted = createOpenWorkProducer({readers: ada(github({open: [[pr({rollup: 'FAILURE'})]], terminal: [[]]}).query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:05:00Z'), store});

        expect((await restarted.pulse()).transitions.map(({kind, to}) => [kind, to])).toEqual([['ci', 'red']])
    });

    test('saved state that cannot be read is unavailable, is never saved over, and is read again on the next pulse', async () => {
        const store = memoryStore();

        await createOpenWorkProducer({readers: ada(github({open: [[pr()]]}).query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), store}).pulse();

        const
            saved = store.saved,
            saves = store.saves,
            load  = store.load;
        let unreadable = true;

        store.load = () => { if (unreadable) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'}); return load() };

        const producer = createOpenWorkProducer({readers: ada(github({open: [[pr({rollup: 'FAILURE'})]], terminal: [[]]}).query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:05:00Z'), store});

        expect(await producer.pulse()).toMatchObject({coverage: 'unavailable', reason: 'the saved open-work state could not be read'});
        expect(store.saves).toBe(saves);
        expect(store.saved).toEqual(saved);

        unreadable = false;

        expect((await producer.pulse()).transitions.map(({kind, to}) => [kind, to])).toEqual([['ci', 'red']])
    });

    test('observe-only: the producer and its reducer name no mailbox', () => {
        for (const file of ['openWorkProducer.mjs', 'openWorkReducer.mjs']) {
            const source = fs.readFileSync(new URL(`../../../../../../ai/services/fleet/${file}`, import.meta.url), 'utf8');

            expect(source, file).not.toMatch(/planeMailboxClient|add_message|addMessage/)
        }
    });
});

test.describe('openWorkProducer — each seat reads its own work with its own PAT (ADR 0038 §2.5.1 row 7)', () => {
    test('seat query documents exclude outside-only CI and comment evidence', async () => {
        const calls = [];
        const query = async (document, {query: search}) => {
            calls.push({document, kind: kindOf(search)});
            return {rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}};
        };
        await createOpenWorkProducer({readers: ada(query), repos: async () => ['acme/app'], identities,
            now: clock('2026-11-16T10:00:00Z')}).pulse();
        expect(calls.map(call => call.kind)).toEqual(['open', 'held', 'outside']);
        const leanComments = /comments\s*\(last:\s*10\)\s*\{\s*pageInfo\s*\{\s*hasPreviousPage\s*\}\s*nodes\s*\{\s*createdAt\s+authorAssociation\s+author\s*\{\s*__typename\s+login\s*\}\s*\}\s*\}/;
        for (const {document} of calls.filter(call => call.kind !== 'outside')) {
            expect(document).not.toMatch(/\bcontexts\s*\(/);
            expect(document.match(/\bcomments\s*\(/g)).toHaveLength(1);
            expect(document).toMatch(leanComments);
            expect(document).toBe(queryDocuments.OPEN_WORK_SNAPSHOT);
        }
        const outside = calls.find(call => call.kind === 'outside').document;
        expect(outside).toMatch(/\bcontexts\s*\(/);
        expect(outside.match(/\bcomments\s*\(/g)).toHaveLength(1);
        expect(outside).toMatch(/comments\s*\(last:\s*10\)\s*\{\s*pageInfo\s*\{\s*hasPreviousPage\s*\}\s*nodes\s*\{\s*id\s+url\s+body\s+updatedAt\s+createdAt\s+authorAssociation\s+author\s*\{\s*__typename\s+\.\.\.\s+on\s+Node\s*\{\s*id\s*\}\s+login\s*\}/);
        expect(outside).not.toBe(queryDocuments.OPEN_WORK_SNAPSHOT);
        expect(outside).toBe(queryDocuments.OPEN_WORK_OUTSIDE_SNAPSHOT);
    });

    /** @summary Original provider evidence and a maintainer's content classification for a held outside PR. */
    const classifiedOutsidePr = () => {
        const head = 'a'.repeat(40), at = '2026-11-16T10:00:00Z';
        const node = {...pr({author: 'external-dev', rollup: 'FAILURE'}), id: 'PR_7', headRefOid: head,
            title   : 'Outside fix', body: 'External fix', authorAssociation: 'CONTRIBUTOR',
            author  : {__typename: 'User', login: 'external-dev'},
            comments: {nodes: [], pageInfo: {hasPreviousPage: false}},
            commits : {nodes: [{commit: {oid: head, statusCheckRollup: {state: 'FAILURE',
                contexts: {pageInfo: {hasNextPage: false}, nodes: [{__typename: 'CheckRun', id: 'CHECK_1', name: 'unit',
                    status    : 'COMPLETED', conclusion: 'FAILURE', startedAt: at, completedAt: at,
                    checkSuite: {app: {id: 'APP_1', slug: 'actions'}, workflowRun: {workflow: {id: 'WORKFLOW_1', name: 'CI'}}}}]}}}}]}};
        const evidence = normalizeCiRepair(node, identities, {apiBase: 'https://api.github.com'}).ciRepairEvidence;
        node.comments.nodes.push({id: 'COMMENT_1', url: 'https://github.com/acme/app/pull/7#issuecomment-1',
            createdAt: at, updatedAt: at, authorAssociation: 'MEMBER',
            author   : {__typename: 'User', id: 'USER_ADA', login: 'neo-opus-ada'},
            body     : '<!-- neo-ci-repair-classification:v1 ' + JSON.stringify({head, evidenceKey: evidence.key, kind: 'content'}) + ' -->'});
        return node;
    };

    /** @summary Answers only fields requested by the lean seat document or the outside document. */
    const queriedOutsidePr = (node, document, title) => {
        const result = structuredClone(node);
        result.title = title;
        if (!/\bcontexts\s*\(/.test(document)) {
            delete result.commits.nodes[0].commit.statusCheckRollup.contexts;
            result.comments.nodes = result.comments.nodes.map(({createdAt, authorAssociation, author}) =>
                ({createdAt, authorAssociation, author: {__typename: author.__typename, login: author.login}}));
        }
        return result;
    };

    test('the outside document preserves evidence and classification and wins over the held seat row', async () => {
        const node  = classifiedOutsidePr();
        const query = async (document, {query: search}) => {
            const kind  = kindOf(search);
            const nodes = ['held', 'outside'].includes(kind) ? [queriedOutsidePr(node, document, kind)] : [];
            return {rateLimit: {cost: 1}, search: {nodes, pageInfo: {hasNextPage: false}}};
        };
        const state = await createOpenWorkProducer({
            readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', apiBase: 'https://api.github.com', query}],
            repos  : async () => ['acme/app'], identities,
            now    : clock('2026-11-16T10:00:00Z')}).pulse();
        expect(Object.keys(state.snapshot.rows)).toEqual(['acme/app#7']);
        const row = state.snapshot.rows['acme/app#7'];
        expect(row.title).toBe('outside');
        expect(row.ciRepairEvidence).toMatchObject({head: node.headRefOid, failedChecks: ['unit']});
        expect(activeCiRepairClassification(row)).toMatchObject({kind: 'content', maintainer: '@neo-opus-ada',
            evidenceKey: row.ciRepairEvidence.key, receiptUrl: node.comments.nodes[0].url});
    });

    for (const previouslyAdmitted of [false, true]) {
        test(`a failed outside read leaves held-seat evidence unavailable with ${previouslyAdmitted ? 'only its dormant prior' : 'no invented'} classification`, async () => {
            const node        = classifiedOutsidePr();
            let   failOutside = !previouslyAdmitted;
            const query       = async (document, {query: search}) => {
                const kind = kindOf(search);
                if (kind === 'outside' && failOutside) throw new Error('outside search unavailable');
                const nodes = ['held', 'outside'].includes(kind) ? [queriedOutsidePr(node, document, kind)] : [];
                return {rateLimit: {cost: 1}, search: {nodes, pageInfo: {hasNextPage: false}}};
            };
            const producer = createOpenWorkProducer({
                readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', apiBase: 'https://api.github.com', query}],
                repos  : async () => ['acme/app'], identities,
                now    : clock('2026-11-16T10:00:00Z')});
            const prior = previouslyAdmitted ? (await producer.pulse()).snapshot.rows['acme/app#7'] : null;
            if (prior) expect(activeCiRepairClassification(prior)?.kind).toBe('content');
            failOutside = true;
            const state = await producer.pulse(), row = state.snapshot.rows['acme/app#7'];
            expect(state.coverage).toBe('partial');
            expect(state.pulses.at(-1).outside).toEqual({complete: false, rows: 0});
            expect(row).toMatchObject({title: 'held', observedAt: state.observedAt, ciRepairEvidence: null,
                ciRepairRead: {coverage: 'unavailable'}});
            expect(row.ciRepairClassification).toEqual(prior?.ciRepairClassification ?? null);
            expect(activeCiRepairClassification(row)).toBeNull();
        });
    }

    /**
     * @summary A query that answers as one seat: only that seat's authored or held work, recording
     * every search it was asked.
     * @param {Object} work `{authored: Object[], held: Object[], outside?: Object[], closed: Object[]}`
     * @returns {{query: Function, searches: String[]}}
     */
    const asSeat = ({authored = [], held = [], outside = [], closed: ended = [], closeout = []}) => {
        const searches = [];

        return {
            searches,
            query: async (text, {query: search}) => {
                searches.push(search);

                const nodes = {open: authored, held, outside, terminal: ended, closeout}[kindOf(search)];

                return {rateLimit: {cost: 1}, search: {nodes, pageInfo: {hasNextPage: false}}}
            }
        }
    };

    test('every seat reads only its own login\'s work, and the rows merge: a PR one seat holds is read once', async () => {
        const
            adaSeat    = asSeat({authored: [pr()]}),
            euclidSeat = asSeat({authored: [pr({number: 9, author: 'neo-gpt', name: 'Euclid'})], held: [pr()]}),
            producer   = createOpenWorkProducer({
                readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaSeat.query}, {seat: '@neo-gpt', login: 'neo-gpt', query: euclidSeat.query}],
                repos  : async () => ['acme/app'],
                identities,
                now    : clock('2026-10-02T10:00:00Z')
            }),
            state      = await producer.pulse();

        expect(adaSeat.searches.filter(search => !search.includes('-author:')).every(search => search.includes('neo-opus-ada') && !search.includes('neo-gpt'))).toBe(true);
        expect(adaSeat.searches.find(search => search.includes('-author:'))).toBe('is:pr is:open archived:false -author:neo-opus-ada -author:neo-gpt repo:acme/app');
        expect(euclidSeat.searches.every(search => search.includes(':neo-gpt ') && !search.includes('neo-opus-ada'))).toBe(true);
        expect(Object.keys(state.snapshot.rows).sort()).toEqual(['acme/app#7', 'acme/app#9']);
        expect(state).toMatchObject({coverage: 'complete', reason: null})
    });

    test('unassigned outside contributor PRs are discovered by one search across every repository, and a failed outside read stays partial while keeping carried outside rows (#1008, #1535)', async () => {
        let failOutside = false;
        const
            outsidePr = {...pr({number: 42, author: 'external-dev', name: 'External'}), body: 'External fix', repository: {nameWithOwner: 'acme/lib'}, reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []}},
            searches  = [],
            query     = async (text, {query: search}) => {
                if (kindOf(search) === 'outside') {
                    searches.push(search);
                    if (failOutside) throw new Error('outside search failed');
                    return {rateLimit: {cost: 1}, search: {nodes: [outsidePr], pageInfo: {hasNextPage: false}}}
                }
                return {rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}}
            },
            producer  = createOpenWorkProducer({
                readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query}],
                repos  : async () => ['acme/lib', 'acme/app'],
                identities,
                now    : clock('2026-10-02T10:00:00Z')
            }),
            first     = await producer.pulse();

        // the reading PAT pays one search a pulse, however many repositories the seats work on
        expect(searches).toEqual(['is:pr is:open archived:false -author:neo-opus-ada repo:acme/app repo:acme/lib']);
        expect(first.coverage).toBe('complete');
        expect(first.pulses.at(-1).outside).toEqual({complete: true, rows: 1});
        expect(first.snapshot.rows['acme/lib#42']?.owner).toEqual({kind: 'outside', seat: null, login: 'external-dev'});

        failOutside = true;
        const second = await producer.pulse();
        expect(second.coverage).toBe('partial');
        expect(second.pulses.at(-1).outside).toEqual({complete: false, rows: 0});
        expect(second.snapshot.rows['acme/lib#42']?.observedAt).toBe(first.observedAt);
    });

    test('a seat without a readable PAT is named with its next step, never "set GH_TOKEN", and the others still read', async () => {
        const
            adaSeat  = asSeat({authored: [pr()]}),
            readers  = async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaSeat.query}, {seat: '@neo-gpt', login: 'neo-gpt', query: null}],
            producer = createOpenWorkProducer({readers, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}),
            state    = await producer.pulse();

        expect(state).toMatchObject({coverage: 'partial', reason: '@neo-gpt has no readable PAT: connect again with a current token for it'});
        expect(Object.keys(state.snapshot.rows)).toEqual(['acme/app#7']);
        expect(state.pulses.at(-1).unread).toEqual(['@neo-gpt']);
        expect(JSON.stringify(state)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);

        const nobody = createOpenWorkProducer({readers: async () => [{seat: '@neo-gpt', login: 'neo-gpt', query: null}], repos: async () => ['acme/app'], identities});

        expect(await nobody.pulse()).toMatchObject({coverage: 'unavailable', reason: '@neo-gpt has no readable PAT: connect again with a current token for it'})
    });

    test('a seat whose read fails leaves the pulse partial and named, and its rows carry instead of vanishing', async () => {
        let failing = false;

        const
            adaSeat    = asSeat({authored: [pr()]}),
            euclidSeat = asSeat({authored: [pr({number: 9, author: 'neo-gpt', name: 'Euclid'})]}),
            euclid     = async (...args) => { if (failing) throw new Error('Bad credentials'); return euclidSeat.query(...args) },
            producer   = createOpenWorkProducer({
                readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaSeat.query}, {seat: '@neo-gpt', login: 'neo-gpt', query: euclid}],
                repos  : async () => ['acme/app'],
                identities,
                now    : clock('2026-10-02T10:00:00Z')
            });

        await producer.pulse();
        failing = true;

        const state = await producer.pulse();

        expect(state).toMatchObject({coverage: 'partial', reason: 'the GitHub read failed for @neo-gpt: the next pulse reads again'});
        expect(state.detail).toContain('Bad credentials');
        expect(Object.keys(state.snapshot.rows).sort()).toEqual(['acme/app#7', 'acme/app#9']);
        expect(state.pulses.at(-1).vanished).toEqual([])
    });

    test('a benched seat owes no coverage: its failed read leaves the pulse complete, and its rows carry (#916)', async () => {
        let failing = false;

        const
            adaSeat    = asSeat({authored: [pr()]}),
            euclidSeat = asSeat({authored: [pr({number: 9, author: 'neo-gpt', name: 'Euclid'})]}),
            euclid     = async (...args) => { if (failing) throw Object.assign(new Error('GitHub GraphQL answered 401: Bad credentials'), {status: 401}); return euclidSeat.query(...args) },
            producer   = benched => createOpenWorkProducer({
                readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaSeat.query, benched: false}, {seat: '@neo-gpt', login: 'neo-gpt', query: euclid, benched}],
                repos  : async () => ['acme/app'],
                identities,
                now    : clock('2026-10-02T10:00:00Z')
            }),
            bench      = producer(true),
            control    = producer(false);

        await bench.pulse();
        await control.pulse();
        failing = true;

        const state = await bench.pulse();

        expect(state).toMatchObject({coverage: 'complete', reason: null});
        expect(Object.keys(state.snapshot.rows).sort()).toEqual(['acme/app#7', 'acme/app#9']);
        expect(state.snapshot.rows['acme/app#9'].observedAt).toBe(state.pulses[0].at);
        // the miss stays on the pulse's record, never in the coverage verdict
        expect(state.pulses.at(-1)).toMatchObject({unread: ['@neo-gpt'], vanished: []});
        // control: the same failure from a seat that participates leaves the pulse partial and named
        expect(await control.pulse()).toMatchObject({coverage: 'partial', reason: 'GitHub refused the PAT of @neo-gpt: connect again with a current token for it'})
    });

    test('a request list cut at its first page may hide a benched seat: its row carries and is no opened, while a complete list still leaves (#916)', async () => {
        let failing = false;

        const
            // an outside author's PR whose review requests show `visible`, and continue past the first page when `more`
            held     = (number, visible, more) => ({
                ...pr({number, author: 'outsider', name: 'Nobody'}),
                reviewRequests: {pageInfo: {hasNextPage: more}, nodes: visible.map(login => ({requestedReviewer: {__typename: 'User', login}}))}
            }),
            ada      = {authored: [], held: [held(19, ['neo-opus-ada'], true), held(21, ['neo-opus-ada'], false)]},
            euclid   = {authored: [], held: [held(19, ['neo-opus-ada'], true)]},
            answer   = work => async (text, {query: search}) => ({rateLimit: {cost: 1}, search: {nodes: {open: work.authored, held: work.held, outside: [], terminal: [], closeout: []}[kindOf(search)], pageInfo: {hasNextPage: false}}}),
            producer = createOpenWorkProducer({
                readers   : async () => [
                    {seat: '@neo-opus-ada', login: 'neo-opus-ada', query: answer(ada), benched: false},
                    {seat: '@neo-gpt',      login: 'neo-gpt',      query: async (...args) => { if (failing) throw new Error('GitHub GraphQL answered 502: no data'); return answer(euclid)(...args) }, benched: true}
                ],
                repos: async () => ['acme/app'],
                identities,
                now  : clock('2026-10-02T10:00:00Z')
            }),
            first    = await producer.pulse();

        // Ada's requests are gone, and benched Euclid, past the first page of the cut list, misses
        ada.held = [];
        failing  = true;

        const missed = await producer.pulse();

        expect(missed).toMatchObject({coverage: 'complete'});
        expect(missed.snapshot.rows['acme/app#19'].observedAt).toBe(first.observedAt);
        // control: a complete list that does not name Euclid is evidence, so its row leaves
        expect(missed.pulses.at(-1).vanished).toEqual(['acme/app#21']);

        // Euclid reads again: a cut row first seen now may only have been unread, while Ada's own new PR opened
        failing      = false;
        euclid.held  = [held(19, ['neo-opus-ada'], true), held(20, ['neo-opus-ada'], true)];
        ada.authored = [{...pr({number: 22}), reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []}}];

        const back = await producer.pulse();

        expect(back.transitions.filter(({kind, pulse}) => kind === 'opened' && pulse === back.observedAt).map(({key}) => key)).toEqual(['acme/app#22'])
    });

    test('only a PAT GitHub refused (401) or one missing a scope asks for a new token; any other failed read names the next pulse (#1535)', async () => {
        const
            refused = async () => { throw Object.assign(new Error('GitHub GraphQL answered 401: Bad credentials'), {status: 401}) },
            // GitHub answers a missing scope with 200 and an error; the next pulse fails the same way
            scoped  = async () => { throw Object.assign(new Error('GitHub GraphQL answered 200: Your token has not been granted the required scopes to execute this query.'), {status: 200, code: 'INSUFFICIENT_SCOPES'}) },
            flaky   = async () => { throw Object.assign(new Error('GitHub GraphQL answered 502: no data'), {status: 502}) },
            pulse   = readers => createOpenWorkProducer({readers: async () => readers, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}).pulse(),
            adaSeat = {seat: '@neo-opus-ada', login: 'neo-opus-ada', query: asSeat({authored: [pr()]}).query};

        expect(await pulse([adaSeat, {seat: '@neo-gpt', login: 'neo-gpt', query: refused}]))
            .toMatchObject({coverage: 'partial', reason: 'GitHub refused the PAT of @neo-gpt: connect again with a current token for it'});
        expect(await pulse([adaSeat, {seat: '@neo-gpt', login: 'neo-gpt', query: scoped}]))
            .toMatchObject({coverage: 'partial', reason: 'GitHub refused the PAT of @neo-gpt: connect again with a current token for it'});
        expect(await pulse([adaSeat, {seat: '@neo-gpt', login: 'neo-gpt', query: flaky}]))
            .toMatchObject({coverage: 'partial', reason: 'the GitHub read failed for @neo-gpt: the next pulse reads again'});
        expect(await pulse([{seat: '@neo-gpt', login: 'neo-gpt', query: refused}]), 'the only seat, refused: unavailable with the same step')
            .toMatchObject({coverage: 'unavailable', reason: 'GitHub refused the PAT of @neo-gpt: connect again with a current token for it', detail: 'GitHub GraphQL answered 401: Bad credentials'})
    });

    test('a saved single watermark seeds every seat\'s window, so an upgrade keeps its catch-up', async () => {
        const store = memoryStore();

        store.saved = {
            snapshot : {rows: {}, closed: {}, complete: true}, observedAt: '2026-10-02T10:00:00.000Z', coverage: 'complete',
            watermark: '2026-10-02T09:50:00.000Z', window: null, reason: null, detail: null, transitions: [], pulses: []
        };

        const
            stub     = github({open: [[]], terminal: [[]]}),
            producer = createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:01:00Z'), store}),
            state    = await producer.pulse();

        expect(stub.calls.find(call => call.kind === 'terminal').search).toBe('is:pr is:closed closed:2026-10-02T09:50:00Z..2026-10-02T10:02:00Z author:neo-opus-ada repo:acme/app');
        expect(state.readers['neo-opus-ada'].watermark).toBe('2026-10-02T09:52:00.000Z')
    });

    // on the first upgrade pulse a seat that cannot read must keep the saved boundary, or the seat that can read
    // advances the aggregate past a merge the other has not yet read
    for (const cause of ['has no readable PAT', 'fails its read']) {
        test(`an upgrade keeps the saved boundary for a seat that ${cause} on its first pulse, so its later read finds the merge`, async () => {
            let phase = 'baseline';

            const
                store  = memoryStore(),
                merged = {...closed(9, '2026-10-02T09:15:00Z', 'MERGED'), author: {login: 'neo-gpt'}, body: 'Authored by Euclid (GPT).'},
                euclid = async (text, {query: search}) => {
                    if (phase === 'outage') throw new Error('Bad credentials');

                    const
                        kind  = kindOf(search),
                        range = search.match(/closed:(\S+)\.\.(\S+)/),
                        nodes = kind === 'open' ? (phase === 'baseline' ? [pr({number: 9, author: 'neo-gpt', name: 'Euclid'})] : [])
                            : kind === 'terminal' ? [merged].filter(node => node.closedAt >= range[1] && node.closedAt <= range[2]) : [];

                    return {rateLimit: {cost: 1}, search: {nodes, pageInfo: {hasNextPage: false}}}
                },
                seatsFor = () => [
                    {seat: '@neo-opus-ada', login: 'neo-opus-ada', query: asSeat({}).query},
                    {seat: '@neo-gpt', login: 'neo-gpt', query: phase === 'outage' && cause === 'has no readable PAT' ? null : euclid}
                ],
                start    = time => createOpenWorkProducer({readers: async () => seatsFor(), repos: async () => ['acme/app'], identities, now: clock(time), store});

            // a saved state from before per-seat reads: Euclid's PR open, one single watermark
            await start('2026-10-02T08:59:00Z').pulse();
            store.saved = {...store.saved, readers: undefined, watermark: '2026-10-02T09:00:00.000Z'};

            const producer = start('2026-10-02T09:59:00Z');

            phase = 'outage';

            const first = await producer.pulse();

            expect(first.readers['neo-gpt'].watermark, 'the unread seat keeps the saved boundary').toBe('2026-10-02T09:00:00.000Z');
            expect(first.watermark, 'and the aggregate cannot pass it').toBe('2026-10-02T09:00:00.000Z');

            phase = 'recovered';

            const second = await producer.pulse();

            expect(second.coverage).toBe('complete');
            expect(second.pulses.at(-1).vanished, 'the merge is read, not vanished').toEqual([]);
            expect(Object.keys(second.snapshot.rows)).toEqual([])
        })
    }

    test('projects typed per-seat credentialRefusal and preserves last answered tokenExpiresAt across failed reads (#1601)', async () => {
        let euclidMode = 'expiring';

        const
            withExpiry = (data, tokenExpiresAt) => {
                Object.defineProperty(data, 'tokenExpiresAt', {value: tokenExpiresAt, enumerable: false, configurable: true});
                return data
            },
            adaQuery    = async () => withExpiry({rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}}, null),
            euclidQuery = async (text, variables) => {
                if (euclidMode === 'expiring') {
                    return withExpiry({rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}}, '2026-12-20T00:00:00.000Z')
                }
                if (euclidMode === '401') {
                    throw Object.assign(new Error('GitHub GraphQL answered 401: Bad credentials'), {status: 401})
                }
                if (euclidMode === 'scopes') {
                    throw Object.assign(
                        new Error("GitHub GraphQL answered 200: The 'login' field requires ['read:org']"),
                        {status: 200, code: 'INSUFFICIENT_SCOPES'}
                    )
                }
                if (euclidMode === '403-rate-limited') {
                    throw Object.assign(
                        new Error('GitHub GraphQL answered 403: You have exceeded a secondary rate limit.'),
                        {status: 403, headers: {'retry-after': '60', 'x-ratelimit-remaining': '0'}, body: {message: 'You have exceeded a secondary rate limit.'}}
                    )
                }
                if (euclidMode === 'partial-then-fail') {
                    if (kindOf(variables.query) === 'open') {
                        return withExpiry({rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}}, '2026-12-25T00:00:00.000Z')
                    }
                    throw Object.assign(new Error('GitHub GraphQL answered 502: no data'), {status: 502})
                }
                if (euclidMode === '502') {
                    throw Object.assign(new Error('GitHub GraphQL answered 502: no data'), {status: 502})
                }
                return withExpiry({rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}}, null)
            },
            nowMs    = {value: Date.parse('2026-10-02T10:00:00.000Z')},
            producer = createOpenWorkProducer({
                readers   : async () => [
                    {seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaQuery},
                    {seat: '@neo-gpt',      login: 'neo-gpt',      query: euclidQuery}
                ],
                repos: async () => ['acme/app'],
                identities,
                now  : () => new Date(nowMs.value)
            }),
            source   = createFleetOpenWorkSource({producer, now: () => nowMs.value + 1000});

        // 1. Answered reads with zero PR rows still create seats[id] with credentialRefusal: null and tokenExpiresAt
        await producer.pulse();
        expect(source.readOpenWork().seats).toEqual({
            '@neo-opus-ada': {authored: [], reviewing: [], credentialRefusal: null, tokenExpiresAt: null},
            '@neo-gpt'     : {authored: [], reviewing: [], credentialRefusal: null, tokenExpiresAt: '2026-12-20T00:00:00.000Z'}
        });

        // 2. HTTP 401 projects frozen authentication-rejected refusal while preserving last answered tokenExpiresAt
        euclidMode  = '401';
        nowMs.value += 60000;
        await producer.pulse();
        const after401 = source.readOpenWork().seats['@neo-gpt'];
        expect(after401).toEqual({
            authored         : [],
            reviewing        : [],
            credentialRefusal: {
                surface: 'forge',
                cause  : 'authentication-rejected',
                verdict: 'refused',
                status : 401,
                reason : 'GitHub GraphQL answered 401: Bad credentials'
            },
            tokenExpiresAt: '2026-12-20T00:00:00.000Z'
        });
        expect(Object.isFrozen(after401.credentialRefusal)).toBe(true);

        // 3. GraphQL INSUFFICIENT_SCOPES -> cause: 'insufficient-capability', verdict: 'refused'
        euclidMode  = 'scopes';
        nowMs.value += 60000;
        await producer.pulse();
        expect(source.readOpenWork().seats['@neo-gpt'].credentialRefusal).toEqual({
            surface: 'forge',
            cause  : 'insufficient-capability',
            verdict: 'refused',
            status : 200,
            reason : "GitHub GraphQL answered 200: The 'login' field requires ['read:org']"
        });

        // 4. Rate-limited HTTP 403 -> cause: 'transport-unavailable', verdict: 'unanswered' (never a refusal)
        euclidMode  = '403-rate-limited';
        nowMs.value += 60000;
        await producer.pulse();
        expect(source.readOpenWork().seats['@neo-gpt'].credentialRefusal).toEqual({
            surface: 'forge',
            cause  : 'transport-unavailable',
            verdict: 'unanswered',
            status : 403,
            reason : 'GitHub GraphQL answered 403: You have exceeded a secondary rate limit.'
        });

        // 5. Partial-read failure keeps the answered page's fresh tokenExpiresAt from this pulse
        euclidMode  = 'partial-then-fail';
        nowMs.value += 60000;
        await producer.pulse();
        expect(source.readOpenWork().seats['@neo-gpt']).toEqual({
            authored         : [],
            reviewing        : [],
            credentialRefusal: {
                surface: 'forge',
                cause  : 'transport-unavailable',
                verdict: 'unanswered',
                status : 502,
                reason : 'GitHub GraphQL answered 502: no data'
            },
            tokenExpiresAt: '2026-12-25T00:00:00.000Z'
        });

        // 6. HTTP 5xx -> cause: 'transport-unavailable', verdict: 'unanswered', preserving latest answered tokenExpiresAt
        euclidMode  = '502';
        nowMs.value += 60000;
        await producer.pulse();
        expect(source.readOpenWork().seats['@neo-gpt']).toEqual({
            authored         : [],
            reviewing        : [],
            credentialRefusal: {
                surface: 'forge',
                cause  : 'transport-unavailable',
                verdict: 'unanswered',
                status : 502,
                reason : 'GitHub GraphQL answered 502: no data'
            },
            tokenExpiresAt: '2026-12-25T00:00:00.000Z'
        });

        // 5. Recovery to a non-expiring token clears credentialRefusal and updates tokenExpiresAt to null
        euclidMode  = 'no-expiry';
        nowMs.value += 60000;
        await producer.pulse();
        expect(source.readOpenWork().seats['@neo-gpt']).toEqual({
            authored         : [],
            reviewing        : [],
            credentialRefusal: null,
            tokenExpiresAt   : null
        });

        // 6. Single-seat Fleet whose very first pulse fails with 401 still projects seats[id].credentialRefusal
        const
            soloNow      = Date.parse('2026-10-02T11:00:00.000Z'),
            soloProducer = createOpenWorkProducer({
                readers   : async () => [{
                    seat : '@neo-gpt',
                    login: 'neo-gpt',
                    query: async () => { throw Object.assign(new Error('GitHub GraphQL answered 401: Bad credentials'), {status: 401}) }
                }],
                repos: async () => ['acme/app'],
                identities,
                now  : () => new Date(soloNow)
            }),
            soloSource   = createFleetOpenWorkSource({producer: soloProducer, now: () => soloNow + 1000});

        await soloProducer.pulse();
        expect(soloSource.readOpenWork()).toMatchObject({
            state: 'unavailable',
            seats: {
                '@neo-gpt': {
                    authored         : [],
                    reviewing        : [],
                    credentialRefusal: {
                        surface: 'forge',
                        cause  : 'authentication-rejected',
                        verdict: 'refused',
                        status : 401,
                        reason : 'GitHub GraphQL answered 401: Bad credentials'
                    },
                    tokenExpiresAt: null
                }
            }
        })
    })
});

test.describe('openWorkProducer — what a merge unblocked (#1619)', () => {
    const
        issue   = (number, state = 'OPEN', extra = {}) => ({number, state, repository: {nameWithOwner: 'acme/app'}, ...extra}),
        blocked = (number, {assignees = ['neo-gpt'], blockers = [issue(5, 'CLOSED')], totalCount = blockers.length} = {}) =>
            issue(number, 'OPEN', {assignees: {nodes: assignees.map(login => ({login}))}, blockedBy: {totalCount, nodes: blockers}}),
        pullRequest = (...closers) => ({closingIssuesReferences: {totalCount: closers.length, nodes: closers.map(([number, blocking]) =>
            ({...issue(number, 'CLOSED'), blocking: {totalCount: blocking.length, nodes: blocking}}))}}),
        // GitHub's answer to the production document: each dependent list holds at most the document's own page
        paged       = (text, answer) => {
            const first = Number(/blocking\(first: (\d+)\)/.exec(text)[1]);

            answer.closingIssuesReferences.nodes.forEach(closer => { closer.blocking.nodes = closer.blocking.nodes.slice(0, first) });
            return answer
        },
        UNBLOCKED   = [{issue: 'acme/app#9', seats: ['@neo-gpt']}];

    /**
     * @summary A producer whose one pull request merges on its third pulse; unblock reads answer through
     * `answer(attempt, document)`.
     * @param {Function} answer
     * @param {Function} [step] Milliseconds between pulses, by pulse index.
     * @returns {{producer: Object, reads: Object[], merge: Function}}
     */
    const merging = (answer, step = () => 60000) => {
        let script = {open: [[pr()]]}, ms = Date.parse('2026-10-02T10:00:00Z'), pulses = 0;
        const
            search = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            reads  = [],
            query  = async (text, variables) => {
                if (text !== OPEN_WORK_UNBLOCKED) return search.query(text, variables);
                reads.push(variables);
                return answer(reads.length, text)
            },
            producer = createOpenWorkProducer({readers: ada(query), repos: async () => ['acme/app'], identities,
                now: () => new Date(ms += step(++pulses))});

        return {producer, reads, merge: () => { script = {open: [[]], terminal: [[closed(7, '2026-10-02T10:01:50Z', 'MERGED')]]} }}
    };

    test('a merge that closes the last open blocker of an assigned issue unblocks it for the assignee seat', () => {
        expect(normalizeUnblocked(pullRequest([5, [blocked(9)]]), identities)).toEqual(UNBLOCKED)
    });

    test('another open blocker keeps an issue blocked; a blocker or dependent list past its page makes the read incomplete', () => {
        const truncated = pullRequest([5, [blocked(9)]]);

        truncated.closingIssuesReferences.nodes[0].blocking.totalCount = 2;

        expect(normalizeUnblocked(pullRequest([5, [blocked(9, {blockers: [issue(5, 'CLOSED'), issue(6)]})]]), identities)).toEqual([]);
        expect(normalizeUnblocked(pullRequest([5, [blocked(9, {totalCount: 11})]]), identities)).toBeNull();
        expect(normalizeUnblocked(truncated, identities)).toBeNull()
    });

    test('a dependent past the tenth is read and woken, and past the document\'s page the read is incomplete, never kept', async () => {
        const
            eleven  = seatOn => Array.from({length: 11}, (_, index) => blocked(20 + index, {assignees: [index === seatOn ? 'neo-gpt' : 'outsider']})),
            resolve = async dependents => {
                const {producer, merge} = merging((attempt, text) => ({rateLimit: {cost: 10}, repository: {pullRequest: paged(text, pullRequest([5, dependents]))}}));

                await producer.pulse();
                await producer.pulse();
                merge();
                return (await producer.pulse()).transitions[0].unblock
            };

        expect((await resolve(eleven(10))).issues).toEqual([{issue: 'acme/app#30', seats: ['@neo-gpt']}]);
        expect((await resolve(eleven(0))).issues).toEqual([{issue: 'acme/app#20', seats: ['@neo-gpt']}]);
        expect(await resolve(Array.from({length: 51}, (_, index) => blocked(20 + index)))).toEqual({failures: 1})
    });

    test('a blocker that is another issue the same merge closes counts as closed before GitHub closes it', () => {
        expect(normalizeUnblocked(pullRequest([5, [blocked(9, {blockers: [issue(5), issue(6)]})]], [6, []]), identities)).toEqual(UNBLOCKED)
    });

    test('an unassigned issue, or one whose assignees map to no seat, names nobody to wake', () => {
        expect(normalizeUnblocked(pullRequest([5, [blocked(9, {assignees: []}), blocked(10, {assignees: ['outsider']})]]), identities)).toEqual([])
    });

    test('a merge is read once with its author\'s reader, and the read is priced in its pulse', async () => {
        const {producer, reads, merge} = merging(() => ({rateLimit: {cost: 2}, repository: {pullRequest: pullRequest([5, [blocked(9)]])}}));

        await producer.pulse();
        await producer.pulse();
        merge();
        const state = await producer.pulse();

        expect(reads).toEqual([{owner: 'acme', name: 'app', number: 7}]);
        expect(state.transitions.map(({kind, unblock}) => [kind, unblock])).toEqual([['merged', {at: '2026-10-02T10:03:00.000Z', issues: UNBLOCKED}]]);
        expect(state.pulses.at(-1).quota.filter(bucket => bucket.queryHash === openWorkQueryCost(OPEN_WORK_UNBLOCKED).queryHash))
            .toMatchObject([{calls: 1, cost: 2, failed: 0}]);

        await producer.pulse();
        expect(reads).toHaveLength(1)
    });

    test('a failed read retries on the next pulses, three attempts at most, and a merge past its recent window is never read', async () => {
        const failing = merging(() => { throw new Error('GitHub answered 502') });

        await failing.producer.pulse();
        await failing.producer.pulse();
        failing.merge();
        for (let pulse = 0; pulse < 5; pulse++) await failing.producer.pulse();
        expect(failing.reads).toHaveLength(3);
        expect(failing.producer.getState().transitions[0].unblock).toEqual({failures: 3});

        const late = merging(() => { throw new Error('GitHub answered 502') }, pulse => pulse === 4 ? 11 * 60000 : 60000);

        await late.producer.pulse();
        await late.producer.pulse();
        late.merge();
        await late.producer.pulse();
        await late.producer.pulse();
        expect(late.reads).toHaveLength(1);
        expect(late.producer.getState().transitions[0].unblock).toEqual({failures: 1})
    });
});

test.describe('openWorkProducer — organization-login PRs keep coverage across outside misses (#1779)', () => {
    const
        seatIdentities = {
            byLogin: login => ({'login-a': '@neo-opus-ada', 'login-e': '@neo-gpt', 'org-b': '@neo-opus-ada'})[login] ?? null,
            byName : name  => ({Ada: '@neo-opus-ada', Euclid: '@neo-gpt'})[name] ?? null
        },
        openNode = ({number, author = 'org-b', body = 'Authored by Ada (Model, Harness).', head = 'h1', rollup = 'SUCCESS', verdict = 'REVIEW_REQUIRED', reviewers = []} = {}) => ({
            ...pr({number, author, verdict, rollup}),
            headRefOid    : head,
            body,
            reviewRequests: {pageInfo: {hasNextPage: false}, nodes: reviewers.map(login => ({requestedReviewer: {__typename: 'User', login}}))},
            commits       : {nodes: [{commit: {oid: head, statusCheckRollup: {state: rollup}}}]}
        });

    /**
     * @summary Harness modeling registered seat `login-a` alongside recognized org login `org-b` without a seat reader.
     * @param {Object} [options]
     * @param {Object|null} [options.store=null]
     * @param {Number} [options.pageBudget=4]
     * @param {String} [options.start='2026-11-16T02:55:00Z']
     * @returns {Object}
     */
    function harness({store = null, pageBudget = 4, start = '2026-11-16T02:55:00Z'} = {}) {
        const
            state = {authored: [], held: [], terminal: [], outsidePages: [[]], failOutside: false},
            query = async (text, {query: search, cursor}) => {
                const kind = kindOf(search);

                if (kind === 'outside') {
                    if (state.failOutside) throw new Error('outside search failed');
                    const index = cursor ? Number(cursor) : 0;

                    return {
                        rateLimit: {cost: 1},
                        search   : {nodes: state.outsidePages[index] ?? [], pageInfo: {hasNextPage: index < state.outsidePages.length - 1, endCursor: String(index + 1)}}
                    }
                }

                const nodes = kind === 'open' ? state.authored : kind === 'held' ? state.held : kind === 'terminal' ? state.terminal : [];

                return {rateLimit: {cost: 1}, search: {nodes, pageInfo: {hasNextPage: false}}}
            };

        let ms = Date.parse(start);

        const producer = createOpenWorkProducer({
            readers   : async () => [{seat: '@neo-opus-ada', login: 'login-a', query}],
            repos     : async () => ['acme/app'],
            identities: seatIdentities,
            store,
            pageBudget,
            now       : () => new Date(ms += 60000)
        });

        return {state, producer, source: createFleetOpenWorkSource({producer, now: () => ms + 1000})}
    }

    test('AC-1: attributable and unattributable org-login PRs retain genuine timestamps, holder and attribution across repeated outside misses without reopening', async () => {
        const
            env   = harness(),
            org50 = openNode({number: 50, author: 'org-b', body: 'Authored by Ada (Model, Harness).'}),
            org51 = openNode({number: 51, author: 'org-b', body: 'Release note without footer.'}),
            feed  = () => createPrTransitionEvents(env.producer.getState().transitions);

        env.state.outsidePages = [[org50, org51]];
        const base = await env.producer.pulse();

        for (let round = 0; round < 2; round++) {
            const lastSeenAt = env.producer.getState().observedAt;

            env.state.failOutside = true;
            const missed = await env.producer.pulse();

            expect(missed.coverage).toBe('partial');
            expect(missed.snapshot.rows['acme/app#50'].observedAt).toBe(lastSeenAt);
            expect(missed.snapshot.rows['acme/app#51'].observedAt).toBe(lastSeenAt);
            expect(missed.pulses.at(-1).vanished).toEqual([]);
            expect(missed.transitions).toEqual([]);

            // Seat attribution and next-action holder remain intact on missed polls
            expect(missed.snapshot.rows['acme/app#50'].owner).toEqual({kind: 'seat', seat: '@neo-opus-ada', login: 'org-b'});
            expect(missed.snapshot.rows['acme/app#51'].owner).toEqual({kind: 'unowned', seat: null, login: 'org-b'});
            expect(env.source.readOpenWork().seats['@neo-opus-ada'].authored.map(item => ({number: item.number, holder: item.holder}))).toEqual([
                {number: 50, holder: {role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']}}
            ]);

            env.state.failOutside = false;
            const recovered = await env.producer.pulse();

            expect(recovered.coverage).toBe('complete');
            expect(recovered.transitions).toEqual([]);
            expect(recovered.snapshot.rows['acme/app#50'].observedAt).toBe(recovered.observedAt);
            expect(recovered.snapshot.rows['acme/app#51'].observedAt).toBe(recovered.observedAt);
        }

        expect(base.transitions).toEqual([]);
        expect(feed().filter(event => event.payload.transition.kind === 'opened')).toEqual([]);

        // Control: once outside succeeds with the PR absent, it vanishes cleanly
        env.state.outsidePages = [[]];
        const ended = await env.producer.pulse();
        expect(ended.pulses.at(-1).vanished.sort()).toEqual(['acme/app#50', 'acme/app#51'])
    });

    test('AC-2: initial incomplete outside read, prior-schema saved snapshot on restart, and body/attribution edits manufacture zero openings', async () => {
        // 1. First observation after an incomplete outside read (page budget cut)
        const truncated = harness({pageBudget: 1});
        truncated.state.outsidePages = [[openNode({number: 49})], [openNode({number: 52})]];
        await truncated.producer.pulse();
        truncated.state.outsidePages = [[openNode({number: 49}), openNode({number: 52})]];
        const observedAfterPartial = await truncated.producer.pulse();
        expect(observedAfterPartial.transitions).toEqual([]);

        // 2. Restart with a saved snapshot from the prior schema (absent PR after missed outside, and carried row before miss)
        const store = memoryStore();
        store.saved = {
            snapshot   : {rows: {'acme/app#50': normalizePullRequest(openNode({number: 50}), seatIdentities)}, closed: {}, complete: true, missed: ['outside']},
            observedAt : '2026-11-16T02:56:00.000Z',
            coverage   : 'partial',
            watermark  : '2026-11-16T02:46:00.000Z',
            window     : null,
            reason     : null,
            detail     : null,
            readers    : {'login-a': {watermark: '2026-11-16T02:46:00.000Z', window: null}},
            seatReads  : {},
            transitions: [],
            pulses     : []
        };

        const restarted = harness({store, start: '2026-11-16T02:57:00Z'});
        restarted.state.outsidePages = [[openNode({number: 50}), openNode({number: 53})]];
        const postUpgrade = await restarted.producer.pulse();
        expect(postUpgrade.transitions).toEqual([]);

        // If outside fails on the pulse right after restart, carried org-B row is retained and still emits no opening on recovery
        restarted.state.failOutside = true;
        const missAfterRestart = await restarted.producer.pulse();
        expect(missAfterRestart.pulses.at(-1).vanished).toEqual([]);
        restarted.state.failOutside = false;
        const recoverAfterRestart = await restarted.producer.pulse();
        expect(recoverAfterRestart.transitions).toEqual([]);

        // 3. Ordinary description edit and changed attribution footer while continuously visible
        restarted.state.outsidePages = [[
            openNode({number: 50, body: 'Refined description.\n\nAuthored by Euclid (Model, Harness).'}),
            openNode({number: 53, body: 'Footer removed completely.'})
        ]];
        const edited = await restarted.producer.pulse();
        expect(edited.transitions).toEqual([]);
        expect(edited.snapshot.rows['acme/app#50'].owner).toEqual({kind: 'seat', seat: '@neo-gpt', login: 'org-b'});
        expect(edited.snapshot.rows['acme/app#53'].owner).toEqual({kind: 'unowned', seat: null, login: 'org-b'})
    });

    test('AC-3: positive controls — genuinely new PRs, terminal close/reopen, held/authored changes and PR-lane feed remain live', async () => {
        const
            env  = harness(),
            feed = withProducerPrLane(async () => ({
                capability: {state: 'wired'},
                counts    : [],
                events    : []
            }), {producer: env.producer, now: () => Date.parse(env.producer.getState().observedAt) + 1000});

        env.state.authored     = [openNode({number: 10, author: 'login-a', body: 'Authored by Ada (Model).'})];
        env.state.outsidePages = [[openNode({number: 50, author: 'org-b', reviewers: ['login-a']})]];
        await env.producer.pulse();

        // New PRs after complete coverage still emit opened
        env.state.authored.push(openNode({number: 12, author: 'login-a', body: 'Authored by Ada (Model).'}));
        env.state.outsidePages = [[
            openNode({number: 50, author: 'org-b', reviewers: ['login-a']}),
            openNode({number: 54, author: 'org-b', body: 'Authored by Ada (Model).'})
        ]];
        const afterOpen = await env.producer.pulse();
        expect(afterOpen.transitions.filter(({kind}) => kind === 'opened').map(({key}) => key).sort())
            .toEqual(['acme/app#12', 'acme/app#54']);

        // Changes observed through a valid held/authored search still fire even while outside fails
        env.state.failOutside = true;
        env.state.authored[0] = openNode({number: 10, author: 'login-a', verdict: 'CHANGES_REQUESTED', body: 'Authored by Ada (Model).'});
        env.state.held        = [openNode({number: 50, author: 'org-b', verdict: 'APPROVED', reviewers: ['login-a']})];
        const viaSeatReads = await env.producer.pulse();
        expect(viaSeatReads.transitions.filter(({kind, pulse}) => kind === 'verdict' && pulse === viaSeatReads.observedAt)
            .map(({key, to}) => [key, to]).sort()).toEqual([
            ['acme/app#10', 'CHANGES_REQUESTED'],
            ['acme/app#50', 'APPROVED']
        ]);

        // Terminal close then reopen still emits closed and opened
        env.state.failOutside  = false;
        env.state.held         = [];
        env.state.authored     = [openNode({number: 10, author: 'login-a', verdict: 'CHANGES_REQUESTED', body: 'Authored by Ada (Model).'})];
        env.state.outsidePages = [[openNode({number: 50, author: 'org-b', verdict: 'APPROVED', reviewers: ['login-a']}), openNode({number: 54, author: 'org-b'})]];
        env.state.terminal     = [{
            number: 12, headRefOid: 'h1', state: 'CLOSED', closedAt: '2026-11-16T02:58:30Z', mergedAt: null,
            body  : 'Authored by Ada (Model).', author: {login: 'login-a'}, repository: {nameWithOwner: 'acme/app'}
        }];
        await env.producer.pulse();

        env.state.terminal = [];
        env.state.authored.push(openNode({number: 12, author: 'login-a', body: 'Authored by Ada (Model).'}));
        await env.producer.pulse();

        const lane = await feed({limit: 20});
        expect(lane.events.map(event => [event.payload.number, event.payload.transition.kind, event.payload.transition.to])).toEqual([
            [12, 'opened',  'open'],
            [12, 'closed',  'closed'],
            [10, 'verdict', 'CHANGES_REQUESTED'],
            [50, 'verdict', 'APPROVED'],
            [12, 'opened',  'open'],
            [54, 'opened',  'open']
        ])
    });
});

test.describe('openWorkProducer — concurrent distinct-query lanes (#1842)', () => {
    test('concurrent distinct-query lanes finish without waiting serially while preserving deterministic order (#1842)', async () => {
        const
            logins  = ['seat-a', 'seat-b', 'seat-c', 'seat-d'],
            gates   = [],
            entered = new Set(),
            localId = {
                byLogin: login => `@${login}`,
                byName : () => null
            },
            emptyPage = (viewerId, nodes = []) => ({
                viewer   : {id: viewerId},
                rateLimit: {cost: 1, limit: 1000, remaining: 999, resetAt: '2026-10-14T11:00:00Z'},
                search   : {nodes, pageInfo: {hasNextPage: false}}
            });
        let onFourEntered;
        const fourEntered = new Promise(resolve => { onFourEntered = resolve });

        const seatQueries = logins.map((login, index) => async (text, {query: search}) => {
            if (!entered.has(login)) {
                entered.add(login);
                if (entered.size === logins.length) onFourEntered();
                await new Promise(resolve => { gates[index] = resolve });
            }

            if (search.includes('author:seat-')) {
                const match = search.match(/author:(seat-\w+)/);
                if (match && !search.startsWith('is:pr is:open archived:false -author:')) {
                    return emptyPage(`issuer-${index}`, [pr({number: 100 + index, author: match[1], name: match[1]})]);
                }
            }
            return emptyPage(`issuer-${index}`);
        });

        const producer = createOpenWorkProducer({
            readers   : async () => logins.map((login, index) => ({
                seat   : `@${login}`,
                login,
                apiBase: 'https://api.github.com',
                query  : seatQueries[index]
            })),
            repos     : async () => ['acme/app'],
            identities: localId,
            now       : clock('2026-10-14T10:00:00Z')
        });

        const pulsePromise = producer.pulse();

        // All 4 distinct-query seats enter concurrently before the first gate is released.
        await fourEntered;
        expect(entered.size).toBe(4);

        // Release in reverse declaration order to verify output/quota ordering remains deterministic.
        for (let index = logins.length - 1; index >= 0; index--) {
            gates[index]();
            await Promise.resolve();
        }

        const state     = await pulsePromise;
        const lastPulse = state.pulses.at(-1);

        expect(lastPulse.seats.map(row => row.seat)).toEqual(logins.map(login => `@${login}`));
        expect(Object.keys(state.seatReads)).toEqual(logins.map(login => `@${login}`));
        expect(lastPulse.quota.slice(0, 4).map(row => [row.viewerId, row.firstOrdinal, row.lastOrdinal])).toEqual([
            ['issuer-0', 1, 2],
            ['issuer-1', 3, 4],
            ['issuer-2', 5, 6],
            ['issuer-3', 7, 8]
        ]);
        expect(lastPulse.quota.slice(0, 4).every(row => Date.parse(row.firstAt) <= Date.parse(row.lastAt))).toBe(true);
        expect(Object.keys(state.snapshot.rows).sort()).toEqual([
            'acme/app#100', 'acme/app#101', 'acme/app#102', 'acme/app#103'
        ]);
    });

    test('concurrency bounds active lanes and serializes seats sharing a query function reference (#1842)', async () => {
        const
            sharedQueryCalls = [],
            inflightByLane   = {shared: 0, dedicated: 0},
            maxShared        = {value: 0};
        let activeTotal   = 0,
            maxTotal      = 0,
            nextRemaining = 1000,
            dedicatedDone = 0;
        const pendingShared = [];

        const makeAnswer = () => ({
            viewer   : {id: 'issuer-shared'},
            rateLimit: {cost: 1, limit: 1000, remaining: --nextRemaining, resetAt: '2026-10-14T11:00:00Z'},
            search   : {nodes: [], pageInfo: {hasNextPage: false}}
        });

        let waitTwoDistinct;
        const twoDistinctEntered = new Promise(resolve => { waitTwoDistinct = resolve });
        const enteredLanes       = new Set();

        const sharedQuery = async (text, {query: search}) => {
            activeTotal++;
            maxTotal = Math.max(maxTotal, activeTotal);
            inflightByLane.shared++;
            maxShared.value = Math.max(maxShared.value, inflightByLane.shared);
            sharedQueryCalls.push(search);
            enteredLanes.add('shared');
            if (enteredLanes.size === 2) waitTwoDistinct();
            try {
                await new Promise(resolve => pendingShared.push(resolve));
                return makeAnswer()
            } finally {
                inflightByLane.shared--;
                activeTotal--;
            }
        };

        const makeDedicated = id => async () => {
            activeTotal++;
            maxTotal = Math.max(maxTotal, activeTotal);
            enteredLanes.add(id);
            if (enteredLanes.size === 2) waitTwoDistinct();
            try {
                await Promise.resolve();
                return makeAnswer()
            } finally {
                dedicatedDone++;
                activeTotal--;
            }
        };

        const producer = createOpenWorkProducer({
            concurrency: 2,
            readers    : async () => [
                {seat: '@s1', login: 's1', apiBase: 'https://api.github.com', query: sharedQuery},
                {seat: '@s2', login: 's2', apiBase: 'https://api.github.com', query: sharedQuery},
                {seat: '@d1', login: 'd1', apiBase: 'https://api.github.com', query: makeDedicated('d1')},
                {seat: '@d2', login: 'd2', apiBase: 'https://api.github.com', query: makeDedicated('d2')}
            ],
            repos     : async () => ['acme/app'],
            identities: {byLogin: login => `@${login}`, byName: () => null},
            now       : clock('2026-10-14T10:00:00Z')
        });

        const run = producer.pulse();
        await twoDistinctEntered;

        // Drain queued promises from the shared lane; hold s2's final call until d1/d2 finish and advance >1 ms.
        let done = false, tickedFinal = false;
        run.finally(() => { done = true });
        while (!done) {
            if (pendingShared.length) {
                if (sharedQueryCalls.length === 4 && !tickedFinal) {
                    if (dedicatedDone < 4) {
                        await Promise.resolve();
                        continue
                    }
                    tickedFinal = true;
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
                pendingShared.shift()();
            }
            await Promise.resolve();
        }

        const state = await run;
        expect(maxShared.value).toBe(1);
        expect(maxTotal).toBeLessThanOrEqual(2);
        expect(sharedQueryCalls.filter(q => !q.includes('-author:') && q.includes('author:s1'))).toHaveLength(1);
        expect(sharedQueryCalls.filter(q => !q.includes('-author:') && q.includes('author:s2'))).toHaveLength(1);
        expect(state.pulses.at(-1).quota[0]).toMatchObject({
            viewerId    : 'issuer-shared',
            calls       : 8,
            firstOrdinal: 1,
            lastOrdinal : 4,
            remaining   : 992
        });
    });
});

test.describe('openWorkProducer — parent closeout transition read, cursor pagination and steward wakes (#1919)', () => {
    const closedSub = (number, closedAt, {parentNumber = 759, state = 'OPEN', repo = 'acme/app', author = 'neo-opus-ada', assignees = [], total = 2, completed = 2} = {}) => ({
        number,
        closedAt,
        parent: {
            number          : parentNumber,
            state,
            repository      : {nameWithOwner: repo},
            author          : {login: author},
            assignees       : {nodes: assignees.map(login => ({login}))},
            subIssuesSummary: {total, completed}
        }
    });

    test('baseline pulse skips OPEN_WORK_CLOSEOUT; subsequent pulses page closed issues across restarts and wake stewards once', async () => {
        const
            store = memoryStore(),
            stub  = github({
                open    : [[]],
                terminal: [[]],
                closeout: [
                    [closedSub(801, '2026-10-02T10:01:10Z', {parentNumber: 700, total: 2, completed: 1})],
                    [closedSub(802, '2026-10-02T10:01:20Z', {parentNumber: 759, assignees: ['neo-opus-ada', 'neo-gpt']})],
                    [closedSub(803, '2026-10-02T10:01:40Z', {parentNumber: 760, assignees: [], author: 'neo-opus-ada'})]
                ]
            }),
            make  = start => createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: clock(start), store, pageBudget: 2});

        const baseline = await make('2026-10-02T10:00:00Z').pulse();
        expect(stub.calls.filter(call => call.kind === 'closeout')).toEqual([]);
        let planned = planOpenWorkWakes({state: baseline, ledger: null, now: Date.parse(baseline.observedAt)});
        expect(planned.wakes).toEqual([]);

        // Pulse 2 reads 2 of 3 closeout pages -> partial, watermark held, cursor saved
        const first = await make('2026-10-02T10:01:00Z').pulse();
        expect(first.coverage).toBe('partial');
        expect(first.closeout).toMatchObject({watermark: '2026-10-02T09:51:00.000Z', window: {cursor: '2'}});
        planned = planOpenWorkWakes({state: first, ledger: planned.ledger, now: Date.parse(first.observedAt)});
        expect(planned.wakes.map(({to, number, head, kind, episode}) => ({to, number, head, kind, episode}))).toEqual([
            {to: '@neo-opus-ada', number: 759, head: null, kind: 'closeout', episode: '2026-10-02T10:01:20Z'},
            {to: '@neo-gpt', number: 759, head: null, kind: 'closeout', episode: '2026-10-02T10:01:20Z'}
        ]);

        // Restarted producer resumes cursor '2', reads page 3, advances closeout watermark, and deduplicates parent 759 on overlap
        const tail = await make('2026-10-02T10:02:00Z').pulse();
        expect(stub.calls.filter(call => call.kind === 'closeout').map(call => call.cursor)).toEqual([null, '1', '2']);
        expect(tail).toMatchObject({coverage: 'complete', closeout: {watermark: '2026-10-02T09:52:00.000Z', window: null}});
        planned = planOpenWorkWakes({state: tail, ledger: planned.ledger, now: Date.parse(tail.observedAt)});
        expect(planned.wakes.map(({to, number, role, kind, episode}) => ({to, number, role, kind, episode}))).toEqual([
            {to: '@neo-opus-ada', number: 760, role: 'author', kind: 'closeout', episode: '2026-10-02T10:01:40Z'}
        ]);

        // Overlap re-read on next pulse emits zero duplicate wakes
        const overlap = await make('2026-10-02T10:03:00Z').pulse();
        planned = planOpenWorkWakes({state: overlap, ledger: planned.ledger, now: Date.parse(overlap.observedAt)});
        expect(planned.wakes).toEqual([]);
    });

    test('upgrade deploy with saved snapshot and old watermark but no closeout seeds at the deploy pulse so parents already all-closed at deploy never burst', async () => {
        const
            store = memoryStore(),
            stub  = github({
                open    : [[]],
                terminal: [[]],
                closeout: [[
                    closedSub(810, '2026-10-01T12:00:00Z', {parentNumber: 770, assignees: ['neo-opus-ada']}),
                    closedSub(811, '2026-10-02T10:01:30Z', {parentNumber: 771, assignees: ['neo-opus-ada']})
                ]]
            }),
            make  = start => createOpenWorkProducer({readers: ada(stub.query), repos: async () => ['acme/app'], identities, now: clock(start), store});

        store.saved = {
            snapshot   : {rows: {}, closed: {}, complete: true, missed: []},
            observedAt : '2026-10-02T10:00:00.000Z',
            coverage   : 'complete',
            readers    : {
                'neo-opus-ada': {watermark: '2026-10-02T09:50:00.000Z', window: null},
                'stale-seat'  : {watermark: '2026-09-25T00:00:00.000Z', window: null}
            },
            watermark  : '2026-09-25T00:00:00.000Z',
            window     : null,
            reason     : null,
            detail     : null,
            seatReads  : {},
            transitions: [],
            pulses     : []
        };

        let ledger = {
            pulse        : '2026-10-02T10:00:00.000Z',
            holding      : {},
            pendingMerges: {},
            baselines    : {}
        };

        const deployPulse = await make('2026-10-02T10:00:00Z').pulse();
        expect(stub.calls.filter(call => call.kind === 'closeout')).toEqual([]);
        expect(deployPulse.closeout).toEqual({watermark: '2026-10-02T09:51:00.000Z', window: null});
        let planned = planOpenWorkWakes({state: deployPulse, ledger, now: Date.parse(deployPulse.observedAt)});
        expect(planned.wakes).toEqual([]);
        ledger = planned.ledger;

        const nextPulse = await make('2026-10-02T10:01:00Z').pulse();
        const closeoutCalls = stub.calls.filter(call => call.kind === 'closeout');
        expect(closeoutCalls).toHaveLength(1);
        expect(closeoutCalls[0].search).toContain('closed:2026-10-02T09:51:00Z..2026-10-02T10:02:00Z');
        planned = planOpenWorkWakes({state: nextPulse, ledger, now: Date.parse(nextPulse.observedAt)});
        expect(planned.wakes.map(({to, number, kind, episode}) => ({to, number, kind, episode}))).toEqual([
            {to: '@neo-opus-ada', number: 771, kind: 'closeout', episode: '2026-10-02T10:01:30Z'}
        ]);
    });
});
