import {test, expect} from '@playwright/test';
import {compileFoundingFamilySeed} from '../../../../../ai/graph/identityFoundingSeed.mjs';
import {FOUNDING_FAMILY_SUBJECTS, IDENTITIES} from '../../../../../ai/graph/identityRoots.mjs';
import {isIdentityPublicationSubject} from '../../../../../ai/services/shared/identityPublicationOperation.mjs';

const identity = (id = '@agent-a', family = 'gpt') =>
    ({id, type: 'AgentIdentity', properties: {accountType: 'agent', modelFamily: family}});
const subject = (providerUserId = '101') =>
    ({authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId});
const input = () => ({identities: [identity()], subjects: [{identityKey: '@agent-a', subject: subject()}]});

test.describe('founding-family seed input', () => {
    test('binds every checked-in agent without copying provider authority onto ordinary boot nodes', () => {
        const result = compileFoundingFamilySeed({identities: IDENTITIES, subjects: FOUNDING_FAMILY_SUBJECTS});
        const agents = IDENTITIES.filter(row => row.type === 'AgentIdentity' && row.properties.accountType === 'agent');
        expect(result.entries.map(row => row.identityKey)).toEqual(agents.map(row => row.id).sort());
        expect(result.entries.every(row => isIdentityPublicationSubject(row.subject))).toBe(true);
        expect(result.entries.find(row => row.identityKey === '@neo-preview').family).toBe('unknown');
        expect(IDENTITIES.every(row => !Object.hasOwn(row.properties, 'providerSubject'))).toBe(true);
        expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    test('keeps all agreeing and conflicting entries that share one stable subject', () => {
        const value = input();
        value.identities.push(identity('@agent-b'), identity('@agent-c', 'claude'));
        value.subjects.push({identityKey: '@agent-b', subject: subject()}, {identityKey: '@agent-c', subject: subject()});
        const result = compileFoundingFamilySeed(value);
        expect(result.entries.map(row => row.family)).toEqual(['gpt', 'gpt', 'claude']);
        expect(result.entries.every(row => row.subject.providerUserId === '101')).toBe(true);
    });

    test('source order and unrelated social metadata do not alter the family digest', () => {
        const first = input();
        first.identities.push(identity('@agent-b', 'claude'));
        first.subjects.push({identityKey: '@agent-b', subject: subject('102')});
        const second = structuredClone(first);
        second.identities.reverse();
        second.subjects.reverse();
        second.identities[0].name = 'A new display name';
        second.identities[0].properties.formerLogins = ['@a-reusable-login'];
        expect(compileFoundingFamilySeed(second)).toEqual(compileFoundingFamilySeed(first));
    });

    for (const [field, value] of [['authProvider', 'gitlab'], ['providerBaseUrl', 'https://other.example/api'],
        ['providerUserId', '102']]) {
        test('binds the digest to ' + field, () => {
            const first = input(), second = input();
            second.subjects[0].subject[field] = value;
            expect(compileFoundingFamilySeed(second).digest).not.toBe(compileFoundingFamilySeed(first).digest);
        });
    }

    test('binds exact family spelling and entry provenance into the same digest', () => {
        const first = input(), differentFamily = input(), differentEntry = input();
        differentFamily.identities[0].properties.modelFamily = ' GPT ';
        differentEntry.identities[0].id = '@renamed-entry';
        differentEntry.subjects[0].identityKey = '@renamed-entry';
        const original = compileFoundingFamilySeed(first).digest;
        expect(compileFoundingFamilySeed(differentFamily).digest).not.toBe(original);
        expect(compileFoundingFamilySeed(differentEntry).digest).not.toBe(original);
    });

    test('never resolves a current or former login when the literal stable ID is missing', () => {
        const value = input();
        value.identities[0].properties.githubLogin = '@agent-a';
        value.identities[0].properties.formerLogins = ['@former-a'];
        delete value.subjects[0].subject.providerUserId;
        expect(() => compileFoundingFamilySeed(value)).toThrow(/stable subject/);
    });

    test('changing only the provider ID never inherits the old tuple', () => {
        const value = input();
        const old = compileFoundingFamilySeed(value);
        value.subjects[0].subject.providerUserId = '202';
        const current = compileFoundingFamilySeed(value);
        expect(current.entries[0].identityKey).toBe(old.entries[0].identityKey);
        expect(current.entries[0].subject.providerUserId).toBe('202');
        expect(current.digest).not.toBe(old.digest);
        expect(old.entries[0].subject.providerUserId).toBe('101');
    });

    test('detaches and deeply freezes output without freezing caller-owned input', () => {
        const value = input(), result = compileFoundingFamilySeed(value);
        expect(Object.isFrozen(value.subjects[0].subject)).toBe(false);
        value.subjects[0].subject.providerUserId = 'changed';
        value.identities[0].properties.modelFamily = 'claude';
        expect(result.entries[0]).toEqual({identityKey: '@agent-a', family: 'gpt', subject: subject()});
        expect(() => { result.entries[0].subject.providerUserId = 'changed'; }).toThrow();
        expect(() => { result.entries.push({}); }).toThrow();
        expect(Object.isFrozen(result)).toBe(true);
    });

    test('an explicitly empty agent roster is valid, and humans do not acquire a family', () => {
        const human = {id: '@owner', type: 'AgentIdentity', properties: {accountType: 'human', modelFamily: null}};
        expect(compileFoundingFamilySeed({identities: [human], subjects: []}).entries).toEqual([]);
        expect(() => compileFoundingFamilySeed({identities: [human], subjects: [{identityKey: '@owner', subject: subject()}]}))
            .toThrow(/unmapped agent/);
    });

    for (const [field, value] of [['accountType', undefined], ['type', undefined], ['type', 'System'],
        ['accountType', 'agnt']]) {
        test('refuses a malformed roster discriminator even without a mapping: ' + field + '=' + value, () => {
            const entry = identity(), target = field === 'type' ? entry : entry.properties;
            if (value === undefined) delete target[field];
            else target[field] = value;
            expect(() => compileFoundingFamilySeed({identities: [entry], subjects: []})).toThrow();
        });
    }

    const invalid = {
        'missing mapping'         : value => { value.subjects = []; },
        'duplicate mapping'       : value => { value.subjects.push(structuredClone(value.subjects[0])); },
        'unknown mapping'         : value => { value.subjects[0].identityKey = '@unknown'; },
        'duplicate roster entry'  : value => { value.identities.push(identity()); },
        'null family'             : value => { value.identities[0].properties.modelFamily = null; },
        'missing family'          : value => { delete value.identities[0].properties.modelFamily; },
        'numeric provider ID'     : value => { value.subjects[0].subject.providerUserId = 101; },
        'mutable username'        : value => { value.subjects[0].subject.providerUsername = 'agent-a'; },
        'extra mapping field'     : value => { value.subjects[0].family = 'claude'; },
        'oversized provider base' : value => { value.subjects[0].subject.providerBaseUrl = 'x'.repeat(2047); },
        'sparse mappings'         : value => { value.subjects.length = 2; },
        'inherited provider ID'   : value => { value.subjects[0].subject = Object.create(subject()); }
    };
    for (const [name, mutate] of Object.entries(invalid)) {
        test('refuses the complete seed: ' + name, () => {
            const value = input();
            mutate(value);
            expect(() => compileFoundingFamilySeed(value)).toThrow();
        });
    }

    test('refuses an accessor before executing it', () => {
        const value = input();
        let calls = 0;
        Object.defineProperty(value.subjects[0].subject, 'providerUserId', {enumerable: true,
            get() { calls++; return '101'; }});
        expect(() => compileFoundingFamilySeed(value)).toThrow();
        expect(calls).toBe(0);
        expect(isIdentityPublicationSubject(value.subjects[0].subject)).toBe(false);
        expect(calls).toBe(0);
    });
});
