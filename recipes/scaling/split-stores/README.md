# Split stores — scale out by bounded context or tenant

The step between archival and partitioning. When one store's global-`id`
total order has become your ceiling *because the store is serving more
than one thing*, the answer is not a cleverer schema on the one store —
it is more stores. One Act per bounded context or tenant, each built
with its own store and cache via `ActOptions.scoped`, each with its own
sequence, its own drain, its own close cycle.

This is the framework's real answer to "the shared sequence is the
bottleneck," and it costs a fraction of what partitioning costs, because
it removes the accidental coupling instead of engineering around it.

## When to reach for it

The symptoms are different from Gates 1 and 2 in
[recipes/scaling/README.md](../README.md). There, the table was full of
*finished* streams. Here, the table may already be bounded — the problem
is what it contains:

- **The events table hosts several bounded contexts or tenants.** Orders,
  billing, audit, notifications — or `tenant_a` through `tenant_z` — all
  interleaved in one `id` sequence. Nothing ever reads across them, but
  every commit serializes through the same `events_id_seq` and every
  cross-stream read merge-sorts all of them anyway.
- **Drain fans over unrelated streams.** A busy context's commit rate
  wakes reaction controllers, correlate scans, and claim queries that
  only care about another context's events. Your notification lag climbs
  because the orders context had a flash sale.
- **You've already done close-the-books and archival, and the ceiling is
  structural.** The table is in steady state and still the shared total
  order — one sequence, one watermark space, one `query_stats` surface —
  is the thing you're paying for. The store is one store because that's
  how the app was first deployed, not because anything needs the shared
  order.

The tell for all three: ask what actually reads across the boundary. If
the honest answer is "nothing — orders never replays audit's events, no
projection spans tenants," the global total order over the union is an
accident of deployment. Splitting the store doesn't give anything up;
it stops paying for something nobody used.

If something *does* read across the boundary — a projection that spans
contexts, a debugging habit of "what happened first, system-wide" — read
[What you give up](#what-you-give-up) first, honestly.

## The mechanics

One builder (or one per context), N builds, each with its own ports:

```ts
import { act, InMemoryCache } from "@rotorsoft/act";
import { PostgresStore } from "@rotorsoft/act-pg";

const orders = ordersBuilder.build({
  scoped: {
    store: new PostgresStore({ schema: "orders" }),
    cache: new InMemoryCache({ maxSize: 5000 }),
  },
});

const audit = auditBuilder.build({
  scoped: {
    store: new PostgresStore({ schema: "audit" }),
    cache: new InMemoryCache({ maxSize: 5000 }),
  },
});
```

Per-schema stores on a shared PG host is the gentle first step — separate
sequences and separate watermark spaces without new hardware. When one
context outgrows the host, its schema moves to its own instance and the
application code doesn't change: the store constructor's connection
config is the only diff. That migration path — schema → database →
instance — is the scaling story partitioning never gives you.

Rules that keep this correct, all enforced or documented by the framework
(see [extension-points.md § Scoped ports](../../../docs/docs/architecture/extension-points.md)):

- **Both `store` and `cache`, together, always.** The cache is keyed by
  stream name. Two stores can each hold a stream called `order-1` with
  different histories; a shared cache would serve one store's snapshot
  for the other store's stream. `ActOptions.scoped` requires the pair so
  this collision can't be configured into existence.
- **The AsyncLocalStorage boundary sits at the Act's public methods.**
  Every call on a scoped Act (`do`, `load`, `query`, `drain`, `settle`,
  `close`, ...) runs inside an ALS wrap that binds the bag; everything
  inside the framework keeps calling the plain `store()` / `cache()`
  port getters and resolves to the right adapter transparently. Your
  domain code stays singleton-style — no store parameter threading — and
  a reaction handler that calls `app.do(...)` stays bound to its own
  store across every `await`, no matter what other scoped Acts are
  running concurrently in the process.
- **Notify wiring is per store, at construction.** Each scoped Act binds
  its `Store.notify` subscription against `options.scoped.store` when
  `build()` runs — same contract as the singleton path, different
  source. Cross-process wakeups arrive per store: the orders workers
  listen on the orders store's channel, the audit workers on audit's.
  (With per-schema `PostgresStore`s the NOTIFY channel is already
  namespaced per `(schema, table)`, so two schemas on one host don't
  cross-wake.)
- **Lifecycle is yours.** Scoped adapters are *not* registered with the
  framework's `dispose()` registry. Dispose each store and cache
  explicitly on shutdown, after `app.shutdown()`.
- **The logger stays singleton.** `scoped` carries store + cache only;
  use `log().child({ context: ... })` if you want per-context
  correlation in the logs.

For the shared-builder pattern (one blueprint, N tenants, lazy
mid-process builds) see the extension-points page — the registry is
built once and shared by reference, so per-Act memory cost is the
mutable state (drain controllers, notify subscription), not N copies of
the schema graph.

## What you give up

Be honest about this list before splitting; every item is permanent.

- **No cross-store total order.** Each store has its own `id` sequence.
  "What happened first across the whole system" stops being a query and
  becomes a correlation exercise across two event logs with unrelated
  clocks. If an auditor or a debugger genuinely needs system-wide order
  today, either keep those contexts together or accept timestamp-based
  reconstruction with its usual caveats.
- **Cross-context reactions leave the framework.** Inside one store,
  a reaction is a drain lease with at-least-once delivery and a
  watermark. Across stores there is no shared watermark to advance. The
  patterns are the ones from
  [external-integration.md](../../../docs/docs/guides/external-integration.md):
  forward the fact to a bus (SQS/Kafka/NATS) from a thin publishing
  reaction, or POST it to the receiving context's inbound receiver
  (`@rotorsoft/act-http/receiver`) — in both cases the receiving side
  owns idempotency, exactly as it would for any external producer. In a
  single process you can call the other Act's `app.do(...)` directly
  (its own ALS wrap binds the commit to its own store — see the runnable
  example below), but treat that as the modular-monolith transitional
  form of the same pattern, not a third architecture.
- **Correlation chains stop at the boundary.** `reactingTo` /
  `meta.causation` reference event ids in one store; a commit in another
  store is an originating action with fresh correlation. Carry the
  upstream correlation id in the payload if you need to stitch traces.
- **Operational surfaces multiply.** One inspector instance per store.
  `app.reset(targets)`, `app.blocked_streams()`, `app.audit()`, close
  cycles, and `query_stats` are all per-Act — a fleet-wide projection
  rebuild is now N rebuilds, and your runbooks and dashboards need the
  loop. This is the real recurring cost of the split: not code, but
  N of everything an operator touches.
- **Backups and migrations multiply too.** Per-schema stores on one host
  keep this cheap (one `pg_dump`, one maintenance window); per-instance
  stores make it real money. Budget accordingly.

## When it beats partitioning — and when it doesn't

Almost always, when the table is divisible. Compare what each buys:

Partitioning keeps the single store and the single total order, and pays
for it forever: MergeAppend planner cost on every cross-stream read,
N×K index trees, a composite primary key, a full-table-rewrite migration
window (the [partitioning gating page](../partitioning/README.md) leads
with "don't" for these reasons). And it keeps the one property you just
established nobody uses — the total order across contexts.

Splitting stores drops that pretense. Each context's drain reads only
its own events in its own order; single-context reads are exactly as
fast as a small unpartitioned table, which is the fastest shape the
adapter has. There is no partition-key coupling in the schema, no
planner tax, and the migration is a per-context copy you can do one
context at a time — with the smallest, least risky context first as the
rehearsal.

Partitioning is still the answer when the workload is **one giant
indivisible context**: a single regulated append-only ledger, one
bounded context whose own streams outgrow the table. There is no seam
to split along, so the four extreme cases in the
[partitioning gate](../partitioning/README.md) apply as written.
Split-stores and partitioning also compose — split by context first,
then partition the one context that individually qualifies.

## Examples in this folder

- [examples/two-contexts.ts](examples/two-contexts.ts) — two bounded
  contexts (orders, audit) in one process, each Act built with its own
  `InMemoryStore` + `InMemoryCache`, a forwarding reaction carrying a
  fact across the boundary, and leak checks proving neither store (nor
  the process-wide singleton) ever sees the other context's streams.

It compiles against `@rotorsoft/act` as published and runs with
`tsx` — no database needed to verify the isolation mechanics. For the
production shape, replace each `InMemoryStore` with a per-schema
`PostgresStore` as in the snippet above.
