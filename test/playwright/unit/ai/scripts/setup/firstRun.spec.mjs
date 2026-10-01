import {expect, test} from '@playwright/test';
import {execFile}     from 'node:child_process';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify}    from 'node:util';
import {fakeHostObservers, hostLayout, parseArgs} from '../../../../../../ai/scripts/setup/firstRun.mjs';

// The CLI on a fake host: a child process per arm, stdin closed (never a TTY), the record under a temp setup root.

const
    execFileAsync = promisify(execFile),
    here          = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot     = path.resolve(here, '../../../../../..'),
    script        = path.join(brainRoot, 'ai/scripts/setup/firstRun.mjs'),
    PAT           = 'ghp_FAKEPAT0123456789abcdefghijklmnopqrstuv',
    RUN_ID        = '0f1e2d3c-4b5a-4968-8777-6655443322aa';

async function scratch() {
    const
        root      = await fs.mkdtemp(path.join(os.tmpdir(), 'first-run-cli-')),
        setupRoot = path.join(root, 'state', 'setup'),
        patPath   = path.join(root, 'operator', 'plane-pat');

    await fs.mkdir(path.dirname(patPath), {recursive: true});
    await fs.writeFile(patPath, `${PAT}\n`, {mode: 0o600});

    return {root, setupRoot, patPath, stateRoot: path.join(root, 'state')};
}

/**
 * The fixture names the observers a fake host cannot read for real (the probe, the served plane, the
 * provider round trip, the first persistence); the carrier, the secret files and the compose project are
 * read from the temp layout and the recording runner by the CLI's own fake-host seam.
 */
function greenFake({patPath, planeId = 'plane-a', dataRoot = '/srv/plane-a', servedPlane = {id: planeId, dataRoot}, done = {queryAnswered: true, persisted: true}, answers = true}) {
    return {
        observers: {
            placement  : {host: {complete: true, availableBytes: 64 * 1073741824, pressure: 'ok'}, guest: null, observed: {}, runningPlane: null},
            servedPlane,
            validation : {provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: 1024}},
            done
        },
        answers: answers ? {preset: 'local-small', 'plane-credential': patPath} : {}
    };
}

async function runCli({setupRoot, stateRoot, fake, extra = []}) {
    const fakePath = path.join(stateRoot, 'fake-host.json');

    await fs.mkdir(stateRoot, {recursive: true});
    await fs.writeFile(fakePath, JSON.stringify(fake));

    const args = [script, '--json', '--setup-root', setupRoot, '--state-root', stateRoot, '--run-id', RUN_ID, '--plane-id', 'plane-a', '--data-root', '/srv/plane-a', '--endpoint', 'http://127.0.0.1:3102', '--fake-host', fakePath, ...extra];

    try {
        const {stdout, stderr} = await execFileAsync(process.execPath, args, {cwd: brainRoot, encoding: 'utf8', env: {...process.env, NEO_HOST_SETUP_RECORD_ROOT: ''}});

        return {code: 0, stdout, stderr};
    } catch (error) {
        return {code: error.code, stdout: error.stdout, stderr: error.stderr};
    }
}

test.describe('firstRun CLI', () => {
    test('AC-5: a cold run on a fake host answers the questions, performs the effects, lists every step with status and reason, and exits 0 on a green terminal step', async () => {
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            result = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})}),
            output = JSON.parse(result.stdout);

        expect(result.code, result.stderr).toBe(0);
        expect(output.runId).toBe(RUN_ID);
        expect(output.binding).toBe('bound');
        expect(output.steps).toHaveLength(10);

        for (const step of output.steps) {
            expect(typeof step.status, step.id).toBe('string');
            expect(typeof step.reason, step.id).toBe('string');
            expect(step.status, `${step.id}: ${step.reason}`).toBe('ok');
        }
        expect(output.steps.find(step => step.id === 'preset').answer).toBe('local-small');
        expect(output.steps.find(step => step.id === 'plane-credential').answer).toBe(patPath);

        // the record: consents and accepted receipts, owner-only, secret-free; the carrier and the secret file, owner-only
        const
            recordText = await fs.readFile(path.join(setupRoot, `${RUN_ID}.json`), 'utf8'),
            record     = JSON.parse(recordText),
            layout     = hostLayout({stateRoot});

        expect(recordText).not.toContain(PAT);
        expect(record.consents.map(consent => consent.stepId).sort()).toEqual(['plane-credential', 'preset']);
        expect(record.receipts.map(receipt => [receipt.effectId, receipt.outcome])).toEqual([['write-env', 'accepted'], ['write-secrets', 'accepted'], ['compose-up', 'accepted']]);
        expect((await fs.stat(path.join(setupRoot, `${RUN_ID}.json`))).mode & 0o777).toBe(0o600);

        const env = await fs.readFile(layout.envFile, 'utf8');

        expect(env).toContain(`GH_TOKEN=${PAT}\n`);
        expect(env).toContain('NEO_PLANE_ID=plane-a\n');
        expect(env).toContain('NEO_PLANE_DATA_ROOT=/srv/plane-a\n');
        expect(env).toContain('NEO_VECTOR_DIMENSION=1024\n');
        expect(env).toContain('NEO_MODEL_PROVIDER=openAiCompatible\n');
        expect((await fs.stat(layout.envFile)).mode & 0o777).toBe(0o600);
        expect(await fs.readFile(path.join(layout.secretsDir, 'fleet-plane-token'), 'utf8')).toBe(PAT);

        // the compose invocation went through the recording runner, in the checkout's deploy folder
        const calls = JSON.parse(await fs.readFile(path.join(setupRoot, 'fake-run.json'), 'utf8'));

        expect(calls).toEqual([{command: 'docker', args: ['compose', '-p', 'neo-local-agent-os', '--env-file', layout.envFile, '-f', 'docker-compose.yml', '-f', 'docker-compose.local-agent-os.yml', 'up', '-d', '--wait'], cwd: path.join(brainRoot, 'deploy', 'cloud')}]);

        // a resumed run performs nothing again and exits 0
        const resumed = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})});

        expect(resumed.code).toBe(0);
        expect(JSON.parse(await fs.readFile(path.join(setupRoot, 'fake-run.json'), 'utf8'))).toHaveLength(1);
        expect(JSON.parse(resumed.stdout).steps.find(step => step.id === 'write-env').reason).toBe('observed; matches the accepted receipt');
    });

    test('the exit code reflects the terminal step: a failed terminal observation exits 1; unanswered questions without a TTY exit 2 and never prompt', async () => {
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            failed = await runCli({setupRoot, stateRoot, fake: greenFake({patPath, done: {queryAnswered: true, persisted: false, reason: 'nothing persisted yet'}})});

        expect(failed.code).toBe(1);
        expect(JSON.parse(failed.stdout).steps.find(step => step.id === 'done')).toMatchObject({status: 'failed', reason: 'nothing persisted yet'});

        // nothing serves yet, nothing answered, no TTY: the questions stay pending, no effect runs, no prompt blocks the process
        const
            fresh   = await scratch(),
            pending = await runCli({setupRoot: fresh.setupRoot, stateRoot: fresh.stateRoot, fake: greenFake({patPath: fresh.patPath, answers: false, servedPlane: {throw: 'connection refused'}, done: {throw: 'no plane to ask'}})}),
            output  = JSON.parse(pending.stdout);

        expect(pending.code).toBe(2);
        expect(output.steps.find(step => step.id === 'preset')).toMatchObject({status: 'pending', reason: 'unanswered'});
        expect(output.steps.find(step => step.id === 'write-env')).toMatchObject({status: 'pending'});
        expect(output.steps.find(step => step.id === 'served-plane')).toMatchObject({status: 'unknown', reason: 'connection refused'});
        expect(output.steps.find(step => step.id === 'done')).toMatchObject({status: 'unknown', reason: 'no plane to ask'});
        await expect(fs.access(path.join(fresh.stateRoot, 'config'))).rejects.toThrow();
    });

    test('a wrong plane answering fails the served-plane step and exits 1; a record bound to another target is retired into history', async () => {
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            first = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})}),
            wrong = await runCli({setupRoot, stateRoot, fake: greenFake({patPath, planeId: 'plane-b'})}),
            output = JSON.parse(wrong.stdout);

        expect(first.code).toBe(0);
        expect(wrong.code).toBe(1);
        expect(output.steps.find(step => step.id === 'served-plane')).toMatchObject({status: 'failed'});
        expect(output.steps.find(step => step.id === 'served-plane').reason).toMatch(/a different plane is answering/);

        const
            rebound = await runCli({setupRoot, stateRoot, fake: greenFake({patPath, planeId: 'plane-c', dataRoot: '/srv/plane-c'}), extra: ['--plane-id', 'plane-c', '--data-root', '/srv/plane-c']}),
            record  = JSON.parse(await fs.readFile(path.join(setupRoot, `${RUN_ID}.json`), 'utf8'));

        expect(rebound.stderr).toMatch(/target-mismatch; prior consents and receipts retired into history/);
        expect(record.history).toHaveLength(1);
        expect(record.history[0].reason).toBe('target-changed');
        expect(record.target.planeId).toBe('plane-c');
    });

    test('parseArgs: defaults under the host state root, env overrides, unknown flags refused; a fake host turns thrown observers into failures', () => {
        const defaults = parseArgs([], {});

        expect(defaults.setupRoot).toBe(path.join(os.homedir(), '.neo-ai', 'setup'));
        expect(defaults.endpoint).toBe('http://127.0.0.1:3102');
        expect(parseArgs(['--setup-root', '/x/setup'], {NEO_HOST_SETUP_RECORD_ROOT: '/env/setup'}).setupRoot).toBe('/x/setup');
        expect(parseArgs([], {NEO_HOST_SETUP_RECORD_ROOT: '/env/setup'}).setupRoot).toBe('/env/setup');
        expect(parseArgs([], {NEO_HOST_STATE_ROOT: '/srv/state'}).setupRoot).toBe('/srv/state/setup');
        expect(() => parseArgs(['--bogus'], {})).toThrow(/unknown flag '--bogus'/);
        expect(() => parseArgs(['--plane-id'], {})).toThrow(/needs a value/);
        expect(hostLayout({stateRoot: '/srv/state'}).envFile).toBe('/srv/state/config/local-agent-os.env');

        const {observers, answers} = fakeHostObservers({observers: {done: {throw: 'kb unreachable'}, servedPlane: {id: 'p'}}, answers: {preset: 'hosted'}});

        expect(answers).toEqual({preset: 'hosted'});
        return expect(observers.done()).rejects.toThrow('kb unreachable');
    });
});
