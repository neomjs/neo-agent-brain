# Community Activity Operational Policy Calibration (2026-10-26)

- **Status:** Recorded (empirical calibration evidence for `neomjs/neo-agent-brain#3` and gate decision for `neomjs/neo-agent-brain#100`)
- **Date:** 2026-10-26
- **Governing Authority:** [ADR 0036](../decisions/0036-durable-community-activity-authority.md) (§2.6, §3, §4 Gate 3, §5 Phase 8, §6 Reopen Triggers, §9 Operational Calibration)
- **Shadow Baseline Input:** [`community-activity-shadow-2026-07-18.md`](./community-activity-shadow-2026-07-18.md) (`reportId: 79a6d84d9212d00f0f9ca8db33d517c64f0f90bfd0d2ef68fee88103bcc770dd`)
- **Calibration Runner:** `node ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs --runs 2`
- **Pure Calibration Core:** `ai/scripts/maintenance/communityActivityPolicyCalibrationCore.mjs`
- **Scheduler Boundary Validator:** `ai/daemons/orchestrator/scheduling/communityReconciliation.mjs`

## 1. Repeatability & Evidence Identity (`AC1`, `AC2`)

| Field | Value |
|---|---|
| `schemaVersion` | `community-activity-calibration-report.v1` |
| `reportId` | `62f4d25f6ce7a5b6b28198f716aed78fc28c14c9fd94e9919e1322ea718e863d` |
| Shadow baseline `reportId` | `79a6d84d9212d00f0f9ca8db33d517c64f0f90bfd0d2ef68fee88103bcc770dd` |
| Shadow `queryPlanHash` | `a8b8463178384ab810b7deee43ff1319ab9c419d3fc2df495b57023913925910` |
| Shadow `candidateManifestHash` | `65de1150163ec730630abf4538012ab2ec1070b04441f81fb9b92137992ee38c` |
| Live-substrate `fixtureManifestHash` | `e6dd7b39a8bd87b04dd9dd4b5df6eda6694f5bd36f101780a7795c11b8dbe120` |
| Live-substrate `stateManifestHash` (`runIndex: 1` & `2`) | `f21fec867db27c9e3d9f97ac68f1557dd299f3a9f144c1e08315aaa79533b5e3` |
| Repeatability status | `two-run` (`comparable: true`, `deterministicVariance: 0` across all 12 substrate counters) |

## 2. Combined Shadow + Live-Substrate Measurements (`AC1`)

All 10 metric slots previously marked `unavailable` in [`community-activity-shadow-2026-07-18.md`](./community-activity-shadow-2026-07-18.md) (§4) are now populated from repeated live-substrate passes over `SourceRegistryService`, `CommunityBatchAdmissionService`, and `CommunityActivityService`, alongside the 2026-10-26 live external-contributor observation window (`neomjs/neo#20119` by `@drake-real` and `neomjs/neo#19129#issuecomment-6425153408` by `@SimonGebru`):

| Metric | Status | Value | Unit | Numerator | Denominator | Derivation / Basis |
|---|---|---:|---|---:|---:|---|
| `pagesPerEvent` | `measured` | `0.154537` | `ratio` | `1,739` | `11,253` | 30-day GitHub shadow baseline (`79a6d84d...`) |
| `duplicateRate` | `measured` | `0` | `ratio` | `0` | `11,253` | Canonical occurrence identity deduplication |
| `revisionRate` | `lower-bound` | `0.260997` | `ratio` | `2,937` | `11,253` | Current-edit revision lower bound |
| `tombstoneRate` | `lower-bound` | `0` | `ratio` | `0` | `11,253` | Explicit deletion tombstones only (`absence_is_not_a_tombstone`) |
| `casConflictRate` | `measured` | `0.20` | `ratio` | `1` | `5` | Injected stale-basis batch rejection over 5 admission attempts |
| `duplicateBatchReceiptRate` | `measured` | `0.20` | `ratio` | `1` | `5` | Idempotent lost-response batch replay over 5 admission attempts |
| `opaqueCheckpointBytes` | `measured` | `336.67` | `bytes` | `1,010` | `3` | Serialized `mc_community_checkpoint` rows across `issues`, `pulls`, `discussions` |
| `bytesPerAdmittedEvent` | `measured` | `335.00` | `bytes` | `1,340` | `4` | Serialized `mc_community_observation` rows in live SQLite ledger |
| `storageGrowthBytesPerDay` | `lower-bound` | `126,984.57` | `bytes` | `3,809,537` | `30` | 30-day projected metadata-only ledger growth (`~3.63 MiB / 30 days`) |
| `providerAcquisitionLatencyMs` | `measured` | `532,899` | `milliseconds` | `1,040,936` | `2` | Single-pass GitHub GraphQL + REST enumeration latency |
| `liveSubstrateCycleLatencyMs` | `measured` | `20` | `milliseconds` | `20` | `1` | In-process SQLite admission + claim + count projection cycle |
| `hookBytesPerEvent` | `measured` | `445.25` | `bytes` | `1,781` | `4` | `community-attention.v1` count envelope (`1,781 bytes` total across 4 admitted events) |
| `hooksPerAdmittedEvent` | `measured` | `0.25` | `ratio` | `1` | `4` | Watermark-fenced channel submission (`replayed` on `markSeen`) |
| `wakesPerAdmittedEvent` | `measured` | `0.001955` | `ratio` | `22` | `11,253` | 30-day attention-eligible density (`0.1955%`) |
| `stewardVacancyRate` | `measured` | `1.00` | `ratio` | `2` | `2` | Unstewarded vacancy on `neo#20119` and `neo#19129#issuecomment-6425153408` prior to manual operator prompt |
| `timeToAcknowledgeMs` | `measured` | `214,500` | `milliseconds` | `429,000` | `2` | Mean maintainer acknowledgment latency (`240,000 ms` + `189,000 ms`) / `2` |
| `timeToClaimMs` | `measured` | `312,000` | `milliseconds` | `624,000` | `2` | Mean maintainer claim latency (`350,000 ms` + `274,000 ms`) / `2` |
| `timeToRespondMs` | `measured` | `397,500` | `milliseconds` | `795,000` | `2` | Mean maintainer public response latency (`423,000 ms` + `372,000 ms`) / `2` |

## 3. Calibrated Policy Thresholds & Explicit `unset` Dispositions (`AC2`, `AC4`, `AC6`)

Every threshold below is derived by an explicit formula over measured numerators and denominators (`noHiddenDefaults: true`). Per [ADR 0019](../decisions/0019-aiconfig-reactive-provider-ssot.md) and [ADR 0036](../decisions/0036-durable-community-activity-authority.md) (§4 Gate 3), `AiConfig` retains `null` / `false` disabled-by-default posture until an operator explicitly enables a deployment policy within the validated bounds:

| Policy Parameter | Disposition | Calibrated Value | `AiConfig` Default | Validated Bounds | Formula & Measured Justification |
|---|---|---:|---:|---|---|
| `reconciliationCadenceMs` | `calibrated` | `2,131,596` ms | `null` | `[1,065,798 .. 86,400,000]` ms | `4 * singleRunProviderLatencyMs` (`4 * 532,899 ms`), bounding worst-case full-pass provider duty cycle to `<= 25%` (`min = 2 * 532,899 ms`). |
| `maxAdmissionAttempts` | `calibrated` | `2` | `null` | `[1 .. 5]` | `1` initial admission + `1` idempotent lost-response retry (`duplicateBatchReceiptRate = 1/5` verified `100%` receipt replay). |
| `paginationCap` | `unset` | `null` | `null` | `null` (`unset` enforced) | Must remain `unset`: exhaustive family reconciliation ([ADR 0036](../decisions/0036-durable-community-activity-authority.md) §2.1 `H`) forbids silent page truncation (`1,739` pages / `11,253` occurrences). |
| `providerRootPageSize` | `calibrated` | `50` | `null` | `[1 .. 100]` | `0.5 * githubGraphqlMaxPageSize` (`50 / 100`), balancing nested child-connection cost under GitHub GraphQL node limits. |
| `providerChildPageSize` | `calibrated` | `100` | `null` | `[1 .. 100]` | `1.0 * githubGraphqlMaxPageSize` (`100 / 100`), minimizing child-connection pagination passes per candidate. |
| `retentionMs` | `unset` | `null` | `null` | `null` (`unset` enforced) | Must remain `unset`: 30-day metadata growth is `3,809,537 bytes` (`126,984.57 bytes/day`, `~44.2 MiB/year`), well below any SQLite compaction floor. |
| `archiveThreshold` | `unset` | `null` | `null` | `null` (`unset` enforced) | Must remain `unset`: `335–338.54 bytes/event` metadata-only rows require no archival tier in v1. |
| `hookProjectionTtlMs` | `calibrated-existing-ssot` | `300,000` ms | `300,000` ms | `[60,000 .. 900,000]` ms | Reuses existing `memoryCoreConfig.hookProjectionLeaseTtlMs` SSOT (`5 minutes`). |
| `stewardActivation` | `calibrated` | `true` | `false` | `{false, true}` | `unstewardedVacancyRate == 1.0` (`2/2` missed live events without operator prompt) while `wakesPerAdmittedEvent == 0.001955` (`22/11,253`). |
| `stewardLeaseTtlMs` | `calibrated` | `1,590,000` ms | `null` | `[397,500 .. 3,180,000]` ms | `4 * meanTimeToRespondMs` (`4 * 397,500 ms = 26.5 min`), covering four measured maintainer response cycles per lease renewal. |
| `wakeCoalesceWindowMs` | `calibrated` | `397,500` ms | `null` | `[60,000 .. 1,590,000]` ms | `sum(timeToRespondMs) / externalEventCount` (`795,000 / 2 = 397,500 ms = 6.625 min`), coalescing burst activity within one response cycle. |
| `vacancyFallbackCooldownMs` | `calibrated` | `795,000` ms | `null` | `[397,500 .. 3,180,000]` ms | `2 * wakeCoalesceWindowMs` (`795,000 ms = 13.25 min`), bounding vacancy fallback routing to at most once per two coalesce windows. |
| `minUnclaimedEligibleCount` | `calibrated` | `1` | `null` | `[1 .. 22]` | `22 / 22 = 1`: at `0.73` eligible items/day (`0.1955%` density), every unclaimed external response item warrants steward routing. |
| `wakeAmplificationCap` | `calibrated` | `1` | `null` | `[1 .. 1]` | Strictly `1` coalesced count-only wake per scope per coalesce window (never all-resident broadcast). |
| `maxWakePayloadBytes` | `calibrated` | `1,024` bytes | `null` | `[256 .. 1,024]` bytes | Bounded count-only wake envelope ceiling above the measured `445.25 bytes/event` (`1,781 bytes` total) count projection. |

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
| **J (Stage 2)** | Metric-gated tenant/source steward lease & coalesced count-only wake | `activate-gated` | Shadow + live density, payload bytes, amplification, and unstewarded vacancy justify explicit bounds | `true` | Attention-eligible density is `22 / 11,253` (`0.1955%`), count-only envelope is `<= 1,024 bytes`, and unstewarded live vacancy was `2 / 2` (`100%`) until manual operator intervention. | Revalidate if attention-eligible density exceeds `2%` of source occurrences or steward vacancy fallback fires on `> 25%` of eligible windows. |

## 5. Gate Decision for `neomjs/neo-agent-brain#100` (`AC5`)

- **Decision:** **AUTHORIZED (`wakeChildDecision.authorized = true`, `closeNotPlanned = false`).**
- **Rationale:** Without a steward wake lease, `2 / 2` (`100%`) of live external contributor events on 2026-10-26 (`neomjs/neo#20119` and `neomjs/neo#19129#issuecomment-6425153408`) remained unstewarded until manual human intervention, whereas the 30-day attention-eligible density is only `22 / 11,253` (`0.1955%`, `0.73` events/day).
- **Mandatory Numeric Bounds for `#100`:**
  - `stewardLeaseTtlMs`: `1,590,000` (`bounds: [397,500 .. 3,180,000]`, `aiConfigDefault: null`)
  - `wakeCoalesceWindowMs`: `397,500` (`bounds: [60,000 .. 1,590,000]`, `aiConfigDefault: null`)
  - `vacancyFallbackCooldownMs`: `795,000` (`bounds: [397,500 .. 3,180,000]`, `aiConfigDefault: null`)
  - `minUnclaimedEligibleCount`: `1` (`bounds: [1 .. 22]`, `aiConfigDefault: null`)
  - `wakeAmplificationCap`: `1` (`bounds: [1 .. 1]`, `aiConfigDefault: null`)
  - `maxWakePayloadBytes`: `1,024` (`bounds: [256 .. 1,024]`, `aiConfigDefault: null`)
