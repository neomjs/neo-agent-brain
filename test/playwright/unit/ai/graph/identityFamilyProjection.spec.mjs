import {test, expect}                                    from '@playwright/test';
import {buildFamilyProjection, familyAt, familiesDuring} from '../../../../../ai/graph/identityFamilyProjection.mjs';

const member      = (bindingId = 'A', since = 10, until = null) => ({bindingId, since, until});
const declaration = (admissionId = 'a', bindingId = 'A', since = 10, family = 'gpt', revision = 2,
    operatorPrincipal = 'operator-a', model = null) =>
    ({admissionId, bindingId, since, family, revision, operatorPrincipal, model});
const correction = (admissionId, targetAdmissionId, family, revision, operatorPrincipal = 'operator-a', model = null) =>
    ({admissionId, targetAdmissionId, family, revision, operatorPrincipal, model});
const source = (overrides = {}) => ({baselineSince: 10, revision: 10,
    memberships: [member()], declarations: [declaration()], corrections: [], ...overrides});
const swaps = () => source({declarations: [declaration(), declaration('b', 'A', 20, 'claude', 3),
    declaration('c', 'A', 30, 'gpt', 4)]});
const classified = family => ({state: 'classified', family});

test.describe('admitted family temporal projection', () => {
    test('baseline and first declaration never backfill earlier instants', () => {
        const projection = buildFamilyProjection(source({declarations: [declaration('a', 'A', 20)]}));
        expect(projection.valid).toBe(true);
        expect(familyAt(projection, 9)).toEqual({state: 'membership-unknown', family: null});
        expect(familyAt(projection, 10)).toEqual({state: 'unconfirmed-seat', family: null});
        expect(familyAt(projection, 19)).toEqual({state: 'unconfirmed-seat', family: null});
        expect(familyAt(projection, 20)).toEqual(classified('gpt'));
        expect(familiesDuring(projection, 9, 30)).toEqual({state: 'membership-unknown', families: []});
        expect(familiesDuring(projection, 10, 30)).toEqual({state: 'unconfirmed-seat', families: []});
    });

    test('an uninitialized source remains membership-unknown, distinct from an admitted empty set', () => {
        const missing = buildFamilyProjection(source({baselineSince: null, revision: 0, memberships: [], declarations: []}));
        const empty   = buildFamilyProjection(source({memberships: [], declarations: []}));
        expect(missing.valid).toBe(true);
        expect(familyAt(missing, 50)).toEqual({state: 'membership-unknown', family: null});
        expect(familyAt(empty, 50)).toEqual({state: 'empty-membership', family: null});
    });

    test('every active binding counts before confirmation and through pending retirement', () => {
        const input = source({memberships: [member(), member('B', 20)],
            declarations: [declaration(), declaration('b', 'B', 30, 'claude', 3, 'operator-b')]});
        const pending = buildFamilyProjection(input);
        expect(familyAt(pending, 19)).toEqual(classified('gpt'));
        expect(familyAt(pending, 20)).toEqual({state: 'unconfirmed-seat', family: null});
        expect(familyAt(pending, 30)).toEqual({state: 'ambiguous-seats', family: null});
        expect(familyAt(pending, 100)).toEqual({state: 'ambiguous-seats', family: null});
        input.memberships[1].until = 40;
        const retired = buildFamilyProjection(input);
        expect(familyAt(retired, 39)).toEqual({state: 'ambiguous-seats', family: null});
        expect(familyAt(retired, 40)).toEqual(classified('gpt'));
        expect(familiesDuring(retired, 35, 45)).toEqual({state: 'ambiguous-seats', families: []});
    });

    test('different operators and different models can agree on exactly one family', () => {
        const projection = buildFamilyProjection(source({memberships: [member(), member('B')],
            declarations: [declaration('a', 'A', 10, 'gpt', 2, 'operator-a', 'model-a'),
                declaration('b', 'B', 10, 'gpt', 3, 'operator-b', null)]}));
        expect(familyAt(projection, 10)).toEqual(classified('gpt'));
        expect(projection.intervals[0].members.map(value => value.model)).toEqual(['model-a', null]);
        expect(projection.intervals[0]).not.toHaveProperty('model');
    });

    test('the same operator declaring different families does not collapse disagreement', () => {
        const projection = buildFamilyProjection(source({memberships: [member(), member('B')],
            declarations: [declaration(), declaration('b', 'B', 10, 'claude', 3)]}));
        expect(familyAt(projection, 10).state).toBe('ambiguous-seats');
    });

    test('author union includes intermediate return swaps and both inclusive query endpoints', () => {
        const projection = buildFamilyProjection(swaps());
        expect(familyAt(projection, 19)).toEqual(classified('gpt'));
        expect(familyAt(projection, 20)).toEqual(classified('claude'));
        expect(familyAt(projection, 30)).toEqual(classified('gpt'));
        expect(familiesDuring(projection, 15, 35)).toEqual({state: 'classified', families: ['claude', 'gpt']});
        expect(familiesDuring(projection, 15, 20).families).toEqual(['claude', 'gpt']);
        expect(familiesDuring(projection, 20, 20).families).toEqual(['claude']);
        expect(familiesDuring(projection, 30, 35).families).toEqual(['gpt']);
    });

    test('latest correction repairs only its exact target, regardless of array order', () => {
        const input = swaps();
        input.corrections = [correction('fix-new', 'a', 'kimi', 9), correction('fix-old', 'a', 'gemini', 7)];
        const projection = buildFamilyProjection(input);
        expect(familyAt(projection, 15)).toEqual(classified('kimi'));
        expect(familyAt(projection, 25)).toEqual(classified('claude'));
        expect(familyAt(projection, 35)).toEqual(classified('gpt'));
        expect(familiesDuring(projection, 10, 35).families).toEqual(['claude', 'gpt', 'kimi']);
        expect(projection.revision).toBe(10);
    });

    test('a correction changes neither another binding nor the current head', () => {
        const input = swaps();
        input.memberships.push(member('B'));
        input.declarations.push(declaration('other', 'B', 10, 'gpt', 5));
        const before = buildFamilyProjection(input);
        input.revision = 11;
        input.corrections.push(correction('fix', 'a', 'gemini', 11));
        const after = buildFamilyProjection(input);
        expect(familyAt(before, 15)).toEqual(classified('gpt'));
        expect(familyAt(after, 15).state).toBe('ambiguous-seats');
        expect(after.intervals.at(-1)).toEqual(before.intervals.at(-1));
        expect(after.intervals.length).toBe(before.intervals.length);
        expect(after.revision).not.toBe(before.revision);
    });

    test('a correction can explicitly withdraw model evidence without inheriting the old model', () => {
        const input = source({declarations: [declaration('a', 'A', 10, 'gpt', 2, 'operator-a', 'old-model')],
            corrections: [correction('fix', 'a', 'gpt', 3, 'operator-a', null)]});
        const projection = buildFamilyProjection(input);
        expect(familyAt(projection, 10)).toEqual(classified('gpt'));
        expect(projection.intervals[0].members[0].model).toBeNull();
        expect(input.declarations[0].model).toBe('old-model');
    });

    test('transfer permits forward declaration but not correction by the new principal', () => {
        const input = source({declarations: [declaration(), declaration('b', 'A', 20, 'claude', 3, 'operator-b')]});
        expect(familyAt(buildFamilyProjection(input), 20)).toEqual(classified('claude'));
        input.corrections.push(correction('bad', 'a', 'claude', 4, 'operator-b'));
        expect(buildFamilyProjection(input).valid).toBe(false);
    });

    test('remove and recreate needs fresh confirmation; its old declaration stays historical', () => {
        const projection = buildFamilyProjection(source({memberships: [member('A', 10, 20), member('B', 20)]}));
        expect(familyAt(projection, 19)).toEqual(classified('gpt'));
        expect(familyAt(projection, 20)).toEqual({state: 'unconfirmed-seat', family: null});
        expect(projection.intervals[1].members).toEqual([{bindingId: 'B', admissionId: null, family: null, model: null}]);
    });

    test('an empty gap blocks the whole author window even with equal endpoint families', () => {
        const projection = buildFamilyProjection(source({memberships: [member('A', 10, 20), member('B', 30)],
            declarations: [declaration(), declaration('b', 'B', 30, 'gpt', 3)]}));
        expect(familyAt(projection, 15)).toEqual(classified('gpt'));
        expect(familyAt(projection, 35)).toEqual(classified('gpt'));
        expect(familiesDuring(projection, 15, 35)).toEqual({state: 'empty-membership', families: []});
    });

    for (const family of ['unknown', '__proto__', 'constructor', 'hasOwnProperty', ' GPT ', 'x'.repeat(254)]) {
        test('preserves exact family vocabulary: ' + family, () => {
            const projection = buildFamilyProjection(source({declarations: [declaration('a', 'A', 10, family)]}));
            expect(familyAt(projection, 10)).toEqual(classified(family));
            expect(familiesDuring(projection, 10, 50).families).toEqual([family]);
        });
    }

    test('rebuilding is deterministic, detached and deeply immutable', () => {
        const input = swaps(), before = structuredClone(input);
        const first = buildFamilyProjection(input);
        expect(buildFamilyProjection(structuredClone(input))).toEqual(first);
        expect(input).toEqual(before);
        expect(Object.isFrozen(input)).toBe(false);
        expect(Object.isFrozen(first.intervals[0].members[0])).toBe(true);
        input.declarations[0].family = 'changed';
        expect(familyAt(first, 10)).toEqual(classified('gpt'));
        expect(() => { first.intervals[0].members[0].family = 'changed'; }).toThrow();
    });

    const invalid = {
        'control character in family'   : input => { input.declarations[0].family = 'gpt\n'; },
        'oversized encoded family'      : input => { input.declarations[0].family = 'x'.repeat(255); },
        'escaped family above cap'      : input => { input.declarations[0].family = '"'.repeat(128); },
        'ill-formed family'             : input => { input.declarations[0].family = '\ud800'; },
        'control character in principal': input => { input.declarations[0].operatorPrincipal = 'operator\n-a'; },
        'oversized model'               : input => { input.declarations[0].model = 'x'.repeat(511); },
        'missing declarations'          : input => { delete input.declarations; },
        'missing corrections'           : input => { delete input.corrections; },
        'missing baseline'              : input => { input.baselineSince = null; },
        'duplicate incarnation'         : input => { input.memberships.push(member()); },
        'reversed lifetime'             : input => { input.memberships[0].until = 9; },
        'declaration before binding'    : input => { input.declarations[0].since = 9; },
        'declaration at retirement'     : input => { input.memberships[0].until = 20; input.declarations[0].since = 20; },
        'foreign binding'               : input => { input.declarations[0].bindingId = 'missing'; },
        'duplicate declaration id'      : input => { input.declarations.push({...input.declarations[0], since: 20, revision: 3}); },
        'same-time forward declaration' : input => { input.declarations.push(declaration('b', 'A', 10, 'claude', 3)); },
        'backward revision'             : input => { input.declarations.push(declaration('b', 'A', 20, 'claude', 1)); },
        'missing model'                 : input => { delete input.declarations[0].model; },
        'unknown family as null'        : input => { input.declarations[0].family = null; },
        'orphan correction'             : input => { input.corrections.push(correction('fix', 'missing', 'claude', 3)); },
        'correction before declaration' : input => { input.corrections.push(correction('fix', 'a', 'claude', 1)); },
        'correction above snapshot'     : input => { input.corrections.push(correction('fix', 'a', 'claude', 11)); },
        'duplicate correction revision' : input => { input.corrections.push(correction('fix1', 'a', 'claude', 3), correction('fix2', 'a', 'gpt', 3)); },
        'correction targets correction' : input => { input.corrections.push(correction('fix1', 'a', 'claude', 3), correction('fix2', 'fix1', 'gpt', 4)); },
        'sparse membership'             : input => { input.memberships.length = 2; },
        'negative-zero boundary'        : input => { input.baselineSince = -0; }
    };
    for (const [name, mutate] of Object.entries(invalid)) {
        test('refuses malformed history: ' + name, () => {
            const input = source();
            mutate(input);
            const projection = buildFamilyProjection(input);
            expect(projection.valid).toBe(false);
            expect(projection.state).toBe('unavailable');
            expect(familyAt(projection, 20)).toEqual({state: 'unavailable', family: null});
            expect(familiesDuring(projection, 10, 30)).toEqual({state: 'unavailable', families: []});
        });
    }

    test('refuses accessor input without executing it', () => {
        const input = source();
        let   calls = 0;
        Object.defineProperty(input.declarations[0], 'family', {enumerable: true, get() { calls++; return 'gpt'; }});
        expect(buildFamilyProjection(input).valid).toBe(false);
        expect(calls).toBe(0);
    });

    test('invalid query windows cannot produce a partial positive result', () => {
        const projection = buildFamilyProjection(source());
        for (const [since, until] of [[30, 10], [NaN, 30], [10, Infinity], [-0, 30], ['10', 30]]) {
            expect(familiesDuring(projection, since, until)).toEqual({state: 'unavailable', families: []});
        }
        expect(familyAt(projection, -1)).toEqual({state: 'unavailable', family: null});
    });
});
