import {expect, test} from '@playwright/test';
import fs             from 'node:fs/promises';
import net            from 'node:net';
import os             from 'node:os';
import path           from 'node:path';
import {
    EFFECT_IDS,
    SECRET_FILE_MODE,
    applyEffect,
    createHost,
    effectInputDigest,
    effectInputKey,
    hostEffectHandlers,
    persistSetupRecord,
    probePort,
    recordConsent,
    recordVerification,
    renderEnvFile,
    settleReceipt
} from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {RECIPE_VERSION, STEP_STATUSES, evaluateRecipe} from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {
    RECEIPT_OUTCOMES,
    RETIRE_REASONS,
    contentDigest,
    createSetupRecord,
    findReceipt,
    readSetupRecord,
    retireCurrentProof,
    setupRecordPath,
    withReceipt,
    withVerification
} from '../../../../../../ai/services/fleet/setupRunRecord.mjs';

// Real filesystem under a temp root (modes are the point of AC-4); the command runner and the clock are fakes.

const
    RUN_ID = '0f1e2d3c-4b5a-4968-8777-6655443322aa',
    NOW    = Date.UTC(2026, 9, 1, 20, 0, 0),
    PAT    = 'ghp_FAKEPAT0123456789abcdefghijklmnopqrstuv',
    KEY    = 'AIzaSyFAKEPROVIDERKEY-0123456789abcdefgh',
    target = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'};

async function scratch() {
    const
        root       = await fs.mkdtemp(path.join(os.tmpdir(), 'first-run-')),
        setupRoot  = path.join(root, 'setup'),
        recordPath = setupRecordPath(setupRoot, RUN_ID),
        calls      = [],
        host       = createHost({run: async (command, args, options) => { calls.push({command, args, options}); return {stdout: '', stderr: ''} }, now: () => NOW}),
        record     = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: () => NOW});

    return {root, setupRoot, recordPath, calls, host, record};
}

const modeOf = async filePath => (await fs.stat(filePath)).mode & 0o777;

test.describe('hostEffects', () => {
    test('AC-2 (ADR 0041 §3): a pending receipt left by an interrupted run is reconcile-required on resume, the handler never re-runs, and only a fresh matching observation settles it', async () => {
        const
            {recordPath, host, record} = await scratch(),
            input   = {path: path.join(path.dirname(recordPath), 'plane.env'), entries: {NEO_PLANE_ID: 'plane-a'}},
            spy     = [],
            effects = {[EFFECT_IDS.writeEnv]: {...hostEffectHandlers[EFFECT_IDS.writeEnv], handler: async (...args) => { spy.push(args); return {digest: 'x', references: []} }}},
            // what a crash between the handler and its receipt leaves on disk
            parked  = withReceipt(record, {effectId: EFFECT_IDS.writeEnv, outcome: RECEIPT_OUTCOMES.pending, inputDigest: effectInputDigest(input), startedAt: 't0'});

        await persistSetupRecord(recordPath, parked, host);

        const resumed = await applyEffect({effectId: EFFECT_IDS.writeEnv, input, record: parked, recordPath, host, effects});

        expect(spy).toHaveLength(0);
        expect(resumed.applied).toBe(false);
        expect(resumed.receipt.outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);
        expect(resumed.receipt.reason).toMatch(/may have run before its receipt was written/);
        expect((await readSetupRecord(recordPath, {fsModule: fs})).record.receipts[0].outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);

        // applying again changes nothing and still never runs the handler
        const again = await applyEffect({effectId: EFFECT_IDS.writeEnv, input, record: resumed.record, recordPath, host, effects});

        expect(spy).toHaveLength(0);
        expect(again.receipt).toBe(resumed.receipt);

        // the step is not green although the carrier is observable
        const parkedEvaluation = await evaluateRecipe({target, record: resumed.record, observers: {envCarrier: async () => ({present: true, digest: 'x'})}, presets: [], now: () => NOW});

        expect(parkedEvaluation.steps.find(step => step.id === 'write-env').status).toBe(STEP_STATUSES.reconcileRequired);

        // a wrong plane's observation does not settle; a non-ok one does not settle; a fresh matching one does
        const wrongPlane = await settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'ok', matchesTarget: false, reason: 'a different plane is answering'}, record: resumed.record, recordPath, host});

        expect(wrongPlane.settled).toBe(false);
        expect(wrongPlane.reason).toBe('a different plane is answering');
        expect(wrongPlane.receipt.outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);

        const notOk = await settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'failed', matchesTarget: true}, record: resumed.record, recordPath, host});

        expect(notOk.settled).toBe(false);

        const settled = await settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'ok', matchesTarget: true, observedAt: '2026-10-01T20:05:00.000Z', digest: 'x'}, record: resumed.record, recordPath, host});

        expect(settled.settled).toBe(true);
        expect(settled.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation', acceptedAt: '2026-10-01T20:05:00.000Z', digest: 'x'});
        expect(spy).toHaveLength(0);

        const settledEvaluation = await evaluateRecipe({target, record: settled.record, observers: {envCarrier: async () => ({present: true, digest: 'x'})}, presets: [], now: () => NOW});

        expect(settledEvaluation.steps.find(step => step.id === 'write-env').status).toBe(STEP_STATUSES.ok);
        await expect(settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'ok', matchesTarget: true}, record: settled.record, recordPath, host})).rejects.toThrow(/holds no pending or reconcile-required receipt/);
    });

    test('the pending receipt carries the digest of the content the handler is about to write where the effect declares one, and an interrupted receipt keeps it', async () => {
        const
            {recordPath, host, record} = await scratch(),
            input   = {path: path.join(path.dirname(recordPath), 'plane.env'), entries: {NEO_PLANE_ID: 'plane-a'}},
            seen    = [],
            // each handler reads the receipt the pending write left on disk
            reading = (effectId, digest) => ({...hostEffectHandlers[effectId], handler: async () => { seen.push(findReceipt((await readSetupRecord(recordPath, {fsModule: fs})).record, effectId)); return {digest, references: []} }}),
            effects = {[EFFECT_IDS.writeEnv]: reading(EFFECT_IDS.writeEnv, 'x'), [EFFECT_IDS.writeSecrets]: reading(EFFECT_IDS.writeSecrets, 'y')};

        await persistSetupRecord(recordPath, record, host);

        const env = await applyEffect({effectId: EFFECT_IDS.writeEnv, input, record, recordPath, host, effects});

        await applyEffect({effectId: EFFECT_IDS.writeSecrets, input: {files: [{path: path.join(path.dirname(recordPath), 'token'), content: 's'}]}, record: env.record, recordPath, host, effects});

        expect(seen[0]).toEqual({effectId: 'write-env', outcome: RECEIPT_OUTCOMES.pending, inputDigest: effectInputDigest(input), inputKey: effectInputDigest(input), startedAt: new Date(NOW).toISOString(), expectedDigest: contentDigest(renderEnvFile(input.entries))});
        // the receipt records the key of its input: the whole input for the carrier, the set alone for the
        // secrets — the same set with other contents is the same input
        expect(seen[1].inputKey).toBe(effectInputKey(EFFECT_IDS.writeSecrets, {files: [{path: path.join(path.dirname(recordPath), 'token'), content: 'another value'}]}));
        expect(seen[1].inputKey).not.toBe(seen[1].inputDigest);
        expect(env.receipt.inputKey, 'and the accepted receipt keeps it').toBe(seen[0].inputKey);
        expect(seen[1], 'a secret\'s content is never an expectation').not.toHaveProperty('expectedDigest');
        expect(env.receipt, 'the accepted receipt carries the handler\'s own digest').not.toHaveProperty('expectedDigest');

        // an interrupted application keeps its expectation through the resume
        const resumed = await applyEffect({effectId: EFFECT_IDS.writeEnv, input, record: withReceipt(record, seen[0]), recordPath, host, effects});

        expect(resumed.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, expectedDigest: seen[0].expectedDigest});

        // an input the carrier cannot render records no expectation; the handler fails on it and the receipt says why
        const bad = await applyEffect({effectId: EFFECT_IDS.writeEnv, input: {path: input.path, entries: {'not an env name': 'x'}}, record, recordPath, host});

        expect(bad.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.failed, reason: expect.stringMatching(/is not an env name/)});
        expect(bad.receipt).not.toHaveProperty('expectedDigest')
    });

    test('settleReceipt owns the pending → reconcile-required transition: a non-matching observation persists it without running any handler, a matching one settles a pending receipt directly', async () => {
        const
            {recordPath, host, record} = await scratch(),
            input  = {path: path.join(path.dirname(recordPath), 'plane.env'), entries: {NEO_PLANE_ID: 'plane-a'}},
            parked = withReceipt(record, {effectId: EFFECT_IDS.writeEnv, outcome: RECEIPT_OUTCOMES.pending, inputDigest: effectInputDigest(input), startedAt: 't0'});

        await persistSetupRecord(recordPath, parked, host);

        const marked = await settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'failed', matchesTarget: false, reason: 'a different plane is answering'}, record: parked, recordPath, host});

        expect(marked.settled).toBe(false);
        expect(marked.reason).toBe('a different plane is answering');
        expect(marked.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, inputDigest: effectInputDigest(input), startedAt: 't0'});
        expect(marked.receipt.reason).toMatch(/may have run before its receipt was written/);
        expect((await readSetupRecord(recordPath, {fsModule: fs})).record.receipts[0].outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);

        // marking again changes nothing
        const again = await settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'failed', matchesTarget: false}, record: marked.record, recordPath, host});

        expect(again.receipt).toBe(marked.receipt);

        // a pending receipt whose first observation matches settles in one step
        await persistSetupRecord(recordPath, parked, host);

        const direct = await settleReceipt({effectId: EFFECT_IDS.writeEnv, observation: {status: 'ok', matchesTarget: true, observedAt: '2026-10-02T08:30:00.000Z', digest: 'x'}, record: parked, recordPath, host});

        expect(direct.settled).toBe(true);
        expect(direct.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation', digest: 'x'});
        expect((await readSetupRecord(recordPath, {fsModule: fs})).record.receipts[0].outcome).toBe(RECEIPT_OUTCOMES.accepted);
    });

    test('an accepted effect never re-runs on resume for the same input; a different input or a failed receipt is a new application', async () => {
        const
            {recordPath, host, record} = await scratch(),
            runs    = [],
            effects = {probe: {id: 'probe', describe: () => 'probe', handler: async input => { runs.push(input); if (input.fail) throw new Error('disk full'); return {digest: 'd', references: ['/x']} }}},
            first   = await applyEffect({effectId: 'probe', input: {n: 1}, record, recordPath, host, effects}),
            resume  = await applyEffect({effectId: 'probe', input: {n: 1}, record: first.record, recordPath, host, effects}),
            changed = await applyEffect({effectId: 'probe', input: {n: 2}, record: resume.record, recordPath, host, effects}),
            failed  = await applyEffect({effectId: 'probe', input: {n: 3, fail: true}, record: changed.record, recordPath, host, effects}),
            retried = await applyEffect({effectId: 'probe', input: {n: 3, fail: true}, record: failed.record, recordPath, host, effects});

        expect(first.applied).toBe(true);
        expect(first.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, digest: 'd', references: ['/x'], acceptedAt: '2026-10-01T20:00:00.000Z'});
        expect(resume.applied).toBe(false);
        expect(resume.receipt).toBe(first.receipt);
        expect(changed.applied).toBe(true);
        expect(failed.applied).toBe(false);
        expect(failed.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.failed, reason: 'disk full'});
        expect(retried.applied).toBe(false);
        expect(runs.map(input => input.n)).toEqual([1, 2, 3, 3]);
        // one receipt per effect, the record on disk is the latest
        expect(retried.record.receipts).toHaveLength(1);
        expect((await readSetupRecord(recordPath, {fsModule: fs})).record.receipts[0].outcome).toBe(RECEIPT_OUTCOMES.failed);
        await expect(applyEffect({effectId: 'nope', input: {}, record, recordPath, host, effects})).rejects.toThrow(/unknown effect 'nope'/);
    });

    test('an effect without a handler is an operator action: the instruction is recorded, the host is untouched', async () => {
        const
            {recordPath, host, record} = await scratch(),
            effects = {'remote-up': {id: 'remote-up', describe: input => `run docker compose up on ${input.host}`, handler: null}},
            result  = await applyEffect({effectId: 'remote-up', input: {host: 'edge-1'}, record, recordPath, host, effects});

        expect(result.applied).toBe(false);
        expect(result.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.operatorAction, instruction: 'run docker compose up on edge-1'});
        expect(findReceipt(result.record, 'remote-up').outcome).toBe(RECEIPT_OUTCOMES.operatorAction);
    });

    test('AC-4: the record holds neither the PAT nor the provider key; the env carrier, the secret files and the record are owner-only', async () => {
        const
            {root, recordPath, host, record} = await scratch(),
            envPath    = path.join(root, 'config', 'local-agent-os.env'),
            patPath    = path.join(root, 'secrets', 'plane-pat'),
            keyPath    = path.join(root, 'secrets', 'provider-key'),
            consented  = await recordConsent({stepId: 'plane-credential', answer: patPath, record, recordPath, host}),
            env        = await applyEffect({effectId: EFFECT_IDS.writeEnv, input: {path: envPath, entries: {GH_TOKEN: PAT, NEO_MODEL_PROVIDER: 'gemini', NEO_PLANE_ID: 'plane-a'}}, record: consented.record, recordPath, host}),
            secrets    = await applyEffect({effectId: EFFECT_IDS.writeSecrets, input: {files: [{path: patPath, content: PAT}, {path: keyPath, content: KEY}]}, record: env.record, recordPath, host}),
            recordText = await fs.readFile(recordPath, 'utf8');

        expect(env.receipt.outcome).toBe(RECEIPT_OUTCOMES.accepted);
        expect(secrets.receipt.outcome).toBe(RECEIPT_OUTCOMES.accepted);
        expect(recordText).not.toContain(PAT);
        expect(recordText).not.toContain(KEY);
        expect(recordText).toContain(patPath);
        expect(JSON.parse(recordText).receipts.map(receipt => receipt.references)).toEqual([[envPath], [patPath, keyPath]]);

        expect(await fs.readFile(envPath, 'utf8')).toBe(`GH_TOKEN=${PAT}\nNEO_MODEL_PROVIDER=gemini\nNEO_PLANE_ID=plane-a\n`);
        expect(env.receipt.digest).toBe(contentDigest(`GH_TOKEN=${PAT}\nNEO_MODEL_PROVIDER=gemini\nNEO_PLANE_ID=plane-a\n`));
        expect(await fs.readFile(patPath, 'utf8')).toBe(PAT);

        for (const filePath of [envPath, patPath, keyPath, recordPath]) {
            expect(await modeOf(filePath), filePath).toBe(SECRET_FILE_MODE);
        }
        expect(SECRET_FILE_MODE).toBe(0o600);

        // a consent is a choice or a reference: a pasted token-sized blob is refused by the writer
        await expect(recordConsent({stepId: 'plane-credential', answer: 'x'.repeat(257), record, recordPath, host})).rejects.toThrow(/a choice or a reference/);
        await expect(recordConsent({stepId: 'preset', answer: {id: 'hosted'}, record, recordPath, host})).rejects.toThrow(/a choice or a reference/);
        // an empty secret is refused, not written
        const empty = await applyEffect({effectId: EFFECT_IDS.writeSecrets, input: {files: [{path: path.join(root, 'secrets', 'empty'), content: ''}]}, record: secrets.record, recordPath, host});

        expect(empty.receipt.outcome).toBe(RECEIPT_OUTCOMES.failed);
        expect(empty.receipt.reason).toMatch(/has no content/);
    });

    test('compose-up runs the canonical invocation in the checkout and records it; a failed command is a failed receipt', async () => {
        const
            {recordPath, host, record, calls} = await scratch(),
            input = {project: 'neo-local-agent-os', cwd: '/srv/brain/deploy/cloud', envFile: '/home/op/.neo-ai/config/local-agent-os.env', composeFiles: ['docker-compose.yml', 'docker-compose.local-agent-os.yml']},
            up    = await applyEffect({effectId: EFFECT_IDS.composeUp, input, record, recordPath, host});

        expect(calls).toEqual([{
            command: 'docker',
            args   : ['compose', '-p', 'neo-local-agent-os', '--env-file', '/home/op/.neo-ai/config/local-agent-os.env', '-f', 'docker-compose.yml', '-f', 'docker-compose.local-agent-os.yml', 'up', '-d', '--wait'],
            options: {cwd: '/srv/brain/deploy/cloud'}
        }]);
        expect(up.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, references: ['compose:neo-local-agent-os']});
        expect(hostEffectHandlers[EFFECT_IDS.composeUp].describe(input)).toBe('docker compose -p neo-local-agent-os up -d --wait');

        const
            broken = createHost({run: async () => { throw new Error('docker: command not found') }, now: () => NOW}),
            down   = await applyEffect({effectId: EFFECT_IDS.composeUp, input: {...input, project: 'other'}, record: up.record, recordPath, host: broken});

        expect(down.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.failed, reason: 'docker: command not found'});

        const partial = await applyEffect({effectId: EFFECT_IDS.composeUp, input: {project: 'p'}, record, recordPath, host});

        expect(partial.receipt.reason).toMatch(/needs project, cwd, envFile and composeFiles/);
    });

    test('renderEnvFile sorts by key and refuses a non-env name or a multi-line value; probePort reads a listener and a closed port', async () => {
        expect(renderEnvFile({B: '2', A: '1'})).toBe('A=1\nB=2\n');
        expect(() => renderEnvFile({'not-a-key': 'x'})).toThrow(/is not an env name/);
        expect(() => renderEnvFile({A: 'one\ntwo'})).toThrow(/single-line/);
        expect(() => renderEnvFile(['A=1'])).toThrow(/must be an object/);

        const server = net.createServer();

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

        const {port} = server.address();

        expect(await probePort({port})).toEqual({open: true, reason: null});
        await new Promise(resolve => server.close(resolve));

        const closed = await probePort({port, timeoutMs: 500});

        expect(closed.open).toBe(false);
        expect(closed.reason).toMatch(/ECONNREFUSED|no answer/);
    });

    test('ADR 0041 §3: the record carries the run\'s verification section through the one writer, owner-only and in one write with its receipt; a rebinding retires it into history with the receipts; the pure helper refuses a non-object', async () => {
        const
            {recordPath, host, record} = await scratch(),
            section = {runId: RUN_ID, planeId: 'plane-a', sessionId: null, attempt: {marker: 'mk-1', dispatchedAt: 't0'}, memory: null, readback: null, recall: null, priorAttempts: []},
            receipt = {effectId: EFFECT_IDS.verify, outcome: RECEIPT_OUTCOMES.pending, resumable: true, inputDigest: contentDigest('mk-1'), startedAt: 't0', reason: 'dispatching'};

        expect(record.verification).toBeNull();

        const {record: written} = await recordVerification({record, recordPath, host, verification: section, receipt});

        expect(written.verification).toEqual(section);
        expect(findReceipt(written, EFFECT_IDS.verify)).toEqual(receipt);
        expect(record.verification).toBeNull(); // the input is never mutated
        expect(await modeOf(recordPath)).toBe(SECRET_FILE_MODE);
        expect((await readSetupRecord(recordPath, {fsModule: fs})).record).toEqual(written);

        // a rebinding to another target retires the section with the receipts — another run never reads this run's witness as its own
        const retired = retireCurrentProof(written, {target: {...target, planeId: 'plane-b'}, recipeVersion: RECIPE_VERSION, reason: RETIRE_REASONS.targetChanged, now: () => NOW});

        expect(retired.verification).toBeNull();
        expect(retired.receipts).toEqual([]);
        expect(retired.history[0]).toMatchObject({reason: RETIRE_REASONS.targetChanged, verification: section, receipts: [receipt]});

        expect(withVerification(written, null).verification).toBeNull();
        expect(() => withVerification(written, 'yes')).toThrow('withVerification: verification must be an object or null.');
    });
});
