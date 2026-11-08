import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    }
});

import {test, expect}                             from '@playwright/test';
import {Client}                                   from '@modelcontextprotocol/sdk/client/index.js';
import Neo                                        from 'neo.mjs/src/Neo.mjs';
import * as core                                  from 'neo.mjs/src/core/_export.mjs';
import BaseServer                                 from '../../../../../../ai/mcp/server/BaseServer.mjs';
import {buildOutputZodSchema, toOpenApiJsonSchema} from '../../../../../../ai/mcp/validation/openApiValidator.mjs';

// A synthetic OpenAPI operation shaped like update_issue_body's success response.
const doc       = {};
const operation = {responses: {'200': {content: {'application/json': {schema: {
    type      : 'object',
    required  : ['id', 'url', 'updatedAt', 'previousBytes', 'updatedBytes', 'byteDelta'],
    properties: {
        id           : {type: 'string'},
        url          : {type: 'string'},
        updatedAt    : {type: 'string'},
        previousBytes: {type: 'integer'},
        updatedBytes : {type: 'integer'},
        byteDelta    : {type: 'integer'}
    }
}}}}}};

/**
 * A real SDK client whose transport-facing `request` is stubbed: tools/list answers with the
 * generated listing, tools/call answers with the real formatter's envelope.
 */
async function clientReturning(result) {
    const client = new Client({name: 'test', version: '1.0.0'});
    const tool   = {
        name        : 'update_issue_body',
        inputSchema : {type: 'object'},
        outputSchema: toOpenApiJsonSchema(buildOutputZodSchema(doc, operation))
    };

    client.request = async ({method}) => method === 'tools/list'
        ? {tools: [tool]}
        : BaseServer.prototype.formatToolResult(result);

    await client.listTools();   // caches the output validator, like a real client
    return client;
}

const call = client => client.callTool({name: 'update_issue_body', arguments: {}});

test.describe('ai/mcp/validation — output schema admits structured error receipts', () => {
    test('a BODY_CHANGED refusal reaches the client with its metadata', async () => {
        const receipt = {error: 'BODY_CHANGED', message: 'Body changed since read', currentBodySha256: 'abc123'};
        const result  = await call(await clientReturning(receipt));

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(receipt);
    });

    test('a FOREIGN_BODY_FORBIDDEN refusal reaches the client with its metadata', async () => {
        const receipt = {error: 'FOREIGN_BODY_FORBIDDEN', message: 'Not your body'};
        const result  = await call(await clientReturning(receipt));

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual(receipt);
    });

    test('a complete success still passes', async () => {
        const success = {id: '1', url: 'u', updatedAt: 't', previousBytes: 1, updatedBytes: 2, byteDelta: 1};
        const result  = await call(await clientReturning(success));

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual(success);
    });

    test('a malformed success without an error key is still rejected', async () => {
        await expect(call(await clientReturning({url: 'u'}))).rejects.toThrow();
    });
});
