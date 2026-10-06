import {test, expect}                 from '@playwright/test';
import fs                             from 'node:fs/promises';
import os                             from 'node:os';
import path                           from 'node:path';
import {prepareManagedAgentWorkspace} from '../../../../../../ai/services/fleet/prepareManagedAgentWorkspace.mjs';
import {LAUNCHABLE_HARNESS_TYPES}     from '../../../../../../ai/services/fleet/deriveHarnessLaunchSpec.mjs';

/**
 * @summary A seat folder copied to another agents root, on real temp folders: every Fleet-owned file
 * that names the old home is re-derived for the new one when the preparation is told the previous root,
 * and only then. Each family that prepares a workspace, with resident and with remote MCP.
 */

const MCP_ENTRYPOINTS = [
    'ai/mcp/server/memory-core/mcp-server.mjs',
    'ai/mcp/server/knowledge-base/mcp-server.mjs',
    'ai/mcp/server/neural-link/mcp-server.mjs',
    'ai/mcp/server/github-workflow/mcp-server.mjs',
    'ai/mcp/server/gitlab-workflow/mcp-server.mjs'
];

// Antigravity prepares no workspace (its own test below), so it has nothing to relocate.
const PREPARED_HARNESS_TYPES = LAUNCHABLE_HARNESS_TYPES.filter(harnessType => harnessType !== 'antigravity');

const tenantTarget = (endpoint = 'https://tenant.example.com/agentos') => ({
    kind            : 'tenant',
    credentialEnvVar: 'NEO_MCP_REMOTE_TOKEN',
    resources       : {'memory-core': {url: `${endpoint}/mc/mcp`}, 'knowledge-base': {url: `${endpoint}/kb/mcp`}}
});

let root, runtime;

test.beforeEach(async () => {
    root    = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'relocated-seat-')));
    runtime = path.join(root, 'installed-neo');

    await fs.mkdir(path.join(runtime, 'ai/mcp/client'), {recursive: true});
    await fs.writeFile(path.join(runtime, 'ai/mcp/client/stdioToStreamableHttp.mjs'), '// installed Neo bridge entrypoint\n');

    for (const relativePath of MCP_ENTRYPOINTS) {
        await fs.mkdir(path.dirname(path.join(runtime, relativePath)), {recursive: true});
        await fs.writeFile(path.join(runtime, relativePath), '// installed canonical entrypoint\n')
    }
});

test.afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true})
});

/**
 * @summary The preparation a Start runs for one seat under one agents root: the checkout sits in the
 * seat's folder, the way the Fleet lays it out.
 */
function prepare({agent, agentsRoot, remote, previousInstanceRoot}) {
    return prepareManagedAgentWorkspace({
        agent,
        targetRepoRoot    : path.join(agentsRoot, agent.id, 'neomjs', 'neo'),
        instanceRoot      : agentsRoot,
        agentosRuntimeRoot: runtime,
        nodePath          : process.execPath,
        claudeConfigRoot  : path.join(root, 'operator'),
        hydrateWorkspace  : async ({projectRoot}) => { await fs.mkdir(projectRoot, {recursive: true}); return {hydrated: true} },
        residentMcpEnv    : Object.fromEntries(['memory-core', 'knowledge-base', 'neural-link', 'github-workflow'].map(key => [key, {NEO_PLANE_DATA_ROOT: path.join(root, 'plane')}])),
        ...(remote && {mcpTarget: tenantTarget()}),
        ...(agent.harnessType === 'claude-desktop' && {remoteMcpCapability: {
            harnessType     : 'claude-desktop',
            binaryPath      : '/Applications/Claude.app/Contents/MacOS/Claude',
            launchBinaryPath: '/Applications/Claude.app/Contents/MacOS/Claude',
            bridge          : {kind: 'neo-stdio-streamable-http', command: process.execPath, entrypoint: path.join(runtime, 'ai/mcp/client/stdioToStreamableHttp.mjs')}
        }}),
        ...(previousInstanceRoot && {previousInstanceRoot})
    })
}

/**
 * @summary Every file beneath a folder whose text names the given path, relative and sorted.
 */
async function filesNaming(dir, needle) {
    const hits = [];

    for (const entry of await fs.readdir(dir, {recursive: true, withFileTypes: true})) {
        if (!entry.isFile()) continue;

        const file = path.join(entry.parentPath, entry.name);

        if ((await fs.readFile(file, 'utf8')).includes(needle)) hits.push(path.relative(dir, file))
    }

    return hits.sort()
}

/**
 * @summary A seat prepared under root A, then its folder copied under each of the given roots.
 */
async function preparedAndCopied({harnessType, remote, copies}) {
    const
        agent = {id: 'seat-a', githubUsername: 'shared-login', harnessType, mcpServers: null},
        rootA = path.join(root, 'A');

    await prepare({agent, agentsRoot: rootA, remote});

    for (const copy of copies) {
        await fs.cp(path.join(rootA, agent.id), path.join(copy, agent.id), {recursive: true, verbatimSymlinks: true})
    }

    return {agent, rootA}
}

const outcomeOf = promise => promise.then(() => 'converged', error => error.code ?? error.name);

for (const harnessType of PREPARED_HARNESS_TYPES) {
    for (const remote of [false, true]) {
        // a local Codex seat renders no path of its seat into a Fleet-owned file
        const pinsItsHome = !(harnessType.startsWith('codex') && !remote);
        const label       = `${harnessType} seat (${remote ? 'remote' : 'resident'} MCP)`;

        test(`a copied ${label} converges at its new root when told the previous one, and only then`, async () => {
            const
                rootB          = path.join(root, 'B'),
                rootUntold     = path.join(root, 'untold'),
                {agent, rootA} = await preparedAndCopied({harnessType, remote, copies: [rootB, rootUntold]});

            expect(await outcomeOf(prepare({agent, agentsRoot: rootUntold, remote})), 'untold, a pinned old path is still a divergence').toBe(pinsItsHome ? 'FLEET_WORKSPACE_DIVERGENT' : 'converged');

            const first = await prepare({agent, agentsRoot: rootB, remote, previousInstanceRoot: rootA});

            expect(first.instanceHome.startsWith(path.join(rootB, agent.id) + path.sep)).toBe(true);
            // Claude Desktop backs up the operator's shared config before adding the new checkout's rows: a byte
            // copy of that file, which still lists the old checkout's rows for a rollback
            expect((await filesNaming(path.join(rootB, agent.id), rootA)).filter(file => !file.endsWith('.neo-fleet-claude-backup.json')), 'no Fleet-owned file names the old root').toEqual([]);
            expect(first.artifacts.some(artifact => artifact.status === 'UPDATED'), 'the move is reported as Fleet moving its own files').toBe(pinsItsHome);

            const second = await prepare({agent, agentsRoot: rootB, remote, previousInstanceRoot: rootA});

            expect(second.artifacts.filter(artifact => artifact.status !== 'MATCH'), 'a second Start converges as a match').toEqual([])
        });

        if (!pinsItsHome) continue;

        test(`a copied ${label} whose pinned file names neither home still refuses when told the previous root`, async () => {
            const
                rootB          = path.join(root, 'B'),
                {agent, rootA} = await preparedAndCopied({harnessType, remote, copies: [rootB]}),
                [edited]       = await filesNaming(path.join(rootB, agent.id), rootA),
                editedPath     = path.join(rootB, agent.id, edited);

            await fs.writeFile(editedPath, (await fs.readFile(editedPath, 'utf8')).replaceAll(rootA, path.join(root, 'elsewhere')));

            expect(await outcomeOf(prepare({agent, agentsRoot: rootB, remote, previousInstanceRoot: rootA})), edited).toBe('FLEET_WORKSPACE_DIVERGENT')
        })
    }
}

test('antigravity prepares no workspace, so a relocation has nothing to converge', async () => {
    const agent = {id: 'seat-a', githubUsername: 'shared-login', harnessType: 'antigravity', mcpServers: null};

    expect(await outcomeOf(prepare({agent, agentsRoot: path.join(root, 'A'), remote: false}))).toBe('FLEET_WORKSPACE_UNSUPPORTED')
});

test('a previous root equal to this one is no relocation, and a relative one is refused', async () => {
    const
        agent = {id: 'seat-a', githubUsername: 'shared-login', harnessType: 'claude-code', mcpServers: null},
        rootA = path.join(root, 'A');

    await prepare({agent, agentsRoot: rootA, remote: false});

    expect(await outcomeOf(prepare({agent, agentsRoot: rootA, remote: false, previousInstanceRoot: rootA}))).toBe('converged');
    expect(await outcomeOf(prepare({agent, agentsRoot: rootA, remote: false, previousInstanceRoot: 'relative/A'}))).toBe('FLEET_WORKSPACE_PREPARATION_FAILED')
});
