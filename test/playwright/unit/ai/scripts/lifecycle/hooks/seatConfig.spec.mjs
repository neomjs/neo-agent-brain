import {test, expect}          from '@playwright/test';
import {spawnSync}             from 'node:child_process';
import path                    from 'node:path';
import {pathToFileURL}         from 'node:url';
import {renderProjection}      from '../../../../../../../ai/scripts/lifecycle/hooks/projectSeatHooks.mjs';
import {HOOK_PROCESS_SHARE_MS} from '../../../../../../../ai/scripts/lifecycle/hooks/seatConfig.mjs';

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
 * @param {Object} [options]
 * @param {Number} [options.registrationMs=2000] The synchronous registration the deadline is read for.
 * @returns {Object} `{seat, plane, deadlineMs, asyncDeadlineMs, stderr}`: what `readSeatConfig`,
 * `readPlaneConfig` and `readTurnPresenceDeadlineMs` (sync and async) returned, a sync refusal as
 * `deadlineMs: {refused: <message>}`, and the child's stderr
 */
function readInChild(env, {registrationMs = 2000} = {}) {
    const script = [
        `const {readSeatConfig, readPlaneConfig, readTurnPresenceDeadlineMs} = await import(${JSON.stringify(pathToFileURL(SEAT_CONFIG).href)});`,
        `const deadlineMs = await readTurnPresenceDeadlineMs({registrationMs: ${registrationMs}}).catch(error => ({refused: error.message}));`,
        `process.stdout.write('\\nSEAT_CONFIG=' + JSON.stringify({seat: await readSeatConfig(), plane: await readPlaneConfig(), deadlineMs, asyncDeadlineMs: await readTurnPresenceDeadlineMs({async: true})}));`
    ].join('\n');

    const {status, stderr, stdout} = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd     : REPO_ROOT,
        encoding: 'utf8',
        env     : {PATH: process.env.PATH, UNIT_TEST_MODE: 'true', ...env}
    });

    if (status !== 0) throw new Error(stderr);

    return {...JSON.parse(stdout.slice(stdout.lastIndexOf('SEAT_CONFIG=') + 'SEAT_CONFIG='.length)), stderr}
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

    test('the turn-presence deadlines are the Memory Core leaves, sync and async, each with its env binding', () => {
        expect(readInChild({}), 'the leaf defaults').toMatchObject({deadlineMs: 1500, asyncDeadlineMs: 8000});
        expect(readInChild({
            NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS      : '900',
            NEO_TURN_PRESENCE_ASYNC_HOOK_WRITE_TIMEOUT_MS: '4000'
        }), 'the leaves\' env layers').toMatchObject({deadlineMs: 900, asyncDeadlineMs: 4000})
    });

    test('a synchronous deadline that does not leave the hook process its share of the registration is refused by name', () => {
        const
            readFor = registrationMs => readInChild({NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS: '4000'}, {registrationMs}),
            refusal = registrationMs => ({refused:
                `the synchronous turn-presence deadline (4000 ms) does not fit this hook's ${registrationMs} ms registration; ` +
                `set NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS to at most ${registrationMs - HOOK_PROCESS_SHARE_MS} ms`});

        expect(readFor(10000).deadlineMs, 'Codex\'s prompt registration').toBe(4000);
        expect(readFor(4000 + HOOK_PROCESS_SHARE_MS).deadlineMs, 'exactly the share left free').toBe(4000);
        expect(readFor(3999 + HOOK_PROCESS_SHARE_MS).deadlineMs).toEqual(refusal(3999 + HOOK_PROCESS_SHARE_MS));
        expect(readFor(2000).deadlineMs, 'Claude\'s start').toEqual(refusal(2000));
        expect(readFor(2000).asyncDeadlineMs, 'an async read has no registration to fit').toBe(8000)
    });

    test('a deadline that is not a whole number of milliseconds warns by name, and its default stands', () => {
        for (const value of ['0', '1.5', 'soon']) {
            const {asyncDeadlineMs, deadlineMs, stderr} = readInChild({
                NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS      : value,
                NEO_TURN_PRESENCE_ASYNC_HOOK_WRITE_TIMEOUT_MS: value
            });

            expect({asyncDeadlineMs, deadlineMs}, value).toEqual({asyncDeadlineMs: 8000, deadlineMs: 1500});
            expect(stderr).toContain(`Invalid NEO_TURN_PRESENCE_HOOK_WRITE_TIMEOUT_MS="${value}" (must be an integer >= 1); falling back.`);
            expect(stderr).toContain(`Invalid NEO_TURN_PRESENCE_ASYNC_HOOK_WRITE_TIMEOUT_MS="${value}" (must be an integer >= 1); falling back.`)
        }
    });

    test('every plane-reaching hook reads through this module from the runtime, and names no transport leaf', () => {
        for (const hook of PLANE_HOOKS) {
            const {contents} = renderProjection(path.join(REPO_ROOT, 'ai/scripts/lifecycle/hooks', hook), REPO_ROOT);

            expect(contents, hook).toContain(`from '${SEAT_CONFIG}'`);
            expect(contents, hook).not.toMatch(/AiConfig\.fleet\.plane/)
        }
    })
});
