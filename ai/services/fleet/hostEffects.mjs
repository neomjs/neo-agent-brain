/**
 * @module ai/services/fleet/hostEffects
 * @summary The first run's host effects and the bootstrap record's one writer (bootstrap-record decision§2.2, §2.6).
 * Every effect names an executable local handler — the plane env carrier, the secret files (mode 0600),
 * `docker compose up` — or an explicit operator action; nothing is skipped silently. `applyEffect` writes
 * a `pending` receipt before a handler runs and an `accepted` one after it returned, so a run interrupted
 * in between leaves exactly the trace a resume must not replay: it becomes `reconcile-required` and is
 * settled only by a fresh matching observation (`settleReceipt`), never by running the handler again.
 *
 * The CLI (`ai/scripts/setup/firstRun.mjs`) and the vessel's main process call this module; the cockpit
 * page projects the record and never writes it. Everything the host offers — the filesystem, the command
 * runner, the clock — is injected through `createHost`, so every arm runs against a fake host.
 */

import {execFile}        from 'node:child_process';
import fsPromises        from 'node:fs/promises';
import net               from 'node:net';
import path              from 'node:path';
import {promisify}       from 'node:util';
import {writeFileAtomic} from '../shared/atomicFileWrite.mjs';
import {
    RECEIPT_OUTCOMES,
    contentDigest,
    findReceipt,
    serializeSetupRecord,
    withConsent,
    withReceipt,
    withVerification
} from './setupRunRecord.mjs';

const execFileAsync = promisify(execFile);

/**
 * The v1 effects, in recipe order. `verify` has no handler here: it is performed through the served plane
 * by `verifyEffect.mjs`, which persists its sub-step receipts through {@link recordVerification}.
 * @type {Object}
 */
export const EFFECT_IDS = Object.freeze({
    writeEnv    : 'write-env',
    writeSecrets: 'write-secrets',
    composeUp   : 'compose-up',
    verify      : 'verify'
});

/**
 * Owner-only: the mode of every file this module writes — the env carrier holds tokens, the secret files
 * are tokens.
 * @type {Number}
 */
export const SECRET_FILE_MODE = 0o600;

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * @summary Renders env entries as the carrier's `KEY=value` lines, sorted by key. Keys must be env names;
 * a value with a line break is refused (it would become a second assignment).
 * @param {Object} entries
 * @returns {String}
 */
export function renderEnvFile(entries) {
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
        throw new Error('renderEnvFile: entries must be an object of env names to values.');
    }

    return Object.keys(entries).sort().map(key => {
        const value = entries[key];

        if (!ENV_KEY_PATTERN.test(key)) {
            throw new Error(`renderEnvFile: '${key}' is not an env name.`);
        }

        if (typeof value !== 'string' || /[\r\n]/.test(value)) {
            throw new Error(`renderEnvFile: the value of '${key}' must be a single-line string.`);
        }

        return `${key}=${value}\n`;
    }).join('');
}

/**
 * @summary The identity of one application of an effect: the digest of its full input. The same effect
 * applied again with the same input is a resume and never re-runs; a different input is a new application.
 * @param {*} input
 * @returns {String}
 */
export function effectInputDigest(input) {
    return contentDigest(JSON.stringify(input ?? null));
}

/**
 * @summary The key of an effect's input: what a receipt records as the input it speaks for, and what the
 * run's current consents are compared against. An effect whose input holds a value that differs on every
 * composition (a minted token) declares `key(input)` over what the consents decide; every other effect is
 * keyed by its whole input.
 * @param {String} effectId
 * @param {*}      input
 * @param {Object} [effects=hostEffectHandlers]
 * @returns {String}
 */
export function effectInputKey(effectId, input, effects = hostEffectHandlers) {
    return effects[effectId]?.key ? effects[effectId].key(input) : effectInputDigest(input);
}

async function writeOwnerOnly(filePath, content, host) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new Error(`hostEffects: '${filePath}' is not an absolute path.`);
    }

    await host.fsModule.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
    await writeFileAtomic(filePath, content, {mode: SECRET_FILE_MODE, fsModule: host.fsModule});

    return contentDigest(content);
}

/**
 * The v1 handlers. Each is `{id, describe(input), handler(input, host) | null}`; a `null` handler is an
 * operator action by construction (`applyEffect` records the instruction and touches nothing). An effect
 * whose result is one file its input fully determines also declares `expects(input)`: the digest of the
 * content its handler writes, so an interrupted application can be matched against what the host shows.
 * @type {Object}
 */
export const hostEffectHandlers = Object.freeze({
    [EFFECT_IDS.writeEnv]: Object.freeze({
        id      : EFFECT_IDS.writeEnv,
        describe: input => `write the plane's env carrier at ${input?.path}`,
        expects : input => contentDigest(renderEnvFile(input?.entries)),
        /**
         * @param {Object} input `{path, entries}` — the carrier path and the preset's env set plus the plane's own bindings.
         * @param {Object} host
         * @returns {Promise<{digest: String, references: String[]}>}
         */
        async handler(input, host) {
            const digest = await writeOwnerOnly(input.path, renderEnvFile(input.entries), host);

            return {digest, references: [input.path]};
        }
    }),
    [EFFECT_IDS.writeSecrets]: Object.freeze({
        id      : EFFECT_IDS.writeSecrets,
        describe: input => `write ${Array.isArray(input?.files) ? input.files.length : 0} secret file(s), owner-only`,
        // the set, not its contents: the plane bearer is minted per composition
        key     : input => effectInputDigest((input?.files ?? []).map(file => file?.path).sort()),
        /**
         * @param {Object} input `{files: [{path, content}]}`
         * @param {Object} host
         * @returns {Promise<{digest: String, references: String[]}>}
         */
        async handler(input, host) {
            if (!Array.isArray(input?.files) || input.files.length === 0) {
                throw new Error('write-secrets: input.files must name at least one file.');
            }

            const digests = [];

            for (const file of input.files) {
                if (typeof file?.content !== 'string' || file.content.length === 0) {
                    throw new Error(`write-secrets: '${file?.path}' has no content.`);
                }

                digests.push(await writeOwnerOnly(file.path, file.content, host));
            }

            return {digest: contentDigest(digests.join('\n')), references: input.files.map(file => file.path)};
        }
    }),
    [EFFECT_IDS.composeUp]: Object.freeze({
        id      : EFFECT_IDS.composeUp,
        describe: input => `docker compose -p ${input?.project} up -d --wait`,
        /**
         * @param {Object} input `{project, cwd, envFile, composeFiles, carrier}` — the compose project, the checkout holding the compose files, the carrier, the files in order, and the key of the carrier it is composed from (part of the input's identity only).
         * @param {Object} host
         * @returns {Promise<{digest: String, references: String[]}>}
         */
        async handler(input, host) {
            const {project, cwd, envFile, composeFiles} = input ?? {};

            if (!project || !cwd || !envFile || !Array.isArray(composeFiles) || composeFiles.length === 0) {
                throw new Error('compose-up: input needs project, cwd, envFile and composeFiles.');
            }

            const args = ['compose', '-p', project, '--env-file', envFile, ...composeFiles.flatMap(file => ['-f', file]), 'up', '-d', '--wait'];

            await host.run('docker', args, {cwd});

            return {digest: contentDigest(args.join(' ')), references: [`compose:${project}`]};
        }
    })
});

/**
 * @summary The host the effects run against. Production defaults; a spec injects a fake filesystem, a
 * recording command runner and a fixed clock.
 * @param {Object} [options]
 * @param {Object}   [options.fsModule=node:fs/promises]
 * @param {Function} [options.run] `(command, args, {cwd}) → Promise<{stdout, stderr}>`
 * @param {Function} [options.now=Date.now]
 * @returns {{fsModule: Object, run: Function, now: Function}}
 */
export function createHost({fsModule = fsPromises, run = (command, args, options) => execFileAsync(command, args, {...options, encoding: 'utf8'}), now = Date.now} = {}) {
    return {fsModule, run, now};
}

/**
 * @summary The record's one writer: owner-only, atomic, under the setup root.
 * @param {String} recordPath
 * @param {Object} record
 * @param {Object} host
 * @returns {Promise<void>}
 */
export async function persistSetupRecord(recordPath, record, host) {
    await writeOwnerOnly(recordPath, serializeSetupRecord(record), host);
}

/**
 * @summary Applies one effect under the replay guard. Returns the receipt the record now holds and the
 * record itself (a fresh object; the input record is never mutated):
 *
 * - an `accepted` receipt for the same input is returned as is — the effect never re-runs on a resume;
 * - a `pending` receipt (a run that was interrupted between the handler and its receipt) becomes
 *   `reconcile-required`; the handler is NOT called; `settleReceipt` is the only way forward;
 * - a `reconcile-required` receipt stays so, untouched;
 * - a `failed` receipt, or an `accepted` one for a different input, is a new application;
 * - an effect without a handler records an `operator-action` receipt with the instruction and touches nothing.
 *
 * Every receipt written here records `inputKey` ({@link effectInputKey}): the input it speaks for. The
 * recipe holds an accepted receipt against the key the consents render now; a receipt from before the
 * key existed carries none and is not compared.
 * @param {Object} options
 * @param {String} options.effectId
 * @param {*}      options.input
 * @param {Object} options.record
 * @param {String} options.recordPath
 * @param {Object} options.host From {@link createHost}.
 * @param {Object} [options.effects=hostEffectHandlers]
 * @returns {Promise<{record: Object, receipt: Object, applied: Boolean}>} `applied` is true only when the handler ran now.
 */
export async function applyEffect({effectId, input, record, recordPath, host, effects = hostEffectHandlers}) {
    const effect = effects[effectId];

    if (!effect) {
        throw new Error(`applyEffect: unknown effect '${effectId}'.`);
    }

    const
        inputDigest = effectInputDigest(input),
        inputKey    = effectInputKey(effectId, input, effects),
        existing    = findReceipt(record, effectId),
        stamp       = () => new Date(host.now()).toISOString();

    if (existing) {
        if (existing.outcome === RECEIPT_OUTCOMES.accepted && existing.inputDigest === inputDigest) {
            return {record, receipt: existing, applied: false};
        }

        if (existing.outcome === RECEIPT_OUTCOMES.pending) {
            const receipt = reconcileRequiredReceipt(existing, host), next = withReceipt(record, receipt);

            await persistSetupRecord(recordPath, next, host);

            return {record: next, receipt, applied: false};
        }

        if (existing.outcome === RECEIPT_OUTCOMES.reconcileRequired) {
            return {record, receipt: existing, applied: false};
        }
    }

    if (!effect.handler) {
        const receipt = {
            effectId,
            outcome    : RECEIPT_OUTCOMES.operatorAction,
            inputDigest,
            inputKey,
            recordedAt : stamp(),
            instruction: effect.describe(input)
        }, next = withReceipt(record, receipt);

        await persistSetupRecord(recordPath, next, host);

        return {record: next, receipt, applied: false};
    }

    let next = withReceipt(record, {effectId, outcome: RECEIPT_OUTCOMES.pending, inputDigest, inputKey, startedAt: stamp(), ...expectedContent(effect, input)});

    await persistSetupRecord(recordPath, next, host);

    let receipt;

    try {
        const result = await effect.handler(input, host);

        receipt = {
            effectId,
            outcome   : RECEIPT_OUTCOMES.accepted,
            inputDigest,
            inputKey,
            acceptedAt: stamp(),
            digest    : result.digest,
            references: result.references
        };
    } catch (error) {
        receipt = {effectId, outcome: RECEIPT_OUTCOMES.failed, inputDigest, inputKey, failedAt: stamp(), reason: error?.message ?? String(error)};
    }

    next = withReceipt(next, receipt);
    await persistSetupRecord(recordPath, next, host);

    return {record: next, receipt, applied: receipt.outcome === RECEIPT_OUTCOMES.accepted};
}

/**
 * @summary What a `pending` receipt records beside its input: the digest of the content the handler is
 * about to write, for an effect that declares it. An input the effect cannot render records nothing —
 * the handler then fails on the same input and the receipt says why.
 * @param {Object} effect
 * @param {*}      input
 * @returns {{expectedDigest: String}|{}}
 */
function expectedContent(effect, input) {
    try {
        return effect.expects ? {expectedDigest: effect.expects(input)} : {};
    } catch {
        return {};
    }
}

/**
 * @summary The receipt an interrupted effect carries from the moment a resume finds it `pending`: the
 * handler may have run before its receipt was written, so it is never run again — a fresh matching
 * observation settles it (bootstrap-record decision§3).
 * @param {Object} existing The `pending` receipt.
 * @param {Object} host
 * @returns {Object}
 */
function reconcileRequiredReceipt(existing, host) {
    return {
        ...existing,
        outcome            : RECEIPT_OUTCOMES.reconcileRequired,
        reconcileRequiredAt: new Date(host.now()).toISOString(),
        reason             : 'a pending receipt was found on resume: the effect may have run before its receipt was written; a fresh matching observation settles it'
    };
}

/**
 * @summary Settles an interrupted effect — a `pending` receipt found on resume, or one already marked
 * `reconcile-required` — with a fresh observation of its result for the bound target. Only an observation
 * that reads `ok` AND matches the target settles it to `accepted` (`settledBy: 'observation'`). Anything
 * else performs the one transition a resume owes and nothing more: a `pending` receipt becomes
 * `reconcile-required` (persisted; the handler never re-runs), a `reconcile-required` one stays as it is,
 * and the answer says why (bootstrap-record decision§2.6, §3).
 * @param {Object} options
 * @param {String} options.effectId
 * @param {Object} options.observation `{status, matchesTarget, observedAt, digest, reason}` from the step's observer.
 * @param {Object} options.record
 * @param {String} options.recordPath
 * @param {Object} options.host
 * @returns {Promise<{record: Object, receipt: Object, settled: Boolean, reason: String|null}>}
 */
export async function settleReceipt({effectId, observation, record, recordPath, host}) {
    const existing = findReceipt(record, effectId);

    if (!existing || ![RECEIPT_OUTCOMES.pending, RECEIPT_OUTCOMES.reconcileRequired].includes(existing.outcome)) {
        throw new Error(`settleReceipt: '${effectId}' holds no pending or reconcile-required receipt.`);
    }

    if (observation?.status !== 'ok' || observation.matchesTarget !== true) {
        const reason = observation?.reason ?? 'the observation did not read ok for the bound target';

        if (existing.outcome !== RECEIPT_OUTCOMES.pending) {
            return {record, receipt: existing, settled: false, reason};
        }

        const receipt = reconcileRequiredReceipt(existing, host), next = withReceipt(record, receipt);

        await persistSetupRecord(recordPath, next, host);

        return {record: next, receipt, settled: false, reason};
    }

    const receipt = {
        effectId,
        outcome    : RECEIPT_OUTCOMES.accepted,
        inputDigest: existing.inputDigest,
        ...(existing.inputKey ? {inputKey: existing.inputKey} : {}),
        acceptedAt : observation.observedAt ?? new Date(host.now()).toISOString(),
        settledBy  : 'observation',
        digest     : observation.digest ?? null,
        references : existing.references ?? []
    }, next = withReceipt(record, receipt);

    await persistSetupRecord(recordPath, next, host);

    return {record: next, receipt, settled: true, reason: null};
}

/**
 * @summary Writes the run's `verification` section and the `verify` receipt that summarizes it in ONE
 * write — the witness effect's sub-step receipts land as each is accepted, so an interruption keeps what
 * the plane already answered and a resume never writes the witness again (bootstrap-record decision §3).
 * Same writer, same file, same owner-only atomic path as every other receipt.
 * @param {Object} options
 * @param {Object} options.record
 * @param {String} options.recordPath
 * @param {Object} options.host From {@link createHost}.
 * @param {Object} options.verification The section as the effect holds it now.
 * @param {Object} options.receipt The `verify` receipt (`{effectId: 'verify', outcome, …}`).
 * @returns {Promise<{record: Object}>}
 */
export async function recordVerification({record, recordPath, host, verification, receipt}) {
    const next = withReceipt(withVerification(record, verification), receipt);

    await persistSetupRecord(recordPath, next, host);

    return {record: next};
}

/**
 * @summary Admits a credential REFERENCE before the record sees it: the answer must be the absolute path
 * of a regular file this process can read. A pasted token is not a path, so it is refused here and never
 * recorded, and the verdict repeats nothing of the input — a refusal names the rule, never the value.
 * @param {Object} options
 * @param {*}      options.answer
 * @param {Object} [options.fsModule=fsPromises]
 * @returns {Promise<{ok: Boolean, path: String|null, reason: String|null}>}
 */
export async function admitCredentialReference({answer, fsModule = fsPromises}) {
    const text = typeof answer === 'string' ? answer.trim() : '';

    if (!text || !path.isAbsolute(text)) {
        return {ok: false, path: null, reason: 'not the absolute path of a file; the value was not recorded'};
    }

    try {
        if (!(await fsModule.stat(text)).isFile()) {
            return {ok: false, path: null, reason: 'the path is not a regular file; the value was not recorded'};
        }

        await fsModule.access(text, fsPromises.constants.R_OK);
    } catch {
        return {ok: false, path: null, reason: 'no readable file at that path; the value was not recorded'};
    }

    return {ok: true, path: text, reason: null};
}

/**
 * @summary Records one consent: a choice or a reference, never a secret value — the record has no slot for
 * one, and this writer refuses anything but a short scalar.
 * @param {Object} options
 * @param {String} options.stepId
 * @param {String|Number|Boolean} options.answer
 * @param {Object} options.record
 * @param {String} options.recordPath
 * @param {Object} options.host
 * @returns {Promise<{record: Object, consent: Object}>}
 */
export async function recordConsent({stepId, answer, record, recordPath, host}) {
    if (!['string', 'number', 'boolean'].includes(typeof answer) || (typeof answer === 'string' && answer.length > 256)) {
        throw new Error(`recordConsent: the answer for '${stepId}' must be a choice or a reference (a short scalar).`);
    }

    const
        consent = {stepId, answer, consentedAt: new Date(host.now()).toISOString()},
        next    = withConsent(record, consent);

    await persistSetupRecord(recordPath, next, host);

    return {record: next, consent};
}

/**
 * @summary A TCP reachability read for a published port — a coordinate check, never an identity proof
 * (the served-plane step is the identity proof).
 * @param {Object} options
 * @param {String}   [options.host='127.0.0.1']
 * @param {Number}   options.port
 * @param {Number}   [options.timeoutMs=1000]
 * @param {Function} [options.connect=net.connect]
 * @returns {Promise<{open: Boolean, reason: String|null}>}
 */
export function probePort({host = '127.0.0.1', port, timeoutMs = 1000, connect = net.connect}) {
    return new Promise(resolve => {
        const socket = connect({host, port});

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => { socket.destroy(); resolve({open: true, reason: null}) });
        socket.once('timeout', () => { socket.destroy(); resolve({open: false, reason: `no answer on ${host}:${port} within ${timeoutMs} ms`}) });
        socket.once('error', error => { socket.destroy(); resolve({open: false, reason: error.message}) });
    });
}
