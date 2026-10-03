import {expect, test}                                                                                  from '@playwright/test';
import fs                                                                                              from 'node:fs/promises';
import os                                                                                              from 'node:os';
import path                                                                                            from 'node:path';
import {fileURLToPath}                                                                                 from 'node:url';
import {EFFECT_IDS, createHost, persistSetupRecord, recordConsent}                                     from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {RECIPE_VERSION, STEP_STATUSES, evaluateRecipe}                                                 from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {presets}                                                                                       from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {EFFECT_ORDER, performEffects, settlePending}                                                   from '../../../../../../ai/services/fleet/setupOrchestration.mjs';
import {RECEIPT_OUTCOMES, contentDigest, createSetupRecord, findReceipt, setupRecordPath, withReceipt} from '../../../../../../ai/services/fleet/setupRunRecord.mjs';
import {productionObservers}                                                                           from '../../../../../../ai/scripts/setup/firstRun.mjs';

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
    target           = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'};

/**
 * @summary A run whose preset and PAT are consented and nothing is performed yet.
 * @param {Object} [options]
 * @param {String} [options.preset='local-small']
 * @returns {Promise<Object>} `{root, stateRoot, recordPath, patPath, calls, reads, host, layout, record}`
 */
async function consentedRun({preset = 'local-small'} = {}) {
    const
        root       = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-orchestration-')),
        stateRoot  = path.join(root, 'state'),
        recordPath = setupRecordPath(path.join(stateRoot, 'setup'), RUN_ID),
        patPath    = path.join(root, 'operator', 'plane-pat'),
        calls      = [],
        reads      = [],
        fsModule   = {...fs, readFile: (file, ...rest) => { reads.push(String(file)); return fs.readFile(file, ...rest) }},
        host       = createHost({fsModule, run: async (command, args, options) => { calls.push({command, args, cwd: options?.cwd}); return {stdout: '', stderr: ''} }, now: () => NOW}),
        layout     = {
            envFile       : path.join(stateRoot, 'config', 'local-agent-os.env'),
            secretsDir    : path.join(stateRoot, 'secrets'),
            composeDir    : path.join(brainRoot, 'deploy', 'cloud'),
            composeFiles  : ['docker-compose.yml', 'docker-compose.local-agent-os.yml'],
            composeProject: 'neo-local-agent-os'
        };

    await fs.mkdir(path.dirname(patPath), {recursive: true});
    await fs.writeFile(patPath, `${PAT}\n`, {mode: 0o600});

    let record = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: () => NOW});

    await persistSetupRecord(recordPath, record, host);
    record = (await recordConsent({stepId: 'preset', answer: preset, record, recordPath, host})).record;
    record = (await recordConsent({stepId: 'plane-credential', answer: patPath, record, recordPath, host})).record;

    return {root, stateRoot, recordPath, patPath, calls, reads, host, layout, record};
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
            secretFiles : observe(EFFECT_IDS.writeSecrets),
            envCarrier  : observe(EFFECT_IDS.writeEnv),
            runningPlane: observe(EFFECT_IDS.composeUp),
            servedPlane : async () => { if (servedPlane instanceof Error) throw servedPlane; return servedPlane }
        }
    });
}

const COLD = new Error('connect ECONNREFUSED 127.0.0.1:3102');

/**
 * @summary The recipe's evaluation over the host itself: the production observers read the run's temp
 * layout, its record and its command runner. Only the plane is scripted — once composed it answers as
 * the target's, and the provider validates at the consented preset's dimension.
 * @param {Object} run From {@link consentedRun}.
 * @param {Object} record
 * @returns {Promise<Object>}
 */
function evaluateOnHost(run, record) {
    return evaluateRecipe({
        target,
        record,
        presets,
        now      : () => NOW,
        observers: productionObservers({
            layout     : run.layout,
            host       : run.host,
            probe      : async () => ({runningPlane: dockerCalls(run) > 0 ? {project: run.layout.composeProject} : null}),
            healthcheck: async () => {
                if (dockerCalls(run) === 0) throw COLD;

                return {plane: {id: target.planeId, dataRoot: target.dataRoot}, status: 'healthy'};
            },
            validate   : async ({preset}) => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: preset.vectorDimension}})
        })
    });
}

/**
 * @summary Records one consent the way a renderer does.
 * @returns {Promise<Object>} The record after it.
 */
async function consent(run, record, stepId, answer) {
    return (await recordConsent({stepId, answer, record, recordPath: run.recordPath, host: run.host})).record;
}

const
    HOST_EFFECTS = [EFFECT_IDS.writeEnv, EFFECT_IDS.writeSecrets, EFFECT_IDS.composeUp],
    row          = (evaluation, id) => evaluation.steps.find(step => step.id === id),
    hostRows     = evaluation => Object.fromEntries(HOST_EFFECTS.map(id => [id, row(evaluation, id).status])),
    dockerCalls  = run => run.calls.filter(call => call.command === 'docker').length;

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
    test('AC-2: with no filter the three effects run in their execution order, every one accepted', async () => {
        const
            run      = await consentedRun(),
            {record} = await perform(run, {evaluation: await evaluate(run.record)});

        expect(EFFECT_ORDER).toEqual([EFFECT_IDS.writeSecrets, EFFECT_IDS.writeEnv, EFFECT_IDS.composeUp, EFFECT_IDS.verify]);
        expect(receipts(record)).toEqual([['write-secrets', 'accepted'], ['write-env', 'accepted'], ['compose-up', 'accepted']]);
        expect(run.calls.map(call => [call.command, call.args[0], call.cwd])).toEqual([['docker', 'compose', run.layout.composeDir]]);
        expect(await fs.readFile(run.layout.envFile, 'utf8')).toContain('NEO_PLANE_ID=plane-a\n')
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

    test('a selected effect never runs past an unfinished predecessor it was not given', async () => {
        const
            run      = await consentedRun(),
            {record} = await perform(run, {evaluation: await evaluate(run.record), effectIds: [EFFECT_IDS.writeEnv]});

        expect(record).toBe(run.record);
        expect(await exists(run.layout.envFile)).toBe(false);
        expect(run.calls).toEqual([])
    });

    test('an unsettled predecessor halts the run although it was not selected', async () => {
        const
            run      = await consentedRun(),
            parked   = await interrupted(run, EFFECT_IDS.writeSecrets),
            {record} = await perform(run, {record: parked, evaluation: await evaluate(parked, {[EFFECT_IDS.writeEnv]: true}), effectIds: [EFFECT_IDS.composeUp]});

        expect(receipts(record)).toEqual([['write-secrets', 'pending']]);
        expect(run.calls).toEqual([])
    });

    test('an empty selection does nothing; an unknown effect is refused through report, reading and writing nothing', async () => {
        const
            run     = await consentedRun(),
            empty   = await perform(run, {evaluation: await evaluate(run.record), effectIds: []}),
            unknown = await perform(run, {evaluation: await evaluate(run.record), effectIds: [EFFECT_IDS.writeEnv, 'deploy']});

        expect(empty.record).toBe(run.record);
        expect(empty.reports).toEqual([]);
        expect(unknown.record).toBe(run.record);
        expect(unknown.reports).toEqual(["unknown effect 'deploy': the effects are write-secrets, write-env, compose-up, verify"]);
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
            run       = await consentedRun(),
            observed  = {[EFFECT_IDS.writeSecrets]: true, [EFFECT_IDS.writeEnv]: true, [EFFECT_IDS.composeUp]: true},
            planes    = [],
            witness   = scripted => ({endpoint, credential}) => {
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
                secretFiles : async () => ({present: true, digest: null}),
                envCarrier  : async () => ({present: true, digest: null}),
                runningPlane: async () => ({present: true, digest: null}),
                servedPlane : async () => ({id: target.planeId, dataRoot: target.dataRoot}),
                // the production observer's read of the record's section, through the recipe's `{record}` argument
                verification: async (_, {record: bound}) => ({present: bound?.verification?.recall?.hit === true, digest: null, problem: null, reason: 'not yet'}),
                ...(validation ? {validation: async () => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: 1024}})} : {})
            }});

        // the gate: with validation unknown the witness is not written, and the run says why
        const gated = await perform(run, {evaluation: await evaluateWith(run.record, false), createPlaneClient: green});

        expect(gated.record).toBe(run.record);
        expect(gated.reports).toEqual(["'verify' waits: validation is unknown (no 'validation' observer); the witness is written only through the validated target plane"]);
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

        // an accepted witness is skipped as ok; the explicit new-attempt consent runs it again
        const again = await perform(run, {record: done.record, evaluation: await evaluateWith(done.record, true), createPlaneClient: green});

        expect(again.record).toBe(done.record);
        expect(planes).toHaveLength(1);

        const consented = await perform(run, {record: done.record, evaluation: await evaluateWith(done.record, true), createPlaneClient: green, newAttempt: true});

        expect(planes).toHaveLength(2);
        expect(consented.record.verification.priorAttempts).toHaveLength(1);

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

        expect(planes.filter(plane => plane.calls !== undefined)).toHaveLength(4);
        expect(findReceipt(resumed.record, EFFECT_IDS.verify)).toMatchObject({outcome: RECEIPT_OUTCOMES.pending, resumable: true});
        expect(resumed.record.verification.attempt.marker).toBe(partial.record.verification.attempt.marker);
    });

    test('a preset changed after its effects were accepted turns the carrier, the secret set and the composition pending for an earlier input, and the next run applies each as a new input', async () => {
        const run = await consentedRun(), keyPath = path.join(run.root, 'operator', 'provider-key');

        await fs.writeFile(keyPath, 'AIzaSENTINELPROVIDERKEY0123456789abcdefgh\n', {mode: 0o600});

        let {record} = await perform(run, {evaluation: await evaluateOnHost(run, run.record), createPlaneClient: null});

        const carrier = await fs.readFile(run.layout.envFile, 'utf8');

        expect(hostRows(await evaluateOnHost(run, record))).toEqual({'write-env': 'ok', 'write-secrets': 'ok', 'compose-up': 'ok'});

        record = await consent(run, await consent(run, record, 'preset', 'hosted'), 'provider-key', keyPath);

        const changed = await evaluateOnHost(run, record);

        expect(hostRows(changed)).toEqual({'write-env': 'pending', 'write-secrets': 'pending', 'compose-up': 'pending'});

        for (const id of HOST_EFFECTS) {
            expect(row(changed, id).reason, id).toMatch(/^accepted for an earlier input/);
        }

        expect(row(changed, EFFECT_IDS.composeUp).reason).toContain('restarts the plane');
        expect(await fs.readFile(run.layout.envFile, 'utf8'), 'an evaluation writes nothing').toBe(carrier);

        ({record} = await perform(run, {record, evaluation: changed, createPlaneClient: null}));

        const rendered = await fs.readFile(run.layout.envFile, 'utf8');

        expect(rendered).not.toBe(carrier);
        expect(rendered).toContain(`NEO_GEMINI_API_KEY_FILE=${path.join(run.layout.secretsDir, 'gemini-api-key')}`);
        expect((await fs.readdir(run.layout.secretsDir)).sort()).toEqual(['fleet-plane-token', 'gemini-api-key', 'mcp-auth-token']);
        expect(dockerCalls(run), 'the plane was composed again from the new carrier').toBe(2);
        expect(hostRows(await evaluateOnHost(run, record))).toEqual({'write-env': 'ok', 'write-secrets': 'ok', 'compose-up': 'ok'});
        expect(Object.fromEntries(receipts(record))).toMatchObject({'write-secrets': 'accepted', 'write-env': 'accepted', 'compose-up': 'accepted'});
    });

    test('a receipt accepted before input keys existed carries none and is not compared: a consent change leaves its row ok, and the row says its input was not recorded', async () => {
        const run = await consentedRun();

        let {record} = await perform(run, {evaluation: await evaluateOnHost(run, run.record), createPlaneClient: null});

        // the receipts as an earlier version recorded them
        record = {...record, receipts: record.receipts.map(({inputKey, ...receipt}) => receipt)};
        await persistSetupRecord(run.recordPath, record, run.host);
        record = await consent(run, record, 'preset', 'local-full');

        const keyless = await evaluateOnHost(run, record);

        expect(hostRows(keyless)).toEqual({'write-env': 'ok', 'write-secrets': 'ok', 'compose-up': 'ok'});

        for (const id of HOST_EFFECTS) {
            expect(row(keyless, id).reason, id).toBe('observed; matches the accepted receipt (input not recorded)');
        }
    });

    test('a consent change re-applies only the effects whose input it touches, and a re-composed plane earns one new witness attempt: the run reads done only after it', async () => {
        const
            run    = await consentedRun(),
            planes = [],
            plane  = ({endpoint, credential}) => {
                const client = {
                    endpoint,
                    credential,
                    addMemory  : async function(content) { this.written = content.prompt; return {id: `mem-${planes.length}`, sessionId: 's', timestamp: 't'} },
                    recentTurns: async function() { return {count: 1, turns: [{id: `mem-${planes.length}`, prompt: this.written}], nextCursor: null} },
                    recall     : async function() { return {count: 1, results: [{id: `mem-${planes.length}`, prompt: this.written}]} },
                    close      : async () => {}
                };

                planes.push(client);

                return client;
            },
            pass   = async record => (await perform(run, {record, evaluation: await evaluateOnHost(run, record), createPlaneClient: plane})).record;

        // the first pass brings the plane up, the second writes the witness through it
        let record = await pass(await pass(run.record));

        const first = record.verification.attempt.marker, witnessed = await evaluateOnHost(run, record);

        expect(planes).toHaveLength(1);
        expect([row(witnessed, 'verify').status, row(witnessed, 'done').status]).toEqual(['ok', 'ok']);

        // a resume without a consent change writes nothing
        expect(await pass(record)).toBe(record);
        expect(planes).toHaveLength(1);

        // local-full renders another carrier and needs the same secret set
        record = await consent(run, record, 'preset', 'local-full');

        const changed = await evaluateOnHost(run, record);

        expect(hostRows(changed)).toEqual({'write-env': 'pending', 'write-secrets': 'ok', 'compose-up': 'pending'});
        expect(row(changed, 'verify').status, 'the witness still follows the composition that runs').toBe('ok');
        expect(row(changed, 'done')).toMatchObject({status: 'pending', reason: expect.stringContaining('write-env was accepted for an earlier input')});

        const secretsBefore = await fs.readFile(path.join(run.layout.secretsDir, 'fleet-plane-token'), 'utf8');

        record = await pass(record);

        expect(await fs.readFile(path.join(run.layout.secretsDir, 'fleet-plane-token'), 'utf8'), 'the untouched secret set was not written again').toBe(secretsBefore);
        expect(dockerCalls(run)).toBe(2);
        expect(planes, 'no witness in the pass that re-composed the plane').toHaveLength(1);

        const recomposed = await evaluateOnHost(run, record);

        expect(hostRows(recomposed)).toEqual({'write-env': 'ok', 'write-secrets': 'ok', 'compose-up': 'ok'});
        expect(row(recomposed, 'verify')).toMatchObject({status: 'pending', reason: expect.stringMatching(/^accepted for an earlier input/)});
        expect(row(recomposed, 'done').status).toBe('pending');

        record = await pass(record);

        expect(planes, 'one new attempt, one write').toHaveLength(2);
        expect(record.verification.attempt.marker).not.toBe(first);
        expect(record.verification.priorAttempts.map(attempt => attempt.marker)).toEqual([first]);
        expect(findReceipt(record, EFFECT_IDS.verify)).toMatchObject({outcome: RECEIPT_OUTCOMES.accepted, inputKey: findReceipt(record, EFFECT_IDS.composeUp).inputKey});

        const settled = await evaluateOnHost(run, record);

        expect([row(settled, 'verify').status, row(settled, 'done').status]).toEqual(['ok', 'ok']);
        expect(await pass(record), 'and a resume after it writes nothing').toBe(record);
        expect(planes).toHaveLength(2);
    });
});
