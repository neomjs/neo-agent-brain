import {setup} from '../../../../setup.mjs';
setup({appConfig: {name: 'OpenWorkCopyTest'}, neoConfig: {unitTestMode: true}});

import {test, expect}  from '@playwright/test';
import fs              from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import Neo             from 'neo.mjs/src/Neo.mjs';
import 'neo.mjs/src/core/_export.mjs';
import 'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';
import {
    ownOpenWorkOf,
    resetOpenWorkCopy,
    writeOpenWorkCopy
} from '../../../../../../ai/services/memory-core/openWorkCopyStore.mjs';

const
    root      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    NOW       = Date.parse('2026-11-13T06:00:00.000Z'),
    minutes   = count => new Date(NOW - count * 60_000).toISOString(),
    pr        = (number, extra = {}) => ({repo: 'acme/app', number, title: `change ${number}`, ci: 'green', verdict: null, stale: false,
        holder: {role: 'author', kind: 'repair-ci'}, ...extra}),
    agents    = () => true,
    publish   = (publisher, args, isAgent = agents) => writeOpenWorkCopy(publisher, {coverage: 'complete', observedAt: minutes(1), ...args}, {isAgent, now: NOW}),
    read      = (identity, now = NOW) => ownOpenWorkOf(identity, {now});

/** @summary The plane's copy of the Fleet's open-work projection: written per publisher, read per seat. */
test.describe('openWorkCopyStore', () => {
    test.beforeEach(() => resetOpenWorkCopy());
    test.afterAll(() => resetOpenWorkCopy());

    test('a seat reads its own entry with its freshness: ok, then stale past 5 minutes, then withheld past 60 (AC-1)', () => {
        publish('@operator', {tracked: ['@ada', '@grace'], seats: {'@ada': {authored: [pr(7)], reviewing: [pr(8)]}}});

        expect(read('@ada')).toMatchObject({state: 'ok', observedAt: minutes(1), coverage: 'complete', authored: [{repo: 'acme/app', number: 7}], reviewing: [{number: 8}]});
        expect(read('@grace'), 'tracked without rows reads empty').toMatchObject({state: 'ok', authored: [], reviewing: []});
        expect(read('@ada', NOW + 5 * 60_000)).toMatchObject({state: 'stale', authored: [{number: 7}]});
        expect(read('@ada', NOW + 61 * 60_000)).toEqual({state: 'unavailable', observedAt: minutes(1), reason: 'the last open-work copy is too old to show'})
    });

    test('no copy reads unavailable and an identity the copy does not track reads untracked, never empty (AC-1)', () => {
        expect(read('@ada')).toEqual({state: 'unavailable', observedAt: null, reason: 'no open-work copy has reached this plane yet'});

        publish('@operator', {tracked: ['@grace']});

        expect(read('@ada')).toEqual({state: 'untracked', observedAt: null, reason: 'the open-work copy does not track @ada'})
    });

    test('a publication replaces only its publisher\'s entries, whole; another publisher\'s entries and ages stay (AC-2)', () => {
        publish('@operator-y', {observedAt: minutes(3), tracked: ['@vega'], seats: {'@vega': {authored: [pr(1)]}}});
        publish('@operator-x', {tracked: ['@ada', '@grace'], seats: {'@ada': {authored: [pr(2)]}}});
        publish('@operator-x', {tracked: ['@ada'], seats: {'@ada': {authored: [pr(3)]}}});

        expect(read('@ada').authored.map(row => row.number), 'replaced, not merged').toEqual([3]);
        expect(read('@grace').state, 'a seat its own publisher omits is removed').toBe('untracked');
        expect(read('@vega'), 'another publisher\'s entry keeps its own age').toMatchObject({observedAt: minutes(3), authored: [{number: 1}]})
    });

    test('two publishers on one seat: the newer observation answers (AC-2)', () => {
        publish('@operator-x', {observedAt: minutes(4), tracked: ['@ada'], seats: {'@ada': {authored: [pr(4)]}}});
        publish('@operator-y', {observedAt: minutes(2), tracked: ['@ada'], seats: {'@ada': {authored: [pr(5)]}}});

        expect(read('@ada')).toMatchObject({observedAt: minutes(2), authored: [{number: 5}]})
    });

    test('an identity that is not an agent is refused and named; the rest is written (AC-2)', () => {
        const answer = publish('@operator', {tracked: ['@ada', '@tobiu'], seats: {'@ada': {authored: [pr(6)]}}}, seat => seat !== '@tobiu');

        expect(answer).toEqual({publishedAt: new Date(NOW).toISOString(), tracked: 1, refused: [{seat: '@tobiu', reason: 'not a registered agent identity'}]});
        expect(read('@tobiu').state).toBe('untracked');
        expect(read('@ada').authored).toHaveLength(1)
    });

    test('a malformed publication writes nothing: the previous copy stays and ages by its own observation (AC-2)', () => {
        publish('@operator', {observedAt: minutes(1), tracked: ['@ada'], seats: {'@ada': {authored: [pr(7)]}}});

        const refusals = [
            [{observedAt: 'yesterday'}, /observedAt/],
            [{coverage: 'unavailable'}, /coverage/],
            [{tracked: 'ada'}, /tracked/],
            [{tracked: ['ada']}, /@identities/],
            [{tracked: ['@ada'], seats: {'@grace': {}}}, /does not track/],
            [{tracked: ['@ada'], seats: {'@ada': {authored: [{number: 9}]}}}, /without a repository/],
            [{tracked: ['@ada'], seats: {'@ada': {reviewing: Array.from({length: 101}, (_, i) => pr(i + 1))}}}, /at most 100 rows/]
        ];

        for (const [args, reason] of refusals) {
            expect(() => publish('@operator', {tracked: ['@ada'], ...args}), String(reason)).toThrow(reason)
        }

        expect(read('@ada', NOW + 6 * 60_000)).toMatchObject({state: 'stale', observedAt: minutes(1), authored: [{number: 7}]})
    });

    test('a caller-supplied key, target or path selects nothing: entries are keyed by the verified publisher (AC-2)', () => {
        publish('@operator', {tracked: ['@ada'], seats: {'@ada': {authored: [pr(1)]}}, publisher: '@intruder', key: '@grace', path: '/tmp/copy.json'});

        expect(read('@ada').authored).toHaveLength(1);
        expect(read('@grace').state).toBe('untracked');
        expect(fs.existsSync('/tmp/copy.json')).toBe(false)
    });

    test('a read hands out a copy: changing it never changes the store', () => {
        publish('@operator', {tracked: ['@ada'], seats: {'@ada': {authored: [pr(1)]}}});
        read('@ada').authored.push(pr(2));

        expect(read('@ada').authored).toHaveLength(1)
    })
});

/** @summary The two verbs: the Fleet's human operator publishes, a seat reads only itself. */
test.describe.configure({mode: 'serial'});
test.describe('openWorkWakeIntake — the open-work copy verbs', () => {
    let GraphService, publishOpenWorkCopy, readOwnOpenWork, originalAutoSave;

    const
        operator   = '@copy-operator',
        identities = [
            [operator, {accountType: 'human', trustTier: 'owner'}],
            ['@copy-seat', {accountType: 'agent'}],
            ['@copy-human', {accountType: 'human', operator: false}]
        ],
        as = (identity, fn) => RequestContextService.run({agentIdentityNodeId: identity}, fn);

    test.beforeAll(async () => {
        GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        ({publishOpenWorkCopy, readOwnOpenWork} = await import('../../../../../../ai/services/memory-core/openWorkWakeIntake.mjs'));
        const LifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;
        await LifecycleService.ready();
        originalAutoSave = GraphService.db.autoSave;
        GraphService.db.autoSave = true;

        for (const [id, properties] of identities) {
            GraphService.upsertNode({id, type: 'AgentIdentity', name: id, properties: {sharedEntity: true, ...properties}})
        }
        resetOpenWorkCopy()
    });

    test.afterAll(() => {
        GraphService.removeNodes(identities.map(([id]) => id));
        GraphService.db.autoSave = originalAutoSave;
        resetOpenWorkCopy()
    });

    test('the operator publishes; an agent and a non-operator human are refused before anything is written', async () => {
        const args = {observedAt: new Date().toISOString(), coverage: 'complete', tracked: ['@copy-seat'], seats: {'@copy-seat': {authored: [pr(7)]}}};

        for (const caller of ['@copy-seat', '@copy-human']) {
            await expect(as(caller, () => publishOpenWorkCopy(args)), caller).rejects.toThrow(/the open-work copy is admitted from the Fleet's human operator only/)
        }
        await expect(as('@copy-seat', () => readOwnOpenWork())).resolves.toMatchObject({state: 'unavailable'});

        await expect(as(operator, () => publishOpenWorkCopy({...args, tracked: ['@copy-seat', '@copy-human']})))
            .resolves.toMatchObject({tracked: 1, refused: [{seat: '@copy-human', reason: 'not a registered agent identity'}]})
    });

    test('a seat reads only itself, by its verified identity; an unbound caller is refused (AC-1)', async () => {
        await expect(as('@copy-seat', () => readOwnOpenWork({seat: '@copy-human'}))).resolves.toMatchObject({state: 'ok', authored: [{number: 7}]});
        await expect(as('copy-seat', () => readOwnOpenWork()), 'the caller is normalized').resolves.toMatchObject({state: 'ok'});
        await expect(as('@copy-human', () => readOwnOpenWork())).resolves.toMatchObject({state: 'untracked'});
        await expect(readOwnOpenWork()).rejects.toThrow()
    })
});

/**
 * @summary AC-4: the copy store, the two verbs' module and the section formatter reach no GitHub client, read over
 * each module's static import graph.
 */
test.describe('the open-work copy readers import no GitHub client (AC-4)', () => {
    /**
     * @summary Every repository module a module reaches through static relative imports, and every package it names.
     * @param {String} entry Repository-relative module path.
     * @returns {{modules: Set<String>, packages: Set<String>}}
     */
    function importGraph(entry) {
        const modules = new Set(), packages = new Set(), pending = [path.join(root, entry)];

        while (pending.length) {
            const file = pending.pop();

            if (modules.has(file) || !fs.existsSync(file)) continue;
            modules.add(file);

            for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
                specifier.startsWith('.') ? pending.push(path.resolve(path.dirname(file), specifier)) : packages.add(specifier)
            }
        }

        return {modules, packages}
    }

    for (const entry of ['ai/services/memory-core/openWorkCopyStore.mjs', 'ai/services/memory-core/openWorkWakeIntake.mjs', 'ai/daemons/wake/wakeDigestBuilder.mjs']) {
        test(entry, () => {
            const {modules, packages} = importGraph(entry);

            expect(modules.size, 'the walk read the module').toBeGreaterThan(0);
            expect([...modules].map(file => path.relative(root, file)).filter(file => /github|octokit/i.test(file))).toEqual([]);
            expect([...packages].filter(name => /octokit|github/i.test(name))).toEqual([])
        })
    }

    test('the walk sees a GitHub module when one is imported (control)', () => {
        const {modules} = importGraph('ai/mcp/server/github-workflow/Server.mjs');

        expect([...modules].some(file => /github/i.test(path.relative(root, file)))).toBe(true)
    })
});
