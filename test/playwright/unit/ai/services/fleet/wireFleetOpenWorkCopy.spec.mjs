import {expect, test}                                 from '@playwright/test';
import {openWorkPublicationOf, wireFleetOpenWorkCopy} from '../../../../../../ai/services/fleet/wireFleetOpenWorkCopy.mjs';

const
    OBSERVED = '2026-11-13T06:00:00.000Z',
    now      = () => Date.parse(OBSERVED) + 60_000,
    row      = {
        key  : 'acme/app#7', repo: 'acme/app', number: 7, title: 'fix: the head goes green', head: 'a1', ci: 'red', verdict: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE', draft: false,
        owner: {kind: 'seat', seat: '@neo-opus-ada'}, requested: ['@neo-gpt'], reviews: [{reviewer: '@neo-gpt', state: 'CHANGES_REQUESTED', onHead: true}], observedAt: OBSERVED
    },
    state    = (overrides = {}) => ({snapshot: {rows: {[row.key]: row}}, observedAt: OBSERVED, coverage: 'complete', reason: null,
        seatReads: {'@neo-opus-grace': {observedAt: OBSERVED}}, ...overrides}),
    quietLog = () => {
        const lines = [];

        return {lines, warn: line => lines.push(line)}
    };

/** @summary The host half of the plane's open-work copy: one publication per pulse. */
test.describe('wireFleetOpenWorkCopy', () => {
    test('a pulse publishes every seat the projection holds, each with the rows its digest names', () => {
        const slim = {repo: 'acme/app', number: 7, title: 'fix: the head goes green', ci: 'red', verdict: 'CHANGES_REQUESTED', stale: false,
            holder: {role: 'author', kind: 'repair-ci'}};

        expect(openWorkPublicationOf(state(), {now})).toEqual({
            observedAt: OBSERVED,
            coverage  : 'complete',
            reason    : null,
            tracked   : ['@neo-opus-grace', '@neo-opus-ada', '@neo-gpt'],
            seats     : {
                '@neo-opus-grace': {authored: [], reviewing: []},
                '@neo-opus-ada'  : {authored: [slim], reviewing: []},
                '@neo-gpt'       : {authored: [], reviewing: [slim]}
            }
        })
    });

    test('an unavailable projection publishes nothing, so the plane\'s copy ages on its own', async () => {
        const published = [];

        expect(openWorkPublicationOf(null, {now})).toBeNull();
        await wireFleetOpenWorkCopy({publish: args => published.push(args), now})(state({observedAt: '2026-11-13T04:00:00.000Z'}));
        expect(published).toEqual([])
    });

    test('a refused seat is logged; a failed publication is logged once per failure and never fails the pulse', async () => {
        const
            log     = quietLog(),
            answers = [{refused: [{seat: '@neo-gpt', reason: 'not a registered agent identity'}]}, new Error('unknown tool'), new Error('unknown tool'), new Error('timeout'), {refused: []}],
            hook    = wireFleetOpenWorkCopy({log, now, publish: async () => {
                const answer = answers.shift();

                if (answer instanceof Error) throw answer;
                return answer
            }});

        for (let pulse = 0; pulse < 5; pulse++) await hook(state());

        expect(log.lines).toEqual([
            '[fleet] the open-work copy refused @neo-gpt',
            '[fleet] the open-work copy was not published: unknown tool',
            '[fleet] the open-work copy was not published: timeout'
        ])
    })
});
