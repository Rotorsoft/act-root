---
id: getting-started
title: Build your first event-sourced app
sidebar_position: 1
---

# Build your first event-sourced app

This guide walks through modeling, dispatching actions to, and reading from a small event-sourced state in Act — start to finish, no prior framework knowledge required. By the end you'll have a runnable counter, a dispatched action, an event in the log, and a reconstructed state. You'll also know exactly which primitive to reach for next.

## What you'll build

A counter with a single action (`increment`) and a single event (`Incremented`). Trivial domain on purpose — the point is to see every primitive in one place.

## 1. Set up

```bash
mkdir my-counter && cd my-counter
pnpm init
pnpm add @rotorsoft/act zod
pnpm add -D typescript tsx @types/node
npx tsc --init --target ES2022 --module nodenext --moduleResolution nodenext --strict
```

Make sure `package.json` has `"type": "module"` so Node treats your `.ts` files as ESM.

## 2. Define the state

Create `counter.ts`:

```typescript
import { state } from "@rotorsoft/act";
import { z } from "zod";

export const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: ({ data }, state) => ({ count: state.count + data.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();
```

Three things just happened:

1. **`state({ Counter: schema })`** declared a state machine named `Counter` whose data shape is `{ count: number }`. The Zod schema is the single source of truth — Act uses it for both runtime validation and TypeScript inference.
2. **`.init(() => ({ count: 0 }))`** says "a brand-new Counter starts at 0." This is what `app.load(Counter, "anything")` returns when the stream has no events yet.
3. **`.emits({ Incremented })`** declares that this state can emit `Incremented` events. **`.patch({ Incremented: … })`** is the reducer — the function Act runs when replaying events to rebuild state. **`.on({ increment }) .emit(...)`** declares an action: a command that takes `{ by: number }`, validates it, and emits an `Incremented` event with the same `amount`.

Note the asymmetry: the action is `increment` (lowercase, intent), the event is `Incremented` (PascalCase, fact). Act doesn't enforce this naming, but it's the convention.

## 3. Wire the orchestrator

Create `index.ts`:

```typescript
import { act } from "@rotorsoft/act";
import { Counter } from "./counter.js";

const app = act().withState(Counter).build();
const actor = { id: "alice", name: "Alice" };

await app.do("increment", { stream: "counter-1", actor }, { by: 5 });
await app.do("increment", { stream: "counter-1", actor }, { by: 3 });

const snapshot = await app.load(Counter, "counter-1");
console.log(snapshot.state); // { count: 8 }
console.log(snapshot.version); // 1 (zero-indexed: events 0 and 1)
```

Run it: `npx tsx index.ts`. You should see `{ count: 8 }` and `1`.

What happened:

- `act().withState(Counter).build()` composes everything into a runnable orchestrator. By default it uses an in-memory event store and an in-memory cache — perfect for development and tests.
- **`app.do(action, target, payload)`** dispatches an action. Act validates the payload, runs any invariants, applies the reducer, commits the resulting events to the store, updates the cache, and returns one snapshot per emitted event.
- **`app.load(State, stream)`** reconstructs current state by replaying events from the cache or store. The `version` is the 0-indexed sequence number of the last event.

## 4. Add a business rule (invariant)

Real domains have rules: "you can't decrement below zero", "you can't close a ticket twice", etc. Act expresses them as **invariants** — small pure functions checked before an action runs:

```typescript
import { type Invariant } from "@rotorsoft/act";

const mustStayPositive: Invariant<{ count: number }> = {
  description: "Count cannot go negative",
  valid: (state) => state.count >= 0,
};

// Add a `decrement` action that reuses the same Incremented event
// (with negative amount) and is gated by the invariant:
.on({ decrement: z.object({ by: z.number() }) })
  .given([mustStayPositive])
  .emit((action) => ["Incremented", { amount: -action.by }])
```

When the invariant fails, Act throws `InvariantError` *before* any event is committed. State doesn't change; the caller sees a typed error with the rule's `description`.

## 5. Inspect what happened

The event log is the audit trail. You can query it directly:

```typescript
const events = await app.query_array({ stream: "counter-1", stream_exact: true });
events.forEach((e) => {
  console.log(`v${e.version}: ${e.name} by ${e.meta.causation.action.actor.name}`);
});
// v0: Incremented by Alice
// v1: Incremented by Alice
```

Every event carries its action's actor, correlation id (request trace), and causation (what triggered it). This is what makes time-travel and debugging possible.

You can also reconstruct state at a specific point in time:

```typescript
// State just before event id 5
const past = await app.load(Counter, "counter-1", undefined, { before: 5 });
```

See [Event Sourcing & Processing → Time-travel queries](../concepts/event-sourcing.md#time-travel-queries) for the full filter set.

## 6. Where to go next

You've covered the four primitives that show up in every Act app:

- **State** (`state()`) — what your domain looks like and how events transform it
- **Actions** (`.on().emit()`) — typed intents that produce events
- **Invariants** (`.given()`) — preconditions checked before commit
- **Events** (`.emits()`/`.patch()`) — the immutable record

The next things you'll want, in roughly the order you'll need them:

1. **A real database.** Replace the in-memory store with PostgreSQL or SQLite — see [Configuration → Store](../concepts/configuration.md#store).
2. **A read model.** Counters fit in events. Bigger queries — "all open tickets assigned to me" — want a projection that writes to a table you can index. See [Wiring projections to a database](./projections-to-database.md).
3. **Reactions.** When one event should trigger another action (e.g. `OrderPlaced` → `ReserveInventory`), reach for slices and reactions. See [State Management → Slices](../concepts/state-management.md#slices).
4. **Production wiring.** Lifecycle events, settle-on-commit, graceful shutdown, snapshot policy — see [Production checklist](./production-checklist.md).
