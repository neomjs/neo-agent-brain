# The aiConfig configuration model

> **Non-authoritative intent notes.** The authority for every AiConfig pattern, antipattern, and sanctioned shape is [ADR 0019](decisions/0019-aiconfig-reactive-provider-ssot.md) — the read-gate every `ai/` config touch must consult first. If this page and the ADR ever disagree, the ADR wins.

> The Brain's configuration (`aiConfig`) is **hierarchical nested data**: a tree of `Neo.state.Provider`s where each layer owns only its slice and inherits the rest up a parent chain. This page is the *intent* behind that shape. Read it before changing how config is loaded, merged, or migrated — the model quietly makes several "obvious" approaches (source-level drift detection, overlay cloning, hand-written merge) the **wrong layer**.

## The shape

`Neo.ai.ConfigProvider extends Neo.state.Provider`, so every config *is* a reactive state provider, and they compose into one tree:

- **Tier-1 — `Neo.ai.Config`** (singleton): the *realm root*. It owns the deployment-wide leaves — model providers, `auth`, `ollama` / `openAiCompatible`, storage, the orchestrator intervals.
- **Per-server configs — `Neo.ai.mcp.server.<name>.Config`**: children of the realm root. Each owns only the leaves that are genuinely server-local — the Knowledge Base's `collectionName`, the Memory Core's `memorySharing`, and so on.

A child resolves a leaf it does not own by walking **up** to the owner: `getOwnerOfDataProperty` checks the local data first, then delegates to `getParent()`. The Brain has no component tree, so `ai/ConfigProvider.mjs` overrides `getParent()` to return the Tier-1 singleton — that override is what roots the realm chain.

This is the same hierarchy the Body uses for component state providers. The canonical illustration lives in [examples/stateProvider/advanced](https://github.com/neomjs/neo/blob/dev/examples/stateProvider/advanced/MainContainer.mjs): a `Panel` reads `button1Text` that only the top-level `Viewport` owns (the lookup walks up), and a write to `button1Text` *initiated on the Panel* bubbles up and lands on the `Viewport`'s provider, which owns it.

Two properties fall out of "each layer owns only its slice":

1. **Reads resolve override-else-inherit, lazily, per key.** No layer holds a copy of another layer's data.
2. **Writes bubble to the owner.** `setData('auth.realm', …)` on a server config lands on Tier-1, because Tier-1 owns `auth`.

## Leaves and the env layer

A config's `data` is a *meta-leaf tree* — each leaf is `leaf(default, env?, type?)`. `ConfigProvider.compileMetaLeaves` walks it into (a) plain reactive data and (b) a metadata registry keyed by dotted path. A bounded **env layer** then overlays environment variables onto env-bound leaves — re-resolved at construction and on explicit refresh, never live-per-read (a port that silently moves without a coordinated restart is a footgun, not a feature). See `ai/ConfigProvider.mjs`.

## Templates, overlays, and why advancement is *inheritance*

Each config realm has three roles:

- a tracked `configBase.mjs` owns the canonical defaults and formulas;
- a tracked, thin `config.template.mjs` registers the canonical singleton for clean checkouts and tests;
- a gitignored, thin `config.mjs` registers the operator singleton and carries only operator **deltas**.

Both thin singletons subclass the same base. Their Tier-1 import must evaluate before the base, so the tracked entry inherits the tracked realm root while a materialized operator entry inherits the operator root.

The trap — and the reason this page exists — is to treat the overlay as a **clone** of the template that must be kept in sync as the template evolves. Down that road lie source-level drift detectors (regex-parsing `.mjs` text for leaf paths) and source-level merges (splicing new leaves into the operator's file, normalizing commas and indentation). **That is the wrong layer.** A config is not text to diff and splice; it is a mergeable data tree the Provider already resolves hierarchically and merges deeply:

- `data_` is a `merge: 'deep'` descriptor — *"when new data is assigned, it will be deeply merged with existing data."*
- `setData(obj)` recursively merges an object into the reactive tree, creating missing leaves and keeping existing ones.
- `load()` merges a JSON overlay into reactive data the same way.

So the model that follows from the hierarchy:

- An overlay **owns only the operator's overrides** and inherits everything else from its canonical base. It cannot go "stale": a base that grows a leaf is inherited automatically, because the new leaf lives in the parent class, not in a frozen copy.
- "Advancing" an overlay to a newer template is therefore **not an operation at all** — there is nothing to reconcile. Operator overrides persist as the child's own data; new defaults arrive by inheritance.
- The override channels are the **env layer** (bounded env vars) and the **overlay's own data** (operator deltas, including a JSON delta via `load()`).

Legacy full-snapshot overlays are the bounded transition exception. `migrateConfigOverlay.mjs` parses their declarations only to produce a reviewed delta subclass: preview is the default, `--write` creates a colocated backup, and unattended setup never takes that write path. Once converted, there is no recurring source reconciliation.

The one-line test: **if ordinary advancement parses or rewrites config *source* to reconcile a template and an overlay, stop.** You are re-implementing — by hand, and fragilely — inheritance and deep merge against a clone that should never have existed.

### The one way an overlay *does* go stale: a key that is removed

Inheritance protects an overlay against a base that **grows**. It cannot protect it against a base that **drops a key**, and that case is silent by construction: the overlay keeps its own value, nothing reads it any more, and no error is raised. An operator sees their setting present in the file and inert in the process.

So a removed key is an operator break and belongs here, not only in a PR body.

**2026-09-04 — the Knowledge Base child Chroma keys were removed.** `host`, `port` and `path` no longer exist on the KB config; they were same-meaning aliases of Tier-1 coordinates (ADR-0019 §3 C4) and the last of them wrapped `AiConfig.engines.chroma.dataDir` under a docblock asserting the two "MUST equal".

| if your overlay sets | it now does nothing | set instead |
|---|---|---|
| KB `host` | ✗ inert | `NEO_CHROMA_HOST`, or Tier-1 `engines.chroma.hostProd` |
| KB `port` | ✗ inert | `NEO_CHROMA_PORT`, or Tier-1 `engines.chroma.portProd` |
| KB `path` | ✗ inert | `NEO_CHROMA_DATA_DIR`, or Tier-1 `engines.chroma.dataDirProd` |

**This is a one-line move, not a capability loss** — every replacement above already worked before the removal, because Tier-1's leaves bind the identical environment variables. Nothing that was reachable became unreachable.

**Not measurable from this repository.** Operator overlays live in deployments, so the affected set is a known-unmeasurable rather than an asserted-clean. Internal consumers were censused and migrated in the same change.

## Related

- [examples/stateProvider/advanced](https://github.com/neomjs/neo/blob/dev/examples/stateProvider/advanced/MainContainer.mjs) — the canonical hierarchical-state illustration (read up, write-to-owner).
- [src/state/Provider.mjs](https://github.com/neomjs/neo/blob/dev/src/state/Provider.mjs) — `getOwnerOfDataProperty`, owner-routed `setData` / `internalSetData`, and the `data_` `merge: 'deep'` descriptor.
- [ai/ConfigProvider.mjs](../../ai/ConfigProvider.mjs) — the meta-leaf compile, the bounded env layer, and the `getParent()` override that roots the realm chain.
- [Cloud-Native KB Ingestion — Configuration](./cloud-deployment/Configuration.md) — the operator-facing config keys this model carries.
