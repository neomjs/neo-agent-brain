import {setup} from '../../../../setup.mjs';

const appName = 'McpServerInstructionsTest';

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

import fs                                 from 'node:fs';
import os                                 from 'node:os';
import path                               from 'node:path';
import {fileURLToPath}                    from 'node:url';
import * as yaml                          from 'js-yaml';
import {test, expect}                     from '@playwright/test';
import {Client}                           from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport}                from '@modelcontextprotocol/sdk/inMemory.js';
import Neo                                from 'neo.mjs/src/Neo.mjs';
import * as core                          from 'neo.mjs/src/core/_export.mjs';
import ToolService                        from '../../../../../../ai/mcp/ToolService.mjs';
import BaseServer                         from '../../../../../../ai/mcp/server/BaseServer.mjs';
import FileSystemServer                   from '../../../../../../ai/mcp/server/file-system/Server.mjs';
import GitHubServer                       from '../../../../../../ai/mcp/server/github-workflow/Server.mjs';
import GitLabServer                       from '../../../../../../ai/mcp/server/gitlab-workflow/Server.mjs';
import KnowledgeBaseServer                from '../../../../../../ai/mcp/server/knowledge-base/Server.mjs';
import MemoryCoreServer                   from '../../../../../../ai/mcp/server/memory-core/Server.mjs';
import {createTransportVisibleToolFacade} from '../../../../../../ai/mcp/server/memory-core/toolService.mjs';
import NeuralLinkServer                   from '../../../../../../ai/mcp/server/neural-link/Server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '../../../../../..');

const MAX_CATALOG_LINES = 15;
const MAX_CATALOG_BYTES = 1600;

const SERVER_SPECS = [
    {name: 'file-system',     ServerClass: FileSystemServer,    openApiRel: 'ai/mcp/server/file-system/openapi.yaml',     unmarked: true},
    {name: 'gitlab-workflow', ServerClass: GitLabServer,        openApiRel: 'ai/mcp/server/gitlab-workflow/openapi.yaml', unmarked: true},
    {name: 'github-workflow', ServerClass: GitHubServer,        openApiRel: 'ai/mcp/server/github-workflow/openapi.yaml', unmarked: false},
    {name: 'knowledge-base',  ServerClass: KnowledgeBaseServer, openApiRel: 'ai/mcp/server/knowledge-base/openapi.yaml',  unmarked: false},
    {name: 'memory-core',     ServerClass: MemoryCoreServer,    openApiRel: 'ai/mcp/server/memory-core/openapi.yaml',     unmarked: false},
    {name: 'neural-link',     ServerClass: NeuralLinkServer,    openApiRel: 'ai/mcp/server/neural-link/openapi.yaml',     unmarked: false}
];

function readAllOperationIds(openApiRel) {
    const doc = yaml.load(fs.readFileSync(path.join(repoRoot, openApiRel), 'utf8'));
    const ids = [];

    for (const pathItem of Object.values(doc.paths || {})) {
        for (const op of Object.values(pathItem || {})) {
            if (op?.operationId) {
                ids.push(op.operationId);
            }
        }
    }
    return ids;
}

function stripBalancedParens(text) {
    let depth = 0, out = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') {
            if (depth === 0 && out.endsWith(' ')) out = out.slice(0, -1);
            depth++;
        } else if (ch === ')') {
            if (depth > 0) depth--;
        } else if (depth === 0) {
            out += ch;
        }
    }
    return out;
}

function extractCatalogToolNames(instructions) {
    if (!instructions) return [];

    const names = [];
    for (const line of instructions.split('\n')) {
        if (line.startsWith('Tool descriptions and input schemas in tools/list')) {
            names.push('get_mcp_tool_handbook');
            continue;
        }
        const colonIdx = line.indexOf(': ');
        if (colonIdx === -1) continue;

        const stripped = stripBalancedParens(line.slice(colonIdx + 2));

        for (const item of stripped.split(', ')) {
            if (item.trim()) {
                names.push(item.trim());
            }
        }
    }
    return names;
}

function assertInstructionsWithinBudget(instructions, label) {
    const lines        = instructions.split('\n');
    const catalogLines = lines[0]?.startsWith('Tool descriptions and input schemas in tools/list')
        ? lines.slice(1)
        : lines;
    const totalBytes   = Buffer.byteLength(instructions, 'utf8');
    const catalogBytes = Buffer.byteLength(catalogLines.join('\n'), 'utf8');

    if (lines.length > MAX_CATALOG_LINES || catalogLines.length > MAX_CATALOG_LINES) {
        throw new Error(`${label} exceeded ${MAX_CATALOG_LINES} lines (total=${lines.length}, catalog=${catalogLines.length})`);
    }
    if (totalBytes > MAX_CATALOG_BYTES || catalogBytes > MAX_CATALOG_BYTES) {
        throw new Error(`${label} exceeded ${MAX_CATALOG_BYTES} bytes (total=${totalBytes}, catalog=${catalogBytes})`);
    }
}

let _testClassCounter = 0;

test.describe('Neo.ai.mcp.server.BaseServer — MCP initialize instructions for handbook discovery', () => {
    test('an MCP client connecting to Neural Link learns from initialize.instructions to call get_mcp_tool_handbook(toolId) while tools/list stays compact', async () => {
        class IsolatedNeuralLinkServer extends NeuralLinkServer {
            static config = {className: `Neo.test.mcp.server.IsolatedNeuralLinkServer${++_testClassCounter}`}
            async initAsync() {}
        }

        const Cls                                = Neo.setupClass(IsolatedNeuralLinkServer),
              server                             = Neo.create(Cls),
              mcpServer                          = server.createMcpServer(),
              [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(),
              client                             = new Client({name: 'outside-agent', version: '1.0.0'});

        await Promise.all([
            mcpServer.connect(serverTransport),
            client.connect(clientTransport)
        ]);

        try {
            const instructions = client.getInstructions();

            expect(typeof instructions).toBe('string');
            expect(instructions).toContain('get_mcp_tool_handbook');
            expect(instructions).toContain('toolId');

            const {tools}    = await client.listTools(),
                  getDomRect = tools.find(tool => tool.name === 'get_dom_rect');

            expect(getDomRect).toBeDefined();
            expect(getDomRect.inputSchema.properties.componentIds.description).toBeUndefined();

            const handbookResponse = await client.callTool({
                name     : 'get_mcp_tool_handbook',
                arguments: {toolId: 'get_dom_rect'}
            });
            const handbookPayload = JSON.parse(handbookResponse.content[0].text);

            expect(handbookPayload.found).toBe(true);
            expect(handbookPayload.inputSchema.properties.componentIds.description).toEqual(expect.any(String));
        } finally {
            await client.close();
            await mcpServer.close();
        }
    });

    test('subclass can override getServerInstructions() or suppress instructions with null', async () => {
        class SilentInstructionsServer extends BaseServer {
            static config = {className: `Neo.test.mcp.server.SilentInstructionsServer${++_testClassCounter}`}
            getServerMetadata()     { return {name: 'neo-silent', version: '1.0.0'}; }
            getToolService()        { return {listTools: () => ({tools: []}), callTool: async () => ({})}; }
            getServerInstructions() { return null; }
            async initAsync()       {}
        }

        const Cls                                = Neo.setupClass(SilentInstructionsServer),
              server                             = Neo.create(Cls),
              mcpServer                          = server.createMcpServer(),
              [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(),
              client                             = new Client({name: 'outside-agent', version: '1.0.0'});

        await Promise.all([
            mcpServer.connect(serverTransport),
            client.connect(clientTransport)
        ]);

        try {
            expect(client.getInstructions()).toBeUndefined();
        } finally {
            await client.close();
            await mcpServer.close();
        }
    });

    test('all six MCP servers deliver a projection-consistent catalog within 15 lines and 1,600 bytes (AC-1, AC-2, AC-3, Fallback)', async () => {
        const collectedInstructions = {};

        for (const spec of SERVER_SPECS) {
            class IsolatedServer extends spec.ServerClass {
                static config = {className: `Neo.test.mcp.server.CatalogServer_${spec.name.replace(/-/g, '_')}_${++_testClassCounter}`}
                async initAsync() {}
            }

            const Cls                                = Neo.setupClass(IsolatedServer),
                  server                             = Neo.create(Cls),
                  mcpServer                          = server.createMcpServer(),
                  [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(),
                  client                             = new Client({name: 'catalog-verifier', version: '1.0.0'});

            await Promise.all([
                mcpServer.connect(serverTransport),
                client.connect(clientTransport)
            ]);

            try {
                const instructions = client.getInstructions();
                const {tools}      = await client.listTools();
                const listedSet    = new Set(tools.map(t => t.name));
                const allOpIds     = readAllOperationIds(spec.openApiRel);

                expect(typeof instructions).toBe('string');
                assertInstructionsWithinBudget(instructions, spec.name);

                const catalogLines = instructions.split('\n').slice(1);
                expect(catalogLines.length).toBeGreaterThanOrEqual(3);

                for (const namedTool of extractCatalogToolNames(instructions)) {
                    expect(listedSet.has(namedTool), `${spec.name}: catalog named unlisted tool ${namedTool}`).toBe(true);
                }

                for (const opId of allOpIds) {
                    if (!listedSet.has(opId)) {
                        expect(instructions).not.toMatch(new RegExp(`\\b${opId}\\b`));
                    }
                }

                if (spec.unmarked) {
                    for (const line of catalogLines) {
                        expect(line).not.toContain('(');
                    }
                }

                collectedInstructions[spec.name] = instructions;
            } finally {
                await client.close();
                await mcpServer.close();
            }
        }

        for (const requiredTool of ['explore_lane_landscape', 'pre_brief_session', 'query_hybrid_graph', 'inspect_deployment']) {
            expect(collectedInstructions['memory-core']).toContain(`${requiredTool} (`);
        }
        expect(collectedInstructions['knowledge-base']).toContain('inspect_deployment (');
        expect(collectedInstructions['knowledge-base']).toContain('get_class_hierarchy (');

        const httpFacade   = createTransportVisibleToolFacade({resolveTransport: () => 'streamable-http'});
        const httpCatalog  = httpFacade.buildToolCatalog();
        const httpListed   = new Set(httpFacade.listTools().tools.map(t => t.name));
        const httpFullText = `Tool descriptions and input schemas in tools/list are compacted to save context tokens. Call get_mcp_tool_handbook({toolId}) before invoking an unfamiliar tool to read its full usage guide and parameter descriptions.\n${httpCatalog}`;

        assertInstructionsWithinBudget(httpFullText, 'memory-core (streamable-http)');
        for (const namedTool of extractCatalogToolNames(httpFullText)) {
            expect(httpListed.has(namedTool)).toBe(true);
        }
    });

    test('narrowed and fail-closed projections never name withheld tools or handbook when unlisted (AC-1)', () => {
        for (const spec of SERVER_SPECS) {
            const allOpIds = readAllOperationIds(spec.openApiRel);

            for (const mode of ['harness-embedded', 'local-readonly-probe', '']) {
                class ProjectedServer extends spec.ServerClass {
                    static config = {className: `Neo.test.mcp.server.Projected_${spec.name.replace(/-/g, '_')}_${++_testClassCounter}`}
                    async initAsync() {}
                }

                const Cls          = Neo.setupClass(ProjectedServer),
                      server       = Neo.create(Cls, {toolProjectionMode: mode}),
                      instructions = server.getServerInstructions(),
                      listedTools  = server.getToolService().listTools({toolProjection: {mode}}).tools,
                      listedSet    = new Set(listedTools.map(t => t.name));

                if (listedSet.size === 0) {
                    expect(instructions).toBeNull();
                    continue;
                }

                assertInstructionsWithinBudget(instructions, `${spec.name}:${mode}`);

                for (const namedTool of extractCatalogToolNames(instructions)) {
                    expect(listedSet.has(namedTool), `${spec.name} (${mode}) named unlisted ${namedTool}`).toBe(true);
                }

                for (const opId of allOpIds) {
                    if (!listedSet.has(opId)) {
                        expect(instructions).not.toMatch(new RegExp(`\\b${opId}\\b`));
                    }
                }
            }
        }
    });

    test('budget gate rejects catalogs exceeding 15 lines or 1,600 bytes and x-neo-tool-catalog leaves tools/list byte-identical (AC-2, AC-5)', () => {
        const sixteenLineFixture   = Array.from({length: 16}, (_, i) => `Family${i}: tool_${i}`).join('\n');
        const oversizedByteFixture = Array.from({length: 10}, (_, i) => `Family${i}: tool_${i} (${'x'.repeat(170)})`).join('\n');

        expect(() => assertInstructionsWithinBudget(sixteenLineFixture, '16-line-fixture')).toThrow(/exceeded 15 lines/);
        expect(() => assertInstructionsWithinBudget(oversizedByteFixture, 'oversized-fixture')).toThrow(/exceeded 1600 bytes/);

        const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-catalog-spec-'));
        const specA   = path.join(tmpDir, 'without-catalog.yaml');
        const specB   = path.join(tmpDir, 'with-catalog.yaml');
        const baseDoc = {
            openapi: '3.0.3',
            info   : {title: 'Catalog Invariance Test', version: '1.0.0'},
            paths  : {
                '/health': {
                    get: {
                        operationId: 'healthcheck',
                        summary    : 'Probe test server liveness; use when calls fail.',
                        tags       : ['OldTag'],
                        responses  : {'200': {description: 'OK'}}
                    }
                },
                '/hidden': {
                    post: {
                        operationId       : 'explore_hidden_topology',
                        summary           : 'Traverse hidden multi-hop edges; use when 1-hop lookup is too shallow.',
                        tags              : ['Graph'],
                        'x-pass-as-object': true,
                        requestBody       : {
                            required: true,
                            content : {'application/json': {schema: {type: 'object', properties: {nodeId: {type: 'string'}}}}}
                        },
                        responses: {'200': {description: 'OK'}}
                    }
                }
            }
        };

        const markedDoc = structuredClone(baseDoc);
        markedDoc.paths['/health'].get.tags = ['Health'];
        markedDoc.paths['/hidden'].post['x-neo-tool-catalog'] = true;

        try {
            fs.writeFileSync(specA, yaml.dump(baseDoc), 'utf8');
            fs.writeFileSync(specB, yaml.dump(markedDoc), 'utf8');

            const svcA = Neo.create(ToolService, {
                compactToolDescriptions     : true,
                compactToolSchemas          : true,
                openApiFilePath             : specA,
                toolListDescriptionMaxLength: 120
            });
            const svcB = Neo.create(ToolService, {
                compactToolDescriptions     : true,
                compactToolSchemas          : true,
                openApiFilePath             : specB,
                toolListDescriptionMaxLength: 120
            });

            expect(JSON.stringify(svcB.listTools())).toBe(JSON.stringify(svcA.listTools()));
            expect(svcA.buildToolCatalog()).toBe('OldTag: healthcheck\nGraph: explore_hidden_topology');
            expect(svcB.buildToolCatalog()).toBe(
                'Health: healthcheck\nGraph: explore_hidden_topology (Traverse hidden multi-hop edges; use when 1-hop lookup is too shallow.)'
            );
        } finally {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        }
    });
});
