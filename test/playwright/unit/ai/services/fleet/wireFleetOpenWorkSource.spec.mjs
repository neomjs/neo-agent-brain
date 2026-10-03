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
    fileStore,
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

    test('a server whose seats have no readable PAT still wires, and its pulse names each seat and the next step', async () => {
        const
            dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wire-')),
            bridge  = {};

        try {
            const wired = wireFleetOpenWorkSource({token: null, registry: {listAgents: () => definitions, getDataDir: () => dataDir, resolveCredential: () => null}, bridge, pulseMs: 3600000});

            await wired.producer.pulse();
            wired.stop();

            expect(bridge.openWorkSource).toBeDefined();
            expect(wired.producer.getState()).toMatchObject({
                coverage: 'unavailable',
                reason  : '@neo-opus-ada, @lab-seat, @idle-seat have no readable PAT: connect again with a current token for each'
            });
            expect(JSON.stringify(wired.producer.getState())).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/)
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
    });

    test('with no token in the environment, each seat reads with its own PAT from the credential store (#823)', async () => {
        const
            dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-wire-')),
            tokens  = [],
            node    = {
                number: 7, headRefOid: 'a1', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', isDraft: false,
                body: 'Authored by Ada (Claude).', author: {login: 'neo-opus-ada'}, repository: {nameWithOwner: 'acme/app'},
                reviewRequests: {pageInfo: {hasNextPage: false}, nodes: []}, latestReviews: {pageInfo: {hasNextPage: false}, nodes: []},
                latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: []}, commits: {nodes: [{commit: {oid: 'a1', statusCheckRollup: {state: 'SUCCESS'}}}]}
            },
            createQuery = token => async (text, {query: search}) => {
                tokens.push([token, search.match(/(?:author|review-requested):(\S+)/)[1]]);
                return {rateLimit: {cost: 1}, search: {pageInfo: {hasNextPage: false}, nodes: token === 'pat-ada' && search.includes('author:neo-opus-ada') ? [node] : []}}
            },
            registry = {listAgents: () => definitions, getDataDir: () => dataDir, resolveCredential: id => id === 'ada' ? 'pat-ada' : null};

        try {
            const wired = wireFleetOpenWorkSource({registry, bridge: {}, createQuery, pulseMs: 3600000});

            await wired.producer.pulse();
            wired.stop();

            expect(Object.keys(wired.producer.getState().snapshot.rows)).toEqual(['acme/app#7']);
            // every search ran as the seat whose work it reads
            expect([...new Set(tokens.map(([token, login]) => `${token}:${login}`))]).toEqual(['pat-ada:neo-opus-ada']);
            expect(wired.producer.getState().reason).toBe('@lab-seat, @idle-seat have no readable PAT: connect again with a current token for each');

            // an explicit override is what every seat reads with
            const overridden = wireFleetOpenWorkSource({token: 'override', registry: {...registry, getDataDir: () => fs.mkdtempSync(path.join(dataDir, 'o-'))}, bridge: {}, createQuery, pulseMs: 3600000});

            tokens.length = 0;
            await overridden.producer.pulse();
            overridden.stop();

            expect([...new Set(tokens.map(([token]) => token))]).toEqual(['override'])
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
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

    test('the served read names each pull request by the title the snapshot query returns', async () => {
        const
            dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-title-')),
            pr      = {
                number                  : 12,
                title                   : 'feat: the pane reads open work',
                isDraft                 : false,
                headRefOid              : 'c3',
                reviewDecision          : 'REVIEW_REQUIRED',
                mergeable               : 'MERGEABLE',
                body                    : 'Authored by Ada.',
                author                  : {login: 'neo-opus-ada'},
                repository              : {nameWithOwner: 'acme/app'},
                reviewRequests          : {pageInfo: {hasNextPage: false}, nodes: []},
                latestReviews           : {pageInfo: {hasNextPage: false}, nodes: []},
                latestOpinionatedReviews: {pageInfo: {hasNextPage: false}, nodes: []},
                commits                 : {nodes: [{commit: {oid: 'c3', statusCheckRollup: {state: 'FAILURE'}}}]}
            },
            query   = async (text, {query: search}) => ({rateLimit: {cost: 1}, search: {pageInfo: {hasNextPage: false}, nodes: search.includes('is:open') ? [pr] : []}}),
            bridge  = {};

        try {
            const wired = wireFleetOpenWorkSource({registry: {listAgents: () => definitions, getDataDir: () => dataDir}, bridge, query, pulseMs: 3600000});

            await wired.producer.pulse();
            wired.stop();

            expect(bridge.openWorkSource.readOpenWork().seats['@neo-opus-ada'].authored.map(({number, title}) => ({number, title})))
                .toEqual([{number: 12, title: 'feat: the pane reads open work'}])
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
    });

    test('only an absent state file is a first pulse; one that cannot be read or parsed throws', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-store-'));

        try {
            const
                file  = path.join(dataDir, 'open-work.json'),
                store = fileStore(file);

            expect(store.load()).toBeNull();

            fs.writeFileSync(file, '{"snapshot": ');
            expect(() => store.load()).toThrow(SyntaxError);

            fs.rmSync(file);
            fs.mkdirSync(file);
            expect(() => store.load()).toThrow(/EISDIR/)
        } finally {
            fs.rmSync(dataDir, {recursive: true, force: true})
        }
    });

    test('without a registry nothing is wired', () => {
        expect(wireFleetOpenWorkSource({})).toBeNull()
    });
});
