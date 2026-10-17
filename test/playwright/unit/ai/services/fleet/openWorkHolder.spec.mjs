import {expect, test} from '@playwright/test';
import {holderOf}     from '../../../../../../ai/services/fleet/openWorkHolder.mjs';

const
    seat    = {kind: 'seat', seat: '@neo-opus-ada', login: 'neo-opus-ada'},
    outside = {kind: 'outside', seat: null, login: 'contributor'},
    review  = (state, onHead=true) => ({reviewer: '@neo-gpt', state, onHead}),
    // an approval or change request is both the reviewer's latest review and their latest opinion
    judged  = (state, onHead=true) => ({reviews: [review(state, onHead)], opinions: [review(state, onHead)]}),
    row     = overrides => ({ci: 'green', verdict: null, mergeable: 'MERGEABLE', draft: false, owner: seat, requested: [], reviews: [], opinions: [], ...overrides});

test.describe('openWorkHolder — the shared holder and next-action kind, first match wins (#761)', () => {
    test('an eligible outside PR routes to rotation for triage-outside when finished and untouched, or approve-runs when runs await approval (#1008)', () => {
        expect(holderOf(row({owner: outside}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red'}))).toEqual({role: 'rotation', kind: 'triage-outside', ids: []});
        expect(holderOf(row({owner: outside, ci: 'pending'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: outside, ci: 'pending', runApproval: 'action_required'})))
            .toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        expect(holderOf(row({owner: outside, ci: 'red', runApproval: 'action_required', reviews: [review('COMMENTED')]})))
            .toEqual({role: 'rotation', kind: 'approve-runs', ids: []});
        expect(holderOf(row({owner: outside, requested: ['@neo-gpt']}))).toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']});
        // A comment counts as engagement for triage-outside, and gives an outside author no seat-owned routing action.
        expect(holderOf(row({owner: outside, reviews: [review('COMMENTED')]}))).toEqual({role: 'none', kind: null, ids: []});
        // Drafts, bots, and maintainer associations do not produce outside rotation actions.
        expect(holderOf(row({owner: outside, draft: true, runApproval: 'action_required'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: outside, bot: true}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: outside, authorType: 'Bot', runApproval: 'action_required'}))).toEqual({role: 'none', kind: null, ids: []});
        for (const authorAssociation of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
            expect(holderOf(row({owner: outside, authorAssociation}))).toEqual({role: 'none', kind: null, ids: []});
            expect(holderOf(row({owner: outside, authorAssociation, runApproval: 'action_required'}))).toEqual({role: 'none', kind: null, ids: []})
        }
    });

    test('red CI takes precedence over every verdict and keeps the same action kind', () => {
        const repair = {role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']};

        expect(holderOf(row({ci: 'red'}))).toEqual(repair);
        expect(holderOf(row({ci: 'red', ...judged('APPROVED')}))).toEqual(repair);
        expect(holderOf(row({ci: 'red', ...judged('CHANGES_REQUESTED')}))).toEqual(repair);
        expect(holderOf(row({ci: 'red', owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}})))
            .toEqual({role: 'author', kind: 'repair-ci', ids: []})
    });

    test('pending CI retains a positive on-head change request, including on a partial row', () => {
        for (const partial of [false, true]) {
            expect(holderOf(row({ci: 'pending', ...judged('CHANGES_REQUESTED'), partial})))
                .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
            expect(holderOf(row({ci: 'pending', ...judged('CHANGES_REQUESTED', false), partial})))
                .toEqual({role: partial ? 'unknown' : 'none', kind: null, ids: []})
        }
    });

    test('the same author has distinct actions through pending, red, green, then red on one head', () => {
        expect(['pending', 'red', 'green', 'red'].map(ci => holderOf(row({head: 'h1', ci}))))
            .toEqual([
                {role: 'none', kind: null, ids: []},
                {role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']},
                {role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']},
                {role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']}
            ])
    });

    test('a change request the author has pushed past, with the review requested again, is the reviewer\'s', () => {
        expect(holderOf(row({verdict: 'CHANGES_REQUESTED', ...judged('CHANGES_REQUESTED', false), requested: ['@neo-gpt']})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']})
    });

    test('a green head with reviews requested is each requested reviewer\'s before the merge chip', () => {
        expect(holderOf(row({requested: ['@neo-gpt', 'team:acme/core']})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt', 'team:acme/core']});
        expect(holderOf(row({...judged('APPROVED'), requested: ['@neo-gpt']})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']})
    });

    test('an approved green conflicting head needs the author to rebase before a requested review', () => {
        const conflict = {...judged('APPROVED'), mergeable: 'CONFLICTING', requested: ['@neo-gpt']};

        expect(holderOf(row(conflict))).toEqual({role: 'author', kind: 'rebase', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...conflict, ci: 'red'}))).toEqual({role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...conflict, ...judged('CHANGES_REQUESTED')})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...conflict, ...judged('APPROVED', false)})))
            .toEqual({role: 'reviewer', kind: 'review', ids: ['@neo-gpt']});
        expect(holderOf(row({...conflict, ci: 'pending'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({...conflict, partial: true}))).toEqual({role: 'unknown', kind: null, ids: []})
    });

    test('review routing belongs only to a green non-draft seat-owned PR without an on-head opinion or request', () => {
        const routing = {role: 'author', kind: 'route-review', ids: ['@neo-opus-ada']};

        expect(holderOf(row({}))).toEqual(routing);
        expect(holderOf(row({reviews: [review('COMMENTED')]}))).toEqual(routing);
        for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
            expect(holderOf(row({verdict: state, ...judged(state, false)}))).toEqual(routing)
        }

        expect(holderOf(row({draft: true}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: {kind: 'unowned', seat: null, login: 'neo-gpt'}})))
            .toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({owner: {kind: 'seat', seat: null, login: 'neo-opus-ada'}})))
            .toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({ci: 'pending'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({ci: null}))).toEqual({role: 'none', kind: null, ids: []})
    });

    test('a green, mergeable head approved on the head is the operator\'s merge chip, and names nobody', () => {
        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED')})))
            .toEqual({role: 'operator', kind: 'merge', ids: []})
    });

    test('an opinion survives the reviewer\'s later comment: the opinion list decides, not the latest review', () => {
        const commented = {reviews: [review('COMMENTED')]};

        expect(holderOf(row({...commented, opinions: [review('APPROVED')]}))).toEqual({role: 'operator', kind: 'merge', ids: []});
        expect(holderOf(row({...commented, opinions: [review('CHANGES_REQUESTED')]})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']});
        expect(holderOf(row({...judged('APPROVED'), opinions: undefined}))).toEqual({role: 'unknown', kind: null, ids: []})
    });

    test('a draft or unknown mergeability does not offer an approved head for merge or review routing', () => {
        const approved = {verdict: 'APPROVED', ...judged('APPROVED')};

        expect(holderOf(row({...approved, draft: true}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({...approved, mergeable: 'UNKNOWN'}))).toEqual({role: 'none', kind: null, ids: []});
        expect(holderOf(row({ci: 'pending', ...approved}))).toEqual({role: 'none', kind: null, ids: []})
    });

    test('a partial read decides only on positive evidence; an absence a missing page could hold is unknown', () => {
        const unknown = {role: 'unknown', kind: null, ids: []};

        expect(holderOf(row({verdict: 'APPROVED', ...judged('APPROVED'), partial: true}))).toEqual(unknown);
        expect(holderOf(row({owner: outside, partial: true}))).toEqual(unknown);
        expect(holderOf(row({requested: ['@neo-gpt'], partial: true}))).toEqual(unknown);
        expect(holderOf(row({partial: true}))).toEqual(unknown);
        expect(holderOf(row({ci: 'red', partial: true}))).toEqual({role: 'author', kind: 'repair-ci', ids: ['@neo-opus-ada']});
        expect(holderOf(row({owner: outside, ci: 'red', partial: true}))).toEqual({role: 'author', kind: 'repair-ci', ids: []});
        expect(holderOf(row({...judged('CHANGES_REQUESTED'), partial: true})))
            .toEqual({role: 'author', kind: 'address-changes', ids: ['@neo-opus-ada']})
    });
});
