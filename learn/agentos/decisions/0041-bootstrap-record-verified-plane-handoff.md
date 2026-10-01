# ADR 0041: The Bootstrap Record and the Verified-Plane Handoff

> Before a plane exists, the host bootstrap owns ONE durable, secret-free record — intent, consent,
> host-effect receipts — under the host's Agent OS state root; once the served plane identity **and
> the bound data root** both match the run's target, authenticated plane observations are the
> authority for **current** readiness and the record stays the authority for **prior** consent and
> effects. No renderer stores a "completed" bit, and no receipt is ever health.

| Attribute | Value |
|---|---|
| **Status** | Accepted — 2026-10-01 (PR #680; ADR 0005 §9: Accepted by the human merge of the approved, green PR that publishes this record — the Discussion's quorum graduated the design, not this record). Graduated from Discussion neomjs/neo#18965 at its §6.2 quorum on 2026-10-01 (`[GRADUATED_TO_TICKET: neomjs/neo-agent-institution#351]`; the gpt family's `[GRADUATION_APPROVED]` by @neo-gpt, `DC_kwDODSospM4BHUr8`); drafted 2026-09-30 at `[GRADUATION_PROPOSED]`; published by its own leaf, neomjs/neo-agent-brain#678, under Epic neomjs/neo-agent-institution#351 |
| **Author** | @neo-fable-clio (Claude Fable 5.1, Claude Code) drafting; the boundary was answered by @neo-gpt on the Discussion (`DC_kwDODSospM4BG0hx`, OQ1) and folded `[RESOLVED_TO_AC]` |
| **Graduated from** | Discussion neomjs/neo#18965 — *the first-run journey: an outside operator provisions their own institution through the setup wizard* (`Decision Record: REQUIRED`, minted by OQ1) |
| **Implementation** | Epic neomjs/neo-agent-institution#351 — the recipe/record leaf neomjs/neo-agent-brain#679 (Brain) writes the record; the cockpit renderer leaf (Institution) projects it |
| **Supersedes** | the implicit assumption that an installer stores step status; the Institution's connection-profile roster read as a plane proof |
| **Informs** | every setup leaf; the vessel's saved plane record; neomjs/neo-agent-brain#83's command ledger (plane-side, future); the deployment-state projection (`ok` · `stale` · `unavailable`) |
| **Decision Record relations** | depends-on ADR 0019 §10.3 (an opaque `plane.id` is declared before launch) and ADR 0005 (the record is filed at graduation; its lifecycle is §9's); complements ADR 0026 (the recovery actuator is not an installation RPC) and neomjs/neo-agent-brain#83 (a future ledger with `accepted` / `reconcile-required` tombstones, not a present install RPC) |
| **Anti-anchor for** | a stored status displayed as health — the cockpit's `● streaming` over a three-week-old row (2026-09-19) and the target-binding violation neomjs/neo-agent-institution#181 |

---

## 1. Context

The first-run journey has two renderers over one recipe: a CLI bootstrap with host-effect authority, and the cockpit inside the packaged vessel. Before a Brain exists nothing authenticated can hold state for the run, and after it exists two authorities could claim the same fact — the installer that performed an effect and the plane that now serves. Neither ADR 0019 nor neomjs/neo-agent-brain#83 says who owns what across that boundary. Every earlier setup surface we measured resolved the gap by storing status, and a stored status is how a surface ends up green over stale truth.

One Brain surface already keeps the discipline this record generalises: the recovery-prescription materializer (`ai/scripts/maintenance/materializeDeploymentPrescriptions.mjs`) writes a run-scoped manifest with a schema version before Docker runs, and a receipt only after the carrier's digest still matches, under the host root `~/.neo-ai/deployment-prescriptions` — a receipt there is provenance of what a deploy consumed, never its health.

## 2. Decision

1. **One record, host-owned, secret-free.** The host bootstrap owns a single durable record per run: `runId`, the target descriptor, the evaluated recipe version, consent entries, and host-effect receipts. It lives under the host's Agent OS state root (`~/.neo-ai/` — the root the backup path, the plane tooling and the prescriptions ledger already use) — never inside a checkout (`git clean -x` reaches `.neo-ai-data`), never inside the plane's data root, never in browser storage. It holds references, never a PAT, a provider key or a bearer.
2. **One writer.** The host-effect module writes it; the CLI and the vessel's main process call that same module. The cockpit page projects the record and never writes it; no plane service writes it.
3. **No completed bit.** A step's status is a fresh observation by the owner that already observes it (service health, config resolution, the deployment projection), evaluated for the bound target and the recipe version. Receipts are provenance and replay guards; they are never a step's status. A renderer meeting an unknown recipe version shows the mismatch and infers no missing check.
4. **Binding — both comparisons.** *Create:* the deployment declares an opaque `plane.id` before launch (ADR 0019 §10.3); that id is the run's target, and the deployment's declared data root is the run's bound root expectation. *Attach:* endpoint text is a connection coordinate only — authenticate, read the served identity, bind consent and effects to the observed id. `plane.id` is the identity **key**; `plane.dataRoot` is corroborating **evidence** that must also match the bound expectation wherever the run holds one: a responder with the expected id over a different root is refused as *same identity, different storage* (`assertServedPlane` with both `expectedPlaneId` and `expectedPlaneDataRoot` — an implementation that supplies only the id does not satisfy this record). The root never keys: a path cannot stand in for the id, and an absent or mismatched identity fails closed regardless of the root.
5. **The handoff.** Once the served identity and the bound root both match the run's target, authenticated plane observations are the authority for *current* readiness and the host record stays the authority for *prior* consent and effects. A matching target is not readiness: a live healthcheck identified its plane, root included, while `degraded`.
6. **Effects.** Every effect names an executable local handler or an explicit operator action; a remote host effect waits for an admitted transport (neomjs/neo-agent-brain#83) and is an operator action until then. An `accepted` effect is never re-run because a renderer resumed. An ambiguous effect resolves to `reconcile-required` and is settled only by a fresh matching observation, never by replay.
7. **Invalidation and retention.** A change of target or recipe version retires every observation and receipt as current proof — they stay history. Receipts live for the run and are purged only by operator action; nothing in the record is reusable authority for an effect elsewhere.
8. **"Is this set?" is a leaf read.** The setup path decides whether a value is configured from the resolved `AiConfig` leaf or its declared metadata (ADR 0019 A1/C1), never from the record and never from `process.env`.

## 3. The witness every implementing leaf inherits

Accept an effect → interrupt before its acknowledgement → resume through the *other* renderer → answer from a wrong or stale plane: a different id, the same id over a different root, or the bound plane while `degraded`. Expected: the effect does not replay, and no step turns green until a fresh observation from the matching plane — id and root — arrives. Two companions: the attach branch never rewrites the attached plane's provider settings or data root (the Discussion's option G falsifier, run 2026-09-23 against the live plane and held); a witness with no Brain and no config dismisses the setup path before any step ran and the frame is still operable (OQ2, neomjs/neo-agent-institution#12).

## 4. Rejected

- **A plane-owned record.** The plane does not exist for the steps that create it.
- **A cockpit-owned status** (browser storage). Unauthenticated, lost per viewer, and the green-over-stale machine by construction.
- **Endpoint-keyed binding.** Labels and paths stood in for identity in the cockpit until neomjs/neo-agent-institution#181; the plane's served identity is the only key.
- **Identity-only binding.** An id match without the bound root's corroboration admits a same-identity/different-storage responder; the root is a check, never the key, and never optional where the run holds an expectation.
- **The Institution's connection-profile roster as the ledger.** It lists coordinates; it proves nothing about a plane and records no consent.
- **Readiness derived from receipts.** A receipt says an effect was accepted, not that its result still holds.

## 5. Consequences

The record leaf is small: a file, a writer module, a projector. The CLI and the vessel share the host-effect module, so there is one implementation of every effect. The cockpit's setup surface becomes a projector over owners that already exist, which keeps it inside neomjs/neo-agent-institution#12's inline, dismissible rule. When neomjs/neo-agent-brain#83's ledger lands it records plane-side commands and never replaces the host record. A single record root makes the operator's purge and the vessel's uninstall the same question.

## 6. Merge gate

The first leaf that writes the record (neomjs/neo-agent-brain#679) cannot merge before this record is on `dev` — Accepted, per ADR 0005 §9, by the human merge of its approved, green PR. The witness in §3 is that PR's required test evidence; a PR that replays an accepted effect on resume, turns a step green from a receipt, or binds on the id alone where a bound root exists, is rejected at review regardless of CI.

---

Origin Session ID: `6682a116-897e-4c18-925e-4320d0489481`
