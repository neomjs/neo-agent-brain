import {test, expect}    from '@playwright/test';
import {launchRefusalOf} from '../../../../../../src/fleet/contract/launchAuthority.mjs';

const released = {launchOwner: 'external', launchOwnerSince: '2026-09-19T17:05:00.000Z'},
      benched  = {status: 'operator_benched', reason: 'the flatrate ended', since: '2026-08-17T00:00:00.000Z'};

test.describe('launchRefusalOf — the one start refusal (#885)', () => {
    test('a bench refuses in the operator\'s words, with the date and the reason', () => {
        expect(launchRefusalOf({}, benched)).toBe('benched by the operator on 2026-08-17: the flatrate ended');
        expect(launchRefusalOf({}, {status: 'operator_benched'})).toBe('benched by the operator');
        expect(launchRefusalOf({}, {status: 'temporarily_unreachable', reason: 'quota'})).toBe('marked temporarily_unreachable: quota')
    });

    test('the release refusal comes first', () => {
        expect(launchRefusalOf(released, benched)).toBe('released to its own harness: adopt it to start it here')
    });

    test('active, absent or unread participation refuses nothing, and the one-argument call is unchanged', () => {
        expect(launchRefusalOf({}, {status: 'active', reason: null, since: null})).toBeNull();
        expect(launchRefusalOf({}, null)).toBeNull();
        expect(launchRefusalOf({})).toBeNull();
        expect(launchRefusalOf(null)).toBeNull()
    })
});
