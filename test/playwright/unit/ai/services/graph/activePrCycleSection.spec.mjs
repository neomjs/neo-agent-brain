import {setup} from '../../../../setup.mjs';

setup({appConfig: {name: 'ActivePrCycleSectionTest'}});

import {test, expect}              from '@playwright/test';
import Neo                         from 'neo.mjs/src/Neo.mjs';
import * as core                   from 'neo.mjs/src/core/_export.mjs';
import {renderRecentOpenPrSummary} from '../../../../../../ai/services/graph/activePrCycleSection.mjs';

const pr = {
    number : 7, title: 'Qualified review', createdAt: '2026-11-16T00:00:00Z',
    author : {login: 'neo-gemini-julia'},
    reviews: [{author: {login: 'neo-opus-grace'}, state: 'APPROVED'}]
};

test.describe('activePrCycleSection qualified family evidence', () => {
    test('absent and unavailable evidence never falls back to roster approvals', () => {
        expect(renderRecentOpenPrSummary([pr], {limit: 5}))
            .toContain('cross-family reviewed: unavailable (family-verdict-unavailable)');
        expect(renderRecentOpenPrSummary([{
            ...pr, familyVerdict: {sourceState: 'unavailable', code: 'family-source-fenced', crossFamily: true}
        }], {limit: 5})).toContain('cross-family reviewed: unavailable (family-source-fenced)');
    });

    test('renders the qualified positive and negative even when raw logins disagree', () => {
        expect(renderRecentOpenPrSummary([{
            ...pr, familyVerdict: {sourceState: 'available', crossFamily: false}
        }], {limit: 5})).toContain('cross-family reviewed: no');
        expect(renderRecentOpenPrSummary([{
            ...pr, author: {login: 'unrostered'}, reviews: [],
            familyVerdict: {sourceState: 'available', crossFamily: true}
        }], {limit: 5})).toContain('cross-family reviewed: yes');
    });

    test('unresolved or malformed evidence remains unavailable', () => {
        for (const crossFamily of [null, undefined, 'true']) {
            expect(renderRecentOpenPrSummary([{
                ...pr, familyVerdict: {sourceState: 'available', crossFamily}
            }], {limit: 5})).toContain('cross-family reviewed: unavailable (family-verdict-unavailable)');
        }
    });

    test('outside no-model coverage requires complete disclosures and a qualified approver', () => {
        const familyVerdict = {
            sourceState   : 'available', crossFamily: null, outside: true,
            authorFamilies: [], approvingFamilies: ['unknown'], disclosureTruncated: false
        };
        expect(renderRecentOpenPrSummary([{...pr, familyVerdict}], {limit: 5}))
            .toContain('cross-family reviewed: yes');
        expect(renderRecentOpenPrSummary([{
            ...pr, familyVerdict: {...familyVerdict, approvingFamilies: []}
        }], {limit: 5})).toContain('cross-family reviewed: no');
        expect(renderRecentOpenPrSummary([{
            ...pr, familyVerdict: {...familyVerdict, disclosureTruncated: true}
        }], {limit: 5})).toContain('cross-family reviewed: unavailable (family-verdict-unavailable)');
        expect(renderRecentOpenPrSummary([{
            ...pr, familyVerdict: {...familyVerdict, qualified: false, code: 'approval-unclassified'}
        }], {limit: 5})).toContain('cross-family reviewed: unavailable (approval-unclassified)');
    });
});
