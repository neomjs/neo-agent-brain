# Community Activity Operational Policy Calibration (2026-10-26)

- **Status:** Recorded (empirical calibration evidence for `neomjs/neo-agent-brain#3` and shadow-experiment gate decision for `neomjs/neo-agent-brain#100`)
- **Date:** 2026-10-26
- **Governing Authority:** [ADR 0036](../decisions/0036-durable-community-activity-authority.md) (§2.6, §3, §4 Gate 3, §5 Phase 8, §6 Reopen Triggers, §9 Operational Calibration)
- **Shadow Baseline Input:** [`community-activity-shadow-2026-07-18.md`](./community-activity-shadow-2026-07-18.md) (`reportId: 79a6d84d9212d00f0f9ca8db33d517c64f0f90bfd0d2ef68fee88103bcc770dd`)
- **Calibration Runner:** `node ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs --runs 2`
- **Pure Calibration Core:** `ai/scripts/maintenance/communityActivityPolicyCalibrationCore.mjs`

## 1. Fixture Determinism & Evidence Identity (`AC1`, `AC2`)

| Field | Value |
|---|---|
| `schemaVersion` | `community-activity-calibration-report.v1` |
| `reportId` | `dd78a28718cf0db9a526876c271053c674e713c9dc4b0fe99882f410ee7f2664` |
| Shadow baseline `reportId` | `79a6d84d9212d00f0f9ca8db33d517c64f0f90bfd0d2ef68fee88103bcc770dd` |
| Shadow `queryPlanHash` | `a8b8463178384ab810b7deee43ff1319ab9c419d3fc2df495b57023913925910` |
| Shadow `candidateManifestHash` | `65de1150163ec730630abf4538012ab2ec1070b04441f81fb9b92137992ee38c` |
| Fixture `fixtureManifestHash` | `bf9b7dec6276ca8089f56fc8804a7e9007dac332acb6d2b7d900d5c123349a04` |
| Fixture `stateManifestHash` (`runIndex: 1` & `2`) | `bb6991c36962c6f73451be8219aabf9165212a81553b6ba7a71fe1a305d0a16e` |
| Repeatability status | `two-run-fixture-determinism` (`comparable: true`, `deterministicVariance: 0` across all 12 fixture substrate counters) |

## 2. Shadow Measurements, Fixture Determinism Checks & Unknown Slots (`AC1`)

Evidence classes are kept strictly separate so deterministic fixture checks never masquerade as live measurements or feed policy values:

1. **Retained 30-Day Shadow Baseline (`status: measured` / `lower-bound`):** Derived directly from [`community-activity-shadow-2026-07-18.md`](./community-activity-shadow-2026-07-18.md) (`reportId: 79a6d84d...`, `11,253` source occurrences, `22` attention-eligible items across `30` days). Note: `providerAcquisitionLatencyMs = 532,899 ms` is the sum of per-family single-pass provider latencies (`21,288 + 320,606 + 191,005 = 532,899 ms`), whereas the two-run probe wall time was `1,040,936 ms` (`520,468 ms` mean elapsed per run).
2. **Deterministic Substrate Fixture Checks (`status: fixture`):** Two identical runs of `executeLiveCalibrationPass` over an isolated temporary SQLite ledger verify deterministic checkpoint, observation, and count-projection byte sizes and replay/conflict handling (`stateManifestHash: bb6991c3...`). No policy threshold is derived from `status: fixture` entries.
3. **Steward & Response-Latency Slots (`status: unknown`):** Per [ADR 0036](../decisions/0036-durable-community-activity-authority.md) §5 (*"a steward experiment adds vacancy and wake-cost evidence"* in shadow-only mode before activation), `stewardVacancyRate`, `timeToAcknowledgeMs`, `timeToClaimMs`, and `timeToRespondMs` remain `unknown` (`value: null`, `reasonCode: steward_experiment_not_yet_run`) until the shadow steward experiment in `neomjs/neo-agent-brain#100` records a retained observation window. Two unstewarded external contributions on 2026-10-26 (`neomjs/neo#20119` by `drakeboley`, opened `06:00:05Z` with first maintainer comment at `13:00:33Z`; `neomjs/neo#19129#issuecomment-6425153408` by `SimonGebru`, posted `19:18:05Z` with first reply at `19:22:58Z`, `293 s`) motivate running that shadow experiment.

| Metric | Status | Value | Unit | Numerator | Denominator | Source / Basis |
|---|---|---:|---|---:|---:|---|
| `pagesPerEvent` | `measured` | `0.154537` | `ratio` | `1,739` | `11,253` | 30-day GitHub shadow baseline (`79a6d84d...`) |
| `duplicateRate` | `measured` | `0` | `ratio` | `0` | `11,253` | Canonical occurrence identity deduplication (`79a6d84d...`) |
| `revisionRate` | `lower-bound` | `0.260997` | `ratio` | `2,937` | `11,253` | Current-edit revision lower bound (`79a6d84d...`) |
| `tombstoneRate` | `lower-bound` | `0` | `ratio` | `0` | `11,253` | Explicit deletion tombstones only (`absence_is_not_a_tombstone`) |
| `storageGrowthBytesPerDay` | `lower-bound` | `126,984.57` | `bytes` | `3,809,537` | `30` | 30-day projected metadata-only ledger growth (`~3.63 MiB / 30 days`) |
| `providerAcquisitionLatencyMs` | `measured` | `532,899` | `milliseconds` | `532,899` | `1` | Sum of per-family single-pass provider latencies (`21,288 + 320,606 + 191,005 ms`) |
| `wakesPerAdmittedEvent` | `measured` | `0.001955` | `ratio` | `22` | `11,253` | 30-day attention-eligible density (`0.1955%`, upper bound on candidate wake density) |
| `casConflictRate` | `fixture` | `0.20` | `ratio` | `1` | `5` | Injected stale-basis batch rejection in deterministic fixture (`injected-stale-basis-batch`) |
| `duplicateBatchReceiptRate` | `fixture` | `0.20` | `ratio` | `1` | `5` | Injected lost-response batch replay in deterministic fixture (`injected-lost-response-replay`) |
| `opaqueCheckpointBytes` | `fixture` | `336.67` | `bytes` | `1,010` | `3` | Serialized `mc_community_checkpoint` rows in deterministic fixture |
| `bytesPerAdmittedEvent` | `fixture` | `335.00` | `bytes` | `1,340` | `4` | Serialized `mc_community_observation` rows in deterministic fixture |
| `liveSubstrateCycleLatencyMs` | `fixture` | `~15` | `milliseconds` | `15` | `1` | Single-pass SQLite fixture execution time (`deterministic-fixture-sqlite-cycle`) |
| `hookBytesPerEvent` | `fixture` | `445.25` | `bytes` | `1,781` | `4` | `community-attention.v1` count envelope in deterministic fixture (`1,781 bytes` total) |
| `hooksPerAdmittedEvent` | `fixture` | `0.25` | `ratio` | `1` | `4` | Watermark-fenced count projection in deterministic fixture |
| `stewardVacancyRate` | `unknown` | `null` | `ratio` | `null` | `null` | `steward_experiment_not_yet_run` (to be measured in `#100` shadow mode) |
| `timeToAcknowledgeMs` | `unknown` | `null` | `milliseconds` | `null` | `null` | `steward_experiment_not_yet_run` (to be measured in `#100` shadow mode) |
| `timeToClaimMs` | `unknown` | `null` | `milliseconds` | `null` | `null` | `steward_experiment_not_yet_run` (to be measured in `#100` shadow mode) |
| `timeToRespondMs` | `unknown` | `null` | `milliseconds` | `null` | `null` | `steward_experiment_not_yet_run` (to be measured in `#100` shadow mode) |

## 3. Calibrated Policy Thresholds & Explicit `unset` Dispositions (`AC2`, `AC4`, `AC6`)

Every calibrated value below is derived from the retained 30-day shadow baseline (`79a6d84d...`); every parameter whose evidence depends on live provider conflict rates or the `#100` shadow steward experiment remains explicitly `unset` (`value: null`, `noHiddenDefaults: true`). Per [ADR 0019](../decisions/0019-aiconfig-reactive-provider-ssot.md) and [ADR 0036](../decisions/0036-durable-community-activity-authority.md) (§4 Gate 3), `AiConfig` retains `null` / `false` disabled-by-default posture (`orchestrator.communityReconciliation.enabled = false`, `orchestrator.intervals.communityReconciliationMs = null`, `orchestrator.communityReconciliation.maxAdmissionAttempts = null`):

| Policy Parameter | Disposition | Calibrated Value | `AiConfig` Default | Formula & Measured Justification |
|---|---|---:|---:|---|
| `reconciliationCadenceMs` | `calibrated` | `2,131,596` ms | `null` | `4 * singleRunProviderLatencyMs` (`4 * 532,899 ms`), bounding full-pass provider duty cycle to `<= 25%` (`79a6d84d...`). |
| `maxAdmissionAttempts` | `unset` | `null` | `null` | `unset`: no retained live provider admission conflict/retry window has been measured yet; fixture replay is determinism-only. |
| `paginationCap` | `unset` | `null` | `null` | `unset`: exhaustive family reconciliation ([ADR 0036](../decisions/0036-durable-community-activity-authority.md) §2.1 `H`) forbids silent page truncation (`1,739` pages / `11,253` occurrences). |
| `providerRootPageSize` | `calibrated` | `50` | `null` | `0.5 * githubGraphqlMaxPageSize` (`50 / 100`), balancing nested child-connection cost under GitHub GraphQL node limits (`79a6d84d...`). |
| `providerChildPageSize` | `calibrated` | `100` | `null` | `1.0 * githubGraphqlMaxPageSize` (`100 / 100`), minimizing child-connection pagination passes per candidate (`79a6d84d...`). |
| `retentionMs` | `unset` | `null` | `null` | `unset`: 30-day metadata growth is `3,809,537 bytes` (`126,984.57 bytes/day`, `~44.2 MiB/year`), well below any SQLite compaction floor. |
| `archiveThreshold` | `unset` | `null` | `null` | `unset`: `338.54 bytes/event` metadata-only rows require no archival tier in v1. |
| `stewardActivation` | `unset` | `null` | `false` | `unset`: shadow-only steward experiment authorized in `#100`; live wake activation awaits its measured window. |
| `stewardLeaseTtlMs` | `unset` | `null` | `null` | `unset`: awaits `#100` shadow steward experiment vacancy and response-latency window. |
| `wakeCoalesceWindowMs` | `unset` | `null` | `null` | `unset`: awaits `#100` shadow steward experiment wake-cost and burst-coalescing window. |
| `vacancyFallbackCooldownMs` | `unset` | `null` | `null` | `unset`: awaits `#100` shadow steward experiment vacancy-fallback window. |
| `minUnclaimedEligibleCount` | `unset` | `null` | `null` | `unset`: awaits `#100` shadow steward experiment wake-threshold window. |
| `wakeAmplificationCap` | `unset` | `null` | `null` | `unset`: awaits `#100` shadow steward experiment amplification window. |
| `maxWakePayloadBytes` | `unset` | `null` | `null` | `unset`: awaits `#100` shadow steward experiment payload-size window. |

## 4. Deferred Option Revalidation Ledger (`AC3`, `AC5`, `AC8`)

Each deferred option in [ADR 0036](../decisions/0036-durable-community-activity-authority.md) (§3, §6) was evaluated against the measured baseline:

| Option | Summary | Disposition | Trigger Checked | Trigger Met? | Measured Evidence | Revalidation Trigger |
|---|---|---|---|---|---|---|
| **E** | Webhook accelerator under exhaustive reconciliation (`H`) | `keep-deferred` | Periodic reconciliation latency or rate-limit exhaustion requiring push acceleration | `false` | Single-pass provider latency is `532,899 ms` (`1,714` cost units); calibrated `2,131,596 ms` cadence consumes `<= 25%` duty cycle without webhook infrastructure. | Revalidate when hosted deployment requires sub-5-minute provider-to-ledger latency or reconciliation exceeds 50% of hourly rate budget. |
| **F** | Repository workflow automation accelerator | `keep-deferred` | Proven value across fork, runner, credential, and replay boundaries | `false` | Pull-request fork workflows cannot safely hold Memory Core admission credentials; local (`L`) and hosted (`M`) connectors satisfy admission directly. | Revalidate only if a zero-privilege signed attestation workflow is required beyond local/hosted connectors. |
| **K** | Connector-owned durable inbox/outbox | `keep-deferred` | Non-reconstructable canonical batch after crash or ambiguous admission outcome | `false` | All 3 GitHub family reconcilers re-enumerate deterministically from checkpoint basis with `0` non-reconstructable batches and `100%` idempotent receipt replay on lost responses. | Revalidate when an ingested provider family lacks replayable cursor/history reconstruction. |
| **O** | Dedicated neutral HTTP/queue receiver | `keep-deferred` | Measured hosted burst or backpressure falsifying authenticated MCP batch admission (`M`) | `false` | 30-day volume is `11,253` occurrences (`15.63/hour` mean) across `50`-observation / `256 KiB` batches with `0` `COMMUNITY_BATCH_VOLUME_EXCEEDED` events. | Revalidate when sustained hosted admission encounters `COMMUNITY_BATCH_VOLUME_EXCEEDED` or HTTP 429/503 backpressure. |
| **V** | Tenant-admin self-service source registration | `keep-deferred` | Authoritative tenant-membership and source-admin role substrate exists | `false` | MCP projection metadata remains non-authoritative for source administration; co-located operator CLI (`W`/`U`) handles all active registrations. | Revalidate when multi-tenant RBAC ships an authoritative source-admin role model. |
| **X** | Tenant self-service source request workflow | `keep-deferred` | Measured multi-tenant self-service provisioning demand | `false` | Current operator provisioning latency has `0` queued tenant requests; self-activation remains forbidden. | Revalidate when operator-provisioned source request volume exceeds manual SLA. |
| **J (Stage 2)** | shadow-only steward experiment authorized; activation thresholds unset until its window | `shadow-only steward experiment authorized; activation thresholds unset until its window` | Shadow steward experiment measures steward vacancy, time-to-ack/claim/respond, and wake-cost before live wake activation | `false` | 30-day eligible external density is `22 / 11,253` (`0.1955%`); two unstewarded 2026-10-26 contributions (`neomjs/neo#20119` by `drakeboley`, opened `06:00:05Z` -> first comment `13:00:33Z`; `neomjs/neo#19129#issuecomment-6425153408` by `SimonGebru`, posted `19:18:05Z` -> first reply `19:22:58Z`) motivate running the shadow steward experiment in `#100` before selecting activation thresholds. | Revalidate activation thresholds after the shadow steward experiment in `#100` records a retained vacancy and response-latency window. |

## 5. Gate Decision for `neomjs/neo-agent-brain#100` (`AC5`)

- **Decision:** **Shadow-only steward experiment authorized; activation thresholds remain `unset` until its window (`wakeChildDecision.mode = 'shadow-only'`, `authorized = true`, `activationAuthorized = false`, `closeNotPlanned = false`).**
- **Rationale:** Per [ADR 0036](../decisions/0036-durable-community-activity-authority.md) §5 (*"a steward experiment adds vacancy and wake-cost evidence"* in shadow-only mode before activation), two unstewarded external contributions on 2026-10-26 (`neomjs/neo#20119` by `drakeboley` and `neomjs/neo#19129#issuecomment-6425153408` by `SimonGebru`) combined with the 30-day attention-eligible density (`22 / 11,253 = 0.1955%`) justify running `#100` as a shadow-only steward experiment that records lease vacancy and would-be count-only wakes without emitting live wakes until a retained shadow window measures `stewardLeaseTtlMs`, `wakeCoalesceWindowMs`, `vacancyFallbackCooldownMs`, `minUnclaimedEligibleCount`, `wakeAmplificationCap`, and `maxWakePayloadBytes`.
