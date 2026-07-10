---
id: cross-process-reactions
title: Cross-process reactions
---

# Cross-process reactions

How Act keeps reaction latency low when more than one process shares the backing event store. The short version: the configured store may implement an optional `notify(handler)` hook; the orchestrator wires it in at build time and wakes `settle()` immediately on commits from other processes — no polling lag, no extra code.

## The problem

In a single-process app, `do()` arms the drain locally and `settle()` runs reactions on the same Node event loop. Latency is bounded by reaction work, not by the framework.

Two or more processes against the same store don't have that luxury. A commit on Worker A is invisible to Worker B until Worker B asks the store. The default mechanism is polling — `start_correlations` runs on a timer, or the user calls `settle()` periodically. The polling interval becomes a floor on reaction latency:

- `start_correlations` default: **10 s**.
- Common explicit poll loops: **50–500 ms**.
- Local single-process: **0 ms** (event loop turn).

For event-driven workloads where reactions matter, that 10 s floor is a deal-breaker. Even 50 ms is loose for things like SSE fan-out or near-real-time projections.

## The hook

The `Store` interface has an optional method:

```ts no-check
interface Store extends Disposable {
  // ...existing...
  notify?(
    handler: (notification: StoreNotification) => void
  ): NotifyDisposer | Promise<NotifyDisposer>;
}

type StoreNotification = {
  readonly stream: string;
  readonly events: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
  }>;
};
```

When present, the orchestrator subscribes once at `build()` time and routes notifications to wake `settle()` automatically. The hook is **opt-in at the adapter level** — `PostgresStore` defaults `notify: false` so single-instance deployments pay zero overhead. Multi-process apps enable it explicitly:

```ts no-check
store(new PostgresStore({ /* ... */, notify: true }));   // ← opt in
const app = act()
  .withState(Order)
  .on("OrderPlaced").do(reduceInventory).to("inventory")
  .build();
// Cross-process commits wake reactions on this process.
```

Optionally, the user can also subscribe to the `notified` lifecycle event for SSE fan-out, dashboards, or audit:

```ts no-check
app.on("notified", (n) => sse.broadcast(n));
```

## Self-filter — a clean cross-process semantic

Every store instance carries a per-instance UUID (`_by`) embedded in the NOTIFY payload. The LISTEN handler skips payloads where `by === this._by`. Result:

- Local commits never echo back through `notified` (the local fast path inside `do()` already arms drain — no double signal).
- The `notified` lifecycle event surfaces only **another process** writing to the same store. That gives consumers a clean signal for cross-process visibility.

The alternative (broadcast everything, let the consumer filter) was rejected as messier — it pollutes the local fast path with self-echoes and forces every listener to know about the filter.

Self-filtering is a portable `Store.notify` contract, not a Postgres detail: the TCK's `notify` capability suite enforces it (plus one-notification-per-commit batch delivery) against every adapter that declares the capability ([#1184](https://github.com/Rotorsoft/act-root/issues/1184)).

## Payload cap — oversize commits degrade to poll

PostgreSQL rejects NOTIFY payloads at or above 8000 bytes (`payload string
too long`), and `pg_notify` runs inside the commit transaction — an
unguarded oversize payload would abort the whole INSERT batch. `commit()`
therefore measures the serialized payload first and **skips the NOTIFY when
it would not fit** (very large batches, long stream/event names). The commit
succeeds, no notification goes out, and listeners pick the events up on
their next poll cycle — delivery degrades in latency, never in guarantees.
At-least-once is preserved because NOTIFY is only ever a latency
optimization over the poll path, not the delivery mechanism itself.

## Adapter status

| Adapter | `notify` | Why |
| --- | --- | --- |
| `PostgresStore` | implemented (opt-in via `notify: true`) | `LISTEN`/`NOTIFY` on a per-`(schema, table)` channel (`act_commit_<schema>_<table>`). One NOTIFY per commit transaction with the full event batch as JSON payload. Default off — single-instance deployments pay zero overhead, existing callers keep their current behavior on upgrade. |
| `InMemoryStore` | not implemented | Single-process by definition — there is no remote writer. |
| `SqliteStore` | not implemented | Single-node by design. Use `@rotorsoft/act-pg` for multi-process. |

## Build-time contract

Inject the store via `store(adapter)` **before** calling `act()...build()`. The orchestrator wires the notify subscription against whichever store is current at construction; late injection won't take effect.

```ts no-check
// ✅ Correct
store(new PostgresStore({...}));
const app = act().withState(Order).build();

// ❌ Wrong — orchestrator binds before injection
const app = act().withState(Order).build();
store(new PostgresStore({...}));   // too late; notify wasn't wired
```

Tests that build the app at module-load time should refactor to a `buildApp()` factory called inside `beforeAll` after store injection.

## Hint, not a contract

`notify` is a **performance hint**. The orchestrator never depends on it for correctness:

- If the store doesn't implement `notify`, the existing debounce/poll path still drains correctly.
- If a notification is dropped (network hiccup, pool exhaustion, misconfigured channel), the existing debounce/poll path still drains correctly.

This means you can run notify as the happy-path optimization and keep `start_correlations` (or a periodic `settle()` timer) as the safety net. Lost wakeups cost latency, never correctness.

## Topology and connection budget

`LISTEN` checks out a **dedicated client** from the pool. Each subscribed process holds one extra connection for the lifetime of the subscription. Three common topologies:

- **Fat single process**: simplest, no notify needed. Easily handles thousands of events/sec.
- **Symmetric workers**: N identical processes, all running the same reactions, sharing a DB. Notify wakes them all; competing consumers via `claim()` (`FOR UPDATE SKIP LOCKED`) ensures exactly-once-per-event per logical reaction. Scales linearly until the connection budget bites.
- **Specialized sidecars**: each process subscribes to a different reaction subset. Notify wakes everyone but only the relevant subscriber does work.

For the symmetric-workers topology, watch for the **thundering herd**: every process wakes on every cross-process commit and races for the same lease. Only one wins per stream — the rest see no work and go back to sleep. That's correct but introduces some redundant claim attempts. A small debounce on `notified` helps under bursty load.

## Performance

Benchmark in [`@rotorsoft/act-pg`'s `PERFORMANCE.md`](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md). Single run, docker PG on `localhost`, 30 single-event commits:

| Mode | p50 | p95 | p99 |
| --- | --- | --- | --- |
| notify | 11 ms | 15 ms | 25 ms |
| polling (50 ms) | 27 ms | 54 ms | 77 ms |

At 50 ms polling, notify is ~3× faster across percentiles. At the default `start_correlations` 10 s interval, the gap blows out to ~1000×.

## See also

- [Correlation and drain](./correlation-and-drain.md) — how `settle()` actually runs.
- [Extension points](./extension-points.md) — `Store` contract reference.
- [`@rotorsoft/act-pg/PERFORMANCE.md`](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md) — benchmark methodology and numbers.
