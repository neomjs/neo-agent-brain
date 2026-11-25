import {test, expect}   from '@playwright/test';
import {buildArgsShape} from '../../../../../../../ai/services/memory-core/helpers/toolArgsShape.mjs';

// The shape names a stalled call's query without carrying its content: closed values of the tool's
// allow-listed arguments, and only the keys of everything else.

test.describe('ai/services/memory-core/helpers/toolArgsShape', () => {
    test('keeps the closed values of allow-listed arguments and only the keys of the rest', () => {
        expect(buildArgsShape('list_messages', {
            box           : 'all',
            status        : 'unread',
            limit         : 50,
            includeArchived: true,
            fromIdentity  : '@neo-gpt-sophie',
            taggedConcepts: ['lane-claim'],
            since         : '2026-11-25T16:00:00.000Z',
            threadId      : undefined
        })).toEqual({
            values: {box: 'all', includeArchived: true, limit: 50, status: 'unread'},
            keys  : ['fromIdentity', 'since', 'taggedConcepts']
        });
    });

    test('an allow-listed key holding an identity, an id or prose keeps only its key', () => {
        expect(buildArgsShape('list_messages', {box: '@neo-opus-ada', status: 'MESSAGE:26fcbfb0', projection: 'a sentence with spaces'}))
            .toEqual({values: {}, keys: ['box', 'projection', 'status']});
    });

    test('a tool without an allow-list keeps keys only, and a call without object arguments has no shape', () => {
        expect(buildArgsShape('add_message', {to: '@neo-opus-grace', subject: 'secret', priority: 'high'}))
            .toEqual({values: {}, keys: ['priority', 'subject', 'to']});
        expect(buildArgsShape('healthcheck', undefined)).toBeNull();
        expect(buildArgsShape('healthcheck', ['positional'])).toBeNull();
    });
});
