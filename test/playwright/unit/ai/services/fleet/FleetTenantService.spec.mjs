import {setup} from '../../../../setup.mjs'

const appName = 'FleetTenantServiceTest'

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
})

import {test, expect} from '@playwright/test'
import {execFileSync} from 'node:child_process'
import crypto         from 'node:crypto'
import fs             from 'node:fs'
import os             from 'node:os'
import path           from 'node:path'
import Neo            from 'neo.mjs/src/Neo.mjs'
import * as core      from 'neo.mjs/src/core/_export.mjs'

import FleetTenantService, {
    probeTenantEndpoint
} from '../../../../../../ai/services/fleet/FleetTenantService.mjs'
import FleetRegistryService       from '../../../../../../ai/services/fleet/FleetRegistryService.mjs'
import FleetControlBridge         from '../../../../../../ai/services/fleet/FleetControlBridge.mjs'
import {dispatchFleetRequest}     from '../../../../../../ai/services/fleet/dispatchFleetRequest.mjs'
import {FLEET_CREDENTIAL_METHODS} from '../../../../../../ai/services/fleet/fleetLaunchContract.mjs'
import {
    createFleetWireOffer,
    createFleetWireRequest,
    FLEET_WIRE_METHODS,
    FLEET_WIRE_RESPONSE_STATES
} from '../../../../../../src/fleet/contract/wire.mjs'

const PAT = 'glpat-SUPER-SECRET-tenant-credential-42'

let sequence = 0, tmpDir

/**
 * Self-test for the remote-tenant connect surface — the design-partner entry. The binding security
 * contract: the tenant PAT rides IN, authenticates the probe, persists ONLY encrypted (AES-256-GCM,
 * 0600), and is never echoed by any return value, any public store file, or any wire-reachable
 * method. Fail-closed everywhere: bad URLs, URL-embedded credentials, rejected bearers, and
 * unreachable endpoints all yield controlled rejected outcomes with no descriptor persisted.
 */
test.describe.serial('Neo.ai.services.fleet.FleetTenantService — connectTenant', () => {
    test.beforeEach(() => {
        sequence++
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-tenant-${sequence}-`))
        FleetTenantService.dataDir = tmpDir
        FleetRegistryService.dataDir = tmpDir
    })

    test.afterEach(() => {
        FleetTenantService.dataDir = null
        FleetTenantService.probeFn = null
        FleetRegistryService.dataDir = null
        fs.rmSync(tmpDir, {force: true, recursive: true})
    })

    test('both storage owners consume the one AiConfig Fleet root when no test override is active', () => {
        const
            configuredRoot = path.join(tmpDir, 'configured-fleet-root'),
            resolverPath   = path.resolve('test/playwright/configTemplateResolver.mjs'),
            neoPath        = import.meta.resolve('neo.mjs/src/Neo.mjs'),
            corePath       = import.meta.resolve('neo.mjs/src/core/_export.mjs'),
            registryPath   = path.resolve('ai/services/fleet/FleetRegistryService.mjs'),
            tenantPath     = path.resolve('ai/services/fleet/FleetTenantService.mjs'),
            script         = [
                `import ${JSON.stringify(resolverPath)};`,
                `import ${JSON.stringify(neoPath)};`,
                `import ${JSON.stringify(corePath)};`,
                `const {default: Registry} = await import(${JSON.stringify(registryPath)});`,
                `const {default: Tenant} = await import(${JSON.stringify(tenantPath)});`,
                'process.stdout.write(JSON.stringify({registry: Registry.getDataDir(), tenant: Tenant.getDataDir()}));'
            ].join('\n'),
            output         = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
                cwd     : process.cwd(),
                encoding: 'utf8',
                env     : {...process.env, NEO_FLEET_DATA_DIR: configuredRoot}
            }),
            resolved       = JSON.parse(output.trim().split('\n').at(-1))

        expect(resolved).toEqual({
            registry: configuredRoot,
            tenant  : configuredRoot
        })
    })

    test('a successful connect returns the PUBLIC descriptor: endpoint, connected status, cloud-tenant posture — no credential', async () => {
        FleetTenantService.probeFn = async () => ({ok: true, status: 200})

        const result = await FleetTenantService.connectTenant({tenantUrl: 'https://tenant.example.com/agentos/', credential: PAT})

        expect(result).toMatchObject({
            endpoint       : 'https://tenant.example.com/agentos',
            status         : 'connected',
            deploymentClass: 'cloud-tenant'
        })
        expect(result.id).toContain('tenant.example.com')
        expect(typeof result.connectedAt).toBe('string')
        expect(JSON.stringify(result)).not.toContain(PAT)
    })

    test('the PAT is never echoed: not in listTenants, not in the public store file — only in the encrypted store, decryptable Brain-side', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        const {id} = await FleetTenantService.connectTenant({tenantUrl: 'https://tenant.example.com', credential: PAT})

        expect(JSON.stringify(FleetTenantService.listTenants())).not.toContain(PAT)

        const publicStore = fs.readFileSync(path.join(tmpDir, 'tenants.json'), 'utf8')
        expect(publicStore).not.toContain(PAT)

        const encryptedStore = fs.readFileSync(path.join(tmpDir, 'tenant-credentials.enc'))
        expect(encryptedStore.includes(Buffer.from(PAT))).toBe(false)

        // The Brain-internal read (NOT wire-reachable) round-trips the credential for the transport.
        expect(FleetTenantService.getCredential(id)).toBe(PAT)
    })

    test('listTenants curates the public descriptor fields even when a legacy row carries secret-shaped extras', () => {
        fs.writeFileSync(path.join(tmpDir, 'tenants.json'), JSON.stringify({
            legacy: {
                id             : 'legacy',
                endpoint       : 'https://tenant.example.com',
                status         : 'connected',
                deploymentClass: 'cloud-tenant',
                connectedAt    : '2026-07-27T00:00:00.000Z',
                credential     : PAT,
                token          : 'legacy-token',
                arbitrary      : 'not-public'
            }
        }))

        expect(FleetTenantService.listTenants()).toEqual([{
            id             : 'legacy',
            endpoint       : 'https://tenant.example.com',
            status         : 'connected',
            deploymentClass: 'cloud-tenant',
            connectedAt    : '2026-07-27T00:00:00.000Z'
        }])
        expect(JSON.stringify(FleetTenantService.listTenants())).not.toContain(PAT)
        expect(JSON.stringify(FleetTenantService.listTenants())).not.toContain('legacy-token')
    })

    test('registry-first and tenant-first stores share one raw key without invalidating either credential class', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        FleetRegistryService.defineAgent({
            id            : 'registry-first',
            githubUsername: 'neo-gpt',
            harnessType   : 'codex',
            credential    : 'ghp_registry_first'
        })

        const registryKey = fs.readFileSync(path.join(tmpDir, 'fleet.key'))
        expect(registryKey).toHaveLength(32)

        const firstTenant = await FleetTenantService.connectTenant({
            tenantUrl : 'https://first.example.com',
            credential: 'plane_first'
        })

        expect(fs.readFileSync(path.join(tmpDir, 'fleet.key'))).toEqual(registryKey)
        expect(FleetRegistryService.resolveCredential('registry-first')).toBe('ghp_registry_first')
        expect(FleetTenantService.getCredential(firstTenant.id)).toBe('plane_first')

        const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-tenant-first-${sequence}-`))

        try {
            FleetTenantService.dataDir = secondDir
            FleetRegistryService.dataDir = secondDir

            const secondTenant = await FleetTenantService.connectTenant({
                tenantUrl : 'https://second.example.com',
                credential: 'plane_second'
            })
            const tenantKey = fs.readFileSync(path.join(secondDir, 'fleet.key'))

            expect(tenantKey).toHaveLength(32)

            FleetRegistryService.defineAgent({
                id            : 'tenant-first',
                githubUsername: 'neo-opus-vega',
                harnessType   : 'codex',
                credential    : 'ghp_tenant_first'
            })

            expect(fs.readFileSync(path.join(secondDir, 'fleet.key'))).toEqual(tenantKey)
            expect(FleetTenantService.getCredential(secondTenant.id)).toBe('plane_second')
            expect(FleetRegistryService.resolveCredential('tenant-first')).toBe('ghp_tenant_first')
        } finally {
            FleetTenantService.dataDir = tmpDir
            FleetRegistryService.dataDir = tmpDir
            fs.rmSync(secondDir, {force: true, recursive: true})
        }
    })

    test('a legacy ASCII-hex fleet.key migrates atomically to raw bytes without stranding tenant ciphertext', async () => {
        const
            key         = crypto.randomBytes(32),
            keyFile     = path.join(tmpDir, 'fleet.key'),
            previousEnv = process.env.NEO_FLEET_SECRET_KEY;

        FleetTenantService.probeFn = async () => ({ok: true})
        process.env.NEO_FLEET_SECRET_KEY = key.toString('hex')

        try {
            const tenant = await FleetTenantService.connectTenant({
                tenantUrl : 'https://legacy.example.com',
                credential: 'plane_legacy'
            })

            delete process.env.NEO_FLEET_SECRET_KEY
            fs.writeFileSync(keyFile, key.toString('hex'), {mode: 0o600})

            expect(FleetTenantService.getCredential(tenant.id)).toBe('plane_legacy')
            expect(fs.readFileSync(keyFile)).toEqual(key)
            expect(fs.readdirSync(tmpDir).filter(name => name.includes('fleet.key.') && name.endsWith('.tmp'))).toEqual([])
        } finally {
            if (previousEnv === undefined) {
                delete process.env.NEO_FLEET_SECRET_KEY
            } else {
                process.env.NEO_FLEET_SECRET_KEY = previousEnv
            }
        }
    })

    test('a malformed existing fleet.key fails loud and is never overwritten', () => {
        const
            keyFile   = path.join(tmpDir, 'fleet.key'),
            malformed = Buffer.from('x'.repeat(64));

        fs.writeFileSync(keyFile, malformed, {mode: 0o600})

        expect(() => FleetTenantService.getKey()).toThrow(/fleet\.key must contain exactly 32 raw bytes/)
        expect(() => FleetRegistryService.getKey()).toThrow(/fleet\.key must contain exactly 32 raw bytes/)
        expect(fs.readFileSync(keyFile)).toEqual(malformed)
    })

    test('the probe receives the credential exactly once, for authentication only', async () => {
        const probeCalls = []
        FleetTenantService.probeFn = async args => { probeCalls.push(args); return {ok: true} }

        await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT})

        expect(probeCalls).toEqual([{endpoint: 'https://t.example.com', credential: PAT}])
    })

    test('fail-closed URL validation: malformed, non-http(s), and credential-embedded URLs all reject without persisting', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        expect(await FleetTenantService.connectTenant({tenantUrl: 'not a url', credential: PAT})).toMatchObject({status: 'rejected'})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'ftp://x.example.com', credential: PAT})).toMatchObject({status: 'rejected'})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'https://user:pass@x.example.com', credential: PAT})).toMatchObject({status: 'rejected'})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'https://ok.example.com'})).toMatchObject({status: 'rejected', reason: 'credential (plane provider bearer) is required'})

        expect(FleetTenantService.listTenants()).toEqual([])
        expect(fs.existsSync(path.join(tmpDir, 'tenant-credentials.enc'))).toBe(false)
    })

    test('a rejected bearer and an unreachable endpoint both fail closed with bounded reasons — nothing persisted', async () => {
        FleetTenantService.probeFn = async () => ({ok: false, status: 401, reason: 'tenant rejected the credential'})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT}))
            .toEqual({status: 'rejected', reason: 'tenant rejected the credential'})

        FleetTenantService.probeFn = async () => { throw new Error(`ECONNREFUSED with ${PAT} in some transport dump`) }
        const result = await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT})

        // The rejection reason is bounded and endpoint-scoped — a throwing transport can never leak
        // the credential (or internals) into the outcome.
        expect(result).toEqual({status: 'rejected', reason: 'tenant endpoint unreachable'})
        expect(FleetTenantService.listTenants()).toEqual([])
    })

    test('reconnecting the same endpoint updates the descriptor in place — one endpoint, one tenant id', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        const first  = await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: 'pat-one'}),
              second = await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com/', credential: 'pat-two'})

        expect(second.id).toBe(first.id)
        expect(FleetTenantService.listTenants()).toHaveLength(1)
        expect(FleetTenantService.getCredential(first.id)).toBe('pat-two')
    })

    test('a REMOTE plain-http endpoint is refused — the bearer must not cross a network in clear', async () => {
        const probed = []
        FleetTenantService.probeFn = async args => { probed.push(args); return {ok: true} }

        expect(await FleetTenantService.connectTenant({tenantUrl: 'http://tenant.example.com', credential: PAT}))
            .toMatchObject({status: 'rejected'})

        // Refused at validation, BEFORE the probe: the credential never reached the transport at all.
        expect(probed).toEqual([])
        expect(FleetTenantService.listTenants()).toEqual([])
    })

    test('plain http stays available for LOOPBACK development only — the bounded exception', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        for (const host of ['localhost:9000', '127.0.0.1:9000', '[::1]:9000']) {
            const result = await FleetTenantService.connectTenant({tenantUrl: `http://${host}`, credential: PAT})

            expect(result).toMatchObject({status: 'connected'})
        }

        // A neighbouring host is NOT loopback, however much it looks like one.
        expect(await FleetTenantService.connectTenant({tenantUrl: 'http://127.0.0.1.evil.example.com', credential: PAT}))
            .toMatchObject({status: 'rejected'})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'http://localhost.evil.example.com', credential: PAT}))
            .toMatchObject({status: 'rejected'})
    })

    test('a hostile probe reason NEVER reaches the caller — the failure vocabulary is closed, not sanitized', async () => {
        // The probe is a collaborator whose text the remote tenant shapes. Even handed the
        // credential verbatim plus an injection attempt, the outcome carries only our own sentence.
        FleetTenantService.probeFn = async () => ({
            ok    : false,
            status: 401,
            reason: `PAT ${PAT} rejected; contact admin@evil.example.com or run rm -rf /`
        })

        const result = await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT})

        expect(result).toEqual({status: 'rejected', reason: 'tenant rejected the credential'})
        expect(JSON.stringify(result)).not.toContain(PAT)
        expect(JSON.stringify(result)).not.toContain('evil.example.com')
        expect(JSON.stringify(result)).not.toContain('rm -rf')
    })

    test('an unmapped probe status still yields a bounded reason, never a fabricated success', async () => {
        FleetTenantService.probeFn = async () => ({ok: false, status: 503})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT}))
            .toEqual({status: 'rejected', reason: 'tenant MCP readiness failed (503)'})

        // No status at all — the probe answered ok:false and nothing else.
        FleetTenantService.probeFn = async () => ({ok: false})
        expect(await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT}))
            .toEqual({status: 'rejected', reason: 'tenant authentication failed'})
    })

    test('credential-first / descriptor-last: a failed public publish rolls the credential back and strands NO connected state', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        // Land a good tenant first, so the rollback has a prior snapshot to restore.
        const first = await FleetTenantService.connectTenant({tenantUrl: 'https://kept.example.com', credential: 'pat-kept'})

        // Now make the PUBLIC descriptor publish fail on the next connect.
        const publishAtomically = FleetTenantService.publishAtomically.bind(FleetTenantService)

        FleetTenantService.publishAtomically = (file, contents) => {
            if (file.endsWith('tenants.json')) throw new Error('disk full')
            return publishAtomically(file, contents)
        }

        try {
            const result = await FleetTenantService.connectTenant({tenantUrl: 'https://doomed.example.com', credential: 'pat-doomed'})

            expect(result).toMatchObject({status: 'rejected'})
            expect(JSON.stringify(result)).not.toContain('disk full')
        } finally {
            FleetTenantService.publishAtomically = publishAtomically
        }

        // The failed connect left NOTHING behind: no descriptor claiming connected...
        expect(FleetTenantService.listTenants().map(tenant => tenant.endpoint)).toEqual(['https://kept.example.com'])

        // ...and no orphan credential — the prior snapshot is restored intact.
        expect(FleetTenantService.getCredential(first.id)).toBe('pat-kept')
        expect(Object.values(FleetTenantService.readCredentials())).not.toContain('pat-doomed')
    })

    test('a credential-store failure returns the bounded rejection and preserves both prior stores', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        const first = await FleetTenantService.connectTenant({tenantUrl: 'https://kept.example.com', credential: 'pat-kept'})

        const descriptorBefore = fs.readFileSync(path.join(tmpDir, 'tenants.json')),
              credentialBefore = fs.readFileSync(path.join(tmpDir, 'tenant-credentials.enc'))

        const publishAtomically = FleetTenantService.publishAtomically.bind(FleetTenantService)

        FleetTenantService.publishAtomically = (file, contents) => {
            if (file.endsWith('tenant-credentials.enc')) {
                throw new Error(`credential write failed with ${PAT}`)
            }

            return publishAtomically(file, contents)
        }

        let result

        try {
            result = await FleetTenantService.connectTenant({tenantUrl: 'https://doomed.example.com', credential: 'pat-doomed'})
        } finally {
            FleetTenantService.publishAtomically = publishAtomically
        }

        expect(result).toEqual({status: 'rejected', reason: 'tenant connection could not be persisted'})
        expect(JSON.stringify(result)).not.toContain(PAT)
        expect(fs.readFileSync(path.join(tmpDir, 'tenants.json'))).toEqual(descriptorBefore)
        expect(fs.readFileSync(path.join(tmpDir, 'tenant-credentials.enc'))).toEqual(credentialBefore)
        expect(FleetTenantService.listTenants().map(tenant => tenant.endpoint)).toEqual(['https://kept.example.com'])
        expect(FleetTenantService.getCredential(first.id)).toBe('pat-kept')
        expect(Object.values(FleetTenantService.readCredentials())).not.toContain('pat-doomed')
        expect(fs.readdirSync(tmpDir).filter(name => name.includes('.tmp'))).toEqual([])
    })

    test('existing corrupt credential ciphertext aborts connect without changing either store', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        await FleetTenantService.connectTenant({
            tenantUrl : 'https://kept.example.com',
            credential: 'plane_kept'
        })

        const
            descriptorFile = path.join(tmpDir, 'tenants.json'),
            credentialFile = path.join(tmpDir, 'tenant-credentials.enc'),
            corruptBytes   = Buffer.from('intentionally-corrupt-prior-store');

        fs.writeFileSync(credentialFile, corruptBytes)

        const descriptorBefore = fs.readFileSync(descriptorFile)
        const result           = await FleetTenantService.connectTenant({
            tenantUrl : 'https://new.example.com',
            credential: 'plane_new'
        })

        expect(result).toEqual({status: 'rejected', reason: 'tenant connection could not be persisted'})
        expect(fs.readFileSync(credentialFile)).toEqual(corruptBytes)
        expect(fs.readFileSync(descriptorFile)).toEqual(descriptorBefore)
    })

    test('existing corrupt descriptor JSON aborts connect before credential mutation', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        await FleetTenantService.connectTenant({
            tenantUrl : 'https://kept.example.com',
            credential: 'plane_kept'
        })

        const
            descriptorFile   = path.join(tmpDir, 'tenants.json'),
            credentialFile   = path.join(tmpDir, 'tenant-credentials.enc'),
            corruptBytes     = Buffer.from('{not-valid-json'),
            credentialBefore = fs.readFileSync(credentialFile);

        fs.writeFileSync(descriptorFile, corruptBytes)

        const result = await FleetTenantService.connectTenant({
            tenantUrl : 'https://new.example.com',
            credential: 'plane_new'
        })

        expect(result).toEqual({status: 'rejected', reason: 'tenant connection could not be persisted'})
        expect(fs.readFileSync(descriptorFile)).toEqual(corruptBytes)
        expect(fs.readFileSync(credentialFile)).toEqual(credentialBefore)
    })

    test('valid JSON arrays are not mutation records for either tenant store', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        for (const target of ['descriptors', 'credentials']) {
            const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-non-record-${target}-`))

            try {
                FleetTenantService.dataDir = isolatedDir
                FleetRegistryService.dataDir = isolatedDir

                await FleetTenantService.connectTenant({
                    tenantUrl : 'https://kept.example.com',
                    credential: 'plane_kept'
                })

                const
                    descriptorFile = path.join(isolatedDir, 'tenants.json'),
                    credentialFile = path.join(isolatedDir, 'tenant-credentials.enc');

                if (target === 'descriptors') {
                    fs.writeFileSync(descriptorFile, '[]')
                } else {
                    fs.writeFileSync(credentialFile, FleetTenantService.encrypt('[]'))
                }

                const
                    descriptorBefore = fs.readFileSync(descriptorFile),
                    credentialBefore = fs.readFileSync(credentialFile),
                    result           = await FleetTenantService.connectTenant({
                        tenantUrl : 'https://new.example.com',
                        credential: 'plane_new'
                    });

                expect(result, target).toEqual({
                    status: 'rejected',
                    reason: 'tenant connection could not be persisted'
                })
                expect(fs.readFileSync(descriptorFile), target).toEqual(descriptorBefore)
                expect(fs.readFileSync(credentialFile), target).toEqual(credentialBefore)
            } finally {
                FleetTenantService.dataDir = tmpDir
                FleetRegistryService.dataDir = tmpDir
                fs.rmSync(isolatedDir, {force: true, recursive: true})
            }
        }
    })

    test('publication is atomic and leaves no temp files behind', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        await FleetTenantService.connectTenant({tenantUrl: 'https://t.example.com', credential: PAT})

        expect(fs.readdirSync(tmpDir).filter(name => name.includes('.tmp'))).toEqual([])
    })

    test('the default probe completes the negotiated MCP handshake on both routes and closes sessions', async () => {
        const
            calls         = [],
            originalFetch = globalThis.fetch

        globalThis.fetch = async (url, options) => {
            calls.push({url, options})

            const request = options.body ? JSON.parse(options.body) : null

            return {
                ok     : true,
                status : 200,
                headers: {
                    get: key => key === 'mcp-session-id' && request?.method === 'initialize'
                        ? `session-${url.includes('/mc/') ? 'mc' : 'kb'}`
                        : null
                },
                text: async () => request?.method === 'initialize'
                    ? JSON.stringify({
                        jsonrpc: '2.0',
                        id     : request.id,
                        result : {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'test', version: '1'}}
                    })
                    : ''
            }
        }

        let result

        try {
            result = await probeTenantEndpoint({
                endpoint  : 'https://tenant.example.com/agentos',
                credential: PAT
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(result).toEqual({
            ok       : true,
            status   : 200,
            resources: {
                'memory-core'   : {ok: true, status: 200},
                'knowledge-base': {ok: true, status: 200}
            }
        })

        const
            posts       = calls.filter(call => call.options.method === 'POST'),
            initializes = posts.filter(call => JSON.parse(call.options.body).method === 'initialize'),
            initialized = posts.filter(call => JSON.parse(call.options.body).method === 'notifications/initialized');

        expect(initializes.map(call => call.url).sort()).toEqual([
            'https://tenant.example.com/agentos/kb/mcp',
            'https://tenant.example.com/agentos/mc/mcp'
        ])

        initializes.forEach(call => {
            expect(call.options.headers.Authorization).toBe(`Bearer ${PAT}`)
            expect(call.options.headers.Accept).toBe('application/json, text/event-stream')
            expect(call.options.headers['Content-Type']).toBe('application/json')
            expect(JSON.parse(call.options.body)).toMatchObject({
                jsonrpc: '2.0',
                method : 'initialize',
                params : {
                    protocolVersion: '2024-11-05',
                    capabilities   : {},
                    clientInfo     : {name: 'neo-fleet-readiness', version: '1'}
                }
            })
        })
        expect(initialized.map(call => ({
            url            : call.url,
            protocolVersion: call.options.headers['mcp-protocol-version'],
            sessionId      : call.options.headers['mcp-session-id']
        })).sort((a, b) => a.url.localeCompare(b.url))).toEqual([
            {
                url            : 'https://tenant.example.com/agentos/kb/mcp',
                protocolVersion: '2025-06-18',
                sessionId      : 'session-kb'
            },
            {
                url            : 'https://tenant.example.com/agentos/mc/mcp',
                protocolVersion: '2025-06-18',
                sessionId      : 'session-mc'
            }
        ])

        expect(calls.filter(call => call.options.method === 'DELETE').map(call => ({
            url            : call.url,
            protocolVersion: call.options.headers['mcp-protocol-version'],
            sessionId      : call.options.headers['mcp-session-id']
        })).sort((a, b) => a.url.localeCompare(b.url))).toEqual([
            {
                url            : 'https://tenant.example.com/agentos/kb/mcp',
                protocolVersion: '2025-06-18',
                sessionId      : 'session-kb'
            },
            {
                url            : 'https://tenant.example.com/agentos/mc/mcp',
                protocolVersion: '2025-06-18',
                sessionId      : 'session-mc'
            }
        ])
        expect(calls.some(call => call.url.includes('/health'))).toBe(false)
    })

    test('the default probe rejects mismatched or incomplete InitializeResult envelopes and still closes sessions', async () => {
        const
            originalFetch = globalThis.fetch,
            variants      = [
                {
                    jsonrpc: '2.0',
                    id     : 99,
                    result : {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'test', version: '1'}}
                },
                {
                    jsonrpc: '2.0',
                    id     : 1,
                    result : {protocolVersion: '2025-06-18', capabilities: {}}
                },
                {
                    jsonrpc: '2.0',
                    id     : 1,
                    result : {protocolVersion: '2025-06-18', capabilities: [], serverInfo: {name: 'test', version: '1'}}
                },
                {
                    jsonrpc: '2.0',
                    id     : 1,
                    result : {protocolVersion: 'bogus', capabilities: {}, serverInfo: {name: 'test', version: '1'}}
                }
            ];

        try {
            for (const envelope of variants) {
                const calls = []

                globalThis.fetch = async (url, options) => {
                    calls.push({url, options})

                    return {
                        ok     : true,
                        status : 200,
                        headers: {get: key => key === 'mcp-session-id' ? `session-${url.includes('/mc/') ? 'mc' : 'kb'}` : null},
                        text   : async () => options.method === 'DELETE' ? '' : JSON.stringify(envelope)
                    }
                }

                const result = await probeTenantEndpoint({
                    endpoint  : 'https://tenant.example.com',
                    credential: PAT
                })

                expect(result.ok).toBe(false)
                expect(calls.filter(call => call.options.method === 'DELETE')).toHaveLength(2)
                expect(calls.some(call => {
                    if (!call.options.body) return false

                    return JSON.parse(call.options.body).method === 'notifications/initialized'
                })).toBe(false)
            }
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('a post-initialize failure always closes the allocated MCP session', async () => {
        const
            calls         = [],
            originalFetch = globalThis.fetch

        globalThis.fetch = async (url, options) => {
            calls.push({url, options})

            const request = options.body ? JSON.parse(options.body) : null

            if (request?.method === 'notifications/initialized' && url.includes('/mc/')) {
                throw new Error('notification transport failed')
            }

            return {
                ok     : true,
                status : 200,
                headers: {
                    get: key => key === 'mcp-session-id' && request?.method === 'initialize'
                        ? `session-${url.includes('/mc/') ? 'mc' : 'kb'}`
                        : null
                },
                text: async () => request?.method === 'initialize'
                    ? JSON.stringify({
                        jsonrpc: '2.0',
                        id     : 1,
                        result : {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'test', version: '1'}}
                    })
                    : ''
            }
        }

        try {
            const result = await probeTenantEndpoint({
                endpoint  : 'https://tenant.example.com',
                credential: PAT
            })

            expect(result.ok).toBe(false)
            expect(result.resources['memory-core']).toEqual({ok: false})
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(calls.filter(call =>
            call.options.method === 'DELETE' &&
            call.options.headers['mcp-session-id'] === 'session-mc'
        )).toHaveLength(1)
    })

    test('the default seat probe proves the request-bound Memory Core identity and rejects a wrong-but-valid subject', async () => {
        const
            calls         = [],
            originalFetch = globalThis.fetch

        let observedIdentity = '@neo-gpt'

        globalThis.fetch = async (url, options) => {
            calls.push({url, options})

            const request = options.body ? JSON.parse(options.body) : null

            if (request?.method === 'tools/call') {
                return {
                    ok     : true,
                    status : 200,
                    headers: {get: () => null},
                    text   : async () => JSON.stringify({
                        jsonrpc: '2.0',
                        id     : 2,
                        result : {
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    identity       : observedIdentity,
                                    capabilities   : [],
                                    grantedToOthers: []
                                })
                            }]
                        }
                    })
                }
            }

            return {
                ok     : true,
                status : 200,
                headers: {
                    get: key => key === 'mcp-session-id' && request?.method === 'initialize'
                        ? `session-${url.includes('/mc/') ? 'mc' : 'kb'}`
                        : null
                },
                text: async () => JSON.stringify({
                    jsonrpc: '2.0',
                    id     : request?.id,
                    result : {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'test', version: '1'}}
                })
            }
        }

        try {
            const accepted = await probeTenantEndpoint({
                endpoint        : 'https://tenant.example.com',
                credential      : PAT,
                expectedIdentity: '@neo-gpt'
            })

            expect(accepted.ok).toBe(true)
            expect(accepted.resources['memory-core'])
                .toEqual({ok: true, status: 200, identity: '@neo-gpt'})

            observedIdentity = '@another-valid-user'

            const rejected = await probeTenantEndpoint({
                endpoint        : 'https://tenant.example.com',
                credential      : PAT,
                expectedIdentity: '@neo-gpt'
            })

            expect(rejected.ok).toBe(false)
            // the other identity is named as such, never carried
            expect(rejected.resources['memory-core'])
                .toEqual({ok: false, status: 200, identity: null, anotherIdentity: true})
        } finally {
            globalThis.fetch = originalFetch
        }

        const identityCalls = calls.filter(call => {
            if (!call.options.body) return false

            return JSON.parse(call.options.body).method === 'tools/call'
        })

        expect(identityCalls).toHaveLength(2)
        identityCalls.forEach(call => {
            expect(call.url).toBe('https://tenant.example.com/mc/mcp')
            expect(call.options.headers.Authorization).toBe(`Bearer ${PAT}`)
            expect(call.options.headers['mcp-session-id']).toBe('session-mc')
            expect(call.options.headers['mcp-protocol-version']).toBe('2025-06-18')
            expect(JSON.parse(call.options.body)).toMatchObject({
                method: 'tools/call',
                params: {name: 'list_permissions', arguments: {}}
            })
        })

        const initializedCalls = calls.filter(call => {
            if (!call.options.body) return false

            return JSON.parse(call.options.body).method === 'notifications/initialized'
        })

        expect(initializedCalls).toHaveLength(4)
        initializedCalls.forEach(call => {
            expect(call.options.headers['mcp-protocol-version']).toBe('2025-06-18')
            expect(call.options.headers['mcp-session-id']).toMatch(/^session-(mc|kb)$/)
        })
    })

    test('the default readiness probe fails when either plane fails and returns no remote prose', async () => {
        const
            originalFetch = globalThis.fetch,
            remoteText    = `remote body containing ${PAT}`

        globalThis.fetch = async (url, options) => {
            const request = options.body ? JSON.parse(options.body) : null

            return {
                ok     : !url.includes('/kb/'),
                status : url.includes('/kb/') ? 503 : 200,
                headers: {get: () => null},
                text   : async () => url.includes('/kb/')
                    ? remoteText
                    : JSON.stringify({
                        jsonrpc: '2.0',
                        id     : request?.id,
                        result : {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'test', version: '1'}}
                    })
            }
        }

        let result

        try {
            result = await probeTenantEndpoint({
                endpoint  : 'https://tenant.example.com',
                credential: PAT
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(result.ok).toBe(false)
        expect(result.status).toBe(503)
        expect(result.resources['memory-core']).toEqual({ok: true, status: 200})
        expect(result.resources['knowledge-base']).toEqual({ok: false, status: 503})
        expect(JSON.stringify(result)).not.toContain(PAT)
        expect(JSON.stringify(result)).not.toContain(remoteText)
    })

    test('an HTTP 200 without an MCP initialize result is not readiness', async () => {
        const originalFetch = globalThis.fetch

        globalThis.fetch = async () => ({
            ok     : true,
            status : 200,
            headers: {get: () => null},
            text   : async () => '<html>proxy fallback</html>'
        })

        try {
            const result = await probeTenantEndpoint({
                endpoint  : 'https://tenant.example.com',
                credential: PAT
            })

            expect(result.ok).toBe(false)
            expect(result.resources['memory-core']).toEqual({ok: false, status: 200})
            expect(result.resources['knowledge-base']).toEqual({ok: false, status: 200})
            expect(JSON.stringify(result)).not.toContain('proxy fallback')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('resource resolution accepts only a canonical connected descriptor and never includes a credential', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        const connected = await FleetTenantService.connectTenant({
            tenantUrl : 'https://tenant.example.com/agentos',
            credential: PAT
        })
        const resolved = FleetTenantService.resolveMcpResources(connected.id)

        expect(resolved).toEqual({
            tenantId : connected.id,
            endpoint : 'https://tenant.example.com/agentos',
            resources: {
                'memory-core'   : {url: 'https://tenant.example.com/agentos/mc/mcp'},
                'knowledge-base': {url: 'https://tenant.example.com/agentos/kb/mcp'}
            }
        })
        expect(JSON.stringify(resolved)).not.toContain(PAT)
        expect(FleetTenantService.resolveMcpCredential(connected.id)).toBe(PAT)

        const descriptorPath = path.join(tmpDir, 'tenants.json')
        fs.writeFileSync(descriptorPath, JSON.stringify({
            [connected.id]: {...connected, endpoint: 'https://tenant.example.com/agentos/'}
        }))

        expect(FleetTenantService.resolveMcpResources(connected.id)).toBeNull()
        expect(FleetTenantService.resolveMcpCredential(connected.id)).toBeNull()

        fs.writeFileSync(descriptorPath, JSON.stringify({
            [connected.id]: {...connected, status: 'disconnected'}
        }))

        expect(FleetTenantService.resolveMcpResources(connected.id)).toBeNull()
        expect(FleetTenantService.resolveMcpCredential(connected.id)).toBeNull()
        expect(FleetTenantService.resolveMcpResources('missing')).toBeNull()
        expect(FleetTenantService.resolveMcpCredential('missing')).toBeNull()
    })

    test('seat readiness proves the exact canonical identity and rejects empty or mismatched inputs', async () => {
        FleetTenantService.probeFn = async () => ({ok: true})

        const connected = await FleetTenantService.connectTenant({
            tenantUrl : 'https://tenant.example.com',
            credential: 'tenant-connection-pat'
        })
        const calls = []

        FleetTenantService.probeFn = async args => {
            calls.push(args)

            return {
                ok       : true,
                status   : 200,
                resources: {
                    'memory-core'   : {ok: true, status: 200, identity: '@neo-gpt'},
                    'knowledge-base': {ok: true, status: 200}
                }
            }
        }

        await expect(FleetTenantService.probeSeatCredential({
            tenantId        : connected.id,
            credential      : PAT,
            expectedIdentity: '@neo-gpt'
        })).resolves.toEqual({
            ok       : true,
            status   : 200,
            resources: {
                'memory-core'   : {ok: true, status: 200, identity: '@neo-gpt'},
                'knowledge-base': {ok: true, status: 200}
            }
        })
        expect(calls).toEqual([{
            endpoint        : 'https://tenant.example.com',
            credential      : PAT,
            expectedIdentity: '@neo-gpt'
        }])

        FleetTenantService.probeFn = async () => ({
            ok       : true,
            status   : 200,
            resources: {
                'memory-core'   : {ok: true, status: 200, identity: '@another-valid-user'},
                'knowledge-base': {ok: true, status: 200}
            }
        })
        await expect(FleetTenantService.probeSeatCredential({
            tenantId        : connected.id,
            credential      : PAT,
            expectedIdentity: '@neo-gpt'
        })).resolves.toMatchObject({ok: false})

        await expect(FleetTenantService.probeSeatCredential({
            tenantId: connected.id, credential: '   ', expectedIdentity: '@neo-gpt'
        })).resolves.toEqual({ok: false})
        await expect(FleetTenantService.probeSeatCredential({
            tenantId: 'missing', credential: PAT, expectedIdentity: '@neo-gpt'
        })).resolves.toEqual({ok: false})
        await expect(FleetTenantService.probeSeatCredential({
            tenantId: connected.id, credential: PAT
        })).resolves.toEqual({ok: false})
        expect(calls).toHaveLength(1)
    })
})

test.describe.serial('FleetControlBridge + wire — the remote-tenant surface', () => {
    test.afterEach(() => {
        FleetControlBridge.tenantService = null
        FleetControlBridge.manager       = null
    })

    test('a seat\'s plane credential rides in as a credential-bearing verb to the Fleet, and nothing reads it back out', async () => {
        const calls = []

        FleetControlBridge.manager = {
            setPlaneCredential: async payload => { calls.push(payload); return {status: 'stored', endpoint: 'http://127.0.0.1:3102', agentId: 'a'} }
        }

        expect(FLEET_CREDENTIAL_METHODS).toContain('setPlaneCredential')
        await expect(dispatchFleetRequest(createFleetWireRequest('setPlaneCredential', {id: 'a', credential: 'x'}))).resolves
            .toMatchObject({ok: true, result: {status: 'stored', endpoint: 'http://127.0.0.1:3102', agentId: 'a'}, state: FLEET_WIRE_RESPONSE_STATES.ok})
        expect(calls).toEqual([{id: 'a', credential: 'x'}])

        for (const reader of ['storeSeatPlaneCredential', 'resolveSeatPlaneCredential', 'probeSeatPlaneCredential']) {
            expect(FLEET_WIRE_METHODS).not.toContain(reader)
        }
    })

    test('connectTenant and listTenants delegate through the injectable tenant seam', async () => {
        const calls = []

        FleetControlBridge.tenantService = {
            connectTenant: async params => { calls.push(['connectTenant', params]); return {id: 't', status: 'connected'} },
            listTenants  : () => { calls.push(['listTenants']); return [{id: 't'}] }
        }

        await expect(FleetControlBridge.connectTenant({tenantUrl: 'https://t', credential: 'x'})).resolves.toEqual({id: 't', status: 'connected'})
        expect(FleetControlBridge.listTenants()).toEqual([{id: 't'}])
        expect(calls).toEqual([['connectTenant', {tenantUrl: 'https://t', credential: 'x'}], ['listTenants']])
    })

    test('both verbs are on the wire allowlist; the credential reader is NOT and can never be dispatched', async () => {
        expect(FLEET_WIRE_METHODS).toContain('connectTenant')
        expect(FLEET_WIRE_METHODS).toContain('listTenants')
        expect(FLEET_WIRE_METHODS).not.toContain('getCredential')
        expect(FLEET_WIRE_METHODS).not.toContain('resolveMcpCredential')

        await expect(dispatchFleetRequest({method: 'getCredential', params: 't', protocol: createFleetWireOffer()})).resolves
            .toMatchObject({
                error: "fleet: method 'getCredential' is not on the control surface",
                ok   : false,
                state: FLEET_WIRE_RESPONSE_STATES.unsupportedMethod
            })
        await expect(dispatchFleetRequest({method: 'resolveMcpCredential', params: 't', protocol: createFleetWireOffer()})).resolves
            .toMatchObject({
                error: "fleet: method 'resolveMcpCredential' is not on the control surface",
                ok   : false,
                state: FLEET_WIRE_RESPONSE_STATES.unsupportedMethod
            })
    })

    test('a connectTenant dispatched over the wire returns the fail-closed envelope on service rejection', async () => {
        FleetControlBridge.tenantService = {
            connectTenant: async () => ({status: 'rejected', reason: 'tenant rejected the credential'})
        }

        const result = await dispatchFleetRequest(createFleetWireRequest(
            'connectTenant',
            {tenantUrl: 'https://t', credential: 'bad'}
        ))

        expect(result).toMatchObject({
            ok    : true,
            result: {status: 'rejected', reason: 'tenant rejected the credential'},
            state : FLEET_WIRE_RESPONSE_STATES.ok
        })
    })
})

/**
 * One encrypted plane binding per seat. The default-plane Start may bind the seat PAT already held by
 * the registry; each row still proves one identity and one served plane. Nothing persists before that
 * proof, and the credential never returns from the service.
 * The plane that answered is stored with it, by the `plane.id` and `plane.dataRoot` it serves, and
 * every start must meet that plane again: an endpoint is only where a plane is reached.
 */
test.describe.serial('Neo.ai.services.fleet.FleetTenantService — seat plane credentials', () => {
    // `asSeatOn` is the plane answering a seat it knows; it names itself only when asked which plane it is.
    const
        PLANE    = 'http://127.0.0.1:3102',
        SERVED   = Object.freeze({id: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data'}),
        STORE    = () => path.join(tmpDir, 'seat-plane-credentials.enc'),
        asSeatOn = (mcPlane = SERVED, kbPlane = mcPlane) => async ({expectedIdentity, servedPlane}) => ({
            ok       : true,
            status   : 200,
            resources: {
                'memory-core'   : {ok: true, status: 200, identity: expectedIdentity, ...(servedPlane ? {plane: mcPlane} : {})},
                'knowledge-base': {ok: true, status: 200, ...(servedPlane ? {plane: kbPlane} : {})}
            }
        }),
        AS_SEAT  = asSeatOn()

    test.beforeEach(() => {
        sequence++
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-seat-plane-${sequence}-`))
        FleetTenantService.dataDir   = tmpDir
        FleetRegistryService.dataDir = tmpDir
    })

    test.afterEach(() => {
        FleetTenantService.dataDir   = null
        FleetTenantService.probeFn   = null
        FleetRegistryService.dataDir = null
        fs.rmSync(tmpDir, {force: true, recursive: true})
    })

    test('a credential proven to be the seat is stored encrypted with the plane that answered, resolves for that seat and plane only, and is never returned', async () => {
        FleetTenantService.probeFn = AS_SEAT

        const stored = await FleetTenantService.storeSeatPlaneCredential({planeBase: `${PLANE}/`, agentId: 'neo-gpt-sophie', identity: 'neo-gpt-sophie', credential: PAT})

        expect(stored).toEqual({status: 'stored', endpoint: PLANE, agentId: 'neo-gpt-sophie'})
        expect(JSON.stringify(stored)).not.toContain(PAT)
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie'})).toEqual({credential: PAT, plane: SERVED})
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-opus-ada'})).toBeNull()
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: 'https://elsewhere.example.com', agentId: 'neo-gpt-sophie'})).toBeNull()
        expect(fs.readFileSync(STORE()).includes(Buffer.from(PAT))).toBe(false)
        expect(fs.statSync(STORE()).mode & 0o777).toBe(0o600)
    })

    test('two seats on one plane each keep their own credential', async () => {
        FleetTenantService.probeFn = AS_SEAT

        await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: 'sophie-plane-pat'})
        await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-emmy', identity: '@neo-gpt-emmy', credential: 'emmy-plane-pat'})

        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie'}).credential).toBe('sophie-plane-pat')
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-emmy'}).credential).toBe('emmy-plane-pat')
    })

    test('a create-only binding retains an explicit credential committed while its proof awaits', async () => {
        const
            agentId  = 'neo-gpt-sophie',
            identity = '@neo-gpt-sophie',
            explicit = 'explicit-plane-pat';
        let explicitWritten = false;

        FleetTenantService.probeFn = async args => {
            if (!explicitWritten) {
                explicitWritten = true;
                await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId, identity, credential: explicit})
            }

            return AS_SEAT(args)
        };

        const result = await FleetTenantService.storeSeatPlaneCredential({
            planeBase: PLANE, agentId, identity, credential: 'registry-plane-pat', ifAbsent: true
        });

        expect(result).toEqual({status: 'stored', endpoint: PLANE, agentId});
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId})).toEqual({credential: explicit, plane: SERVED});
        expect(await FleetTenantService.probeSeatPlaneCredential({
            planeBase: PLANE, credential: explicit, expectedIdentity: identity, expectedPlane: SERVED
        })).toEqual({ok: true})

        // The explicit setter omits ifAbsent and remains an intentional rebind.
        expect(await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId, identity, credential: 'manual-rebind-pat'}))
            .toEqual({status: 'stored', endpoint: PLANE, agentId});
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId}).credential).toBe('manual-rebind-pat')
    })

    test('create-only binding preserves corrupt ciphertext and a malformed selected row', async () => {
        const
            agentId  = 'neo-gpt-sophie',
            identity = '@neo-gpt-sophie',
            params   = {planeBase: PLANE, agentId, identity, credential: 'registry-plane-pat', ifAbsent: true};

        FleetTenantService.probeFn = AS_SEAT;
        fs.writeFileSync(STORE(), 'not ciphertext', {mode: 0o600});

        const corrupt = fs.readFileSync(STORE());

        expect(await FleetTenantService.storeSeatPlaneCredential(params)).toEqual({
            status: 'rejected', reason: 'seat plane credential could not be persisted'
        });
        expect(fs.readFileSync(STORE())).toEqual(corrupt);

        // A decryptable endpoint map can still have a malformed selected seat; create-only must not
        // replace it with the registry PAT and conceal state that needs explicit repair.
        for (const selected of [
            {credential: '', plane: SERVED},
            {credential: 'existing-pat', plane: {dataRoot: SERVED.dataRoot}},
            {credential: 'existing-pat', plane: {id: SERVED.id}}
        ]) {
            const malformed = FleetTenantService.encrypt(JSON.stringify({[PLANE]: {[agentId]: selected}}));

            fs.writeFileSync(STORE(), malformed, {mode: 0o600});

            const before   = fs.readFileSync(STORE()),
                  retained = await FleetTenantService.storeSeatPlaneCredential(params);
            const resolved = FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId});

            expect(retained).toEqual({status: 'rejected', reason: 'seat plane credential could not be persisted'});
            expect(fs.readFileSync(STORE())).toEqual(before);

            if (selected.credential && selected.plane?.id) {
                expect(resolved).toEqual({credential: selected.credential, plane: selected.plane});
                await expect(FleetTenantService.probeSeatPlaneCredential({
                    planeBase: PLANE,
                    credential: selected.credential,
                    expectedIdentity: identity,
                    expectedPlane: selected.plane
                })).resolves.toMatchObject({ok: false})
            } else {
                expect(resolved).toBeNull()
            }
        }
    })

    test('another identity, a rejected bearer, an unreachable plane and a plane that does not name itself each persist nothing', async () => {
        const cases = [
            [async () => ({ok: true, status: 200, resources: {'memory-core': {ok: true, identity: '@someone-else'}, 'knowledge-base': {ok: true}}}), 'the credential resolves to another identity'],
            [async () => ({ok: false, status: 200, resources: {'memory-core': {ok: false, status: 200, identity: null, anotherIdentity: true}, 'knowledge-base': {ok: true}}}), 'the credential resolves to another identity'],
            [async () => ({ok: false, status: 401}), 'plane rejected the credential'],
            [async () => { throw new Error(`refused ${PAT}`) }, 'plane endpoint unreachable'],
            [asSeatOn(null), 'the plane did not identify itself'],
            [asSeatOn(SERVED, {...SERVED, id: 'another-plane'}), 'the Memory Core and Knowledge Base at this endpoint belong to different planes']
        ]

        for (const [probe, reason] of cases) {
            FleetTenantService.probeFn = probe

            expect(await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: PAT}))
                .toEqual({status: 'rejected', reason})
            expect(fs.existsSync(STORE())).toBe(false)
        }
    })

    test('an invalid plane, seat id or credential is refused before the probe sees anything', async () => {
        let probed = 0

        FleetTenantService.probeFn = async args => { probed++; return AS_SEAT(args) }

        for (const params of [
            {planeBase: 'http://plane.example.com', agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: PAT},
            {planeBase: PLANE, agentId: '../neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: PAT},
            {planeBase: PLANE, agentId: 'Neo-Gpt-Sophie', identity: '@neo-gpt-sophie', credential: PAT},
            {planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '', credential: PAT},
            {planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: '  '}
        ]) {
            expect((await FleetTenantService.storeSeatPlaneCredential(params)).status).toBe('rejected')
        }

        expect(probed).toBe(0)
        expect(fs.existsSync(STORE())).toBe(false)
    })

    test('a seat credential leaves the tenant bearers untouched, and a corrupt seat store refuses a write without changing it', async () => {
        FleetTenantService.probeFn = AS_SEAT

        const tenant = await FleetTenantService.connectTenant({tenantUrl: 'https://tenant.example.com', credential: 'tenant-bearer'})

        await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: PAT})
        expect(FleetTenantService.resolveMcpCredential(tenant.id)).toBe('tenant-bearer')

        fs.writeFileSync(STORE(), 'not ciphertext', {mode: 0o600})

        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie'})).toBeNull()
        expect(await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-emmy', identity: '@neo-gpt-emmy', credential: 'x'}))
            .toEqual({status: 'rejected', reason: 'seat plane credential could not be persisted'})
        expect(fs.readFileSync(STORE(), 'utf8')).toBe('not ciphertext')
    })

    test('the seat credential is never reachable over the Fleet wire', async () => {
        await expect(dispatchFleetRequest({method: 'resolveSeatPlaneCredential', params: {}, protocol: createFleetWireOffer()})).resolves
            .toMatchObject({ok: false, state: FLEET_WIRE_RESPONSE_STATES.unsupportedMethod})
    })

    test('every start proves the credential again, and a plane recreated behind the same URL does not inherit it', async () => {
        FleetTenantService.probeFn = AS_SEAT

        await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: PAT})

        const
            {credential, plane} = FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie'}),
            prove               = () => FleetTenantService.probeSeatPlaneCredential({planeBase: PLANE, credential, expectedIdentity: '@neo-gpt-sophie', expectedPlane: plane})

        expect(await prove()).toEqual({ok: true})

        // another id, and the same id over other storage
        for (const served of [{...SERVED, id: 'neo-local-recreated'}, {...SERVED, dataRoot: '/elsewhere/.neo-ai-data'}]) {
            FleetTenantService.probeFn = asSeatOn(served)

            expect(await prove()).toEqual({ok: false, reason: 'the plane at this endpoint is not the one the credential was stored for'})
        }
    })

    test('a start proof fails with the plane\'s reason, and an unproven input never reaches the probe', async () => {
        const proof = {planeBase: PLANE, credential: PAT, expectedIdentity: '@neo-gpt-sophie', expectedPlane: SERVED}

        for (const [probe, reason] of [
            [async () => ({ok: false, status: 401}), 'plane rejected the credential'],
            [async () => { throw new Error('ECONNREFUSED') }, 'plane endpoint unreachable'],
            [async () => ({ok: true, status: 200, resources: {'memory-core': {ok: true, identity: '@someone-else'}, 'knowledge-base': {ok: true}}}), 'the credential resolves to another identity'],
            [asSeatOn(null), 'the plane did not identify itself']
        ]) {
            FleetTenantService.probeFn = probe

            expect(await FleetTenantService.probeSeatPlaneCredential(proof)).toEqual({ok: false, reason})
        }

        let probed = 0

        FleetTenantService.probeFn = async args => { probed++; return AS_SEAT(args) }

        for (const override of [{expectedPlane: null}, {credential: ' '}, {expectedIdentity: ''}, {planeBase: 'http://plane.example.com'}]) {
            expect(await FleetTenantService.probeSeatPlaneCredential({...proof, ...override}))
                .toEqual({ok: false, reason: 'the seat holds no proven plane credential'})
        }

        expect(probed).toBe(0)
    })

    test('the default probe reads which plane serves each resource only when asked, and names a wrong-but-valid subject as another identity', async () => {
        const
            calls         = [],
            originalFetch = globalThis.fetch

        let served = {plane: SERVED}, identity = '@neo-gpt-sophie'

        globalThis.fetch = async (url, options) => {
            const request = options.body ? JSON.parse(options.body) : null

            calls.push({url, request, session: options.headers['mcp-session-id']})

            const result = request?.method === 'tools/call'
                ? {content: [{type: 'text', text: JSON.stringify(request.params.name === 'healthcheck' ? served : {identity})}]}
                : {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: 'test', version: '1'}}

            return {
                ok     : true,
                status : 200,
                headers: {get: key => key === 'mcp-session-id' && request?.method === 'initialize' ? `session-${url.includes('/mc/') ? 'mc' : 'kb'}` : null},
                text   : async () => JSON.stringify({jsonrpc: '2.0', id: request?.id, result})
            }
        }

        const healthchecks = () => calls.filter(call => call.request?.params?.name === 'healthcheck')

        try {
            const asked = await probeTenantEndpoint({endpoint: PLANE, credential: PAT, expectedIdentity: '@neo-gpt-sophie', servedPlane: true})

            expect(asked).toEqual({
                ok       : true,
                status   : 200,
                resources: {
                    'memory-core'   : {ok: true, status: 200, identity: '@neo-gpt-sophie', plane: SERVED},
                    'knowledge-base': {ok: true, status: 200, plane: SERVED}
                }
            })
            // one healthcheck per resource, inside that resource's own session
            expect(healthchecks().map(call => [call.url, call.session]).sort())
                .toEqual([[`${PLANE}/kb/mcp`, 'session-kb'], [`${PLANE}/mc/mcp`, 'session-mc']])

            const unasked = await probeTenantEndpoint({endpoint: PLANE, credential: PAT, expectedIdentity: '@neo-gpt-sophie'})

            expect(unasked.resources['memory-core']).toEqual({ok: true, status: 200, identity: '@neo-gpt-sophie'})
            expect(healthchecks()).toHaveLength(2)

            // a server that names no plane is no plane, and readiness is still decided by readiness alone
            served = {status: 'healthy'}

            const unnamed = await probeTenantEndpoint({endpoint: PLANE, credential: PAT, servedPlane: true})

            expect(unnamed.ok).toBe(true)
            expect(unnamed.resources['knowledge-base'].plane).toBeNull()

            // the store end to end through the default probe: the plane's other subject is named as such
            served   = {plane: SERVED}
            identity = '@someone-else'

            expect(await FleetTenantService.storeSeatPlaneCredential({planeBase: PLANE, agentId: 'neo-gpt-sophie', identity: '@neo-gpt-sophie', credential: PAT}))
                .toEqual({status: 'rejected', reason: 'the credential resolves to another identity'})
            expect(fs.existsSync(STORE())).toBe(false)
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})
