/**
 * @module ai/services/fleet/setupRunRecord
 * @summary The first-run bootstrap record (bootstrap-record decision§2.1–2.4, §2.7): one durable, secret-free file per
 * run under the host's Agent OS state root, holding the run's target, the recipe version it was
 * evaluated under, the consents the operator gave and the receipts of the host effects performed.
 *
 * The record answers exactly two questions — *what did the operator consent to* and *which effects were
 * accepted* — and never a third: no step's status lives here. A receipt is provenance and a replay guard;
 * readiness is a fresh observation by the owner that already observes it (`firstRunRecipe`). This module
 * is pure: it creates, reads, binds and retires records. The one writer is the host-effect module
 * (`hostEffects.mjs`, bootstrap-record decision§2.2); the CLI and the vessel's main process reach the file through it.
 *
 * Secret-free by construction: a receipt carries the digest of what was applied and the paths it was
 * applied to; a consent carries an answer or a reference (a secret file's path), never a value that is
 * itself a secret. No slot in the shape can hold a PAT, a provider key or a bearer.
 */

import {createHash} from 'node:crypto';
import path         from 'node:path';

/**
 * The record's schema version — bumped on any shape change; a reader meeting another version reports the
 * mismatch and infers nothing (bootstrap-record decision§2.3).
 * @type {Number}
 */
export const SETUP_RECORD_SCHEMA_VERSION = 1;

/**
 * The record type stamp, the same discipline as the deployment-prescription ledger's `recordType`.
 * @type {String}
 */
export const SETUP_RECORD_TYPE = 'first-run-setup-record';

/**
 * A receipt's finite outcomes. `pending` is written before a handler runs; `accepted` after it returned;
 * `reconcile-required` is what a resumed run finds where a `pending` receipt was left behind — never
 * replayed, settled only by a fresh matching observation (bootstrap-record decision§2.6); `failed` carries the handler's
 * named reason; `operator-action` is an effect the host cannot perform and the operator must.
 * @type {Object}
 */
export const RECEIPT_OUTCOMES = Object.freeze({
    pending          : 'pending',
    accepted         : 'accepted',
    reconcileRequired: 'reconcile-required',
    failed           : 'failed',
    operatorAction   : 'operator-action'
});

/**
 * Why current proof was retired into history (bootstrap-record decision§2.7).
 * @type {Object}
 */
export const RETIRE_REASONS = Object.freeze({
    targetChanged : 'target-changed',
    versionChanged: 'recipe-version-changed',
    operator      : 'operator'
});

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @summary The sha256 hex digest of a string — the receipt's provenance of applied content, never the
 * content itself.
 * @param {String} content
 * @returns {String}
 */
export function contentDigest(content) {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * @summary Normalizes a run target to the record's binding shape. `planeId` is the identity key, `dataRoot`
 * the corroborating evidence, `endpoint` a connection coordinate only (bootstrap-record decision§2.4); each `null` when
 * the run does not hold it yet (before create, the id is declared but nothing serves it).
 * @param {Object} [target={}]
 * @returns {{planeId: String|null, dataRoot: String|null, endpoint: String|null}}
 */
export function normalizeTarget(target = {}) {
    const text = value => typeof value === 'string' && value.length > 0 ? value : null;

    return {
        planeId : text(target.planeId),
        dataRoot: text(target.dataRoot),
        endpoint: text(target.endpoint)
    };
}

/**
 * @summary The target a resumed invocation evaluates against: each field the invocation names, and each
 * it omits filled from the record's bound target. A record holding a corroborating root keeps that
 * expectation when the resume names only the identity — the root is never optional where the run holds
 * one (bootstrap-record decision§2.4). A field the invocation does name is compared by {@link describeBinding},
 * never replaced.
 * @param {Object} record
 * @param {Object} [invocation={}]
 * @returns {{planeId: String|null, dataRoot: String|null, endpoint: String|null}}
 */
export function resumeTarget(record, invocation = {}) {
    const named = normalizeTarget(invocation), bound = normalizeTarget(record?.target);

    // another identity names a new target: nothing of the old binding carries over
    if (named.planeId !== null && named.planeId !== bound.planeId) {
        return named;
    }

    return {
        planeId : named.planeId  ?? bound.planeId,
        dataRoot: named.dataRoot ?? bound.dataRoot,
        endpoint: named.endpoint ?? bound.endpoint
    };
}

/**
 * @summary A fresh record for one run.
 * @param {Object} options
 * @param {String} options.runId         A UUID; the CLI mints it, a resume passes the existing one.
 * @param {Object} options.target        See {@link normalizeTarget}.
 * @param {Number} options.recipeVersion The recipe version the run is evaluated under.
 * @param {Function} [options.now=Date.now]
 * @returns {Object}
 */
export function createSetupRecord({runId, target, recipeVersion, now = Date.now}) {
    if (!RUN_ID_PATTERN.test(runId ?? '')) {
        throw new Error('createSetupRecord: runId must be a UUID.');
    }

    if (!Number.isInteger(recipeVersion) || recipeVersion < 1) {
        throw new Error('createSetupRecord: recipeVersion must be a positive integer.');
    }

    return {
        schemaVersion: SETUP_RECORD_SCHEMA_VERSION,
        recordType   : SETUP_RECORD_TYPE,
        runId,
        createdAt    : new Date(now()).toISOString(),
        recipeVersion,
        target       : normalizeTarget(target),
        consents     : [],
        receipts     : [],
        history      : []
    };
}

/**
 * @summary The record file's path for a run under the setup root.
 * @param {String} setupRoot The host state root's setup folder (`~/.neo-ai/setup` by default — the CLI resolves it).
 * @param {String} runId
 * @returns {String}
 */
export function setupRecordPath(setupRoot, runId) {
    if (typeof setupRoot !== 'string' || !path.isAbsolute(setupRoot)) {
        throw new Error('setupRecordPath: setupRoot must be an absolute path.');
    }

    if (!RUN_ID_PATTERN.test(runId ?? '')) {
        throw new Error('setupRecordPath: runId must be a UUID.');
    }

    return path.join(setupRoot, `${runId}.json`);
}

/**
 * @summary Validates a parsed record's shape and version. Returns the named problem, or `null`.
 * @param {*} record
 * @returns {String|null}
 */
export function describeRecordProblem(record) {
    if (!isObject(record)) {
        return 'not an object';
    }

    if (record.recordType !== SETUP_RECORD_TYPE) {
        return `recordType '${record.recordType ?? 'missing'}' is not '${SETUP_RECORD_TYPE}'`;
    }

    if (record.schemaVersion !== SETUP_RECORD_SCHEMA_VERSION) {
        return `schemaVersion ${record.schemaVersion ?? 'missing'} is not ${SETUP_RECORD_SCHEMA_VERSION}`;
    }

    if (!RUN_ID_PATTERN.test(record.runId ?? '')) {
        return 'runId is not a UUID';
    }

    if (!Number.isInteger(record.recipeVersion) || record.recipeVersion < 1) {
        return 'recipeVersion is not a positive integer';
    }

    if (!isObject(record.target) || !['consents', 'receipts', 'history'].every(key => Array.isArray(record[key]))) {
        return 'target, consents, receipts or history is missing';
    }

    return null;
}

/**
 * @summary Reads a record file. An absent file is a fresh run; an unreadable or malformed file is reported
 * by name, and its caller refuses to run over it — a receipt it cannot read may guard an effect that ran.
 * @param {String} filePath
 * @param {Object} [options]
 * @param {Object} [options.fsModule] `node:fs/promises`-shaped; injected by the host.
 * @returns {Promise<{record: Object|null, problem: String|null}>}
 */
export async function readSetupRecord(filePath, {fsModule} = {}) {
    let text;

    try {
        text = await fsModule.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return {record: null, problem: null};
        }

        return {record: null, problem: `unreadable: ${error?.message ?? error}`};
    }

    let parsed;

    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return {record: null, problem: `malformed: ${error.message}`};
    }

    const problem = describeRecordProblem(parsed);

    return problem ? {record: null, problem: `malformed: ${problem}`} : {record: parsed, problem: null};
}

/**
 * @summary The record's serialized form — the only text the writer puts on disk.
 * @param {Object} record
 * @returns {String}
 */
export function serializeSetupRecord(record) {
    return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * @summary Whether the record's binding is the run's: same identity key, same corroborating root where the
 * run holds one, same recipe version. Consents and receipts are current proof only under a bound record
 * (bootstrap-record decision§2.4, §2.7); `target-mismatch` and `version-mismatch` are shown, never inferred around.
 * @param {Object} record
 * @param {Object} options
 * @param {Object} options.target
 * @param {Number} options.recipeVersion
 * @returns {'bound'|'target-mismatch'|'version-mismatch'}
 */
export function describeBinding(record, {target, recipeVersion}) {
    const
        bound    = normalizeTarget(record.target),
        expected = normalizeTarget(target);

    if (record.recipeVersion !== recipeVersion) {
        return 'version-mismatch';
    }

    if (bound.planeId !== expected.planeId) {
        return 'target-mismatch';
    }

    // the root never keys and is never optional where the run holds an expectation: a bound root the
    // record disagrees with is "same identity, different storage" (bootstrap-record decision§2.4)
    if (expected.dataRoot !== null && bound.dataRoot !== null && bound.dataRoot !== expected.dataRoot) {
        return 'target-mismatch';
    }

    return 'bound';
}

/**
 * @summary A new record for the same run whose current consents and receipts are retired into history with
 * the named reason, rebound to the new target and version. The retired entries stay readable; nothing is
 * deleted (bootstrap-record decision§2.7).
 * @param {Object} record
 * @param {Object} options
 * @param {Object} options.target
 * @param {Number} options.recipeVersion
 * @param {String} options.reason One of {@link RETIRE_REASONS}.
 * @param {Function} [options.now=Date.now]
 * @returns {Object} A fresh record object; the input is not mutated.
 */
export function retireCurrentProof(record, {target, recipeVersion, reason, now = Date.now}) {
    if (!Object.values(RETIRE_REASONS).includes(reason)) {
        throw new Error(`retireCurrentProof: unknown reason '${reason}'.`);
    }

    const retiredAt = new Date(now()).toISOString();

    return {
        ...record,
        recipeVersion,
        target  : normalizeTarget(target),
        consents: [],
        receipts: [],
        history : [
            ...record.history,
            {
                retiredAt,
                reason,
                recipeVersion: record.recipeVersion,
                target       : normalizeTarget(record.target),
                consents     : record.consents,
                receipts     : record.receipts
            }
        ]
    };
}

/**
 * @summary The current receipt for an effect, or `null`.
 * @param {Object} record
 * @param {String} effectId
 * @returns {Object|null}
 */
export function findReceipt(record, effectId) {
    return record.receipts.find(receipt => receipt.effectId === effectId) ?? null;
}

/**
 * @summary The current consent for a question step, or `null`.
 * @param {Object} record
 * @param {String} stepId
 * @returns {Object|null}
 */
export function findConsent(record, stepId) {
    return record.consents.find(consent => consent.stepId === stepId) ?? null;
}

/**
 * @summary A new record with one receipt replaced or appended — the pure half of every receipt write.
 * @param {Object} record
 * @param {Object} receipt `{effectId, outcome, …}`
 * @returns {Object}
 */
export function withReceipt(record, receipt) {
    if (!Object.values(RECEIPT_OUTCOMES).includes(receipt?.outcome)) {
        throw new Error(`withReceipt: unknown outcome '${receipt?.outcome}'.`);
    }

    const others = record.receipts.filter(existing => existing.effectId !== receipt.effectId);

    return {...record, receipts: [...others, receipt]};
}

/**
 * @summary A new record with one consent replaced or appended.
 * @param {Object} record
 * @param {Object} consent `{stepId, answer, consentedAt}` — `answer` is a choice or a reference, never a secret value.
 * @returns {Object}
 */
export function withConsent(record, consent) {
    if (typeof consent?.stepId !== 'string' || consent.stepId.length === 0) {
        throw new Error('withConsent: consent.stepId is required.');
    }

    const others = record.consents.filter(existing => existing.stepId !== consent.stepId);

    return {...record, consents: [...others, consent]};
}
