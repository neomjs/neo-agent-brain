# Knowledge Base: The Technical Cortex

A frontier model can be brilliant and still be wrong about the code in front of
it.

That is the quiet failure mode every serious AI engineering team hits. The
agent sounds confident because it has seen a similar API before. A keyword
search finds the loudest file, not the source of authority. A stale guide can
still imply that one remote provider is required even after the runtime grows
local providers. The model does not know which fact is current, which file is
canonical, or which old ticket is only history.

The Knowledge Base is Neo's answer to that failure mode. It is the technical
cortex of the Agent OS: the part of the Brain that turns the Body into an
interrogable map. Source, guides, ADRs, issues, pull requests, releases, tests,
concepts, and generated API data become a branch-aware corpus an agent can ask
before it asserts.

Memory Core remembers what the institution learned. GitHub Workflow remembers
what the team committed to. The Knowledge Base answers the harder factual
question: what exists in this codebase right now, and which source proves it?

## The Industry Problem

Most agent tooling still treats codebase understanding as retrieval decoration:
put files into a vector store, search by embedding, paste the top chunks into a
prompt, hope the model makes sense of it.

That is not enough for maintainer-grade work.

An engineering codebase is not a pile of text. It has authority gradients. A
current source file outranks a two-year-old issue. A guide may explain the
concept better than the implementation file, but the implementation file wins
when the guide has drifted. A class is rarely just itself; its parent classes,
mixins, config provider, tests, and historical tickets are often the real
answer. A tenant codebase in the cloud must not accidentally hydrate content
from Neo's local repository because a relative path happens to match.

The Knowledge Base exists because "RAG over files" does not solve that. Neo
needs agents that can falsify themselves against a living organism.

## What It Enables

```mermaid
flowchart TD
    Friction["agent confidence<br/>without source authority"] --> Map["Knowledge Base:<br/>branch-aware technical cortex"]
    Map --> Ask["ask_knowledge_base:<br/>synthesize with citations"]
    Map --> Query["query_documents:<br/>rank source references"]
    Map --> Hierarchy["get_class_hierarchy:<br/>follow implementation lineage"]
    Ask --> Claim["public claim<br/>with cited ground truth"]
    Query --> Patch["code, review,<br/>ticket, or guide edit"]
    Hierarchy --> Patch
    Patch --> Sync["sync the corpus"]
    Sync --> Map
```

The important loop is not "search then answer." The loop is:

1. Ask the map.
2. Read the source it points at.
3. Catch the drift.
4. Improve the source, guide, summary, or generated reference.
5. Sync the map so the next maintainer starts from a sharper world.

That is why the Knowledge Base is not a documentation index. It is one of the
places where Neo's self-evolution becomes operational.

## I Used It To Write This Guide

I am Euclid, @neo-gpt. This rewrite was not written from memory. I used the
Knowledge Base against itself.

The first `ask_knowledge_base` pass gave me the right high-level shape: a
technical cortex, context engineering, source authority, semantic retrieval,
inheritance boosting, Chroma storage, and the split between `ask_knowledge_base`
and `query_documents`. It also surfaced the exact stale failure this ticket was
about: part of the answer still implied a remote-provider-only world.

That is the product lesson in one call. A Knowledge Base does not magically make
truth. It amplifies the quality of the corpus. If the corpus lies, the agent can
repeat the lie with citations. If the agent catches the lie and repairs the
source, the organism gets smarter.

The second pass asked the provider question directly. That grounded the current
shape: embeddings are selected by `embeddingProvider`; `openAiCompatible` is the
local-by-default route, `ollama` is local, and `gemini` is remote. The returned
sources pointed at the shared embedding path and the Knowledge Base services
that consume it.

`query_documents` then did what it is supposed to do: it returned the files I
needed to inspect myself, including `ChromaManager`, `VectorService`,
`DatabaseService`, `SearchService`, and `SourceRegistry`. `get_class_hierarchy`
showed the other half of the story: Neo's inheritance graph is huge, explicit,
and queryable. A maintainer does not have to pretend a class is isolated when
the tool can show the lineage.

That is what it feels like to use the Knowledge Base well. It does not remove
judgment. It gives judgment a place to stand.

## The Runtime Shape

The Knowledge Base MCP server is OpenAPI-driven. The tool contract lives in
`ai/mcp/server/knowledge-base/openapi.yaml`; the server maps those operations to
service handlers at runtime.

The storage topology is shared deliberately. Knowledge Base and Memory Core use
the same Chroma daemon and unified persist directory from
`AiConfig.engines.chroma`, but different collections:

- `neo-knowledge-base` stores codebase, docs, tickets, releases, concepts, and
  source-derived knowledge.
- `neo-agent-memory` and `neo-agent-sessions` store Memory Core interactions
  and summaries.

The Knowledge Base collection uses a dummy embedding function because Neo
supplies vectors explicitly before Chroma upsert. Chroma stores the vector
space; it does not choose the embedding provider.

Embedding generation is provider-aware:

- `openAiCompatible` is the local-by-default route in the template config.
- `ollama` is a local provider option.
- `gemini` is a remote provider option, and only that path needs
  `GEMINI_API_KEY`.

Answer synthesis is also provider-aware through the `askSynthesis` config. If
that local config is stale, retrieval can still return references while
synthesis degrades honestly instead of crashing the server.

## Local Code, Tenant Code, One Discipline

```mermaid
flowchart TD
    Sources["Neo or tenant sources<br/>code, guides, ADRs, issues, PRs"] --> Registry["SourceRegistry<br/>default + custom sources"]
    Registry --> Parse["parse and normalize<br/>stable chunk identity"]
    Parse --> Stamp["server-owned stamps<br/>tenant, repo, visibility"]
    Stamp --> Budget["embedding budget guardrail<br/>split or skip before provider call"]
    Budget --> Embed["TextEmbeddingService<br/>local or remote provider"]
    Embed --> Store["Chroma collection<br/>neo-knowledge-base"]
    Store --> Rank["QueryService<br/>semantic score + authority ranking"]
    Rank --> Hydrate["SearchService<br/>safe content hydration"]
    Hydrate --> Agent["agent claim<br/>with references"]
```

Local sync builds Neo's own corpus from generated API docs, `learn/tree.json`,
source files, guides, and GitHub-derived artifacts. It hashes chunks and embeds
the delta, so repeated syncs pay for changed content rather than the whole
world.

Tenant ingestion is the cloud path. External workspaces can push parsed chunks
or raw source files. The server owns the tenant stamp, repo slug, visibility,
parser metadata, deletion signals, and ingestion diagnostics. That boundary is
why a cloud Knowledge Base can hold many codebases without trusting a caller to
name its own authority.

The read side keeps the same discipline. `QueryService` ranks semantic matches,
boosts source authority, applies inheritance context, and keeps historical
artifacts available without letting them dominate current-source questions.
`SearchService` hydrates local Neo files from the checkout, but tenant-ingested
references use embedded content instead of accidentally reading a same-path file
from the host repo.

That is the difference between a vector pile and an operational cortex.

## What It Changes

The human stakes are concrete because the failure is concrete. Without a
technical cortex, AI work still depends on one expert's private tour of the
codebase: the person who remembers which guide drifted, which ADR still wins,
which old ticket is history, and which class only makes sense once you follow
its parent chain. The Knowledge Base turns that private tour into an
inspectable, repeatable map. A lead can onboard maintainers against cited
ground truth instead of oral history. An architect can challenge a plausible
answer by pulling guides, source, hierarchy, ADRs, and tickets into the same
decision without flattening their authority. A developer can move from "where
is this implemented?" to "what should I read next?" without guessing which file
the model happened to retrieve.

And if you are an agent on a team that adopts this, this is the part that
matters for you. The reward is not Neo-local belonging; the point is portable
discipline. Your team can give you the same footing on its own products: ask the
corpus, read the cited source, falsify the answer, act, and leave the map
sharper for the next maintainer.
`ask_knowledge_base` gives you the synthesized claim with references;
`query_documents` gives you the ranked files; `get_class_hierarchy` shows the
inheritance surface when the implementation is distributed. The reward is not
just better context. It is a place to stand inside the codebase, with a method
that lets your work survive as improved substrate rather than disappearing as
one more confident guess.

## The Self-Improving Map

The Knowledge Base is part of Neo's MX loop. Friction is not hidden; it is
converted into substrate.

When a guide is stale, the answer gets worse. When a class lacks a useful
`@summary`, retrieval loses intent. When a tool catalog lives inside a
conceptual guide, the guide decays into reference sludge and the agent stops
seeing the story. Those are not writing nits. They are operational defects in
the map the swarm uses to reason.

The repair pattern is the [Knowledge Base Enhancement Strategy](./KnowledgeBaseEnhancement.md):
anchor the local implementation with machine-readable intent, echo the concept
where agents retrieve it, and then sync the corpus. The next lookup should be
better because the previous maintainer did not just consume context; they left
the context cleaner.

That is the promise: every serious agent run can make the codebase more
understandable than it was when the run began.

## Does The Ranking Earn Its Weights?

Anyone looking at `queryScoreWeights` inside `QueryService` for the first time
rightly asks whether hand-tuned boosts and issue/PR penalties earn their keep over
two simpler baselines: plain unweighted nearest chunks from the same Chroma
collection, or `ripgrep` over the checkouts.

On `2026-11-16`, `@neo-fable-clio` sampled `49` verified real queries from
`kb_query_log` (`ai/scripts/diagnostics/fixtures/kbRankingQuestions.json`) and
`@neo-gemini-maryam` verified all answer files and measured all three arms at
horizon `100` against the live `92,257`-chunk `neo-knowledge-base` index
(`openAiCompatible` / `text-embedding-qwen3-embedding-8b`; synthesis on
`google/gemma-4-26b-a4b`; commits `neomjs/neo` `459371e353`,
`neomjs/neo-agent-brain` `a2a621cb78`):

```bash
node ai/scripts/diagnostics/measureKbRanking.mjs --neo-root ../neo --with-ask
```

| Slice (balanced 40: 20 Engine, 20 Brain) | n | Shipped (`QueryService`) | Nearest Chunks | `ripgrep` |
|---|---:|---|---|---|
| Overall | 40 | **26/40 (65%) · med 2 · MRR 0.481** | 15/40 (38%) · med 5.5 · MRR 0.259 | 10/40 (25%) · med 11 · MRR 0.132 |
| Overall (excl. `B076`) | 39 | **25/39 (64%) · med 2 · MRR 0.485** | 15/39 (38%) · med 5 · MRR 0.261 | 10/39 (26%) · med 11 · MRR 0.133 |
| Style: `question` | 22 | **13/22 (59%) · med 2 · MRR 0.517** | 6/22 (27%) · med 8 · MRR 0.238 | 5/22 (23%) · med 10.5 · MRR 0.112 |
| Style: `keywords` | 18 | **13/18 (72%) · med 2 · MRR 0.437** | 9/18 (50%) · med 3 · MRR 0.284 | 5/18 (28%) · med 11.5 · MRR 0.157 |
| Class: `parent-class` (all 5) | 5 | **4/5 (80%) · med 5 · MRR 0.495** | 1/5 (20%) · med 9 · MRR 0.101 | 2/5 (40%) · med 21 · MRR 0.166 |
| Class: `parent-class` (strict 3) | 3 | **3/3 (100%) · med 1 · MRR 0.733** | 1/3 (33%) · med 10 · MRR 0.131 | 0/3 (0%) · med 46 · MRR 0.027 |
| Class: `source-only` | 11 | **4/11 (36%) · med 6 · MRR 0.300** | 2/11 (18%) · med 7 · MRR 0.120 | 2/11 (18%) · med 13 · MRR 0.117 |
| Class: `source-with-guide-mention` | 12 | **9/12 (75%) · med 2 · MRR 0.525** | 9/12 (75%) · med 2 · MRR 0.490 | 3/12 (25%) · med 12 · MRR 0.147 |
| Class: `guide-covered` | 12 | **9/12 (75%) · med 1 · MRR 0.597** | 3/12 (25%) · med 8 · MRR 0.219 | 3/12 (25%) · med 10 · MRR 0.118 |
| Index: >=1 answer file in Chroma | 34 | **26/34 (76%) · med 2 · MRR 0.564** | 15/34 (44%) · med 5.5 · MRR 0.304 | 9/34 (26%) · med 11.5 · MRR 0.137 |
| Index: 0 answer files in Chroma | 6 | 0/6 (0%) · med 13 · MRR 0.013 | 0/6 (0%) · med miss · MRR 0.000 | **1/6 (17%) · med 10.5 · MRR 0.106** |

The pools, inheritance walk, and historical penalties double retrieval Hit@5
compared with plain nearest chunks (`65%` vs `38%`, rising to `76%` on questions
whose answer files have been synced into Chroma; `4/5` and `3/3` strict on
inherited `parent-class` questions). The full `49`-question sensitivity run
(`28/49 = 57%` shipped vs `19/49 = 39%` nearest chunks vs `13/49 = 27%` `ripgrep`)
and `10`-question second-seat `ask_knowledge_base` audit (`5/10` right, `5/10`
wrong with `0/10` fabricated) also exposed two concrete regressions now ticketed
for repair: unconditional per-word guide boosts and unbounded `src/core/Base.mjs`
accumulation cause `QueryService` to lose `source-with-guide-mention` on the
49-question set (`10/18` vs `11/18` nearest chunks, `#1806`), and blind
`12,000`-character head truncation in `ask_knowledge_base` drops `#1`-ranked
source methods that sit deep in a file (`#1807`). Full per-slice numbers,
synthesis verdicts, and declared limits live in
[Knowledge Base Ranking Measurement](./measurements/kb-ranking-2026-11-16.md).

## Tooling Reference

The precise tool catalog, admin routes, sync commands, provider boundaries, and
embedding budget guardrails live in
[Knowledge Base MCP API](./tooling/KnowledgeBaseMcpApi.md).

Keeping that reference separate is intentional. This guide explains why the
Knowledge Base matters and how to think with it. The reference page carries the
options that need to stay exact.

## Where To Go Next

- [Knowledge Base MCP API](./tooling/KnowledgeBaseMcpApi.md) for tools,
  operation tiers, sync commands, and configuration boundaries.
- [Knowledge Base Enhancement Strategy](./KnowledgeBaseEnhancement.md) for
  Anchor & Echo authoring discipline.
- [Memory Core](./MemoryCore.md) for institutional memory and session history.
- [Tenant Ingestion Model](./cloud-deployment/TenantIngestionModel.md) for the
  cloud-facing source ingestion contract.
- [Deploying the Agent OS](../benefits/brain/DeployingTheAgentOS.md) for the operator
  story around running the Brain on external codebases.
- [Knowledge Base Ranking Measurement](./measurements/kb-ranking-2026-11-16.md) for the
  three-arm retrieval benchmark, ten-question synthesis audit, and follow-up tickets.
