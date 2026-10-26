import {setup} from '../../../../../setup.mjs';
import Neo from 'neo.mjs/src/Neo.mjs';
import * as core from 'neo.mjs/src/core/_export.mjs';
import {test, expect} from '@playwright/test';
import crypto from 'node:crypto';
import http from 'node:http';
import {stringifyCanonicalJson} from '../../../../../../../ai/services/shared/canonicalJson.mjs';

setup({appConfig: {name: 'IdentityPublicationAuthHttpTest'}});
test.describe.configure({mode: 'serial'});

const first = crypto.generateKeyPairSync('ed25519');
const second = crypto.generateKeyPairSync('ed25519');
const path = '/identity/family-publications';

/** @summary Signs fixture bytes independently of the HTTP owner. */
function signed({patch = {}, privateKey = first.privateKey} = {}) {
    const issuedAt = Date.now();
    const value = {
        audience: 'plane-a', issuer: 'fleet-a', kid: 'key-a', version: 1,
        purpose: 'identity-family-publication', issuedAt, expiresAt: issuedAt + 300000,
        operation: {kind: 'confirm', model: null, operationId: 'act-a'}, ...patch
    };
    const bytes = Buffer.from(stringifyCanonicalJson(value));
    const signature = crypto.sign(null, Buffer.concat([Buffer.from('neo.identity-family-publication.v1\0'), bytes]), privateKey);

    return bytes.toString('base64url') + '.' + signature.toString('base64url');
}

/** @summary Supplies plain test-owned configuration, never mutating a shared provider. */
function config(auth = {}, extra = {}) {
    return {
        mcpHttpHost: '127.0.0.1', mcpListenHost: '127.0.0.1', mcpHttpPort: 0,
        fleet: {cockpitOrigins: ['http://127.0.0.1:8080']},
        auth: {
            mode: 'github-pat', githubApiBaseUrl: 'https://forge.fixture',
            patCacheTtlSeconds: 60, patStaleGraceSeconds: 0, patDiskCachePath: '',
            patValidationTimeoutMs: 1000, allowedUsers: [], pinFirstProviderSubject: false,
            host: null, issuerUrl: null, trustProxyIdentity: false, ...auth
        },
        ...extra
    };
}

test.describe('identity publication actual HTTP boundary', () => {
    let TransportService, originalFetch, providerCalls, logs, admitted;

    test.beforeAll(async () => {
        TransportService = (await import('../../../../../../../ai/mcp/server/shared/services/TransportService.mjs')).default;
    });

    test.beforeEach(() => {
        originalFetch = globalThis.fetch;
        providerCalls = 0;
        logs = [];
        admitted = [];
        globalThis.fetch = async url => {
            expect(String(url)).toBe('https://forge.fixture/user');
            providerCalls++;
            return {ok: true, status: 200, headers: new Headers(), json: async () => ({id: 42, login: 'operator', name: 'Operator'})};
        };
    });

    test.afterEach(async () => {
        globalThis.fetch = originalFetch;
        if (TransportService.httpServer?.listening) {
            await new Promise((resolve, reject) => TransportService.httpServer.close(error => error ? reject(error) : resolve()));
        }
        TransportService.app = null;
        TransportService.httpServer = null;
        TransportService.transports = new Map();
        TransportService.mcpServers = new Map();
    });

    /** @summary Creates one verifier-owned boot descriptor with an observable fake MC admission callback. */
    function boundary(admit = async envelope => {
        admitted.push(envelope);
        return {statusCode: 200, body: {status: 'accepted', receiptId: 'receipt-fixture'}};
    }) {
        return {audience: 'plane-a', issuer: 'fleet-a', publicKeys: new Map([['key-a', first.publicKey]]), admit};
    }

    /** @summary Boots the real transport and auth owners; no graph or live forge is used. */
    async function boot(identityPublication, aiConfig = config()) {
        await TransportService.setup({
            server: {mcpServer: {connect: async () => {}}, onSessionClosed() {}},
            aiConfig, identityPublication,
            logger: {info: value => logs.push(value), warn: value => logs.push(value), error: value => logs.push(value)},
            resourceName: 'IdentityPublicationHttpFixture'
        });
    }

    /** @summary Sends a real HTTP request to the ephemeral loopback listener. */
    async function send(body, {route = path, method = 'POST', headers = {}, rawBody} = {}) {
        const port = TransportService.httpServer.address().port;
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1', port, path: route, method, agent: false,
                headers: {'content-type': 'application/json', ...headers}
            }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let value;
                    try {value = JSON.parse(text);} catch {value = text;}
                    resolve({status: res.statusCode, body: value});
                });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => req.destroy(new Error('Fixture HTTP request timed out')));
            req.end(rawBody === undefined ? body === undefined ? undefined : JSON.stringify(body) : rawBody);
        });
    }

    test('signed service request reaches only the MC callback before ordinary bearer auth', async () => {
        await boot(boundary());
        const result = await send({envelope: signed()}, {headers: {authorization: 'Bearer not-a-class9-credential'}});

        expect(result).toEqual({status: 200, body: {status: 'accepted', receiptId: 'receipt-fixture'}});
        expect(providerCalls).toBe(0);
        expect(admitted).toHaveLength(1);
        expect(admitted[0].operation.model).toBeNull();
        expect(Object.isFrozen(admitted[0].operation)).toBe(true);
        expect(admitted[0]).not.toHaveProperty('auth');
        expect(admitted[0]).not.toHaveProperty('headers');
    });

    test('ordinary credentials and malformed carriers cannot call the publication owner', async () => {
        await boot(boundary());
        for (const body of [{}, {envelope: 'ordinary-token'}, {envelope: null},
            {envelope: signed(), operatorPrincipal: 'forged'}, [signed()]]) {
            const response = await send(body, {headers: {authorization: 'Bearer valid-fixture-pat'}});
            expect([400, 401]).toContain(response.status);
        }
        expect(providerCalls).toBe(0);
        expect(admitted).toEqual([]);
    });

    test('wrong trust, purpose and expired delivery refuse without invoking admission', async () => {
        await boot(boundary());
        const expired = Date.now() - 600000;
        for (const token of [
            signed({privateKey: second.privateKey}),
            signed({patch: {audience: 'other-plane'}}),
            signed({patch: {issuer: 'other-issuer'}}),
            signed({patch: {purpose: 'bridge-token'}}),
            signed({patch: {issuedAt: expired, expiresAt: expired + 300000}})
        ]) {
            expect((await send({envelope: token})).status).toBe(401);
        }
        expect(admitted).toEqual([]);
    });

    test('common Host and Origin guards run before a valid signed publication', async () => {
        await boot(boundary());
        expect((await send({envelope: signed()}, {headers: {host: 'untrusted.example'}})).status).toBe(403);
        expect((await send({envelope: signed()}, {headers: {origin: 'https://untrusted.example'}})).status).toBe(403);
        expect(admitted).toEqual([]);
    });

    test('running trust and callback are detached from subsequent descriptor mutation', async () => {
        const descriptor = boundary();
        await boot(descriptor);
        descriptor.publicKeys.clear();
        descriptor.publicKeys.set('key-b', second.publicKey);
        descriptor.audience = 'other-plane';
        descriptor.issuer = 'other-issuer';
        descriptor.admit = () => {throw new Error('replacement callback must not run');};

        expect((await send({envelope: signed()})).status).toBe(200);
        expect((await send({envelope: signed({patch: {kid: 'key-b'}, privateKey: second.privateKey})})).status).toBe(401);
        expect(admitted).toHaveLength(1);
    });

    for (const [name, aiConfig] of [
        ['custom', config({}, {authMiddleware() {}})],
        ['proxy-only', config({mode: 'oidc', trustProxyIdentity: true})],
        ['mixed proxy flag', config({trustProxyIdentity: true})],
        ['OIDC', config({mode: 'oidc'})],
        ['GitLab-PAT', config({mode: 'gitlab-pat'})],
        ['local bearer', config({mode: 'local-bearer'})],
        ['seat token', config({mode: 'seat-token'})]
    ]) {
        test('provisioned ' + name + ' refuses before any listener opens', async () => {
            await expect(boot(boundary(), aiConfig)).rejects.toThrow('standard github-pat profile');
            expect(TransportService.httpServer?.listening).not.toBe(true);
            expect(providerCalls).toBe(0);
        });
    }

    test('reserve-only boot rejects every signature while ordinary authenticated transport remains available', async () => {
        const descriptor = {...boundary(), publicKeys: new Map()};
        await boot(descriptor);
        descriptor.publicKeys.set('key-a', first.publicKey);
        TransportService.app.get('/ordinary-probe', (req, res) => res.json({identity: req.auth.userId}));
        expect((await send({envelope: signed()}, {headers: {authorization: 'Bearer fixture-pat'}})).status).toBe(401);
        expect(admitted).toEqual([]);
        expect(providerCalls).toBe(0);
        expect(await send(undefined, {route: '/ordinary-probe', method: 'GET', headers: {authorization: 'Bearer fixture-pat'}}))
            .toEqual({status: 200, body: {identity: 'operator'}});
    });

    test('reserve-only configuration still rejects an unsupported auth profile before listening', async () => {
        await expect(boot({...boundary(), publicKeys: new Map()}, config({}, {authMiddleware() {}})))
            .rejects.toThrow('standard github-pat profile');
        expect(TransportService.httpServer?.listening).not.toBe(true);
    });

    test('partial provision and nonpublic trust refuse boot instead of disappearing', async () => {
        for (const descriptor of [
            {}, {...boundary(), admit: null}, {...boundary(), publicKeys: null},
            {...boundary(), publicKeys: new Map([['key-a', first.privateKey]])},
            {...boundary(), publicKeys: new Map([['key-a', {type: 'public', asymmetricKeyType: 'ed25519', key: first.privateKey}]])}
        ]) {
            await expect(boot(descriptor)).rejects.toThrow('AuthService: identity publication');
            expect(TransportService.httpServer?.listening).not.toBe(true);
        }
    });

    test('unprovisioned custom profile remains unchanged and exposes no publication route', async () => {
        await boot(null, config({}, {authMiddleware: (_req, _res, next) => next()}));
        expect((await send({envelope: signed()})).status).toBe(404);
        expect(admitted).toEqual([]);
    });

    test('MC unavailable result preserves the ordinary authenticated transport', async () => {
        await boot(boundary(async () => ({statusCode: 503, body: {status: 'unavailable', reason: 'graph-not-ready'}})));
        TransportService.app.get('/ordinary-probe', (req, res) => res.json({identity: req.auth.userId}));

        expect(await send({envelope: signed()})).toEqual({status: 503, body: {status: 'unavailable', reason: 'graph-not-ready'}});
        const ordinary = await send(undefined, {route: '/ordinary-probe', method: 'GET', headers: {authorization: 'Bearer fixture-pat'}});
        expect(ordinary).toEqual({status: 200, body: {identity: 'operator'}});
        expect(providerCalls).toBe(1);
    });

    test('unexpected admission errors disclose neither the envelope nor arbitrary error text', async () => {
        const secretMarker = 'must-not-escape-fixture';
        await boot(boundary(async () => {throw new Error(secretMarker);}));

        expect(await send({envelope: signed()})).toEqual({status: 503, body: {error: {code: 'publication-unavailable'}}});
        expect(JSON.stringify(logs)).not.toContain(secretMarker);
    });

    test('invalid callback response becomes a named unavailable result', async () => {
        await boot(boundary(async () => ({statusCode: 0, body: {status: 'accepted'}})));
        expect(await send({envelope: signed()})).toEqual({status: 503, body: {error: {code: 'publication-unavailable'}}});
    });

    test('undefined callback body cannot become an empty successful response', async () => {
        await boot(boundary(async () => ({statusCode: 200, body: undefined})));
        expect(await send({envelope: signed()})).toEqual({status: 503, body: {error: {code: 'publication-unavailable'}}});
    });

    for (const statusCode of [204, 205, 304]) {
        test('body-suppressing callback status ' + statusCode + ' cannot erase its result', async () => {
            await boot(boundary(async () => ({statusCode, body: {status: 'accepted'}})));
            expect(await send({envelope: signed()})).toEqual({status: 503, body: {error: {code: 'publication-unavailable'}}});
        });
    }

    test('outer JSON parser refusals are pre-admission and may have a different error shape', async () => {
        await boot(boundary());
        const malformed = await send(undefined, {rawBody: '{"envelope":'});
        expect(malformed.status).toBe(400);
        const token = signed({patch: {operation: {kind: 'baseline', largeFixture: 'x'.repeat(80000)}}});
        const bytes = Buffer.byteLength(JSON.stringify({envelope: token}));
        expect(bytes).toBeGreaterThan(102400);
        const oversized = await send({envelope: token});
        expect(oversized.status).toBe(413);
        expect(admitted).toEqual([]);
        expect(providerCalls).toBe(0);
    });
});
