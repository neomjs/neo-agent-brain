import {expect, test} from '@playwright/test';
import {holderOf}     from '../../../../../../ai/services/fleet/openWorkHolder.mjs';

const
    seat    = {kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'},
    outside = {kind: 'outside', seat: null, login: 'contributor'},
    review  = (state, onHead=true) => ({reviewer: '@neo-gpt', state, onHead}),
    row     = overrides => ({ci: 'green', verdict: null, mergeable: 'MERGEABLE', draft: false, owner: seat, requested: [], reviews: [], ...overrides});

test.describe('openWorkHolder — OQ2\'s holder table on the current head, first match wins (#779)', () => {
    test('an outside PR whose CI finished and that nobody has engaged with is the rotation\'s', () => {
        expect(holderOf(row({owner: outside}))).toEqual({role: 'rotation', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red'}))).toEqual({role: 'rotation', ids: []});
        // still running: nobody holds it yet
        expect(holderOf(row({owner: outside, ci: 'pending'}))).toEqual({role: 'none', ids: []});
        // a requested seat has engaged
        expect(holderOf(row({owner: outside, requested: ['@neo-gpt']}))).toEqual({role: 'reviewer', ids: ['@neo-gpt']})
    });

    test('a red head, or changes requested on the head, is the author\'s; an author no seat owns names nobody', () => {
        expect(holderOf(row({ci: 'red'}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row({reviews: [review('CHANGES_REQUESTED')]}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row({ci: 'red', reviews: [review('APPROVED')]}))).toEqual({role: 'author', ids: ['@neo-opus-ada']});
        expect(holderOf(row({ci: 'red', owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}}))).toEqual({role: 'author', ids: []})
    });

    test('a change request the author has pushed past, with the review requested again, is the reviewer\'s', () => {
        expect(holderOf(row({verdict: 'CHANGES_REQUESTED', reviews: [review('CHANGES_REQUESTED', false)], requested: ['@neo-gpt']})))
            .toEqual({role: 'reviewer', ids: ['@neo-gpt']})
    });

    test('a green head with reviews requested is each requested reviewer\'s', () => {
        expect(holderOf(row({requested: ['@neo-gpt', 'team:acme/core']}))).toEqual({role: 'reviewer', ids: ['@neo-gpt', 'team:acme/core']})
    });

    test('a green, mergeable head approved on the head is the operator\'s, and names nobody', () => {
        expect(holderOf(row({verdict: 'APPROVED', reviews: [review('APPROVED')]}))).toEqual({role: 'operator', ids: []})
    });

    test('a draft, an unknown or conflicting mergeability, or an approval of an earlier head is nobody\'s', () => {
        const approved = {verdict: 'APPROVED', reviews: [review('APPROVED')]};

        expect(holderOf(row({...approved, draft: true})).role).toBe('none');
        expect(holderOf(row({...approved, mergeable: 'UNKNOWN'})).role).toBe('none');
        expect(holderOf(row({...approved, mergeable: 'CONFLICTING'})).role).toBe('none');
        expect(holderOf(row({verdict: 'APPROVED', reviews: [review('APPROVED', false)]})).role).toBe('none');
        expect(holderOf(row({})).role).toBe('none');
        expect(holderOf(row({ci: 'pending', reviews: [review('APPROVED')]})).role).toBe('none')
    });
});
