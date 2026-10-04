/**
 * @module ai/services/fleet/verifyEffect
 * @summary The first run's `verify` effect: one witness memory written THROUGH the served plane under this
 * run, read back, and recalled through the plane's embedding lane — the run-bound proof behind the recipe's
 * `done` step (the setup epic's point 6: the wizard witnesses its own completion). Global counters and
 * plane-level firsts are not witnesses; this exchange is, because every receipt it keeps is a value the
 * plane returned for THIS run's marker.
 *
 * **At most one dispatched write per attempt, by construction.** A durable `attempt` lands in the record
 * BEFORE the write is dispatched; an acknowledged write is never written again; an ambiguous (lost)
 * acknowledgement is only ever ADOPTED from a positive read — a row carrying the attempt's marker — or left
 * `reconcile-required`, never replayed: an empty recency read is also what an unavailable graph or an
 * unreadable WAL answers (`count 0 / nextCursor: null`), so it is not evidence of absence. The only other
 * write is a NEW attempt the operator consents to explicitly (`newAttempt`), recorded under its own marker;
 * a later recall finding both rows is a tolerated, documented duplicate. An explicit refusal the plane
 * answered before accepting (no row minted) settles its attempt as `refused`.
 *
 * Receipts land as each sub-step is accepted — `attempt`, `memory`, `readback`, `recall` — through the
 * record's one writer, so an interruption keeps what was accepted and a resume re-runs only the read-only
 * sub-steps. The `verify` receipt summarizes the section: `pending` + `resumable` while a read-only sub-step
 * has not landed (the recipe shows it pending; a re-check resumes it), `reconcile-required` while an
 * acknowledgement is unsettled, `failed` with the plane's reason, `accepted` only on the complete set.
 *
 * Pure over the injected plane client (`{addMemory, recentTurns, recall}`) and the host; reads no config.
 */

import {randomUUID}                                 from 'node:crypto';
import {EFFECT_IDS, recordVerification}             from './hostEffects.mjs';
import {RECEIPT_OUTCOMES, contentDigest, findReceipt} from './setupRunRecord.mjs';

/**
 * How many recent turns one reconciliation or readback reads; a marker beyond this page is a paged read,
 * which never concludes absence.
 * @type {Number}
 */
export const WITNESS_READ_LIMIT = 20;

/**
 * @summary The witness row's content: the run, the plane and the attempt's marker, in words a reader of the
 * plane recognizes. The marker is the only token that binds a row to one attempt.
 * @param {Object} options
 * @param {String} options.runId
 * @param {String} options.planeId
 * @param {String} options.marker
 * @returns {{prompt: String, thought: String, response: String}}
 */
export function witnessContent({runId, planeId, marker}) {
    return {
        prompt  : `first-run witness · run ${runId} · plane ${planeId} · marker ${marker}`,
        thought : 'The setup wizard writes one memory through the served plane to witness that the plane it provisioned persists and recalls; the marker binds this row to one consented attempt of one run.',
        response: `witness ${marker}: written through the served plane under the run it names`
    };
}

/**
 * @summary Whether a plane row carries the marker in any of its text fields.
 * @param {Object} row
 * @param {String} marker
 * @returns {Boolean}
 */
export function rowCarriesMarker(row, marker) {
    return ['prompt', 'response', 'thought', 'summary', 'document'].some(field => typeof row?.[field] === 'string' && row[field].includes(marker));
}

/**
 * @summary A fresh section for a new attempt; the previous attempt, if any, is kept under `priorAttempts`
 * (a refused one, or one the operator consented to write again).
 * @param {Object|null} previous
 * @param {Object} options
 * @param {String} options.runId
 * @param {String} options.planeId
 * @param {String} options.marker
 * @param {String} options.dispatchedAt
 * @returns {Object}
 */
export function newAttemptSection(previous, {runId, planeId, marker, dispatchedAt, composition = null}) {
    return {
        runId,
        planeId,
        sessionId    : null,
        attempt      : {marker, dispatchedAt, ...(composition ? {composition} : {})},
        memory       : null,
        readback     : null,
        recall       : null,
        priorAttempts: previous ? [...(previous.priorAttempts ?? []), {...previous.attempt, memory: previous.memory}] : []
    };
}

const
    stampOf     = host => new Date(host.now()).toISOString(),
    isRefusal   = error => error?.refused === true,
    reasonOf    = error => error?.message ?? String(error),
    baseReceipt = section => ({effectId: EFFECT_IDS.verify, inputDigest: contentDigest(section.attempt.marker), ...(section.attempt.composition ? {inputKey: section.attempt.composition} : {})});

function pendingReceipt(section, host, reason) {
    return {...baseReceipt(section), outcome: RECEIPT_OUTCOMES.pending, resumable: true, startedAt: section.attempt.dispatchedAt, updatedAt: stampOf(host), reason};
}

function reconcileReceipt(section, host, reason) {
    return {...baseReceipt(section), outcome: RECEIPT_OUTCOMES.reconcileRequired, startedAt: section.attempt.dispatchedAt, reconcileRequiredAt: stampOf(host), reason};
}

function failedReceipt(section, host, reason) {
    return {...baseReceipt(section), outcome: RECEIPT_OUTCOMES.failed, startedAt: section.attempt.dispatchedAt, failedAt: stampOf(host), reason};
}

function acceptedReceipt(section, host) {
    return {...baseReceipt(section), outcome: RECEIPT_OUTCOMES.accepted, startedAt: section.attempt.dispatchedAt, acceptedAt: stampOf(host), digest: contentDigest(section.memory.id), references: [`memory:${section.memory.id}`]};
}

/**
 * @summary Performs or resumes the witness for the run's current attempt. Returns the record after the
 * sub-steps that landed, the `verify` receipt it now holds, and what happened (`written`, `adopted`,
 * `resumed`, `refused`, `reconcile-required`, `unchanged`).
 *
 * - no section, `newAttempt`, or a section that followed another `composition`: a durable attempt first, then ONE write; an answered write records `memory`
 *   and `sessionId`, an explicit refusal settles the attempt, an ambiguous failure leaves the receipt
 *   `reconcile-required` and the attempt unacknowledged;
 * - an unacknowledged attempt: a read of the recent turns; a row carrying the marker is adopted as `memory`
 *   (visible adoption, `readback` landed); anything else keeps `reconcile-required` with that reason — empty,
 *   failed, limited or paged reads alike;
 * - an acknowledged attempt: the missing read-only sub-steps (`readback`, then `recall`) run until they land;
 *   the receipt is `accepted` only when `recall.hit` is true;
 * - a refused attempt without `newAttempt`, or an accepted receipt: unchanged.
 * @param {Object} options
 * @param {Object}   options.record The current record, held exclusively by the caller.
 * @param {String}   options.recordPath
 * @param {Object}   options.host From `createHost` (its `now` stamps every receipt).
 * @param {Object}   options.target `{planeId}`.
 * @param {Object}   options.plane `{addMemory(content), recentTurns({limit}), recall({query, limit})}` over the served plane; a
 *     refusal the plane answered carries `error.refused === true`, anything else is ambiguous.
 * @param {Boolean}  [options.newAttempt=false] The operator's explicit consent to write the witness again (a duplicate row is possible).
 * @param {String|null} [options.composition=null] The key of the composition the witness follows (`compositionKey`); the attempt
 *     records it, and an attempt that recorded another one is superseded by a new attempt — a new input, not a second write for the same one.
 * @param {Function} [options.mintMarker=randomUUID]
 * @returns {Promise<{record: Object, receipt: Object, performed: String}>}
 */
export async function performVerify({record, recordPath, host, target, plane, newAttempt = false, composition = null, mintMarker = randomUUID}) {
    const existing = findReceipt(record, EFFECT_IDS.verify);

    let section = record.verification ?? null, current = record;

    // a witness speaks for the composition it followed: a re-composed plane is a new input, so its attempt
    // is a new one without the operator's second-write consent
    const fresh = newAttempt || Boolean(section) && (section.attempt?.composition ?? null) !== composition;

    const persist = async receipt => {
        current = (await recordVerification({record: current, recordPath, host, verification: section, receipt})).record;

        return receipt;
    };

    // persist first, THEN read `current`: an object literal evaluates `record: current` before an awaited
    // `receipt:` expression, which would hand the caller the record from before the write
    const settle = async (receipt, performed) => ({receipt: await persist(receipt), record: current, performed});

    if (existing?.outcome === RECEIPT_OUTCOMES.accepted && section?.recall?.hit === true && !fresh) {
        return {record, receipt: existing, performed: 'unchanged'};
    }

    if (section?.attempt?.refused && !fresh) {
        return {record, receipt: existing, performed: 'unchanged'};
    }

    let performed;

    if (!section || fresh) {
        // the attempt is durable BEFORE the write leaves: a crash between the two leaves a reconcilable trace, never a replay
        section = newAttemptSection(section, {runId: record.runId, planeId: target.planeId, marker: mintMarker(), dispatchedAt: stampOf(host), composition});
        await persist(pendingReceipt(section, host, 'the witness write is being dispatched'));

        let answer;

        try {
            answer = await plane.addMemory(witnessContent({runId: record.runId, planeId: target.planeId, marker: section.attempt.marker}));
        } catch (error) {
            if (isRefusal(error)) {
                section = {...section, attempt: {...section.attempt, refused: {at: stampOf(host), reason: reasonOf(error)}}};

                return settle(failedReceipt(section, host, `the plane refused the witness write: ${reasonOf(error)}`), 'refused');
            }

            return settle(reconcileReceipt(section, host, `the witness write was dispatched and its acknowledgement did not arrive (${reasonOf(error)}); a row carrying the attempt's marker is adopted on re-check, nothing is written again`), 'reconcile-required');
        }

        section = {...section, sessionId: answer?.sessionId ?? null, memory: {id: answer?.id ?? null, at: answer?.timestamp ?? stampOf(host)}};
        await persist(pendingReceipt(section, host, 'the witness was written; its readback and recall have not landed yet'));
        performed = 'written';
    } else if (!section.memory) {
        // a lost acknowledgement: reads only, and only a positive read moves the state
        const read = await plane.recentTurns({limit: WITNESS_READ_LIMIT}).then(value => ({ok: true, value}), error => ({ok: false, error}));

        if (!read.ok) {
            return settle(reconcileReceipt(section, host, `the reconciliation read failed (${reasonOf(read.error)}); nothing is written again`), 'reconcile-required');
        }

        const row = (read.value?.turns ?? []).find(turn => rowCarriesMarker(turn, section.attempt.marker));

        if (!row) {
            const paged = read.value?.nextCursor ? 'the read was paged, the row may lie beyond it' : `the read answered ${read.value?.count ?? 0} rows without the marker — also what an unavailable store answers`;

            return settle(reconcileReceipt(section, host, `the witness write is unacknowledged and ${paged}; nothing is written again — consent to a new attempt writes a second row`), 'reconcile-required');
        }

        section = {...section, sessionId: row.sessionId ?? section.sessionId, memory: {id: row.id, at: row.timestamp ?? stampOf(host)}, readback: {at: stampOf(host), adopted: true}};
        await persist(pendingReceipt(section, host, 'the witness row was adopted from a positive read; its recall has not landed yet'));
        performed = 'adopted';
    } else {
        performed = 'resumed';
    }

    // a read-only sub-step the plane REFUSES is recorded on the section (`failure`) so every reader — the
    // effect row, `done` — projects the plane's own reason; a later resume that lands the sub-step clears it
    const refusedSubStep = (name, error) => {
        section = {...section, failure: {step: name, at: stampOf(host), reason: reasonOf(error)}};

        return settle(failedReceipt(section, host, `the plane refused the ${name}: ${reasonOf(error)}`), performed);
    };

    if (section.failure) {
        section = {...section, failure: null};
    }

    if (!section.readback) {
        const read = await plane.recentTurns({limit: WITNESS_READ_LIMIT}).then(value => ({ok: true, value}), error => ({ok: false, error}));

        if (!read.ok) {
            return isRefusal(read.error) ? refusedSubStep('readback', read.error) : settle(pendingReceipt(section, host, `the readback did not answer (${reasonOf(read.error)}); re-check repeats it`), performed);
        }

        if (!(read.value?.turns ?? []).some(turn => rowCarriesMarker(turn, section.attempt.marker))) {
            return settle(pendingReceipt(section, host, 'the written witness is not in the recent turns yet; re-check repeats the readback'), performed);
        }

        section = {...section, readback: {at: stampOf(host)}};
        await persist(pendingReceipt(section, host, 'the witness was read back; its recall has not landed yet'));
    }

    // the semantic query is the witness's own words, never the bare marker: an embedding of a UUID lands
    // nowhere near its row (measured 2026-10-03: marker alone → no hit at 0.73; the prompt → the row at 0.35).
    // The hit is bound to the attempt by the marker in the returned row, or by the acknowledged id.
    const recall = await plane.recall({query: witnessContent({runId: record.runId, planeId: target.planeId, marker: section.attempt.marker}).prompt, limit: WITNESS_READ_LIMIT}).then(value => ({ok: true, value}), error => ({ok: false, error}));

    if (!recall.ok) {
        return isRefusal(recall.error) ? refusedSubStep('recall', recall.error) : settle(pendingReceipt(section, host, `the recall did not answer (${reasonOf(recall.error)}); re-check repeats it`), performed);
    }

    const answer = recall.value ?? {};

    // the producer's own words for a query it could not run properly: a degraded or quarantined semantic path is
    // reported as such, never read as "not embedded yet"
    if (answer.quarantined === true) {
        return settle(pendingReceipt(section, host, 'the plane\'s semantic query is quarantined; the witness is written and read back, its recall waits for the plane — re-check repeats it'), performed);
    }

    if (answer.degraded === true) {
        return settle(pendingReceipt(section, host, `the plane's semantic query is degraded${answer.code ? ` (${answer.code})` : ''}${answer.message ? `: ${answer.message}` : ''}; the witness is written and read back, its recall waits for the plane — re-check repeats it`), performed);
    }

    const results = Array.isArray(answer.results) ? answer.results : [];

    if (!results.some(row => rowCarriesMarker(row, section.attempt.marker) || (section.memory.id && row?.id === section.memory.id))) {
        return settle(pendingReceipt(section, host, `the witness is written and read back; the plane's semantic recall did not return it yet (${results.length} rows answered, none this attempt's) — re-check repeats the recall`), performed);
    }

    section = {...section, recall: {at: stampOf(host), hit: true}};

    return settle(acceptedReceipt(section, host), performed);
}
