---
id: priority-lanes
title: Reaction priority lanes
---

# Reaction priority lanes

How an operator biases the `claim()` lagging-frontier ordering when the worker is saturated. The short version: `.priority(n)` on the resolver target adds an `ORDER BY priority DESC, at ASC` clause to the lagging CTE so a high-priority replay wins lease slots before equal-watermark peers. Default `0`. Only meaningful under contention.

:::note Priority is intra-lane

ACT-1103 introduced **drain lanes** — separate `DrainController` instances with their own `leaseMillis`/`streamLimit`/`cycleMs` budgets. Priority (this page) and lane (ACT-1103) operate on different axes: a lane carves the drain pipeline along latency classes ("webhooks need 30 s leases, metrics need 1 s leases"), and priority biases which streams *within* a single lane win lease slots under saturation. A reaction sets both independently via `.to({ target, lane, priority })`. See [Concepts → Lanes](../concepts/configuration.md#lanes).

:::

## The problem

`drain()` uses a dual-frontier `claim()` strategy: a lagging budget (most-behind streams catch up) plus a leading budget (active streams stay current). Each cycle picks at most `streamLimit` total. Within the lagging budget, the SQL is `ORDER BY at ASC` — most-behind first. Tie-breaking when many streams share a watermark — the typical replay-after-reset shape — falls to PostgreSQL's physical row order, which is undefined from the framework's perspective.

When `streamLimit` is binding (more candidate streams than the worker can claim per cycle), low-importance replays can claim leases ahead of customer-facing ones because the tie-break is essentially random. Until ACT-102 there was no way to express "this replay matters more."

## The shape

A reaction's resolver gets an optional `priority` field:

```ts no-check
.on("OrderConfirmed")
  .do(sendCriticalNotification)
  .to({ target: "notifications-out", priority: 10 })
```

Or for dynamic resolvers:

```ts no-check
.on("UserActivity")
  .do(updateLeaderboard)
  .to((e) => ({
    target: `leaderboard-${e.data.region}`,
    source: e.stream,
    priority: e.data.tier === "premium" ? 5 : 0,
  }))
```

`claim()`'s lagging CTE becomes `ORDER BY priority DESC, at ASC`. With everyone at `priority = 0` the ordering collapses to plain `at ASC` so existing workloads see no behavior change.

## Fairness — priority biases, it does not starve

Priority is a scheduling hint, not strict precedence. A large high-priority set that always has work must not be able to hold every lagging slot forever and shut a default-priority stream out indefinitely (ACT-1223). So each adapter reserves a small slice of the lagging budget — roughly a quarter of the slots, at least one whenever there are two or more to split — for the most-behind streams by pure watermark ascending, priority ignored. A stream that keeps being passed over falls ever further behind, so its watermark eventually becomes the smallest in the store and the reserve claims it within a bounded number of cycles. High-priority streams still win the majority of slots every cycle, so the bias holds; the reserve only bounds the worst case. Under equal priorities (`priority = 0`, the common case) the priority slice and the reserve both order by `at ASC`, so the split is a no-op. `claim()`'s signature is unchanged — the reserve is purely internal to how each adapter fills the lagging frontier.

## What stays inviolate

**Per-stream event ordering.** Priority only biases *which streams `claim()` picks first*, never the order events within a stream are processed. Within a stream, events still drain by `id ASC`. That's a foundational ES guarantee — ACT-102 explicitly does not break it.

If you need ordering changes inside a stream, the right tool is target filters at subscription time (different reactions on different target streams), not priority.

## Build-time semantic

When multiple reactions target the same stream with different priorities — e.g., one slice registers `target: "shared", priority: 3` and another registers `target: "shared", priority: 7` — the **maximum** wins:

```ts no-check
.on("Inc").do(r1).to({ target: "shared", priority: 3 })  // ignored
.on("Inc").do(r2).to({ target: "shared", priority: 7 })  // sets the lane
```

The same `max()` invariant holds at runtime: `subscribe()` upserts priority via `GREATEST(stored, new)`, so the highest-priority registered reaction sets the scheduling lane.

## Runtime operator override — `app.prioritize`

`subscribe()` can only raise priority (via the max invariant). For runtime adjustments — including *decreases* — use `app.prioritize(filter, n)`:

```ts no-check
// Boost a specific replay
await app.prioritize({ stream: "^proj-orders$", stream_exact: false }, 10);

// Drop background audit jobs to the back
await app.prioritize({ source: "^audit-" }, -5);

// Reset all to default
await app.prioritize({}, 0);
```

Filter shape mirrors [`query_streams`](./extension-points.md#store-contract): regex on `stream`/`source` by default, exact match with the `_exact` flags, `blocked` filter, empty `{}` matches everything. Returns the count of streams whose priority changed.

## When it doesn't matter

Priority only binds **under saturation** — when `streamLimit` < number of candidate lagging streams. If the worker can claim every candidate every cycle, priority is irrelevant. Healthy systems with no backlog see no effect.

Concretely: with the default `streamLimit = 10`, priority starts mattering once you have ~15+ behind streams competing for the lagging slots simultaneously. Cold starts, projection rebuilds, and post-incident catch-up are the typical scenarios.

## Performance

Benchmark in [`@rotorsoft/act-pg`'s `PERFORMANCE.md`](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md). 50 cold-replay targets, 500 events each, `streamLimit = 5` — three back-to-back runs:

- Priority target time-to-finish: **~11× faster** (80 ms vs. 860 ms).
- Total drain time (all 50 targets): **~6 % faster** (priority arm reduces row-level contention on the streams table).
- Final state: identical between arms — priority reorders, doesn't reduce throughput.

## Adapter support

| Adapter | claim ordering | prioritize | schema migration |
| --- | --- | --- | --- |
| `PostgresStore` | `ORDER BY priority DESC, at ASC` in lag CTE | `UPDATE ... WHERE priority <> $1 AND ...` | `ALTER TABLE ADD COLUMN IF NOT EXISTS priority` |
| `SqliteStore` | server-side `SELECT ... ORDER BY priority DESC, at ASC` | parameterized UPDATE with LIKE-translated patterns | `ALTER TABLE ADD COLUMN priority` (try/swallow on duplicate) |
| `InMemoryStore` | sort by `priority DESC, at ASC` in `claim()` | iterate matching streams, set priority directly | n/a |

All three keep the **max invariant** on `subscribe()` and treat `prioritize()` as an outright set.

## See also

- [Correlation and drain](./correlation-and-drain.md) — how `claim()` slots streams into the dual-frontier.
- [Extension points](./extension-points.md) — `Store.subscribe` and `Store.prioritize` contracts.
- [`PERFORMANCE.md`](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md) — benchmark methodology and numbers.
