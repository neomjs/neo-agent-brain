# Cloud-Native KB Ingestion — Migration Path

> **Status — post-split migration.** The Phase 0/1 zero-config promise below is historical context. The current shared-core scan is a deliberate Engine/Brain repository-profile cut; tenant-config persistence remains documented in [Configuration](./Configuration.md).

## Historical Phase 0/1 zero-config promise

The original cloud-ingestion substrate let a single-repo Neo deployment adopt tenant plumbing without a config edit. That claim applied to its original SourceRegistry-backed `kbSync` path; later repository splits and the `github-content-sync` tenant changed the source set. Do not use the old byte-equivalence claim as current migration evidence.

## Current shared-core boundary

| Concern | Current behavior |
|---|---|
| Shared core acquisition | `kbSync` reads the image-carried Engine package and Brain source through two exact-revision profiles. It no longer enumerates `SourceRegistry` or reads `aiConfig.sourcePaths` for the core scan. |
| Shared core ownership | The two outputs are stamped separately as `(neo-shared, neo)` and `(neo-shared, neo-agent-brain)`; one combined JSONL cannot represent both safely. |
| Conversations | The old three Engine-tree Sources retired in #402. `ConversationCorpusSource` is a distinct `github-content-sync` tenant route; its activation and freshness receipts are #411. |
| First profile embed | Additive (`deleteStale: false`). The post-cut legacy scan remains disabled; old and new IDs for one code fact can coexist until #419's replacement-proven retirement. Old conversation rows have their separate #417 owner. A corpus-tenant receipt alone never authorizes legacy `kbSync` stale deletion. |

The first profile materialization publishes two JSONL artifacts behind one manifest, with separate revision and extraction identities. The current code does not claim byte-equivalence with the retired global SourceRegistry builder. Release-note files and the skills corpus have no active image-carried roots in this cut; their separately owned source contracts remain outside the shared-core profiles.

### Activation and legacy-row migration receipt

This is the acceptance plan for #282 AC-9, not an activation performed by its code PR. `kbSync` remains off under #253 / #411 until a later activation owner records each step against the same deployed image and collection:

1. Capture the pre-activation Chroma row inventory by `(tenantId, repoSlug, sourcePath, type)` and count old code, conversation, skill, concept, and release-note rows separately. Bind the installed Engine pin, Brain revision, and current corpus revision in the receipt; an aggregate count cannot prove which family was preserved.
2. Resolve effective `tenantRepos` through the graph → YAML → Tier-1 winner. The core scan and tenant GitMirror both refuse an enabled shared-tenant Engine/Brain route by owner key or canonical clone URL before writes. A higher-tier `tenantRepos: []` suppresses lower-tier entries; reading Tier-1 alone is not an ownership check.
3. Materialize both exact-revision profiles and record their manifest SHA, extraction identity, per-family yielded paths and counts. The full profile embed is additive (`deleteStale: false`): it can leave a legacy and a new ID for the same Engine code fact because extraction identity changes the hash. Until #419's deployed cleanup receipt, neither a green embed nor `ask_knowledge_base` can prove code currentness. Verify both repository stamps, same-path collision separation, and stored-content hydration against representative old and new rows. No global collection `shadow-swap` or per-repo stale deletion is authorized by this receipt.
4. Retire old conversation rows only through #417's conversation-scoped control. #419 owns a separate replacement-proven source-code-row retirement: it compares the exact old IDs against landed Engine/Brain profile rows and preserves unmatched families. Neither transaction may delete rows of another family as a side effect.
5. The Skills package is a separate repository: the Brain image's `.agents/skills` link is not a revision-bound Brain input. Name and verify its ingestion owner before retiring old `SkillSource` rows. The #282 Engine pin `17b59aad8f95c55c916fd6bb8bd6a0f43bd2d687` contains 59 `resources/content/concepts` files; the Engine content-removal lane must preserve a declared, revision-bound concept input before deleting that directory. Release-note roots are absent from both images in this cut; compare any retained historical rows before deciding their retirement.

Only after these receipts pass may an activation owner change the `kbSync` gate and choose a scoped stale-row strategy. A corpus tenant receipt alone cannot make the shared core scan current.

## What an operator opts into (cloud / multi-tenant mode)

Divergence from the single-repo default is **granular and opt-in**. An operator moving to a multi-tenant cloud deployment changes only what their topology requires:

- **Skip legacy default Source registration** — set `aiConfig.useDefaultSources = false` for SourceRegistry consumers. This does not disable the shared Engine/Brain core profiles; `kbSync` has its own scheduler toggle.
- **Unknown tenant repo shape** — set `aiConfig.rawRepoSource = true` to register the built-in raw-text fallback Source while a custom Source is still premature.
- **Different legacy Source layout** — override affected `aiConfig.sourcePaths` keys for a consumer still using that registry. Repository profiles carry their own route territories and exact reader authority; `sourcePaths` does not override them.
- **Register tenant Sources/Parsers** — populate `aiConfig.customSources` / `aiConfig.customParsers` with pre-imported tenant classes, or call `SourceRegistry.registerSource(...)` at runtime.
- **Spoof-rejection policy** — a multi-tenant operator should consider `aiConfig.spoofRejectionMode: 'reject'` (fail-closed) over the `'overwrite'` default (see [Security](./Security.md)).

Each of these is a local config edit; none requires a code fork.

## Config-template clone-sync

The new config keys (`useDefaultSources`, `rawRepoSource`, `useDefaultParsers`, `customSources`, `customParsers`, `sourcePaths`, `defaultTenantId`, `defaultRepoSlug`, `defaultVisibility`, `spoofRejectionMode`) live in `ai/mcp/server/knowledge-base/config.template.mjs` — the `SourceRegistry` keys via PR #11659, the `sourcePaths` keys via PR #11661, and the tenant-stamping keys via PR #11662. Each clone's local `config.mjs` is gitignored and copied from the template.

- **Zero-config deployments** need no local `config.mjs` edit — the runtime falls through to defaults when a key is absent.
- **Cloud / tenant-mode deployments** add the keys they need to their local `config.mjs`. A harness restart picks up the change (config modules load once per MCP process).

## Tenant-config persistence

How a multi-tenant deployment *stores* its per-tenant configuration — the `KnowledgeBaseTenantConfig` graph-node shape, the `kb-config.yaml` bootstrap-vs-canonical semantics, config-version metadata — is defined by #11637 and documented in **[Configuration](./Configuration.md)**. A deployment's tenant config resolves through three tiers: the `kb-config:<tenantId>` graph node → the `kb-config.yaml` bootstrap → the local `config.mjs` defaults. This tiering now also covers `tenantRepos` (the pull-mode polling config), resolved via `listConfiguredTenantRepos`.

## Tenant-repo checkpoint revalidation

Pull-mode deployments upgrading from a release that could persist a repository
head after an error-bearing ingestion summary do not need to delete state or
run an in-container recovery command. Unversioned checkpoint heads are treated
as historically unknown and receive one automatic null-base replay.

Migration is gradual: the one-minute scheduler sweep admits no more than the
configured tenant-repo concurrency limit, while per-repo cadence, deterministic
jitter, failure backoff, and the normal concurrency semaphore remain active.
Failures preserve the old head and stay eligible for a later retry. Only a
clean Knowledge Base summary writes the current success-contract marker and
returns that repo to incremental ingestion. The deployment-state snapshot
exposes aggregate and hashed per-repo progress; scoped CLI `--full` replay
remains an optional acceleration override.

## Breaking-change inventory

There are **no breaking changes** for an existing single-repo deployment. The substrate is additive end-to-end. The only "migration" a single-repo operator performs is `git pull` — the defaults handle the rest.

For a deployment that *was* manually patching the hardcoded source array or per-source paths (a pre-substrate fork): un-fork. Move the customization into `aiConfig.customSources` / `aiConfig.sourcePaths`. The registry + config substrate exists precisely to retire those forks.

## Deprecation timeline

No deprecations in Phase 0/1. The legacy single-`source`-string chunk metadata is superseded by the path-identity tuple, but `tenantId: 'neo-shared'` / `repoSlug: 'neo'` is the deterministic default — no migration window, no dual-read shim. A KB re-sync (`npm run ai:sync-kb`) re-stamps all chunks under the tuple on the next run.

## Related

- [Overview](./Overview.md) — the contract split + default-source inheritance.
- [Security](./Security.md) — tenant-isolation invariants + spoof-rejection policy choice.
- [Configuration](./Configuration.md) — tenant-config persistence (#11637).
