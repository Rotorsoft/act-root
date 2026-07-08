# Lift the LISTEN/NOTIFY fanout ceiling

You want more workers than Postgres wants listener connections. Every Act worker that subscribes to cross-process wakeups through the built-in channel holds a dedicated `LISTEN` connection, and connection budgets on managed Postgres are famously stingy. The wakeup channel is a hint, not a contract — correctness always comes from `claim()`/drain over the durable store — so the fix is to move the hint, not the truth.

## The move

[`@rotorsoft/act-notify`](https://www.npmjs.com/package/@rotorsoft/act-notify) wraps your durable adapter and rides a broker for wakeups only:

```ts no-check
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { RedisBroker, withBroker } from "@rotorsoft/act-notify";
import { createClient } from "redis";

const publisher = createClient({ url: process.env.REDIS_URL });
const subscriber = publisher.duplicate();
await publisher.connect();
await subscriber.connect();

store(
  withBroker(
    new PostgresStore({ notify: false }), // stop paying for LISTEN
    new RedisBroker({ publisher, subscriber })
  )
);
```

That is the whole migration. One Redis connection per worker replaces one Postgres listener per worker, and a single Redis instance fans out to thousands of subscribers without blinking. Everything else — leases, ordering, replay, the events table — is exactly the store you already run; the decorator passes the full Store TCK wrapping a real `PostgresStore`.

## What breaks when the broker breaks

Nothing but latency. Publish failures are swallowed and logged; a Redis outage means remote workers wake on their next poll cycle instead of within milliseconds. A broker that drops, duplicates, or reorders messages changes nothing about what drain processes — there is a test that does exactly that to prove it.

## What this deliberately does not solve

The durable log is not sharded. If your wall is write throughput or table size — not wakeup fanout — this recipe is the wrong page: see [split stores](../split-stores/README.md) for scale-out by context, and the [partitioning gating page](../partitioning/README.md) before reaching for anything heavier.
