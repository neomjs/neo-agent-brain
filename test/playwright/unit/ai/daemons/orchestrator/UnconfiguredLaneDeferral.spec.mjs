import {test, expect}             from '@playwright/test';
import {spawnSync}                from 'node:child_process';
import {tmpdir}                   from 'node:os';
import path                       from 'node:path';
import {fileURLToPath}            from 'node:url';
import Neo                        from 'neo.mjs/src/Neo.mjs';
import * as core                  from 'neo.mjs/src/core/_export.mjs';
import {ProcessSupervisorService} from '../../../../../../ai/daemons/orchestrator/services/ProcessSupervisorService.mjs';

const
    repoRoot   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
    INGEST     = path.join(repoRoot, 'ai/scripts/maintenance/ingestCiFailures.mjs'),
    DIGEST     = path.join(repoRoot, 'ai/scripts/diagnostics/defectObservations.mjs'),
    supervisor = ProcessSupervisorService.prototype;

/**
 * @summary Runs one lane's child the way the supervisor does, and reads its stdout with the supervisor's own parser
 * and classifier. The child runs from a temporary directory, so no `.env` of this checkout supplies a credential.
 * @param {String}   taskName
 * @param {String}   script
 * @param {String[]} args
 * @param {Object}   [inputs] The lane inputs to set; every other GitHub credential and the plane base are unset
 * @returns {Object} `{disposition, status, stdout}`
 */
function runLane(taskName, script, args, inputs = {}) {
    const env = {...process.env, NEO_FLEET_PLANE_BASE: ''};

    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;

    const {status, stdout} = spawnSync(process.execPath, [script, ...args], {cwd: tmpdir(), encoding: 'utf8', env: {...env, ...inputs}, timeout: 60_000}),
          capture          = {bytes: Buffer.byteLength(stdout), chunks: [Buffer.from(stdout)], maxBytes: 1 << 20, overflow: false},
          {outcome}        = supervisor.parseCapturedStdoutJson.call(supervisor, capture);

    return {disposition: status === 0 ? supervisor.classifySuccessfulChildOutcome(taskName, outcome) : null, status, stdout}
}

/**
 * A plane that lacks an input a lane needs is not configured for that lane. The lane defers, and the supervisor records
 * a `skipped` outcome with the missing input as its reason instead of a `failed` one on every tick. An input that is
 * present but fails is not deferral, and still fails.
 */
test.describe('an unconfigured plane defers its CI-ingest and defect-digest lanes', () => {
    test('without a GitHub credential the CI-ingest lane defers, and the supervisor records it as skipped', () => {
        const lane = runLane('ci-failure-ingest', INGEST, ['--json']);

        expect(lane.status).toBe(0);
        expect(JSON.parse(lane.stdout)).toEqual({deferred: true, reason: 'github-token-unset'});
        expect(lane.disposition).toEqual({status: 'skipped', reasonCode: 'github-token-unset'})
    });

    test('with a credential but no plane base it defers on the plane', () => {
        const lane = runLane('ci-failure-ingest', INGEST, ['--json'], {GH_TOKEN: 'unused-by-a-deferred-tick'});

        expect(lane.status).toBe(0);
        expect(lane.disposition).toEqual({status: 'skipped', reasonCode: 'plane-base-unset'})
    });

    test('the defect digest defers without a plane base', () => {
        const lane = runLane('defect-ledger-digest', DIGEST, ['--digest']);

        expect(lane.status).toBe(0);
        expect(JSON.parse(lane.stdout)).toEqual({deferred: true, reason: 'plane-base-unset'});
        expect(lane.disposition).toEqual({status: 'skipped', reasonCode: 'plane-base-unset'})
    });

    test('control: a configured plane that cannot be reached still fails both lanes', () => {
        const inputs = {GH_TOKEN: 'unused-by-a-failed-init', NEO_FLEET_PLANE_BASE: 'http://127.0.0.1:9'};

        for (const [taskName, script, args] of [['ci-failure-ingest', INGEST, ['--json']], ['defect-ledger-digest', DIGEST, ['--digest']]]) {
            const lane = runLane(taskName, script, args, inputs);

            expect(lane.status, `${taskName} fails`).not.toBe(0);
            expect(lane.stdout, `${taskName} prints no deferred envelope`).not.toContain('"deferred"')
        }
    })
});
