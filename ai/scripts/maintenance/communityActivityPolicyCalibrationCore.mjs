import {Command}                   from 'commander';
import {hashEvidence, measurement} from './communityActivityShadowProbeCore.mjs';

/**
 * @module ai/scripts/maintenance/communityActivityPolicyCalibrationCore
 * @summary Pure, dependency-injected policy calibration core for community activity.
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
        summary            : 'shadow-only steward experiment authorized; activation thresholds unset until its window',
        disposition        : 'shadow-only steward experiment authorized; activation thresholds unset until its window',
        triggerChecked     : 'Shadow steward experiment measures steward vacancy, time-to-ack/claim/respond, and wake-cost before live wake activation',
        triggerMet         : false,
        measuredEvidence   : '30-day eligible external density is 22/11,253 (0.1955%); two unstewarded 2026-10-26 contributions (neomjs/neo#20119 by drakeboley, opened 06:00:05Z -> first comment 13:00:33Z; neomjs/neo#19129#issuecomment-6425153408 by SimonGebru, posted 19:18:05Z -> first reply 19:22:58Z) motivate running the shadow steward experiment in #100 before selecting activation thresholds',
        revalidationTrigger: 'Revalidate activation thresholds after the shadow steward experiment in #100 records a retained vacancy and response-latency window'
    })
});

function ratioMetric(numerator, denominator, status = 'measured', reasonCode = null) {
    return denominator > 0
        ? measurement(status, numerator / denominator, 'ratio', {numerator, denominator, reasonCode})
        : measurement('unknown', null, 'ratio', {numerator, denominator, reasonCode: reasonCode || 'zero-denominator'})
}

function unsetThreshold(unit, formula, source, reasonCode, {
    aiConfigDefault = null,
    denominator     = null,
    numerator       = null
} = {}) {
    return {
        disposition: 'unset',
        value      : null,
        aiConfigDefault,
        unit,
        derivation : {
            formula,
            numerator,
            denominator,
            source
        },
        reasonCode
    }
}

/**
 * @summary Derives the calibrated operational policy and unset dispositions from retained shadow evidence.
 * @param {Object} [_metrics]
 * @param {Object} [shadowBaseline=SHADOW_BASELINE_MANIFEST]
 * @returns {Object}
 */
export function deriveCalibratedPolicy(_metrics = {}, shadowBaseline = SHADOW_BASELINE_MANIFEST) {
    const singlePassMs      = shadowBaseline.singleRunProviderLatencyMs;
    const calibratedCadence = singlePassMs * 4;

    return {
        schemaVersion   : 'community-activity-policy.v1',
        noHiddenDefaults: true,
        thresholds      : {
            reconciliationCadenceMs: {
                disposition    : 'calibrated',
                value          : calibratedCadence,
                aiConfigDefault: null,
                unit           : 'milliseconds',
                derivation     : {
                    formula    : '4 * singleRunProviderLatencyMs',
                    numerator  : calibratedCadence,
                    denominator: singlePassMs,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'bounds-full-pass-duty-cycle-to-25-percent'
            },
            maxAdmissionAttempts: unsetThreshold(
                'count',
                'unset (no retained live provider admission conflict/retry window measured yet)',
                shadowBaseline.reportId,
                'insufficient-live-conflict-evidence-leaves-value-unset'
            ),
            paginationCap: unsetThreshold(
                'count',
                'unset (exhaustive reconciliation requires uncapped family traversal)',
                shadowBaseline.reportId,
                'exhaustive-reconciliation-requires-uncapped-traversal',
                {
                    numerator  : shadowBaseline.totals.pages,
                    denominator: shadowBaseline.totals.sourceOccurrences
                }
            ),
            providerRootPageSize: {
                disposition    : 'calibrated',
                value          : 50,
                aiConfigDefault: null,
                unit           : 'count',
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
                derivation     : {
                    formula    : '1.0 * githubGraphqlMaxPageSize',
                    numerator  : 100,
                    denominator: 100,
                    source     : shadowBaseline.reportId
                },
                reasonCode: 'minimizes-child-connection-pages-per-candidate'
            },
            retentionMs: unsetThreshold(
                'milliseconds',
                'unset (3,809,537 bytes / 30 days = 126,984.57 bytes/day)',
                shadowBaseline.reportId,
                'measured-storage-growth-below-compaction-floor',
                {
                    numerator  : shadowBaseline.totals.projectedMetadataBytes,
                    denominator: shadowBaseline.window.durationDays
                }
            ),
            archiveThreshold: unsetThreshold(
                'count',
                'unset (338.54 bytes/event metadata-only ledger)',
                shadowBaseline.reportId,
                'measured-storage-growth-below-compaction-floor',
                {
                    numerator  : shadowBaseline.totals.projectedMetadataBytes,
                    denominator: shadowBaseline.totals.sourceOccurrences
                }
            ),
            stewardActivation: unsetThreshold(
                'boolean',
                'unset (shadow-only steward experiment authorized; activation awaits measured vacancy and wake-cost window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation',
                {aiConfigDefault: false}
            ),
            stewardLeaseTtlMs: unsetThreshold(
                'milliseconds',
                'unset (awaiting shadow steward experiment vacancy and response-latency window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation'
            ),
            wakeCoalesceWindowMs: unsetThreshold(
                'milliseconds',
                'unset (awaiting shadow steward experiment wake-cost and burst-coalescing window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation'
            ),
            vacancyFallbackCooldownMs: unsetThreshold(
                'milliseconds',
                'unset (awaiting shadow steward experiment vacancy-fallback window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation'
            ),
            minUnclaimedEligibleCount: unsetThreshold(
                'count',
                'unset (awaiting shadow steward experiment wake-threshold window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation'
            ),
            wakeAmplificationCap: unsetThreshold(
                'count',
                'unset (awaiting shadow steward experiment amplification window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation'
            ),
            maxWakePayloadBytes: unsetThreshold(
                'bytes',
                'unset (awaiting shadow steward experiment payload-size window)',
                shadowBaseline.reportId,
                'steward-experiment-shadow-only-before-activation'
            )
        }
    }
}

/**
 * @summary Builds the CLI argument parser for the community policy calibration runner.
 * @returns {Command}
 */
function createProgram() {
    return new Command()
        .name('node ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs')
        .description('Runs repeated deterministic calibration passes and combines them with the 30-day shadow baseline.')
        .helpOption('-h, --help', 'Display help.')
        .allowExcessArguments(false)
        .option('--runs <count>', 'Repeated calibration fixture runs (minimum 2).', value => Number(value), 2)
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
    if (report?.repeatability?.evidenceStatus !== 'two-run-fixture-determinism' || report?.repeatability?.comparable !== true) {
        throw new Error('assertCalibrationReport: two-run comparable fixture determinism is required')
    }
    if (Object.values(report?.repeatability?.deterministicVariance ?? {}).some(delta => delta !== 0)) {
        throw new Error('assertCalibrationReport: deterministic substrate variance must be zero across runs')
    }
    if (report?.policy?.noHiddenDefaults !== true) {
        throw new Error('assertCalibrationReport: policy must preserve noHiddenDefaults=true')
    }
    const thresholds = report?.policy?.thresholds ?? {};
    for (const [key, entry] of Object.entries(thresholds)) {
        if (!['calibrated', 'unset'].includes(entry?.disposition)) {
            throw new Error(`assertCalibrationReport: invalid disposition for ${key}`)
        }
        if (entry.disposition === 'unset' && entry.value !== null) {
            throw new Error(`assertCalibrationReport: unset threshold ${key} must have value=null`)
        }
        if (entry.aiConfigDefault !== null && entry.aiConfigDefault !== false) {
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
 * @summary Executes repeated deterministic fixture passes and synthesizes the versioned calibration report.
 * @param {Object} options `{runs}`
 * @param {Object} deps
 * @param {Function} deps.runSinglePass Injected fixture pass runner `(runIndex) => Promise<Object>`.
 * @param {Function} deps.now Injected ISO clock.
 * @param {Object} [deps.shadowBaseline=SHADOW_BASELINE_MANIFEST]
 * @returns {Promise<{exitCode: Number, report: Object}>}
 */
export async function runPolicyCalibration(options, {
    runSinglePass,
    now,
    shadowBaseline = SHADOW_BASELINE_MANIFEST
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

    const familyLatencySumMs =
        shadowBaseline.families.issues.providerLatencyMs +
        shadowBaseline.families.pullRequests.providerLatencyMs +
        shadowBaseline.families.discussions.providerLatencyMs;

    const metrics = {
        pagesPerEvent            : ratioMetric(shadowBaseline.totals.pages, shadowBaseline.totals.sourceOccurrences),
        duplicateRate            : ratioMetric(shadowBaseline.totals.duplicateOccurrences, shadowBaseline.totals.sourceOccurrences),
        revisionRate             : ratioMetric(shadowBaseline.totals.revisions, shadowBaseline.totals.sourceOccurrences, 'lower-bound'),
        tombstoneRate            : ratioMetric(shadowBaseline.totals.explicitTombstones, shadowBaseline.totals.sourceOccurrences, 'lower-bound'),
        casConflictRate          : ratioMetric(primary.casConflicts, primary.admissionAttempts, 'fixture', 'injected-stale-basis-batch'),
        duplicateBatchReceiptRate: ratioMetric(primary.idempotentReceiptHits, primary.admissionAttempts, 'fixture', 'injected-lost-response-replay'),
        opaqueCheckpointBytes    : measurement('fixture', primary.checkpointBytesTotal / primary.partitionCount, 'bytes', {
            numerator  : primary.checkpointBytesTotal,
            denominator: primary.partitionCount,
            reasonCode : 'deterministic-fixture-checkpoint-rows'
        }),
        bytesPerAdmittedEvent: measurement('fixture', primary.admittedObservationBytes / primary.admittedEvents, 'bytes', {
            numerator  : primary.admittedObservationBytes,
            denominator: primary.admittedEvents,
            reasonCode : 'deterministic-fixture-observation-rows'
        }),
        storageGrowthBytesPerDay: measurement('lower-bound', shadowBaseline.totals.projectedMetadataBytes / shadowBaseline.window.durationDays, 'bytes', {
            numerator  : shadowBaseline.totals.projectedMetadataBytes,
            denominator: shadowBaseline.window.durationDays
        }),
        providerAcquisitionLatencyMs: measurement('measured', familyLatencySumMs, 'milliseconds', {
            numerator  : familyLatencySumMs,
            denominator: 1,
            reasonCode : 'sum-of-per-family-single-pass-provider-latencies'
        }),
        liveSubstrateCycleLatencyMs: measurement('fixture', primary.cycleDurationMs, 'milliseconds', {
            numerator  : primary.cycleDurationMs,
            denominator: 1,
            reasonCode : 'deterministic-fixture-sqlite-cycle'
        }),
        hookBytesPerEvent: measurement('fixture', primary.hookPayloadBytes / primary.admittedEvents, 'bytes', {
            numerator  : primary.hookPayloadBytes,
            denominator: primary.admittedEvents,
            reasonCode : 'deterministic-fixture-attention-envelope'
        }),
        hooksPerAdmittedEvent: ratioMetric(primary.hookSubmissions, primary.admittedEvents, 'fixture', 'deterministic-fixture-watermark-fence'),
        wakesPerAdmittedEvent: ratioMetric(shadowBaseline.totals.attentionEligibleOccurrences, shadowBaseline.totals.sourceOccurrences),
        stewardVacancyRate   : measurement('unknown', null, 'ratio', {
            reasonCode: 'steward_experiment_not_yet_run'
        }),
        timeToAcknowledgeMs: measurement('unknown', null, 'milliseconds', {
            reasonCode: 'steward_experiment_not_yet_run'
        }),
        timeToClaimMs: measurement('unknown', null, 'milliseconds', {
            reasonCode: 'steward_experiment_not_yet_run'
        }),
        timeToRespondMs: measurement('unknown', null, 'milliseconds', {
            reasonCode: 'steward_experiment_not_yet_run'
        })
    };

    const policy        = deriveCalibratedPolicy(metrics, shadowBaseline);
    const completedAt   = now();
    const repeatability = {
        schemaVersion: CALIBRATION_REPEATABILITY_VERSION,
        comparable   : runs.every(run =>
            run.fixtureManifestHash === first.fixtureManifestHash &&
            run.stateManifestHash === first.stateManifestHash
        ),
        evidenceStatus: runs.length >= 2 ? 'two-run-fixture-determinism' : 'insufficient-runs',
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
            fixtureDeterminism: {
                fixtureManifestHash: primary.fixtureManifestHash,
                stateManifestHash  : primary.stateManifestHash,
                hookWatermark      : primary.hookWatermark
            }
        },
        metrics,
        policy,
        optionDispositions: OPTION_REVALIDATION_LEDGER,
        wakeChildDecision : {
            issueNumber         : 100,
            mode                : 'shadow-only',
            disposition         : 'shadow-only steward experiment authorized; activation thresholds unset until its window',
            authorized          : true,
            activationAuthorized: false,
            closeNotPlanned     : false,
            requiredThresholds  : {
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
        `pages/event=${m.pagesPerEvent?.value?.toFixed(6)} · providerLatencyMs=${m.providerAcquisitionLatencyMs?.value} · fixtureCheckpointBytes/partition=${m.opaqueCheckpointBytes?.value}`,
        `cadenceMs=${t.reconciliationCadenceMs?.value} (default=${t.reconciliationCadenceMs?.aiConfigDefault}) · leaseTtlMs=${t.stewardLeaseTtlMs?.value} · coalesceMs=${t.wakeCoalesceWindowMs?.value} · retentionMs=${t.retentionMs?.value}`,
        `repeatability=${report?.repeatability?.evidenceStatus} · wakeChildMode=${report?.wakeChildDecision?.mode} · activationAuthorized=${report?.wakeChildDecision?.activationAuthorized}`
    ].join('\n')
}
