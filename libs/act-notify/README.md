# @rotorsoft/act-notify

_Ride a broker for cross-process wakeups — the durable log stays exactly where it is._

The practical ceiling for Act's built-in cross-process wakeup is the Postgres `LISTEN`/`NOTIFY` subscriber-connection budget: every worker holds a dedicated listener connection, and connection budgets are precious. Because `Store.notify` is a **hint, not a contract** — correctness always comes from `claim()`/drain over the durable store — the wakeup channel is swappable without touching a single durability, lease, or ordering guarantee.

`withBroker(store, broker)` is that swap, packaged: a decorator that delegates every durable `Store` method to the wrapped adapter and overrides only the notification channel. Commits publish a wakeup hint to the broker; `notify` subscribes to it; everything else — including the self-filtering contract (your own commits never wake you) — is handled.

```typescript
import { store } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";
import { RedisBroker, withBroker } from "@rotorsoft/act-notify";
import { createClient } from "redis";

const publisher = createClient();
const subscriber = publisher.duplicate(); // redis pub/sub needs its own connection
await publisher.connect();
await subscriber.connect();

store(
  withBroker(
    new PostgresStore({ notify: false }), // broker carries the wakeups now
    new RedisBroker({ publisher, subscriber })
  )
);
// ...then act()...build() as usual — the orchestrator wires notify automatically
```

Sink-injection, zero dependencies: you pass connected clients (node-redis v4+ shapes); the package never pins your client version.

## Brokers

- **`RedisBroker`** — pub/sub fan-out; every subscribed worker sees every wakeup. Implemented and the recommended production choice.
- **`LoopbackBroker`** — in-process fan-out; the reference implementation, used by the TCK conformance run and handy for tests or multi-orchestrator single-process setups.
- **`KafkaBroker`** — a scaffold that refuses loudly. Kafka consumer groups deliver each message to one consumer per group, while wakeups need fan-out to every worker; until the per-process `groupId`/offset/rebalance semantics are settled against a real deployment, the adapter throws with guidance instead of fanning out incorrectly.

Any `{ publish, subscribe }` implementation of the exported `Broker` type works — NATS, MQTT, or your own bus are a dozen lines away.

## What this does not do

It does **not** shard the durable log. Writes, replay, and global ordering stay bound to the wrapped store — if the log itself is the wall, see the partitioning and split-stores recipes. A broker outage degrades cross-process latency to the poll cycle and nothing else: publish failures are swallowed and logged, and a broker that drops, duplicates, or reorders every message changes nothing about what drain processes (there is a test that does exactly that).

## Conformance

The decorator passes the full Store TCK — including the lease-semantics cases — wrapping a real `PostgresStore`. If you decorate a different adapter, run `runStoreTck` from `@rotorsoft/act-tck` over your wrapped factory to prove the same.
