import {test, expect}         from '@playwright/test';
import {Client}               from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {execFileSync}         from 'node:child_process';
import crypto                 from 'node:crypto';
import fs                     from 'node:fs';
import os                     from 'node:os';
import path                   from 'node:path';
import {fileURLToPath}        from 'node:url';
import {
    FORBIDDEN_RUNTIME_DEPS,
    PACK_TARGETS,
    collectClosure,
    packMcpServer
} from '../../../../../../ai/scripts/setup/packMcpServer.mjs';

const brainRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

/**
 * @summary Snapshots recursive relative file paths and SHA-256 digests under `rootDir`.
 * @param {String} rootDir Directory to snapshot.
 * @returns {Map<String, String>}
 */
function snapshotTreeDigests(rootDir) {
    const result = new Map();

    const walk = dir => {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            const abs = path.join(dir, entry.name);
            const rel = path.relative(rootDir, abs).split(path.sep).join('/');

            if (entry.isDirectory()) {
                walk(abs);
            } else if (entry.isFile()) {
                const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
                result.set(rel, hash);
            }
        }
    };

    walk(rootDir);
    return result;
}

/**
 * @summary Symlinks only declared runtime dependencies from `brainRoot/node_modules` into an isolated install root.
 * @param {String} targetNodeModules Isolated `node_modules` path.
 * @param {String[]} depNames Declared dependency names from the packed `package.json`.
 */
function linkDeclaredDeps(targetNodeModules, depNames) {
    fs.mkdirSync(targetNodeModules, {recursive: true});

    for (const dep of depNames) {
        const src  = path.join(brainRoot, 'node_modules', dep);
        const dest = path.join(targetNodeModules, dep);

        fs.mkdirSync(path.dirname(dest), {recursive: true});
        fs.symlinkSync(src, dest, 'dir');
    }
}

/**
 * @summary Connects a real MCP SDK stdio client with isolated `HOME` and captured stderr output.
 * @param {Object} options
 * @param {String} options.binPath Path to the unpacked standalone CLI entrypoint.
 * @param {String} options.cwd Process working directory.
 * @param {String} options.homeDir Isolated temporary HOME directory.
 * @param {String} options.clientName Client harness name passed in MCP `initialize`.
 * @returns {Promise<{client: Client, stderrChunks: String[], close: Function}>}
 */
async function connectPackedStdioClient({binPath, cwd, homeDir, clientName}) {
    const stderrChunks = [];
    const transport    = new StdioClientTransport({
        command: process.execPath,
        args   : [binPath],
        cwd,
        env    : {
            HOME       : homeDir,
            USERPROFILE: homeDir,
            PATH       : process.env.PATH || ''
        },
        stderr : 'pipe'
    });

    transport.stderr?.on('data', chunk => {
        stderrChunks.push(chunk.toString());
    });

    const client = new Client({
        name   : clientName,
        version: '1.0.0'
    });

    await client.connect(transport);

    return {
        client,
        stderrChunks,
        async close() {
            await client.close();
        }
    };
}

test.describe('ai/scripts/setup/packMcpServer', () => {
    test('memory-core closure excludes heavy Agent OS stores, node:* builtins, and forbidden native/vector packages', () => {
        const {files, packages} = collectClosure({target: 'memory-core'});

        expect(files).toContain('ai/mcp/server/memory-core/standalone.mjs');
        expect(files).toContain('ai/mcp/server/memory-core/standaloneServer.mjs');
        expect(files).toContain('ai/mcp/server/memory-core/standaloneToolService.mjs');
        expect(files).toContain('ai/mcp/server/memory-core/standaloneConfigBase.mjs');
        expect(files).toContain('ai/services/memory-core/helpers/standaloneSqliteIndex.mjs');
        expect(files).toContain('ai/services/memory-core/helpers/promoteStandaloneWal.mjs');

        expect(files).not.toContain('ai/mcp/server/memory-core/Server.mjs');
        expect(files.some(file => file.includes('GraphService.mjs'))).toBe(false);
        expect(files.some(file => file.includes('MemoryService.mjs'))).toBe(false);

        expect(packages).toEqual(expect.arrayContaining(['@modelcontextprotocol/sdk', 'js-yaml', 'neo.mjs']));
        expect(packages.some(name => name.startsWith('node:') || name === 'sqlite')).toBe(false);
        for (const forbidden of FORBIDDEN_RUNTIME_DEPS) {
            expect(packages).not.toContain(forbidden);
        }
    });

    test('fails the build immediately when a closure imports a forbidden runtime package', async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-mcp-forbidden-'));
        const outDir      = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-mcp-forbidden-out-'));

        try {
            const serverDir = path.join(fixtureRoot, PACK_TARGETS['memory-core'].serverDir);
            fs.mkdirSync(serverDir, {recursive: true});
            fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
                name        : 'fixture-brain',
                version     : '0.0.0',
                engines     : {node: '>=24.0.0'},
                dependencies: {'chromadb': '3.5.0'}
            }));
            fs.copyFileSync(
                path.join(brainRoot, PACK_TARGETS['memory-core'].serverDir, 'server.json'),
                path.join(serverDir, 'server.json')
            );
            fs.copyFileSync(
                path.join(brainRoot, PACK_TARGETS['memory-core'].serverDir, 'openapi.yaml'),
                path.join(serverDir, 'openapi.yaml')
            );
            fs.writeFileSync(path.join(serverDir, 'standalone.mjs'), "import 'chromadb';\n");

            await expect(packMcpServer({
                target: 'memory-core',
                out   : outDir,
                root  : fixtureRoot
            })).rejects.toThrow(/forbidden runtime dependencies: chromadb/i);
        } finally {
            fs.rmSync(fixtureRoot, {force: true, recursive: true});
            fs.rmSync(outDir, {force: true, recursive: true});
        }
    });

    test('assembles neo-memory-core package with self-contained closure, clean-HOME tarball unpack, and <2s cross-harness recall', async () => {
        const packOut    = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-mc-tar-'));
        const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-mc-walk-'));

        try {
            const {manifest, packages, tarballPath} = await packMcpServer({
                target     : 'memory-core',
                out        : packOut,
                packTarball: true
            });

            expect(manifest.name).toBe('neo-memory-core');
            expect(manifest.mcpName).toBe('io.github.neomjs/memory-core');
            expect(manifest.engines).toEqual({node: '>=24.0.0'});
            expect(manifest.bin['neo-memory-core']).toBe('ai/mcp/server/memory-core/standalone.mjs');
            expect(manifest.scripts).toBeUndefined();
            for (const forbidden of FORBIDDEN_RUNTIME_DEPS) {
                expect(forbidden in manifest.dependencies).toBe(false);
            }
            expect(() => collectClosure({root: packOut, target: 'memory-core'})).not.toThrow();
            expect(tarballPath && fs.existsSync(tarballPath)).toBe(true);

            const tarballEntries = execFileSync('tar', ['-tzf', tarballPath], {encoding: 'utf8'})
                .trim()
                .split(/\r?\n/);

            for (const forbidden of FORBIDDEN_RUNTIME_DEPS) {
                expect(tarballEntries.some(entry => entry.includes(forbidden))).toBe(false);
            }
            expect(tarballEntries.some(entry => /GraphService\.mjs|MemoryService\.mjs|SessionService\.mjs|\/storage\/SQLite\.mjs/.test(entry))).toBe(false);

            const pkgDir    = path.join(sandboxDir, 'package');
            const repoDir   = path.join(sandboxDir, 'repo');
            const nestedDir = path.join(repoDir, 'packages', 'app');
            const cleanHome = path.join(sandboxDir, 'home');

            fs.mkdirSync(pkgDir, {recursive: true});
            fs.mkdirSync(nestedDir, {recursive: true});
            fs.mkdirSync(cleanHome, {recursive: true});

            execFileSync('tar', ['-xzf', tarballPath, '-C', pkgDir, '--strip-components=1']);
            linkDeclaredDeps(path.join(sandboxDir, 'node_modules'), Object.keys(manifest.dependencies));

            execFileSync('git', ['init', '-q'], {cwd: repoDir});
            execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/cross-harness-walk.git'], {cwd: repoDir});

            const pkgSnapshotBefore  = snapshotTreeDigests(pkgDir);
            const repoSnapshotBefore = snapshotTreeDigests(repoDir);
            const binPath            = path.join(pkgDir, manifest.bin['neo-memory-core']);
            const uniqueToken        = `geodesic-walk-${crypto.randomUUID()}`;
            let   writtenId;

            const session1 = await connectPackedStdioClient({
                binPath,
                cwd       : repoDir,
                homeDir   : cleanHome,
                clientName: 'claude-code'
            });

            try {
                const listed    = await session1.client.listTools();
                const toolNames = listed.tools.map(tool => tool.name);
                expect(toolNames).toEqual(expect.arrayContaining([
                    'add_memory',
                    'query_recent_turns',
                    'get_session_memories',
                    'query_raw_memories'
                ]));

                const writeRes = await session1.client.callTool({
                    name     : 'add_memory',
                    arguments: {
                        sessionId      : 'claude-session-1',
                        agent          : 'claude-code',
                        prompt         : `Record cross-harness decision ${uniqueToken}.`,
                        decisionContext: `Standalone pack walk verification token ${uniqueToken} over clean HOME.`,
                        response       : 'Persisted WAL turn and FTS5 entry from packed neo-memory-core tarball.'
                    }
                });

                expect(writeRes.isError).toBeFalsy();
                writtenId = writeRes.structuredContent.id;
                expect(writeRes.structuredContent.workspace).toBe('github.com/example/cross-harness-walk');
                expect(writeRes.structuredContent.persisted).toBe(true);
            } finally {
                await session1.close();
            }

            expect(session1.stderrChunks.join('')).toBe('');

            const startedAt = performance.now();
            const session2  = await connectPackedStdioClient({
                binPath,
                cwd       : nestedDir,
                homeDir   : cleanHome,
                clientName: 'codex-cli'
            });

            try {
                const recallStartedAt = performance.now();
                const recent          = (await session2.client.callTool({
                    name     : 'query_recent_turns',
                    arguments: {limit: 5, detail: 'summary'}
                })).structuredContent;

                const bySession = (await session2.client.callTool({
                    name     : 'get_session_memories',
                    arguments: {sessionId: 'claude-session-1'}
                })).structuredContent;

                const byQuery = (await session2.client.callTool({
                    name     : 'query_raw_memories',
                    arguments: {query: uniqueToken, nResults: 5}
                })).structuredContent;

                const recallMs = performance.now() - recallStartedAt;
                const totalMs  = performance.now() - startedAt;

                expect(recallMs).toBeLessThan(2000);
                expect(totalMs).toBeLessThan(10000);
                expect(recent.count).toBeGreaterThanOrEqual(1);
                expect(recent.turns.some(turn => turn.id === writtenId)).toBe(true);
                expect(recent.turns[0].workspace).toBe('github.com/example/cross-harness-walk');

                expect(bySession.count).toBe(1);
                expect(bySession.memories[0].id).toBe(writtenId);

                expect(byQuery.count).toBeGreaterThanOrEqual(1);
                expect(byQuery.retrievalMode).toBe('lexical-fts5');
                expect(byQuery.results[0].id).toBe(writtenId);
            } finally {
                await session2.close();
            }

            expect(session2.stderrChunks.join('')).toBe('');
            expect(snapshotTreeDigests(pkgDir)).toEqual(pkgSnapshotBefore);
            expect(snapshotTreeDigests(repoDir)).toEqual(repoSnapshotBefore);
            expect(fs.existsSync(path.join(cleanHome, '.neo-ai', 'memory-core', 'index.sqlite'))).toBe(true);
            expect(fs.existsSync(path.join(cleanHome, '.neo-ai', 'memory-core', 'wal'))).toBe(true);
            expect(packages.length).toBeGreaterThan(0);
        } finally {
            fs.rmSync(packOut, {force: true, recursive: true});
            fs.rmSync(sandboxDir, {force: true, recursive: true});
        }
    });
});
