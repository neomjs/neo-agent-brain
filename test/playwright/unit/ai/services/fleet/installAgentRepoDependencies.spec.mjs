import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import {
    DEPENDENCY_RECEIPT,
    installAgentRepoDependencies,
    installSeatDependencies,
    resolveLoginShellNpm,
    runToExit
} from '../../../../../../ai/services/fleet/installAgentRepoDependencies.mjs';

/** The Fleet's own environment: a GUI app's PATH with the organism shim, and credentials npm must never see. */
const FLEET_ENV = {
    HOME                : '/Users/operator',
    LANG                : 'en_US.UTF-8',
    LOGNAME             : 'operator',
    SHELL               : '/bin/zsh',
    TMPDIR              : '/tmp/operator',
    USER                : 'operator',
    PATH                : '/organism/shims:/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '1',
    GH_TOKEN            : 'ghp_fleetOnlyFixture',
    NEO_MCP_REMOTE_TOKEN: 'plane-bearer-fixture'
};

/** What a login shell keeps of {@link FLEET_ENV}: nothing that names a credential, a runtime or a PATH. */
const SHELL_ENV = {HOME: '/Users/operator', LANG: 'en_US.UTF-8', LOGNAME: 'operator', SHELL: '/bin/zsh', TMPDIR: '/tmp/operator', USER: 'operator'};

const RESOLVED = {npm: '/opt/homebrew/bin/npm', PATH: '/opt/homebrew/bin:/usr/bin:/bin'};

/** A recording seam: each call is kept, and answers through `answer`. */
function recorder(answer = async () => {}) {
    const calls = [];
    const fn    = async (...args) => { calls.push(args); return answer(...args) };
    fn.calls    = calls;
    return fn
}

/**
 * @summary A seat checkout's dependency install, on real temp folders and real child processes: it installs a fresh
 * clone or its own unfinished attempt, leaves a tree it did not install alone, runs the operator's own `npm` without
 * the Fleet's credentials, waits for a stopped `npm` to exit, and answers with data instead of throwing.
 */
test.describe('installAgentRepoDependencies — a seat checkout gets its locked dependencies before launch', () => {
    let root;

    const checkout = (...entries) => {
        const dir = fs.mkdtempSync(path.join(root, 'checkout-'));

        entries.includes('lock')         && fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
        entries.includes('node_modules') && fs.mkdirSync(path.join(dir, 'node_modules'));

        return dir
    };

    test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-deps-')) });
    test.afterEach(() => { fs.rmSync(root, {recursive: true, force: true}) });

    test('a checkout without package-lock.json is not-applicable, and nothing resolves, runs or records', async () => {
        const run = recorder(), resolveNpm = recorder(async () => RESOLVED), record = recorder();

        expect(await installAgentRepoDependencies({repoPath: checkout(), env: FLEET_ENV, run, resolveNpm, record})).toEqual({state: 'not-applicable'});
        expect([run.calls, resolveNpm.calls, record.calls]).toEqual([[], [], []]);
    });

    test('a tree the Fleet finished is present, and one it did not install is unverified: both stay untouched', async () => {
        const run = recorder(), resolveNpm = recorder(async () => RESOLVED), record = recorder(), repoPath = checkout('lock', 'node_modules');

        expect(await installAgentRepoDependencies({repoPath, prior: {state: 'installed'}, env: FLEET_ENV, run, resolveNpm, record})).toEqual({state: 'present'});
        // npm ci deletes node_modules first, so a tree the Fleet cannot vouch for is only reported
        expect(await installAgentRepoDependencies({repoPath, prior: null, env: FLEET_ENV, run, resolveNpm, record})).toEqual({state: 'unverified'});
        expect([run.calls, resolveNpm.calls, record.calls]).toEqual([[], [], []]);
    });

    test("a fresh checkout runs the login shell's npm ci with that shell's PATH and none of the Fleet's credentials, receipted", async () => {
        const run      = recorder(), resolveNpm = recorder(async () => RESOLVED), record = recorder(),
              signal   = new AbortController().signal,
              repoPath = checkout('lock');

        expect(await installAgentRepoDependencies({repoPath, signal, env: FLEET_ENV, run, resolveNpm, record})).toEqual({state: 'installed'});
        expect(run.calls).toEqual([[RESOLVED.npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], {
            cwd: repoPath,
            // the shell's PATH, so `node` resolves to the operator's runtime and never the organism shim
            env: {...SHELL_ENV, PATH: RESOLVED.PATH},
            signal
        }]]);
        expect(record.calls).toEqual([[{state: 'installing'}], [{state: 'installed'}]]);
    });

    test('a tree left by an owned install that never finished installs again instead of reading as ready', async () => {
        const run = recorder(), resolveNpm = recorder(async () => RESOLVED), record = recorder(), repoPath = checkout('lock', 'node_modules');

        expect(await installAgentRepoDependencies({repoPath, prior: {state: 'failed', reason: 'npm ci exited 1'}, env: FLEET_ENV, run, resolveNpm, record}))
            .toEqual({state: 'installed'});
        expect(await installAgentRepoDependencies({repoPath, prior: {state: 'installing'}, env: FLEET_ENV, run, resolveNpm, record}))
            .toEqual({state: 'installed'});
        expect(run.calls).toHaveLength(2);
    });

    test('a login shell without npm fails the row with its reason, and nothing runs or is receipted', async () => {
        const run        = recorder(), record = recorder(),
              resolveNpm = recorder(async () => ({reason: 'npm is not on the PATH of the login shell /bin/zsh'}));

        expect(await installAgentRepoDependencies({repoPath: checkout('lock'), env: FLEET_ENV, run, resolveNpm, record}))
            .toEqual({state: 'failed', reason: 'npm is not on the PATH of the login shell /bin/zsh'});
        expect([run.calls, record.calls]).toEqual([[], []]);
    });

    test('a failed install answers and receipts a redacted, bounded reason instead of throwing', async () => {
        const token  = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`,
              record = recorder(),
              run    = recorder(async () => {
                  throw new Error(`npm ci exited 1: npm error 401 https://x:${token}@github.com/neomjs/private.git\n${'npm error retry\n'.repeat(40)}`)
              }),
              result = await installAgentRepoDependencies({repoPath: checkout('lock'), env: FLEET_ENV, run, resolveNpm: async () => RESOLVED, record});

        expect(result.state).toBe('failed');
        expect(result.reason).toMatch(/^npm ci exited 1/);
        expect(result.reason).not.toContain(token);
        expect(result.reason.length).toBeLessThanOrEqual(240);
        expect(record.calls.at(-1)).toEqual([{state: 'failed', reason: result.reason}]);
    });
});

test.describe('runToExit — a stopped install has exited before the Start goes on', () => {
    let root;

    test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-to-exit-')) });
    test.afterEach(() => { fs.rmSync(root, {recursive: true, force: true}) });

    const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } };

    test('exit 0 resolves, and another exit code rejects with the end of stderr', async () => {
        await expect(runToExit(process.execPath, ['-e', ''], {cwd: root, env: {}})).resolves.toBeUndefined();
        await expect(runToExit(process.execPath, ['-e', 'console.error("lock mismatch"); process.exit(3)'], {cwd: root, env: {}}))
            .rejects.toThrow(/exited 3: lock mismatch$/);
    });

    test('a canceled Start stops the command and settles only once it has exited', async () => {
        // the child takes 300 ms to honour SIGTERM, as npm does while it winds down its scripts
        const pidFile    = path.join(root, 'pid'),
              script     = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000)`,
              controller = new AbortController(),
              running    = runToExit(process.execPath, ['-e', script], {cwd: root, env: {}, signal: controller.signal});

        await expect.poll(() => fs.existsSync(pidFile)).toBe(true);

        const pid = Number(fs.readFileSync(pidFile, 'utf8')), stoppedAt = Date.now();

        controller.abort();

        await expect(running).rejects.toMatchObject({canceled: true, message: expect.stringMatching(/canceled$/)});
        expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(250);
        expect(alive(pid)).toBe(false);
    });

    test('a command that ignores SIGTERM past the timeout is killed, and the timeout is not a cancel', async () => {
        const running = runToExit(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {cwd: root, env: {}, timeout: 100, killGraceMs: 100});

        await expect(running).rejects.toMatchObject({canceled: false, message: expect.stringMatching(/timed out after 100 ms$/)});
    });

    test('an already-canceled Start starts nothing', async () => {
        const controller = new AbortController();

        controller.abort();
        await expect(runToExit(process.execPath, ['-e', ''], {cwd: root, env: {}, signal: controller.signal})).rejects.toMatchObject({canceled: true});
    });
});

test.describe("resolveLoginShellNpm — npm comes from the operator's shell, not the Fleet's PATH", () => {
    test('no SHELL is a named reason, never a guessed shell', async () => {
        const execute = recorder(), {SHELL, ...env} = FLEET_ENV;

        expect(SHELL).toBe('/bin/zsh');
        expect(await resolveLoginShellNpm({env, execute})).toEqual({reason: 'no login shell (SHELL) to resolve npm from'});
        expect(execute.calls).toHaveLength(0);
    });

    test("the markers find npm and PATH among a profile's own output, and the shell gets no credentials", async () => {
        const execute = recorder(async () => ({
            stdout: `Last login: today\n__NEO_NPM__${RESOLVED.npm}\n__NEO_PATH__${RESOLVED.PATH}\nprofile noise\n`,
            stderr: 'zsh: no job control in this shell'
        }));

        expect(await resolveLoginShellNpm({env: FLEET_ENV, execute})).toEqual(RESOLVED);

        const [file, args, options] = execute.calls[0];

        expect(file).toBe('/bin/zsh');
        // interactive as well as login: version managers hook into the interactive profile
        expect(args[0]).toBe('-ilc');
        expect(options.env).toEqual(SHELL_ENV);
    });

    test('a shell that knows no npm is a named reason', async () => {
        const execute = recorder(async () => ({stdout: '__NEO_NPM__\n__NEO_PATH__/usr/bin:/bin\n', stderr: ''}));

        expect(await resolveLoginShellNpm({env: FLEET_ENV, execute})).toEqual({reason: 'npm is not on the PATH of the login shell /bin/zsh'});
    });

    test('a shell that fails or times out answers with its redacted reason', async () => {
        const execute = recorder(async () => { throw new Error('Command failed: /bin/zsh -ilc … killed (SIGTERM)') });

        expect(await resolveLoginShellNpm({env: FLEET_ENV, execute}))
            .toEqual({reason: 'the login shell /bin/zsh could not resolve npm: Command failed: /bin/zsh -ilc … killed (SIGTERM)'});
    });
});

test.describe('installSeatDependencies — one row per checkout, the receipt kept across Starts', () => {
    let seatRoot;

    const checkouts = [
        {repoSlug: 'neomjs/neo',                   repoPath: '/seat/neomjs/neo'},
        {repoSlug: 'neomjs/neo-agent-brain',       repoPath: '/seat/neomjs/neo-agent-brain'},
        {repoSlug: 'neomjs/neo-agent-institution', repoPath: '/seat/neomjs/neo-agent-institution'}
    ];

    const receipt = () => JSON.parse(fs.readFileSync(path.join(seatRoot, DEPENDENCY_RECEIPT), 'utf8'));

    test.beforeEach(() => { seatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-root-')) });
    test.afterEach(() => { fs.rmSync(seatRoot, {recursive: true, force: true}) });

    test('checkouts install in parallel, keep their order, share one npm resolution, and receipt each outcome', async () => {
        const resolveNpm = recorder(async () => RESOLVED),
              signal     = new AbortController().signal,
              // the working checkout answers last, so an order taken from completion would show it
              delays     = {'/seat/neomjs/neo': 30, '/seat/neomjs/neo-agent-brain': 0, '/seat/neomjs/neo-agent-institution': 10},
              install    = async ({repoPath, prior, signal: received, resolveNpm: resolveOnce, record}) => {
                  expect([prior, received]).toEqual([null, signal]);
                  await resolveOnce();
                  await record({state: 'installing'});
                  await new Promise(resolve => setTimeout(resolve, delays[repoPath]));

                  const outcome = repoPath.endsWith('institution') ? {state: 'failed', reason: 'npm ci exited 1'} : {state: 'installed'};

                  await record(outcome);

                  return outcome
              };

        expect(await installSeatDependencies({checkouts, seatRoot, signal, install, resolveNpm, now: () => '2026-10-08T19:40:00.000Z'})).toEqual([
            {repoSlug: 'neomjs/neo',                   state: 'installed'},
            {repoSlug: 'neomjs/neo-agent-brain',       state: 'installed'},
            {repoSlug: 'neomjs/neo-agent-institution', state: 'failed', reason: 'npm ci exited 1'}
        ]);
        expect(resolveNpm.calls).toHaveLength(1);
        expect(receipt()).toEqual({
            'neomjs/neo'                  : {state: 'installed', at: '2026-10-08T19:40:00.000Z'},
            'neomjs/neo-agent-brain'      : {state: 'installed', at: '2026-10-08T19:40:00.000Z'},
            'neomjs/neo-agent-institution': {state: 'failed', reason: 'npm ci exited 1', at: '2026-10-08T19:40:00.000Z'}
        });
    });

    test("the next Start hands each checkout its receipt entry, so a failed install's leftover tree is retried", async () => {
        fs.writeFileSync(path.join(seatRoot, DEPENDENCY_RECEIPT), JSON.stringify({'neomjs/neo': {state: 'failed', reason: 'npm ci exited 1', at: 'earlier'}}));

        const priors  = {},
              install = async ({repoPath, prior}) => { priors[repoPath] = prior; return {state: 'present'} };

        await installSeatDependencies({checkouts: checkouts.slice(0, 2), seatRoot, install, resolveNpm: async () => RESOLVED});

        expect(priors).toEqual({
            '/seat/neomjs/neo'            : {state: 'failed', reason: 'npm ci exited 1', at: 'earlier'},
            '/seat/neomjs/neo-agent-brain': null
        });
    });

    test('an unreadable receipt reads as no owned install, so nothing is vouched for', async () => {
        fs.writeFileSync(path.join(seatRoot, DEPENDENCY_RECEIPT), '{not json');

        const priors = [];

        await installSeatDependencies({checkouts: checkouts.slice(0, 1), seatRoot, install: async ({prior}) => { priors.push(prior); return {state: 'unverified'} }});

        expect(priors).toEqual([null]);
    });
});

test.describe('installAgentRepoDependencies + installSeatDependencies — a failed install, then the next Start', () => {
    let root;

    test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-retry-')) });
    test.afterEach(() => { fs.rmSync(root, {recursive: true, force: true}) });

    test('npm ci that leaves a half-built node_modules and fails is installed again on the next Start, not reported present', async () => {
        const repoPath = path.join(root, 'neomjs', 'neo');

        fs.mkdirSync(repoPath, {recursive: true});
        fs.writeFileSync(path.join(repoPath, 'package-lock.json'), '{"lockfileVersion":3}');

        let attempt = 0;

        const run = async () => {
                  attempt++;
                  fs.mkdirSync(path.join(repoPath, 'node_modules'), {recursive: true});
                  if (attempt === 1) throw new Error('npm ci exited 1: prepare failed')
              },
              start = () => installSeatDependencies({
                  checkouts : [{repoSlug: 'neomjs/neo', repoPath}],
                  seatRoot  : root,
                  resolveNpm: async () => RESOLVED,
                  install   : options => installAgentRepoDependencies({...options, env: FLEET_ENV, run})
              });

        expect(await start()).toEqual([{repoSlug: 'neomjs/neo', state: 'failed', reason: 'npm ci exited 1: prepare failed'}]);
        expect(await start()).toEqual([{repoSlug: 'neomjs/neo', state: 'installed'}]);
        expect(await start()).toEqual([{repoSlug: 'neomjs/neo', state: 'present'}]);
        expect(attempt).toBe(2);
    });
});
