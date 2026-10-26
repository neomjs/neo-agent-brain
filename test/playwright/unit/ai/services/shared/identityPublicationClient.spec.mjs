import {test, expect}                                                         from '@playwright/test';
import {createIdentityPublicationClient, validateIdentityPublicationSnapshot} from '../../../../../../ai/services/shared/identityPublicationClient.mjs';
import {familyMembershipKey}                                                  from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';

const target    = {planeId: 'family-plane', dataRoot: '/served/root'}, identity = '@viewer';
const subject   = {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '123'};
const binding   = {subject: {...subject, providerUsername: 'outside'}, seatId: 'seat-a', incarnation: 'inc-a'};
const bindingId = familyMembershipKey({planeId: target.planeId, ...binding});

/** @summary Builds one complete wire history independently of the client validator. */
function snapshot() {
    return {version: 1, target: {...target}, revision: 2, baselineSince: 100,
        counts            : {subjects: 1, memberships: 1, declarations: 1, corrections: 0}, subjects: [{subject: {...subject},
        membershipRevision: 1, admissionRevision: 1, bindings: [{bindingId, binding: structuredClone(binding), currentSeatId: 'seat-a'}],
        source            : {baselineSince: 100, revision: 2, memberships: [{bindingId, since: 100, until: null}],
            declarations: [{admissionId: 'declaration-a', bindingId, operatorPrincipal: 'operator-a', since: 110,
                revision: 2, family: 'gpt', model: null}], corrections: []}}]};
}

/** @summary Uses the existing client's explicit session seam; no credentials or network are read. */
function fixture({identities = [identity], targets = [target], response = () => ({state: 'available', snapshot: snapshot()})} = {}) {
    const calls         = [], sessions = [];
    const createSession = () => {
        const ordinal = sessions.length;
        const session = {closed: 0, terminated: 0,
            client: {async connect() { calls.push({name: 'connect', ordinal}); }, async close() { session.closed++; },
                async callTool({name, arguments: args}) {
                    calls.push({name, args, ordinal});
                    const payload = name === 'list_permissions' ? {identity: identities[Math.min(ordinal, identities.length - 1)]} :
                        name === 'healthcheck' ? {plane: {id: targets[Math.min(ordinal, targets.length - 1)].planeId,
                            dataRoot: targets[Math.min(ordinal, targets.length - 1)].dataRoot}} : await response({ordinal, calls});
                    return {structuredContent: payload};
                }}, transport: {async terminateSession() { session.terminated++; }}};
        sessions.push(session); return session;
    };
    const client = createIdentityPublicationClient({baseUrl: 'https://plane.example/mc/mcp', credential: 'fixture-seat-token',
        expectedIdentity: identity, expectedTarget: target, createSession});
    return {client, calls, sessions};
}

test('requires explicit credential, viewer and remote target before constructing a session', () => {
    let   created = 0;
    const options = {baseUrl: 'https://plane.example/mc/mcp', credential: 'fixture-token', expectedIdentity: identity,
        expectedTarget: target, createSession: () => { created++; }};
    for (const patch of [{credential: ''}, {credential: undefined}, {expectedIdentity: null}, {expectedTarget: undefined},
        {expectedTarget: {planeId: 'p', dataRoot: 'relative'}}, {expectedTarget: {...target, extra: true}}]) {
        expect(() => createIdentityPublicationClient({...options, ...patch})).toThrow('explicit credential');
    }
    expect(created).toBe(0);
});

test('is passive until read, proves identity then target, and returns an independent frozen snapshot', async () => {
    const source = snapshot(), {client, calls, sessions} = fixture({response: () => ({state: 'available', snapshot: source})});
    expect(sessions).toHaveLength(0);
    try {
        const result = await client.readSnapshot();
        expect(result.state).toBe('available');
        expect(calls.map(value => value.name)).toEqual(['connect', 'list_permissions', 'healthcheck', 'get_identity_publication_snapshot']);
        expect(calls[2].args).toEqual({scope: 'plane'});
        expect(Object.isFrozen(result.snapshot.subjects[0].source.declarations[0])).toBe(true);
        source.subjects[0].source.declarations[0].family = 'claude';
        expect(result.snapshot.subjects[0].source.declarations[0].family).toBe('gpt');
        expect(Object.keys(client).sort()).toEqual(['close', 'readSnapshot']);
    } finally { await client.close(); }
    expect(sessions[0]).toMatchObject({closed: 1, terminated: 1});
});

test('concurrent first reads share proofs but each receives its own complete decision snapshot', async () => {
    const {client, calls} = fixture();
    try {
        const [a, b] = await Promise.all([client.readSnapshot(), client.readSnapshot()]);
        expect(a).toEqual(b); expect(a.snapshot).not.toBe(b.snapshot);
        expect(calls.filter(call => call.name === 'connect')).toHaveLength(1);
        expect(calls.filter(call => call.name === 'healthcheck')).toHaveLength(1);
        expect(calls.filter(call => call.name === 'get_identity_publication_snapshot')).toHaveLength(2);
    } finally { await client.close(); }
});

test('explicit empty membership is available, while source failure is not an empty success', async () => {
    for (const response of [null, {}, {state: 'unavailable', code: 'membership-unknown'}]) {
        const {client} = fixture({response: () => response});
        try { expect(await client.readSnapshot()).toEqual({state: 'unavailable',
            code: response?.code === 'membership-unknown' ? 'membership-unknown' : 'family-source-unavailable'}); }
        finally { await client.close(); }
    }
    const {client} = fixture({response: () => ({state: 'available', snapshot: {...snapshot(), revision: 1, subjects: [],
        counts: {subjects: 0, memberships: 0, declarations: 0, corrections: 0}}})});
    try { expect(await client.readSnapshot()).toMatchObject({state: 'available', snapshot: {subjects: [], revision: 1}}); }
    finally { await client.close(); }
});

test('a source response from another root refuses even after a successful session proof', async () => {
    const wrong    = snapshot(); wrong.target.dataRoot = '/foreign';
    const {client} = fixture({response: () => ({state: 'available', snapshot: wrong})});
    try { expect(await client.readSnapshot()).toEqual({state: 'unavailable', code: 'family-snapshot-target-mismatch'}); }
    finally { await client.close(); }
});

for (const [label, corrupt] of [
    ['version', value => { value.version = 2; }],
    ['missing population', value => { delete value.subjects[0].source.corrections; }],
    ['mixed revision', value => { value.subjects[0].source.revision = 3; }],
    ['missing binding', value => { value.subjects[0].bindings = []; }],
    ['foreign subject', value => { value.subjects[0].subject.providerUserId = 'other'; }],
    ['unaccounted declaration', value => { value.subjects[0].admissionRevision = 0; }],
    ['duplicate subject', value => { value.subjects.push(structuredClone(value.subjects[0])); }],
    ['unclassified history removed', value => { value.subjects[0].source.memberships[0].since = 120; }],
    ['bad correction target', value => { value.revision = 3; value.subjects[0].source.revision = 3;
        value.subjects[0].admissionRevision = 2; value.subjects[0].source.corrections.push({admissionId: 'correction-a',
            targetAdmissionId: 'missing', operatorPrincipal: 'operator-a', revision: 3, family: 'claude', model: null}); }]
]) test('refuses malformed complete snapshot: ' + label, () => {
    const value = snapshot(); corrupt(value);
    expect(validateIdentityPublicationSnapshot(value, target)).toEqual({valid: false, code: 'family-snapshot-invalid'});
});

test('accessors are not invoked while validating an untrusted structured payload', () => {
    let   reads = 0;
    const value = snapshot();
    Object.defineProperty(value, 'subjects', {enumerable: true, get() { reads++; return []; }});
    expect(validateIdentityPublicationSnapshot(value, target).valid).toBe(false);
    expect(reads).toBe(0);
});

test('reconnect refuses a changed identity or target before reading its content', async () => {
    for (const options of [{identities: [identity, '@other']}, {targets: [target, {...target, planeId: 'other-plane'}]}]) {
        const {client, calls} = fixture({...options, response: () => { throw Object.assign(new Error('Session invalid'), {code: 404}); }});
        try {
            expect((await client.readSnapshot()).state).toBe('unavailable');
            expect(calls.filter(call => call.name === 'get_identity_publication_snapshot')).toHaveLength(1);
            expect(calls.filter(call => call.name === 'list_permissions')).toHaveLength(2);
        } finally { await client.close(); }
    }
});

test('a failed initial proof can recover later without caching false authority', async () => {
    const {client, calls} = fixture({identities: ['@other', identity]});
    try {
        expect(await client.readSnapshot()).toEqual({state: 'unavailable', code: 'viewer-binding-unavailable'});
        expect((await client.readSnapshot()).state).toBe('available');
        expect(calls.filter(call => call.name === 'get_identity_publication_snapshot')).toHaveLength(1);
    } finally { await client.close(); }
});

test('ambiguous failure is not replayed; the next read re-proves its session', async () => {
    let   reads           = 0;
    const {client, calls} = fixture({response: () => {
        if (++reads === 1) throw new Error('Connection lost');
        return {state: 'available', snapshot: snapshot()};
    }});
    try {
        expect((await client.readSnapshot()).state).toBe('unavailable'); expect(reads).toBe(1);
        expect((await client.readSnapshot()).state).toBe('available');
        expect(calls.filter(call => call.name === 'healthcheck')).toHaveLength(2);
    } finally { await client.close(); }
});

test('close is terminal and never starts another session', async () => {
    const {client, calls} = fixture();
    await client.close();
    expect(await client.readSnapshot()).toEqual({state: 'unavailable', code: 'family-source-closed'});
    expect(calls).toEqual([]);
});

test('immediate close joins pending initialization before its final teardown', async () => {
    const {client, sessions} = fixture();
    const reading            = client.readSnapshot();
    await client.close();
    expect(await reading).toEqual({state: 'unavailable', code: 'family-source-closed'});
    for (const session of sessions) expect(session).toMatchObject({terminated: 1, closed: 1});
});

test('baseline revision cannot also contain a declaration', () => {
    const value = snapshot(); value.revision = 1; value.subjects[0].source.revision = 1;
    value.subjects[0].source.declarations[0].revision = 1;
    expect(validateIdentityPublicationSnapshot(value, target).valid).toBe(false);
});

test('a complete-looking baseline cannot exceed the shared active-binding limit', () => {
    const value = snapshot(), item = value.subjects[0];
    value.revision = 1; item.source.revision = 1; item.admissionRevision = 0; item.source.declarations = [];
    value.counts.memberships = 129; value.counts.declarations = 0;
    item.bindings = Array.from({length: 129}, (_, i) => {
        const member = {...structuredClone(binding), seatId: 'seat-' + i, incarnation: 'inc-' + i};
        return {bindingId: familyMembershipKey({planeId: target.planeId, ...member}), binding: member, currentSeatId: member.seatId};
    });
    item.source.memberships = item.bindings.map(({bindingId}) => ({bindingId, since: 100, until: null}));
    expect(validateIdentityPublicationSnapshot(value, target).valid).toBe(false);
});

test('a dropped baseline-only population cannot masquerade as an explicitly empty plane', () => {
    const value = snapshot(); value.revision = 1; value.counts.declarations = 0; value.subjects = [];
    expect(validateIdentityPublicationSnapshot(value, target).valid).toBe(false);
});

test('retained retired incarnations may exceed the active profile limit', () => {
    const value = snapshot(), item = value.subjects[0];
    value.revision = 258; item.source.revision = 258; item.membershipRevision = 258;
    item.admissionRevision = 0; item.source.declarations = [];
    value.counts.memberships = 129; value.counts.declarations = 0;
    item.bindings = Array.from({length: 129}, (_, i) => {
        const member = {...structuredClone(binding), incarnation: 'inc-' + i};
        return {bindingId: familyMembershipKey({planeId: target.planeId, ...member}), binding: member, currentSeatId: member.seatId};
    });
    item.source.memberships = item.bindings.map(({bindingId}, i) => ({bindingId, since: 100 + 2 * i, until: 101 + 2 * i}));
    expect(validateIdentityPublicationSnapshot(value, target).valid).toBe(true);
});
