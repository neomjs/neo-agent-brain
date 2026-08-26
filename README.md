# neo-agent-brain

> The Brain of the Neo.mjs organism — the Agent OS — moving into its own repository.

**Status: pre-move shell.** This repository was scaffolded ahead of the extraction wave
([Epic neomjs/neo#17500](https://github.com/neomjs/neo/issues/17500)). The Agent OS source still
lives in the [`neomjs/neo`](https://github.com/neomjs/neo) `ai/` tree and relocates here only after
the wave's two blocking proofs land
([ADR 0040 §2.6](learn/agentos/decisions/0040-agentos-extraction-topology.md)).

**Provenance (ADR 0040 §2.9):** this repository starts with fresh history; no `neomjs/neo` SHA is
rewritten, ever. Moved code's provenance lives in the wave's ledger and this repository's import
commits — the Engine's history remains the load-bearing archive.

**Topology (ADR 0040 §2.1):** at the move, the repository root becomes the Host-Edge package;
`cloud/` becomes an independently installed nested package; npm workspaces are forbidden by
decision; a plane-neutral `shared/` exists for the inventory-proven population. The Engine
(`neomjs/neo`) never depends back — not in `dependencies`, not in `devDependencies`.

## Learning and decisions

Brain-owned Agent OS guides live in [`learn/agentos`](learn/agentos/). The decision records are in
[`learn/agentos/decisions`](learn/agentos/decisions/); start with
[the extraction topology](learn/agentos/decisions/0040-agentos-extraction-topology.md) for the
repository boundary, then [the Knowledge Base](learn/agentos/KnowledgeBase.md),
[Memory Core](learn/agentos/MemoryCore.md), and the
[Deployment Cookbook](learn/agentos/DeploymentCookbook.md) for the main runtime surfaces.

The directory is intentionally subject-split rather than mirrored wholesale. Body-, Engine-, and
Fleet-owned guides remain canonical in [`neomjs/neo`](https://github.com/neomjs/neo/tree/dev/learn/agentos)
and are linked explicitly when a Brain guide crosses that boundary.

**Working branch:** `dev`. `main` does not exist yet — it is created by release machinery, never by
hand, mirroring the Engine's release-only main.
