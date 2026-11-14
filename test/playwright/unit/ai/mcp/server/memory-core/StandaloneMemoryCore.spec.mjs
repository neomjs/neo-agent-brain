import {setup}                        from '../../../../../setup.mjs';

setup();

import {test, expect}           from '@playwright/test';
import * as acorn               from 'acorn';
import {Client}                 from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport}   from '@modelcontextprotocol/sdk/client/stdio.js';
import {execFileSync}           from 'node:child_process';
import fs                       from 'node:fs';
import os                       from 'node:os';
import path                     from 'node:path';
import {fileURLToPath}          from 'node:url';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import InstanceManager          from 'neo.mjs/src/manager/Instance.mjs';
import {derivePlaneMemberPaths} from '../../../../../../../ai/planeConfig.mjs';
import {appendWalMemory}        from '../../../../../../../ai/services/memory-core/helpers/memoryWalStore.mjs';
import StandaloneSqliteIndex    from '../../../../../../../ai/services/memory-core/helpers/standaloneSqliteIndex.mjs';
import {
    normalizeGitRemoteOrigin,
    resolveStandaloneWorkspaceKey
}                                     from '../../../../../../../ai/services/memory-core/helpers/standaloneWorkspaceKey.mjs';
import {
    DEFAULT_STANDALONE_PLANE_ID,
    launch,
    parseStandaloneArgs,
    standalonePlacement
}                                     from '../../../../../../../ai/mcp/server/memory-core/standalone.mjs';
import * as standaloneConfigModule     from '../../../../../../../ai/mcp/server/memory-core/standaloneConfigBase.mjs';
import StandaloneConfigBase, {
    STANDALONE_PLANE_MEMBER_PATHS,
    createStandaloneConfig,
    defaultStandaloneDataRoot
}                                     from '../../../../../../../ai/mcp/server/memory-core/standaloneConfigBase.mjs';
import StandaloneServer            from '../../../../../../../ai/mcp/server/memory-core/standaloneServer.mjs';
import {STANDALONE_APPROVED_TOOLS} from '../../../../../../../ai/mcp/server/memory-core/standaloneToolService.mjs';

void core;
void InstanceManager;

const STANDALONE_BIN = fileURLToPath(
    new URL('../../../../../../../ai/mcp/server/memory-core/standalone.mjs', import.meta.url)
);
const REPO_ROOT     = path.resolve(path.dirname(STANDALONE_BIN), '../../../..');
const ADR_0019_PATH = path.join(REPO_ROOT, 'learn/agentos/decisions/0019-aiconfig-reactive-provider-ssot.md');

/**
 * @summary Creates a temporary test directory removed by the caller's cleanup block.
 * @param {String} prefix Directory prefix.
 * @returns {String}
 */
function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @summary Walks static and literal dynamic ESM imports recursively within `ai/` to collect bare package and file specifiers.
 * @param {String[]} entryFiles Absolute entry file paths.
 * @returns {{bareSpecifiers: Set<String>, visitedFiles: Set<String>}}
 */
function collectTransitiveImportClosure(entryFiles) {
    const visitedFiles   = new Set();
    const bareSpecifiers = new Set();
    const queue          = entryFiles.map(item => path.resolve(item));

    const recordSpecifier = (fromFile, specifier) => {
        if (typeof specifier !== 'string' || !specifier) {
            return;
        }
        if (specifier.startsWith('.')) {
            const candidate = path.resolve(path.dirname(fromFile), specifier);
            if (fs.existsSync(candidate) && !visitedFiles.has(candidate)) {
                queue.push(candidate);
            }
            return;
        }
        bareSpecifiers.add(specifier);
    };

    const walkAst = (node, fromFile) => {
        if (!node || typeof node !== 'object') {
            return;
        }
        if (
            (node.type === 'ImportDeclaration' ||
                node.type === 'ExportNamedDeclaration' ||
                node.type === 'ExportAllDeclaration') &&
            node.source?.type === 'Literal'
        ) {
            recordSpecifier(fromFile, node.source.value);
        } else if (node.type === 'ImportExpression' && node.source?.type === 'Literal') {
            recordSpecifier(fromFile, node.source.value);
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') {
                continue;
            }
            if (Array.isArray(value)) {
                value.forEach(child => walkAst(child, fromFile));
            } else if (value && typeof value === 'object') {
                walkAst(value, fromFile);
            }
        }
    };

    while (queue.length > 0) {
        const current = queue.shift();
        if (visitedFiles.has(current) || !current.endsWith('.mjs') || !fs.existsSync(current)) {
            continue;
        }
        visitedFiles.add(current);
        const source = fs.readFileSync(current, 'utf8');
        const ast    = acorn.parse(source, {
            allowHashBang: true,
            ecmaVersion  : 'latest',
            sourceType   : 'module'
        });
        walkAst(ast, current);
    }

    return {bareSpecifiers, visitedFiles};
}

/**
 * @summary Connects a real MCP SDK `Client` to `standalone.mjs` over stdio against an isolated temp plane root.
 * @param {Object} options
 * @param {String} options.dataRoot Isolated plane data root.
 * @param {String} [options.workspace='test-org/standalone-app'] Explicit workspace slug or path.
 * @param {String} [options.sessionId] Optional default session ID.
 * @returns {Promise<{client: Client, close: Function, transport: StdioClientTransport}>}
 */
async function connectStandaloneStdioClient({
    dataRoot,
    workspace = 'test-org/standalone-app',
    sessionId
}) {
    const cliArgs = [STANDALONE_BIN, '--data-root', dataRoot, '--workspace', workspace];
    if (sessionId) {
        cliArgs.push('--session-id', sessionId);
    }

    const transport = new StdioClientTransport({
        command: process.execPath,
        args   : cliArgs,
        cwd    : REPO_ROOT,
        stderr : 'pipe'
    });

    const client = new Client({
        name   : 'standalone-memory-core-spec-client',
        version: '1.0.0'
    });

    await client.connect(transport);

    return {
        client,
        transport,
        async close() {
            await client.close();
        }
    };
}

test.describe('Standalone Memory Core MCP Server', () => {
    test('AC-1: standaloneConfigBase derives exact 3 plane members without Tier-1 inheritance, boots coherently, fails closed on partial relocation, and records ADR 0019 §10.7', async () => {
        const derivedPaths = derivePlaneMemberPaths({
            descriptorData: StandaloneConfigBase.config.data,
            anchor        : defaultStandaloneDataRoot
        });

        expect(derivedPaths).toEqual([...STANDALONE_PLANE_MEMBER_PATHS]);
        expect(new Set(derivedPaths)).toEqual(new Set(['memoryWal.dirProd', 'standaloneIndexPath', 'logPath']));

        const rawProvider = Neo.create(StandaloneConfigBase);
        try {
            expect(rawProvider.getParent()).toBeNull();
        } finally {
            rawProvider.destroy();
        }

        const tempRoot         = makeTempDir('mc-standalone-ac1-');
        const badTarget        = makeTempDir('mc-standalone-partial-');
        const secondTempHome   = makeTempDir('mc-standalone-fake-home-');
        const serveHome        = makeTempDir('mc-standalone-serve-home-');
        const foreignPlaneRoot = makeTempDir('mc-standalone-foreign-plane-');
        const badTransportCfg  = path.join(tempRoot, 'bad-transport.json');

        try {
            // RA-4a: DEFAULT_STANDALONE_PLANE_ID is exported from standalone.mjs only; config leaf defaults derive from standalonePlacement.
            expect('DEFAULT_STANDALONE_PLANE_ID' in standaloneConfigModule).toBe(false);
            const canonicalPlacement = standalonePlacement();
            expect(StandaloneConfigBase.config.data.plane.id.default).toBe(canonicalPlacement.NEO_PLANE_ID);
            expect(StandaloneConfigBase.config.data.plane.dataRoot.default).toBe(canonicalPlacement.NEO_PLANE_DATA_ROOT);
            expect(StandaloneConfigBase.config.data.memoryWal.dirProd.default).toBe(canonicalPlacement.NEO_MEMORY_WAL_DIR);
            expect(StandaloneConfigBase.config.data.standaloneIndexPath.default).toBe(canonicalPlacement.NEO_MC_STANDALONE_INDEX_PATH);
            expect(StandaloneConfigBase.config.data.logPath.default).toBe(canonicalPlacement.NEO_MC_LOG_PATH);
            expect(StandaloneConfigBase.config.data.transport.env).toBeNull();

            const placement = standalonePlacement({
                homedir  : '/Users/example',
                dataRoot : tempRoot,
                workspace: 'acme/widget'
            });

            expect(placement).toEqual({
                NEO_PLANE_ID                : DEFAULT_STANDALONE_PLANE_ID,
                NEO_PLANE_DATA_ROOT         : path.resolve(tempRoot),
                NEO_MEMORY_WAL_DIR          : path.join(path.resolve(tempRoot), 'wal'),
                NEO_MC_STANDALONE_INDEX_PATH: path.join(path.resolve(tempRoot), 'index.sqlite'),
                NEO_MC_LOG_PATH             : path.join(path.resolve(tempRoot), 'logs'),
                NEO_MC_WORKSPACE            : 'acme/widget'
            });

            // Launcher placement wins over any inherited NEO_PLANE_DATA_ROOT from another deployment.
            const spawnCalls = [];
            launch({
                argv   : ['--workspace', 'acme/widget'],
                env    : {NEO_PLANE_DATA_ROOT: '/foreign/deployment/.neo-ai-data', PATH: '/usr/bin'},
                homedir: tempRoot,
                spawnFn: (cmd, args, opts) => {
                    spawnCalls.push({cmd, args, opts});
                    return {};
                }
            });
            expect(spawnCalls).toHaveLength(1);
            expect(spawnCalls[0].opts.env.NEO_PLANE_DATA_ROOT).toBe(path.join(tempRoot, '.neo-ai', 'memory-core'));
            expect(spawnCalls[0].opts.env.NEO_PLANE_ID).toBe(DEFAULT_STANDALONE_PLANE_ID);

            // Transport stays pinned to 'stdio' even when NEO_TRANSPORT is set in envOverrides.
            const isolatedCfg = createStandaloneConfig({
                envOverrides: {
                    ...placement,
                    NEO_TRANSPORT: 'streamable-http'
                }
            });
            expect(isolatedCfg.transport).toBe('stdio');

            const server = Neo.create(StandaloneServer, {
                aiConfig     : isolatedCfg,
                connectOnBoot: false
            });

            try {
                await server.ready();
                expect(server.getPlaneMembers()).toHaveLength(3);
                expect(fs.existsSync(path.join(tempRoot, 'index.sqlite'))).toBe(true);
                // Shared createLogger writes daily mc-standalone-YYYY-MM-DD.log inside the logPath directory.
                const logFiles = fs.readdirSync(path.join(tempRoot, 'logs'));
                expect(logFiles.some(name => /^mc-standalone-\d{4}-\d{2}-\d{2}\.log$/.test(name))).toBe(true);
            } finally {
                server.destroy();
                isolatedCfg.destroy();
            }

            // Non-stdio transport overlay fails closed at boot.
            fs.writeFileSync(badTransportCfg, JSON.stringify({transport: 'streamable-http'}), 'utf8');
            const badTransportProvider = createStandaloneConfig({envOverrides: placement});
            const badTransportServer   = Neo.create(StandaloneServer, {
                aiConfig     : badTransportProvider,
                configFile   : badTransportCfg,
                connectOnBoot: false
            });
            try {
                await expect(badTransportServer.ready()).rejects.toThrow(/supports only "stdio" transport/);
            } finally {
                badTransportServer.destroy();
                badTransportProvider.destroy();
            }

            // Direct `--serve` entry path beats inherited foreign NEO_PLANE_DATA_ROOT / NEO_MEMORY_WAL_DIR / NEO_TRANSPORT.
            const foreignWalDir  = path.join(foreignPlaneRoot, 'memory-wal');
            const foreignLogDir  = path.join(foreignPlaneRoot, 'logs');
            const serveTransport = new StdioClientTransport({
                command: process.execPath,
                args   : [STANDALONE_BIN, '--serve', '--workspace', 'probe/ws'],
                cwd    : REPO_ROOT,
                stderr : 'pipe',
                env    : {
                    ...process.env,
                    HOME               : serveHome,
                    NEO_PLANE_ID       : 'neo-local-canonical',
                    NEO_PLANE_DATA_ROOT: foreignPlaneRoot,
                    NEO_MEMORY_WAL_DIR : foreignWalDir,
                    NEO_MC_LOG_PATH    : foreignLogDir,
                    NEO_TRANSPORT      : 'streamable-http'
                }
            });
            const serveClient = new Client({name: 'standalone-serve-probe', version: '1.0.0'});
            await serveClient.connect(serveTransport);
            try {
                const serveHealth = (await serveClient.callTool({name: 'healthcheck', arguments: {}})).structuredContent;
                expect(serveHealth.plane.id).toBe(DEFAULT_STANDALONE_PLANE_ID);
                expect(serveHealth.plane.dataRoot).toBe(path.join(serveHome, '.neo-ai', 'memory-core'));
                expect(serveHealth.workspace).toBe('probe/ws');

                const serveWrite = await serveClient.callTool({
                    name     : 'add_memory',
                    arguments: {
                        prompt         : 'Direct --serve entry path isolation check.',
                        decisionContext: 'Verify standalonePlacement overrides inherited foreign NEO_MEMORY_WAL_DIR.',
                        response       : 'Wrote under standalone root without touching foreign plane.',
                        agent          : 'free-text-agent'
                    }
                });
                expect(serveWrite.isError).toBeFalsy();
            } finally {
                await serveClient.close();
            }
            expect(fs.existsSync(foreignWalDir)).toBe(false);
            expect(fs.existsSync(foreignLogDir)).toBe(false);
            expect(fs.existsSync(path.join(serveHome, '.neo-ai', 'memory-core', 'wal'))).toBe(true);

            // Partial relocation (dataRoot moved to badTarget while standaloneIndexPath stays on its default under secondTempHome —
            // outside badTarget, still resolved === default so assertPlaneMemberCoherence flags it, and never touching real ~/.neo-ai).
            const partialCfg = createStandaloneConfig({
                homedir     : secondTempHome,
                envOverrides: {
                    NEO_PLANE_ID       : DEFAULT_STANDALONE_PLANE_ID,
                    NEO_PLANE_DATA_ROOT: badTarget,
                    NEO_MEMORY_WAL_DIR : path.join(badTarget, 'wal'),
                    NEO_MC_LOG_PATH    : path.join(badTarget, 'logs')
                }
            });
            expect(partialCfg.standaloneIndexPath).toBe(path.join(secondTempHome, '.neo-ai', 'memory-core', 'index.sqlite'));

            const brokenServer = Neo.create(StandaloneServer, {
                aiConfig     : partialCfg,
                connectOnBoot: false
            });

            try {
                await expect(brokenServer.ready()).rejects.toThrow(/assertPlaneMemberCoherence/);
                expect(fs.existsSync(path.join(badTarget, 'logs'))).toBe(false);
                expect(fs.existsSync(path.join(secondTempHome, '.neo-ai'))).toBe(false);
            } finally {
                brokenServer.destroy();
                partialCfg.destroy();
            }

            const adrText = fs.readFileSync(ADR_0019_PATH, 'utf8');
            expect(adrText).toContain('Standalone Memory Core package (`npx`; its `bin` is `ai/mcp/server/memory-core/standalone.mjs`)');
            expect(adrText).toContain('neo-standalone-memory-core');
            expect(adrText).toContain('NEO_MC_STANDALONE_INDEX_PATH');
        } finally {
            fs.rmSync(tempRoot, {recursive: true, force: true});
            fs.rmSync(badTarget, {recursive: true, force: true});
            fs.rmSync(secondTempHome, {recursive: true, force: true});
            fs.rmSync(serveHome, {recursive: true, force: true});
            fs.rmSync(foreignPlaneRoot, {recursive: true, force: true});
        }
    });

    test('AC-2: standaloneWorkspaceKey follows explicit-slug -> git-remote -> git-toplevel -> cwd and healthcheck reports plane, workspace, and storage gauges', async () => {
        expect(normalizeGitRemoteOrigin('git@github.com:NeoMJS/Neo.git')).toBe('github.com/neomjs/neo');
        expect(normalizeGitRemoteOrigin('https://user:secret-token@github.com/NeoMJS/Neo.git/')).toBe('github.com/neomjs/neo');
        expect(normalizeGitRemoteOrigin('ssh://git@github.com:22/NeoMJS/Neo.git')).toBe('github.com/neomjs/neo');
        expect(normalizeGitRemoteOrigin('https://gitlab.example.org:8443/Group/Sub/Repo.git')).toBe('gitlab.example.org:8443/group/sub/repo');

        const tempDir     = makeTempDir('mc-standalone-ws-');
        const realTempDir = fs.realpathSync(tempDir);

        try {
            // 1. explicit-slug wins over git-remote
            const slugResult = resolveStandaloneWorkspaceKey({
                explicitWorkspace: 'custom-team/service-a',
                cwd              : tempDir,
                execGit          : () => 'git@github.com:NeoMJS/Neo.git'
            });
            expect(slugResult).toEqual({
                workspace      : 'custom-team/service-a',
                workspaceSource: 'explicit-slug'
            });

            // 2. git-remote wins when explicitWorkspace is omitted or is a filesystem path ('.')
            const remoteFromDot = resolveStandaloneWorkspaceKey({
                explicitWorkspace: '.',
                cwd              : tempDir,
                execGit          : args => args.includes('get-url') ? 'https://tok@github.com/NeoMJS/Neo-Agent-Brain.git/' : null
            });
            expect(remoteFromDot).toEqual({
                workspace      : 'github.com/neomjs/neo-agent-brain',
                workspaceSource: 'git-remote'
            });

            // 3. git-toplevel wins when origin remote is absent
            const topLevelResult = resolveStandaloneWorkspaceKey({
                cwd    : tempDir,
                execGit: args => args.includes('--show-toplevel') ? tempDir : null
            });
            expect(topLevelResult).toEqual({
                workspace      : realTempDir,
                workspaceSource: 'git-toplevel'
            });

            // 4. cwd fallback outside git
            const cwdResult = resolveStandaloneWorkspaceKey({
                cwd    : tempDir,
                execGit: () => null
            });
            expect(cwdResult).toEqual({
                workspace      : realTempDir,
                workspaceSource: 'cwd'
            });

            // Verify healthcheck payload contract on StandaloneServer
            const dataRoot = makeTempDir('mc-standalone-hc-');
            const cfg      = createStandaloneConfig({
                envOverrides: standalonePlacement({dataRoot})
            });
            const server = Neo.create(StandaloneServer, {
                aiConfig     : cfg,
                connectOnBoot: false,
                cwd          : tempDir,
                execGit      : args => args.includes('get-url') ? 'git@github.com:NeoMJS/Neo.git' : null
            });

            try {
                await server.ready();
                const health = await server.getToolService().callTool('healthcheck', {});

                expect(health.status).toBe('healthy');
                expect(health.mode).toBe('standalone');
                expect(health.plane).toEqual({
                    id      : DEFAULT_STANDALONE_PLANE_ID,
                    dataRoot: path.resolve(dataRoot)
                });
                expect(health.workspace).toBe('github.com/neomjs/neo');
                expect(health.workspaceSource).toBe('git-remote');
                expect(health.storage).toEqual({
                    walBytes       : 0,
                    indexBytes     : expect.any(Number),
                    memoryCount    : 0,
                    retentionPolicy: 'none-v1'
                });
                expect(health.storage.indexBytes).toBeGreaterThan(0);
            } finally {
                server.destroy();
                cfg.destroy();
                fs.rmSync(dataRoot, {recursive: true, force: true});
            }
        } finally {
            fs.rmSync(tempDir, {recursive: true, force: true});
        }
    });

    test('AC-3: stdio MCP surface exposes exact 6 tools, fails closed on non-profile tools, emits workflow instructions, and imports zero heavy dependencies', async () => {
        const entryFiles = [
            STANDALONE_BIN,
            path.join(REPO_ROOT, 'ai/mcp/server/memory-core/standaloneServer.mjs'),
            path.join(REPO_ROOT, 'ai/mcp/server/memory-core/standaloneToolService.mjs'),
            path.join(REPO_ROOT, 'ai/mcp/server/memory-core/standaloneConfigBase.mjs'),
            path.join(REPO_ROOT, 'ai/services/memory-core/helpers/standaloneSqliteIndex.mjs'),
            path.join(REPO_ROOT, 'ai/services/memory-core/helpers/standaloneWorkspaceKey.mjs')
        ];

        const {bareSpecifiers, visitedFiles} = collectTransitiveImportClosure(entryFiles);
        const visitedBasenames               = [...visitedFiles].map(file => path.basename(file));

        expect(bareSpecifiers.has('better-sqlite3')).toBe(false);
        expect(bareSpecifiers.has('chromadb')).toBe(false);
        expect(bareSpecifiers.has('@chroma-core/default-embed')).toBe(false);
        expect(visitedBasenames).not.toContain('GraphService.mjs');
        expect(visitedBasenames).not.toContain('MemoryService.mjs');
        expect(visitedBasenames).not.toContain('SessionService.mjs');
        expect(visitedBasenames).not.toContain('ChromaManager.mjs');

        expect(parseStandaloneArgs([
            '--serve',
            '--workspace', 'org/repo',
            '--data-root=/tmp/mc',
            '--session-id', 'sess-42',
            '--config=/tmp/custom.json',
            '--debug'
        ])).toMatchObject({
            configFile: '/tmp/custom.json',
            dataRoot  : '/tmp/mc',
            debug     : true,
            mode      : 'serve',
            sessionId : 'sess-42',
            workspace : 'org/repo'
        });

        const helpOut = execFileSync(process.execPath, [STANDALONE_BIN, '--help'], {encoding: 'utf8'});
        expect(helpOut).toContain('Usage: neo-memory-core');
        expect(helpOut).toContain('--data-root');

        const dataRoot = makeTempDir('mc-standalone-stdio-ac3-');
        const session  = await connectStandaloneStdioClient({
            dataRoot,
            workspace: 'acme/standalone-suite'
        });

        try {
            const instructions = session.client.getInstructions() || '';
            expect(instructions).toContain('query_recent_turns');
            expect(instructions).toContain('add_memory');

            const listed    = await session.client.listTools();
            const toolNames = listed.tools.map(tool => tool.name);

            expect(toolNames).toHaveLength(6);
            expect(toolNames).toEqual([...STANDALONE_APPROVED_TOOLS]);

            for (const forbiddenTool of ['query_summaries', 'list_messages', 'delete_message']) {
                const denied = await session.client.callTool({
                    name     : forbiddenTool,
                    arguments: {}
                });
                expect(denied.isError).toBe(true);
                expect(denied.structuredContent?.code).toBe('POLICY_REFUSED');
            }

            const handbookAllowed = await session.client.callTool({
                name     : 'get_mcp_tool_handbook',
                arguments: {toolId: 'query_raw_memories'}
            });
            expect(handbookAllowed.isError).toBeFalsy();
            expect(handbookAllowed.structuredContent?.found).toBe(true);
            expect(handbookAllowed.structuredContent?.inputSchema?.properties?.workspace?.type).toBe('string');

            const handbookDenied = await session.client.callTool({
                name     : 'get_mcp_tool_handbook',
                arguments: {toolId: 'delete_message'}
            });
            expect(handbookDenied.structuredContent?.found).toBe(false);
            expect(handbookDenied.structuredContent?.code).toBe('POLICY_REFUSED');
        } finally {
            await session.close();
            fs.rmSync(dataRoot, {recursive: true, force: true});
        }
    });

    test('AC-4: persists unmarked canonical WAL across stdio sessions, serves FTS5 BM25 recall without distance/compositeScore, isolates workspaces, catches up concurrent WAL appends via byte watermark, and rebuilds deleted index.sqlite losslessly', async () => {
        const dataRoot  = makeTempDir('mc-standalone-ac4-');
        const walDir    = path.join(dataRoot, 'wal');
        const indexPath = path.join(dataRoot, 'index.sqlite');

        try {
            // Session 1: write two episodic memories in workspace-alpha over real stdio MCP.
            const session1 = await connectStandaloneStdioClient({
                dataRoot,
                workspace: 'org/workspace-alpha',
                sessionId: 'session-alpha-1'
            });

            let firstWriteReceipt;
            try {
                const res1 = await session1.client.callTool({
                    name     : 'add_memory',
                    arguments: {
                        prompt         : 'Configure standalone SQLite FTS5 lexical memory index over canonical WAL segments.',
                        decisionContext: 'Selected node:sqlite DatabaseSync with WAL journal mode and unicode61 FTS5 tokenizer for ADR-0019 §10.7 compliance.',
                        response       : 'Implemented byte-watermark sync and verified zero Chroma or native C++ addon dependencies.',
                        agent          : 'codex-cli',
                        model          : 'gpt-5',
                        amountToolCalls: 4,
                        toolsUsed      : ['read_file', 'write_file']
                    }
                });
                expect(res1.isError).toBeFalsy();
                firstWriteReceipt = res1.structuredContent;
                expect(firstWriteReceipt.persisted).toBe(true);
                expect(firstWriteReceipt.sessionId).toBe('session-alpha-1');
                expect(firstWriteReceipt.workspace).toBe('org/workspace-alpha');

                const res2 = await session1.client.callTool({
                    name     : 'add_memory',
                    arguments: {
                        prompt         : 'Verify deterministic git remote workspace normalization.',
                        decisionContext: 'Normalized SSH and HTTPS origin URLs identically to lowercase host/owner/repo.',
                        response       : 'Added precedence chain explicit-slug -> git-remote -> git-toplevel -> cwd.'
                    }
                });
                expect(res2.isError).toBeFalsy();
            } finally {
                await session1.close();
            }

            // Inspect WAL directory: canonical wal-YYYY-MM-DD.jsonl present; .embedded.jsonl and .graph.jsonl strictly absent!
            const walEntries = fs.readdirSync(walDir);
            const walFiles   = walEntries.filter(name => /^wal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
            expect(walFiles.length).toBeGreaterThanOrEqual(1);
            expect(walEntries.some(name => name.endsWith('.embedded.jsonl'))).toBe(false);
            expect(walEntries.some(name => name.endsWith('.graph.jsonl'))).toBe(false);

            const walLines = fs.readFileSync(path.join(walDir, walFiles[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            expect(walLines).toHaveLength(2);
            expect(walLines[0].workspace).toBe('org/workspace-alpha');
            expect(walLines[0].workspaceSource).toBe('explicit-slug');
            expect(walLines[0].graphProjectionVersion).toBe(1);
            // Keep metadata.agent for display, omit unverified agentIdentity until promotion's rostered --owner stamps it.
            expect(walLines[0].metadata.agent).toBe('codex-cli');
            expect('agentIdentity' in walLines[0]).toBe(false);
            expect('agentIdentity' in (walLines[0].graphProjection?.memoryProperties || {})).toBe(false);

            // Write one memory in a second workspace ('org/workspace-beta') to verify default workspace isolation.
            const sessionBeta = await connectStandaloneStdioClient({
                dataRoot,
                workspace: 'org/workspace-beta',
                sessionId: 'session-beta-1'
            });
            try {
                await sessionBeta.client.callTool({
                    name     : 'add_memory',
                    arguments: {
                        prompt         : 'Unrelated beta workspace deployment note.',
                        decisionContext: 'Scoped strictly to workspace-beta.',
                        response       : 'Should never leak into workspace-alpha default queries.'
                    }
                });
            } finally {
                await sessionBeta.close();
            }

            // Session 2: reconnect in workspace-alpha and verify cross-session recall + live concurrent WAL catch-up.
            const session2 = await connectStandaloneStdioClient({
                dataRoot,
                workspace: 'org/workspace-alpha',
                sessionId: 'session-alpha-2'
            });

            try {
                const recentSummary = (await session2.client.callTool({
                    name     : 'query_recent_turns',
                    arguments: {limit: 10, detail: 'summary'}
                })).structuredContent;

                expect(recentSummary.count).toBe(2);
                expect(recentSummary.summaryFallback).toBe(true);
                expect(recentSummary.turns[0].summaryFallback).toBe(true);
                expect(recentSummary.turns[0].summary.length).toBeGreaterThan(10);
                expect(recentSummary.turns.every(turn => turn.workspace === 'org/workspace-alpha')).toBe(true);

                // Opt-in cross-workspace recall with workspace: '*'
                const recentAll = (await session2.client.callTool({
                    name     : 'query_recent_turns',
                    arguments: {workspace: '*', limit: 10, detail: 'full'}
                })).structuredContent;
                expect(recentAll.count).toBe(3);

                // Lexical FTS5 search including punctuation & boolean operator tokens (must never throw FTS5 syntax error!)
                const searchHits = (await session2.client.callTool({
                    name     : 'query_raw_memories',
                    arguments: {
                        query   : 'ADR-0019 §10.7 "unicode61" wal:segments? AND NOT broken (v1)',
                        nResults: 5,
                        detail  : 'full'
                    }
                })).structuredContent;

                expect(searchHits.retrievalMode).toBe('lexical-fts5');
                expect(searchHits.count).toBeGreaterThanOrEqual(1);
                const topHit = searchHits.results[0];
                expect(topHit.id).toBe(firstWriteReceipt.id);
                expect(typeof topHit.bm25Score).toBe('number');
                expect(topHit.lexicalRankScore).toBeGreaterThan(0);
                expect(topHit.lexicalRankScore).toBeLessThanOrEqual(1);
                expect(topHit.summaryFallback).toBe(true);
                expect('distance' in topHit).toBe(false);
                expect('compositeScore' in topHit).toBe(false);

                // lexicalRankScore (|bm25| / (1 + |bm25|)) rises with relevance and never rises down the ranked list.
                const sessionRank = await connectStandaloneStdioClient({
                    dataRoot,
                    workspace: 'org/workspace-rank',
                    sessionId: 'session-rank-1'
                });
                try {
                    await sessionRank.client.callTool({
                        name     : 'add_memory',
                        arguments: {
                            prompt         : 'Weak mention of quaternionic in a long unrelated maintenance log entry with many filler words.',
                            decisionContext: 'Routine filesystem cleanup across alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima.',
                            response       : 'Completed routine archival sweep across mike november oscar papa quebec romeo sierra tango uniform victor whiskey.'
                        }
                    });
                    await sessionRank.client.callTool({
                        name     : 'add_memory',
                        arguments: {
                            prompt         : 'Medium quaternionic algebra notes for camera rotation interpolation.',
                            decisionContext: 'Compared Euler gimbal lock against quaternionic slerp normalization across viewport frames.',
                            response       : 'Verified unit norm preservation under repeated frame composition.'
                        }
                    });
                    await sessionRank.client.callTool({
                        name     : 'add_memory',
                        arguments: {
                            prompt         : 'Quaternionic rotor derivation: quaternionic multiplication and quaternionic conjugate.',
                            decisionContext: 'Quaternionic basis products stabilize quaternionic orientation updates.',
                            response       : 'Shipped quaternionic slerp kernel.'
                        }
                    });

                    const ranked = (await sessionRank.client.callTool({
                        name     : 'query_raw_memories',
                        arguments: {query: 'quaternionic', nResults: 10}
                    })).structuredContent;

                    expect(ranked.count).toBe(3);
                    expect(ranked.results[0].lexicalRankScore).toBeGreaterThan(ranked.results[2].lexicalRankScore);
                    for (let i = 0; i < ranked.results.length - 1; i++) {
                        expect(ranked.results[i].bm25Score).toBeLessThanOrEqual(ranked.results[i + 1].bm25Score);
                        expect(ranked.results[i].lexicalRankScore).toBeGreaterThanOrEqual(ranked.results[i + 1].lexicalRankScore);
                    }
                } finally {
                    await sessionRank.close();
                }

                // Punctuation-only query with zero alphanumeric tokens returns empty array cleanly
                const emptySearch = (await session2.client.callTool({
                    name     : 'query_raw_memories',
                    arguments: {query: '::: ??? --- "/"'}
                })).structuredContent;
                expect(emptySearch.count).toBe(0);
                expect(emptySearch.results).toEqual([]);

                // Chronological session recall
                const sessionRecall = (await session2.client.callTool({
                    name     : 'get_session_memories',
                    arguments: {sessionId: 'session-alpha-1'}
                })).structuredContent;
                expect(sessionRecall.count).toBe(2);
                expect(sessionRecall.memories[0].id).toBe(firstWriteReceipt.id);

                // Live concurrent WAL append while Session 2 is ALREADY open (no restart!):
                await appendWalMemory({
                    id             : 'concurrent-external-wal-1',
                    timestamp      : Date.now() + 50,
                    workspace      : 'org/workspace-alpha',
                    workspaceSource: 'explicit-slug',
                    metadata       : {
                        prompt         : 'Concurrent external harness wrote hotfix quorum telemetry.',
                        thought        : 'Appended directly to WAL while Session 2 SQLite handle was open.',
                        response       : 'Caught up incrementally via stat.size byte watermark.',
                        sessionId      : 'session-external-live',
                        type           : 'agent-interaction',
                        workspace      : 'org/workspace-alpha',
                        workspaceSource: 'explicit-slug'
                    },
                    document              : 'Concurrent external harness wrote hotfix quorum telemetry.',
                    graphProjectionVersion: 1
                }, {
                    dir    : walDir,
                    planeId: DEFAULT_STANDALONE_PLANE_ID
                });

                const liveSearch = (await session2.client.callTool({
                    name     : 'query_raw_memories',
                    arguments: {query: 'hotfix quorum telemetry'}
                })).structuredContent;
                expect(liveSearch.count).toBe(1);
                expect(liveSearch.results[0].id).toBe('concurrent-external-wal-1');

                const healthAfterLiveAppend = (await session2.client.callTool({
                    name     : 'healthcheck',
                    arguments: {}
                })).structuredContent;
                expect(healthAfterLiveAppend.storage.memoryCount).toBe(7);
                expect(healthAfterLiveAppend.storage.walBytes).toBeGreaterThan(0);
            } finally {
                await session2.close();
            }

            // Inspect index_meta watermarks, then delete index.sqlite (+ -wal/-shm) and verify lossless rebuild from WAL!
            const inspector = new StandaloneSqliteIndex({indexPath, walDir});
            try {
                const meta          = inspector.getIndexMeta();
                const latestWalFile = fs.readdirSync(walDir).filter(name => /^wal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().at(-1);
                const latestWalSize = fs.statSync(path.join(walDir, latestWalFile)).size;

                expect(meta.latestSegmentKey).toBe(latestWalFile.slice(4, -6));
                expect(Number(meta.latestSegmentBytes)).toBe(latestWalSize);
            } finally {
                inspector.close();
            }

            for (const suffix of ['', '-wal', '-shm']) {
                fs.rmSync(`${indexPath}${suffix}`, {force: true});
            }
            expect(fs.existsSync(indexPath)).toBe(false);

            const rebuiltIndex = new StandaloneSqliteIndex({indexPath, walDir});
            try {
                expect(rebuiltIndex.getStorageStats().memoryCount).toBe(7);
                const rebuiltHits = rebuiltIndex.queryRawMemories({
                    query    : 'hotfix quorum telemetry',
                    workspace: 'org/workspace-alpha'
                });
                expect(rebuiltHits.count).toBe(1);
                expect(rebuiltHits.results[0].id).toBe('concurrent-external-wal-1');

                // Partial trailing JSONL write without newline must NOT advance watermark until completed with '\n'
                const latestWalFile = fs.readdirSync(walDir).filter(name => /^wal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().at(-1);
                const latestWalPath = path.join(walDir, latestWalFile);
                const preSize       = fs.statSync(latestWalPath).size;
                const partialRecord = JSON.stringify({
                    id             : 'partial-trailing-wal-1',
                    timestamp      : Date.now() + 100,
                    workspace      : 'org/workspace-alpha',
                    workspaceSource: 'explicit-slug',
                    metadata       : {
                        prompt   : 'Partial trailing atomic line test.',
                        thought  : 'Buffered before newline arrives.',
                        response : 'Indexed only once newline completes the JSONL record.',
                        sessionId: 'session-partial'
                    }
                });

                fs.appendFileSync(latestWalPath, partialRecord, 'utf8');
                expect(rebuiltIndex.getStorageStats().memoryCount).toBe(7);
                expect(Number(rebuiltIndex.getIndexMeta().latestSegmentBytes)).toBe(preSize);

                fs.appendFileSync(latestWalPath, '\n', 'utf8');
                expect(rebuiltIndex.getStorageStats().memoryCount).toBe(8);
                expect(Number(rebuiltIndex.getIndexMeta().latestSegmentBytes)).toBe(fs.statSync(latestWalPath).size);
            } finally {
                rebuiltIndex.close();
            }
        } finally {
            fs.rmSync(dataRoot, {recursive: true, force: true});
        }
    });
});
