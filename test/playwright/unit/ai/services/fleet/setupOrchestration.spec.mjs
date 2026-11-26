import {expect, test}  from '@playwright/test';
import fs              from 'node:fs/promises';
import os              from 'node:os';
import path            from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    EFFECT_IDS,
    createHost,
    hostEffectHandlers,
    persistSetupRecord,
    recordConsent
} from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {RECIPE_STEPS, RECIPE_VERSION, STEP_KINDS, STEP_STATUSES, evaluateRecipe, exitCodeFor} from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {presets}                                                                              from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {EFFECT_ORDER, performEffects, settlePending}                                          from '../../../../../../ai/services/fleet/setupOrchestration.mjs';
import {
    RECEIPT_OUTCOMES,
    RETIRE_REASONS,
    contentDigest,
    createSetupRecord,
    findReceipt,
    setupRecordPath,
    withReceipt
} from '../../../../../../ai/services/fleet/setupRunRecord.mjs';
import {extractReceiverDeclaration, parseLaunchAgentPlist} from '../../../../../../ai/services/fleet/wakeReceiverPlist.mjs';
import {productionObservers}                               from '../../../../../../ai/scripts/setup/firstRun.mjs';

// The orchestration over a real temp layout and the checkout's own config and Compose files; the command
// runner, the clock and every observation are scripted, and each run's file reads are recorded.

const
    here             = path.dirname(fileURLToPath(import.meta.url)),
    brainRoot        = path.resolve(here, '../../../../../..'),
    configSourcePath = path.join(brainRoot, 'ai/configBase.mjs'),
    MODULE_SOURCE    = path.join(brainRoot, 'ai/services/fleet/setupOrchestration.mjs'),
    RUN_ID           = '0f1e2d3c-4b5a-4968-8777-6655443322aa',
    NOW              = Date.UTC(2026, 9, 2, 15, 0, 0),
    PAT              = 'ghp_FAKEPAT0123456789abcdefghijklmnopqrstuv',
    FORGE_CLI        = 'ai/scripts/fleet/forgeConnections.mjs',
    target           = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'};

/**
 * @summary The plane's forge-connection CLI over one scripted store: `status` answers the forge the plane
 * declares and its binding, `init` and `register` change the store as the real commands do.
 * @returns {Function} `args → answer`
 */
function scriptedForge() {
    const declared = {authProvider: 'github', endpoint: 'https://api.github.com'};

    let store = null;

    return ([command, ...options]) => {
        if (command === 'init') {
            store = {binding: null};

            return {ok: true, applied: true, version: 1};
        }

        if (command === 'register') {
            store.binding = {connectionId: 'conn-1', authProvider: options[options.indexOf('--provider') + 1]};

            return {ok: true, connectionId: 'conn-1', applied: true};
        }

        return {ok: true, declared, declaredReason: null, state: store ? 'ok' : 'absent', reason: null, binding: store?.binding ?? null, tombstoned: false};
    };
}

/** The forge-CLI commands among a run's calls, by their arguments. */
const forgeCommands = calls => calls.filter(call => call.args.includes(FORGE_CLI)).map(call => call.args.slice(call.args.indexOf(FORGE_CLI) + 1));

/**
 * @summary A run whose preset and PAT are consented and nothing is performed yet.
 * @param {Object} [options]
 * @param {String}   [options.preset='local-small']
 * @param {Function} [options.forge] Answers the plane's forge-connection CLI; a throw is a command that printed nothing.
 * @returns {Promise<Object>} `{root, stateRoot, recordPath, patPath, calls, reads, host, layout, record}`
 */
async function consentedRun({preset = 'local-small', forge = scriptedForge(), desktopWake = 'declined'} = {}) {
    const
        root       = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-orchestration-')),
        stateRoot  = path.join(root, 'state'),
        homeDir    = path.join(root, 'home'),
        recordPath = setupRecordPath(path.join(stateRoot, 'setup'), RUN_ID),
        patPath    = path.join(root, 'operator', 'plane-pat'),
        calls      = [],
        reads      = [],
        launchd    = {loaded: false, running: false, plistPath: null, program: null, workingDirectory: null, arguments: null, defaultEnvironment: null, environment: null},
        fsModule   = {...fs, readFile: (file, ...rest) => { reads.push(String(file)); return fs.readFile(file, ...rest) }},
        host       = createHost({
            fsModule,
            platform            : () => 'darwin',
            uid                 : () => typeof process.getuid === 'function' ? process.getuid() : 501,
            wakeReadinessDelayMs: 0,
            probeWakeListener   : async ({host: h, port: p}) => launchd.loaded && launchd.running && h === '127.0.0.1' && p === 3199
                ? {listening: true, wakeReceiver: true, statusCode: 404, reason: null}
                : {listening: false, wakeReceiver: false, statusCode: null, reason: 'ECONNREFUSED'},
            run: async (command, args, options) => {
                calls.push({command, args, cwd: options?.cwd});

                if (command === 'launchctl') {
                    if (args[0] === 'print') {
                        if (!launchd.loaded) {
                            throw Object.assign(new Error('Could not find service'), {stderr: 'Could not find service'});
                        }

                        const
                            inhEnv = launchd.inheritedEnvironment && typeof launchd.inheritedEnvironment === 'object'
                                ? launchd.inheritedEnvironment
                                : {HOME: '/Users/operator', SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.mock/Listeners'},
                            defEnv = launchd.defaultEnvironment && typeof launchd.defaultEnvironment === 'object'
                                ? launchd.defaultEnvironment
                                : {PATH: '/usr/bin:/bin:/usr/sbin:/sbin'},
                            envMap = launchd.environment && typeof launchd.environment === 'object' ? launchd.environment : null;

                        return {
                            stdout: [
                                `\tstate = ${launchd.running ? 'running' : 'not running'}`,
                                `\tpid = ${launchd.running ? 4242 : 0}`,
                                ...(launchd.program ? [`\tprogram = ${launchd.program}`] : []),
                                ...(launchd.workingDirectory ? [`\tworking directory = ${launchd.workingDirectory}`] : []),
                                ...(Array.isArray(launchd.arguments) && launchd.arguments.length > 0
                                    ? ['\targuments = {', ...launchd.arguments.map(item => `\t\t${item}`), '\t}']
                                    : []),
                                '\tinherited environment = {',
                                ...Object.entries(inhEnv).map(([k, v]) => `\t\t${k} => ${v}`),
                                '\t}',
                                '\tdefault environment = {',
                                ...Object.entries(defEnv).map(([k, v]) => `\t\t${k} => ${v}`),
                                '\t}',
                                ...(envMap
                                    ? [
                                        '\tenvironment = {',
                                        '\t\tOSLogRateLimit => 64',
                                        ...Object.entries(envMap).map(([k, v]) => `\t\t${k} => ${v}`),
                                        '\t\tXPC_SERVICE_NAME => com.neomjs.agent-os-wake',
                                        '\t}'
                                    ]
                                    : []),
                                ...(launchd.plistPath ? [`\tpath = ${launchd.plistPath}`] : [])
                            ].join('\n'),
                            stderr: ''
                        };
                    }

                    if (args[0] === 'bootout') {
                        launchd.loaded  = false;
                        launchd.running = false;

                        return {stdout: '', stderr: ''};
                    }

                    if (args[0] === 'bootstrap') {
                        const
                            parsed = parseLaunchAgentPlist(await fs.readFile(args[2], 'utf8'), {allowComments: false}),
                            decl   = extractReceiverDeclaration(parsed);

                        launchd.loaded           = true;
                        launchd.running          = true;
                        launchd.plistPath        = args[2];
                        launchd.program          = decl.executable;
                        launchd.workingDirectory = parsed.WorkingDirectory ?? decl.runtimeRoot;
                        launchd.arguments        = parsed.ProgramArguments ?? null;
                        launchd.environment      = parsed.EnvironmentVariables ?? {};

                        return {stdout: '', stderr: ''};
                    }
                }

                return {stdout: args.includes(FORGE_CLI) ? JSON.stringify(forge(args.slice(args.indexOf(FORGE_CLI) + 1))) : '', stderr: ''};
            },
            now: () => NOW
        }),
        layout     = {
            homeDir,
            stateRoot,
            repoRoot        : brainRoot,
            nodeBin         : process.execPath,
            envFile         : path.join(stateRoot, 'config', 'local-agent-os.env'),
            secretsDir      : path.join(stateRoot, 'secrets'),
            composeDir      : path.join(brainRoot, 'deploy', 'cloud'),
            composeFiles    : ['docker-compose.yml', 'docker-compose.local-agent-os.yml'],
            composeProject  : 'neo-local-agent-os',
            wakeTemplatePath: path.join(brainRoot, 'deploy', 'host', 'com.neomjs.agent-os-wake.plist')
        };

    await fs.mkdir(path.dirname(patPath), {recursive: true});
    await fs.writeFile(patPath, `${PAT}\n`, {mode: 0o600});

    let record = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: () => NOW});

    await persistSetupRecord(recordPath, record, host);
    record = (await recordConsent({stepId: 'preset', answer: preset, record, recordPath, host})).record;
    record = (await recordConsent({stepId: 'plane-credential', answer: patPath, record, recordPath, host})).record;
    if (desktopWake !== null) {
        record = (await recordConsent({stepId: 'desktop-wake', answer: desktopWake, record, recordPath, host})).record;
    }

    return {root, stateRoot, homeDir, recordPath, patPath, calls, reads, host, layout, record, launchd};
}

/**
 * @summary The recipe's own evaluation of a run, with each effect's result on the host scripted.
 * @param {Object} record
 * @param {Object} [present={}] `{[effectId]: true}` for each result the host shows, or the observation itself.
 * @param {Object|Error} [servedPlane] What the served plane reports; the target's by default. An `Error`
 *     is a host where nothing answers.
 * @returns {Promise<Object>}
 */
function evaluate(record, present = {}, servedPlane = {id: target.planeId, dataRoot: target.dataRoot}) {
    const observe = effectId => async () => present[effectId] === true ? {present: true, digest: null, problem: null} : present[effectId] || {present: false, reason: 'not performed'};

    return evaluateRecipe({
        target,
        record,
        presets,
        now      : () => NOW,
        observers: {
            secretFiles    : observe(EFFECT_IDS.writeSecrets),
            envCarrier     : observe(EFFECT_IDS.writeEnv),
            runningPlane   : observe(EFFECT_IDS.composeUp),
            forgeConnection: observe(EFFECT_IDS.registerForge),
            wakeReceiver   : observe(EFFECT_IDS.startWakeReceiver),
            servedPlane    : async () => { if (servedPlane instanceof Error) throw servedPlane; return servedPlane }
        }
    });
}

const COLD = new Error('connect ECONNREFUSED 127.0.0.1:3102');

/**
 * @summary Runs `performEffects` the way a renderer does, collecting what it reports.
 * @returns {Promise<{record: Object, reports: String[]}>}
 */
async function perform(run, {record = run.record, evaluation, ...options}) {
    const reports = [];

    return {record: await performEffects({record, recordPath: run.recordPath, host: run.host, layout: run.layout, target, evaluation, report: message => reports.push(message), configSourcePath, ...options}), reports};
}

/**
 * @summary Parks an effect the way a crash between its handler and its receipt leaves it.
 */
async function interrupted(run, effectId) {
    const record = withReceipt(run.record, {effectId, outcome: RECEIPT_OUTCOMES.pending, inputDigest: 'x', startedAt: 't0'});

    await persistSetupRecord(run.recordPath, record, run.host);

    return record;
}

const receipts = record => record.receipts.map(receipt => [receipt.effectId, receipt.outcome]);

const exists = filePath => fs.access(filePath).then(() => true, () => false);

test.describe('setupOrchestration', () => {
    test('AC-2: with no filter the host effects run in their execution order, every one accepted', async () => {
        const
            run      = await consentedRun(),
            {record} = await perform(run, {evaluation: await evaluate(run.record)});

        // one list: the order that runs is the recipe's effect steps as listed, the secret files before the carrier that points at them
        expect(EFFECT_ORDER).toEqual(RECIPE_STEPS.filter(step => step.kind === STEP_KINDS.effect).map(step => step.effectId));
        expect(EFFECT_ORDER).toEqual([EFFECT_IDS.writeSecrets, EFFECT_IDS.writeEnv, EFFECT_IDS.composeUp, EFFECT_IDS.registerForge, EFFECT_IDS.startWakeReceiver, EFFECT_IDS.verify]);
        expect(receipts(record)).toEqual([['write-secrets', 'accepted'], ['write-env', 'accepted'], ['compose-up', 'accepted'], ['register-forge', 'accepted']]);
        expect(run.calls.map(call => [call.command, call.args[0], call.cwd])).toEqual(Array(6).fill(['docker', 'compose', run.layout.composeDir]));
        expect(run.calls[0].args).toContain('up');
        // the forge is read from the plane compose-up brought up, once for the input and once before the handler mutates
        expect(forgeCommands(run.calls)).toEqual([['status'], ['status'], ['init', '--apply'], ['register', '--provider', 'github', '--endpoint', 'https://api.github.com', '--apply'], ['status']]);
        expect(findReceipt(record, EFFECT_IDS.registerForge).references).toEqual(['forge-connection:conn-1']);

        const
            envContent     = await fs.readFile(run.layout.envFile, 'utf8'),
            disabledRecord = path.join(run.stateRoot, 'wake-receiver-disabled', 'records');

        expect(envContent).toContain('NEO_PLANE_ID=plane-a\n');
        expect(envContent).toContain(`NEO_WAKE_RECEIVER_RECORDS_HOST_DIR=${disabledRecord}\n`);
        expect((await fs.stat(disabledRecord)).mode & 0o777).toBe(0o700);
    });

    test('register-forge selected behind an unfinished compose-up waits for it and asks the plane nothing; a plane that cannot say what it declares is reported, and nothing is applied', async () => {
        const
            hostFiles = {[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: true},
            run       = await consentedRun(),
            waiting   = await perform(run, {evaluation: await evaluate(run.record, hostFiles), effectIds: [EFFECT_IDS.registerForge]});

        expect(waiting.record).toBe(run.record);
        expect(waiting.reports).toEqual(["'register-forge' waits for 'compose-up': it is pending (not performed)"]);
        expect(run.calls).toEqual([]);

        const
            mute    = await consentedRun({forge: () => { throw Object.assign(new Error('service "fleet-server" is not running'), {stdout: ''}) }}),
            refused = await perform(mute, {evaluation: await evaluate(mute.record, {...hostFiles, [EFFECT_IDS.composeUp]: true}), effectIds: [EFFECT_IDS.registerForge]});

        expect(refused.reports).toEqual(['\'register-forge\' could not read which connection the plane declares: the plane\'s connection registry did not answer: service "fleet-server" is not running — a new run asks again']);
        expect(findReceipt(refused.record, EFFECT_IDS.registerForge)).toBeNull();
        expect(forgeCommands(mute.calls)).toEqual([['status']]);
    });

    test('AC-2: [\'write-env\'] applies that effect and nothing after it once write-secrets is ok', async () => {
        const
            run      = await consentedRun(),
            {record} = await perform(run, {evaluation: await evaluate(run.record, {[EFFECT_IDS.writeSecrets]: true}), effectIds: [EFFECT_IDS.writeEnv]});

        expect(receipts(record)).toEqual([['write-env', 'accepted']]);
        expect(await exists(run.layout.envFile)).toBe(true);
        expect(await exists(run.layout.secretsDir)).toBe(false);
        expect(run.calls).toEqual([])
    });

    test('a selected effect never runs past an unfinished predecessor it was not given, and says which one it waits for', async () => {
        const
            run               = await consentedRun(),
            evaluation        = await evaluate(run.record),
            {record, reports} = await perform(run, {evaluation, effectIds: [EFFECT_IDS.writeEnv]});

        expect(record).toBe(run.record);
        expect(reports).toEqual(["'write-env' waits for 'write-secrets': it is pending (not performed)"]);
        // the report and the row's own data name the same step
        expect(evaluation.steps.find(step => step.id === EFFECT_IDS.writeEnv).waitsFor).toBe(EFFECT_IDS.writeSecrets);
        expect(await exists(run.layout.envFile)).toBe(false);
        expect(run.calls).toEqual([]);

        // decision §3's witness: the last host effect, selected alone on a cold run, waits for the first — no receipt, no file, no command
        const last = await perform(run, {evaluation, effectIds: [EFFECT_IDS.composeUp]});

        expect(last.record).toBe(run.record);
        expect(last.reports).toEqual(["'compose-up' waits for 'write-secrets': it is pending (not performed)"]);
        expect(await exists(run.layout.secretsDir)).toBe(false);
        expect(run.calls).toEqual([]);

        // a selection whose effect is already ok has nothing to wait for and nothing to say
        const settled = await perform(run, {evaluation: await evaluate(run.record, {[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: true}), effectIds: [EFFECT_IDS.writeEnv]});

        expect(settled.record).toBe(run.record);
        expect(settled.reports).toEqual([])
    });

    test('an unsettled predecessor halts the run although it was not selected, and the selected effect names it', async () => {
        const
            run               = await consentedRun(),
            parked            = await interrupted(run, EFFECT_IDS.writeSecrets),
            {record, reports} = await perform(run, {record: parked, evaluation: await evaluate(parked, {[EFFECT_IDS.writeEnv]: true}), effectIds: [EFFECT_IDS.composeUp]});

        expect(receipts(record)).toEqual([['write-secrets', 'pending']]);
        expect(reports).toEqual(["'compose-up' waits for 'write-secrets': it is reconcile-required (the effect may have run before its receipt was written; a fresh matching observation settles it)"]);
        expect(run.calls).toEqual([])
    });

    test('an effect that waits for a question says so and reads nothing: no consent yet, then a consented preset the table does not hold', async () => {
        const
            run      = await consentedRun(),
            bare     = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: () => NOW}),
            unasked  = await perform(run, {record: bare, evaluation: await evaluate(bare)}),
            selected = await perform(run, {record: bare, evaluation: await evaluate(bare), effectIds: [EFFECT_IDS.composeUp]}),
            foreign  = (await recordConsent({stepId: 'preset', answer: 'retired-preset', record: run.record, recordPath: run.recordPath, host: run.host})).record,
            unknown  = await perform(run, {record: foreign, evaluation: await evaluate(foreign)});

        expect(unasked.record).toBe(bare);
        expect(unasked.reports).toEqual(["'write-secrets' waits for 'preset': it is pending (unanswered)"]);
        expect(selected.reports).toEqual(["'compose-up' waits for 'preset': it is pending (unanswered)"]);
        expect(unknown.record).toBe(foreign);
        expect(unknown.reports).toEqual(["the consented preset 'retired-preset' is not in the preset table: no effect runs"]);
        expect(run.reads).toEqual([]);
        expect(run.calls).toEqual([]);
        expect(await exists(run.layout.secretsDir)).toBe(false)
    });

    test('an empty selection does nothing; an unknown effect is refused through report, reading and writing nothing', async () => {
        const
            run     = await consentedRun(),
            empty   = await perform(run, {evaluation: await evaluate(run.record), effectIds: []}),
            unknown = await perform(run, {evaluation: await evaluate(run.record), effectIds: [EFFECT_IDS.writeEnv, 'deploy']});

        expect(empty.record).toBe(run.record);
        expect(empty.reports).toEqual([]);
        expect(unknown.record).toBe(run.record);
        expect(unknown.reports).toEqual(["unknown effect 'deploy': the effects are write-secrets, write-env, compose-up, register-forge, start-wake-receiver, verify"]);
        expect(run.reads).toEqual([]);
        expect(run.calls).toEqual([])
    });

    test('AC-3: a refusal reaches report and writes nothing — the preset\'s env set, then the credentials', async () => {
        const
            run           = await consentedRun(),
            emptyConfig   = path.join(run.root, 'configBase.mjs'),
            presetRefused = await (async () => { await fs.writeFile(emptyConfig, ''); return perform(run, {evaluation: await evaluate(run.record), configSourcePath: emptyConfig}) })(),
            hosted        = await consentedRun({preset: 'hosted'}),
            keyRefused    = await perform(hosted, {evaluation: await evaluate(hosted.record)});

        expect(presetRefused.record).toBe(run.record);
        expect(presetRefused.reports).toHaveLength(1);
        expect(presetRefused.reports[0]).toMatch(/^preset 'local-small' refused before any write:\n {2}\S/);

        expect(keyRefused.record).toBe(hosted.record);
        expect(keyRefused.reports).toEqual(["credentials refused before any write:\n  the 'hosted' preset requires a provider key and none was given"]);

        for (const {layout, calls} of [run, hosted]) {
            expect(await exists(layout.envFile)).toBe(false);
            expect(await exists(layout.secretsDir)).toBe(false);
            expect(calls).toEqual([])
        }
    });

    test('AC-4: settlePending settles the plane\'s own effect only while the served plane matches the target', async () => {
        const
            run     = await consentedRun(),
            shown   = {[EFFECT_IDS.composeUp]: true},
            settle  = async (record, servedPlane) => settlePending({record, recordPath: run.recordPath, host: run.host, evaluation: await evaluate(record, shown, servedPlane)}),
            parked  = await interrupted(run, EFFECT_IDS.composeUp),
            wrong   = await settle(parked, {id: 'plane-b', dataRoot: target.dataRoot}),
            cold    = await settle(wrong, COLD),
            settled = await settle(cold, undefined);

        expect(findReceipt(wrong, EFFECT_IDS.composeUp).outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);
        expect(findReceipt(cold, EFFECT_IDS.composeUp).outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);
        expect(findReceipt(settled, EFFECT_IDS.composeUp)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation'});
        expect(run.calls).toEqual([])
    });

    test('a host-file effect interrupted before any plane serves settles by its own observation, and the run goes on', async () => {
        const
            run     = await consentedRun(),
            shown   = {[EFFECT_IDS.writeSecrets]: true},
            parked  = await interrupted(run, EFFECT_IDS.writeSecrets),
            settled = await settlePending({record: parked, recordPath: run.recordPath, host: run.host, evaluation: await evaluate(parked, shown, COLD)});

        expect(findReceipt(settled, EFFECT_IDS.writeSecrets)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation'});

        const {record, reports} = await perform(run, {record: settled, evaluation: await evaluate(settled, shown, COLD), effectIds: [EFFECT_IDS.writeEnv]});

        expect(receipts(record)).toEqual([['write-secrets', 'accepted'], ['write-env', 'accepted']]);
        expect(await exists(run.layout.envFile)).toBe(true);
        expect(reports).toEqual([]);
        expect(run.calls).toEqual([])
    });

    test('a host-file effect whose result the host shows only in part stays unsettled, and the halt repeats the observation\'s own reason', async () => {
        const
            run       = await consentedRun(),
            partial   = {[EFFECT_IDS.writeSecrets]: {present: false, reason: 'missing under /srv/state/secrets: fleet-plane-token'}},
            parked    = await interrupted(run, EFFECT_IDS.writeSecrets),
            unsettled = await settlePending({record: parked, recordPath: run.recordPath, host: run.host, evaluation: await evaluate(parked, partial, COLD)}),
            halted    = await perform(run, {record: unsettled, evaluation: await evaluate(unsettled, partial, COLD)});

        expect(findReceipt(unsettled, EFFECT_IDS.writeSecrets).outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);
        expect(halted.reports).toEqual(['\'write-secrets\' was interrupted and is not settled, so nothing runs past it: missing under /srv/state/secrets: fleet-plane-token']);
        expect(await exists(run.layout.secretsDir), 'nothing was written').toBe(false);
        expect(run.calls).toEqual([])
    });

    test('an interrupted carrier write settles only on the content the run was writing; a receipt without that expectation settles on presence', async () => {
        const
            run      = await consentedRun(),
            expected = contentDigest('NEO_PLANE_ID=plane-a\n'),
            park     = async expectation => {
                const record = withReceipt(run.record, {effectId: EFFECT_IDS.writeEnv, outcome: RECEIPT_OUTCOMES.pending, inputDigest: 'x', startedAt: 't0', ...expectation});

                await persistSetupRecord(run.recordPath, record, run.host);

                return record
            },
            carrier  = digest => ({[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: {present: true, digest, problem: null}}),
            settle   = async (record, digest) => settlePending({record, recordPath: run.recordPath, host: run.host, evaluation: await evaluate(record, carrier(digest), COLD)}),
            other    = await settle(await park({expectedDigest: expected}), contentDigest('NEO_PLANE_ID=plane-b\n'));

        expect(findReceipt(other, EFFECT_IDS.writeEnv)).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, expectedDigest: expected});

        // the row stays unsettled: the handler does not run over it, and the halt says why
        const halted = await perform(run, {record: other, evaluation: await evaluate(other, carrier(contentDigest('NEO_PLANE_ID=plane-b\n')), COLD), effectIds: [EFFECT_IDS.writeEnv]});

        expect(await exists(run.layout.envFile)).toBe(false);
        expect(halted.reports).toEqual(['\'write-env\' was interrupted and is not settled, so nothing runs past it: the file on the host is not the content this run was writing']);

        expect(findReceipt(await settle(other, expected), EFFECT_IDS.writeEnv)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation', digest: expected});
        expect(findReceipt(await settle(await park({}), contentDigest('anything\n')), EFFECT_IDS.writeEnv)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation'});
        expect(run.calls).toEqual([])
    });

    test('a halt behind the plane\'s unsettled effect says which row and what settles it, with or without the filter', async () => {
        const
            run       = await consentedRun(),
            shown     = {[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: true, [EFFECT_IDS.composeUp]: true},
            stale     = {id: target.planeId, dataRoot: '/srv/elsewhere'},
            parked    = await interrupted(run, EFFECT_IDS.composeUp),
            unsettled = await settlePending({record: parked, recordPath: run.recordPath, host: run.host, evaluation: await evaluate(parked, shown, stale)}),
            evaluated = await evaluate(unsettled, shown, stale),
            line      = '\'compose-up\' was interrupted and is not settled, so nothing runs past it: the served plane does not match the target yet, or the result is not observable';

        expect((await perform(run, {record: unsettled, evaluation: evaluated})).reports).toEqual([line]);
        expect((await perform(run, {record: unsettled, evaluation: evaluated, effectIds: [EFFECT_IDS.composeUp]})).reports).toEqual([line]);
        expect(run.calls).toEqual([])
    });

    test('AC-5: an interrupted effect, resumed through another renderer against a stale plane, is never applied again, with or without the filter', async () => {
        const
            run       = await consentedRun(),
            parked    = await interrupted(run, EFFECT_IDS.writeSecrets),
            stale     = {id: target.planeId, dataRoot: '/srv/elsewhere'},
            unsettled = await settlePending({record: parked, recordPath: run.recordPath, host: run.host, evaluation: await evaluate(parked, {}, stale)}),
            evaluated = await evaluate(unsettled, {}, stale),
            whole     = await perform(run, {record: unsettled, evaluation: evaluated}),
            one       = await perform(run, {record: unsettled, evaluation: evaluated, effectIds: [EFFECT_IDS.writeSecrets]});

        expect(evaluated.steps.find(step => step.effectId === EFFECT_IDS.writeSecrets).status).toBe(STEP_STATUSES.reconcileRequired);

        for (const {record} of [whole, one]) {
            expect(receipts(record)).toEqual([['write-secrets', 'reconcile-required']])
        }

        expect(await exists(run.layout.secretsDir)).toBe(false);
        expect(run.calls).toEqual([])
    });

    test('AC-6: outside the layout a run reads only the config source and the consented credential file, and the module reads no Agent OS config', async () => {
        const run = await consentedRun();

        await perform(run, {evaluation: await evaluate(run.record)});

        const outside = run.reads.filter(file => !file.startsWith(run.stateRoot + path.sep) && !file.startsWith(run.layout.composeDir + path.sep));

        expect([...new Set(outside)].sort()).toEqual([configSourcePath, run.patPath].sort());

        // nothing derived from config or from the module's own location
        const source = await fs.readFile(MODULE_SOURCE, 'utf8');

        expect(source).not.toMatch(/AiConfig|config\.mjs'|process\.env|import\.meta\.url/)
    });

    test('verify runs last, only behind a fresh served-plane AND validation, through a plane client built from the target endpoint and the consented credential; it is resumed, never halted on, and every reason it did not reach ok is reported', async () => {
        const
            run      = await consentedRun(),
            observed = {[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: true, [EFFECT_IDS.composeUp]: true},
            planes   = [],
            witness  = scripted => ({endpoint, credential}) => {
                const plane = {endpoint, credential, calls: [], closed: 0, ...scripted};

                planes.push(plane);

                return plane;
            },
            // the plane echoes what was written: the rows it answers carry the attempt's own marker
            green     = witness({
                addMemory  : async function(content) { this.written = content.prompt; return {id: 'mem-1', sessionId: 's', timestamp: 't'} },
                recentTurns: async function() { return {count: 1, turns: [{id: 'mem-1', prompt: this.written}], nextCursor: null} },
                recall     : async function() { return {count: 1, results: [{id: 'mem-1', prompt: this.written}]} },
                close      : async function() { this.closed++ }
            }),
            evaluateWith = (record, validation) => evaluateRecipe({target, record, presets, now: () => NOW, observers: {
                secretFiles    : async () => ({present: true, digest: null}),
                envCarrier     : async () => ({present: true, digest: null}),
                runningPlane   : async () => ({present: true, digest: null}),
                forgeConnection: async () => ({present: true, digest: null, problem: null}),
                wakeReceiver   : async () => ({present: true, running: true, digest: null}),
                servedPlane    : async () => ({id: target.planeId, dataRoot: target.dataRoot}),
                // the production observer's read of the record's section, through the recipe's `{record}` argument
                verification: async (_, {record: bound}) => ({present: bound?.verification?.recall?.hit === true, digest: null, problem: null, reason: 'not yet'}),
                ...(validation ? {validation: async () => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: 1024}})} : {})
            }});

        // the gate: with validation unknown the witness is not written, and the run says why
        const gated = await perform(run, {evaluation: await evaluateWith(run.record, false), createPlaneClient: green});

        expect(gated.record).toBe(run.record);
        expect(gated.reports).toEqual(["'verify' waits for 'validation': it is unknown (no 'validation' observer); the witness is written only through the validated target plane"]);
        expect(planes).toEqual([]);

        // a renderer without a plane (the fake host) is told, not failed
        const noPlane = await perform(run, {evaluation: await evaluateWith(run.record, true), createPlaneClient: null});

        expect(noPlane.record).toBe(run.record);
        expect(noPlane.reports).toEqual(["'verify' was not run: this renderer supplies no plane client"]);

        // gates open: the client is built from the target endpoint and the consented credential file's content, the witness lands, the client is closed
        const done = await perform(run, {evaluation: await evaluateWith(run.record, true), createPlaneClient: green});

        expect(planes).toHaveLength(1);
        expect(planes[0]).toMatchObject({endpoint: target.endpoint, credential: PAT, closed: 1});
        expect(findReceipt(done.record, EFFECT_IDS.verify)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted});
        expect(done.record.verification).toMatchObject({planeId: 'plane-a', memory: {id: 'mem-1'}, recall: {hit: true}});
        expect(done.reports).toEqual([]);
        expect(run.calls).toEqual([]);

        // an accepted witness is skipped as ok; the consent to a new attempt changes nothing on it — refused before a client is built, and said
        const again = await perform(run, {record: done.record, evaluation: await evaluateWith(done.record, true), createPlaneClient: green});

        expect(again.record).toBe(done.record);
        expect(planes).toHaveLength(1);

        const consented = await perform(run, {record: done.record, evaluation: await evaluateWith(done.record, true), createPlaneClient: green, newAttempt: true});

        expect(consented.record).toBe(done.record);
        expect(consented.reports).toEqual(["'verify' is accepted: no new attempt is made, the witness is complete; a new run witnesses a plane again"]);
        expect(planes).toHaveLength(1);

        // a pending resumable witness is RESUMED through performEffects (read-only), not halted on; its reason is reported
        const slow = witness({
            addMemory  : async function(content) { this.written = content.prompt; return {id: 'mem-2', sessionId: 's', timestamp: 't'} },
            recentTurns: async function() { return {count: 1, turns: [{id: 'mem-2', prompt: this.written}], nextCursor: null} },
            recall     : async () => ({count: 0, results: []}),
            close      : async function() { this.closed++ }
        });
        const fresh   = await consentedRun();
        const partial = await perform(fresh, {evaluation: await evaluateWith(fresh.record, true), createPlaneClient: slow});

        expect(findReceipt(partial.record, EFFECT_IDS.verify)).toMatchObject({outcome: RECEIPT_OUTCOMES.pending, resumable: true});
        expect(partial.reports).toEqual([`'verify' is pending: ${findReceipt(partial.record, EFFECT_IDS.verify).reason}`]);

        const resumed = await perform(fresh, {record: partial.record, evaluation: await evaluateWith(partial.record, true), createPlaneClient: slow});

        expect(planes.filter(plane => plane.calls !== undefined)).toHaveLength(3);
        expect(findReceipt(resumed.record, EFFECT_IDS.verify)).toMatchObject({outcome: RECEIPT_OUTCOMES.pending, resumable: true});
        expect(resumed.record.verification.attempt.marker).toBe(partial.record.verification.attempt.marker);

        // a new attempt the row did not offer stays the operator's consent at the host: it is made, and the attempt keeps the exits it was offered
        const outside = await perform(fresh, {record: resumed.record, evaluation: await evaluateWith(resumed.record, true), createPlaneClient: slow, newAttempt: true});

        expect(outside.record.verification.attempt.offered).toEqual(['resume']);
        expect(outside.record.verification.attempt.marker).not.toBe(partial.record.verification.attempt.marker);
        expect(outside.record.verification.priorAttempts).toHaveLength(1);
    });

    test('desktop-wake enables start-wake-receiver behind served-plane, writes 0700 active records carrier, materializes comment-free plist, and refuses dead-plist settlement', async () => {
        const
            unanswered = await consentedRun({desktopWake: null}),
            waited     = await perform(unanswered, {evaluation: await evaluate(unanswered.record)});

        expect(waited.record).toBe(unanswered.record);
        expect(waited.reports).toEqual(["'write-secrets' waits for 'desktop-wake': it is pending (unanswered)"]);

        const
            enabled   = await consentedRun({desktopWake: 'enabled'}),
            gatedEval = await evaluate(enabled.record, {[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: true, [EFFECT_IDS.composeUp]: true, [EFFECT_IDS.registerForge]: true}, COLD),
            gatedRun  = await perform(enabled, {evaluation: gatedEval, effectIds: [EFFECT_IDS.startWakeReceiver]});

        expect(gatedRun.reports).toEqual(["'start-wake-receiver' waits for 'served-plane': it is unknown (connect ECONNREFUSED 127.0.0.1:3102)"]);

        const
            okRun     = await perform(enabled, {evaluation: await evaluate(enabled.record), effectIds: EFFECT_ORDER.slice(0, -1)}),
            envText   = await fs.readFile(enabled.layout.envFile, 'utf8'),
            activeDir = path.join(enabled.stateRoot, 'wake-receiver', 'records'),
            plistPath = path.join(enabled.homeDir, 'Library', 'LaunchAgents', 'com.neomjs.agent-os-wake.plist');

        expect(okRun.reports).toEqual([]);
        expect(findReceipt(okRun.record, EFFECT_IDS.startWakeReceiver)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted});
        expect(envText).toContain(`NEO_WAKE_RECEIVER_RECORDS_HOST_DIR=${activeDir}\n`);
        expect((await fs.stat(activeDir)).mode & 0o777).toBe(0o700);
        expect(await fs.readFile(plistPath, 'utf8')).not.toContain('<!--');
        expect(enabled.calls.some(call => call.command === 'launchctl' && call.args[0] === 'bootstrap')).toBe(true);

        // settlePending refuses a stopped wake receiver even if its plist digest matches; only a running listener settles
        const
            parked     = await interrupted(enabled, EFFECT_IDS.startWakeReceiver),
            stoppedObs = {present: false, running: false, digest: 'x', reason: 'not running'},
            unsettled  = await settlePending({record: parked, recordPath: enabled.recordPath, host: enabled.host, evaluation: await evaluate(parked, {[EFFECT_IDS.startWakeReceiver]: stoppedObs})});

        expect(findReceipt(unsettled, EFFECT_IDS.startWakeReceiver).outcome).toBe(RECEIPT_OUTCOMES.reconcileRequired);

        const
            runningObs = {present: true, running: true, digest: 'x'},
            settled    = await settlePending({record: unsettled, recordPath: enabled.recordPath, host: enabled.host, evaluation: await evaluate(unsettled, {[EFFECT_IDS.startWakeReceiver]: runningObs})});

        expect(findReceipt(settled, EFFECT_IDS.startWakeReceiver)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, settledBy: 'observation'});
    });

    test('AC-1 & failed-reapplication arm: changing preset turns write-env, write-secrets and compose-up pending; a thrown re-application reads failed (never ok) while retaining the earlier receipt in history, and retries cleanly on the next run', async () => {
        const
            run          = await consentedRun(),
            keyPath      = path.join(run.root, 'operator', 'provider-key'),
            composeCalls = () => run.calls.filter(call => call.command === 'docker' && call.args[0] === 'compose' && call.args.includes('up')),
            mountedDir   = () => path.join(run.stateRoot, 'wake-receiver-disabled', 'records'),
            evaluateHost = record => evaluateRecipe({
                target,
                record,
                presets,
                now      : () => NOW,
                observers: {
                    ...productionObservers({
                        layout: run.layout,
                        host  : run.host,
                        probe : async () => ({
                            host        : {complete: true, availableBytes: 64 * 1073741824, pressure: 'ok'},
                            guest       : null,
                            observed    : {},
                            runningPlane: composeCalls().length > 0 ? {project: run.layout.composeProject} : null
                        }),
                        healthcheck: async () => {
                            if (composeCalls().length === 0) throw COLD;

                            return {plane: {id: target.planeId, dataRoot: target.dataRoot}, status: 'healthy'};
                        },
                        validate   : async ({preset}) => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: preset.vectorDimension}})
                    }),
                    runningPlane: async (t, {record: boundRecord = null} = {}) => {
                        const base = await productionObservers({
                            layout: run.layout,
                            host  : {
                                ...run.host,
                                run: async (command, args, opts) => {
                                    if (command === 'docker' && args[0] === 'ps') {
                                        return {stdout: composeCalls().length > 0 ? 'cid-mc-1\n' : '', stderr: ''};
                                    }
                                    if (command === 'docker' && args[0] === 'inspect') {
                                        return {stdout: JSON.stringify([{Destination: '/app/wake-receiver-records', Source: mountedDir()}]), stderr: ''};
                                    }

                                    return run.host.run(command, args, opts);
                                }
                            },
                            probe: async () => ({runningPlane: composeCalls().length > 0 ? {project: run.layout.composeProject} : null})
                        }).runningPlane(t, {record: boundRecord});

                        return base;
                    }
                }
            }),
            consent = async (rec, stepId, answer) => (await recordConsent({stepId, answer, record: rec, recordPath: run.recordPath, host: run.host})).record,
            row     = (evaluation, id) => evaluation.steps.find(step => step.id === id),
            statuses = (evaluation, ids) => Object.fromEntries(ids.map(id => [id, row(evaluation, id).status]));

        await fs.writeFile(keyPath, 'AIzaSENTINELPROVIDERKEY0123456789abcdefgh\n', {mode: 0o600});

        let {record} = await perform(run, {evaluation: await evaluateHost(run.record), createPlaneClient: null});

        const
            initialCarrier        = await fs.readFile(run.layout.envFile, 'utf8'),
            initialEnvReceipt     = findReceipt(record, EFFECT_IDS.writeEnv),
            initialSecretsReceipt = findReceipt(record, EFFECT_IDS.writeSecrets),
            initialComposeReceipt = findReceipt(record, EFFECT_IDS.composeUp);

        expect(statuses(await evaluateHost(record), ['write-secrets', 'write-env', 'compose-up', 'register-forge'])).toEqual({
            'write-secrets' : 'ok',
            'write-env'     : 'ok',
            'compose-up'    : 'ok',
            'register-forge': 'ok'
        });
        expect(composeCalls()).toHaveLength(1);

        // Operator changes preset from local-small to hosted + provider-key
        record = await consent(await consent(record, 'preset', 'hosted'), 'provider-key', keyPath);

        const changed = await evaluateHost(record);

        expect(statuses(changed, ['write-secrets', 'write-env', 'compose-up', 'register-forge'])).toEqual({
            'write-secrets' : 'pending',
            'write-env'     : 'pending',
            'compose-up'    : 'pending',
            'register-forge': 'ok'
        });
        for (const id of ['write-secrets', 'write-env', 'compose-up']) {
            expect(row(changed, id).reason, id).toMatch(/^accepted for an earlier input:/);
        }
        expect(row(changed, 'compose-up').reason).toContain('restarts the plane');
        expect(await fs.readFile(run.layout.envFile, 'utf8'), 'evaluating mutates nothing').toBe(initialCarrier);

        // Failed re-application arm: suppose docker compose up throws after write-secrets & write-env succeed
        let   failDockerOnce = true;
        const flakyHost      = {
            ...run.host,
            run: async (command, args, opts) => {
                if (failDockerOnce && command === 'docker' && args[0] === 'compose' && args.includes('up')) {
                    failDockerOnce = false;
                    throw new Error('docker daemon socket hung up during recreate');
                }

                return run.host.run(command, args, opts);
            }
        };

        record = await performEffects({
            record,
            recordPath       : run.recordPath,
            host             : flakyHost,
            layout           : run.layout,
            target,
            evaluation       : changed,
            report           : () => {},
            configSourcePath,
            createPlaneClient: null
        });

        const afterFailedRecompose = await evaluateHost(record);

        // Even though the earlier container is still running on the host, compose-up MUST read failed (never ok)
        expect(row(afterFailedRecompose, 'compose-up')).toMatchObject({
            status : STEP_STATUSES.failed,
            receipt: RECEIPT_OUTCOMES.failed,
            reason : 'docker daemon socket hung up during recreate'
        });
        expect(exitCodeFor(afterFailedRecompose)).toBe(1);

        // All three replaced local-small receipts were retained in record.history (bootstrap-record decision §2.7)
        expect(record.history.map(entry => [entry.effectId, entry.reason, entry.receipt])).toEqual([
            [EFFECT_IDS.writeSecrets, RETIRE_REASONS.inputChanged, initialSecretsReceipt],
            [EFFECT_IDS.writeEnv,     RETIRE_REASONS.inputChanged, initialEnvReceipt],
            [EFFECT_IDS.composeUp,    RETIRE_REASONS.inputChanged, initialComposeReceipt]
        ]);

        // Next run retries compose-up and brings all host effects to ok for the hosted inputs
        ({record} = await perform(run, {record, evaluation: afterFailedRecompose, createPlaneClient: null}));

        const
            hostedCarrier = await fs.readFile(run.layout.envFile, 'utf8'),
            afterRetry    = await evaluateHost(record);

        expect(hostedCarrier).not.toBe(initialCarrier);
        expect(hostedCarrier).toContain(`NEO_GEMINI_API_KEY_FILE=${path.join(run.layout.secretsDir, 'gemini-api-key')}\n`);
        expect((await fs.readdir(run.layout.secretsDir)).sort()).toEqual(['fleet-plane-token', 'gemini-api-key', 'mcp-auth-token']);
        expect(composeCalls()).toHaveLength(2);
        expect(statuses(afterRetry, ['write-secrets', 'write-env', 'compose-up', 'register-forge'])).toEqual({
            'write-secrets' : 'ok',
            'write-env'     : 'ok',
            'compose-up'    : 'ok',
            'register-forge': 'ok'
        });
    });

    test('AC-2, AC-3 & pre-merge keyless receipts: untouched effects stay ok on preset change, re-composed plane sets verify to pending with exits [run], writes one fresh marker, and keyless receipts compare inputDigest where identical to inputKey while disclosing write-secrets', async () => {
        const
            run          = await consentedRun(),
            planes       = [],
            composeCalls = () => run.calls.filter(call => call.command === 'docker' && call.args[0] === 'compose' && call.args.includes('up')),
            mountedDir   = () => path.join(run.stateRoot, 'wake-receiver-disabled', 'records'),
            plane        = ({endpoint, credential}) => {
                const client = {
                    endpoint,
                    credential,
                    addMemory  : async function(content) { this.written = content.prompt; return {id: `mem-${planes.length}`, sessionId: 's', timestamp: `t-${planes.length}`} },
                    recentTurns: async function() { return {count: 1, turns: [{id: `mem-${planes.length}`, prompt: this.written}], nextCursor: null} },
                    recall     : async function() { return {count: 1, results: [{id: `mem-${planes.length}`, prompt: this.written}]} },
                    close      : async () => {}
                };

                planes.push(client);

                return client;
            },
            evaluateHost = record => evaluateRecipe({
                target,
                record,
                presets,
                now      : () => NOW,
                observers: {
                    ...productionObservers({
                        layout: run.layout,
                        host  : run.host,
                        probe : async () => ({
                            host        : {complete: true, availableBytes: 64 * 1073741824, pressure: 'ok'},
                            guest       : null,
                            observed    : {},
                            runningPlane: composeCalls().length > 0 ? {project: run.layout.composeProject} : null
                        }),
                        healthcheck: async () => {
                            if (composeCalls().length === 0) throw COLD;

                            return {plane: {id: target.planeId, dataRoot: target.dataRoot}, status: 'healthy'};
                        },
                        validate   : async ({preset}) => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: preset.vectorDimension}})
                    }),
                    runningPlane: async (t, {record: boundRecord = null} = {}) => productionObservers({
                        layout: run.layout,
                        host  : {
                            ...run.host,
                            run: async (command, args, opts) => {
                                if (command === 'docker' && args[0] === 'ps') {
                                    return {stdout: composeCalls().length > 0 ? 'cid-mc-1\n' : '', stderr: ''};
                                }
                                if (command === 'docker' && args[0] === 'inspect') {
                                    return {stdout: JSON.stringify([{Destination: '/app/wake-receiver-records', Source: mountedDir()}]), stderr: ''};
                                }

                                return run.host.run(command, args, opts);
                            }
                        },
                        probe: async () => ({runningPlane: composeCalls().length > 0 ? {project: run.layout.composeProject} : null})
                    }).runningPlane(t, {record: boundRecord})
                }
            }),
            consent = async (rec, stepId, answer) => (await recordConsent({stepId, answer, record: rec, recordPath: run.recordPath, host: run.host})).record,
            row     = (evaluation, id) => evaluation.steps.find(step => step.id === id),
            pass    = async rec => (await perform(run, {record: rec, evaluation: await evaluateHost(rec), createPlaneClient: plane})).record;

        // Pass 1 brings the plane up, Pass 2 witnesses it
        let record = await pass(await pass(run.record));

        const
            firstMarker = record.verification.attempt.marker,
            witnessed   = await evaluateHost(record);

        expect(planes).toHaveLength(1);
        expect([row(witnessed, 'verify').status, row(witnessed, 'done').status]).toEqual(['ok', 'ok']);

        // Unchanged resume writes nothing
        expect(await pass(record)).toBe(record);
        expect(planes).toHaveLength(1);

        // AC-3: switch local-small -> local-full (touches write-env and compose-up; secret set is identical)
        record = await consent(record, 'preset', 'local-full');

        const changed = await evaluateHost(record);

        expect(row(changed, 'write-secrets').status).toBe('ok');
        expect(row(changed, 'register-forge').status).toBe('ok');
        expect(row(changed, 'write-env')).toMatchObject({status: 'pending', reason: expect.stringMatching(/^accepted for an earlier input:/)});
        expect(row(changed, 'compose-up')).toMatchObject({status: 'pending', reason: expect.stringContaining('restarts the plane')});
        expect(row(changed, 'done')).toMatchObject({status: 'pending', reason: expect.stringContaining('write-env was accepted for an earlier input')});

        const fleetTokenBefore = await fs.readFile(path.join(run.layout.secretsDir, 'fleet-plane-token'), 'utf8');

        // Re-compose pass (without inline evaluate callback): write-env & compose-up re-run, secrets stay untouched
        record = await pass(record);

        expect(await fs.readFile(path.join(run.layout.secretsDir, 'fleet-plane-token'), 'utf8')).toBe(fleetTokenBefore);
        expect(composeCalls()).toHaveLength(2);
        expect(planes).toHaveLength(1);

        // AC-2: after re-composition, verify reads pending and names exits: ['run'], duplicatePossible: false
        const recomposed = await evaluateHost(record);

        expect(row(recomposed, 'verify')).toMatchObject({
            status           : 'pending',
            reason           : expect.stringMatching(/^accepted for an earlier input:/),
            exits            : ['run'],
            duplicatePossible: false
        });
        expect(row(recomposed, 'done').status).toBe('pending');

        // Witness pass for the new composition: one fresh marker, prior attempt preserved
        record = await pass(record);

        expect(planes).toHaveLength(2);
        expect(record.verification.attempt.marker).not.toBe(firstMarker);
        expect(record.verification.attempt.offered).toEqual(['run']);
        expect(record.verification.priorAttempts.map(attempt => attempt.marker)).toEqual([firstMarker]);
        expect(findReceipt(record, EFFECT_IDS.verify)).toMatchObject({
            outcome : RECEIPT_OUTCOMES.accepted,
            inputKey: findReceipt(record, EFFECT_IDS.composeUp).inputKey
        });

        const settled = await evaluateHost(record);

        expect([row(settled, 'verify').status, row(settled, 'done').status]).toEqual(['ok', 'ok']);
        expect(await pass(record)).toBe(record);
        expect(planes).toHaveLength(2);

        // write-env and compose-up have inputKey === inputDigest; write-secrets does not (its inputDigest covers minted content).
        expect(findReceipt(record, EFFECT_IDS.writeEnv).inputKey).toBe(findReceipt(record, EFFECT_IDS.writeEnv).inputDigest);
        expect(findReceipt(record, EFFECT_IDS.composeUp).inputKey).toBe(findReceipt(record, EFFECT_IDS.composeUp).inputDigest);
        expect(findReceipt(record, EFFECT_IDS.writeSecrets).inputKey).not.toBe(findReceipt(record, EFFECT_IDS.writeSecrets).inputDigest);

        const strippedReceipts = {...record, receipts: record.receipts.map(({inputKey, ...rest}) => rest)};
        const keylessUnchanged = await evaluateHost(strippedReceipts);

        expect(row(keylessUnchanged, 'write-env')).toMatchObject({status: 'ok', reason: 'observed; matches the accepted receipt'});
        expect(row(keylessUnchanged, 'compose-up')).toMatchObject({status: 'ok', reason: 'observed; matches the accepted receipt'});
        expect(row(keylessUnchanged, 'write-secrets')).toMatchObject({status: 'ok', reason: 'observed; matches the accepted receipt (input not recorded)'});

        // When preset changes over pre-merge keyless receipts, write-env and compose-up compare inputDigest and turn pending; write-secrets keeps the disclosure.
        const keylessChanged = await consent(strippedReceipts, 'preset', 'local-small');
        const keylessEval    = await evaluateHost(keylessChanged);

        expect(row(keylessEval, 'write-env')).toMatchObject({
            status: 'pending',
            reason: 'accepted for an earlier input: the consents now render another carrier'
        });
        expect(row(keylessEval, 'compose-up')).toMatchObject({
            status: 'pending',
            reason: 'accepted for an earlier input: the carrier changed since the plane was composed — running it again restarts the plane'
        });
        expect(row(keylessEval, 'write-secrets')).toMatchObject({
            status: 'ok',
            reason: 'observed; matches the accepted receipt (input not recorded)'
        });
    });

    test('moving provider-key or plane-credential consent to another file turns write-secrets pending without reading secret values during evaluation, and the next run writes the new file', async () => {
        const
            run          = await consentedRun({preset: 'hosted'}),
            keyPathA     = path.join(run.root, 'operator', 'provider-key-a'),
            keyPathB     = path.join(run.root, 'operator', 'provider-key-b'),
            patPathB     = path.join(run.root, 'operator', 'plane-pat-b'),
            KEY_A        = 'fixture-provider-key-alpha',
            KEY_B        = 'fixture-provider-key-bravo',
            PAT_B        = 'ghp_FAKEPAT_BRAVO_0123456789abcdefghijklm',
            composeCalls = () => run.calls.filter(call => call.command === 'docker' && call.args[0] === 'compose' && call.args.includes('up')),
            mountedDir   = () => path.join(run.stateRoot, 'wake-receiver-disabled', 'records'),
            evaluateHost = record => evaluateRecipe({
                target,
                record,
                presets,
                now      : () => NOW,
                observers: {
                    ...productionObservers({
                        layout: run.layout,
                        host  : run.host,
                        probe : async () => ({
                            host        : {complete: true, availableBytes: 64 * 1073741824, pressure: 'ok'},
                            guest       : null,
                            observed    : {},
                            runningPlane: composeCalls().length > 0 ? {project: run.layout.composeProject} : null
                        }),
                        healthcheck: async () => {
                            if (composeCalls().length === 0) throw COLD;

                            return {plane: {id: target.planeId, dataRoot: target.dataRoot}, status: 'healthy'};
                        },
                        validate: async ({preset}) => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: preset.vectorDimension}})
                    }),
                    runningPlane: async (t, {record: boundRecord = null} = {}) => productionObservers({
                        layout: run.layout,
                        host  : {
                            ...run.host,
                            run: async (command, args, opts) => {
                                if (command === 'docker' && args[0] === 'ps') {
                                    return {stdout: composeCalls().length > 0 ? 'cid-mc-1\n' : '', stderr: ''};
                                }
                                if (command === 'docker' && args[0] === 'inspect') {
                                    return {stdout: JSON.stringify([{Destination: '/app/wake-receiver-records', Source: mountedDir()}]), stderr: ''};
                                }

                                return run.host.run(command, args, opts);
                            }
                        },
                        probe: async () => ({runningPlane: composeCalls().length > 0 ? {project: run.layout.composeProject} : null})
                    }).runningPlane(t, {record: boundRecord})
                }
            }),
            consent = async (rec, stepId, answer) => (await recordConsent({stepId, answer, record: rec, recordPath: run.recordPath, host: run.host})).record,
            row     = (evaluation, id) => evaluation.steps.find(step => step.id === id);

        await fs.writeFile(keyPathA, `${KEY_A}\n`, {mode: 0o600});
        await fs.writeFile(keyPathB, `${KEY_B}\n`, {mode: 0o600});
        await fs.writeFile(patPathB, `${PAT_B}\n`, {mode: 0o600});

        let record = await consent(run.record, 'provider-key', keyPathA);

        ({record} = await perform(run, {record, evaluation: await evaluateHost(record), createPlaneClient: null}));

        expect(row(await evaluateHost(record), 'write-secrets').status).toBe('ok');
        expect(await fs.readFile(path.join(run.layout.secretsDir, 'gemini-api-key'), 'utf8')).toBe(KEY_A);
        expect(await fs.readFile(path.join(run.layout.secretsDir, 'mcp-auth-token'), 'utf8')).toBe(PAT);

        // move provider-key consent to keyPathB; secretFiles observer computes inputKey without reading keyPathB
        record     = await consent(record, 'provider-key', keyPathB);
        run.reads.length = 0;

        const secretObsAfterKeyMove = await productionObservers({layout: run.layout, host: run.host}).secretFiles(target, {record});

        expect(run.reads).toEqual([]);
        expect(secretObsAfterKeyMove.inputKey).not.toBe(findReceipt(record, EFFECT_IDS.writeSecrets).inputKey);

        const afterKeyMove = await evaluateHost(record);

        expect(row(afterKeyMove, 'write-secrets')).toMatchObject({
            status: 'pending',
            reason: 'accepted for an earlier input: the consents now render another secret set'
        });
        expect(row(afterKeyMove, 'write-env').status).toBe('ok');
        expect(row(afterKeyMove, 'compose-up').status).toBe('ok');

        ({record} = await perform(run, {record, evaluation: afterKeyMove, createPlaneClient: null}));

        expect(await fs.readFile(path.join(run.layout.secretsDir, 'gemini-api-key'), 'utf8')).toBe(KEY_B);
        expect(row(await evaluateHost(record), 'write-secrets').status).toBe('ok');

        // move plane-credential consent to patPathB; write-secrets turns pending and next run writes PAT_B
        record     = await consent(record, 'plane-credential', patPathB);
        run.reads.length = 0;

        await productionObservers({layout: run.layout, host: run.host}).secretFiles(target, {record});
        expect(run.reads).toEqual([]);

        const afterPatMove = await evaluateHost(record);

        expect(row(afterPatMove, 'write-secrets')).toMatchObject({
            status: 'pending',
            reason: 'accepted for an earlier input: the consents now render another secret set'
        });
        expect(row(afterPatMove, 'write-env').status).toBe('ok');
        expect(row(afterPatMove, 'compose-up').status).toBe('ok');

        ({record} = await perform(run, {record, evaluation: afterPatMove, createPlaneClient: null}));

        expect(await fs.readFile(path.join(run.layout.secretsDir, 'mcp-auth-token'), 'utf8')).toBe(PAT_B);
        expect(row(await evaluateHost(record), 'write-secrets').status).toBe('ok');
    });
});
