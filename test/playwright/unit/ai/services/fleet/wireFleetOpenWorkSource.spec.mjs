import {setup} from '../../../../setup.mjs';

// the wiring imports FleetControlBridge, a Neo class: the spec stands up Neo itself, never through a sibling
setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'WireFleetOpenWorkSourceTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {expect, test} from '@playwright/test';
import fs             from 'fs';
import os             from 'os';
import path           from 'path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {
    createGithubGraphqlQuery,
    githubSlugsOf,
    seatIdentities,
    wireFleetOpenWorkSource
} from '../../../../../../ai/services/fleet/wireFleetOpenWorkSource.mjs';

const definitions = [
    {id: 'ada',   githubUsername: 'neo-opus-ada', metadata: {repo: {repoSlug: 'acme/app', cloneUrl: 'https://github.com/acme/app.git'}, repos: [{repoSlug: 'acme/lib', cloneUrl: 'https://github.com/acme/lib.git'}]}},
    {id: 'lab',   githubUsername: 'lab-seat',     metadata: {repo: {repoSlug: 'group/sub/app', cloneUrl: 'https://gitlab.example.com/group/sub/app.git', forge: 'gitlab'}}},
    {id: 'empty', githubUsername: 'idle-seat',    metadata: {}}
];

test.describe('wireFleetOpenWorkSource — the producer wired into a Fleet server (#760)', () => {
    test('the scope is every GitHub repository a seat works on; a GitLab one is not GitHub\'s to read', () => {
        expect(githubSlugsOf(definitions)).toEqual(['acme/app', 'acme/lib'])
    });

    test('a login resolves from the registry first, then the roots; a social name from the roots', () => {
        const identities = seatIdentities(() => definitions, [
            {id: '@neo-gpt', name: 'Euclid', properties: {githubLogin: '@neo-gpt'}}
        ]);

        expect(identities.byLogin('lab-seat')).toBe('@lab-seat');
        expect(identities.byLogin('neo-gpt')).toBe('@neo-gpt');
        expect(identities.byLogin('stranger')).toBeNull();
        expect(identities.byName('Euclid')).toBe('@neo-gpt');
        expect(identities.byName('Nobody')).toBeNull()
    });

    test('no token, an HTTP failure or a GraphQL error throws for the producer to record; data comes back as data', async () => {
        await expect(createGithubGraphqlQuery({token: null})('{x}', {})).rejects.toThrow(/no GitHub token/);

        const answering = payload => createGithubGraphqlQuery({token: 't', fetchImpl: async () => ({ok: payload.ok ?? true, status: payload.status ?? 200, json: async () => payload.body})});

        await expect(answering({ok: false, status: 502, body: null})('{x}', {})).rejects.toThrow(/answered 502/);
        await expect(answering({body: {errors: [{message: 'rate limited'}]}})('{x}', {})).rejects.toThrow(/rate limited/);
        expect(await answering({body: {data: {search: {nodes: []}}}})('{x}', {})).toEqual({search: {nodes: []}})
    });

    test('the bridge reads the producer\'s projection, and the state file carries it across a restart', async () => {
        const
            dataDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wire-')),
            registry = {listAgents: () => definitions, getDataDir: () => dataDir},
            query    = async () => ({rateLimit: {cost: 1}, search: {pageInfo: {hasNextPage: false}, nodes: []}}),
            bridge   = {};

        try {
            const wired = wireFleetOpenWorkSource({registry, bridge, query, pulseMs: 3600000});

            await wired.producer.pulse();
            wired.stop();

            expect(bridge.openWorkSource.readOpenWork()).toMatchObject({state: 'ok', coverage: 'complete', seats: {}});
            expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'open-work.json'), 'utf8'))).toMatchObject({coverage: 'complete'});

            const restarted = wireFleetOpenWorkSource({registry, bridge: {}, query, pulseMs: 3600000});

            expect(restarted.producer.getState().observedAt).not.toBeNull();
            restarted.stop()
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
    });

    test('without a registry nothing is wired', () => {
        expect(wireFleetOpenWorkSource({})).toBeNull()
    });
});
