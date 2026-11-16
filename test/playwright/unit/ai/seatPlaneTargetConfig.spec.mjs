import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import ConfigBase                     from '../../../../ai/configBase.mjs';
import {leaf}                         from '../../../../ai/ConfigProvider.mjs';
import {normalizeExpectedPlaneTarget} from '../../../../ai/services/fleet/mcpWireParsing.mjs';

test('the seat target is an explicit bootstrap leaf, with no local plane default', () => {
    const declared = ConfigBase.config.data.seat.planeTarget;
    expect(declared).toMatchObject({default: null, env: 'NEO_SEAT_PLANE_TARGET', type: 'string'});
    const target = {planeId: 'remote-plane', dataRoot: '/remote/durable'};
    expect(declared.parse(declared.env, {env: {[declared.env]: JSON.stringify(target)}})).toBe(JSON.stringify(target));
    expect(declared.parse(declared.env, {env: {}})).toBeUndefined();
});

test('a partial child target replaces the whole atomic binding instead of inheriting a root', () => {
    const Parent = Neo.setupClass(class extends ConfigBase {
        static config = {className: 'Neo.test.family.SeatTargetParent1511', data: {
            seat: {planeTarget: leaf('{"planeId":"original","dataRoot":"/original/root"}', null, 'string')}
        }};
    });
    const Child = Neo.setupClass(class extends Parent {
        static config = {className: 'Neo.test.family.SeatTargetChild1511', data: {
            seat: {planeTarget: leaf('{"planeId":"changed"}', null, 'string')}
        }};
    });
    const text = Child.config.data.seat.planeTarget.default;
    expect(text).toBe('{"planeId":"changed"}');
    expect(normalizeExpectedPlaneTarget(JSON.parse(text))).toBeNull();
});
