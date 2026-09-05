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

The same `max()` invariant holds at runtime: `subscribe()` upserts priority via `GREATEST(stored, new)`, so the highest-priority registered reaction sets the scheduling lane. This holds for **dynamic resolvers across correlate scans** too — if a target is first discovered at a low priority and a later event resolves a higher one for the same target, the correlate cycle re-subscribes it so the store's `GREATEST` raises it (a lower-or-equal later resolution is a no-op). The orchestrator tracks the last-subscribed priority per dynamic target rather than mere presence, so the upgrade isn't frozen at first discovery ([#1363](https://github.com/Rotorsoft/act-root/issues/1363)).

The lane rides that same merge: `subscribe()` writes `lane` only when the incoming priority is at or above the stored one ([#1599](https://github.com/Rotorsoft/act-root/issues/1599)). The orchestrator's per-target map is bounded, and a record goes missing on eviction or on any restart — a missing record reads as never-seen, which used to let a lower-priority resolution take a lane it had already lost. Keeping the rule in the store means forgetting is a cache miss rather than a correctness event.

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
| `PostgresStore` | `ORDER BY priority DESC, at ASC` in lag CTE (over the correlated set — see below) | `UPDATE ... WHERE priority <> $1 AND ...` | `ALTER TABLE ADD COLUMN IF NOT EXISTS priority` |
| `SqliteStore` | server-side `SELECT ... ORDER BY priority DESC, at ASC` | parameterized UPDATE with LIKE-translated patterns | `ALTER TABLE ADD COLUMN priority` (try/swallow on duplicate) |
| `InMemoryStore` | sort by `priority DESC, at ASC` in `claim()` | iterate matching streams, set priority directly | n/a |

All three keep the **max invariant** on `subscribe()` and treat `prioritize()` as an outright set.

Ordering applies **over the correlated set**, not over every subscription ([#1485](https://github.com/Rotorsoft/act-root/issues/1485)). A subscription row carries an optional work mark (`correlated_at`, the highest event id seen to resolve to that target), and a marked stream is eligible only while `at < correlated_at`. Priority and lane then order the streams that survive that filter. This changes the cost, not the outcome: the streams excluded are the ones the old has-work probe would have rejected anyway, so the same set is ordered the same way — on Postgres out of a partial index (`(lane, priority DESC, at) WHERE blocked = false AND at < correlated_at`) that contains only streams with work. Since [#1488](https://github.com/Rotorsoft/act-root/issues/1488) that index is the whole story: `claim` reads no other source of truth.

## See also

- [Correlation and drain](./correlation-and-drain.md) — how `claim()` slots streams into the dual-frontier.
- [Extension points](./extension-points.md) — `Store.subscribe` and `Store.prioritize` contracts.
- [`PERFORMANCE.md`](https://github.com/rotorsoft/act-root/blob/master/libs/act-pg/PERFORMANCE.md) — benchmark methodology and numbers.
