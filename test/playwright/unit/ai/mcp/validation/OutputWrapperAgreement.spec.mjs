import {test, expect}  from '@playwright/test';
import fs              from 'fs';
import path            from 'path';
import {fileURLToPath} from 'url';
import * as yaml       from 'js-yaml';
import {buildOutputZodSchema,
        resolveRef,
        toOpenApiJsonSchema} from '../../../../../../ai/mcp/validation/openApiValidator.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const servers  = ['file-system', 'github-workflow', 'gitlab-workflow', 'knowledge-base', 'memory-core', 'neural-link'];

/**
 * @summary The listed output schema and the runtime envelope decide the `result` wrapper
 * independently, and they must decide it the same way.
 *
 * `BaseServer#formatToolResult` emits an object result as `structuredContent` unwrapped and wraps
 * only a non-object as `{result}`. `buildOutputZodSchema` lists the wrapper for every response
 * schema whose resolved type is not `object`. The two agree for a declared array or primitive and
 * for a declared object; they disagree for an UNTYPED response schema whose runtime value is an
 * object — the listing promises `result`, the payload never carries it, and a strict client
 * rejects every call (`get_instance_properties` was the instance). An untyped schema promises
 * nothing about the shape, so it cannot promise the wrapper: it lists as an open object.
 */
const successSchema = operation => {
    const response = operation.responses?.['200'] || operation.responses?.['201'] || operation.responses?.['202'];

    return response?.content?.['application/json']?.schema || null
};

const listsWrapper = (doc, operation) => {
    const listed = toOpenApiJsonSchema(buildOutputZodSchema(doc, operation));

    return listed.type === 'object'
        && 'result' in (listed.properties || {})
        && (listed.required || []).includes('result')
};

test.describe('OpenApiValidator: the listed `result` wrapper agrees with the runtime envelope', () => {
    test('every operation lists the wrapper if and only if its response declares a non-object type', () => {
        const disagreements = [];

        for (const server of servers) {
            const doc = yaml.load(fs.readFileSync(path.join(repoRoot, `ai/mcp/server/${server}/openapi.yaml`), 'utf8'));

            for (const pathItem of Object.values(doc.paths || {})) {
                for (const operation of Object.values(pathItem)) {
                    const schema = operation?.operationId && successSchema(operation);

                    if (!schema) continue;

                    const declared = schema.$ref ? resolveRef(doc, schema.$ref) : schema,
                          expected = declared.type !== undefined && declared.type !== 'object',
                          actual   = listsWrapper(doc, operation);

                    if (actual !== expected) {
                        disagreements.push(`${server}/${operation.operationId}: declared type ${JSON.stringify(declared.type)} → listed wrapper ${actual}, envelope wraps ${expected}`)
                    }
                }
            }
        }

        expect(disagreements, disagreements.join('\n')).toEqual([])
    });

    test('an untyped response schema lists as an open object, never as a `result` promise', () => {
        const doc       = {openapi: '3.0.0', paths: {}},
              operation = {
                  operationId: 'untyped_probe',
                  responses  : {'200': {description: 'ok', content: {'application/json': {schema: {description: 'The property values'}}}}}
              },
              listed    = toOpenApiJsonSchema(buildOutputZodSchema(doc, operation)),
              zod       = buildOutputZodSchema(doc, operation);

        expect(listed.type).toBe('object');
        expect(listed.required || []).not.toContain('result');
        expect(listed.additionalProperties).toBe(true);
        // The runtime object result validates as emitted (unwrapped), and a wrapped primitive
        // still validates — both envelopes the formatter can produce fit the listing.
        expect(zod.safeParse({text: 'Save', hidden: false}).success).toBe(true);
        expect(zod.safeParse({result: 42}).success).toBe(true)
    });

    test('a declared non-object type keeps the wrapper the envelope produces', () => {
        const doc       = {openapi: '3.0.0', paths: {}},
              operation = {
                  operationId: 'boolean_probe',
                  responses  : {'200': {description: 'ok', content: {'application/json': {schema: {type: 'boolean'}}}}}
              };

        expect(listsWrapper(doc, operation)).toBe(true)
    });
});
