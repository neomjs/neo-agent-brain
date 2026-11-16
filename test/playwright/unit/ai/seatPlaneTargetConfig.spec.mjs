import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import ConfigBase             from '../../../../ai/configBase.mjs';
import ConfigProvider, {leaf} from '../../../../ai/ConfigProvider.mjs';
import * as wire              from '../../../../ai/services/fleet/mcpWireParsing.mjs';

/** @summary Drives the actual leaf parser through an isolated Provider without changing process env or the singleton. */
function provider(env) {
    const declared = ConfigBase.config.data.seat.planeTarget;
    return Neo.create(ConfigProvider, {data: {seat: {planeTarget: leaf(declared.default, declared.env, declared.type,
        {parse: (name, options) => declared.parse(name, {...options, env})})}}});
}

test('the seat target is an explicit bootstrap leaf, with no local plane default', () => {
    const declared = ConfigBase.config.data.seat.planeTarget;
    const target   = {planeId: 'remote-plane', dataRoot: '/remote/durable'};
    const config   = provider({[declared.env]: JSON.stringify(target)});
    try {
        expect(config.getData('seat.planeTarget')).toEqual([target.planeId, target.dataRoot]);
        expect(wire.normalizeSeatPlaneTarget(config.getData('seat.planeTarget'))).toEqual(target);
        expect(declared).toMatchObject({default: null, env: 'NEO_SEAT_PLANE_TARGET', type: 'array'});
        expect(Object.isFrozen(config.getData('seat.planeTarget'))).toBe(true);
        expect(declared.parse(declared.env, {env: {}})).toBeUndefined();
    } finally {config.destroy();}
});

test('malformed present env clears previous target authority without failing Provider construction', () => {
    const env    = {NEO_SEAT_PLANE_TARGET: JSON.stringify({planeId: 'original', dataRoot: '/original/root'})};
    const config = provider(env);
    try {
        env.NEO_SEAT_PLANE_TARGET = '{';
        expect(() => config.refreshEnv()).not.toThrow();
        expect(config.getData('seat.planeTarget')).toEqual([]);
        for (const raw of ['', 'null', '[]', 'true', '123', '"text"', '{"planeId":"changed"}',
            '{"planeId":"changed","dataRoot":"relative"}',
            '{"planeId":" padded ","dataRoot":"/root"}',
            '{"planeId":"changed","dataRoot":"/root","extra":true}']) {
            const malformed = provider({NEO_SEAT_PLANE_TARGET: raw});
            try {
                expect(malformed.getData('seat.planeTarget'), raw).toEqual([]);
                expect(wire.normalizeSeatPlaneTarget(malformed.getData('seat.planeTarget'))).toBeNull();
            } finally {malformed.destroy();}
        }
        const absent = provider({});
        try {expect(absent.getData('seat.planeTarget')).toBeNull();} finally {absent.destroy();}
    } finally {config.destroy();}
});

test('a partial child target replaces the whole atomic binding instead of inheriting a root', () => {
    const Parent = Neo.setupClass(class extends ConfigProvider {
        static config = {className: 'Neo.test.family.SeatTargetParent1511', data: {
            seat: {planeTarget: leaf(['original', '/original/root'], null, 'array')}
        }};
    });
    const Child = Neo.setupClass(class extends Parent {
        static config = {className: 'Neo.test.family.SeatTargetChild1511', data: {
            seat: {planeTarget: leaf(['changed'], null, 'array')}
        }};
    });
    const config = Neo.create(Child);
    try {
        expect(config.getData('seat.planeTarget')).toEqual(['changed']);
        expect(wire.normalizeSeatPlaneTarget(config.getData('seat.planeTarget'))).toBeNull();
    } finally {config.destroy();}
});

test('only complete resolved tuples validate; raw or partial object overlays never become a mixed target', () => {
    const valid  = ['held', '/held/root'];
    const config = Neo.create(ConfigProvider, {data: {seat: {planeTarget: leaf(valid, null, 'array')}}});
    const absent = provider({});
    try {
        expect(wire.normalizeSeatPlaneTarget(valid)).toEqual({planeId: 'held', dataRoot: '/held/root'});
        for (const value of [null, [], ['changed'], ['changed', '/root', 'extra'], ['changed', 'relative'],
            {planeId: 'changed'}, {planeId: 'changed', dataRoot: '/held/root'}, JSON.stringify({planeId: 'held', dataRoot: '/held/root'}),
            Object.assign([...valid], {extra: true}), Object.defineProperty([...valid], '0', {get() {throw new Error('must not read');}})]) {
            expect(wire.normalizeSeatPlaneTarget(value)).toBeNull();
        }
        absent.setData({seat: {planeTarget: {planeId: 'changed'}}});
        expect(wire.normalizeSeatPlaneTarget(absent.getData('seat.planeTarget'))).toBeNull();
        // Provider ignores an object patch over an atomic value; it does not combine that patch with the held root.
        config.setData({seat: {planeTarget: {planeId: 'changed'}}});
        expect(wire.normalizeSeatPlaneTarget(config.getData('seat.planeTarget'))).toEqual({planeId: 'held', dataRoot: '/held/root'});
    } finally {config.destroy(); absent.destroy();}
});

test('runtime overrides supply parsed tuples and excluded seat metadata does not enter config exports', () => {
    const config = provider({});
    try {
        config.setEnvOverride('NEO_SEAT_PLANE_TARGET', ['override', '/override/root']);
        expect(wire.normalizeSeatPlaneTarget(config.getData('seat.planeTarget'))).toEqual({planeId: 'override', dataRoot: '/override/root'});
        expect(config.exportEnv({envNames: []})).toEqual({});
        expect(() => config.exportEnv({envNames: ['NEO_SEAT_PLANE_TARGET']})).toThrow('no scalar child-env representation');
    } finally {config.destroy();}
});
