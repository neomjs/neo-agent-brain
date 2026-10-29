import {setup} from '../../../../setup.mjs';

const appName = 'MailboxBroadcastAudienceTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import                            'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';

test.describe.configure({mode: 'serial'});

/**
 * @summary An `AGENT:*` broadcast's send-time cohort comes from the graph store, not the in-memory cache.
 *
 * The cache holds only the nodes loaded since boot and drops nodes another process changed, so a cohort
 * read from it gives a persisted but uncached identity no delivery edge and its mailbox never shows the
 * broadcast. Each arm asserts the `DELIVERED_TO` edges the send wrote, which are the cohort itself.
 */
test.describe('MailboxService — the broadcast audience is read from the graph store', () => {
    let GraphService, MailboxService;

    const deliveredTo = messageId => GraphService.db.storage.db
        .prepare("SELECT target FROM Edges WHERE source = ? AND type = 'DELIVERED_TO'")
        .all(messageId)
        .map(row => row.target)
        .sort();

    const identity = (id, accountType) => GraphService.upsertNode({id, type: 'AgentIdentity', name: id, properties: {accountType}});

    const broadcastFrom = sender => RequestContextService.run({agentIdentityNodeId: sender}, () => MailboxService.addMessage({
        to     : 'AGENT:*',
        subject: `broadcast from ${sender}`,
        body   : 'audience fixture'
    }));

    test.beforeAll(async () => {
        GraphService   = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;

        const LifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }
    });

    test('a persisted identity missing from the in-memory cache still receives the broadcast', async () => {
        identity('@audience-cold-sender',    'agent');
        identity('@audience-cold-recipient', 'agent');

        // The state after a restart or an eviction: in storage, not loaded. The cache drops it the
        // way `syncCache` does, with autoSave off, so the removal never reaches storage.
        const db       = GraphService.db,
              autoSave = db.autoSave;

        db.autoSave = false;
        db.nodes.remove('@audience-cold-recipient');
        db.autoSave = autoSave;
        db.vicinityLoadedNodes.delete('@audience-cold-recipient');
        db.lastAccessMap.delete('@audience-cold-recipient');

        expect(db.nodes.get('@audience-cold-recipient'), 'the cache no longer holds the identity').toBeFalsy();
        expect(db.storage.db.prepare('SELECT id FROM Nodes WHERE id = ?').get('@audience-cold-recipient'), 'storage still does').toBeTruthy();

        const {messageId} = await broadcastFrom('@audience-cold-sender');

        expect(deliveredTo(messageId)).toContain('@audience-cold-recipient');

        const page = await RequestContextService.run({agentIdentityNodeId: '@audience-cold-recipient'}, () =>
            MailboxService.listMessages({box: 'inbox', limit: 5}));

        expect(page.messages.map(message => message.subject)).toContain('broadcast from @audience-cold-sender')
    });

    test('the sender, human and sentinel identities stay out of the cohort', async () => {
        identity('@audience-sender',   'agent');
        identity('@audience-peer',     'agent');
        identity('@audience-human',    'human');
        identity('@audience-sentinel', 'sentinel');

        const recipients = deliveredTo((await broadcastFrom('@audience-sender')).messageId);

        expect(recipients).toContain('@audience-peer');
        expect(recipients).not.toContain('@audience-sender');
        expect(recipients).not.toContain('@audience-human');
        expect(recipients).not.toContain('@audience-sentinel')
    });
});
