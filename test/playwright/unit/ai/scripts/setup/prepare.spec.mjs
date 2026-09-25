import {test, expect}  from '@playwright/test';
import {readFileSync}  from 'fs';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDependencyBuild, runPrepare} from '../../../../../../ai/scripts/setup/prepare.mjs';

const
    repoRoot    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

/**
 * A spawn seam that records every launch and reports success, so the lifecycle's ORDER and
 * GUARDS are asserted without writing a config file or a skills link.
 */
function recordingSpawn(calls, statusFor = () => 0) {
    return (file, args, options) => {
        calls.push({file, args, options});
        return {status: statusFor(calls.length), error: null}
    }
}

test.describe('#482 — the Brain\'s install lifecycle stays inside the Brain', () => {
    test('package.json runs the lifecycle from prepare and declares no postinstall', () => {
        // npm runs a dependency's `postinstall` inside every consumer's install, and the
        // materializer projects into `INIT_CWD` — the consumer's root. `prepare` is the stage
        // consumers do not run (tarball) or run in a cache clone the guard recognises (git).
        expect(packageJson.scripts.postinstall).toBeUndefined();
        expect(packageJson.scripts.prepare).toBe('node ./ai/scripts/setup/prepare.mjs');
    });

    test('the installed engine carries no postinstall: its materializer runs from a guarded prepare (neomjs/neo#19053, #19205)', () => {
        // A nested engine whose `postinstall` still materializes would write into the consumer's
        // root from one level deeper. The property the pin must guarantee is read off the
        // installed package, not inferred from a SHA: the engine at 17b59aad still declared
        // `postinstall: neo-agent-skills-materialize` (red on dev), the guard commit's line does not.
        const
            enginePackage = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules/neo.mjs/package.json'), 'utf8')),
            pinned        = packageJson.dependencies['neo.mjs'];

        expect(pinned).toMatch(/neo\/archive\/[0-9a-f]{40}\.tar\.gz$/);
        expect(pinned).not.toContain('17b59aad8f95c55c916fd6bb8bd6a0f43bd2d687');
        expect(enginePackage.scripts.postinstall).toBeUndefined();
        expect(enginePackage.scripts.prepare).toBe('node ./buildScripts/util/prepare.mjs');
    });

    test('isDependencyBuild: a foreign INIT_CWD is a consumer install; the checkout itself is not', () => {
        expect(isDependencyBuild({env: {INIT_CWD: '/some/consumer/root'}, root: repoRoot})).toBe(true);
        expect(isDependencyBuild({env: {INIT_CWD: repoRoot}, root: repoRoot})).toBe(false);
        expect(isDependencyBuild({env: {}, root: repoRoot})).toBe(false);
    });

    test('a consumer install runs the config bootstrap and skips the materializer', () => {
        const
            calls  = [],
            result = runPrepare({root: repoRoot, env: {INIT_CWD: '/some/consumer/root'}, spawnFn: recordingSpawn(calls)});

        expect(result).toEqual({skipped: ['materialize'], stage: 'done', status: 0});
        expect(calls).toHaveLength(1);
        expect(calls[0].args[0]).toBe(path.join(repoRoot, 'ai/scripts/setup/initServerConfigs.mjs'));
        expect(calls[0].options.cwd).toBe(repoRoot);
    });

    test('the checkout\'s own install runs both stages, configs first, then the materializer from its bin declaration', () => {
        const
            calls  = [],
            result = runPrepare({root: repoRoot, env: {INIT_CWD: repoRoot}, spawnFn: recordingSpawn(calls)});

        expect(result).toEqual({skipped: [], stage: 'done', status: 0});
        expect(calls.map(call => path.basename(call.args[0]))).toEqual(['initServerConfigs.mjs', 'materialize-harness-skills.mjs']);
        expect(calls[1].args[0]).toContain(path.join('node_modules', 'neo-agent-skills'));
    });

    test('--package-lock-only mutates nothing', () => {
        const
            calls  = [],
            result = runPrepare({root: repoRoot, env: {INIT_CWD: repoRoot, npm_config_package_lock_only: 'true'}, spawnFn: recordingSpawn(calls)});

        expect(result).toEqual({skipped: ['package-lock-only'], stage: 'guard', status: 0});
        expect(calls).toHaveLength(0);
    });

    test('a failed stage stops the lifecycle and names itself', () => {
        const
            calls  = [],
            result = runPrepare({root: repoRoot, env: {INIT_CWD: repoRoot}, spawnFn: recordingSpawn(calls, n => n === 1 ? 2 : 0)});

        expect(result).toEqual({skipped: [], stage: 'configs', status: 2});
        expect(calls).toHaveLength(1);
    });
});
