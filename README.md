# neo-agent-brain

> The Brain of the Neo.mjs organism — the Agent OS.

This repository owns the Agent OS runtime, its tests, deployment substrate, learning
guides, and decision records. The sibling [`neomjs/neo`](https://github.com/neomjs/neo) repository
owns the application Engine and Body surfaces.

During the repository cut, the Brain depends on one immutable `neomjs/neo:dev` commit through its
npm lockfile. The install lifecycle projects the Engine-owned trees required by the unchanged Brain
imports and materializes the local, gitignored Agent OS config overlays. The dependency pin advances
to the Engine deletion commit after the cut and remains SHA-bound until the next Engine package
release.

## Learning and decisions

Agent OS guides live in [`learn/agentos`](learn/agentos/), with the shorter Brain benefit guides in
[`learn/benefits/brain`](learn/benefits/brain/). Decision records live in
[`learn/agentos/decisions`](learn/agentos/decisions/). Start with
[the Knowledge Base](learn/agentos/KnowledgeBase.md), [Memory Core](learn/agentos/MemoryCore.md), and
the [Deployment Cookbook](learn/agentos/DeploymentCookbook.md).

**Working branch:** `dev`. `main` is release-only and is created by release machinery.
