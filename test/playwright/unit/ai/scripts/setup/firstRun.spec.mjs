import {expect, test} from '@playwright/test';
import {execFile}     from 'node:child_process';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify}    from 'node:util';
import {PLANE_MEMORY_CORE_PATH, fakeHostObservers, hostLayout, parseArgs, productionObservers} from '../../../../../../ai/scripts/setup/firstRun.mjs';
import {RECIPE_VERSION, evaluateRecipe}                  from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {createHost}                                      from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {presets}                                         from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {createSetupRecord, withConsent}                  from '../../../../../../ai/services/fleet/setupRunRecord.mjs';

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
            validation  : {provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: 1024}},
            // a fake host has no plane to witness through: the witness effect's observation and the terminal read are the fixture's
            verification: {present: true, digest: null, problem: null},
            done
        },
        answers: answers ? {preset: 'local-small', 'plane-credential': patPath} : {}
    };
}

/** One CLI run; `dataRoot: null` omits `--data-root` (the resume that names only the identity). */
async function runCli({setupRoot, stateRoot, fake, extra = [], dataRoot = '/srv/plane-a'}) {
    const fakePath = path.join(stateRoot, 'fake-host.json');

    await fs.mkdir(stateRoot, {recursive: true});
    await fs.writeFile(fakePath, JSON.stringify(fake));

    const args = [script, '--json', '--setup-root', setupRoot, '--state-root', stateRoot, '--run-id', RUN_ID, '--plane-id', 'plane-a', ...(dataRoot ? ['--data-root', dataRoot] : []), '--endpoint', 'http://127.0.0.1:3102', '--fake-host', fakePath, ...extra];

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
        expect(output.steps).toHaveLength(12);

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
        expect(record.receipts.map(receipt => [receipt.effectId, receipt.outcome])).toEqual([['write-secrets', 'accepted'], ['write-env', 'accepted'], ['compose-up', 'accepted']]);
        expect((await fs.stat(path.join(setupRoot, `${RUN_ID}.json`))).mode & 0o777).toBe(0o600);
        expect(output.steps.find(step => step.id === 'provider-key')).toMatchObject({status: 'ok', reason: "not needed: the 'local-small' preset requires no providerKey"});

        const env = await fs.readFile(layout.envFile, 'utf8');

        // the carrier holds paths, never a value: the admission token and the minted Fleet bearer by file
        expect(env).not.toContain(PAT);
        expect(env).toContain(`NEO_MCP_AUTH_TOKEN_FILE=${layout.secretsDir}/mcp-auth-token\n`);
        expect(env).toContain(`NEO_FLEET_PLANE_TOKEN_FILE=${layout.secretsDir}/fleet-plane-token\n`);
        expect(env).not.toContain('GEMINI_API_KEY_FILE');
        expect(env).toContain('NEO_PLANE_ID=plane-a\n');
        expect(env).toContain('NEO_PLANE_DATA_ROOT=/srv/plane-a\n');
        expect(env).toContain('NEO_VECTOR_DIMENSION=1024\n');
        expect(env).toContain('NEO_MODEL_PROVIDER=openAiCompatible\n');
        expect(env).toContain('NEO_LOCAL_AGENT_OS_EMBEDDING_MODEL=text-embedding-qwen3-embedding-0.6b\n');
        expect((await fs.stat(layout.envFile)).mode & 0o777).toBe(0o600);
        // the PAT is the admission token; the Fleet bearer is a distinct mint; both owner-only
        expect(await fs.readFile(path.join(layout.secretsDir, 'mcp-auth-token'), 'utf8')).toBe(PAT);
        expect(await fs.readFile(path.join(layout.secretsDir, 'fleet-plane-token'), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
        expect((await fs.stat(path.join(layout.secretsDir, 'mcp-auth-token'))).mode & 0o777).toBe(0o600);
        await expect(fs.access(path.join(layout.secretsDir, 'gemini-api-key'))).rejects.toThrow();

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

    test('a resume that names only the identity keeps the record\'s bound root: a different served root still fails, a matching one resumes, and the explicit mismatch control stands', async () => {
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            first    = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})}),
            // the same run without --data-root while the plane answers with the identity over another root
            idOnly   = await runCli({setupRoot, stateRoot, dataRoot: null, fake: greenFake({patPath, servedPlane: {id: 'plane-a', dataRoot: '/srv/plane-b'}})}),
            idOnlyOk = await runCli({setupRoot, stateRoot, dataRoot: null, fake: greenFake({patPath})}),
            explicit = await runCli({setupRoot, stateRoot, fake: greenFake({patPath, servedPlane: {id: 'plane-a', dataRoot: '/srv/plane-b'}})});

        expect(first.code).toBe(0);
        expect(idOnly.code).toBe(1);
        expect(JSON.parse(idOnly.stdout).target).toEqual({planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'});
        expect(JSON.parse(idOnly.stdout).steps.find(step => step.id === 'served-plane')).toMatchObject({status: 'failed'});
        expect(JSON.parse(idOnly.stdout).steps.find(step => step.id === 'served-plane').reason).toMatch(/same identity, different storage/);
        expect(idOnlyOk.code).toBe(0);
        expect(JSON.parse(idOnlyOk.stdout).binding).toBe('bound');
        expect(explicit.code).toBe(1);
        // the record stayed bound to its root throughout: nothing was retired
        expect(JSON.parse(await fs.readFile(path.join(setupRoot, `${RUN_ID}.json`), 'utf8')).history).toHaveLength(0);
    });

    test('a pasted token given as the credential answer is refused before the consent write and never appears in the record, stdout or stderr; a directory, a relative or a missing path are refused by their own rule; the real file is admitted', async () => {
        const
            {root, setupRoot, stateRoot, patPath} = await scratch(),
            PASTED     = 'FAKE_PASTED_PAT_DO_NOT_STORE_20261002',
            fake       = greenFake({patPath, servedPlane: {throw: 'connection refused'}, done: {throw: 'no plane to ask'}}),
            pasted     = await runCli({setupRoot, stateRoot, fake: {...fake, answers: {preset: 'local-small', 'plane-credential': PASTED}}}),
            recordText = await fs.readFile(path.join(setupRoot, `${RUN_ID}.json`), 'utf8');

        expect(pasted.code).toBe(2);
        expect(pasted.stderr).toContain('plane-credential: not the absolute path of a file; the value was not recorded');
        expect(pasted.stderr).not.toContain(PASTED);
        expect(pasted.stdout).not.toContain(PASTED);
        expect(recordText).not.toContain(PASTED);
        expect(JSON.parse(pasted.stdout).steps.find(step => step.id === 'plane-credential')).toMatchObject({status: 'pending', reason: 'unanswered'});
        expect(JSON.parse(recordText).consents.map(consent => consent.stepId)).toEqual(['preset']);
        await expect(fs.access(path.join(stateRoot, 'config'))).rejects.toThrow();

        const
            dir      = await runCli({setupRoot, stateRoot, fake: {...fake, answers: {'plane-credential': path.dirname(patPath)}}}),
            relative = await runCli({setupRoot, stateRoot, fake: {...fake, answers: {'plane-credential': 'operator/plane-pat'}}}),
            missing  = await runCli({setupRoot, stateRoot, fake: {...fake, answers: {'plane-credential': path.join(root, 'missing')}}}),
            admitted = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})});

        expect(dir.stderr).toContain('plane-credential: the path is not a regular file; the value was not recorded');
        expect(relative.stderr).toContain('plane-credential: not the absolute path of a file; the value was not recorded');
        expect(missing.stderr).toContain('plane-credential: no readable file at that path; the value was not recorded');
        expect(admitted.code).toBe(0);
        expect(JSON.parse(admitted.stdout).steps.find(step => step.id === 'plane-credential').answer).toBe(patPath);
    });

    test('a pending receipt left on disk resumes through the CLI as reconcile-required with JSON output and no replay: the plane\'s own effect stays so under a wrong plane and the halt is reported, a matching observation settles it; a host-file effect settles by its own observation with no plane answering (ADR 0041 §3, the renderer\'s half)', async () => {
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            recordPath = path.join(setupRoot, `${RUN_ID}.json`),
            callsPath  = path.join(setupRoot, 'fake-run.json'),
            first      = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})}),
            receiptOf  = async effectId => JSON.parse(await fs.readFile(recordPath, 'utf8')).receipts.find(receipt => receipt.effectId === effectId),
            // what a crash between the handler and its receipt leaves on disk: the effect's receipt still pending
            park       = async effectId => {
                const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));

                record.receipts = record.receipts.map(receipt => receipt.effectId === effectId ? {effectId, outcome: 'pending', inputDigest: receipt.inputDigest, startedAt: receipt.acceptedAt} : receipt);
                await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
            };

        expect(first.code).toBe(0);
        await park('compose-up');

        const wrong = await runCli({setupRoot, stateRoot, fake: greenFake({patPath, servedPlane: {id: 'plane-b', dataRoot: '/srv/plane-b'}})});

        expect(wrong.code).toBe(1);
        expect(JSON.parse(wrong.stdout).steps.find(step => step.id === 'compose-up')).toMatchObject({status: 'reconcile-required', effectId: 'compose-up', receipt: 'reconcile-required'});
        expect(await receiptOf('compose-up')).toMatchObject({outcome: 'reconcile-required', reason: expect.stringMatching(/may have run before its receipt was written/)});
        expect(wrong.stderr).toContain('\'compose-up\' was interrupted and is not settled, so nothing runs past it: the served plane does not match the target yet, or the result is not observable');
        expect(JSON.parse(await fs.readFile(callsPath, 'utf8'))).toHaveLength(1);

        const settled = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})});

        expect(settled.code).toBe(0);
        expect(JSON.parse(settled.stdout).steps.find(step => step.id === 'compose-up')).toMatchObject({status: 'ok', reason: 'observed; matches the accepted receipt'});
        expect(await receiptOf('compose-up')).toMatchObject({outcome: 'accepted', settledBy: 'observation'});
        expect(JSON.parse(await fs.readFile(callsPath, 'utf8'))).toHaveLength(1);

        // a pending receipt whose first resume already matches settles directly
        await park('compose-up');

        const direct = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})});

        expect(direct.code).toBe(0);
        expect(await receiptOf('compose-up')).toMatchObject({outcome: 'accepted', settledBy: 'observation'});
        expect(JSON.parse(await fs.readFile(callsPath, 'utf8'))).toHaveLength(1);

        // the carrier is a host file: its own observation settles it while another plane answers
        await park('write-env');

        const file = await runCli({setupRoot, stateRoot, fake: greenFake({patPath, servedPlane: {id: 'plane-b', dataRoot: '/srv/plane-b'}})});

        expect(file.code, 'the served plane still fails the run').toBe(1);
        expect(JSON.parse(file.stdout).steps.find(step => step.id === 'write-env')).toMatchObject({status: 'ok', reason: 'observed; matches the accepted receipt'});
        expect(await receiptOf('write-env')).toMatchObject({outcome: 'accepted', settledBy: 'observation'});
        expect(JSON.parse(await fs.readFile(callsPath, 'utf8'))).toHaveLength(1);
    });

    test('an interrupted hosted secret write that left one of its three files stays unsettled and names the missing files; the complete set settles it', async () => {
        const
            {root, setupRoot, stateRoot, patPath} = await scratch(),
            keyPath                               = path.join(root, 'operator', 'gemini-key'),
            recordPath                            = path.join(setupRoot, `${RUN_ID}.json`),
            layout                                = hostLayout({stateRoot}),
            fake                                  = greenFake({patPath}),
            hosted                                = servedPlane => ({...fake, observers: {...fake.observers, servedPlane, validation: {provider: {ok: true, model: 'gemini-3.8-flash'}, embedding: {ok: true, dimension: 3072}}}, answers: {preset: 'hosted', 'plane-credential': patPath, 'provider-key': keyPath}}),
            cold                                  = {throw: 'connect ECONNREFUSED 127.0.0.1:3102'},
            secrets                               = async () => (await fs.readdir(layout.secretsDir)).sort(),
            stepOf                                = run => JSON.parse(run.stdout).steps.find(step => step.id === 'write-secrets');

        await fs.writeFile(keyPath, 'AIzaSENTINELPROVIDERKEY0123456789abcdefgh\n', {mode: 0o600});

        expect((await runCli({setupRoot, stateRoot, fake: hosted(fake.observers.servedPlane)})).code).toBe(0);
        expect(await secrets()).toEqual(['fleet-plane-token', 'gemini-api-key', 'mcp-auth-token']);

        // what an interruption after the first of three atomic file writes leaves: one file, the receipt still pending
        const
            record = JSON.parse(await fs.readFile(recordPath, 'utf8')),
            held   = await Promise.all(['fleet-plane-token', 'gemini-api-key'].map(async name => [name, await fs.readFile(path.join(layout.secretsDir, name), 'utf8')]));

        record.receipts = record.receipts.map(receipt => receipt.effectId === 'write-secrets' ? {effectId: 'write-secrets', outcome: 'pending', inputDigest: receipt.inputDigest, startedAt: receipt.acceptedAt} : receipt);
        await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        await Promise.all(held.map(([name]) => fs.rm(path.join(layout.secretsDir, name))));

        const partial = await runCli({setupRoot, stateRoot, fake: hosted(cold)});

        expect(partial.code).toBe(1);
        expect(stepOf(partial)).toMatchObject({status: 'reconcile-required', receipt: 'reconcile-required'});
        expect(partial.stderr).toContain(`'write-secrets' was interrupted and is not settled, so nothing runs past it: missing under ${layout.secretsDir}: fleet-plane-token, gemini-api-key`);
        expect(await secrets(), 'nothing ran over the partial set').toEqual(['mcp-auth-token']);

        // the complete set is the positive control: the same receipt settles by observation
        await Promise.all(held.map(([name, content]) => fs.writeFile(path.join(layout.secretsDir, name), content, {mode: 0o600})));

        const complete = await runCli({setupRoot, stateRoot, fake: hosted(cold)});

        expect(stepOf(complete)).toMatchObject({status: 'ok'});
        expect(JSON.parse(await fs.readFile(recordPath, 'utf8')).receipts.find(receipt => receipt.effectId === 'write-secrets')).toMatchObject({outcome: 'accepted', settledBy: 'observation'})
    });

    test('the secret-file observer reads the consented preset\'s whole set: a partial set is not present and names what is missing, a file readable beyond its owner is a problem', async () => {
        const
            {stateRoot} = await scratch(),
            layout      = hostLayout({stateRoot}),
            observe     = preset => productionObservers({layout, host: createHost()}).secretFiles({}, {record: preset ? {consents: [{stepId: 'preset', answer: preset}]} : null}),
            write       = async (name, mode = 0o600) => { await fs.writeFile(path.join(layout.secretsDir, name), 'x'); await fs.chmod(path.join(layout.secretsDir, name), mode) };

        expect(await observe('hosted')).toEqual({present: false, reason: `no secret files under ${layout.secretsDir}`});

        await fs.mkdir(layout.secretsDir, {recursive: true});
        await write('mcp-auth-token');

        expect(await observe('hosted')).toEqual({present: false, reason: `missing under ${layout.secretsDir}: fleet-plane-token, gemini-api-key`});
        expect(await observe('local-small')).toEqual({present: false, reason: `missing under ${layout.secretsDir}: fleet-plane-token`});

        await write('fleet-plane-token');

        // a local preset's set is complete; the hosted one still lacks its provider key; without a consent the base set is read
        expect(await observe('local-small')).toEqual({present: true, digest: null, problem: null});
        expect(await observe(null)).toEqual({present: true, digest: null, problem: null});
        expect(await observe('hosted')).toEqual({present: false, reason: `missing under ${layout.secretsDir}: gemini-api-key`});

        await write('gemini-api-key', 0o644);

        expect(await observe('hosted')).toEqual({present: true, digest: null, problem: 'gemini-api-key is readable beyond its owner'})
    });

    test('a record the CLI cannot read is refused by name and left as it is; nothing runs over it', async () => {
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            recordPath = path.join(setupRoot, `${RUN_ID}.json`);

        await fs.mkdir(setupRoot, {recursive: true});
        await fs.writeFile(recordPath, '{not json');

        const refused = await runCli({setupRoot, stateRoot, fake: greenFake({patPath})});

        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe('');
        expect(refused.stderr.startsWith(`record ${recordPath} is malformed: `), refused.stderr).toBe(true);
        expect(refused.stderr.endsWith(': refusing to run over it — move the file away, or name another --run-id\n'), refused.stderr).toBe(true);
        expect(await fs.readFile(recordPath, 'utf8')).toBe('{not json');
        expect(await fs.access(path.join(stateRoot, 'secrets')).then(() => true, () => false), 'no effect ran').toBe(false);
        expect(await fs.access(path.join(setupRoot, 'fake-run.json')).then(() => true, () => false), 'no command ran').toBe(false)
    });

    test('AC-2 end to end: a hosted preset writes the provider key as an owner-only secret and points the leaf at the mount; the key is in no record, carrier or log', async () => {
        const
            {root, setupRoot, stateRoot, patPath} = await scratch(),
            KEY     = 'AIzaSENTINELPROVIDERKEY0123456789abcdefgh',
            keyPath = path.join(root, 'operator', 'gemini-key');

        await fs.writeFile(keyPath, `${KEY}\n`, {mode: 0o600});

        const
            fake   = greenFake({patPath}),
            hosted = await runCli({setupRoot, stateRoot, fake: {...fake, observers: {...fake.observers, validation: {provider: {ok: true, model: 'gemini-3.8-flash'}, embedding: {ok: true, dimension: 3072}}}, answers: {preset: 'hosted', 'plane-credential': patPath, 'provider-key': keyPath}}}),
            output = JSON.parse(hosted.stdout),
            layout = hostLayout({stateRoot}),
            env    = await fs.readFile(layout.envFile, 'utf8');

        expect(hosted.code, hosted.stderr).toBe(0);
        expect(output.steps.find(step => step.id === 'provider-key')).toMatchObject({status: 'ok', answer: keyPath});
        expect(env).toContain(`NEO_GEMINI_API_KEY_FILE=${layout.secretsDir}/gemini-api-key\n`);
        expect(env).toContain('GEMINI_API_KEY_FILE=/run/secrets/gemini-api-key\n');
        expect(env).toContain('NEO_MODEL_PROVIDER=gemini\n');
        expect(env).toContain('NEO_VECTOR_DIMENSION=3072\n');
        expect(env).not.toContain(KEY);
        expect(env).not.toContain(PAT);
        expect(await fs.readFile(path.join(layout.secretsDir, 'gemini-api-key'), 'utf8')).toBe(KEY);
        expect((await fs.stat(path.join(layout.secretsDir, 'gemini-api-key'))).mode & 0o777).toBe(0o600);

        for (const file of [path.join(setupRoot, `${RUN_ID}.json`), path.join(setupRoot, 'fake-run.json')]) {
            const text = await fs.readFile(file, 'utf8');

            expect(text, file).not.toContain(KEY);
            expect(text, file).not.toContain(PAT);
        }
        expect(hosted.stdout).not.toContain(KEY);
        expect(hosted.stderr).not.toContain(KEY);
    });

    test('AC-3: a preset the profile would not honour is refused before any file is written', async () => {
        // a hosted answer without a provider key on a host where nothing serves yet: the credential step
        // refuses, no secret and no carrier appear, the run stays pending
        const
            {setupRoot, stateRoot, patPath} = await scratch(),
            fake   = greenFake({patPath, servedPlane: {throw: 'connection refused'}, done: {throw: 'no plane to ask'}}),
            result = await runCli({setupRoot, stateRoot, fake: {...fake, observers: {...fake.observers, validation: {throw: 'no plane to ask'}}, answers: {preset: 'hosted', 'plane-credential': patPath}}}),
            layout = hostLayout({stateRoot});

        expect(result.code).toBe(2);
        expect(result.stderr).toMatch(/credentials refused before any write:\n\s+the 'hosted' preset requires a provider key and none was given/);
        await expect(fs.access(layout.envFile)).rejects.toThrow();
        await expect(fs.access(layout.secretsDir)).rejects.toThrow();
        expect(JSON.parse(result.stdout).steps.find(step => step.id === 'provider-key')).toMatchObject({status: 'pending', reason: 'unanswered'});
    });

    test('a fake host\'s provider-key answer for a local preset is never recorded: the question is decided after the preset consent (review round 1, RA-2)', async () => {
        const
            {root, setupRoot, stateRoot, patPath} = await scratch(),
            keyPath = path.join(root, 'operator', 'gemini-key');

        await fs.writeFile(keyPath, 'AIzaFAKEKEY\n', {mode: 0o600});

        const
            fake   = greenFake({patPath}),
            local  = await runCli({setupRoot, stateRoot, fake: {...fake, answers: {preset: 'local-small', 'plane-credential': patPath, 'provider-key': keyPath}}}),
            record = JSON.parse(await fs.readFile(path.join(setupRoot, `${RUN_ID}.json`), 'utf8'));

        expect(local.code, local.stderr).toBe(0);
        expect(record.consents.map(consent => consent.stepId)).toEqual(['preset', 'plane-credential']);
        expect(JSON.parse(local.stdout).steps.find(step => step.id === 'provider-key')).toMatchObject({status: 'ok', reason: "not needed: the 'local-small' preset requires no providerKey", answer: null});
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

    test('the production served-plane observer asks the plane the way its clients do: the Memory Core route, the consented credential as the bearer, the block as observed; no consent sends no bearer, and the recipe keeps the verdict', async () => {
        const
            {patPath}  = await scratch(),
            target     = {planeId: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data', endpoint: 'http://127.0.0.1:3102'},
            served     = {id: 'neo-local-canonical', dataRoot: '/app/.neo-ai-data'},
            calls      = [],
            healthcheck = async options => {
                calls.push(options);

                if (!options.bearerToken) {
                    throw new Error('Streamable HTTP error: Error POSTing to endpoint (HTTP 401)');
                }

                return {status: 'healthy', url: `${options.url}/`, plane: served, timings: {startupMs: 1, timeoutMs: 8000}};
            },
            host       = createHost({now: () => Date.UTC(2026, 9, 3)}),
            observers  = productionObservers({layout: hostLayout({stateRoot: '/srv/state'}), host, healthcheck}),
            consented  = withConsent(createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: host.now}), {stepId: 'plane-credential', answer: patPath, consentedAt: 't'});

        // bound record with the credential consent: the route, the bearer (trimmed file content), the report flag, no expectations
        await expect(observers.servedPlane(target, {record: consented})).resolves.toEqual({...served, status: 'healthy'});
        expect(calls).toEqual([{url: target.endpoint, mcpPath: PLANE_MEMORY_CORE_PATH, bearerToken: PAT, expectedStatus: 'healthy,degraded', reportServedPlane: true}]);
        expect(PLANE_MEMORY_CORE_PATH).toBe('/mc/mcp');

        // before the consent (or unbound): no bearer leaves the host; the plane's refusal is the observer's thrown reason
        await expect(observers.servedPlane(target, {record: null})).rejects.toThrow('401');
        await expect(observers.servedPlane(target)).rejects.toThrow('401');
        expect(calls.slice(1).map(call => call.bearerToken)).toEqual([null, null]);

        // the recipe's own comparison keeps the verdict: a thrown probe is unknown, a wrong plane is failed — never the other way round
        const
            evaluate = (record, planeId) => evaluateRecipe({target: {...target, planeId}, record, observers: {servedPlane: observers.servedPlane}, presets, now: host.now}).then(result => result.steps.find(step => step.id === 'served-plane')),
            thrown   = await evaluate(null, 'neo-local-canonical'),
            wrong    = await evaluate(withConsent(createSetupRecord({runId: RUN_ID, target: {...target, planeId: 'plane-b'}, recipeVersion: RECIPE_VERSION, now: host.now}), {stepId: 'plane-credential', answer: patPath, consentedAt: 't'}), 'plane-b');

        expect(thrown).toMatchObject({status: 'unknown', reason: expect.stringContaining('401')});
        expect(wrong).toMatchObject({status: 'failed', reason: expect.stringContaining("served plane id is 'neo-local-canonical', expected 'plane-b'")});
    });

    test('AC-1 / AC-4 (observers): validation runs the probe fresh with the consented preset and key file at every call and never reads a receipt; verification and done read this run\'s section — unknown without one, failed with a recorded refusal, ok only with the plane\'s answers', async () => {
        const
            {patPath, root} = await scratch(),
            keyPath         = path.join(root, 'operator', 'provider-key'),
            target          = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'},
            probes          = [],
            validate        = async ({preset, providerKey}) => { probes.push({preset: preset.id, providerKey}); return {provider: {ok: true, model: preset.chatModel, reason: null}, embedding: {ok: true, dimension: preset.vectorDimension, reason: null}} },
            host            = createHost({now: () => Date.UTC(2026, 9, 3)}),
            observers       = productionObservers({layout: hostLayout({stateRoot: '/srv/state'}), host, healthcheck: async () => ({plane: {id: 'plane-a', dataRoot: '/srv/plane-a'}}), validate}),
            base            = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: host.now});

        await fs.writeFile(keyPath, 'AIzaSyFAKEKEY\n', {mode: 0o600});

        // validation: the consented preset and the key FILE's content, fresh per call
        const hosted = withConsent(withConsent(withConsent(base, {stepId: 'preset', answer: 'hosted', consentedAt: 't'}), {stepId: 'plane-credential', answer: patPath, consentedAt: 't'}), {stepId: 'provider-key', answer: keyPath, consentedAt: 't'});

        await observers.validation(target, {record: hosted});
        await observers.validation(target, {record: hosted});
        expect(probes).toEqual([{preset: 'hosted', providerKey: 'AIzaSyFAKEKEY'}, {preset: 'hosted', providerKey: 'AIzaSyFAKEKEY'}]);
        await expect(observers.validation(target, {record: null})).rejects.toThrow('no preset consented');

        const local = withConsent(base, {stepId: 'preset', answer: 'local-small', consentedAt: 't'});

        await observers.validation(target, {record: local});
        expect(probes.at(-1)).toEqual({preset: 'local-small', providerKey: ''});

        // a receipt-only record proves nothing to validation: with the probe refusing, the retained section changes no answer
        const refusing = productionObservers({layout: hostLayout({stateRoot: '/srv/state'}), host, validate: async () => ({provider: {ok: false, model: 'm', reason: 'provider down'}, embedding: {ok: false, dimension: null, reason: 'provider down'}})});
        const witnessed = {...hosted, verification: {runId: RUN_ID, planeId: 'plane-a', sessionId: 's', attempt: {marker: 'mk', dispatchedAt: 't0'}, memory: {id: 'mem-1', at: 't1'}, readback: {at: 't2'}, recall: {at: 't3', hit: true}, priorAttempts: []}};

        expect((await refusing.validation(target, {record: witnessed})).provider).toMatchObject({ok: false, reason: 'provider down'});

        // done + verification read the section, never a counter
        await expect(observers.done(target, {record: hosted})).rejects.toThrow('no witness for this run yet');
        expect(await observers.done(target, {record: witnessed})).toEqual({persisted: true, queryAnswered: true, at: 't1', reason: null});
        expect(await observers.verification(target, {record: witnessed})).toEqual({present: true, digest: null, problem: null, reason: 'the witness has not been written and recalled yet'});
        expect(await observers.verification(target, {record: hosted})).toEqual({present: false, digest: null, problem: null, reason: 'the verify effect has not run'});

        const refused = {...witnessed, verification: {...witnessed.verification, memory: null, readback: null, recall: null, attempt: {marker: 'mk', dispatchedAt: 't0', refused: {at: 't1', reason: 'no grant'}}}};

        expect(await observers.done(target, {record: refused})).toEqual({persisted: false, queryAnswered: false, at: null, reason: 'the plane refused the witness write at t1: no grant'});
        expect(await observers.verification(target, {record: refused})).toEqual({present: true, digest: null, problem: 'the plane refused the witness write at t1: no grant'});

        // through the recipe: the witnessed record completes only with the fresh steps ok in the same evaluation
        const step = (await evaluateRecipe({target, record: witnessed, observers: {servedPlane: observers.servedPlane, validation: observers.validation, verification: observers.verification, done: observers.done}, presets, now: host.now})).steps.find(row => row.id === 'done');

        expect(step).toMatchObject({status: 'ok', witnessedAt: 't1'});

        // the plane's health word rides with the identity: the same complete witness against a DEGRADED matching plane
        // does not complete — validation is not asked, done stays pending with the timestamp (ADR 0041 §2.5)
        const
            degradedObservers = productionObservers({layout: hostLayout({stateRoot: '/srv/state'}), host, healthcheck: async () => ({status: 'degraded', plane: {id: 'plane-a', dataRoot: '/srv/plane-a'}}), validate: async () => { throw new Error('must not be asked against a degraded plane') }}),
            byId              = steps => Object.fromEntries(steps.map(row => [row.id, row])),
            degradedSteps     = byId((await evaluateRecipe({target, record: witnessed, observers: {servedPlane: degradedObservers.servedPlane, validation: degradedObservers.validation, verification: degradedObservers.verification, done: degradedObservers.done}, presets, now: host.now})).steps);

        expect(await degradedObservers.servedPlane(target, {record: hosted})).toEqual({id: 'plane-a', dataRoot: '/srv/plane-a', status: 'degraded'});
        expect(degradedSteps['served-plane']).toMatchObject({status: 'ok', reason: 'the served identity matches the target; the plane reports itself degraded'});
        expect(degradedSteps.validation).toMatchObject({status: 'unknown', reason: 'not observed: served-plane is degraded'});
        expect(degradedSteps.done).toMatchObject({status: 'pending', witnessedAt: 't1', reason: 'witnessed at t1; served-plane is degraded'});

        // a refused read-only sub-step the section recorded projects as failed with the plane's reason, on the effect row and on done
        const readbackRefused = {...witnessed, verification: {...witnessed.verification, readback: null, recall: null, failure: {step: 'readback', at: 't2', reason: 'viewer lacks READ'}}};

        expect(await observers.verification(target, {record: readbackRefused})).toEqual({present: true, digest: null, problem: 'the plane refused the readback at t2: viewer lacks READ'});
        expect(await observers.done(target, {record: readbackRefused})).toEqual({persisted: true, queryAnswered: false, at: 't1', reason: 'the plane refused the readback at t2: viewer lacks READ'});

        const projected = byId((await evaluateRecipe({target, record: {...readbackRefused, receipts: [{effectId: 'verify', outcome: 'failed', inputDigest: 'x', startedAt: 't0', failedAt: 't2', reason: 'the plane refused the readback: viewer lacks READ'}]}, observers: {servedPlane: observers.servedPlane, validation: observers.validation, verification: observers.verification, done: observers.done}, presets, now: host.now})).steps);

        expect(projected.verify).toMatchObject({status: 'failed', reason: 'the plane refused the readback at t2: viewer lacks READ'});
        expect(projected.done).toMatchObject({status: 'failed', reason: 'the plane refused the readback at t2: viewer lacks READ'});
    });
});
