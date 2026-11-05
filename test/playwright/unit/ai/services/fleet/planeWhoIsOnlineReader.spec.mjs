import {expect, test}                 from '@playwright/test';
import {createPlaneWhoIsOnlineReader} from '../../../../../../ai/services/fleet/planeWhoIsOnlineReader.mjs';

test.describe('planeWhoIsOnlineReader — the plane-mode presence read', () => {
    test('the production request shape is the verbose contract — argument-captured, not assumed', async () => {
        // The terse report omits the per-agent rows entirely, so the exact request arguments ARE
        // the contract under test: a reader that "works" against a hand-injected verbose payload
        // while sending the terse request would throw on every healthy production call.
        const
            calls   = [],
            payload = {agents: [{identity: '@neo-fable-clio', state: 'online', reason: null, signals: {}}]},
            reader  = createPlaneWhoIsOnlineReader({
                callTool: (name, args) => {
                    calls.push([name, args]);
                    return Promise.resolve(payload)
                }
            });

        await expect(reader()).resolves.toBe(payload);
        expect(calls).toEqual([['who_is_online', {verbose: true}]])
    });

    test('an answer without a top-level agents array throws — the source converts that into honest unknown', async () => {
        const reader = createPlaneWhoIsOnlineReader({
            callTool: () => Promise.resolve({signalStatus: 'terse shape, no rows'})
        });

        await expect(reader()).rejects.toThrow('plane who_is_online answer unreadable')
    });

    test('a client rejection propagates untouched — degradation policy belongs to the consumer', async () => {
        const reader = createPlaneWhoIsOnlineReader({
            callTool: () => Promise.reject(new Error('plane unreachable'))
        });

        await expect(reader()).rejects.toThrow('plane unreachable')
    });

    test('concurrent reads share one plane call, and a read after it settles makes its own (#1468)', async () => {
        const
            answers = [],
            reader  = createPlaneWhoIsOnlineReader({callTool: () => new Promise(resolve => answers.push(resolve))}),
            first   = reader(),
            second  = reader();

        expect(answers, 'the roster, open work and the wake routes read presence at once').toHaveLength(1);

        answers[0]({agents: []});
        expect(await second).toBe(await first);

        const third = reader();

        expect(answers).toHaveLength(2);
        answers[1]({agents: [{identity: '@neo-fable-clio', state: 'online'}]});
        expect((await third).agents).toHaveLength(1)
    });

    test('a rejection reaches every caller sharing the call (#1468)', async () => {
        let calls = 0;

        const
            reader = createPlaneWhoIsOnlineReader({callTool: () => { calls++; return Promise.reject(new Error('plane unreachable')) }}),
            reads  = [reader(), reader()];

        expect(calls).toBe(1);

        for (const read of reads) {
            await expect(read).rejects.toThrow('plane unreachable')
        }
    })
});
