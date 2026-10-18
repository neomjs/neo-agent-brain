import fs                     from 'node:fs';
import path                   from 'node:path';
import {McpServer}            from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * @summary A stdio MCP server with one `healthcheck` tool, for the seat stand-in's spec. It answers with the
 * `FIXTURE_MARKER` its row passed, so the spec can see the row's env arrive, and writes its pid to
 * `FIXTURE_PID_FILE`, so the spec can see the stand-in reap it.
 */
const server = new McpServer({name: 'healthcheck-fixture', version: '1.0.0'});

server.tool('healthcheck', 'Fixture health', async () => ({
    content: [{type: 'text', text: JSON.stringify({status: 'healthy', marker: process.env.FIXTURE_MARKER ?? null})}]
}));

if (process.env.FIXTURE_PID_FILE) {
    fs.mkdirSync(path.dirname(process.env.FIXTURE_PID_FILE), {recursive: true});
    fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid))
}

await server.connect(new StdioServerTransport());
