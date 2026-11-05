import {TRUST_TIERS} from './trustTiers.mjs';

/**
 * @module ai/graph/mailboxRoots
 * @summary The two graph roots every plane's mailbox needs, whatever its team: the system sender
 * and the broadcast sentinel.
 *
 * Boot seeds both on every plane (`bootSeedManifest.mjs`). `identityRoots.mjs` lists them beside our
 * team, so the setup seed and the roster's readers see the same two records.
 */

/**
 * @summary The non-human sender of lifecycle-generated mailbox messages.
 * @member {Object}
 */
export const SYSTEM_SENDER = {
    id         : '@system',
    type       : 'System',
    name       : 'System Sender',
    description: 'Non-human system sender used for lifecycle-generated mailbox messages.',
    properties : {
        githubLogin: null,
        displayName: 'System',
        modelFamily: null,
        accountType: 'system',
        trustTier  : TRUST_TIERS.SYSTEM,
        createdAt  : '2026-05-27T12:33:17.000Z'
    }
};

/**
 * @summary The target of every broadcast, which must exist as a node for broadcast edges to survive.
 * @member {Object}
 */
export const BROADCAST_SENTINEL = {
    id         : 'AGENT:*',
    type       : 'BroadcastSentinel',
    name       : 'Broadcast',
    description: 'Mailbox broadcast sentinel. `SENT_TO` edges targeting this node preserve one semantic broadcast MESSAGE; current sends snapshot per-recipient unread state through `DELIVERED_TO` edges, with legacy SENT_TO-only visibility retained for old broadcasts. Must exist as a real graph node so GraphService.linkNodes FK-style guard does not cull broadcast edges — see #10174 and #11029.',
    properties : {
        githubLogin: null,
        displayName: 'Broadcast',
        modelFamily: null,
        accountType: 'sentinel',
        trustTier  : TRUST_TIERS.UNCLASSIFIED,
        createdAt  : '2026-04-23T13:03:46.000Z'
    }
};
