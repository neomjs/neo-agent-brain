import {test, expect} from '@playwright/test';
import crypto         from 'node:crypto';
import {
    canonicalizeDeterministicJsonValue as sharedCanonicalize,
    stringifyCanonicalJson
} from '../../../../../../ai/services/shared/canonicalJson.mjs';
import {
    canonicalizeDeterministicJsonValue,
    computePublishRevisionDigest
} from '../../../../../../ai/services/memory-core/helpers/publishDigest.mjs';

test.describe('canonical JSON shared publication bytes', () => {
    test('the old path re-exports the shared primitive', () => {
        expect(canonicalizeDeterministicJsonValue).toBe(sharedCanonicalize);
    });

    test('preserves own prototype-named keys as data', () => {
        const input = JSON.parse('{"z":1,"__proto__":{"allowed":false},"constructor":"family","a":null}');
        const result = canonicalizeDeterministicJsonValue(input);

        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
        expect(JSON.stringify(result)).toBe('{"__proto__":{"allowed":false},"a":null,"constructor":"family","z":1}');
        expect(Object.hasOwn({}, 'allowed')).toBe(false);
    });

    test('detaches and orders objects while preserving array order and explicit null', () => {
        const input = {z: [{b: 2, a: 1}, null], a: 'é'};
        const result = canonicalizeDeterministicJsonValue(input);

        expect(JSON.stringify(result)).toBe('{"a":"é","z":[{"a":1,"b":2},null]}');
        result.z[0].a = 9;
        expect(input.z[0].a).toBe(1);
        expect(JSON.stringify(canonicalizeDeterministicJsonValue({a: 'é', z: [{a: 1, b: 2}, null]})))
            .toBe('{"a":"é","z":[{"a":1,"b":2},null]}');
    });

    test('preserves the existing publication digest byte contract', () => {
        const input = {text: 'Hello', format: 'post', channel: 'x', account: 'operator'};
        const expectedBytes = '{"account":"operator","channel":"x","format":"post","inReplyTo":null,"media":[],"text":"Hello"}';

        expect(computePublishRevisionDigest(input)).toBe(crypto.createHash('sha256').update(expectedBytes).digest('hex'));
    });

    test('strict encoding retains explicit data and repeated references without mutating them', () => {
        const leaf = Object.freeze({model: null, family: 'constructor'});
        const input = Object.freeze({b: leaf, a: leaf});

        expect(stringifyCanonicalJson(input)).toBe('{"a":{"family":"constructor","model":null},"b":{"family":"constructor","model":null}}');
        expect(stringifyCanonicalJson(JSON.parse('{"__proto__":null}'))).toBe('{"__proto__":null}');
    });

    for (const [name, value] of [
        ['undefined field', {model: undefined}], ['undefined array item', [undefined]],
        ['NaN', {time: NaN}], ['infinity', [Infinity]], ['bigint', {revision: 1n}],
        ['function', {toJSON: () => ({accepted: true})}], ['symbol', {family: Symbol('gpt')}],
        ['date', new Date(0)], ['typed array', new Uint8Array([1, 2])],
        ['sparse array', Array(2)], ['array property', Object.assign([], {extra: true})],
        ['symbol key', {[Symbol('hidden')]: true}], ['custom prototype', Object.create({inherited: true})],
        ['non-enumerable field', Object.defineProperty({}, 'hidden', {value: true})]
    ]) {
        test(`strict encoding refuses ${name}`, () => {
            expect(() => stringifyCanonicalJson(value)).toThrow(TypeError);
        });
    }

    test('rejects accessors without invoking them and rejects cycles', () => {
        let invoked = false;
        const accessor = Object.defineProperty({}, 'family', {enumerable: true, get() {invoked = true; return 'gpt';}});
        const cyclic = {};
        cyclic.self = cyclic;

        expect(() => stringifyCanonicalJson(accessor)).toThrow(TypeError);
        expect(invoked).toBe(false);
        expect(() => stringifyCanonicalJson(cyclic)).toThrow(TypeError);
    });

    test('rejects custom array serialization without invoking it', () => {
        let invoked = false;
        class CustomArray extends Array {
            toJSON() { invoked = true; return 'changed'; }
        }

        expect(() => stringifyCanonicalJson(new CustomArray(1, 2))).toThrow(TypeError);
        expect(invoked).toBe(false);
    });
});
