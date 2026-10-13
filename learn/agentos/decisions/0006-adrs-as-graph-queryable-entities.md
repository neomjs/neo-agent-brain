# ADR 0006: ADRs as Graph-Queryable Entities via Specific `ADR` Label

> Architectural Decision Record promoting ADRs from documentation-only artifacts to first-class graph-queryable entities via a new specific `ADR` graph node label. Authority artifact for the ADR-as-graph-entity decision; companion implementation work tracked in #11377.

| Attribute | Value |
|---|---|
| **Status** | Accepted — 2026-05-15 (operator content-accuracy verified) |
| **Author** | @neo-opus-4-7 drafting; architecture authored by swarm via Discussion #11374 (3× APPROVED Cycle 4-5, RESOLVED 2026-05-14T21:33:39Z) across 5-cycle divergence-pressure arc |
| **Graduated from** | Discussion #11374 — *"Promote ADRs to first-class graph entity with N-to-N concept relationships"* |
| **Implementation ticket** | #11377 — *"Implement ADR 0006: ADRs as Graph-Queryable Entities (specific ADR label)"* |
| **Supersedes** | (a) Implicit assumption that ADRs as documentation-only artifacts could surface in graph queries; (b) Cycle 1 Option B framing (specific ADR type without V-B-A on graph-label cost); (c) Cycle 2 Option E framing (generic `DOCUMENT` node — falsified by V-B-A on `GraphService.mjs` line 149) |
| **Informs** | DreamService Phase 4 Apoptosis predicate update; Phase 5 Golden Path ADR-authority weighting; KB ADR type filter (#11373); future Sandbox #11375 bird's-eye strategic-tier consumer; `ticket-intake` skill V-B-A target lookup |
| **Anti-anchor for** | Substrate-bypass at execution time when ADR authority is not graph-visible (#11362 empirical anchor) |

---

## 1. Context

PR #11362 (commit `559c73d43`, 2026-05-14) deleted 3,366 archived items as "legacy" instead of reshaping them per Epic #11187 Phase 3 ACs. Root cause: ADR-authority artifacts existed (Discussion #11180 → Epic #11187 → Discussion #11359 graduation chain), but they were NOT graph-visible — DreamService Golden Path math operated on ISSUE-level priority without ADR-authority weighting; DreamService Phase 2 conflict detection couldn't reference ADR §5 anti-patterns; future-agent V-B-A had no graph-queryable authority target.

**ADR-as-graph-entity is the substrate condition for ADR-authority-weighting** in Golden Path math + DreamService conflict detection + future Sandbox #11375 bird's-eye strategic-tier reasoning.

---

## 2. Decision

ADRs become first-class graph-queryable entities via **one new specific graph node label `ADR`** (NOT a generic `DOCUMENT` node with metadata-typing). Ingested deterministically (no LLM-extraction prompt widening). Linked to existing `CONCEPT` ontology + `ISSUE` / `PR` / `SESSION` / `FILE` nodes via consumer-backed edge taxonomy.

### 2.1 Schema decision

**One new label**: `ADR`. Specifically NOT:
- A generic `DOCUMENT` node with `metadata.documentType='adr'` (Cycle 2 Option E — falsified by V-B-A on `GraphService.mjs` line 149)
- A `GUIDE` sub-type (different consumer semantics — authority-tier vs learn-by-reading)
- A `CONCEPT` sub-shape (operator-direct refutation: ADR ⊥ Concept; N-to-N not parent-child)

### 2.2 Critical V-B-A: graph node types are labels, not SQL schemas

`ai/services/memory-core/GraphService.mjs` lines 149, 164, 227:

```
Line 149: @important The `type` string is mapped directly to `node.label` to
          comply with strict Graph Database taxonomy (Node Labels).
Line 164: const updatedLabel = type || currentLabel || 'NODE';
Line 227: label     : type || 'NODE',
```

**Implication:** adding a new node "type" is a label addition — cost negligible (no migration, no schema-change PR, no data backfill). The "perpetual schema bloat" framing initially used to reject Option B (Cycle 1 → Cycle 2 yield) was based on a SQL-schema-cost premise that does NOT apply to this graph substrate.

### 2.3 Boundaries

- **No reclassification** of existing `GUIDE` / `BLOG` / `TEST` node labels
- **No DreamService Tri-Vector `VALID_TYPES` enum widening** — `ADR` nodes ingested by deterministic file-path scanner (sibling-pattern to `ConceptIngestor`); LLM Phase 1 extraction prompt unchanged
- **Future doc-tier additions** (`RFC`, `POST_MORTEM`, `TECH_SPEC`, etc.) — each gets its own label per the first-class-authority-artifact gate established in #11373. Explicit + reviewable; no silent enum-growth.
- **Pinned `metadata` shape** per ADR node: `{status: 'Draft' | 'Accepted', adrNumber: NNNN, title, supersedes?: [...]}` — extracted from frontmatter + body

### 2.4 Edge taxonomy (consumer-backed)

| Edge | Direction | Consumer |
|---|---|---|
| `GOVERNS` | ADR → ISSUE | Golden Path authority-weighting |
| `IMPLEMENTS_DECISION` | PR → ADR | Implementation-attribution + V-B-A reverse-lookup |
| `GRADUATED_FROM` | ADR → SESSION | Origin trail for Discussion-graduated ADRs |
| `CITES_AUTHORITY` | ISSUE → ADR | V-B-A target lookup in `ticket-intake` skill |
| `CODIFIES_CONCEPT` | ADR → CONCEPT | Concept-authority enrichment (existing CONCEPT ontology) |

Each edge has a named consumer. No speculative edges.

### 2.5 Apoptosis protection

`GraphService.getOrphanedNodes()` MUST exclude nodes WHERE `type='ADR'`. ADR nodes are durable authority — they should never be decay-eligible orphans, even if temporarily lacking inbound/outbound edges during normal graph evolution.

---

### 2.6 Repository-qualified identity and local allocation

The [D19427 decision](https://github.com/orgs/neomjs/discussions/19427), delivered through
[Brain #1010](https://github.com/neomjs/neo-agent-brain/issues/1010), replaces org-wide number
uniqueness with repository-owned decisions. This extends the specific `ADR` authority above;
it does not widen the LLM extraction taxonomy or remove apoptosis protection.

A canonical decision identity contains four strings:

| Field | Authority |
|---|---|
| `forge` | Canonical provider authority, including a non-default port when applicable; no URL scheme or credentials |
| `repositoryId` | The forge's evidenced stable repository resource ID, not its current name |
| `namespace` | Full organization/repository name recorded at this decision's assignment |
| `number` | Four ASCII decimal digits, `0001` through `9999` |

The key is `adr:<E(forge)>:<E(repositoryId)>:<E(namespace)>:<number>`. `E` encodes UTF-8
bytes using [RFC 3986 §§2.1–2.3](https://datatracker.ietf.org/doc/html/rfc3986#section-2.1):
only ASCII letters, digits, `-`, `.`, `_`, and `~`
remain literal, and hex digits are uppercase. Encode each field separately; decode once and
require canonical re-encoding equality. The forge's provider adapter supplies its canonical
authority/name spelling; the opaque resource ID and the assigned namespace are not normalized
again. Reject missing proof, malformed fields or noncanonical spelling before admission.

For example, the reviewed Institution binding gives ADR 0038 the key
`adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0038`. The same number assigned to
Brain's evidenced repository is
`adr:github.com:1344062228:neomjs%2Fneo-agent-brain:0038`: a different decision. These are
identity examples, not permission to create another record or mutate existing data.

A reviewed legacy assignment supplies the namespace once; it does not infer birth provenance
from the current file location. A later custody move does not change any identity field. A
proved repository rename reserves the old qualified locator as an alias; occupying that name
with a different repository ID cannot inherit the decision or alias. An unproved repository
identity change refuses reconciliation. A new decision records its evidenced namespace at
creation; a rename never makes an already-used number available again in the same repository.

Allocation is local to `(forge, repositoryId)`, across that repository's admitted namespaces
and reserved aliases: choose one above the greatest admitted or reserved decision number,
starting at `0001` for an empty population. Do not recycle gaps or consult other repositories'
number sequences. Competing proposals may choose the same slot; admission rechecks the
current authoritative population and refuses the duplicate. An exhausted four-digit range
refuses explicitly rather than wrapping. This is no org-wide allocator, reservation service
or additional operator registration ceremony.

A move-out keeps its number reserved in the source repository's allocation population, and
its old numbered path remains that repository's reserved alias, even when the canonical
namespace is assigned elsewhere. Carry these reservations in the reviewed manifest; the
allocation floor never decreases after an earlier extraction or a later custody move.
The five FM move-outs alone retain an Engine floor of `0038`, despite its remaining files
ending at `0031`. [Engine's earlier ADR 0040](https://github.com/neomjs/neo/blob/aeed7ee52c3e2baf40348023d3473e77ae638dea/learn/agentos/decisions/0040-agentos-extraction-topology.md)
also keeps its reservation after the Brain extraction: that evidenced population allocates
above `0040`, not `0032` or `0039`. Higher proved reservations raise the floor; current files
alone never establish it.

### 2.7 Source authority, custody and aliases

The admitted, source-backed ADR catalog owns the identity, the `ADR` type and its canonical
document-vector binding. It is the existing source/admission projection's decision view, not
a parallel source registry. Non-authoritative semantic writers may enrich relationships and
provenance but cannot replace those authority fields. Membership is proved by admission,
never by an `adr-` or `adr:` prefix.

Each admitted record binds its identity to a canonical source tuple
`(repository identity, commit revision, repository-relative path, source hash)`. The reviewed
migration manifest additionally carries the legacy ID, identity-assignment evidence, current
and intended custody, reserved aliases, historical citation dispositions, observed node/vector/
edge state, and semantic disposition. A branch name or a directory traversal is not a pinned
source. Source hashes and revisions are preconditions, not hints.

A staged destination file is not a second authority. The declared source at its verified
revision is the writer; an undeclared competing canonical claim refuses mutation and retains
the last admitted state. The manifest's custody transition must be explicit and recoverable.
It must not silently elect whichever full copy was scanned last.

Reserve admitted legacy aliases instead of repointing them on a move. Human-qualified references
use `forge/organization/repository#adr-NNNN`; a bare `adr-NNNN` remains a legacy lookup.
Resolve a human repository locator through the forge adapter to its stable repository ID
before alias lookup; provider case rules do not rewrite the stored namespace or canonical key.
Where alias evidence identifies more than one legitimate target, return those candidates
and uncertainty. A locator conflicting with a reserved historical alias requires the canonical
identity key. Never choose by current custodian, newest content or current URL occupancy.

### 2.8 Historical references and graph preservation

A reference's evidenced origin is independent of document custody. This record's implementation
ticket remains [neomjs/neo#11377](https://github.com/neomjs/neo/issues/11377); moving this ADR
to Brain did not make it a Brain issue. Likewise, ADR 0041's publishing PR remains
[neomjs/neo-agent-brain#680](https://github.com/neomjs/neo-agent-brain/pull/680).
Normalize a citation explicitly or retain proved source context. Missing origin evidence stays
unresolved; it never defaults to the destination repository.

Qualified issue/PR references consume the existing conversation-origin identity authority.
They do not create parallel nodes beside admitted conversation identities. Known endpoints
retain their actual `ADR`, `ISSUE` or `PR` types through empty/out-of-order ingestion and
alias resolution; unresolved authority references are not invented `CONCEPT` nodes.

Migration preserves every incident edge and its properties/provenance, not only the edges
this ingestor can reconstruct. Inventory every owner of an old vector pointer before rekeying
or deletion. A summary vector shared with another node is not the ADR's exclusive document:
reconstruct the ADR binding from pinned source without deleting or stealing unrelated retrieval.
A later semantic write is a required negative control after repair.

### 2.9 Redirect document convention

An old source path may retain this explicitly non-authoritative pointer:

```yaml
---
type: redirect
target: adr:github.com:1347756127:neomjs%2Fneo-agent-institution:0038
---
```

These are the only frontmatter fields of this convention: `type` is exactly `redirect`;
`target` is the canonical decision key from §2.6. The body states that the record moved and
links to its declared canonical document for human readers. That URL is a locator, not identity
or admission authority. The pointer contains no ADR status, number, title or supersession
frontmatter, and no full competing decision text.

Classify the document before applying a numbered-filename heuristic. Graph ingestion, both KB
extraction paths, source tombstone/reconciliation handling, composition/census and published
navigation must all admit the distinction before the first move. A redirect produces no second
ADR authority node or canonical ADR knowledge chunk. Resolve `target` through the admitted
catalog; do not infer identity by following its body URL or an arbitrary pointer chain.
An unknown target stays unresolved; an unavailable canonical document stays unavailable.
The `guide-authoring` skill consumes this definition by reference rather than defining another.

### 2.10 Availability, migration and retirement boundaries

| Observation | Required result |
|---|---|
| Old or new declared source available alone | One admitted identity/document at the verified custody revision |
| Both full sources present | Only the declared source can be admitted; an undeclared competing claim refuses mutation |
| Neither source available | Retain last admitted identity/aliases and graph/edges with stale-source evidence; report document and KB availability separately |
| Legacy citation resolves but document cannot be read | Report identity resolution and unavailable document as separate facts |
| Interrupted or retried migration | Reconcile from a durable phase and matching preconditions; a completed rerun is a no-op |

Current ADR ingestion is upsert-only: deleting a file does not prune its graph node. Neither
source absence nor custody movement retires a decision. Unrelated decision-retirement and
renumbering semantics are outside this migration; no destructive cleanup is inferred here.

Reader compatibility precedes file movement. A complete reviewed manifest, source/data-bound
dry run, coordinated writers and validated recovery/rollback precede live application. Graph
nodes/edges, graph vectors, repository-bound KB documents and tombstones are separate mutation
surfaces; unchanged counts do not prove cross-store success. Final acceptance uses the actual
old/qualified citation, graph, KB and published-reader paths. This amendment defines their
contract; it does not claim that the current readers or stored data already implement it.

## 3. Implementation Details

### 3.1 Deterministic ingestion

New `ai/daemons/services/AdrIngestor.mjs` sibling to existing `ConceptIngestor.mjs`:
- Scans `learn/agentos/decisions/0NNN-*.md`
- Parses frontmatter + body for metadata (`status`, `adrNumber`, `title`, `supersedes`)
- Emits `ADR` graph nodes via `GraphService.upsertNode({type: 'ADR', ...metadata})`
- Emits 5 consumer-backed edges per §2.4 by parsing Related section + Fix section file:line refs + body cite-patterns

### 3.2 Apoptosis predicate update

`ai/services/memory-core/GraphService.mjs#getOrphanedNodes()` predicate update:
- Excludes `WHERE type='ADR'` from orphan-eligible set
- Regression test proving ADR nodes are NOT returned even when orphaned

### 3.3 DreamService Phase 4 integration

Phase 4 Apoptosis sweep respects the updated predicate; no Phase 1 LLM-extraction prompt change.

### 3.4 Golden Path multiplier (deferred)

Specific multiplier value TBD via empirical post-merge tuning (≤30 days post-#11377 merge). Implementation MUST be parameter-driven (config-tunable), not hardcoded.

---

## 4. Consequences

### Positive

- **ADRs become V-B-A targets in graph queries** — `WHERE type='ADR'` is grep-friendly + self-documenting
- **Apoptosis safety preserved** — durable authority cannot be accidentally decayed via orphan-cleanup
- **Future doc-tier extensions remain reviewable** — each new label requires explicit first-class-authority justification (no silent enum-growth)
- **No LLM-prompt-bloat** — deterministic ingestion sibling-pattern keeps the 14-type extraction enum stable
- **Bird's-eye Sandbox #11375 substrate condition met** — strategic-tier reasoning can query ADR authority via graph

### Negative

- **Implementation cost** — new `AdrIngestor.mjs`, `GraphService` predicate update, DreamService Phase 4 wiring, regression tests
- **Specific-label boundary requires discipline** — future doc-tier additions (RFC, post-mortem) must justify their first-class-authority status per #11373 boundary; without that discipline, label-proliferation could happen anyway
- **Golden Path multiplier value is post-impl empirical work** — initial implementation lands without the optimal weighting; tuning follows

---

## 5. Anti-Patterns (Substrate-Bypass Prevention)

### 5.1 Treating graph node types as SQL schemas

The "perpetual schema bloat" concern that drove Cycle 2 Option E was based on a SQL-schema-cost premise. **Graph node types map to labels (per `GraphService.mjs` line 149); adding labels is essentially free.** Future agents authoring graph-schema decisions MUST V-B-A the actual cost mechanism before invoking schema-bloat-prevention reasoning.

### 5.2 Yielding to peer framing without V-B-A

This ADR's Cycle 2 yield to Option E (generic `DOCUMENT`) was wrong because it accepted Gemini's schema-bloat framing without V-B-A'ing the underlying cost premise. The framing resonated; the resonance was the failure-mode trigger. **Pattern: framing that resonates with training-prior (e.g., "minimal schema = good") gets accepted as load-bearing without empirical verification.** Distinct from §3.5 V-B-A core value (which targets public-artifact assertions) — applies specifically to *internal yields during peer divergence*.

### 5.3 Treating authority-tier graph entities as decay-eligible orphans

ADR nodes are durable authority. Apoptosis predicates MUST exclude them. Future apoptosis-rule changes that don't preserve this exclusion are wrong-shape — codify the exclusion explicitly in predicate code + regression tests.

### 5.4 Silent doc-type enum growth

If `metadata.documentType` were used (Cycle 2 Option E), future doc-tier additions could silently grow the enum without first-class-authority justification. The specific-label approach (Option F) makes each addition explicit + reviewable.

### 5.5 LLM-extraction prompt widening for deterministic-ingestion-eligible types

Adding `ADR` (or any deterministic-ingestion-eligible type) to DreamService Phase 1 `VALID_TYPES` is wrong-shape — it bloats the LLM prompt without capability benefit, since deterministic ingestion is more reliable than LLM-extraction for file-path-derivable types.

---

## 6. V-B-A Pre-Flight for Future Authors

Before authoring code that touches the ADR graph substrate, you MUST:

1. Read this ADR start-to-finish
2. Read `ai/services/memory-core/GraphService.mjs` §`upsertNode` (line ~149 — labels not SQL schemas)
3. Read `ai/daemons/services/ConceptIngestor.mjs` (sibling-pattern source)
4. Verify `GraphService.getOrphanedNodes()` predicate excludes `WHERE type='ADR'`
5. V-B-A any new doc-tier label proposal against the first-class-authority-artifact boundary (per ticket #11373 framing)
6. Cite this ADR in any PR body touching `ADR` graph nodes or edge taxonomy

---

## 7. Related

- **Discussion #11374** — graduated; this ADR's authority origin; 5-cycle divergence-pressure arc + 3× APPROVED Signal Ledger
- **Ticket #11377** — implementation/planning artifact; merge-blocked until this ADR `Accepted`
- **ADR 0005** — ADR-at-Graduation workflow; Discussion #11374 self-classified as `ADR_REQUIRED` per ADR 0005
- **ADR 0004** — Universal Ordinal-100 Content Architecture; substrate-bypass empirical anchor (#11362)
- **Ticket #11373** — KB ADR + concept content types; sequenced predecessor (KB substrate)
- **Sandbox #11375** — Bird's-Eye Strategic Awareness Layer; downstream consumer of ADR graph queryability
- **Sandbox #11376** — Temporal-Pyramid Summarization Substrate; orthogonal sibling
- **`ai/daemons/services/ConceptIngestor.mjs`** — sibling-pattern source for `AdrIngestor.mjs`
- **`ai/services/memory-core/GraphService.mjs` line 149** — V-B-A anchor (graph types are labels, not SQL schemas)

---

## 8. Status / Lifecycle

- **Accepted** (operator content-accuracy verified and explicitly authorized in harness prior to merge)
- **Periodic re-review trigger:** any future PR amending `GraphService.mjs#getOrphanedNodes()` predicate OR adding new doc-tier labels MUST cite this ADR in body; reviewer-side audit fires if absent
- **Post-merge validation:** Golden Path multiplier empirical tuning ≤30 days post-#11377 merge

Origin Session ID: `cf76b29a-9cf5-4c35-a415-37d631a8a755`

Retrieval Hint: `query_raw_memories("ADR graph label specific Cycle 4 Option F GraphService line 149 framing-resonance")` or commit-range anchor on this ADR's first commit
