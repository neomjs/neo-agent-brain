import {expect, test} from '@playwright/test';
import {holderOf}     from '../../../../../../ai/services/fleet/openWorkHolder.mjs';

const
    seat    = {kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'},
    outside = {kind: 'outside', seat: null, login: 'contributor'},
    review  = (state, onHead=true) => ({reviewer: '@neo-gpt', state, onHead}),
    // an approval or change request is both the reviewer's latest review and their latest opinion
    judged  = (state, onHead=true) => ({reviews: [review(state, onHead)], opinions: [review(state, onHead)]}),
    row     = overrides => ({ci: 'green', verdict: null, mergeable: 'MERGEABLE', draft: false, owner: seat, requested: [], reviews: [], opinions: [], ...overrides});

test.describe('openWorkHolder — OQ2\'s holder table on the current head, first match wins (#779)', () => {
    test('an outside PR whose CI finished and that nobody has engaged with is the rotation\'s', () => {
        expect(holderOf(row({owner: outside}))).toEqual({role: 'rotation', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red'}))).toEqual({role: 'rotation', ids: []});
        // still running: nobody holds it yet
        expect(holderOf(row({owner: outside, ci: 'pending'}))).toEqual({role: 'none', ids: []});
        // a requested seat has engaged
        expect(holderOf(row({owner: outside, requested: ['@neo-gpt']}))).toEqual({role: 'reviewer', ids: ['@neo-gpt']});
        // so has a comment on the head, though it carries no opinion
        expect(holderOf(row({owner: outside, reviews: [review('COMMENTED')]})).role).not.toBe('rotation')
    });

    test('a red head, or changes requested on the head, is the author\'s; an author no seat owns names nobody', () => {
        expect(holderOf(row({ci: 'red'}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row(judged('CHANGES_REQUESTED')))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row({ci: 'red', ...judged('APPROVED')}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row({ci: 'red', owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}}))).toEqual({role: 'author', ids: []})
    });

    test('a change request the author has pushed past, with the review requested again, is the reviewer\'s', () => {
        expect(holderOf(row({verdict: 'CHANGES_REQUESTED', ...judged('CHANGES_REQUESTED', false), requested: ['@neo-gpt']})))
            .toEqual({role: 'reviewer', ids: ['@neo-gpt']})
    });

    test('a green head with reviews requested is each requested reviewer\'s', () => {
        expect(holderOf(row({requested: ['@neo-gpt', 'team:acme/core']}))).toEqual({role: 'reviewer', ids: ['@neo-gpt', 'team:acme/core']})
    });

    test('a green, mergeable head approved on the head is the operator\'s, and names nobody', () => {
        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED')}))).toEqual({role: 'operator', ids: []})
    });

    test('an opinion survives the reviewer\'s later comment: the opinion list decides, not the latest review', () => {
        const commented = {reviews: [review('COMMENTED')]};

        expect(holderOf(row({...commented, opinions: [review('APPROVED')]}))).toEqual({role: 'operator', ids: []});
        expect(holderOf(row({...commented, opinions: [review('CHANGES_REQUESTED')]}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        // a row that carries no opinion list cannot show an approval, so it holds nothing it can name
        expect(holderOf(row({...judged('APPROVED'), opinions: undefined}))).toEqual({role: 'unknown', ids: []})
    });

    test('a draft, an unknown or conflicting mergeability, or an approval of an earlier head is nobody\'s', () => {
        const approved = {verdict: 'APPROVED', ...judged('APPROVED')};

        expect(holderOf(row({...approved, draft: true})).role).toBe('none');
        expect(holderOf(row({...approved, mergeable: 'UNKNOWN'})).role).toBe('none');
        expect(holderOf(row({...approved, mergeable: 'CONFLICTING'})).role).toBe('none');
        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED', false)})).role).toBe('none');
        expect(holderOf(row({})).role).toBe('none');
        expect(holderOf(row({ci: 'pending', ...judged('APPROVED')})).role).toBe('none')
    });

    test('a partial read decides only on positive evidence; an absence a missing page could hold is unknown', () => {
        const unknown = {role: 'unknown', ids: []};

        // an unseen on-head change request or review request could hold the approval back
        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED'), partial: true}))).toEqual(unknown);
        // an unreturned page may hold a review of the head
        expect(holderOf(row({owner: outside, partial: true}))).toEqual(unknown);
        // an unseen on-head change request precedes the reviewer rule
        expect(holderOf(row({requested: ['@neo-gpt'], partial: true}))).toEqual(unknown);
        expect(holderOf(row({partial: true}))).toEqual(unknown);
        // positive evidence still decides
        expect(holderOf(row({ci: 'red', partial: true}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...judged('CHANGES_REQUESTED'), partial: true}))).toEqual({role: 'author', ids: ['@neo-opus-ada']})
    });
});
