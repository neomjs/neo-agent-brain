import {expect, test}                from '@playwright/test';
import {createHostWhoIsOnlineReader} from '../../../../../../ai/services/fleet/hostWhoIsOnlineReader.mjs';
import {readFleetPresenceSnapshot}   from '../../../../../../ai/services/fleet/fleetPresenceStateAdapter.mjs';

const openGraph = {db: {storage: {db: {}}}};

function readerOver(whoIsOnline, graph = openGraph) {
    return createHostWhoIsOnlineReader(async () => ({wakeSubscriptions: {whoIsOnline}, graph}))
}

test.describe('hostWhoIsOnlineReader — the host-mode presence read (#874)', () => {
    test('asks the in-process projection for the verbose rows and passes them through', async () => {
        const
            calls   = [],
            payload = {agents: [{identity: '@neo-gpt', state: 'online', reason: null, signals: {}}]},
            reader  = readerOver(args => {
                calls.push(args);
                return Promise.resolve(payload)
            });

        await expect(reader()).resolves.toBe(payload);
        expect(calls).toEqual([{verbose: true}])
    });

    test('a graph that is not open refuses before the projection answers an empty roster', async () => {
        let asked = false;
        const reader = readerOver(() => {
            asked = true;
            return Promise.resolve({agents: []})
        }, {db: null});

        await expect(reader()).rejects.toThrow('host graph not open');
        expect(asked).toBe(false)
    });

    test('an answer without a top-level agents array throws', async () => {
        await expect(readerOver(() => Promise.resolve({signalStatus: 'terse'}))()).rejects.toThrow('host who_is_online answer unreadable')
    });

    test('through the presence adapter, a seat carries its node\'s bench; a closed graph leaves it unread', async () => {
        const
            agents  = [{id: 'neo-gpt', githubUsername: 'neo-gpt'}],
            benched = {
                identity: '@neo-gpt', state: 'benched', reason: 'roster: generic',
                signals : {participationStatus: 'operator_benched', statusReason: 'the flatrate ended', participationSince: '2026-10-01T00:00:00.000Z', activityRecency: null}
            };

        const [read] = (await readFleetPresenceSnapshot({agents, readPresence: readerOver(() => Promise.resolve({agents: [benched]}))})).states;

        expect(read.participation).toEqual({status: 'operator_benched', reason: 'the flatrate ended', since: '2026-10-01T00:00:00.000Z'});
        expect(read.participationRead).toEqual({state: 'read'});

        const [unread] = (await readFleetPresenceSnapshot({agents, readPresence: readerOver(() => Promise.resolve({agents: [benched]}), {db: null})})).states;

        expect(unread.participation).toBeNull();
        expect(unread.participationRead).toEqual({state: 'unread', reason: 'host graph not open'})
    })
});
