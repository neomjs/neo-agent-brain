import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';

import {armClaudeSeat, describeArming} from '../../../../../../../ai/scripts/lifecycle/hooks/claude/wakeArmingHook.mjs';

/**
 * The Claude seat's arming entrypoint (`wakeArmingHook.mjs`): it hands the plane and
 * identity leaves to the pull arming, closes the session it opened, and says what happened in the one
 * line the harness shows at session start.
 */

const config = {planeBase: 'http://127.0.0.1:3102', planeBearer: 'token', identity: 'neo-seat'};

test('an unconfigured or unproven seat is reported UNARMED with the reason, and nothing is armed', async () => {
    let armed = 0;

    const result = await armClaudeSeat({
        config : {...config, planeBase: ''},
        connect: async () => ({reason: 'seat.planeBase is not configured, so there is no Memory Core plane to reach'}),
        arm    : async () => {armed++}
    });

    expect(result).toEqual({armed: false, reason: 'seat.planeBase is not configured, so there is no Memory Core plane to reach'});
    expect(armed).toBe(0);
    expect(describeArming(result)).toBe('[WARN] [wake-arming] seat is UNARMED — seat.planeBase is not configured, so there is no Memory Core plane to reach')
});

test('arms the proven seat for pull and closes the plane session afterwards', async () => {
    const seen   = [];
    let   closed = 0;

    const client = {async close() {closed++}},
          result = await armClaudeSeat({
              config,
              connect: async options => {seen.push(options); return {client, identity: '@neo-seat'}},
              arm    : async options => {seen.push(options); return {subscriptionId: 'WAKE_SUB:pull', retired: ['WAKE_SUB:a', 'WAKE_SUB:b']}}
          });

    expect(seen).toEqual([config, {client, identity: '@neo-seat'}]);
    expect(result).toEqual({armed: true, identity: '@neo-seat', subscriptionId: 'WAKE_SUB:pull', retired: ['WAKE_SUB:a', 'WAKE_SUB:b']});
    expect(closed).toBe(1);
    expect(describeArming(result)).toBe('[INFO] [wake-arming] @neo-seat armed for pull on WAKE_SUB:pull; unsubscribed 2 route(s) that typed into a window')
});

test('a failed arming still closes the plane session', async () => {
    let closed = 0;

    await expect(armClaudeSeat({
        config,
        connect: async () => ({client: {async close() {closed++}}, identity: '@neo-seat'}),
        arm    : async () => {throw new Error('plane refused the subscription')}
    })).rejects.toThrow('plane refused the subscription');

    expect(closed).toBe(1)
});
