import {test, expect} from '@playwright/test';
import {matchDeferencePhrase, detectDeferencePhrase} from '../../../../../../ai/scripts/lifecycle/deferencePhraseMatch.mjs';

/**
 * @summary Distinguishes executed-decision reports from genuine operator handbacks.
 */
test.describe('deferencePhraseMatch', () => {
    const reports = [
        ['recorded', 'I recorded your call as #42: the decision is in the ticket.'],
        ['followed', 'I followed your call and kept the old source.'],
        ['implemented', 'I implemented your call.'],
        ['applied', 'I applied your call.'],
        ['took', 'I took your call as the decision.'],
        ['went with', 'I went with your call.'],
        ['case folding', 'I RECORDED YOUR CALL.'],
        ['soft wraps', 'I went\n with\nyour\ncall.'],
        ['emphasis', 'I **recorded** __your call__.'],
        ['multiple executed reports', 'I recorded your call and followed your call.']
    ];

    for (const [name, text] of reports) {
        test(`executed report: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBeNull();
        });
    }

    const handbacks = [
        ['direct question', 'Your call?'],
        ['nonadjacent verb', 'recorded it — your call?'],
        ['prior sentence', 'I recorded the decision. Your call?'],
        ['question after report', 'I recorded your call. Your call?'],
        ['emphasized choice after report', 'I went with your call.\n\n**Your call:** A or B?'],
        ['question after citation', 'per #1 your call, but honestly, your call?'],
        ['citation tokens after executed verb', 'I recorded rule 1 your call?'],
        ['intervening pronoun', 'I recorded it, your call?']
    ];

    for (const [name, text] of handbacks) {
        test(`genuine handback: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBe('your call');
        });
    }

    const existingExemptions = [
        ['adjacent citation', 'per your call'],
        ['citation bridge', "per #1 that's your call"],
        ['operator direction', 'as you directed your call'],
        ['phrase mention', 'the phrase your call'],
        ['reported wording', 'reported your call'],
        ['identifier', 'your_call']
    ];

    for (const [name, text] of existingExemptions) {
        test(`existing exemption: ${name}`, () => {
            expect(matchDeferencePhrase(text)).toBeNull();
        });
    }

    test('operator dialogue retains the carve', () => {
        expect(detectDeferencePhrase('Your call?', {operatorInLoop: true})).toBeNull();
    });

    test('autonomous turns still detect genuine handbacks', () => {
        expect(detectDeferencePhrase('Your call?', {operatorInLoop: false})).toBe('your call');
    });
});
