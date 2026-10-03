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
import {admitCredentialReference, createHost, persistSetupRecord, recordConsent}              from '../../services/fleet/hostEffects.mjs';
import {presets}                                                                              from '../../services/fleet/placementPresets.mjs';
import {createDefaultReaders, probePlacement}                                                 from '../../services/fleet/probePlacement.mjs';
import {
    RETIRE_REASONS, contentDigest, createSetupRecord, describeBinding, readSetupRecord, resumeTarget, retireCurrentProof, setupRecordPath
} from '../../services/fleet/setupRunRecord.mjs';
import {performEffects, settlePending} from '../../services/fleet/setupOrchestration.mjs';
import {runHealthcheck}                from '../diagnostics/mcpHealthcheck.mjs';

const
    brainRoot       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
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
        envFile       : path.join(stateRoot, 'config', 'local-agent-os.env'),
        secretsDir    : path.join(stateRoot, 'secrets'),
        composeDir    : path.join(brainRoot, 'deploy', 'cloud'),
        composeFiles  : COMPOSE_FILES,
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
        envCarrier : () => digestOfFile(host.fsModule, layout.envFile),
        secretFiles: async () => {
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

/**
 * @summary Answers the pending questions in recipe order, re-evaluating after every consent, so a
 * question the consented preset decides (the provider key) is asked only once that preset requires it.
 * A question left unanswered or refused is not asked twice in one pass. Exported for the renderer spec.
 * @param {Object} options
 * @param {Function} options.evaluate `(record) → Promise<evaluation>`: the run's evaluation over a candidate record.
 * @param {Object}   options.answers  Answers by step id (a fake host's, or none when prompting).
 * @param {Object}   options.record
 * @param {String}   options.recordPath
 * @param {Object}   options.host
 * @param {Object}   options.io `{input, output}` for the prompts.
 * @param {Boolean}  options.interactive
 * @param {Object}   options.stderr
 * @returns {Promise<Object>} The record after the consents this pass could record.
 */
export async function answerQuestions({evaluate, answers, record, recordPath, host, io, interactive, stderr}) {
    const asked = new Set();

    let current = record, evaluation = await evaluate(current);

    for (;;) {
        const step = evaluation.steps.find(row => row.kind === STEP_KINDS.question && row.status === STEP_STATUSES.pending && !asked.has(row.id));

        if (!step) {
            return current;
        }

        asked.add(step.id);

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

        current    = (await recordConsent({stepId: step.id, answer, record: current, recordPath, host})).record;
        // the next question is decided by what was just consented
        evaluation = await evaluate(current);
    }
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
        // a receipt in a record that cannot be read may guard an effect that already ran: nothing runs over it
        stderr.write(`record ${recordPath} is ${read.problem}: refusing to run over it — move the file away, or name another --run-id\n`);

        return 1;
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

    const evaluate = (candidate = record) => evaluateRecipe({target, record: candidate, observers, presets, now: host.now});

    let evaluation;

    record     = await answerQuestions({evaluate, answers, record, recordPath, host, io: {input: stdin, output: stdout}, interactive, stderr});
    evaluation = await evaluate();
    record     = await settlePending({record, recordPath, host, evaluation});
    // performing reads the settled state: a settled effect is skipped as ok, an unsettled one halts the run
    evaluation = await evaluate();
    record     = await performEffects({record, recordPath, host, layout, target, evaluation, report: line => stderr.write(`${line}\n`), configSourcePath: path.join(brainRoot, 'ai/configBase.mjs')});
    evaluation = await evaluate();

    stdout.write(options.json || !interactive ? `${JSON.stringify({runId, recordPath, ...evaluation}, null, 2)}\n` : renderText(evaluation));

    return exitCodeFor(evaluation);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
    main().then(code => { process.exitCode = code }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 });
}
