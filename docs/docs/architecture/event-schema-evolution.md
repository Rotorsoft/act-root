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

```ts
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

```ts
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

```ts
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

## Pointers

- `libs/act/src/types/action.ts` — `EventRegister`, `PatchHandlers` — type-level shape that drives this
- `libs/act/src/internal/event-sourcing.ts` — `load()` — reads `me.patch[e.name]`; missing reducer logs a warning rather than silently corrupting state
- `libs/act/src/internal/merge.ts` — duplicate-event-name guard at slice composition time (one canonical reducer per event)
