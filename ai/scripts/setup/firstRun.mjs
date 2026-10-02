#!/usr/bin/env node
/**
 * @module ai/scripts/setup/firstRun
 * @summary The first-run recipe's CLI renderer (the setup epic's point 2): prints the
 * live evaluation of every step, asks the pending questions, performs the effects through the host-effect
 * module, re-evaluates after each, and exits with the run's disposition. `--json` prints the evaluation
 * for the vessel's smoke and the bootstrap-record decisionwitness; without a TTY the renderer never prompts and prints
 * JSON only.
 *
 * Runs on the host before any Brain container exists, so — like the deployment-prescription entrypoint —
 * it has no AiConfig bootstrap: the setup root is an argument (`--setup-root`) with the host state root's
 * `~/.neo-ai/setup` as its default, overridable by `NEO_HOST_SETUP_RECORD_ROOT` the way the prescriptions
 * root is. "Is this value set?" for the plane itself is never answered here; the served plane answers it.
 *
 * `--fake-host <file>` is the renderer's declared test seam: a JSON file supplying the observers' values,
 * the answers, and a command runner that records instead of running. A spec drives a cold run with it.
 */

import {randomUUID}    from 'node:crypto';
import fsPromises      from 'node:fs/promises';
import os              from 'node:os';
import path            from 'node:path';
import readline        from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {RECIPE_STEPS, RECIPE_VERSION, STEP_KINDS, STEP_STATUSES, evaluateRecipe, exitCodeFor} from '../../services/fleet/firstRunRecipe.mjs';
import {EFFECT_IDS, admitCredentialReference, applyEffect, createHost, persistSetupRecord, recordConsent, settleReceipt} from '../../services/fleet/hostEffects.mjs';
import {presets}                                                                              from '../../services/fleet/placementPresets.mjs';
import {createDefaultReaders, probePlacement}                                                 from '../../services/fleet/probePlacement.mjs';
import {RETIRE_REASONS, contentDigest, createSetupRecord, describeBinding, readSetupRecord, resumeTarget, retireCurrentProof, setupRecordPath} from '../../services/fleet/setupRunRecord.mjs';
import {runHealthcheck}                                                                       from '../diagnostics/mcpHealthcheck.mjs';

const
    brainRoot      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    COMPOSE_PROJECT = 'neo-local-agent-os',
    COMPOSE_FILES   = ['docker-compose.yml', 'docker-compose.local-agent-os.yml'],
    USAGE           = `usage: node ai/scripts/setup/firstRun.mjs [--json] [--setup-root <dir>] [--state-root <dir>] [--run-id <uuid>]
       [--plane-id <id>] [--data-root <path>] [--endpoint <url>] [--fake-host <file>] [--help]

  Evaluates the first-run recipe live, asks the pending questions, performs the effects, re-evaluates.
  Exit code: 0 when the terminal step reads ok · 1 when a step failed or needs reconciling · 2 while pending.
`;

/**
 * @summary Parses the flags; unknown flags are refused.
 * @param {String[]} argv
 * @param {Object} [env=process.env] The host environment — read here only, for the two root defaults.
 * @returns {Object}
 */
export function parseArgs(argv, env = process.env) {
    const
        stateRoot = env.NEO_HOST_STATE_ROOT || path.join(os.homedir(), '.neo-ai'),
        options   = {
            json     : false,
            help     : false,
            stateRoot,
            setupRoot: env.NEO_HOST_SETUP_RECORD_ROOT || path.join(stateRoot, 'setup'),
            runId    : null,
            planeId  : null,
            dataRoot : null,
            endpoint : 'http://127.0.0.1:3102',
            fakeHost : null
        },
        valued    = {'--setup-root': 'setupRoot', '--state-root': 'stateRoot', '--run-id': 'runId', '--plane-id': 'planeId', '--data-root': 'dataRoot', '--endpoint': 'endpoint', '--fake-host': 'fakeHost'};

    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];

        if (flag === '--json') {
            options.json = true;
        } else if (flag === '--help' || flag === '-h') {
            options.help = true;
        } else if (valued[flag]) {
            const value = argv[++index];

            if (value === undefined || value.startsWith('--')) {
                throw new Error(`${flag} needs a value`);
            }

            options[valued[flag]] = value;
        } else {
            throw new Error(`unknown flag '${flag}'`);
        }
    }

    options.setupRoot = path.resolve(options.setupRoot);
    options.stateRoot = path.resolve(options.stateRoot);

    return options;
}

/**
 * @summary The host layout every production observer and effect shares.
 * @param {Object} options
 * @returns {Object}
 */
export function hostLayout({stateRoot}) {
    return {
        envFile      : path.join(stateRoot, 'config', 'local-agent-os.env'),
        secretsDir   : path.join(stateRoot, 'secrets'),
        composeDir   : path.join(brainRoot, 'deploy', 'cloud'),
        composeFiles : COMPOSE_FILES,
        composeProject: COMPOSE_PROJECT
    };
}

async function digestOfFile(fsModule, filePath) {
    try {
        return {present: true, digest: contentDigest(await fsModule.readFile(filePath, 'utf8')), problem: null};
    } catch (error) {
        return error?.code === 'ENOENT' ? {present: false, reason: `${filePath} does not exist`} : {present: true, digest: null, problem: error.message};
    }
}

/**
 * @summary The production observers over the host layout: the placement probe, the carrier and secret
 * files by digest and mode, the compose project, the served plane's identity through the MCP healthcheck.
 * `validation` and `done` are not observed yet — the recipe reports them `unknown`, never green.
 * @param {Object} options
 * @param {Object} options.layout
 * @param {Object} options.host
 * @param {Function} [options.probe=probePlacement]
 * @param {Function} [options.healthcheck=runHealthcheck]
 * @returns {Object}
 */
export function productionObservers({layout, host, probe = probePlacement, healthcheck = runHealthcheck}) {
    let probed = null;

    const placement = async () => {
        probed = await probe({target: 'local', readers: createDefaultReaders({run: host.run})});

        return probed;
    };

    return {
        placement,
        envCarrier  : () => digestOfFile(host.fsModule, layout.envFile),
        secretFiles : async () => {
            const files = await host.fsModule.readdir(layout.secretsDir).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));

            if (files.length === 0) {
                return {present: false, reason: `no secret files under ${layout.secretsDir}`};
            }

            for (const file of files) {
                const stat = await host.fsModule.stat(path.join(layout.secretsDir, file));

                if ((stat.mode & 0o077) !== 0) {
                    return {present: true, digest: null, problem: `${file} is readable beyond its owner`};
                }
            }

            return {present: true, digest: null, problem: null};
        },
        runningPlane: async () => {
            const result = probed ?? await placement();

            return {present: result.runningPlane?.project === layout.composeProject, digest: null, reason: 'the compose project is not running'};
        },
        servedPlane : async target => {
            const health = await healthcheck({url: target.endpoint, expectedStatus: 'healthy,degraded'});

            return health?.plane ?? null;
        }
    };
}

/**
 * @summary Observers and answers from a fake-host file (`{observers: {name: value | {throw: reason}}, answers: {stepId: answer}}`).
 * @param {Object} fake
 * @returns {{observers: Object, answers: Object}}
 */
export function fakeHostObservers(fake) {
    const observers = {};

    for (const [name, value] of Object.entries(fake.observers ?? {})) {
        observers[name] = async () => {
            if (value && typeof value === 'object' && typeof value.throw === 'string') {
                throw new Error(value.throw);
            }

            return value;
        };
    }

    return {observers, answers: fake.answers ?? {}};
}

function renderText(evaluation) {
    const lines = [`first-run recipe v${evaluation.recipeVersion} · target ${evaluation.target.planeId ?? '(undeclared)'} · record ${evaluation.binding}`];

    for (const step of evaluation.steps) {
        lines.push(`  ${step.status.padEnd(18)} ${step.id.padEnd(17)} ${step.reason}`);
    }

    return `${lines.join('\n')}\n`;
}

async function ask(question, {input, output}) {
    const rl = readline.createInterface({input, output});

    try {
        return (await rl.question(question)).trim();
    } finally {
        rl.close();
    }
}

async function answerQuestions({evaluation, answers, record, recordPath, host, io, interactive, stderr}) {
    let current = record;

    for (const step of evaluation.steps.filter(row => row.kind === STEP_KINDS.question && row.status === STEP_STATUSES.pending)) {
        let answer = answers[step.id] ?? null;

        if (answer === null && interactive) {
            const prompt = step.id === 'preset'
                ? `preset (${presets.map(preset => preset.id).join(' | ')}): `
                : step.id === 'plane-credential' ? 'plane credential file path (an existing file holding the PAT): ' : `${step.summary}: `;

            answer = await ask(prompt, io);
        }

        if (answer === null || answer === '') {
            continue;
        }

        if (step.id === 'preset' && !presets.some(preset => preset.id === answer)) {
            throw new Error(`'${answer}' is not a preset`);
        }

        // a file reference is admitted before the record sees it: a pasted token is refused here, never
        // recorded, and the refusal repeats nothing of the input
        if (RECIPE_STEPS.find(row => row.id === step.id)?.answer === 'file') {
            const admitted = await admitCredentialReference({answer, fsModule: host.fsModule});

            if (!admitted.ok) {
                stderr.write(`${step.id}: ${admitted.reason}\n`);
                continue;
            }

            answer = admitted.path;
        }

        current = (await recordConsent({stepId: step.id, answer, record: current, recordPath, host})).record;
    }

    return current;
}

async function performEffects({record, recordPath, host, layout, target, evaluation}) {
    const
        presetId  = record.consents.find(consent => consent.stepId === 'preset')?.answer ?? null,
        preset    = presets.find(row => row.id === presetId),
        patPath   = record.consents.find(consent => consent.stepId === 'plane-credential')?.answer ?? null;

    if (!preset || !patPath) {
        return record;
    }

    const
        pat     = (await host.fsModule.readFile(patPath, 'utf8')).trim(),
        entries = {
            ...preset.env,
            GH_TOKEN          : pat,
            NEO_PLANE_ID      : target.planeId,
            NEO_PLANE_DATA_ROOT: target.dataRoot
        };

    let current = record;

    for (const [effectId, input] of [
        [EFFECT_IDS.writeEnv,     {path: layout.envFile, entries}],
        [EFFECT_IDS.writeSecrets, {files: [{path: path.join(layout.secretsDir, 'fleet-plane-token'), content: pat}]}],
        [EFFECT_IDS.composeUp,    {project: layout.composeProject, cwd: layout.composeDir, envFile: layout.envFile, composeFiles: layout.composeFiles}]
    ]) {
        const stepStatus = evaluation.steps.find(step => step.effectId === effectId)?.status;

        if (stepStatus === STEP_STATUSES.ok) {
            continue;
        }

        // an unsettled effect is never replayed, and nothing is performed on top of it
        if (stepStatus === STEP_STATUSES.reconcileRequired) {
            break;
        }

        const result = await applyEffect({effectId, input, record: current, recordPath, host});

        current = result.record;

        if (result.receipt.outcome !== 'accepted') {
            break;
        }
    }

    return current;
}

/**
 * @summary Settles every interrupted effect — `pending` on disk, or already `reconcile-required` — whose
 * result is observable while the served plane is the target's: the fresh matching observation
 * bootstrap-record decision§2.6 asks for. One that does not settle is left `reconcile-required` by the writer, never replayed.
 */
async function settlePending({record, recordPath, host, evaluation}) {
    const planeMatches = evaluation.steps.find(row => row.id === 'served-plane')?.status === STEP_STATUSES.ok;

    let current = record;

    for (const step of evaluation.steps.filter(row => row.kind === STEP_KINDS.effect && row.status === STEP_STATUSES.reconcileRequired)) {
        const
            observed = step.observed,
            matches  = planeMatches && observed?.present === true && !observed.problem;

        current = (await settleReceipt({
            effectId   : step.effectId,
            observation: {status: matches ? 'ok' : 'failed', matchesTarget: matches, observedAt: step.observedAt, digest: observed?.digest ?? null, reason: matches ? null : 'the served plane does not match the target yet, or the result is not observable'},
            record     : current,
            recordPath,
            host
        })).record;
    }

    return current;
}

/**
 * @summary One run: read or create the record, evaluate, answer, perform, re-evaluate, print, exit.
 * @param {String[]} [argv=process.argv.slice(2)]
 * @param {Object} [io] `{stdout, stderr, stdin, env, isTTY}` — injectable for the spec.
 * @returns {Promise<Number>} The exit code.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
    const
        stdout  = io.stdout ?? process.stdout,
        stderr  = io.stderr ?? process.stderr,
        stdin   = io.stdin ?? process.stdin,
        options = parseArgs(argv, io.env ?? process.env);

    if (options.help) {
        stdout.write(USAGE);

        return 0;
    }

    const
        interactive = !options.json && (io.isTTY ?? Boolean(stdin.isTTY)) && !options.fakeHost,
        layout      = hostLayout(options);

    let target = {planeId: options.planeId, dataRoot: options.dataRoot, endpoint: options.endpoint}, host = createHost(), observers, answers = {};

    if (options.fakeHost) {
        // the fake host: a recording runner (its compose-up counts as the plane running), the real file
        // observers over the temp layout, and the fixture's values for everything it names
        const
            fake      = JSON.parse(await fsPromises.readFile(options.fakeHost, 'utf8')),
            callsPath = path.join(options.setupRoot, 'fake-run.json'),
            readCalls = () => fsPromises.readFile(callsPath, 'utf8').then(JSON.parse, () => []);

        host = createHost({run: async (command, args, runOptions) => {
            const calls = [...await readCalls(), {command, args, cwd: runOptions?.cwd}];

            await fsPromises.writeFile(callsPath, `${JSON.stringify(calls, null, 2)}\n`);

            return {stdout: '', stderr: ''};
        }});

        const fakeHost = fakeHostObservers(fake);

        observers = {
            ...productionObservers({layout, host}),
            placement   : async () => { throw new Error('no placement on the fake host') },
            runningPlane: async () => ({present: (await readCalls()).some(call => call.command === 'docker' && call.args[0] === 'compose' && call.args.includes('up')), digest: null, reason: 'the compose project is not running'}),
            ...fakeHost.observers
        };
        answers = fakeHost.answers;
    } else {
        observers = productionObservers({layout, host});
    }

    const
        runId      = options.runId ?? randomUUID(),
        recordPath = setupRecordPath(options.setupRoot, runId),
        read       = await readSetupRecord(recordPath, {fsModule: host.fsModule});

    let record = read.record;

    if (read.problem) {
        stderr.write(`record ${recordPath} is ${read.problem}; starting fresh\n`);
    }

    if (!record) {
        record = createSetupRecord({runId, target, recipeVersion: RECIPE_VERSION, now: host.now});
        await persistSetupRecord(recordPath, record, host);
    } else {
        // a resume names what it names; the record's bound target fills the rest, so a root the record
        // holds stays the expectation when the invocation omits it
        target = resumeTarget(record, target);

        const binding = describeBinding(record, {target, recipeVersion: RECIPE_VERSION});

        if (binding !== 'bound') {
            record = retireCurrentProof(record, {target, recipeVersion: RECIPE_VERSION, reason: binding === 'version-mismatch' ? RETIRE_REASONS.versionChanged : RETIRE_REASONS.targetChanged, now: host.now});
            await persistSetupRecord(recordPath, record, host);
            stderr.write(`record ${recordPath}: ${binding}; prior consents and receipts retired into history\n`);
        }
    }

    const evaluate = () => evaluateRecipe({target, record, observers, presets, now: host.now});

    let evaluation = await evaluate();

    record     = await answerQuestions({evaluation, answers, record, recordPath, host, io: {input: stdin, output: stdout}, interactive, stderr});
    evaluation = await evaluate();
    record     = await settlePending({record, recordPath, host, evaluation});
    // performing reads the settled state: a settled effect is skipped as ok, an unsettled one halts the run
    evaluation = await evaluate();
    record     = await performEffects({record, recordPath, host, layout, target, evaluation});
    evaluation = await evaluate();

    stdout.write(options.json || !interactive ? `${JSON.stringify({runId, recordPath, ...evaluation}, null, 2)}\n` : renderText(evaluation));

    return exitCodeFor(evaluation);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
    main().then(code => { process.exitCode = code }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 });
}
