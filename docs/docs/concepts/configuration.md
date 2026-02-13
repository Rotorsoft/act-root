# Builders & Adapters

## Tips for Builders & Adapters

- Use `StateBuilder` to define state machines, actions, events, and validation logic in a fluent, type-safe way.
- Use `ActBuilder` to compose applications from multiple state machines and reactions.
- Adapters allow you to swap event stores (e.g., in-memory, Postgres, custom) without changing business logic.
- Use reactions to decouple workflows and integrate with external systems.
- Visualize your application architecture to clarify how builders and adapters interact.

---

## Example 1: Composing State Machines with Builders

**Scenario:**
You want to define two state machines (e.g., a Counter and a TodoList) and compose them into a single application using `ActBuilder`.

```typescript
import { act, state, z } from "@rotorsoft/act";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: (event, state) => ({ count: state.count + event.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
  .emit((action) => ["Incremented", { amount: action.by }])
  .build();

const TodoList = state({ TodoList: z.object({ todos: z.array(z.string()) }) })
  .init(() => ({ todos: [] }))
  .emits({ Added: z.object({ todo: z.string() }) })
  .patch({
    Added: (event, state) => ({ todos: [...state.todos, event.todo] }),
  })
  .on({ add: z.object({ todo: z.string() }) })
  .emit((action) => ["Added", { todo: action.todo }])
  .build();

const app = act().with(Counter).with(TodoList).build();
```

---

## Example 2: Using a Postgres or Custom Store Adapter

**Scenario:**
You want to use a Postgres event store in production and an in-memory store for testing, without changing your application logic. You inject the adapter using the `store()` function before any event processing.

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

store(
  new PostgresStore({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT) || 5432,
    database: process.env.PGDATABASE || "postgres",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    schema: "public", // or your custom schema
    table: "events", // or your custom table
  })
);
```

---

## How to Build a Custom Store Adapter

**Scenario:**
You want to connect your application to a custom event store (e.g., a cloud database). Implement the `Store` interface and inject your adapter using the `store()` function.

```typescript
import type {
  Store,
  EventMeta,
  Message,
  Committed,
  Schemas,
} from "@rotorsoft/act";

export class MyCustomStore implements Store {
  async seed() {
    /* ... */
  }
  async drop() {
    /* ... */
  }
  async dispose() {
    /* ... */
  }
  async commit<E extends Schemas>(
    stream: string,
    msgs: Message<E, keyof E>[],
    meta: EventMeta,
    expectedVersion?: number
  ): Promise<Committed<E, keyof E>[]> {
    // Your persistence logic here
    return [];
  }
  async query<E extends Schemas>(
    callback: (event: Committed<E, keyof E>) => void,
    query?: any
  ): Promise<number> {
    // Your query logic here
    return 0;
  }
  async fetch<E extends Schemas>(limit: number) {
    /* ... */ return { streams: [], events: [] };
  }
  async lease(leases: any[]) {
    /* ... */ return [];
  }
  async ack(leases: any[]) {
    /* ... */
  }
}

// Inject your custom store
import { store } from "@rotorsoft/act";
store(new MyCustomStore());
```

---

## Advanced: Lease Management & Reliable Event Stream Processing

Building a robust custom store adapter is much more than just persisting events—it requires careful design for distributed, reliable, and efficient event stream processing, with **lease management** at its core.

### What is a Lease?

A lease is a temporary claim on a stream for processing. It ensures that only one process (or worker) is handling a given event stream at a time, supporting distributed, parallel, and fault-tolerant event processing.

### Key Methods

- **`fetch(limit)`**: Returns a batch of streams and events that are ready for processing (not blocked or already leased).
- **`lease(leases)`**: Attempts to acquire leases on the given streams. Should atomically mark streams as leased (with a timeout/expiry).
- **`ack(leases)`**: Acknowledges processing is complete, updates stream positions, and releases the lease.

### Challenges

- **Atomicity:** Leasing and updating stream positions must be atomic to avoid race conditions.
- **Timeouts:** Leases must expire if a worker crashes or hangs, so other workers can take over.
- **Retries:** Support for retrying failed streams, with backoff or retry counters.
- **Blocking:** Ability to block streams that are in an error state or require manual intervention.
- **Scalability:** Efficiently handle many streams and high event throughput.

### Best Practices

- Use transactions for all lease and commit operations.
- Index your stream and lease tables for fast lookups and updates.
- Handle lease expiry: If a lease is not acknowledged in time, it should become available for other workers.
- Support retries and backoff for failed processing.
- Log and monitor lease acquisition, expiry, and errors for observability.

### Sample Lease Table Schema (for SQL-based stores)

```sql
CREATE TABLE streams (
  stream VARCHAR PRIMARY KEY,
  at INT NOT NULL DEFAULT -1,
  retry SMALLINT NOT NULL DEFAULT 0,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  leased_by UUID,
  leased_at INT,
  leased_until TIMESTAMPTZ
);
```

### Summary Table

| Method | Purpose                                  | Complexity/Notes                          |
| ------ | ---------------------------------------- | ----------------------------------------- |
| fetch  | Find streams/events ready for processing | Must filter out blocked/leased streams    |
| lease  | Atomically acquire leases on streams     | Use transactions/locking, set expiry      |
| ack    | Release lease, update stream position    | Must be atomic, handle errors and retries |

> **Note:** Lease management is critical for correctness and reliability in distributed event-driven systems. Study the [PostgresStore](https://github.com/rotorsoft/act/blob/master/libs/act-pg/src/PostgresStore.ts) for a production-grade reference implementation.
