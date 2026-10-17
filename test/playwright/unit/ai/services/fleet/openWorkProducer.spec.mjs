import {expect, test}                           from '@playwright/test';
import fs                                       from 'fs';
import {createHash}                             from 'node:crypto';
import {createFleetOpenWorkSource}              from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';
import {createOpenWorkProducer}                 from '../../../../../../ai/services/fleet/openWorkProducer.mjs';
import {planOpenWorkWakes}                      from '../../../../../../ai/services/fleet/openWorkWakes.mjs';
import {OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL} from '../../../../../../ai/services/github-workflow/queries/openWorkQueries.mjs';

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
 * @summary The kind of search a read sent: a seat's authored or held open work, or its closed work.
 * @param {String} search
 * @returns {'open'|'held'|'terminal'}
 */
const kindOf = search => !search.includes('is:open') ? 'terminal' : search.includes('review-requested:') ? 'held' : search.includes('-author:') ? 'outside' : 'open';

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

    test('shared issuer reads compact into one bucket while zero-row seat coverage stays explicit', async () => {
        const producer = createOpenWorkProducer(options(async () => ['ada', 'gpt'].map(login => ({
            seat: '@' + login, login, apiBase: 'https://api.github.com', query: async () => answer()
        }))));
        const pulse = (await producer.pulse()).pulses.at(-1);
        expect(pulse).toMatchObject({telemetryVersion: 1, cost: 10, pages: 5, costUnknown: false, outside: {complete: true, rows: 0}});
        expect(pulse.quota).toHaveLength(1);
        expect(pulse.quota[0]).toMatchObject({apiBase: 'https://api.github.com', viewerId: 'issuer-1', resetAt: '2026-10-14T11:00:00.000Z', limit: 1000, cost: 10, calls: 5, failed: 0, unknown: false});
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
        expect(ordinary.quota.map(row => row.queryHash)).toEqual([OPEN_WORK_SNAPSHOT, OPEN_WORK_TERMINAL].map(text => createHash('sha256').update(text).digest('hex')));
        expect(ordinary.quota[0]).toMatchObject({reported: true, maxMeasuredCost: 2, firstOrdinal: 1, lastOrdinal: 4, zeroCostFailedCalls: 0});
        expect(ordinary.quota[1]).toMatchObject({firstOrdinal: 3, lastOrdinal: 3});
        failing = true;
        const failed = (await producer.pulse()).pulses.at(-1);
        expect(failed).toMatchObject({cost: 0, costUnknown: false, quota: [{reported: true, calls: 1, failed: 1, zeroCostFailedCalls: 1}]});
        expect(Date.parse(failed.quota[0].firstAttemptAt)).toBeLessThanOrEqual(Date.parse(failed.quota[0].firstAt));
        expect(calls).toBe(8);
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
            {resetAt: null, cost: 0, calls: 3, failed: 0, unknown: true}
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
        expect(pulse.quota).toHaveLength(3);
        expect(pulse.quota[0]).toMatchObject({remaining: null, unknown: false, calls: 1, cost: 2});
        expect(pulse.quota[1]).toMatchObject({viewerId: null, unknown: true, failed: 1, calls: 1});
        expect(pulse.quota[2]).toMatchObject({apiBase: 'https://github.example/api', viewerId: 'issuer-1', calls: 3});
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
        expect(pulse).toMatchObject({cost: 6, costUnknown: false, quota: [{resetAt: '2026-10-14T09:59:59.000Z', cost: 6, calls: 3, unknown: false}]});
        expect(Date.parse(pulse.quota[0].firstAt)).toBeGreaterThan(Date.parse(pulse.quota[0].resetAt));
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
        expect(state.pulses.at(-1)).toMatchObject({cost: 4, pages: 4, coverage: 'complete', transitions: {'@neo-opus-ada': 1}});
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
    /**
     * @summary A query that answers as one seat: only that seat's authored or held work, recording
     * every search it was asked.
     * @param {Object} work `{authored: Object[], held: Object[], outside?: Object[], closed: Object[]}`
     * @returns {{query: Function, searches: String[]}}
     */
    const asSeat = ({authored = [], held = [], outside = [], closed: ended = []}) => {
        const searches = [];

        return {
            searches,
            query: async (text, {query: search}) => {
                searches.push(search);

                const nodes = {open: authored, held, outside, terminal: ended}[kindOf(search)];

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

    test('unassigned outside contributor PRs are discovered per repository, and a failed outside read stays partial while keeping carried outside rows (#1008)', async () => {
        let failOutside = false;
        const
            outsidePr = {...pr({number: 42, author: 'external-dev', name: 'External'}), body: 'External fix', reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []}},
            query     = async (text, {query: search}) => {
                if (kindOf(search) === 'outside') {
                    if (failOutside) throw new Error('outside search failed');
                    return {rateLimit: {cost: 1}, search: {nodes: [outsidePr], pageInfo: {hasNextPage: false}}}
                }
                return {rateLimit: {cost: 1}, search: {nodes: [], pageInfo: {hasNextPage: false}}}
            },
            producer  = createOpenWorkProducer({
                readers: async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query}],
                repos  : async () => ['acme/app'],
                identities,
                now    : clock('2026-10-02T10:00:00Z')
            }),
            first     = await producer.pulse();

        expect(first.coverage).toBe('complete');
        expect(first.pulses.at(-1).outside).toEqual({complete: true, rows: 1});
        expect(first.snapshot.rows['acme/app#42']?.owner).toEqual({kind: 'outside', seat: null, login: 'external-dev'});

        failOutside = true;
        const second = await producer.pulse();
        expect(second.coverage).toBe('partial');
        expect(second.pulses.at(-1).outside).toEqual({complete: false, rows: 0});
        expect(second.snapshot.rows['acme/app#42']?.observedAt).toBe(first.observedAt);
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
            answer   = work => async (text, {query: search}) => ({rateLimit: {cost: 1}, search: {nodes: {open: work.authored, held: work.held, outside: [], terminal: []}[kindOf(search)], pageInfo: {hasNextPage: false}}}),
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

    test('only a PAT GitHub refused (401) asks for a new token; any other failed read names the next pulse', async () => {
        const
            refused = async () => { throw Object.assign(new Error('GitHub GraphQL answered 401: Bad credentials'), {status: 401}) },
            flaky   = async () => { throw Object.assign(new Error('GitHub GraphQL answered 502: no data'), {status: 502}) },
            pulse   = readers => createOpenWorkProducer({readers: async () => readers, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}).pulse(),
            adaSeat = {seat: '@neo-opus-ada', login: 'neo-opus-ada', query: asSeat({authored: [pr()]}).query};

        expect(await pulse([adaSeat, {seat: '@neo-gpt', login: 'neo-gpt', query: refused}]))
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
});
