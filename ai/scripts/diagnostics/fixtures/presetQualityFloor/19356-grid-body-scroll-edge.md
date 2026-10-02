# grid.Body publishes a scrollEdge event when the mounted window reaches the store's end

neomjs/neo#19356 · opened 2026-10-02 by @neo-opus-vega · a public engine thread, used as a Tri-Vector fixture document

## Context

Two Fleet Manager grids (neomjs/neo-agent-institution `apps/agentos/view/fleet/mailbox/Grid.mjs`, `memories/RowsGrid.mjs`) carry the same sentence in their docblocks: data acquisition stays the owning pane's drain "until the engine lands its scroll-edge seam". The engine has not landed it, so both panes walk their whole remote corpus page by page as soon as the first page arrives. On the cockpit's boot that walk is 173 Memory Core pages over three minutes and starves the Observatory's first read (neomjs/neo-agent-institution#416). The consumers exist and are waiting; the primitive is a few lines.

## The Problem

`Neo.grid.Body` knows exactly when the mounted window reaches the end of the store, and tells nobody. `updateMountedAndVisibleRows` (`src/grid/Body.mjs:1557`) computes `visibleRows[0..1]` and the mounted range on every scroll and resize; the only event the body publishes is `isScrollingChange` (`:499`). A buffered grid over a remote corpus therefore has two choices today: load everything up front, or hand the app the body's internals. Neither is the engine's shape.

## The Architectural Reality

- `src/grid/Body.mjs` `updateMountedAndVisibleRows`: `endIndex = Math.min(countRecords, startIndex + availableRows)`, `mountedEnd = min(countRecords, endIndex + bufferRowRange)`; called from the scroll handler, `afterSetStartIndex` → `createViewData`, and the resize path.
- `Neo.data.Store` has `currentPage`/`pageSize` for replace-style remote paging; append-style window loading has no engine signal.
- The list side (`src/list/Base.mjs`) renders all items; no comparable seam there either, and none is asked for here.

## The Fix

`Neo.grid.Body` fires `scrollEdge` with `{startIndex, endIndex, count}` when the mounted window reaches the store's end: `endIndex + bufferRowRange >= store.count`. Once per entry: the body remembers the `count` it fired for and re-arms when the store grows or shrinks, so an append that keeps the viewport at the edge fires again, and a stationary viewport does not fire on every scroll tick. A store shorter than one window fires on first layout, so a short first page still reaches the consumer. `Neo.grid.Container` relays it like `isScrollingChange` is relayed today, or the consumer listens on `grid.body`; pick the existing pattern and document it on the event.

No store change, no new config beyond what the event needs, no plugin.

## Contract Ledger

| Target surface | Source of authority | Behavior | Fallback | Docs | Evidence |
|---|---|---|---|---|---|
| `scrollEdge` event on `Neo.grid.Body` | `src/grid/Body.mjs` `updateMountedAndVisibleRows` | `{startIndex, endIndex, count}` once per entry into the last `bufferRowRange` rows; re-armed on a count change. | A store with no records never fires; a store shorter than one window fires once on first layout when `count > 0`. | the event's JSDoc + the grid learn guide's paging paragraph | a unit spec over a fake store count: enter, stay, grow, shrink |

## Acceptance Criteria

- [ ] Scrolling a buffered grid to the end fires `scrollEdge` exactly once; further scroll ticks at the edge fire nothing.
- [ ] Appending rows to the store while the viewport stays at the edge fires once more (re-armed by the count change).
- [ ] A store shorter than one window fires once on first layout; an empty store never fires.
- [ ] The event is documented where `isScrollingChange` is, and the grid learn guide names the append-style paging pattern in one paragraph.
- [ ] Red-first: the new spec fails on the current body.

## Out of Scope

- A remote store that pages itself; the consumer requests the next window.
- Lists (`src/list/Base.mjs`).
- The Fleet Manager consumers (Institution tickets); they adopt the event when their engine pin carries it.

## Avoided Traps

- **A plugin.** The body already computes the numbers on the right tick; a plugin would re-derive them from scroll events.
- **Firing on every tick at the edge.** The consumer would dedup; the engine should not make it.
- **Store-level paging.** `currentPage` replaces; these consumers append.

## Related

neomjs/neo-agent-institution#416 (the mailbox pane's boot drain; the first consumer) · neomjs/neo-agent-institution#40 (the drain's origin) · `Neo.grid.Body` `isScrollingChange`

Live latest-open sweep: the latest 20 open engine issues read at 08:30Z (all Ada's pin specs, Grace's two, Fable's #19354); `gh search issues` for "grid scroll edge seam", "grid infinite scroll load next page" and "grid Body scroll edge event" returned nothing; the A2A inbox's last 30 messages carry no claim on this scope.

Origin Session ID: 60d9be31-4233-40fd-9b07-6ee6a9ebf6cf
Retrieval Hint: "grid Body scrollEdge event buffered window reaches store end append paging"
