/**
 * @module ai/services/fleet/firstRunRecipe
 * @summary The first-run recipe: one versioned step list, evaluated LIVE for a bound target (bootstrap-record decision§2.3,
 * §2.5; the setup epic's point 1). Every step's status is a fresh read — a question
 * reads the record's consent (prior consent IS the record's authority), an effect reads the observation
 * of its result beside its receipt (a receipt alone is never green), an observation reads the owner that
 * already observes it (the placement probe, the served plane's identity, the provider round trip).
 *
 * The module is pure over injected observers: `evaluateRecipe({target, record, observers, presets})`
 * never touches the host, never reads config, never writes. The CLI and the vessel's main process supply
 * production observers; a spec supplies stubs and proves AC-1 (stubbed observers fail → nothing is green
 * whatever the record holds) and AC-3 (another target's record turns no step green).
 *
 * An effect row is also the renderer's instruction (decision §2.10): `waitsFor`, and on the witness row
 * `exits` and `duplicatePossible`. A renderer chooses from these fields; a `reason` is for the operator.
 *
 * The placement step adds the one judgement the probe and the preset table do not make — a named
 * headroom: a preset is recommended only when the host margin clears `HEADROOM_BYTES` and the guest
 * margin is non-negative; a bare fit is *possible, not recommended*; a `candidate` preset (no recorded
 * floor) is never recommended by default.
 */

import {ANY_FORGE_NAME}                                              from './forgeProviders.mjs';
import {GiB, fitsPreset}                                             from './probePlacement.mjs';
import {presetStatus}                                                from './placementPresets.mjs';
import {RECEIPT_OUTCOMES, describeBinding, findConsent, findReceipt} from './setupRunRecord.mjs';
import {verifyExits}                                                 from './verifyEffect.mjs';

/**
 * The recipe version a record is evaluated under; a record from another version is shown as a mismatch
 * and retired as current proof (bootstrap-record decision§2.7).
 * @type {Number}
 */
export const RECIPE_VERSION = 1;

/**
 * The working headroom a recommendation needs above a bare fit — the 2026-09-23 harness-stack measurement:
 * the OS starts compressing below it.
 * @type {Number}
 */
export const HEADROOM_BYTES = 4 * GiB;

/**
 * @type {Object}
 */
export const STEP_KINDS = Object.freeze({
    question   : 'question',
    effect     : 'effect',
    observation: 'observation'
});

/**
 * A step's finite statuses. `ok` is a fresh positive read; `pending` an unanswered question or an effect
 * not yet performed; `unknown` an observer that failed or is missing (never green by default); `failed`
 * a fresh negative read; `reconcile-required` an effect whose receipt was interrupted (settled only by a
 * matching observation).
 * @type {Object}
 */
export const STEP_STATUSES = Object.freeze({
    ok               : 'ok',
    pending          : 'pending',
    unknown          : 'unknown',
    failed           : 'failed',
    reconcileRequired: 'reconcile-required'
});

/**
 * The v1 steps in order. `observer` names the injected reader a step consults; `effectId` the host effect
 * whose receipt and result an effect step reads; `answer: 'file'` marks a question answered by a file
 * reference, admitted as one before it is recorded; `terminal` marks the step whose `ok` ends the run.
 * The effect steps run in the order listed here and nowhere else (decision §2.10); `gates` names the
 * observations an effect waits for beside the questions and effects before it.
 * @type {Object[]}
 */
export const RECIPE_STEPS = Object.freeze([
    Object.freeze({id: 'placement',        kind: STEP_KINDS.observation, observer: 'placement',    summary: 'the presets this host bears, each with its reason'}),
    Object.freeze({id: 'preset',           kind: STEP_KINDS.question,                              summary: 'the inference preset'}),
    Object.freeze({id: 'plane-credential', kind: STEP_KINDS.question,    answer: 'file',           summary: 'the plane credential, kept as a secret file (the record holds its path)'}),
    Object.freeze({id: 'provider-key',     kind: STEP_KINDS.question,    answer: 'file', requiredBy: 'providerKey', summary: 'the provider key file, when the consented preset requires one (the record holds its path)'}),
    Object.freeze({id: 'advanced',         kind: STEP_KINDS.question,    optional: true,           summary: 'advanced bindings, folded by default'}),
    Object.freeze({id: 'write-secrets',    kind: STEP_KINDS.effect,      observer: 'secretFiles',  effectId: 'write-secrets', summary: 'the secret files exist, owner-only'}),
    Object.freeze({id: 'write-env',        kind: STEP_KINDS.effect,      observer: 'envCarrier',   effectId: 'write-env',     summary: 'the plane env carrier holds the preset and the plane bindings'}),
    Object.freeze({id: 'compose-up',       kind: STEP_KINDS.effect,      observer: 'runningPlane', effectId: 'compose-up',    summary: 'the compose project is running'}),
    Object.freeze({id: 'register-forge',   kind: STEP_KINDS.effect,      observer: 'forgeConnection', effectId: 'register-forge', summary: `the plane's ${ANY_FORGE_NAME} connection is registered, so seats can be owned`}),
    Object.freeze({id: 'served-plane',     kind: STEP_KINDS.observation, observer: 'servedPlane',  summary: 'the served plane identity and data root match the target'}),
    Object.freeze({id: 'validation',       kind: STEP_KINDS.observation, observer: 'validation',   summary: 'one fresh provider call and one fresh embedding with the configuration the run supplied, at the preset dimension — never read from a receipt'}),
    Object.freeze({id: 'verify',           kind: STEP_KINDS.effect,      observer: 'verification', effectId: 'verify',        gates: Object.freeze(['served-plane', 'validation']), summary: 'the first-run witness: one memory written through the served plane under this run, read back and recalled through its embedding lane'}),
    Object.freeze({id: 'done',             kind: STEP_KINDS.observation, observer: 'done',         terminal: true, summary: 'this run\'s witness was persisted and recalled, and the served plane and validation are fresh and ok in the same evaluation'})
]);

const GIB_TEXT = bytes => `${(bytes / GiB).toFixed(1)} GiB`;

/**
 * @summary The headroom rule over the probe and the preset table: which presets to recommend, which to
 * show as possible with their margins, which the probe refused and why. Pure.
 * @param {Object} options
 * @param {Object}   options.probe   A `probePlacement()` result.
 * @param {Object[]} options.presets The preset table (`placementPresets.presets`).
 * @param {Number}   [options.headroomBytes=HEADROOM_BYTES]
 * @returns {{recommended: Object[], possible: Object[], unverified: Object[], refused: Object[], headroomBytes: Number}}
 *   each entry `{id, kind, margins, reason, cause, nextStep}`; `unverified` holds the presets whose verdict the
 *   host did not answer (`kind: 'unverified'` — the preset's fit on the observed facts, with the missing reader's
 *   cause and next step), `refused` only the observed refusals.
 */
export function recommendPlacement({probe, presets, headroomBytes = HEADROOM_BYTES}) {
    const result = {recommended: [], possible: [], unverified: [], refused: [], headroomBytes};

    for (const preset of presets) {
        const
            fit = fitsPreset(probe, preset.workload),
            row = {
                id      : preset.id,
                kind    : fit?.kind ?? 'observed',
                margins : fit?.margins ?? {host: null, guest: null},
                reason  : null,
                cause   : fit?.cause ?? null,
                nextStep: fit?.nextStep ?? null
            };

        if (!fit?.fits) {
            row.reason = (fit?.reasons ?? ['no workload declared']).join('; ');
            // a verdict the host did not answer is unverified, never a refusal: the preset's fit on the
            // observed facts stands as a recommendation the reader can act on, with its cause and next step
            result[row.kind === 'unverified' ? 'unverified' : 'refused'].push(row);
            continue;
        }

        if (presetStatus(preset) !== 'supported') {
            row.reason = 'no recorded quality floor: a candidate, never recommended by default';
            result.possible.push(row);
            continue;
        }

        const guestOk = fit.margins.guest === null || fit.margins.guest >= 0;

        if (fit.margins.host >= headroomBytes && guestOk) {
            row.reason = `fits with ${GIB_TEXT(fit.margins.host)} host margin (headroom ${GIB_TEXT(headroomBytes)})`;
            result.recommended.push(row);
        } else {
            row.reason = `fits by ${GIB_TEXT(fit.margins.host)} on the host, under the ${GIB_TEXT(headroomBytes)} headroom: possible, not recommended`;
            result.possible.push(row);
        }
    }

    return result;
}

/**
 * @summary One observer read, never thrown: a missing or failing observer is an `unknown` reason. The
 * observer sees the target and, under a bound binding only, the record — prior consent is the record's
 * authority, and a reader that needs a consented reference (the plane credential file, the preset) takes it
 * from there; another target's record hands out nothing.
 * @param {Object} observers
 * @param {String} name
 * @param {Object} target
 * @param {{record: Object|null}} context
 * @returns {Promise<{ok: Boolean, reason: String|null, value: *}>}
 */
async function observe(observers, name, target, context) {
    const observer = observers?.[name];

    if (typeof observer !== 'function') {
        return {ok: false, reason: `no '${name}' observer`, value: null};
    }

    try {
        return {ok: true, reason: null, value: await observer(target, context)};
    } catch (error) {
        return {ok: false, reason: error?.message ?? String(error), value: null};
    }
}

function status(step, state, reason, extra = {}) {
    return {id: step.id, kind: step.kind, status: state, reason, summary: step.summary, ...extra};
}

function evaluateQuestion(step, {record, bound, bindingReason, presets}) {
    const consent = bound ? findConsent(record, step.id) : null;

    if (consent) {
        return status(step, STEP_STATUSES.ok, 'consented', {answer: consent.answer, consentedAt: consent.consentedAt});
    }

    if (step.optional) {
        return status(step, STEP_STATUSES.ok, 'folded: defaults apply', {answer: null});
    }

    if (step.requiredBy) {
        // a question the consented preset decides: asked only when that preset requires the input
        const
            chosen = bound ? findConsent(record, 'preset') : null,
            preset = chosen ? presets.find(row => row.id === chosen.answer) : null;

        if (!preset) {
            // pending, and not yet a question to answer: the row waits for the preset, as data
            return status(step, STEP_STATUSES.pending, 'decided by the preset: none consented yet', {answer: null, waitsFor: 'preset'});
        }

        if (!(preset.requires ?? []).includes(step.requiredBy)) {
            return status(step, STEP_STATUSES.ok, `not needed: the '${preset.id}' preset requires no ${step.requiredBy}`, {answer: null});
        }
    }

    return status(step, STEP_STATUSES.pending, bound ? 'unanswered' : `unanswered (${bindingReason})`, {answer: null});
}

async function evaluateEffect(step, {record, bound, observers, target, context, observedAt}) {
    const
        receipt = bound ? findReceipt(record, step.effectId) : null,
        read    = await observe(observers, step.observer, target, context),
        extra   = {effectId: step.effectId, receipt: receipt ? receipt.outcome : null, observedAt};

    if (receipt?.outcome === RECEIPT_OUTCOMES.pending && receipt.resumable) {
        // a multi-step effect that says what landed and what has not: pending, not interrupted — a re-check
        // resumes its read-only remainder (the witness effect's receipts name the sub-step)
        return status(step, STEP_STATUSES.pending, receipt.reason ?? 'performed in part; a re-check resumes it', {...extra, observed: read.ok ? read.value : null});
    }

    if (receipt && [RECEIPT_OUTCOMES.pending, RECEIPT_OUTCOMES.reconcileRequired].includes(receipt.outcome)) {
        // the observed result rides along so a renderer can settle the receipt once the served plane matches
        return status(step, STEP_STATUSES.reconcileRequired, receipt.reason && receipt.outcome === RECEIPT_OUTCOMES.reconcileRequired ? receipt.reason : 'the effect may have run before its receipt was written; a fresh matching observation settles it', {...extra, observed: read.ok ? read.value : null});
    }

    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, extra);
    }

    const observed = read.value ?? {};

    if (observed.present !== true) {
        if (receipt?.outcome === RECEIPT_OUTCOMES.accepted) {
            return status(step, STEP_STATUSES.failed, 'the accepted effect\'s result is gone from the host', extra);
        }

        if (receipt?.outcome === RECEIPT_OUTCOMES.failed) {
            // the last attempt failed and left no result: the row says why, and a run tries it again
            return status(step, STEP_STATUSES.failed, receipt.reason ?? 'the last attempt failed', extra);
        }

        return status(step, STEP_STATUSES.pending, observed.reason ?? 'not performed', extra);
    }

    if (observed.problem) {
        return status(step, STEP_STATUSES.failed, observed.problem, extra);
    }

    if (receipt?.outcome === RECEIPT_OUTCOMES.accepted && receipt.digest && observed.digest && receipt.digest !== observed.digest) {
        return status(step, STEP_STATUSES.failed, 'the host content changed after the effect was accepted', extra);
    }

    return status(step, STEP_STATUSES.ok, receipt?.outcome === RECEIPT_OUTCOMES.accepted ? 'observed; matches the accepted receipt' : 'observed; not performed by this run', extra);
}

/**
 * @summary The step an effect row waits for: the first one before it that is not `ok` and stands in its
 * way — a question, an effect, or an observation the step declares as a gate. `null` when it can run.
 * @param {Object}   step
 * @param {Object[]} steps The steps evaluated so far.
 * @returns {String|null}
 */
function waitOf(step, steps) {
    return steps.find(row => row.status !== STEP_STATUSES.ok && (row.kind !== STEP_KINDS.observation || step.gates?.includes(row.id)))?.id ?? null;
}

function evaluatePlacement(step, read, presets, observedAt) {
    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, {observedAt});
    }

    const placement = recommendPlacement({probe: read.value, presets});

    if (placement.recommended.length > 0) {
        return status(step, STEP_STATUSES.ok, `recommended: ${placement.recommended.map(row => row.id).join(', ')}`, {placement, observedAt});
    }

    if (placement.possible.length > 0) {
        // nothing recommended is not one cause: a possible preset may lack a floor or the headroom, a
        // refused one names its shortfall — each row's own reason is the step's reason
        const named = rows => rows.map(row => `${row.id} (${row.reason})`).join(', ');

        return status(step, STEP_STATUSES.ok, `nothing recommended; possible: ${named(placement.possible)}${placement.refused.length > 0 ? `; refused: ${named(placement.refused)}` : ''}`, {placement, observedAt});
    }

    if (placement.unverified.length > 0) {
        // the host did not answer every reader: the door continues on an unverified recommendation
        // that names what was not read and the one thing to do — never a dead end, never a fit
        const lead = placement.unverified[0];

        return status(step, STEP_STATUSES.ok, `unverified: ${placement.unverified.map(row => row.id).join(', ')} (${lead.cause}; next: ${lead.nextStep})`, {placement, observedAt, verdict: 'unverified'});
    }

    return status(step, STEP_STATUSES.failed, 'no supported preset fits this host', {placement, observedAt});
}

function evaluateServedPlane(step, read, target, observedAt) {
    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, {observedAt});
    }

    const served = read.value;

    if (!served || typeof served.id !== 'string') {
        return status(step, STEP_STATUSES.failed, 'the responder never identified itself: no plane block', {observedAt});
    }

    if (!target.planeId) {
        return status(step, STEP_STATUSES.pending, 'the run holds no target plane id yet', {served, observedAt});
    }

    if (served.id !== target.planeId) {
        return status(step, STEP_STATUSES.failed, `served plane id is '${served.id}', expected '${target.planeId}': a different plane is answering`, {served, observedAt});
    }

    if (target.dataRoot && served.dataRoot !== target.dataRoot) {
        return status(step, STEP_STATUSES.failed, `served plane dataRoot is '${served.dataRoot ?? '<missing>'}', expected '${target.dataRoot}': same identity, different storage`, {served, observedAt});
    }

    return status(step, STEP_STATUSES.ok, served.status === 'degraded' ? 'the served identity matches the target; the plane reports itself degraded' : 'the served identity matches the target', {served, observedAt});
}

function evaluateValidation(step, read, {record, bound, presets, observedAt}) {
    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, {observedAt});
    }

    const
        consent = bound ? findConsent(record, 'preset') : null,
        preset  = consent ? presets.find(row => row.id === consent.answer) : null,
        value   = read.value ?? {};

    if (value.provider?.ok !== true) {
        return status(step, STEP_STATUSES.failed, value.provider?.reason ?? 'the provider call did not answer', {observedAt});
    }

    if (value.embedding?.ok !== true) {
        return status(step, STEP_STATUSES.failed, value.embedding?.reason ?? 'no embedding was observed', {observedAt});
    }

    if (!preset) {
        // an attached plane's dimension is what it is: reported, compared with nothing
        return status(step, STEP_STATUSES.ok, `provider answered; embedding observed at ${value.embedding.dimension} dimensions (no preset consented to compare)`, {observedAt});
    }

    if (value.embedding.dimension !== preset.vectorDimension) {
        return status(step, STEP_STATUSES.failed, `the observed embedding has ${value.embedding.dimension} dimensions, the '${preset.id}' preset declares ${preset.vectorDimension}`, {observedAt});
    }

    return status(step, STEP_STATUSES.ok, `provider answered; embedding observed at ${preset.vectorDimension} dimensions`, {observedAt});
}

/**
 * @summary The fresh steps a historical reading may stand on: `served-plane` (and `validation`, for the
 * terminal step) must read `ok` in THIS evaluation. Names the first that does not, or `null`.
 * @param {Object[]} steps The steps evaluated so far.
 * @param {String[]} ids
 * @returns {String|null} `'<id> is <status>'`
 */
function staleGate(steps, ids) {
    for (const id of ids) {
        const step = steps.find(row => row.id === id);

        if (step?.status !== STEP_STATUSES.ok) {
            return {status: step?.status ?? STEP_STATUSES.unknown, reason: `${id} is ${step?.status ?? 'not evaluated'}`};
        }

        // a matching plane that reports itself `degraded` is identified, not ready (bootstrap-record decision
        // §2.5): the identity step stays ok, the steps that need a ready plane wait
        if (id === 'served-plane' && step.served?.status === 'degraded') {
            return {status: STEP_STATUSES.pending, reason: 'served-plane is degraded'};
        }
    }

    return null;
}

function evaluateDone(step, read, {steps, observedAt}) {
    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, {observedAt});
    }

    const
        value = read.value ?? {},
        at    = value.at ? `witnessed at ${value.at}` : 'witnessed';

    // a recorded refusal is a fresh negative; an outstanding sub-step (the write unacknowledged, the recall not
    // landed) keeps the run open — the verify row says what re-check repeats
    if (value.reason) {
        return status(step, STEP_STATUSES.failed, value.reason, {observedAt});
    }

    if (value.persisted !== true) {
        return status(step, STEP_STATUSES.pending, 'nothing persisted yet', {observedAt});
    }

    if (value.queryAnswered !== true) {
        return status(step, STEP_STATUSES.pending, `${at}; the witness was not recalled yet`, {observedAt, witnessedAt: value.at});
    }

    // the historical witness never completes a run on its own: completion is the witness AND the plane it
    // was written through still answering as the target, validated, in this evaluation
    const stale = staleGate(steps, ['served-plane', 'validation']);

    if (stale) {
        // the gate's own status is mirrored: a failed plane fails the run, an unanswered one keeps it open
        return status(step, stale.status, `${at}; ${stale.reason}`, {observedAt, witnessedAt: value.at});
    }

    return status(step, STEP_STATUSES.ok, `${at}; recalled through the served plane; served plane and validation fresh and ok`, {observedAt, witnessedAt: value.at});
}

/**
 * @summary Evaluates every step live for the target. The record contributes prior consent and receipts
 * only when it is bound to this target and recipe version; otherwise the binding is reported and the
 * record's entries contribute nothing (never inferred around).
 * @param {Object} options
 * @param {Object}      options.target  `{planeId, dataRoot, endpoint}` (nulls before create).
 * @param {Object|null} [options.record=null]
 * @param {Object}      [options.observers={}] Named readers, each `(target, {record}) → Promise<value>`; the record
 *     is handed over under a bound binding only, `null` otherwise.
 * @param {Object[]}    [options.presets=[]]
 * @param {Function}    [options.now=Date.now]
 * @returns {Promise<{recipeVersion: Number, target: Object, binding: String, steps: Object[], terminal: Object}>}
 */
export async function evaluateRecipe({target, record = null, observers = {}, presets = [], now = Date.now}) {
    const
        binding       = record ? describeBinding(record, {target, recipeVersion: RECIPE_VERSION}) : 'no-record',
        bound         = binding === 'bound',
        bindingReason = {
            'no-record'       : 'no record for this run',
            'target-mismatch' : 'the record is bound to another target',
            'version-mismatch': `the record was evaluated under recipe version ${record?.recipeVersion}`
        }[binding],
        context       = {record: bound ? record : null},
        observedAt    = new Date(now()).toISOString(),
        steps         = [];

    for (const step of RECIPE_STEPS) {
        if (step.kind === STEP_KINDS.question) {
            steps.push(evaluateQuestion(step, {record, bound, bindingReason, presets}));
            continue;
        }

        if (step.kind === STEP_KINDS.effect) {
            const row = await evaluateEffect(step, {record, bound, observers, target, context, observedAt});

            steps.push({
                ...row,
                waitsFor: row.status === STEP_STATUSES.ok ? null : waitOf(step, steps),
                ...(step.id === 'verify' ? verifyExits({receipt: bound ? findReceipt(record, step.effectId) : null, section: bound ? record.verification : null}) : {})
            });
            continue;
        }

        if (step.id === 'validation') {
            // a fresh observation, and only of the plane the run targets: behind a served-plane row that is
            // not ok in THIS evaluation nothing is asked — a wrong, stale or degraded plane is never validated
            const gate = staleGate(steps, ['served-plane']);

            if (gate) {
                steps.push(status(step, STEP_STATUSES.unknown, `not observed: ${gate.reason}`, {observedAt}));
                continue;
            }
        }

        const read = await observe(observers, step.observer, target, context);

        switch (step.id) {
            case 'placement':
                steps.push(evaluatePlacement(step, read, presets, observedAt));
                break;
            case 'served-plane':
                steps.push(evaluateServedPlane(step, read, target, observedAt));
                break;
            case 'validation':
                steps.push(evaluateValidation(step, read, {record, bound, presets, observedAt}));
                break;
            default:
                steps.push(evaluateDone(step, read, {steps, observedAt}));
        }
    }

    const terminal = steps.find(step => RECIPE_STEPS.find(row => row.id === step.id)?.terminal) ?? null;

    return {recipeVersion: RECIPE_VERSION, target, binding, bindingReason, steps, terminal};
}

/**
 * @summary The run's exit disposition from an evaluation: `1` when any step reads `failed` or
 * `reconcile-required` (a green terminal step does not outrank an unsettled effect), else `0` when the
 * terminal step reads `ok`, else `2` while steps are still pending or unknown.
 * @param {Object} evaluation From {@link evaluateRecipe}.
 * @returns {Number}
 */
export function exitCodeFor(evaluation) {
    if (evaluation.steps.some(step => [STEP_STATUSES.failed, STEP_STATUSES.reconcileRequired].includes(step.status))) {
        return 1;
    }

    return evaluation.terminal?.status === STEP_STATUSES.ok ? 0 : 2;
}
