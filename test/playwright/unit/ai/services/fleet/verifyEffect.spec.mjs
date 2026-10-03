import {expect, test} from '@playwright/test';
import fs             from 'node:fs/promises';
import os             from 'node:os';
import path           from 'node:path';
import {RECIPE_VERSION, STEP_STATUSES, evaluateRecipe}                      from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {EFFECT_IDS, createHost, persistSetupRecord}                          from '../../../../../../ai/services/fleet/hostEffects.mjs';
import {presets}                                                             from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {RECEIPT_OUTCOMES, createSetupRecord, findReceipt, readSetupRecord, setupRecordPath, withConsent} from '../../../../../../ai/services/fleet/setupRunRecord.mjs';
import {WITNESS_READ_LIMIT, newAttemptSection, performVerify, rowCarriesMarker, witnessContent} from '../../../../../../ai/services/fleet/verifyEffect.mjs';

// The witness effect over a scripted plane and a real temp record: at most one dispatched write per attempt,
// receipts as each sub-step lands, adoption only from a positive read, a second write only by explicit consent.

const
    RUN_ID = '0f1e2d3c-4b5a-4968-8777-6655443322aa',
    NOW    = Date.UTC(2026, 9, 3, 7, 0, 0),
    target = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'};

const ambiguous = message => new Error(message);
const refused   = message => Object.assign(new Error(message), {refused: true});

/**
 * @summary A plane whose three calls answer from scripts; every call is recorded. A script is a function of
 * the call index for that tool; a thrown value rejects.
 */
function scriptedPlane({addMemory, recentTurns, recall}) {
    const calls = {addMemory: [], recentTurns: [], recall: []};
    const bind  = (name, script) => async args => {
        calls[name].push(args);

        const step = script[Math.min(calls[name].length - 1, script.length - 1)];

        if (step instanceof Error) throw step;

        return typeof step === 'function' ? step(args) : step;
    };

    return {calls, addMemory: bind('addMemory', addMemory), recentTurns: bind('recentTurns', recentTurns), recall: bind('recall', recall)};
}

const answered = {id: 'mem-1', sessionId: 'sess-1', timestamp: '2026-10-03T07:00:01.000Z', visibility: {recencyQueryable: true, semanticQueryable: false}};
const rowFor   = marker => ({id: 'mem-1', sessionId: 'sess-1', timestamp: '2026-10-03T07:00:01.000Z', prompt: `first-run witness · marker ${marker}`});
const turns    = (...rows) => ({count: rows.length, turns: rows, nextCursor: null});
const recalled = marker => ({count: 1, results: [{id: 'mem-1', prompt: `… marker ${marker}`}]});
const nothing  = {count: 0, results: []};

async function scratch() {
    const
        root       = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-effect-')),
        recordPath = setupRecordPath(path.join(root, 'setup'), RUN_ID),
        host       = createHost({now: () => NOW});

    let record = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: host.now});

    record = withConsent(record, {stepId: 'preset', answer: 'local-small', consentedAt: 't'});
    record = withConsent(record, {stepId: 'plane-credential', answer: '/op/plane-pat', consentedAt: 't'});
    await persistSetupRecord(recordPath, record, host);

    return {root, recordPath, host, record};
}

const onDisk = async ({recordPath, host}) => (await readSetupRecord(recordPath, {fsModule: host.fsModule})).record;

test.describe('verifyEffect', () => {
    test('AC-2: the attempt is durable before the write leaves; memory, readback and recall land as the plane answers; one write; the receipt is accepted only on the complete set', async () => {
        const run = await scratch();

        let diskAtDispatch = null;

        const plane = scriptedPlane({
            addMemory  : [async () => { diskAtDispatch = await onDisk(run); return answered }],
            recentTurns: [args => turns(rowFor(diskAtDispatch.verification.attempt.marker))],
            recall     : [args => recalled(args.query)]
        });

        const result = await performVerify({...run, target, plane, mintMarker: () => 'marker-1'});

        // the record on disk when the write was dispatched already held the attempt and a pending receipt
        expect(diskAtDispatch.verification).toMatchObject({runId: RUN_ID, planeId: 'plane-a', attempt: {marker: 'marker-1', dispatchedAt: new Date(NOW).toISOString()}, memory: null, readback: null, recall: null});
        expect(findReceipt(diskAtDispatch, EFFECT_IDS.verify)).toMatchObject({outcome: RECEIPT_OUTCOMES.pending, resumable: true});

        expect(result.performed).toBe('written');
        expect(result.receipt).toMatchObject({effectId: 'verify', outcome: RECEIPT_OUTCOMES.accepted, references: ['memory:mem-1']});
        expect(result.record.verification).toMatchObject({sessionId: 'sess-1', memory: {id: 'mem-1', at: answered.timestamp}, readback: {at: new Date(NOW).toISOString()}, recall: {hit: true}});
        expect(plane.calls.addMemory).toHaveLength(1);
        expect(plane.calls.addMemory[0]).toEqual(witnessContent({runId: RUN_ID, planeId: 'plane-a', marker: 'marker-1'}));
        expect(plane.calls.recentTurns).toEqual([{limit: WITNESS_READ_LIMIT}]);
        // the semantic query is the witness's own words (a bare UUID embeds nowhere near its row), the hit is bound by the marker
        expect(plane.calls.recall).toEqual([{query: witnessContent({runId: RUN_ID, planeId: 'plane-a', marker: 'marker-1'}).prompt, limit: WITNESS_READ_LIMIT}]);
        expect(await onDisk(run)).toEqual(result.record);

        // an accepted witness is never written again without consent
        const again = await performVerify({...run, record: result.record, target, plane});

        expect(again.performed).toBe('unchanged');
        expect(plane.calls.addMemory).toHaveLength(1);
    });

    test('AC-3 (accepted-resume control): a later query failing then a retry produces exactly one write; the recall landing late keeps the step pending and resumable until it lands', async () => {
        const run   = await scratch();
        const plane = scriptedPlane({
            addMemory  : [answered],
            recentTurns: [turns(rowFor('mk-7f3a'))],
            recall     : [ambiguous('ECONNRESET'), nothing, args => recalled(args.query)]
        });

        const first = await performVerify({...run, target, plane, mintMarker: () => 'mk-7f3a'});

        expect(first.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.pending, resumable: true, reason: expect.stringContaining('recall did not answer')});

        // the recipe reads a resumable pending receipt as pending with that reason, never as reconcile-required
        const step = (await evaluateRecipe({target, record: first.record, observers: {verification: async () => ({present: false, reason: 'not yet'})}, presets, now: () => NOW})).steps.find(row => row.id === 'verify');

        expect(step).toMatchObject({status: STEP_STATUSES.pending, reason: first.receipt.reason});

        const second = await performVerify({...run, record: first.record, target, plane});

        expect(second.performed).toBe('resumed');
        expect(second.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.pending, resumable: true, reason: expect.stringContaining('not recalled it semantically yet')});

        const third = await performVerify({...run, record: second.record, target, plane});

        expect(third.receipt.outcome).toBe(RECEIPT_OUTCOMES.accepted);
        expect(plane.calls.addMemory).toHaveLength(1);
        expect(plane.calls.recentTurns).toHaveLength(1);
        expect(plane.calls.recall).toHaveLength(3);
    });

    test('AC-3 (refusal arm): an explicit pre-acceptance refusal settles the attempt as refused and failed; a resume writes nothing; a consented new attempt dispatches once more under its own marker', async () => {
        const run   = await scratch();
        const plane = scriptedPlane({
            addMemory  : [refused('tenant has no write grant'), answered],
            recentTurns: [turns(rowFor('m2'))],
            recall     : [args => recalled(args.query)]
        });

        const markers = ['m1', 'm2'];
        const first   = await performVerify({...run, target, plane, mintMarker: () => markers.shift()});

        expect(first.performed).toBe('refused');
        expect(first.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.failed, reason: 'the plane refused the witness write: tenant has no write grant'});
        expect(first.record.verification.attempt).toMatchObject({marker: 'm1', refused: {reason: 'tenant has no write grant'}});

        const resumed = await performVerify({...run, record: first.record, target, plane});

        expect(resumed.performed).toBe('unchanged');
        expect(plane.calls.addMemory).toHaveLength(1);

        const consented = await performVerify({...run, record: first.record, target, plane, newAttempt: true, mintMarker: () => markers.shift()});

        expect(consented.receipt.outcome).toBe(RECEIPT_OUTCOMES.accepted);
        expect(consented.record.verification.attempt.marker).toBe('m2');
        expect(consented.record.verification.priorAttempts).toEqual([{marker: 'm1', dispatchedAt: new Date(NOW).toISOString(), refused: {at: new Date(NOW).toISOString(), reason: 'tenant has no write grant'}, memory: null}]);
        expect(plane.calls.addMemory).toHaveLength(2);
    });

    test('AC-3 (Euclid\'s diagonal): a lost acknowledgement is reconciled read-only — an empty or paged read keeps reconcile-required with no write, resumed twice; a row carrying the marker is adopted; one attempt, one write', async () => {
        const run   = await scratch();
        const plane = scriptedPlane({
            addMemory  : [ambiguous('plane add_memory timed out after 60000 ms')],
            recentTurns: [turns(), {count: 1, turns: [rowFor('other')], nextCursor: {timestamp: 't', id: 'x'}}, turns(rowFor('mk-7f3a'))],
            recall     : [args => recalled(args.query)]
        });

        const lost = await performVerify({...run, target, plane, mintMarker: () => 'mk-7f3a'});

        expect(lost.performed).toBe('reconcile-required');
        expect(lost.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, reason: expect.stringContaining('acknowledgement did not arrive')});
        expect(lost.record.verification.memory).toBeNull();

        // the recipe shows the receipt's own reason on the row
        const row = (await evaluateRecipe({target, record: lost.record, observers: {verification: async () => ({present: false, reason: 'not yet'})}, presets, now: () => NOW})).steps.find(step => step.id === 'verify');

        expect(row).toMatchObject({status: STEP_STATUSES.reconcileRequired, reason: lost.receipt.reason});

        const empty = await performVerify({...run, record: lost.record, target, plane});

        expect(empty.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, reason: expect.stringContaining('answered 0 rows without the marker — also what an unavailable store answers')});

        const paged = await performVerify({...run, record: empty.record, target, plane});

        expect(paged.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, reason: expect.stringContaining('the read was paged')});
        expect(plane.calls.addMemory).toHaveLength(1);

        const adopted = await performVerify({...run, record: paged.record, target, plane});

        expect(adopted.performed).toBe('adopted');
        expect(adopted.receipt.outcome).toBe(RECEIPT_OUTCOMES.accepted);
        expect(adopted.record.verification).toMatchObject({attempt: {marker: 'mk-7f3a'}, memory: {id: 'mem-1'}, readback: {adopted: true}, recall: {hit: true}, sessionId: 'sess-1'});
        expect(adopted.record.verification.priorAttempts).toEqual([]);
        expect(plane.calls.addMemory).toHaveLength(1);
        expect(plane.calls.recentTurns).toHaveLength(3);
    });

    test('a failed reconciliation read and a refused read-only sub-step each settle without a write; the witness content and the marker match are exact', async () => {
        const run   = await scratch();
        const plane = scriptedPlane({addMemory: [ambiguous('socket hang up')], recentTurns: [ambiguous('ECONNREFUSED')], recall: [nothing]});

        const lost = await performVerify({...run, target, plane, mintMarker: () => 'mk-7f3a'});
        const read = await performVerify({...run, record: lost.record, target, plane});

        expect(read.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.reconcileRequired, reason: expect.stringContaining('the reconciliation read failed (ECONNREFUSED)')});
        expect(plane.calls.addMemory).toHaveLength(1);

        const refusing = scriptedPlane({addMemory: [answered], recentTurns: [refused('viewer lacks READ')], recall: [nothing]});
        const second   = await scratch();
        const result   = await performVerify({...second, target, plane: refusing, mintMarker: () => 'mk-7f3a'});

        expect(result.receipt).toMatchObject({outcome: RECEIPT_OUTCOMES.failed, reason: 'the plane refused the readback: viewer lacks READ'});
        expect(result.record.verification.memory).toMatchObject({id: 'mem-1'});

        expect(rowCarriesMarker({response: 'witness abc: written'}, 'abc')).toBe(true);
        expect(rowCarriesMarker({summary: 'nothing here'}, 'abc')).toBe(false);
        expect(rowCarriesMarker(null, 'abc')).toBe(false);
        expect(witnessContent({runId: RUN_ID, planeId: 'p', marker: 'abc'}).prompt).toBe(`first-run witness · run ${RUN_ID} · plane p · marker abc`);
        expect(newAttemptSection(null, {runId: RUN_ID, planeId: 'p', marker: 'abc', dispatchedAt: 't'})).toEqual({runId: RUN_ID, planeId: 'p', sessionId: null, attempt: {marker: 'abc', dispatchedAt: 't'}, memory: null, readback: null, recall: null, priorAttempts: []});
    });
});
