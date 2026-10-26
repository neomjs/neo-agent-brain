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

import {test, expect}      from '@playwright/test';
import {Client}            from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import Neo                 from 'neo.mjs/src/Neo.mjs';
import * as core           from 'neo.mjs/src/core/_export.mjs';
import BaseServer          from '../../../../../../ai/mcp/server/BaseServer.mjs';
import nlConfig            from '../../../../../../ai/mcp/server/neural-link/config.template.mjs';

let _testClassCounter = 0;

test.describe('Neo.ai.mcp.server.BaseServer — MCP initialize instructions for handbook discovery', () => {
    test('an MCP client connecting to Neural Link learns from initialize.instructions to call get_mcp_tool_handbook(toolId) while tools/list stays compact', async () => {
        nlConfig.data.autoConnect = false;

        const {default: NeuralLinkServer} = await import('../../../../../../ai/mcp/server/neural-link/Server.mjs');

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
});
