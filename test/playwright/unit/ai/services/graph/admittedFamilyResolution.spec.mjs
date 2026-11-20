import {expect, test} from '@playwright/test';
import {spawnSync}    from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createAdmittedFamilyResolver, normalizeFamilyActor, parseBoundSelfIdKey}
    from '../../../../../../ai/services/graph/admittedFamilyResolution.mjs';
import {compileFoundingFamilySeed} from '../../../../../../ai/graph/identityFoundingSeed.mjs';
import {familyMembershipKey}       from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';

const API     = 'https://api.github.com', TARGET = {planeId: 'resolver-fixture', dataRoot: '/fixture/resolver'};
const subject = (id, base = API, provider = 'github') => ({authProvider: provider, providerBaseUrl: base, providerUserId: String(id)});
const actor   = (id, login = 'actor-' + id) => ({__typename: 'User', databaseId: id, login});
const review  = (id, at, state = 'APPROVED') => ({author: actor(id), submittedAt: new Date(at).toISOString(), state});
const pr      = (overrides = {}) => ({author: actor(1), createdAt: new Date(10).toISOString(), authorAssociation: 'MEMBER',
    reviews: [review(2, 35)], ...overrides});

/** @summary Builds detached registered-snapshot shapes using the existing seed compiler and membership keys. */
function observation(rows = [], founders = []) {
    const founding = compileFoundingFamilySeed({
        identities: founders.map(([identityKey, family]) => ({id: identityKey, type: 'AgentIdentity', properties: {accountType: 'agent', modelFamily: family}})),
        subjects  : founders.map(([identityKey, family, id, base = API]) => ({identityKey, subject: subject(id, base)}))
    });
    const inputs = [...rows];
    for (const entry of founding.entries) {
        if (!inputs.some(row => JSON.stringify(subject(row.id, row.base, row.provider)) === JSON.stringify(entry.subject))) {
            inputs.push({id: entry.subject.providerUserId, base: entry.subject.providerBaseUrl, provider: entry.subject.authProvider, foundingOnly: true});
        }
    }
    let   revision = 1;
    const subjects = inputs.map(({id, families = [], corrections = [], foundingOnly = false, base = API, provider = 'github'}) => {
        const stable = subject(id, base, provider), binding = {subject: {...stable, providerUsername: 'login-' + id},
            seatId: 'seat-' + id, incarnation: 'incarnation-' + id};
        const bindingId    = familyMembershipKey({planeId: TARGET.planeId, ...binding});
        const declarations = families.map(([since, family], index) => ({admissionId: 'admission-' + id + '-' + index,
            bindingId, operatorPrincipal: 'operator', since, revision: ++revision, family, model: null}));
        const corrected = corrections.map(([index, family], order) => ({admissionId: 'correction-' + id + '-' + order,
            targetAdmissionId: declarations[index].admissionId, operatorPrincipal: 'operator', revision: ++revision, family, model: null}));
        return {subject: stable, membershipRevision: foundingOnly ? 0 : 1, admissionRevision: declarations.length + corrected.length,
            bindings: foundingOnly ? [] : [{bindingId, binding, currentSeatId: binding.seatId}],
            source  : {baselineSince: 10, revision: 0,
                memberships: foundingOnly ? [] : [{bindingId, since: 10, until: null}], declarations, corrections: corrected}};
    });
    for (const entry of subjects) entry.source.revision = revision;
    return {state: 'available', snapshot: {version: 1, target: TARGET, revision, baselineSince: 10, founding, foundingRevision: 1,
        foundingProvenance: {sourceRevision: 'reviewed-fixture', installedAt: 1, issuer: 'fixture-fleet', lineageHead: 'identity-family-lineage-head-' + 'a'.repeat(64)},
        counts            : {subjects: subjects.length, admittedSubjects: subjects.filter(row => row.membershipRevision > 0).length,
            memberships : subjects.reduce((n, row) => n + row.bindings.length, 0),
            declarations: subjects.reduce((n, row) => n + row.source.declarations.length, 0),
            corrections : subjects.reduce((n, row) => n + row.source.corrections.length, 0)}, subjects}};
}

const resolve = (source, extra = {}) => createAdmittedFamilyResolver({source, providerBaseUrl: API, observedAt: 40, ...extra});

test('normalizes exact decimal User IDs without treating login, node ID, or another Actor kind as identity', () => {
    for (const id of [42, '42', '9007199254740993']) expect(normalizeFamilyActor(actor(id)).databaseId).toBe(String(id));
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '0', '01', ' 42', '42 ', '1e3', 'U_42']) {
        expect(normalizeFamilyActor(actor(id)).databaseId, String(id)).toBeNull();
    }
    expect(normalizeFamilyActor({...actor(42), __typename: 'Bot'})).toEqual({login: 'actor-42', __typename: 'Bot', databaseId: null});
    expect(normalizeFamilyActor({login: 'actor-42', id: 42}).databaseId).toBeNull();
    expect(normalizeFamilyActor(normalizeFamilyActor(actor(42)))).toEqual(normalizeFamilyActor(actor(42)));
});

test('only an anchored literal self-id is parsed, never a social name, email, mid-line mention or ambiguous keys', () => {
    expect(parseBoundSelfIdKey('Notes\nAuthored by Person @one.name (Model).')).toBe('@one.name');
    expect(parseBoundSelfIdKey('Authored by @one_name (Model).')).toBe('@one_name');
    for (const body of ['Authored by Sophie (GPT).', 'A note: Authored by @one (GPT)', 'Co-Authored by @one',
        'Authored by person@example.com', 'Authored by @one and @two', 'Authored by @one\nAuthored by @two']) {
        expect(parseBoundSelfIdKey(body), body).toBeNull();
    }
});

test('historical review families use submittedAt, including groups spanning a later switch', () => {
    const source   = observation([{id: 1, families: [[10, 'gpt'], [20, 'claude']]}]);
    const resolver = resolve(source), first = review(1, 15), second = review(1, 25);
    expect(resolver.classifyReviewer(first)).toMatchObject({classified: true, family: 'gpt', login: 'actor-1', state: 'classified'});
    expect(resolver.classifyReviewer(second).family).toBe('claude');
    expect(resolver.classifyActor(actor(1), 40).family).toBe('claude');
    expect(resolver.groupReviews([first, second])).toMatchObject({byFamily: {gpt: 1, claude: 1}, unclassified: []});
});

test('full author interval includes a return swap instead of comparing only the endpoints', () => {
    const source = observation([{id: 1, families: [[10, 'gpt'], [20, 'claude'], [30, 'gpt']]},
        {id: 2, families: [[10, 'claude']]}, {id: 3, families: [[10, 'gemini']]}]);
    const resolver = resolve(source);
    expect(resolver.resolveVerdict(pr())).toMatchObject({sourceState: 'available', qualified: true,
        authorFamilies: ['claude', 'gpt'], approvingFamilies: ['claude'], crossFamily: false,
        revision      : source.snapshot.revision, foundingRevision: 1, foundingDigest: source.snapshot.founding.digest});
    expect(resolver.resolveVerdict(pr({reviews: [review(3, 35)]})).crossFamily).toBe(true);
});

test('bound distinct self-id and opener contribute both complete family intervals', () => {
    const resolver = resolve(observation([{id: 2, families: [[10, 'claude']]}, {id: 3, families: [[10, 'gemini']]}],
        [['@selected', 'gpt', 1]]));
    const input = pr({author: actor(2), body: 'Authored by @selected (GPT).', reviews: [review(2, 35)]});
    expect(resolver.resolveVerdict(input)).toMatchObject({authorFamilies: ['claude', 'gpt'], crossFamily: false});
    expect(resolver.resolveVerdict({...input, body: '', selfIdIdentityKey: '@selected', reviews: [review(3, 35)]}).crossFamily).toBe(true);
    expect(resolver.resolveVerdict({...input, body: 'Authored by Sophie (GPT).', reviews: [review(1, 35)]}))
        .toMatchObject({authorFamilies: ['claude'], crossFamily: true});
    expect(resolver.resolveVerdict({...input, body: '', selfIdIdentityKey: '@unbound', reviews: [review(1, 35)]}).authorFamilies).toEqual(['claude']);
});

test('currentSeatId and caller-provided authorFamily cannot bind a self-id or override admitted history', () => {
    const source = observation([{id: 1, families: [[10, 'gpt']]}, {id: 2, families: [[10, 'claude']]}]);
    source.snapshot.subjects[1].bindings[0].currentSeatId = '@selected';
    expect(resolve(source).resolveVerdict(pr({selfIdIdentityKey: '@selected', authorFamily: 'claude'})))
        .toMatchObject({authorFamilies: ['gpt'], crossFamily: true});
});

test('an unclassified author subinterval refuses even when the current family and an approver are known', () => {
    const resolver = resolve(observation([{id: 1, families: [[20, 'gpt']]}, {id: 2, families: [[10, 'claude']]}]));
    expect(resolver.resolveVerdict(pr())).toMatchObject({sourceState: 'available', qualified: false, crossFamily: null,
        authorFamilies: [], code: 'author-family-unclassified'});
    expect(resolver.resolveVerdict(pr({authorAssociation: 'CONTRIBUTOR', body: 'AI assistance: GPT'})).qualified).toBe(false);
});

test('stable provider identity survives login changes but not another subject, API base or Actor kind', () => {
    const source = observation([{id: 1, families: [[10, 'gpt']]}]);
    expect(resolve(source).classifyActor(actor(1, 'renamed'), 15)).toMatchObject({classified: true, family: 'gpt'});
    expect(resolve(source).classifyActor(actor(2, 'actor-1'), 15).classified).toBe(false);
    expect(resolve(source, {providerBaseUrl: 'https://forge.example/api/v3'}).classifyActor(actor(1), 15).classified).toBe(false);
    expect(resolve(source).classifyActor({...actor(1), __typename: 'Bot'}, 15).classified).toBe(false);
    expect(resolve(observation([{id: 1, provider: 'gitlab', families: [[10, 'gpt']]}])).classifyActor(actor(1), 15).classified).toBe(false);
});

test('source unavailability never becomes an outside/no-disclosure positive', () => {
    const unavailable = resolve({state: 'unavailable', code: 'publication-restore-fenced', snapshot: observation().snapshot});
    expect(unavailable.resolveVerdict(pr({authorAssociation: 'CONTRIBUTOR', reviews: [review(2, 30)]})))
        .toMatchObject({sourceState: 'unavailable', qualified: false, crossFamily: null, code: 'publication-restore-fenced'});
});

test('malformed unrelated history, a mixed revision, and a missing founding subject refuse the whole observation', () => {
    const first     = observation([{id: 1, families: [[10, 'gpt']]}, {id: 2, families: [[10, 'claude']]}]);
    const malformed = structuredClone(first); malformed.snapshot.subjects[1].source.declarations[0].revision = 0;
    const mixed     = structuredClone(first); mixed.snapshot.subjects[1].source.revision++;
    const omitted   = observation([], [['@founder', 'gpt', 1]]); omitted.snapshot.subjects = []; omitted.snapshot.counts.subjects = 0;
    for (const source of [malformed, mixed, omitted]) {
        expect(resolve(source).classifyActor(actor(1), 15)).toMatchObject({sourceState: 'unavailable', classified: false, code: 'family-snapshot-invalid'});
    }
});

test('outside disclosure unions all named families and preserves asymmetric truncation', () => {
    const resolver = resolve(observation([{id: 1, families: [[10, 'gpt']]}, {id: 2, families: [[10, 'claude']]},
        {id: 3, families: [[10, 'gemini']]}]));
    const input = pr({author: actor(99), authorAssociation: 'CONTRIBUTOR', body: 'AI assistance: Claude and GPT', reviews: [review(2, 35)]});
    expect(resolver.resolveVerdict(input)).toMatchObject({outside: true, authorFamilies: ['claude', 'gpt'], crossFamily: false});
    expect(resolver.resolveVerdict({...input, reviews: [review(3, 35)]}).crossFamily).toBe(true);
    expect(resolver.resolveVerdict({...input, reviews: [review(3, 35)], disclosureTruncated: true}))
        .toMatchObject({qualified: false, crossFamily: null, disclosureTruncated: true});
    expect(resolver.resolveVerdict({...input, disclosureTruncated: true}).crossFamily).toBe(false);
    expect(resolver.resolveVerdict({...input, body: '', reviews: [review(3, 35)]}))
        .toMatchObject({outside: true, qualified: true, authorFamilies: [], crossFamily: null});
});

test('unclassified approvers never qualify while literal unknown remains a real family', () => {
    const resolver = resolve(observation([{id: 1, families: [[10, 'gpt']]}, {id: 2, families: [[10, 'unknown']]}]));
    expect(resolver.resolveVerdict(pr())).toMatchObject({qualified: true, approvingFamilies: ['unknown'], crossFamily: true});
    expect(resolver.resolveVerdict(pr({reviews: [review(99, 35)]})))
        .toMatchObject({qualified: false, code: 'approval-family-unclassified', unclassifiedApprovers: ['actor-99']});
    expect(resolver.resolveVerdict(pr({author: actor(99), authorAssociation: 'CONTRIBUTOR', reviews: [review(98, 35)]})).qualified).toBe(false);
    expect(resolver.resolveVerdict(pr({approvalsTruncated: true})).crossFamily).toBe(true);
    expect(resolver.resolveVerdict(pr({reviews: [review(1, 35)], approvalsTruncated: true})))
        .toMatchObject({qualified: false, crossFamily: null});
});

test('a complete population without approvals is a known negative, while an incomplete one is unavailable', () => {
    const resolver = resolve(observation([{id: 1, families: [[10, 'gpt']]}]));
    for (const reviews of [[], [review(1, 35, 'CHANGES_REQUESTED')], [review(1, 35, 'COMMENTED')]]) {
        expect(resolver.resolveVerdict(pr({reviews}))).toMatchObject({qualified: true, crossFamily: false, approvingFamilies: []});
        expect(resolver.resolveVerdict(pr({reviews, approvalsTruncated: true})))
            .toMatchObject({qualified: false, crossFamily: null, code: 'approval-history-unavailable'});
    }
    for (const reviews of [[null], [{state: 'UNKNOWN'}], null]) {
        expect(resolver.resolveVerdict(pr({reviews}))).toMatchObject({qualified: false, code: 'approval-history-unavailable'});
    }
});

test('corrections move founding cutoff at the original declaration boundary, not correction time', () => {
    const founders  = [['@author', 'gpt', 1]];
    const corrected = resolve(observation([{id: 1, families: [[10, 'gpt'], [20, 'claude']], corrections: [[1, 'gpt']]},
        {id: 2, families: [[10, 'claude']]}], founders));
    expect(corrected.resolveVerdict(pr({createdAt: new Date(0).toISOString()})))
        .toMatchObject({qualified: true, authorFamilies: ['gpt'], crossFamily: true});
    const introduced = resolve(observation([{id: 1, families: [[10, 'gpt'], [20, 'gpt']], corrections: [[1, 'claude']]},
        {id: 2, families: [[10, 'claude']]}], founders));
    expect(introduced.classifyActor(actor(1), 19).family).toBe('gpt');
    expect(introduced.classifyActor(actor(1), 20).family).toBe('claude');
    expect(introduced.resolveVerdict(pr()).authorFamilies).toEqual(['claude', 'gpt']);
});

test('one resolver retains one detached revision and family grouping is safe for prototype names', () => {
    const source   = observation([{id: 1, families: [[10, '__proto__']]}]);
    const resolver = resolve(source);
    source.snapshot.subjects[0].source.declarations[0].family = 'changed';
    const grouped = resolver.groupReviews([review(1, 15)]);
    expect(Object.getPrototypeOf(grouped.byFamily)).toBeNull();
    expect(Object.hasOwn(grouped.byFamily, '__proto__')).toBe(true);
    expect(grouped.byFamily.__proto__).toBe(1);
    expect(resolver.classifyActor(actor(1), 15).family).toBe('__proto__');
    expect(resolve(source).classifyActor(actor(1), 15).family).toBe('changed');
});

test('invalid decision inputs remain explicit and do not throw or substitute current time', () => {
    const unavailable = createAdmittedFamilyResolver();
    expect(unavailable.resolveVerdict(pr())).toMatchObject({sourceState: 'unavailable', qualified: false});
    expect(unavailable.resolveVerdict(null).qualified).toBe(false);
    const source   = observation([{id: 1, families: [[10, 'gpt']]}]);
    const resolver = resolve(source);
    expect(resolver.classifyReviewer({author: actor(1)})).toMatchObject({classified: false, code: 'family-time-unavailable'});
    expect(resolver.classifyActor(actor(1), 41).classified).toBe(false);
    expect(resolver.groupReviews(null)).toMatchObject({code: 'review-history-unavailable', unclassified: [{state: 'unavailable'}]});
    expect(resolve(source, {observedAt: 'invalid'}).sourceState).toBe('unavailable');
    const disclosedFamilies = new Array(1);
    expect(resolver.resolveVerdict(pr({author: actor(99), authorAssociation: 'CONTRIBUTOR', disclosedFamilies})))
        .toMatchObject({qualified: false, code: 'author-disclosure-unavailable'});
});

test('preparsed null self-id stays unbound, and outside commit disclosures retain the existing policy', () => {
    const resolver = resolve(observation([{id: 1, families: [[10, 'gpt']]}, {id: 2, families: [[10, 'claude']]}],
        [['@other', 'claude', 2]]));
    expect(resolver.resolveVerdict(pr({body: 'Authored by @other (Claude).', selfIdIdentityKey: null})))
        .toMatchObject({authorFamilies: ['gpt'], crossFamily: true});
    expect(resolver.resolveVerdict(pr({author: actor(99), authorAssociation: 'CONTRIBUTOR', body: 'ordinary prose',
        commitMessages: ['A change\n\nCo-Authored-By: Claude <fixture@example.test>']})))
        .toMatchObject({outside: true, authorFamilies: ['claude'], crossFamily: false});
});

test('the pure resolver imports without Neo, service boot or a legacy roster dependency', () => {
    const file  = new URL('../../../../../../ai/services/graph/admittedFamilyResolution.mjs', import.meta.url);
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
        'await import(' + JSON.stringify(file.href) + '); process.stdout.write("PURE_RESOLVER");'], {encoding: 'utf8'});
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('PURE_RESOLVER');
    expect(readFileSync(file, 'utf8')).not.toMatch(/from ['"][^'"]*(?:identityRoots|agentFamilyResolution|GraphService|config\.mjs)/);
});
