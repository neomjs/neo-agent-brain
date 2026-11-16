import {test, expect}  from '@playwright/test';
import fs              from 'fs-extra';
import os              from 'node:os';
import path            from 'path';
import {load}          from 'js-yaml';
import {packMcpServer} from '../../../../../../ai/scripts/setup/packMcpServer.mjs';

const MCP_SERVERS = [
    'file-system',
    'github-workflow',
    'gitlab-workflow',
    'knowledge-base',
    'memory-core',
    'neural-link'
];

const STANDALONE_NPM_SERVERS = new Map([
    ['memory-core', 'neo-memory-core'],
    ['neural-link', 'neo-neural-link']
]);

const ALLOWED_SERVER_KEYS = new Set([
    '$schema',
    '_meta',
    'description',
    'icons',
    'name',
    'packages',
    'remotes',
    'repository',
    'title',
    'version',
    'websiteUrl'
]);

const ALLOWED_REPOSITORY_KEYS = new Set([
    'id',
    'source',
    'subfolder',
    'url'
]);

test.describe('MCP Registry server.json manifests', () => {
    for (const serverDir of MCP_SERVERS) {
        test(`${serverDir}/server.json adheres to the 2025-12-11 MCP Registry schema and matches openapi.yaml`, async () => {
            const repoRoot     = process.cwd();
            const subfolder    = `ai/mcp/server/${serverDir}`;
            const manifestPath = path.join(repoRoot, subfolder, 'server.json');
            const openapiPath  = path.join(repoRoot, subfolder, 'openapi.yaml');

            expect(await fs.pathExists(manifestPath)).toBe(true);
            expect(await fs.pathExists(openapiPath)).toBe(true);

            const manifest = await fs.readJSON(manifestPath);
            const openapi  = load(await fs.readFile(openapiPath, 'utf8'));

            for (const key of Object.keys(manifest)) {
                expect(ALLOWED_SERVER_KEYS.has(key)).toBe(true);
            }

            expect(manifest.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
            expect(manifest.name).toBe(`io.github.neomjs/${serverDir}`);
            expect(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(manifest.name)).toBe(true);
            expect(manifest.name.length).toBeGreaterThanOrEqual(3);
            expect(manifest.name.length).toBeLessThanOrEqual(200);

            expect(typeof manifest.title).toBe('string');
            expect(manifest.title.length).toBeGreaterThanOrEqual(1);
            expect(manifest.title.length).toBeLessThanOrEqual(100);

            expect(typeof manifest.description).toBe('string');
            expect(manifest.description.length).toBeGreaterThanOrEqual(1);
            expect(manifest.description.length).toBeLessThanOrEqual(100);

            expect(manifest.version).toBe(String(openapi.info.version));
            expect(/^[0-9]+\.[0-9]+\.[0-9]+/.test(manifest.version)).toBe(true);

            expect(manifest.websiteUrl).toBe('https://neomjs.com');

            expect(typeof manifest.repository).toBe('object');
            for (const key of Object.keys(manifest.repository)) {
                expect(ALLOWED_REPOSITORY_KEYS.has(key)).toBe(true);
            }
            expect(manifest.repository.id).toBe('1344062228');
            expect(manifest.repository.source).toBe('github');
            expect(manifest.repository.url).toBe('https://github.com/neomjs/neo-agent-brain');
            expect(manifest.repository.subfolder).toBe(subfolder);
            expect(await fs.pathExists(path.join(repoRoot, manifest.repository.subfolder))).toBe(true);

            const expectedNpmPackage = STANDALONE_NPM_SERVERS.get(serverDir);

            if (expectedNpmPackage) {
                expect(Array.isArray(manifest.packages)).toBe(true);
                expect(manifest.packages).toHaveLength(1);
                expect(manifest.packages[0]).toEqual({
                    registryType: 'npm',
                    identifier  : expectedNpmPackage,
                    version     : manifest.version,
                    transport   : {type: 'stdio'}
                });

                const out = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-registry-${serverDir}-`));

                try {
                    const packed = await packMcpServer({target: serverDir, out});

                    expect(packed.manifest.name).toBe(expectedNpmPackage);
                    expect(packed.manifest.version).toBe(manifest.version);
                    expect(packed.manifest.mcpName).toBe(manifest.name);
                } finally {
                    await fs.remove(out);
                }
            } else {
                expect(manifest.packages).toBeUndefined();
            }
        });
    }

    test('publish-mcp-registry workflow exposes only standalone-packaged servers in inputs.server', async () => {
        const workflowPath = path.join(process.cwd(), '.github/workflows/publish-mcp-registry.yml');
        const workflow     = load(await fs.readFile(workflowPath, 'utf8'));
        const options      = workflow.on?.workflow_dispatch?.inputs?.server?.options;

        expect(workflow.on?.workflow_dispatch?.inputs?.server?.default).toBe('neural-link');
        expect(options).toEqual(['neural-link', 'memory-core', 'all']);
    });
});
