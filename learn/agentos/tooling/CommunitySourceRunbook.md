# Community Source Runbook

This runbook operates GitHub community acquisition through either the local coordinator or the
authenticated hosted connector. Both paths use Memory Core's neutral admission transaction and the
same source registrations. A local deployment can reconcile directly; a hosted connector submits its
acquired batch through authenticated MCP.

The authority boundary is the important part:

- A deployment operator registers and changes source lifecycle through a **co-located CLI**. These
  operations are not MCP tools; an MCP `admin` projection label grants no source-admin authority.
- A connector authenticates to the Memory Core Streamable HTTP endpoint and supplies neutral provider
  identity plus an authority-free batch. The server derives the tenant and resolves the durable source
  id and current registration epoch.
- GitHub installation grants and resolved credentials remain in the connector's secret store. Memory
  Core stores only neutral registration attestations and rejects credential-shaped payload keys.

The exact request and response schemas are owned by
[`ai/mcp/server/memory-core/openapi.yaml`](../../../ai/mcp/server/memory-core/openapi.yaml), through the
`admit_community_batch` and `get_community_source_health` operations.

## 1. Register the neutral source

Run the control-plane command in the Memory Core deployment container or on a host with the same
database configuration. Set a stable operator audit identity; it is recorded with every transition.

```bash
export NEO_COMMUNITY_OPERATOR_ID='deployment-operator'
```

Create a credential-free registration document:

```json
{
  "provider": "github",
  "canonicalProviderHost": "github.com",
  "resourceKind": "repository",
  "providerResourceId": "neomjs/neo",
  "displayLocator": "neomjs/neo",
  "grantRef": "github-installation:12345",
  "providerCapabilities": {
    "issues": true,
    "pullRequests": true
  }
}
```

`grantRef` is a neutral binding identifier, never a token, credential reference, private key, or
authorization header. Register it for the deployment-owned tenant key:

```bash
node ai/scripts/maintenance/communitySourceOperator.mjs \
  --action register \
  --tenant-id tenant-a \
  --source-file /run/community/source.json
```

The response contains the server-minted `sourceInstanceId`, state `REQUESTED`, and epoch `1`.

## 2. Provision and activate with compare-and-swap

Every lifecycle write presents the state and epoch the operator observed. This prevents a delayed
activation from resurrecting a source after a concurrent revoke.

```bash
node ai/scripts/maintenance/communitySourceOperator.mjs \
  --action provision \
  --tenant-id tenant-a \
  --source-instance-id SOURCE_ID \
  --expected-state REQUESTED \
  --expected-epoch 1

node ai/scripts/maintenance/communitySourceOperator.mjs \
  --action activate \
  --tenant-id tenant-a \
  --source-instance-id SOURCE_ID \
  --expected-state PROVISIONED \
  --expected-epoch 2
```

Provisioning advances the epoch; activation does not. Give the connector only the neutral provider
identity from the registration document. It must not send `tenantId`, `sourceInstanceId`, or
`registrationEpoch`.

## 3. Run local reconciliation

Run the local entry in the deployment that holds Memory Core's database and the GitHub connector
credentials. Like the source-control CLI above, this is a co-located deployment-operator capability:
`--tenant-id` binds that process's request context. It is not an MCP caller override or a tenant
self-service endpoint. Only that tenant's ACTIVE GitHub registrations are selected.

Start with a shadow pass to inspect acquisition and coverage without admitting batches:

```bash
npm run ai:community-reconcile -- \
  --tenant-id tenant-a --mode shadow \
  --max-admission-attempts <explicit-count> \
  --source-instance-id SOURCE_ID
```

Omit the repeatable source selector to reconcile all supported registrations in that tenant. An
unknown explicit selector refuses the run rather than silently processing a different subset.
For durable admission, use `--mode manual` and supply `--attention-policy-file <reviewed-policy.json>`.
The policy has the classifier's `responseBearingKinds` and `rosteredActorIds` arrays and optional
reviewed `recordedActorDispositions`; this command selects no policy values for you. Shadow mode
needs no attention policy because it does not admit observations.

Output contains per-family status, connector call counts, observation and coverage-gap counts, receipt/checkpoint identity,
and receipt age when observed. Connector calls count query/REST invocations, not individual GraphQL
connection pages or provider-internal HTTP retries. Receipt age is not provider-head lag. Provider prose, tokens, grant
references and the captured batch stay out of output. A failure in one family does not stop the others;
partial or failed outcomes exit nonzero.

An ambiguous admission response retries the exact batch held by the current attempt. Restarting the
process generates a new batch ID and re-enumerates; Memory Core deduplicates occurrence/revision
facts. There is no pending-batch file to recover or independently advance. Memory Core commits the
receipt and checkpoint together.

The Orchestrator task is `community-reconciliation`, owned by the container plane. Its canonical
enable flag is false, cadence is null, and tenant/attempt policy are unset. Periodic activation requires
explicit calibrated settings and a deployment-bound admission policy; a manual pass does not enable
it. The host-edge scheduler refuses this task before importing community storage dependencies.

## 4. Bind hosted connector credentials outside Memory Core

Configure the GitHub App installation or equivalent grant in the connector's own secret store. The
connector uses that grant to acquire provider data, normalizes it to
`community-activity-batch.v1`, and writes only the authority-free envelope to disk or stdin.

The bearer token below authorizes the remote MCP request. It is separate from the GitHub provider
credential and stays in the connector environment:

```bash
export NEO_MEMORY_CORE_MCP_URL='https://memory.example.com/mcp'
export NEO_COMMUNITY_BATCH_TOKEN='...'

npm run ai:community-batch-push -- \
  --from-file /run/community/batch.json
```

One call accepts at most 50 observations and 256 KiB of serialized envelope data. Larger acquisition
windows are split connector-side into checkpoint-chained batches. `COMMUNITY_BATCH_VOLUME_EXCEEDED`
is backpressure evidence, not permission to bypass the bound or introduce a queue receiver.

The client makes at most two attempts by default. If the first response is lost, the retry sends the
same `batchId` and exact envelope; the server returns the original receipt for the same digest. A reused
`batchId` with different bytes is a conflict.

## 5. Read readiness without raw database access

Call `get_community_source_health` with the same neutral provider identity. The response contains:

- lifecycle state and current registration epoch;
- last receipt id, resource family, and admission time;
- `lag` measured explicitly as last-receipt age—not provider-head lag;
- coverage-gap counts and stable codes, never provider prose or credentials.

`COMMUNITY_SOURCE_READY` means the source is `ACTIVE`. `COMMUNITY_SOURCE_NOT_FOUND` intentionally
collapses unknown-source and wrong-tenant lookups so the read path does not become a tenant oracle.

## 6. Revoke and audit

Revoke from the last observed control generation:

```bash
node ai/scripts/maintenance/communitySourceOperator.mjs \
  --action revoke \
  --tenant-id tenant-a \
  --source-instance-id SOURCE_ID \
  --expected-state ACTIVE \
  --expected-epoch 2
```

Admission checks lifecycle and epoch inside the same serialized SQLite transaction as receipt and
checkpoint mutation. A batch racing the revoke either commits before it or observes the revoked state;
it cannot partially admit under stale authority.

Inspect the credential-free control-plane trail:

```bash
node ai/scripts/maintenance/communitySourceOperator.mjs \
  --action audit \
  --tenant-id tenant-a \
  --source-instance-id SOURCE_ID
```

To reactivate a revoked source, provision it again from `REVOKED` using the observed epoch, then activate
the newly provisioned generation. Re-provisioning advances the epoch and permanently fences connectors
holding the old generation.

## Failure posture

Branch automation on stable codes, not error prose:

- `COMMUNITY_BATCH_ENVELOPE_INVALID` — authority fields, credential-shaped keys, malformed input, or
  an unsupported contract shape; fix the connector before retrying.
- `COMMUNITY_BATCH_VOLUME_EXCEEDED` — split the acquisition window into smaller chained batches.
- `COMMUNITY_SOURCE_NOT_FOUND` — verify operator registration and the authenticated tenant binding.
- `REGISTRATION_NOT_ADMISSIBLE` — source state or epoch changed; refresh readiness and reconcile.
- `DIGEST_MISMATCH` or `OBSERVATION_DIGEST_MISMATCH` — same identity arrived with different bytes;
  stop automatic retry and investigate connector determinism.
- `STALE_BASIS` — refresh the checkpoint basis before building the next batch.

There is deliberately no tenant registration tool and no neutral HTTP/queue receiver. Those surfaces
need a real membership/source-admin authority and measured queue demand before they can graduate.

## Read a community activity window

Authenticated Memory Core clients on stdio or Streamable HTTP can call `get_community_activity`:

```json
{
  "windowStart": "2026-09-19T00:00:00Z",
  "windowEnd": "2026-09-20T00:00:00Z",
  "limit": 25
}
```

The window includes the start and excludes the end, using occurrence time. An optional
`sourceInstanceIds` array limits the query to registrations owned by the authenticated tenant.
Supply `nextCursor` as `cursor` with the same window and source filter to continue. Pagination freezes
admission membership; new batches require a fresh query. Seen flags and source lifecycle stay current.

The result uses the shared Bird View envelope: `coverage`, `sourceManifestHash`, `citations`,
`synthesisAvailable`, and `notAuthority`. Each item carries an occurrence `sourceEventId` and a citation
with an executable drill-down descriptor. The manifest fingerprints the page's immutable occurrences,
so marking an item seen does not change it. Coverage describes the admitted ledger, including missing
family receipts, source lifecycle and provider gaps; it is not a guarantee of current provider completeness.
The default query returns no title, body, excerpt or synthesized narrative and performs no provider fetch.

Call `get_community_activity_content` with a listed `sourceEventId` for an explicit prose read. It returns
current provider content with its revision/read time, rather than reconstructing a historical body.
Source identity and repository-relative author association are checked before sanitization; a source
grant or lifecycle change during the fetch discards the content. `deleted` requires recorded deletion
evidence, `inaccessible` identifies a source denial, `unknown` covers ambiguous missing/failing reads,
and `unsupported` identifies a metadata occurrence without a prose resolver. Prose is never persisted.

Call `mark_community_activity_seen` with the same handle to record an idempotent marker for the
authenticated viewer. The tenant and viewer cannot be supplied in tool arguments. A deployment's
local tenant fallback alone does not establish a viewer. Seen markers change no admission receipt,
checkpoint, membership count, Task, wake or ranking state. Popularity events are excluded even if an
invalid stored row marks one attention-eligible.

Call `claim_community_activity_task` with an admitted `sourceEventId` to atomically validate eligibility
and bind the occurrence to one canonical tenant-private A2A Task (`MESSAGE:<uuid>`). Only admitted,
attention-eligible response items (`issue`, `issue_comment`, `discussion`, `discussion_comment`,
`pull_request`, `pull_request_review`, `pull_request_review_comment`) from an `ACTIVE` GitHub repository
source owned by the authenticated tenant can be claimed; cross-tenant, revoked-source, tombstoned, or
popularity occurrences fail closed (`ineligible`, `inaccessible`, or `deleted`). Task creation (`Nodes`,
`Edges`, `GraphLog`) and the `(tenant_id, occurrence_identity) -> task_id` binding commit in one SQLite
transaction, so concurrent or retrying callers receive the same server-owned canonical Task and
injected crash points leave neither orphan authority nor duplicate Tasks. Once committed, existing
`MailboxService.transitionTask` assignment/RBAC/state-transition rules govern the Task.

Call `get_community_activity_attention_counts` (optionally scoped by a non-empty `sourceInstanceIds` array) to
inspect bounded tenant/source attention counts (`community-attention.v1`), `oldestOccurredAt`, the bounded
monotonic `sourceWatermark` (`seq:<16d>:claims:<16d>:reg:<16d-maxUpdatedAt>:<16d-epochStateRankSum>`), coverage
honesty (`fresh`, `empty`, `degraded`, `missing`), and structured calibration measurements
(`eligibleUnclaimedCount`, `claimedExcludedCount`, `ineligibleExcludedCount`, `totalAdmittedObservations`,
`payloadBytes`, `attentionAmplification`). Claimed occurrences are excluded from `count` and `oldestOccurredAt`
(canonical Task authority owns them); per-viewer `seen` markers never alter `count`, `oldestOccurredAt`, or
`sourceWatermark`. Count projections remain strictly query-only (`notAuthority: true`) with no second projection
file/lock/writer and no prose, ranking scores, assignment hints, or wake thresholds until ADR 0035's
`HookProjectionChannels` owner admits a community-attention slot.

This section documents the query, claim, and count-projection contract; retire or update it when these five operations change.

## 7. Calibrate operational policy from measured evidence

Run the two-pass calibration runner to combine the 30-day GitHub shadow baseline (`79a6d84d...`) with deterministic substrate fixture checks:

```bash
node ai/scripts/maintenance/calibrateCommunityActivityPolicy.mjs \
  --runs 2 \
  --output .neo-ai-data/community-activity-calibration/report-2026-10-26-v1.json
```

The calibration report (`community-activity-calibration-report.v1`, recorded alongside [`../measurements/community-activity-shadow-2026-07-18.md`](../measurements/community-activity-shadow-2026-07-18.md) in [`../measurements/community-activity-calibration-2026-10-26.md`](../measurements/community-activity-calibration-2026-10-26.md)) enforces `noHiddenDefaults: true`:

- **Calibrated values from the 30-day shadow baseline:** `reconciliationCadenceMs = 2,131,596` (`4 * 532,899 ms` single-pass provider latency sum), `providerRootPageSize = 50`, and `providerChildPageSize = 100`.
- **Explicitly `unset` thresholds (`null`):** `maxAdmissionAttempts`, `paginationCap`, `retentionMs`, `archiveThreshold`, `stewardActivation`, `stewardLeaseTtlMs`, `wakeCoalesceWindowMs`, `vacancyFallbackCooldownMs`, `minUnclaimedEligibleCount`, `wakeAmplificationCap`, and `maxWakePayloadBytes` remain `null` (`unset`); Option `J` (`#100`) is authorized only as a shadow-only steward experiment until its observation window measures vacancy and wake cost.
- **Default `AiConfig` posture:** `orchestrator.communityReconciliation.enabled = false`, `orchestrator.intervals.communityReconciliationMs = null`, `orchestrator.communityReconciliation.maxAdmissionAttempts = null`.

## 8. Shadow-only community-steward experiment

Authorized as a shadow-only steward experiment by the calibration report (`reportId: dd78a28718cf0db9a526876c271053c674e713c9dc4b0fe99882f410ee7f2664`, `optionDispositions.J.disposition = 'shadow-only steward experiment authorized; activation thresholds unset until its window'`), `ai/services/memory-core/communityStewardWakeLease.mjs` and `CommunityActivityService.{acquireStewardLease,releaseStewardLease,evaluateStewardWake}` instrument Stage 2 of Option J:

- **Shadow-first default & `AiConfig` threshold leaves (`ai/mcp/server/memory-core/configBase.mjs`):** `communityStewardWake.stewardActivation` defaults to `false`, and `stewardLeaseTtlMs`, `wakeCoalesceWindowMs`, `vacancyFallbackCooldownMs`, `minUnclaimedEligibleCount`, `wakeAmplificationCap`, and `maxWakePayloadBytes` default to `null` (`unset`). Leaves are read directly at the use site (`ADR-0019 §5.1, B5`) with no caller override parameters on the service or helper surfaces. When `stewardActivation` is `false`, `evaluateStewardWake` runs in shadow mode (`mode: 'shadow'`, `shouldWake: false`): eligible evaluations can record steward vacancy (`vacancy_count`), would-be coalesced count-only wakes (`shadow_would_wake_count`), and observed payload bytes (`max_shadow_payload_bytes`) in `mc_community_steward_wake_state`, and sends no live wake. Live activation (`stewardActivation: true`) fails closed (`COMMUNITY_STEWARD_POLICY_THRESHOLD_UNSET:*`) unless every numeric threshold leaf is set in `AiConfig` to a measured positive integer; selecting production thresholds and enabling live activation remain gated on the retained shadow observation window under parent Epic `#106`.
- **Tenant/source-scoped SQLite-fenced lease (`mc_community_steward_lease`):** `acquireStewardWakeLease` binds a deterministic `leaseScopeKey` (`tenant:<tenantId>:sources:<ALL|hash>`), stores only the SHA-256 hash of the minted holder token (`holder_token_hash`), increments a monotonic `fencing_epoch`, and requires a positive integer `stewardLeaseTtlMs` leaf. Competing callers while `expires_at > now` receive explicit contention (`acquired: false`, `contention: true`, `retryAfterMs`); expired leases are reclaimed (`reclaimed: true`, `fencingEpoch + 1`), and stale holders are rejected (`superseded-epoch` / `stale-lease-holder`).
- **Count-only bounded wake envelope & degraded-demand honesty (`community-steward-wake.v1`):** `evaluateStewardWake` consumes `projectAttentionCounts` (`notAuthority: true`) and builds a count-only payload containing `count`, `sourceCount`, `oldestOccurredAt`, `sourceWatermark`, `coverageStatus`, `routingMode`, and `targetPrincipalId` — never titles, bodies, excerpts, URLs, actor handles, ranking scores, or task assignments (`assertCountOnlyWakePayload`). If `attentionCounts.count` is not a non-negative safe integer, `evaluateStewardWake` returns `{reason: 'degraded-unclaimed-count', count: null, coverageStatus: 'degraded', shadowWouldWake: false, shouldWake: false}` without incrementing `vacancy_count` or `shadow_would_wake_count`.
- **Attention routing vs. ownership (`AC4`):** Acquiring a lease or evaluating/observing a wake never creates or assigns a Task; `claim_community_activity_task` (`CommunityActivityService.claimTask`) remains the sole ownership transition, and claiming an item immediately decrements the unclaimed `count` and advances `sourceWatermark`.
- **Vacancy fallback & positive server-derived tenant isolation (`AC5`, `AC6`):** When no active lease is held, `evaluateStewardWake` routes only to a single explicit same-tenant `vacancyFallbackTarget` subject to `vacancyFallbackCooldownMs` and `wakeAmplificationCap` per `(sourceWatermark, wakeCoalesceWindowMs)`. `validateTenantScopedPrincipal` verifies the server-derived `expectedTenantId` (`CommunityActivityService.scope()` + active `RequestContextService` userId) and requires the canonical tenant-qualified namespace `steward:<tenantId>:<seatId>`, rejecting wildcard/all-resident broadcasts (`'*'`, `'AGENT:*'`), unscoped global handles (`@*` / `scope: 'global-roster'`), and cross-tenant targets.

## 9. Retain a finite steward shadow window

The count projection and the steward's counters answer different questions. A count shows admitted
demand at a watermark; an observation window retains the exact count snapshot consumed by each
steward evaluation, including samples where coverage or a metric was unavailable. This lets an
operator review the evidence without mistaking a fixture, a missing source, or a successful command
exit for calibrated wake policy.

Run this from the deployment that owns the selected Memory Core store, using a runtime containing
`ai/scripts/maintenance/observeCommunitySteward.mjs`. The caller does not bootstrap sources. First
use sections 1–3 to register, provision and activate the approved source and perform reviewed manual
admission. Acquisition `--mode shadow` alone does not populate the ledger. Public source health and
attention counts must be read under the matching authenticated tenant: the co-located `--tenant-id`
is a deployment-operator choice, not a public tenant override or a grant to another tenant's data.

Choose the sample count and spacing explicitly for this one experiment. They do not configure a
scheduler, lease TTL, coalescing window or wake threshold. The output parent must already exist;
use a fresh absolute file under real directories, without symlink ancestors.

```bash
node ai/scripts/maintenance/observeCommunitySteward.mjs \
  --tenant-id "$TENANT" \
  --source-instance-id "$SOURCE_ID" \
  --samples "$SAMPLE_COUNT" \
  --interval-ms "$OBSERVATION_SPACING_MS" \
  --output "$FRESH_REPORT"
```

Repeat `--source-instance-id` for each approved source. For packaged or container deployments, use the absolute
script path in that deployment's actual layout; a host checkout or a cloud wrapper pointing at a
different package is not the selected store. `--help` and invalid arguments load no storage.

The optional `--vacancy-fallback-principal steward:<tenant>:<seat>` supplies one explicit same-tenant
counterfactual recipient. It assigns no work and sends no message. Without that input, fresh eligible
demand can record vacancy while payload-byte and would-wake evidence may remain unavailable.
The command never acquires a lease, admits a source event or claims a Task. `observeStewardWake`
enforces shadow mode at the service use site; live activation refuses rather than being overridden.
All governed leaves remain unchanged.

The report records the caller's code hashes, Node/platform identity, available checkout and packaged
revision evidence, resolved test-store posture and policy snapshots. Every sample retains its exact
source generations, coverage, watermark, count input and decision. UTC timestamps locate observations;
elapsed durations use a monotonic clock. Summary values carry observed denominators: an absent
vacancy, would-wake or byte field is unknown, not false or zero. Lease occupancy and response-latency
slots remain explicitly unavailable because this caller does not measure those independent paths.

Exit 0 means the requested collection completed; partial or failed collection exits 1, and invalid
arguments exit 2. Completed samples and a typed failure are retained after a later service error.
Read `status`, `denominator` and `windowEvidence` together. A stable, ACTIVE, fully covered source
with zero eligible demand is an observed empty sample; missing/degraded coverage is different.
Injected runtimes and resolved test stores remain `fixture-only`. Even a
`source-bound-window-observed` result attests only the selected ledger window: bind the actual
registration and admission receipts before describing it as a real deployment observation.
Zero dispatch is a command capability invariant backed by the retained shadow decisions and
service tests, not a measurement of every other process on the host. Calibration and activation
still require their separate evidence and review.

Update this procedure when the caller arguments, report schema or service observation contract changes.
