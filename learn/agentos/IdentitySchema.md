# AgentIdentity Graph Schema

This document formalizes the `AgentIdentity` graph node schema within the Neo.mjs architectural graph database.

## Architecture & Rationale

The AgentOS Memory Core utilizes a persistent, hybrid semantic/graph database to link ephemeral conversation memory with structural repository data.

To support the "Model Experience" (MX) capabilities — cf. Discussion #10137 for the distinction from Agent Experience (AX) — and fully attribute actions across long-lived Swarm intelligences, we provision explicit Identity nodes representing the actors interacting with the repository.

### Per-Model vs. Per-Version Account Binding

A key design decision involved how to track model iterations (e.g., `gemini-3-pro` vs `gemini-3.1-pro` vs `gemini-4-pro`).

**Decision:** We adopt a **Per-Model Identity** mapping (e.g. `@neo-gemini-pro`).
**Rationale:**
1. **Low Churn:** Models undergo massive capability upgrades (like Gemini 3.0 to 3.1) which inherently change their reasoning processes. Tying accounts to distinct capabilities rather than an ambiguous parent prevents behavioral telemetry from becoming meaningless over time.
2. **Cross-Session Traversal:** Explicit identity keys matching actual API accounts mean graph traversal queries (`MATCH (AgentIdentity {id: "@neo-opus-ada"})-[:AUTHORED]->(Session)`) directly align with GitHub handles and PR authorship.
3. **Traceability:** It provides full attribution via GitHub to a specific model version, establishing accountability for pull requests, code reviews, and autonomous system patches.

## Schema Specification

Each `AgentIdentity` node in the graph is structured with the following properties:

| Property | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `id` | `String` | The unique primary key identifier, usually matching the GitHub login. | `'@neo-opus-ada'` |
| `type` / `label` | `String` | The graph node type. Must be `'AgentIdentity'`. | `'AgentIdentity'` |
| `name` | `String` | Confirmed Social Name, or the handle-derived fallback when no Social Name exists. | `'Ada'` |
| `description` | `String` | A factual account/model summary. It must not prescribe a role or character. | `'Anthropic Claude Opus Agent Identity'` |
| `githubLogin` | `String` | The resident's durable GitHub username. | `'@neo-opus-ada'` |
| `displayName` | `String` | Verified account/UI label. Usually the Social Name; a pre-boot profile label may appear here while top-level `name` remains handle-derived pending bearer assent. | `'Ada'` |
| `modelFamily` | `String` | The underlying architectural family of the model. | `'claude'` |
| `accountType` | `String` | The actor classification (`'agent'` or `'human'`). | `'agent'` |
| `createdAt` | `ISO 8601 String` | Immutable resident/root-introduction timestamp. It is committed as a literal and must never be recomputed at module import or graph rehydration. | `'2026-04-21T12:00:00.000Z'` |

## Capability Fields (Extended per ADR 0012)

Beyond the core identity fields above, `AgentIdentity` nodes carry capability-bearing properties that inform swarm-routing decisions, training-drift defense, and sunset/promotion lifecycle. The full framework lives in [ADR 0012: Model-Stats Framework](decisions/0012-model-stats-framework.md); per-model values live in the live registry at [ModelStats.md](ModelStats.md).

These fields are populated at provisioning time (via `ai/scripts/setup/seedAgentIdentities.mjs`) and updated per ADR 0012 §2.5 registry-update discipline (authoritative-source-cite required).

| Property | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `contextWindowInput` | `Number` (tokens) | Maximum input token capacity. | `1048576` |
| `contextWindowOutput` | `Number` (tokens, optional) | Output token capacity where distinct from input. | `65536` (Gemini 3.1 Pro) |
| `parallelToolCalls` | `Boolean` \| `Number` | Whether parallel tool invocation is supported; numeric value indicates max concurrency where bounded. | `true` |
| `thoughtBudget` | `String` | Reasoning/thinking-budget setting in active use (per-provider terminology). Cross-family comparable at coarse "closer ball park" granularity; exact equivalences require empirical V-B-A. | `'max'` (Claude), `'high'` (Gemini cap), `'extra-high'` (GPT) |
| `hosting` | `String` | Where the model executes: `'cloud'` \| `'mlx-local'` \| `'self-hosted'`. Informs latency, cost, and privacy substrate. | `'cloud'` |
| `tier` | `String` | Capability-cost tier: `'frontier'` \| `'balanced'` \| `'fast'`. Informs swarm-routing policy per ADR 0012 §2.4. | `'frontier'` |
| `releaseDate` | `ISO 8601 String` | Model release date. Anchors capability claims against training-data drift. | `'2026-04-16'` |
| `pricingInput` | `Number` (USD per 1M tokens, optional) | Cost dimension for cloud-hosted models. | `5.00` |
| `pricingOutput` | `Number` (USD per 1M tokens, optional) | Cost dimension for cloud-hosted models. | `25.00` |
| `license` | `String` (optional) | License identifier for open-weights models. | `'Apache-2.0'` (Gemma 4) |
| `benchmarkSnapshot` | `Object` (optional) | Latest benchmark scores for capability-trend tracking. | `{ 'SWE-bench': 0.876 }` |
| `sunsetTriggers` | `String[]` | **Advisory only — human/agent-evaluated, never machine-enforced.** Records the conditions a maintainer judged would end this embodiment, per ADR 0012 §2.3. **Code writes this field; no code evaluates it.** `identityRootsMigration.mjs` carries the values into era capabilities and `generateRosterOnboarding.mjs` emits a row for it — both writers. Nothing watches for the condition, and nothing acts when one occurs. A recorded trigger is editorial intent, not a guarantee that the transition will be noticed — a maintainer noticing a release is the entire mechanism. It has gone off silently twice (see `ModelStats.md` §update_discipline); treating it as governed has already produced a wrong prescription in a ticket. | `['Provider releases a successor in this capability class', 'Provider deprecates this model branch']` |
| `modelAssignment` | `Object` (optional) | Current engine assignment override for a stable identity. Absent means the identity runs its baseline model with no managed temporary/reversion window. | `{ model: 'claude-fable-5', baselineModel: 'claude-opus-4-8', temporary: true, authority: '@tobiu', since: '2026-06-13', until: '2026-06-21', reversionTrigger: 'revert unless extended' }` |

`modelFamily` (declared above) is the family identifier consumed by the registry's `family` field — both surface the same conceptual property; `modelFamily` is the graph-node primary, `family` is the registry-side mirror.

### Identity nodes are not workflow containers

Per ADR 0032's identity anti-lock-in contract, an `AgentIdentity` records who the resident is;
it does not encode staffing utility, assigned roles, review policy, onboarding checklists, sibling
relationships, or memory workflow. Established routing and lifecycle fields such as
`subscriptionTemplate` and `participationStatus` remain schema-backed operational facts; they do
not authorize arbitrary workflow payloads. Fields such as `swarmRole`, `identityContract`,
`reviewSemantics`, `memoryContinuity`, and `activationPrerequisites` are not part of this schema.
Their real owners are governance services, migration modules, live lane state, and onboarding
records—not the person node.

`modelAssignment` is the source-of-truth field for managed engine swaps under a stable `AgentIdentity`. It must not change handle routing, memory authorship, quorum family, or review semantics by itself; those remain keyed to the identity node and `modelFamily`. Consumers such as the Fleet Manager registry project this field instead of defining a parallel assignment schema. When present, the object carries `model`, `baselineModel`, `temporary`, `authority`, `since`, `until`, and `reversionTrigger`.

**Update discipline:** Capability values that change post-provisioning (e.g., Anthropic releases a context-window upgrade for an existing identity) update via `ModelStats.md` first; the graph node is reseeded via `ai/scripts/setup/seedAgentIdentities.mjs` to reflect.

## Ingestion Mechanism

Identity projection has two deliberately separate write authorities:

- `GraphService.initAsync` is **additive-only**. Ordinary process boot provisions roots that are
  absent so first binding works, but it never rewrites an existing identity from the process-local
  registry snapshot. This prevents an MCP server running an older checkout from rewinding a newer
  activation/status projection.
- `ai/scripts/setup/seedAgentIdentities.mjs` is the **explicit canonical update** path. It upserts the
  merged registry facts, and **the registry is authoritative for `createdAt`**: a declared value is
  projected over a divergent persisted stamp, because a rename is identity *continuation* and the
  node's stamp otherwise records when a seeding run happened rather than when the resident was
  introduced. The persisted stamp is the fallback **only** for entries the registry does not declare,
  so a silent registry never blanks it. Runtime-added properties are preserved throughout — the
  upsert layers the payload over the existing bag rather than replacing it, so a field the registry
  never mentions (a static wake route, say) survives the projection untouched.

### Participation decisions

A bench is the operator's decision, recorded on the plane host with `ai/scripts/fleet/participation.mjs`.
The command writes these fields on the node:
- `participationStatus`: `active` or `operator_benched`;
- `statusReason`: required for a bench;
- `since`;
- `participationDecidedBy`: who decided.

A recorded decision outranks both writers above. The seeder leaves the participation fields of a node
that carries `participationDecidedBy` alone. The Memory Core's sign-in refresh writes
`participationStatus` only when it creates a node. On the plane, run the command in the Memory Core
container. Without `--apply` it only reports what it would write:

```bash
node ai/scripts/fleet/participation.mjs bench --identity @<resident> --reason "<why>" --apply
node ai/scripts/fleet/participation.mjs activate --identity @<resident> --apply
```

After an intentional identity-root change merges, run the projection gate from the checkout that
owns the target Memory Core deployment:

```bash
git switch dev
git pull --ff-only origin dev
node ai/scripts/setup/seedAgentIdentities.mjs
```

Restart the Memory Core server so its loaded module graph matches the pulled revision. Then verify
the same resident through both read surfaces:

```text
get_node({id: '@<resident>', projection: 'full'})
who_is_online({verbose: true})
```

Both projections must carry the merged `participationStatus`. A missing node, mismatch, stale
runtime checkout, or unreachable graph fails the activation/status-flip gate; it is never reduced
to a warning. `ai/scripts/fleet/onboardPeer.mjs` applies the same fail-closed comparison before a
resident can reach launch.

## Pure family protocol and projection

Family operations need stable bytes across signatures and retries, and complete history when a reader
classifies an account. These modules validate or derive a supplied value without reading credentials,
writing storage or selecting a running seat. Their caller still establishes source authority,
completeness, plane binding and admission in the owning transaction.

| Boundary | Source owner | Result |
| --- | --- | --- |
| Deterministic JSON | [canonicalJson.mjs](../../ai/services/shared/canonicalJson.mjs) | A detached ordered value, or strict serialization that refuses unsupported JSON data before it disappears. |
| Stable record identities | [identityPublicationKeys.mjs](../../ai/services/shared/identityPublicationKeys.mjs) | Domain-separated keys bound to plane, provider/API-base/stable-user ID and the applicable incarnation or logical operation. Login changes do not rename membership. |
| Closed logical operations | [identityPublicationOperation.mjs](../../ai/services/shared/identityPublicationOperation.mjs) | A frozen validated operation and delivery-independent digest, or a field-addressed refusal. |
| Signed delivery | [identityPublicationSignature.mjs](../../ai/services/shared/identityPublicationSignature.mjs) | An authenticated immutable envelope, or refusal. Authentication does not admit its operation. |
| Exact family vocabulary | [identityPublicationVocabulary.mjs](../../ai/services/memory-core/helpers/identityPublicationVocabulary.mjs) | Introduction-intent and collision checks over the complete caller-supplied catalog, retaining exact labels. |
| Founding input | [identityFoundingSeed.mjs](../../ai/graph/identityFoundingSeed.mjs) | A complete provider-bound payload and content digest from explicit source inputs; a matching digest establishes content consistency. |
| Temporal account families | [identityFamilyProjection.mjs](../../ai/graph/identityFamilyProjection.mjs) | Membership and effective family intervals, point reads and complete author-window unions from one supplied source revision. |

The fixed v1 profile defines six operation shapes: `baseline`, `bind`, `retire`, `rekey`, `confirm` and `correct`.
The complete baseline supports 128 bindings within a derived 588,887-byte compact carrier limit.
An excess binding refuses the whole input and reports its index, available seat identity, count,
limit and remedy. An empty array is explicit input; the validator does not establish that a live
census is empty or complete.

The signed carrier binds its purpose, audience, stable issuer, key ID, delivery times and complete
operation using Ed25519 and the `neo.identity-family-publication.v1` domain followed by one zero byte.
The caller supplies current trust and the shared-clock reading. Validity is exactly 300,000 ms with
`issuedAt <= now < expiresAt`; re-signing preserves logical operation identity while rechecking trust
and time. The [credential and membership decision](https://github.com/neomjs/neo-agent-institution/blob/dev/learn/agentos/decisions/0038-fm-client-topology.md)
owns the service, custody and recovery requirements beyond this pure boundary.

Family comparison derives a collision key using NFKC, removal of JavaScript whitespace,
lower/upper/lower case conversion and NFKC again. Exact labels remain unchanged; control/format
characters and empty keys refuse. Cross-script visual confusables remain distinct. The literal
family `unknown` is data; unavailable, unconfirmed, empty and ambiguous results are separate states.

The temporal reader validates the complete retained payload before selecting a subject. Corrections
apply at the target declaration's original admission boundary. A consistent founding family governs
until the earliest corrected different-family declaration, including retired incarnations; a
correction may move or remove that cutoff. Conflicting founders remain ambiguous until the first
admitted declaration at its original admission time, then the admitted aggregate governs, including
its unconfirmed or ambiguous states. All founding rows and membership diagnostics remain visible.
`familiesDuring` includes every overlapping family and refuses an unclassified span without returning
a partial positive set.

The retained founding residual is an undeclared different-family seat on a rostered identity: the
effective family remains the founding family while the membership view reports `unconfirmed-seat`.
An observed case where that seat passes the cross-family gate reopens the founding-precedence policy.
The projection preserves the missing-declaration evidence and does not infer the seat's family.

The publication helper re-exports the shared deterministic canonicalizer. Ordinary publication bytes,
field projection, scheduling and read-back APIs retain their contracts. Own `__proto__` keys remain
data in raw canonicalized objects; `computePublishRevisionDigest` continues projecting media onto its
declared fields first. The strict serializer is the separate entry point for signed protocol data.

## Test Pollution Hazard

**The Incident:** On 2026-04-22 (session `15852d91`) and 2026-04-23 (session `8968b9f6`), the production `AgentIdentity` nodes were wiped. This was traced back to a test-pollution anti-pattern in the Playwright test suite.

**The Mechanism:** Tests like `MailboxService.spec.mjs` and `PermissionService.spec.mjs` attempt to isolate themselves using an in-memory database override (`aiConfig.storagePaths.graph = ':memory:';`). However, if `LifecycleService._initPromise` is already set (because a prior test initialized the `LifecycleService` with the default production SQLite path), the `:memory:` override is silently ignored. When the test's `beforeEach` hook then executes `storage.clear()`, it wipes the production data instead of the intended in-memory database.

**The Safer Pattern:** Other specs (e.g., `DreamService`, `SemanticGraphExtractor`) use concrete `testDbPath` temporary files per test. This provides a robust isolation boundary and eliminates the leak surface.

**Recovery Procedure:** If you find the identities missing (often manifesting as identity unbound errors or `null` mailbox previews), run the `ai/scripts/setup/seedAgentIdentities.mjs` script. If the root cause was test pollution, please file a ticket to refactor the offending specs to the concrete temporary file pattern.
