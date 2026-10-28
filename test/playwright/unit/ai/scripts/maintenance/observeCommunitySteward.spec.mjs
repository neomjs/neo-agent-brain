import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {test, expect} from '@playwright/test';

const execFileAsync = promisify(execFile),
    cliPath = fileURLToPath(new URL('../../../../../../ai/scripts/maintenance/observeCommunitySteward.mjs', import.meta.url)),
    repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
let loaded;

/** @summary Loads the tracked module lazily so the actual missing-CLI help proof can run before implementation. */
const api = () => loaded ??= import(pathToFileURL(cliPath).href);

/** @summary Creates a canonical, non-symlink temporary output parent. */
async function directory() {
    return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brain-steward-window-')))
}

/** @summary Provides explicit scope and finite controls for one hermetic window. */
function args(output, overrides = {}) {
    return {tenantId: 'tenant-alpha', sourceInstanceIds: ['source-alpha'], samples: 2, intervalMs: 0,
        output, vacancyFallbackPrincipal: null, help: false, ...overrides}
}

/** @summary Represents one exact service-owned metadata snapshot and its matching shadow decision. */
function sample(status = 'fresh', overrides = {}) {
    return {attentionCounts: {schemaVersion: 'community-attention.v1', status, notAuthority: true,
        count: status === 'fresh' ? 2 : 0, sourceWatermark: 'wm-1',
        oldestOccurredAt: status === 'fresh' ? '2026-10-27T00:00:00Z' : null,
        coverage: {basis: 'admitted-ledger', sourceCount: 1, activeSourceCount: 1,
            completeSourceCount: status === 'degraded' ? 0 : 1, degraded: status === 'degraded'},
        sources: [{sourceInstanceId: 'source-alpha', registrationEpoch: 2, lifecycleState: 'ACTIVE',
            families: ['issues', 'pulls', 'discussions'].map(resourceFamily => ({resourceFamily,
                complete: status !== 'degraded', qualified: status !== 'degraded'}))}], ...overrides},
    evaluation: {mode: 'shadow', shouldWake: false,
        ...(['fresh', 'empty'].includes(status) ? {stewardVacant: true, shadowWouldWake: false} : {}),
        reason: status === 'fresh' ? 'steward-vacant-no-fallback-target' : `coverage-${status}`, notAuthority: true}}
}

/** @summary Uses real async context propagation while the injected service records every invocation. */
function fixture(values = [sample(), sample()], policy = {}) {
    const storage = new AsyncLocalStorage(), calls = [],
        leaves = Object.freeze({mode: 'shadow', stewardActivation: false, stewardLeaseTtlMs: null,
            wakeCoalesceWindowMs: null, vacancyFallbackCooldownMs: null, minUnclaimedEligibleCount: null,
            wakeAmplificationCap: null, maxWakePayloadBytes: null, ...policy}),
        context = {run: (scope, callback) => storage.run(scope, callback)};
    let loads = 0;
    return {calls, leaves, get loads() { return loads }, runtimeLoader: async () => {
        loads++;
        return {context, readPolicy: () => leaves, activity: {
            async observeStewardWake(options) {
                calls.push({scope: storage.getStore(), options});
                const value = values[calls.length - 1];
                if (value instanceof Error) throw value;
                return value;
            },
            acquireStewardLease() { throw new Error('must never acquire') },
            claimTask() { throw new Error('must never claim') },
            projectAttentionCounts() { throw new Error('must not independently project') },
            evaluateStewardWake() { throw new Error('must not independently evaluate') }
        }}
    }}
}

/** @summary Runs the actual tracked entry with a deliberately unusable database path for help and invalid inputs. */
async function runCli(argv, env = {}) {
    try {
        const result = await execFileAsync(process.execPath, [cliPath, ...argv], {cwd: repoRoot,
            env: {...process.env, NEO_MEMORY_DB_PATH: '/unusable-steward-test-path/never.sqlite',
                NEO_MEMORY_DB_PATH_TEST: '/unusable-steward-test-path/never.sqlite', ...env}, timeout: 10000});
        return {code: 0, killed: false, signal: null, ...result};
    } catch (error) {
        return {code: typeof error.code === 'number' ? error.code : 1, killed: error.killed === true,
            signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? ''}
    }
}

test.describe('finite community-steward observation CLI', () => {
    test('actual CLI help works without loading storage (RED before the tracked CLI exists)', async () => {
        const result = await runCli(['--help']);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('Usage: node ai/scripts/maintenance/observeCommunitySteward.mjs');
        expect(result.stdout).toContain('--source-instance-id');
        expect(result.stdout).toContain('--interval-ms');
        expect(result.stdout).not.toContain('COMMUNITY_STEWARD_WINDOW_FAILED');
    });

    test('actual CLI no-argument and malformed paths refuse before runtime storage', async () => {
        const missing = await runCli([]);
        expect(missing.code).toBe(2);
        expect(missing.stderr).toContain('--tenant-id is required');
        expect(missing.stderr).toContain('--samples must be an explicit');
        const malformed = await runCli(['--tenant-id']);
        expect(malformed.code).toBe(2);
        expect(malformed.stderr).toContain('COMMUNITY_STEWARD_WINDOW_ARGUMENTS_INVALID');
    });

    test('requires explicit finite scope and sampling before loading collaborators', async () => {
        const {parseArgs, validateArgs, runOperatorWindow} = await api(), dir = await directory();
        try {
            expect(parseArgs(['--tenant-id', 'tenant-alpha', '--source-instance-id', 'source-alpha',
                '--samples', '2', '--interval-ms', '0', '--output', path.join(dir, 'window.json')]))
                .toEqual(args(path.join(dir, 'window.json')));
            for (const overrides of [{tenantId: null}, {sourceInstanceIds: []}, {samples: 0},
                {samples: Infinity}, {intervalMs: null}, {intervalMs: -1}, {intervalMs: 2_147_483_648}, {output: 'relative.json'},
                {vacancyFallbackPrincipal: 'steward:tenant-beta:seat'}]) {
                const f = fixture(), input = args(path.join(dir, 'invalid.json'), overrides);
                expect(validateArgs(input).length).toBeGreaterThan(0);
                await expect(runOperatorWindow({args: input, runtimeLoader: f.runtimeLoader})).rejects.toThrow('ARGUMENTS_INVALID');
                expect(f.loads).toBe(0);
            }
            expect(() => parseArgs(['--samples', '1', '--samples', '2'])).toThrow('DUPLICATE_ARGUMENT');
            expect(() => parseArgs(['--tenant-id', 'tenant-alpha', '--unknown', '1'])).toThrow('UNKNOWN_ARGUMENT');
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('refuses overwrite and symlink ancestors before loading runtime', async () => {
        const {runOperatorWindow} = await api(), dir = await directory(), f = fixture();
        try {
            const existing = path.join(dir, 'existing.json');
            await fs.writeFile(existing, 'keep');
            await expect(runOperatorWindow({args: args(existing), runtimeLoader: f.runtimeLoader})).rejects.toThrow();
            expect(await fs.readFile(existing, 'utf8')).toBe('keep');
            const real = path.join(dir, 'real'), link = path.join(dir, 'alias');
            await fs.mkdir(real); await fs.symlink(real, link, 'dir');
            await expect(runOperatorWindow({args: args(path.join(link, 'window.json')), runtimeLoader: f.runtimeLoader}))
                .rejects.toThrow('UNSAFE_OUTPUT');
            expect(f.loads).toBe(0);
            expect(await fs.readdir(real)).toEqual([]);
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('retains the same service observations with tenant context, explicit clock, policy and finite denominator', async () => {
        const {runOperatorWindow, resolveExitCode} = await api(), dir = await directory(),
            first = sample(), second = sample('fresh', {sourceWatermark: 'wm-2', count: 3}), f = fixture([first, second]),
            waits = [], output = path.join(dir, 'window.json');
        let tick = Date.parse('2026-10-27T12:00:00Z');
        try {
            const report = await runOperatorWindow({args: args(output, {intervalMs: 20,
                vacancyFallbackPrincipal: 'steward:tenant-alpha:oncall'}), runtimeLoader: f.runtimeLoader,
                now: () => tick++, sleep: async ms => { waits.push(ms); tick += ms }});
            expect(report.status).toBe('completed');
            expect(resolveExitCode(report)).toBe(0);
            expect(report.denominator).toMatchObject({requested: 2, attempted: 2, recorded: 2, freshDemand: 2});
            expect(waits).toEqual([20]);
            expect(f.calls).toHaveLength(2);
            expect(f.calls[0].scope).toEqual({userId: 'tenant-alpha'});
            expect(f.calls[0].options).toMatchObject({sourceInstanceIds: ['source-alpha'],
                vacancyFallbackTarget: 'steward:tenant-alpha:oncall'});
            expect(f.calls[0].options).not.toHaveProperty('tenantId');
            expect(report.observations[0].observedAt).toBe(new Date(f.calls[0].options.now).toISOString());
            expect(report.observations[0].attentionCounts).toEqual(first.attentionCounts);
            expect(report.observations[1].attentionCounts).toEqual(second.attentionCounts);
            expect(report.observations[0].evaluation).toEqual(first.evaluation);
            expect(report.observations[0].sourceGenerationComplete).toBe(true);
            expect(report.observations[0].bytes.attentionCounts).toBe(Buffer.byteLength(JSON.stringify(first.attentionCounts), 'utf8'));
            expect(report.policy).toEqual(f.leaves);
            expect(report.zeroDispatch).toMatchObject({kind: 'command-capability-invariant', scope: 'this-command',
                hostWideDispatchCount: null, hostWideDispatchCountReason: 'not-measured'});
            expect(report.zeroDispatch).not.toHaveProperty('dispatches');
            expect(report.summary.vacancy).toEqual({observedDenominator: 2, unknownObservations: 0, numerator: 2, fraction: 1});
            expect(report.summary.wouldWake.numerator).toBe(0);
            expect(report.summary.payloadBytes).toMatchObject({observedDenominator: 0, total: null, max: null});
            expect(report.caller.sourceFiles).toHaveLength(3);
            for (const source of report.caller.sourceFiles) {
                const bytes = await fs.readFile(source.path);
                expect(source).toMatchObject({status: 'measured', bytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex')});
            }
            expect(report.windowEvidence).toBe('fixture-only');
            expect(report.unavailableMetrics.timeToRespondMs.value).toBeNull();
            expect(JSON.parse(await fs.readFile(output, 'utf8')).observations).toEqual(report.observations);
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('keeps missing, empty and degraded demand distinct from fresh demand and records generation changes', async () => {
        const {runOperatorWindow} = await api(), dir = await directory(),
            f = fixture([sample('missing', {sources: []}), sample('empty'), sample('degraded')]);
        try {
            const report = await runOperatorWindow({args: args(path.join(dir, 'window.json'), {samples: 3}), runtimeLoader: f.runtimeLoader});
            expect(report.denominator).toEqual({requested: 3, attempted: 3, recorded: 3, freshDemand: 0,
                missing: 1, empty: 1, degraded: 1});
            expect(report.sourceGenerationChanges).toBe(2);
            expect(report.observations.map(row => row.attentionCounts.status)).toEqual(['missing', 'empty', 'degraded']);
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('classifies complete zero-demand windows as observed and rejects coverage, identity, epoch and policy gaps', async () => {
        const {classifyWindow} = await api(), policy = {mode: 'shadow', stewardActivation: false},
            row = () => ({...sample('empty'), policy, policyAfter: policy, policyStable: true}),
            window = () => ({evidenceClass: 'co-located-ledger-observation', testStore: false, status: 'completed',
                policy, scope: {sourceInstanceIds: ['source-alpha']}, denominator: {requested: 2, recorded: 2}, observations: [row(), row()]}),
            valid = window();
        expect(classifyWindow(valid)).toBe('source-bound-window-observed');
        for (const mutate of [
            report => { report.observations[1].attentionCounts.status = 'missing' },
            report => { report.observations[1].attentionCounts.status = 'degraded' },
            report => { report.observations[1].attentionCounts.coverage.completeSourceCount = 0 },
            report => { report.observations[1].attentionCounts.coverage.activeSourceCount = 0 },
            report => { delete report.observations[1].attentionCounts.sources[0].families },
            report => { report.observations[1].attentionCounts.sources[0].families[0].qualified = false },
            report => { report.observations[1].attentionCounts.sources[0].families.forEach(family => { delete family.qualified }) },
            report => { report.observations[1].attentionCounts.sources[0].families.pop() },
            report => { report.observations[1].attentionCounts.sources[0].families[2].resourceFamily = 'issues' },
            report => { report.observations[1].attentionCounts.sources[0].registrationEpoch++ },
            report => { report.observations[1].policyStable = false },
            report => { report.observations[1].policyAfter = {...policy, stewardActivation: true} },
            report => { report.observations[1].evaluation.shouldWake = true },
            report => { report.testStore = true },
            report => { report.observations[1].attentionCounts.sources[0].sourceInstanceId = 'source-beta' },
            report => { report.scope.sourceInstanceIds.push('source-alpha') },
            report => { report.observations[1].attentionCounts.sources.push({...report.observations[1].attentionCounts.sources[0]}) },
            report => { report.status = 'partial' }
        ]) {
            const changed = window(); mutate(changed);
            expect(classifyWindow(changed)).toBe('insufficient-evidence');
        }
        valid.evidenceClass = 'injected-runtime-fixture';
        expect(classifyWindow(valid)).toBe('fixture-only');
        valid.evidenceClass = 'isolated-test-ledger-fixture'; valid.testStore = true;
        expect(classifyWindow(valid)).toBe('fixture-only');
    });

    test('actual CLI against an isolated empty test tenant remains fixture-only even with the default runtime loader', async () => {
        const dir = await directory(), output = path.join(dir, 'isolated-window.json'), dbPath = path.join(dir, 'store.sqlite');
        try {
            const result = await runCli(['--tenant-id', 'isolated-empty-steward-tenant',
                '--source-instance-id', 'unregistered-source', '--samples', '1', '--interval-ms', '0', '--output', output],
            {UNIT_TEST_MODE: 'true', NEO_MEMORY_DB_PATH_TEST: dbPath, NEO_MEMORY_DB_PATH: dbPath});
            // The explicit source does not exist: this must fail rather than inventing a measured zero-demand source.
            expect(result.code, result.stderr).toBe(1);
            expect(result.killed).toBe(false);
            expect(result.signal).toBeNull();
            const report = JSON.parse(await fs.readFile(output, 'utf8'));
            expect(report).toMatchObject({status: 'failed', testStore: true, unitTestStore: true,
                evidenceClass: 'isolated-test-ledger-fixture', windowEvidence: 'fixture-only',
                denominator: {recorded: 0}, failure: {code: 'COMMUNITY_SOURCE_NOT_OWNED'}});
            expect(report.caller.sourceFiles.every(source => source.status === 'measured')).toBe(true);
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('summarizes only observed evaluator fields without turning unavailable vacancy or bytes into zero', async () => {
        const {summarizeObservations} = await api(), report = summarizeObservations([
            {evaluation: {stewardVacant: true, shadowWouldWake: true, payloadBytes: 100}},
            {evaluation: {stewardVacant: false, shadowWouldWake: false, payloadBytes: 40}},
            {evaluation: {reason: 'coverage-empty'}}, {evaluation: {stewardVacant: null, payloadBytes: null}}
        ]);
        expect(report).toEqual({basis: 'retained-evaluator-fields', recordedObservations: 4,
            vacancy: {observedDenominator: 2, unknownObservations: 2, numerator: 1, fraction: 0.5},
            wouldWake: {observedDenominator: 2, unknownObservations: 2, numerator: 1, fraction: 0.5},
            payloadBytes: {observedDenominator: 2, unknownObservations: 2, total: 140, min: 40, max: 100, mean: 70}});
        expect(summarizeObservations([{evaluation: {reason: 'coverage-empty'}}])).toMatchObject({
            vacancy: {observedDenominator: 0, numerator: null, fraction: null},
            wouldWake: {observedDenominator: 0, numerator: null, fraction: null},
            payloadBytes: {observedDenominator: 0, total: null, min: null, max: null, mean: null}});
    });

    test('refuses live policy without observing, changing leaves or exposing failure prose', async () => {
        const {runOperatorWindow, resolveExitCode} = await api(), dir = await directory(),
            f = fixture([sample()], {mode: 'live', stewardActivation: true});
        try {
            const report = await runOperatorWindow({args: args(path.join(dir, 'refused.json')), runtimeLoader: f.runtimeLoader});
            expect(report.status).toBe('failed');
            expect(report.failure.code).toBe('COMMUNITY_STEWARD_WINDOW_LIVE_ACTIVATION_REFUSED');
            expect(resolveExitCode(report)).toBe(1);
            expect(f.calls).toEqual([]);
            expect(f.leaves.stewardActivation).toBe(true);
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('retains completed samples and a typed partial terminal result after later service failure', async () => {
        const {runOperatorWindow, resolveExitCode} = await api(), dir = await directory(), output = path.join(dir, 'partial.json'),
            f = fixture([sample(), new Error('provider token=PRIVATE fixture text')]);
        try {
            const report = await runOperatorWindow({args: args(output), runtimeLoader: f.runtimeLoader});
            expect(report.status).toBe('partial');
            expect(report.denominator).toMatchObject({requested: 2, attempted: 2, recorded: 1});
            expect(report.failure.code).toBe('COMMUNITY_STEWARD_WINDOW_OBSERVATION_FAILED');
            expect(resolveExitCode(report)).toBe(1);
            const retained = await fs.readFile(output, 'utf8');
            expect(JSON.parse(retained).observations).toHaveLength(1);
            expect(retained).not.toContain('PRIVATE');
            expect(retained).not.toContain('provider token');
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });

    test('refuses cross-source output or prose/token-bearing observations instead of retaining rewritten inputs', async () => {
        const {runOperatorWindow} = await api(), dir = await directory();
        try {
            for (const [name, value] of [['foreign', sample('fresh', {sources: [{sourceInstanceId: 'source-beta'}]})],
                ['prose', sample('fresh', {body: 'PRIVATE'})], ['proof', {...sample(), holderProof: {token: 'PRIVATE'}}]]) {
                const output = path.join(dir, `${name}.json`), f = fixture([value]);
                const report = await runOperatorWindow({args: args(output, {samples: 1}), runtimeLoader: f.runtimeLoader});
                expect(report.status).toBe('failed');
                expect(report.observations).toEqual([]);
                expect(await fs.readFile(output, 'utf8')).not.toContain('PRIVATE');
            }
        } finally { await fs.rm(dir, {recursive: true, force: true}) }
    });
});
