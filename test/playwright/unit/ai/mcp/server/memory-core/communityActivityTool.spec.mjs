import {setup} from '../../../../../setup.mjs';

setup({
    neoConfig: {unitTestMode: true},
    appConfig: {
        name             : 'MemoryCoreCommunityActivityToolTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

const WINDOW = {
    limit      : 10,
    windowEnd  : '2026-09-20T00:00:00.000Z',
    windowStart: '2026-09-19T00:00:00.000Z'
};

test.describe('Memory Core community activity MCP surface (#103 / #102)', () => {
    let CommunityActivityService, createFacade, originalClaimTask, originalQuery, originalGetContent, originalMarkSeen, calls;

    const facadeFor = transport => createFacade({resolveTransport: () => transport});

    const toolNames = [
        'claim_community_activity_task',
        'get_community_activity',
        'get_community_activity_content',
        'mark_community_activity_seen'
    ];

    const toolArguments = {
        claim_community_activity_task: {sourceEventId: 'event-1'},
        get_community_activity       : {
            ...WINDOW,
            cursor           : 'opaque-cursor',
            sourceInstanceIds: ['source-a']
        },
        get_community_activity_content: {sourceEventId: 'event-1'},
        mark_community_activity_seen  : {sourceEventId: 'event-1'}
    };

    test.beforeAll(async () => {
        ({createTransportVisibleToolFacade: createFacade} = await import(
            '../../../../../../../ai/mcp/server/memory-core/toolService.mjs'
        ));
        CommunityActivityService = (await import(
            '../../../../../../../ai/services/memory-core/CommunityActivityService.mjs'
        )).default;

        originalClaimTask  = CommunityActivityService.claimTask;
        originalQuery      = CommunityActivityService.query;
        originalGetContent = CommunityActivityService.getContent;
        originalMarkSeen   = CommunityActivityService.markSeen;
    });

    test.afterAll(() => {
        CommunityActivityService.claimTask  = originalClaimTask;
        CommunityActivityService.query      = originalQuery;
        CommunityActivityService.getContent = originalGetContent;
        CommunityActivityService.markSeen   = originalMarkSeen;
    });

    test.beforeEach(() => {
        calls = [];

        CommunityActivityService.claimTask = async args => {
            calls.push({operation: 'claim', args});
            return {
                claimedAt       : '2026-09-19T12:00:00.000Z',
                claimedBy       : '@neo-gemini-maryam',
                created         : true,
                notAuthority    : false,
                sourceEventId   : args.sourceEventId,
                sourceInstanceId: 'source-a',
                status          : 'claimed',
                task            : {
                    assignee              : '@neo-gemini-maryam',
                    id                    : 'MESSAGE:00000000-0000-4000-8000-000000000001',
                    occurrenceKind        : 'issue.comment',
                    parentProviderEntityId: null,
                    providerEntityId      : 'entity-1',
                    sourceEventId         : args.sourceEventId,
                    sourceInstanceId      : 'source-a',
                    state                 : 'Working'
                },
                taskId: 'MESSAGE:00000000-0000-4000-8000-000000000001'
            };
        };
        CommunityActivityService.query = async args => {
            calls.push({operation: 'query', args});
            return {items: [], nextCursor: null, notAuthority: true};
        };
        CommunityActivityService.getContent = async args => {
            calls.push({operation: 'content', args});
            return {notAuthority: true, sourceEventId: args.sourceEventId, status: 'unknown'};
        };
        CommunityActivityService.markSeen = args => {
            calls.push({operation: 'seen', args});
            return {status: 'seen'};
        };
    });

    test.afterEach(() => {
        CommunityActivityService.claimTask  = originalClaimTask;
        CommunityActivityService.query      = originalQuery;
        CommunityActivityService.getContent = originalGetContent;
        CommunityActivityService.markSeen   = originalMarkSeen;
    });

    test('advertises read/write tiers and dispatches all four operations on stdio and streamable-http', async () => {
        for (const transport of ['stdio', 'streamable-http']) {
            const facade = facadeFor(transport),
                  listed = new Map(facade.listTools({toolProjection: {mode: 'harness-embedded'}}).tools
                      .map(tool => [tool.name, tool]));

            for (const name of toolNames) expect(listed.has(name), `${transport}:${name}`).toBe(true);

            expect(listed.get('get_community_activity').inputSchema.required).toContain('limit');
            expect(listed.get('get_community_activity_content').annotations).toEqual({readOnlyHint: true});
            expect(listed.get('mark_community_activity_seen').annotations).toBeUndefined();
            expect(listed.get('claim_community_activity_task').annotations).toBeUndefined();

            await facade.callTool('get_community_activity', toolArguments.get_community_activity);
            await facade.callTool('get_community_activity_content', toolArguments.get_community_activity_content);
            await facade.callTool('mark_community_activity_seen', toolArguments.mark_community_activity_seen);
            await facade.callTool('claim_community_activity_task', toolArguments.claim_community_activity_task);
        }

        expect(calls).toEqual([
            {
                operation: 'query',
                args     : {
                    cursor           : 'opaque-cursor',
                    limit            : 10,
                    sourceInstanceIds: ['source-a'],
                    windowEnd        : WINDOW.windowEnd,
                    windowStart      : WINDOW.windowStart
                }
            },
            {operation: 'content', args: {sourceEventId: 'event-1'}},
            {operation: 'seen', args: {sourceEventId: 'event-1'}},
            {operation: 'claim', args: {sourceEventId: 'event-1'}},
            {
                operation: 'query',
                args     : {
                    cursor           : 'opaque-cursor',
                    limit            : 10,
                    sourceInstanceIds: ['source-a'],
                    windowEnd        : WINDOW.windowEnd,
                    windowStart      : WINDOW.windowStart
                }
            },
            {operation: 'content', args: {sourceEventId: 'event-1'}},
            {operation: 'seen', args: {sourceEventId: 'event-1'}},
            {operation: 'claim', args: {sourceEventId: 'event-1'}}
        ]);
    });

    test('requires an explicit positive query limit instead of applying a tool-layer default', async () => {
        for (const transport of ['stdio', 'streamable-http']) {
            await expect(facadeFor(transport).callTool('get_community_activity', {
                windowEnd  : WINDOW.windowEnd,
                windowStart: WINDOW.windowStart
            }), transport).rejects.toThrow();
        }

        expect(calls).toEqual([]);
    });

    test('rejects every current request-authority and task-authority field before normalization on every operation and transport', async () => {
        const forgedFields = [
            ['tenantId', 'forged-tenant'],
            ['userId', 'forged-user'],
            ['viewerId', 'forged-viewer'],
            ['sessionId', 'forged-session'],
            ['registrationEpoch', 7],
            ['agentIdentityNodeId', '@forged-agent'],
            ['taskId', 'MESSAGE:forged'],
            ['claimedBy', '@forged-agent'],
            ['assignee', '@forged-agent'],
            ['seen', true],
            ['deliveryId', 'delivery-1'],
            ['providerDeliveryId', 'delivery-1']
        ];

        for (const transport of ['stdio', 'streamable-http']) {
            const facade = facadeFor(transport);

            for (const name of toolNames) {
                for (const [field, value] of forgedFields) {
                    await expect(facade.callTool(name, {...toolArguments[name], [field]: value}), `${transport}:${name}:${field}`)
                        .rejects.toThrow(new RegExp(`COMMUNITY_ACTIVITY_AUTHORITY_FIELD_FORBIDDEN:args\\.${field}`));
                }
            }
        }

        expect(calls).toEqual([]);
    });
});
