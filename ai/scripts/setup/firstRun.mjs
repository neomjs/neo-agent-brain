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
import {secretFileNames}                                                                      from '../../services/fleet/credentialStep.mjs';
import {admitCredentialReference, createHost, persistSetupRecord, recordConsent}              from '../../services/fleet/hostEffects.mjs';
import {PLANE_MEMORY_CORE_PATH}                                                               from '../../services/fleet/mcpWireParsing.mjs';
import {presets}                                                                              from '../../services/fleet/placementPresets.mjs';
import {createDefaultReaders, probePlacement}                                                 from '../../services/fleet/probePlacement.mjs';
import {probeValidation}                                                                      from '../../services/fleet/providerValidation.mjs';
import {
    RETIRE_REASONS, contentDigest, createSetupRecord, describeBinding, findConsent, readSetupRecord, retireCurrentProof, runTarget, setupRecordPath
} from '../../services/fleet/setupRunRecord.mjs';
import {performEffects, settlePending}            from '../../services/fleet/setupOrchestration.mjs';
import {VERIFY_EXITS}                             from '../../services/fleet/verifyEffect.mjs';
import {CANONICAL_PLANE_ID, resolvePlaneDataRoot} from '../../planeConfig.mjs';
import {runHealthcheck}                           from '../diagnostics/mcpHealthcheck.mjs';

const
    brainRoot       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
    COMPOSE_PROJECT = 'neo-local-agent-os',
    COMPOSE_FILES   = ['docker-compose.yml', 'docker-compose.local-agent-os.yml'],
    // the plane this profile's compose files bring up: the canonical local plane, rooted where its image holds the
    // Brain (/app), behind the ingress the profile publishes on the loopback
    PROFILE_TARGET  = Object.freeze({planeId: CANONICAL_PLANE_ID, dataRoot: resolvePlaneDataRoot({rootDir: '/app'}), endpoint: 'http://127.0.0.1:3102'}),
    USAGE           = `usage: node ai/scripts/setup/firstRun.mjs [--json] [--setup-root <dir>] [--state-root <dir>] [--run-id <uuid>]
       [--plane-id <id>] [--data-root <path>] [--endpoint <url>] [--fake-host <file>] [--new-attempt] [--help]

  Evaluates the first-run recipe live, asks the pending questions, performs the effects, re-evaluates.
  A run that names no plane binds the one this profile declares: ${PROFILE_TARGET.planeId} at ${PROFILE_TARGET.dataRoot},
  served on ${PROFILE_TARGET.endpoint}. --plane-id, --data-root and --endpoint override it.
  --new-attempt consents to writing the first-run witness again (a duplicate row on the plane is possible);
  an accepted witness is never written again.
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
            json      : false,
            help      : false,
            stateRoot,
            setupRoot : env.NEO_HOST_SETUP_RECORD_ROOT || path.join(stateRoot, 'setup'),
            runId     : null,
            planeId   : null,
            dataRoot  : null,
            endpoint  : PROFILE_TARGET.endpoint,
            fakeHost  : null,
            newAttempt: false
        },
        valued    = {'--setup-root': 'setupRoot', '--state-root': 'stateRoot', '--run-id': 'runId', '--plane-id': 'planeId', '--data-root': 'dataRoot', '--endpoint': 'endpoint', '--fake-host': 'fakeHost'};

    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];

        if (flag === '--json') {
            options.json = true;
        } else if (flag === '--help' || flag === '-h') {
            options.help = true;
        } else if (flag === '--new-attempt') {
            options.newAttempt = true;
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
 * @summary The host layout every production observer and effect shares, and the one statement of the
 * profile it provisions: its compose project and files, and `target`, the plane those files bring up. A
 * run that names no plane binds that target (`setupRunRecord.runTarget`), whichever renderer starts it.
 * @param {Object} options
 * @returns {Object}
 */
export function hostLayout({stateRoot}) {
    return {
        envFile       : path.join(stateRoot, 'config', 'local-agent-os.env'),
        secretsDir    : path.join(stateRoot, 'secrets'),
        composeDir    : path.join(brainRoot, 'deploy', 'cloud'),
        composeFiles  : COMPOSE_FILES,
        composeProject: COMPOSE_PROJECT,
        target        : PROFILE_TARGET
    };
}

async function digestOfFile(fsModule, filePath) {
    try {
        return {present: true, digest: contentDigest(await fsModule.readFile(filePath, 'utf8')), problem: null};
    } catch (error) {
        return error?.code === 'ENOENT' ? {present: false, reason: `${filePath} does not exist`} : {present: true, digest: null, problem: error.message};
    }
}

export {PLANE_MEMORY_CORE_PATH};

/**
 * @summary The production observers over the host layout: the placement probe, the carrier by digest, the
 * secret files as the consented preset's whole set and by mode, the compose project, the served plane's
 * identity through the MCP healthcheck, the provider round trip, and the run's own witness.
 *
 * `servedPlane` asks the plane the way its clients do: the Memory Core route below the endpoint, the
 * consented plane credential as the bearer (read from the file the record references at call time — the
 * token lives in the request only, never in a log or the record), and the plane block as observed, asserted
 * against nothing: the recipe compares identity and root itself, so a wrong plane reads `failed` there. Before
 * the credential consent no bearer is sent; the plane's refusal is then the observer's reason (`unknown`).
 *
 * `validation` is a FRESH observation at every evaluation (`providerValidation.mjs`): one chat completion
 * and one embedding with the consented preset's env and the operator's key file; it reads no receipt. Its
 * bound: the supplied configuration answers from this host — the plane's own route is proven by `verify`,
 * through the plane. The recipe asks it only behind a served-plane row that is `ok` in the same evaluation.
 *
 * `verification` and `done` read the record's `verification` section — the plane's answers to THIS run's
 * witness, historical by construction: `done` turns `ok` only when the recipe finds `served-plane` and
 * `validation` fresh and `ok` beside it (bootstrap-record decision §3); without a section for this run it is
 * `unknown`, with a recorded refusal `failed`.
 * @param {Object} options
 * @param {Object} options.layout
 * @param {Object} options.host
 * @param {Function} [options.probe=probePlacement]
 * @param {Function} [options.healthcheck=runHealthcheck]
 * @param {Function} [options.validate=probeValidation] `({preset, providerKey}) → {provider, embedding}`.
 * @returns {Object}
 */
export function productionObservers({layout, host, probe = probePlacement, healthcheck = runHealthcheck, validate = probeValidation}) {
    let probed = null;

    const placement = async () => {
        probed = await probe({target: 'local', readers: createDefaultReaders({run: host.run})});

        return probed;
    };

    const consentedFile = async (record, stepId) => {
        const filePath = record ? findConsent(record, stepId)?.answer : null;

        return typeof filePath === 'string' ? (await host.fsModule.readFile(filePath, 'utf8')).trim() || null : null;
    };

    const witnessOf = record => {
        const section = record?.verification;

        if (!section) {
            throw new Error('no witness for this run yet: the verify effect has not run');
        }

        return section;
    };

    // the plane's own reason for a witness that cannot proceed: a refused write settles the attempt, a refused
    // read-only sub-step (readback, recall) is recorded on the section until a resume lands it
    const witnessRefusal = section => section?.attempt?.refused
        ? `the plane refused the witness write at ${section.attempt.refused.at}: ${section.attempt.refused.reason}`
        : section?.failure ? `the plane refused the ${section.failure.step} at ${section.failure.at}: ${section.failure.reason}` : null;

    return {
        placement,
        envCarrier : () => digestOfFile(host.fsModule, layout.envFile),
        // present means the WHOLE set the consented preset needs: the files are written one at a time,
        // so an interrupted write leaves some of them, and "any file" would read that as done
        secretFiles: async (target, {record = null} = {}) => {
            const
                files   = await host.fsModule.readdir(layout.secretsDir).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error)),
                consent = record ? findConsent(record, 'preset')?.answer : null,
                missing = secretFileNames(presets.find(preset => preset.id === consent) ?? null).filter(name => !files.includes(name));

            if (files.length === 0) {
                return {present: false, reason: `no secret files under ${layout.secretsDir}`};
            }

            if (missing.length > 0) {
                return {present: false, reason: `missing under ${layout.secretsDir}: ${missing.join(', ')}`};
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
        servedPlane : async (target, {record = null} = {}) => {
            const health = await healthcheck({
                url              : target.endpoint,
                mcpPath          : PLANE_MEMORY_CORE_PATH,
                bearerToken      : await consentedFile(record, 'plane-credential'),
                expectedStatus   : 'healthy,degraded',
                reportServedPlane: true
            });

            // identity AND the plane's own health word: a matching plane while `degraded` is identified, not ready
            // (bootstrap-record decision §2.5) — the recipe gates validation and completion on the status
            return health?.plane ? {...health.plane, status: health.status} : null;
        },
        validation : async (target, {record = null} = {}) => {
            const preset = presets.find(row => row.id === (record ? findConsent(record, 'preset')?.answer : null));

            if (!preset) {
                throw new Error('no preset consented: nothing to validate with');
            }

            return validate({preset, providerKey: (await consentedFile(record, 'provider-key')) ?? ''});
        },
        verification: async (target, {record = null} = {}) => {
            const section = record?.verification;

            // the effect step's observation beside its receipt: a refused attempt, or a refused read-only sub-step
            // the section recorded, is a present, failed result with the plane's reason (the card's next action
            // is re-check or an explicit new attempt); an incomplete one is not performed yet
            const refusal = witnessRefusal(section);

            if (refusal) {
                return {present: true, digest: null, problem: refusal};
            }

            return {present: Boolean(section?.memory && section.recall?.hit), digest: null, problem: null, reason: section ? 'the witness has not been written and recalled yet' : 'the verify effect has not run'};
        },
        done        : async (target, {record = null} = {}) => {
            const section = witnessOf(record);

            return {
                persisted    : Boolean(section.memory?.id),
                queryAnswered: section.recall?.hit === true,
                at           : section.memory?.at ?? null,
                reason       : witnessRefusal(section)
            };
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

/**
 * What the operator does for each of a witness row's exits (`verifyEffect.VERIFY_EXITS`).
 * @type {Object}
 */
const EXIT_TEXT = Object.freeze({
    [VERIFY_EXITS.run]       : 'a run performs it',
    [VERIFY_EXITS.resume]    : 'a re-run resumes it and writes nothing',
    [VERIFY_EXITS.newAttempt]: '--new-attempt writes the witness again'
});

/**
 * @summary What a row's own data says comes next: the step it waits for, or the witness row's exits with
 * whether a second row is possible. Read from the row's fields, never from its reason.
 * @param {Object} step An evaluated step.
 * @returns {String} A suffix for the row, or the empty string.
 */
function nextOf(step) {
    if (step.waitsFor) {
        return ` · waits for ${step.waitsFor}`;
    }

    if (!step.exits?.length) {
        return '';
    }

    const duplicate = !step.exits.includes(VERIFY_EXITS.newAttempt) ? '' : step.duplicatePossible ? ' (a second row on the plane is possible)' : ' (no duplicate is possible)';

    return ` · next: ${step.exits.map(exit => EXIT_TEXT[exit] ?? exit).join(', or ')}${duplicate}`;
}

/**
 * @summary The evaluation as the operator's text: one row per step — status, id, reason — and what the
 * row's data says comes next.
 * @param {Object} evaluation From `evaluateRecipe`.
 * @returns {String}
 */
export function renderText(evaluation) {
    const lines = [`first-run recipe v${evaluation.recipeVersion} · target ${evaluation.target.planeId ?? '(undeclared)'} · record ${evaluation.binding}`];

    for (const step of evaluation.steps) {
        lines.push(`  ${step.status.padEnd(18)} ${step.id.padEnd(17)} ${step.reason}${nextOf(step)}`);
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

    const named = {planeId: options.planeId, dataRoot: options.dataRoot, endpoint: options.endpoint};

    let target, host = createHost(), observers, answers = {};

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

    // what the invocation names, else what the record is bound to, else the plane the profile declares
    target = runTarget({record, named, profile: layout.target});

    if (!record) {
        record = createSetupRecord({runId, target, recipeVersion: RECIPE_VERSION, now: host.now});
        await persistSetupRecord(recordPath, record, host);
    } else {
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
    record     = await performEffects({
        record, recordPath, host, layout, target, evaluation,
        report          : line => stderr.write(`${line}\n`),
        configSourcePath: path.join(brainRoot, 'ai/configBase.mjs'),
        newAttempt      : options.newAttempt,
        // a fake host has no plane to witness through: the fixture's `done` observer stands in for the terminal read
        ...(options.fakeHost ? {createPlaneClient: null} : {})
    });
    evaluation = await evaluate();

    stdout.write(options.json || !interactive ? `${JSON.stringify({runId, recordPath, ...evaluation}, null, 2)}\n` : renderText(evaluation));

    return exitCodeFor(evaluation);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
    main().then(code => { process.exitCode = code }, error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 });
}
