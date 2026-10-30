import {test, expect}           from '@playwright/test';
import fs                       from 'node:fs';
import {isolateUnitEnvironment} from '../isolateUnitEnvironment.mjs';

/**
 * @summary `isolateUnitEnvironment()` removes what a unit run inherits from the shell that starts it, and nothing
 * the harness or a workflow sets for the run.
 */
test.describe('test/playwright/isolateUnitEnvironment', () => {
    test('removes inherited placement and git identity; keeps the harness namespace, endpoints and credentials', () => {
        const env = {
            NEO_PLANE_DATA_ROOT       : '/live/plane',
            NEO_PLANE_ID              : 'live-plane',
            NEO_CHROMA_DATA_DIR       : '/live/plane/chroma/unified',
            NEO_HEARTBEAT_ALIVE_PATH  : '/live/plane/heartbeat.alive',
            NEO_SEAT_PLANE_BASE       : '/live',
            NEO_MCP_REMOTE_TOKEN_DIR  : '/live/plane/tokens',
            GIT_AUTHOR_NAME           : 'seat',
            GIT_COMMITTER_EMAIL       : 'seat@example.com',
            NEO_TEST_SKIP_CI          : 'true',
            NEO_TEST_STORAGE_ROOT     : '/tmp/neo-playwright-x',
            NEO_MCP_REMOTE_TOKEN      : 'fixture-token',
            NEO_OPENAI_COMPATIBLE_HOST: 'http://model-host.test',
            NEO_AGENT_IDENTITY        : '@seat',
            GIT_DIR                   : '/repo/.git',
            PATH                      : '/usr/bin'
        };

        expect(isolateUnitEnvironment(env).sort()).toEqual([
            'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'NEO_CHROMA_DATA_DIR', 'NEO_HEARTBEAT_ALIVE_PATH',
            'NEO_MCP_REMOTE_TOKEN_DIR', 'NEO_PLANE_DATA_ROOT', 'NEO_PLANE_ID', 'NEO_SEAT_PLANE_BASE'
        ]);
        expect(env).toEqual({
            NEO_TEST_SKIP_CI          : 'true',
            NEO_TEST_STORAGE_ROOT     : '/tmp/neo-playwright-x',
            NEO_MCP_REMOTE_TOKEN      : 'fixture-token',
            NEO_OPENAI_COMPATIBLE_HOST: 'http://model-host.test',
            NEO_AGENT_IDENTITY        : '@seat',
            GIT_DIR                   : '/repo/.git',
            PATH                      : '/usr/bin'
        })
    });

    test('inside the harness boundary it removes nothing: a worker keeps what the runner bound', () => {
        const env = {NEO_TEST_CONFIG_TEMPLATES: 'true', NEO_MEMORY_LOG_PATH: '/tmp/neo-playwright-x/worker-0/memory-core-logs'};

        expect(isolateUnitEnvironment(env)).toEqual([]);
        expect(env.NEO_MEMORY_LOG_PATH).toBe('/tmp/neo-playwright-x/worker-0/memory-core-logs')
    });

    test('the unit config imports it before the resolver binds the harness values', () => {
        const source = fs.readFileSync(new URL('../playwright.config.unit.mjs', import.meta.url), 'utf8'),
              scrub  = source.indexOf("import './isolateUnitEnvironment.mjs';"),
              binder = source.indexOf("import './configTemplateResolver.mjs';");

        expect(scrub, 'the scrub is imported').toBeGreaterThan(-1);
        expect(binder, 'the resolver is imported').toBeGreaterThan(-1);
        expect(scrub).toBeLessThan(binder)
    });
});
