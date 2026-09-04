import {setup} from '../../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    }
});

import {test, expect}           from '@playwright/test';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import fs                       from 'fs';
import path                     from 'path';
import {fileURLToPath}          from 'url';
import * as yaml                from 'js-yaml';
import Neo                      from 'neo.mjs/src/Neo.mjs';
import * as core                from 'neo.mjs/src/core/_export.mjs';
import BaseServer               from '../../../../../../ai/mcp/server/BaseServer.mjs';
import {buildOutputZodSchema,
        resolveRef,
        toOpenApiJsonSchema}    from '../../../../../../ai/mcp/validation/openApiValidator.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const servers  = ['file-system', 'github-workflow', 'gitlab-workflow', 'knowledge-base', 'memory-core', 'neural-link'];

/**
 * @summary The listed output schema and the runtime envelope decide the `result` wrapper
 * independently, and they must decide it the same way — witnessed from both sides.
 *
 * `BaseServer#formatToolResult` emits an object result as `structuredContent` unwrapped and wraps
 * only a non-object as `{result}`, reading the runtime value and never the schema.
 * `buildOutputZodSchema` lists the wrapper for a declared non-object type. The two agree for a
 * declared array or primitive and for a declared object; they disagreed for a response schema with
 * no top-level type whose runtime value is an object — the listing promised `result`, the payload
 * never carried it, and the client's validator (the SDK's Ajv provider, used here as the oracle)
 * rejected every call. `get_instance_properties` (a bare schema) and `ingest_source_files` (a
 * `oneOf` of two object refs) were the instances.
 *
 * The listing walk covers every operation of every document; the envelope arms run the real
 * formatter on representative results and validate what it emits against the emitted listing,
 * including the composed contract, which must keep rejecting a value neither branch declares.
 */
const loadDocument = server => yaml.load(fs.readFileSync(path.join(repoRoot, `ai/mcp/server/${server}/openapi.yaml`), 'utf8'));

const findOperation = (doc, operationId) => {
    for (const pathItem of Object.values(doc.paths || {})) {
        for (const operation of Object.values(pathItem)) {
            if (operation?.operationId === operationId) return operation
        }
    }

    return null
};

const successSchema = operation => {
    const response = operation.responses?.['200'] || operation.responses?.['201'] || operation.responses?.['202'];

    return response?.content?.['application/json']?.schema || null
};

const listedSchema = (doc, operation) => toOpenApiJsonSchema(buildOutputZodSchema(doc, operation));

const listsWrapper = listed => listed.type === 'object'
    && 'result' in (listed.properties || {})
    && (listed.required || []).includes('result');

const validator = new AjvJsonSchemaValidator();

const validates = (listed, value) => validator.getValidator(listed)(value);

// The formatter reads nothing from `this` but `Neo.isObject`; the prototype call keeps the arm
// free of a server instance while running the production method, not a mirror of it.
const envelope = result => BaseServer.prototype.formatToolResult.call({}, result).structuredContent;

test.describe('OpenApiValidator: the listed `result` wrapper agrees with the runtime envelope', () => {
    test('every operation lists the wrapper if and only if its response declares a non-object type; a composition keeps its branches', () => {
        const disagreements = [];

        for (const server of servers) {
            const doc = loadDocument(server);

            for (const pathItem of Object.values(doc.paths || {})) {
                for (const operation of Object.values(pathItem)) {
                    const schema = operation?.operationId && successSchema(operation);

                    if (!schema) continue;

                    const declared    = schema.$ref ? resolveRef(doc, schema.$ref) : schema,
                          listed      = listedSchema(doc, operation),
                          expected    = declared.type !== undefined && declared.type !== 'object',
                          composition = ['oneOf', 'anyOf', 'allOf'].find(key => Array.isArray(declared[key]));

                    if (listsWrapper(listed) !== expected) {
                        disagreements.push(`${server}/${operation.operationId}: declared type ${JSON.stringify(declared.type)} → listed wrapper ${listsWrapper(listed)}, envelope wraps ${expected}`)
                    }

                    if (listed.type !== 'object') {
                        disagreements.push(`${server}/${operation.operationId}: the MCP outputSchema root must be an object, listed ${JSON.stringify(listed.type)}`)
                    }

                    if (composition && declared.type === undefined) {
                        const carried = listed[composition === 'allOf' ? 'allOf' : 'anyOf'];

                        if (!Array.isArray(carried) || carried.length !== declared[composition].length) {
                            disagreements.push(`${server}/${operation.operationId}: a ${composition} of ${declared[composition].length} branches lists ${Array.isArray(carried) ? carried.length : 'no'} branches`)
                        }
                    }
                }
            }
        }

        expect(disagreements, disagreements.join('\n')).toEqual([])
    });

    test('the envelope of an object result validates unwrapped against the declared property map', () => {
        const doc    = loadDocument('neural-link'),
              listed = listedSchema(doc, findOperation(doc, 'get_instance_properties')),
              // the shape the engine's InstanceService answers: the requested properties keyed by
              // name, under one `properties` key
              value  = envelope({properties: {text: 'Save', hidden: false, iconCls: 'fa fa-save'}});

        expect(value).toEqual({properties: {text: 'Save', hidden: false, iconCls: 'fa fa-save'}});
        expect(listsWrapper(listed)).toBe(false);
        expect(validates(listed, value)).toMatchObject({valid: true});
        // The declaration is exact, not merely open: a bare map without the `properties` key is
        // no longer what the tool promises.
        expect(validates(listed, envelope({text: 'Save'})).valid).toBe(false)
    });

    test('the envelope of a declared primitive result validates wrapped', () => {
        const doc    = loadDocument('neural-link'),
              listed = listedSchema(doc, findOperation(doc, 'simulate_event')),
              value  = envelope(true);

        expect(value).toEqual({result: true});
        expect(listsWrapper(listed)).toBe(true);
        expect(validates(listed, value)).toMatchObject({valid: true})
    });

    test('a composed contract keeps its branches: the declared shapes validate unwrapped, a value neither branch declares is rejected', () => {
        const doc       = loadDocument('knowledge-base'),
              operation = findOperation(doc, 'ingest_source_files'),
              listed    = listedSchema(doc, operation),
              summary   = envelope({ingested: 3, deleted: 0, embeddingsGenerated: 3, settled: 3, remaining: 0, errors: [], tenantId: 'neo-shared', durationMs: 42}),
              refused   = envelope({error: 'KB_INGEST_VOLUME_EXCEEDED', message: 'too many files', code: 'KB_INGEST_VOLUME_EXCEEDED', bulkPath: 'ai:ingest-tenant', batchSize: 400, threshold: 200}),
              malformed = envelope({ingested: 'not-an-integer', error: 42, code: 'NOT_THE_DECLARED_CODE'});

        expect(listed.type).toBe('object');
        expect(listsWrapper(listed)).toBe(false);
        expect(listed.anyOf, 'the two declared branches ride the listing').toHaveLength(2);
        expect(validates(listed, summary)).toMatchObject({valid: true});
        expect(validates(listed, refused)).toMatchObject({valid: true});
        expect(validates(listed, malformed).valid, 'typed fields and the enum survive the envelope repair').toBe(false)
    });

    test('a bare untyped response schema lists as an open object, never as a `result` promise', () => {
        const doc       = {openapi: '3.0.0', paths: {}},
              operation = {
                  operationId: 'untyped_probe',
                  responses  : {'200': {description: 'ok', content: {'application/json': {schema: {description: 'The property values'}}}}}
              },
              listed    = listedSchema(doc, operation);

        expect(listed.type).toBe('object');
        expect(listed.required || []).not.toContain('result');
        expect(listed.additionalProperties).toBe(true);
        expect(validates(listed, envelope({text: 'Save'}))).toMatchObject({valid: true});
        expect(validates(listed, envelope(42))).toMatchObject({valid: true})
    });
});
