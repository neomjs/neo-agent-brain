import {expect, test}                    from '@playwright/test';
import {createPlanePrLaneActivityReader} from '../../../../../../ai/services/fleet/planePrLaneActivityReader.mjs';

/**
 * The plane-mode PR/lane read: a fleet process attached to a plane has no corpus, so its PR/lane slot
 * is the plane's `get_pr_lane_activity` — the slot's own snapshot, served from the corpus the
 * orchestrator materializes, handed to the composer untouched.
 */
test.describe('planePrLaneActivityReader — the plane-mode PR/lane read', () => {
    const planeSnapshot = () => ({
        capability     : {source: 'fleet-activity', state: 'wired', confidence: 'observed', capturedAt: '2026-09-27T14:00:00.000Z'},
        counts         : [],
        events         : [{eventId: 'github-pr:7', type: 'pr-activity'}],
        corpusIndexedAt: '2026-09-27T14:27:29.000Z'
    });

    test('the request is the plane tool with the slot\'s limit, and the snapshot comes back untouched', async () => {
        const
            calls    = [],
            snapshot = planeSnapshot(),
            reader   = createPlanePrLaneActivityReader({
                callTool: (name, args) => {
                    calls.push([name, args]);
                    return Promise.resolve(snapshot)
                }
            });

        await expect(reader({limit: 25})).resolves.toBe(snapshot);
        expect(calls).toEqual([['get_pr_lane_activity', {limit: 25}]])
    });

    test('asked for no pull-request events, the request carries `prEvents: false` to the plane; otherwise the flag never travels', async () => {
        const
            calls  = [],
            reader = createPlanePrLaneActivityReader({
                callTool: (name, args) => {
                    calls.push(args);
                    return Promise.resolve(planeSnapshot())
                }
            });

        await reader({limit: 200, prEvents: false});
        await reader({limit: 25, prEvents: true});
        await reader({limit: 25});

        expect(calls).toEqual([{limit: 200, prEvents: false}, {limit: 25}, {limit: 25}])
    });

    test('a degraded plane snapshot is the slot\'s answer too — the plane\'s reason reaches the feed', async () => {
        const
            degraded = {capability: {state: 'degraded', reason: 'neo: ENOENT'}, counts: [], events: [{eventId: 'pr-lane:source-degraded', type: 'source-degraded'}]},
            reader   = createPlanePrLaneActivityReader({callTool: () => Promise.resolve(degraded)});

        await expect(reader({limit: 5})).resolves.toBe(degraded)
    });

    test('an answer that is not a snapshot throws, so the composer degrades this slot alone', async () => {
        const reader = createPlanePrLaneActivityReader({callTool: () => Promise.resolve({status: 'available'})});

        await expect(reader({limit: 5})).rejects.toThrow('plane get_pr_lane_activity answer unreadable')
    });

    test('a client rejection propagates untouched — degradation policy belongs to the composer', async () => {
        const reader = createPlanePrLaneActivityReader({callTool: () => Promise.reject(new Error('plane unreachable'))});

        await expect(reader({limit: 5})).rejects.toThrow('plane unreachable')
    });
});
