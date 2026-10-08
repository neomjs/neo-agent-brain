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

    test('a process the command started ends with it: a child that ignores SIGTERM stops writing before the answer', async () => {
        // the leader honours SIGTERM at once; its child, like an npm lifecycle script, ignores it and keeps writing
        const pidFile    = path.join(root, 'pid'),
              heartbeat  = path.join(root, 'heartbeat'),
              writer     = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => require('fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20)`,
              script     = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {stdio: 'ignore'}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`,
              controller = new AbortController(),
              running    = runToExit(process.execPath, ['-e', script], {cwd: root, env: {}, signal: controller.signal, killGraceMs: 200});

        await expect.poll(() => fs.existsSync(heartbeat)).toBe(true);
        controller.abort();
        await expect(running).rejects.toMatchObject({canceled: true});

        const pid = Number(fs.readFileSync(pidFile, 'utf8')), written = fs.statSync(heartbeat).size;

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(alive(pid)).toBe(false);
        expect(fs.statSync(heartbeat).size).toBe(written);
    });

    test('a real npm run whose script ignores SIGTERM: a Stop ends the script before the answer, and nothing writes after it', async () => {
        const npm = path.join(path.dirname(process.execPath), 'npm');

        test.skip(!fs.existsSync(npm), `no npm beside ${process.execPath}`);

        const heartbeat = path.join(root, 'heartbeat'),
              pidFile   = path.join(root, 'pid');

        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'hold', version: '1.0.0', private: true, scripts: {hold: 'node hold.js'}}));
        fs.writeFileSync(path.join(root, 'hold.js'), "require('fs').writeFileSync('pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => require('fs').appendFileSync('heartbeat', '.'), 20)");

        const controller = new AbortController(),
              env        = {PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, npm_config_cache: path.join(root, '.npm'), npm_config_update_notifier: 'false'},
              running    = runToExit(npm, ['run', 'hold'], {cwd: root, env, signal: controller.signal, killGraceMs: 300});

        await expect.poll(() => fs.existsSync(heartbeat), {timeout: 15_000}).toBe(true);
        controller.abort();
        await expect(running).rejects.toMatchObject({canceled: true});

        const pid = Number(fs.readFileSync(pidFile, 'utf8')), written = fs.statSync(heartbeat).size;

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(alive(pid)).toBe(false);
        expect(fs.statSync(heartbeat).size).toBe(written);
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

    test('a receipt that cannot record the install keeps npm from running, so an old installed entry never vouches for a half-built tree', async () => {
        const repoPath = path.join(root, 'neomjs', 'neo');

        fs.mkdirSync(repoPath, {recursive: true});
        fs.writeFileSync(path.join(repoPath, 'package-lock.json'), '{"lockfileVersion":3}');
        // an earlier owned install finished, and its tree has since gone
        fs.writeFileSync(path.join(root, DEPENDENCY_RECEIPT), JSON.stringify({'neomjs/neo': {state: 'installed', at: 'earlier'}}));

        let attempts = 0;

        const run = async () => {
                  attempts++;
                  fs.mkdirSync(path.join(repoPath, 'node_modules'), {recursive: true});
                  throw new Error('npm ci exited 1: prepare failed')
              },
              start = write => installSeatDependencies({
                  checkouts : [{repoSlug: 'neomjs/neo', repoPath}],
                  seatRoot  : root,
                  resolveNpm: async () => RESOLVED,
                  install   : options => installAgentRepoDependencies({...options, env: FLEET_ENV, run}),
                  ...(write ? {write} : {})
              });

        const [refused] = await start(async () => { throw new Error('EACCES: permission denied, rename') });

        expect(refused).toEqual({repoSlug: 'neomjs/neo', state: 'failed', reason: expect.stringContaining('the seat receipt could not record the install, so npm did not run')});
        expect(attempts).toBe(0);
        expect(fs.existsSync(path.join(repoPath, 'node_modules'))).toBe(false);

        // with writes back, each Start installs, and the half-built tree it leaves is never read as present
        expect(await start()).toEqual([{repoSlug: 'neomjs/neo', state: 'failed', reason: 'npm ci exited 1: prepare failed'}]);
        expect(await start()).toEqual([{repoSlug: 'neomjs/neo', state: 'failed', reason: 'npm ci exited 1: prepare failed'}]);
        expect(attempts).toBe(2);
    });

    test('an install the receipt could not record reads installed with that reason, and the next Start installs again', async () => {
        const repoPath = path.join(root, 'neomjs', 'neo');

        fs.mkdirSync(repoPath, {recursive: true});
        fs.writeFileSync(path.join(repoPath, 'package-lock.json'), '{"lockfileVersion":3}');

        let attempts = 0;

        const run   = async () => { attempts++; fs.mkdirSync(path.join(repoPath, 'node_modules'), {recursive: true}) },
              start = write => installSeatDependencies({
                  checkouts : [{repoSlug: 'neomjs/neo', repoPath}],
                  seatRoot  : root,
                  resolveNpm: async () => RESOLVED,
                  install   : options => installAgentRepoDependencies({...options, env: FLEET_ENV, run}),
                  ...(write ? {write} : {})
              });

        // `installing` lands, the outcome does not
        const [unrecorded] = await start(async (file, text) => {
            if (text.includes('"installed"')) throw new Error('EIO: i/o error, rename');
            fs.writeFileSync(file, text)
        });

        expect(unrecorded).toEqual({repoSlug: 'neomjs/neo', state: 'installed', reason: expect.stringContaining('the seat receipt could not record it, so the next Start installs again')});
        expect(JSON.parse(fs.readFileSync(path.join(root, DEPENDENCY_RECEIPT), 'utf8'))['neomjs/neo'].state).toBe('installing');

        expect(await start()).toEqual([{repoSlug: 'neomjs/neo', state: 'installed'}]);
        expect(attempts).toBe(2);
    });
});

test.describe('installSeatDependencies — live rows, and a Skip that drains npm without stopping the Start', () => {
    let seatRoot;

    test.beforeEach(() => { seatRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-skip-')) });
    test.afterEach(() => { fs.rmSync(seatRoot, {recursive: true, force: true}) });

    const checkouts = [
        {repoSlug: 'neomjs/neo',             repoPath: '/seat/neomjs/neo'},
        {repoSlug: 'neomjs/neo-agent-brain', repoPath: '/seat/neomjs/neo-agent-brain'}
    ];

    /** An install that runs until its signal stops it, unless it is told to finish first. */
    const installUntil = finishes => async ({repoPath, signal, record}) => {
        await record({state: 'installing'});

        if (finishes.has(repoPath)) {
            await record({state: 'installed'});
            return {state: 'installed'}
        }

        await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, {once: true}));
        await record({state: 'failed', reason: 'npm ci canceled'});

        return {state: 'failed', reason: 'npm ci canceled', canceled: true}
    };

    test('each row reaches onRows as it changes, the working checkout first', async () => {
        const seen    = [],
              install = async ({repoPath, record}) => {
                  if (repoPath.endsWith('brain')) return {state: 'present'};

                  await record({state: 'installing'});
                  await record({state: 'installed'});

                  return {state: 'installed'}
              };

        await installSeatDependencies({checkouts, seatRoot, install, onRows: rows => seen.push(rows)});

        expect(seen).toEqual([
            [{repoSlug: 'neomjs/neo', state: 'installing'}],
            [{repoSlug: 'neomjs/neo', state: 'installing'}, {repoSlug: 'neomjs/neo-agent-brain', state: 'present'}],
            [{repoSlug: 'neomjs/neo', state: 'installed'},  {repoSlug: 'neomjs/neo-agent-brain', state: 'present'}]
        ]);
    });

    test('a Skip marks only the interrupted install skipped, keeps a finished one, and the receipt has it redo', async () => {
        const start = new AbortController(),
              skip  = new AbortController(),
              rows  = installSeatDependencies({
                  checkouts,
                  seatRoot,
                  signal    : start.signal,
                  skipSignal: skip.signal,
                  install   : installUntil(new Set(['/seat/neomjs/neo-agent-brain']))
              });

        setTimeout(() => skip.abort(), 20);

        expect(await rows).toEqual([
            {repoSlug: 'neomjs/neo',             state: 'skipped', reason: 'skipped during the install'},
            {repoSlug: 'neomjs/neo-agent-brain', state: 'installed'}
        ]);
        expect(start.signal.aborted).toBe(false);
        // the interrupted tree is the Fleet's own unfinished attempt: the next Start installs it again
        expect(JSON.parse(fs.readFileSync(path.join(seatRoot, DEPENDENCY_RECEIPT), 'utf8'))['neomjs/neo'].state).toBe('failed');
    });

    test('a Stop wins over a Skip: the interrupted install reads canceled, never skipped or failed, and a finished one keeps its outcome', async () => {
        const start = new AbortController(),
              skip  = new AbortController(),
              rows  = installSeatDependencies({checkouts, seatRoot, signal: start.signal, skipSignal: skip.signal, install: installUntil(new Set(['/seat/neomjs/neo-agent-brain']))});

        setTimeout(() => { skip.abort(); start.abort() }, 20);

        expect(await rows).toEqual([
            {repoSlug: 'neomjs/neo',             state: 'canceled', reason: 'stopped during the install'},
            {repoSlug: 'neomjs/neo-agent-brain', state: 'installed'}
        ]);
        // the receipt still has the next Start install it again
        expect(JSON.parse(fs.readFileSync(path.join(seatRoot, DEPENDENCY_RECEIPT), 'utf8'))['neomjs/neo'].state).toBe('failed');
    });

    test('a stopped run reports canceled, so its caller can tell a Skip or a Stop from a failure', async () => {
        const root     = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-cancel-')),
              repoPath = path.join(root, 'neo');

        try {
            fs.mkdirSync(repoPath);
            fs.writeFileSync(path.join(repoPath, 'package-lock.json'), '{"lockfileVersion":3}');

            const run = async () => { throw Object.assign(new Error('npm ci canceled'), {canceled: true}) };

            expect(await installAgentRepoDependencies({repoPath, env: FLEET_ENV, run, resolveNpm: async () => RESOLVED}))
                .toEqual({state: 'failed', reason: 'npm ci canceled', canceled: true});
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    });
});
