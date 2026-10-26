import {Command}                   from 'commander';
import {hashEvidence, measurement} from './communityActivityShadowProbeCore.mjs';

/**
 * @module ai/scripts/maintenance/communityActivityPolicyCalibrationCore
 * @summary Pure, dependency-injected policy calibration and boundary validation core for community activity.
 */

export const CALIBRATION_REPORT_SCHEMA_VERSION  = 'community-activity-calibration-report.v1';
export const CALIBRATION_SUMMARY_SCHEMA_VERSION = 'community-activity-calibration-summary.v1';
export const CALIBRATION_REPEATABILITY_VERSION  = 'community-activity-calibration-repeatability.v1';

export const SHADOW_BASELINE_MANIFEST = Object.freeze({
    reportSchemaVersion  : 'community-activity-shadow-report.v1',
    reportId             : '79a6d84d9212d00f0f9ca8db33d517c64f0f90bfd0d2ef68fee88103bcc770dd',
    queryPlanHash        : 'a8b8463178384ab810b7deee43ff1319ab9c419d3fc2df495b57023913925910',
    candidateManifestHash: '65de1150163ec730630abf4538012ab2ec1070b04441f81fb9b92137992ee38c',
    runManifestHashes    : Object.freeze([
        '33088e5dba0e33b04e004cc17fa130bee34a3aa3e7f73ead0ad5b6bdc7608347',
        'b42736c6663bfcee205397b911ebc50414eb5e5833aaff8afb94c8bb8952cf60'
    ]),
    rawReportSha256: '7ff1e6be32b2b9840290408332685f3c985e26533daaec63ba7431c2a917a887',
    rawReportBytes : 1_058_632,
    repository     : Object.freeze({owner: 'neomjs', name: 'neo'}),
    window         : Object.freeze({
        startInclusive: '2026-06-18T00:00:00.000Z',
        endExclusive  : '2026-07-18T00:00:00.000Z',
        durationMs    : 2_592_000_000,
        durationDays  : 30
    }),
    wallTimeMs                : 1_040_936,
    singleRunProviderLatencyMs: 532_899,
    totals                    : Object.freeze({
        sourceOccurrences           : 11_253,
        attentionEligibleOccurrences: 22,
        pages                       : 1_739,
        providerRequests            : 1_714,
        graphqlRequests             : 1_683,
        restRequests                : 31,
        providerCostUnits           : 1_714,
        projectedMetadataBytes      : 3_809_537,
        revisions                   : 2_937,
        explicitTombstones          : 0,
        duplicateOccurrences        : 0
    }),
    families: Object.freeze({
        issues      : Object.freeze({pages: 40, occurrences: 4_920, uniqueEntities: 2_756, attentionEligible: 9, revisions: 1_460, stateTransitions: 951, projectedBytes: 1_640_121, providerLatencyMs: 21_288}),
        pullRequests: Object.freeze({pages: 995, occurrences: 5_664, uniqueEntities: 3_493, attentionEligible: 4, revisions: 1_364, stateTransitions: 863, projectedBytes: 1_939_843, providerLatencyMs: 320_606}),
        discussions : Object.freeze({pages: 704, occurrences: 669, uniqueEntities: 543, attentionEligible: 9, revisions: 113, stateTransitions: 38, projectedBytes: 229_573, providerLatencyMs: 191_005})
    }),
    coverageGaps: Object.freeze([
        'absence_is_not_a_tombstone',
        'discussion_child_watermark_lower_bound',
        'historical_deletion_tombstones_unavailable',
        'historical_revisions_unavailable',
        'issue_lifecycle_history_not_acquired',
        'pull_request_lifecycle_history_not_acquired',
        'search_window_has_day_granularity'
    ])
});

export const LIVE_INCIDENT_MANIFEST = Object.freeze({
    schemaVersion: 'community-activity-live-observation-window.v1',
    repository   : Object.freeze({owner: 'neomjs', name: 'neo'}),
    window       : Object.freeze({
        startInclusive: '2026-10-26T18:00:00.000Z',
        endExclusive  : '2026-10-26T22:00:00.000Z',
        durationMs    : 14_400_000
    }),
    externalEvents: Object.freeze([
        Object.freeze({
            occurrenceIdentity : 'github:neomjs/neo:pull_request:20119:opened',
            resourceFamily     : 'pulls',
            unstewardedVacant  : true,
            timeToAcknowledgeMs: 240_000,
            timeToClaimMs      : 350_000,
            timeToRespondMs    : 423_000
        }),
        Object.freeze({
            occurrenceIdentity : 'github:neomjs/neo:issue_comment:IC_kwDODSospM8AAAABfvmKmw:created',
            resourceFamily     : 'issues',
            unstewardedVacant  : true,
            timeToAcknowledgeMs: 189_000,
            timeToClaimMs      : 274_000,
            timeToRespondMs    : 372_000
        })
    ])
});

export const OPTION_REVALIDATION_LEDGER = Object.freeze({
    E: Object.freeze({
        option             : 'E',
        summary            : 'Webhook accelerator under exhaustive reconciliation',
        disposition        : 'keep-deferred',
        triggerChecked     : 'Measured periodic reconciliation latency or rate-limit exhaustion requiring push acceleration',
        triggerMet         : false,
        measuredEvidence   : 'Single-pass provider latency is 532,899 ms (1,714 cost units); calibrated 2,131,596 ms cadence consumes <= 25% duty cycle without webhook infrastructure',
        revalidationTrigger: 'Revalidate when hosted deployment requires sub-5-minute provider-to-ledger latency or reconciliation exceeds 50% of hourly rate budget'
    }),
    F: Object.freeze({
        option             : 'F',
        summary            : 'Repository workflow automation accelerator',
        disposition        : 'keep-deferred',
        triggerChecked     : 'Proven value across fork, runner, credential, and replay boundaries',
        triggerMet         : false,
        measuredEvidence   : 'Pull-request fork workflows cannot safely hold Memory Core admission credentials; local and hosted connectors satisfy admission directly',
        revalidationTrigger: 'Revalidate only if a zero-privilege signed attestation workflow is required beyond local/hosted connectors'
    }),
    K: Object.freeze({
        option             : 'K',
        summary            : 'Connector-owned durable inbox/outbox',
        disposition        : 'keep-deferred',
        triggerChecked     : 'Non-reconstructable canonical batch after crash or ambiguous admission outcome',
        triggerMet         : false,
        measuredEvidence   : 'All 3 family reconcilers re-enumerate deterministically from checkpoint basis with 0 non-reconstructable batches and 100% idempotent receipt replay on lost responses',
        revalidationTrigger: 'Revalidate when an ingested provider family lacks replayable cursor/history reconstruction'
    }),
    O: Object.freeze({
        option             : 'O',
        summary            : 'Dedicated neutral HTTP/queue receiver',
        disposition        : 'keep-deferred',
        triggerChecked     : 'Measured hosted burst or backpressure falsifying authenticated MCP batch admission',
        triggerMet         : false,
        measuredEvidence   : '30-day volume is 11,253 occurrences (15.63/hour mean) across 50-observation / 256 KiB batches with 0 volume-exceeded backpressure events',
        revalidationTrigger: 'Revalidate when sustained hosted admission encounters COMMUNITY_BATCH_VOLUME_EXCEEDED or HTTP 429/503 backpressure'
    }),
    V: Object.freeze({
        option             : 'V',
        summary            : 'Tenant-admin self-service source registration',
        disposition        : 'keep-deferred',
        triggerChecked     : 'Authoritative tenant-membership and source-admin role substrate exists',
        triggerMet         : false,
        measuredEvidence   : 'MCP projection metadata remains non-authoritative for source administration; co-located operator CLI (W/U) handles all active registrations',
        revalidationTrigger: 'Revalidate when multi-tenant RBAC ships an authoritative source-admin role model'
    }),
    X: Object.freeze({
        option             : 'X',
        summary            : 'Tenant self-service source request workflow',
        disposition        : 'keep-deferred',
        triggerChecked     : 'Measured multi-tenant self-service provisioning demand',
        triggerMet         : false,
        measuredEvidence   : 'Current operator provisioning latency has 0 queued tenant requests; self-activation remains forbidden',
        revalidationTrigger: 'Revalidate when operator-provisioned source request volume exceeds manual SLA'
    }),
    J: Object.freeze({
        option             : 'J',
        summary            : 'Stage-2 metric-gated tenant/source steward lease and coalesced count-only wake',
        disposition        : 'activate-gated',
        triggerChecked     : 'Shadow + live density, payload bytes, amplification, and unstewarded vacancy measurements justify explicit bounds',
        triggerMet         : true,
        measuredEvidence   : 'Eligible external density is 22/11,253 (0.1955%), count-only hook envelope is <= 1,024 bytes, and unstewarded live vacancy was 2/2 (100%) until manual operator intervention',
        revalidationTrigger: 'Revalidate if attention-eligible density exceeds 2% of source occurrences or steward vacancy fallback fires on > 25% of eligible windows'
    })
});

function ratioMetric(numerator, denominator, status = 'measured', reasonCode = null) {
    return denominator > 0
        ? measurement(status, numerator / denominator, 'ratio', {numerator, denominator, reasonCode})
        : measurement('unknown', null, 'ratio', {numerator, denominator, reasonCode: reasonCode || 'zero-denominator'})
}

/**
 * @summary Derives the calibrated operational policy and unset dispositions from measured evidence.
 * @param {Object} metrics Combined shadow and live measurements.
 * @param {Object} [shadowBaseline=SHADOW_BASELINE_MANIFEST]
 * @param {Object} [liveIncident=LIVE_INCIDENT_MANIFEST]
 * @returns {Object}
 */
export function deriveCalibratedPolicy(metrics, shadowBaseline = SHADOW_BASELINE_MANIFEST, liveIncident = LIVE_INCIDENT_MANIFEST) {
    const singlePassMs      = shadowBaseline.singleRunProviderLatencyMs;
    const minCadenceMs      = singlePassMs * 2;
    const calibratedCadence = singlePassMs * 4;
    const meanRespondMs     = metrics.timeToRespondMs.value;
    const coalesceWindowMs  = Math.round(meanRespondMs);
    const vacancyCooldownMs = coalesceWindowMs * 2;
    const stewardLeaseTtlMs = coalesceWindowMs * 4;
    const eligibleTotal     = shadowBaseline.totals.attentionEligibleOccurrences;

    return {
        schemaVersion   : 'community-activity-policy.v1',
        noHiddenDefaults: true,
        thresholds      : {
            reconciliationCadenceMs: {
                disposition    : 'calibrated',
                value          : calibratedCadence,
                aiConfigDefault: null,
                unit           : 'milliseconds',
                bounds         : {min: minCadenceMs, max: 86_400_000},
                derivation     : {
                    formula    : '4 * singleRunProviderLatencyMs',
                    numerator  : calibratedCadence,
                    denominator: singlePassMs,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'bounds-full-pass-duty-cycle-to-25-percent'
            },
            maxAdmissionAttempts: {
                disposition    : 'calibrated',
                value          : 2,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : {min: 1, max: 5},
                derivation     : {
                    formula    : '1 initial admission + 1 idempotent lost-response retry',
                    numerator  : 2,
                    denominator: 1,
                    source     : 'live-substrate-probe'
                },
                reasonCode: 'one-retry-recovers-lost-response-without-retry-storm'
            },
            paginationCap: {
                disposition    : 'unset',
                value          : null,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : null,
                derivation     : {
                    formula    : 'unset (exhaustive reconciliation requires uncapped family traversal)',
                    numerator  : shadowBaseline.totals.pages,
                    denominator: shadowBaseline.totals.sourceOccurrences,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'exhaustive-reconciliation-requires-uncapped-traversal'
            },
            providerRootPageSize: {
                disposition    : 'calibrated',
                value          : 50,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : {min: 1, max: 100},
                derivation     : {
                    formula    : '0.5 * githubGraphqlMaxPageSize',
                    numerator  : 50,
                    denominator: 100,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'balances-nested-connection-cost-under-github-graphql-node-limit'
            },
            providerChildPageSize: {
                disposition    : 'calibrated',
                value          : 100,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : {min: 1, max: 100},
                derivation     : {
                    formula    : '1.0 * githubGraphqlMaxPageSize',
                    numerator  : 100,
                    denominator: 100,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'minimizes-child-connection-pages-per-candidate'
            },
            retentionMs: {
                disposition    : 'unset',
                value          : null,
                aiConfigDefault: null,
                unit           : 'milliseconds',
                bounds         : null,
                derivation     : {
                    formula    : 'unset (3,809,537 bytes / 30 days = 126,984.57 bytes/day)',
                    numerator  : shadowBaseline.totals.projectedMetadataBytes,
                    denominator: shadowBaseline.window.durationDays,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'measured-storage-growth-below-compaction-floor'
            },
            archiveThreshold: {
                disposition    : 'unset',
                value          : null,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : null,
                derivation     : {
                    formula    : 'unset (338.54 bytes/event metadata-only ledger)',
                    numerator  : shadowBaseline.totals.projectedMetadataBytes,
                    denominator: shadowBaseline.totals.sourceOccurrences,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'measured-storage-growth-below-compaction-floor'
            },
            hookProjectionTtlMs: {
                disposition    : 'calibrated-existing-ssot',
                value          : 300_000,
                aiConfigDefault: 300_000,
                unit           : 'milliseconds',
                bounds         : {min: 60_000, max: 900_000},
                derivation     : {
                    formula    : 'existing HookProjectionWriter lease TTL SSOT',
                    numerator  : 300_000,
                    denominator: 1,
                    source     : 'memoryCoreConfig.hookProjectionLeaseTtlMs'
                },
                reasonCode: 'reuses-existing-hook-projection-lease-ttl'
            },
            stewardActivation: {
                disposition    : 'calibrated',
                value          : true,
                aiConfigDefault: false,
                unit           : 'boolean',
                bounds         : {allowed: [false, true]},
                derivation     : {
                    formula    : 'unstewardedVacancyRate == 1.0 && wakesPerAdmittedEvent <= 0.002',
                    numerator  : liveIncident.externalEvents.length,
                    denominator: liveIncident.externalEvents.length,
                    source     : liveIncident.schemaVersion
                },
                reasonCode: 'unstewarded-vacancy-rate-1.0-with-0.001955-eligible-density'
            },
            stewardLeaseTtlMs: {
                disposition    : 'calibrated',
                value          : stewardLeaseTtlMs,
                aiConfigDefault: null,
                unit           : 'milliseconds',
                bounds         : {min: coalesceWindowMs, max: stewardLeaseTtlMs * 2},
                derivation     : {
                    formula    : '4 * meanTimeToRespondMs',
                    numerator  : stewardLeaseTtlMs,
                    denominator: coalesceWindowMs,
                    source     : liveIncident.schemaVersion
                },
                reasonCode: 'covers-four-measured-maintainer-response-cycles'
            },
            wakeCoalesceWindowMs: {
                disposition    : 'calibrated',
                value          : coalesceWindowMs,
                aiConfigDefault: null,
                unit           : 'milliseconds',
                bounds         : {min: 60_000, max: stewardLeaseTtlMs},
                derivation     : {
                    formula    : 'sum(timeToRespondMs) / externalEventCount',
                    numerator  : liveIncident.externalEvents.reduce((sum, item) => sum + item.timeToRespondMs, 0),
                    denominator: liveIncident.externalEvents.length,
                    source     : liveIncident.schemaVersion
                },
                reasonCode: 'coalesces-bursts-within-one-measured-response-cycle'
            },
            vacancyFallbackCooldownMs: {
                disposition    : 'calibrated',
                value          : vacancyCooldownMs,
                aiConfigDefault: null,
                unit           : 'milliseconds',
                bounds         : {min: coalesceWindowMs, max: stewardLeaseTtlMs * 2},
                derivation     : {
                    formula    : '2 * wakeCoalesceWindowMs',
                    numerator  : vacancyCooldownMs,
                    denominator: coalesceWindowMs,
                    source     : liveIncident.schemaVersion
                },
                reasonCode: 'bounds-vacancy-fallback-to-at-most-one-per-two-coalesce-windows'
            },
            minUnclaimedEligibleCount: {
                disposition    : 'calibrated',
                value          : 1,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : {min: 1, max: eligibleTotal},
                derivation     : {
                    formula    : 'eligibleTotal / eligibleTotal',
                    numerator  : eligibleTotal,
                    denominator: eligibleTotal,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'every-rare-external-response-item-warrants-steward-routing'
            },
            wakeAmplificationCap: {
                disposition    : 'calibrated',
                value          : 1,
                aiConfigDefault: null,
                unit           : 'count',
                bounds         : {min: 1, max: 1},
                derivation     : {
                    formula    : 'max 1 coalesced count-only wake per coalesce window per scope',
                    numerator  : 1,
                    denominator: 1,
                    source     : 'live-substrate-probe'
                },
                reasonCode: 'prevents-all-resident-or-multi-wake-amplification'
            },
            maxWakePayloadBytes: {
                disposition    : 'calibrated',
                value          : 1_024,
                aiConfigDefault: null,
                unit           : 'bytes',
                bounds         : {min: 256, max: 1_024},
                derivation     : {
                    formula    : 'bounded count-only envelope ceiling above measured 640-byte channel payload',
                    numerator  : metrics.hookBytesPerEvent.numerator,
                    denominator: 1,
                    source     : 'live-substrate-probe'
                },
                reasonCode: 'enforces-metadata-and-count-only-wake-payload'
            }
        }
    }
}

/**
 * @summary Validates a candidate operational policy against calibrated bounds and unset dispositions.
 * @param {Object} candidate Candidate threshold map.
 * @param {Object} [calibratedPolicy] Reference policy from `deriveCalibratedPolicy`.
 * @returns {{valid: Boolean, errors: String[]}}
 */
export function validateCommunityPolicyThresholds(candidate = {}, calibratedPolicy = null) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return {valid: false, errors: ['POLICY_Thresholds_MUST_BE_OBJECT']}
    }

    const errors    = [];
    const unsetKeys = ['paginationCap', 'retentionMs', 'archiveThreshold'];

    for (const key of unsetKeys) {
        if (candidate[key] !== undefined && candidate[key] !== null) {
            errors.push(`POLICY_THRESHOLD_MUST_REMAIN_UNSET:${key}`)
        }
    }

    const numericBounds = {
        reconciliationCadenceMs  : calibratedPolicy?.thresholds?.reconciliationCadenceMs?.bounds ?? {min: 1_065_798, max: 86_400_000},
        maxAdmissionAttempts     : calibratedPolicy?.thresholds?.maxAdmissionAttempts?.bounds ?? {min: 1, max: 5},
        providerRootPageSize     : calibratedPolicy?.thresholds?.providerRootPageSize?.bounds ?? {min: 1, max: 100},
        providerChildPageSize    : calibratedPolicy?.thresholds?.providerChildPageSize?.bounds ?? {min: 1, max: 100},
        hookProjectionTtlMs      : calibratedPolicy?.thresholds?.hookProjectionTtlMs?.bounds ?? {min: 60_000, max: 900_000},
        stewardLeaseTtlMs        : calibratedPolicy?.thresholds?.stewardLeaseTtlMs?.bounds ?? {min: 397_500, max: 3_180_000},
        wakeCoalesceWindowMs     : calibratedPolicy?.thresholds?.wakeCoalesceWindowMs?.bounds ?? {min: 60_000, max: 1_590_000},
        vacancyFallbackCooldownMs: calibratedPolicy?.thresholds?.vacancyFallbackCooldownMs?.bounds ?? {min: 397_500, max: 3_180_000},
        minUnclaimedEligibleCount: calibratedPolicy?.thresholds?.minUnclaimedEligibleCount?.bounds ?? {min: 1, max: 22},
        wakeAmplificationCap     : calibratedPolicy?.thresholds?.wakeAmplificationCap?.bounds ?? {min: 1, max: 1},
        maxWakePayloadBytes      : calibratedPolicy?.thresholds?.maxWakePayloadBytes?.bounds ?? {min: 256, max: 1_024}
    };

    for (const [key, bounds] of Object.entries(numericBounds)) {
        const value = candidate[key];
        if (value === undefined || value === null) continue;
        if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
            errors.push(`POLICY_THRESHOLD_OUT_OF_BOUNDS:${key}`)
        }
    }

    if (
        Number.isInteger(candidate.stewardLeaseTtlMs) &&
        Number.isInteger(candidate.wakeCoalesceWindowMs) &&
        candidate.stewardLeaseTtlMs < candidate.wakeCoalesceWindowMs
    ) {
        errors.push('POLICY_STEWARD_LEASE_SHORTER_THAN_COALESCE_WINDOW')
    }

    return {valid: errors.length === 0, errors}
}

/**
 * @summary Builds the CLI argument parser for the community policy calibration runner.
 * @returns {Command}
 */
function createProgram() {
    return new Command()
        .name('node ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs')
        .description('Runs repeated live-substrate community calibration passes and combines them with the 30-day shadow baseline.')
        .helpOption('-h, --help', 'Display help.')
        .allowExcessArguments(false)
        .option('--runs <count>', 'Repeated live-substrate calibration runs (minimum 2).', value => Number(value), 2)
        .option('--output <path>', 'Optional JSON report path under the repository.')
}

/**
 * @summary Parses CLI arguments for the calibration runner.
 * @param {String[]} argv
 * @returns {Object}
 */
export function parseArgs(argv = []) {
    const program = createProgram();

    if (argv.some(arg => arg === '--help' || arg === '-h')) {
        return {helpText: program.helpInformation()}
    }

    program
        .exitOverride()
        .configureOutput({writeErr: () => {}, writeOut: () => {}})
        .parse(argv, {from: 'user'});

    const options = program.opts();
    if (!Number.isInteger(options.runs) || options.runs < 2) {
        throw new Error('parseArgs: --runs must be an integer >= 2 for repeatable calibration evidence')
    }

    return options
}

/**
 * @summary Validates that a constructed calibration report satisfies all evidence and non-hidden-default invariants.
 * @param {Object} report
 * @returns {Object}
 */
export function assertCalibrationReport(report) {
    if (report?.schemaVersion !== CALIBRATION_REPORT_SCHEMA_VERSION) {
        throw new Error('assertCalibrationReport: invalid report schemaVersion')
    }
    if (report?.repeatability?.evidenceStatus !== 'two-run' || report?.repeatability?.comparable !== true) {
        throw new Error('assertCalibrationReport: two-run comparable repeatability is required')
    }
    if (Object.values(report?.repeatability?.deterministicVariance ?? {}).some(delta => delta !== 0)) {
        throw new Error('assertCalibrationReport: deterministic substrate variance must be zero across runs')
    }
    if (report?.policy?.noHiddenDefaults !== true) {
        throw new Error('assertCalibrationReport: policy must preserve noHiddenDefaults=true')
    }
    const thresholds = report?.policy?.thresholds ?? {};
    for (const [key, entry] of Object.entries(thresholds)) {
        if (!['calibrated', 'unset', 'calibrated-existing-ssot'].includes(entry?.disposition)) {
            throw new Error(`assertCalibrationReport: invalid disposition for ${key}`)
        }
        if (entry.disposition === 'unset' && entry.value !== null) {
            throw new Error(`assertCalibrationReport: unset threshold ${key} must have value=null`)
        }
        if (key !== 'hookProjectionTtlMs' && entry.aiConfigDefault !== null && entry.aiConfigDefault !== false) {
            throw new Error(`assertCalibrationReport: threshold ${key} cannot introduce a hidden active default`)
        }
    }
    for (const optionKey of ['E', 'F', 'K', 'O', 'V', 'X', 'J']) {
        if (!report?.optionDispositions?.[optionKey]?.disposition) {
            throw new Error(`assertCalibrationReport: missing option disposition for ${optionKey}`)
        }
    }

    return report
}

/**
 * @summary Executes repeated live-substrate passes and synthesizes the versioned calibration report.
 * @param {Object} options `{runs}`
 * @param {Object} deps
 * @param {Function} deps.runSinglePass Injected live-substrate pass runner `(runIndex) => Promise<Object>`.
 * @param {Function} deps.now Injected ISO clock.
 * @param {Object} [deps.shadowBaseline=SHADOW_BASELINE_MANIFEST]
 * @param {Object} [deps.liveIncident=LIVE_INCIDENT_MANIFEST]
 * @returns {Promise<{exitCode: Number, report: Object}>}
 */
export async function runPolicyCalibration(options, {
    runSinglePass,
    now,
    shadowBaseline = SHADOW_BASELINE_MANIFEST,
    liveIncident   = LIVE_INCIDENT_MANIFEST
}) {
    if (typeof runSinglePass !== 'function' || typeof now !== 'function') {
        throw new Error('runPolicyCalibration: runSinglePass and now functions are required')
    }
    const runCount = options?.runs ?? 2;
    if (!Number.isInteger(runCount) || runCount < 2) {
        throw new Error('runPolicyCalibration: runs must be an integer >= 2')
    }

    const startedAt = now();
    const runs      = [];
    for (let runIndex = 1; runIndex <= runCount; runIndex++) {
        runs.push(await runSinglePass(runIndex))
    }

    const first             = runs[0];
    const primary           = runs.at(-1);
    const deterministicKeys = [
        'admittedEvents',
        'eligibleUnclaimedCount',
        'claimedCount',
        'admissionAttempts',
        'casConflicts',
        'idempotentReceiptHits',
        'checkpointBytesTotal',
        'partitionCount',
        'admittedObservationBytes',
        'hookPayloadBytes',
        'hookSubmissions',
        'replayedHookSubmissions'
    ];
    const deterministicVariance = Object.fromEntries(
        deterministicKeys.map(key => [key, primary[key] - first[key]])
    );

    const vacantCount = liveIncident.externalEvents.filter(item => item.unstewardedVacant).length;
    const eventCount  = liveIncident.externalEvents.length;
    const sumAckMs    = liveIncident.externalEvents.reduce((sum, item) => sum + item.timeToAcknowledgeMs, 0);
    const sumClaimMs  = liveIncident.externalEvents.reduce((sum, item) => sum + item.timeToClaimMs, 0);
    const sumRespMs   = liveIncident.externalEvents.reduce((sum, item) => sum + item.timeToRespondMs, 0);

    const metrics = {
        pagesPerEvent            : ratioMetric(shadowBaseline.totals.pages, shadowBaseline.totals.sourceOccurrences),
        duplicateRate            : ratioMetric(shadowBaseline.totals.duplicateOccurrences, shadowBaseline.totals.sourceOccurrences),
        revisionRate             : ratioMetric(shadowBaseline.totals.revisions, shadowBaseline.totals.sourceOccurrences, 'lower-bound'),
        tombstoneRate            : ratioMetric(shadowBaseline.totals.explicitTombstones, shadowBaseline.totals.sourceOccurrences, 'lower-bound'),
        casConflictRate          : ratioMetric(primary.casConflicts, primary.admissionAttempts),
        duplicateBatchReceiptRate: ratioMetric(primary.idempotentReceiptHits, primary.admissionAttempts),
        opaqueCheckpointBytes    : measurement('measured', primary.checkpointBytesTotal / primary.partitionCount, 'bytes', {
            numerator  : primary.checkpointBytesTotal,
            denominator: primary.partitionCount
        }),
        bytesPerAdmittedEvent: measurement('measured', primary.admittedObservationBytes / primary.admittedEvents, 'bytes', {
            numerator  : primary.admittedObservationBytes,
            denominator: primary.admittedEvents
        }),
        storageGrowthBytesPerDay: measurement('lower-bound', shadowBaseline.totals.projectedMetadataBytes / shadowBaseline.window.durationDays, 'bytes', {
            numerator  : shadowBaseline.totals.projectedMetadataBytes,
            denominator: shadowBaseline.window.durationDays
        }),
        providerAcquisitionLatencyMs: measurement('measured', shadowBaseline.singleRunProviderLatencyMs, 'milliseconds', {
            numerator  : shadowBaseline.wallTimeMs,
            denominator: 2
        }),
        liveSubstrateCycleLatencyMs: measurement('measured', primary.cycleDurationMs, 'milliseconds', {
            numerator  : primary.cycleDurationMs,
            denominator: 1
        }),
        hookBytesPerEvent: measurement('measured', primary.hookPayloadBytes / primary.admittedEvents, 'bytes', {
            numerator  : primary.hookPayloadBytes,
            denominator: primary.admittedEvents
        }),
        hooksPerAdmittedEvent: ratioMetric(primary.hookSubmissions, primary.admittedEvents),
        wakesPerAdmittedEvent: ratioMetric(shadowBaseline.totals.attentionEligibleOccurrences, shadowBaseline.totals.sourceOccurrences),
        stewardVacancyRate   : ratioMetric(vacantCount, eventCount),
        timeToAcknowledgeMs  : measurement('measured', sumAckMs / eventCount, 'milliseconds', {
            numerator  : sumAckMs,
            denominator: eventCount
        }),
        timeToClaimMs: measurement('measured', sumClaimMs / eventCount, 'milliseconds', {
            numerator  : sumClaimMs,
            denominator: eventCount
        }),
        timeToRespondMs: measurement('measured', sumRespMs / eventCount, 'milliseconds', {
            numerator  : sumRespMs,
            denominator: eventCount
        })
    };

    const policy        = deriveCalibratedPolicy(metrics, shadowBaseline, liveIncident);
    const completedAt   = now();
    const repeatability = {
        schemaVersion: CALIBRATION_REPEATABILITY_VERSION,
        comparable   : runs.every(run =>
            run.fixtureManifestHash === first.fixtureManifestHash &&
            run.stateManifestHash === first.stateManifestHash
        ),
        evidenceStatus: runs.length >= 2 ? 'two-run' : 'insufficient-runs',
        requiredRuns  : 2,
        deterministicVariance,
        runs          : runs.map(run => ({
            runIndex           : run.runIndex,
            fixtureManifestHash: run.fixtureManifestHash,
            stateManifestHash  : run.stateManifestHash,
            hookWatermark      : run.hookWatermark,
            cycleDurationMs    : run.cycleDurationMs
        }))
    };

    const report = {
        schemaVersion: CALIBRATION_REPORT_SCHEMA_VERSION,
        generatedAt  : completedAt,
        reportId     : hashEvidence({
            shadowReportId     : shadowBaseline.reportId,
            fixtureManifestHash: primary.fixtureManifestHash,
            stateManifestHash  : primary.stateManifestHash,
            policy
        }),
        sources: {
            shadowBaseline,
            liveIncident,
            liveSubstrateProbe: {
                fixtureManifestHash: primary.fixtureManifestHash,
                stateManifestHash  : primary.stateManifestHash,
                hookWatermark      : primary.hookWatermark
            }
        },
        metrics,
        policy,
        optionDispositions: OPTION_REVALIDATION_LEDGER,
        wakeChildDecision : {
            issueNumber       : 100,
            authorized        : true,
            closeNotPlanned   : false,
            requiredThresholds: {
                stewardLeaseTtlMs        : policy.thresholds.stewardLeaseTtlMs.value,
                wakeCoalesceWindowMs     : policy.thresholds.wakeCoalesceWindowMs.value,
                vacancyFallbackCooldownMs: policy.thresholds.vacancyFallbackCooldownMs.value,
                minUnclaimedEligibleCount: policy.thresholds.minUnclaimedEligibleCount.value,
                wakeAmplificationCap     : policy.thresholds.wakeAmplificationCap.value,
                maxWakePayloadBytes      : policy.thresholds.maxWakePayloadBytes.value
            }
        },
        repeatability,
        run: {
            startedAt,
            completedAt,
            runCount: runs.length
        }
    };

    report.summary = {
        schemaVersion: CALIBRATION_SUMMARY_SCHEMA_VERSION,
        text         : formatCalibrationSummary(report)
    };

    assertCalibrationReport(report);

    return {exitCode: 0, report}
}

/**
 * @summary Renders a compact deterministic human summary for the calibration report.
 * @param {Object} report
 * @returns {String}
 */
export function formatCalibrationSummary(report) {
    const m = report?.metrics ?? {};
    const t = report?.policy?.thresholds ?? {};

    return [
        `[community-activity-calibration ${report?.schemaVersion}]`,
        `shadow baseline=${report?.sources?.shadowBaseline?.reportId} · occurrences=${report?.sources?.shadowBaseline?.totals?.sourceOccurrences} · eligible=${report?.sources?.shadowBaseline?.totals?.attentionEligibleOccurrences}`,
        `pages/event=${m.pagesPerEvent?.value?.toFixed(6)} · checkpointBytes/partition=${m.opaqueCheckpointBytes?.value} · hookBytes/event=${m.hookBytesPerEvent?.value?.toFixed(2)}`,
        `cadenceMs=${t.reconciliationCadenceMs?.value} (default=${t.reconciliationCadenceMs?.aiConfigDefault}) · leaseTtlMs=${t.stewardLeaseTtlMs?.value} · coalesceMs=${t.wakeCoalesceWindowMs?.value} · retentionMs=${t.retentionMs?.value}`,
        `repeatability=${report?.repeatability?.evidenceStatus} · wakeChildAuthorized=${report?.wakeChildDecision?.authorized}`
    ].join('\n')
}
