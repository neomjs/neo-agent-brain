import fs                     from 'node:fs';
import path                   from 'node:path';
import {McpServer}            from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * @summary A stdio MCP server for the seat stand-in's spec. By default it lists one `healthcheck` tool that answers
 * with the `FIXTURE_MARKER` its row passed, so the spec can see the row's env arrive. It writes its pid to
 * `FIXTURE_PID_FILE`, so the spec can see the stand-in reap it. The negative controls switch its behavior:
 * `FIXTURE_TOOL=ping` lists no healthcheck, `FIXTURE_HEALTH=error` answers `isError`, and `FIXTURE_DELAY_MS` holds
 * the healthcheck open.
 */
const
    server = new McpServer({name: 'healthcheck-fixture', version: '1.0.0'}),
    delay  = Number(process.env.FIXTURE_DELAY_MS) || 0;

server.tool(process.env.FIXTURE_TOOL || 'healthcheck', 'Fixture health', async () => {
    delay && await new Promise(resolve => setTimeout(resolve, delay));

    return process.env.FIXTURE_HEALTH === 'error'
        ? {isError: true, content: [{type: 'text', text: 'fixture health failed'}]}
        : {content: [{type: 'text', text: JSON.stringify({status: 'healthy', marker: process.env.FIXTURE_MARKER ?? null})}]}
});

if (process.env.FIXTURE_PID_FILE) {
    fs.mkdirSync(path.dirname(process.env.FIXTURE_PID_FILE), {recursive: true});
    fs.writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid))
}

await server.connect(new StdioServerTransport());
