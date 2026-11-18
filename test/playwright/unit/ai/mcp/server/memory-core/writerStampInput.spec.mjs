import {test, expect}  from '@playwright/test';
import fs              from 'node:fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The wire's input parse keeps the writer stamp the seat's hook adds to `add_memory` and `add_message`.
 * The parse strips every key the OpenAPI does not declare, so without the declarations the handlers would
 * never see the stamp: the control key below proves the parse is the stripping kind.
 */

const STAMP = {writerKey: 'v1:0123456789abcdef0123456789abcdef', writerTurn: '0f1e2d3c-4b5a-4987-8765-43210fedcba9'};

/**
 * @summary Parses `args` with the input schema the memory-core wire builds for `operationId`.
 * @param {String} operationId
 * @param {Object} args
 * @returns {Promise<Object>} The parsed input.
 */
async function parseInput(operationId, args) {
    const
        {buildZodSchema} = await import('../../../../../../../ai/mcp/validation/openApiValidator.mjs'),
        yamlModule       = await import('js-yaml'),
        load             = yamlModule.load || yamlModule.default.load,
        repoRoot         = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../..'),
        spec             = load(fs.readFileSync(path.join(repoRoot, 'ai/mcp/server/memory-core/openapi.yaml'), 'utf8')),
        operation        = Object.values(spec.paths || {}).flatMap(item => Object.values(item)).find(method => method?.operationId === operationId);

    expect(operation, operationId).toBeTruthy();

    return buildZodSchema(spec, operation).parse(args)
}

test('add_memory keeps the writer stamp and strips an undeclared key', async () => {
    const parsed = await parseInput('add_memory', {prompt: 'p', response: 'r', decisionContext: 'd', ...STAMP, undeclaredControl: 'x'});

    expect(parsed).toMatchObject(STAMP);
    expect('undeclaredControl' in parsed).toBe(false)
});

test('add_message keeps the writer stamp and strips an undeclared key', async () => {
    const parsed = await parseInput('add_message', {to: '@seat', subject: 's', body: 'b', ...STAMP, undeclaredControl: 'x'});

    expect(parsed).toMatchObject(STAMP);
    expect('undeclaredControl' in parsed).toBe(false)
});

test('record_turn_presence keeps writerKey and strips an undeclared key', async () => {
    const parsed = await parseInput('record_turn_presence', {action: 'progress', writerKey: STAMP.writerKey, undeclaredControl: 'x'});

    expect(parsed.writerKey).toBe(STAMP.writerKey);
    expect('undeclaredControl' in parsed).toBe(false)
});
