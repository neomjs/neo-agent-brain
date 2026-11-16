import {test, expect}             from '@playwright/test';
import {createPlaneMailboxClient} from '../../../../../../ai/services/fleet/planeMailboxClient.mjs';

const identity = '@reader', target = {planeId: 'protected-plane', dataRoot: '/declared/root'};

/** @summary Exercises the real session-proof and recovery owner without opening a transport. */
function fixture({identities = [identity], targets = [target], respond, probe} = {}) {
    const calls  = [], sessions = [];
    const client = createPlaneMailboxClient({baseUrl: 'https://plane.example/mc/mcp', credential: 'fixture-token',
        createSession: bearer => {
            const ordinal = sessions.length;
            const session = {terminated: 0, closed: 0, bearer,
                client: {
                    async connect() {calls.push({name: 'connect', ordinal});},
                    async close() {session.closed++;},
                    async callTool({name, arguments: args}) {
                        calls.push({name, args, ordinal});
                        if (name === 'list_permissions') return {structuredContent: {identity: identities[Math.min(ordinal, identities.length - 1)]}};
                        if (name === 'healthcheck') {
                            const plane = targets[Math.min(ordinal, targets.length - 1)];
                            await probe?.({ordinal});
                            return {structuredContent: {plane: plane && {id: plane.planeId, dataRoot: plane.dataRoot}}};
                        }
                        return {structuredContent: await respond?.({name, ordinal}) ?? {read: true}};
                    }
                },
                transport: {async terminateSession() {session.terminated++;}}
            };
            sessions.push(session);
            return session;
        }});
    return {client, calls, sessions};
}

for (const [label, plane] of [['missing', null], ['wrong plane', {...target, planeId: 'other'}], ['same id wrong root', {...target, dataRoot: '/other'}]]) {
    test('refuses an independently bound target: ' + label, async () => {
        const {client, calls, sessions} = fixture({targets: [plane]});
        try {
            expect(await client.init({expectedIdentity: identity, expectedTarget: target})).toMatchObject({ok: false, blockerCode: 'plane-binding-unavailable'});
            expect(calls.map(call => call.name)).toEqual(['connect', 'list_permissions', 'healthcheck']);
        } finally {await client.close();}
        expect(sessions[0]).toMatchObject({terminated: 1, closed: 1});
    });
}

test('proves identity and both target fields before content, retaining a detached expectation', async () => {
    const {client, calls} = fixture(), supplied = {...target};
    try {
        expect(await client.init({expectedIdentity: identity, expectedTarget: supplied})).toMatchObject({ok: true});
        supplied.dataRoot = '/changed-after-init';
        expect(await client.callTool('get_identity_publication_snapshot')).toEqual({read: true});
        expect(calls.map(call => call.name)).toEqual(['connect', 'list_permissions', 'healthcheck', 'get_identity_publication_snapshot']);
        expect(calls[2].args).toEqual({scope: 'plane'});
    } finally {await client.close();}
});

test('ordinary clients without a target retain their identity-only proof', async () => {
    const {client, calls} = fixture();
    try {
        expect(await client.init({expectedIdentity: identity})).toMatchObject({ok: true});
        expect(await client.callTool('list_messages')).toEqual({read: true});
        expect(calls.some(call => call.name === 'healthcheck')).toBe(false);
    } finally {await client.close();}
});

test('refuses malformed target declarations before any session is created', async () => {
    for (const expectedTarget of [null, {}, {...target, dataRoot: 'relative'}, {...target, extra: true}]) {
        const {client, sessions} = fixture();
        try {
            expect(await client.init({expectedIdentity: identity, expectedTarget})).toMatchObject({ok: false, blockerCode: 'plane-binding-unavailable'});
            expect(sessions).toHaveLength(0);
        } finally {await client.close();}
    }
});

test('a reconnect re-proves the original root before any replay', async () => {
    const {client, calls} = fixture({targets: [target, {...target, dataRoot: '/rebound'}], respond: () => {
        throw Object.assign(new Error('expired session'), {code: 404});
    }});
    try {
        expect(await client.init({expectedIdentity: identity, expectedTarget: target})).toMatchObject({ok: true});
        await expect(client.callTool('get_identity_publication_snapshot')).rejects.toMatchObject({planeBlockerCode: 'plane-binding-unavailable'});
        expect(calls.filter(call => call.name === 'get_identity_publication_snapshot')).toHaveLength(1);
        expect(calls.filter(call => call.name === 'healthcheck')).toHaveLength(2);
    } finally {await client.close();}
});

test('rotation to another root refuses while the prior proven session keeps serving', async () => {
    const {client, calls, sessions} = fixture({targets: [target, {...target, dataRoot: '/other'}]});
    try {
        expect(await client.init({expectedIdentity: identity, expectedTarget: target})).toMatchObject({ok: true});
        expect(await client.rotate({credential: 'successor-token'})).toMatchObject({ok: false, blockerCode: 'plane-binding-unavailable'});
        expect(await client.callTool('get_identity_publication_snapshot')).toEqual({read: true});
        expect(calls.at(-1).ordinal).toBe(0);
        expect(sessions[1]).toMatchObject({terminated: 1, closed: 1});
    } finally {await client.close();}
});

test('terminal close wins while target proof is awaiting its response', async () => {
    let release, reached;
    const entered            = new Promise(resolve => {reached = resolve;});
    const blocked            = new Promise(resolve => {release = resolve;});
    const {client, sessions} = fixture({probe: async () => {reached(); await blocked;}});
    const initializing       = client.init({expectedIdentity: identity, expectedTarget: target});
    await entered;
    const closing = client.close();
    release();
    expect(await initializing).toMatchObject({ok: false});
    await closing;
    expect(sessions[0]).toMatchObject({terminated: 1, closed: 1});
    await expect(client.callTool('get_identity_publication_snapshot')).rejects.toThrow('not initialized');
});
