import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'MemoryCoreAddMessageToolTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

/**
 * @summary The `add_message` tool hands the request's Memory Core session to the mailbox as a server-owned
 * option: the session `add_memory` saves under, so a sunset handover names the writer whose close ends its
 * turn. A wire field can neither set nor suppress it.
 */
test.describe('Memory Core add_message tool boundary (#1739)', () => {
    let MailboxService, RequestContextService, createFacade, originalAddMessage;

    test.beforeAll(async () => {
        ({createTransportVisibleToolFacade: createFacade} = await import(
            '../../../../../../../ai/mcp/server/memory-core/toolService.mjs'
        ));
        MailboxService        = (await import('../../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        RequestContextService = (await import('../../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs')).default;
        originalAddMessage    = MailboxService.addMessage;
    });

    test.afterAll(() => {
        MailboxService.addMessage = originalAddMessage
    });

    test('the request\'s session rides as serverSessionId beside deferProjection on every transport, and a wire field cannot set it', async () => {
        const calls = [];

        MailboxService.addMessage = async (args, options) => {
            calls.push({args, options});
            return {messageId: 'MESSAGE:00000000-0000-4000-8000-000000000001', sentAt: '2026-11-15T01:50:08.824Z', priority: 'normal', status: 'sent'}
        };

        for (const transport of ['stdio', 'streamable-http']) {
            await RequestContextService.run({agentIdentityNodeId: '@neo-rotation-seat', sessionId: 'session-writer'}, () =>
                createFacade({resolveTransport: () => transport}).callTool('add_message', {
                    to             : '@neo-rotation-seat', subject: '[sunset]', body: 'handover', wakeSuppressed: true,
                    taggedConcepts : ['sunset-protocol-handover'],
                    serverSessionId: 'session-forged'
                })
            )
        }

        expect(calls).toHaveLength(2);

        for (const {args, options} of calls) {
            expect(options).toEqual({deferProjection: true, serverSessionId: 'session-writer'});
            expect(Object.hasOwn(args, 'serverSessionId')).toBe(false)
        }
    });
});
