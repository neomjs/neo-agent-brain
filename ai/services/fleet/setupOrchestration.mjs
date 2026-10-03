/**
 * @module ai/services/fleet/setupOrchestration
 * @summary The first-run recipe's effect orchestration, one implementation for every renderer with host
 * authority: the CLI (`ai/scripts/setup/firstRun.mjs`) and the vessel's setup broker. `performEffects`
 * turns the consented preset and the operator's credential files into the host effects' inputs and
 * applies them in their execution order, then performs the `verify` witness through the served plane;
 * `settlePending` closes an interrupted host effect from a fresh matching observation. Both write only
 * through `hostEffects`, so an effect accepted for the same input never runs again, and an interrupted one
 * is settled by observation, never replayed.
 *
 * **One writer is the caller's precondition.** Every write goes through `applyEffect` or `settleReceipt` on
 * the `recordPath` the caller names, and neither re-reads nor locks that file: the caller holds the current
 * record exclusively and serializes its calls. Nothing here detects a crossed write.
 *
 * The module reads no Agent OS config and derives no path from its own location: the config source a
 * preset is checked against arrives as `configSourcePath`, from the entrypoint.
 */

import path                                          from 'node:path';
import {composeCredentialEffects, presetEnvRefusals} from './credentialStep.mjs';
import {STEP_KINDS, STEP_STATUSES}                   from './firstRunRecipe.mjs';
import {EFFECT_IDS, applyEffect, settleReceipt}      from './hostEffects.mjs';
import {presets}                                     from './placementPresets.mjs';
import {createPlaneWitnessClient}                    from './planeWitnessClient.mjs';
import {RECEIPT_OUTCOMES, findReceipt}               from './setupRunRecord.mjs';
import {performVerify}                               from './verifyEffect.mjs';

/**
 * The order the effects run in, whichever renderer runs them. The recipe lists them in another order.
 * `verify` is last: it runs through the plane the others bring up, and only behind a fresh `served-plane`
 * and `validation` (`VERIFY_GATES`).
 * @type {String[]}
 */
export const EFFECT_ORDER = Object.freeze([EFFECT_IDS.writeSecrets, EFFECT_IDS.writeEnv, EFFECT_IDS.composeUp, EFFECT_IDS.verify]);

/**
 * The recipe steps that must read `ok` in the evaluation a `verify` run reads — the witness is written only
 * through the plane the run targets, validated with the configuration it supplied.
 * @type {String[]}
 */
export const VERIFY_GATES = Object.freeze(['served-plane', 'validation']);

/**
 * The effects whose result is a host file: they run before the plane exists, and bring it up.
 * @type {String[]}
 */
const HOST_FILE_EFFECTS = Object.freeze(EFFECT_ORDER.slice(0, EFFECT_ORDER.indexOf(EFFECT_IDS.composeUp)));

/**
 * @summary The credential step and the effects after it. The preset's env set is refused BEFORE any write
 * when the profile would not honour it (`presetEnvRefusals` over the config source and the Compose files);
 * the credentials are read from the operator's consented files and composed into secret files (the
 * admission token, a minted Fleet plane bearer, a hosted preset's provider key) and `_FILE` env values, so
 * the carrier and the record carry paths, never a value. The effects then run in
 * {@link EFFECT_ORDER}: one observed `ok` is skipped, and one `reconcile-required` or not accepted halts the
 * run — an unsettled effect is never replayed, nothing is performed on top of it, and the halt is reported
 * with the reason it is unsettled.
 *
 * `effectIds` lets a renderer run some effects only, without changing that order: an effect left out that is
 * not `ok` yet halts the run before anything after it, so a selected effect never runs past an unfinished
 * predecessor. An empty selection does nothing; an unknown id is refused through `report`.
 *
 * `verify` (`verifyEffect.mjs`) is the one effect performed through the served plane rather than on the
 * host: it runs only when every {@link VERIFY_GATES} step reads `ok` in `evaluation` (else the run halts
 * there and says so through `report`), with the consented plane credential, under the run's own record; a
 * `pending` + `resumable` or `reconcile-required` receipt of it is RESUMED, not halted on — the effect
 * re-runs only its read-only sub-steps and never writes the witness again (the `newAttempt` consent is the
 * one exception, explicit by construction).
 * @param {Object}   options
 * @param {Object}   options.record The current record, held exclusively by the caller.
 * @param {String}   options.recordPath
 * @param {Object}   options.host From `createHost`.
 * @param {Object}   options.layout `{envFile, secretsDir, composeDir, composeFiles, composeProject}`.
 * @param {Object}   options.target `{planeId, dataRoot, endpoint}`.
 * @param {Object}   options.evaluation The settled evaluation this run reads, from `evaluateRecipe`.
 * @param {Function} options.report `(message) → void`, once per refusal (a refused run writes nothing) and once for a halt behind an unsettled effect.
 * @param {String}   options.configSourcePath The Brain's `ai/configBase.mjs`, which a preset's env set is checked against.
 * @param {String[]} [options.effectIds] The effects to run now; every effect when absent.
 * @param {Boolean}  [options.newAttempt=false] The operator's explicit consent to write the witness again.
 * @param {Function} [options.createPlaneClient=createPlaneWitnessClient] `({endpoint, credential}) → {addMemory, recentTurns, recall, close}`; a renderer without a plane (a fake host) passes `null` and `verify` is reported, not run.
 * @returns {Promise<Object>} The record after the run.
 */
export async function performEffects({record, recordPath, host, layout, target, evaluation, report, configSourcePath, effectIds, newAttempt = false, createPlaneClient = createPlaneWitnessClient}) {
    const selected = effectIds ? new Set(effectIds) : null;

    if (selected) {
        const unknown = [...selected].filter(effectId => !EFFECT_ORDER.includes(effectId));

        if (unknown.length > 0) {
            report(`unknown effect ${unknown.map(effectId => `'${effectId}'`).join(', ')}: the effects are ${EFFECT_ORDER.join(', ')}`);

            return record;
        }

        if (selected.size === 0) {
            return record;
        }
    }

    const
        consent = stepId => record.consents.find(row => row.stepId === stepId)?.answer ?? null,
        preset  = presets.find(row => row.id === consent('preset')),
        patPath = consent('plane-credential'),
        keyPath = consent('provider-key');

    if (!preset || !patPath) {
        return record;
    }

    const refusals = presetEnvRefusals({
        preset,
        configSource: await host.fsModule.readFile(configSourcePath, 'utf8'),
        composeTexts: await Promise.all(layout.composeFiles.map(file => host.fsModule.readFile(path.join(layout.composeDir, file), 'utf8')))
    });

    if (refusals.length > 0) {
        report(`preset '${preset.id}' refused before any write:\n  ${refusals.join('\n  ')}`);

        return record;
    }

    const credentials = composeCredentialEffects({
        preset,
        pat        : await host.fsModule.readFile(patPath, 'utf8'),
        providerKey: keyPath ? await host.fsModule.readFile(keyPath, 'utf8') : '',
        secretsDir : layout.secretsDir
    });

    if (credentials.refusals.length > 0) {
        report(`credentials refused before any write:\n  ${credentials.refusals.join('\n  ')}`);

        return record;
    }

    const inputs = {
        [EFFECT_IDS.writeSecrets]: {files: credentials.secretFiles.map(({path: filePath, content}) => ({path: filePath, content}))},
        [EFFECT_IDS.writeEnv]    : {path: layout.envFile, entries: {...preset.env, ...credentials.envEntries, NEO_PLANE_ID: target.planeId, NEO_PLANE_DATA_ROOT: target.dataRoot}},
        [EFFECT_IDS.composeUp]   : {project: layout.composeProject, cwd: layout.composeDir, envFile: layout.envFile, composeFiles: layout.composeFiles}
    };

    let current = record;

    for (const effectId of EFFECT_ORDER) {
        const stepStatus = evaluation.steps.find(step => step.effectId === effectId)?.status;

        if (stepStatus === STEP_STATUSES.ok && !(effectId === EFFECT_IDS.verify && newAttempt)) {
            continue;
        }

        if (selected && !selected.has(effectId)) {
            break;
        }

        if (effectId === EFFECT_IDS.verify) {
            current = await runVerify({record: current, recordPath, host, target, evaluation, report, patPath, newAttempt, createPlaneClient});
            break;
        }

        if (stepStatus === STEP_STATUSES.reconcileRequired) {
            const reason = unsettledReason({
                effectId,
                observed      : evaluation.steps.find(step => step.effectId === effectId)?.observed,
                expectedDigest: findReceipt(current, effectId)?.expectedDigest,
                planeMatches  : evaluation.steps.find(step => step.id === 'served-plane')?.status === STEP_STATUSES.ok
            });

            report(`'${effectId}' was interrupted and is not settled, so nothing runs past it: ${reason ?? 'a re-check settles it'}`);
            break;
        }

        const result = await applyEffect({effectId, input: inputs[effectId], record: current, recordPath, host});

        current = result.record;

        if (result.receipt.outcome !== RECEIPT_OUTCOMES.accepted) {
            break;
        }
    }

    return current;
}

/**
 * @summary Why an interrupted effect's fresh observation does not match the target, or `null` when it does.
 * A host-file effect is matched by the file itself — present, no problem, and the content its pending
 * receipt expected where it recorded one: it exists to bring the plane up, so no plane can vouch for it.
 * The plane's own effect is matched by the served plane.
 * @param {Object}      options
 * @param {String}      options.effectId
 * @param {Object|null} options.observed The step's observation (`{present, digest, problem}`).
 * @param {String}      [options.expectedDigest] From the effect's receipt.
 * @param {Boolean}     options.planeMatches Whether the served plane is the target's.
 * @returns {String|null}
 */
function unsettledReason({effectId, observed, expectedDigest, planeMatches}) {
    const shown = observed?.present === true && !observed.problem;

    if (!HOST_FILE_EFFECTS.includes(effectId)) {
        return planeMatches && shown ? null : 'the served plane does not match the target yet, or the result is not observable';
    }

    if (!shown) {
        // the observation's own words: which file is missing, or what is wrong with the one that is there
        return observed?.problem ?? observed?.reason ?? 'the result is not observable on the host';
    }

    return expectedDigest && observed.digest !== expectedDigest ? 'the file on the host is not the content this run was writing' : null;
}

/**
 * @summary The `verify` leg of {@link performEffects}: the gates, the plane client over the consented
 * credential, the effect, the client's teardown — and a `report` for every reason it did not run to `ok`.
 * @param {Object} options See {@link performEffects}; `patPath` is the consented plane credential file.
 * @returns {Promise<Object>} The record after the leg.
 * @private
 */
async function runVerify({record, recordPath, host, target, evaluation, report, patPath, newAttempt, createPlaneClient}) {
    const stale = VERIFY_GATES.map(id => evaluation.steps.find(step => step.id === id)).find(step => step?.status !== STEP_STATUSES.ok);

    if (stale) {
        report(`'verify' waits: ${stale.id} is ${stale.status} (${stale.reason}); the witness is written only through the validated target plane`);

        return record;
    }

    if (typeof createPlaneClient !== 'function') {
        report('\'verify\' was not run: this renderer supplies no plane client');

        return record;
    }

    const plane = createPlaneClient({endpoint: target.endpoint, credential: (await host.fsModule.readFile(patPath, 'utf8')).trim()});

    try {
        const result = await performVerify({record, recordPath, host, target, plane, newAttempt});

        if (result.receipt && result.receipt.outcome !== RECEIPT_OUTCOMES.accepted) {
            report(`'verify' is ${result.receipt.outcome}: ${result.receipt.reason}`);
        }

        return result.record;
    } finally {
        await plane.close?.();
    }
}

/**
 * @summary Settles every interrupted effect — `pending` on disk, or already `reconcile-required` — from
 * the fresh matching observation the bootstrap-record decision asks for (§2.6): a host-file effect by the
 * file itself, the plane's own effect while the served plane is the target's ({@link unsettledReason}).
 * One that does not settle is left `reconcile-required` by the writer, never replayed.
 * @param {Object} options
 * @param {Object} options.record The current record, held exclusively by the caller.
 * @param {String} options.recordPath
 * @param {Object} options.host From `createHost`.
 * @param {Object} options.evaluation From `evaluateRecipe`.
 * @returns {Promise<Object>} The record after the settle pass.
 */
export async function settlePending({record, recordPath, host, evaluation}) {
    const planeMatches = evaluation.steps.find(row => row.id === 'served-plane')?.status === STEP_STATUSES.ok;

    let current = record;

    for (const step of evaluation.steps.filter(row => row.kind === STEP_KINDS.effect && row.status === STEP_STATUSES.reconcileRequired)) {
        const
            observed = step.observed,
            reason   = unsettledReason({effectId: step.effectId, observed, expectedDigest: findReceipt(current, step.effectId)?.expectedDigest, planeMatches});

        current = (await settleReceipt({
            effectId   : step.effectId,
            observation: {status: reason ? 'failed' : 'ok', matchesTarget: !reason, observedAt: step.observedAt, digest: observed?.digest ?? null, reason},
            record     : current,
            recordPath,
            host
        })).record;
    }

    return current;
}
