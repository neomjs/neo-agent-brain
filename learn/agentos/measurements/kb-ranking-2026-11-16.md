# Knowledge Base 3-Arm Ranking Measurement (2026-11-16)

> **Status: MEASURED ON LIVE CORPUS (`92,257` CHUNKS).** All counts, ranks, and MRR figures below come directly from `ai/scripts/diagnostics/measureKbRanking.mjs` over the pre-registered query-log fixture (`ai/scripts/diagnostics/fixtures/kbRankingQuestions.json`) without tuning weights.

## Provenance & Method

- **Ticket:** `neomjs/neo-agent-brain#1800`
- **Instrument:** `ai/scripts/diagnostics/measureKbRanking.mjs`
- **Fixture:** `ai/scripts/diagnostics/fixtures/kbRankingQuestions.json` (`49` verified query-log questions; pre-registered balanced `40` = `20` `neomjs/neo` + `20` `neomjs/neo-agent-brain`)
- **Question picker:** `@neo-fable-clio` (`kb_query_log` via `list_agent_faqs(refresh=true, minCount=1, limit=300)` at `2026-11-16T10:20:00Z`)
- **Independent answer-file verifier & second-seat `ask` judge:** `@neo-gemini-maryam`
- **Measured commits:**
  - `neomjs/neo`: `459371e3539b61006b08cb3619dad1a6d5d5e312` (`459371e353`)
  - `neomjs/neo-agent-brain`: `a2a621cb78d4b94054a0c4bed9b4cb38f5629386` (`a2a621cb78`)
- **Live index & models:**
  - Collection: `neo-knowledge-base` (`92,257` chunks across `default_database`, local primary repo sources last synced `2026-08-14`, `github-content-sync` synced through `2026-11-16`)
  - Embeddings: `openAiCompatible` / `text-embedding-qwen3-embedding-8b`
  - Answer synthesis (`SearchService#ask`): `openAiCompatible` / `google/gemma-4-26b-a4b`

### Three Arms Compared (`horizon = 100`)

1. **Arm A — Shipped (`QueryService#queryDocuments`):** Stratified 4-pool candidate retrieval (`0.65` primary, `0.20` secondary, `0.10` historical, `0.05` custom), weighted scoring (`queryScoreWeights`), inheritance chain boosts, and local lexical rescue (`limit: 100`).
2. **Arm B — Nearest Chunks (unweighted):** Single unfiltered `collection.query({queryEmbeddings, nResults: 100})` on `neo-knowledge-base`, folded to distinct source files in closest-chunk order without pools, weights, inheritance boost, or lexical rescue.
3. **Arm C — `ripgrep` (content words):** Case-insensitive word-bounded alternation (`\b(?:w1|w2|...)\b`) over all lowercase content tokens (`length >= 3`, non-stopword) across both checkouts (`neomjs/neo` and `neomjs/neo-agent-brain`, `rg --count-matches -i`), ordered by match count descending.

### Reproducing Commands

```bash
# Primary pre-registered balanced 40-question benchmark + 10 judged ask_knowledge_base runs
node ai/scripts/diagnostics/measureKbRanking.mjs --neo-root ../neo --with-ask

# Full 49-question sensitivity run across all verified query-log rows
node ai/scripts/diagnostics/measureKbRanking.mjs --neo-root ../neo --all-49
```

## Primary Results: Balanced-40 Set (`20` Engine + `20` Brain)

Each cell reports `Hit@5 / n (%) · median found rank · MRR`. Only `34/40` questions have at least one verified answer file present in Chroma (`6/40` post-August files are unindexed: `E021`, `E032`, `E132`, `B023`, `B073`, `B117`).

| Slice | n | Arm A: Shipped (`QueryService`) | Arm B: Nearest Chunks (unweighted) | Arm C: `ripgrep` (content words) |
|---|---:|---|---|---|
| Overall | 40 | **26/40 (65%) · med 2 · MRR 0.481** | 15/40 (38%) · med 5.5 · MRR 0.259 | 10/40 (25%) · med 11 · MRR 0.132 |
| Overall (excl. `B076`) | 39 | **25/39 (64%) · med 2 · MRR 0.485** | 15/39 (38%) · med 5 · MRR 0.261 | 10/39 (26%) · med 11 · MRR 0.133 |
| Style: `question` | 22 | **13/22 (59%) · med 2 · MRR 0.517** | 6/22 (27%) · med 8 · MRR 0.238 | 5/22 (23%) · med 10.5 · MRR 0.112 |
| Style: `keywords` | 18 | **13/18 (72%) · med 2 · MRR 0.437** | 9/18 (50%) · med 3 · MRR 0.284 | 5/18 (28%) · med 11.5 · MRR 0.157 |
| Repo: `neomjs/neo` | 20 | **14/20 (70%) · med 1 · MRR 0.552** | 8/20 (40%) · med 4 · MRR 0.280 | 4/20 (20%) · med 14 · MRR 0.095 |
| Repo: `neomjs/neo-agent-brain` | 20 | **12/20 (60%) · med 3 · MRR 0.410** | 7/20 (35%) · med 6 · MRR 0.237 | 6/20 (30%) · med 10 · MRR 0.170 |
| Class: `parent-class` (all 5) | 5 | **4/5 (80%) · med 5 · MRR 0.495** | 1/5 (20%) · med 9 · MRR 0.101 | 2/5 (40%) · med 21 · MRR 0.166 |
| Class: `parent-class` (strict 3) | 3 | **3/3 (100%) · med 1 · MRR 0.733** | 1/3 (33%) · med 10 · MRR 0.131 | 0/3 (0%) · med 46 · MRR 0.027 |
| Class: `source-only` | 11 | **4/11 (36%) · med 6 · MRR 0.300** | 2/11 (18%) · med 7 · MRR 0.120 | 2/11 (18%) · med 13 · MRR 0.117 |
| Class: `source-with-guide-mention` | 12 | **9/12 (75%) · med 2 · MRR 0.525** | 9/12 (75%) · med 2 · MRR 0.490 | 3/12 (25%) · med 12 · MRR 0.147 |
| Class: `guide-covered` | 12 | **9/12 (75%) · med 1 · MRR 0.597** | 3/12 (25%) · med 8 · MRR 0.219 | 3/12 (25%) · med 10 · MRR 0.118 |
| Index: >=1 answer file in Chroma | 34 | **26/34 (76%) · med 2 · MRR 0.564** | 15/34 (44%) · med 5.5 · MRR 0.304 | 9/34 (26%) · med 11.5 · MRR 0.137 |
| Index: 0 answer files in Chroma | 6 | 0/6 (0%) · med 13 · MRR 0.013 | 0/6 (0%) · med miss · MRR 0.000 | **1/6 (17%) · med 10.5 · MRR 0.106** |

## Sensitivity Run: All 49 Verified Questions (`29` Engine + `20` Brain)

Adding the 9 remaining Engine rows (`42/49` with >=1 indexed answer file; `7/49` with 0 indexed because `E066` `src/gantt/DependencyStore.mjs` is post-August) tests all 18 `source-with-guide-mention` questions and exposes the exact regression where shipped weights lose to unweighted retrieval:

| Slice | n | Arm A: Shipped (`QueryService`) | Arm B: Nearest Chunks (unweighted) | Arm C: `ripgrep` (content words) |
|---|---:|---|---|---|
| Overall | 49 | **28/49 (57%) · med 2.5 · MRR 0.438** | 19/49 (39%) · med 5.5 · MRR 0.256 | 13/49 (27%) · med 11 · MRR 0.152 |
| Overall (excl. `B076`) | 48 | **27/48 (56%) · med 2 · MRR 0.440** | 19/48 (40%) · med 5 · MRR 0.258 | 13/48 (27%) · med 11 · MRR 0.154 |
| Style: `question` | 26 | **15/26 (58%) · med 2 · MRR 0.502** | 7/26 (27%) · med 8 · MRR 0.250 | 6/26 (23%) · med 11 · MRR 0.121 |
| Style: `keywords` | 23 | **13/23 (57%) · med 3 · MRR 0.366** | 12/23 (52%) · med 3 · MRR 0.263 | 7/23 (30%) · med 11.5 · MRR 0.188 |
| Repo: `neomjs/neo` | 29 | **16/29 (55%) · med 2 · MRR 0.458** | 12/29 (41%) · med 4 · MRR 0.269 | 7/29 (24%) · med 13 · MRR 0.140 |
| Repo: `neomjs/neo-agent-brain` | 20 | **12/20 (60%) · med 3 · MRR 0.410** | 7/20 (35%) · med 6 · MRR 0.237 | 6/20 (30%) · med 10 · MRR 0.170 |
| Class: `parent-class` (all 5) | 5 | **4/5 (80%) · med 5 · MRR 0.495** | 1/5 (20%) · med 9 · MRR 0.101 | 2/5 (40%) · med 21 · MRR 0.166 |
| Class: `parent-class` (strict 3) | 3 | **3/3 (100%) · med 1 · MRR 0.733** | 1/3 (33%) · med 10 · MRR 0.131 | 0/3 (0%) · med 46 · MRR 0.027 |
| Class: `source-only` | 11 | **4/11 (36%) · med 6 · MRR 0.300** | 2/11 (18%) · med 7 · MRR 0.120 | 2/11 (18%) · med 13 · MRR 0.117 |
| Class: `source-with-guide-mention` | 18 | 10/18 (56%) · med 2.5 · MRR 0.402 | **11/18 (61%) · med 4 · MRR 0.371** | 6/18 (33%) · med 11 · MRR 0.209 |
| Class: `guide-covered` | 15 | **10/15 (67%) · med 1 · MRR 0.564** | 5/15 (33%) · med 7 · MRR 0.269 | 3/15 (20%) · med 11 · MRR 0.106 |
| Index: >=1 answer file in Chroma | 42 | **28/42 (67%) · med 2 · MRR 0.509** | 19/42 (45%) · med 5.5 · MRR 0.299 | 12/42 (29%) · med 11 · MRR 0.161 |
| Index: 0 answer files in Chroma | 7 | 0/7 (0%) · med 13 · MRR 0.011 | 0/7 (0%) · med miss · MRR 0.000 | **1/7 (14%) · med 11 · MRR 0.102** |

## AC-4 Class Verdict & Follow-Up Tickets

- On the balanced-40 set, shipped `QueryService` matched or outperformed both baselines in every canonical class (`parent-class` 4/5 vs 1/5 & 2/5; `source-only` 4/11 vs 2/11 & 2/11; `source-with-guide-mention` 9/12 vs 9/12 & 3/12 with higher MRR `0.525` vs `0.490`; `guide-covered` 9/12 vs 3/12 & 3/12).
- Across all 49 verified questions, however, `QueryService` **loses `source-with-guide-mention` (`10/18 = 56%` vs `11/18 = 61%` nearest chunks)**, and `source-only` succeeds on only **`4/11 (36%)`**. Three inspected code mechanisms drive those misses:
  1. `QueryService.mjs:212` awards `queryScoreWeights.guideMatch` (`+50`) inside `queryWords.forEach` without checking whether the word matched the guide (`E107` `#4 → #9`, `E126` `#3 → #9`, `E183` `#3 → #6`, `B056` `#2 → #11`, `E022` `#6 → #14`).
  2. `QueryService.mjs:227, 233-240` accumulates `baseFileBonus` and `inheritanceBoost` across every candidate chunk per subclass, pushing `src/core/Base.mjs` to rank `#1` on `12/49` questions including Brain-only queries (`B004`, `B015`, `B056`, `B112`, `B116`, `B117`).
  3. `QueryService#getLexicalRescueCandidates` (`QueryService.mjs:641`) resolves only `aiConfig.neoRootDir`, missing `node_modules/neo.mjs/`.
- Tracked in **`neomjs/neo-agent-brain#1806`** (`Stop unconditional guide bonus and Base.mjs boost from burying source`).

## Second-Seat `SearchService#ask` Audit (`10` Judged Questions)

All `10` `judged: true` rows were evaluated with `SearchService.ask({query, type: 'all', limit: 5})` (`0` degraded calls) and graded against the fixture's `referenceAnswer` by `@neo-gemini-maryam`:

**Summary:** **`5/10` Right (`50%`) · `5/10` Wrong (`50%`: `4` honest abstentions, `1` truncated half-answer) · `0/10` Fabricated (`0%`)**. Among `guide-covered` questions, `5/6 (83%)` answered right; among `source-only` and `source-with-guide-mention`, `0/4 (0%)` answered right.

| ID | Repo | Class | Shipped Ans Rank | Top Reference | Latency | Verdict | Failure Stage |
|---|---|---|---:|---|---:|---|---|
| `E003` | Engine | `guide-covered` | 1 | `learn/guides/fundamentals/ExtendingNeoClasses.md` | 8.3 s | **Right** | — |
| `E022` | Engine | `source-only` | 14 | `learn/guides/datahandling/DynamicGrids.md` | 2.9 s | **Wrong** | Retrieval (`source-only` buried behind guides) |
| `E040` | Engine | `guide-covered` | 1 | `learn/guides/datahandling/StateProviders.md` | 8.5 s | **Right** | — |
| `E061` | Engine | `guide-covered` | 8 | `learn/Glossary.md` | 5.0 s | **Right** | (`WorkerArchitecture.md` #8; `Glossary.md` carried answer minus `handleDomUpdate`) |
| `E079` | Engine | `guide-covered` | 1 | `learn/guides/datahandling/TreeStore.md` | 6.4 s | **Wrong** | Context truncation + retrieval (`TreeStore.md` cut at 12k chars before `Menu.List` `isKept()`; `TreeStore.mjs`/`List.mjs` not in top 5) |
| `B051` | Brain | `guide-covered` | 1 | `learn/agentos/tooling/RestorationRunbook.md` | 12.4 s | **Right** | — |
| `B054` | Brain | `source-only` | 6 | `learn/agentos/tooling/MemoryCoreMcpApi.md` | 2.6 s | **Wrong** | Retrieval (`MemoryService.mjs` at rank `#6`, bumped below `limit: 5` by 4 guides + `Base.mjs`) |
| `B056` | Brain | `source-only` | 11 | `src/core/Base.mjs` | 2.6 s | **Wrong** | Retrieval (`RuntimeFreshnessService.mjs` nearest chunks `#2`, buried to `#11`) |
| `B076` | Brain | `guide-covered` | 3 | `learn/agentos/SharedDeployment.md` | 3.3 s | **Right** | — |
| `B088` | Brain | `source-with-guide-mention` | **1** | `ai/services/github-workflow/IssueService.mjs` | 2.5 s | **Wrong** | **Hydration head-truncation** (`IssueService.mjs` ranked `#1` then sliced `[0, 12000]`, dropping `updateIssueRelationship` at line 2122) |

The `B088` and `E079` head-truncation failure is tracked in **`neomjs/neo-agent-brain#1807`** (`Window oversized files around matched chunks in ask_knowledge_base`).

## Declared Measurement Limits

1. **Author knowledge & keyword share:** Questions came from real `kb_query_log` sessions written by maintainers who use this Knowledge Base; `23/49` (`18/40` in balanced 40) are keyword queries naming exact symbols, which disproportionately helps `ripgrep`.
2. **History questions excluded:** Questions asking which ticket decided a change were excluded because checkout `ripgrep` has no GitHub ticket corpus; `ticket` (`-70`) and `pull` (`-250`) penalties are measured only via their suppression of issue/PR noise in candidate pools (where unweighted `nearestChunks` frequently surfaced old issues/PRs in top 5).
3. **`B076` June anecdote:** Kept in the Brain 20 and reported both with (`26/40`) and without (`25/39`) so the baseline does not lean on the prior anecdote.
4. **Answer filenames named in text:** Three rows (`E025`, `E032`, `B051`) mention one of their answer file names in the query text itself (`E032` still scored `miss` in Chroma because `DockLayouts.md` was post-August unindexed, while `E025` landed `#6` in shipped vs `#1` in nearest chunks).
5. **Local corpus sync lag (`2026-08-14`):** `github-content-sync` chunks (`62,496` of `92,257`) were current through `2026-11-16`, while local Engine and Brain code/guide chunks stopped syncing around `2026-08-14`. Six of the `40` balanced questions (`7/49` overall) had zero answer files present in Chroma (`0/6` Hit@5 in both Chroma arms vs `26/34 = 76%` when indexed).
