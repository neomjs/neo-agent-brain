import {setup} from '../../../../setup.mjs';

const appName = 'PlaneFleetClientTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect}           from '@playwright/test';
import fs                       from 'node:fs';
import path                     from 'node:path';
import {fileURLToPath}          from 'node:url';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import {createPlaneFleetClient} from '../../../../../../ai/services/fleet/planeFleetClient.mjs';
import {dispatchFleetS1Request} from '../../../../../../ai/services/fleet/fleetServerPolicy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * @summary The host relay's client of the plane's fleet surface. The fixture plane is the plane's own S1
 * policy over a stub registry, behind one HTTP exchange: the client presents the fleet-surface credential,
 * answers a refusal in the plane's words, tells an unreachable plane apart, and sends nothing without a
 * credential.
 */
test.describe('createPlaneFleetClient — the plane defines a seat first', () => {
    const
        BASE       = 'http://127.0.0.1:3102/',
        CREDENTIAL = 'fleet-surface-mint',
        DEFINITION = Object.freeze({githubUsername: 'seat-one', harnessType: 'codex', credential: 'ghp_seat'});

    function plane(context, planeBridge = {defineAgent: def => ({id: def.githubUsername, harnessType: def.harnessType})}) {
        const exchanges = [];

        return {
            exchanges,
            async fetchImpl(url, init) {
                const request = JSON.parse(init.body);

                exchanges.push({authorization: init.headers.Authorization, request, url});

                const envelope = await dispatchFleetS1Request(request, planeBridge, context);

                return {json: async () => envelope}
            }
        }
    }

    test('a define reaches <base>/fleet with the fleet-surface credential and answers the plane\'s public definition', async () => {
        const fixture = plane({ownerPrincipal: 'owner:conn-1:1001'});
        const client  = createPlaneFleetClient({baseUrl: BASE, credential: CREDENTIAL, fetchImpl: fixture.fetchImpl});

        expect(await client.defineAgent(DEFINITION)).toEqual({status: 'defined', definition: {id: 'seat-one', harnessType: 'codex'}});
        expect(fixture.exchanges).toHaveLength(1);
        expect(fixture.exchanges[0]).toMatchObject({
            authorization: `Bearer ${CREDENTIAL}`,
            request      : {method: 'defineAgent', params: DEFINITION},
            url          : 'http://127.0.0.1:3102/fleet'
        })
    });

    test('each refusal answers in the plane\'s words: the owner resolution states, and the plane registry\'s own rejection', async () => {
        for (const state of ['uninitialized', 'unregistered', 'refused', 'unavailable']) {
            const client = createPlaneFleetClient({baseUrl: BASE, credential: CREDENTIAL, fetchImpl: plane({ownerResolution: {state, reason: `the ${state} reason`}}).fetchImpl});
            const answer = await client.defineAgent(DEFINITION);

            expect(answer.status).toBe('rejected');
            expect(answer.reason).toContain(`the owner is ${state}: the ${state} reason`)
        }

        const registryRejection = {status: 'rejected', reason: "id 'seat-one' already exists; use a scoped update operation."};
        const client            = createPlaneFleetClient({
            baseUrl   : BASE,
            credential: CREDENTIAL,
            fetchImpl : plane({ownerPrincipal: 'owner:conn-1:1001'}, {defineAgent: () => registryRejection}).fetchImpl
        });

        expect(await client.defineAgent(DEFINITION)).toEqual(registryRejection)
    });

    test('an unreachable plane, or one that answers no envelope, answers unavailable', async () => {
        const refused = createPlaneFleetClient({baseUrl: BASE, credential: CREDENTIAL, fetchImpl: async () => { throw new TypeError('fetch failed') }});
        const garbled = createPlaneFleetClient({baseUrl: BASE, credential: CREDENTIAL, fetchImpl: async () => ({json: async () => { throw new SyntaxError('Unexpected token <') }})});

        for (const client of [refused, garbled]) {
            expect(await client.defineAgent(DEFINITION)).toEqual({status: 'unavailable', reason: 'the plane did not answer at http://127.0.0.1:3102/fleet'})
        }
    });

    test('with no fleet-surface credential, a define refuses with that reason and sends nothing', async () => {
        const fixture = plane({ownerPrincipal: 'owner:conn-1:1001'});
        const answer  = await createPlaneFleetClient({baseUrl: BASE, credential: '', fetchImpl: fixture.fetchImpl}).defineAgent(DEFINITION);

        expect(answer).toEqual({status: 'rejected', reason: expect.stringContaining('no fleet-surface credential is declared')});
        expect(fixture.exchanges).toEqual([])
    });

    test('an endpoint outside the secure policy refuses at construction', () => {
        for (const baseUrl of ['http://plane.example.org', 'https://user:secret@plane.example.org', 'not a url']) {
            expect(() => createPlaneFleetClient({baseUrl, credential: CREDENTIAL, fetchImpl: async () => { throw new Error('must not be called') }}))
                .toThrow(/secure|https|loopback/)
        }
    });

    test('ratchet: the dev fleet entry arms the plane fleet client with the fleet-surface credential, never the plane-MCP bearer', () => {
        const source = fs.readFileSync(path.join(repoRoot, 'ai/services/fleet/devFleetServer.mjs'), 'utf8');

        expect(source).toMatch(/FleetControlBridge\.planeFleet = createPlaneFleetClient\(\{baseUrl: planeBase, credential: planeAdmissionBearer\}\)/);
        expect(source).not.toMatch(/createPlaneFleetClient\(\{[^}]*assertFleetPlaneBearerClass/)
    })
});
