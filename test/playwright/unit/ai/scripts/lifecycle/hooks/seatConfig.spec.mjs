import {test, expect}     from '@playwright/test';
import {execFileSync}     from 'node:child_process';
import path               from 'node:path';
import {pathToFileURL}    from 'node:url';
import {renderProjection} from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';

/**
 * A seat hook reaches the plane as the seat. It reads the seat-side leaves (`AiConfig.seat`), which the
 * Fleet injects beside the seat's own credential, and never `fleet.*`: those leaves configure the Fleet
 * transport, whose bearer belongs to the single viewer.
 *
 * The config resolves its env once, in the process that loads it, so each read runs in a child with
 * exactly the env under test. The shared singleton is never mutated.
 */

const
    REPO_ROOT   = path.resolve(process.cwd()),
    SEAT_CONFIG = path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks/seatConfig.mjs'),
    // every seat hook that reaches the plane, one per harness that has one
    PLANE_HOOKS = [
        'claude/turnPresenceHook.mjs',
        'claude/wakeArmingHook.mjs',
        'claude/wakeListenerHook.mjs',
        'codex/codex-context.mjs',
        'kimi-code/turnPresenceHook.mjs'
    ];

/**
 * @summary Reads the seat config in a child process whose env is exactly `env`, plus PATH.
 * @param {Object} env
 * @returns {Object} `{seat, plane}`: what `readSeatConfig` and `readPlaneConfig` returned
 */
function readInChild(env) {
    const script = [
        `const {readSeatConfig, readPlaneConfig} = await import(${JSON.stringify(pathToFileURL(SEAT_CONFIG).href)});`,
        `process.stdout.write('\\nSEAT_CONFIG=' + JSON.stringify({seat: await readSeatConfig(), plane: await readPlaneConfig()}));`
    ].join('\n');

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd     : REPO_ROOT,
        encoding: 'utf8',
        env     : {PATH: process.env.PATH, UNIT_TEST_MODE: 'true', ...env}
    });

    return JSON.parse(output.slice(output.lastIndexOf('SEAT_CONFIG=') + 'SEAT_CONFIG='.length))
}

test.describe('seatConfig — a seat hook reaches the plane as the seat', () => {
    test('a seat holding only the Fleet\'s injections resolves its plane, credential and identity', () => {
        const {seat, plane} = readInChild({
            NEO_AGENT_IDENTITY  : '@neo-seat',
            NEO_MCP_REMOTE_TOKEN: 'seat-plane-pat',
            NEO_SEAT_PLANE_BASE : 'https://plane.example/'
        });

        expect(seat).toEqual({planeBase: 'https://plane.example', planeBearer: 'seat-plane-pat', identity: '@neo-seat'});
        expect(plane).toEqual({baseUrl: 'https://plane.example/mc/mcp', credential: 'seat-plane-pat'})
    });

    test('the Fleet transport\'s plane and bearer never reach a seat hook', () => {
        const {seat, plane} = readInChild({
            NEO_AGENT_IDENTITY    : '@neo-seat',
            NEO_FLEET_PLANE_BASE  : 'https://transport.example',
            NEO_FLEET_PLANE_BEARER: 'viewer-bearer'
        });

        expect(seat).toEqual({planeBase: '', planeBearer: '', identity: '@neo-seat'});
        expect(plane).toEqual({baseUrl: '', credential: ''})
    });

    test('every plane-reaching hook reads through this module from the runtime, and names no transport leaf', () => {
        for (const hook of PLANE_HOOKS) {
            const {contents} = renderProjection(path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks', hook), REPO_ROOT);

            expect(contents, hook).toContain(`from '${SEAT_CONFIG}'`);
            expect(contents, hook).not.toMatch(/AiConfig\.fleet\.plane/)
        }
    })
});
