# ADR 0014: Cloud Deployment Topology + Scheduler Task Taxonomy

> Architectural Decision Record for the **D0** critical-path workstream of Epic #11720 (*Cloud Agent OS Deployment Readiness*, graduated from Discussion #11718). Classifies every `Orchestrator` scheduler lane as `cloud-deployable` / `local-only` / `shared primitive`, and records the target production deployment topology. This ADR is the decision input that unblocks Sub B (#11723), Sub C (#11724), Sub D (#11725), and Sub F1 (#11727).

| Attribute | Value |
|---|---|
| **Status** | Accepted — 2026-05-21 (D0 decision record merged via PR #11738 with cross-family review, per ADR 0005 lifecycle) |
| **Author** | @neo-opus-4-7 (Claude Opus 4.7) drafting; substrate-truth grounded in the live `ai/daemons/` source audited at `dev` |
| **Resolves** | #11721 — *"Cloud deployment topology + scheduler-task-taxonomy ADR"* (D0 of Epic #11720) |
| **Graduated from** | Discussion #11718 (*Cloud Agent OS Deployment Readiness*) → Epic #11720 |
| **Unblocks** | #11723 (Sub B — container topology), #11724 (Sub C — reference compose), #11725 (Sub D — healthcheck / journey proof), #11727 (Sub F1 — cookbook) |
| **Informs** | #11722 (Sub A — deployment-mode feature toggles), #11726 (Sub E — tenant-repo ingestion model) |
| **Anti-anchor for** | Containerizing the mixed-responsibility `Orchestrator` as-is; mono-container deployment; ADR-as-options-workspace |

---

## 1. Context

Epic #11720's mission: an external dev team can deploy Neo's Agent OS (KB + MC MCP servers + `Orchestrator` + supporting infra) into a containerized cloud environment and use it against their own repositories — *without tacit maintainer knowledge*.

The blocking gap is not a missing capability — it is **substrate drift plus an un-containerizable supervisor**. `deploy/cloud/docker-compose.yml` is a stale 3-service baseline (`chroma` + `kb-server` + `mc-server`) and carries **no `Orchestrator`**. And the `Orchestrator` cannot simply be added: `Neo.ai.daemons.Orchestrator` is a **mixed-responsibility local Agent OS supervisor**. Its `poll()` loop schedules one task set that interleaves cloud-relevant maintenance lanes with local-maintainer-only lanes (`git pull origin/dev`, local-worktree discovery, `osascript` / `tmux` desktop-harness wake-delivery). Containerizing it as-is drags local-only behavior into a cloud tenant deployment.

D0 is the **first** Epic workstream because the topology cannot be designed until every scheduler lane is classified. **The classification *is* the unblock:** once the local-only lanes are identified and excluded by config, the `Orchestrator` has no local-checkout / git / desktop-harness dependency and containerizes cleanly.

**Substrate audited at `dev`:** `ai/daemons/TaskDefinitions.mjs`, `ai/daemons/Orchestrator.mjs#poll`, `ai/daemons/services/PrimaryRepoSyncService.mjs`, `ai/daemons/wake/daemon.mjs`, `buildScripts/ai/syncKnowledgeBase.mjs`, `ai/daemons/services/GoldenPathSynthesizer.mjs`, `buildScripts/ai/backup.mjs`, `deploy/cloud/docker-compose.yml`.

## 2. Decision

### 2.1 Scheduler task taxonomy

`Orchestrator.poll()` drives its scheduler lanes under a **two-role authority topology**. Every lane
carries exactly one authority class, and each role admits a fixed set of classes:

| Authority class | Meaning | Admitted by role |
|---|---|---|
| `host-edge` | Needs the maintainer host itself — a local checkout, a desktop harness to key into, or host-local inference. Cannot run inside the container plane. | host-edge only |
| `container-plane` | Runs inside the dockerized deployment. Needs no host checkout and no desktop harness. | container-plane only |
| `shared-primitive` | Infrastructure that lanes depend on and no lane owns. Admitted **only** by the container-plane role — a host-edge process does not run it. | container-plane |

**The per-lane assignment is NOT restated here.** It lives in
`ai/daemons/orchestrator/taskAuthority.mjs` — `TASK_AUTHORITY_BY_NAME` for the lane→class map and
`AUTHORITY_CLASSES_BY_PROFILE` for the role→classes map, both frozen and fail-closed. That file is the
single source of truth; a table in this document would be a second copy free to disagree with it, which
is exactly the drift that made this ADR dangerous to read (#16571).

What a decision record owns, and the runtime map cannot express, is the **discriminator**: a lane is
`host-edge` if and only if it requires the maintainer host — a local git checkout, `osascript` / `tmux`
desktop-harness delivery, or host-local model inference. Everything else is `container-plane`. Apply
that test when classifying a new lane, then record the result in the runtime map, not here.

**Adding a lane is a decision, not a config change.** Classify it against the discriminator above
before implementation — §9's re-review trigger fires on every new lane.

#### Per-lane host dependency — the D0 findings

These are the substantive audit results this ADR was written to record: for each lane D0 examined,
**what** it needs and therefore whether it can leave the maintainer host. The findings are durable —
they describe what the code requires, which does not change when the classification vocabulary does.
The resulting authority class is deliberately absent; read it from `TASK_AUTHORITY_BY_NAME`.

| Lane | Kind | Host dependency, and what it implies |
|---|---|---|
| `chroma` | compose-managed container | The unified vector store — ADR 0003, as amended by ADR 0017 (single flat `unified` store, dev/prod parity). It is a compose-managed container with its own `healthcheck:`, **not** an `Orchestrator`-supervised child: `hostEdgeProfile.mjs` sets `NEO_ORCHESTRATOR_CHROMA_DAEMON_ENABLED: 'false'`, so the host-edge role does not supervise it either. No lane owns it and the lanes that use it are container-plane, which is why it is `shared-primitive` rather than a lane of its own. |
| `bridgeDaemon` | continuous | `ai/daemons/wake/daemon.mjs` delivers A2A wake digests to *local desktop agent harnesses* via `osascript` (macOS) / `tmux` keystroke simulation. **Requires a desktop harness to key into.** (A2A *message storage* via the MC server is separate and has no host dependency — distinct from this wake-*delivery* daemon.) |
| `mlx` | continuous (default off) | `mlx_lm.server` is macOS / Apple-Silicon local inference. **Requires host-local inference.** Model inference elsewhere is a *provider-profile* decision (external API default; a self-hosted container is a variant), not an `Orchestrator` child. Already `NEO_ORCHESTRATOR_MLX_ENABLED`-gated, default `false`. |
| `summary` | periodic, heavy | `summarize-sessions.mjs` digests agent sessions from the graph and writes summaries back. **No host dependency** — verified, no git / spawn. Needs a model-provider endpoint. |
| `kbSync` | periodic, heavy | `syncKnowledgeBase.mjs` runs `KB_DatabaseService.syncDatabase()` — a full re-scan of the Neo repo's own corpus. D0 recorded this as checkout-bound; it has since been made to run without the maintainer checkout (#16556), which is why its authority class today is not what D0 assumed. **The audit finding stands; the conclusion drawn from it moved.** |
| `backup` | periodic, heavy | `backup.mjs` exports the Chroma + SQLite substrates. **No host dependency.** Its best-effort `git rev-parse HEAD` bundle-meta stamp degrades to `null` without `.git` — graceful, and an awareness note rather than a blocker. |
| `primary-dev-sync` | periodic, heavy | `PrimaryRepoSyncService` is pure maintainer machinery: `git fetch` / `pull --ff-only origin/dev`, worktree discovery, `resources/content/.sync-metadata.json` reset, local `ai:sync-kb` cascade. **Requires a local checkout.** |
| `dream` | periodic, heavy | DreamService REM-sleep graph extraction — Memory Core intelligence. **No host dependency** — verified, no git / spawn. Needs a provider endpoint. |
| `golden-path` | periodic, light | The Hybrid GraphRAG synthesis (Chroma semantic + SQLite structural scoring → the Computed Golden Path) is pure graph/vector, **no host dependency**. **Caveat:** two enrichment sections — "Active PR Cycle State" (`gh pr list`, hardcoded to the Neo swarm logins) and "Latest Priority Backlog" (a local `resources/content/issues` scan) — are Neo-maintainer-repo-specific. Both degrade gracefully (`try/catch` → empty section), so the lane runs correctly either way, but they are inert noise outside the maintainer repo. Graceful degradation is not the same as belonging (§5.4). |

The `Orchestrator` has since grown well past these lanes — `TASK_AUTHORITY_BY_NAME` carries **29** at the
time of writing. Only the lanes D0 actually audited are listed here; a lane added later carries its
rationale in the ticket that introduced it, per §9.

### 2.2 Target production deployment topology

A **multi-container** topology — per-service resource isolation is the devops concern motivating the mission; a mono-container defeats it. Logical services:

| Service | Container | Today | D0 decision |
|---|---|---|---|
| `chroma` | dedicated | exists | keep; the unified vector store per ADR 0003 |
| `kb-server` | dedicated | exists | keep; add a Docker `healthcheck:` block (today only `chroma` has one) |
| `mc-server` | dedicated | exists | keep; add a Docker `healthcheck:` block |
| **`orchestrator`** | **dedicated — NEW** | **absent** | **the core D0-unblocked gap** — a new container running the cloud-safe `Orchestrator` profile (§2.3) |
| model provider | endpoint (not necessarily a container) | absent | a swappable provider profile; an external API is the MVP default; a self-hosted provider container is a **D1 variant**, not the MVP. The `Orchestrator` *consumes* a provider endpoint — model runtime is **not** co-located with it by default. |

Topology-level gaps recorded here and routed to their owning subs (D0 decides; it does not build):
- **Persistence / redeploy survival** — Chroma data, the SQLite graph, and backup bundles must sit on volumes that survive container rebuild. Today `chroma-data` + `shared-sqlite-data` volumes exist; **no backup volume.** → Sub C #11724.
- **Per-container resource limits** — absent entirely today. → Sub B #11723.
- **Deployed healthcheck / readiness semantics** — `kb-server` / `mc-server` / `orchestrator`. → Sub D #11725.
- **External exposure** — internal-`expose`-only today; reverse-proxy refs exist but are unwired (known port mismatch). → Sub C #11724.

### 2.3 The cloud-safe `Orchestrator` profile

The cloud `orchestrator` container derives its admitted work from the fail-closed runtime authority
map and deployment-profile leaves; it no longer owns a frozen four-lane list in this ADR.
`host-edge` work such as `primary-dev-sync`, local model launchers, and `bridgeDaemon` is not admitted
to the container plane. The current map is authoritative for the complete population.

`kbSync` is now a **container-plane** lane. The container is the checkout carrying the shared Neo
corpus, so the old checkout-bound classification no longer applies. Its `cloudOnly.kbSyncEnabled`
leaf is the clean disable/enable surface, and both the scheduled lane and the
`primary-dev-sync` cascade require the same explicit authorization; the cascade helper admits
strict `true` only. `tenant-repo-sync` remains a separate container-plane lane over GitMirror and
must never be folded into `kbSync`.

The `chroma` shared primitive is **not** `Orchestrator`-supervised in cloud — compose owns the `chroma` container lifecycle.

### 2.4 Cloud-profile negative-behavior contract

The cloud profile asserts the **absence of host effects**, not the absence of `kbSync`. It MUST NOT
run `git pull origin/dev`, perform maintainer-worktree discovery or metadata resets, launch host-local
model processes, or deliver `osascript` / `tmux` desktop-harness wakes. Those effects belong to
`host-edge` lanes. A container-plane `kbSync` scans only the image-carried shared Neo corpus; it does
not authorize a host checkout mutation or tenant acquisition.

### 2.5 Stale-ADR sweep — 0003 / 0009

Per the Epic, D0 sweeps the two existing daemon-relevant ADRs:
- **ADR 0003 (Chroma Topology — Unified Only)** — **not stale.** It already anticipates an "independently hosted ChromaDB instance"; the cloud `chroma` container *is* that unified instance. Cross-referenced here as the authority for the `chroma` = shared-primitive classification. No amendment. *(Update 2026-05-29: ADR 0003 is subsequently amended by ADR 0017 — single flat `unified` store + dev/prod parity — refining the store's on-disk layout + persist-path config. The `chroma` = shared-primitive / one-container classification recorded here is unaffected.)*
- **ADR 0009 (Cross-Daemon Heavy-Maintenance Lease Inheritance)** — **not stale.** The file-lease serializes the heavy lanes (`summary` / `kbSync` / `backup` / `primary-dev-sync` / `dream`) across processes; in a single-`orchestrator`-container cloud deployment it is a degenerate-but-correct safety net. No amendment.

Broader deployment-doc / ADR reconciliation beyond 0003 / 0009 is tracked by the #11720 owner map and its follow-up tickets; #11729 was closed after D0 owner-map narrowing.

## 3. Decision Process — Rejected Alternatives

| Option | Rejection rationale |
|---|---|
| **Containerize the current `Orchestrator` as-is** | It is mixed-responsibility; it would drag `git pull origin/dev`, worktree discovery, and `osascript` wake-delivery into a cloud tenant deployment. The task taxonomy must split the lanes *first* — that is the entire reason D0 gates Sub B/C/D. |
| **Mono-container deployment** (one container, all services) | Defeats per-service resource isolation — the explicit devops concern motivating the mission. Heavy LLM-inference lanes (`summary` / `dream`) need a resource envelope distinct from the request-serving MCP servers. |
| **Drop the `Orchestrator` from the cloud MVP** (ship KB + MC + Chroma only) | The adoption-ladder proof requires `backup` → redeploy-survival, and the Memory Core digestion pipeline (`summary` / `dream` / `golden-path`) *is* the Agent OS's value. Shipping only the MCP servers deploys a data store, not the Agent OS. |
| **Co-locate the model runtime with the `Orchestrator`** | The `Orchestrator` is a control-plane process that *consumes* a provider endpoint. Bundling a model runtime couples a swappable profile choice to the control plane and inflates its resource envelope. Provider = endpoint profile (D1). |
| **Treat this ADR as an open A/B/C/D options workspace** | An ADR is a decision *record* — chosen outcome + rejected options — per ADR 0005 / 0006. D0 records a made decision; D1–D4 variant exploration belongs to the owning subs. |

## 4. Consequences

### Positive
- **The `Orchestrator` remains containerizable** — authority projection excludes every host effect while allowing container-owned corpus maintenance. The taxonomy *is* the unblock.
- **Sub B / C / D / F1 are unblocked** with a decided topology and a classified lane set, instead of guessing.
- **The cloud profile is contract-bound** — the negative-behavior contract (§2.4) gives Sub D a precise, falsifiable assertion target.
- **Profile-derived service count** — the container count follows the topology (§2.2), not a target number.

### Negative / handoffs
- **Profile and authority are independent axes** — classifying a lane container-plane does not start it; the deployment-profile leaf still decides enablement. New lanes must wire both or risk a valid owner with no producer.
- **`golden-path` carries Neo-maintainer-repo-specific enrichment** — its "Active PR Cycle State" (`gh pr list`) and "Latest Priority Backlog" (`resources/content/issues` scan) sections degrade gracefully but emit per-cycle warnings + dead sections in a tenant deployment. Routed to Sub A #11722 for deployment-mode gating; a friction → gold cleanup, not an MVP blocker.
- **The digestion lanes (`summary` / `dream` / `golden-path`) need a reachable provider endpoint in cloud** — a deployment without a configured provider runs a degraded Agent OS. The provider-profile decision (D1) is a near-dependency, not fully independent.

## 5. Anti-Patterns

### 5.1 Re-merging local-only lanes into the cloud profile
A change that enables host-effect lanes such as `primary-dev-sync`, local model launchers, or
`bridgeDaemon` in a cloud deployment re-introduces the un-containerizable mixed-responsibility shape.
The authority profile is a contract, not a default-config convenience.

### 5.2 Feeding tenant repositories through `kbSync`
`kbSync` owns the image-carried **shared Neo corpus**. Tenant content arrives through push ingestion
or the separate `tenant-repo-sync` GitMirror lane. Re-pointing `kbSync` at tenant repositories, or
admitting the same shared Neo repository through both lanes, creates two acquisition authorities over
one corpus. Tenant onboarding must choose the owning lane explicitly rather than double-ingesting it.

### 5.3 Letting the container count lead the topology
Service boundaries derive from the lane taxonomy + resource-isolation needs. Picking "N containers" first and back-filling responsibilities inverts the decision.

### 5.4 Treating graceful degradation as cloud-readiness
`golden-path`'s Neo-repo enrichment sections *degrade* gracefully — they do not *belong* in a tenant deployment. Graceful degradation is a safety net, not a substitute for deployment-mode gating.

## 6. Boundary — What D0 does NOT decide

- **The compose / Dockerfile implementation** — Sub B #11723 (multi-container, resource limits, profile variants) + Sub C #11724 (reference compose, proxy / TLS wiring, redeploy-safe persistence).
- **Healthcheck implementation + journey proof** — Sub D #11725.
- **The model-provider profile** (external API vs self-hosted container) — D1, owned by Sub B's decision record.
- **Server-side repo cloning** — a D3 exploration; out of scope (push-based ingestion is the MVP default).
- **SQLite → networked-SQL graph-store migration** — D5; deferred (Epic #11730 residual).

## 7. Related

- **Epic:** #11720 (Cloud Agent OS Deployment Readiness)
- **Resolves:** #11721 (D0)
- **Origin Discussion:** #11718 — §5/D0; orchestrator-role-split anchor `DC_kwDODSospM4BA4F9`
- **Unblocks:** #11723, #11724, #11725, #11727
- **Informs:** #11722 (Sub A — the toggle + `golden-path`-gating handoff), #11726 (Sub E — the local `kbSync` exclusion is *why* push-based ingestion is the cloud KB path)
- **ADRs:** 0003 (unified Chroma — swept, not stale), 0009 (cross-daemon lease — swept, not stale), 0005 (ADR-at-graduation), 0006 (ADRs as graph-queryable entities)
- **Substrate:** `ai/daemons/TaskDefinitions.mjs`, `ai/daemons/Orchestrator.mjs`, `ai/daemons/services/PrimaryRepoSyncService.mjs`, `ai/daemons/wake/daemon.mjs`, `buildScripts/ai/syncKnowledgeBase.mjs`, `ai/daemons/services/GoldenPathSynthesizer.mjs`, `buildScripts/ai/backup.mjs`, `deploy/cloud/docker-compose.yml`

## 8. Amendments

### 2026-05-22 — `swarm-heartbeat` lane added to the taxonomy (#11766)

After this ADR was accepted, [#11766](https://github.com/neomjs/neo/issues/11766) folded the swarm heartbeat from a standalone launchd daemon (`ai/scripts/swarm-heartbeat-daemon.mjs` + `swarm-heartbeat.sh` + `com.neomjs.swarm-heartbeat.plist`) into an `Orchestrator` scheduler lane. The §2.1 taxonomy is amended to include it — the `Orchestrator` now drives **ten** scheduler lanes, not nine.

| Lane | Kind | Classification | Rationale |
|---|---|---|---|
| `swarm-heartbeat` | periodic, light | **Requires a desktop harness to key into.** | `SwarmHeartbeatService.pulse()` delivers wake events to *local desktop agent harnesses* via `osascript` (macOS) / `tmux` keystroke simulation — the same wake-*delivery* dependency that makes `bridgeDaemon` local-only (§2.1). A cloud tenant deployment has no local harness apps to key into. (A2A *message storage* + the TTL sweep stay cloud-relevant — distinct from this wake-*delivery* lane.) |

**Historical summary at this amendment:** cloud-deployable = `{summary, backup, dream, golden-path}` · local-only = `{bridgeDaemon, mlx, kbSync, primary-dev-sync, swarm-heartbeat}` · shared primitive = `{chroma}`. The 2026-08-05 amendment below supersedes the `kbSync` row.

**Cloud disable is a config default, not a hardcode.** The cloud `Orchestrator` profile disables the lane via the `localOnly.swarmHeartbeatEnabled` config key (`NEO_ORCHESTRATOR_SWARM_HEARTBEAT_ENABLED` env override) — resolved by the same `assignLocalOnlyToggle` deployment-mode mechanism §2.3 uses for the other local-only lanes. The lane is not stripped from the build. This is the deliberate forward-compat seam: post-v13, agents could run inside a container deployment, which would flip `swarmHeartbeatEnabled` back on with no code redesign. The lane's exclusion from the cloud profile is a profile contract (§5.1), not a permanent capability removal.

### 2026-05-23 — tenant-repo pull-ingestion lane + server-side-cloning boundary update (#11740)

Epic [#11731](https://github.com/neomjs/neo/issues/11731) (*Server-side tenant-repo ingestion for cloud Agent OS deployments*, graduated from Discussion #11782) adopts server-side pull-based tenant-repo KB ingestion as a post-MVP path **additive** to the #11726 push-based model. This amendment fires per §9's own re-review trigger — #11731 introduces a new `Orchestrator` scheduler lane — and updates the §6 scope boundary. ADR successor-risk verdict (per `adr-successor-risk-audit.md`): `adr-amendment-required` — the §2.1–§2.4 D0 MVP decision is **not** invalidated, so this is an amendment, not a supersession.

**§6 boundary updated.** §6 records *"Server-side repo cloning — a D3 exploration; out of scope (push-based ingestion is the MVP default)."* That boundary was correct **for Epic #11720's D0 MVP** and the MVP default is unchanged. Epic #11731 is the post-MVP follow-up that brings server-side pull-ingestion **into scope** — as an additive tenant-ingestion option, not a replacement for push-based ingestion (#11726).

**New lane — decision-level classification (implementation: #11790).** #11731's decomposition routes the pull-ingestion lane to sub #11790 (*tenant-repo-sync scheduler lane*), backed by a persistent GitMirror primitive (#11788) and a diff-to-ingest envelope builder (#11789). Per §9, the lane is classified here at the decision level; #11790 owns the `buildTaskDefinitions()` key, cadence config, and disable toggle.

| Lane | Kind | Classification | Rationale |
|---|---|---|---|
| `tenant-repo-sync` | periodic, heavy | **No host dependency.** Pulls tenant-repo content into the KB via a credentialed persistent GitMirror (#11788) + diff-to-ingest envelope (#11789). It clones what it needs, so it requires no maintainer checkout and runs wherever the KB does. `TASK_AUTHORITY_BY_NAME` has it `container-plane`, and it is enabled on any plane that has tenant repos configured — including the canonical one. Distinct from `kbSync` — see below. |

**`kbSync` stays a separate lane; §5.2 is reinforced, not weakened.** At the time of this amendment `kbSync` was understood as checkout-bound (the Neo-maintainer corpus scan). That is **no longer its authority class** — `TASK_AUTHORITY_BY_NAME` has both `kbSync` and `temporal-summary` as `container-plane`, because the container *is* the checkout: it is built from the repo and carries `learn/`, `src/`, `resources/content/` and `.git` at the built revision, which is every source those lanes read (`taskAuthority.mjs:70`). What this amendment decided — that tenant ingestion is a distinct lane — is unaffected. Tenant pull-ingestion is a **separate lane** (`tenant-repo-sync`) backed by a **separate primitive** (GitMirror, #11788) — *not* a re-pointed `kbSync`. §5.2's anti-pattern (*"Re-pointing the local `kbSync` lane at tenant content"*) stands and is reinforced: #11731 deliberately does not re-point `kbSync`; it adds the deliberate lane/service boundary §5.2 implied was the correct path. Maintainer-checkout `kbSync` and tenant pull-ingestion are two distinct concepts and must not be conflated.

**Credential boundary — recorded, not yet blessed deployable.** This amendment blesses the *architectural shape* (a distinct cloud-deployable lane) — it does **not** mark the pull-ingestion path production-deployable. Per #11740 AC4, the credential / token / env-var contract — credentialed repo access that persists no secrets in `repoSlug`, logs, manifests, or graph-visible config — is specified by sub #11787 and is a hard prerequisite before `tenant-repo-sync` is marked production-ready.

**Forward-looking taxonomy.** The lane does not yet exist in `buildTaskDefinitions()`; #11790 adds it. When #11790 lands, the `Orchestrator` will drive **eleven** scheduler lanes, and the cloud-deployable set becomes `{summary, backup, dream, golden-path, tenant-repo-sync}` (the local-only and shared-primitive sets unchanged).

### 2026-07-11 — temporal-pyramid aggregation lane classification (#14938)

Epic #12679's temporal-pyramid substrate (ADR 0028) adds a durable L1/L2 aggregation lane to the `Orchestrator`. This amendment fires per §9's re-review trigger — #14938 introduces a new `Orchestrator` scheduler lane — and classifies it here at the decision level. ADR successor-risk verdict: `adr-amendment-required` — the §2.1–§2.4 D0 MVP decision is **not** invalidated.

**New lane — decision-level classification (implementation: #14938).** The lane is a supervised one-shot child (`supervised-child-process`, spawned per due tick — no independent poller), owning the `buildTaskDefinitions()` key `temporal-summary`, the `intervals.temporalSummary` cadence, and the `localOnly.temporalSummaryEnabled` disable toggle.

| Lane | Kind | Classification | Rationale |
|---|---|---|---|
| `temporal-summary` | periodic, heavy | **Reads checkout-bound sources, which the container provides.** The aggregation folds — the repo-tracked GitHub sync under `AiConfig.projectRoot/resources/content` (PRs, Discussions), `git log --first-parent origin/dev`, and `learn/agentos/decisions/` — into the durable `SUMMARY_SESSION` / `SUMMARY_DAILY` records. A cloud tenant deployment has neither the Neo-maintainer checkout nor `origin/dev`; its corpus arrives via push-ingest (the §2.1 `kbSync` / `tenant-repo-sync` boundary), not this local scan. Mirror of the other local-only heavy lanes. |

**Cloud disable is a config default, not a hardcode.** The cloud profile disables the lane via `localOnly.temporalSummaryEnabled` (`NEO_ORCHESTRATOR_TEMPORAL_SUMMARY_ENABLED` env override), resolved by the same deployment-mode mechanism the other local-only lanes use. The `temporalSummaryEnabled` getter ANDs that deployment gate with the ADR 0028 opt-in (`AiConfig.temporalSummary.aggregationEnabled`), so the lane runs only in a local profile that has explicitly opted in. Forward-compat seam: a future container deployment with a mounted corpus could flip it back on with no code redesign.

**Historical summary at this amendment:** local-only = `{bridgeDaemon, mlx, kbSync, primary-dev-sync, swarm-heartbeat, temporal-summary}` (cloud-deployable + shared-primitive sets unchanged). The 2026-08-05 amendment below reclassifies `kbSync` and `temporal-summary`.

### 2026-07-30 — exhaustive host-edge / container-plane authority projection (#16166)

The original taxonomy correctly separated cloud-deployable, local-only, and shared primitives, but
the runtime grew beyond its last amendment: additional continuous children, digestion lanes,
health/watchdog lanes, and local process effects were not represented in one mechanically exhaustive
surface. #16166 projects the decision vocabulary into a fail-closed runtime authority map and names
the target two-role topology:

| Runtime authority class | Continuous children | Scheduled tasks | Target owner |
|---|---|---|---|
| `host-edge` (the operational form of `local-only`) | `bridgeDaemon`, `neuralLinkBridge`, `mlx`, `ollama`, `lms` | `kbSync`, `githubWorkflowSync`, `primary-dev-sync`, `temporal-summary`, `swarm-heartbeat` | host-edge orchestrator |
| `container-plane` (cloud-capable Agent OS work) | `embedDaemon`, `messageDaemon` | `summary`, `memory-summary-backfill`, `backup`, `graphlog-compaction`, `tenant-repo-sync`, `dream`, `message-concept-harvest`, `golden-path`, `embed-drain-liveness-watchdog`, `rem-consolidation-liveness-watchdog`, `data-integrity-sweep` | container plane |
| `shared-primitive` | `chroma` | — | container plane in the split topology; Compose owns its lifecycle |

This table is the 2026-07-30 projection snapshot. The 2026-08-05 amendment below moves `kbSync`
and `temporal-summary` to `container-plane`; `TASK_AUTHORITY_BY_NAME` remains current authority.

The three recurring poll-side effects which are neither child processes nor cadence-picked tasks are
also explicit container-plane lanes: `boot-identity-fact`, `deployment-state-bridge`, and
`freeze-reprobe`. This prevents internal post-pipeline work from becoming an unclassified route
around the two registries. A host-edge scheduler also projects persisted task state to its owned set,
so stale plane-task `running` flags from the former mixed supervisor cannot backpressure local work.

`chromaDefrag` is an explicit auxiliary-child registry entry rather than a continuous or scheduled
lane; it follows `chroma`'s shared-primitive authority and can run only where Chroma supervision
itself is enabled.

The local compatibility profile (`legacy-mixed`) temporarily owns all three classes; it is not part
of the target split and has an explicit retirement trigger in ADR 0019 §10.8.

Two constraints are now mechanical:

1. the continuous-child, scheduling, recurring-internal, and auxiliary-child registries project
   `authorityClass` from the same task map, so a newly registered lane without an ADR
   classification fails construction/test; and
2. the canonical `{host-edge, container-plane}` matrix must yield exactly one owner for every
   registered lane before work begins.

Per-lane toggles still decide whether owned work is enabled; they cannot move work across the
authority boundary. In particular, a container-plane profile cannot opt into desktop wake,
maintainer-worktree mutation, Neural-Link process ownership, or local model launchers.
The shared Chroma row remains a capability taxonomy statement: in the target topology its effective
owner is the container plane while the Compose service, not the orchestrator child supervisor,
executes that lifecycle.

### 2026-07-30 — one-machine hard cut elects a graphless host receiver (#16167, #16180)

The authority matrix above remains the fail-closed classification for Orchestrator lanes, but it
does not require every deployment to run both Orchestrator roles. On the sole known local Agent OS
machine, #16167 elects the final topology as a `container-plane` Compose Orchestrator plus the
signed `ai/daemons/wake/receiver.mjs` from #16180, supervised by a per-user LaunchAgent. The
receiver has no graph, SQLite, or Memory Core config dependency; it accepts only a signed Shape-B
envelope and executes the addressed local adapter. No `host-edge` Orchestrator runs after the cut.

This is a deployment election, not a fourth authority class. The standalone receiver owns only
durable webhook acceptance plus host-local delivery state; matching, coalescing, and retry remain
inside container Memory Core. It cannot dispatch the other host-edge scheduler lanes. Local
Neural Link, model-provider, and checkout-sync capabilities therefore need an explicit
surviving consumer or are retired in #16167's immediate cleanup series. The
`{host-edge, container-plane}` audit remains valid while both Orchestrator profiles exist, and its
`legacy-mixed` compatibility row plus the Shape-C graph worker sunset after the accepted receipt.

### 2026-07-31 — receiver-only local election superseded by the missing host-actuation incident (#16210)

The receiver-only deployment election above did not instantiate the already-ratified `host-edge`
Orchestrator role. The cutover therefore removed the only owner capable of starting and loading the
host LM Studio provider. Container Memory Core and Knowledge Base stayed reachable while their
embedding provider was absent, making semantic retrieval unavailable despite green process-level
health. This falsifies the receiver-only election; it does not change the exhaustive authority map.

The canonical local topology now runs two invocations of the same scheduler engine:

1. Compose runs `authorityProfile=container-plane` on Docker-owned volumes for graph, embedding,
   summary, mini-summary, Dream, backup, and other plane maintenance.
2. launchd runs `authorityProfile=host-edge` with a distinct host-only state root. It does not
   assert or open the Docker plane. The initial deployment explicitly enables only LM Studio
   lifecycle and disables checkout/corpus, graph, Neural Link, heartbeat, and legacy
   Shape-C wake lanes.

The signed graphless Shape-B receiver remains a separate final-mile security boundary; reinstating
the host-edge Orchestrator does not reinstate the retired GraphLog wake daemon. Any additional
host-edge lane must prove that it needs a real host effect and that all KB/MC interaction crosses
authenticated Streamable HTTP. A local SQLite or Chroma path is not an acceptable consumer seam.

Revalidation trigger: if the selected model provider moves fully into Compose, or another durable
host supervisor replaces the host-edge role, re-evaluate whether this second scheduler invocation
still owns any enabled lane.

### 2026-08-05 — `kbSync` + `temporal-summary` reclassified local-only → container-plane (#16554)

**The §2.1 classification was correct and its premise expired.** Both lanes were classed local-only
because they scan the Neo repo's own corpus *"from the local checkout"*. The non-dockerized local
Agent OS has since been retired **deliberately**, so no local checkout runs a scheduler. The
checkout did not disappear — it moved: the container is built from the repo and carries `learn/`,
`src/`, `resources/content/` and `.git` at the built revision, which is every source both lanes
read.

**Measured consequence of leaving them unmoved.** The container plane declined both lanes to
`host-edge`; `src/composition/orchestrator/hostEdgeProfile.mjs` declined the same lanes as *"lanes this topology does
not elect for the host edge"*. Five lanes ended up with no owner and `lastRunAt = NEVER`, and the
Knowledge Base ran to **0 documents** with no producer. `auditAuthorityTopology` passed throughout,
correctly: it audits **class ownership**, and enablement is a different axis.

**What did not change.** §5.2's anti-pattern stands unweakened: this does **not** re-point `kbSync`
at tenant content, which remains `tenant-repo-sync`'s job on its own GitMirror primitive. Only the
*where it runs* moved, not the *what it reads*. `primary-dev-sync` stays host-edge — it mutates a
working tree, which is a genuine host effect. `githubWorkflowSync` and `swarm-heartbeat` stay
host-edge-classed and remain deliberately disabled (CI owns corpus publication; the Stop hook makes
heartbeat redundant).

**Ownership does not start a lane, and the enablement is declared separately.** Both leaves stay
under `orchestrator.localOnly`, whose `null` default resolves local-enables / cloud-disables — so on
a cloud-mode plane the new owner would never start what it owns. `deploy/cloud/docker-compose.yml`
therefore declares `NEO_ORCHESTRATOR_KB_SYNC_ENABLED=true` and
`NEO_ORCHESTRATOR_TEMPORAL_SUMMARY_ENABLED=true` as deployment inputs, the same class of artifact as
`hostEdgeProfile`'s closure.

**Why not relocate the leaves to `cloudOnly`,** which is semantically tidier: `kbSync` is the
canonical example lane across the orchestrator scheduling fixtures, so flipping its default group
inverts it for every local-mode consumer and every spec using it as a stand-in for "a schedulable
heavy lane" — **measured at 13 specs** against a clean-`dev` control. The leaf group encodes default
policy; a deployment declaring its own lanes is the narrower change and leaves local behaviour
untouched.

**The host-edge closure keeps both keys.** `hostEdgeProfile` still sets them `'false'`, alongside
`CHROMA_DAEMON` and `EMBED_DAEMON`, which are container-plane classed and have always been listed
there. That closure declares what a **graphless** process must not start — a capability claim, not
an ownership one — and it survives reclassification unchanged. Removing the keys was tried and
reverted; `ParityPlaneVolumeScoping` caught it.

**Revalidation trigger:** re-derive both classifications if any of these change — (a) a durable
non-containerized maintainer scheduler is reinstated; (b) the container ceases to be built from the
repo (e.g. a slim runtime image without `resources/content`); (c) the compose enablement lines are
dropped, or the leaves are relocated to `cloudOnly` without re-basing the fixtures that use `kbSync`
as their example lane. The container-as-checkout premise is what (a) and (b) rest on and it is as
mortal as the one it replaced; (c) is the quieter one, because it disables the lanes while
contradicting nothing.

### 2026-08-12 — role-isolated two-lane provider profile (#17019, epic #17018, D#17015)

Graduated from Discussion #17015 (§6.2 family-keyed quorum: Claude `AUTHOR_SIGNAL` + GPT
`GRADUATION_APPROVED`, both at body-r6) after the 2026-08-12 external-plane incident evidence
(epic #16706). ADR successor-risk verdict: `adr-amendment-required` — the D0 decision is **not**
invalidated. **Two of its decisions are load-bearing and are explicitly preserved:**

1. **The model runtime is a provider endpoint the `Orchestrator` consumes — never co-located with
   the control plane** (§2.2 model-provider row; §3's rejected co-location option). Unchanged.
2. **Multi-container topology exists for per-service resource isolation** (§2.2; §3's rejected
   mono-container option). Unchanged — this amendment is that decision applied to the provider
   itself.

**What changes: the provider profile splits into two role-isolated lanes.** §2.2's single
"model provider" row read the provider as one swappable endpoint profile (external API MVP
default; a self-hosted container as the D1 variant). Measured production evidence falsified the
one-endpoint shape for constrained CPU planes: a single ollama server serving both models
serializes embeddings behind its per-model `parallel=1` force (embedding-only models are forced to
one slot at pinned `v0.23.1` — `server/sched.go#L412-L417` — AND at current stable `v0.32.9` —
`server/sched.go#L497-L503`), and a 131k chat warm collapsed embedding throughput to 3
completions per 17 minutes on a 4-CPU envelope (receipts: epic #16706, D#17015 r6).

The provider profile is now **two lanes under one declared resource envelope**:

| Lane | Engine class | Roles routed to it | Contract |
|---|---|---|---|
| **Chat** | native Ollama (self-hosted container) | `modelProvider` (MC session/mini summaries), `graphProvider` (REM Tri-Vector, topology inference, Golden Path synthesis), KB `askSynthesis.{provider,model,baseUrl}` | large context (131k-class), parallelism 1 |
| **Embedding** | OpenAI-compatible (llama.cpp-server class; `learn/agentos/cloud-deployment/LlamaCppProfile.md` is its doc home) | `embeddingProvider` (KB + MC, every embedding collection) | hard model ceiling enforced **per-slot** (slot truth: `--ctx-size` is TOTAL across `-np` slots; the startup receipt, not the knob, is verified), parallelism elected empirically from {1,2,4} under the preserved envelope |

Binding rules recorded with the profile (authoritative AC text: D#17015 r6, implemented by epic
#17018's subs):

- **Resource axis:** one explicitly declared total CPU/memory envelope with per-lane allocation.
  An engine split without a resource policy preserves the contention class it exists to remove.
- **Four-route consumer map:** the three chat selectors and the embedding selector above are the
  complete routing contract; a consumer constructing a provider directly (bypassing the
  selectors) is a defect, not a variant.
- **Elected values are immutable declarative deployment inputs** after canonical-plane election —
  not runtime adaptation knobs.
- **Version currency:** engine images are pinned to explicit versions with a named
  bump-and-revalidate ritual; version-anchored scheduler/source claims are dated facts and
  re-verify on bump.
- **Embedding-generation identity:** changing any load-bearing embedding-generation coordinate
  creates a new corpus generation, elected through the coordinated vector-plane contract
  (D#17015 AC-C/AC-E) — never mixed generations in a live collection.

**Rejected alternatives** (full falsifiers in D#17015's divergence matrix): two ollama containers
(the per-model `parallel=1` force holds at both audited versions; re-entry gate = an exact runner
receipt showing the embedding model loaded with `parallel=4`); a tuned single ollama (no role
controls, keeps the abandoned-embedding-work class); LM Studio headless on Linux (partial parity
by construction; no credibility inheritance from the macOS mixed-engine stack).

**Revalidation trigger:** re-derive the lane split if (a) the audited ollama scheduler force is
lifted in a pinned-and-verified version, (b) the constrained plane gains a GPU-class provider
whose single-server per-model controls satisfy both lanes' contracts, or (c) role-scoped
same-type host leaves land (D#17015 fallback topology A), which changes the config surface this
profile routes through.

### 2026-08-31 — repository-bound hierarchy identity for tenant ingestion (#263)

The repository split invalidated one ambient identity input: tenant ApiSource extraction could read
the installed Engine hierarchy even while materializing a Brain or tenant repository revision. An
Engine-generated map cannot enumerate classes that exist only in another repository, and `extends`
participates in chunk identity. Same source revision plus a different ambient map therefore produced
a different corpus while the materialization receipt still named only the source revision.

Tenant repository ingestion now receives a pure, identity-bearing hierarchy resolver through its
repository execution context. The resolver reads only the exact scoped revision reader, reuses
SourceParser's class-description universe, and owns its own `id` and `version`; no config surface may
restate those coordinates. For hierarchy-consuming profiles, resolver identity is part of the
existing extraction/materialization identity. A version change at the same Git SHA forces null-base
full replay, proof replacement, and extraction-currency reconciliation. Profiles whose descriptors
do not consume hierarchy do not churn when the resolver version changes.

This does **not** make `get_class_hierarchy` tenant-aware. `QueryService.getClassHierarchy()` remains
the explicit static Neo-only MCP surface backed by the tracked Engine hierarchy artifact. The legacy
multi-root `ApiSource.extract()` wrapper also retains that artifact until the shared core-corpus scan
is ported to repository profiles; its interim coverage baseline retires at that migration, while the
tracked artifact remains for the static public query.

The lane boundary is unchanged and now stated in current terms: `kbSync` is container-plane and owns
the image-carried shared Neo corpus; `tenant-repo-sync` owns tenant GitMirror acquisition. The
scheduled `kbSync` route and every `primary-dev-sync` cascade door share the same strict authorization
gate (`true` only). Neither authorization nor container ownership permits re-pointing `kbSync` at
tenant repositories or admitting the same shared Neo repository through both lanes.

ADR successor-risk verdict: `adr-amendment-required` — the original D0 checkout-local premise and
missing-toggle rows were correct at acceptance and are superseded by the runtime authority map,
deployment-profile leaves, strict cascade authorization, and repository-bound extraction described
above. The topology decision itself remains accepted.

**Revalidation trigger:** re-evaluate this amendment if `kbSync` stops scanning an image-carried
checkout, `get_class_hierarchy` becomes tenant-aware, hierarchy ceases to participate in chunk
identity, or tenant acquisition no longer runs through an exact revision reader.

## 9. Status / Lifecycle

- **Accepted** after PR #11738 merged to `dev` with cross-family review. Re-open the decision only if Sub B / C / D discovers evidence that invalidates the taxonomy.
- **Periodic re-review trigger:** any PR that enables a `local-only` lane in a cloud profile, or adds a new `Orchestrator` scheduler lane, MUST cite this ADR and classify the lane.

Origin Session ID: `8e1dc8ca-b5a5-4479-b3cf-31918eb4a5b2` (Epic #11720 / D0 #11721 graduation lineage; this ADR authored in the continuing #11720 implementation sprint)

Retrieval Hint: `query_raw_memories("cloud deployment topology scheduler task taxonomy D0 #11721 orchestrator local-only lanes")`
