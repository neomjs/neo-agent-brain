import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import {setup} from '../../../../setup.mjs';
import IdentityPublicationClient, {createIdentityPublicationClient, validateIdentityPublicationSnapshot}
    from '../../../../../../ai/services/shared/identityPublicationClient.mjs';
import {familyMembershipKey}       from '../../../../../../ai/services/shared/identityPublicationKeys.mjs';
import {compileFoundingFamilySeed} from '../../../../../../ai/graph/identityFoundingSeed.mjs';

setup();

const target    = {planeId: 'family-plane', dataRoot: '/served/root'}, identity = '@viewer';
const subject   = {authProvider: 'github', providerBaseUrl: 'https://api.github.com', providerUserId: '123'};
const founder   = {...subject, providerUserId: '456'};
const binding   = {subject: {...subject, providerUsername: 'outside'}, seatId: 'seat-a', incarnation: 'inc-a'};
const bindingId = familyMembershipKey({planeId: target.planeId, ...binding});

/** @summary Builds the physical owner's current complete founding-plus-admitted wire shape. */
function snapshot() {
    const founding = structuredClone(compileFoundingFamilySeed({identities: [{id: '@founder', type: 'AgentIdentity',
        properties: {accountType: 'agent', modelFamily: 'gpt'}}], subjects: [{identityKey: '@founder', subject: founder}]}));
    return {version: 1, target: {...target}, revision: 2, baselineSince: 100, founding, foundingRevision: 1,
        foundingProvenance: {sourceRevision: 'reviewed-source', installedAt: 90, issuer: 'issuer-a', lineageHead: 'identity-family-lineage-head-' + 'a'.repeat(64)},
        counts            : {subjects: 2, admittedSubjects: 1, memberships: 1, declarations: 1, corrections: 0},
        subjects          : [{subject: {...subject}, membershipRevision: 1, admissionRevision: 1,
            bindings: [{bindingId, binding: structuredClone(binding), currentSeatId: 'seat-a'}],
            source  : {baselineSince: 100, revision: 2, memberships: [{bindingId, since: 100, until: null}],
                declarations: [{admissionId: 'declaration-a', bindingId, operatorPrincipal: 'operator-a', since: 110,
                    revision: 2, family: 'gpt', model: null}], corrections: []}},
        {subject: {...founder}, membershipRevision: 0, admissionRevision: 0, bindings: [],
            source: {baselineSince: 100, revision: 2, memberships: [], declarations: [], corrections: []}}]};
}

/** @summary Drives the actual owned client through its explicit transport seam without network access. */
function fixture({identities = [identity], targets = [target], response = () => ({state: 'available', snapshot: snapshot()}), probe} = {}) {
    const calls  = [], sessions = [];
    const client = createIdentityPublicationClient({baseUrl: 'https://plane.example/mc/mcp', credential: 'fixture-token',
        expectedIdentity: identity, expectedTarget: target,
        createSession   : () => {
            const ordinal = sessions.length;
            const session = {closed: 0, terminated: 0,
                client: {async connect() {calls.push({name: 'connect', ordinal});}, async close() {session.closed++;},
                    async callTool({name, arguments: args}) {
                        calls.push({name, args, ordinal});
                        const plane = targets[Math.min(ordinal, targets.length - 1)];
                        if (name === 'healthcheck') await probe?.();
                        return {structuredContent: name === 'list_permissions' ? {identity: identities[Math.min(ordinal, identities.length - 1)]} :
                            name === 'healthcheck' ? {plane: {id: plane.planeId, dataRoot: plane.dataRoot}} : await response({ordinal})};
                    }},
                transport: {async terminateSession() {session.terminated++;}}
            };
            sessions.push(session);
            return session;
        }});
    return {client, calls, sessions};
}

test('reads a complete coherent observation including a founding-only subject', async () => {
    const {client, calls} = fixture();
    try {
        expect(client instanceof IdentityPublicationClient).toBe(true);
        expect(calls).toEqual([]);
        const result = await client.readSnapshot();
        expect(result).toMatchObject({state: 'available', snapshot: {revision: 2, foundingRevision: 1,
            counts: {subjects: 2, admittedSubjects: 1}}});
        expect(calls.map(call => call.name)).toEqual(['connect', 'list_permissions', 'healthcheck', 'get_identity_publication_snapshot']);
        expect(calls[2].args).toEqual({scope: 'plane'});
        expect(Object.isFrozen(result.snapshot.founding.entries[0])).toBe(true);
    } finally {await client.close(); client.destroy();}
});

for (const [label, corrupt] of [
    ['founding digest', value => {value.founding.digest = 'sha256:' + '0'.repeat(64);}],
    ['founding revision', value => {value.foundingRevision = 2;}],
    ['missing founding provenance', value => {delete value.foundingProvenance;}],
    ['malformed original lineage', value => {value.foundingProvenance.lineageHead = 'forged';}],
    ['missing founding-only subject', value => {value.subjects.pop(); value.counts.subjects--;}],
    ['invented founding-only subject', value => {value.subjects[1].subject.providerUserId = '789';}],
    ['admitted subject count', value => {value.counts.admittedSubjects = 2;}],
    ['founding row with admission', value => {value.subjects[1].admissionRevision = 1;}],
    ['mixed owner revision', value => {value.subjects[0].source.revision++;}],
    ['missing admitted binding', value => {value.subjects[0].bindings = [];}],
    ['negative clock', value => {value.foundingProvenance.installedAt = -1;}],
    ['nonfinite Date clock', value => {value.foundingProvenance.installedAt = Number.MAX_SAFE_INTEGER;}]
]) test('refuses malformed complete source: ' + label, () => {
    const value = snapshot(); corrupt(value);
    expect(validateIdentityPublicationSnapshot(value, target)).toEqual({valid: false, code: 'family-snapshot-invalid'});
});

test('source mismatch cannot replace the independently held target after a valid session proof', async () => {
    const value    = snapshot(); value.target.dataRoot = '/different';
    const {client} = fixture({response: () => ({state: 'available', snapshot: value})});
    try {expect(await client.readSnapshot()).toEqual({state: 'unavailable', code: 'family-snapshot-target-mismatch'});}
    finally {await client.close(); client.destroy();}
});

test('unknown source is unavailable rather than a manufactured empty population', async () => {
    for (const result of [null, {}, {state: 'unavailable', code: 'membership-unknown'}, {state: 'unavailable', code: 'untrusted-prose'}]) {
        const {client} = fixture({response: () => result});
        try {expect(await client.readSnapshot()).toEqual({state: 'unavailable', code: result?.code === 'membership-unknown' ? 'membership-unknown' : 'family-source-unavailable'});}
        finally {await client.close(); client.destroy();}
    }
});

test('each read returns a detached observation without caching history', async () => {
    const value = snapshot(), {client, calls} = fixture({response: () => ({state: 'available', snapshot: value})});
    try {
        const [a, b] = await Promise.all([client.readSnapshot(), client.readSnapshot()]);
        expect(a.state).toBe('available'); expect(b).toEqual(a); expect(a.snapshot).not.toBe(b.snapshot);
        value.subjects[0].source.declarations[0].family = 'claude';
        expect(a.snapshot.subjects[0].source.declarations[0].family).toBe('gpt');
        expect((await client.readSnapshot()).snapshot.subjects[0].source.declarations[0].family).toBe('claude');
        expect(calls.filter(call => call.name === 'connect')).toHaveLength(1);
    } finally {await client.close(); client.destroy();}
});

test('reconnect proves identity and target before repeating a source read', async () => {
    for (const options of [{identities: [identity, '@other']}, {targets: [target, {...target, dataRoot: '/other'}]}]) {
        const {client, calls} = fixture({...options, response: () => {throw Object.assign(new Error('Session invalid'), {code: 404});}});
        try {
            expect((await client.readSnapshot()).state).toBe('unavailable');
            expect(calls.filter(call => call.name === 'get_identity_publication_snapshot')).toHaveLength(1);
            expect(calls.filter(call => call.name === 'list_permissions')).toHaveLength(2);
        } finally {await client.close(); client.destroy();}
    }
});

test('Neo destruction closes the owned transport and prevents all new reads', async () => {
    const {client, sessions} = fixture();
    expect(await client.connect()).toEqual({state: 'bound'});
    client.destroy();
    await client.close();
    expect(await client.readSnapshot()).toEqual({state: 'unavailable', code: 'family-source-closed'});
    expect(sessions[0]).toMatchObject({closed: 1, terminated: 1});
});

test('close invokes the transport owner before waiting on its pending proof', async () => {
    let entered, release;
    const reached            = new Promise(resolve => {entered = resolve;});
    const pending            = new Promise(resolve => {release = resolve;});
    const {client, sessions} = fixture({probe: async () => {entered(); await pending;}});
    const reading            = client.readSnapshot();
    await reached;
    const closeOwner = client.planeClient.close.bind(client.planeClient);
    let   called     = false;
    client.planeClient.close = () => {called = true; release(); return closeOwner();};
    try {
        const closing = client.close();
        await Promise.resolve();
        expect(called).toBe(true);
        await closing;
        expect(await reading).toEqual({state: 'unavailable', code: 'family-source-closed'});
        expect(sessions[0]).toMatchObject({closed: 1, terminated: 1});
    } finally {release(); await reading; await client.close(); client.destroy();}
});

test('explicit bootstrap inputs are required before any connection is allocated', () => {
    for (const patch of [{credential: ''}, {expectedIdentity: null}, {expectedTarget: null}]) {
        expect(() => Neo.create(IdentityPublicationClient, {baseUrl: 'https://plane.example/mc/mcp', credential: 'fixture-token',
            expectedIdentity: identity, expectedTarget: target, ...patch})).toThrow('explicit credential');
    }
});

test('a rejected proof settling after Neo destruction writes no late client state', async () => {
    const {client} = fixture();
    await client.ready();
    let reject;
    client.planeClient.init = () => new Promise((resolve, refused) => {reject = refused;});
    const reading = client.readSnapshot();
    const closing = client.close();
    client.destroy();
    const stateAfterDestroy = client.sourceState;
    reject(new Error('late proof refusal'));
    expect(await reading).toEqual({state: 'unavailable', code: 'family-source-closed'});
    await closing;
    expect(client.sourceState).toBe(stateAfterDestroy);
});

for (const code of ['publication-boot-unavailable', 'founding-source-conflict', 'founding-source-unavailable',
    'founding-history-unreconciled', 'founding-input-invalid']) {
    test('preserves the protected source refusal: ' + code, async () => {
        const {client} = fixture({response: () => ({state: 'unavailable', code})});
        try {expect(await client.readSnapshot()).toEqual({state: 'unavailable', code});}
        finally {await client.close(); client.destroy();}
    });
}
