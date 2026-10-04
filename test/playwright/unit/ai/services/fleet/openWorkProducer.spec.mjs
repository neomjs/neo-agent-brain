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
const pr = ({number=7, verdict='REVIEW_REQUIRED', rollup='SUCCESS', partial=false, author='neo-opus-ada', name='Ada'}={}) => ({
    number,
    headRefOid    : 'a1',
    reviewDecision: verdict,
    mergeable     : 'MERGEABLE',
    isDraft       : false,
    body          : `Authored by ${name} (Claude Opus 5, Claude Code).`,
    author        : {login: author},
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
 * @summary The kind of search a read sent: a seat's authored or held open work, or its closed work.
 * @param {String} search
 * @returns {'open'|'held'|'terminal'}
 */
const kindOf = search => !search.includes('is:open') ? 'terminal' : search.includes('review-requested:') ? 'held' : 'open';

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
        expect(state.pulses.at(-1)).toMatchObject({cost: 3, pages: 3, coverage: 'complete', transitions: {'@neo-opus-ada': 1}});
        // the seat reads what it authored and holds, one scope per repository; the terminal read is its
        // window of close times from its watermark, an overlap back
        expect(stub.calls.slice(0, 2).map(call => call.search)).toEqual([
            'is:pr is:open archived:false author:neo-opus-ada repo:acme/app',
            'is:pr is:open archived:false review-requested:neo-opus-ada repo:acme/app'
        ]);
        expect(stub.calls.at(-1).search).toBe('is:pr is:closed closed:2026-10-02T09:51:00Z..2026-10-02T10:02:00Z author:neo-opus-ada repo:acme/app')
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
        // one pulse's two open reads, never a second pulse's
        expect(calls).toHaveLength(2)
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
     * @param {Object} work `{authored: Object[], held: Object[], closed: Object[]}`
     * @returns {{query: Function, searches: String[]}}
     */
    const asSeat = ({authored = [], held = [], closed: ended = []}) => {
        const searches = [];

        return {
            searches,
            query: async (text, {query: search}) => {
                searches.push(search);

                const nodes = {open: authored, held, terminal: ended}[kindOf(search)];

                return {rateLimit: {cost: 1}, search: {nodes, pageInfo: {hasNextPage: false}}}
            }
        }
    };

    test('every seat reads only its own login\'s work, and the rows merge: a PR one seat holds is read once', async () => {
        const
            adaSeat    = asSeat({authored: [pr()]}),
            euclidSeat = asSeat({authored: [pr({number: 9, author: 'neo-gpt', name: 'Euclid'})], held: [pr()]}),
            producer   = createOpenWorkProducer({
                readers   : async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaSeat.query}, {seat: '@neo-gpt', login: 'neo-gpt', query: euclidSeat.query}],
                repos     : async () => ['acme/app'],
                identities,
                now       : clock('2026-10-02T10:00:00Z')
            }),
            state      = await producer.pulse();

        expect(adaSeat.searches.every(search => search.includes('neo-opus-ada') && !search.includes('neo-gpt'))).toBe(true);
        expect(euclidSeat.searches.every(search => search.includes(':neo-gpt ') && !search.includes('neo-opus-ada'))).toBe(true);
        expect(Object.keys(state.snapshot.rows).sort()).toEqual(['acme/app#7', 'acme/app#9']);
        expect(state).toMatchObject({coverage: 'complete', reason: null})
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
                readers   : async () => [{seat: '@neo-opus-ada', login: 'neo-opus-ada', query: adaSeat.query}, {seat: '@neo-gpt', login: 'neo-gpt', query: euclid}],
                repos     : async () => ['acme/app'],
                identities,
                now       : clock('2026-10-02T10:00:00Z')
            });

        await producer.pulse();
        failing = true;

        const state = await producer.pulse();

        expect(state).toMatchObject({coverage: 'partial', reason: 'the GitHub read failed for @neo-gpt: the next pulse reads again'});
        expect(state.detail).toContain('Bad credentials');
        expect(Object.keys(state.snapshot.rows).sort()).toEqual(['acme/app#7', 'acme/app#9']);
        expect(state.pulses.at(-1).vanished).toEqual([])
    });

    test('only a PAT GitHub refused (401) asks for a new token; any other failed read names the next pulse', async () => {
        const
            refused  = async () => { throw Object.assign(new Error('GitHub GraphQL answered 401: Bad credentials'), {status: 401}) },
            flaky    = async () => { throw Object.assign(new Error('GitHub GraphQL answered 502: no data'), {status: 502}) },
            pulse    = readers => createOpenWorkProducer({readers: async () => readers, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')}).pulse(),
            adaSeat  = {seat: '@neo-opus-ada', login: 'neo-opus-ada', query: asSeat({authored: [pr()]}).query};

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
            snapshot: {rows: {}, closed: {}, complete: true}, observedAt: '2026-10-02T10:00:00.000Z', coverage: 'complete',
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
