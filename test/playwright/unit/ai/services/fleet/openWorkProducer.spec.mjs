import {expect, test}              from '@playwright/test';
import fs                          from 'fs';
import {createFleetOpenWorkSource} from '../../../../../../ai/services/fleet/fleetOpenWorkSource.mjs';
import {createOpenWorkProducer}    from '../../../../../../ai/services/fleet/openWorkProducer.mjs';

const identities = {
    byLogin: login => ({'neo-opus-ada': '@neo-opus-ada', 'neo-gpt': '@neo-gpt'})[login] ?? null,
    byName : name  => ({Ada: '@neo-opus-ada', Euclid: '@neo-gpt'})[name] ?? null
};

/**
 * @summary One open search node.
 * @param {Object} [overrides]
 * @returns {Object}
 */
const pr = ({number=7, verdict='REVIEW_REQUIRED', rollup='SUCCESS', partial=false}={}) => ({
    number,
    headRefOid    : 'a1',
    reviewDecision: verdict,
    mergeable     : 'MERGEABLE',
    isDraft       : false,
    body          : 'Authored by Ada (Claude Opus 5, Claude Code).',
    author        : {login: 'neo-opus-ada'},
    repository    : {nameWithOwner: 'acme/app'},
    reviewRequests: {pageInfo: {hasNextPage: partial}, nodes: [{requestedReviewer: {__typename: 'User', login: 'neo-gpt'}}]},
    latestReviews : {pageInfo: {hasNextPage: false}, nodes: []},
    latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: []},
    commits       : {nodes: [{commit: {oid: 'a1', statusCheckRollup: {state: rollup}}}]}
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
 * @summary A GraphQL stub answering each search from a script: open pages, then terminal pages.
 * @param {Object} script `{open: Object[][], terminal: Object[][]}`: nodes per page.
 * @returns {{query: Function, calls: Object[]}}
 */
function github(script) {
    const calls = [];

    return {
        calls,
        query: async (text, {query: search, cursor}) => {
            const
                kind  = search.includes('is:open') ? 'open' : 'terminal',
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

const clock = start => {
    let ms = Date.parse(start);

    return () => new Date(ms += 60000)
};

const memoryStore = () => {
    const store = {saved: null, saves: 0};

    return Object.assign(store, {load: () => store.saved, save: state => { store.saves++; store.saved = JSON.parse(JSON.stringify(state)) }})
};

test.describe('openWorkProducer — one producer observes, records, and wakes no one (#760)', () => {
    test('a pulse after the baseline records the verdict change, its cost and the seat it belongs to', async () => {
        let script = {open: [[pr()]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            producer = createOpenWorkProducer({query: stub.query, repos: async () => ['acme/app', 'acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        await producer.pulse();
        script = {open: [[pr({verdict: 'APPROVED'})]], terminal: [[]]};

        const state = await producer.pulse();

        expect(state.coverage).toBe('complete');
        expect(state.transitions.map(({kind, to}) => [kind, to])).toEqual([['verdict', 'APPROVED']]);
        expect(state.pulses.at(-1)).toMatchObject({cost: 2, pages: 2, coverage: 'complete', transitions: {'@neo-opus-ada': 1}});
        // one scope per repository, and the terminal read is the window of close times from the watermark, an overlap back
        expect(stub.calls[0].search).toBe('is:pr is:open archived:false repo:acme/app');
        expect(stub.calls.at(-1).search).toBe('is:pr is:closed closed:2026-10-02T09:51:00Z..2026-10-02T10:02:00Z repo:acme/app')
    });

    test('a merge the search indexes after its window ended is read in the next window\'s overlap, once', async () => {
        let script = {open: [[pr()]], terminal: [[]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            producer = createOpenWorkProducer({query: stub.query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        // merged at 10:01:50, but the 10:02 pulse still reads it open and its window finds nothing
        await producer.pulse();
        await producer.pulse();
        script = {open: [[]], terminal: [[closed(7, '2026-10-02T10:01:50Z', 'MERGED')]]};
        await producer.pulse();

        const state = await producer.pulse();

        expect(state.transitions.map(({key, kind}) => [key, kind])).toEqual([['acme/app#7', 'merged']]);
        expect(stub.calls.filter(call => call.kind === 'terminal')[1].search).toBe('is:pr is:closed closed:2026-10-02T09:52:00Z..2026-10-02T10:03:00Z repo:acme/app')
    });

    test('a PR that leaves complete reads with no terminal row is vanished on its pulse, never a close', async () => {
        let script = {open: [[pr()]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            producer = createOpenWorkProducer({query: stub.query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

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
            query    = (text, variables) => (calls.push(variables), new Promise(resolve => { release = () => resolve({rateLimit: {cost: 1}, search: {nodes: [pr()], pageInfo: {hasNextPage: false}}}) })),
            producer = createOpenWorkProducer({query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}),
            first    = producer.pulse(),
            second   = producer.pulse();

        await new Promise(resolve => setTimeout(resolve, 0));
        release();

        expect(await second).toBe(await first);
        expect(calls).toHaveLength(1)
    });

    test('a page without its structure is a failed read: the snapshot stays and the watermark holds', async () => {
        let script = {open: [[pr()]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            query    = async (text, variables) => script.broken ? {rateLimit: {cost: 1}, search: {nodes: []}} : stub.query(text, variables),
            producer = createOpenWorkProducer({query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}),
            baseline = await producer.pulse();

        script = {broken: true};

        expect(await producer.pulse()).toMatchObject({coverage: 'stale', reason: 'the GitHub read failed', watermark: baseline.watermark});
        expect(Object.keys(producer.getState().snapshot.rows)).toEqual(['acme/app#7'])
    });

    test('a page past the budget, or a truncated request list, leaves the pulse partial, and the first still starts the watermark', async () => {
        const budgeted = createOpenWorkProducer({query: github({open: [[pr()], [pr({number: 8})], [pr({number: 9})]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), pageBudget: 2});

        expect(await budgeted.pulse()).toMatchObject({coverage: 'partial', watermark: '2026-10-02T09:51:00.000Z'});

        const truncated = createOpenWorkProducer({query: github({open: [[pr({partial: true})]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        expect(await truncated.pulse()).toMatchObject({coverage: 'partial', watermark: '2026-10-02T09:51:00.000Z'})
    });

    test('a terminal backlog past the budget reaches its tail across pulses and a restart, then moves the watermark', async () => {
        const
            store    = memoryStore(),
            stub     = github({open: [[pr()]], terminal: [[closed(1, '2026-10-02T10:01:10Z')], [closed(2, '2026-10-02T10:01:20Z')], [closed(3, '2026-10-02T10:01:30Z')]]}),
            make     = start => createOpenWorkProducer({query: stub.query, repos: async () => ['acme/app'], identities, now: clock(start), store, pageBudget: 2}),
            baseline = await make('2026-10-02T10:00:00Z').pulse(),
            first    = await make('2026-10-02T10:01:00Z').pulse();

        expect(first).toMatchObject({coverage: 'partial', watermark: baseline.watermark});
        expect(first.window).toMatchObject({since: baseline.watermark, until: '2026-10-02T10:02:00.000Z', cursor: '2'});

        // a restarted producer resumes the same window at the same cursor, so page 3 is finally read
        const tail = await make('2026-10-02T10:02:00Z').pulse();

        expect(stub.calls.filter(call => call.kind === 'terminal').map(call => call.cursor)).toEqual([null, '1', '2']);
        expect(tail).toMatchObject({coverage: 'complete', watermark: '2026-10-02T09:52:00.000Z', window: null})
    });

    test('an hour of partial pulses after a complete baseline never makes the row they missed fresh', async () => {
        let script = {open: [[pr(), pr({number: 8})]], terminal: [[]]};

        const
            stub     = github({get open() { return script.open }, get terminal() { return script.terminal }}),
            every10  = (() => { let ms = Date.parse('2026-10-02T10:00:00Z'); return () => new Date(ms += 10 * 60000) })(),
            producer = createOpenWorkProducer({query: stub.query, repos: async () => ['acme/app'], identities, now: every10, pageBudget: 1});

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
            producer = createOpenWorkProducer({query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        await producer.pulse();
        await producer.pulse();

        expect(producer.getState().pulses.at(-1)).toMatchObject({failed: true, cost: 1, pages: 1, costUnknown: true})
    });

    test('a failed read is stale over a snapshot and unavailable without one, under a constant reason and a redacted detail', async () => {
        let fail = true;

        const
            query    = async (...args) => { if (fail) throw new Error('Bad credentials for ghp_privateCanary0123456789abcdefABCDEF'); return github({open: [[pr()]]}).query(...args) },
            producer = createOpenWorkProducer({query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        const first = await producer.pulse();

        expect(first).toMatchObject({coverage: 'unavailable', reason: 'the GitHub read failed'});
        expect(first.detail).toContain('Bad credentials');
        expect(JSON.stringify(first)).not.toContain('privateCanary');

        fail = false;
        await producer.pulse();
        fail = true;

        expect((await producer.pulse()).coverage).toBe('stale');
        expect(producer.getState().snapshot.rows['acme/app#7']).toBeTruthy()
    });

    test('no seat on a GitHub repository is unavailable with its reason, not an empty board', async () => {
        const producer = createOpenWorkProducer({query: github({}).query, repos: async () => [], identities});

        expect(await producer.pulse()).toMatchObject({coverage: 'unavailable', reason: 'no seat works on a GitHub repository'})
    });

    test('the store carries the snapshot across a restart, so the next pulse diffs instead of re-baselining', async () => {
        const store = memoryStore();

        await createOpenWorkProducer({query: github({open: [[pr()]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), store}).pulse();

        const restarted = createOpenWorkProducer({query: github({open: [[pr({rollup: 'FAILURE'})]], terminal: [[]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:05:00Z'), store});

        expect((await restarted.pulse()).transitions.map(({kind, to}) => [kind, to])).toEqual([['ci', 'red']])
    });

    test('saved state that cannot be read is unavailable, is never saved over, and is read again on the next pulse', async () => {
        const store = memoryStore();

        await createOpenWorkProducer({query: github({open: [[pr()]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), store}).pulse();

        const
            saved = store.saved,
            saves = store.saves,
            load  = store.load;
        let unreadable = true;

        store.load = () => { if (unreadable) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'}); return load() };

        const producer = createOpenWorkProducer({query: github({open: [[pr({rollup: 'FAILURE'})]], terminal: [[]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:05:00Z'), store});

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
