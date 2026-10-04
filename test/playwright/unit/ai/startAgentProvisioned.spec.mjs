import {test, expect}                    from '@playwright/test';
import {CREDENTIAL_FAMILIES}             from '../../../../ai/services/fleet/redactCredentials.mjs';
import {LAUNCHABLE_HARNESS_TYPES}        from '../../../../ai/services/fleet/deriveHarnessLaunchSpec.mjs';
import {createManagedAgentWorkspacePlan} from '../../../../ai/services/fleet/managedAgentWorkspacePlan.mjs';
import {startAgentProvisioned as startProvisioned} from '../../../../ai/services/fleet/startAgentProvisioned.mjs';
import {resolveSeatGitIdentity}          from '../../../../ai/services/fleet/seatGitIdentity.mjs';
import {supportsTenantMcpTarget}         from '../../../../src/fleet/contract/harnessTypes.mjs';

/** The Git identity a fixture seat resolves to unless a case says otherwise. */
const SEAT_GIT_IDENTITY = {state: 'derived', source: 'verified-primary', name: 'Seat Agent', email: 'seat@example.test'};

/**
 * Every repo-bearing start resolves and converges the seat's Git identity. Cases about anything else get a resolved
 * identity and converged checkouts, so no case reads a forge or runs git.
 */
function startAgentProvisioned(options) {
    return startProvisioned({
        resolveGitIdentity : async () => SEAT_GIT_IDENTITY,
        convergeGitIdentity: async () => ({state: 'converged', scope: 'local', action: 'kept'}),
        ...options
    })
}

// Pure composer — imported directly with injected stubs (no fs / git / Neo runtime), so the suite has
// no host-runtime side effects and each case is fully isolated. Mirrors deriveAgentRepoPath.spec /
// ensureAgentRepo.spec. The `ensureRepo` + `cloneRepo` seams stand in for the real provisioning chain;
// the `lifecycleService` stub records every `start` call so the cwd-threading contract is assertable.

/** Every agent holds a GitHub PAT; a known agent resolves this one unless `credentials` names another. */
const FIXTURE_PAT = 'ghp_fixture_only';

/** A recording FleetLifecycleService stub: tracks start/capability/credential calls. */
function makeLifecycle({
    agents = {},
    definitions = agents,
    credentials = {},
    running = {},
    events,
    capabilityError = null,
    inspectionError = null
} = {}) {
    const calls = {capability: [], credential: [], gitIdentity: [], inspection: [], repoOutcomes: [], start: [], status: []};
    return {
        calls,
        credentialEnvVar: 'GH_TOKEN',
        isRunning       : id => !!running[id],
        status          : id => { calls.status.push(id); return {id, running: !!running[id], state: running[id] ? 'running' : 'stopped'}; },
        getRegistry     : () => ({
            getAgent         : id => agents[id] || null,
            getDefinition    : id => definitions[id] || null,
            resolveCredential: id => {
                events?.push('credential');
                calls.credential.push(id);

                // `credentials: {id: null}` models an agent stored without a PAT
                return Object.hasOwn(credentials, id) ? credentials[id] : (definitions[id] ? FIXTURE_PAT : null)
            }
        }),
        getInstanceRoot          : () => '/instances',
        assertRemoteMcpCapability: async (agent, options) => {
            events?.push('capability');
            calls.capability.push({agent, options});

            if (capabilityError) throw capabilityError;

            return {
                harnessType     : agent.harnessType,
                binaryPath      : '/bin/harness',
                launchBinaryPath: '/bin/harness'
            }
        },
        inspectPreparedRemoteMcpAdapter: async args => {
            events?.push('inspect');
            calls.inspection.push(args);

            if (inspectionError) throw inspectionError;

            return {harnessType: args.agent.harnessType, inspected: true}
        },
        resolveResidentMcpEnvironment: () => ({}),
        setRepoOutcomes              : (id, repos, launch) => { calls.repoOutcomes.push({id, repos, launch}); return true },
        setGitIdentity               : (id, gitIdentity) => { calls.gitIdentity.push({id, gitIdentity}); return true },
        start                        : (id, opts) => { events?.push('start'); calls.start.push({id, opts}); return {id, running: true, state: 'running', cwd: opts?.cwd, pid: 4242, startedAt: '2026-10-01T20:00:00.000Z'}; }
    };
}

/** A recording ensureAgentRepo stub: records its args, returns a fixed repoPath (no fs / git). */
function makeEnsureRepo(repoPath = '/managed/agent/repo', events) {
    const calls = [];
    const fn    = async args => { events?.push('ensure'); calls.push(args); return {repoPath, state: 'absent', action: 'cloned', cloned: true}; };
    fn.calls    = calls;
    return fn;
}

function buildPreparedMcpPlan(args, mcpMatrix) {
    return Object.entries(mcpMatrix).map(([key, enabled]) => {
        const resource = args.mcpTarget?.resources?.[key];

        return {
            key,
            name            : `neo-mjs-${key}`,
            enabled,
            target          : resource ? 'tenant' : 'resident',
            transport       : resource ? 'streamable-http' : 'stdio',
            url             : resource?.url || null,
            credentialEnvVar: resource ? 'NEO_MCP_REMOTE_TOKEN' : null,
            command         : '/usr/bin/node',
            sourceRoot      : args.agentosRuntimeRoot,
            args            : [
                `${args.agentosRuntimeRoot}/ai/mcp/server/${key}/mcp-server.mjs`,
                ...(key === 'neural-link' ? ['--cwd', args.agentosRuntimeRoot] : [])
            ],
            runtimeEnv        : ['NEO_AGENT_IDENTITY'],
            requiredRuntimeEnv: ['NEO_AGENT_IDENTITY'],
            secretEnv         : [],
            unsupportedReason : null
        }
    })
}

/** Recording post-provisioning workspace/home preparation seam. */
function makePrepareWorkspace(events) {
    const calls = [];
    const fn    = async args => {
        events?.push('prepare');
        calls.push(args);

        const mcpMatrix = {
            'memory-core'    : true,
            'knowledge-base' : true,
            'neural-link'    : true,
            'github-workflow': false,
            'gitlab-workflow': false
        };

        return {
            agentosRuntimeRoot: args.agentosRuntimeRoot,
            targetRepoRoot    : args.targetRepoRoot,
            instanceHome      : `/instances/${args.agent.id}`,
            mcpMatrix,
            mcpPlan           : buildPreparedMcpPlan(args, mcpMatrix)
        }
    };
    fn.calls    = calls;
    return fn;
}

const REPO = {cloneUrl: 'https://github.com/neomjs/neo.git', repoSlug: 'neomjs/neo'};

/** A row as `defineAgent` writes it today: born with its seat home under the suite's `/managed` root. */
function repoAgent(id = 'a') {
    return {[id]: {id, githubUsername: id, harnessType: 'codex', metadata: {repo: REPO}, seatHome: `/managed/${id}`}};
}

/** A row persisted before Fleet recorded seat homes: no `seatHome`, so a start must adopt or refuse. */
function legacyRepoAgent(id = 'a') {
    const agents = repoAgent(id);

    delete agents[id].seatHome;
    agents[id].createdAt = '2026-09-30T19:46:00.000Z';

    return agents
}

function remoteRepoAgent(id = 'a') {
    const agents = repoAgent(id);

    agents[id].mcpTarget = {kind: 'tenant', tenantId: 'tenant-a'};

    return agents
}

function makeTenantService({
    events,
    resolved   = true,
    readiness  = true,
    credential = 'glpat_exact_plane_credential'
} = {}) {
    const
        resources = {
            'memory-core'   : {url: 'https://tenant.example.com/mc/mcp'},
            'knowledge-base': {url: 'https://tenant.example.com/kb/mcp'}
        },
        calls = {credential: [], resolve: [], probe: []};

    return {
        calls,
        resolveMcpResources(tenantId) {
            events?.push('resolve-tenant');
            calls.resolve.push(tenantId);

            return resolved ? {tenantId, endpoint: 'https://tenant.example.com', resources} : null
        },
        resolveMcpCredential(tenantId) {
            events?.push('plane-credential');
            calls.credential.push(tenantId);

            return credential
        },
        async probeSeatCredential(args) {
            events?.push('probe');
            calls.probe.push(args);

            return readiness === true
                ? {
                    ok       : true,
                    status   : 200,
                    resources: {
                        'memory-core'   : {
                            ok: true, status: 200, identity: args.expectedIdentity
                        },
                        'knowledge-base': {ok: true, status: 200}
                    }
                }
                : readiness
        }
    }
}

test.describe('startAgentProvisioned (Fleet Manager spawn-time repo provisioning)', () => {
    test('provisions the target, binds AgentOS runtime, then launches from the target root', async () => {
        const events           = [],
              lifecycle        = makeLifecycle({agents: repoAgent('a'), events}),
              ensureRepo       = makeEnsureRepo('/managed/a/neomjs-neo', events),
              prepareWorkspace = makePrepareWorkspace(events),
              cloneRepo        = () => {},
              status           = await startAgentProvisioned({
                  lifecycleService  : lifecycle,
                  agentId           : 'a',
                  managedRoot       : '/managed',
                  cloneRepo,
                  ensureRepo,
                  prepareWorkspace,
                  agentosRuntimeRoot: '/installed/neo',
                  nodePath          : '/usr/bin/node'
              });

        // provisioning fed the agent's metadata.repo coordinates + the managed root + the clone seam, and the
        // seat's own PAT, so a private repo clones without credentials on the Fleet host
        expect(ensureRepo.calls).toHaveLength(1);
        expect(ensureRepo.calls[0]).toMatchObject({managedRoot: '/managed', agentId: 'a', repoSlug: 'neomjs/neo', cloneUrl: REPO.cloneUrl, credential: FIXTURE_PAT, cloneRepo});
        expect(prepareWorkspace.calls).toHaveLength(1);
        expect(prepareWorkspace.calls[0]).toMatchObject({
            agent             : repoAgent('a').a,
            targetRepoRoot    : '/managed/a/neomjs-neo',
            instanceRoot      : '/instances',
            agentosRuntimeRoot: '/installed/neo',
            nodePath          : '/usr/bin/node'
        });
        // the PAT is resolved once, before the checkout, and that exact value reaches the spawn
        expect(events).toEqual(['credential', 'ensure', 'prepare', 'start']);
        // Runtime authority stays AgentOS-owned; the harness cwd stays the provisioned target root.
        expect(lifecycle.calls.start).toHaveLength(1);
        expect(lifecycle.calls.start[0]).toEqual({id: 'a', opts: {cwd: '/managed/a/neomjs-neo', resolvedCredential: FIXTURE_PAT, resolvedResidentMcpEnv: {}, gitIdentity: {name: 'Seat Agent', email: 'seat@example.test'}}});
        expect(status.state).toBe('running');
        expect(status.cwd).toBe('/managed/a/neomjs-neo');
        expect(status).not.toHaveProperty('repos');
    });

    test('a seat\'s other repositories are cloned beside the working checkout, with its PAT, before the spawn', async () => {
        const events = [],
              agents = repoAgent('a');

        agents.a.metadata.repos = [
            {repoSlug: 'neomjs/neo-agent-brain',       cloneUrl: 'https://github.com/neomjs/neo-agent-brain.git'},
            {repoSlug: 'neomjs/neo-agent-institution', cloneUrl: 'https://github.com/neomjs/neo-agent-institution.git'}
        ];

        const lifecycle        = makeLifecycle({agents, events}),
              ensureRepo       = makeEnsureRepo('/managed/a/neomjs/neo', events),
              prepareWorkspace = makePrepareWorkspace(events),
              status           = await startAgentProvisioned({
                  lifecycleService  : lifecycle,
                  agentId           : 'a',
                  managedRoot       : '/managed',
                  ensureRepo,
                  prepareWorkspace,
                  agentosRuntimeRoot: '/installed/neo'
              });

        expect(ensureRepo.calls.map(call => call.repoSlug)).toEqual(['neomjs/neo', 'neomjs/neo-agent-brain', 'neomjs/neo-agent-institution']);
        expect(ensureRepo.calls.every(call => call.managedRoot === '/managed' && call.agentId === 'a' && call.credential === FIXTURE_PAT)).toBe(true);
        expect(ensureRepo.calls[2].cloneUrl).toBe('https://github.com/neomjs/neo-agent-institution.git');
        expect(events).toEqual(['credential', 'ensure', 'ensure', 'ensure', 'prepare', 'start']);
        expect(lifecycle.calls.start[0].opts.cwd).toBe('/managed/a/neomjs/neo');
        expect(status.repos).toEqual([
            {repoSlug: 'neomjs/neo-agent-brain',       state: 'prepared'},
            {repoSlug: 'neomjs/neo-agent-institution', state: 'prepared'}
        ]);

        // the launch record keeps the same outcome for every later read, bound to this launch
        expect(lifecycle.calls.repoOutcomes).toEqual([{id: 'a', repos: status.repos, launch: {pid: 4242, startedAt: '2026-10-01T20:00:00.000Z'}}]);
    });

    test("every clone carries the origin the seat's PAT was stored for: a GitLab seat's host, or none for GitHub's", async () => {
        const
            ORIGIN = 'https://gitlab.example.com',
            agents = repoAgent('a'),
            start  = async (lifecycleAgents, agentId, ensureRepo) => startAgentProvisioned({
                lifecycleService  : makeLifecycle({agents: lifecycleAgents}),
                agentId,
                managedRoot       : '/managed',
                ensureRepo,
                prepareWorkspace  : makePrepareWorkspace(),
                agentosRuntimeRoot: '/installed/neo'
            });

        Object.assign(agents.a, {forge: 'gitlab', forgeHost: ORIGIN});
        agents.a.metadata.repo  = {repoSlug: 'group/sub/project', cloneUrl: `${ORIGIN}/group/sub/project.git`, forge: 'gitlab'};
        agents.a.metadata.repos = [{repoSlug: 'group/tools', cloneUrl: `${ORIGIN}/group/tools.git`, forge: 'gitlab'}];

        const gitlabRepo = makeEnsureRepo('/managed/a/group/sub/project'),
              githubRepo = makeEnsureRepo('/managed/b/neomjs/neo');

        await start(agents, 'a', gitlabRepo);
        await start(repoAgent('b'), 'b', githubRepo);

        expect(gitlabRepo.calls.map(call => [call.repoSlug, call.credentialOrigin])).toEqual([['group/sub/project', ORIGIN], ['group/tools', ORIGIN]]);
        expect(githubRepo.calls[0].credentialOrigin).toBeUndefined() // the clone's own default: github.com
    });

    test('an other repository that cannot be cloned is reported on the status, and the seat still starts', async () => {
        const agents = repoAgent('a');

        agents.a.metadata.repos = [{repoSlug: 'neomjs/missing', cloneUrl: 'https://github.com/neomjs/missing.git'}];

        const lifecycle  = makeLifecycle({agents}),
              ensureRepo = async ({repoSlug}) => {
                  if (repoSlug === 'neomjs/missing') throw new Error('ensureAgentRepo: clone failed');
                  return {repoPath: '/managed/a/neomjs/neo'}
              },
              status     = await startAgentProvisioned({
                  lifecycleService  : lifecycle,
                  agentId           : 'a',
                  managedRoot       : '/managed',
                  ensureRepo,
                  prepareWorkspace  : makePrepareWorkspace(),
                  agentosRuntimeRoot: '/installed/neo'
              });

        expect(lifecycle.calls.start).toHaveLength(1);
        expect(status.repos).toEqual([{repoSlug: 'neomjs/missing', state: 'failed', reason: 'ensureAgentRepo: clone failed'}]);
    });

    test('a failed repository\'s reason carries no credential and stays bounded, for every family the redactor knows', async () => {
        const agents = repoAgent('a');

        // one failing repository per family, the secret leading a 4 KB message: redaction, not the bound,
        // is what has to remove it
        agents.a.metadata.repos = CREDENTIAL_FAMILIES.map(({name}) => ({repoSlug: `canary/${name}`, cloneUrl: `https://github.com/canary/${name}.git`}));

        const lifecycle  = makeLifecycle({agents}),
              ensureRepo = async ({repoSlug}) => {
                  const family = CREDENTIAL_FAMILIES.find(({name}) => repoSlug === `canary/${name}`);
                  if (family) throw new Error(`fatal: unable to access ${family.sample} ${'x'.repeat(4096)}`);
                  return {repoPath: '/managed/a/neomjs/neo'}
              },
              status     = await startAgentProvisioned({
                  lifecycleService  : lifecycle,
                  agentId           : 'a',
                  managedRoot       : '/managed',
                  ensureRepo,
                  prepareWorkspace  : makePrepareWorkspace(),
                  agentosRuntimeRoot: '/installed/neo'
              });

        expect(lifecycle.calls.start).toHaveLength(1);
        expect(status.repos.map(({repoSlug, state}) => ({repoSlug, state}))).toEqual(agents.a.metadata.repos.map(({repoSlug}) => ({repoSlug, state: 'failed'})));

        CREDENTIAL_FAMILIES.forEach(({secret}, index) => {
            const {reason} = status.repos[index];

            expect(reason.startsWith('fatal: unable to access')).toBe(true);
            expect(reason).not.toContain(secret);
            expect(reason.length).toBeLessThanOrEqual(240)
        })
    });

    test('a working checkout that cannot be cloned still refuses the start, and no other repository is tried', async () => {
        const agents = repoAgent('a'),
              tried  = [];

        agents.a.metadata.repos = [{repoSlug: 'neomjs/neo-agent-brain', cloneUrl: 'https://github.com/neomjs/neo-agent-brain.git'}];

        const lifecycle = makeLifecycle({agents});

        await expect(startAgentProvisioned({
            lifecycleService  : lifecycle,
            agentId           : 'a',
            managedRoot       : '/managed',
            ensureRepo        : async ({repoSlug}) => { tried.push(repoSlug); throw new Error('ensureAgentRepo: conflicting checkout') },
            prepareWorkspace  : makePrepareWorkspace(),
            agentosRuntimeRoot: '/installed/neo'
        })).rejects.toThrow('conflicting checkout');

        expect(tried).toEqual(['neomjs/neo']);
        expect(lifecycle.calls.start).toHaveLength(0);
    });

    test('an agent with no metadata.repo starts in the inherited cwd (backward-compatible)', async () => {
        const lifecycle        = makeLifecycle({agents: {a: {id: 'a', metadata: {launch: {command: 'h'}}}}}),
              ensureRepo       = makeEnsureRepo(),
              prepareWorkspace = makePrepareWorkspace();

        await startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/managed', ensureRepo, prepareWorkspace});

        // nothing to provision; start carries the resolved PAT and NO cwd
        expect(ensureRepo.calls).toHaveLength(0);
        expect(prepareWorkspace.calls).toHaveLength(0);
        expect(lifecycle.calls.start).toHaveLength(1);
        expect(lifecycle.calls.start[0].id).toBe('a');
        expect(lifecycle.calls.start[0].opts).toEqual({resolvedCredential: FIXTURE_PAT});
    });

    test('an agent without a GitHub PAT is refused before any checkout, preparation or spawn', async () => {
        // a blank value stored before the requirement is no PAT either
        for (const [agents, stored] of [
            [repoAgent('a'), null], [repoAgent('a'), ''], [repoAgent('a'), '   '],
            [{a: {id: 'a', metadata: {launch: {command: 'h'}}}}, null], [{a: {id: 'a', metadata: {launch: {command: 'h'}}}}, '  ']
        ]) {
            const events           = [],
                  lifecycle        = makeLifecycle({agents, credentials: {a: stored}, events}),
                  ensureRepo       = makeEnsureRepo('/managed/a/neomjs-neo', events),
                  prepareWorkspace = makePrepareWorkspace(events);

            await expect(startAgentProvisioned({
                lifecycleService  : lifecycle,
                agentId           : 'a',
                managedRoot       : '/managed',
                ensureRepo,
                prepareWorkspace,
                agentosRuntimeRoot: '/installed/neo'
            })).rejects.toThrow(/agent 'a' has no GitHub PAT stored/);

            expect(events).toEqual(['credential']);
            expect(lifecycle.calls.start).toEqual([])
        }
    });

    test('a remote seat keeps repository and plane credentials distinct through readiness and spawn', async () => {
        const
            events           = [],
            repositoryPat    = 'ghp_exact_repository_pat',
            planePat         = 'glpat_exact_plane_pat',
            agents           = remoteRepoAgent('a'),
            lifecycle        = makeLifecycle({agents, credentials: {a: repositoryPat}, events}),
            tenantService    = makeTenantService({events, credential: planePat}),
            ensureRepo       = makeEnsureRepo('/managed/a/neomjs-neo', events),
            prepareWorkspace = makePrepareWorkspace(events);

        await startAgentProvisioned({
            lifecycleService  : lifecycle,
            tenantService,
            agentId           : 'a',
            managedRoot       : '/managed',
            agentosRuntimeRoot: '/installed/neo',
            ensureRepo,
            prepareWorkspace
        });

        expect(events).toEqual([
            'credential',
            'resolve-tenant',
            'plane-credential',
            'capability',
            'probe',
            'ensure',
            'prepare',
            'inspect',
            'start'
        ]);
        expect(lifecycle.calls.credential).toEqual(['a']);
        expect(lifecycle.calls.capability).toEqual([{
            agent  : agents.a,
            options: {mainCheckout: '/installed/neo', nodePath: undefined}
        }]);
        expect(tenantService.calls.resolve).toEqual(['tenant-a']);
        expect(tenantService.calls.credential).toEqual(['tenant-a']);
        expect(tenantService.calls.probe).toEqual([{
            tenantId        : 'tenant-a',
            credential      : planePat,
            expectedIdentity: '@a'
        }]);
        expect(prepareWorkspace.calls[0].mcpTarget).toEqual({
            kind            : 'tenant',
            credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN',
            resources       : {
                'memory-core'   : {url: 'https://tenant.example.com/mc/mcp'},
                'knowledge-base': {url: 'https://tenant.example.com/kb/mcp'}
            }
        });
        expect(prepareWorkspace.calls[0].remoteMcpCapability).toEqual({
            harnessType     : 'codex',
            binaryPath      : '/bin/harness',
            launchBinaryPath: '/bin/harness'
        });
        expect(lifecycle.calls.inspection).toEqual([{
            agent       : agents.a,
            binaryPath  : '/bin/harness',
            repoPath    : '/managed/a/neomjs-neo',
            instanceHome: '/instances/a',
            mcpMatrix   : {
                'memory-core'    : true,
                'knowledge-base' : true,
                'neural-link'    : true,
                'github-workflow': false,
                'gitlab-workflow': false
            },
            mcpPlan: buildPreparedMcpPlan(prepareWorkspace.calls[0], {
                'memory-core'    : true,
                'knowledge-base' : true,
                'neural-link'    : true,
                'github-workflow': false,
                'gitlab-workflow': false
            }),
            mcpTarget: {
                kind     : 'tenant',
                resources: {
                    'memory-core'   : {url: 'https://tenant.example.com/mc/mcp'},
                    'knowledge-base': {url: 'https://tenant.example.com/kb/mcp'}
                }
            }
        }]);
        expect(lifecycle.calls.start).toEqual([{
            id  : 'a',
            opts: {
                cwd                   : '/managed/a/neomjs-neo',
                resolvedCredential    : repositoryPat,
                resolvedResidentMcpEnv: {},
                gitIdentity           : {name: 'Seat Agent', email: 'seat@example.test'},
                resolvedMcpCredential : planePat,
                resolvedMcpEndpoint   : 'https://tenant.example.com',
                remoteMcpCapability   : {
                    harnessType     : 'codex',
                    binaryPath      : '/bin/harness',
                    launchBinaryPath: '/bin/harness'
                }
            }
        }])
    });

    test('remote readiness binds the provider AgentIdentity, not the per-instance fleet id', async () => {
        const agents = remoteRepoAgent('codex-2');

        agents['codex-2'].githubUsername = 'neo-gpt';

        const
            lifecycle        = makeLifecycle({agents}),
            tenantService    = makeTenantService(),
            ensureRepo       = makeEnsureRepo('/managed/codex-2/neomjs-neo'),
            prepareWorkspace = makePrepareWorkspace();

        await startAgentProvisioned({
            lifecycleService: lifecycle,
            tenantService,
            agentId         : 'codex-2',
            managedRoot     : '/managed',
            ensureRepo,
            prepareWorkspace
        });

        expect(tenantService.calls.probe).toEqual([{
            tenantId        : 'tenant-a',
            credential      : 'glpat_exact_plane_credential',
            expectedIdentity: '@neo-gpt'
        }])
    });

    test('a remote seat carries its own PAT to the spawn, never its plane bearer in its place', async () => {
        const
            agents           = remoteRepoAgent('a'),
            lifecycle        = makeLifecycle({agents, credentials: {a: 'ghp_seat_only'}}),
            tenantService    = makeTenantService({credential: 'glpat_plane_only'}),
            ensureRepo       = makeEnsureRepo('/managed/a/neomjs-neo'),
            prepareWorkspace = makePrepareWorkspace();

        await startAgentProvisioned({
            lifecycleService: lifecycle,
            tenantService,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo,
            prepareWorkspace
        });

        expect(lifecycle.calls.credential).toEqual(['a']);
        expect(lifecycle.calls.start).toEqual([{
            id  : 'a',
            opts: {
                cwd                   : '/managed/a/neomjs-neo',
                resolvedCredential    : 'ghp_seat_only',
                resolvedResidentMcpEnv: {},
                gitIdentity           : {name: 'Seat Agent', email: 'seat@example.test'},
                resolvedMcpCredential : 'glpat_plane_only',
                resolvedMcpEndpoint   : 'https://tenant.example.com',
                remoteMcpCapability   : {
                    harnessType     : 'codex',
                    binaryPath      : '/bin/harness',
                    launchBinaryPath: '/bin/harness'
                }
            }
        }])
    });

    test('a remote seat without a managed repo rejects before credential, capability, tenant, or filesystem work', async () => {
        const
            lifecycle        = makeLifecycle({
                agents: {
                    a: {
                        id       : 'a', harnessType: 'codex', metadata: {},
                        mcpTarget: {kind: 'tenant', tenantId: 'tenant-a'}
                    }
                },
                credentials: {a: 'ghp_x'}
            }),
            tenantService    = makeTenantService(),
            ensureRepo       = makeEnsureRepo(),
            prepareWorkspace = makePrepareWorkspace();

        await expect(startAgentProvisioned({
            lifecycleService: lifecycle,
            tenantService,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo,
            prepareWorkspace
        })).rejects.toThrow(/requires a managed repo/);

        expect(lifecycle.calls.credential).toEqual([]);
        expect(lifecycle.calls.capability).toEqual([]);
        expect(tenantService.calls.resolve).toEqual([]);
        expect(tenantService.calls.credential).toEqual([]);
        expect(tenantService.calls.probe).toEqual([]);
        expect(ensureRepo.calls).toEqual([]);
        expect(prepareWorkspace.calls).toEqual([]);
        expect(lifecycle.calls.start).toEqual([])
    });

    test('every remote admission failure leaves checkout, workspace, and spawn untouched', async () => {
        const scenarios = [{
            name       : 'unavailable tenant',
            credentials: {},
            tenant     : {resolved: false},
            error      : /tenant 'tenant-a' is unavailable/
        }, {
            name       : 'missing plane credential',
            credentials: {a: 'ghp_x'},
            tenant     : {credential: null},
            error      : /tenant 'tenant-a' has no plane credential/
        }, {
            name           : 'unsupported installed capability',
            credentials    : {a: 'ghp_x'},
            tenant         : {},
            capabilityError: new Error('missing remote grammar'),
            error          : /missing remote grammar/
        }, {
            name       : 'one plane not ready',
            credentials: {a: 'ghp_x'},
            tenant     : {
                readiness: {
                    ok       : false,
                    status   : 503,
                    resources: {
                        'memory-core'   : {ok: true, status: 200},
                        'knowledge-base': {ok: false, status: 503}
                    }
                }
            },
            error: /credential readiness failed/
        }];

        for (const scenario of scenarios) {
            const
                lifecycle        = makeLifecycle({
                    agents         : remoteRepoAgent('a'),
                    credentials    : scenario.credentials,
                    capabilityError: scenario.capabilityError
                }),
                tenantService    = makeTenantService(scenario.tenant),
                ensureRepo       = makeEnsureRepo(),
                prepareWorkspace = makePrepareWorkspace();

            await expect(startAgentProvisioned({
                lifecycleService: lifecycle,
                tenantService,
                agentId         : 'a',
                managedRoot     : '/managed',
                ensureRepo,
                prepareWorkspace
            }), scenario.name).rejects.toThrow(scenario.error);

            expect(ensureRepo.calls, scenario.name).toEqual([]);
            expect(prepareWorkspace.calls, scenario.name).toEqual([]);
            expect(lifecycle.calls.start, scenario.name).toEqual([])
        }
    });

    test('a declared model the harness\'s complete catalog lacks refuses before anything changes, and the seat says why', async () => {
        const
            agents    = repoAgent('a'),
            lifecycle = makeLifecycle({agents}),
            ensure    = makeEnsureRepo('/managed/a/neomjs-neo'),
            seatModel = new Map(),
            catalog   = state => async ({agent}) => ({state, models: [{id: 'gpt-6-luna', slug: 'gpt-6-luna', efforts: ['low', 'max']}], reason: state === 'complete' ? null : 'rate limited', agent});

        lifecycle.setSeatModel = (id, outcome) => outcome ? seatModel.set(id, outcome) : seatModel.delete(id);
        Object.assign(agents.a, {model: 'gpt-6-astra', reasoningEffort: 'ultra'});

        await expect(startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/managed', ensureRepo: ensure, readModelCatalog: catalog('complete')}))
            .rejects.toMatchObject({code: 'FLEET_SEAT_MODEL_UNAVAILABLE', message: expect.stringContaining('cannot start: model gpt-6-astra is not available. Nothing was changed.')});
        expect([ensure.calls.length, lifecycle.calls.start.length], 'nothing cloned, nothing spawned').toEqual([0, 0]);
        expect(seatModel.get('a')).toEqual({state: 'refused', model: 'gpt-6-astra', reasoningEffort: 'ultra', reason: 'model gpt-6-astra is not available'});

        // a read that could not say refuses nothing: the start goes on, and the seat records the read's state
        await startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/managed', ensureRepo: ensure, prepareWorkspace: makePrepareWorkspace(), readModelCatalog: catalog('partial'), agentosRuntimeRoot: '/installed/neo'});
        expect(lifecycle.calls.start).toHaveLength(1);
        expect(seatModel.get('a')).toMatchObject({state: 'partial', reason: 'rate limited'});
    });

    test('a seat\'s model refusal belongs to its latest start: a later start never inherits it', async () => {
        const
            agents    = repoAgent('a'),
            lifecycle = makeLifecycle({agents}),
            seatModel = new Map(),
            refusing  = async () => ({state: 'complete', models: [{id: 'gpt-6-luna', slug: 'gpt-6-luna', efforts: ['low']}], reason: null}),
            start     = options => startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/managed', ensureRepo: makeEnsureRepo('/managed/a/neomjs-neo'), readModelCatalog: refusing, ...options});

        lifecycle.setSeatModel = (id, outcome) => outcome ? seatModel.set(id, outcome) : seatModel.delete(id);
        Object.assign(agents.a, {model: 'gpt-6-astra'});

        await expect(start()).rejects.toMatchObject({code: 'FLEET_SEAT_MODEL_UNAVAILABLE'});
        expect(seatModel.get('a')?.state).toBe('refused');

        // refused before the model is read: the seat says nothing about its model, never the earlier refusal
        await expect(start({resolveGitIdentity: async () => ({state: 'missing', reason: 'no commit identity declared'})}))
            .rejects.toMatchObject({code: 'FLEET_SEAT_GIT_IDENTITY_MISSING'});
        expect(seatModel.has('a'), 'cleared by the start that never read a catalog').toBe(false);

        await expect(start()).rejects.toMatchObject({code: 'FLEET_SEAT_MODEL_UNAVAILABLE'});

        // the declaration withdrawn: the start reads nothing, runs, and no refusal outlives it
        agents.a.model = null;
        await start({prepareWorkspace: makePrepareWorkspace(), agentosRuntimeRoot: '/installed/neo'});
        expect([lifecycle.calls.start.length, seatModel.has('a')]).toEqual([1, false]);
    });

    test('a seat with nothing declared, or a family Fleet does not configure this way, reads no catalog', async () => {
        const reads = [];

        for (const harnessType of ['codex', 'claude-desktop']) {
            const agents = repoAgent('a');

            Object.assign(agents.a, {harnessType}, harnessType === 'codex' ? {} : {model: 'claude-opus-5-5'});
            await startAgentProvisioned({
                lifecycleService  : makeLifecycle({agents}),
                agentId           : 'a',
                managedRoot       : '/managed',
                ensureRepo        : makeEnsureRepo('/managed/a/neomjs-neo'),
                prepareWorkspace  : makePrepareWorkspace(),
                agentosRuntimeRoot: '/installed/neo'
            }).catch(error => reads.push(error.message));
        }

        expect(reads.filter(message => /catalog|model/.test(message)), 'the default reader answered null before spawning anything').toEqual([]);
    });

    test('a provisioning failure propagates and the harness is NEVER spawned (fail-closed)', async () => {
        const lifecycle = makeLifecycle({agents: repoAgent('a')}),
              boom      = async () => { throw new Error('conflict: foreign occupant'); };

        await expect(startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/managed', ensureRepo: boom}))
            .rejects.toThrow('conflict: foreign occupant');

        expect(lifecycle.calls.start).toHaveLength(0);
    });

    test('planner and apply rejections both propagate before start (fail-closed)', async () => {
        for (const stage of ['planner', 'apply']) {
            const
                lifecycle        = makeLifecycle({agents: repoAgent('a')}),
                prepareWorkspace = async () => { throw new Error(`${stage} rejected workspace preparation`); };

            await expect(startAgentProvisioned({
                lifecycleService: lifecycle,
                agentId         : 'a',
                managedRoot     : '/managed',
                ensureRepo      : makeEnsureRepo('/managed/a/neomjs-neo'),
                prepareWorkspace
            }), stage).rejects.toThrow(`${stage} rejected workspace preparation`);

            expect(lifecycle.calls.start, stage).toHaveLength(0)
        }
    });

    test('an installed-adapter readback rejection propagates after preparation and before spawn', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({
                agents         : remoteRepoAgent('a'),
                events,
                inspectionError: new Error('installed adapter rejected generated projection')
            }),
            ensureRepo       = makeEnsureRepo('/managed/a/neomjs-neo', events),
            prepareWorkspace = makePrepareWorkspace(events);

        await expect(startAgentProvisioned({
            lifecycleService: lifecycle,
            tenantService   : makeTenantService({events}),
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo,
            prepareWorkspace
        })).rejects.toThrow(/installed adapter rejected generated projection/);

        expect(events).toEqual([
            'credential',
            'resolve-tenant',
            'plane-credential',
            'capability',
            'probe',
            'ensure',
            'prepare',
            'inspect'
        ]);
        expect(lifecycle.calls.start).toEqual([])
    });

    test('a repo-bearing raw launch override refuses before clone, prepare, or start', async () => {
        const
            publicAgent = repoAgent('a'),
            rawAgent    = structuredClone(publicAgent);

        rawAgent.a.metadata.launch = {command: '/custom/harness'};

        const
            lifecycle        = makeLifecycle({agents: publicAgent, definitions: rawAgent}),
            ensureRepo       = makeEnsureRepo(),
            prepareWorkspace = makePrepareWorkspace();

        await expect(startAgentProvisioned({
            lifecycleService: lifecycle,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo,
            prepareWorkspace
        })).rejects.toThrow(/raw metadata\.launch override/);

        expect(ensureRepo.calls).toHaveLength(0);
        expect(prepareWorkspace.calls).toHaveLength(0);
        expect(lifecycle.calls.start).toHaveLength(0);
    });

    test('an already-running agent short-circuits to status without provisioning or re-spawning', async () => {
        const lifecycle        = makeLifecycle({agents: repoAgent('a'), running: {a: true}}),
              ensureRepo       = makeEnsureRepo(),
              prepareWorkspace = makePrepareWorkspace(),
              status           = await startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/managed', ensureRepo, prepareWorkspace});

        expect(status.running).toBe(true);
        expect(ensureRepo.calls).toHaveLength(0);
        expect(prepareWorkspace.calls).toHaveLength(0);
        expect(lifecycle.calls.start).toHaveLength(0);
    });

    test('missing lifecycleService / agentId throw clear errors', async () => {
        await expect(startAgentProvisioned({agentId: 'a'})).rejects.toThrow(/lifecycleService/);
        await expect(startAgentProvisioned({lifecycleService: makeLifecycle()})).rejects.toThrow(/agentId/);
    });

    test('a repo-bearing agent with no managedRoot throws and never provisions or starts', async () => {
        const lifecycle  = makeLifecycle({agents: repoAgent('a')}),
              ensureRepo = makeEnsureRepo();

        await expect(startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', ensureRepo}))
            .rejects.toThrow(/managedRoot/);

        expect(ensureRepo.calls).toHaveLength(0);
        expect(lifecycle.calls.start).toHaveLength(0);
    });

    test('a relative AgentOS runtime root rejects before repo or harness effects', async () => {
        const
            lifecycle        = makeLifecycle({agents: repoAgent('a')}),
            ensureRepo       = makeEnsureRepo(),
            prepareWorkspace = makePrepareWorkspace();

        await expect(startAgentProvisioned({
            lifecycleService  : lifecycle,
            agentId           : 'a',
            managedRoot       : '/managed',
            agentosRuntimeRoot: 'relative/agentos',
            ensureRepo,
            prepareWorkspace
        })).rejects.toThrow(/agentosRuntimeRoot.*absolute/);

        expect(ensureRepo.calls).toEqual([]);
        expect(prepareWorkspace.calls).toEqual([]);
        expect(lifecycle.calls.start).toEqual([])
    });

    test('an unknown agent throws', async () => {
        const lifecycle = makeLifecycle({agents: {}});

        await expect(startAgentProvisioned({lifecycleService: lifecycle, agentId: 'ghost', managedRoot: '/managed'}))
            .rejects.toThrow(/unknown agent/);
    });

    test('a preparation result cannot substitute a second checkout path', async () => {
        const lifecycle = makeLifecycle({agents: repoAgent('a')});

        await expect(startAgentProvisioned({
            lifecycleService: lifecycle,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo      : makeEnsureRepo('/managed/a/neomjs-neo'),
            prepareWorkspace: async args => ({
                agentosRuntimeRoot: args.agentosRuntimeRoot,
                targetRepoRoot    : '/other/repo'
            })
        })).rejects.toThrow(/exact AgentOS runtime and target repo roots/);

        expect(lifecycle.calls.start).toHaveLength(0);
    });

    // Admission at the manager's entry cannot speak for the spawn: provisioning and preparation are
    // asynchronous, so the authority admitted at entry may be released while they run. These two arms
    // drive the release and the adoption THROUGH the real composer — the refusal has to come from a
    // registry read at the spawn, not from state captured on the way in.
    test('a release published while preparation runs refuses the spawn', async () => {
        const
            agents      = repoAgent('a'),
            events      = [],
            lifecycle   = makeLifecycle({agents, events}),
            ensureRepo  = makeEnsureRepo('/managed/a/neomjs-neo', events),
            basePrepare = makePrepareWorkspace(events);

        await expect(startAgentProvisioned({
            lifecycleService: lifecycle,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo,
            prepareWorkspace: async args => {
                Object.assign(agents.a, {launchOwner: 'external', launchOwnerSince: '2026-09-19T18:00:00.000Z'});
                events.push('release');

                return basePrepare(args)
            }
        })).rejects.toThrow(/released while its start was being prepared/);

        expect(events).toEqual(['credential', 'ensure', 'release', 'prepare']);
        expect(lifecycle.calls.start).toEqual([])
    });

    test('a seat adopted back while preparation runs spawns', async () => {
        const
            agents    = repoAgent('a'),
            lifecycle = makeLifecycle({agents});

        Object.assign(agents.a, {launchOwner: 'external', launchOwnerSince: '2026-09-19T18:00:00.000Z'});

        const status = await startAgentProvisioned({
            lifecycleService: lifecycle,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo      : makeEnsureRepo('/managed/a/neomjs-neo'),
            prepareWorkspace: async args => {
                Object.assign(agents.a, {launchOwner: 'fleet', launchOwnerSince: null});

                return makePrepareWorkspace()(args)
            }
        });

        expect(status.running).toBe(true);
        expect(lifecycle.calls.start).toHaveLength(1);
        expect(lifecycle.calls.start[0].opts.cwd).toBe('/managed/a/neomjs-neo')
    });

    test('a row born with its record starts under its root; the record is read, never written, by a start', async () => {
        const
            agents    = repoAgent('a'),
            lifecycle = makeLifecycle({agents});

        expect(agents.a.seatHome).toBe('/managed/a');   // defineAgent wrote it at registration

        const status = await startAgentProvisioned({
            lifecycleService  : lifecycle,
            agentId           : 'a',
            managedRoot       : '/managed',
            ensureRepo        : makeEnsureRepo('/managed/a/neomjs-neo'),
            prepareWorkspace  : makePrepareWorkspace(),
            agentosRuntimeRoot: '/installed/neo'
        });

        expect(status.running).toBe(true);
        expect(lifecycle.calls.start).toHaveLength(1);
        expect(agents.a.seatHome).toBe('/managed/a')
    });

    test('a changed agents root is refused before the PAT read and any checkout, naming the recorded home and both remedies', async () => {
        const
            events     = [],
            agents     = repoAgent('a'),
            lifecycle  = makeLifecycle({agents, events}),
            ensureRepo = makeEnsureRepo('/moved/a/neomjs-neo', events),
            prepare    = makePrepareWorkspace(events);

        agents.a.seatHome = '/managed/a';   // materialized under the previous root

        const failure = await startAgentProvisioned({
            lifecycleService  : lifecycle,
            agentId           : 'a',
            managedRoot       : '/moved',
            ensureRepo,
            prepareWorkspace  : prepare,
            agentosRuntimeRoot: '/installed/neo'
        }).catch(error => error);

        expect(failure).toBeInstanceOf(Error);
        expect(failure.code).toBe('FLEET_SEAT_HOME_MISMATCH');
        expect(failure.recordedSeatHome).toBe('/managed/a');
        expect(failure.derivedSeatHome).toBe('/moved/a');
        expect(failure.message).toContain("records its seat home at '/managed/a'");
        expect(failure.message).toContain("derives '/moved/a'");
        expect(failure.message).toMatch(/Restore the previous agents root, or move the seat deliberately and relocate its record/);
        // nothing was created, read or spawned under the new root
        expect(events).toEqual([]);
        expect(ensureRepo.calls).toEqual([]);
        expect(prepare.calls).toEqual([]);
        expect(lifecycle.calls.start).toEqual([]);
        expect(agents.a.seatHome).toBe('/managed/a')
    });

    test('a deliberate move rewrote the record, so the start proceeds under the new root without touching it', async () => {
        const
            agents    = repoAgent('a'),
            lifecycle = makeLifecycle({agents});

        agents.a.seatHome = '/moved/a';   // what relocateSeatHome wrote after the files moved

        const status = await startAgentProvisioned({
            lifecycleService  : lifecycle,
            agentId           : 'a',
            managedRoot       : '/moved',
            ensureRepo        : makeEnsureRepo('/moved/a/neomjs-neo'),
            prepareWorkspace  : makePrepareWorkspace(),
            agentosRuntimeRoot: '/installed/neo'
        });

        expect(status.running).toBe(true);
        expect(lifecycle.calls.start[0].opts.cwd).toBe('/moved/a/neomjs-neo');
        expect(agents.a.seatHome).toBe('/moved/a')
    });

    test('a registration that predates the record is refused until its home is bound, even when a directory already exists under the current root', async () => {
        // the stray empty home an earlier start minted under the changed root also "exists" — a
        // directory carries no binding authority, so the composer never consults the filesystem
        for (const managedRoot of ['/managed', '/moved']) {
            const
                events     = [],
                agents     = legacyRepoAgent('a'),
                lifecycle  = makeLifecycle({agents, events}),
                ensureRepo = makeEnsureRepo(`${managedRoot}/a/neomjs-neo`, events),
                prepare    = makePrepareWorkspace(events);

            const failure = await startAgentProvisioned({
                lifecycleService  : lifecycle,
                agentId           : 'a',
                managedRoot,
                ensureRepo,
                prepareWorkspace  : prepare,
                agentosRuntimeRoot: '/installed/neo'
            }).catch(error => error);

            expect(failure).toBeInstanceOf(Error);
            expect(failure.code).toBe('FLEET_SEAT_HOME_UNBOUND');
            expect(failure.derivedSeatHome).toBe(`${managedRoot}/a`);
            expect(failure.message).toContain(`was registered before Fleet recorded seat homes and names none; the current agents root derives '${managedRoot}/a'`);
            expect(failure.message).toMatch(/bind its home deliberately \(relocateSeatHome from null\) to the directory its files live in/);
            expect(events).toEqual([]);
            expect(ensureRepo.calls).toEqual([]);
            expect(prepare.calls).toEqual([]);
            expect(lifecycle.calls.start).toEqual([]);
            expect(agents.a.seatHome).toBeUndefined()
        }
    });

    test('a legacy row bound to the directory its files live in starts there, and nowhere else', async () => {
        const
            agents    = legacyRepoAgent('a'),
            lifecycle = makeLifecycle({agents});

        agents.a.seatHome = '/managed/a';   // relocateSeatHome(id, {from: null, to: '/managed/a'}) — the deliberate bind

        const status = await startAgentProvisioned({
            lifecycleService  : lifecycle,
            agentId           : 'a',
            managedRoot       : '/managed',
            ensureRepo        : async () => ({repoPath: '/managed/a/neomjs-neo', state: 'present', action: 'reused', cloned: false}),
            prepareWorkspace  : makePrepareWorkspace(),
            agentosRuntimeRoot: '/installed/neo'
        });

        expect(status.running).toBe(true);
        expect(lifecycle.calls.start[0].opts.cwd).toBe('/managed/a/neomjs-neo');

        const elsewhere = await startAgentProvisioned({
            lifecycleService  : makeLifecycle({agents}),
            agentId           : 'a',
            managedRoot       : '/moved',
            ensureRepo        : makeEnsureRepo('/moved/a/neomjs-neo'),
            prepareWorkspace  : makePrepareWorkspace(),
            agentosRuntimeRoot: '/installed/neo'
        }).catch(error => error);

        expect(elsewhere.code).toBe('FLEET_SEAT_HOME_MISMATCH')
    });

    test('a curated seat without a managed repo is guarded too: its harness home and lease live under the agents root', async () => {
        // unbound: refused before the envelope, the PAT read and the spawn — nothing under the root is touched
        const
            events  = [],
            unbound = {a: {id: 'a', githubUsername: 'a', harnessType: 'codex-desktop', metadata: {}}},
            refusal = await startAgentProvisioned({lifecycleService: makeLifecycle({agents: unbound, events}), agentId: 'a', managedRoot: '/moved'}).catch(error => error);

        expect(refusal.code).toBe('FLEET_SEAT_HOME_UNBOUND');
        expect(refusal.derivedSeatHome).toBe('/moved/a');
        expect(events).toEqual([]);

        // bound elsewhere: the same mismatch refusal a repo-bearing seat gets
        const
            moved     = {a: {id: 'a', githubUsername: 'a', harnessType: 'codex-desktop', metadata: {}, seatHome: '/managed/a'}},
            lifecycle = makeLifecycle({agents: moved, events}),
            mismatch  = await startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/moved'}).catch(error => error);

        expect(mismatch.code).toBe('FLEET_SEAT_HOME_MISMATCH');
        expect(mismatch.recordedSeatHome).toBe('/managed/a');
        expect(lifecycle.calls.start).toEqual([]);
        expect(events).toEqual([]);

        // bound where the root derives it: starts in the inherited cwd as before
        const status = await startAgentProvisioned({lifecycleService: makeLifecycle({agents: moved}), agentId: 'a', managedRoot: '/managed'});

        expect(status.running).toBe(true);

        // the managed root is required to place the home even without a repo
        await expect(startAgentProvisioned({lifecycleService: makeLifecycle({agents: moved}), agentId: 'a'})).rejects.toThrow(/'managedRoot' is required to place the seat home/)
    });

    test('a raw metadata.launch override derives no home, so it is the one row the guard leaves alone', async () => {
        const
            agents    = {a: {id: 'a', metadata: {launch: {command: 'h'}}}},
            lifecycle = makeLifecycle({agents});

        expect(agents.a.seatHome).toBeUndefined();

        const status = await startAgentProvisioned({lifecycleService: lifecycle, agentId: 'a', managedRoot: '/moved'});

        expect(status.running).toBe(true);
        expect(lifecycle.calls.start).toHaveLength(1)
    });
});

/**
 * A seat on the plane the Fleet serves (`planeBase`) reaches that plane's Memory Core and Knowledge
 * Base with its own stored plane credential, proven again at every start on the plane it was stored
 * against. A seat that cannot get there refuses and says why; a private per-seat store is no fallback.
 */
test.describe('startAgentProvisioned — a seat\'s Memory Core is the plane the Fleet serves', () => {
    const
        PLANE      = 'http://127.0.0.1:3102',
        SERVED     = Object.freeze({id: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data'}),
        RESOURCES  = Object.freeze({'memory-core': {url: `${PLANE}/mc/mcp`}, 'knowledge-base': {url: `${PLANE}/kb/mcp`}}),
        CAPABILITY = Object.freeze({harnessType: 'codex', binaryPath: '/bin/harness', launchBinaryPath: '/bin/harness'});

    /** The seat-plane half of the tenant service: existing-PAT binding and the start's proof of it. */
    function makePlaneService({events, stored = {credential: 'seat-plane-pat', plane: SERVED}, readiness = {ok: true}, storeResult = {status: 'stored'}, storeReadback} = {}) {
        const calls = {resolve: [], probe: [], store: []};
        let currentStored = stored;

        return {
            calls,
            resolveSeatPlaneCredential(args) {
                events?.push('plane-credential');
                calls.resolve.push(args);

                return currentStored
            },
            async storeSeatPlaneCredential(args) {
                events?.push('store');
                calls.store.push(args);

                if (storeReadback !== undefined) currentStored = storeReadback;
                else if (storeResult?.status === 'stored') currentStored = {credential: args.credential, plane: SERVED};

                return storeResult
            },
            async probeSeatPlaneCredential(args) {
                events?.push('probe');
                calls.probe.push(args);

                return readiness
            }
        }
    }

    /** A lifecycle that also records which placement the resident envelope was resolved for. */
    function makePlaneLifecycle(options) {
        const lifecycle = makeLifecycle(options);

        lifecycle.calls.resident = [];
        lifecycle.resolveResidentMcpEnvironment = (agent, placed) => { lifecycle.calls.resident.push(placed); return {} };

        return lifecycle
    }

    function start({lifecycle, planeService, planeBase = PLANE, ensureRepo = makeEnsureRepo('/managed/a/neomjs-neo'), prepareWorkspace = makePrepareWorkspace()}) {
        return startAgentProvisioned({
            lifecycleService: lifecycle,
            tenantService   : planeService,
            agentId         : 'a',
            managedRoot     : '/managed',
            planeBase,
            ensureRepo,
            prepareWorkspace
        })
    }

    test('a seat starts with its own plane credential, proven on its plane before any checkout', async () => {
        const
            events           = [],
            lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), credentials: {a: 'ghp_seat_checkout'}, events}),
            planeService     = makePlaneService({events}),
            prepareWorkspace = makePrepareWorkspace(events);

        await start({lifecycle, planeService, ensureRepo: makeEnsureRepo('/managed/a/neomjs-neo', events), prepareWorkspace});

        expect(events).toEqual(['credential', 'plane-credential', 'capability', 'probe', 'ensure', 'prepare', 'inspect', 'start']);
        expect(lifecycle.calls.resident).toEqual([{remote: true}]);
        expect(planeService.calls.resolve).toEqual([{planeBase: PLANE, agentId: 'a'}]);
        expect(planeService.calls.probe).toEqual([{
            planeBase       : PLANE,
            credential      : 'seat-plane-pat',
            expectedIdentity: '@a',
            expectedPlane   : SERVED
        }]);
        expect(planeService.calls.store).toEqual([]);
        expect(prepareWorkspace.calls[0].mcpTarget).toEqual({kind: 'tenant', credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN', resources: RESOURCES});
        expect(lifecycle.calls.inspection[0].mcpTarget).toEqual({kind: 'tenant', resources: RESOURCES});
        // An existing explicit plane binding remains separate and is only re-proven.
        expect(lifecycle.calls.start[0].opts).toEqual({
            cwd                   : '/managed/a/neomjs-neo',
            resolvedCredential    : 'ghp_seat_checkout',
            resolvedResidentMcpEnv: {},
            gitIdentity           : {name: 'Seat Agent', email: 'seat@example.test'},
            resolvedMcpCredential : 'seat-plane-pat',
            resolvedMcpEndpoint   : PLANE,
            remoteMcpCapability   : CAPABILITY
        })
    });

    test('a missing default-plane binding uses the existing registry PAT once, then re-proves it before checkout', async () => {
        const
            events           = [],
            lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), credentials: {a: 'ghp_seat_checkout'}, events}),
            planeService     = makePlaneService({events, stored: null}),
            ensureRepo       = makeEnsureRepo('/managed/a/neomjs-neo', events),
            prepareWorkspace = makePrepareWorkspace(events);

        await start({lifecycle, planeService, ensureRepo, prepareWorkspace});

        expect(events).toEqual(['credential', 'plane-credential', 'capability', 'store', 'plane-credential', 'probe', 'ensure', 'prepare', 'inspect', 'start']);
        expect(planeService.calls.store).toEqual([{
            planeBase : PLANE,
            agentId   : 'a',
            identity  : '@a',
            credential: 'ghp_seat_checkout',
            ifAbsent  : true
        }]);
        expect(planeService.calls.resolve).toEqual([
            {planeBase: PLANE, agentId: 'a'},
            {planeBase: PLANE, agentId: 'a'}
        ]);
        expect(planeService.calls.probe).toEqual([{
            planeBase       : PLANE,
            credential      : 'ghp_seat_checkout',
            expectedIdentity: '@a',
            expectedPlane   : SERVED
        }]);
        expect(lifecycle.calls.start[0].opts).toMatchObject({
            resolvedCredential   : 'ghp_seat_checkout',
            resolvedMcpCredential: 'ghp_seat_checkout',
            resolvedMcpEndpoint  : PLANE
        });

        // Once written, a later start reuses and re-proves the binding rather than creating another.
        await start({lifecycle, planeService});

        expect(planeService.calls.store).toHaveLength(1);
        expect(planeService.calls.probe).toHaveLength(2);
        expect(lifecycle.calls.start).toHaveLength(2);
        expect(lifecycle.calls.start.map(({opts}) => opts.resolvedMcpCredential)).toEqual([
            'ghp_seat_checkout',
            'ghp_seat_checkout'
        ])
    });

    test('failed default-plane identity, reachability or persistence proof refuses before clone and spawn', async () => {
        for (const reason of [
            'the credential resolves to another identity',
            'plane endpoint unreachable',
            'seat plane credential could not be persisted'
        ]) {
            const
                lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), credentials: {a: 'ghp_seat_checkout'}}),
                planeService     = makePlaneService({stored: null, storeResult: {status: 'rejected', reason}}),
                ensureRepo       = makeEnsureRepo(),
                prepareWorkspace = makePrepareWorkspace(),
                failure          = await start({lifecycle, planeService, ensureRepo, prepareWorkspace}).then(() => null, error => error);

            expect(failure?.message, reason).toContain(reason);
            expect(failure?.message, reason).not.toContain('ghp_seat_checkout');
            expect(planeService.calls.store[0].credential, reason).toBe('ghp_seat_checkout');
            expect(ensureRepo.calls, reason).toEqual([]);
            expect(prepareWorkspace.calls, reason).toEqual([]);
            expect(lifecycle.calls.start, reason).toEqual([])
        }
    });

    test('a successful create-only store that cannot be read back refuses before checkout and spawn', async () => {
        const
            lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), credentials: {a: 'ghp_seat_checkout'}}),
            planeService     = makePlaneService({stored: null, storeReadback: null}),
            ensureRepo       = makeEnsureRepo(),
            prepareWorkspace = makePrepareWorkspace(),
            failure          = await start({lifecycle, planeService, ensureRepo, prepareWorkspace}).then(() => null, error => error);

        expect(failure?.message).toContain('plane binding was not readable after storage');
        expect(planeService.calls.store).toHaveLength(1);
        expect(ensureRepo.calls).toEqual([]);
        expect(prepareWorkspace.calls).toEqual([]);
        expect(lifecycle.calls.start).toEqual([])
    });

    test('a binding already present at the store snapshot is re-read and re-proved instead of replaced', async () => {
        const
            registryPat      = 'ghp_seat_checkout',
            explicitBinding  = 'explicit-plane-binding',
            lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), credentials: {a: registryPat}}),
            planeService     = makePlaneService({stored: null, storeReadback: {credential: explicitBinding, plane: SERVED}}),
            prepareWorkspace = makePrepareWorkspace();

        await start({lifecycle, planeService, prepareWorkspace});

        expect(planeService.calls.store).toEqual([{
            planeBase : PLANE,
            agentId   : 'a',
            identity  : '@a',
            credential: registryPat,
            ifAbsent  : true
        }]);
        expect(planeService.calls.resolve).toHaveLength(2);
        expect(planeService.calls.probe[0]).toEqual({
            planeBase       : PLANE,
            credential      : explicitBinding,
            expectedIdentity: '@a',
            expectedPlane   : SERVED
        });
        expect(lifecycle.calls.start[0].opts.resolvedCredential).toBe(registryPat);
        expect(lifecycle.calls.start[0].opts.resolvedMcpCredential).toBe(explicitBinding)
    });

    test('a binding that appears during a failed registry-PAT proof is re-read and re-proved before checkout', async () => {
        const
            registryPat      = 'ghp_seat_checkout',
            explicitBinding  = 'explicit-plane-binding',
            lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), credentials: {a: registryPat}}),
            planeService     = makePlaneService({
                stored      : null,
                storeResult : {status: 'rejected', reason: 'plane rejected the credential'},
                storeReadback: {credential: explicitBinding, plane: SERVED}
            }),
            ensureRepo       = makeEnsureRepo(),
            prepareWorkspace = makePrepareWorkspace();

        await start({lifecycle, planeService, ensureRepo, prepareWorkspace});

        expect(planeService.calls.resolve).toHaveLength(2);
        expect(planeService.calls.probe[0]).toMatchObject({
            credential      : explicitBinding,
            expectedIdentity: '@a',
            expectedPlane   : SERVED
        });
        expect(ensureRepo.calls).toHaveLength(1);
        expect(lifecycle.calls.start[0].opts.resolvedCredential).toBe(registryPat);
        expect(lifecycle.calls.start[0].opts.resolvedMcpCredential).toBe(explicitBinding)
    });

    test('every launchable family either renders no local Memory Core or Knowledge Base on the plane, or refuses', async () => {
        // `plan` is the real planner over exactly what the start hands preparation
        const
            ON   = {'memory-core': true, 'knowledge-base': true, 'neural-link': false, 'github-workflow': false, 'gitlab-workflow': false},
            rows = {},
            plan = async args => {
                const {mcpServers} = createManagedAgentWorkspacePlan({agent: {id: args.agent.id, harnessType: args.agent.harnessType}, mcpMatrix: ON, mcpTarget: args.mcpTarget});

                rows[args.agent.harnessType] = mcpServers.filter(server => ['memory-core', 'knowledge-base'].includes(server.key));

                return {agentosRuntimeRoot: args.agentosRuntimeRoot, targetRepoRoot: args.targetRepoRoot, instanceHome: `/instances/${args.agent.id}`, mcpMatrix: ON, mcpPlan: buildPreparedMcpPlan(args, ON)}
            };

        expect(LAUNCHABLE_HARNESS_TYPES.filter(supportsTenantMcpTarget).length).toBeGreaterThan(0);
        expect(LAUNCHABLE_HARNESS_TYPES.filter(type => !supportsTenantMcpTarget(type))).toContain('antigravity');

        for (const harnessType of LAUNCHABLE_HARNESS_TYPES) {
            const agents = repoAgent('a');

            agents.a.harnessType = harnessType;

            const run = start({lifecycle: makePlaneLifecycle({agents}), planeService: makePlaneService(), prepareWorkspace: plan});

            if (!supportsTenantMcpTarget(harnessType)) {
                await expect(run, harnessType).rejects.toThrow(`agent 'a' cannot start: ${harnessType} cannot reach a remote Memory Core`);
                continue
            }

            await run;

            expect(rows[harnessType].map(({key, target, transport, url}) => ({key, target, transport, url})), harnessType).toEqual([
                {key: 'memory-core',    target: 'tenant', transport: 'streamable-http', url: RESOURCES['memory-core'].url},
                {key: 'knowledge-base', target: 'tenant', transport: 'streamable-http', url: RESOURCES['knowledge-base'].url}
            ])
        }
    });

    test('a seat that cannot get to the plane refuses before checkout, workspace and spawn, and names why', async () => {
        const scenarios = [{
            name : 'another identity',
            plane: {readiness: {ok: false, reason: 'the credential resolves to another identity'}},
            error: `agent 'a' cannot use its plane at ${PLANE}: the credential resolves to another identity.`
        }, {
            name : 'an unreachable plane',
            plane: {readiness: {ok: false, reason: 'plane endpoint unreachable'}},
            error: `agent 'a' cannot use its plane at ${PLANE}: plane endpoint unreachable.`
        }, {
            name : 'a plane recreated behind the same URL',
            plane: {readiness: {ok: false, reason: 'the plane at this endpoint is not the one the credential was stored for'}},
            error: 'the plane at this endpoint is not the one the credential was stored for'
        }, {
            name           : 'a harness without the remote grammar',
            plane          : {},
            capabilityError: new Error('missing remote grammar'),
            error          : 'missing remote grammar'
        }];

        for (const scenario of scenarios) {
            const
                lifecycle        = makePlaneLifecycle({agents: repoAgent('a'), capabilityError: scenario.capabilityError}),
                ensureRepo       = makeEnsureRepo(),
                prepareWorkspace = makePrepareWorkspace();

            await expect(start({lifecycle, planeService: makePlaneService(scenario.plane), ensureRepo, prepareWorkspace}), scenario.name)
                .rejects.toThrow(scenario.error);

            expect(ensureRepo.calls, scenario.name).toEqual([]);
            expect(prepareWorkspace.calls, scenario.name).toEqual([]);
            expect(lifecycle.calls.start, scenario.name).toEqual([])
        }
    });

    test('a seat the plane cannot host refuses before any secret is read', async () => {
        const repoLess = repoAgent('a');

        delete repoLess.a.metadata.repo;

        for (const [name, agents, planeBase, error] of [
            ['a seat without a managed repo', repoLess,                                                     PLANE,                      /reaches its Memory Core remotely and requires a managed repo/],
            ['a harness with no remote Memory Core', {a: {...repoAgent('a').a, harnessType: 'antigravity'}}, PLANE,                      /cannot start: antigravity cannot reach a remote Memory Core/],
            ['a plane that is no secure endpoint', repoAgent('a'),                                          'http://plane.example.com', /cannot start: fleet\.planeBase is not a secure MCP endpoint/]
        ]) {
            const
                lifecycle    = makePlaneLifecycle({agents}),
                planeService = makePlaneService();

            await expect(start({lifecycle, planeService, planeBase}), name).rejects.toThrow(error);

            expect(lifecycle.calls.credential, name).toEqual([]);
            expect(planeService.calls.resolve, name).toEqual([]);
            expect(lifecycle.calls.start, name).toEqual([])
        }
    });

    test('a Fleet that serves no plane keeps the per-seat servers, and a raw launch override has no placement', async () => {
        const
            lifecycle        = makePlaneLifecycle({agents: repoAgent('a')}),
            planeService     = makePlaneService(),
            prepareWorkspace = makePrepareWorkspace();

        await start({lifecycle, planeService, planeBase: null, prepareWorkspace});

        expect(lifecycle.calls.resident).toEqual([{remote: false}]);
        expect(planeService.calls.resolve).toEqual([]);
        expect(prepareWorkspace.calls[0].mcpTarget).toBeNull();
        expect(lifecycle.calls.start[0].opts).not.toHaveProperty('resolvedMcpCredential');

        const raw = makePlaneLifecycle({agents: {a: {id: 'a', githubUsername: 'a', metadata: {launch: {command: 'h'}}}}});

        expect((await start({lifecycle: raw, planeService})).running).toBe(true);
        expect(planeService.calls.resolve).toEqual([])
    });
});

test.describe('startAgentProvisioned — an adopted seat\'s memory import', () => {
    const
        SOURCE  = '/Users/x/.codex/memories',
        adopted = (id = 'a') => {
            const agents = repoAgent(id);

            agents[id] = {...agents[id], memoryImport: SOURCE};

            return agents
        },
        start = ({lifecycle, events, importMemory}) => startAgentProvisioned({
            lifecycleService: lifecycle,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo      : makeEnsureRepo('/managed/a/neomjs-neo', events),
            prepareWorkspace: makePrepareWorkspace(events),
            nodePath        : '/usr/bin/node',
            ...(importMemory ? {importMemory} : {})
        });

    test('the import runs after preparation and before the spawn, and its result rides the status', async () => {
        const
            events       = [],
            calls        = [],
            lifecycle    = makeLifecycle({agents: adopted(), events}),
            importMemory = async args => {
                events.push('import');
                calls.push(args);

                return {state: 'copied', source: SOURCE, destination: '/instances/a/harness/codex/memories', files: 33}
            },
            status = await start({lifecycle, events, importMemory});

        expect(events).toEqual(['credential', 'ensure', 'prepare', 'import', 'start']);
        expect(calls).toEqual([{agent: adopted().a, instanceRoot: '/instances'}]);
        expect(status.memoryImport).toEqual({state: 'copied', source: SOURCE, destination: '/instances/a/harness/codex/memories', files: 33})
    });

    test('a refused import stops the start: nothing is spawned', async () => {
        const
            lifecycle = makeLifecycle({agents: adopted()}),
            refusal   = Object.assign(new Error("startAgentProvisioned: agent 'a' consented to import its memory, but its seat holds none."), {code: 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED'});

        await expect(start({lifecycle, importMemory: async () => {throw refusal}})).rejects.toBe(refusal);
        expect(lifecycle.calls.start).toHaveLength(0)
    });

    test('a fresh seat imports nothing and its status carries no import', async () => {
        const status = await start({lifecycle: makeLifecycle({agents: repoAgent('a')})});

        expect(status.state).toBe('running');
        expect(status).not.toHaveProperty('memoryImport')
    });

    test('a seat without a managed repository cannot converge a consented import, so it is refused before the spawn', async () => {
        const lifecycle = makeLifecycle({agents: {a: {id: 'a', metadata: {launch: {command: 'h'}}, memoryImport: SOURCE}}});

        await expect(start({lifecycle})).rejects.toMatchObject({
            code   : 'FLEET_SEAT_MEMORY_IMPORT_UNCONVERGED', source: SOURCE, step: 'memory import',
            message: "startAgentProvisioned: the memory import needs the seat's repository: set it before starting it."
        });
        expect(lifecycle.calls.start).toHaveLength(0)
    });
});

test.describe('startAgentProvisioned — the seat commits as itself', () => {
    const
        BRAIN      = {repoSlug: 'neomjs/neo-agent-brain', cloneUrl: 'https://github.com/neomjs/neo-agent-brain.git'},
        MISSING    = {state: 'missing', name: 'Seat Agent', reason: 'its forge account offers no email this PAT can read'},
        CONVERGED  = {state: 'converged', scope: 'local', action: 'written'},
        withRepos  = (...repos) => ({a: {...repoAgent('a').a, metadata: {repo: REPO, repos}}}),
        // each repository lands in its own checkout; a slug listed in `failing` cannot be cloned
        ensureRepo = (events, failing = []) => async ({repoSlug}) => {
            events.push('ensure');

            if (failing.includes(repoSlug)) throw new Error(`clone of ${repoSlug} failed`);

            return {repoPath: `/managed/a/${repoSlug.replace('/', '-')}`}
        },
        recorder   = (events, name, answer) => {
            const fn = async args => { events.push(name); fn.calls.push(args); return answer };

            fn.calls = [];
            return fn
        },
        start      = ({lifecycle, events, resolveGitIdentity, convergeGitIdentity, failing}) => startProvisioned({
            lifecycleService: lifecycle,
            agentId         : 'a',
            managedRoot     : '/managed',
            ensureRepo      : ensureRepo(events, failing),
            prepareWorkspace: makePrepareWorkspace(events),
            nodePath        : '/usr/bin/node',
            resolveGitIdentity,
            convergeGitIdentity
        });

    test('the identity is resolved with the seat\'s PAT before anything is cloned, and every checkout converges before preparation', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: withRepos(BRAIN), events}),
            resolve   = recorder(events, 'resolve', SEAT_GIT_IDENTITY),
            converge  = recorder(events, 'converge', CONVERGED);

        await start({lifecycle, events, resolveGitIdentity: resolve, convergeGitIdentity: converge});

        expect(events).toEqual(['credential', 'resolve', 'ensure', 'ensure', 'converge', 'converge', 'prepare', 'start']);
        expect(resolve.calls).toEqual([{agent: withRepos(BRAIN).a, credential: FIXTURE_PAT}]);
        expect(converge.calls).toEqual([
            {repoPath: '/managed/a/neomjs-neo',             identity: {name: 'Seat Agent', email: 'seat@example.test'}},
            {repoPath: '/managed/a/neomjs-neo-agent-brain', identity: {name: 'Seat Agent', email: 'seat@example.test'}}
        ]);
        expect(lifecycle.calls.start[0].opts.gitIdentity).toEqual({name: 'Seat Agent', email: 'seat@example.test'});
        expect(lifecycle.calls.gitIdentity).toEqual([{id: 'a', gitIdentity: SEAT_GIT_IDENTITY}]);
    });

    test('with no identity to commit under, Start refuses before anything is cloned, names the next step and records it', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: repoAgent('a'), events}),
            converge  = recorder(events, 'converge', CONVERGED);

        await expect(start({lifecycle, events, resolveGitIdentity: async () => MISSING, convergeGitIdentity: converge})).rejects.toMatchObject({
            code   : 'FLEET_SEAT_GIT_IDENTITY_MISSING',
            message: "startAgentProvisioned: agent 'a' has no Git identity to commit under: its forge account offers no email this PAT can read. Nothing was changed. Declare the name and email its commits carry (gitName and gitEmail), then start it again."
        });
        expect(events).toEqual(['credential']);
        expect(lifecycle.calls.start).toHaveLength(0);
        expect(lifecycle.calls.gitIdentity).toEqual([{id: 'a', gitIdentity: MISSING}]);
    });

    test('an account that could not be read stops the start the same way, as unknown rather than missing', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: repoAgent('a'), events}),
            unknown   = {state: 'unknown', reason: 'its forge account could not be read (HTTP 401)'};

        await expect(start({lifecycle, events, resolveGitIdentity: async () => unknown, convergeGitIdentity: recorder(events, 'converge', CONVERGED)})).rejects.toMatchObject({
            code   : 'FLEET_SEAT_GIT_IDENTITY_UNKNOWN',
            message: "startAgentProvisioned: agent 'a' cannot start until its Git identity is known: its forge account could not be read (HTTP 401). Nothing was changed. Check its PAT and its forge, or declare the name and email its commits carry (gitName and gitEmail), then start it again."
        });
        expect(events).toEqual(['credential']);
        expect(lifecycle.calls.gitIdentity).toEqual([{id: 'a', gitIdentity: unknown}]);
    });

    test('a PAT that answers for another account stops the start before anything is cloned: the real derivation over a fixture forge', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: repoAgent('a'), events}),
            converge  = recorder(events, 'converge', CONVERGED),
            // the stored PAT reads an account that is not the seat's `a`
            fetchFn   = async url => ({ok: true, status: 200, json: async () => url === 'https://api.github.com/user'
                ? {login: 'different-account', name: 'Different Account', email: 'different@example.test'}
                : [{email: 'different@example.test', primary: true, verified: true, visibility: 'public'}]}),
            resolve   = args => resolveSeatGitIdentity({...args, fetchFn});

        await expect(start({lifecycle, events, resolveGitIdentity: resolve, convergeGitIdentity: converge})).rejects.toMatchObject({
            code   : 'FLEET_SEAT_GIT_IDENTITY_MISMATCH',
            message: "startAgentProvisioned: agent 'a' would commit as another account: its PAT belongs to the forge account 'different-account', not to the seat's 'a'. Nothing was changed. Store the seat's own PAT, or declare the name and email its commits carry (gitName and gitEmail), then start it again."
        });
        expect(events).toEqual(['credential']);
        expect(converge.calls).toEqual([]);
        expect(lifecycle.calls.start).toHaveLength(0);
        expect(lifecycle.calls.gitIdentity).toEqual([{id: 'a', gitIdentity: expect.objectContaining({state: 'mismatch', found: 'different-account'})}]);
    });

    test('a checkout holding another identity stops the start before preparation, left as it is, and records the mismatch', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: repoAgent('a'), events}),
            found     = 'Operator <operator@example.test>',
            converge  = recorder(events, 'converge', {state: 'mismatch', scope: 'local', found, reason: `holds '${found}' in its local config, which the Fleet did not write`});

        await expect(start({lifecycle, events, resolveGitIdentity: async () => SEAT_GIT_IDENTITY, convergeGitIdentity: converge})).rejects.toMatchObject({
            code    : 'FLEET_SEAT_GIT_IDENTITY_MISMATCH',
            repoPath: '/managed/a/neomjs-neo',
            found,
            message : "startAgentProvisioned: agent 'a' commits as 'Seat Agent <seat@example.test>', but its checkout '/managed/a/neomjs-neo' holds 'Operator <operator@example.test>' in its local config, which the Fleet did not write. The harness is not spawned, and no identity the Fleet did not write was changed. Declare the identity the seat commits as, or remove the other one from that checkout's Git config, then start it again."
        });
        expect(events).toEqual(['credential', 'ensure', 'converge']);
        expect(lifecycle.calls.start).toHaveLength(0);
        expect(lifecycle.calls.gitIdentity).toEqual([{id: 'a', gitIdentity: {...SEAT_GIT_IDENTITY, state: 'mismatch'}}]);
    });

    test('a repository that could not be cloned is reported and not converged; the others are', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: withRepos(BRAIN, {repoSlug: 'neomjs/missing', cloneUrl: 'https://github.com/neomjs/missing.git'}), events}),
            converge  = recorder(events, 'converge', CONVERGED),
            status    = await start({lifecycle, events, resolveGitIdentity: async () => SEAT_GIT_IDENTITY, convergeGitIdentity: converge, failing: ['neomjs/missing']});

        expect(converge.calls.map(call => call.repoPath)).toEqual(['/managed/a/neomjs-neo', '/managed/a/neomjs-neo-agent-brain']);
        expect(status.repos.map(repo => repo.state)).toEqual(['prepared', 'failed']);
    });

    test('a seat without a managed repository resolves no identity', async () => {
        const
            events    = [],
            lifecycle = makeLifecycle({agents: {a: {id: 'a', githubUsername: 'a', harnessType: 'codex', metadata: {launch: {command: 'h'}}}}, events}),
            resolve   = recorder(events, 'resolve', SEAT_GIT_IDENTITY);

        await start({lifecycle, events, resolveGitIdentity: resolve, convergeGitIdentity: recorder(events, 'converge', CONVERGED)});

        expect(resolve.calls).toHaveLength(0);
        expect(lifecycle.calls.start[0].opts).not.toHaveProperty('gitIdentity');
    });
});
