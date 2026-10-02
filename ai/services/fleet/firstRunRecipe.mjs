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
 * The placement step adds the one judgement the probe and the preset table do not make — a named
 * headroom: a preset is recommended only when the host margin clears `HEADROOM_BYTES` and the guest
 * margin is non-negative; a bare fit is *possible, not recommended*; a `candidate` preset (no recorded
 * floor) is never recommended by default.
 */

import {GiB, fitsPreset}                           from './probePlacement.mjs';
import {presetStatus}                              from './placementPresets.mjs';
import {RECEIPT_OUTCOMES, describeBinding, findConsent, findReceipt} from './setupRunRecord.mjs';

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
 * @type {Object[]}
 */
export const RECIPE_STEPS = Object.freeze([
    Object.freeze({id: 'placement',        kind: STEP_KINDS.observation, observer: 'placement',    summary: 'the presets this host bears, each with its reason'}),
    Object.freeze({id: 'preset',           kind: STEP_KINDS.question,                              summary: 'the inference preset'}),
    Object.freeze({id: 'plane-credential', kind: STEP_KINDS.question,    answer: 'file',           summary: 'the plane credential, kept as a secret file (the record holds its path)'}),
    Object.freeze({id: 'provider-key',     kind: STEP_KINDS.question,    answer: 'file', requiredBy: 'providerKey', summary: 'the provider key file, when the consented preset requires one (the record holds its path)'}),
    Object.freeze({id: 'advanced',         kind: STEP_KINDS.question,    optional: true,           summary: 'advanced bindings, folded by default'}),
    Object.freeze({id: 'write-env',        kind: STEP_KINDS.effect,      observer: 'envCarrier',   effectId: 'write-env',     summary: 'the plane env carrier holds the preset and the plane bindings'}),
    Object.freeze({id: 'write-secrets',    kind: STEP_KINDS.effect,      observer: 'secretFiles',  effectId: 'write-secrets', summary: 'the secret files exist, owner-only'}),
    Object.freeze({id: 'compose-up',       kind: STEP_KINDS.effect,      observer: 'runningPlane', effectId: 'compose-up',    summary: 'the compose project is running'}),
    Object.freeze({id: 'served-plane',     kind: STEP_KINDS.observation, observer: 'servedPlane',  summary: 'the served plane identity and data root match the target'}),
    Object.freeze({id: 'validation',       kind: STEP_KINDS.observation, observer: 'validation',   summary: 'one provider call and one observed embedding at the preset dimension'}),
    Object.freeze({id: 'done',             kind: STEP_KINDS.observation, observer: 'done',         terminal: true, summary: 'a query answered and the first persistence'})
]);

const GIB_TEXT = bytes => `${(bytes / GiB).toFixed(1)} GiB`;

/**
 * @summary The headroom rule over the probe and the preset table: which presets to recommend, which to
 * show as possible with their margins, which the probe refused and why. Pure.
 * @param {Object} options
 * @param {Object}   options.probe   A `probePlacement()` result.
 * @param {Object[]} options.presets The preset table (`placementPresets.presets`).
 * @param {Number}   [options.headroomBytes=HEADROOM_BYTES]
 * @returns {{recommended: Object[], possible: Object[], refused: Object[], headroomBytes: Number}} each entry `{id, margins, reason}`.
 */
export function recommendPlacement({probe, presets, headroomBytes = HEADROOM_BYTES}) {
    const result = {recommended: [], possible: [], refused: [], headroomBytes};

    for (const preset of presets) {
        const
            fit  = fitsPreset(probe, preset.workload),
            row  = {id: preset.id, margins: fit?.margins ?? {host: null, guest: null}, reason: null};

        if (!fit?.fits) {
            row.reason = (fit?.reasons ?? ['no workload declared']).join('; ');
            result.refused.push(row);
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

async function observe(observers, name, target) {
    const observer = observers?.[name];

    if (typeof observer !== 'function') {
        return {ok: false, reason: `no '${name}' observer`, value: null};
    }

    try {
        return {ok: true, reason: null, value: await observer(target)};
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
            return status(step, STEP_STATUSES.pending, 'decided by the preset: none consented yet', {answer: null});
        }

        if (!(preset.requires ?? []).includes(step.requiredBy)) {
            return status(step, STEP_STATUSES.ok, `not needed: the '${preset.id}' preset requires no ${step.requiredBy}`, {answer: null});
        }
    }

    return status(step, STEP_STATUSES.pending, bound ? 'unanswered' : `unanswered (${bindingReason})`, {answer: null});
}

async function evaluateEffect(step, {record, bound, observers, target, observedAt}) {
    const
        receipt = bound ? findReceipt(record, step.effectId) : null,
        read    = await observe(observers, step.observer, target),
        extra   = {effectId: step.effectId, receipt: receipt ? receipt.outcome : null, observedAt};

    if (receipt && [RECEIPT_OUTCOMES.pending, RECEIPT_OUTCOMES.reconcileRequired].includes(receipt.outcome)) {
        // the observed result rides along so a renderer can settle the receipt once the served plane matches
        return status(step, STEP_STATUSES.reconcileRequired, 'the effect may have run before its receipt was written; a fresh matching observation settles it', {...extra, observed: read.ok ? read.value : null});
    }

    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, extra);
    }

    const observed = read.value ?? {};

    if (observed.present !== true) {
        if (receipt?.outcome === RECEIPT_OUTCOMES.accepted) {
            return status(step, STEP_STATUSES.failed, 'the accepted effect\'s result is gone from the host', extra);
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

    return status(step, STEP_STATUSES.ok, 'the served identity matches the target', {served, observedAt});
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

function evaluateDone(step, read, observedAt) {
    if (!read.ok) {
        return status(step, STEP_STATUSES.unknown, read.reason, {observedAt});
    }

    const value = read.value ?? {};

    if (value.queryAnswered !== true) {
        return status(step, STEP_STATUSES.failed, value.reason ?? 'no query was answered', {observedAt});
    }

    if (value.persisted !== true) {
        return status(step, STEP_STATUSES.failed, value.reason ?? 'nothing persisted yet', {observedAt});
    }

    return status(step, STEP_STATUSES.ok, 'a query was answered and a first memory persisted', {observedAt});
}

/**
 * @summary Evaluates every step live for the target. The record contributes prior consent and receipts
 * only when it is bound to this target and recipe version; otherwise the binding is reported and the
 * record's entries contribute nothing (never inferred around).
 * @param {Object} options
 * @param {Object}      options.target  `{planeId, dataRoot, endpoint}` (nulls before create).
 * @param {Object|null} [options.record=null]
 * @param {Object}      [options.observers={}] Named readers, each `(target) → Promise<value>`.
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
        observedAt    = new Date(now()).toISOString(),
        steps         = [];

    for (const step of RECIPE_STEPS) {
        if (step.kind === STEP_KINDS.question) {
            steps.push(evaluateQuestion(step, {record, bound, bindingReason, presets}));
            continue;
        }

        if (step.kind === STEP_KINDS.effect) {
            steps.push(await evaluateEffect(step, {record, bound, observers, target, observedAt}));
            continue;
        }

        const read = await observe(observers, step.observer, target);

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
                steps.push(evaluateDone(step, read, observedAt));
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
