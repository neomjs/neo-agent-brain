import {test, expect} from '@playwright/test';
import {identityFamilyComparisonKey, isIdentityPublicationBinding, isIdentityPublicationFamily,
    validateIdentityPublicationOperation} from '../../../../../../../ai/services/shared/identityPublicationOperation.mjs';
import {validateIdentityFamilyIntroduction} from '../../../../../../../ai/services/memory-core/helpers/identityPublicationVocabulary.mjs';
import {getCoreSwarmAgentFamilies}          from '../../../../../../../ai/services/graph/agentFamilyResolution.mjs';

/** @summary Supplies closed wire fixtures without importing config, services or graph storage. */
function binding() {
    return {subject: {authProvider: 'github', providerBaseUrl: 'https://api.github.com',
        providerUserId: 'stable-person', providerUsername: 'current-login'}, seatId: 'seat-a', incarnation: 'incarnation-a'};
}

/** @summary Exercises the same family grammar through both declaration variants. */
function operation(family, kind = 'confirm') {
    return {kind, operationId: 'act-a', effectiveAt: 1, binding: binding(),
        expectedMembershipRevision: 1, expectedAdmissionRevision: 0, family, model: null,
        newFamily                 : true, operatorPrincipal: 'operator-a', unattestedReason: 'No attested model.',
        ...(kind === 'correct' ? {targetAdmissionId: 'declaration-a', reason: 'Original label was incorrect.'} : {})};
}

const collisionCases = [
    ['whitespace and case', '  GPT  ', 'gpt', 'gpt'],
    ['internal whitespace removal', 'G\u00a0 P\u2028T', 'GPT', 'gpt'],
    ['fullwidth compatibility', 'ＧＰＴ', 'gpt', 'gpt'],
    ['sharp-s uppercase expansion', 'ß', 'SS', 'ss'],
    ['capital sharp-s lower-first expansion', 'ẞ', 'ß', 'ss'],
    ['canonical accent equivalence', 'café', 'cafe\u0301', 'café'],
    ['intentional dotless-i overmatch', 'ı', 'i', 'i']
];

for (const [name, first, second, key] of collisionCases) {
    test(name + ' collides without rewriting either exact label', () => {
        expect(identityFamilyComparisonKey(first)).toBe(key);
        expect(identityFamilyComparisonKey(second)).toBe(key);
        for (const [family, known] of [[first, second], [second, first]]) {
            expect(validateIdentityFamilyIntroduction({family, newFamily: true, knownFamilies: [known]}))
                .toEqual({valid: false, code: 'family-comparison-collision',
                    conflictingLabels: [known], remedy: 'use-existing-exact-label'});
            const answer = validateIdentityFamilyIntroduction({family, newFamily: false, knownFamilies: [family]});
            expect(answer).toEqual({valid: true, family, comparisonKey: key, novel: false});
            expect(Object.isFrozen(answer)).toBe(true);
            expect(validateIdentityPublicationOperation(operation(family)).operation.family).toBe(family);
        }
    });
}

test('control and format labels refuse through comparison, predicates and both operation variants', () => {
    for (const family of ['G\u200bPT', 'G\u200dPT', 'G\u202ePT', '\ufeffGPT', 'G\u00adPT',
        'G\u0085PT', 'G\u009fPT', 'G\tPT', 'G\nPT', 'G\0PT']) {
        expect(identityFamilyComparisonKey(family)).toBeNull();
        expect(isIdentityPublicationFamily(family)).toBe(false);
        expect(validateIdentityFamilyIntroduction({family, newFamily: true, knownFamilies: []}))
            .toEqual({valid: false, code: 'invalid-family'});
        for (const kind of ['confirm', 'correct']) {
            expect(validateIdentityPublicationOperation(operation(family, kind)))
                .toMatchObject({valid: false, field: 'family'});
        }
    }
});

test('Cyrillic er remains a distinct visual-confusable residual', () => {
    expect(identityFamilyComparisonKey('р')).toBe('р');
    expect(identityFamilyComparisonKey('p')).toBe('p');
    expect(validateIdentityFamilyIntroduction({family: 'р', newFamily: true, knownFamilies: ['p']}))
        .toEqual({valid: true, family: 'р', comparisonKey: 'р', novel: true});
});

test('literal unknown and prototype names are exact labels, never missing-state or inherited keys', () => {
    for (const family of ['unknown', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        expect(validateIdentityFamilyIntroduction({family, newFamily: true, knownFamilies: []}))
            .toMatchObject({valid: true, family, novel: true});
        expect(validateIdentityFamilyIntroduction({family, newFamily: false, knownFamilies: [family]}))
            .toMatchObject({valid: true, family, novel: false});
        expect(validateIdentityFamilyIntroduction({family, newFamily: true, knownFamilies: [family]}))
            .toEqual({valid: false, code: 'known-family-introduction'});
    }
});

test('explicit introduction intent distinguishes known and novel labels without coercion', () => {
    expect(validateIdentityFamilyIntroduction({family: 'gpt', newFamily: false, knownFamilies: []}))
        .toEqual({valid: false, code: 'new-family-intent-required'});
    expect(validateIdentityFamilyIntroduction({family: 'novel', newFamily: true, knownFamilies: ['gpt']}))
        .toEqual({valid: true, family: 'novel', comparisonKey: 'novel', novel: true});
    for (const newFamily of [undefined, null, 0, 1, 'true', 'false']) {
        expect(validateIdentityFamilyIntroduction({family: 'novel', newFamily, knownFamilies: []}))
            .toEqual({valid: false, code: 'invalid-family-intent'});
    }
});

test('the complete catalog is validated before known-label success, without rewriting older collisions', () => {
    for (const knownFamilies of [undefined, null, {}, new Set(['gpt']), ['gpt', null], ['gpt', 'bad\u200blabel'],
        ['gpt', ''], ['gpt', ' '.repeat(4)], ['gpt', '\ud800'], ['gpt', 'x'.repeat(255)]]) {
        expect(validateIdentityFamilyIntroduction({family: 'gpt', newFamily: false, knownFamilies}))
            .toEqual({valid: false, code: 'family-catalog-unavailable'});
    }
    const catalog = Object.freeze(['gpt', 'GPT', 'gpt']);
    expect(validateIdentityFamilyIntroduction({family: 'gpt', newFamily: false, knownFamilies: catalog}))
        .toEqual({valid: false, code: 'known-family-comparison-collision',
            conflictingLabels: ['GPT', 'gpt'], remedy: 'authorized-catalog-reconciliation'});
    expect(catalog).toEqual(['gpt', 'GPT', 'gpt']);
});

test('an old collision blocks only its key and never merges or reclassifies history', () => {
    const knownFamilies = Object.freeze(['gpt', 'GPT', 'claude']);
    for (const family of ['gpt', 'GPT', ' GpT ']) {
        for (const newFamily of [false, true]) {
            const result = validateIdentityFamilyIntroduction({family, newFamily, knownFamilies});
            expect(result).toEqual({valid: false, code: 'known-family-comparison-collision',
                conflictingLabels: ['GPT', 'gpt'], remedy: 'authorized-catalog-reconciliation'});
            expect(Object.isFrozen(result.conflictingLabels)).toBe(true);
        }
    }
    expect(validateIdentityFamilyIntroduction({family: 'claude', newFamily: false, knownFamilies}).valid).toBe(true);
    expect(validateIdentityFamilyIntroduction({family: 'new-family', newFamily: true, knownFamilies}).valid).toBe(true);
    expect(knownFamilies).toEqual(['gpt', 'GPT', 'claude']);
});

test('the checked-in roster source has no distinct labels sharing a comparison key', () => {
    // This checks source integrity only; it does not add a static-roster fallback to runtime admission.
    const knownFamilies = Object.values(getCoreSwarmAgentFamilies());
    expect(knownFamilies.length).toBeGreaterThan(0);
    for (const family of new Set(knownFamilies)) {
        expect(validateIdentityFamilyIntroduction({family, newFamily: false, knownFamilies}).valid).toBe(true);
    }
});

test('sparse, decorated and accessor catalogs refuse without executing an entry getter', () => {
    let   calls    = 0;
    const accessor = ['gpt'];
    Object.defineProperty(accessor, 1, {get() { calls++; return 'other'; }, enumerable: true});
    const sparse    = new Array(2); sparse[0] = 'gpt';
    const decorated = ['gpt']; decorated.authority = true;
    const symbol    = ['gpt']; symbol[Symbol('authority')] = true;
    const inherited = ['gpt']; Object.setPrototypeOf(inherited, Object.create(Array.prototype));
    for (const knownFamilies of [accessor, sparse, decorated, symbol, inherited]) {
        expect(validateIdentityFamilyIntroduction({family: 'gpt', newFamily: false, knownFamilies}))
            .toEqual({valid: false, code: 'family-catalog-unavailable'});
    }
    expect(calls).toBe(0);
});

test('missing, inherited, accessor or extra introduction fields cannot imply an empty catalog', () => {
    let   calls    = 0;
    const valid    = {family: 'gpt', newFamily: true, knownFamilies: []};
    const accessor = {...valid};
    Object.defineProperty(accessor, 'knownFamilies', {get() { calls++; return []; }, enumerable: true});
    for (const input of [null, undefined, {}, {family: 'gpt', newFamily: true},
        Object.assign(Object.create({knownFamilies: []}), {family: 'gpt', newFamily: true}),
        {...valid, admitted: true}, accessor]) {
        expect(validateIdentityFamilyIntroduction(input)).toEqual({valid: false, code: 'invalid-family-introduction'});
    }
    expect(calls).toBe(0);
    expect(validateIdentityFamilyIntroduction(Object.assign(Object.create(null), valid)).valid).toBe(true);
});

test('comparison keeps the fixed encoded-byte and well-formed label grammar', () => {
    for (const family of [null, undefined, 1, {}, '', '  ', '\u00a0\u2028\u2029', '\ud800', 'x'.repeat(255)]) {
        expect(identityFamilyComparisonKey(family)).toBeNull();
        expect(isIdentityPublicationFamily(family)).toBe(false);
    }
    const family = 'X'.repeat(254);
    expect(identityFamilyComparisonKey(family)).toBe('x'.repeat(254));
    expect(validateIdentityFamilyIntroduction({family, newFamily: true, knownFamilies: []}).family).toBe(family);
});

test('stored bindings reuse the closed wire grammar and preserve mutable display names', () => {
    const value = binding(), before = structuredClone(value);
    expect(isIdentityPublicationBinding(value)).toBe(true);
    expect(value).toEqual(before);
    value.subject.providerUsername = 'new-login';
    expect(isIdentityPublicationBinding(value)).toBe(true);
    const inherited = Object.assign(Object.create({authority: true}), binding());
    for (const bad of [null, {}, inherited, {...binding(), permission: true}, {...binding(), incarnation: ''},
        {...binding(), seatId: ' padded '}, {...binding(), subject: {...binding().subject, providerUserId: null}}]) {
        expect(isIdentityPublicationBinding(bad)).toBe(false);
    }
    let   calls    = 0;
    const accessor = binding();
    Object.defineProperty(accessor.subject, 'providerUserId', {get() { calls++; return 'stable-person'; }, enumerable: true});
    expect(isIdentityPublicationBinding(accessor)).toBe(false);
    expect(calls).toBe(0);
    expect(isIdentityPublicationBinding(Object.assign(Object.create(null), binding()))).toBe(true);
});

test('runtime codepoint census preserves case invariance and comparison-key idempotence', () => {
    const failures = [];
    let   accepted = 0, failureCount = 0;
    for (let codepoint = 0; codepoint <= 0x10ffff; codepoint++) {
        const value = String.fromCodePoint(codepoint), key = identityFamilyComparisonKey(value);
        if (key === null) continue;
        accepted++;
        for (const [kind, variant] of [['lower', value.toLowerCase()], ['upper', value.toUpperCase()], ['key', key]]) {
            const actual = identityFamilyComparisonKey(variant);
            if (actual !== key) {
                failureCount++;
                if (failures.length < 12) failures.push({codepoint: codepoint.toString(16), kind, key, actual});
            }
        }
    }
    expect({checkedAll: accepted > 1000000, failureCount, failures}).toEqual({checkedAll: true, failureCount: 0, failures: []});
});
