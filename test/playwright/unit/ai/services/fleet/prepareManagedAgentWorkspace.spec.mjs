import {test, expect}                  from '@playwright/test';
import {Client}                        from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport}          from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMcpExpressApp}           from '@modelcontextprotocol/sdk/server/express.js';
import {McpServer}                     from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {spawnSync}                     from 'node:child_process';
import crypto                          from 'node:crypto';
import fs                              from 'node:fs/promises';
import os                              from 'node:os';
import path                            from 'node:path';
import {fileURLToPath, pathToFileURL}  from 'node:url';
import {
    ManagedWorkspacePreparationError,
    WORKSPACE_ARTIFACT_STATES,
    applyManagedAgentWorkspacePlan,
    createManagedAgentWorkspacePlan,
    prepareManagedAgentWorkspace
} from '../../../../../../ai/services/fleet/prepareManagedAgentWorkspace.mjs';
import {mcpDeclarationRefusal}                          from '../../../../../../ai/services/fleet/managedAgentWorkspacePlan.mjs';
import {isUnmodifiedGeneration, stampWakeEnvelopePlant} from '../../../../../../ai/services/fleet/generateOpenCodeSeatConfig.mjs';
import {deriveNodeRuntimeEnv}                           from '../../../../../../ai/services/fleet/deriveNodeRuntimeEnv.mjs';
import {startAgentProvisioned}                          from '../../../../../../ai/services/fleet/startAgentProvisioned.mjs';

// Temp-filesystem contract tests: the real artifact writer runs, while checkout hydration is an
// injected recorder. `hydrateCurrentWorktree` has its own real temp-checkout suite; this spec proves
// the new composer calls that existing primitive at the right boundary without invoking its CLI,
// install, or build path.

const NODE_PATH    = process.execPath;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

const MCP_ENTRYPOINTS = [
    'ai/mcp/server/memory-core/mcp-server.mjs',
    'ai/mcp/server/knowledge-base/mcp-server.mjs',
    'ai/mcp/server/neural-link/mcp-server.mjs',
    'ai/mcp/server/github-workflow/mcp-server.mjs',
    'ai/mcp/server/gitlab-workflow/mcp-server.mjs'
];

const BOUNDED_APPLY_EFFECTS = new Set([
    'access',
    'chmod',
    'hydrateWorkspace',
    'lstat',
    'mkdir',
    'readFile',
    'rename',
    'stat',
    'unlink',
    'writeFile'
]);

let root, agentosRuntimeRoot, repoRoot, instanceRoot, hydrationCalls;

test.beforeEach(async () => {
    root          = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-fleet-workspace-'));
    agentosRuntimeRoot  = path.join(root, 'installed-neo');
    repoRoot      = path.join(root, 'managed-repos');
    instanceRoot  = path.join(root, 'instances');
    hydrationCalls = [];

    await fs.mkdir(path.join(agentosRuntimeRoot, 'ai/mcp/client'), {recursive: true});
    await fs.writeFile(
        path.join(agentosRuntimeRoot, 'ai/mcp/client/stdioToStreamableHttp.mjs'),
        '// installed Neo bridge entrypoint\n',
        'utf8'
    );
    for (const relativePath of MCP_ENTRYPOINTS) {
        const filePath = path.join(agentosRuntimeRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), {recursive: true});
        await fs.writeFile(filePath, '// installed canonical entrypoint\n', 'utf8');
    }
});

test.afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
});

function makeAgent(harnessType, {id = 'agent-a', mcpServers = null} = {}) {
    return {id, githubUsername: 'shared-login', harnessType, mcpServers};
}

function makeHydrate() {
    return async args => {
        hydrationCalls.push(args);
        await fs.mkdir(args.projectRoot, {recursive: true});
        return {hydrated: true};
    };
}

function options(agent, repoName = agent.id) {
    const result = {
        agent,
        targetRepoRoot  : path.join(repoRoot, repoName),
        instanceRoot,
        agentosRuntimeRoot,
        nodePath        : NODE_PATH,
        hydrateWorkspace: makeHydrate()
    };

    if (agent.harnessType === 'claude-desktop') {
        result.remoteMcpCapability = claudeDesktopRemoteCapability(agentosRuntimeRoot)
    }

    return result
}

function claudeDesktopRemoteCapability(checkout, nodePath=NODE_PATH) {
    return {
        harnessType     : 'claude-desktop',
        binaryPath      : '/Applications/Claude.app/Contents/MacOS/Claude',
        launchBinaryPath: '/Applications/Claude.app/Contents/MacOS/Claude',
        bridge          : {
            kind      : 'neo-stdio-streamable-http',
            command   : nodePath,
            entrypoint: path.join(checkout, 'ai/mcp/client/stdioToStreamableHttp.mjs')
        }
    }
}

async function read(filePath) {
    return fs.readFile(filePath, 'utf8');
}

async function sourceFiles(directoryPath) {
    const result = [];

    for (const entry of await fs.readdir(directoryPath, {withFileTypes: true})) {
        const filePath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            result.push(...await sourceFiles(filePath))
        } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
            result.push(filePath)
        }
    }

    return result
}

/**
 * @summary Start two authenticated Streamable-HTTP MCP resources behind one ephemeral listener.
 * Each route exposes a resource-labelled probe tool so the generated MC and KB bridge entries can
 * be proven independently through their actual stdio subprocess.
 * @param {String} token Expected bearer token.
 * @returns {Promise<{baseUrl: String, close: Function, sessionCount: Function}>}
 */
async function startBridgeFixture(token) {
    const
        app        = createMcpExpressApp({allowedHosts: ['127.0.0.1']}),
        sessions   = new Map(),
        mcpServers = new Set(),
        transports = new Set();

    app.use((request, response, next) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
            response.setHeader('WWW-Authenticate', 'Bearer');
            response.status(401).json({error: 'unauthorized'});
            return
        }

        next()
    });

    for (const resource of ['mc', 'kb']) {
        app.all(`/${resource}/mcp`, async (request, response) => {
            const sessionId = request.headers['mcp-session-id'];
            let   transport = sessionId && sessions.get(`${resource}:${sessionId}`);

            if (!transport) {
                let mcpServer;

                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator  : () => crypto.randomUUID(),
                    onsessioninitialized: id => sessions.set(`${resource}:${id}`, transport),
                    onsessionclosed     : id => sessions.delete(`${resource}:${id}`)
                });
                mcpServer = new McpServer({name: `${resource}-bridge-fixture`, version: '1.0.0'});
                mcpServer.registerTool('bridge_probe', {
                    description: `Return the ${resource} fixture identity.`,
                    inputSchema: {}
                }, async () => ({
                    content          : [{type: 'text', text: resource}],
                    structuredContent: {resource}
                }));
                mcpServers.add(mcpServer);
                transports.add(transport);
                await mcpServer.connect(transport)
            }

            await transport.handleRequest(request, response, request.body)
        })
    }

    const httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
        server.once('error', reject)
    });

    return {
        baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
        close  : async () => {
            await Promise.allSettled([...mcpServers].map(server => server.close()));
            await Promise.allSettled([...transports].map(transport => transport.close()));
            await new Promise(resolve => httpServer.close(resolve))
        },
        sessionCount: () => sessions.size
    }
}

function tenantTarget(endpoint='https://tenant.example.com/agentos') {
    return {
        kind            : 'tenant',
        credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN',
        resources       : {
            'memory-core'   : {url: `${endpoint}/mc/mcp`},
            'knowledge-base': {url: `${endpoint}/kb/mcp`}
        }
    }
}

function canonicalMcpMatrix(overrides={}) {
    return {
        'memory-core'    : true,
        'knowledge-base' : true,
        'neural-link'    : true,
        'github-workflow': false,
        'gitlab-workflow': false,
        ...overrides
    }
}

function logicalInput({harnessType='codex', mcpMatrix=canonicalMcpMatrix(), mcpTarget=null}={}) {
    return {
        agent: {id: 'agent-a', harnessType},
        mcpMatrix,
        mcpTarget
    }
}

function recursivelyFrozen(value) {
    if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;

    return Object.values(value).every(child =>
        !child || typeof child !== 'object' || recursivelyFrozen(child))
}

function collectStrings(value, result=[]) {
    if (typeof value === 'string') {
        result.push(value)
    } else if (Array.isArray(value)) {
        value.forEach(child => collectStrings(child, result))
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(child => collectStrings(child, result))
    }

    return result
}

function parseJsonc(content) {
    return JSON.parse(content.split(/\r?\n/).filter(line => !line.trimStart().startsWith('//')).join('\n'))
}

function tomlMcpTable(content, name) {
    const
        marker = `[mcp_servers."${name}"]`,
        start  = content.indexOf(marker),
        tail   = content.slice(start + marker.length),
        next   = tail.search(/\n\s*\[/);

    return start < 0 ? '' : marker + (next < 0 ? tail : tail.slice(0, next))
}

test.describe('managed workspace logical plan → host apply boundary', () => {
    test('the plan/apply composer has one production caller', async () => {
        const callers = [];

        for (const rootName of ['ai', 'src']) {
            for (const filePath of await sourceFiles(path.join(PROJECT_ROOT, rootName))) {
                if ((await read(filePath)).includes('prepareManagedAgentWorkspace.mjs')) {
                    callers.push(path.relative(PROJECT_ROOT, filePath))
                }
            }
        }

        expect(callers.sort()).toEqual(['ai/services/fleet/startAgentProvisioned.mjs'])
    });

    test('planner module loads and executes with filesystem, process, and config authority denied', () => {
        const
            moduleUrl = pathToFileURL(path.join(PROJECT_ROOT, 'ai/services/fleet/managedAgentWorkspacePlan.mjs')).href,
            loader    = `
                const denied = new Set(['fs', 'fs/promises', 'fs-extra', 'node:fs', 'node:fs/promises']);
                const configFiles = ['config.mjs', 'config.template.mjs', 'configBase.mjs', 'ConfigProvider.mjs'];

                export async function resolve(specifier, context, nextResolve) {
                    if (denied.has(specifier) || configFiles.some(name =>
                        specifier === name || specifier.endsWith('/' + name))) {
                        throw new Error('denied planner import: ' + specifier)
                    }
                    return nextResolve(specifier, context)
                }
            `,
            childScript = `
                import {register} from 'node:module';

                const realProcess = globalThis.process;
                register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(loader)}), import.meta.url);
                Object.defineProperty(globalThis, 'process', {
                    configurable: true,
                    get() {
                        throw new Error('denied planner process access')
                    }
                });
                for (const name of ['AiConfig', 'Config', 'Neo']) {
                    Object.defineProperty(globalThis, name, {
                        configurable: true,
                        get() {
                            throw new Error('denied planner global config access: ' + name)
                        }
                    })
                }

                const {createManagedAgentWorkspacePlan} = await import(${JSON.stringify(`${moduleUrl}?deny-authority=1`)});
                const plan = createManagedAgentWorkspacePlan({
                    agent: {id: 'deny-authority-seat', harnessType: 'codex'},
                    mcpMatrix: {
                        'memory-core': true,
                        'knowledge-base': true,
                        'neural-link': true,
                        'github-workflow': false,
                        'gitlab-workflow': false
                    }
                });

                realProcess.stdout.write(JSON.stringify({
                    artifactProfile: plan.artifactProfile,
                    frozen: Object.isFrozen(plan),
                    serverCount: plan.mcpServers.length
                }))
            `,
            result = spawnSync(NODE_PATH, ['--input-type=module', '--eval', childScript], {
                encoding: 'utf8'
            });

        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            artifactProfile: 'codex',
            frozen         : true,
            serverCount    : 5
        })
    });

    test('pure planning is deterministic, recursively frozen, closed, and path-free', () => {
        const
            input  = logicalInput({mcpTarget: tenantTarget()}),
            first  = createManagedAgentWorkspacePlan(input),
            second = createManagedAgentWorkspacePlan(structuredClone(input));

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(recursivelyFrozen(first)).toBe(true);
        expect(Object.keys(first)).toEqual(['agent', 'artifactProfile', 'mcpMatrix', 'mcpServers']);
        expect(Object.keys(first.agent)).toEqual(['id', 'harnessType']);
        expect(first.artifactProfile).toBe('codex');
        expect(first.mcpServers).toHaveLength(5);
        expect(Object.keys(first.mcpServers[0])).toEqual([
            'key',
            'name',
            'enabled',
            'target',
            'transport',
            'entrypoint',
            'url',
            'credentialEnvVar',
            'runtimeEnv',
            'requiredRuntimeEnv',
            'secretEnv'
        ]);
        expect(first.mcpServers.filter(server => server.target === 'tenant').map(server => server.key))
            .toEqual(['memory-core', 'knowledge-base']);
        expect(first.mcpServers.find(server => server.key === 'neural-link')).toMatchObject({
            target   : 'resident',
            transport: 'stdio',
            url      : null
        });
        expect(first.mcpServers.every(server => server.entrypoint && !path.isAbsolute(server.entrypoint))).toBe(true);
        expect(collectStrings(first).filter(value => !/^https?:/.test(value)).every(value => !path.isAbsolute(value))).toBe(true);
        expect(JSON.stringify(first)).not.toMatch(/"(?:args|command|cwd|agentosRuntimeRoot|targetRepoRoot|mainCheckout|repoPath|nodePath|owner|grant|authorization)"/);
    });

    test('planner rejects forbidden/unknown/absolute fields without evaluating effectful accessors', () => {
        const forbidden = [{
            name  : 'owner',
            mutate: input => { input.owner = '@someone' }
        }, {
            name  : 'nested targetRepoRoot',
            mutate: input => { input.agent.targetRepoRoot = '/tmp/repo' }
        }, {
            name  : 'legacy root alias',
            mutate: input => { input.agent.repoPath = '/tmp/legacy-repo' }
        }, {
            name  : 'bearer value',
            mutate: input => { input.mcpTarget = {...tenantTarget(), bearer: 'secret-value'} }
        }, {
            name  : 'authorization field',
            mutate: input => { input.mcpTarget = {...tenantTarget(), authorization: {grant: 'admin'}} }
        }, {
            name  : 'resource headers',
            mutate: input => {
                input.mcpTarget = tenantTarget();
                input.mcpTarget.resources['memory-core'].headers = {Authorization: 'Bearer secret'}
            }
        }, {
            name  : 'absolute opaque id',
            mutate: input => { input.agent.id = '/tmp/agent-a' }
        }];

        for (const entry of forbidden) {
            const input = logicalInput();

            entry.mutate(input);
            expect(() => createManagedAgentWorkspacePlan(input), entry.name).toThrow(TypeError)
        }

        const cyclic = logicalInput();
        cyclic.agent.loop = cyclic.agent;

        expect(() => createManagedAgentWorkspacePlan(cyclic)).toThrow(TypeError);

        for (const field of ['fileSystem', 'env', 'process', 'globalConfig']) {
            const input = logicalInput();
            let   reads = 0;

            Object.defineProperty(input, field, {
                enumerable: true,
                get() {
                    reads++;
                    throw new Error(`${field} getter was evaluated`)
                }
            });

            expect(() => createManagedAgentWorkspacePlan(input), field).toThrow(TypeError);
            expect(reads, field).toBe(0)
        }
    });

    test('unsupported harness, MCP, and transport combinations are RangeErrors', () => {
        expect(() => createManagedAgentWorkspacePlan(logicalInput({harnessType: 'unknown'}))).toThrow(RangeError);
        expect(() => createManagedAgentWorkspacePlan(logicalInput({harnessType: 'antigravity'}))).toThrow(RangeError);
        expect(() => createManagedAgentWorkspacePlan(logicalInput({
            mcpMatrix: canonicalMcpMatrix({'gitlab-workflow': true})
        }))).toThrow(RangeError);
        expect(() => createManagedAgentWorkspacePlan(logicalInput({
            harnessType: 'claude-desktop',
            mcpMatrix  : canonicalMcpMatrix({'github-workflow': true})
        }))).toThrow(RangeError);
    });

    test('the plan refuses an MCP declaration for exactly the reason the registry is told', () => {
        const declarations = [
            {harnessType: 'claude-desktop', mcpMatrix: canonicalMcpMatrix({'github-workflow': true}), tenant: false},
            {harnessType: 'codex',          mcpMatrix: canonicalMcpMatrix({'gitlab-workflow': true}), tenant: false},
            {harnessType: 'antigravity',    mcpMatrix: canonicalMcpMatrix(),                          tenant: true}
        ];

        for (const declaration of declarations) {
            const refusal = mcpDeclarationRefusal(declaration);

            expect(refusal, declaration.harnessType).toEqual(expect.any(String));
            expect(() => createManagedAgentWorkspacePlan(logicalInput({
                harnessType: declaration.harnessType,
                mcpMatrix  : declaration.mcpMatrix,
                mcpTarget  : declaration.tenant ? tenantTarget() : null
            })), declaration.harnessType).toThrow(`createManagedAgentWorkspacePlan: ${refusal}`)
        }

        expect(mcpDeclarationRefusal({harnessType: 'claude-desktop', mcpMatrix: canonicalMcpMatrix()})).toBeNull();
        expect(mcpDeclarationRefusal({harnessType: 'claude-code', mcpMatrix: canonicalMcpMatrix({'github-workflow': true}), tenant: true})).toBeNull()
    });

    test('host apply accepts a structural clone and records only the bounded effect vocabulary', async () => {
        const
            plan       = createManagedAgentWorkspacePlan(logicalInput()),
            operations = [],
            fileSystem = new Proxy(fs, {
                get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);

                    return typeof value !== 'function'
                        ? value
                        : async (...args) => {
                            operations.push(String(property));
                            return value.call(target, ...args)
                        }
                }
            });

        expect(operations).toEqual([]);

        const result = await applyManagedAgentWorkspacePlan({
            plan            : structuredClone(plan),
            targetRepoRoot  : path.join(repoRoot, 'direct-apply'),
            instanceRoot,
            agentosRuntimeRoot,
            nodePath        : NODE_PATH,
            hydrateWorkspace: async args => {
                operations.push('hydrateWorkspace');
                await fs.mkdir(args.projectRoot, {recursive: true});
                return {hydrated: true}
            },
            fileSystem
        });

        expect([...new Set(operations)].every(operation => BOUNDED_APPLY_EFFECTS.has(operation))).toBe(true);
        expect(operations).toContain('hydrateWorkspace');
        expect(operations).toContain('writeFile');
        expect(Object.keys(result)).toEqual([
            'agentosRuntimeRoot',
            'targetRepoRoot',
            'instanceHome',
            'mcpMatrix',
            'mcpPlan',
            'hydration',
            'artifacts',
            'seatInstructions'
        ]);
        expect(result.mcpPlan[0].args[0]).toBe(path.join(agentosRuntimeRoot, MCP_ENTRYPOINTS[0]));
        expect(path.isAbsolute(result.mcpPlan[0].args[0])).toBe(true);
        expect(result.agentosRuntimeRoot).toBe(agentosRuntimeRoot);
        expect(result.targetRepoRoot).toBe(path.join(repoRoot, 'direct-apply'));
        expect(result.mcpPlan.every(server => server.sourceRoot === agentosRuntimeRoot)).toBe(true);
        expect(result.mcpPlan.find(server => server.key === 'neural-link').args.slice(-2))
            .toEqual(['--cwd', agentosRuntimeRoot])
    });

    test('host apply requires both semantic roots and never falls back to legacy aliases', async () => {
        const
            plan    = createManagedAgentWorkspacePlan(logicalInput()),
            hydrate = makeHydrate(),
            base    = {plan, instanceRoot, nodePath: NODE_PATH, hydrateWorkspace: hydrate};

        await expect(applyManagedAgentWorkspacePlan({
            ...base,
            targetRepoRoot: path.join(repoRoot, 'missing-runtime')
        })).rejects.toThrow(/agentosRuntimeRoot/);

        await expect(applyManagedAgentWorkspacePlan({
            ...base,
            agentosRuntimeRoot
        })).rejects.toThrow(/targetRepoRoot/);

        await expect(applyManagedAgentWorkspacePlan({
            ...base,
            mainCheckout: agentosRuntimeRoot,
            repoPath    : path.join(repoRoot, 'legacy-only')
        })).rejects.toThrow(/targetRepoRoot/);

        expect(hydrationCalls).toEqual([])
    });

    test('host apply rejects projection drift while accepting a coherent clone without proving provenance', async () => {
        const
            plan           = createManagedAgentWorkspacePlan(logicalInput()),
            divergentPlan  = structuredClone(plan),
            coherentPlan   = structuredClone(plan),
            hydrationCalls = [];

        divergentPlan.mcpServers.find(server => server.key === 'memory-core').transport = 'streamable-http';

        await expect(applyManagedAgentWorkspacePlan({
            plan            : divergentPlan,
            targetRepoRoot  : path.join(repoRoot, 'divergent-plan'),
            instanceRoot,
            agentosRuntimeRoot,
            nodePath        : NODE_PATH,
            hydrateWorkspace: async args => {
                hydrationCalls.push(args);
                return {hydrated: true}
            }
        })).rejects.toThrow(
            'host apply rejected its logical plan (applyManagedAgentWorkspacePlan: plan does not match the canonical logical projection.)'
        );
        expect(hydrationCalls).toEqual([]);

        // This gate proves coherence with the plan's OWN logical inputs, not that a registry
        // authorized them. Cross-process provenance belongs to the later signed envelope.
        coherentPlan.mcpMatrix['memory-core'] = false;
        coherentPlan.mcpServers.find(server => server.key === 'memory-core').enabled = false;

        const result = await applyManagedAgentWorkspacePlan({
            plan            : coherentPlan,
            targetRepoRoot  : path.join(repoRoot, 'coherent-plan'),
            instanceRoot,
            agentosRuntimeRoot,
            nodePath        : NODE_PATH,
            hydrateWorkspace: makeHydrate()
        });

        expect(result.mcpMatrix['memory-core']).toBe(false);
        expect(result.mcpPlan.find(server => server.key === 'memory-core').enabled).toBe(false)
    });

    test('invalid host input is normalized and a completed artifact converges after a mid-apply failure', async () => {
        const
            plan           = createManagedAgentWorkspacePlan(logicalInput()),
            badPlan        = structuredClone(plan),
            targetRepoRoot = path.join(repoRoot, 'partial-apply');

        badPlan.agent.id = '/tmp/escaped-agent';

        await expect(applyManagedAgentWorkspacePlan({
            plan            : badPlan,
            targetRepoRoot,
            instanceRoot,
            agentosRuntimeRoot,
            nodePath        : NODE_PATH,
            hydrateWorkspace: makeHydrate()
        })).rejects.toBeInstanceOf(ManagedWorkspacePreparationError);
        expect(hydrationCalls).toEqual([]);

        let   writes            = 0;
        const failingFileSystem = new Proxy(fs, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);

                if (property !== 'writeFile') return typeof value === 'function' ? value.bind(target) : value;

                return async (...args) => {
                    writes++;
                    if (writes === 2) throw Object.assign(new Error('injected mid-apply failure'), {code: 'EIO'});
                    return value.call(target, ...args)
                }
            }
        });
        const applyOptions = {
            plan,
            targetRepoRoot,
            instanceRoot,
            agentosRuntimeRoot,
            nodePath        : NODE_PATH,
            hydrateWorkspace: makeHydrate()
        };

        await expect(applyManagedAgentWorkspacePlan({...applyOptions, fileSystem: failingFileSystem}))
            .rejects.toBeInstanceOf(ManagedWorkspacePreparationError);
        expect(await read(path.join(targetRepoRoot, '.codex', 'config.toml'))).toContain('neo-mjs-memory-core');

        const retry = await applyManagedAgentWorkspacePlan(applyOptions);

        expect(retry.artifacts.map(item => item.status)).toEqual([
            WORKSPACE_ARTIFACT_STATES.MATCH,
            WORKSPACE_ARTIFACT_STATES.CREATED,
            WORKSPACE_ARTIFACT_STATES.CREATED
        ])
    });

    test('plan/apply composer resolves once before entering one host apply sequence', async () => {
        const
            events = [],
            agent  = makeAgent('codex'),
            result = await prepareManagedAgentWorkspace({
                ...options(agent, 'compatibility-composer'),
                resolveMatrix(overrides) {
                    events.push('resolve');
                    expect(overrides).toBe(agent.mcpServers);
                    return canonicalMcpMatrix()
                },
                deriveInstanceHome({instanceRoot: rootPath, agentId, harnessType}) {
                    events.push('apply:derive');
                    return path.join(rootPath, agentId, harnessType)
                },
                hydrateWorkspace: async args => {
                    events.push('apply:hydrate');
                    await fs.mkdir(args.projectRoot, {recursive: true});
                    return {hydrated: true}
                }
            });

        expect(events).toEqual(['resolve', 'apply:derive', 'apply:hydrate']);
        expect(Object.keys(result)).toEqual([
            'agentosRuntimeRoot',
            'targetRepoRoot',
            'instanceHome',
            'mcpMatrix',
            'mcpPlan',
            'hydration',
            'artifacts',
            'seatInstructions'
        ])
    });
});

test.describe('prepareManagedAgentWorkspace', () => {
    test('Node execution mode belongs only to the selected Electron executable', () => {
        const runtime = {execPath: '/app/Electron', versions: {electron: '43.5.0'}};

        expect(deriveNodeRuntimeEnv('/app/Electron', runtime)).toEqual({ELECTRON_RUN_AS_NODE: '1'});
        expect(deriveNodeRuntimeEnv('/usr/local/bin/node', runtime)).toEqual({});
        expect(deriveNodeRuntimeEnv('/app/Electron', {...runtime, versions: {}})).toEqual({});
    });

    for (const harnessType of ['codex', 'codex-desktop', 'claude-code', 'claude-desktop', 'kimi-code', 'opencode']) {
        test(`${harnessType}: upgrade the exact prior MCP runtime without changing login files`, async () => {
            const opts = {
                ...options(makeAgent(harnessType)),
                runtime: {execPath: NODE_PATH, versions: {}}
            };
            const first      = await prepareManagedAgentWorkspace(opts);
            const configPath = {
                codex           : path.join(opts.targetRepoRoot, '.codex/config.toml'),
                'codex-desktop' : path.join(opts.targetRepoRoot, '.codex/config.toml'),
                'claude-code'   : path.join(first.instanceHome, 'mcp-config.json'),
                'claude-desktop': path.join(first.instanceHome, 'claude_desktop_config.json'),
                'kimi-code'     : path.join(opts.targetRepoRoot, '.kimi-code/mcp.json'),
                opencode        : path.join(opts.targetRepoRoot, 'opencode.jsonc')
            }[harnessType];
            const before     = await read(configPath);
            const authPath   = path.join(first.instanceHome, 'auth.json');
            const parentMode = process.env.ELECTRON_RUN_AS_NODE;

            await fs.writeFile(authPath, 'resident login bytes\n');
            expect(before).not.toContain('ELECTRON_RUN_AS_NODE');
            opts.runtime.versions.electron = '43.5.0';

            const upgraded = await prepareManagedAgentWorkspace(opts);
            expect(await read(configPath)).toContain('ELECTRON_RUN_AS_NODE');
            expect(upgraded.artifacts.find(item => item.path === configPath).status).toBe(WORKSPACE_ARTIFACT_STATES.UPDATED);
            expect(await read(authPath)).toBe('resident login bytes\n');
            expect(process.env.ELECTRON_RUN_AS_NODE).toBe(parentMode);
            expect((await prepareManagedAgentWorkspace(opts)).artifacts.every(item => item.status === WORKSPACE_ARTIFACT_STATES.MATCH)).toBe(true);

            await fs.writeFile(configPath, before.replaceAll(NODE_PATH, '/edited/node'));
            await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({code: 'FLEET_WORKSPACE_DIVERGENT'});
        });
    }

    test('Electron MCP upgrade preserves remote endpoints, resident TOML and nested Codex login', async () => {
        const opts       = {...options(makeAgent('codex-desktop')), mcpTarget: tenantTarget(), runtime: {execPath: NODE_PATH, versions: {}}};
        const first      = await prepareManagedAgentWorkspace(opts);
        const configPath = path.join(opts.targetRepoRoot, '.codex/config.toml');
        const resident   = '\n[resident]\nkeep = "owned by the peer"\n';
        const authPath   = path.join(first.instanceHome, 'codex-home/auth.json');

        await fs.writeFile(configPath, await read(configPath) + resident);
        await fs.writeFile(authPath, 'private login fixture\n');
        opts.runtime.versions.electron = '43.5.0';
        await prepareManagedAgentWorkspace(opts);

        const result = await read(configPath);
        expect(result).toContain(resident);
        expect(result).toContain('https://tenant.example.com/agentos/mc/mcp');
        expect(result.match(/ELECTRON_RUN_AS_NODE/g)).toHaveLength(3);
        expect(await read(authPath)).toBe('private login fixture\n');

        opts.mcpTarget = null;
        await prepareManagedAgentWorkspace(opts);
        expect((await read(configPath)).match(/ELECTRON_RUN_AS_NODE/g)).toHaveLength(5);
        opts.mcpTarget = tenantTarget();
        await prepareManagedAgentWorkspace(opts);
        expect((await read(configPath)).match(/ELECTRON_RUN_AS_NODE/g)).toHaveLength(3);
    });

    test('installed Codex parser and Electron execute the generated MCP command', async () => {
        test.skip(!process.versions.electron || !process.env.NEO_TEST_CODEX_BIN,
            'Requires the packaged Electron runtime and an installed Codex CLI.');

        const entry = path.join(agentosRuntimeRoot, MCP_ENTRYPOINTS[2]);
        await fs.writeFile(entry, [
            `import {McpServer} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};`,
            `import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};`,
            'const server = new McpServer({name: "runtime-probe", version: "1.0.0"});',
            'server.registerTool("runtime_probe", {inputSchema: {}}, async () => ({content: [{type: "text", text: JSON.stringify({electron: process.versions.electron, mode: process.env.ELECTRON_RUN_AS_NODE})}]}));',
            'await server.connect(new StdioServerTransport());'
        ].join('\n'));

        const opts       = {...options(makeAgent('codex-desktop')), mcpTarget: tenantTarget()};
        const result     = await prepareManagedAgentWorkspace(opts);
        const homePath   = path.join(result.instanceHome, 'codex-home', 'config.toml');
        const nativeHome = (await read(homePath)).replace(
            '# Fleet-managed remote MCP project trust begin\n',
            '# Fleet-managed remote MCP project trust begin\n' +
            'notify = ["/fixture/native-notify", "turn-ended"]\nmodel = "gpt-6-astra"\n' +
            'model_reasoning_effort = "ultra"\n\n'
        );
        await fs.writeFile(homePath, nativeHome);
        await prepareManagedAgentWorkspace(opts);
        expect(await read(homePath)).toBe(nativeHome);
        const listed = spawnSync(process.env.NEO_TEST_CODEX_BIN, ['mcp', 'list', '--json'], {
            cwd     : opts.targetRepoRoot,
            env     : {PATH: process.env.PATH, CODEX_HOME: path.join(result.instanceHome, 'codex-home')},
            encoding: 'utf8',
            timeout : 10000
        });
        expect(listed.status, listed.stderr).toBe(0);
        const row = JSON.parse(listed.stdout).find(item => item.name === 'neo-mjs-neural-link');
        expect(row.transport.env).toEqual({ELECTRON_RUN_AS_NODE: '1'});

        const transport = new StdioClientTransport({
            command: row.transport.command,
            args   : row.transport.args,
            env    : row.transport.env,
            cwd    : opts.targetRepoRoot,
            stderr : 'pipe'
        });
        const client = new Client({name: 'runtime-proof', version: '1.0.0'});
        try {
            await client.connect(transport);
            const response = await client.callTool({name: 'runtime_probe', arguments: {}});
            expect(JSON.parse(response.content[0].text)).toEqual({electron: process.versions.electron, mode: '1'});
        } finally {
            await client.close();
        }
    });

    for (const harnessType of ['codex', 'codex-desktop']) {
        test(`${harnessType}: context defaults come only from the selected repository`, async () => {
            const opts         = options(makeAgent(harnessType));
            const templatePath = path.join(opts.targetRepoRoot, '.codex', 'config.template.toml');
            await fs.mkdir(path.dirname(templatePath), {recursive: true});
            await fs.writeFile(templatePath, [
                '"model_context_window" = 1000000',
                'model_auto_compact_token_limit = 850000',
                'model = "not-copied"',
                'model_max_output_tokens = 128000',
                'approval_policy = "never"',
                'notes = """',
                'model_context_window = 42',
                '"""',
                '[sandbox_workspace_write]',
                'network_access = true',
                '[nested]',
                'model_context_window = 99'
            ].join('\n'));
            await fs.mkdir(path.join(agentosRuntimeRoot, '.codex'), {recursive: true});
            await fs.writeFile(path.join(agentosRuntimeRoot, '.codex', 'config.template.toml'), 'model_context_window = 7\n');

            const prepared = await prepareManagedAgentWorkspace(opts);
            const config   = await read(path.join(opts.targetRepoRoot, '.codex', 'config.toml'));
            expect(config).toContain('model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n');
            expect(config).not.toMatch(/not-copied|model_max_output_tokens|approval_policy|network_access|notes|\[nested\]/);
            expect(prepared.artifacts[0].status).toBe(WORKSPACE_ARTIFACT_STATES.CREATED);
        });

        for (const scope of ['project', 'home']) {
            for (const key of ['model_context_window', 'model_auto_compact_token_limit']) {
                test(`${harnessType}: one explicit ${scope} ${key} preserves the resident policy`, async () => {
                    const opts        = options(makeAgent(harnessType));
                    const prepared    = await prepareManagedAgentWorkspace(opts);
                    const projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml');
                    const homePath    = path.join(prepared.instanceHome, ...(harnessType === 'codex-desktop' ? ['codex-home'] : []), 'config.toml');
                    const policyPath  = scope === 'project' ? projectPath : homePath;
                    await fs.writeFile(policyPath, `"${key}" = 123456\n` + await read(policyPath));
                    const projectBefore = await read(projectPath);
                    const homeBefore    = await read(homePath);
                    await fs.writeFile(path.join(opts.targetRepoRoot, '.codex', 'config.template.toml'),
                        'model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n');

                    const repeated = await prepareManagedAgentWorkspace(opts);
                    expect(await read(projectPath)).toBe(projectBefore);
                    expect(await read(homePath)).toBe(homeBefore);
                    expect(repeated.artifacts.every(artifact => artifact.status === WORKSPACE_ARTIFACT_STATES.MATCH)).toBe(true);
                });
            }
        }
    }

    test('Codex context seeding upgrades MCP-only output once and preserves resident text and login', async () => {
        const opts         = options(makeAgent('codex-desktop'));
        const prepared     = await prepareManagedAgentWorkspace(opts);
        const projectPath  = path.join(opts.targetRepoRoot, '.codex', 'config.toml');
        const homePath     = path.join(prepared.instanceHome, 'codex-home', 'config.toml');
        const authPath     = path.join(prepared.instanceHome, 'codex-home', 'auth.json');
        const templatePath = path.join(opts.targetRepoRoot, '.codex', 'config.template.toml');
        const resident     = '# retain this comment\nnotes = """\nmodel_context_window = 42\n"""\n';
        const original     = resident + await read(projectPath) + '\n[custom]\nmodel_context_window = 17\n';
        const homeBefore   = await read(homePath);
        await fs.writeFile(projectPath, original);
        await fs.writeFile(authPath, '{"fixture":"login-preserved"}\n');
        await fs.writeFile(templatePath, 'model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n');

        const upgraded = await prepareManagedAgentWorkspace(opts);
        const after    = await read(projectPath);
        expect(upgraded.artifacts[0].status).toBe(WORKSPACE_ARTIFACT_STATES.UPDATED);
        expect(after).toContain('model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n');
        expect(after.endsWith(original)).toBe(true);
        expect(await read(homePath)).toBe(homeBefore);
        expect(await read(authPath)).toBe('{"fixture":"login-preserved"}\n');

        await fs.writeFile(templatePath, 'model_context_window = "later-invalid-policy"\n');
        const repeated = await prepareManagedAgentWorkspace(opts);
        expect(await read(projectPath)).toBe(after);
        expect(repeated.artifacts[0].status).toBe(WORKSPACE_ARTIFACT_STATES.MATCH);
    });

    test('Codex context seeding ignores nested keys and literal-string lookalikes', async () => {
        const opts = options(makeAgent('codex'));
        await fs.mkdir(path.join(opts.targetRepoRoot, '.codex'), {recursive: true});
        await fs.writeFile(path.join(opts.targetRepoRoot, '.codex', 'config.template.toml'), [
            "notes = '''",
            'model_context_window = 1000000',
            "'''",
            '[profile]',
            'model_auto_compact_token_limit = 850000'
        ].join('\n'));
        await prepareManagedAgentWorkspace(opts);
        const config = await read(path.join(opts.targetRepoRoot, '.codex', 'config.toml'));
        expect(config).not.toMatch(/model_context_window|model_auto_compact_token_limit/);
    });

    test('Codex context seeding accepts a template with only one supported default', async () => {
        const opts = options(makeAgent('codex'));
        await fs.mkdir(path.join(opts.targetRepoRoot, '.codex'), {recursive: true});
        await fs.writeFile(path.join(opts.targetRepoRoot, '.codex', 'config.template.toml'), 'model_context_window = 800000\n');
        await prepareManagedAgentWorkspace(opts);
        const config = await read(path.join(opts.targetRepoRoot, '.codex', 'config.toml'));
        expect(config).toContain('model_context_window = 800000\n');
        expect(config).not.toContain('model_auto_compact_token_limit');
    });

    for (const value of ['"secret-invalid-value"', '0', '-1', '1.5', '99999999999999999999', '[invalid-secret']) {
        test(`Codex context seeding refuses malformed policy ${value} without exposing its content`, async () => {
            const opts         = options(makeAgent('codex'));
            const templatePath = path.join(opts.targetRepoRoot, '.codex', 'config.template.toml');
            await fs.mkdir(path.dirname(templatePath), {recursive: true});
            await fs.writeFile(templatePath, `model_context_window = ${value}\n`);
            const failure = await prepareManagedAgentWorkspace(opts).catch(error => error);
            expect(failure).toBeInstanceOf(ManagedWorkspacePreparationError);
            expect(failure.message).toContain(templatePath);
            expect(failure.message).not.toContain('secret');
            await expect(fs.stat(path.join(opts.targetRepoRoot, '.codex', 'config.toml'))).rejects.toMatchObject({code: 'ENOENT'});
        });
    }

    test('Codex context seeding refuses a symlinked repository template', async () => {
        const opts = options(makeAgent('codex'));
        await fs.mkdir(path.join(opts.targetRepoRoot, '.codex'), {recursive: true});
        const outside = path.join(repoRoot, 'other-policy.toml');
        await fs.writeFile(outside, 'model_context_window = 1000000\n');
        await fs.symlink(outside, path.join(opts.targetRepoRoot, '.codex', 'config.template.toml'));
        await expect(prepareManagedAgentWorkspace(opts)).rejects.toThrow(/symlinked/);
    });

    test('Codex: template-free runtime → project MCP projection + isolated home policy, all CREATED', async () => {
        const
            opts              = options(makeAgent('codex')),
            result            = await prepareManagedAgentWorkspace(opts),
            projectConfigPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml'),
            homeConfigPath    = path.join(result.instanceHome, 'config.toml'),
            memoriesPath      = path.join(result.instanceHome, 'memories'),
            projectConfig     = await read(projectConfigPath),
            homeConfig        = await read(homeConfigPath);

        expect(hydrationCalls).toHaveLength(1);
        expect(hydrationCalls[0]).toMatchObject({mainCheckout: agentosRuntimeRoot, projectRoot: opts.targetRepoRoot});
        expect(result.agentosRuntimeRoot).toBe(agentosRuntimeRoot);
        expect(result.targetRepoRoot).toBe(opts.targetRepoRoot);
        expect(result.hydration).toEqual({hydrated: true});
        expect(result.mcpPlan).toHaveLength(5);
        expect(result.mcpPlan.map(server => server.key)).toEqual([
            'memory-core',
            'knowledge-base',
            'neural-link',
            'github-workflow',
            'gitlab-workflow'
        ]);
        expect(result.mcpPlan.every(server =>
            Array.isArray(server.args) &&
            Array.isArray(server.runtimeEnv) &&
            Array.isArray(server.requiredRuntimeEnv) &&
            Array.isArray(server.secretEnv) &&
            server.target === 'resident' &&
            server.transport === 'stdio'
        )).toBe(true);
        expect(result.artifacts.map(item => item.status)).toEqual([
            WORKSPACE_ARTIFACT_STATES.CREATED,
            WORKSPACE_ARTIFACT_STATES.CREATED,
            WORKSPACE_ARTIFACT_STATES.CREATED
        ]);

        // Fresh target clones have no dependencies: every executable and Neural Link's package cwd
        // come from AgentOS, while project artifacts remain under the target repository.
        expect(projectConfig).toContain(`command = ${JSON.stringify(NODE_PATH)}`);
        expect(projectConfig).toContain(path.join(agentosRuntimeRoot, 'ai/mcp/server/memory-core/mcp-server.mjs'));
        expect(projectConfig).toContain(JSON.stringify(['--cwd', agentosRuntimeRoot]).slice(1, -1));
        expect(projectConfig).not.toContain('command = "npm"');
        await expect(fs.stat(path.join(opts.targetRepoRoot, 'node_modules'))).rejects.toMatchObject({code: 'ENOENT'});

        // All catalog keys are projected from current defaults. Only the switched-off optional workflows
        // say so; the switched-on servers carry no `enabled`, so the seat's own switch decides.
        expect(projectConfig.match(/^\[mcp_servers\."[^"]+"\]$|^enabled\s*=.*$/gm)).toEqual([
            '[mcp_servers."neo-mjs-memory-core"]',
            '[mcp_servers."neo-mjs-knowledge-base"]',
            '[mcp_servers."neo-mjs-neural-link"]',
            '[mcp_servers."neo-mjs-github-workflow"]',
            'enabled = false',
            '[mcp_servers."neo-mjs-gitlab-workflow"]',
            'enabled = false'
        ]);
        expect(homeConfig).toContain('cli_auth_credentials_store = "file"');
        expect(homeConfig).toContain('mcp_oauth_credentials_store = "file"');
        expect(homeConfig).not.toContain(`[projects.${JSON.stringify(opts.targetRepoRoot)}]`);
        expect(homeConfig).not.toContain('trust_level = "trusted"');
        expect(homeConfig).toBe([
            '# Fleet-owned Codex home policy. Authentication material itself is created by Codex login, never by Fleet.',
            'cli_auth_credentials_store = "file"',
            'mcp_oauth_credentials_store = "file"',
            '',
            '[features]',
            'memories = true',
            ''
        ].join('\n'));
        expect(homeConfig).toContain('memories = true');
        expect((await fs.stat(memoriesPath)).isDirectory()).toBe(true);
        expect((await fs.stat(homeConfigPath)).mode & 0o777).toBe(0o600);
    });

    test('re-entry reports MATCH and ignores unrelated operator-owned TOML tables/keys', async () => {
        const opts        = options(makeAgent('codex'));
        const first       = await prepareManagedAgentWorkspace(opts);
        const projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml');
        const homePath    = path.join(first.instanceHome, 'config.toml');

        const residentProject = 'project_doc_max_bytes = 131072\n' + await read(projectPath) +
            '\n[mcp_servers."operator-local"]\ncommand = "custom"\n\n[features]\nhooks = true\n';
        await fs.writeFile(projectPath, residentProject, 'utf8');
        await fs.appendFile(homePath, '\n[operator]\nkeep = true\n', 'utf8');

        const second = await prepareManagedAgentWorkspace(opts);

        expect(second.artifacts.map(item => item.status)).toEqual([
            WORKSPACE_ARTIFACT_STATES.MATCH,
            WORKSPACE_ARTIFACT_STATES.MATCH,
            WORKSPACE_ARTIFACT_STATES.MATCH
        ]);
        expect(await read(projectPath)).toBe(residentProject);
        expect(await read(homePath)).toContain('[operator]');
    });

    test('divergent owned content refuses without overwrite and exposes only bounded metadata', async () => {
        const opts      = options(makeAgent('codex'));
        const first     = await prepareManagedAgentWorkspace(opts);
        const homePath  = path.join(first.instanceHome, 'config.toml');
        const divergent = (await read(homePath)).replace('memories = true', 'memories = false');

        await fs.writeFile(homePath, divergent, 'utf8');

        let error;
        try {
            await prepareManagedAgentWorkspace(opts);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(ManagedWorkspacePreparationError);
        expect(error.code).toBe('FLEET_WORKSPACE_DIVERGENT');
        expect(error.artifact).toMatchObject({
            path     : homePath,
            status   : WORKSPACE_ARTIFACT_STATES.DIVERGENT,
            ownedKeys: 'cli_auth_credentials_store,mcp_oauth_credentials_store,features.memories'
        });
        expect(error.artifact).not.toHaveProperty('actual');
        expect(error.artifact).not.toHaveProperty('desired');
        expect(await read(homePath)).toBe(divergent);
    });

    test('two residents sharing one GitHub identity have disjoint Codex auth/memory homes', async () => {
        const
            a = await prepareManagedAgentWorkspace(options(makeAgent('codex', {id: 'resident-a'}))),
            b = await prepareManagedAgentWorkspace(options(makeAgent('codex', {id: 'resident-b'})));

        expect(a.instanceHome).not.toBe(b.instanceHome);
        expect(path.join(a.instanceHome, 'config.toml')).not.toBe(path.join(b.instanceHome, 'config.toml'));
        expect(path.join(a.instanceHome, 'memories')).not.toBe(path.join(b.instanceHome, 'memories'));
        expect((await fs.stat(path.join(a.instanceHome, 'memories'))).isDirectory()).toBe(true);
        expect((await fs.stat(path.join(b.instanceHome, 'memories'))).isDirectory()).toBe(true);
    });

    for (const harness of ['codex', 'codex-desktop']) {
        test(`${harness}: remote trust re-entry preserves native settings inside Fleet comments`, async () => {
            const opts = options(makeAgent(harness));
            opts.mcpTarget = tenantTarget();

            const first      = await prepareManagedAgentWorkspace(opts);
            const home       = harness === 'codex' ? first.instanceHome : path.join(first.instanceHome, 'codex-home');
            const homePath   = path.join(home, 'config.toml');
            const authPath   = path.join(home, 'auth.json');
            const nativeHome = (await read(homePath)).replace(
                '# Fleet-managed remote MCP project trust begin\n',
                '# Fleet-managed remote MCP project trust begin\n' +
                'notify = ["/fixture/native-notify", "turn-ended"]\n' +
                'model = "resident-model"\nmodel_reasoning_effort = "ultra"\n\n'
            );
            const authentication = '{"fixture": "resident login stays untouched"}\n';

            await fs.writeFile(homePath, nativeHome);
            await fs.writeFile(authPath, authentication);
            const second = await prepareManagedAgentWorkspace(opts);

            expect(second.artifacts.every(item => item.status === WORKSPACE_ARTIFACT_STATES.MATCH)).toBe(true);
            expect(await read(homePath)).toBe(nativeHome);
            expect(await read(authPath)).toBe(authentication);

            const equivalent = nativeHome.replace('trust_level = "trusted"', "trust_level = 'trusted' # native spelling");
            await fs.writeFile(homePath, equivalent);
            await prepareManagedAgentWorkspace(opts);
            expect(await read(homePath)).toBe(equivalent);

            opts.mcpTarget = null;
            await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({code: 'FLEET_WORKSPACE_DIVERGENT'});
            expect(await read(homePath)).toBe(equivalent);
            expect(await read(authPath)).toBe(authentication);
        });
    }

    for (const [name, mutate] of [
        ['missing target trust', source => source.replace('trust_level = "trusted"', '# removed by resident')],
        ['wrong target', source => source.replace('[projects.', '[other_projects.')],
        ['invalid TOML', source => 'resident_secret = "unterminated\n' + source],
        ['missing end marker', source => source.replace('# Fleet-managed remote MCP project trust end', '')],
        ['orphan end marker', source => source.replace('# Fleet-managed remote MCP project trust begin', '')],
        ['duplicate end marker', source => source + '\n# Fleet-managed remote MCP project trust end\n']
    ]) {
        test(`remote trust re-entry refuses ${name} without exposing or overwriting content`, async () => {
            const opts = options(makeAgent('codex-desktop'));
            opts.mcpTarget = tenantTarget();
            const first    = await prepareManagedAgentWorkspace(opts);
            const homePath = path.join(first.instanceHome, 'codex-home', 'config.toml');
            const invalid  = mutate(await read(homePath));
            await fs.writeFile(homePath, invalid);

            let error;
            try {
                await prepareManagedAgentWorkspace(opts);
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(ManagedWorkspacePreparationError);
            expect(error.code).toBe('FLEET_WORKSPACE_DIVERGENT');
            expect(error.artifact.ownedKeys).toBe(name === 'invalid TOML' ? 'Codex context policy' : 'projects.<managed-repo>.trust_level');
            expect(JSON.stringify(error)).not.toContain('resident_secret');
            expect(error.message).not.toContain('resident_secret');
            expect(await read(homePath)).toBe(invalid);
        });
    }

    test('a remote Codex home refuses a managed-project trust downgrade instead of silently ignoring its generated MCP config', async () => {
        const opts = options(makeAgent('codex'));

        opts.mcpTarget = tenantTarget();

        const
            first      = await prepareManagedAgentWorkspace(opts),
            homePath   = path.join(first.instanceHome, 'config.toml'),
            downgraded = (await read(homePath)).replace('trust_level = "trusted"', 'trust_level = "untrusted"');

        await fs.writeFile(homePath, downgraded, 'utf8');

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {
                path     : homePath,
                ownedKeys: 'projects.<managed-repo>.trust_level'
            }
        });
        expect(await read(homePath)).toBe(downgraded);
    });

    test('Codex Desktop: template-free runtime keeps auth/memory policy inside the nested codex-home', async () => {
        const
            opts     = options(makeAgent('codex-desktop')),
            result   = await prepareManagedAgentWorkspace(opts),
            authHome = path.join(result.instanceHome, 'codex-home');

        expect(await read(path.join(authHome, 'config.toml'))).toContain('features');
        expect((await read(path.join(opts.targetRepoRoot, '.codex', 'config.toml'))).match(/^\[mcp_servers\./gm)).toHaveLength(5);
        expect((await fs.stat(path.join(authHome, 'memories'))).isDirectory()).toBe(true);
        await expect(fs.stat(path.join(result.instanceHome, 'config.toml'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('a switch the Codex app writes into the seat\'s home survives the next Start untouched', async () => {
        const
            opts        = options(makeAgent('codex-desktop')),
            result      = await prepareManagedAgentWorkspace(opts),
            homePath    = path.join(result.instanceHome, 'codex-home', 'config.toml'),
            projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml'),
            project     = await read(projectPath),
            // What the app's switch writes (`config/value/write`, user layer): Neural Link off.
            switched    = await read(homePath) + '\n[mcp_servers."neo-mjs-neural-link"]\nenabled = false\n';

        await fs.writeFile(homePath, switched);

        const again = await prepareManagedAgentWorkspace(opts);

        expect(await read(homePath)).toBe(switched);
        expect(await read(projectPath)).toBe(project);
        expect(again.artifacts.every(item => item.status === WORKSPACE_ARTIFACT_STATES.MATCH)).toBe(true);
    });

    test('a cockpit change of the MCP matrix lands at the next Start instead of reading as divergence', async () => {
        const
            opts        = options(makeAgent('codex')),
            projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml'),
            switches    = async () => (await read(projectPath)).match(/^\[mcp_servers\."[^"]+"\]$|^enabled = false$/gm).join(' ');

        await prepareManagedAgentWorkspace(opts);

        opts.agent = makeAgent('codex', {mcpServers: {'github-workflow': true}});
        const on = await prepareManagedAgentWorkspace(opts);

        expect(on.artifacts[0].status).toBe(WORKSPACE_ARTIFACT_STATES.UPDATED);
        expect(await switches()).not.toMatch(/github-workflow"\] enabled = false/);
        expect(await switches()).toMatch(/gitlab-workflow"\] enabled = false/);

        opts.agent = makeAgent('codex');
        await prepareManagedAgentWorkspace(opts);

        expect(await switches()).toMatch(/github-workflow"\] enabled = false/);
    });

    test('a seat an earlier Fleet rendered with project `enabled` lines migrates in one Start, its receipt included', async () => {
        const
            opts        = {...options(makeAgent('codex-desktop')), mcpTarget: tenantTarget()},
            first       = await prepareManagedAgentWorkspace(opts),
            projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml'),
            homePath    = path.join(first.instanceHome, 'codex-home', 'config.toml'),
            receiptPath = path.join(first.instanceHome, '.neo-fleet-mcp-transport.json'),
            tableBody   = (source, name) => {
                const lines = source.split('\n'), start = lines.indexOf(`[mcp_servers."${name}"]`);
                let   end   = start + 1;

                while (end < lines.length && !lines[end].startsWith('[')) end++;

                return lines.slice(start, end).join('\n').trim()
            },
            // The receipt contract: sha256 over the canonical JSON of the Memory Core and Knowledge Base tables.
            transportHash = source => crypto.createHash('sha256').update(JSON.stringify({
                'neo-mjs-knowledge-base': tableBody(source, 'neo-mjs-knowledge-base'),
                'neo-mjs-memory-core'   : tableBody(source, 'neo-mjs-memory-core')
            })).digest('hex');

        expect(JSON.parse(await read(receiptPath)).projectionSha256, 'the hash helper reproduces the receipt')
            .toBe(transportHash(await read(projectPath)));

        // The previous rendering: the old header, and `enabled = true` closing every switched-on table.
        let table = null;
        const previous = (await read(projectPath)).split('\n').map(line => {
            const header = line.match(/^\[mcp_servers\."(neo-mjs-[^"]+)"\]$/);

            table = header ? header[1] : line.startsWith('[') ? null : table;

            return table && !table.endsWith('-workflow') && line === 'tool_timeout_sec = 120' ? `${line}\nenabled = true` : line
        }).join('\n').replace(
            /^# Fleet-managed Neo MCP tables: .*$/m,
            '# Fleet-managed Neo MCP tables: executable paths come from the installed canonical checkout; cwd/project paths stay bound to this prepared resident checkout; enabled values are the current Brain projection.'
        );

        await fs.writeFile(projectPath, previous);
        await fs.writeFile(receiptPath, JSON.stringify({version: 1, adapter: 'codex-desktop', artifact: 'config.toml', projectionSha256: transportHash(previous)}));

        const home = await read(homePath);

        // The same Start also moves the tenant, so the receipt has to authenticate the converged tables.
        opts.mcpTarget = tenantTarget('https://tenant-b.example.com/agentos');
        await prepareManagedAgentWorkspace(opts);

        const project = await read(projectPath);

        expect(project.match(/^enabled\s*=.*$/gm)).toEqual(['enabled = false', 'enabled = false']);
        expect(project).toContain('`enabled = false` marks a server the Fleet switches off');
        expect(project).toContain('https://tenant-b.example.com/agentos/mc/mcp');
        expect(await read(homePath), 'the Fleet never writes a switch into the home').toBe(home);
        expect(JSON.parse(await read(receiptPath)).projectionSha256).toBe(transportHash(project));
    });

    test('the installed Codex parser reads each server\'s state from the seat\'s home', async () => {
        test.skip(!process.env.NEO_TEST_CODEX_BIN, 'Requires an installed Codex CLI.');

        const
            // Codex trusts a project by its canonical path; the temp root may sit behind a symlink.
            opts     = {...options(makeAgent('codex-desktop')), mcpTarget: tenantTarget(), targetRepoRoot: path.join(await fs.realpath(root), 'canonical-repo')},
            result   = await prepareManagedAgentWorkspace(opts),
            home     = path.join(result.instanceHome, 'codex-home'),
            homePath = path.join(home, 'config.toml'),
            states   = () => {
                const listed = spawnSync(process.env.NEO_TEST_CODEX_BIN, ['mcp', 'list', '--json'], {
                    cwd     : opts.targetRepoRoot,
                    env     : {PATH: process.env.PATH, CODEX_HOME: home},
                    encoding: 'utf8',
                    timeout : 10000
                });

                expect(listed.status, listed.stderr).toBe(0);
                return Object.fromEntries(JSON.parse(listed.stdout).map(row => [row.name, row.enabled]))
            };

        expect(states()).toMatchObject({'neo-mjs-neural-link': true, 'neo-mjs-github-workflow': false});

        // The app's switch turns Neural Link off in the home; the cockpit turns GitHub on.
        await fs.writeFile(homePath, await read(homePath) + '\n[mcp_servers."neo-mjs-neural-link"]\nenabled = false\n');
        opts.agent = makeAgent('codex-desktop', {mcpServers: {'github-workflow': true}});
        await prepareManagedAgentWorkspace(opts);

        expect(states()).toMatchObject({'neo-mjs-neural-link': false, 'neo-mjs-github-workflow': true});
    });

    test('a symlinked resident-home segment fails before hydration or artifact writes', async () => {
        const
            opts        = options(makeAgent('codex')),
            foreignHome = path.join(root, 'foreign-resident-home'),
            agentRoot   = path.join(instanceRoot, 'agent-a');

        opts.deriveInstanceHome = () => path.join(agentRoot, 'codex');
        await fs.mkdir(foreignHome, {recursive: true});
        await fs.mkdir(instanceRoot, {recursive: true});
        await fs.symlink(foreignHome, agentRoot, 'dir');

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: agentRoot, reason: 'symlinked resident-owned path segment'}
        });
        expect(hydrationCalls).toHaveLength(0);
    });

    test('a symlinked instance root fails before hydration or artifact writes', async () => {
        const
            opts        = options(makeAgent('codex')),
            foreignRoot = path.join(root, 'foreign-instance-root');

        await fs.mkdir(foreignRoot, {recursive: true});
        await fs.symlink(foreignRoot, instanceRoot, 'dir');

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: instanceRoot, reason: 'trusted root is not a real directory'}
        });
        expect(hydrationCalls).toHaveLength(0);
    });

    test('resident node_modules stays outside the owned artifact set', async () => {
        const
            opts        = options(makeAgent('codex')),
            foreignDeps = path.join(root, 'foreign-resident', 'node_modules');

        await fs.mkdir(foreignDeps, {recursive: true});
        await fs.mkdir(opts.targetRepoRoot, {recursive: true});
        await fs.symlink(foreignDeps, path.join(opts.targetRepoRoot, 'node_modules'), 'dir');

        const result = await prepareManagedAgentWorkspace(opts);

        expect(result.artifacts.every(item => item.ownedKeys !== 'dependency-root')).toBe(true);
        expect(path.resolve(path.dirname(path.join(opts.targetRepoRoot, 'node_modules')), await fs.readlink(path.join(opts.targetRepoRoot, 'node_modules'))))
            .toBe(foreignDeps);
    });

    test('raw launch overrides and missing executables fail before a launchable config exists', async () => {
        const raw = options(makeAgent('codex'));
        raw.agent.metadata = {launch: {command: '/custom'}};

        await expect(prepareManagedAgentWorkspace(raw)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });
        expect(hydrationCalls).toHaveLength(0);

        const missingNode = options(makeAgent('codex'), 'missing-node');
        missingNode.nodePath = path.join(root, 'absent-node');
        await expect(prepareManagedAgentWorkspace(missingNode)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });
        await expect(fs.stat(path.join(missingNode.targetRepoRoot, '.codex', 'config.toml'))).rejects.toMatchObject({code: 'ENOENT'});

        const missingEntrypoint = options(makeAgent('codex'), 'missing-entrypoint');
        await fs.rm(path.join(agentosRuntimeRoot, MCP_ENTRYPOINTS[0]));
        await expect(prepareManagedAgentWorkspace(missingEntrypoint)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });
        await expect(fs.stat(path.join(missingEntrypoint.targetRepoRoot, '.codex', 'config.toml'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('swapping AgentOS runtime and target roots fails at the AgentOS executable guard', async () => {
        const opts = options(makeAgent('codex'), 'swapped-roots');

        [opts.agentosRuntimeRoot, opts.targetRepoRoot] = [opts.targetRepoRoot, opts.agentosRuntimeRoot];

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code   : 'FLEET_WORKSPACE_UNSUPPORTED',
            message: expect.stringMatching(/installed file entrypoint/)
        })
    });

    test('directory-valued Node and MCP entrypoint paths fail executable preflight', async () => {
        const directoryNode = options(makeAgent('codex'), 'directory-node');
        directoryNode.nodePath = root;

        await expect(prepareManagedAgentWorkspace(directoryNode)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });

        const directoryEntrypoint = options(makeAgent('codex'), 'directory-entrypoint');
        const directoryPath       = path.join(agentosRuntimeRoot, MCP_ENTRYPOINTS[0]);
        await fs.rm(directoryPath);
        await fs.mkdir(directoryPath);

        await expect(prepareManagedAgentWorkspace(directoryEntrypoint)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });
    });

    test('Claude Code: strict home JSON stores env references, never dynamic secret values', async () => {
        const originalBridgeToken = process.env.NEO_FLEET_BRIDGE_TOKEN;
        process.env.NEO_FLEET_BRIDGE_TOKEN = 'secret-token-value';

        const opts = options(makeAgent('claude-code'));
        let result;
        try {
            result = await prepareManagedAgentWorkspace(opts);
        } finally {
            if (originalBridgeToken === undefined) delete process.env.NEO_FLEET_BRIDGE_TOKEN;
            else process.env.NEO_FLEET_BRIDGE_TOKEN = originalBridgeToken;
        }

        const
            configPath = path.join(result.instanceHome, 'mcp-config.json'),
            raw        = await read(configPath),
            config     = JSON.parse(raw),
            nl         = config.mcpServers['neo-mjs-neural-link'];

        expect(Object.keys(config.mcpServers).sort()).toEqual([
            'neo-mjs-knowledge-base',
            'neo-mjs-memory-core',
            'neo-mjs-neural-link'
        ]);
        expect(nl.command).toBe(NODE_PATH);
        expect(nl.args).toEqual([
            path.join(agentosRuntimeRoot, 'ai/mcp/server/neural-link/mcp-server.mjs'),
            '--cwd',
            agentosRuntimeRoot
        ]);
        expect(nl.env).toEqual({
            NEO_AGENT_IDENTITY    : '${NEO_AGENT_IDENTITY}',
            NEO_FLEET_BRIDGE_TOKEN: '${NEO_FLEET_BRIDGE_TOKEN}'
        });
        expect(raw).not.toContain('secret-token-value');
        await expect(fs.stat(path.join(opts.targetRepoRoot, '.mcp.json'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('Claude Desktop: default profile includes Neural Link without persisting its optional Bridge token', async () => {
        const originalBridgeToken = process.env.NEO_FLEET_BRIDGE_TOKEN;
        process.env.NEO_FLEET_BRIDGE_TOKEN = 'secret-token-value';

        const opts = options(makeAgent('claude-desktop'));
        let result;
        try {
            result = await prepareManagedAgentWorkspace(opts);
        } finally {
            if (originalBridgeToken === undefined) delete process.env.NEO_FLEET_BRIDGE_TOKEN;
            else process.env.NEO_FLEET_BRIDGE_TOKEN = originalBridgeToken;
        }

        const
            configPath = path.join(result.instanceHome, 'claude_desktop_config.json'),
            raw        = await read(configPath),
            nl         = JSON.parse(raw).mcpServers['neo-mjs-neural-link'];

        expect(nl.env).toEqual({
            NEO_AGENT_IDENTITY: 'agent-a'
        });
        expect(raw).not.toContain('NEO_FLEET_BRIDGE_TOKEN');
        expect(raw).not.toContain('secret-token-value');
    });

    test('Claude Desktop: an existing explicit NL projection is preserved as a divergence', async () => {
        const opts       = options(makeAgent('claude-desktop')),
              result     = await prepareManagedAgentWorkspace(opts),
              configPath = path.join(result.instanceHome, 'claude_desktop_config.json'),
              config     = JSON.parse(await read(configPath));

        config.mcpServers['neo-mjs-neural-link'].env.NEO_NL_TOOL_PROJECTION_MODE = 'harness-embedded';
        const existing = JSON.stringify(config, null, 2) + '\n';
        await fs.writeFile(configPath, existing);

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({code: 'FLEET_WORKSPACE_DIVERGENT'});
        expect(await read(configPath)).toBe(existing);
    });

    test('Claude Desktop: a secret-free matrix materializes the exact contained profile config', async () => {
        const
            opts       = options(makeAgent('claude-desktop', {mcpServers: {'neural-link': false}})),
            result     = await prepareManagedAgentWorkspace(opts),
            configPath = path.join(result.instanceHome, 'claude_desktop_config.json'),
            config     = JSON.parse(await read(configPath));

        expect(result.artifacts).toEqual([
            {
                path     : configPath,
                status   : WORKSPACE_ARTIFACT_STATES.CREATED,
                ownedKeys: 'mcpServers.neo-mjs-*'
            }
        ]);
        expect(Object.keys(config.mcpServers).sort()).toEqual([
            'neo-mjs-knowledge-base',
            'neo-mjs-memory-core'
        ]);
        expect(config.mcpServers['neo-mjs-memory-core'].env).toEqual({NEO_AGENT_IDENTITY: 'agent-a'});
    });

    test('Claude Desktop refuses an enabled server whose startup requires secret env', async () => {
        const opts = options(makeAgent('claude-desktop', {mcpServers: {'github-workflow': true}}));

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });
        expect(hydrationCalls).toHaveLength(0);
        await expect(fs.stat(instanceRoot)).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('Antigravity and unprovisioned GitLab credential authority fail before hydration', async () => {
        await expect(prepareManagedAgentWorkspace(options(makeAgent('antigravity')))).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });
        await expect(prepareManagedAgentWorkspace(options(makeAgent('codex', {
            mcpServers: {'gitlab-workflow': true}
        }), 'gitlab-agent'))).rejects.toMatchObject({code: 'FLEET_WORKSPACE_UNSUPPORTED'});

        expect(hydrationCalls).toHaveLength(0);
        await expect(fs.stat(path.join(repoRoot, 'agent-a', '.gemini', 'settings.json'))).rejects.toMatchObject({code: 'ENOENT'});
    });

    test('required arguments fail loud before any hydration', async () => {
        await expect(prepareManagedAgentWorkspace()).rejects.toThrow(/agent/);
        await expect(prepareManagedAgentWorkspace({
            ...options(makeAgent('codex')),
            targetRepoRoot: 'relative/repo'
        })).rejects.toThrow(/targetRepoRoot.*absolute/);
        expect(hydrationCalls).toHaveLength(0);
    });

    test('Kimi Code: birth emits the full seat artifact set, matrix-narrowed, with the memory layer', async () => {
        const
            opts   = options(makeAgent('kimi-code')),
            result = await prepareManagedAgentWorkspace(opts),
            config = await read(path.join(result.instanceHome, 'config.toml')),
            mcp    = JSON.parse(await read(path.join(opts.targetRepoRoot, '.kimi-code', 'mcp.json'))),
            hook   = await read(path.join(result.instanceHome, 'hooks', 'identityAnchorHook.mjs')),
            memory = await read(path.join(result.instanceHome, 'memory', 'MEMORY.md'));

        // 7 artifacts: config.toml + mcp.json + 4 memory-layer files + the emitted hook.
        expect(result.artifacts.map(item => item.status)).toEqual(new Array(7).fill(WORKSPACE_ARTIFACT_STATES.CREATED));

        // The curated matrix narrows the wiring: github/gitlab stay OUT, the enabled three wire in.
        expect(Object.keys(mcp.mcpServers).sort()).toEqual(['neo-mjs-knowledge-base', 'neo-mjs-memory-core', 'neo-mjs-neural-link']);
        expect(config).toContain('pattern  = "mcp__neo-mjs-memory-core__*"');
        expect(config).not.toContain('mcp__neo-mjs-github-workflow__*');

        // The identity-anchor hook pair is wired against the emitted script in the instance home.
        expect(config.match(/\[\[hooks\]\]/g)).toHaveLength(8); // SessionStart + 2 identity-anchor + 5 presence
        expect(config).toContain(`"${NODE_PATH}" "${path.join(result.instanceHome, 'hooks', 'identityAnchorHook.mjs')}"`);

        // The emitted hook is generated code with the seat memory dir baked in.
        expect(hook).toContain('GENERATED by ai/services/fleet/generateKimiSeatConfig.mjs');
        expect(hook).toContain(`const MEMORY_DIR  = "${path.join(result.instanceHome, 'memory')}";`);

        // The Grace-pattern layer lands capped + story-sovereign.
        expect(memory).toContain('<17KB');
        expect(memory).toContain('Weak-spots');
        expect((await read(path.join(result.instanceHome, 'memory', 'identity.md'))).length).toBeLessThan(600);
    });

    test('Kimi Code: re-entry is MATCH across all artifacts and bearer edits are never clobbered', async () => {
        const
            opts         = options(makeAgent('kimi-code')),
            first        = await prepareManagedAgentWorkspace(opts),
            identityPath = path.join(first.instanceHome, 'memory', 'identity.md'),
            indexPath    = path.join(first.instanceHome, 'memory', 'MEMORY.md');

        // The bearer authors their layer after first boot — re-provisioning must not even flag it.
        await fs.writeFile(identityPath, '# Identity — MINE\n\nThe bearer wrote this.\n', 'utf8');
        await fs.writeFile(indexPath, '# Seat memory index\n\n- bearer-accreted line\n', 'utf8');

        const second = await prepareManagedAgentWorkspace(opts);

        expect(second.artifacts.map(item => item.status)).toEqual(new Array(7).fill(WORKSPACE_ARTIFACT_STATES.MATCH));
        expect(await read(identityPath)).toBe('# Identity — MINE\n\nThe bearer wrote this.\n');
        expect(await read(indexPath)).toContain('bearer-accreted line');
    });

    test('Kimi Code: divergence on Fleet-owned surfaces fails closed without overwrite', async () => {
        const
            opts       = options(makeAgent('kimi-code')),
            first      = await prepareManagedAgentWorkspace(opts),
            configPath = path.join(first.instanceHome, 'config.toml');

        await fs.writeFile(configPath, (await read(configPath)).replace('default_permission_mode = "auto"', 'default_permission_mode = "ask"'), 'utf8');

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_DIVERGENT'
        });
        // The divergent file is left exactly as found — fail closed, never a silent repair.
        expect(await read(configPath)).toContain('default_permission_mode = "ask"');
    });

    test('OpenCode: birth emits the slim instructions layer + matrix-narrowed servers + wake hook + plant', async () => {
        const
            opts        = options(makeAgent('opencode')),
            result      = await prepareManagedAgentWorkspace(opts),
            jsoncSource = await read(path.join(opts.targetRepoRoot, 'opencode.jsonc')),
            config      = JSON.parse(jsoncSource.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n'));

        // 7 artifacts: opencode.jsonc + 4 memory-layer files + the wake-envelope boot hook + the plant.
        // The plant is a SIBLING artifact, not a payload inside the hook: the hook runs after the server
        // is listening, so a plant it installed could only be loaded by a later process. Converged here,
        // before spawn, at the seat's own plugins path.
        expect(result.artifacts.map(item => item.status)).toEqual(new Array(7).fill(WORKSPACE_ARTIFACT_STATES.CREATED));

        // The always-loaded slot carries the boot files ONLY; detail files load on demand by path.
        expect(config.instructions).toEqual([
            path.join(result.instanceHome, 'memory', 'MEMORY.md'),
            path.join(result.instanceHome, 'memory', 'identity.md')
        ]);
        expect(Object.keys(config.mcp).sort()).toEqual(['neo-mjs-knowledge-base', 'neo-mjs-memory-core', 'neo-mjs-neural-link']);
        // Permission allow-list covers the seat home, the managed repo, and the canonical checkout.
        expect(config.permission.external_directory[result.instanceHome + '/**']).toBe('allow');
        expect(config.permission.external_directory[opts.targetRepoRoot + '/**']).toBe('allow');
        expect(config.permission.external_directory['*']).toBe('ask');

        const hook = await read(path.join(result.instanceHome, 'write-wake-envelope.mjs'));
        expect(hook).toContain('GENERATED by ai/services/fleet/generateOpenCodeSeatConfig.mjs');

        // The seat's FIRST process must find the plant, so it lands in the seat's own plugins dir and
        // carries no base64 payload — the hook's own bytes prove the inlined shape is gone.
        const plantPath = path.join(result.instanceHome, 'opencode', 'plugins', 'neo-wake-envelope.mjs'),
              plant     = await read(plantPath);

        expect(plant, 'the plant is in the seat\'s own plugins dir before OpenCode ever starts').toContain('export const NeoWakeEnvelope');
        expect(
            plant.replace(/^\/\* GENERATED by generateOpenCodeSeatConfig — plant generation sha256:[0-9a-f]{64} \*\/\n/, ''),
            'and apart from its generation marker its bytes are the Brain copy, not a re-serialization'
        ).toBe(await read(path.join(PROJECT_ROOT, 'ai/services/fleet/opencodeWakeEnvelopePlugin.mjs')));
        expect(
            isUnmodifiedGeneration(plant),
            'the marker agrees with the body it stamps, which is what makes the file replaceable'
        ).toBe(true);
        expect(hook, 'and the hook carries no plant payload').not.toMatch(/[A-Za-z0-9+/]{500,}={0,2}/);

        expect(await read(path.join(result.instanceHome, 'memory', 'about-this-layer.md'))).toContain('Grace-pattern');
    });

    test('OpenCode: re-entry is MATCH and bearer edits are never clobbered', async () => {
        const
            opts   = options(makeAgent('opencode')),
            first  = await prepareManagedAgentWorkspace(opts),
            memory = path.join(first.instanceHome, 'memory', 'MEMORY.md');

        await fs.writeFile(memory, '# bearer index\n', 'utf8');

        const second = await prepareManagedAgentWorkspace(opts);

        expect(second.artifacts.map(item => item.status)).toEqual(new Array(7).fill(WORKSPACE_ARTIFACT_STATES.MATCH));
        expect(await read(memory)).toBe('# bearer index\n');
    });

    test('OpenCode: an EARLIER GENERATION of the plant is replaced and reported UPDATED, not refused', async () => {
        // The gap the plant's own convergence exists to close. The Fleet's general text rule is
        // create-or-refuse, so without provenance the FIRST plant edit after provisioning is refused on
        // every seat: the file on disk is an earlier generation, and a bare byte-compare cannot tell that
        // from a hand edit. This arm is that earlier generation on disk.
        const
            opts      = options(makeAgent('opencode')),
            first     = await prepareManagedAgentWorkspace(opts),
            plantPath = path.join(first.instanceHome, 'opencode', 'plugins', 'neo-wake-envelope.mjs'),
            pristine  = await read(plantPath);

        // An EARLIER generation: a body from a previous emission, carrying a marker that agrees with it.
        // Built through the generator's own stamper so the marker is real rather than hand-forged.
        const earlier = stampWakeEnvelopePlant(pristine.replace(/^export default NeoWakeEnvelope;$/m, 'export default NeoWakeEnvelope;\n// an earlier generation\n'));

        await fs.writeFile(plantPath, earlier, 'utf8');

        const second = await prepareManagedAgentWorkspace(opts);

        expect(await read(plantPath), 'the seat now carries the CURRENT generation').toBe(pristine);
        expect(
            second.artifacts.find(artifact => artifact.path === plantPath).status,
            'and the receipt says the Fleet moved its own file forward'
        ).toBe(WORKSPACE_ARTIFACT_STATES.UPDATED);
    });

    test('OpenCode: a hand-edited plant is refused, while a planted-but-edited one is refused too', async () => {
        // Both halves of the provenance rule. A file with no marker is a person's. So is one that KEPT
        // its marker and was edited underneath it — which is why the marker carries a content hash
        // rather than being a bare word.
        const
            opts      = options(makeAgent('opencode')),
            first     = await prepareManagedAgentWorkspace(opts),
            plantPath = path.join(first.instanceHome, 'opencode', 'plugins', 'neo-wake-envelope.mjs'),
            pristine  = await read(plantPath);

        await fs.writeFile(plantPath, '// hand edit\n', 'utf8');
        await expect(prepareManagedAgentWorkspace(opts)).rejects.toThrow(/hand-edited wake-envelope plant/);

        // marker kept, body changed underneath it: the hash no longer agrees
        await fs.writeFile(plantPath, `${pristine}\n// sneaky edit\n`, 'utf8');
        await expect(prepareManagedAgentWorkspace(opts)).rejects.toThrow(/hand-edited wake-envelope plant/);

        // and the refusal never clobbers: the file is still exactly what the person left
        expect(await read(plantPath)).toBe(`${pristine}\n// sneaky edit\n`);
    });

    test('remote adapters emit each harness exact grammar while Neural Link remains local', async () => {
        const cases = [{
            harnessType: 'codex',
            inspect    : async (opts, result) => {
                const source = await read(path.join(opts.targetRepoRoot, '.codex', 'config.toml'));

                expect(source).toMatch(/\[mcp_servers\."neo-mjs-memory-core"\][\s\S]*?url = "https:\/\/tenant\.example\.com\/agentos\/mc\/mcp"[\s\S]*?bearer_token_env_var = "NEO_MCP_REMOTE_TOKEN"/);
                expect(source).toMatch(/\[mcp_servers\."neo-mjs-knowledge-base"\][\s\S]*?url = "https:\/\/tenant\.example\.com\/agentos\/kb\/mcp"[\s\S]*?bearer_token_env_var = "NEO_MCP_REMOTE_TOKEN"/);
                expect(source).toMatch(/\[mcp_servers\."neo-mjs-neural-link"\][\s\S]*?command = /)
            }
        }, {
            harnessType: 'codex-desktop',
            inspect    : async (opts, result) => {
                const source = await read(path.join(opts.targetRepoRoot, '.codex', 'config.toml'));

                expect(source).toContain('bearer_token_env_var = "NEO_MCP_REMOTE_TOKEN"');
                expect(result.instanceHome).toContain('codex-desktop')
            }
        }, {
            harnessType: 'claude-code',
            inspect    : async (opts, result) => {
                const config = JSON.parse(await read(path.join(result.instanceHome, 'mcp-config.json')));

                expect(config.mcpServers['neo-mjs-memory-core']).toEqual({
                    type   : 'http',
                    url    : 'https://tenant.example.com/agentos/mc/mcp',
                    headers: {Authorization: 'Bearer ${NEO_MCP_REMOTE_TOKEN}'}
                });
                expect(config.mcpServers['neo-mjs-knowledge-base']).toEqual({
                    type   : 'http',
                    url    : 'https://tenant.example.com/agentos/kb/mcp',
                    headers: {Authorization: 'Bearer ${NEO_MCP_REMOTE_TOKEN}'}
                });
                expect(config.mcpServers['neo-mjs-neural-link'].command).toBe(NODE_PATH)
            }
        }, {
            harnessType: 'claude-desktop',
            inspect    : async (opts, result) => {
                const
                    config = JSON.parse(await read(path.join(result.instanceHome, 'claude_desktop_config.json'))),
                    bridge = path.join(agentosRuntimeRoot, 'ai/mcp/client/stdioToStreamableHttp.mjs');

                expect(config.mcpServers['neo-mjs-memory-core']).toEqual({
                    command: NODE_PATH,
                    args   : [
                        bridge,
                        '--url',
                        'https://tenant.example.com/agentos/mc/mcp',
                        '--token-env',
                        'NEO_MCP_REMOTE_TOKEN'
                    ]
                });
                expect(config.mcpServers['neo-mjs-knowledge-base']).toEqual({
                    command: NODE_PATH,
                    args   : [
                        bridge,
                        '--url',
                        'https://tenant.example.com/agentos/kb/mcp',
                        '--token-env',
                        'NEO_MCP_REMOTE_TOKEN'
                    ]
                });
                expect(config.mcpServers['neo-mjs-neural-link'].command).toBe(NODE_PATH)
            }
        }, {
            harnessType: 'kimi-code',
            inspect    : async opts => {
                const config = JSON.parse(await read(path.join(opts.targetRepoRoot, '.kimi-code', 'mcp.json')));

                expect(config.mcpServers['neo-mjs-memory-core']).toEqual({
                    url              : 'https://tenant.example.com/agentos/mc/mcp',
                    bearerTokenEnvVar: 'NEO_MCP_REMOTE_TOKEN',
                    enabled          : true
                });
                expect(config.mcpServers['neo-mjs-knowledge-base']).toEqual({
                    url              : 'https://tenant.example.com/agentos/kb/mcp',
                    bearerTokenEnvVar: 'NEO_MCP_REMOTE_TOKEN',
                    enabled          : true
                });
                expect(config.mcpServers['neo-mjs-neural-link'].command).toBe(NODE_PATH)
            }
        }, {
            harnessType: 'opencode',
            inspect    : async opts => {
                const config = parseJsonc(await read(path.join(opts.targetRepoRoot, 'opencode.jsonc')));

                expect(config.mcp['neo-mjs-memory-core']).toEqual({
                    type   : 'remote',
                    url    : 'https://tenant.example.com/agentos/mc/mcp',
                    enabled: true,
                    headers: {Authorization: 'Bearer {env:NEO_MCP_REMOTE_TOKEN}'},
                    oauth  : false
                });
                expect(config.mcp['neo-mjs-knowledge-base']).toEqual({
                    type   : 'remote',
                    url    : 'https://tenant.example.com/agentos/kb/mcp',
                    enabled: true,
                    headers: {Authorization: 'Bearer {env:NEO_MCP_REMOTE_TOKEN}'},
                    oauth  : false
                });
                expect(config.mcp['neo-mjs-neural-link'].type).toBe('local')
            }
        }];

        for (const {harnessType, inspect} of cases) {
            const opts = options(makeAgent(harnessType), `remote-${harnessType}`);

            opts.mcpTarget = tenantTarget();

            const result = await prepareManagedAgentWorkspace(opts);

            await inspect(opts, result);
            expect(result.mcpPlan.find(server => server.key === 'memory-core'))
                .toMatchObject({target: 'tenant', transport: 'streamable-http'});
            expect(result.mcpPlan.find(server => server.key === 'knowledge-base'))
                .toMatchObject({target: 'tenant', transport: 'streamable-http'});
            expect(result.mcpPlan.find(server => server.key === 'neural-link'))
                .toMatchObject({target: 'resident', transport: 'stdio'});
                expect(JSON.stringify(result.mcpPlan)).not.toContain(['remote', 'http'].join('-'));

            const receipt = JSON.parse(await read(path.join(result.instanceHome, '.neo-fleet-mcp-transport.json')));

            expect(Object.keys(receipt).sort()).toEqual(['adapter', 'artifact', 'projectionSha256', 'version']);
            expect(receipt.adapter).toBe(harnessType);
            expect(receipt.projectionSha256).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.stringify(receipt)).not.toContain('tenant.example.com');
            expect(JSON.stringify(receipt)).not.toContain('NEO_MCP_REMOTE_TOKEN')
        }
    });

    test('transport transition is local → remote → different remote → local, preserving unrelated TOML bytes', async () => {
        const
            opts        = options(makeAgent('codex'), 'transition-codex'),
            projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml');

        const local              = await prepareManagedAgentWorkspace(opts);
        const localBaseline      = await read(projectPath);
        const homePath           = path.join(local.instanceHome, 'config.toml');
        const homeBaseline       = await read(homePath);
        const operatorBlock      = '\n# operator bytes begin\n[mcp_servers."operator-local"]\ncommand = "custom --do-not-touch"\n# operator bytes end\n';
        const operatorArrayBlock = '# operator route policy\n[[operator."routes]#keep"]] # legal inline-commented array header\nname = "custom --do-not-touch"\n';
        const insertionAnchor    = '[mcp_servers."neo-mjs-knowledge-base"]';

        await fs.writeFile(
            projectPath,
            localBaseline.replace(insertionAnchor, operatorArrayBlock + insertionAnchor) + operatorBlock,
            'utf8'
        );

        opts.mcpTarget = tenantTarget();
        const firstRemote = await prepareManagedAgentWorkspace(opts);
        const firstSource = await read(projectPath);
        const receiptPath = path.join(firstRemote.instanceHome, '.neo-fleet-mcp-transport.json');

        expect(firstSource).toContain(operatorBlock);
        expect(firstSource).toContain(operatorArrayBlock);
        expect(firstSource).toContain('https://tenant.example.com/agentos/mc/mcp');
        expect(tomlMcpTable(firstSource, 'neo-mjs-memory-core')).not.toContain('command = ');
        expect(await read(homePath)).toContain('# Fleet-managed remote MCP project trust begin');
        expect(JSON.parse(await read(receiptPath)).adapter).toBe('codex');

        opts.mcpTarget = tenantTarget('https://other.example.com/agentos');
        await prepareManagedAgentWorkspace(opts);

        const secondSource = await read(projectPath);

        expect(secondSource).toContain(operatorBlock);
        expect(secondSource).toContain(operatorArrayBlock);
        expect(secondSource).toContain('https://other.example.com/agentos/mc/mcp');
        expect(secondSource).not.toContain('https://tenant.example.com/agentos/mc/mcp');

        opts.mcpTarget = null;
        const backToLocal = await prepareManagedAgentWorkspace(opts);
        const localSource = await read(projectPath);

        expect(localSource).toContain(operatorBlock);
        expect(localSource).toContain(operatorArrayBlock);
        expect(tomlMcpTable(localSource, 'neo-mjs-memory-core')).toContain('command = ');
        expect(localSource).not.toContain('https://other.example.com');
        expect(localSource.replace(operatorArrayBlock, '').replace(operatorBlock, '')).toBe(localBaseline);
        expect(await read(homePath)).toBe(homeBaseline);
        await expect(fs.stat(receiptPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(backToLocal.artifacts.some(item => item.ownedKeys === 'transport receipt removed')).toBe(true);
        expect(local.instanceHome).toBe(backToLocal.instanceHome)
    });

    test('Claude, Kimi, and legal OpenCode JSONC preserve operator bytes across the full transport lifecycle', async () => {
        const
            strictOperatorBlock = '  "operatorOwned": {\n    "keep": true\n  },\n',
            jsoncOperatorBlock  = '  /* operator bytes include structural noise: } [ */\n  "operatorOwned": {\n    "keep": true, // legal JSONC inline comment\n  },\n',
            cases               = [{
                harnessType  : 'claude-code',
                artifactPath : (opts, result) => path.join(result.instanceHome, 'mcp-config.json'),
                operatorBlock: strictOperatorBlock
            }, {
                harnessType  : 'claude-desktop',
                artifactPath : (opts, result) => path.join(result.instanceHome, 'claude_desktop_config.json'),
                operatorBlock: strictOperatorBlock
            }, {
                harnessType  : 'kimi-code',
                artifactPath : opts => path.join(opts.targetRepoRoot, '.kimi-code', 'mcp.json'),
                operatorBlock: strictOperatorBlock
            }, {
                harnessType  : 'opencode',
                artifactPath : opts => path.join(opts.targetRepoRoot, 'opencode.jsonc'),
                operatorBlock: jsoncOperatorBlock
            }];

        for (const entry of cases) {
            const
                id                = `transition-${entry.harnessType}`,
                opts              = options(makeAgent(entry.harnessType, {id}), id),
                local             = await prepareManagedAgentWorkspace(opts),
                artifactPath      = entry.artifactPath(opts, local),
                localBaseline     = await read(artifactPath),
                localWithOperator = localBaseline.replace('{\n', `{\n${entry.operatorBlock}`);

            await fs.writeFile(artifactPath, localWithOperator, 'utf8');

            opts.mcpTarget = tenantTarget();
            const firstRemote = await prepareManagedAgentWorkspace(opts);
            const firstSource = await read(artifactPath);
            const receiptPath = path.join(firstRemote.instanceHome, '.neo-fleet-mcp-transport.json');

            expect(firstSource, entry.harnessType).toContain(entry.operatorBlock);
            expect(firstSource, entry.harnessType).toContain('https://tenant.example.com/agentos/mc/mcp');
            expect(JSON.parse(await read(receiptPath)).adapter).toBe(entry.harnessType);

            const edited = firstSource.replace(
                'https://tenant.example.com/agentos/mc/mcp',
                'https://operator.example.com/agentos/mc/mcp'
            );

            await fs.writeFile(artifactPath, edited, 'utf8');
            opts.mcpTarget = tenantTarget('https://other.example.com/agentos');

            await expect(prepareManagedAgentWorkspace(opts), entry.harnessType).rejects.toMatchObject({
                code: 'FLEET_WORKSPACE_DIVERGENT'
            });
            expect(await read(artifactPath), entry.harnessType).toBe(edited);

            await fs.writeFile(artifactPath, firstSource, 'utf8');
            await prepareManagedAgentWorkspace(opts);

            const secondSource = await read(artifactPath);

            expect(secondSource, entry.harnessType).toContain(entry.operatorBlock);
            expect(secondSource, entry.harnessType).toContain('https://other.example.com/agentos/mc/mcp');
            expect(secondSource, entry.harnessType).not.toContain('https://tenant.example.com/agentos/mc/mcp');

            opts.mcpTarget = null;
            await prepareManagedAgentWorkspace(opts);

            expect(await read(artifactPath), entry.harnessType).toBe(localWithOperator);
            await expect(fs.stat(receiptPath), entry.harnessType).rejects.toMatchObject({code: 'ENOENT'})
        }
    });

    test('a receipt cannot authorize an operator-edited transport projection', async () => {
        const
            opts        = options(makeAgent('codex'), 'edited-remote'),
            projectPath = path.join(opts.targetRepoRoot, '.codex', 'config.toml');

        opts.mcpTarget = tenantTarget();
        await prepareManagedAgentWorkspace(opts);

        const edited = (await read(projectPath)).replace(
            'https://tenant.example.com/agentos/mc/mcp',
            'https://operator.example.com/agentos/mc/mcp'
        );

        await fs.writeFile(projectPath, edited, 'utf8');
        opts.mcpTarget = tenantTarget('https://other.example.com/agentos');

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_DIVERGENT'
        });
        expect(await read(projectPath)).toBe(edited)
    });

    test('remote plan grammar rejects extra/secret fields, incomplete resources, and split deployment bases before hydration', async () => {
        const malformed = [{
            ...tenantTarget(),
            token: 'secret'
        }, {
            ...tenantTarget(),
            resources: {
                ...tenantTarget().resources,
                'memory-core': {
                    url    : 'https://tenant.example.com/agentos/mc/mcp',
                    headers: {Authorization: 'Bearer secret'}
                }
            }
        }, {
            ...tenantTarget(),
            resources: {
                'memory-core': {url: 'https://tenant.example.com/agentos/mc/mcp'}
            }
        }, {
            ...tenantTarget(),
            resources: {
                'memory-core'   : {url: 'https://tenant.example.com/agentos/mc/mcp'},
                'knowledge-base': {url: 'https://other.example.com/agentos/kb/mcp'}
            }
        }, {
            ...tenantTarget(),
            credentialEnvVar: 'GH_TOKEN'
        }, {
            ...tenantTarget(),
            credentialEnvVar: 'NOT VALID'
        }];

        for (const [index, mcpTarget] of malformed.entries()) {
            const opts = options(makeAgent('codex'), `malformed-${index}`);

            opts.mcpTarget = mcpTarget;

            await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
                code: 'FLEET_WORKSPACE_UNSUPPORTED'
            })
        }

        expect(hydrationCalls).toHaveLength(0)
    });

    test('Claude Desktop generated bridges list and call both ephemeral HTTP resources without leaking the bearer', async () => {
        const
            token   = 'plane-secret-that-must-never-reach-artifacts-or-argv',
            fixture = await startBridgeFixture(token),
            opts    = options(makeAgent('claude-desktop'), 'remote-desktop-live-bridge');

        opts.agentosRuntimeRoot       = PROJECT_ROOT;
        opts.remoteMcpCapability = claudeDesktopRemoteCapability(PROJECT_ROOT);
        opts.mcpTarget           = tenantTarget(fixture.baseUrl);

        try {
            const
                result     = await prepareManagedAgentWorkspace(opts),
                configPath = path.join(result.instanceHome, 'claude_desktop_config.json'),
                raw        = await read(configPath),
                config     = JSON.parse(raw);

            expect(raw).not.toContain(token);
            expect(JSON.stringify(result)).not.toContain(token);

            for (const [serverName, resource] of [
                ['neo-mjs-memory-core', 'mc'],
                ['neo-mjs-knowledge-base', 'kb']
            ]) {
                const
                    entry     = config.mcpServers[serverName],
                    transport = new StdioClientTransport({
                        command: entry.command,
                        args   : entry.args,
                        env    : {
                            ...process.env,
                            ...entry.env,
                            NEO_MCP_REMOTE_TOKEN : token
                        },
                        stderr: 'pipe'
                    }),
                    client = new Client({
                        name   : `claude-desktop-${resource}-bridge-test`,
                        version: '1.0.0'
                    }, {
                        capabilities: {}
                    });
                let stderr = '';

                transport.stderr.on('data', chunk => {
                    stderr += chunk
                });

                expect(entry.args.join(' ')).not.toContain(token);

                try {
                    await client.connect(transport);

                    const {tools} = await client.listTools();
                    const result  = await client.callTool({name: 'bridge_probe', arguments: {}});

                    expect(tools.map(tool => tool.name)).toContain('bridge_probe');
                    expect(result.content).toContainEqual({type: 'text', text: resource})
                } finally {
                    await client.close()
                }

                expect(stderr).not.toContain(token);
                await expect.poll(fixture.sessionCount).toBe(0)
            }
        } finally {
            await fixture.close()
        }
    });

    test('Claude Desktop remote transport rejects missing or drifted bridge capability before hydration', async () => {
        const missingProof = options(makeAgent('claude-desktop'), 'remote-desktop-missing-proof');

        missingProof.mcpTarget = tenantTarget();
        delete missingProof.remoteMcpCapability;

        await expect(prepareManagedAgentWorkspace(missingProof)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });

        const wrongKind = options(makeAgent('claude-desktop'), 'remote-desktop-wrong-kind');

        wrongKind.mcpTarget = tenantTarget();
        wrongKind.remoteMcpCapability.bridge.kind = 'generic-proxy';

        await expect(prepareManagedAgentWorkspace(wrongKind)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });

        const missingBridge = options(makeAgent('claude-desktop'), 'remote-desktop-missing-bridge');

        missingBridge.mcpTarget = tenantTarget();
        await fs.rm(path.join(agentosRuntimeRoot, 'ai/mcp/client/stdioToStreamableHttp.mjs'));

        await expect(prepareManagedAgentWorkspace(missingBridge)).rejects.toMatchObject({
            code: 'FLEET_WORKSPACE_UNSUPPORTED'
        });

        expect(hydrationCalls).toHaveLength(0);
        await expect(fs.stat(instanceRoot)).rejects.toMatchObject({code: 'ENOENT'})
    });
});

test.describe('prepareManagedAgentWorkspace: the seat\'s instructions in its harness home', () => {
    const
        GATE    = /No AiConfig work without reading ADR-0019/,
        RECEIPT = '.neo-fleet-seat-instructions.json',
        onRepo  = (agent, repoSlug) => ({...agent, metadata: {repo: {repoSlug}}}),
        sha256  = content => crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
        homeOf  = (result, harnessType) => path.join(result.instanceHome, harnessType === 'codex-desktop' ? 'codex-home' : '', harnessType === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md'),
        absent  = filePath => expect(fs.stat(filePath)).rejects.toMatchObject({code: 'ENOENT'});

    test('a Claude seat on the Brain gets the composition as <home>/CLAUDE.md with a receipt, and re-entry is MATCH', async () => {
        const
            agent    = onRepo(makeAgent('claude-code'), 'neomjs/neo-agent-brain'),
            first    = await prepareManagedAgentWorkspace(options(agent)),
            filePath = path.join(first.instanceHome, 'CLAUDE.md');

        expect(first.artifacts.at(-1)).toEqual({path: filePath, status: WORKSPACE_ARTIFACT_STATES.CREATED, ownedKeys: 'seat instructions'});
        expect(await read(filePath)).toMatch(GATE);
        expect(JSON.parse(await read(path.join(first.instanceHome, RECEIPT))))
            .toEqual({version: 1, artifact: 'CLAUDE.md', sha256: sha256(await read(filePath))});

        const second = await prepareManagedAgentWorkspace(options(agent));

        expect(second.artifacts.at(-1).status).toBe(WORKSPACE_ARTIFACT_STATES.MATCH)
    });

    test('a new Skills release replaces a file Fleet wrote; a person\'s edit refuses the start, naming the path', async () => {
        const
            agent    = onRepo(makeAgent('claude-code'), 'neomjs/neo-agent-brain'),
            first    = await prepareManagedAgentWorkspace(options(agent)),
            filePath = path.join(first.instanceHome, 'CLAUDE.md'),
            older    = '# An older generation Fleet wrote\n';

        // the file and its receipt agree on other bytes: Fleet's own earlier write
        await fs.writeFile(filePath, older);
        await fs.writeFile(path.join(first.instanceHome, RECEIPT), JSON.stringify({version: 1, artifact: 'CLAUDE.md', sha256: sha256(older)}));

        const updated = await prepareManagedAgentWorkspace(options(agent));

        expect(updated.artifacts.at(-1).status).toBe(WORKSPACE_ARTIFACT_STATES.UPDATED);
        expect(await read(filePath)).toMatch(GATE);

        await fs.appendFile(filePath, '\nA rule of my own.\n');

        await expect(prepareManagedAgentWorkspace(options(agent))).rejects.toMatchObject({
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: filePath}
        })
    });

    test('a checkout carrying .claude/CLAUDE.md supplies a Claude seat\'s instructions: no home file, no artifact, the decision in the result', async () => {
        const opts = options(onRepo(makeAgent('claude-code'), 'neomjs/neo'));

        await fs.mkdir(path.join(opts.targetRepoRoot, '.claude'), {recursive: true});
        await fs.writeFile(path.join(opts.targetRepoRoot, '.claude', 'CLAUDE.md'), '# The repository\'s own\n');

        const result = await prepareManagedAgentWorkspace(opts);

        expect(result.artifacts.map(artifact => artifact.ownedKeys)).not.toContain('seat instructions');
        await absent(path.join(result.instanceHome, 'CLAUDE.md'));
        expect(result.seatInstructions).toEqual({state: 'repository-supplied', reason: `the checkout carries ${path.join('.claude', 'CLAUDE.md')}`})
    });

    test('a checkout carrying AGENTS.md supplies a Codex seat\'s instructions: Codex reads its home file whole, beside the project budget', async () => {
        const opts = options(onRepo(makeAgent('codex'), 'neomjs/neo'));

        await fs.mkdir(opts.targetRepoRoot, {recursive: true});
        await fs.writeFile(path.join(opts.targetRepoRoot, 'AGENTS.md'), '# The repository\'s own\n');

        const result = await prepareManagedAgentWorkspace(opts);

        expect(result.artifacts.map(artifact => artifact.ownedKeys)).not.toContain('seat instructions');
        await absent(path.join(result.instanceHome, 'AGENTS.md'));
        expect(result.seatInstructions).toEqual({state: 'repository-supplied', reason: 'the checkout carries AGENTS.md'})
    });

    test('once the checkout supplies the instructions, the home file Fleet wrote is retired with its receipt, for every harness', async () => {
        for (const [harnessType, repoFile] of [['claude-code', 'CLAUDE.md'], ['codex', 'AGENTS.md'], ['codex-desktop', 'AGENTS.md']]) {
            const
                opts     = options(onRepo(makeAgent(harnessType, {id: `retire-${harnessType}`}), 'neomjs/neo')),
                first    = await prepareManagedAgentWorkspace(opts),
                homeFile = homeOf(first, harnessType);

            expect(first.artifacts.at(-1), harnessType).toMatchObject({path: homeFile, status: WORKSPACE_ARTIFACT_STATES.CREATED});

            await fs.writeFile(path.join(opts.targetRepoRoot, repoFile), '# The repository\'s own\n');

            const second = await prepareManagedAgentWorkspace(opts);

            expect(second.artifacts.at(-1), harnessType).toEqual({path: homeFile, status: WORKSPACE_ARTIFACT_STATES.UPDATED, ownedKeys: 'seat instructions retired'});
            expect(second.seatInstructions.state, harnessType).toBe('repository-supplied');
            await absent(homeFile);
            await absent(path.join(first.instanceHome, RECEIPT))
        }
    });

    test('a seat moved to a repository the Skills source does not declare loses the file Fleet wrote', async () => {
        const
            first    = await prepareManagedAgentWorkspace(options(onRepo(makeAgent('codex'), 'neomjs/neo-agent-brain'))),
            homeFile = homeOf(first, 'codex'),
            moved    = await prepareManagedAgentWorkspace(options(onRepo(makeAgent('codex'), 'acme/app')));

        expect(moved.seatInstructions).toMatchObject({state: 'not-applicable'});
        expect(moved.artifacts.at(-1)).toMatchObject({path: homeFile, ownedKeys: 'seat instructions retired'});
        await absent(homeFile)
    });

    test('a home file edited after Fleet wrote it refuses the start once the seat no longer takes it, and keeps the edit', async () => {
        const
            opts     = options(onRepo(makeAgent('claude-code'), 'neomjs/neo')),
            first    = await prepareManagedAgentWorkspace(opts),
            homeFile = homeOf(first, 'claude-code');

        await fs.appendFile(homeFile, '\nA rule of my own.\n');
        const edited = await read(homeFile);
        await fs.writeFile(path.join(opts.targetRepoRoot, 'CLAUDE.md'), '# The repository\'s own\n');

        await expect(prepareManagedAgentWorkspace(opts)).rejects.toMatchObject({
            code    : 'FLEET_WORKSPACE_DIVERGENT',
            artifact: {path: homeFile}
        });
        expect(await read(homeFile)).toBe(edited)
    });

    test('a home file Fleet never wrote stays when the checkout supplies the instructions, and the decision says so', async () => {
        const opts  = options(onRepo(makeAgent('claude-code'), 'neomjs/neo')),
              first = await prepareManagedAgentWorkspace({...opts, agent: onRepo(makeAgent('claude-code'), 'acme/app')}),
              home  = homeOf(first, 'claude-code');

        await fs.writeFile(home, '# The resident\'s own\n');
        await fs.writeFile(path.join(opts.targetRepoRoot, 'CLAUDE.md'), '# The repository\'s own\n');

        const result = await prepareManagedAgentWorkspace(opts);

        expect(await read(home)).toBe('# The resident\'s own\n');
        expect(result.seatInstructions).toMatchObject({state: 'repository-supplied', homeFile: `kept: ${home} was not written by Fleet`})
    });

    test('an AGENTS.md the harness cannot read never stands in for the composition; a symlink to a readable file does', async () => {
        const
            unreadable = typeof process.getuid === 'function' && process.getuid() !== 0,
            cases      = [
                ['a directory', async file => fs.mkdir(file), 'not a file'],
                ['a link to nothing', async file => fs.symlink(path.join(root, 'nowhere.md'), file), 'a link to nothing'],
                ...(unreadable ? [['an unreadable file', async file => {await fs.writeFile(file, '# locked\n'); await fs.chmod(file, 0o000)}, 'unreadable']] : [])
            ];

        for (const [label, place, why] of cases) {
            const opts = options(onRepo(makeAgent('codex', {id: `entry-${why.replace(/\W+/g, '-')}`}), 'neomjs/neo'));

            await fs.mkdir(opts.targetRepoRoot, {recursive: true});
            await place(path.join(opts.targetRepoRoot, 'AGENTS.md'));

            const result = await prepareManagedAgentWorkspace(opts);

            expect(result.artifacts.at(-1), label).toMatchObject({path: homeOf(result, 'codex'), status: WORKSPACE_ARTIFACT_STATES.CREATED});
            expect(result.seatInstructions, label).toMatchObject({state: 'projected', ignored: [`AGENTS.md (${why})`]})
        }

        const linked = options(onRepo(makeAgent('codex', {id: 'entry-linked'}), 'neomjs/neo'));

        await fs.mkdir(linked.targetRepoRoot, {recursive: true});
        await fs.writeFile(path.join(root, 'shared-agents.md'), '# Shared\n');
        await fs.symlink(path.join(root, 'shared-agents.md'), path.join(linked.targetRepoRoot, 'AGENTS.md'));

        const supplied = await prepareManagedAgentWorkspace(linked);

        expect(supplied.seatInstructions).toEqual({state: 'repository-supplied', reason: 'the checkout carries AGENTS.md'});
        await absent(homeOf(supplied, 'codex'))
    });

    test('a real composed start returns the instruction decision on the status it hands its caller, with no logger injected', async () => {
        const
            started   = [],
            lifecycle = agent => ({
                isRunning      : () => false,
                status         : id => ({id, running: false, state: 'stopped'}),
                getInstanceRoot: () => instanceRoot,
                getRegistry    : () => ({getAgent: () => agent, getDefinition: () => agent, resolveCredential: () => 'ghp_fixture_only'}),
                start          : (id, opts) => { started.push(id); return {id, running: true, state: 'running', cwd: opts.cwd} }
            }),
            start = async (agent, repoRoot) => startAgentProvisioned({
                lifecycleService: lifecycle(agent),
                agentId         : agent.id,
                managedRoot     : root,
                ensureRepo      : async () => ({repoPath: repoRoot}),
                prepareWorkspace: args => prepareManagedAgentWorkspace({...args, hydrateWorkspace: makeHydrate()}),
                agentosRuntimeRoot,
                nodePath        : NODE_PATH
            }),
            supplied = {...makeAgent('claude-code', {id: 'composed-a'}), metadata: {repo: {repoSlug: 'neomjs/neo', cloneUrl: 'https://github.com/neomjs/neo.git'}}},
            outside  = {...makeAgent('claude-code', {id: 'composed-b'}), metadata: {repo: {repoSlug: 'acme/app', cloneUrl: 'https://github.com/acme/app.git'}}},
            suppliedRoot = path.join(repoRoot, 'composed-a');

        await fs.mkdir(suppliedRoot, {recursive: true});
        await fs.writeFile(path.join(suppliedRoot, 'CLAUDE.md'), '# The repository\'s own\n');

        expect(await start(supplied, suppliedRoot)).toMatchObject({
            state           : 'running',
            seatInstructions: {state: 'repository-supplied', reason: 'the checkout carries CLAUDE.md'}
        });
        expect(await start(outside, path.join(repoRoot, 'composed-b'))).toMatchObject({
            state           : 'running',
            seatInstructions: {state: 'not-applicable', reason: 'the Skills source declares no repository \'acme/app\''}
        });
        expect(started).toEqual(['composed-a', 'composed-b'])
    });

    test('Codex Desktop gets AGENTS.md inside its nested Codex home', async () => {
        const result = await prepareManagedAgentWorkspace(options(onRepo(makeAgent('codex-desktop'), 'neomjs/neo-agent-institution')));

        expect(result.artifacts.at(-1)).toMatchObject({
            path  : path.join(result.instanceHome, 'codex-home', 'AGENTS.md'),
            status: WORKSPACE_ARTIFACT_STATES.CREATED
        })
    });

    test('a seat on a repository the Skills source does not declare starts without the file, and the result says why', async () => {
        const result = await prepareManagedAgentWorkspace(options(onRepo(makeAgent('codex'), 'acme/app')));

        expect(result.artifacts.map(artifact => artifact.ownedKeys)).not.toContain('seat instructions');
        await absent(path.join(result.instanceHome, 'AGENTS.md'));
        expect(result.seatInstructions).toEqual({state: 'not-applicable', reason: 'the Skills source declares no repository \'acme/app\''})
    })
});
