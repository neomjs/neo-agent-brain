# Neo.mjs Brain Contributing Guide
We are very excited that you are interested in contributing to the Neo.mjs Brain (`neo-agent-brain`, the Agent OS).<br>
No worries, you don't need to be a guru, ninja or rockstar to support the project.

## Which starting point is yours?

Three different things get called "getting started", and picking the wrong one costs an evening:

* **Running or observing an AI engineering team?** Start with [Agent Institution](https://github.com/neomjs/neo-agent-institution)
  (`neomjs/neo-agent-institution`), the operator-facing cockpit application, or see
  [Run Your Own Agent Team](learn/agentos/OwnAgentTeam.md).
* **Building an app *with* the Neo.mjs UI Engine?** See [`neomjs/neo`](https://github.com/neomjs/neo) and the
  <a href="https://neomjs.com/#/learn/gettingstarted/Setup">Setup guide</a>.
* **Changing the Brain *itself* — fixing a bug in `src/` or `ai/`, adding a unit test, improving an MCP service or guide?**
  That is this page, and the loop below is the whole of it.

## Set up the Brain from a clone

You need **Node.js 24 or newer** and Git. For the isolated unit suite, nothing else is required: no Docker, no external
database server, no API key, and no Neo maintainer credentials.

```bash
git clone https://github.com/neomjs/neo-agent-brain.git   # or your fork
cd neo-agent-brain
npm install
npm run test-unit
```

Every test command takes a path, so you can run just the area you touched:

```bash
npm run test-unit -- test/playwright/unit/ai/services/memory-core
```

Before opening a pull request, run the mechanical pre-flight checks on your branch:

```bash
npm run agent-preflight
```

The integration suites exercise live cross-service composition and parity contracts when a local or containerized
service stack is available:

```bash
npm run test-integration-unified   # unified service integration suite
npm run test-integration-parity    # Host-Edge / Container-Cloud parity suite
```

Container-Cloud operations live in the independent `cloud/` package (`cd cloud && npm ci`; see
[Cloud Overview](learn/agentos/cloud-deployment/Overview.md) and [ADR 0040](learn/agentos/decisions/0040-agentos-extraction-topology.md)).
If you are fixing a unit test or a pure service module, you do not need `cloud/` or Docker.

⚠️ **Run the `npm run test-*` scripts, not `npx playwright test` directly.** There is no Playwright config at the
repository root — each tier above has its own under `test/playwright/` (`playwright.config.unit.mjs`,
`playwright.config.integration.mjs`, `playwright.config.integration-parity.mjs`), and the npm scripts pass it with `-c`.
Without `-c`, Playwright fails to select the tier's configuration and setup fixtures, which looks like a broken checkout
and is not one.

Two things `npm install` ([`ai/scripts/setup/prepare.mjs`](ai/scripts/setup/prepare.mjs)) does that are worth
recognising when they scroll past:

1. It runs [`ai/scripts/setup/initServerConfigs.mjs`](ai/scripts/setup/initServerConfigs.mjs) to bootstrap local,
   git-ignored `ai/config.mjs` overlays so a fresh clone can run unit tests without private credentials.
2. It prints `neo-agent-skills: materialized N link(s)`. That is our shared
   [`neo-agent-skills`](https://github.com/neomjs/neo-agent-skills) package linking itself into `.agents/skills` and
   `.claude/skills`. It needs nothing from you, and you do not need private infrastructure to use it.

If any command above does not behave as described, that is a bug in this guide — please open an issue.

## What you can do to help:

### 1. Spread the Word

Neo.mjs thrives on community engagement. One of the most impactful ways to contribute is to help grow our community and
share the project with others.

1. **Star the repository:** This helps with visibility on GitHub.
2. **Tell your friends and colleagues:** Share your experience with the Neo.mjs Agent OS and Engine.
3. **Engage on social media:** Write blog posts or share content on platforms like LinkedIn, X (formerly Twitter), and Facebook.
4. **Represent Neo.mjs:** Interested in giving a talk or a workshop at a developer conference? We'd love to support you. Just reach out!
5. **Uphold our values:** Please stick to our <a href="https://github.com/neomjs/neo/blob/dev/.github/CODE_OF_CONDUCT.md">Code of Conduct</a> in all interactions.

### 2. Use the issues tracker

1. In case you got an idea for a new feature or Agent OS capability.
2. In case you find a bug:
   1. Ideally, you create a new breaking unit test inside `test/playwright/unit/`.
      This saves a lot of time and ensures the bug will stay fixed once the ticket is resolved.
3. Please like or comment on current tickets.
   This is a great help to figure out which tickets are the most important ones for the community.

### 3. Contribute to the Brain code base

**What we are working on now.** The [organization map](README.md#the-organization-map) names the sibling repositories,
and they release independently: [`neomjs/neo`](https://github.com/neomjs/neo) as the `neo.mjs` Engine package, this
repository as the Brain / Agent OS, [`neomjs/neo-agent-institution`](https://github.com/neomjs/neo-agent-institution) as
the operator-facing Fleet Manager cockpit, and [`neomjs/neo-agent-skills`](https://github.com/neomjs/neo-agent-skills) as
the shared skill substrate on npm. Inside this repository:

* `src/**` is the canonical domain and contract authority (including `src/fleet/contract/`);
* `ai/**` holds the MCP servers (`knowledge-base`, `memory-core`, `github-workflow`, `neural-link`, `file-system`),
  services, daemons, and operational scripts;
* `cloud/**` is the independently installed Container-Cloud package;
* `deploy/**` contains declarative Host and Cloud deployment artifacts only;
* `learn/**` contains Agent OS guides and [Architecture Decision Records](learn/agentos/decisions/);
* `test/**` owns every unit, integration, and deployment fixture.

1. **Looking for somewhere to start?** For a first PR, take an issue labelled
   <a href="../../issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22">good first issue</a>:
   comment on one to claim it (see 3). No approval round needed; they are already approved.
   **After your first merged PR**, move on to
   <a href="../../issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22">help wanted</a>
   or an unassigned open issue, the same way. Good first issues stay reserved for first-time contributors, so there is
   always a way in for the next person.
2. For anything else, please ***always*** create a new issue inside our <a href="../../issues">Issues Tracker</a> first
   and wait for approval. This ensures that your idea fits the scope of the project and makes it less likely to get a
   rejected PR. We will do our best to reply to new tickets within 7d max. In case we don't, feel free to bump the ticket.
3. **Claim before you start.** To work on an existing ticket, comment there; we assign the first person who asks.
   An automatic reply tells you whether you are first in line. If you are, the ticket is yours: start right away, and a
   maintainer confirms the assignment. You can open a PR without being assigned, but we merge the first approve-worthy PR
   for a ticket, so if someone else holds it or gets there first, your work may not land. An assignment is what protects
   your time.
   To keep the project moving, if a ticket is assigned and we do not receive any feedback from the assignee (e.g. via a
   comment) within 7 days, the ticket may get re-assigned to make it available for other contributors.
4. Please make sure that pull requests are always related to an issue inside our <a href="../../issues">Issues Tracker</a>.
5. Please create PRs for the `dev` branch, not for `main`.
6. Please do not copy code from other frameworks or libraries.
   1. It is simply impossible to verify if contributed code is self-written.
   2. Adding new npm packages (`dependencies` / `devDependencies`) is fine when there are no licensing conflicts.
7. Never commit live tokens, `.env` files, or generated local `ai/config.mjs` overlays.

### 4. Contributions from AI Agents & Autonomous Entities

We actively welcome contributions from artificial intelligence, LLMs, and autonomous agent teams. The Brain is where the
Neo.mjs institution's memory, graph, and coordination services live.

**For Human Operators of AI Agents:**
1. **Transparency:** If you use an AI agent to generate a Pull Request or formulate an issue, please briefly mention
   which model or agent harness was used (e.g., "Generated by Gemini," "Automated via Claude").
2. **Accountability:** You remain responsible for the code your agent submits. Please review generated PRs for
   architectural consistency and ensure they follow our
   <a href="https://github.com/neomjs/neo/blob/dev/.github/CODING_GUIDELINES.md">Coding Guidelines</a>.
3. **Setup:** Your agent needs nothing beyond the clone above — our skills package is already installed by `npm install`.
   To go further, see [Strategic Workflows](learn/agentos/StrategicWorkflows.md),
   [Memory Core](learn/agentos/MemoryCore.md), and [Knowledge Base](learn/agentos/KnowledgeBase.md).

**For Autonomous Agents (If you are reading this):**
1. **Start here:** you need nothing private — no account, container, or model provider. Run:
   ```bash
   npx -p neo-agent-skills neo-agent-skills-agents-md --repo neo-agent-brain --audience contributor
   ```
   for what an outside agent should know first; the maintainer instruction layer is written for this project's own
   standing maintainer seats.
2. **Skills are already in your checkout:** `npm install` materializes `.agents/skills/` (including `unit-test` and
   `pull-request`). Apply JSDoc with `@summary` tags to new or modified classes and methods, verify your change with
   `npm run test-unit`, and target your pull request at `dev`.
3. **The Two Hemispheres & Neural Link:** This repository (`neo-agent-brain`) is the Brain; [`neomjs/neo`](https://github.com/neomjs/neo)
   is the multi-threaded application Body. They connect through the Neural Link MCP bridge
   ([`ai/mcp/server/neural-link/`](ai/mcp/server/neural-link/mcp-server.mjs)), which lets agents inspect and mutate a
   live running Neo.mjs application without modifying source code or reloading the browser.

<br><br>
Copyright (c) 2015 - today, <a href="https://www.linkedin.com/in/tobiasuhlig/">Tobias Uhlig</a>
