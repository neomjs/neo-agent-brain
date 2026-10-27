import {test, expect}                                    from '@playwright/test';
import {buildFamilyProjection, buildSubjectFamilyProjection, familyAt, familiesDuring}
    from '../../../../../ai/graph/identityFamilyProjection.mjs';
import {compileFoundingFamilySeed} from '../../../../../ai/graph/identityFoundingSeed.mjs';

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

test.describe('provider-bound founding and admitted family composition', () => {
    const subject = () => ({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '101'});
    const founding = (families = ['gpt'], providerSubject = subject()) => compileFoundingFamilySeed({
        identities: families.map((family, index) => ({id: '@founder-' + index, type: 'AgentIdentity',
            properties: {accountType: 'agent', modelFamily: family}})),
        subjects: families.map((_, index) => ({identityKey: '@founder-' + index, subject: providerSubject}))
    });
    const compose = (history = source(), seed = founding(), target = subject()) =>
        buildSubjectFamilyProjection({subject: target, source: history, founding: seed});

    test('baseline and matching declarations preserve founding with unchanged membership evidence', () => {
        const history = source({memberships: [member(), member('B')], declarations: [declaration('a', 'A', 20)]});
        const result = compose(history);
        expect(result.valid).toBe(true);
        for (const at of [0, 9, 10, 19, 20, 100]) expect(familyAt(result, at)).toEqual(classified('gpt'));
        expect(result.founding.cutoff).toBeNull();
        expect(result.membership).toEqual(buildFamilyProjection(history));
        expect(familyAt(result.membership, 10).state).toBe('unconfirmed-seat');
        expect(result.membership.intervals.at(-1).members).toHaveLength(2);
        expect(familiesDuring(result, 0, 100)).toEqual({state: 'classified', families: ['gpt']});
    });

    test('an explicit pre-baseline source is distinct from an unavailable source', () => {
        const result = compose(source({baselineSince: null, revision: 0, memberships: [], declarations: []}));
        expect(familyAt(result, 0)).toEqual(classified('gpt'));
        expect(familyAt(result.membership, 0).state).toBe('membership-unknown');
        expect(compose(null).valid).toBe(false);
        expect(compose(source(), null).valid).toBe(false);
    });

    test('different declaration cuts while the aggregate is unconfirmed, not only when classified', () => {
        const result = compose(source({memberships: [member(), member('B')],
            declarations: [declaration('a', 'A', 30, 'claude')]}));
        expect(result.founding.cutoff).toBe(30);
        expect(familyAt(result, 29)).toEqual(classified('gpt'));
        expect(familyAt(result, 30)).toEqual({state: 'unconfirmed-seat', family: null});
        expect(familiesDuring(result, 0, 30)).toEqual({state: 'unconfirmed-seat', families: []});
    });

    test('retirement, an empty gap and a later matching declaration cannot resurrect founding', () => {
        const result = compose(source({memberships: [member('A', 10, 30), member('B', 40)],
            declarations: [declaration('a', 'A', 20, 'claude'), declaration('b', 'B', 50, 'gpt', 3)]}));
        expect(result.founding.cutoff).toBe(20);
        expect(familyAt(result, 20)).toEqual(classified('claude'));
        expect(familyAt(result, 35).state).toBe('empty-membership');
        expect(familyAt(result, 45).state).toBe('unconfirmed-seat');
        expect(familyAt(result, 50)).toEqual(classified('gpt'));
        expect(result.intervals.at(-1).origin).toBe('admitted');
        expect(familiesDuring(result, 10, 60)).toEqual({state: 'empty-membership', families: []});
    });

    test('correcting a matching declaration to different moves cutoff to original admission', () => {
        const history = source({declarations: [declaration('a', 'A', 20)],
            corrections: [correction('fix', 'a', 'claude', 9)]});
        const result = compose(history);
        expect(result.founding.cutoff).toBe(20);
        expect(familyAt(result, 19)).toEqual(classified('gpt'));
        expect(familyAt(result, 20)).toEqual(classified('claude'));
        expect(result.intervals.map(row => row.since)).toEqual([0, 10, 20]);
    });

    test('correcting the only differing declaration back removes cutoff despite an unconfirmed seat', () => {
        const history = source({memberships: [member(), member('B')],
            declarations: [declaration('a', 'A', 20, 'claude')]});
        expect(familyAt(compose(history), 20).state).toBe('unconfirmed-seat');
        history.corrections = [correction('fix', 'a', 'gpt', 9)];
        const result = compose(history);
        expect(result.founding.cutoff).toBeNull();
        expect(familyAt(result, 100)).toEqual(classified('gpt'));
        expect(familyAt(result.membership, 100).state).toBe('unconfirmed-seat');
    });

    test('correcting the first differing declaration preserves the later differing cutoff', () => {
        const history = source({declarations: [declaration('a', 'A', 20, 'claude'),
            declaration('b', 'A', 60, 'gemini', 3)], corrections: [correction('fix', 'a', 'gpt', 9)]});
        const result = compose(history);
        expect(result.founding.cutoff).toBe(60);
        expect(familyAt(result, 59)).toEqual(classified('gpt'));
        expect(familyAt(result, 60)).toEqual(classified('gemini'));
        expect(result.intervals.map(row => row.since)).toEqual([0, 10, 20, 60]);
    });

    test('latest correction wins regardless of array order, and model-only corrections do not cut', () => {
        const history = source({declarations: [declaration('a', 'A', 20)],
            corrections: [correction('new', 'a', 'gpt', 9, 'operator-a', 'new-model'),
                correction('old', 'a', 'claude', 7)]});
        const result = compose(history);
        expect(result.founding.cutoff).toBeNull();
        expect(result.membership.intervals.at(-1).members[0].model).toBe('new-model');
        history.corrections.reverse();
        expect(compose(history)).toEqual(result);
    });

    test('author unions include the cutoff endpoint and intermediate return swaps', () => {
        const result = compose(swaps());
        expect(familiesDuring(result, 19, 20)).toEqual({state: 'classified', families: ['claude', 'gpt']});
        expect(familiesDuring(result, 20, 20)).toEqual({state: 'classified', families: ['claude']});
        expect(familiesDuring(result, 0, 40)).toEqual({state: 'classified', families: ['claude', 'gpt']});
        expect(familyAt(result, 30)).toEqual(classified('gpt'));
        expect(result.founding.cutoff).toBe(20);
    });

    test('all agreeing founders count, while conflicting founders stay ambiguous even after C7', () => {
        const agrees = compose(source(), founding(['gpt', 'gpt']));
        expect(agrees.founding.identityKeys).toHaveLength(2);
        expect(familyAt(agrees, 0)).toEqual(classified('gpt'));
        const conflict = compose(source(), founding(['gpt', 'claude']));
        expect(conflict.founding.families).toEqual(['claude', 'gpt']);
        for (const at of [0, 20, 100]) expect(familyAt(conflict, at).state).toBe('ambiguous-founders');
        expect(familyAt(conflict.membership, 20)).toEqual(classified('gpt'));
        expect(familiesDuring(conflict, 0, 100)).toEqual({state: 'ambiguous-founders', families: []});
    });

    test('missing founding entries preserve C8 rather than classifying an unconfirmed account', () => {
        const history = source({declarations: []}), result = compose(history, founding([]));
        expect(result.founding.identityKeys).toEqual([]);
        for (const at of [0, 10, 100]) expect(familyAt(result, at)).toEqual(familyAt(result.membership, at));
    });

    for (const [key, value] of [['authProvider', 'gitlab'], ['providerBaseUrl', 'https://other.example'], ['providerUserId', '202']]) {
        test('does not inherit founding when only ' + key + ' changes', () => {
            const target = {...subject(), [key]: value};
            const result = compose(source({declarations: []}), founding(), target);
            expect(result.founding.identityKeys).toEqual([]);
            expect(familyAt(result, 10).state).toBe('unconfirmed-seat');
        });
    }

    test('literal unknown and prototype-looking family names remain exact classified families', () => {
        for (const family of ['unknown', '__proto__', 'constructor']) {
            const result = compose(source({declarations: []}), founding([family]));
            expect(familyAt(result, 10)).toEqual(classified(family));
        }
    });

    test('a malformed unrelated founder, bad digest or malformed history invalidates the whole view', () => {
        const broken = structuredClone(founding(['gpt', 'gpt']));
        broken.entries[1].subject.providerUserId = 'unrelated';
        broken.entries[1].family = null;
        const badHistory = source();
        delete badHistory.corrections;
        for (const result of [compose(source(), broken), compose(source(), {...founding(), digest: 'bad'}), compose(badHistory)]) {
            expect(result.valid).toBe(false);
            expect(familyAt(result, 10)).toEqual({state: 'unavailable', family: null});
            expect(familiesDuring(result, 0, 100)).toEqual({state: 'unavailable', families: []});
        }
    });

    test('detaches both source revisions and refuses decorated/accessor-bearing options', () => {
        const history = source(), seed = structuredClone(founding()), target = subject();
        const options = {subject: target, source: history, founding: seed};
        const result = buildSubjectFamilyProjection(options);
        expect(result.revision).toBe(history.revision);
        expect(result.founding.digest).toBe(seed.digest);
        expect(Object.isFrozen(result.membership.intervals[0].members[0])).toBe(true);
        target.providerUserId = '202'; seed.entries[0].family = 'changed'; history.declarations[0].family = 'changed';
        expect(result.subject.providerUserId).toBe('101');
        expect(familyAt(result, 10)).toEqual(classified('gpt'));
        expect(buildSubjectFamilyProjection({...options, currentSeatId: '@founder-0'}).valid).toBe(false);
        let calls = 0;
        expect(buildSubjectFamilyProjection({get subject() { calls++; return subject(); },
            source: source(), founding: founding()}).valid).toBe(false);
        expect(calls).toBe(0);
    });
});
