# RFC 1221: expose `deferred_at` on `StreamPosition`

- **Status:** accepted
- **Issue:** #1221
- **Author:** Rotorsoft
- **Created:** 2026-07-11

## Motivation

An autoclose (or any one-shot `defer`) parks a stream by persisting a future
`deferred_at` in the store and holding its watermark. The in-process
`DeferTimer` that re-arms the drain at the due-time lives in worker memory and
is empty after a restart. For an *idle* terminal aggregate — the exact case
autoclose exists for — no commit ever re-arms the drain, so a process that
restarts before the due-time never fires the deferred close: the stream sits
un-closed indefinitely.

The fix re-seeds the `DeferTimer` at cold start by reading the persisted
schedule back out of the store. The store already persists `deferred_at`; it
just wasn't surfaced on the read path. `query_streams` is the existing
read-only introspection surface every adapter implements, so the schedule
rides back through it — no new port method.

## Public surface added

- **Public types** — one new optional field on the existing exported
  `StreamPosition` type:

  ```ts
  export type StreamPosition = {
    // …existing fields…
    readonly deferred_at?: number; // ms since epoch; omitted when no active future defer
  };
  ```

  Returned by `Store.query_streams`'s per-position callback. Every in-tree
  adapter (InMemory / act-pg / act-sqlite) populates it from the `deferred_at`
  column they already persist. No signature change to `query_streams` itself.

No new exports, builder methods, port methods, or lifecycle events.

## Alternatives considered

- **New `Store` port method** (e.g. `min_deferred_at()` / `deferred_streams()`).
  Rejected: a whole new required port method + TCK + three adapters to surface
  a value `query_streams` already had every column for. The field is the
  minimal additive change.
- **Enforce a `cycleMs` poller on any lane carrying defer/autoclose reactions.**
  Rejected: a periodic wake defeats the point of the precise defer schedule
  (`#1090` replaced the blind sweep with an exact `DeferTimer`), and it would
  re-introduce fixed-interval polling on the default lane.
- **Do nothing.** Rejected: the defer-timer doc already *claimed* a restart
  rebuilds the schedule from the log; nothing implemented it. This RFC makes
  the claim true.

## Stability / charter impact

- Category: **public types** (`StreamPosition`, re-exported from
  `@rotorsoft/act`).
- **Additive** — a new optional field. No rename, removal, narrowing, or
  changed semantics of existing fields. Not breaking.
- TCK: `store-tck.ts`'s `describe("defer")` gained a case asserting
  `query_streams` surfaces a future `deferred_at` and omits it for undeferred
  streams. Run green against InMemory, act-pg, and act-sqlite.

## Open questions

None.
