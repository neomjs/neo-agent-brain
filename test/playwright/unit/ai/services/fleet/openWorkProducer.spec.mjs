import {expect, test}           from '@playwright/test';
import fs                       from 'fs';
import {createOpenWorkProducer} from '../../../../../../ai/services/fleet/openWorkProducer.mjs';

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
    commits       : {nodes: [{commit: {oid: 'a1', statusCheckRollup: {state: rollup}}}]}
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
        // one scope per repository, and the terminal read starts at the first pulse's watermark
        expect(stub.calls[0].search).toBe('is:pr is:open archived:false repo:acme/app');
        expect(stub.calls.at(-1).search).toBe('is:pr is:closed updated:>=2026-10-02T10:01:00.000Z repo:acme/app')
    });

    test('a page past the budget, or a truncated request list, leaves the pulse partial and the watermark where it was', async () => {
        const budgeted = createOpenWorkProducer({query: github({open: [[pr()], [pr({number: 8})], [pr({number: 9})]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), pageBudget: 2});

        expect(await budgeted.pulse()).toMatchObject({coverage: 'partial', watermark: null});

        const truncated = createOpenWorkProducer({query: github({open: [[pr({partial: true})]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z')});

        expect(await truncated.pulse()).toMatchObject({coverage: 'partial', watermark: null})
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
        let saved = null;

        const store = {load: () => saved, save: state => { saved = JSON.parse(JSON.stringify(state)) }};

        await createOpenWorkProducer({query: github({open: [[pr()]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:00:00Z'), store}).pulse();

        const restarted = createOpenWorkProducer({query: github({open: [[pr({rollup: 'FAILURE'})]], terminal: [[]]}).query, repos: async () => ['acme/app'], identities, now: clock('2026-10-02T10:05:00Z'), store});

        expect((await restarted.pulse()).transitions.map(({kind, to}) => [kind, to])).toEqual([['ci', 'red']])
    });

    test('observe-only: the producer and its reducer name no mailbox', () => {
        for (const file of ['openWorkProducer.mjs', 'openWorkReducer.mjs']) {
            const source = fs.readFileSync(new URL(`../../../../../../ai/services/fleet/${file}`, import.meta.url), 'utf8');

            expect(source, file).not.toMatch(/planeMailboxClient|add_message|addMessage/)
        }
    });
});
