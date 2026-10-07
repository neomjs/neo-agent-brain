import {test, expect} from '@playwright/test';

import {participationByIdentity} from '../../../../../../ai/graph/agentIdentityParticipation.mjs';
import {wakeTargetPermission}    from '../../../../../../ai/daemons/wake/wakeTargetEligibility.mjs';

/**
 * Receive permission over the identity nodes' participation. The identities below are real roster ids on
 * purpose: Iris's root reads benched and neo-gpt's reads active, so a module that still consulted the roots
 * would answer the opposite of what the nodes say.
 */
test.describe('wakeTargetPermission — receive permission, from the identity nodes (#879)', () => {
    const participation = participationByIdentity([
        {id: '@neo-kimi-iris', properties: {participationStatus: 'active'}},
        {id: '@neo-gpt',       properties: {participationStatus: 'operator_benched'}},
        {id: 'neo-retired',    properties: {participationStatus: 'retired'}},
        {id: '@neo-plain',     properties: {}}
    ]);

    test('the node decides: a node bench is benched over an active root, a node-active seat is eligible over a root bench', () => {
        expect(wakeTargetPermission('@neo-gpt', participation)).toBe('benched');
        expect(wakeTargetPermission('@neo-kimi-iris', participation)).toBe('eligible');
        expect(wakeTargetPermission('neo-retired', participation), 'ids are canonicalized on both sides').toBe('benched');
        expect(wakeTargetPermission('@neo-plain', participation), 'a node without a status reads active').toBe('eligible')
    });

    test('an identity without a node stays eligible, the open-set case for forks and local agents', () => {
        expect(wakeTargetPermission('@a-fork', participation)).toBe('eligible');
        expect(wakeTargetPermission(null, participation), 'a null target is not filtered here').toBe('eligible')
    });

    test('without a participation read every target is unread, which defers rather than drops', () => {
        expect(wakeTargetPermission('@neo-kimi-iris', null)).toBe('unread');
        expect(wakeTargetPermission('@neo-gpt', null), 'not benched: no read said so').toBe('unread')
    })
});
