---
id: configuration
title: Builders & Adapters
---

# Builders & Adapters

Act uses a fluent builder pattern for defining domain logic and a port/adapter pattern for infrastructure concerns.

## State Builder

Define state machines with actions, events, and validation:

```typescript
import { state } from "@rotorsoft/act";
import { z } from "zod";

const Counter = state({ Counter: z.object({ count: z.number() }) })
  .init(() => ({ count: 0 }))
  .emits({ Incremented: z.object({ amount: z.number() }) })
  .patch({
    Incremented: ({ data }, state) => ({ count: state.count + data.amount }),
  })
  .on({ increment: z.object({ by: z.number() }) })
    .emit((action) => ["Incremented", { amount: action.by }])
  .build();
```

## Projection Builder

Read-model updaters that react to events:

```typescript
import { projection } from "@rotorsoft/act";

const CounterProjection = projection("counters")
  .on({ Incremented: z.object({ amount: z.number() }) })
    .do(async ({ stream, data }) => { /* update read model */ })
  .build();
```

## Slice Builder

Vertical feature modules grouping states, projections, and reactions:

```typescript
import { slice } from "@rotorsoft/act";

const CounterSlice = slice()
  .withState(Counter)
  .withProjection(CounterProjection)
  .on("Incremented")
    .do(async (event, stream, app) => { /* cross-state dispatch via app */ })
    .to((event) => ({ target: event.stream }))
  .build();
```

## Act Orchestrator

Compose everything into an application:

```typescript
import { act } from "@rotorsoft/act";

const app = act()
  .withSlice(CounterSlice)
  .withState(AnotherState)
  .withProjection(StandaloneProjection)
  .on("SomeEvent")
    .do(handler)
    .to(resolver)
  .build();
```

## Port/Adapter Pattern

Infrastructure concerns (logging, storage, caching) use singleton adapters injected via port functions. All three ports follow the same pattern — first call wins, with a sensible default:

```typescript
import { log, store, cache } from "@rotorsoft/act";

const logger = log();   // ConsoleLogger (default)
const s = store();       // InMemoryStore (default)
const c = cache();       // InMemoryCache (default)
```

### Logger

The default `ConsoleLogger` emits JSON lines in production (compatible with GCP, AWS CloudWatch, Datadog) and colorized output in development — zero dependencies.

```typescript
import { log } from "@rotorsoft/act";

const logger = log();
logger.info("Application started");
```

For pino, inject the adapter from `@rotorsoft/act-pino`:

```typescript
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

log(new PinoLogger({ level: "debug", pretty: true }));
```

The `Logger` interface is minimal and compatible with pino, winston, bunyan, and other popular loggers:

```typescript
interface Logger extends Disposable {
  level: string;
  fatal(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  trace(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
```

### Store

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

// Development: in-memory (default)
const s = store();

// Production: inject PostgreSQL
store(new PostgresStore({
  host: "localhost",
  database: "myapp",
  user: "postgres",
  password: "secret",
  schema: "public",
  table: "events",
}));

// Embedded / single-node: SQLite via libSQL
import { SqliteStore } from "@rotorsoft/act-sqlite";
store(new SqliteStore({ url: "file:myapp.db" }));
```

### Cache

Cache is always-on with `InMemoryCache` (LRU, maxSize 1000) as the default:

```typescript
import { cache } from "@rotorsoft/act";

// Default: InMemoryCache — no setup needed
// For distributed deployments:
cache(new RedisCache({ url: "redis://localhost:6379" }));
```

The `Cache` interface is async for forward-compatibility with external caches:

```typescript
interface Cache extends Disposable {
  get<TState>(stream: string): Promise<CacheEntry<TState> | undefined>;
  set<TState>(stream: string, entry: CacheEntry<TState>): Promise<void>;
  invalidate(stream: string): Promise<void>;
  clear(): Promise<void>;
}
```

### Resource Disposal

All adapters (logger, store, cache, and custom disposers) are cleaned up via `dispose()()`:

```typescript
import { dispose } from "@rotorsoft/act";

// Register custom cleanup
dispose(async () => {
  await redis.quit();
});

// Trigger cleanup (graceful shutdown or test teardown)
await dispose()();
```

## Custom Store Implementation

Implement the `Store` interface for custom backends:

```typescript
interface Store extends Disposable {
  seed(): Promise<void>;
  drop(): Promise<void>;
  commit(stream, msgs, meta, expectedVersion?): Promise<Committed[]>;
  query(callback, filter?): Promise<number>;
  claim(lagging, leading, by, millis): Promise<Lease[]>;
  subscribe(streams): Promise<{ subscribed: number; watermark: number }>;
  ack(leases): Promise<Lease[]>;
  block(leases): Promise<(Lease & { error })[]>;
  dispose(): Promise<void>;
}
```

`claim()` atomically discovers and locks streams for processing using PostgreSQL's `FOR UPDATE SKIP LOCKED` pattern — zero-contention competing consumers where workers never block each other. `subscribe()` registers new streams for reaction processing and returns the count of newly registered streams. Version-based optimistic concurrency must be implemented correctly. See the [PostgresStore source](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/src/PostgresStore.ts) for a production-grade reference.
