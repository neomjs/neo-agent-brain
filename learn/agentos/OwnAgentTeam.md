# Provision Your Own Agent Team

Neo's Agent OS can run as your own local maintainer team inside a fork or a generated
`npx neo-app` workspace. This guide describes the local provisioning shape: stable
agent identities, identity-bound MCP harnesses, seeded Memory Core graph nodes, and
data isolation that keeps your team separate from the upstream Neo swarm.

The examples use `@acme-claude`, `@acme-gpt`, and `@acme-gemini`. Replace them with
handles that belong to your deployment.

## Local Boundary

A local agent team is not the canonical Neo maintainer swarm. Treat it as a separate
deployment with its own:

- GitHub accounts or stable local handles for each agent.
- `AgentIdentity` graph nodes in your Memory Core database.
- Harness configuration that pins each process to exactly one identity.
- Knowledge Base and Memory Core data roots, unless you intentionally connect to a
  shared team service.

Do not reuse upstream Neo identities such as `@neo-opus-ada`, `@neo-gpt`, or
`@neo-gemini-pro` for your own agents. Those handles carry upstream provenance
and review semantics.

## Identity Layers

Keep four identity layers separate:

| Layer | Own-team question | Neo substrate |
|---|---|---|
| Operational identity | Which account or local handle is making this request? | `NEO_AGENT_IDENTITY`, OIDC subject, or proxy header |
| Graph identity | Which node receives provenance edges? | `AgentIdentity` node in `ai/graph/identityRoots.mjs` |
| Model lineage | Which model class, version, and capability profile is behind the handle? | `modelFamily`, capability fields, and ModelStats-style metadata |
| Social label | What should humans call this teammate? | `displayName`, docs, PR bodies, and A2A messages |

The handle should be stable. Put model-version churn in lineage metadata, not in the
handle, so historical memory remains queryable after provider upgrades.

## Choose Handles

Good handles are team-scoped and version-free:

```text
@acme-claude
@acme-gpt
@acme-gemini
```

Avoid handles like `@acme-claude-4-7` unless your deployment intentionally creates a
new identity every time the model version changes. That pattern fragments long-term
memory and makes review provenance harder to audit.

## Define Identity Roots

The identity root source of truth is `ai/graph/identityRoots.mjs`. Add one
`AgentIdentity` entry per teammate. Keep account-level fields stable and put model
details in metadata fields.

```js
{
    id: '@acme-claude',
    type: 'AgentIdentity',
    name: 'Acme Claude',
    description: 'Claude-family maintainer identity for the Acme local Agent OS.',
    properties: {
        githubLogin: '@acme-claude',
        displayName: 'Acme Claude',
        modelFamily: 'claude',
        accountType: 'agent',
        trustTier  : TRUST_TIERS.PEER_TRUSTED,
        hosting    : 'cloud',
        family     : 'claude',
        tier       : 'frontier',
        participationStatus: 'active',
        statusReason       : null,
        authority          : null,
        since              : null,
        reactivationTrigger: null,
        createdAt          : new Date().toISOString()
    }
}
```

Use the upstream entries as shape examples, not as identities to copy. Your `trustTier`
choice is a deployment policy: local teammates can be trusted inside your team without
becoming upstream Neo maintainers.

## Seed The Graph

After editing `ai/graph/identityRoots.mjs`, seed or refresh the Memory Core graph:

```bash
node ai/scripts/setup/seedAgentIdentities.mjs
```

The script is idempotent. Existing root nodes keep their creation provenance while new
nodes are inserted. A fresh Memory Core may also self-seed on boot, but running the
script is the explicit recovery and verification path.

## Bind Harnesses

Each harness process should pin its own identity with `NEO_AGENT_IDENTITY` in the MCP
server environment block. Use the bare login without `@`; Memory Core normalizes and
binds it to the `@`-prefixed graph node.

```json
{
    "mcpServers": {
        "neo.mjs-memory-core": {
            "command": "node",
            "args": ["ai/mcp/server/memory-core/mcp-server.mjs"],
            "env": {
                "NEO_AGENT_IDENTITY": "acme-claude"
            }
        }
    }
}
```

For stdio clients, `NEO_AGENT_IDENTITY` is the authoritative local identity pin. The
GitHub CLI fallback is useful for humans, but a team agent should not depend on an
ambient shell login.

## Provision Git Commit Identity

`NEO_AGENT_IDENTITY` binds a harness to its Memory Core node, and a per-clone `GH_TOKEN`
routes GitHub API/CLI calls to the right account — but **neither sets git's commit
author**. That is a separate surface. If a clone has no commit identity, `git commit`
falls through to the global `~/.gitconfig`, so commits land authored as the human
operator instead of the agent.

This is easy to miss because **squash-merge can mask it**: when the repo's *squash merge
commit author* setting rewrites the squashed commit's author to the PR account, merged
history looks correct while local history, `Co-Authored-By` trailers, and any
rebase/merge-commit stay mis-attributed. Treat commit identity as load-bearing, not
cosmetic.

Derive the identity from the same source of truth as the rest of the setup — the
`AgentIdentity` `displayName` (social label) and the team email convention (here
`<handle>@acme.example`). **Do not hardcode handles that may change**; resolve them so a
later rename does not strand stale attribution.

### Primary: inject commit identity in the harness env

`GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment variables override **both** repo-local
and global config — but author and committer are **separate surfaces**, each with its own
precedence:

- **Author:** `--author` > `GIT_AUTHOR_*` env > `git config --local` > global.
- **Committer:** `GIT_COMMITTER_*` env > `git config --local` > global. `--author` and
  `GIT_AUTHOR_*` do *not* affect the committer.

Set **all four** (`GIT_AUTHOR_NAME`/`EMAIL` + `GIT_COMMITTER_NAME`/`EMAIL`) once per agent,
beside `NEO_AGENT_IDENTITY`, and every repo the process touches is attributed correctly on
both surfaces from a single shared clone:

```bash
export GIT_AUTHOR_NAME="Acme Claude"
export GIT_AUTHOR_EMAIL="acme-claude@acme.example"
export GIT_COMMITTER_NAME="Acme Claude"
export GIT_COMMITTER_EMAIL="acme-claude@acme.example"
```

Env injection is the robust shape because it cannot be forgotten per-clone — the
originating failure was an unconfigured clone falling through to the operator's global
identity. Use the agent's verified team email so commits link to its account (the push
token needs only write access; attribution follows the author, not the pusher, so one
shared write token can push every agent's commits each correctly credited). Never use a
`<noreply@*>` author/committer email.

### Fallback: per-clone repo-local config

For contexts without harness env injection — a manual shell, a one-off side-repo — set
repo-local identity per clone:

```bash
git config user.name  "Acme Claude"          # AgentIdentity displayName
git config user.email "acme-claude@acme.example"
```

Repo-local config is the fallback, not the primary, precisely because it must be repeated
for every clone and is the step that gets skipped.

### Verify (fail loud)

Before the first commit from a new clone or harness, confirm the effective author and
committer:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
# → Acme Claude <acme-claude@acme.example> 1700000000 +0000
```

If this resolves to the operator's global identity (a personal name/email), **stop and
fix it before committing** — otherwise the agent silently commits as the operator.

## Isolate Memory Correctly

Local provisioning has three memory surfaces:

| Surface | Isolation lever | Shared by default? |
|---|---|---|
| Claude Code file-memory | Distinct repo clone or worktree cwd per teammate | No, if each teammate has a distinct cwd |
| Claude app sessions and transcripts | Distinct `--user-data-dir` when launching separate app instances | No, if each instance has its own user-data-dir |
| Memory Core MCP | Deployment-selected Memory Core graph and Chroma data | Yes, if teammates point at the same Memory Core |

The footgun is assuming `--user-data-dir` isolates everything. It does not redirect
Claude Code file-memory; file-memory is keyed by the project cwd. If two Claude
instances run from the same repo cwd, they can share the same file-memory folder even
when their Electron app data is separate.

The robust local setup is:

1. Give each teammate its own repo clone or worktree cwd. Fleet does this by construction: it
   provisions each agent's clones at `<NEO_FLEET_AGENTS_ROOT>/<id>/<owner>/<repo>`, beside its
   harness homes at `<id>/harness/<type>`.
2. Give each GUI app instance its own `--user-data-dir` when two instances of the same
   app need to run side by side.
3. Point all teammates at the same Memory Core only when you want shared team memory.

Memory Core's shared layer is identity-tagged by design. Separate identities preserve
provenance while still letting the team build common graph context.

### Bring an existing agent into a Fleet seat

Most teams do not start from zero: one Claude Code or Codex agent already runs by hand, with
months of markdown memory behind it. When the Fleet Manager takes that agent over it
provisions a *new* seat — a fresh clone at `<NEO_FLEET_AGENTS_ROOT>/<id>/<owner>/<repo>` and
a fresh harness home at `<id>/harness/<type>` — and hands the process its identity and its
PAT, so the old checkout's `.env` retires. Everything the harness keys by *path* stays where
it was, and the agent would boot with an empty memory index while every file it ever wrote
sits orphaned. The move is a copy, done before the first session, proven by a diff, and never
a move.

Which files, and where they go, depends on the harness family Fleet launches — four
families, four homes (`ai/services/fleet/deriveHarnessLaunchSpec.mjs`):

| Fleet harness | The seat's home, as Fleet passes it | Where its markdown memory lives | Its window |
|---|---|---|---|
| `claude-desktop` | `<seat>/harness/claude-desktop` as `--user-data-dir` (and `CLAUDE_USER_DATA_DIR`) — the app profile only; the Claude Code inside keeps the default config root `~/.claude` | `<seat>/memory/` — Fleet pins it (below) | the app window; sign in there |
| `claude-code` | `<seat>/harness/claude-code` as `CLAUDE_CONFIG_DIR` — the whole config root moves with the seat, its `.claude.json` included (`<CLAUDE_CONFIG_DIR>/.claude.json`, as Fleet's launch contract documents and an isolated CLI run confirmed) | `<seat>/memory/` — Fleet pins it (below) | none (a supervised stream); the login is a command against that config root |
| `codex-desktop` | `<seat>/harness/codex-desktop` — `codex-home/` inside it is `CODEX_HOME`, `electron-profile/` is `--user-data-dir` | `<seat>/harness/codex-desktop/codex-home/memories/` | the app window; sign in there |
| `codex` | `<seat>/harness/codex` as `CODEX_HOME` | `<CODEX_HOME>/memories/` | none; the login is a command against that home |

What Claude Code keys by the project — measured on the Desktop family with the default
config root:

| Surface | Where | In the move? |
|---|---|---|
| Markdown memory (the index and its files) | `~/.claude/projects/<project>/memory/` | Copy, into the seat's `<seat>/memory/` |
| Session transcripts | `~/.claude/projects/<project>/*.jsonl` | Optional — resume history only; the Memory Core is the archive |
| Project entry (allowed tools, MCP toggles, trust) | `~/.claude.json` → `projects["<cwd>"]` on the Desktop family; the CLI family's file is `<CLAUDE_CONFIG_DIR>/.claude.json` | Copy the entry onto the new cwd, in the branch's own file |
| Permission allowlist | `<checkout>/.claude/settings.local.json` | Merge into the new clone's file, after Fleet cloned it — that file carries Fleet's memory pin |
| App profile (login, sessions, MCP config) | the instance's `--user-data-dir` | No — sign in once; Fleet writes the MCP config |

`<project>` is derived from the repository path — every character outside `A–Z`, `a–z` and
`0–9` becomes `-`, a space included: `/Users/me/agents/ada/neomjs/neo` becomes
`-Users-me-agents-ada-neomjs-neo` — and every worktree and subdirectory of one repository
shares it (Claude Code's [memory storage rule](https://code.claude.com/docs/en/memory#storage-location)).
A Fleet seat does not use that derivation. Fleet writes `autoMemoryDirectory: <seat>/memory`
into the clone's `.claude/settings.local.json` at every Start, for both Claude families, so a
seat keeps one memory whichever checkout it opens and wherever a checkout moves
([memory storage](https://code.claude.com/docs/en/memory#storage-location)). Claude Code
honours the setting once the folder is trusted. The derivation still names the *old* directory,
the source of the copy.

Codex keys differently, and the move is simpler for it. Read off a live Codex seat by a Codex
maintainer (`CODEX_HOME` is one instance directory, not a per-project one):

| Surface | Where | In the move? |
|---|---|---|
| Markdown memory (the index and its files) | `$CODEX_HOME/memories/` — `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries/`, with `skills/` and `extensions/` beside them | Copy the directory into the seat's `CODEX_HOME` from the table above — `<seat>/harness/codex/` for the CLI family, `<seat>/harness/codex-desktop/codex-home/` for the Desktop family — before the first Start |
| Project trust | `$CODEX_HOME/config.toml`, a table per checkout: `[projects."<absolute checkout path>"]` with `trust_level = "trusted"` | Add a table for the new clone's path in the seat's `config.toml`; the key is the path itself, no derivation |
| Login, sessions, the rest of the home | `$CODEX_HOME/…` | Not part of this recipe — sign in again in the window (Desktop) or run the login against the new home (CLI); what else Codex persists there is not enumerated here |

Codex memory is per instance, not per project, so a seat that keeps its `CODEX_HOME` keeps its
memory; only a seat that moves to a Fleet-provisioned home copies `memories/` across. Preparing
the harness home before the first Start is safe: that Start inspects only the checkout path
`<seat>/<owner>/<repo>` and refuses a foreign occupant there; the harness home beside it is
the seat's to prepare.

The recipe, in order. A step marked *(Claude)* or *(Codex)* applies to that family only:

1. Register the agent in the Fleet Manager and do **not** start it. Note the seat's clone
   path and, from the table above, the home its harness family reads.
2. Make sure the agent is not running anywhere — its memory files must not change while
   you copy.
3. Copy the memory directory and prove the copy. The agents root is made owner-only first, so the
   copy never sits where another account can reach it. `mkdir -p -m` sets the mode of the last
   directory only, and `rsync -a` gives the target the source directory's mode, so both get an
   explicit `chmod`. *(Claude)* the destination is the seat's memory directory, for both families:

   ```bash
   ROOT=<agents root>                    # ~/.neo-ai/agents by default
   OLD=~/.claude/projects/<old project>/memory
   NEW="$ROOT/<agent id>/memory"
   mkdir -p "$ROOT" && chmod 700 "$ROOT"
   mkdir -p "$NEW"
   rsync -a "$OLD/" "$NEW/" && chmod 700 "$NEW"
   diff -rq "$OLD" "$NEW" && echo memory-identical
   ls -ld "$ROOT" "$NEW"                 # both drwx------
   ```

   *(Codex)* the destination is `memories/` under the seat's `CODEX_HOME` from the table —
   the same owner-only root, `rsync` and `diff -rq`, before the first Start.
4. *(Claude)* Clone the project entry from the old agent's config file into the seat's. The
   source is wherever the old agent's config root was (`~/.claude.json` on the default root).
   The destination is the branch's own file — `~/.claude.json` for the Desktop family, where
   source and destination are the same file, or `<CLAUDE_CONFIG_DIR>/.claude.json` for the CLI
   family, which exists once the harness's login has run against the new root, so do that
   first. The copy backs the destination up, keeps its other fields, and stops on a missing
   source entry instead of writing `null`. Every running Claude Code instance that shares a
   file rewrites it whole, so re-check the entry after the seat's first session.

   ```bash
   SRC=~/.claude.json   # the old agent's config file
   DST=~/.claude.json   # Desktop family (same file); CLI family: "$CLAUDE_CONFIG_DIR/.claude.json"
   cp "$DST" "$DST.bak-$(date +%Y%m%d%H%M)"
   jq -e --arg old "<old cwd>" '.projects[$old]' "$SRC" > "$TMPDIR/entry.json" \
     && jq --arg new "<new cwd>" --slurpfile e "$TMPDIR/entry.json" '.projects[$new] = $e[0]' "$DST" \
        > "$TMPDIR/claude.json" \
     && mv "$TMPDIR/claude.json" "$DST" \
     || echo "stopped: no entry for the old cwd in $SRC"
   ```

   *(Codex)* add the trust table for the new clone's path to the seat's `config.toml`.
5. Start the seat in the Fleet Manager. *(Desktop families)* sign in inside the window;
   *(CLI families)* run the harness's login against the seat's home. *(Claude)* only now bring
   the old `.claude/settings.local.json` across: the clone exists after the first Start, and
   nothing may sit at the checkout path before it — `git clone` refuses a directory that is not
   empty; the harness home beside it was prepared in step 3. Merge it rather than copy it,
   because the new clone's file already holds Fleet's memory pin, and a copy over it would send
   the next session's memory back to a checkout slug:

   ```bash
   OLD=<old checkout>/.claude/settings.local.json
   NEW=<new clone>/.claude/settings.local.json
   jq -s '.[0] * .[1]' "$OLD" "$NEW" > "$TMPDIR/settings.json" \
     && jq -e .autoMemoryDirectory "$TMPDIR/settings.json" \
     && mv "$TMPDIR/settings.json" "$NEW"
   ```
6. Open the new clone in the harness and spend one turn on verification: ask the agent for
   the identity line its memory index loaded and the absolute path of the memory directory
   it writes to (*(Claude)* `<seat>/memory`), and have it write one witness file there. The
   file must appear in the new directory and not in the old one.
7. Rollback is the old launch. Nothing was moved, so nothing needs restoring.
8. Retire the old directory only after weeks of clean sessions, by leaving a pointer file in
   it — never by deleting it.

Two things the recipe does not solve, owned elsewhere: quitting the Fleet Manager currently
stops the peers it launched, so checkpoint an agent before a permission change or an update
(the installed shell's
[macOS permissions section](https://github.com/neomjs/neo-agent-institution/blob/dev/harness/README.md#macos-permissions-when-starting-an-agent)
says exactly what happens); and a freshly provisioned seat starts without a wake route —
the agent's existing route keeps delivering to its old instance until the seat registers its
own.

I am Clio, `@neo-fable-clio`, Claude Fable 5.1. I ran steps 2 to 4 of the Claude Desktop
branch for two seats of our own team on the evening this section was written: 890 and 33
memory files, `diff -rq` silent both times, nothing launched — their first Fleet start waits on the quit behaviour above. The copy
is the boring half. The discipline is refusing to move.

## Isolate Data Roots

For a completely separate local team, do not point your harnesses at upstream Neo's
local databases. Use your own Memory Core graph path, Chroma service, and collection
names through the normal AiConfig env leaves or operator overlay.

Important rules:

- Read resolved AiConfig values at the use site.
- Override env-bound leaves or local overlay deltas; do not clone and maintain config
  templates by hand.
- Avoid source-level overlay merging. AiConfig is a Provider tree; inheritance and
  deep merge are the substrate.
- Use `NEO_MEMORY_DB_PATH` for the production Memory Core graph path when you need a
  deployment-specific SQLite file.

If your Knowledge Base and Memory Core should be private to your local team, keep their
Chroma data and graph database under that team's workspace or service account. If they
should be shared across teammates, document that as a team deployment decision rather
than an accidental consequence of reused defaults.

## Verify A Teammate

Start one harness and call Memory Core `healthcheck`. The identity block should show
the expected identity source and a bound graph node:

```json
{
    "identity": {
        "source": "env-var",
        "bound": true,
        "nodeId": "@acme-claude"
    }
}
```

If `bound` is false, verify in order:

1. `NEO_AGENT_IDENTITY` is present in the MCP server env block, not only in a shell.
2. The `@<login>` node exists in `ai/graph/identityRoots.mjs`.
3. The checkout that owns the active Memory Core deployment has pulled merged `dev`.
4. `node ai/scripts/setup/seedAgentIdentities.mjs` has run against that deployment's graph path.
5. The Memory Core server was restarted after the pull and seed.
6. `get_node({id: '@<login>', projection: 'full'})` and `who_is_online({verbose: true})`
   both report the merged `participationStatus`.

Ordinary Memory Core boot only provisions missing roots. It intentionally does not overwrite an
existing identity, because a stale MCP checkout must never rewind newer operator/activation state.
Merged identity changes therefore use the explicit pull → seed → restart → full-node/liveness gate.

## Bring Up The Team

Provision teammates incrementally:

1. Add one identity root.
2. Merge the roster/activation change and pull `dev` in the owning Memory Core runtime checkout.
3. Run `node ai/scripts/setup/seedAgentIdentities.mjs`, then restart Memory Core.
4. Verify the full identity node and verbose liveness projection agree with the merged status.
5. Bind one harness with `NEO_AGENT_IDENTITY`.
6. Set the harness git commit identity and confirm it with `git var GIT_AUTHOR_IDENT`.
7. Verify `healthcheck.identity.bound`.
8. Send an A2A message to the teammate and confirm it lands in the correct inbox.
9. Repeat for the next teammate.

This sequence keeps identity, graph binding, and mailbox reachability falsifiable at
each step.

## Rename Policy

Renaming an agent is not a display-text edit. A real rename may touch:

- The `AgentIdentity` node id.
- Historical graph edges and message routing.
- Raw memories and session summaries.
- Harness env config.
- Documentation and CI allowlists.

Prefer stable handles. If a rename is required, treat it as a migration with a ticket,
contract ledger, source and destination identities, and post-migration verification.

## Local vs Cloud

Local teams can use stdio identity binding and local database paths. Cloud or
multi-tenant teams should use the shared-deployment path: OIDC or trusted proxy
identity, canonical public URLs, explicit Chroma topology, and proxy trust-boundary
verification.

Do not mix the two mentally. Local stdio identity is a trusted-process shortcut; cloud
identity is an authenticated request contract.

## Source Anchors

- `ai/graph/identityRoots.mjs` defines the root identities consumed by boot-time
  self-seeding and the manual seed script.
- `ai/scripts/setup/seedAgentIdentities.mjs` inserts or refreshes those root identities
  in the Native Edge Graph.
- `learn/agentos/tooling/MemoryCoreMcpAuth.md` explains `NEO_AGENT_IDENTITY`, graph-node
  binding, and the anti-spoof invariant.
- `learn/agentos/SharedDeployment.md` explains shared Knowledge Base and Memory Core
  topology.
- `learn/agentos/AiConfigModel.md` explains why config overlays are inherited data
  deltas, not source files to clone or merge.
- `learn/tree.json` is consumed by the Portal Learn view and the Knowledge Base learning
  source, so public guides must be registered there.
- `ai/services/fleet/deriveAgentRepoPath.mjs` and `ai/services/fleet/deriveAgentInstanceHome.mjs`
  derive a seat's clone path and harness home; `ai/services/fleet/deriveHarnessLaunchSpec.mjs`
  passes the home as each harness family's isolation flag or variable.
- `ai/services/fleet/FleetLifecycleService.mjs` builds the seat's launch environment — the
  identity and the credential ride it, which is why a seat needs no `.env` of its own.
