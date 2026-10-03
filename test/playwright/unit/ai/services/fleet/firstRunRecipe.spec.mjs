import {expect, test} from '@playwright/test';
import {
    HEADROOM_BYTES,
    RECIPE_STEPS,
    RECIPE_VERSION,
    STEP_KINDS,
    STEP_STATUSES,
    evaluateRecipe,
    exitCodeFor,
    recommendPlacement
} from '../../../../../../ai/services/fleet/firstRunRecipe.mjs';
import {presets} from '../../../../../../ai/services/fleet/placementPresets.mjs';
import {GiB}     from '../../../../../../ai/services/fleet/probePlacement.mjs';
import {
    RECEIPT_OUTCOMES,
    RETIRE_REASONS,
    createSetupRecord,
    describeBinding,
    resumeTarget,
    retireCurrentProof,
    withConsent,
    withReceipt
} from '../../../../../../ai/services/fleet/setupRunRecord.mjs';

// Pure module over injected observers: no host, no config, no record file is touched by any arm.

const
    RUN_ID   = '0f1e2d3c-4b5a-4968-8777-6655443322aa',
    NOW      = Date.UTC(2026, 9, 1, 20, 0, 0),
    targetA  = {planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'},
    targetB  = {planeId: 'plane-b', dataRoot: '/srv/plane-b', endpoint: 'http://127.0.0.1:3202'},
    byId     = steps => Object.fromEntries(steps.map(step => [step.id, step])),
    preset   = id => presets.find(row => row.id === id),
    need     = id => preset(id).workload.modelsBytes + preset(id).workload.planePeakBytes,
    probeOf  = ({hostAvailable, guestAvailable = null, capBytes = 32 * GiB, pressure = 'ok'}) => ({
        host    : {complete: true, availableBytes: hostAvailable, pressure},
        guest   : guestAvailable === null ? null : {complete: true, availableBytes: guestAvailable, capBytes},
        observed: {}
    });

/** A record bound to `target` holding every consent and an accepted receipt for every effect. */
function fullRecord(target, {digest = 'd1'} = {}) {
    let record = createSetupRecord({runId: RUN_ID, target, recipeVersion: RECIPE_VERSION, now: () => NOW});

    record = withConsent(record, {stepId: 'preset', answer: 'local-small', consentedAt: 't'});
    record = withConsent(record, {stepId: 'plane-credential', answer: '/home/op/.neo-ai/secrets/plane-pat', consentedAt: 't'});

    for (const step of RECIPE_STEPS.filter(row => row.kind === STEP_KINDS.effect)) {
        record = withReceipt(record, {effectId: step.effectId, outcome: RECEIPT_OUTCOMES.accepted, inputDigest: 'i', acceptedAt: 't', digest, references: []});
    }

    return record;
}

/** Observers that read every result as present and matching. */
function greenObservers({digest = 'd1', dimension = 1024} = {}) {
    return {
        placement   : async () => probeOf({hostAvailable: 60 * GiB, guestAvailable: 29 * GiB}),
        envCarrier  : async () => ({present: true, digest}),
        secretFiles : async () => ({present: true, digest}),
        runningPlane: async () => ({present: true, digest: null}),
        servedPlane : async target => ({id: target.planeId, dataRoot: target.dataRoot}),
        validation  : async () => ({provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension}}),
        verification: async () => ({present: true, digest: null}),
        done        : async () => ({queryAnswered: true, persisted: true, at: '2026-10-01T20:00:00.000Z'})
    };
}

const failingObservers = () => Object.fromEntries(
    ['placement', 'envCarrier', 'secretFiles', 'runningPlane', 'servedPlane', 'validation', 'verification', 'done']
        .map(name => [name, async () => { throw new Error(`${name} unreachable`) }])
);

test.describe('firstRunRecipe', () => {
    test('AC-1: accepted receipts with failing observers turn no step green; green observers with an empty record read ok', async () => {
        // the record holds an accepted receipt for every effect, and nothing can be observed
        const stale = await evaluateRecipe({target: targetA, record: fullRecord(targetA), observers: failingObservers(), presets, now: () => NOW});

        expect(stale.binding).toBe('bound');

        for (const step of stale.steps.filter(row => row.kind !== STEP_KINDS.question)) {
            expect(step.status, step.id).toBe(STEP_STATUSES.unknown);
            // validation is never asked behind a served-plane row that is not ok: its reason names the gate, not its observer
            expect(step.reason, step.id).toMatch(step.id === 'validation' ? /^not observed: served-plane is unknown$/ : /unreachable/);
        }
        // the questions read their consent: prior consent is the record's own authority (bootstrap-record decision§2.5)
        expect(byId(stale.steps).preset.status).toBe(STEP_STATUSES.ok);
        expect(byId(stale.steps).preset.answer).toBe('local-small');
        expect(exitCodeFor(stale)).toBe(2);

        // an empty record under green observers: every observation and effect step is a fresh ok
        const fresh = await evaluateRecipe({target: targetA, record: null, observers: greenObservers(), presets, now: () => NOW}), steps = byId(fresh.steps);

        expect(fresh.binding).toBe('no-record');

        for (const id of ['placement', 'write-env', 'write-secrets', 'compose-up', 'served-plane', 'validation', 'done']) {
            expect(steps[id].status, id).toBe(STEP_STATUSES.ok);
        }
        expect(steps['write-env'].reason).toBe('observed; not performed by this run');
        expect(steps.validation.reason).toMatch(/no preset consented/);
        expect(steps.preset.status).toBe(STEP_STATUSES.pending);
        expect(steps['plane-credential'].status).toBe(STEP_STATUSES.pending);
        expect(steps.advanced.status).toBe(STEP_STATUSES.ok);
        expect(steps.advanced.reason).toMatch(/folded/);
        expect(fresh.terminal.id).toBe('done');
        expect(exitCodeFor(fresh)).toBe(0);
    });

    test('an effect step is a fresh read beside its receipt: a changed carrier fails, a gone result fails, a pending receipt is reconcile-required', async () => {
        const
            record  = fullRecord(targetA, {digest: 'd1'}),
            changed = await evaluateRecipe({target: targetA, record, observers: {...greenObservers(), envCarrier: async () => ({present: true, digest: 'd2'})}, presets, now: () => NOW}),
            gone    = await evaluateRecipe({target: targetA, record, observers: {...greenObservers(), envCarrier: async () => ({present: false})}, presets, now: () => NOW}),
            pending = withReceipt(record, {effectId: 'write-env', outcome: RECEIPT_OUTCOMES.pending, inputDigest: 'i', startedAt: 't'}),
            parked  = await evaluateRecipe({target: targetA, record: pending, observers: greenObservers(), presets, now: () => NOW});

        expect(byId(changed.steps)['write-env'].status).toBe(STEP_STATUSES.failed);
        expect(byId(changed.steps)['write-env'].reason).toMatch(/changed after the effect was accepted/);
        expect(byId(gone.steps)['write-env'].status).toBe(STEP_STATUSES.failed);
        expect(byId(gone.steps)['write-env'].reason).toMatch(/gone from the host/);
        // a matching receipt and content read ok with the receipt named
        expect(byId(changed.steps)['write-secrets'].status).toBe(STEP_STATUSES.ok);
        expect(byId(changed.steps)['write-secrets'].reason).toBe('observed; matches the accepted receipt');
        // the interrupted effect is not green although its result is observable: a fresh matching observation must settle it
        expect(byId(parked.steps)['write-env'].status).toBe(STEP_STATUSES.reconcileRequired);
        expect(exitCodeFor(parked)).toBe(1);
    });

    test('AC-3: a record bound to target A turns no step green for target B; a recipe-version change retires the proof into readable history', async () => {
        const
            recordA   = fullRecord(targetA),
            absent    = {...greenObservers(), envCarrier: async () => ({present: false}), secretFiles: async () => ({present: false}), runningPlane: async () => ({present: false})},
            forB      = await evaluateRecipe({target: targetB, record: recordA, observers: absent, presets, now: () => NOW}),
            stepsB    = byId(forB.steps);

        expect(forB.binding).toBe('target-mismatch');
        expect(stepsB.preset.status).toBe(STEP_STATUSES.pending);
        expect(stepsB.preset.reason).toMatch(/bound to another target/);
        // A's accepted receipts neither green nor fail B's effects: they contribute nothing
        for (const id of ['write-env', 'write-secrets', 'compose-up']) {
            expect(stepsB[id].status, id).toBe(STEP_STATUSES.pending);
            expect(stepsB[id].receipt, id).toBeNull();
        }

        // the same identity over a different root is a target mismatch (bootstrap-record decision§2.4)
        expect(describeBinding(recordA, {target: {...targetA, dataRoot: '/srv/other'}, recipeVersion: RECIPE_VERSION})).toBe('target-mismatch');
        // a run that holds no root expectation yet binds on the id
        expect(describeBinding(recordA, {target: {planeId: 'plane-a'}, recipeVersion: RECIPE_VERSION})).toBe('bound');
        // a resume that names only the identity evaluates against the record's root; a named root is compared, never
        // replaced; another identity carries nothing of the old binding over
        expect(resumeTarget(recordA, {planeId: 'plane-a'})).toEqual({planeId: 'plane-a', dataRoot: '/srv/plane-a', endpoint: 'http://127.0.0.1:3102'});
        expect(resumeTarget(recordA, {planeId: 'plane-a', dataRoot: '/srv/other'}).dataRoot).toBe('/srv/other');
        expect(resumeTarget(recordA, {planeId: 'plane-b'})).toEqual({planeId: 'plane-b', dataRoot: null, endpoint: null});

        const retired = retireCurrentProof(recordA, {target: targetA, recipeVersion: RECIPE_VERSION + 1, reason: RETIRE_REASONS.versionChanged, now: () => NOW});

        expect(retired.consents).toEqual([]);
        expect(retired.receipts).toEqual([]);
        expect(retired.history).toHaveLength(1);
        expect(retired.history[0].reason).toBe(RETIRE_REASONS.versionChanged);
        expect(retired.history[0].consents).toHaveLength(2);
        expect(retired.history[0].receipts).toHaveLength(4);
        expect(retired.history[0].recipeVersion).toBe(RECIPE_VERSION);
        expect(recordA.receipts).toHaveLength(4); // the input is not mutated

        const underNewVersion = await evaluateRecipe({target: targetA, record: retired, observers: greenObservers(), presets, now: () => NOW});

        expect(underNewVersion.binding).toBe('version-mismatch');
        expect(byId(underNewVersion.steps).preset.reason).toMatch(new RegExp(`recipe version ${RECIPE_VERSION + 1}`));
        expect(() => retireCurrentProof(recordA, {target: targetA, recipeVersion: 1, reason: 'because'})).toThrow(/unknown reason/);
    });

    test('the served-plane step is the identity proof: a different id fails, the same id over another root fails, a nameless responder fails, no target id is pending', async () => {
        const evaluateWith = (served, target = targetA) => evaluateRecipe({target, record: null, observers: {...greenObservers(), servedPlane: async () => served}, presets, now: () => NOW}).then(result => byId(result.steps)['served-plane']);

        expect((await evaluateWith({id: 'plane-b', dataRoot: '/srv/plane-a'})).status).toBe(STEP_STATUSES.failed);
        expect((await evaluateWith({id: 'plane-b', dataRoot: '/srv/plane-a'})).reason).toMatch(/different plane is answering/);
        expect((await evaluateWith({id: 'plane-a', dataRoot: '/srv/other'})).reason).toMatch(/same identity, different storage/);
        expect((await evaluateWith(null)).reason).toMatch(/never identified itself/);
        expect((await evaluateWith({id: 'plane-a', dataRoot: '/srv/plane-a'}, {planeId: null, dataRoot: null, endpoint: 'http://127.0.0.1:3102'})).status).toBe(STEP_STATUSES.pending);
        expect((await evaluateWith({id: 'plane-a', dataRoot: '/srv/plane-a'})).status).toBe(STEP_STATUSES.ok);
    });

    test('validation compares the observed embedding with the consented preset\'s dimension', async () => {
        const
            record   = fullRecord(targetA), // consented preset: local-small (1024)
            right    = await evaluateRecipe({target: targetA, record, observers: greenObservers({dimension: 1024}), presets, now: () => NOW}),
            wrong    = await evaluateRecipe({target: targetA, record, observers: greenObservers({dimension: 4096}), presets, now: () => NOW}),
            noEmbed  = await evaluateRecipe({target: targetA, record, observers: {...greenObservers(), validation: async () => ({provider: {ok: true}, embedding: {ok: false, reason: 'embedding timed out'}})}, presets, now: () => NOW});

        expect(byId(right.steps).validation.status).toBe(STEP_STATUSES.ok);
        expect(byId(wrong.steps).validation.status).toBe(STEP_STATUSES.failed);
        expect(byId(wrong.steps).validation.reason).toMatch(/4096 dimensions, the 'local-small' preset declares 1024/);
        expect(byId(noEmbed.steps).validation.reason).toBe('embedding timed out');
    });

    test('the headroom rule: a bare fit is possible, a fit above 4 GiB is recommended, a swapping host gets no local recommendation, a candidate is never recommended', () => {
        const
            small     = need('local-small'),
            generous  = recommendPlacement({probe: probeOf({hostAvailable: small + 6 * GiB, guestAvailable: 29 * GiB}), presets}),
            bare      = recommendPlacement({probe: probeOf({hostAvailable: small + 1 * GiB, guestAvailable: 29 * GiB}), presets}),
            swapping  = recommendPlacement({probe: probeOf({hostAvailable: small + 6 * GiB, guestAvailable: 29 * GiB, pressure: 'swapping'}), presets}),
            lowCap    = recommendPlacement({probe: probeOf({hostAvailable: small + 6 * GiB, guestAvailable: 5 * GiB, capBytes: 6 * GiB}), presets}),
            candidate = recommendPlacement({probe: probeOf({hostAvailable: 60 * GiB}), presets: [{...preset('local-small'), id: 'local-trial', qualityFloor: null}]}),
            // a host with 1 GiB above the plane's own peak: hosted fits on arithmetic, under the headroom
            tight     = recommendPlacement({probe: probeOf({hostAvailable: need('hosted') + 1 * GiB}), presets}),
            ids       = rows => rows.map(row => row.id);

        expect(HEADROOM_BYTES).toBe(4 * GiB);
        // `hosted` carries its recorded floor (three met samples): supported, so a host that clears the headroom gets it recommended
        expect(ids(generous.recommended)).toEqual(['hosted', 'local-small']);
        expect(generous.recommended.find(row => row.id === 'hosted').reason).toMatch(/fits with .* host margin/);
        expect(ids(generous.recommended)).not.toContain('local-full');
        // supported is not a free pass: below the headroom hosted is possible, not recommended — by headroom, never by status
        expect(ids(tight.recommended)).toEqual([]);
        expect(ids(tight.possible)).toEqual(['hosted']);
        expect(tight.possible[0].reason).toMatch(/fits by 1\.0 GiB on the host, under the 4\.0 GiB headroom: possible, not recommended/);
        // a preset without a recorded floor is still never recommended by default
        expect(ids(candidate.recommended)).toEqual([]);
        expect(candidate.possible[0].reason).toMatch(/candidate, never recommended by default/);

        // the 32 GiB tier's lesson: fits on arithmetic by less than the headroom → possible, not recommended
        expect(ids(bare.recommended)).toEqual(['hosted']);
        expect(ids(bare.possible)).toEqual(['local-small']);
        expect(bare.possible[0].reason).toMatch(/fits by 1\.0 GiB on the host, under the 4\.0 GiB headroom: possible, not recommended/);
        expect(bare.possible[0].margins.host).toBe(1 * GiB);

        // the probe refuses every LOCAL preset on a swapping host; hosted runs its inference elsewhere and stays the recommendation
        expect(ids(swapping.recommended)).toEqual(['hosted']);
        expect(ids(swapping.refused)).toEqual(['local-small', 'local-full']);
        expect(swapping.refused.find(row => row.id === 'local-small').reason).toMatch(/swapping/);

        // the probe's cap rule refuses; the recipe shows the probe's reason unchanged
        expect(ids(lowCap.refused)).toContain('local-small');
        expect(lowCap.refused.find(row => row.id === 'local-small').reason).toMatch(/VM cap is below the preset's recommended/);

        expect(candidate.recommended).toEqual([]);
        expect(candidate.possible[0].id).toBe('local-trial');
        expect(candidate.possible[0].reason).toMatch(/candidate, never recommended by default/);
    });

    test('the placement step reports the recommendation; with nothing recommended it names each possible and refused preset with its reason; a host nothing fits reads failed', async () => {
        const
            fits     = await evaluateRecipe({target: targetA, record: null, observers: greenObservers(), presets, now: () => NOW}),
            // the probe's own 32 GiB fixture (15.5 GiB host budget, a 16 GiB VM): hosted clears the headroom by 13 GiB; both local
            // presets are refused — no row has a headroom shortfall. With its recorded floor, hosted is what such a host is told.
            laptop   = {placement: async () => probeOf({hostAvailable: 15.5 * GiB, guestAvailable: 13.5 * GiB, capBytes: 16 * GiB})},
            smallHost = await evaluateRecipe({target: targetA, record: null, observers: {...greenObservers(), ...laptop}, presets, now: () => NOW}),
            // the same host under a table where hosted has no recorded floor: possible only for lack of one, nothing recommended
            possible = await evaluateRecipe({target: targetA, record: null, observers: {...greenObservers(), ...laptop}, presets: presets.map(row => row.id === 'hosted' ? {...row, qualityFloor: null} : row), now: () => NOW}),
            nothing  = await evaluateRecipe({target: targetA, record: null, observers: {...greenObservers(), placement: async () => probeOf({hostAvailable: 1 * GiB})}, presets: presets.filter(row => row.id !== 'hosted'), now: () => NOW});

        expect(byId(fits.steps).placement.reason).toMatch(/^recommended: /);
        expect(byId(fits.steps).placement.placement.headroomBytes).toBe(HEADROOM_BYTES);
        expect(byId(smallHost.steps).placement.reason).toBe('recommended: hosted');
        expect(byId(possible.steps).placement.status).toBe(STEP_STATUSES.ok);
        expect(byId(possible.steps).placement.reason).toBe('nothing recommended; possible: hosted (no recorded quality floor: a candidate, never recommended by default); refused: local-small (the host budget falls 2.2 GiB short), local-full (the host budget falls 5.9 GiB short)');
        expect(byId(possible.steps).placement.summary).toBe('the presets this host bears, each with its reason');
        expect(byId(nothing.steps).placement.status).toBe(STEP_STATUSES.failed);
        expect(byId(nothing.steps).placement.placement.refused).toHaveLength(2);
    });

    test('a missing observer is unknown, never green, and the step order and kinds are the recipe\'s', async () => {
        const result = await evaluateRecipe({target: targetA, record: null, observers: {}, presets, now: () => NOW});

        for (const step of result.steps.filter(row => row.kind !== STEP_KINDS.question)) {
            expect(step.status, step.id).toBe(STEP_STATUSES.unknown);
            expect(step.reason, step.id).toMatch(step.id === 'validation' ? /^not observed: served-plane is unknown$/ : /^no '.+' observer$/);
        }
        expect(result.steps.map(step => step.id)).toEqual(RECIPE_STEPS.map(step => step.id));
        // an effect row carries the effect it reads, so a renderer can settle the receipt it names
        expect(result.steps.filter(row => row.kind === STEP_KINDS.effect).map(row => row.effectId)).toEqual(['write-env', 'write-secrets', 'compose-up', 'verify']);
        // both credential questions are answered by a file reference, admitted before it is recorded
        expect(RECIPE_STEPS.filter(step => step.answer === 'file').map(step => step.id)).toEqual(['plane-credential', 'provider-key']);
        expect(RECIPE_STEPS.map(step => step.id)).toEqual(['placement', 'preset', 'plane-credential', 'provider-key', 'advanced', 'write-env', 'write-secrets', 'compose-up', 'served-plane', 'validation', 'verify', 'done']);
        // the provider-key question is decided by the consented preset: pending until one is chosen, not needed for a local one
        expect(result.steps.find(step => step.id === 'provider-key')).toMatchObject({status: STEP_STATUSES.pending, reason: 'decided by the preset: none consented yet'});
        expect(result.recipeVersion).toBe(RECIPE_VERSION);
    });

    test('AC-4: done is the historical witness gated on a fresh served-plane and validation — a wrong plane or an unknown validation keeps it not ok with the witnessed timestamp in the reason; validation is never asked behind a served-plane that is not ok', async () => {
        const
            witnessed  = {queryAnswered: true, persisted: true, at: '2026-10-03T06:00:00.000Z'},
            asked      = [],
            evaluateAs = overrides => evaluateRecipe({target: targetA, record: null, presets, now: () => NOW, observers: {...greenObservers(), validation: async () => { asked.push('validation'); return {provider: {ok: true, model: 'm'}, embedding: {ok: true, dimension: 1024}} }, done: async () => witnessed, ...overrides}}).then(result => byId(result.steps));

        // every fresh step ok: the witness completes the run
        const fresh = await evaluateAs({});

        expect(fresh.done).toMatchObject({status: STEP_STATUSES.ok, witnessedAt: witnessed.at, reason: expect.stringContaining('witnessed at 2026-10-03T06:00:00.000Z')});

        // the control: the record's witness is present, the served plane is another one — done is failed, the fact survives in the reason, validation was not even asked
        asked.length = 0;

        const wrong = await evaluateAs({servedPlane: async () => ({id: 'plane-b', dataRoot: '/srv/plane-b'})});

        expect(wrong['served-plane'].status).toBe(STEP_STATUSES.failed);
        expect(wrong.validation).toMatchObject({status: STEP_STATUSES.unknown, reason: 'not observed: served-plane is failed'});
        expect(wrong.done).toMatchObject({status: STEP_STATUSES.failed, witnessedAt: witnessed.at, reason: 'witnessed at 2026-10-03T06:00:00.000Z; served-plane is failed'});
        expect(asked).toEqual([]);

        // the matching plane while `degraded` (ADR 0041 §2.5): identified — the served-plane step stays ok and says so —
        // but not ready: validation is not asked, done stays open with the witnessed timestamp, nothing turns green
        asked.length = 0;

        const degraded = await evaluateAs({servedPlane: async target => ({id: target.planeId, dataRoot: target.dataRoot, status: 'degraded'})});

        expect(degraded['served-plane']).toMatchObject({status: STEP_STATUSES.ok, reason: 'the served identity matches the target; the plane reports itself degraded'});
        expect(degraded.validation).toMatchObject({status: STEP_STATUSES.unknown, reason: 'not observed: served-plane is degraded'});
        expect(degraded.done).toMatchObject({status: STEP_STATUSES.pending, witnessedAt: witnessed.at, reason: 'witnessed at 2026-10-03T06:00:00.000Z; served-plane is degraded'});
        expect(asked).toEqual([]);
        expect(exitCodeFor({steps: Object.values(degraded), terminal: degraded.done})).toBe(2);
        // and a healthy status word changes nothing
        expect((await evaluateAs({servedPlane: async target => ({id: target.planeId, dataRoot: target.dataRoot, status: 'healthy'})})).done.status).toBe(STEP_STATUSES.ok);

        // validation unknown (its observer failed) mirrors as unknown on done: the run stays open, never green
        const unknown = await evaluateAs({validation: async () => { throw new Error('provider unreachable') }});

        expect(unknown.validation.status).toBe(STEP_STATUSES.unknown);
        expect(unknown.done).toMatchObject({status: STEP_STATUSES.unknown, reason: 'witnessed at 2026-10-03T06:00:00.000Z; validation is unknown'});
        expect(exitCodeFor({steps: Object.values(unknown), terminal: unknown.done})).toBe(2);

        // no witness yet reads as the observer says: unknown without a section, failed with a recorded refusal
        expect((await evaluateAs({done: async () => { throw new Error('no witness for this run yet') }})).done).toMatchObject({status: STEP_STATUSES.unknown, reason: 'no witness for this run yet'});
        expect((await evaluateAs({done: async () => ({persisted: false, queryAnswered: false, reason: 'the plane refused the witness write at t: no grant'})})).done).toMatchObject({status: STEP_STATUSES.failed, reason: 'the plane refused the witness write at t: no grant'});
        // an outstanding sub-step keeps the run OPEN (the verify row says what re-check repeats); only a recorded refusal fails it
        expect((await evaluateAs({done: async () => ({persisted: true, queryAnswered: false, at: 't1'})})).done).toMatchObject({status: STEP_STATUSES.pending, reason: 'witnessed at t1; the witness was not recalled yet', witnessedAt: 't1'});
        expect((await evaluateAs({done: async () => ({persisted: false, queryAnswered: false, at: null, reason: null})})).done).toMatchObject({status: STEP_STATUSES.pending, reason: 'nothing persisted yet'});
    });

    test('every observer is called with the target and, under a bound binding only, the record: no record, another target\'s record and another version\'s record hand over null', async () => {
        const
            calls     = [],
            recording = Object.fromEntries(Object.entries(greenObservers()).map(([name, observer]) => [name, async (target, context) => {
                calls.push({name, target, context});

                return observer(target, context);
            }])),
            recordA   = fullRecord(targetA),
            seen      = async (target, record) => {
                calls.length = 0;
                await evaluateRecipe({target, record, observers: recording, presets, now: () => NOW});

                return calls;
            };

        // bound: the record rides along to every observation and effect observer, with the target
        const bound = await seen(targetA, recordA);

        expect(bound.map(call => call.name).sort()).toEqual(['done', 'envCarrier', 'placement', 'runningPlane', 'secretFiles', 'servedPlane', 'validation', 'verification']);
        for (const call of bound) {
            expect(call.target, call.name).toEqual(targetA);
            expect(call.context, call.name).toEqual({record: recordA});
        }

        // not bound: the observer gets the target and `{record: null}` — never another target's or version's consents
        for (const [target, record] of [[targetA, null], [targetB, recordA], [targetA, {...recordA, recipeVersion: RECIPE_VERSION + 1}]]) {
            for (const call of await seen(target, record)) {
                expect(call.context, `${call.name} for ${target.planeId}`).toEqual({record: null});
            }
        }
    });
});
