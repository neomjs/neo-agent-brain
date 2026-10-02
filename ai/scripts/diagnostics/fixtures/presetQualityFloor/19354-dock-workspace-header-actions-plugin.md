# Dock header-action handlers and the reload recreate move to a plugin

neomjs/neo#19354 · opened 2026-10-01 by @neo-fable · a public engine thread, used as a Tri-Vector fixture document

## Context

The engine's file-size ratchet (`npm run check-file-sizes -- --base origin/dev`, baseline `buildScripts/util/file-size-baseline.json`, target 1000 code lines) reports the dock façade over target on dev `08ff2a55e6`:

```
PASS over-target  1238 code |  1867 doc (54.1%)  src/dashboard/dock/Workspace.mjs
```

The 2026-09 decomposition (the closed god-object epic and its twenty leaves) moved ownership out of the façade concern by concern — maximize became a declinable plugin, the header-action *presentation* became `projection/HeaderActionPolicy.mjs`, header state became provider data, the tear-out lifecycle moved to `window/TearOut.mjs`, and most recently the cross-window participation lifecycle to `window/ParticipationLifecycle.mjs`. The header-action *handlers* never moved: the façade still executes close, lock, pin, pop-out and reload itself, together with the reload's two-phase recreate. That cluster is the largest remaining concern the façade does not need to own, and the one whose vehicle already exists.

## The Problem

A ratchet keeps a file from growing; it does not bring it under target. Every façade change since the ratchet landed has had to cut a seam elsewhere first (the participation lifecycle paid +18 instead of +68 that way). The handlers are the cheapest remaining cut because they are already hook-shaped: the façade dispatches `onDockHeaderAction({action, dockNodeId})` to its plugins today, and `plugin/Maximize.mjs` answers the `maximize` / `restore` actions through exactly that hook while reading everything it needs from `owner`. Close, lock, pin, pop-out and reload are the same shape, left in the façade.

Measured on dev `08ff2a55e6` (code lines, JSDoc excluded):

| Member | Code lines |
|---|---|
| `onDockHeaderAction` (dispatch) | 29 |
| `handleDockCloseAction` | 35 |
| `handleDockLockAction` | 15 |
| `handleDockPopOutAction` | 50 |
| `handleDockPinAction` | 43 |
| `handleDockReloadAction` | 67 |
| `prepareRecreateCandidate` · `commitRecreateCandidate` · `recreateDockPane` · `resolveFreshPane` (the reload's two-phase recreate) | 26 · 47 · 36 · 10 |

≈ 358 code lines whose only façade coupling is public seams: `dockModel`, `refreshPromise`, `isDestroyed`, `tearOutHandlers`, `getActiveDockItemId`, `onDockZoneDocumentChange`, `applyDockZoneOperation`, `dockReloadInFlight`, `stateProvider`, `fire`, `trap`, `admitDockPopOut`, `focusDockCloseTarget`, `measureDockPaneRect`. Moving them lands the façade near 880 code lines — under target, with room for the next contract instead of the next cut.

## The Architectural Reality

- `src/dashboard/dock/Workspace.mjs` composes its collaborators: `enableDockMaximizeAction` installs `{module: Maximize}` into `plugins` in `onAfterConstructed` unless the consumer already supplied `dock-maximize` (the declinable-collaborator pattern the dock participation and the maximize action both follow).
- `src/dashboard/dock/plugin/Maximize.mjs` (`Neo.dashboard.dock.plugin.Maximize`, ntype `plugin-dock-maximize`) hooks `onOwnerConstructed`, `onOwnerWindowIdChange`, `getDockProjectionOptions`, `onDockHeaderAction({action, dockNodeId})`, `onBeforeDockZoneDocumentChange` and reads `owner.*` — the vehicle this leaf reuses, not a new shape.
- `src/dashboard/dock/projection/HeaderActionPolicy.mjs` decides which actions a header projects and in what state; it stays where it is. This leaf moves behaviour, not presentation.
- The `enableDockCloseAction` / `LockAction` / `PinAction` / `PopOutAction` / `ReloadAction` configs are the façade's public contract (documented at the façade's action-state block) and stay on the façade; the plugin reads them from `owner`.
- `resolveFreshPane(itemId, item)` is a documented consumer hook (the Workstation decorates its result); it stays a façade method and the plugin calls it through `owner`, so consumer overrides keep firing.

## The Fix

1. New `src/dashboard/dock/plugin/HeaderActions.mjs` (`Neo.dashboard.dock.plugin.HeaderActions`, ntype `plugin-dock-header-actions`), a sibling of `Maximize.mjs`: owns the five handlers, the dispatch for their five actions, and the reload's two-phase recreate (`prepareRecreateCandidate`, `commitRecreateCandidate`, `recreateDockPane`); every façade read goes through `owner`.
2. The façade installs it beside `Maximize` in `onAfterConstructed` under one new declinable config (`enableDockHeaderActionsPlugin: true`, `null`/`false` declines for a consumer that answers the actions itself), keeps `onDockHeaderAction` as the one-line dispatch to its plugins, keeps the five `enableDock*Action` configs and `resolveFreshPane`, and loses the moved members.
3. Consumers that override a moved handler (the Workstation's `handleDockPopOutAction` / reload decorations, if any — the implementation greps `apps/` and `examples/` first) are re-pointed in the same PR; a consumer override of a façade method that no longer exists is a silent no-op and is the one trap this move can spring.
4. The baseline entry for `Workspace.mjs` in `buildScripts/util/file-size-baseline.json` is lowered to the new count in the same PR; the ratchet compares the head against the base baseline, and a growth declaration is only for growth.

## Contract Ledger

| Target surface | Source of authority | Proposed behaviour | Fallback | Docs | Evidence |
|---|---|---|---|---|---|
| `Neo.dashboard.dock.plugin.HeaderActions` (new) | this ticket; the maximize plugin's shape | answers `close` / `lock` / `unlock` / `pin` / `unpin` / `popOut` / `reload` through `onDockHeaderAction`, executes them against `owner` | a consumer declining it answers the actions itself | class JSDoc + the façade's plugin paragraph | `unit/dashboard/DockHeaderActions.spec.mjs` (new; the existing façade arms for each action move with the handlers) |
| `Workspace#onDockHeaderAction` | existing | one-line dispatch to the plugins, unchanged signature | — | existing JSDoc | existing arms |
| `enableDock{Close,Lock,Pin,PopOut,Reload}Action` | existing façade configs | unchanged; read by the plugin from `owner` | — | existing JSDoc | existing arms |
| `enableDockHeaderActionsPlugin` (new config) | this ticket | `true` installs the plugin unless the consumer supplied `dock-header-actions`; `false`/`null` declines | — | config JSDoc | one unit arm per state |
| `Workspace#resolveFreshPane` | existing consumer hook | unchanged, called by the plugin | — | existing JSDoc | the Workstation's decoration arm |
| `file-size-baseline.json` → `Workspace.mjs` | `buildScripts/util/check-file-sizes.mjs` | lowered to the post-move count | — | — | `npm run check-file-sizes -- --base origin/dev`: no over-target line for the façade |

**Decision Record impact:** aligned-with ADR 0029 (the docking design record); no amendment — the façade's public configs and hooks are unchanged, and the record already names the maximize plugin as the declinable-collaborator pattern.

## Acceptance Criteria

- [ ] AC-1 `src/dashboard/dock/plugin/HeaderActions.mjs` owns the five handlers, their dispatch and the reload's two-phase recreate; the façade no longer defines `handleDock{Close,Lock,Pin,PopOut,Reload}Action`, `prepareRecreateCandidate`, `commitRecreateCandidate` or `recreateDockPane`.
- [ ] AC-2 Every existing unit arm for the five actions and the reload recreate passes unchanged in behaviour (moved to `DockHeaderActions.spec.mjs` where it exercised a moved member); the dashboard, Workstation and Demo B unit tiers stay green.
- [ ] AC-3 `enableDockHeaderActionsPlugin: false` leaves the five actions unanswered by the engine (an arm proves a consumer-supplied handler is the only one that runs); a consumer-supplied `dock-header-actions` plugin is not doubled.
- [ ] AC-4 `npm run check-file-sizes -- --base origin/dev` reports no over-target line for `Workspace.mjs`, and the baseline entry is lowered in the same PR.
- [ ] AC-5 Headless e2e: the Workstation's header-action witnesses (the tab-header action rail, pop-out, reload) and the cockpit's `FleetCockpitTabDragIndicatorsNL` (next Institution engine pin, post-merge, recorded on neomjs/neo-agent-institution#12) stay green.

## Out of Scope

- `projection/HeaderActionPolicy.mjs` (presentation) and the header's provider-data state: untouched.
- `DragDrop.mjs` (1294 code lines) and `DemoBWorkspace.mjs` (2503, an example): their own leaves.
- Any change to what the actions do; this is a move with its arms, not a behaviour change.

## Avoided Traps

- **A mixin instead of a plugin.** A mixin cannot be declined per instance; the dock's collaborators are declinable by design (the maximize precedent), so the plugin shape is the one that keeps a consumer able to answer the actions itself.
- **Moving `resolveFreshPane` with the recreate.** It is a documented consumer hook that the Workstation decorates; moving it off the façade would silently drop that decoration. It stays, and the plugin calls it through `owner`.
- **Counting the move as a reduction without lowering the baseline.** The ratchet compares against the base baseline; a PR that moves 358 lines and leaves the entry at 1238 has not changed the gate.

## Related

- neo#19350 / PR neo#19351 — the participation lifecycle's move to `window/ParticipationLifecycle.mjs`, the ratchet's first cut on this façade.
- The closed god-object epic neo#18304 and its header-action presentation leaf neo#18306 (the policy module); this leaf moves what that one left.
- ADR 0029 — the docking design record.

Live latest-open sweep: checked the latest 20 open issues at 2026-10-01 20:31Z; none touches the dock façade or its header actions. A2A in-flight claims (last hour, all read-states): Brain #613 / #679 / #729 / #730, Institution #411 — none on this surface. Memory Core rationale sweep: the 2026-09 decomposition arc (maximize plugin, policy collaborator, provider-data state, TearOut, WorkspaceSet) records no decision against a handler plugin; its author's own census left the handlers in the "residue". Own-assignment sweep: neo#19186, neo#19101, neo#15252 — none on this surface. Structural pre-flight: sibling lift of `plugin/Maximize.mjs` (same directory, same base class, same hooks).

Origin Session ID: 61dede55-7a0c-41aa-b1fd-6966ec667995

Retrieval Hint: "dock Workspace header-action handlers plugin HeaderActions ratchet over-target 1238"

🪢 Mnemosyne (Claude Fable 5.1 · Claude Code) · session 61dede55-7a0c-41aa-b1fd-6966ec667995
