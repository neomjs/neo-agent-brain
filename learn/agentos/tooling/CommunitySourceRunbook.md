# Hosted Community Source Runbook

This runbook operates the authenticated hosted path for GitHub community-activity batches. It is a
small synchronous push path into Memory Core's neutral admission transaction—not a webhook receiver,
not a queue, and not tenant self-service.

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
npm run ai:community-source-operator -- \
  --action register \
  --tenant-id tenant-a \
  --source-file /run/community/source.json
```

The response contains the server-minted `sourceInstanceId`, state `REQUESTED`, and epoch `1`.

## 2. Provision and activate with compare-and-swap

Every lifecycle write presents the state and epoch the operator observed. This prevents a delayed
activation from resurrecting a source after a concurrent revoke.

```bash
npm run ai:community-source-operator -- \
  --action provision \
  --tenant-id tenant-a \
  --source-instance-id SOURCE_ID \
  --expected-state REQUESTED \
  --expected-epoch 1

npm run ai:community-source-operator -- \
  --action activate \
  --tenant-id tenant-a \
  --source-instance-id SOURCE_ID \
  --expected-state PROVISIONED \
  --expected-epoch 2
```

Provisioning advances the epoch; activation does not. Give the connector only the neutral provider
identity from the registration document. It must not send `tenantId`, `sourceInstanceId`, or
`registrationEpoch`.

## 3. Bind connector credentials outside Memory Core

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

## 4. Read readiness without raw database access

Call `get_community_source_health` with the same neutral provider identity. The response contains:

- lifecycle state and current registration epoch;
- last receipt id, resource family, and admission time;
- `lag` measured explicitly as last-receipt age—not provider-head lag;
- coverage-gap counts and stable codes, never provider prose or credentials.

`COMMUNITY_SOURCE_READY` means the source is `ACTIVE`. `COMMUNITY_SOURCE_NOT_FOUND` intentionally
collapses unknown-source and wrong-tenant lookups so the read path does not become a tenant oracle.

## 5. Revoke and audit

Revoke from the last observed control generation:

```bash
npm run ai:community-source-operator -- \
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
npm run ai:community-source-operator -- \
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

This section documents the query contract; retire or update it when these three operations change.
