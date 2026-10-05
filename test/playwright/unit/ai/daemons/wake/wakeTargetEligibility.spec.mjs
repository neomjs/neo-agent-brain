import {test, expect} from '@playwright/test';

import {
    isWakeTargetEligible,
    participationByIdentity
} from '../../../../../../ai/daemons/wake/wakeTargetEligibility.mjs';

/**
 * Receive permission over the identity nodes' participation. The identities below are real roster ids on
 * purpose: Iris's root reads benched and neo-gpt's reads active, so a module that still consulted the roots
 * would answer the opposite of what the nodes say.
 */
test.describe('isWakeTargetEligible — receive permission, from the identity nodes (#879)', () => {
    const participation = participationByIdentity([
        {id: '@neo-kimi-iris', properties: {participationStatus: 'active'}},
        {id: '@neo-gpt',       properties: {participationStatus: 'operator_benched'}},
        {id: 'neo-retired',    properties: {participationStatus: 'retired'}},
        {id: '@neo-plain',     properties: {}}
    ]);

    test('the node decides: a node bench stops a root-active seat, a node-active seat is woken over a root bench', () => {
        expect(isWakeTargetEligible('@neo-gpt', participation)).toBe(false);
        expect(isWakeTargetEligible('@neo-kimi-iris', participation)).toBe(true);
        expect(isWakeTargetEligible('neo-retired', participation), 'ids are canonicalized on both sides').toBe(false);
        expect(isWakeTargetEligible('@neo-plain', participation), 'a node without a status reads active').toBe(true)
    });

    test('an identity without a node stays eligible, the open-set case for forks and local agents', () => {
        expect(isWakeTargetEligible('@a-fork', participation)).toBe(true);
        expect(isWakeTargetEligible(null, participation), 'a null target is not filtered here').toBe(true)
    });

    test('without a participation read nothing is eligible', () => {
        expect(isWakeTargetEligible('@neo-kimi-iris', null)).toBe(false);
        expect(isWakeTargetEligible('@a-fork', null)).toBe(false)
    })
});
