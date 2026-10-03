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

import {test, expect}       from '@playwright/test';
import Neo                  from 'neo.mjs/src/Neo.mjs';
import * as core            from 'neo.mjs/src/core/_export.mjs';
import FleetManager         from '../../../../../../ai/services/fleet/FleetManager.mjs';
import FleetRegistryService from '../../../../../../ai/services/fleet/FleetRegistryService.mjs';
import fs                   from 'fs';
import os                   from 'os';
import path                 from 'path';

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
            getRegistry: () => registryStub,
            status     : id => id === 'alice'
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
            getRegistry: () => registryStub,
            status     : id => id === 'alice'
                ? {id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-01T20:00:00Z', exitCode: null, repos}
                : {id, state: 'running', running: true, pid: 4343, startedAt: '2026-10-01T20:00:00Z', exitCode: null, repos: null}
        };

        const [alice, bob] = FleetManager.fleetRuntimeStatus();

        expect(alice.repos).toEqual(repos);
        expect(Object.hasOwn(bob, 'repos')).toBe(false)
    });

    test('where a desktop seat\'s session opened rides its runtime row, and a status without one adds nothing', () => {
        const
            registryStub  = {listAgents: () => [{id: 'alice'}, {id: 'bob'}]},
            sessionFolder = {state: 'pending', expected: '/agents/alice/neomjs/neo'};

        FleetManager.lifecycleService = {
            getRegistry: () => registryStub,
            status     : id => id === 'alice'
                ? {id, state: 'running', running: true, pid: 4242, startedAt: '2026-10-03T19:00:00Z', exitCode: null, sessionFolder}
                : {id, state: 'running', running: true, pid: 4343, startedAt: '2026-10-03T19:00:00Z', exitCode: null, sessionFolder: null}
        };

        const [alice, bob] = FleetManager.fleetRuntimeStatus();

        expect(alice.sessionFolder).toEqual(sessionFolder);
        expect(Object.hasOwn(bob, 'sessionFolder')).toBe(false)
    });

    test('the Git identity a seat\'s last start resolved rides its runtime row, a refused start\'s included', () => {
        const
            registryStub = {listAgents: () => [{id: 'alice'}, {id: 'bob'}, {id: 'carol'}]},
            derived      = {state: 'derived', source: 'verified-primary', name: 'Alice', email: 'alice@example.test'};

        FleetManager.lifecycleService = {
            getRegistry: () => registryStub,
            status     : id => ({
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

    test('an agent the fleet never launched reports unmanaged, NOT stopped — never-launched is not stopped (#17305)', () => {
        // The incident: nine external-harness seats rendered `benched / offline` because `status()`
        // answers `stopped` for an agent it holds no record of — a sound lifecycle default, an
        // invented verdict once republished as fleet truth. The row must still EXIST (the roster
        // guarantee is about row existence), it just may not assert a session state.
        const registryStub = {listAgents: () => [{id: 'grace'}]};

        FleetManager.lifecycleService = {
            getRegistry: () => registryStub,
            status     : id => ({id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null})
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
            getRegistry: () => registryStub,
            status     : id => ({id, state: 'stopped', running: false, pid: null, startedAt: '2026-07-04T00:00:00Z', exitCode: 1})
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([
            {agentId: 'alice', state: 'stopped', running: false, confidence: 'observed', source: 'fleet:runtimeStatus'}
        ]);
    });

    test('a fleet-launched seat with no process record reads stopped, labelled inferred — an external one stays unmanaged', () => {
        const registryStub = {listAgents: () => [{id: 'cockpit', launchOwner: 'fleet'}, {id: 'grace', launchOwner: 'external'}]};

        FleetManager.lifecycleService = {
            getRegistry: () => registryStub,
            status     : id => ({id, state: 'stopped', running: false, pid: null, startedAt: null, exitCode: null})
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
            getRegistry: () => registryStub,
            status     : id => ({id, state: 'running', running: true, pid: 4242, startedAt: '2026-09-19T00:00:00Z', exitCode: null})
        };

        expect(FleetManager.fleetRuntimeStatus()).toEqual([
            {agentId: 'cockpit', state: 'running', running: true, confidence: 'observed', source: 'fleet:runtimeStatus'}
        ]);
    });

    test('an installed-capability refusal surfaces as observed unavailable with a safe reason', () => {
        const registryStub = {listAgents: () => [{id: 'desktop'}]};

        FleetManager.lifecycleService = {
            getRegistry: () => registryStub,
            status     : id => ({
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

test.describe('Neo.ai.services.fleet.FleetManager — Codex Desktop cleanup failure gates', () => {
    let calls, registryStub;

    test.beforeEach(() => {
        calls = [];
        registryStub = {
            getAgent   : () => null,
            removeAgent: id => { calls.push(['removeAgent', id]); return {success: true, id}; }
        };

        FleetManager.lifecycleService = {
            getRegistry: () => registryStub,
            stop       : async id => ({success: false, id, state: 'failed', cleanupUnresolved: true})
        };
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

        FleetManager.lifecycleService = {
            getRegistry: () => ({getAgent: id => definitions[id] ?? null}),
            stop       : async id => { calls.push(['stop', id]); return {success: true, id, state: 'stopped'}; }
        };
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
            FleetManager.lifecycleService = {
                getRegistry: () => FleetRegistryService,
                stop       : async id => { calls.push(['stop', id]); return {success: true, id, state: 'stopped'}; }
            };

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
