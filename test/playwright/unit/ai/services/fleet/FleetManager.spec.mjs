import {setup} from '../../../../setup.mjs';

const appName = 'FleetManagerTest';

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

import {test, expect}                                                          from '@playwright/test';
import Neo                                                                     from 'neo.mjs/src/Neo.mjs';
import * as core                                                               from 'neo.mjs/src/core/_export.mjs';
import FleetControlBridge                                                      from '../../../../../../ai/services/fleet/FleetControlBridge.mjs';
import FleetLifecycleService                                                   from '../../../../../../ai/services/fleet/FleetLifecycleService.mjs';
import FleetManager                                                            from '../../../../../../ai/services/fleet/FleetManager.mjs';
import FleetRegistryService                                                    from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import FleetTenantService                                                      from '../../../../../../ai/services/fleet/FleetTenantService.mjs';
import {armFleetSeatWake}                                                      from '../../../../../../ai/services/fleet/armFleetSeatWake.mjs';
import {createFleetCockpitStatus}                                              from '../../../../../../ai/services/fleet/fleetCockpitStatus.mjs';
import {PACKAGE_SLOTS_RECORD, PACKAGE_RECEIPT_PATH, runtimeGenerationIdentity} from '../../../../../../ai/services/fleet/runtimeGeneration.mjs';
import {
    CREDENTIAL_REFUSAL_CAUSES,
    proveSeatForgeAccount,
    resolveSeatGitIdentity
}                                                                              from '../../../../../../ai/services/fleet/seatGitIdentity.mjs';
import {startAgentProvisioned}                                  from '../../../../../../ai/services/fleet/startAgentProvisioned.mjs';
import {createFleetWireRequest, REPLACE_SEAT_CREDENTIAL_SCOPES} from '../../../../../../src/fleet/contract/wire.mjs';
import {dispatchFleetRequest}                                   from '../../../../../../ai/services/fleet/dispatchFleetRequest.mjs';
import {DEPENDENCY_RECEIPT, installSeatDependencies}            from '../../../../../../ai/services/fleet/installAgentRepoDependencies.mjs';
import {execFileSync}                                           from 'node:child_process';
import fs                                                       from 'fs';
import os                                                       from 'os';
import path                                                     from 'path';

test.describe('FleetManager guarded checkout removal (#951)', () => {
    let root, repoPath, agent, retired;
    const git = (...args) => execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env     : {...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'}
    }).trim();
    const remove = () => FleetManager.removeRepoCheckout({id: 'seat', repoSlug: 'x/extra'});

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-remove-policy-'));
        repoPath = path.join(root, 'seat', 'x', 'extra');
        fs.mkdirSync(repoPath, {recursive: true});
        agent = {id: 'seat', harnessType: 'codex', seatHome: path.join(root, 'seat'),
            metadata: {repo: {repoSlug: 'x/main'}, repos: []}};
        retired = [];
        FleetManager.managedRoot = root;
        FleetManager.lifecycleService = {
            getRegistry      : () => ({getDefinition: id => id === 'seat' && agent ? structuredClone(agent) : null}),
            retireRepoOutcome: (id, slug) => retired.push([id, slug])
        };
        git('init', '-b', 'main');
        git('config', 'user.name', 'Removal fixture');
        git('config', 'user.email', 'removal@example.invalid');
        fs.writeFileSync(path.join(repoPath, '.gitignore'), 'notes.local\nnode_modules/\n');
        fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'seed');
        git('add', '.');
        git('commit', '-m', 'test(fleet): seed removal fixture (#951)');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    });

    test.afterEach(() => {
        FleetManager.lifecycleService = null;
        FleetManager.managedRoot = null;
        FleetManager.repoRemovalOptions = null;
        FleetManager.seatHomeHolds.clear();
        fs.rmSync(root, {recursive: true, force: true})
    });

    test('removes only an unlisted clean checkout at the derived path', async () => {
        expect(await remove()).toEqual({removed: true, repoPath});
        expect(retired).toEqual([['seat', 'x/extra']]);
        expect(fs.existsSync(repoPath)).toBe(false)
    });

    for (const kind of ['listed', 'working', 'dirty', 'untracked', 'ignored', 'unpushed', 'stash', 'detached', 'tag-only', 'local-ref']) {
        test(`${kind} work refuses without deleting the checkout`, async () => {
            if (kind === 'listed') agent.metadata.repos = [{repoSlug: 'x/extra'}];
            else if (kind === 'working') agent.metadata.repo.repoSlug = 'x/extra';
            else if (kind === 'dirty' || kind === 'stash') fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'changed');
            else if (kind === 'untracked') fs.writeFileSync(path.join(repoPath, 'new.txt'), 'keep');
            else if (kind === 'ignored') fs.writeFileSync(path.join(repoPath, 'notes.local'), 'keep');
            else {
                if (kind !== 'unpushed') git('checkout', '--detach');
                fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'unpublished');
                git('commit', '-am', 'test(fleet): unpublished removal fixture (#951)');
                if (kind === 'tag-only') {
                    git('tag', 'local-only');
                    git('checkout', 'main')
                } else if (kind === 'local-ref') {
                    git('update-ref', 'refs/keep/local-work', 'HEAD');
                    git('checkout', 'main')
                }
            }
            if (kind === 'stash') git('stash', 'push');

            const result = await remove();
            expect(result.removed).toBe(false);
            expect(retired).toEqual([]);
            expect(result.reason).toMatch(kind === 'listed' ? /unlist/i : kind === 'working' ? /working/i :
                kind === 'stash' ? /stash/i : ['unpushed', 'detached', 'tag-only', 'local-ref'].includes(kind) ? /unpushed/i :
                    kind === 'ignored' ? /notes\.local/ : /changed|untracked/i);
            expect(fs.existsSync(path.join(repoPath, '.git'))).toBe(true)
        })
    }

    for (const owned of [false, true]) {
        test(`ignored root node_modules with installed receipt=${owned}`, async () => {
            fs.mkdirSync(path.join(repoPath, 'node_modules'));
            fs.writeFileSync(path.join(repoPath, 'node_modules', 'package.txt'), 'dependency');
            fs.writeFileSync(path.join(agent.seatHome, DEPENDENCY_RECEIPT), JSON.stringify({'x/extra': {state: owned ? 'installed' : 'unverified'}}));
            const result = await remove();
            expect(result.removed).toBe(owned);
            if (!owned) expect(result.reason).toMatch(/node_modules/);
            expect(fs.existsSync(repoPath)).toBe(!owned)
        })
    }

    test('the dependency receipt cannot exempt another ignored entry', async () => {
        fs.mkdirSync(path.join(repoPath, 'node_modules'));
        fs.writeFileSync(path.join(repoPath, 'node_modules', 'package.txt'), 'dependency');
        fs.writeFileSync(path.join(repoPath, 'notes.local'), 'keep');
        fs.writeFileSync(path.join(agent.seatHome, DEPENDENCY_RECEIPT), JSON.stringify({'x/extra': {state: 'installed'}}));
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringContaining('notes.local')});
        expect(fs.existsSync(repoPath)).toBe(true)
    });

    test('an installed receipt exempts neither nested node_modules nor malformed ownership', async () => {
        fs.mkdirSync(path.join(repoPath, 'packages', 'local', 'node_modules'), {recursive: true});
        fs.writeFileSync(path.join(repoPath, 'packages', 'local', 'node_modules', 'notes.txt'), 'keep');
        fs.writeFileSync(path.join(agent.seatHome, DEPENDENCY_RECEIPT), JSON.stringify({'x/extra': {state: 'installed'}}));
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringContaining('packages')});
        fs.rmSync(path.join(repoPath, 'packages'), {recursive: true});
        fs.mkdirSync(path.join(repoPath, 'node_modules'));
        fs.writeFileSync(path.join(repoPath, 'node_modules', 'notes.txt'), 'keep');
        fs.writeFileSync(path.join(agent.seatHome, DEPENDENCY_RECEIPT), 'unreadable json');
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringContaining('node_modules')})
    });

    test('a clean gitlink cannot hide unpublished history in an initialized nested repository', async () => {
        git('init', '-b', 'main', 'nested');
        git('-C', 'nested', 'config', 'user.name', 'Nested fixture');
        git('-C', 'nested', 'config', 'user.email', 'nested@example.invalid');
        fs.writeFileSync(path.join(repoPath, 'nested', 'seed.txt'), 'seed');
        git('-C', 'nested', 'add', '.');
        git('-C', 'nested', 'commit', '-m', 'test(fleet): seed nested fixture (#951)');
        git('-C', 'nested', 'update-ref', 'refs/remotes/origin/main', 'HEAD');
        git('add', 'nested');
        git('commit', '-m', 'test(fleet): record nested fixture (#951)');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        git('-C', 'nested', 'checkout', '-b', 'local-work');
        fs.writeFileSync(path.join(repoPath, 'nested', 'work.txt'), 'unpublished');
        git('-C', 'nested', 'add', '.');
        git('-C', 'nested', 'commit', '-m', 'test(fleet): retain nested work (#951)');
        git('-C', 'nested', 'checkout', 'main');
        expect(git('status', '--porcelain')).toBe('');
        const removed = [];
        FleetManager.repoRemovalOptions = {removeDir: target => removed.push(target)};
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/submodule/i)});
        expect(removed).toEqual([])
    });

    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
        test(`index flag ${flag} cannot hide modified tracked files`, async () => {
            git('update-index', flag, 'tracked.txt');
            fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'hidden local work');
            expect(git('status', '--porcelain')).toBe('');
            const removed = [];
            FleetManager.repoRemovalOptions = {removeDir: target => removed.push(target)};
            expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/index|working.tree/i)});
            expect(removed).toEqual([])
        })
    }

    test('deinitialized module histories remain protected without a gitlink', async () => {
        fs.mkdirSync(path.join(repoPath, '.git', 'modules', 'former-submodule'), {recursive: true});
        fs.writeFileSync(path.join(repoPath, '.git', 'modules', 'former-submodule', 'HEAD'), 'retained history');
        expect(git('ls-files', '--stage')).not.toContain('160000');
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/submodule history/i)});
        expect(fs.existsSync(repoPath)).toBe(true)
    });

    test('an uninitialized submodule declaration refuses', async () => {
        fs.writeFileSync(path.join(repoPath, '.gitmodules'), '[submodule "later"]\npath = later\n');
        git('add', '.gitmodules');
        git('commit', '-m', 'test(fleet): declare a future submodule (#951)');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/submodule/i)});
        expect(fs.existsSync(repoPath)).toBe(true)
    });

    test('Git-reported linked worktree metadata protects the shared object store', async () => {
        const linked = path.join(root, 'linked'), metadata = path.join(repoPath, '.git', 'worktrees', 'linked');
        fs.mkdirSync(linked);
        fs.mkdirSync(metadata, {recursive: true});
        fs.writeFileSync(path.join(metadata, 'HEAD'), `${git('rev-parse', 'HEAD')}\n`);
        fs.writeFileSync(path.join(metadata, 'gitdir'), `${path.join(linked, '.git')}\n`);
        fs.writeFileSync(path.join(metadata, 'commondir'), '../..\n');
        fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${metadata}\n`);
        expect(git('worktree', 'list', '--porcelain')).toContain(linked);
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/linked worktree/i)});
        expect(fs.existsSync(path.join(repoPath, '.git', 'objects'))).toBe(true)
    });

    test('Git environment overrides cannot redirect the read away from retained work', async () => {
        const prior = {GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE};
        fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'keep');
        try {
            process.env.GIT_DIR = path.join(root, 'does-not-exist');
            process.env.GIT_WORK_TREE = root;
            expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/changed|untracked/i)});
            expect(fs.readFileSync(path.join(repoPath, 'tracked.txt'), 'utf8')).toBe('keep')
        } finally {
            for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value
        }
    });

    test('a detached commit and local tag both covered by a remote-tracking ref pass', async () => {
        git('checkout', '--detach');
        fs.writeFileSync(path.join(repoPath, 'tracked.txt'), 'published');
        git('commit', '-am', 'test(fleet): published detached fixture (#951)');
        git('tag', 'published-tag');
        git('update-ref', 'refs/remotes/origin/published', 'HEAD');
        expect(await remove()).toEqual({removed: true, repoPath})
    });

    test('unknown, absent and foreign paths never call the remover', async () => {
        const removed = [];
        FleetManager.repoRemovalOptions = {removeDir: target => removed.push(target)};
        expect(await FleetManager.removeRepoCheckout({id: 'unknown', repoSlug: 'x/extra'})).toBeNull();
        fs.rmSync(repoPath, {recursive: true});
        expect(await remove()).toMatchObject({removed: false, reason: expect.any(String)});
        fs.mkdirSync(repoPath);
        fs.writeFileSync(path.join(repoPath, 'foreign.txt'), 'keep');
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/checkout/i)});
        expect(removed).toEqual([]);
        expect(fs.readFileSync(path.join(repoPath, 'foreign.txt'), 'utf8')).toBe('keep')
    });

    for (const change of ['relist', 'working', 'remove seat']) {
        test(`a definition change during the guard (${change}) prevents removal`, async () => {
            const removed = [];
            FleetManager.repoRemovalOptions = {
                removeDir: target => removed.push(target),
                readGit  : async (target, args) => {
                    const result = git(...args);
                    if (args.includes('--all')) {
                        if (change === 'relist') agent.metadata.repos = [{repoSlug: 'x/extra'}];
                        else if (change === 'working') agent.metadata.repo.repoSlug = 'x/extra';
                        else agent = null
                    }
                    return result
                }
            };
            const result = await remove();
            expect(result === null || result.removed === false).toBe(true);
            expect(removed).toEqual([]);
            expect(fs.existsSync(repoPath)).toBe(true)
        })
    }

    test('the seat hold serializes removal and re-reads the definition after waiting', async () => {
        let release;
        const holding = FleetManager.withSeatHome('seat', () => new Promise(resolve => {release = resolve}));
        await Promise.resolve();
        const pending = remove();
        agent.metadata.repos = [{repoSlug: 'x/extra'}];
        release();
        await holding;
        expect(await pending).toMatchObject({removed: false, reason: expect.stringMatching(/unlist/i)});
        expect(fs.existsSync(repoPath)).toBe(true)
    });

    test('the one remover receives the derived path once', async () => {
        const removed = [];
        FleetManager.repoRemovalOptions = {removeDir: target => removed.push(target)};
        expect(await remove()).toEqual({removed: true, repoPath});
        expect(removed).toEqual([repoPath])
    });

    test('a failed remover keeps the current outcome row', async () => {
        FleetManager.repoRemovalOptions = {removeDir: () => {throw new Error('filesystem failure')}};
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/fully removed/i)});
        expect(retired).toEqual([]);
        expect(fs.existsSync(repoPath)).toBe(true)
    });

    test('caller paths, traversal, nested protected repositories and foreign seat homes refuse', async () => {
        for (const payload of [{id: 'seat', repoSlug: '../extra'}, {id: 'seat', repoSlug: 'x/extra', repoPath: '/outside'}]) {
            await expect(FleetManager.removeRepoCheckout(payload)).rejects.toThrow()
        }
        agent.metadata.repo.repoSlug = 'x/extra/working';
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/working/i)});
        agent.metadata.repo.repoSlug = 'x/main';
        agent.seatHome = path.join(root, 'other');
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/managed home/i)});
        expect(fs.existsSync(repoPath)).toBe(true)
    });

    test('a symlinked owner directory cannot redirect the guard or deletion', async () => {
        const target = path.join(root, 'outside');
        fs.renameSync(path.join(root, 'seat', 'x'), target);
        fs.symlinkSync(target, path.join(root, 'seat', 'x'));
        let reads = 0;
        FleetManager.repoRemovalOptions = {readGit: async () => {reads++; return ''}};
        expect(await remove()).toMatchObject({removed: false, reason: expect.stringMatching(/link|path/i)});
        expect(reads).toBe(0);
        expect(fs.existsSync(path.join(target, 'extra', 'tracked.txt'))).toBe(true)
    })
});

test.describe('FleetManager prepares repositories for a live launch', () => {
    let root, agent, launch, calls, lifecycle;
    const at = '2026-10-11T01:00:00.000Z';

    test.beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-prepare-repos-'));
        calls = [];
        agent = {id: 'seat', harnessType: 'codex', seatHome: path.join(root, 'seat'),
            gitName : 'Pending Name', gitEmail: 'pending@example.test',
            metadata: {repo: {repoSlug: 'x/main'}, repos: [
                {repoSlug: 'x/present', cloneUrl: 'https://github.com/x/present.git'},
                {repoSlug: 'x/new', cloneUrl: 'https://github.com/x/new.git'}
            ]}};
        launch = {pid: 123, startedAt: at, state: 'running', gitIdentity: {state: 'derived', name: 'Running Name', email: 'running@example.test'}};
        fs.mkdirSync(path.join(root, 'seat', 'x', 'present', '.git'), {recursive: true});
        lifecycle = {
            getRegistry: () => ({getDefinition: id => id === 'seat' ? structuredClone(agent) : null,
                resolveCredential: () => 'ghp_fixture_only'}),
            isRunning      : () => launch.state === 'running',
            status         : () => structuredClone(launch),
            setRepoOutcomes: (id, rows, token) => {calls.push(['publish', id, rows, token]); return true}
        };
        FleetManager.lifecycleService = lifecycle;
        FleetManager.managedRoot = root;
        FleetManager.repoPreparationOptions = {
            now      : () => at,
            cloneRepo: async (url, destination) => {
                calls.push(['clone', url, destination]);
                fs.mkdirSync(path.join(destination, '.git'), {recursive: true})
            },
            convergeGitIdentity: async args => {calls.push(['identity', args]); return {state: 'converged'}}
        };
    });

    test.afterEach(() => {
        FleetManager.lifecycleService = null;
        FleetManager.managedRoot = null;
        FleetManager.repoPreparationOptions = null;
        FleetManager.seatHomeHolds.clear();
        fs.rmSync(root, {recursive: true, force: true});
    });

    test('clones only the absent repository and gives it the captured launch identity', async () => {
        const result = await FleetManager.prepareRepos({id: 'seat'});
        expect(result).toEqual({state: 'complete', repos: [
            {repoSlug: 'x/present', state: 'prepared', via: 'prepare', at},
            {repoSlug: 'x/new', state: 'prepared', via: 'prepare', at}
        ]});
        expect(calls.filter(([kind]) => kind === 'clone')).toEqual([
            ['clone', 'https://github.com/x/new.git', path.join(root, 'seat', 'x', 'new')]
        ]);
        expect(calls.filter(([kind]) => kind === 'identity')).toEqual([
            ['identity', {repoPath: path.join(root, 'seat', 'x', 'present'), identity: {name: 'Running Name', email: 'running@example.test'}, readOnly: true}],
            ['identity', {repoPath: path.join(root, 'seat', 'x', 'new'), identity: {name: 'Running Name', email: 'running@example.test'}, readOnly: false}]
        ]);
        expect(calls.at(-1)[0]).toBe('publish');
        expect(launch.state).toBe('running');
    });

    test('unknown, stopped and identity-unavailable launches perform no filesystem work', async () => {
        expect(await FleetManager.prepareRepos({id: 'unknown'})).toBeNull();
        launch.state = 'stopped';
        expect(await FleetManager.prepareRepos({id: 'seat'})).toEqual({state: 'at-start', repos: []});
        launch.state = 'running';
        delete launch.gitIdentity;
        expect(await FleetManager.prepareRepos({id: 'seat'})).toMatchObject({state: 'identity-unavailable', repos: [], reason: expect.stringMatching(/Start/)});
        expect(calls).toEqual([]);
        expect(fs.existsSync(path.join(root, 'seat', 'x', 'new'))).toBe(false);
    });

    test('a failed repository stays a row while the next repository prepares', async () => {
        fs.rmSync(path.join(root, 'seat', 'x', 'present', '.git'), {recursive: true});
        fs.writeFileSync(path.join(root, 'seat', 'x', 'present', 'work.txt'), 'keep');
        const result = await FleetManager.prepareRepos({id: 'seat'});
        expect(result.state).toBe('complete');
        expect(result.repos[0]).toMatchObject({repoSlug: 'x/present', state: 'failed', via: 'prepare', at, reason: expect.any(String)});
        expect(result.repos[1]).toMatchObject({repoSlug: 'x/new', state: 'prepared'});
        expect(fs.readFileSync(path.join(root, 'seat', 'x', 'present', 'work.txt'), 'utf8')).toBe('keep');
    });

    test('queued preparations clone once and the second only verifies the reused identity', async () => {
        const results = await Promise.all([FleetManager.prepareRepos({id: 'seat'}), FleetManager.prepareRepos({id: 'seat'})]);
        expect(results.map(result => result.state)).toEqual(['complete', 'complete']);
        expect(calls.filter(([kind]) => kind === 'clone')).toHaveLength(1);
        expect(calls.filter(([kind, args]) => kind === 'identity' && !args.readOnly)).toHaveLength(1);
        expect(FleetManager.seatHomeHolds.size).toBe(0);
    });

    test('closed input and a mismatched seat home cannot reach the clone seam', async () => {
        for (const payload of [null, [], {}, {id: 'seat', repoPath: '/outside'}]) {
            await expect(FleetManager.prepareRepos(payload)).rejects.toThrow(/seat id/)
        }
        agent.seatHome = path.join(root, 'other-seat');
        await expect(FleetManager.prepareRepos({id: 'seat'})).rejects.toThrow(/matching managed home/);
        expect(calls).toEqual([]);
    });

    test('clone and identity errors are redacted before they become outcome rows', async () => {
        const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // secret-scan-ok: synthetic alphabet token exercises outcome redaction
        FleetManager.repoPreparationOptions.convergeGitIdentity = async () => {throw new Error(`identity ${secret}`)};
        FleetManager.repoPreparationOptions.cloneRepo = async () => {throw new Error(`clone ${secret}`)};
        const result = await FleetManager.prepareRepos({id: 'seat'});
        expect(result.repos.map(row => row.state)).toEqual(['failed', 'failed']);
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    test('retrying a clone whose identity failed cannot promote it to prepared by reuse alone', async () => {
        FleetManager.repoPreparationOptions.convergeGitIdentity = async () => ({state: 'mismatch', reason: 'the checkout holds another identity'});
        const first = await FleetManager.prepareRepos({id: 'seat'});
        expect(first.repos[1]).toMatchObject({state: 'failed'});
        const retry = await FleetManager.prepareRepos({id: 'seat'});
        expect(retry.repos[1]).toMatchObject({state: 'failed'});
        expect(calls.filter(([kind]) => kind === 'clone')).toHaveLength(1);
    });

    for (const change of ['stop', 'replace']) {
        test(`${change} during a clone cannot publish or prepare another repository`, async () => {
            agent.metadata.repos.push({repoSlug: 'x/later', cloneUrl: 'https://github.com/x/later.git'});
            const clone = FleetManager.repoPreparationOptions.cloneRepo;
            FleetManager.repoPreparationOptions.cloneRepo = async (...args) => {
                await clone(...args);
                if (change === 'stop') launch.state = 'stopped';
                else launch.pid++;
            };
            const result = await FleetManager.prepareRepos({id: 'seat'});
            expect(result.state).toBe('superseded');
            expect(calls.filter(([kind]) => kind === 'publish')).toEqual([]);
            expect(calls.filter(([kind, args]) => kind === 'identity' && !args.readOnly)).toEqual([]);
            expect(calls.filter(([kind]) => kind === 'clone')).toHaveLength(1);
            expect(fs.existsSync(path.join(root, 'seat', 'x', 'new', '.git'))).toBe(true);
            expect(fs.existsSync(path.join(root, 'seat', 'x', 'later'))).toBe(false);
        });
    }
});

/** Borrow real Start cancellation methods while isolating mutable lifecycle state per test. */
function lifecycleWithStarts(overrides = {}) {
    return Object.assign(Object.create(FleetLifecycleService), {
        pendingStarts     : new Map(),
        processes         : new Map(),
        getRegistry       : () => ({getAgent: () => null}),
        getLaunchAdmission: () => ({revocationMark: () => null, revoke: () => null}),
        adoptLeasedSeats  : () => {},
        refreshAdoptedSeat: () => {},
        ...overrides
    })
}

// FleetManager is a singleton; `lifecycleService` is a plain injectable seam (default =
// FleetLifecycleService). Each test swaps in a stub whose getRegistry() returns a recording registry
// stub, so setRepo's fleet-authority delegation + its metadata construction are proven without
// touching disk / spawning processes; afterEach resets the seam so no state leaks between tests.

test.describe('Neo.ai.services.fleet.FleetManager — fleet-authority definition-update verbs (setRepo / setAvatar)', () => {
    let calls, registryStub;

    test.beforeEach(() => {
        calls = [];

        registryStub = {
            // setRepo reads the seat's other repositories for the collision rule; none by default
            getAgent   : () => null,
            updateAgent: (id, patch) => { calls.push(['updateAgent', id, patch]); return {id, ...patch}; }
        };

        FleetManager.lifecycleService = {getRegistry: () => registryStub};
    });

    test.afterEach(() => {
        FleetManager.lifecycleService = null;
    });

    test('sets metadata.repo = {cloneUrl, repoSlug} from the single payload — the convention the provisioner honors', () => {
        const result = FleetManager.setRepo({id: 'alice', cloneUrl: 'https://github.com/x/y.git', repoSlug: 'x/y'});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {repo: {cloneUrl: 'https://github.com/x/y.git', repoSlug: 'x/y'}}}]]);
        expect(result.metadata.repo).toEqual({cloneUrl: 'https://github.com/x/y.git', repoSlug: 'x/y'});
    });

    test('a slug alone stores the clone URL derived from it', () => {
        FleetManager.setRepo({id: 'alice', repoSlug: 'neomjs/neo-agent-brain'});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {repo: {repoSlug: 'neomjs/neo-agent-brain', cloneUrl: 'https://github.com/neomjs/neo-agent-brain.git'}}}]]);
    });

    test('a remote naming the slug\'s repo is accepted over https, ssh and the SCP-like form, on any host', () => {
        for (const cloneUrl of ['git@gitlab.example:x/y.git', 'ssh://git@host.example:2222/x/y.git', 'https://GitHub.com/X/Y']) {
            FleetManager.setRepo({id: 'alice', repoSlug: 'x/y', cloneUrl})
        }

        expect(calls.map(([, , patch]) => patch.metadata.repo.cloneUrl)).toEqual(['git@gitlab.example:x/y.git', 'ssh://git@host.example:2222/x/y.git', 'https://GitHub.com/X/Y'])
    });

    test('no caller points a seat at a source or a path it chose: everything else is refused before the registry', () => {
        const refused = [
            {repoSlug: 'x/y', cloneUrl: 'file:///tmp/y'},                         // a local source
            {repoSlug: 'x/y', cloneUrl: '/tmp/y'},
            {repoSlug: 'x/y', cloneUrl: 'http://github.com/x/y.git'},             // no plain http
            {repoSlug: 'x/y', cloneUrl: 'https://user:token@github.com/x/y.git'}, // no embedded credentials
            {repoSlug: 'x/y', cloneUrl: 'https://github.com/x/other.git'},        // a remote for another repo
            {repoSlug: 'x/y', cloneUrl: 'https://github.com/x/y.git?ref=main'},
            {cloneUrl: 'https://github.com/x/y.git'},                             // a URL with no slug
            {repoSlug: 'x/..'},                                                   // a checkout path out of the root
            {repoSlug: '../y'},
            {repoSlug: 'x/y/z'},
            {repoSlug: 'X/Y'},                                                    // the checkout path is lowercase
            {repoSlug: 'harness/y'}                                               // the harness homes' segment
        ];

        for (const payload of refused) {
            expect(() => FleetManager.setRepo({id: 'alice', ...payload}), JSON.stringify(payload)).toThrow(/FleetManager\.setRepo/)
        }

        expect(calls, 'the registry was never touched').toEqual([])
    });

    test('a refusal names the rule, never the value it refused: a secret in the input stays out of the message', () => {
        for (const payload of [
            {repoSlug: 'x/y', cloneUrl: 'https://user:ghp_SECRET1@github.com/x/y.git'},
            {repoSlug: 'https://user:ghp_SECRET2@github.com/x/y.git'}
        ]) {
            let message = '';

            try {
                FleetManager.setRepo({id: 'alice', ...payload})
            } catch (error) {
                message = error.message
            }

            expect(message).toMatch(/^FleetManager\.setRepo: /);
            expect(message).not.toMatch(/SECRET/)
        }
    });

    test('with no coordinates sets an empty metadata.repo (a safe no-op, not a wipe of other metadata)', () => {
        FleetManager.setRepo({id: 'alice'});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {repo: {}}}]]);
    });

    test('forwards the registry null (unknown agent) verbatim — no partial definition invented', () => {
        registryStub.updateAgent = (id, patch) => { calls.push(['updateAgent', id, patch]); return null; };

        expect(FleetManager.setRepo({id: 'ghost', repoSlug: 'x/y'})).toBeNull();
    });

    test('setRepos stores the seat\'s other repositories as metadata.repos, each by setRepo\'s rule', () => {
        registryStub.getAgent = id => ({id, metadata: {repo: {repoSlug: 'neomjs/neo', cloneUrl: 'https://github.com/neomjs/neo.git'}}});

        FleetManager.setRepos({id: 'alice', repos: [{repoSlug: 'neomjs/neo-agent-brain'}, {repoSlug: 'x/y', cloneUrl: 'git@gitlab.example:x/y.git'}]});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {repos: [
            {repoSlug: 'neomjs/neo-agent-brain', cloneUrl: 'https://github.com/neomjs/neo-agent-brain.git'},
            {repoSlug: 'x/y',                    cloneUrl: 'git@gitlab.example:x/y.git'}
        ]}}]]);
    });

    test('setRepos refuses what setRepo refuses, a duplicate and the working repository, naming the rule, never the value', () => {
        registryStub.getAgent = id => ({id, metadata: {repo: {repoSlug: 'neomjs/neo', cloneUrl: 'https://github.com/neomjs/neo.git'}}});

        for (const [repos, rule] of [
            [[{repoSlug: 'x/y', cloneUrl: 'https://user:ghp_SECRET@github.com/x/y.git'}], /the clone URL must be/],
            [[{repoSlug: 'harness/y'}],                                                  /repoSlug must be/],
            [['x/y'],                                                                    /repoSlug must be/],
            [[{repoSlug: 'x/y'}, {repoSlug: 'x/y'}],                                     /listed twice/],
            [[{repoSlug: 'neomjs/neo'}],                                                 /the working repository/]
        ]) {
            let message = '';

            try {
                FleetManager.setRepos({id: 'alice', repos})
            } catch (error) {
                message = error.message
            }

            expect(message, JSON.stringify(repos)).toMatch(/^FleetManager\.setRepos: /);
            expect(message).toMatch(rule);
            expect(message).not.toMatch(/SECRET/)
        }

        expect(() => FleetManager.setRepos({id: 'alice', repos: 'x/y'})).toThrow(/must be an array/);

        registryStub.getAgent = id => ({id, metadata: {}});
        expect(() => FleetManager.setRepos({id: 'alice', repos: [{repoSlug: 'x/y'}]})).toThrow(/no working repository/);

        expect(calls, 'the registry was never written').toEqual([])
    });

    test('a GitLab repository records its forge, may name nested groups, and must name its clone URL', () => {
        FleetManager.setRepo({id: 'alice', forge: 'gitlab', repoSlug: 'group/sub/project', cloneUrl: 'https://gitlab.example.com/group/sub/project.git'});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {repo: {
            cloneUrl: 'https://gitlab.example.com/group/sub/project.git', forge: 'gitlab', repoSlug: 'group/sub/project'
        }}}]]);

        for (const [payload, rule] of [
            [{forge: 'gitlab', repoSlug: 'group/project'},                                                              /needs its clone URL/],
            [{forge: 'gitlab', repoSlug: 'group/project', cloneUrl: 'https://gitlab.example.com/other/project.git'},   /the clone URL must be/],
            [{forge: 'bitbucket', repoSlug: 'x/y'},                                                                     /forge must be one of github, gitlab/],
            [{repoSlug: 'group/sub/project'},                                                                           /exactly '<owner>\/<repo>' on GitHub/],
            [{forge: 'gitlab', repoSlug: 'memory/sub/project', cloneUrl: 'git@gitlab.example.com:memory/sub/project.git'}, /repoSlug must be/],
            // the text matches the slug, but the parsed URL names another path or is no string at all
            [{forge: 'gitlab', repoSlug: 'group/sub/project', cloneUrl: 'https://gitlab.example.com?x=/group/sub/project.git'}, /plain remote string/],
            [{forge: 'gitlab', repoSlug: 'group/sub/project', cloneUrl: 'https://gitlab.example.com#x=/group/sub/project.git'}, /plain remote string/],
            [{forge: 'gitlab', repoSlug: 'group/sub/project', cloneUrl: ['https://gitlab.example.com/group/sub/project.git']}, /plain remote string/],
            [{repoSlug: 'x/y', cloneUrl: 'https://github.com/x/y.git?ref=main'},                                         /plain remote string/]
        ]) {
            expect(() => FleetManager.setRepo({id: 'alice', ...payload}), JSON.stringify(payload)).toThrow(rule)
        }

        expect(calls, 'only the valid entry was written').toHaveLength(1)
    });

    test("a seat keeps its working repository on its own forge, so its PAT reaches it", () => {
        registryStub.getAgent = id => ({
            gl    : {id, forge: 'gitlab', forgeHost: 'https://gitlab.example.com',      metadata: {}},
            gl8443: {id, forge: 'gitlab', forgeHost: 'https://gitlab.example.com:8443', metadata: {}},
            gl6   : {id, forge: 'gitlab', forgeHost: 'https://[2001:db8::1]:8443',      metadata: {}}
        })[id] ?? {id, metadata: {}};

        for (const [id, payload, rule] of [
            ['gl',     {repoSlug: 'x/y', cloneUrl: 'https://github.com/x/y.git'},                               /works on its GitLab instance/],
            ['gl',     {forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://gitlab.other.example/g/p.git'},    /must live on its GitLab instance, https:\/\/gitlab\.example\.com/],
            ['gh',     {forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://gitlab.example.com/g/p.git'},      /works on GitHub/],
            ['gl8443', {forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://gitlab.example.com:9443/g/p.git'}, /must live on its GitLab instance, https:\/\/gitlab\.example\.com:8443/], // another port
            ['gl8443', {forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://gitlab.example.com/g/p.git'},      /must live on its GitLab instance/],   // the implicit 443
            ['gl6',    {forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://[2001:db8::2]:8443/g/p.git'},     /must live on its GitLab instance/]    // another address
        ]) {
            expect(() => FleetManager.setRepo({id, ...payload}), `${id} ${JSON.stringify(payload)}`).toThrow(rule)
        }

        expect(calls, 'nothing was written').toEqual([]);

        FleetManager.setRepo({id: 'gl',     forge: 'gitlab', repoSlug: 'g/sub/p', cloneUrl: 'git@gitlab.example.com:g/sub/p.git'});
        FleetManager.setRepo({id: 'gh',     repoSlug: 'x/y'});
        FleetManager.setRepo({id: 'gl8443', forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://gitlab.example.com:8443/g/p.git'});
        FleetManager.setRepo({id: 'gl6',    forge: 'gitlab', repoSlug: 'g/p', cloneUrl: 'https://[2001:DB8::1]:8443/g/p.git'});

        expect(calls.map(([, id]) => id)).toEqual(['gl', 'gh', 'gl8443', 'gl6'])
    });

    test("a GitLab seat's repository without a clone URL is its slug on the seat's own instance, in setRepo and setRepos", () => {
        const work = forge => forge === 'gitlab'
            ? {repoSlug: 'g/work', cloneUrl: 'https://gitlab.example.com:8443/g/work.git', forge}
            : {repoSlug: 'x/work', cloneUrl: 'https://github.com/x/work.git'};

        registryStub.getAgent = id => ({
            gl: {id, forge: 'gitlab', forgeHost: 'https://gitlab.example.com:8443', metadata: {repo: work('gitlab')}},
            gh: {id, metadata: {repo: work('github')}}
        })[id];

        FleetManager.setRepo({id: 'gl', repoSlug: 'group/sub/project'});
        FleetManager.setRepos({id: 'gl', repos: [{repoSlug: 'group/tools'}, {forge: 'gitlab', repoSlug: 'group/docs'}]});
        FleetManager.setRepos({id: 'gh', repos: [{repoSlug: 'x/tools'}]});

        expect(calls).toEqual([
            ['updateAgent', 'gl', {metadata: {repo: {repoSlug: 'group/sub/project', cloneUrl: 'https://gitlab.example.com:8443/group/sub/project.git', forge: 'gitlab'}}}],
            ['updateAgent', 'gl', {metadata: {repos: [
                {repoSlug: 'group/tools', cloneUrl: 'https://gitlab.example.com:8443/group/tools.git', forge: 'gitlab'},
                {repoSlug: 'group/docs',  cloneUrl: 'https://gitlab.example.com:8443/group/docs.git',  forge: 'gitlab'}
            ]}}],
            ['updateAgent', 'gh', {metadata: {repos: [{repoSlug: 'x/tools', cloneUrl: 'https://github.com/x/tools.git'}]}}]
        ])
    });

    test('a seat\'s checkouts never share a path or nest, across forges, in setRepo and setRepos', () => {
        const working = {repoSlug: 'acme/tools', cloneUrl: 'https://github.com/acme/tools.git'};

        registryStub.getAgent = id => ({id, metadata: {repo: working}});

        for (const repos of [
            [{forge: 'gitlab', repoSlug: 'acme/tools/cli', cloneUrl: 'https://gitlab.example.com/acme/tools/cli.git'}],
            [{forge: 'gitlab', repoSlug: 'acme/tools', cloneUrl: 'https://gitlab.example.com/acme/tools.git'}],
            [{forge: 'gitlab', repoSlug: 'x/y', cloneUrl: 'https://gitlab.example.com/x/y.git'},
             {forge: 'gitlab', repoSlug: 'x/y/z', cloneUrl: 'https://gitlab.example.com/x/y/z.git'}]
        ]) {
            expect(() => FleetManager.setRepos({id: 'alice', repos}), JSON.stringify(repos)).toThrow(/share one checkout, or nest one inside the other/)
        }

        // a new working repository is checked against the others already recorded
        registryStub.getAgent = id => ({id, metadata: {repos: [{forge: 'gitlab', repoSlug: 'acme/tools/cli', cloneUrl: 'https://gitlab.example.com/acme/tools/cli.git'}]}});
        expect(() => FleetManager.setRepo({id: 'alice', repoSlug: 'acme/tools'})).toThrow(/share one checkout, or nest one inside the other/);

        expect(calls, 'nothing was written').toEqual([]);

        // a sibling that only shares a name prefix is no collision
        registryStub.getAgent = id => ({id, metadata: {repo: working}});
        FleetManager.setRepos({id: 'alice', repos: [{forge: 'gitlab', repoSlug: 'acme/tools-cli', cloneUrl: 'https://gitlab.example.com/acme/tools-cli.git'}]});

        expect(calls).toHaveLength(1)
    });

    test('setRepos with an empty list clears the facet, and an unknown agent is null', () => {
        registryStub.getAgent = id => id === 'alice' ? {id, metadata: {}} : null;

        FleetManager.setRepos({id: 'alice', repos: []});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {repos: []}}]]);
        expect(FleetManager.setRepos({id: 'ghost', repos: []})).toBeNull();
    });

    test('setAvatar sets metadata.avatarUrl from the single payload (sibling fleet-authority verb)', () => {
        const result = FleetManager.setAvatar({id: 'alice', avatarUrl: 'https://cdn/x.png'});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {avatarUrl: 'https://cdn/x.png'}}]]);
        expect(result.metadata.avatarUrl).toBe('https://cdn/x.png');
    });

    test('setAvatar with no avatarUrl sends an empty metadata patch (safe no-op, not a wipe)', () => {
        FleetManager.setAvatar({id: 'alice'});

        expect(calls).toEqual([['updateAgent', 'alice', {metadata: {}}]]);
    });

    test('adoptAgent / releaseAgent write launch ownership through the registry\'s one write — never a metadata patch', () => {
        registryStub.setLaunchOwner = (id, owner) => { calls.push(['setLaunchOwner', id, owner]); return {id, launchOwner: owner}; };

        expect(FleetManager.adoptAgent({id: 'alice'}).launchOwner).toBe('fleet');
        expect(FleetManager.releaseAgent({id: 'alice'}).launchOwner).toBe('external');
        expect(calls).toEqual([['setLaunchOwner', 'alice', 'fleet'], ['setLaunchOwner', 'alice', 'external']]);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — fleetRuntimeStatus (roster × lifecycle status)', () => {
    test.afterEach(() => {
        FleetManager.lifecycleService = null;
    });

    test('composes the roster with per-agent lifecycle status — every registered agent gets a row', () => {
        const registryStub = {listAgents: () => [{id: 'alice'}, {id: 'bob'}]};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => id === 'alice'
                ? {id, state: 'running', running: true,  pid: 4242, startedAt: '2026-07-04T00:00:00Z', exitCode: null}
                : {id, state: 'stopped', running: false, pid: null, startedAt: null,                    exitCode: null}
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([
            {agentId: 'alice', state: 'running', running: true, confidence: 'observed', source: 'fleet:runtimeStatus'},
            {
                agentId   : 'bob',
                state     : 'unmanaged',
                running   : false,
                confidence: 'none',
                reason    : 'no fleet process record: this agent runs outside fleet supervision',
                source    : 'fleet:runtimeStatus'
            }
        ]);
    });

    test('a launch\'s per-repository outcome rides its runtime row, and a status without one adds nothing', () => {
        const
            registryStub = {listAgents: () => [{id: 'alice'}, {id: 'bob'}]},
            repos        = [{repoSlug: 'neomjs/missing', state: 'failed', reason: 'ensureAgentRepo: clone failed'}];

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => id === 'alice'
                ? {id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-01T20:00:00Z', exitCode: null, repos}
                : {id, state: 'running', running: true, pid: 4343, startedAt: '2026-10-01T20:00:00Z', exitCode: null, repos: null}
        };

        const [alice, bob] = FleetManager.fleetRuntimeStatus();

        expect(alice.repos).toEqual(repos);
        expect(Object.hasOwn(bob, 'repos')).toBe(false)
    });

    test('a Start\'s dependency rows reach the cockpit row through the real lifecycle: live while it installs, final after, launched or not', () => {
        const
            registryStub = {listAgents: () => [{id: 'ada', launchOwner: 'fleet'}, {id: 'grace', launchOwner: 'fleet'}]},
            lifecycle    = lifecycleWithStarts({
                attemptDependencies: new Map(),
                gitIdentities      : new Map(),
                seatModels         : new Map(),
                getRegistry        : () => registryStub,
                getLaunchAdmission : () => ({revocationMark: () => null, revoke: () => null, holds: () => false}),
                harnessSettingsFor : () => null
            }),
            cockpit      = () => createFleetCockpitStatus({agents: registryStub.listAgents(), runtimeStatus: FleetManager.fleetRuntimeStatus()})
                .rows.map(row => row.dependencyOutcomes),
            canceled     = [{repoSlug: 'neomjs/neo', state: 'canceled', reason: 'stopped during the install'}, {repoSlug: 'neomjs/neo-agent-brain', state: 'installed'}];

        FleetManager.lifecycleService = lifecycle;

        expect(cockpit()).toEqual([null, null]);

        const attempt = lifecycle.beginStart('ada');

        lifecycle.setPendingDependencies('ada', attempt, [{repoSlug: 'neomjs/neo', state: 'installing'}]);
        expect(cockpit()).toEqual([[{repoSlug: 'neomjs/neo', state: 'installing'}], null]);

        // a Stop ends the attempt before any launch; its final rows stay readable
        lifecycle.setPendingDependencies('ada', attempt, canceled);
        lifecycle.finishStart('ada', attempt);
        expect(cockpit()).toEqual([canceled, null]);
    });

    test('where a desktop seat\'s session opened rides its runtime row, and a status without one adds nothing', () => {
        const
            registryStub  = {listAgents: () => [{id: 'alice'}, {id: 'bob'}]},
            sessionFolder = {state: 'pending', expected: '/agents/alice/neomjs/neo'};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => id === 'alice'
                ? {id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-03T19:00:00Z', exitCode: null, sessionFolder}
                : {id, state: 'running', running: true, pid: 4343, startedAt: '2026-10-03T19:00:00Z', exitCode: null, sessionFolder: null}
        };

        const [alice, bob] = FleetManager.fleetRuntimeStatus();

        expect(alice.sessionFolder).toEqual(sessionFolder);
        expect(Object.hasOwn(bob, 'sessionFolder')).toBe(false)
    });

    test('a GUI seat\'s windowPlacement rides its runtime row when present, including macOS Accessibility refusal reasons, and a status without one adds nothing (#1301)', () => {
        const
            registryStub    = {listAgents: () => [{id: 'julia'}, {id: 'ada'}]},
            windowPlacement = {
                state    : 'refused',
                reason   : 'osascript is not allowed assistive access (-25211)',
                requested: {x: 2056, y: 30, width: 788, height: 1056},
                observed : null,
                at       : '2026-10-26T15:00:00.000Z'
            };

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            : id => id === 'julia'
                ? {id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-26T15:00:00Z', exitCode: null, windowPlacement}
                : {id, state: 'running', running: true, pid: 4343, startedAt: '2026-10-26T15:00:00Z', exitCode: null, windowPlacement: null}
        };

        const [julia, ada] = FleetManager.fleetRuntimeStatus();

        expect(julia.windowPlacement).toEqual(windowPlacement);
        expect(Object.hasOwn(ada, 'windowPlacement')).toBe(false)
    });

    test('why a seat exited without a Stop rides its runtime row when present', () => {
        const
            registryStub = {listAgents: () => [{id: 'alice'}, {id: 'bob'}]},
            exitReason   = {state: 'harness-update', exitedAt: '2026-10-15T12:26:13.450Z', logPath: '/tmp/main.log', matchedLine: '2026-10-15 14:26:13 [info] beforeQuitForUpdate'};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            : id => id === 'alice'
                ? {id, state: 'stopped', running: false, pid: null, startedAt: '2026-10-15T10:00:00Z', exitCode: 0, exitedAt: '2026-10-15T12:26:13.450Z', exitReason}
                : {id, state: 'stopped', running: false, pid: null, startedAt: '2026-10-15T10:00:00Z', exitCode: 0, exitedAt: '2026-10-15T12:26:13.450Z', exitReason: null}
        };

        const [alice, bob] = FleetManager.fleetRuntimeStatus();

        expect(alice.exitReason).toEqual(exitReason);
        expect(Object.hasOwn(bob, 'exitReason')).toBe(false)
    });

    test('unresolved helper cleanup and its failureReason ride the runtime row when present (#1074)', () => {
        const
            registryStub  = {listAgents: () => [{id: 'alice'}, {id: 'bob'}]},
            failureReason = 'Codex Desktop helper cleanup failed: ambiguous profile-owned process identity (pid 4242); refusing cleanup.';

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            : id => id === 'alice'
                ? {id, state: 'failed', running: false, pid: null, startedAt: '2026-10-15T10:00:00Z', exitCode: 0, exitedAt: '2026-10-15T12:26:13.450Z', cleanupUnresolved: true, failureReason}
                : {id, state: 'stopped', running: false, pid: null, startedAt: '2026-10-15T10:00:00Z', exitCode: 0, exitedAt: '2026-10-15T12:26:13.450Z', cleanupUnresolved: false, failureReason: null}
        };

        const [alice, bob] = FleetManager.fleetRuntimeStatus();

        expect(alice).toMatchObject({state: 'failed', cleanupUnresolved: true, failureReason});
        expect(Object.hasOwn(bob, 'cleanupUnresolved')).toBe(false);
        expect(Object.hasOwn(bob, 'failureReason')).toBe(false);
    });

    test('the Git identity a seat\'s last start resolved rides its runtime row, a refused start\'s included', () => {
        const
            registryStub = {listAgents: () => [{id: 'alice'}, {id: 'bob'}, {id: 'carol'}]},
            derived      = {state: 'derived', source: 'verified-primary', name: 'Alice', email: 'alice@example.test'};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => ({
                alice: {id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-03T20:00:00Z', exitCode: null, gitIdentity: derived},
                bob  : {id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null, gitIdentity: {state: 'missing', name: 'Bob'}},
                carol: {id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null, gitIdentity: null}
            })[id]
        };

        const [alice, bob, carol] = FleetManager.fleetRuntimeStatus();

        expect(alice.gitIdentity).toEqual(derived);
        expect(bob.gitIdentity).toEqual({state: 'missing', name: 'Bob'});
        expect(Object.hasOwn(carol, 'gitIdentity')).toBe(false)
    });

    test('a Desktop seat\'s launch admission rides its runtime row and reaches the cockpit row; a seat without one adds nothing', () => {
        const
            registryStub = {listAgents: () => [{id: 'ada', harnessType: 'claude-desktop'}, {id: 'sophie', harnessType: 'codex-desktop'}]},
            stale        = {state: 'stale', reason: 'issuer-replaced', generation: null, since: null, servers: [], recent: []};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            : id => ({id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-07T08:00:00Z', exitCode: null,
                launchAdmission: id === 'ada' ? stale : null})
        };

        const
            runtime       = FleetManager.fleetRuntimeStatus(),
            [ada, sophie] = runtime,
            rows          = createFleetCockpitStatus({agents: registryStub.listAgents(), runtimeStatus: runtime}).rows;

        expect(ada.launchAdmission).toEqual(stale);
        expect(Object.hasOwn(sophie, 'launchAdmission')).toBe(false);
        expect(rows.map(row => row.launchAdmission)).toEqual([stale, null])
    });

    test('what a Codex seat\'s config is set to rides its runtime row; a seat with nothing to read back adds nothing', () => {
        const
            registryStub = {listAgents: () => [{id: 'sophie', harnessType: 'codex-desktop'}, {id: 'ada', harnessType: 'claude-desktop'}]},
            configured   = {model: 'gpt-6-astra', reasoningEffort: 'ultra'};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: agent => agent.id === 'sophie' ? configured : null,
            status            : id => ({id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null})
        };

        const [sophie, ada] = FleetManager.fleetRuntimeStatus();

        expect(sophie.harnessSettings, 'a stopped seat reads back too').toEqual(configured);
        expect(Object.hasOwn(ada, 'harnessSettings')).toBe(false)
    });

    test('runtime rows keep the original Start separate from the package selected for the next Start', () => {
        const original  = {id: 'a'.repeat(64), pin: 'held'};
        const installed = {id: 'b'.repeat(64), directory: '/unrecorded-runtime/' + 'b'.repeat(64),
            payloadDigest: 'c'.repeat(64), identity: ['product', 'brain', 'engine', 'electron']};
        FleetManager.lifecycleService = {
            installedRuntime  : {generation: installed},
            getRegistry       : () => ({listAgents: () => [{id: 'alice'}, {id: 'bob'}]}),
            harnessSettingsFor: () => null,
            status            : id => ({id, state: id === 'alice' ? 'running' : 'stopped', running: id === 'alice',
                runtimeGeneration: id === 'alice' ? original : null})
        };
        const rows = FleetManager.fleetRuntimeStatus();
        expect(rows[0].runtimeGeneration).toEqual(original);
        expect(rows.map(row => row.nextRuntimeGeneration)).toEqual([installed, installed].map(value =>
            ({id: value.id, payloadDigest: value.payloadDigest, identity: value.identity})));
        expect(rows[0].nextRuntimeGeneration.identity).not.toBe(installed.identity);
        expect(rows[0].installedGeneration).toMatchObject({state: 'unknown', id: null});
        expect(rows[1]).not.toHaveProperty('runtimeGeneration');
        FleetManager.lifecycleService.installedRuntime = null;
        expect(FleetManager.fleetRuntimeStatus().every(row => !Object.hasOwn(row, 'installedGeneration'))).toBe(true);
    });

    test('an agent the fleet never launched reports unmanaged, NOT stopped — never-launched is not stopped (#17305)', () => {
        // The incident: nine external-harness seats rendered `benched / offline` because `status()`
        // answers `stopped` for an agent it holds no record of — a sound lifecycle default, an
        // invented verdict once republished as fleet truth. The row must still EXIST (the roster
        // guarantee is about row existence), it just may not assert a session state.
        const registryStub = {listAgents: () => [{id: 'grace'}]};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => ({id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null})
        };

        const [row] = FleetManager.fleetRuntimeStatus();

        expect(row.state).toBe('unmanaged');
        expect(row.state).not.toBe('stopped');
        // Absence of signal, never a verdict: no confidence is claimed, and the cause travels with
        // the fact because downstream normalization is forbidden from inventing one.
        expect(row.confidence).toBe('none');
        expect(row.reason).toBe('no fleet process record: this agent runs outside fleet supervision');
    });

    test('a tracked-but-stopped agent reads observed (a process record backs it) — state never invented', () => {
        const registryStub = {listAgents: () => [{id: 'alice'}]};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => ({id, state: 'stopped', running: false, pid: null, startedAt: '2026-07-04T00:00:00Z', exitCode: 1})
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([
            {agentId: 'alice', state: 'stopped', running: false, confidence: 'observed', source: 'fleet:runtimeStatus'}
        ]);
    });

    test('a fleet-launched seat with no process record reads stopped, labelled inferred — an external one stays unmanaged', () => {
        const registryStub = {listAgents: () => [{id: 'cockpit', launchOwner: 'fleet'}, {id: 'grace', launchOwner: 'external'}]};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => ({id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null})
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([{
            agentId   : 'cockpit',
            state     : 'stopped',
            running   : false,
            confidence: 'inferred',
            reason    : 'no fleet process record: this fleet is the seat\'s only launcher, so it is stopped',
            source    : 'fleet:runtimeStatus'
        }, {
            agentId   : 'grace',
            state     : 'unmanaged',
            running   : false,
            confidence: 'none',
            reason    : 'no fleet process record: this agent runs outside fleet supervision',
            source    : 'fleet:runtimeStatus'
        }]);
    });

    test('a process record wins over the inference: a fleet-launched seat that ran reads observed', () => {
        const registryStub = {listAgents: () => [{id: 'cockpit', launchOwner: 'fleet'}]};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => ({id, state: 'running', running: true, pid: 4242, startedAt: '2026-09-19T00:00:00Z', exitCode: null})
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([
            {agentId: 'cockpit', state: 'running', running: true, confidence: 'observed', source: 'fleet:runtimeStatus'}
        ]);
    });

    test('an installed-capability refusal surfaces as observed unavailable with a safe reason', () => {
        const registryStub = {listAgents: () => [{id: 'desktop'}]};

        FleetManager.lifecycleService = {
            getRegistry       : () => registryStub,
            harnessSettingsFor: () => null,
            status            :id => ({
                id,
                state        : 'unavailable',
                running      : false,
                pid          : null,
                startedAt    : null,
                exitCode     : null,
                failureReason: 'updater-disable-predicate-missing'
            })
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([{
            agentId      : 'desktop',
            state        : 'unavailable',
            running      : false,
            confidence   : 'observed',
            source       : 'fleet:runtimeStatus',
            failureReason: 'updater-disable-predicate-missing'
        }]);
    });
});

test.describe('FleetManager exact installed-runtime restart', () => {
    let root, directory, receiptFile, receipt, next, calls;
    test.beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-runtime-restart-')));
        directory = path.join(root, 'runtime');
        const installed = path.join(root, 'Installed.app'), rollback = path.join(root, 'Rollback'), parked = path.join(root, 'Parked');
        receipt = {electronVersion: '43.5.0', owners: Object.fromEntries(['product', 'brain', 'engine'].map((name, i) =>
            [name, {revision: String(i + 1).repeat(40)}]))};
        receiptFile = path.join(installed, PACKAGE_RECEIPT_PATH);
        fs.mkdirSync(path.dirname(receiptFile), {recursive: true});
        fs.mkdirSync(directory, {mode: 0o700});
        fs.writeFileSync(receiptFile, JSON.stringify(receipt));
        const identity = runtimeGenerationIdentity(receipt);
        next = {...identity, directory: path.join(directory, identity.id), payloadDigest: 'd'.repeat(64)};
        fs.writeFileSync(path.join(directory, PACKAGE_SLOTS_RECORD), JSON.stringify({version: 1, directory,
            completionId : '12345678-1234-4234-8234-123456789abc', completedAt: '2026-10-15T13:00:00Z',
            selectedPaths: [installed, rollback, parked], slots: [{path: installed, exists: true, receipt},
                {path: rollback, exists: false, receipt: null}, {path: parked, exists: false, receipt: null}]}), {mode: 0o600});
        calls = [];
        FleetManager.lifecycleService = lifecycleWithStarts({installedRuntime: {generation: next},
            getRegistry: () => ({getAgent: () => null}),
            stop       : async () => { calls.push('stop'); return {cleanupUnresolved: false} }
        });
        FleetManager.managedRoot = '/managed/root';
        FleetManager.provisionAndStartFn = async () => { calls.push('start'); return {runtimeGeneration: next.id} };
    });
    test.afterEach(() => {
        FleetManager.lifecycleService = null;
        FleetManager.managedRoot = null;
        FleetManager.provisionAndStartFn = null;
        fs.rmSync(root, {recursive: true, force: true});
    });
    test('an exact installed and next-Start match uses the existing Stop then provisioned Start', async () => {
        await expect(FleetManager.restartAgent('seat', {expectedRuntimeGeneration: next.id})).resolves.toEqual({runtimeGeneration: next.id});
        expect(calls).toEqual(['stop', 'start']);
    });
    test('a changed displayed identity refuses before Stop', async () => {
        await expect(FleetManager.restartAgent('seat', {expectedRuntimeGeneration: 'f'.repeat(64)})).rejects.toMatchObject({code: 'runtime-target-changed'});
        expect(calls).toEqual([]);
    });
    test('an incumbent selecting another runtime and an unverified installed slot each refuse before Stop', async () => {
        FleetManager.lifecycleService.installedRuntime.generation = {...next, id: 'f'.repeat(64)};
        await expect(FleetManager.restartAgent('seat', {expectedRuntimeGeneration: next.id})).rejects.toMatchObject({code: 'runtime-target-changed'});
        FleetManager.lifecycleService.installedRuntime.generation = next;
        fs.unlinkSync(path.join(directory, PACKAGE_SLOTS_RECORD));
        await expect(FleetManager.restartAgent('seat', {expectedRuntimeGeneration: next.id})).rejects.toMatchObject({code: 'runtime-target-changed'});
        expect(calls).toEqual([]);
    });
    test('a target changing while Stop settles never starts a different generation', async () => {
        FleetManager.lifecycleService.stop = async () => {
            calls.push('stop');
            fs.writeFileSync(receiptFile, JSON.stringify({...receipt, changed: true}));
            return {cleanupUnresolved: false};
        };
        await expect(FleetManager.restartAgent('seat', {expectedRuntimeGeneration: next.id})).rejects.toMatchObject({code: 'runtime-target-changed'});
        expect(calls).toEqual(['stop']);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — Codex Desktop cleanup failure gates', () => {
    let calls, registryStub;

    test.beforeEach(() => {
        calls = [];
        registryStub = {
            getAgent   : () => null,
            removeAgent: id => { calls.push(['removeAgent', id]); return {success: true, id}; }
        };

        FleetManager.lifecycleService = lifecycleWithStarts({
            getRegistry: () => registryStub,
            stop       : async id => ({success: false, id, state: 'failed', cleanupUnresolved: true})
        });
        FleetManager.managedRoot        = '/managed/root';
        FleetManager.provisionAndStartFn = async options => {
            calls.push(['start', options.agentId]);
            return {id: options.agentId, state: 'running'};
        };
    });

    test.afterEach(() => {
        FleetManager.lifecycleService   = null;
        FleetManager.managedRoot        = null;
        FleetManager.provisionAndStartFn = null;
    });

    test('restart refuses to spawn over ambiguous residual helpers', async () => {
        await expect(FleetManager.restartAgent('desktop')).rejects.toThrow(/cleanup failed.*refusing to spawn/);

        expect(calls).toEqual([]);
    });

    test('remove refuses to deregister the owner of ambiguous residual helpers', async () => {
        await expect(FleetManager.removeAgent('desktop')).rejects.toThrow(/cleanup failed.*refusing to deregister/);

        expect(calls).toEqual([]);
    });

    test('ordinary failed harnesses retain the legacy restart and removal recovery paths', async () => {
        FleetManager.lifecycleService.stop = async id => ({success: false, id, state: 'failed', cleanupUnresolved: false});

        await expect(FleetManager.restartAgent('cli')).resolves.toMatchObject({id: 'cli', state: 'running'});
        await expect(FleetManager.removeAgent('cli')).resolves.toEqual({success: true, id: 'cli'});

        expect(calls).toEqual([['start', 'cli'], ['removeAgent', 'cli']]);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — an explicit release is start authority', () => {
    let calls, definitions;

    test.beforeEach(() => {
        calls       = [];
        definitions = {
            adopted : {id: 'adopted',  launchOwner: 'fleet',    launchOwnerSince: '2026-09-19T17:00:00.000Z'},
            default : {id: 'default',  launchOwner: 'external'},
            released: {id: 'released', launchOwner: 'external', launchOwnerSince: '2026-09-19T17:05:00.000Z'}
        };

        FleetManager.lifecycleService = lifecycleWithStarts({
            getRegistry: () => ({getAgent: id => definitions[id] ?? null}),
            stop       : async id => { calls.push(['stop', id]); return {success: true, id, state: 'stopped'}; }
        });
        FleetManager.managedRoot         = '/managed/root';
        FleetManager.provisionAndStartFn = async options => {
            calls.push(['start', options.agentId]);
            return {id: options.agentId, state: 'running'};
        };
    });

    test.afterEach(() => {
        FleetManager.lifecycleService    = null;
        FleetManager.managedRoot         = null;
        FleetManager.provisionAndStartFn = null;
    });

    test('a released seat is refused in the registry\'s words, before anything is spawned', async () => {
        await expect(FleetManager.startAgent('released'))
            .rejects.toThrow("FleetManager.startAgent: agent 'released' was released to its own harness: adopt it to start it here.");

        expect(calls).toEqual([]);
    });

    test('a restart of a released seat is refused before the stop, so it never ends half done', async () => {
        await expect(FleetManager.restartAgent('released')).rejects.toThrow(/FleetManager\.restartAgent: agent 'released' was released/);

        expect(calls).toEqual([]);
    });

    test('a managed Start reads the launch admission mark before it waits for the seat, and hands it to the provisioned start', async () => {
        let mark = 3;

        const marks = [];

        FleetManager.lifecycleService.getLaunchAdmission = () => ({revocationMark: id => id === 'adopted' ? mark : -1});
        FleetManager.provisionAndStartFn = async options => { marks.push(options.admissionMark); return {id: options.agentId, state: 'running'} };

        const started = FleetManager.startAgent('adopted');

        // a Stop asked for while the Start waits for the seat's home
        mark = 4;
        await started;

        expect(marks).toEqual([3])
    });

    test('a seat with no ownership act, an adopted seat, and an id the registry does not know start as before', async () => {
        await FleetManager.startAgent('default');
        await FleetManager.restartAgent('adopted');
        await FleetManager.startAgent('ghost');

        expect(calls).toEqual([['start', 'default'], ['stop', 'adopted'], ['start', 'adopted'], ['start', 'ghost']]);
    });

    test('a seat CREATED external — the roster pilot\'s row — is refused by the real registry before anything is spawned, and an adoption lifts it', async () => {
        const
            tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fleet-manager-born-')),
            priorDataDir = FleetRegistryService.dataDir;

        try {
            FleetRegistryService.dataDir = tmpDir;
            FleetRegistryService.defineAgent({githubUsername: 'born-external', harnessType: 'codex', credential: 'ghp_fixture_only', launchOwner: 'external'});
            FleetManager.lifecycleService = lifecycleWithStarts({
                getRegistry: () => FleetRegistryService,
                stop       : async id => { calls.push(['stop', id]); return {success: true, id, state: 'stopped'}; }
            });

            await expect(FleetManager.startAgent('born-external'))
                .rejects.toThrow("FleetManager.startAgent: agent 'born-external' was released to its own harness: adopt it to start it here.");
            expect(calls).toEqual([]);

            FleetRegistryService.setLaunchOwner('born-external', 'fleet');
            await FleetManager.startAgent('born-external');
            expect(calls).toEqual([['start', 'born-external']])
        } finally {
            // The registry is a singleton: hand its root back before the directory goes, or
            // `ensureLoaded` keeps serving this arm's row to a later case from a deleted root.
            FleetRegistryService.dataDir = priorDataDir;
            fs.rmSync(tmpDir, {recursive: true, force: true})
        }

        expect(FleetRegistryService.getAgent('born-external'), 'a fresh read on the restored root no longer sees the row').toBeNull()
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — a benched identity is start authority (#885)', () => {
    const rows = {
        '@neo-kimi-iris': {identity: '@neo-kimi-iris', state: 'benched', reason: null, signals: {participationStatus: 'operator_benched', statusReason: 'the flatrate ended', participationSince: '2026-08-17T00:00:00.000Z'}},
        '@neo-gpt'      : {identity: '@neo-gpt',       state: 'idle',    reason: null, signals: {participationStatus: 'active'}}
    };

    let calls, readPresence;

    test.beforeEach(() => {
        calls        = [];
        readPresence = async () => ({agents: Object.values(rows)});

        const definitions = {
            iris: {id: 'iris', githubUsername: 'neo-kimi-iris'},
            gpt : {id: 'gpt',  githubUsername: 'neo-gpt'}
        };

        FleetManager.lifecycleService = lifecycleWithStarts({
            getRegistry: () => ({getAgent: id => definitions[id] ?? null}),
            stop       : async id => { calls.push(['stop', id]); return {success: true, id, state: 'stopped'}; }
        });
        FleetManager.managedRoot          = '/managed/root';
        FleetManager.presenceStateOptions = {readPresence: () => readPresence()};
        FleetManager.provisionAndStartFn  = async options => {
            calls.push(['start', options.agentId, await options.readParticipation()]);
            return {id: options.agentId, state: 'running'};
        };
    });

    test.afterEach(() => {
        FleetManager.lifecycleService     = null;
        FleetManager.managedRoot          = null;
        FleetManager.presenceStateOptions = null;
        FleetManager.provisionAndStartFn  = null;
    });

    test('a benched seat is refused in the operator\'s words before anything runs, a restart before its stop', async () => {
        await expect(FleetManager.startAgent('iris'))
            .rejects.toThrow("FleetManager.startAgent: agent 'iris' was benched by the operator on 2026-08-17: the flatrate ended.");
        await expect(FleetManager.restartAgent('iris')).rejects.toThrow(/FleetManager\.restartAgent: agent 'iris' was benched by the operator/);

        expect(calls).toEqual([]);
    });

    test('an active seat starts and hands the spawn its own re-read; an unread participation is no refusal', async () => {
        await FleetManager.startAgent('gpt');
        expect(calls).toEqual([['start', 'gpt', {status: 'active', reason: null, since: null}]]);

        readPresence = async () => { throw new Error('plane unreachable') };
        await FleetManager.startAgent('iris');
        expect(calls[1]).toEqual(['start', 'iris', null]);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — fleetWakeStatus (roster × wake observation)', () => {
    test.afterEach(() => {
        FleetManager.lifecycleService = null;
        FleetManager.wakeStateOptions = null;
    });

    test('composes the roster with the injected wake truth sources — every registered agent gets a taxonomy row', async () => {
        FleetManager.lifecycleService = {getRegistry: () => ({listAgents: () => [{id: 'alice'}, {id: 'bob'}]})};
        FleetManager.wakeStateOptions = {
            pidFilePath             : '/x/wake-daemon.pid',
            readFile                : () => '4242',
            probeProcess            : () => {},
            readProcessCommand      : () => 'node /repo/ai/daemons/wake/daemon.mjs',
            resolveSubscriptionState: agent => agent.id === 'alice' ? 'active' : 'none'
        };

        const {capability, states} = await FleetManager.fleetWakeStatus();

        expect(capability).toMatchObject({state: 'wired', confidence: 'observed'});
        expect(states).toEqual([
            {agentId: 'alice', wake: 'on',  confidence: 'observed', source: 'fleet:wakeState'},
            {agentId: 'bob',   wake: 'off', confidence: 'observed', source: 'fleet:wakeState'}
        ]);
    });

    test('with no injected options every row is honestly unknown under a degraded/none capability — never invented', async () => {
        FleetManager.lifecycleService = {getRegistry: () => ({listAgents: () => [{id: 'alice'}]})};

        const {capability, states} = await FleetManager.fleetWakeStatus();

        expect(capability).toMatchObject({state: 'degraded', confidence: 'none'});
        expect(states).toEqual([{
            agentId   : 'alice',
            wake      : 'unknown',
            confidence: 'none',
            source    : 'fleet:wakeState',
            reason    : 'subscription read path unavailable'
        }]);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — fleetThrottleStatus (roster × throttle observation)', () => {
    test.afterEach(() => {
        FleetManager.lifecycleService     = null;
        FleetManager.throttleStateOptions = null;
    });

    test('composes the roster with an injected throttle truth source — the watchdog flip-target', async () => {
        FleetManager.lifecycleService     = {getRegistry: () => ({listAgents: () => [{id: 'alice'}, {id: 'bob'}]})};
        FleetManager.throttleStateOptions = {
            resolveThrottleState: agent => agent.id === 'alice' ? 'rate-limited' : 'none'
        };

        const {capability, states} = await FleetManager.fleetThrottleStatus();

        expect(capability).toMatchObject({state: 'wired', confidence: 'observed'});
        expect(states).toEqual([
            {agentId: 'alice', throttle: 'rate-limited', confidence: 'observed', source: 'fleet:throttleState'},
            {agentId: 'bob',   throttle: 'none',         confidence: 'observed', source: 'fleet:throttleState'}
        ]);
    });

    test('with no injected options every row is honestly unknown under degraded/none — the documented platform truth', async () => {
        FleetManager.lifecycleService = {getRegistry: () => ({listAgents: () => [{id: 'alice'}]})};

        const {capability, states} = await FleetManager.fleetThrottleStatus();

        expect(capability).toMatchObject({state: 'degraded', confidence: 'none'});
        expect(states).toEqual([{
            agentId   : 'alice',
            throttle  : 'unknown',
            confidence: 'none',
            source    : 'fleet:throttleState',
            reason    : 'no throttle truth source exists yet: watchdog-signals producer not landed'
        }]);
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — fleetSeatModelCatalog (what Configuration offers to declare)', () => {
    const SEAT = {id: 'sophie', githubUsername: 'sophie', harnessType: 'codex-desktop'};

    test.afterEach(() => {
        FleetManager.lifecycleService    = null;
        FleetManager.managedRoot         = null;
        FleetManager.modelCatalogFn      = null;
        FleetManager.provisionAndStartFn = null;
        FleetManager.wakeArmFn           = null;
    });

    const lifecycle = ({running = false, kept = null} = {}) => lifecycleWithStarts({
        getRegistry    : () => ({getDefinition: id => (id === 'sophie' ? SEAT : null), getAgent: () => null}),
        getInstanceRoot: () => '/agents',
        isRunning      : () => running,
        seatCatalogOf  : () => kept
    });

    test('a stopped seat is read fresh, through the read Start runs', async () => {
        const calls = [], answer = {state: 'complete', models: [{id: 'gpt-6-astra'}], reason: null};

        FleetManager.lifecycleService = lifecycle();
        FleetManager.modelCatalogFn   = async args => { calls.push(args); return answer };

        expect(await FleetManager.fleetSeatModelCatalog({id: 'sophie'})).toEqual(answer);
        expect(calls.map(({agent, instanceRoot}) => [agent.id, instanceRoot])).toEqual([['sophie', '/agents']]);
    });

    test('a running seat answers what its last start read, never a second app-server beside its own', async () => {
        const kept = {state: 'complete', models: [], reason: null, observedAt: '2026-10-04T20:00:00.000Z'};

        FleetManager.lifecycleService = lifecycle({running: true, kept});
        FleetManager.modelCatalogFn   = async () => { throw new Error('must not read') };

        expect(await FleetManager.fleetSeatModelCatalog({id: 'sophie'})).toEqual(kept);

        FleetManager.lifecycleService = lifecycle({running: true});
        expect((await FleetManager.fleetSeatModelCatalog({id: 'sophie'})).reason).toBe('the seat has run since before this Fleet started, so its catalog is read at its next start');
    });

    test('reads and a start take one seat\'s home one at a time: a running check never admits a second app-server', async () => {
        const
            seat    = {running: false},
            entered = [],
            gates   = [],
            gate    = () => new Promise(release => gates.push(release)),
            open    = async (count) => {
                await expect.poll(() => entered.length).toBe(count);
                gates.shift()()
            };

        FleetManager.lifecycleService    = Object.assign(lifecycle({kept: {state: 'complete', models: [], reason: null, observedAt: 'at the start'}}), {isRunning: () => seat.running});
        FleetManager.managedRoot         = '/managed';
        FleetManager.wakeArmFn           = async () => null;
        FleetManager.modelCatalogFn      = async () => { entered.push('read'); await gate(); return {state: 'complete', models: [], reason: null} };
        FleetManager.provisionAndStartFn = async () => { entered.push('start'); await gate(); seat.running = true; return {state: 'running'} };

        const
            first  = FleetManager.fleetSeatModelCatalog({id: 'sophie'}),
            second = FleetManager.fleetSeatModelCatalog({id: 'sophie'}),
            start  = FleetManager.startAgent('sophie'),
            third  = FleetManager.fleetSeatModelCatalog({id: 'sophie'});

        await open(1);
        await first;
        expect(entered, 'the second read waited for the first').toEqual(['read', 'read']);
        await open(2);
        await second;
        await open(3);
        await start;

        // the read queued behind the start finds the seat running, and answers what its start kept
        expect(await third).toMatchObject({observedAt: 'at the start'});
        expect(entered).toEqual(['read', 'read', 'start']);
    });

    test('an operation that fails releases the seat\'s home', async () => {
        FleetManager.lifecycleService = lifecycle();
        FleetManager.managedRoot      = '/managed';
        FleetManager.provisionAndStartFn = async () => { throw new Error('startAgentProvisioned: refused') };
        FleetManager.modelCatalogFn   = async () => ({state: 'complete', models: [], reason: null});

        await expect(FleetManager.startAgent('sophie')).rejects.toThrow('refused');
        expect((await FleetManager.fleetSeatModelCatalog({id: 'sophie'})).state).toBe('complete');
        expect(FleetManager.seatHomeHolds.size).toBe(0);
    });

    test('an unknown seat, or a read that throws, answers its state and reason — never a refusal', async () => {
        FleetManager.lifecycleService = lifecycle();
        expect(await FleetManager.fleetSeatModelCatalog({id: 'nobody'})).toEqual({state: 'unavailable', models: [], reason: "no agent 'nobody' is registered"});

        FleetManager.modelCatalogFn = async () => { throw new Error('spawn EACCES') };
        expect(await FleetManager.fleetSeatModelCatalog({id: 'sophie'})).toMatchObject({state: 'unavailable', models: [], reason: expect.stringContaining('the catalog read failed')});
    });
});

test.describe('Neo.ai.services.fleet.FleetManager — pending Start cancellation across the seat-home queue', () => {
    const SEATS = {
        ada  : {id: 'ada',  harnessType: 'codex'},
        grace: {id: 'grace', harnessType: 'codex'}
    };

    test.beforeEach(() => {
        FleetManager.seatHomeHolds.clear();
        FleetManager.lifecycleService = lifecycleWithStarts({getRegistry: () => ({getAgent: id => SEATS[id] ?? null})});
        FleetManager.managedRoot = '/managed';
    });

    test.afterEach(() => {
        FleetManager.seatHomeHolds.clear();
        FleetManager.lifecycleService = null;
        FleetManager.managedRoot = null;
        FleetManager.provisionAndStartFn = null;
        FleetManager.wakeArmFn = null;
        FleetManager.presenceStateOptions = null;
        FleetManager.planeBase = null;
        FleetManager.tenantService = null;
        FleetManager.wakeStateOptions = null;
    });

    test('Stop cancels both queued Starts; another seat proceeds and a later fresh Start succeeds', async () => {
        const
            lifecycle = FleetManager.lifecycleService,
            calls     = [],
            home      = Promise.withResolvers();

        FleetManager.provisionAndStartFn = async ({agentId, startSignal}) => {
            calls.push(['compose', agentId, startSignal]);
            return {id: agentId, state: 'running'}
        };
        FleetManager.wakeArmFn = async ({agent, startSignal}) => {
            calls.push(['wake', agent.id, startSignal]);
            return {state: 'ready'}
        };

        const blocker = FleetManager.withSeatHome('ada', () => home.promise);

        await expect.poll(() => FleetManager.seatHomeHolds.has('ada')).toBe(true);

        const first  = FleetManager.startAgent('ada'),
              second = FleetManager.startAgent('ada');

        await expect.poll(() => lifecycle.pendingStarts.get('ada')?.size).toBe(2);

        const otherSeat = await FleetManager.startAgent('grace');
        const stopped   = await FleetManager.stopAgent('ada');

        expect(stopped.canceledStarts).toBe(2);
        expect(calls.map(([kind, id]) => [kind, id])).toEqual([['compose', 'grace'], ['wake', 'grace']]);
        expect(otherSeat).toMatchObject({id: 'grace', state: 'running', wakeRoute: {state: 'ready'}});

        home.resolve();
        await blocker;

        const canceled = await Promise.all([first, second]);

        expect(canceled).toEqual([
            {id: 'ada', state: 'stopped', pid: null, canceled: true, reason: 'stop-requested'},
            {id: 'ada', state: 'stopped', pid: null, canceled: true, reason: 'stop-requested'}
        ]);
        expect(lifecycle.pendingStarts.has('ada')).toBe(false);
        expect(calls.map(([kind, id]) => [kind, id])).toEqual([['compose', 'grace'], ['wake', 'grace']]);

        const fresh = await FleetManager.startAgent('ada');

        expect(fresh).toMatchObject({id: 'ada', state: 'running', wakeRoute: {state: 'ready'}});
        expect(calls.map(([kind, id]) => [kind, id])).toEqual([
            ['compose', 'grace'], ['wake', 'grace'], ['compose', 'ada'], ['wake', 'ada']
        ])
    });

    test('Stop after composition but before wake arming leaves the pending signal registered until cleanup', async () => {
        const
            lifecycle = FleetManager.lifecycleService,
            calls     = [],
            composed  = Promise.withResolvers(),
            release   = Promise.withResolvers();

        FleetManager.provisionAndStartFn = async ({startSignal}) => {
            calls.push(['compose', startSignal]);
            composed.resolve(startSignal);
            await release.promise;
            return {id: 'ada', state: 'running'}
        };
        FleetManager.wakeArmFn = async () => { calls.push(['wake']); return {state: 'ready'} };

        const starting = FleetManager.startAgent('ada'),
              signal   = await composed.promise;

        await FleetManager.stopAgent('ada');
        expect(signal.aborted).toBe(true);
        expect(lifecycle.pendingStarts.get('ada')?.has(signal)).toBe(true);

        release.resolve();
        expect(await starting).toEqual({id: 'ada', state: 'stopped', pid: null, canceled: true, reason: 'stop-requested'});
        expect(calls.map(([kind]) => kind)).toEqual(['compose']);
        expect(lifecycle.pendingStarts.has('ada')).toBe(false)
    });

    /**
     * A Start whose provisioning runs the real `installSeatDependencies`: the seat's first checkout installs at once,
     * and the second keeps `npm` running until its signal aborts and `exit()` lets it end.
     * @returns {{installing: Promise, exit: Function, rows: Function}}
     */
    function startInstalling() {
        const
            installing = Promise.withResolvers(),
            exited     = Promise.withResolvers(),
            checkouts  = [{repoSlug: 'neomjs/neo', repoPath: '/managed/ada/neomjs/neo'}, {repoSlug: 'neomjs/neo-agent-brain', repoPath: '/managed/ada/neomjs/neo-agent-brain'}];
        let rows = null;

        FleetManager.provisionAndStartFn = async ({agentId, startSignal, dependencySkipSignal}) => {
            rows = await installSeatDependencies({
                checkouts,
                seatRoot  : '/managed/ada',
                signal    : startSignal,
                skipSignal: dependencySkipSignal,
                write     : async () => {},
                install   : ({repoPath, signal}) => repoPath === checkouts[0].repoPath ? Promise.resolve({state: 'installed'}) : new Promise(resolve => {
                    installing.resolve();
                    signal.addEventListener('abort', () => exited.promise.then(() => resolve({canceled: true, state: 'failed', reason: 'npm ci canceled'})), {once: true})
                })
            });
            startSignal.throwIfAborted();
            return {id: agentId, state: 'running'}
        };
        FleetManager.wakeArmFn = async () => ({state: 'ready'});

        return {installing: installing.promise, exit: () => exited.resolve(), rows: () => rows}
    }

    test('Skip ends a pending Start\'s install and the Start launches: the interrupted checkout reads skipped, the finished one keeps its outcome', async () => {
        const seat     = startInstalling(),
              starting = FleetManager.startAgent('ada');

        await seat.installing;
        // the operator's Skip arrives as a wire verb, through the real bridge to this manager
        expect(await dispatchFleetRequest(createFleetWireRequest('skipAgentDependencies', 'ada'), FleetControlBridge))
            .toMatchObject({ok: true, result: {id: 'ada', skippedStarts: 1}});
        seat.exit();

        expect(await starting).toMatchObject({id: 'ada', state: 'running', wakeRoute: {state: 'ready'}});
        expect(seat.rows()).toEqual([
            {repoSlug: 'neomjs/neo', state: 'installed'},
            {repoSlug: 'neomjs/neo-agent-brain', state: 'skipped', reason: 'skipped during the install'}
        ]);
        // the attempt is over, so there is nothing left to skip
        expect(FleetManager.skipAgentDependencies('ada')).toEqual({id: 'ada', skippedStarts: 0})
    });

    test('a Stop after a Skip still cancels the Start, and the install it interrupted reads canceled', async () => {
        const seat     = startInstalling(),
              starting = FleetManager.startAgent('ada');

        await seat.installing;
        FleetManager.skipAgentDependencies('ada');
        // npm has not exited from the Skip yet
        expect((await FleetManager.stopAgent('ada')).canceledStarts).toBe(1);
        seat.exit();

        expect(await starting).toEqual({id: 'ada', state: 'stopped', pid: null, canceled: true, reason: 'stop-requested'});
        expect(seat.rows()[1]).toEqual({repoSlug: 'neomjs/neo-agent-brain', state: 'canceled', reason: 'stopped during the install'})
    });

    for (const phase of ['during-client-close', 'after-arming']) {
        test(`Stop ${phase} preserves the real armer's unresolved route without reporting it ready`, async () => {
            const
                entered    = Promise.withResolvers(),
                release    = Promise.withResolvers(),
                plane      = 'http://127.0.0.1:32123',
                calls      = [],
                armResults = [],
                persisted  = [],
                agent      = {id: 'ada', githubUsername: 'ada', harnessType: 'codex-desktop', mcpTarget: {kind: 'tenant', tenantId: 'local'}},
                lifecycle  = lifecycleWithStarts({
                    getRegistry : () => ({getAgent: () => agent}),
                    setWakeRoute: (id, route) => persisted.push({id, route})
                });
            let closes = 0;

            FleetManager.lifecycleService = lifecycle;
            FleetManager.planeBase = plane;
            FleetManager.tenantService = {
                resolveMcpResources : () => ({endpoint: plane, resources: {'memory-core': {url: `${plane}/mc/mcp`}}}),
                resolveMcpCredential: () => 'fixture-credential'
            };
            FleetManager.wakeStateOptions = {wakeReceiverBase: 'http://127.0.0.1:32124', wakeReceiverManifestPath: '/fixture/routes.json'};
            FleetManager.provisionAndStartFn = async () => ({id: 'ada', state: 'running', instanceHome: '/fixture/ada/harness/codex-desktop'});
            FleetManager.wakeArmFn = async options => {
                const route = await armFleetSeatWake({
                    ...options,
                    createClient: () => ({
                        init    : async () => ({ok: true}),
                        callTool: async (name, {action}) => {
                            calls.push(action);
                            return action === 'subscribe' ? {subscriptionId: 'WAKE_SUB:late'} : {subscriptions: [{id: 'WAKE_SUB:late'}]}
                        },
                        close: async () => {
                            if (++closes === 1 && phase === 'during-client-close') {
                                entered.resolve();
                                await release.promise
                            }
                        }
                    }),
                    armRoute: async ({listSubscriptions}) => ({armed: true, subscriptionIds: (await listSubscriptions()).map(row => row.id)})
                });

                armResults.push(route);
                if (armResults.length === 1 && phase === 'after-arming') {
                    entered.resolve();
                    await release.promise
                }
                return route
            };

            const starting = FleetManager.startAgent('ada');

            await entered.promise;
            const signal = [...lifecycle.pendingStarts.get('ada').keys()][0];

            await FleetManager.stopAgent('ada');
            expect(signal.aborted).toBe(true);
            expect(lifecycle.pendingStarts.get('ada').has(signal)).toBe(true);
            release.resolve();

            expect(await starting).toMatchObject({
                canceled : true,
                state    : 'stopped',
                wakeRoute: {state: 'unarmed', reason: 'start canceled by Stop', cleanupUnresolved: true, subscriptionId: 'WAKE_SUB:late'}
            });
            expect(armResults[0].state).toBe(phase === 'during-client-close' ? 'unarmed' : 'ready');
            expect(calls).toEqual(['subscribe', 'list']);
            expect(persisted).toEqual([]);
            expect(lifecycle.pendingStarts.has('ada')).toBe(false);
            expect(FleetManager.seatHomeHolds.has('ada')).toBe(false);

            expect(await FleetManager.startAgent('ada')).toMatchObject({state: 'running', wakeRoute: {state: 'ready', subscriptionId: 'WAKE_SUB:late'}});
            expect(persisted).toHaveLength(1);
            expect(lifecycle.pendingStarts.has('ada')).toBe(false)
        });
    }
});

test.describe('Neo.ai.services.fleet.FleetManager — fleetSeatGitIdentity (the identity Add reads after a define)', () => {
    const
        SEAT     = {id: 'alice', githubUsername: 'alice', harnessType: 'codex'},
        registry = ({agents = {alice: SEAT}, credentials = {alice: 'ghp_alice'}} = {}) => ({
            getDefinition    : id => agents[id] ?? null,
            getAgent         : id => agents[id] ?? null,
            resolveCredential: id => credentials[id] ?? null
        });

    test.afterEach(() => {
        FleetManager.lifecycleService = null;
        FleetManager.gitIdentityFn    = null;
    });

    test('answers the derivation Start runs, from the seat\'s definition and its stored PAT', async () => {
        const
            calls   = [],
            derived = {state: 'derived', source: 'verified-primary', name: 'Alice', email: 'alice@example.test'};

        FleetManager.lifecycleService = {getRegistry: () => registry()};
        FleetManager.gitIdentityFn    = async args => { calls.push(args); return derived };

        expect(await FleetManager.fleetSeatGitIdentity({id: 'alice'})).toEqual(derived);
        expect(calls).toEqual([{agent: SEAT, credential: 'ghp_alice'}]);
    });

    test('a read that fails answers unknown with its reason, never derived, and never throws', async () => {
        FleetManager.lifecycleService = {getRegistry: () => registry()};
        FleetManager.gitIdentityFn    = async () => { throw new Error('socket hang up') };

        expect(await FleetManager.fleetSeatGitIdentity({id: 'alice'})).toEqual({state: 'unknown', reason: 'the identity read failed: socket hang up'});
    });

    test('an unknown seat, or one without a PAT, answers unknown and reads no forge', async () => {
        const calls = [];

        FleetManager.lifecycleService = {getRegistry: () => registry({credentials: {}})};
        FleetManager.gitIdentityFn    = async args => { calls.push(args); return {state: 'derived'} };

        expect(await FleetManager.fleetSeatGitIdentity({id: 'nobody'})).toEqual({state: 'unknown', reason: "no agent 'nobody' is registered"});
        expect(await FleetManager.fleetSeatGitIdentity({id: 'alice'})).toEqual({state: 'unknown', reason: 'no PAT is stored for it'});
        expect(calls).toEqual([]);
    });

    test('a declared identity answers as declared, without a PAT or a forge read', async () => {
        FleetManager.lifecycleService = {getRegistry: () => registry({agents: {alice: {...SEAT, gitName: 'Alice', gitEmail: 'alice@example.test'}}, credentials: {}})};

        expect(await FleetManager.fleetSeatGitIdentity({id: 'alice'})).toEqual({state: 'declared', source: 'declared', name: 'Alice', email: 'alice@example.test'});
    });
});

test.describe.serial('Neo.ai.services.fleet.FleetManager — replaceSeatCredential (#815)', () => {
    const
        PLANE    = 'http://127.0.0.1:3102',
        SERVED   = Object.freeze({id: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data'}),
        OLD_PAT  = 'ghp_OLD_SECRET_CREDENTIAL_TOKEN_815',
        NEW_PAT  = 'ghp_NEW_SECRET_CREDENTIAL_TOKEN_815',
        PEER_PAT = 'ghp_PEER_CONCURRENT_TOKEN_815',
        asPlane  = (mcPlane = SERVED, kbPlane = mcPlane, overrides = {}) => async ({expectedIdentity, servedPlane}) => ({
            ok       : true,
            status   : 200,
            verdict  : 'proved',
            resources: {
                'memory-core'   : {ok: true, status: 200, verdict: 'proved', identity: expectedIdentity, ...(servedPlane ? {plane: mcPlane} : {}), ...overrides.mc},
                'knowledge-base': {ok: true, status: 200, verdict: 'proved', ...(servedPlane ? {plane: kbPlane} : {}), ...overrides.kb}
            }
        });

    let tmpDir, managedRoot, running, cleanupUnresolved, startedWith;

    function createLifecycle() {
        return lifecycleWithStarts({
            getRegistry                    : () => FleetRegistryService,
            getInstanceRoot                : () => managedRoot,
            resolveResidentMcpEnvironment  : () => ({}),
            assertRemoteMcpCapability      : async () => ({ok: true, binaryPath: '/usr/bin/codex'}),
            inspectPreparedRemoteMcpAdapter: async () => {},
            isRunning                      : id => running.has(id),
            status                         : id => ({
                id,
                state            : running.has(id) ? 'running' : cleanupUnresolved.has(id) ? 'failed' : 'stopped',
                running          : running.has(id),
                cleanupUnresolved: cleanupUnresolved.has(id),
                pid              : running.has(id) ? 4242 : null
            }),
            setGitIdentity        : () => {},
            setSeatCatalog        : () => {},
            setSeatModel          : () => {},
            setPendingDependencies: () => {},
            setDependencies       : () => {},
            setRepoOutcomes       : () => true,
            start                 : async (id, options) => {
                startedWith.push({id, options});
                running.add(id);
                return {id, state: 'running', pid: 4242}
            }
        })
    }

    test.beforeEach(async () => {
        tmpDir            = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-replace-cred-815-'));
        managedRoot       = path.join(tmpDir, 'managed');
        running           = new Set();
        cleanupUnresolved = new Set();
        startedWith       = [];

        fs.mkdirSync(managedRoot, {recursive: true});

        FleetRegistryService.dataDir    = tmpDir;
        FleetRegistryService.agentsRoot = managedRoot;
        FleetTenantService.dataDir      = tmpDir;
        FleetTenantService.probeFn      = asPlane();

        FleetRegistryService.defineAgent({
            id            : 'alice',
            githubUsername: 'alice',
            harnessType   : 'codex',
            credential    : OLD_PAT,
            gitName       : 'Alice',
            gitEmail      : 'alice@example.test',
            launchOwner   : 'fleet',
            metadata      : {repo: {repoSlug: 'neomjs/neo', cloneUrl: 'https://github.com/neomjs/neo.git'}}
        });

        await FleetTenantService.storeSeatPlaneCredential({
            planeBase : PLANE,
            agentId   : 'alice',
            identity  : '@alice',
            credential: OLD_PAT
        });

        FleetManager.lifecycleService = createLifecycle();
        FleetManager.tenantService    = FleetTenantService;
        FleetManager.managedRoot      = managedRoot;
        FleetManager.planeBase        = PLANE;
        FleetManager.forgeProofFn     = async ({agent, credential}) => credential === NEW_PAT
            ? {ok: true, verdict: 'proved', login: agent.githubUsername}
            : {
                ok               : false,
                verdict          : 'refused',
                reason           : 'HTTP 401',
                cause            : 'revoked',
                credentialRefusal: {cause: 'revoked', surface: 'forge', verdict: 'refused', status: 401, reason: 'HTTP 401'}
            };

        FleetControlBridge.registry      = FleetRegistryService;
        FleetControlBridge.manager       = FleetManager;
        FleetControlBridge.tenantService = FleetTenantService;
    });

    test.afterEach(() => {
        FleetControlBridge.registry        = null;
        FleetControlBridge.manager         = null;
        FleetControlBridge.tenantService   = null;
        FleetManager.lifecycleService      = null;
        FleetManager.tenantService         = null;
        FleetManager.managedRoot           = null;
        FleetManager.planeBase             = null;
        FleetManager.forgeProofFn          = null;
        FleetManager.gitIdentityFn         = null;
        FleetManager.seatHomeHolds.clear();
        FleetTenantService.dataDir         = null;
        FleetTenantService.probeFn         = null;
        FleetRegistryService.dataDir    = null;
        FleetRegistryService.agentsRoot = null;
        fs.rmSync(tmpDir, {recursive: true, force: true});
    });

    test('exports closed scopes and refusal causes, and refuses missing, unknown, or blank inputs before any probe', async () => {
        expect(REPLACE_SEAT_CREDENTIAL_SCOPES).toEqual(['forge', 'forge-and-bound-plane']);
        expect(CREDENTIAL_REFUSAL_CAUSES).toEqual([
            'authentication-rejected',
            'expired',
            'revoked',
            'insufficient-capability',
            'wrong-identity',
            'plane-mismatch',
            'transport-unavailable',
            'indeterminate'
        ]);

        let forgeCalls = 0, planeCalls = 0;
        FleetManager.forgeProofFn  = async () => { forgeCalls++; return {ok: true, verdict: 'proved'} };
        FleetTenantService.probeFn = async args => { planeCalls++; return asPlane()(args) };

        for (const payload of [
            null,
            {},
            {id: 'alice', credential: NEW_PAT},
            {id: 'alice', credential: NEW_PAT, scope: 'all'},
            {id: 'alice', credential: '   ', scope: 'forge'},
            {id: 'ghost', credential: NEW_PAT, scope: 'forge'}
        ]) {
            const result = await FleetManager.replaceSeatCredential(payload);
            expect(result.status).toBe('rejected');
            expect(JSON.stringify(result)).not.toContain(NEW_PAT);
        }

        expect(forgeCalls).toBe(0);
        expect(planeCalls).toBe(0);
        expect(FleetRegistryService.resolveCredential('alice')).toBe(OLD_PAT);
    });

    test('refuses replacement while the seat is running or its shared desktop profile is still in use (AC-3)', async () => {
        let forgeCalls = 0;
        FleetManager.forgeProofFn = async () => { forgeCalls++; return {ok: true, verdict: 'proved'} };

        running.add('alice');
        expect(await FleetManager.replaceSeatCredential({
            id        : 'alice',
            credential: NEW_PAT,
            scope     : 'forge-and-bound-plane'
        })).toMatchObject({
            status : 'rejected',
            id     : 'alice',
            scope  : 'forge-and-bound-plane',
            cause  : 'seat-running',
            reason : "agent 'alice' is running; stop it before replacing its credential",
            receipt: {
                scope             : 'forge-and-bound-plane',
                persistedAuthority: {forge: 'unchanged', plane: 'unchanged'},
                carrier           : 'deferred-until-start',
                session           : 'running'
            }
        });

        running.delete('alice');
        cleanupUnresolved.add('alice');
        expect(await FleetManager.replaceSeatCredential({
            id        : 'alice',
            credential: NEW_PAT,
            scope     : 'forge-and-bound-plane'
        })).toMatchObject({
            status : 'rejected',
            id     : 'alice',
            scope  : 'forge-and-bound-plane',
            cause  : 'profile-in-use',
            reason : "agent 'alice' has unresolved helper processes holding its profile; resolve or stop them before replacing its credential",
            receipt: {
                scope             : 'forge-and-bound-plane',
                persistedAuthority: {forge: 'unchanged', plane: 'unchanged'},
                carrier           : 'deferred-until-start',
                session           : 'stopped'
            }
        });
        cleanupUnresolved.delete('alice');

        // Shared-seat-home refusal: another running seat shares this seat's recorded seatHome
        const
            aliceDef = FleetRegistryService.getAgent('alice'),
            bobDef   = FleetRegistryService.defineAgent({
                id            : 'bob',
                githubUsername: 'bob',
                harnessType   : 'codex',
                credential    : OLD_PAT,
                launchOwner   : 'fleet'
            });
        FleetRegistryService.relocateSeatHome('bob', {from: bobDef.seatHome, to: aliceDef.seatHome});
        running.add('bob');

        expect(await FleetManager.replaceSeatCredential({
            id        : 'alice',
            credential: NEW_PAT,
            scope     : 'forge'
        })).toMatchObject({
            status : 'rejected',
            id     : 'alice',
            scope  : 'forge',
            cause  : 'profile-in-use',
            reason : "agent 'alice' shares its seat home with running agent 'bob'; stop it before replacing its credential",
            receipt: {
                scope             : 'forge',
                persistedAuthority: {forge: 'unchanged', plane: 'not-selected'},
                carrier           : 'deferred-until-start',
                session           : 'stopped'
            }
        });
        running.delete('bob');
        FleetRegistryService.removeAgent('bob');

        // Real FleetLifecycleService singleton desktopProfileInUse check runs unconditionally for Claude Desktop / Antigravity seats (even with processListFn === null)
        FleetRegistryService.defineAgent({
            id            : 'claire',
            githubUsername: 'claire',
            harnessType   : 'claude-desktop',
            credential    : OLD_PAT,
            launchOwner   : 'fleet'
        });

        const
            originalRegistry      = FleetLifecycleService.registry,
            originalInstanceRoot  = FleetLifecycleService.instanceRoot,
            originalProcessListFn = FleetLifecycleService.processListFn,
            originalDesktopCheck  = FleetLifecycleService.desktopProfileInUse;
        let desktopCheckCalls   = 0,
            desktopCheckOutcome = true;

        FleetManager.lifecycleService             = null;
        FleetLifecycleService.registry            = FleetRegistryService;
        FleetLifecycleService.instanceRoot        = managedRoot;
        FleetLifecycleService.processListFn       = null;
        FleetLifecycleService.desktopProfileInUse = function(agent) {
            desktopCheckCalls++;
            expect(this).toBe(FleetLifecycleService);
            expect(this.processListFn).toBeNull();
            expect(agent.id).toBe('claire');
            return desktopCheckOutcome
        };

        try {
            expect(await FleetManager.replaceSeatCredential({
                id        : 'claire',
                credential: NEW_PAT,
                scope     : 'forge'
            })).toMatchObject({
                status : 'rejected',
                id     : 'claire',
                scope  : 'forge',
                cause  : 'profile-in-use',
                reason : "agent 'claire' has its desktop profile open in another process; quit that application before replacing its credential",
                receipt: {
                    scope             : 'forge',
                    persistedAuthority: {forge: 'unchanged', plane: 'not-selected'},
                    carrier           : 'deferred-until-start',
                    session           : 'stopped'
                }
            });

            desktopCheckOutcome = null;
            expect(await FleetManager.replaceSeatCredential({
                id        : 'claire',
                credential: NEW_PAT,
                scope     : 'forge'
            })).toMatchObject({
                status : 'rejected',
                id     : 'claire',
                scope  : 'forge',
                cause  : 'profile-in-use',
                reason : "the process table could not be read to confirm agent 'claire's desktop profile is closed",
                receipt: {
                    scope             : 'forge',
                    persistedAuthority: {forge: 'unchanged', plane: 'not-selected'},
                    carrier           : 'deferred-until-start',
                    session           : 'stopped'
                }
            });
            expect(desktopCheckCalls).toBe(2);
        } finally {
            FleetLifecycleService.desktopProfileInUse = originalDesktopCheck;
            FleetLifecycleService.processListFn       = originalProcessListFn;
            FleetLifecycleService.instanceRoot        = originalInstanceRoot;
            FleetLifecycleService.registry            = originalRegistry;
            FleetManager.lifecycleService             = createLifecycle();
        }

        expect(forgeCalls).toBe(0);
        expect(FleetRegistryService.resolveCredential('alice')).toBe(OLD_PAT);
        expect(FleetRegistryService.resolveCredential('claire')).toBe(OLD_PAT);
    });

    test('replaces forge-only or forge-and-bound-plane coherently, returns a non-secret receipt, and recovers startAgentProvisioned (AC-1, AC-2, AC-5)', async () => {
        // 1. Forge-only replacement updates credentials.enc and leaves seat-plane-credentials.enc at OLD_PAT
        const forgeOnly = await dispatchFleetRequest(
            createFleetWireRequest('replaceSeatCredential', {
                id        : 'alice',
                credential: NEW_PAT,
                scope     : 'forge'
            }),
            FleetControlBridge
        );

        expect(forgeOnly).toMatchObject({
            ok    : true,
            result: {
                status : 'replaced',
                id     : 'alice',
                scope  : 'forge',
                receipt: {
                    scope             : 'forge',
                    persistedAuthority: {forge: 'replaced', plane: 'not-selected'},
                    carrier           : 'deferred-until-start',
                    session           : 'stopped',
                    coherent          : true,
                    incomplete        : false,
                    nextStep          : 'start-agent'
                }
            }
        });
        expect(Object.keys(forgeOnly.result.receipt).sort()).toEqual([
            'boundPlane',
            'carrier',
            'coherent',
            'incomplete',
            'nextStep',
            'persistedAuthority',
            'scope',
            'session'
        ]);
        expect(JSON.stringify(forgeOnly)).not.toContain(OLD_PAT);
        expect(JSON.stringify(forgeOnly)).not.toContain(NEW_PAT);
        expect(FleetRegistryService.resolveCredential('alice')).toBe(NEW_PAT);
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'alice'}).credential).toBe(OLD_PAT);

        // 2. When the plane rejects OLD_PAT (e.g. token expired), startAgentProvisioned surfaces the typed plane refusal through FleetControlBridge
        FleetTenantService.probeFn = async ({credential, expectedIdentity, servedPlane}) => {
            if (credential === OLD_PAT) {
                return {
                    ok       : false,
                    status   : 401,
                    verdict  : 'refused',
                    cause    : 'expired',
                    resources: {
                        'memory-core': {ok: false, status: 401, verdict: 'refused', cause: 'expired', reason: 'token expired'}
                    }
                }
            }
            return asPlane()({expectedIdentity, servedPlane})
        };

        FleetManager.provisionAndStartFn = options => startAgentProvisioned({
            ...options,
            readModelCatalog   : async () => null,
            ensureRepo         : async () => ({repoPath: path.join(managedRoot, 'alice', 'neomjs', 'neo')}),
            convergeGitIdentity: async () => ({state: 'converged'}),
            prepareWorkspace   : async ({targetRepoRoot, agentosRuntimeRoot}) => ({
                targetRepoRoot,
                agentosRuntimeRoot,
                instanceHome: path.join(managedRoot, 'alice', 'harness', 'codex'),
                mcpMatrix   : {},
                mcpPlan     : []
            }),
            installDependencies: async () => [{repoSlug: 'neomjs/neo', state: 'installed'}]
        });
        FleetManager.wakeArmFn = async () => ({state: 'ready'});

        const refusedStart = await FleetControlBridge.startAgent('alice');
        expect(refusedStart).toEqual({
            status           : 'rejected',
            reason           : "agent 'alice' cannot use its plane at http://127.0.0.1:3102: plane rejected the credential.",
            cause            : 'expired',
            surface          : 'plane',
            credentialRefusal: {
                cause  : 'expired',
                surface: 'plane',
                verdict: 'refused',
                status : 401,
                reason : 'plane rejected the credential'
            }
        });
        expect(JSON.stringify(refusedStart)).not.toContain(OLD_PAT);
        expect(JSON.stringify(refusedStart)).not.toContain(NEW_PAT);

        // 3. Replace both forge and bound plane with NEW_PAT; startAgentProvisioned now succeeds
        const bothReplaced = await FleetControlBridge.replaceSeatCredential({
            id        : 'alice',
            credential: NEW_PAT,
            scope     : 'forge-and-bound-plane'
        });

        expect(bothReplaced).toEqual({
            status : 'replaced',
            id     : 'alice',
            scope  : 'forge-and-bound-plane',
            receipt: {
                scope             : 'forge-and-bound-plane',
                persistedAuthority: {forge: 'replaced', plane: 'replaced'},
                boundPlane        : {endpoint: PLANE, id: SERVED.id, dataRoot: SERVED.dataRoot},
                carrier           : 'deferred-until-start',
                session           : 'stopped',
                coherent          : true,
                incomplete        : false,
                nextStep          : 'start-agent'
            }
        });
        expect(FleetRegistryService.resolveCredential('alice')).toBe(NEW_PAT);
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'alice'})).toEqual({
            credential: NEW_PAT,
            plane     : SERVED
        });
        expect(FleetRegistryService.getCredentialReplacementState('alice')).toBeNull();

        const recoveredStart = await FleetControlBridge.startAgent('alice');
        expect(recoveredStart).toMatchObject({id: 'alice', state: 'running', pid: 4242});
        expect(startedWith).toHaveLength(1);
    });

    test('proves all selected uses before writing anything and classifies typed non-secret refusal causes (AC-1, AC-4)', async () => {
        // Producer-level classification on proveSeatForgeAccount and resolveSeatGitIdentity
        const expiredForge = await proveSeatForgeAccount({
            agent     : {id: 'alice', githubUsername: 'alice'},
            credential: OLD_PAT,
            fetchFn   : async () => ({
                ok     : false,
                status : 401,
                headers: {get: () => null},
                json   : async () => ({message: `Bad credentials: token expired ${OLD_PAT}`})
            })
        });
        expect(expiredForge).toMatchObject({ok: false, verdict: 'refused'});
        expect(expiredForge.cause).toBe('expired');
        expect(expiredForge.credentialRefusal).toMatchObject({
            cause  : 'expired',
            surface: 'forge',
            verdict: 'refused',
            status : 401
        });
        expect(JSON.stringify(expiredForge)).not.toContain(OLD_PAT);
        expect(JSON.stringify(expiredForge.credentialRefusal)).not.toContain(OLD_PAT);

        const wrongIdentityGit = await resolveSeatGitIdentity({
            agent     : {id: 'alice', githubUsername: 'alice'},
            credential: OLD_PAT,
            fetchFn   : async () => ({
                ok     : true,
                status : 200,
                headers: {get: () => null},
                json   : async () => ({login: 'mallory', name: 'Mallory', email: 'mallory@example.test'})
            })
        });
        expect(wrongIdentityGit).toMatchObject({state: 'mismatch', found: 'mallory'});
        expect(wrongIdentityGit.cause).toBe('wrong-identity');
        expect(wrongIdentityGit.credentialRefusal).toMatchObject({
            cause  : 'wrong-identity',
            surface: 'forge',
            verdict: 'refused'
        });

        // Pre-write proof failures on replaceSeatCredential leave both stores untouched
        const cases = [
            {
                name : 'wrong-identity on forge',
                forge: async () => ({
                    ok               : false,
                    verdict          : 'refused',
                    reason           : 'mismatch',
                    found            : 'mallory',
                    cause            : 'wrong-identity',
                    credentialRefusal: {cause: 'wrong-identity', surface: 'forge', verdict: 'refused', reason: "its PAT belongs to the forge account 'mallory', not to the seat's 'alice'"}
                }),
                plane : asPlane(),
                expect: {status: 'rejected', cause: 'wrong-identity', surface: 'forge'}
            },
            {
                name : 'insufficient-capability on forge',
                forge: async () => ({
                    ok               : false,
                    verdict          : 'refused',
                    reason           : 'HTTP 403',
                    cause            : 'insufficient-capability',
                    credentialRefusal: {cause: 'insufficient-capability', surface: 'forge', verdict: 'refused', status: 403, reason: 'HTTP 403'}
                }),
                plane : asPlane(),
                expect: {status: 'rejected', cause: 'insufficient-capability', surface: 'forge'}
            },
            {
                name : 'wrong-identity on plane after forge proof succeeded',
                forge: async () => ({ok: true, verdict: 'proved', login: 'alice'}),
                plane: async () => ({
                    ok       : true,
                    status   : 200,
                    resources: {
                        'memory-core'   : {ok: true, status: 200, identity: '@mallory', plane: SERVED},
                        'knowledge-base': {ok: true, status: 200, plane: SERVED}
                    }
                }),
                expect: {status: 'rejected', cause: 'wrong-identity', surface: 'plane'}
            },
            {
                name  : 'plane-mismatch (different plane.id or plane.dataRoot) refuses without rebinding',
                forge : async () => ({ok: true, verdict: 'proved', login: 'alice'}),
                plane : asPlane({id: 'different-plane-id', dataRoot: '/elsewhere/.neo-ai-data'}),
                expect: {status: 'rejected', cause: 'plane-mismatch', surface: 'plane'}
            },
            {
                name  : 'transport-unavailable on plane refuses without writing forge',
                forge : async () => ({ok: true, verdict: 'proved', login: 'alice'}),
                plane : async () => { throw new Error(`ECONNREFUSED ${NEW_PAT}`) },
                expect: {status: 'rejected', cause: 'transport-unavailable', surface: 'plane'}
            }
        ];

        for (const testCase of cases) {
            FleetManager.forgeProofFn  = testCase.forge;
            FleetTenantService.probeFn = testCase.plane;

            const result = await FleetManager.replaceSeatCredential({
                id        : 'alice',
                credential: NEW_PAT,
                scope     : 'forge-and-bound-plane'
            });

            expect(result, testCase.name).toMatchObject(testCase.expect);
            expect(JSON.stringify(result), testCase.name).not.toContain(NEW_PAT);
            expect(JSON.stringify(result), testCase.name).not.toContain(OLD_PAT);
            expect(FleetRegistryService.resolveCredential('alice'), testCase.name).toBe(OLD_PAT);
            expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'alice'}), testCase.name).toEqual({
                credential: OLD_PAT,
                plane     : SERVED
            });
            expect(FleetRegistryService.getCredentialReplacementState('alice'), testCase.name).toBeNull();
        }
    });

    test('preserves concurrent writes for other seats and fences incomplete second-store publication until re-run converges (AC-2)', async () => {
        FleetRegistryService.defineAgent({
            id            : 'bob',
            githubUsername: 'bob',
            harnessType   : 'codex',
            credential    : 'ghp_bob_initial',
            launchOwner   : 'fleet',
            metadata      : {repo: {repoSlug: 'neomjs/neo', cloneUrl: 'https://github.com/neomjs/neo.git'}}
        });
        await FleetTenantService.storeSeatPlaneCredential({
            planeBase : PLANE,
            agentId   : 'bob',
            identity  : '@bob',
            credential: 'ghp_bob_initial'
        });

        // 1. Concurrent update to 'bob' while 'alice' is mid-proof is preserved by per-seat delta writes
        let concurrentUpdated = false;
        FleetManager.forgeProofFn = async ({agent}) => {
            if (!concurrentUpdated) {
                concurrentUpdated = true;
                FleetRegistryService.replaceCredential('bob', PEER_PAT);
                FleetTenantService.persistBoundSeatPlaneCredential({
                    planeBase    : PLANE,
                    agentId      : 'bob',
                    credential   : PEER_PAT,
                    expectedPlane: SERVED
                });
            }
            return {ok: true, verdict: 'proved', login: agent.githubUsername}
        };
        FleetTenantService.probeFn = asPlane();

        const replaced = await FleetManager.replaceSeatCredential({
            id        : 'alice',
            credential: NEW_PAT,
            scope     : 'forge-and-bound-plane'
        });
        expect(replaced.status).toBe('replaced');
        expect(FleetRegistryService.resolveCredential('alice')).toBe(NEW_PAT);
        expect(FleetRegistryService.resolveCredential('bob')).toBe(PEER_PAT);
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'bob'}).credential).toBe(PEER_PAT);

        // 2. Simulate second-store failure after forge write succeeds: records incomplete state, refuses Start, and converges on retry
        const
            NEXT_PAT        = 'ghp_NEXT_RECOVERY_TOKEN_815',
            originalPersist = FleetTenantService.persistBoundSeatPlaneCredential;

        FleetManager.forgeProofFn                          = async ({agent}) => ({ok: true, verdict: 'proved', login: agent.githubUsername});
        FleetTenantService.persistBoundSeatPlaneCredential = () => ({
            status: 'rejected',
            cause : 'indeterminate',
            reason: 'simulated second-store write failure'
        });

        try {
            const partial = await FleetManager.replaceSeatCredential({
                id        : 'alice',
                credential: NEXT_PAT,
                scope     : 'forge-and-bound-plane'
            });

            expect(partial).toMatchObject({
                status    : 'rejected',
                id        : 'alice',
                scope     : 'forge-and-bound-plane',
                surface   : 'plane',
                cause     : 'indeterminate',
                incomplete: true,
                reason    : 'simulated second-store write failure',
                receipt   : {
                    scope             : 'forge-and-bound-plane',
                    persistedAuthority: {forge: 'replaced', plane: 'unchanged'},
                    coherent          : false,
                    incomplete        : true,
                    nextStep          : 'replace-seat-credential'
                }
            });
            expect(JSON.stringify(partial)).not.toContain(NEXT_PAT);
            const journalState = FleetRegistryService.getCredentialReplacementState('alice');
            expect(journalState).toMatchObject({
                id     : 'alice',
                scope  : 'forge-and-bound-plane',
                state  : 'incomplete',
                surface: 'plane',
                forge  : 'replaced',
                plane  : 'unchanged'
            });
            expect(journalState).not.toHaveProperty('targetSha256');

            // Start is refused while the replacement is incomplete
            FleetManager.provisionAndStartFn = options => startAgentProvisioned({
                ...options,
                readModelCatalog   : async () => null,
                ensureRepo         : async () => ({repoPath: path.join(managedRoot, 'alice', 'neomjs', 'neo')}),
                convergeGitIdentity: async () => ({state: 'converged'}),
                prepareWorkspace   : async ({targetRepoRoot, agentosRuntimeRoot}) => ({
                targetRepoRoot,
                agentosRuntimeRoot,
                instanceHome       : path.join(managedRoot, 'alice', 'harness', 'codex'),
                mcpMatrix          : {},
                mcpPlan            : []
            }),
                installDependencies: async () => [{repoSlug: 'neomjs/neo', state: 'installed'}]
            });

            const blockedStart = await FleetControlBridge.startAgent('alice');
            expect(blockedStart).toEqual({
                status           : 'rejected',
                code             : 'FLEET_SEAT_CREDENTIAL_REPLACEMENT_INCOMPLETE',
                cause            : 'indeterminate',
                surface          : 'plane',
                reason           : "agent 'alice' has an incomplete credential replacement across its forge and plane stores; re-run replaceSeatCredential to reconcile it before starting.",
                credentialRefusal: {
                    surface: 'plane',
                    cause  : 'indeterminate',
                    verdict: 'refused',
                    status : null,
                    reason : "agent 'alice' has an incomplete credential replacement across its forge and plane stores; re-run replaceSeatCredential to reconcile it before starting."
                }
            });
        } finally {
            FleetTenantService.persistBoundSeatPlaneCredential = originalPersist;
        }

        // Re-running replaceSeatCredential converges both stores and clears the incomplete journal record
        const converged = await FleetManager.replaceSeatCredential({
            id        : 'alice',
            credential: NEXT_PAT,
            scope     : 'forge-and-bound-plane'
        });

        expect(converged).toMatchObject({
            status : 'replaced',
            id     : 'alice',
            scope  : 'forge-and-bound-plane',
            receipt: {
                scope             : 'forge-and-bound-plane',
                persistedAuthority: {forge: 'replaced', plane: 'replaced'},
                carrier           : 'deferred-until-start',
                session           : 'stopped',
                coherent          : true,
                incomplete        : false,
                nextStep          : 'start-agent'
            }
        });
        expect(FleetRegistryService.getCredentialReplacementState('alice')).toBeNull();
        expect(FleetRegistryService.resolveCredential('alice')).toBe(NEXT_PAT);
        expect(FleetTenantService.resolveSeatPlaneCredential({planeBase: PLANE, agentId: 'alice'}).credential).toBe(NEXT_PAT);

        FleetManager.wakeArmFn = async () => ({state: 'ready'});
        const startedAfterConvergence = await FleetControlBridge.startAgent('alice');
        expect(startedAfterConvergence).toMatchObject({id: 'alice', state: 'running', pid: 4242});
    });
});
