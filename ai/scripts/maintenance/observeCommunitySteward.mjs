import fs                            from 'node:fs';
import path                          from 'node:path';
import {execFileSync}                from 'node:child_process';
import {createHash}                  from 'node:crypto';
import {performance}                 from 'node:perf_hooks';
import {fileURLToPath}               from 'node:url';
import {COMMUNITY_RESOURCE_FAMILIES} from '../../services/memory-core/communityCoverageContract.mjs';
import {isEntryModule}               from '../../services/shared/isEntryModule.mjs';

/**
 * @module ai/scripts/maintenance/observeCommunitySteward
 * @summary Finite co-located steward observations with exact scoped input/result custody and no dispatch capability.
 */

const PREFIX    = 'COMMUNITY_STEWARD_WINDOW_',
    POLICY_KEYS = ['stewardActivation', 'stewardLeaseTtlMs', 'wakeCoalesceWindowMs',
        'vacancyFallbackCooldownMs', 'minUnclaimedEligibleCount', 'wakeAmplificationCap', 'maxWakePayloadBytes'],
    entrypoint = fileURLToPath(import.meta.url),
    repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * @summary Parses only explicit operator scope, finite sampling controls and report custody.
 * @param {String[]} argv Operator arguments.
 * @returns {Object} Explicit choices without runtime loading.
 */
export function parseArgs(argv) {
    const args = {tenantId: null, sourceInstanceIds: [], samples: null, intervalMs: null,
        output: null, vacancyFallbackPrincipal: null, help: false},
        fields = {'--tenant-id': 'tenantId', '--samples': 'samples', '--interval-ms': 'intervalMs',
            '--output': 'output', '--vacancy-fallback-principal': 'vacancyFallbackPrincipal'};
    const supplied = new Set();
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--help' || flag === '-h') { args.help = true; continue }
        if (!fields[flag] && flag !== '--source-instance-id') throw new Error(`${PREFIX}UNKNOWN_ARGUMENT`);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${PREFIX}ARGUMENT_VALUE_REQUIRED`);
        if (flag === '--source-instance-id') args.sourceInstanceIds.push(value);
        else {
            if (supplied.has(flag)) throw new Error(`${PREFIX}DUPLICATE_ARGUMENT`);
            supplied.add(flag);
            args[fields[flag]] = ['samples', 'intervalMs'].includes(fields[flag]) ? Number(value) : value;
        }
    }
    return args
}

/**
 * @summary Rejects incomplete or non-finite choices before runtime imports or report creation.
 * @param {Object} args Parsed operator arguments.
 * @returns {String[]} Validation failures.
 */
export function validateArgs(args) {
    const errors = [], identifier = value => typeof value === 'string' && /^\S+$/.test(value);
    if (!identifier(args.tenantId)) errors.push('--tenant-id is required and must contain no whitespace.');
    if (!Array.isArray(args.sourceInstanceIds) || !args.sourceInstanceIds.length ||
        args.sourceInstanceIds.some(id => !identifier(id))) errors.push('--source-instance-id is required.');
    if (!Number.isSafeInteger(args.samples) || args.samples < 1) errors.push('--samples must be an explicit positive safe integer.');
    if (!Number.isSafeInteger(args.intervalMs) || args.intervalMs < 0 || args.intervalMs > 2_147_483_647) {
        errors.push('--interval-ms must be an explicit non-negative integer within the Node timer range.');
    }
    if (!Number.isSafeInteger((args.samples - 1) * args.intervalMs)) errors.push('The requested observation horizon must be a safe integer.');
    if (typeof args.output !== 'string' || !path.isAbsolute(args.output)) errors.push('--output must name a fresh absolute file path.');
    if (args.vacancyFallbackPrincipal !== null &&
        (!/^steward:[^:\s]+:[^:\s]+$/.test(args.vacancyFallbackPrincipal) ||
            args.vacancyFallbackPrincipal.split(':')[1] !== args.tenantId)) {
        errors.push('--vacancy-fallback-principal must name one steward in the selected tenant.');
    }
    return errors
}

/** @summary Reserves one new regular file, refusing symlink ancestors and existing destinations before storage loads. */
function reserveReport(output) {
    const absolute = path.resolve(output), parent = path.dirname(absolute), parsed = path.parse(parent);
    let   current  = parsed.root;
    for (const segment of parent.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${PREFIX}UNSAFE_OUTPUT`);
    }
    const parentBefore = fs.statSync(parent);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        const parentAfter = fs.lstatSync(parent), file = fs.fstatSync(fd), named = fs.lstatSync(absolute);
        if (parentAfter.isSymbolicLink() || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino ||
            !file.isFile() || file.nlink !== 1 || file.dev !== named.dev || file.ino !== named.ino) {
            throw new Error(`${PREFIX}UNSAFE_OUTPUT`)
        }
        return {fd, absolute}
    } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        throw error
    }
}

/** @summary Loads process collaborators only after finite arguments and exclusive output custody are established. */
async function loadRuntime() {
    await import('dotenv/config');
    await import('neo.mjs/src/Neo.mjs');
    await import('neo.mjs/src/core/_export.mjs');
    await import('neo.mjs/src/manager/Instance.mjs');
    const config = (await import('../../mcp/server/memory-core/config.mjs')).default;
    const policy = await import('../../services/memory-core/communityStewardWakeLease.mjs');
    policySnapshot(policy.resolveValidatedStewardWakePolicy);
    const [activity, context] = await Promise.all([
        import('../../services/memory-core/CommunityActivityService.mjs'),
        import('../../mcp/server/shared/services/RequestContextService.mjs')
    ]);
    return {activity: activity.default, context: context.default, readPolicy: policy.resolveValidatedStewardWakePolicy,
        unitTestStore: config.storagePaths.useUnitTestDatabase, testStore: config.storagePaths.useTestDatabase}
}

/** @summary Records the actual caller process and checkout without claiming it is a remote served process. */
function callerProvenance() {
    let sourceRevision = null, sourceDirty = null;
    try {
        const git = args => execFileSync('git', args, {cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
        sourceRevision = git(['rev-parse', 'HEAD']);
        sourceDirty = Boolean(git(['status', '--porcelain']));
    } catch { /* Unknown checkout provenance remains explicit. */ }
    const sourceFiles = [entrypoint, fileURLToPath(new URL('../../services/memory-core/CommunityActivityService.mjs', import.meta.url)),
        fileURLToPath(new URL('../../services/memory-core/communityStewardWakeLease.mjs', import.meta.url))].map(file => {
        try {
            const bytes = fs.readFileSync(file);
            return {path: file, status: 'measured', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')}
        } catch { return {path: file, status: 'unknown', bytes: null, sha256: null, reason: 'file-unavailable'} }
    });
    let packagedRevision = {status: 'unknown', reason: 'revision-marker-unavailable', revision: null};
    try {
        const bytes = fs.readFileSync(path.join(repoRoot, '.neo-revision')), revision = bytes.toString('utf8').trim();
        packagedRevision = {status: /^[a-f0-9]{40}$/.test(revision) ? 'measured' : 'invalid',
            revision: /^[a-f0-9]{40}$/.test(revision) ? revision : null,
            bytes   : bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
    } catch { /* A checkout need not carry a packaged runtime marker. */ }
    return {kind: 'co-located-process', entrypoint, nodeVersion: process.version, executable: process.execPath,
        platform: process.platform, architecture: process.arch, sourceRevision, sourceDirty, packagedRevision, sourceFiles}
}

/** @summary Requires exactly the selected ACTIVE source generations and qualified three-family admitted-ledger coverage. */
function completeSources(counts, selected) {
    const sources = counts?.sources, coverage = counts?.coverage;
    if (!Array.isArray(sources) || sources.length !== selected.length || new Set(selected).size !== selected.length ||
        new Set(sources.map(source => source.sourceInstanceId)).size !== selected.length) return false;
    return coverage?.basis === 'admitted-ledger' && coverage.degraded === false &&
        coverage.sourceCount === selected.length && coverage.activeSourceCount === selected.length &&
        coverage.completeSourceCount === selected.length && sources.every(source => selected.includes(source.sourceInstanceId) &&
            Number.isSafeInteger(source.registrationEpoch) && source.registrationEpoch > 0 && source.lifecycleState === 'ACTIVE' &&
            Array.isArray(source.families) && source.families.length === COMMUNITY_RESOURCE_FAMILIES.length &&
            new Set(source.families.map(family => family.resourceFamily)).size === COMMUNITY_RESOURCE_FAMILIES.length &&
            source.families.every(family => COMMUNITY_RESOURCE_FAMILIES.includes(family.resourceFamily) && family.qualified === true))
}

/**
 * @summary Classifies a complete source-bound window; fresh zero demand is evidence, unavailable coverage is not.
 * @param {Object} report Retained caller, scope, policy and observation evidence.
 * @returns {String} Fixture, insufficient, or source-bound window classification.
 */
export function classifyWindow(report) {
    if (['injected-runtime-fixture', 'isolated-test-ledger-fixture'].includes(report.evidenceClass)) return 'fixture-only';
    const selected = report.scope?.sourceInstanceIds, observations = report.observations ?? [];
    if (report.evidenceClass !== 'co-located-ledger-observation' || report.testStore !== false ||
        report.status !== 'completed' || !selected?.length || !observations.length ||
        observations.length !== report.denominator?.requested || observations.length !== report.denominator?.recorded) return 'insufficient-evidence';
    const generations = new Set();
    for (const row of observations) {
        const counts = row.attentionCounts;
        if (!completeSources(counts, selected) || counts.notAuthority !== true || row.policyStable !== true ||
            row.policy?.mode !== 'shadow' || row.policy.stewardActivation !== false ||
            JSON.stringify(row.policy) !== JSON.stringify(row.policyAfter) ||
            JSON.stringify(row.policy) !== JSON.stringify(report.policy) ||
            row.evaluation?.mode !== 'shadow' || row.evaluation.shouldWake !== false ||
            !Number.isSafeInteger(counts.count) || (counts.status === 'fresh' ? counts.count <= 0 :
                counts.status !== 'empty' || counts.count !== 0)) return 'insufficient-evidence';
        generations.add(JSON.stringify(counts.sources.map(source => [source.sourceInstanceId, source.registrationEpoch]).sort()));
    }
    return generations.size === 1 ? 'source-bound-window-observed' : 'insufficient-evidence'
}

/**
 * @summary Derives sample-based metrics only from explicit evaluator fields; absent fields stay unavailable.
 * @param {Object[]} observations Retained input/result pairs.
 * @returns {Object} Measurements with explicit observed denominators and unknowns.
 */
export function summarizeObservations(observations) {
    const values      = key => observations.map(row => row.evaluation?.[key]),
        booleanMetric = key => {
            const known = values(key).filter(value => typeof value === 'boolean'), numerator = known.filter(value => value).length;
            return {observedDenominator: known.length, unknownObservations: observations.length - known.length,
                numerator: known.length ? numerator : null, fraction: known.length ? numerator / known.length : null}
        },
        bytes = values('payloadBytes').filter(value => Number.isSafeInteger(value) && value >= 0),
        total = bytes.reduce((sum, value) => sum + value, 0);
    return {basis: 'retained-evaluator-fields', recordedObservations: observations.length,
        vacancy     : booleanMetric('stewardVacant'), wouldWake: booleanMetric('shadowWouldWake'),
        payloadBytes: {observedDenominator: bytes.length, unknownObservations: observations.length - bytes.length,
            total: bytes.length ? total : null, min: bytes.length ? bytes.reduce((min, value) => Math.min(min, value)) : null,
            max  : bytes.length ? bytes.reduce((max, value) => Math.max(max, value)) : null, mean: bytes.length ? total / bytes.length : null}}
}

/** @summary Rejects prose, credentials and lease proofs rather than silently retaining a filtered replacement input. */
function copyMetadata(value) {
    const inspect = input => {
        if (!input || typeof input !== 'object') return;
        for (const [key, child] of Object.entries(input)) {
            if (/token|secret|password|credential|^(?:title|body|excerpt|prose|summary|html|url|holderProof)$/i.test(key)) {
                throw new Error(`${PREFIX}NON_METADATA_RESULT`)
            }
            inspect(child);
        }
    };
    inspect(value);
    return JSON.parse(JSON.stringify(value))
}

/** @summary Reads canonical policy without changing leaves or accepting a caller policy override. */
function policySnapshot(readPolicy) {
    const policy = readPolicy();
    if (policy.stewardActivation !== false || policy.mode !== 'shadow') throw new Error(`${PREFIX}LIVE_ACTIVATION_REFUSED`);
    return Object.fromEntries(['mode', ...POLICY_KEYS].map(key => [key, policy[key]]))
}

/** @summary Makes retained failures typed and bounded; provider text, paths and secrets never become error evidence. */
function failureCode(error) {
    return /^COMMUNITY_[A-Z0-9_]+/.exec(String(error?.message ?? ''))?.[0] ?? `${PREFIX}OBSERVATION_FAILED`
}

/** @summary Writes only the file reserved by this invocation; completed samples survive a later observation failure. */
function retain(fd, report) {
    const bytes  = Buffer.from(JSON.stringify(report, null, 2) + '\n');
    let   offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    fs.ftruncateSync(fd, bytes.length);
    fs.fsyncSync(fd)
}

/**
 * @summary Runs one finite deployment-owned observation window through the existing service; each retained input is
 * the snapshot consumed by that same service evaluation. Acquiring sources, leases, Tasks or dispatch is absent.
 * @param {Object} options Explicit args; runtimeLoader, now and sleep are hermetic test seams.
 * @returns {Promise<Object>} Retained report; collection completion never closes the parent outcome.
 */
export async function runOperatorWindow({args, runtimeLoader = loadRuntime, now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
    if (validateArgs(args).length) throw new Error(`${PREFIX}ARGUMENTS_INVALID`);
    const output          = reserveReport(args.output), startedMs = now(), monotonicStart = performance.now(),
        sourceInstanceIds = [...new Set(args.sourceInstanceIds)].sort(),
        report            = {schemaVersion: 'community-steward-shadow-window.v1', status: 'running',
            evidenceClass: runtimeLoader === loadRuntime ? 'runtime-unresolved' : 'injected-runtime-fixture',
            testStore    : null, unitTestStore: null, testStoreBasis: 'memoryCoreConfig.storagePaths.useTestDatabase',
            caller       : callerProvenance(), scope: {tenantId: args.tenantId, sourceInstanceIds},
            controls     : {samples: args.samples, intervalMs: args.intervalMs},
            clockBasis   : {timestamps: 'UTC epoch milliseconds', elapsed: 'performance.now monotonic milliseconds'},
            startedAt    : new Date(startedMs).toISOString(), finishedAt: null, elapsedMs: null,
            observations : [], denominator: {requested: args.samples, attempted: 0, recorded: 0, freshDemand: 0,
                empty: 0, missing: 0, degraded: 0}, sourceGenerationChanges: 0,
            zeroDispatch: {kind: 'command-capability-invariant', scope: 'this-command',
                forbiddenCapabilities: ['source-registration', 'source-admission', 'lease-acquisition', 'task-claim', 'message-dispatch'],
                evidence             : 'retained-shadow-evaluations-and-service-no-effect-tests',
                hostWideDispatchCount: null, hostWideDispatchCountReason: 'not-measured'},
            unavailableMetrics: {leaseOccupancy: {value: null, reason: 'lease-occupancy-window-not-measured'},
                timeToAcknowledgeMs: {value: null, reason: 'not-observed'},
                timeToClaimMs      : {value: null, reason: 'not-observed'}, timeToRespondMs: {value: null, reason: 'not-observed'}},
            windowEvidence: 'not-completed', summary: summarizeObservations([]), failure: null};
    let baselineGeneration = null;
    try {
        retain(output.fd, report);
        const {activity, context, readPolicy, testStore, unitTestStore} = await runtimeLoader();
        report.testStore = typeof testStore === 'boolean' ? testStore : null;
        report.unitTestStore = typeof unitTestStore === 'boolean' ? unitTestStore : null;
        report.evidenceClass = runtimeLoader !== loadRuntime ? 'injected-runtime-fixture' :
            testStore === true ? 'isolated-test-ledger-fixture' :
                testStore === false ? 'co-located-ledger-observation' : 'runtime-unresolved';
        report.policy = policySnapshot(readPolicy);
        for (let index = 0; index < args.samples; index++) {
            if (index) await sleep(args.intervalMs);
            const observedMs = now(), observedMonotonic = performance.now(), policy = policySnapshot(readPolicy);
            report.denominator.attempted++;
            const observation = await context.run({userId: args.tenantId}, () => activity.observeStewardWake({
                sourceInstanceIds, now: observedMs,
                vacancyFallbackTarget: args.vacancyFallbackPrincipal === null ? null : args.vacancyFallbackPrincipal
            }));
            const policyAfter                 = policySnapshot(readPolicy), value = copyMetadata(observation),
                {attentionCounts, evaluation} = value;
            if (!attentionCounts || attentionCounts.notAuthority !== true || !evaluation ||
                evaluation.mode !== 'shadow' || evaluation.shouldWake !== false) throw new Error(`${PREFIX}INVALID_SHADOW_RESULT`);
            if (!Array.isArray(attentionCounts.sources) || attentionCounts.sources.some(source =>
                !sourceInstanceIds.includes(source.sourceInstanceId)) ||
                (evaluation.wakePayload?.tenantId !== undefined && evaluation.wakePayload.tenantId !== args.tenantId)) {
                throw new Error(`${PREFIX}SOURCE_SCOPE_MISMATCH`)
            }
            const generation = JSON.stringify(attentionCounts.sources.map(source =>
                [source.sourceInstanceId, source.registrationEpoch, source.lifecycleState]).sort()),
                generationChanged = baselineGeneration !== null && generation !== baselineGeneration,
                generationComplete = completeSources(attentionCounts, sourceInstanceIds),
                policyStable = JSON.stringify(policy) === JSON.stringify(policyAfter) &&
                    JSON.stringify(policy) === JSON.stringify(report.policy);
            baselineGeneration ??= generation;
            if (generationChanged) report.sourceGenerationChanges++;
            report.observations.push({index, observedAt: new Date(observedMs).toISOString(),
                elapsedMs: observedMonotonic - monotonicStart, durationMs: performance.now() - observedMonotonic, policy, policyAfter,
                policyStable, sourceGenerationChanged: generationChanged, sourceGenerationComplete: generationComplete,
                bytes: {attentionCounts: Buffer.byteLength(JSON.stringify(attentionCounts), 'utf8'),
                    evaluation : Buffer.byteLength(JSON.stringify(evaluation), 'utf8'),
                    wakePayload: evaluation.payloadBytes ?? null}, attentionCounts, evaluation});
            report.denominator.recorded++;
            const status = attentionCounts.status;
            if (status === 'fresh' && Number.isSafeInteger(attentionCounts.count) && attentionCounts.count > 0) report.denominator.freshDemand++;
            else if (['empty', 'missing', 'degraded'].includes(status)) report.denominator[status]++;
            report.summary = summarizeObservations(report.observations);
            retain(output.fd, report);
        }
        report.status = 'completed';
    } catch (error) {
        report.status = report.denominator.recorded ? 'partial' : 'failed';
        report.failure = {code: failureCode(error)};
    } finally {
        const finishedMs = now();
        report.finishedAt = new Date(finishedMs).toISOString();
        report.elapsedMs = performance.now() - monotonicStart;
        report.summary = summarizeObservations(report.observations);
        report.windowEvidence = classifyWindow(report);
        try { retain(output.fd, report) } finally { fs.closeSync(output.fd) }
    }
    return {...report, reportPath: output.absolute}
}

/**
 * @summary Collection completion is distinct from fresh-demand evidence; partial and failed runs exit nonzero.
 * @param {Object} report Final retained outcome.
 * @returns {Number} Process exit code.
 */
export function resolveExitCode(report) {
    return report?.status === 'completed' ? 0 : 1
}

/**
 * @summary Implements help and validation without loading runtime storage, then emits a count-only report handle.
 * @param {String[]} [argv] Operator arguments; defaults to this process's argv.
 * @returns {Promise<Number>} Process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
    let args;
    try { args = parseArgs(argv) }
    catch { console.error(`${PREFIX}ARGUMENTS_INVALID`); return 2 }
    if (args.help) {
        console.log(`Usage: node ai/scripts/maintenance/observeCommunitySteward.mjs --tenant-id <tenant>
  --source-instance-id <id> [--source-instance-id <id>]... --samples <count>
  --interval-ms <milliseconds> --output <fresh-absolute-file>
  [--vacancy-fallback-principal steward:<tenant>:<seat>]
Finite co-located shadow observation only. No source admission, lease acquisition, Task claim or dispatch.
Use existing source-control/reconciliation commands separately. Exit 0: collected; 1: partial/failed; 2: invalid input.`);
        return 0
    }
    const errors = validateArgs(args);
    if (errors.length) { errors.forEach(error => console.error(error)); return 2 }
    try {
        const report = await runOperatorWindow({args});
        console.log(JSON.stringify({status: report.status, reportPath: report.reportPath,
            denominator: report.denominator, windowEvidence: report.windowEvidence}));
        return resolveExitCode(report)
    } catch { console.error(`${PREFIX}FAILED`); return 1 }
}

if (isEntryModule(import.meta.url)) {
    main().then(code => { process.exitCode = code }).catch(() => { process.exitCode = 1 })
}
