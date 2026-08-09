# RFC 1449: splitting the `Store` port into event store + subscription store

- **Status:** draft — **superseded in part.** The original recommendation (do not split) still holds *as posed*, but the question was reframed: see § Reframing. The interesting primitive is a subscription-side work set, which makes the split possible and is worth doing on its own merits.
- **Issue:** #1449 (benchmarks filed separately as #1448)
- **Author:** Rotorsoft
- **Created:** 2026-08-09

## Motivation

`Store` is one port covering two jobs:

| Event store | Subscription / drain |
|---|---|
| `commit`, `query`, `query_stats`, `scan`/`restore`, `forget_pii`, `notify` | `subscribe`, `claim`, `ack`, `block`, `unblock`, `defer`, `prioritize`, `reset`, `query_streams` |
| `truncate` — **spans both** | |

Splitting them into two interfaces would let one app instance run two adapters: events durable in Postgres, subscriptions and leases somewhere cheaper or faster (Redis, an in-memory tier, a queue). The types partition cleanly, and there is precedent — `EventSource` / `EventSink` (extension-points.md:123) already split the read and write ends of the restore pipeline so `Act.restore` can move events between any source and any sink.

## The two blockers, in the order people find them

### 1. `truncate` is one transaction across both halves

`postgres-store.ts:~2190`:

```sql
DELETE FROM streams WHERE stream = ANY($1)   -- subscription side
DELETE FROM events  WHERE stream = $1        -- event side
INSERT INTO events(...)                      -- the seed snapshot / tombstone
```

Close-the-books is atomic across the two tables by design. Split the adapters and this becomes a distributed commit: land the events truncate without the streams delete and the stream is retired but still subscribed; land the reverse and you orphan a live aggregate's subscription. `restore` has the same shape (its doc-comment: *"truncate the events + streams/subscriptions tables"*).

**This one is tractable.** Close is low-cadence housekeeping, so a two-phase protocol is affordable, and the machinery already exists: phase 3 writes a tombstone guard, and #1389 made an interrupted close **resumable** — a stream whose non-snap head is a tombstone is detected and resumed rather than re-tombstoned. Extending that to "crashed between the two stores" is engineering, not a redesign.

`commit` is clean: it never touches the streams table (verified — zero references to the streams relation in its body).

### 2. `claim` is a join, and that is the whole problem

```sql
SELECT ... FROM streams s
WHERE ... AND (s.at < 0 OR EXISTS (
  SELECT 1 FROM events e WHERE e.id > s.at AND e.name <> '__snapshot__' ...))
```

"Which subscribed streams have unconsumed work?" is answered by correlating the subscription watermark against the event log. If those live in different adapters the join is impossible, and the drain must read candidates from the subscription store and probe the event store per candidate — on the hottest path in the system.

Underneath is a semantic coupling: **`streams.at` is an event id issued by the other store.** The watermark space, the monotonic-id guarantee, and the `pg_advisory_xact_lock` gap-closing (#1178) all assume a single id issuer. That survives a split only if exactly one adapter mints ids and the other treats them as opaque — workable, but it means the subscription store can never answer "is there work?" on its own.

## Measurements

Real Postgres on :5431, 3 events per stream, ids shuffled so a stream's watermark lands at a random point in the global sequence (the realistic shape once streams are active at different times). Lease budget 10. `hit%` is the fraction of subscribed streams with unconsumed work — a healthy steady state is **sparse**, because most streams are caught up.

Script: `libs/act-pg/scripts/store-split-claim.bench.mjs`.

| streams | hit% | joined (today) | joined (fixed) | split n+1 | split batched |
|---|---|---|---|---|---|
| 1,000 | 100 | 1.15 ms | 0.43 ms | 3.54 ms (10 probes) | 0.95 ms |
| 1,000 | 10 | 2.41 ms | 0.40 ms | 5.12 ms (15 probes) | 1.33 ms |
| 1,000 | 1 | 58.84 ms | 1.29 ms | **300.94 ms** (1000 probes) | 2.07 ms |
| 10,000 | 100 | 10.21 ms | 0.37 ms | 3.42 ms (10 probes) | 0.72 ms |
| 10,000 | 10 | 17.55 ms | 0.40 ms | 4.17 ms (12 probes) | 4.46 ms |
| 10,000 | 1 | 96.87 ms | **0.47 ms** | 17.07 ms (52 probes) | 6.56 ms |

- **joined (today)** — a simplified form of the current query (LIMIT pushed down, no materialized CTE). It *understates* production: with the real `available` CTE the same shape costs **5,792 ms** at 10k streams (#1448).
- **joined (fixed)** — after #1448's fix: sargable source predicate plus a `(stream, id)` index. Essentially **flat at ~0.4 ms** across every stream count and hit rate.
- **split n+1** — candidates from the subscription store, one probe per candidate until the budget fills.
- **split batched** — the *optimistic bound*: one batched probe for all candidates. Only possible when both halves speak the same query language on the same host, which is precisely the deployment a split exists to avoid. Treat it as a floor nobody can actually reach, not as a design.

### What the numbers say

The premise "the join is cheap, so N+1 would be a regression" was **false when this RFC was opened** — today's join is 10–97 ms at 10k streams (5.8 s with the real CTE), which is *worse* than the split's N+1. That is what #1448 is about, and it is a bug in the join, not an argument for splitting.

Against the **fixed** join, which is the honest comparison:

- realistic sparse case (10k / 1%): **0.47 ms → 17.07 ms**, a **36x** regression
- worst measured (1k / 1%): **1.29 ms → 300.94 ms**, a **233x** regression
- even the unreachable batched bound is **2–14x** worse

And the split's cost *grows as the system gets healthier*: the fewer streams with pending work, the further it must walk to fill its budget. The fixed join is flat because the database stops at the budget.

## Pros and cons

**For a split**

- Different storage economics per half. Leases and watermarks are hot, small, and disposable; events are cold, large, and permanent. Putting leases on Redis is a real cost/latency argument.
- Blast-radius isolation: a subscription-store outage stops reactions but not commits.
- Cleaner conceptual boundary — an event store genuinely is a different thing from a work queue, and the `EventSource`/`EventSink` split is precedent that the codebase tolerates this kind of seam.
- Third-party adapters could implement one half without the other, lowering the bar to contribute.

**Against**

- **The claim regression above.** 36x on the realistic case, and it worsens as the workload quiets down.
- **Distributed `truncate`.** Solvable, but it converts an atomic operation into a protocol with its own failure modes and its own tests.
- **Two ports to keep in lockstep.** CLAUDE.md already requires that a port change ships with its TCK update in the same slice; two ports means two TCKs, two capability matrices, and a new combinatorial surface (adapter A × adapter B) that nothing currently tests.
- **`ActOptions.scoped` already requires store and cache together**, because sharing a cache across distinct stores collides on stream keys. A split store raises the same class of question for watermark/id space, with a bigger answer.
- **It buys nothing the alternatives don't**, per below.

## Alternatives

- **Fix `claim` and keep one port (#1448).** Sargable source predicate + `(stream, id)` index takes 10k-stream claims from 5,792 ms to 6.6 ms. This is the actual win people are reaching for when they propose splitting, and it costs one index and one query branch.
- **`ActOptions.scoped`** — already shipped. Per-Act store+cache pairs for multi-tenant, parallel test workers, hybrid storage. Splits *vertically* (whole stores by domain), which keeps `claim` local.
- **The [split-stores recipe](../recipes/scaling/split-stores/README.md)** — split by bounded context or tenant when the shared total order is the thing you're paying for. Same vertical shape.
- **`act-notify`** — already lifts the LISTEN/NOTIFY fanout ceiling by riding an external broker for cross-process wakeups *without* touching durability. Precedent for the pattern that actually works here: decorate the one store, don't bisect the port.

## Recommendation (original, as posed)

**Do not split.** Land #1448 instead.

The split's motivating benefit — a faster, cheaper subscription tier — is almost entirely recovered by fixing the join, and the fixed join is 36x faster than the best realistic split on the case that matters. The costs are permanent and land on the hottest path in the framework, while the benefits are available today from `scoped`, the split-stores recipe, and `act-notify`.

Revisit only with a workload where the *events* half is the constraint in a way the subscription half is not — for example an append-only archival store on object storage with leases in Postgres. That is a genuinely different shape from "make claim faster", and it would want its own numbers.

## Reframing: what if `claim` never asked the event log?

The analysis above takes the pull model as given: the subscription side *asks*
the event log "who has work?", which needs the join, which is what the split
cannot do. That framing was too narrow.

If the subscription side is **told** instead of asking — a durable work set it
owns — then `claim` reads only its own store, the join disappears, and the
hard blocker with it.

### #1448 landed, and left the interesting half standing

The claim fix (#1448, merged as a sargable source-class split plus a partial
`(stream, id)` index) took 10k-stream claims from **22,345 ms to 12.65 ms**.
That fixed the *per-probe* cost. It did not fix the *probe count*: `available`
is still materialized with no `LIMIT`, so the work is still O(subscribed
streams), which is the residual slope from 12.65 ms at 10k to 26.41 ms at 20k.

A work set removes that term outright — `claim` becomes O(lease budget),
independent of how many streams are subscribed. **That is a single-store win.
It does not require, or presuppose, a split.**

### Who produces the set

Not `commit`. Enqueueing transactionally with every commit is a distributed
transaction on the hottest path in the system — far worse than the `truncate`
one, which is at least low-cadence. Enqueueing non-transactionally loses
signals, and a lost signal stalls a stream forever unless a pull remains as
backstop — which puts the join right back.

**`correlate` is already the producer.** It owns a durable checkpoint, scans
events forward from it, and calls `subscribe` — an idempotent UPSERT — for the
targets it discovers. Recording "target T has work up to id N" is the same
shape on the same data it is already reading.

That makes the two-store interaction a **pipeline, not a transaction**: read
from the event store at a checkpoint, write to the subscription store
idempotently. The classic at-least-once shape, no distributed commit, and
self-healing by construction — a lost or corrupt work set is rebuilt by
rewinding the checkpoint, which `correlate` already does on cold start via its
`BACK_SCAN` floor.

### What it would cost

- **New durable structure and the port methods to maintain it** — public
  surface, so its own RFC and TCK cases.
- **`correlate` must always run.** Today it early-returns for apps whose
  reactions are all static (`correlate_probes_store === false`). It would
  become the universal producer. Probably net-positive — it replaces the
  per-claim probe with one forward scan — but it is a real behavior change and
  needs its own numbers.
- **Stale entries are tolerable but not free.** An entry whose work was
  already consumed costs a wasted lease, an empty fetch and an ack.
  Self-correcting, and cheap relative to what it replaces.
- **Ordering is unaffected.** Priority, the fairness reserve, and `at`-order
  are all subscription-side already; they would order the work set instead of
  the joined result.

### What it does to the split

Every blocker in this RFC changes category:

| Blocker | Under the work set |
|---|---|
| `claim` is a join | Gone — claim reads the subscription store only |
| `streams.at` is the other store's id | Still true, but only `correlate` interprets ids; the subscription store treats them as opaque |
| `truncate` spans both | Unchanged — still needs a resumable two-phase protocol, still tractable |

So the split stops being blocked by the thing that made it a bad idea. It does
not thereby become a good one: it still buys a deployment option, and it still
costs a second port, a second TCK, and an untested adapter × adapter matrix.

## Recommendation (revised)

1. **Prototype the subscription-side work set for the single store, and
   measure it.** The bar is the #1448 numbers: does `claim` go flat with
   subscribed-stream count, and what does the always-on `correlate` cost an
   app with only static reactions? This is worth doing whether or not anyone
   ever splits the port.
2. **Revisit the split afterwards**, on its own merits, with the join no
   longer part of the argument. It should be judged then as "is a second port
   worth the deployment flexibility", which is a much smaller question than
   the one this RFC opened with.
3. **Do not split now.** Nothing in the measurements supports paying the N+1
   cost against today's claim path.

The original recommendation — land #1448, keep one port — was right for the
question as posed. The question was the wrong one: the pull model was the
constraint, not the port boundary.

## Public surface

None proposed by this RFC. The work set in § Reframing *would* add public
surface (a durable structure plus the port methods that maintain it) and needs
its own RFC before any code.

Recorded here so the question is not re-litigated from first principles. If it
is reopened, start from the measurements rather than from the intuition that a
join is obviously cheaper than N+1 — before #1448 it was not, by three orders
of magnitude.
