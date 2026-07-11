---
id: event-schema-evolution
title: Event schema evolution
---

# Event schema evolution

Events on disk are immutable. State shapes change over time. Reconciling those two facts is what schema evolution is.

The framework's stance: **versioned event names**, not upcasting. Old event versions stay in the registry; reducers handle each version explicitly. Type information is preserved end-to-end.

## What the alternatives look like (and why they were rejected)

### Upcasting

The traditional event-sourcing approach. Define a single `OrderPlaced` event; when a new field is added, write an "upcaster" that transforms old payloads into the new shape at read time:

```ts no-check
// Pseudocode for an upcasting framework
function upcast(rawEvent) {
  if (rawEvent.version === 1) {
    return { ...rawEvent, priority: "medium" };  // default for v1 events
  }
  return rawEvent;
}
```

Upcasting buys *runtime* compatibility but at the cost of *type* compatibility. The reducer signature has to be `(event: OrderPlaced) => State` — there's no way to express "this branch handles upcasted-from-v1, this branch handles native-v2." Upcasters typically take and return `unknown` or `any`, erasing the very thing Zod schemas exist to provide.

The bigger problem is that upcasting hides versioning behavior from the reader. A reducer looking at `event.priority` doesn't know that priority might have come from a default supplied by an upcaster. Bugs in upcasters are silently absorbed into "current state."

### Migration scripts

Run a one-time script that rewrites old events into the new shape. Direct, but breaks the immutability invariant. Audit logs no longer reflect what actually happened — they reflect what the most recent migration *says* happened. The first time something subtle goes wrong, this hurts.

The framework's event log is the source of truth. Rewriting it is not on the table.

## How versioned event names work

Add a new event name with a version suffix; keep the old one in the registry; both have explicit reducers:

```ts no-check
.emits({
  // v1: original schema (kept forever — historical events match this name)
  TicketOpened: z.object({
    title: z.string(),
    type: z.string(),
  }),

  // v2: breaking change — renamed `type` to `category`, added `priority`
  TicketOpened_v2: z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]),
    category: z.string(),
  }),
})
.patch({
  // Reducer for v1 events — maps old shape to current state shape
  TicketOpened: ({ data }, state) => ({
    ...state,
    title: data.title,
    category: data.type,           // map old field
    priority: "medium",            // default for v1
  }),

  // Reducer for v2 events — direct
  TicketOpened_v2: ({ data }, state) => ({
    ...state,
    title: data.title,
    priority: data.priority,
    category: data.category,
  }),
})
// New actions emit v2
.on({ openTicket: z.object({ ... }) })
  .emit((action) => ["TicketOpened_v2", { ... }])
```

### What this guarantees

- **Type safety end-to-end**: Zod's `z.infer` produces narrow types per event name. Reducer functions, query filters, projection handlers — all see the right shape per event.
- **Audit fidelity**: events on disk are exactly what was committed. No transformation at read time.
- **Schema discoverability**: looking at `me.events` shows every version that has ever existed. Adding a new version is a deliberate, visible act.
- **Reducer locality**: the migration logic for v1 lives in the v1 reducer. Future readers of the code see "this is how an old event becomes current state."

### What this costs

- **Registry grows over time**: old event names stick around. For a stream that's been live for years through several breaking changes, the registry might have `OrderPlaced`, `OrderPlaced_v2`, `OrderPlaced_v3`. That's the cost of immutable history.
- **Multiple reducers per concept**: each version needs its own reducer. Often the v1 reducer's job is "translate to v2 shape, then apply v2 logic"; sometimes that's tempting to factor as `me.patch.OrderPlaced_v1 = compose(translateV1ToV2, me.patch.OrderPlaced_v2)`. The framework allows that; it doesn't enforce it.

## Non-breaking changes need no version bump

Adding an optional field with a sensible default is not a breaking change:

```ts no-check
.emits({
  // Was: title only. Now: title + optional priority with a default.
  TicketOpened: z.object({
    title: z.string(),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
  }),
})
.patch({
  TicketOpened: ({ data }, state) => ({
    ...state,
    title: data.title,
    priority: data.priority ?? "medium",  // handles old events that have no priority
  }),
})
```

Zod's `.default()` does the lift on parse. New events go in with a value (defaulted at validation time if not supplied). Old events on disk don't have the field; the reducer's `?? "medium"` fills it on replay.

This works for: adding optional fields, adding fields with defaults, broadening enum members, broadening string types. It does *not* work for: renames, removals, narrowing constraints, type changes (string → number). Those need a version bump.

## Cross-cutting: cache and snapshots

Schema evolution interacts with the cache and snapshot layers:

- **Cache** lives in process memory and reflects post-reducer state. After a reducer change, restarting the process empties the cache; all loads cold-reload. No migration needed.
- **Snapshots** are events too. A `__snapshot__` event committed under v1 of the state shape contains v1-shape state. After a v2 schema change, the framework doesn't migrate the snapshot — it loads the snapshot's data as the seed state, then applies subsequent reducer-versioned events on top.
- **Stale snapshots**: if v1's state shape was `{ title, type }` and v2's is `{ title, category, priority }`, a v1 snapshot's data lacks `category` and `priority`. The reducer in `load()` reads the snapshot raw — `state = e.data as TState`. After this, every subsequent reducer call will work normally on the v1-shaped state plus newer events.

In practice this means: snapshots are forward-compatible as long as your reducers handle the missing fields. If a v1 snapshot's missing fields would corrupt the v2 reducer, the right move is `app.close({ restart: true })` — load current state via the latest reducers, commit a fresh `__snapshot__` reflecting the current shape, tombstone the historical events.

See [Cache and snapshots](./cache-and-snapshots) for more on the snapshot lifecycle.

## What to do when

| Change | Approach |
|---|---|
| Add an optional field with a default | Update the schema with `.default(...)`; reducer handles missing |
| Add a required field | Add as optional with default first; backfill if needed; later make required |
| Rename a field | New version with the new field; v1 reducer maps old field to new state shape |
| Change a field's type | New version (string→number is a breaking change in Zod); v1 reducer parses/converts |
| Remove a field | New version that omits the field; v1 reducer ignores it |
| Combine two events into one | New combined event name; v1 reducers stay (history doesn't change); going forward emit only v2 |
| Split one event into many | New event names; v1 reducer maps old event to compound state changes; going forward emit the new ones |

## The versioning convention is the deprecation signal (ACT-403)

After a schema migration, `OrderPlaced` and `OrderPlaced_v2` both live in the registry — but only `OrderPlaced_v2` should be emitted by new actions. The framework enforces that at build time by reading the `_v<digits>` convention.

**The rule:** within a state's events, group by base name; for any group with ≥ 2 members, the highest version is *current*, all lower versions are *deprecated*. Adding `OrderPlaced_v2` to `.emits({...})` automatically marks `OrderPlaced` as deprecated — there's no `.deprecate(...)` API, no metadata to maintain, no marker to forget. The naming convention is the marker.

**Enforcement:**

- **Build-time throw** when a static `.emit("OrderPlaced")` call targets a deprecated event:
  ```
  Action "openTicket" in state "Ticket" emits deprecated event "OrderPlaced".
  A newer version exists: "OrderPlaced_v2". Update the .emit() call to target the
  current version. The reducer (.patch) for "OrderPlaced" stays as-is — historical
  events still need it.
  ```

  This catches the forgotten `.emit()` call after a migration. The `app.build()` call refuses to construct the orchestrator until the static targets are fixed.

- **Startup advisory** — a single info log at `app.build()` enumerates every deprecated event in scope with its current version and owning state. One line per Act, regardless of how many call sites emit the legacy name. The same data is exposed programmatically via `app.registry.deprecated_events(state_name)` for callers that want to layer their own policy on top (a CI gate, a metrics tag, a custom Logger warning).

- **No runtime warning on dynamic emits.** Dynamic `.emit((a) => ["OrderPlaced", ...])` callbacks escape the static check, but the startup advisory already names every deprecated event the registry knows about — a per-action runtime warn would only repeat what the operator already saw at boot. The orchestrator (and `event-sourcing.ts`) stays unaware of deprecation by design; the registry holds the data, the build-time channel surfaces it.

- **`.patch()` reducer path stays silent forever.** Replay of historical events must not warn, because the reducer is required for the lifetime of the system. Deprecation is for *emission*, not *reduction*.

**Edge cases:**

- **Gaps allowed.** `{Foo, Foo_v3}` (no `Foo_v2`) → `Foo` is deprecated, `Foo_v3` is current. The framework picks the highest version regardless of contiguity.
- **`_v1` is a literal name.** Version suffixes start at 2 (the base is implicitly v1). If you name an event `Foo_v1`, it's treated as a distinct event with no grouping. Don't use this — write `Foo` for the v1 of an event.
- **Single-version events.** No `_v<n>` siblings means no deprecation; `OrderPaid` standing alone is just an event.
- **No leading zeros in a version.** `Foo_v2` and `Foo_v02` both parse to numeric version 2 — they can't both be a distinct version, so one is a typo. Rather than let declaration order silently pick which one is "current" (and possibly deprecate the real current event, making its `.emit(...)` throw), the build **rejects** the collision with a clear, order-independent error: *"duplicate event version: Foo_v2 and Foo_v02 both map to version 2."* Pick one canonical spelling.

**Why this works for rolling deploys:**

Old instances built before the migration already emit the legacy event name and run fine — their build was clean at startup. New instances build with both schemas registered and refuse to start if any static `.emit("Foo")` remains in the new code. Each build is atomic; the deploy is rolling. There's no in-between state where the framework can't decide.

**No opt-out flag.** A `--allow-deprecated-emit` knob would invite developers to silence the throw instead of fixing the call site. The fix is mechanical (one-character rename to the current version); the throw is the forcing function.

## Surfacing on-disk drift — `app.audit()`

The build-time deprecation enforcement answers "is my registry clean?" — it doesn't tell you "how many legacy events are still on disk." That question needs a store query, and a store query at app startup is a footgun on large tables. The operator runs it on demand via `app.audit(["deprecated-load"], { thresholds: { deprecated_min: 0.10 } })`. The audit walks `query_stats({names: true})` once, classifies event names by the same `_v<digits>` rule, and yields findings for each deprecated event whose share of the total store is at or above the threshold — sorted by absolute count with top-10 stream carriers per finding.

Same operator-driven category as `app.close()` / `app.reset()` / `app.unblock()`: never auto-invoked; you decide when to run and what to do with the findings. The audit covers eight more categories beyond `deprecated-load` (schema, close-candidate, restart-candidate, reaction-health, snapshot-drift, routing-health, correlation-gaps, clock-anomalies) — each tagged with a remediation. See [Auditing a store](../guides/auditing-a-store.md) for the full catalogue and cookbook recipes.

## Pointers

- `libs/act/src/types/action.ts` — `EventRegister`, `PatchHandlers` — type-level shape that drives this
- `libs/act/src/types/registry.ts` — `Registry.deprecated_events(state_name)` — closure-backed lookup populated at build time; the only programmatic surface for deprecated names
- `libs/act/src/internal/event-sourcing.ts` — `load()` — reads `me.patch[e.name]`; missing reducer logs a warning rather than silently corrupting state. The action path is intentionally deprecation-unaware
- `libs/act/src/internal/merge.ts` — duplicate-event-name guard at slice composition time (one canonical reducer per event)
- `libs/act/src/internal/event-versions.ts` — `_v<digits>` parser; `deprecated_event_names()` + `current_version_of()` helpers
- `libs/act/src/builders/act-builder.ts` — `finalize_deprecations()` populates `registry.deprecated_events`, throws on static `.emit("OldName")` targeting a deprecated event, and emits the one-line startup advisory
