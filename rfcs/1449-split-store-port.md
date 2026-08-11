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

*Superseded by § Recommendation (revised) below — kept because the reasoning
still holds for the question as it was asked.*

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

### #1448 fixes the constant factor, and leaves the interesting half standing

The claim fix (#1448 — a sargable source-class split plus a partial
`(stream, id)` index, merged as PR #1451) takes 10k-stream claims from
**22,345 ms to 12.65 ms**. That fixes the *per-probe* cost. It did not fix the *probe count*: `available`
is still materialized with no `LIMIT` and referenced four times, so the
`EXISTS` probe runs for every eligible row before `lag`/`lead` apply their
limits. The work is still O(subscribed streams), which is the residual slope
from 12.65 ms at 10k to 26.41 ms at 20k — about **1.4 µs per subscribed
stream, per claim, per worker**. Extrapolated, that is ~130 ms per claim at
100k streams and ~1.3 s at 1M. For the per-aggregate reaction shape
(`.to(e => ({ target: e.stream }))`), subscribed streams *equals* aggregate
count, so this is a scaling wall on the framework's most common topology.

A work set removes that term outright — `claim` becomes O(lease budget),
independent of how many streams are subscribed. **That is a single-store win.
It does not require, or presuppose, a split.**

### SQLite is the decisive case, and #1448's fix cannot reach it

`sqlite-store.ts` `claim` opens `transaction("write")`, selects **every**
eligible stream with no limit, then runs one `SELECT 1 FROM events … LIMIT 1`
**per candidate in a JavaScript loop**, with no early exit once
`lagging + leading` candidates are found.

Three problems compound. It is a literal N+1 — the exact cost model this RFC
measured and rejected for the split, already shipping in an in-tree adapter.
The loop runs inside the single writer lock, so at 10k streams a claim
serializes ~10k round-trips against every concurrent `commit`. And #1448's fix
does not port: the probe is in JS, not SQL, so there is no planner to make
sargable. **Under the pull model SQLite has no path to a fix at all**, which
is the strongest argument in this document for changing the model rather than
optimizing it further.

There is no `claim-scale` benchmark for act-sqlite today. There should be, and
it is likely to be the headline number of the whole effort.

### Who produces the set

Not `commit`. Enqueueing transactionally with every commit is a distributed
transaction on the hottest path in the system — far worse than the `truncate`
one, which is at least low-cadence. Enqueueing non-transactionally loses
signals, and a lost signal stalls a stream forever unless a pull remains as
backstop — which puts the join right back.

**`correlate` is already the producer.** It scans events forward from a
checkpoint and calls `subscribe` — an idempotent UPSERT — for the targets it
discovers. Recording "target T has work up to id N" is the same shape on the
same data it is already reading.

The decisive reason is stronger than transaction cost, and worth stating
plainly because it rules out the outbox pattern permanently: **the store
cannot compute the target.** `reaction.resolver(event)` is arbitrary user code
in the registry, so only the orchestrator can resolve an event to its targets.
And orchestrator-side resolution *at commit time* still misses every event
that does not flow through this process's `app.do` — a remote writer, a direct
`store().commit`, a `restore`, a replay. `correlate` is the only component
that sees every event regardless of who wrote it.

**Correction to an earlier draft of this section:** it claimed correlate
"owns a durable checkpoint". It does not. `correlate-cycle.ts` holds
`private _checkpoint = -1` in memory, recovered on cold start from
`subscribe()`'s returned watermark minus `DEFAULT_COLD_START_BACK_SCAN`
(10,000). Three consequences follow, and they change the plan rather than the
conclusion. Under N workers there are N independent correlators, each scanning
the same event range and issuing the same UPSERTs, so correlation work is
duplicated N-fold today, uncoordinated and unmeasured. The resume point is
*derived from the subscription watermark*, which is precisely the coupling a
split is meant to break. And the 10k back-scan is a heuristic: a target more
than 10k events behind the global max is not re-derived on restart. Making the
checkpoint durable and single-writer-leased is therefore a **prerequisite
slice**, not an implementation detail — and it is worth shipping on its own
merits before any of this.

That makes the two-store interaction a **pipeline, not a transaction**: read
from the event store at a checkpoint, write to the subscription store
idempotently. The classic at-least-once shape, no distributed commit, and
self-healing by construction — a lost or corrupt work set is rebuilt by
rewinding the checkpoint, which `correlate` already does on cold start via its
`BACK_SCAN` floor.

### What everyone else does

| System | How it answers "who has work?" | What it pays |
|---|---|---|
| **EventStoreDB** persistent subscriptions | Doesn't ask. A server-side process reads forward and *pushes* into a per-group buffer; consumers ack by event number. | The subscription is a process, not a query. Checkpoint per group. |
| **Marten** async daemon | A high-water-mark detector finds the max contiguous sequence; each shard reads its own range forward from one progression row. One forward scan drives every projection. | A dedicated daemon; the detector must handle sequence gaps from in-flight transactions. |
| **Kafka** consumer groups | `log_end_offset > committed_offset`, O(1) per partition. | The key space collapses to a fixed partition count. You can never ask this per key. Rebalancing is a distributed protocol. |
| **Postgres logical replication** | One WAL sender walks forward once and routes; the slot holds one LSN. | Single reader; slot retention pins WAL. |
| **Debezium outbox** | The *writer* materializes the dirty set in the same transaction. | Write amplification on the hot path, and the producer must know the routing. |
| **Axon** tracking tokens | One token per *processor*, not per aggregate. | No per-aggregate isolation — a poison aggregate stalls the processor. |
| **NATS JetStream** | Per-consumer ack floor vs stream last-sequence, plus an in-memory pending map. | Pending state is memory-resident, rebuilt on restart. |

Every one of these either walks the log once with a single cursor and fans
out, or has the writer materialize the dirty set, or shrinks the key space to
a handful of partitions. **Nobody asks "which of my N keys have work?" per
key.** Act is the outlier.

What Act does that none of them do, and should keep, is maintain per-target
state: lease, retry budget, blocking, priority, lane, ordering. That is more
expressive than a Kafka partition or an Axon token, and it is why a poison
aggregate blocks one stream here instead of an entire processor. The mistake
is not the per-stream watermark. **The mistake is using the per-stream
watermark as the *discovery* mechanism.**

### The shape: a `pending` mark on the subscription row

One nullable `bigint` column, `streams.pending`, meaning *correlate has
observed an event at id N that resolves to this target*. Correlate records it
through the `subscribe` UPSERT it already issues, as
`pending = GREATEST(pending, N)`. Eligibility becomes a pure
subscription-table predicate:

```sql
WHERE blocked = false
  AND (leased_by IS NULL OR leased_until <= NOW())
  AND (deferred_at IS NULL OR deferred_at <= NOW())
  AND at < pending
```

`at < pending` is a valid partial-index predicate — immutable, single-row, no
cross-row reference — so the pending set *is* an index:

```sql
CREATE INDEX act_streams_pending_ix
  ON <schema>.<table>_streams (lane, priority DESC, at)
  WHERE blocked = false AND at < pending;
```

It contains only streams with work. `LIMIT` pushes straight into it. A stream
leaves when `ack` advances `at` to `pending` and re-enters when correlate
raises `pending`. `claim` becomes an index scan of at most
`lagging + leading` rows: **O(budget), independent of subscribed-stream
count.** SQLite gets the identical fix, and its N+1 loop and writer-lock
occupancy are deleted outright.

**The public surface is one optional field.** `Store.subscribe` already takes
`{stream, source?, priority?, lane?}` and is already the idempotent UPSERT
called from the right place; it gains `pending?: number`. No new port, no new
method, no new table. That is the smallest surface that expresses the change,
and it keeps "record the target" and "record its frontier" in one statement.

**Migration.** The column lands via the established
`ADD COLUMN IF NOT EXISTS` pattern used for `priority`, `lane`, and
`deferred_at`, consistent with seed-sync being the schema story. Bootstrapping
existing rows is the real sub-decision. Backfilling `pending = MAX(id)` makes
every stream look pending at once and drains the whole table through empty
fetches. A full correlate replay from `-1` is correct but unbounded at
startup. The workable answer is that **`pending IS NULL` means "unknown — use
the legacy probe"**: today's `EXISTS` arms stay as a gated branch, old rows
behave exactly as they do now, and every row correlate touches migrates to the
fast arm permanently. The legacy arm is deleted in a later slice, once an
opt-in reconciliation sweep has covered the tail.

### What it would cost

- **`correlate` must always run.** Today it early-returns when no reaction has
  a dynamic resolver (`correlate-cycle.ts`: `if (!this._has_dynamic_resolvers)
  return …`). It would become the universal producer, resolving static targets
  too. Probably net-positive — one forward scan replaces the per-claim probe —
  but it is a real behavior change for static-only apps and needs its own
  numbers. This is the one place the design can *regress* someone.
- **A stale mark is not self-correcting, and this must be fixed first.** An
  earlier draft called stale entries self-correcting. In the current code they
  are not. `drain-cycle.ts` computes
  `const at = entry.fetch.events.at(-1)?.id || fetch_window_at`, where
  `fetch_window_at` is the max over the cycle's fetched entries. When *some*
  stream in the cycle fetched work, an empty-fetch stream fast-forwards to the
  window max and is fine. When the whole cycle comes back empty — exactly the
  all-stale-marks case — `fetch_window_at` collapses to the max of the leases'
  own `at`, so the stream does not advance, is re-claimed next cycle, and
  `claim` bumps `retry` on every acquisition until `budget_exhausted` blocks
  it. Narrower than "any empty fetch", and still a stall-then-block. It is a
  latent bug worth fixing on its own merits, and a hard prerequisite here.
- **N-way write contention on the mark.** N uncoordinated correlators write
  the same `pending` values. This is a today-problem the design makes visible
  rather than one it creates; the answer is the durable leased checkpoint,
  which is why that slice comes first.
- **Btree churn on the pending index** as streams enter and leave under
  sustained commit load. Unknown, and measurable.
- **Ordering is unaffected.** Priority, the fairness reserve, and `at`-order
  are all subscription-side already; they would order the pending set instead
  of the joined result.

It also settles **#1446** — adapters disagree on whether a fresh `at = -1`
subscription with no events is claimable — by making the rule definitional:
claimable iff the subscription store holds a mark saying so. That ambiguity
exists today precisely because "has work" is inferred rather than stated.

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

**Ship the pending mark. Treat the split as a later, demand-gated
repackaging of it. Do not split now.**

The mark is the only candidate that fixes SQLite, whose claim is an N+1 inside
the writer lock with no path to an index-based fix. It removes the
O(subscribed streams) term outright rather than shaving its constant. It costs
one optional field on an existing port method, and no orchestration changes at
all — the `notify` → `settle` → `correlate` → `drain` chain already routes
correctly, because `notify` is already the trigger and correlate already the
scanner. And it makes the split *possible* without doing the split, which is
the honest resolution of this RFC: **the port boundary was never the
constraint; the pull model was.**

Rejected along the way, one line each. *Commit-side dirty set* — the store
cannot resolve user-code targets, and commit-time resolution misses every
non-local writer. *Notify-carried routing* — a documented best-effort channel
cannot be the sole producer without a pull backstop, which reinstates the
join. *In-memory hot set fed by notify* — per-process, lost on restart, keeps
the O(N) fallback; a mitigation, not a fix. *Bucketing the streams table
Kafka-style* — a constant-factor win that requires static worker-to-bucket
assignment, surrendering the assignment-free elasticity `SKIP LOCKED` gives
Act today. *Splitting the port now* — pays a second port, a second TCK, and an
adapter × adapter matrix for a deployment option, buying no performance the
mark does not already deliver.

### Slice plan

Each slice ships on its own.

| # | Slice | Notes |
|---|---|---|
| 0 | **Benchmarks first.** Extend `claim-scale.bench.mjs` to 50k/100k; **write the missing act-sqlite claim-scale bench**. Record both in the respective `PERFORMANCE.md`. | Establishes the bar; likely the headline number. |
| 1 | **Fix the empty-fetch no-advance hazard** + TCK case + behavior-contract row. | Latent bug today. Hard prerequisite. |
| 2 | **Durable, single-writer-leased correlate checkpoint.** Prefer a zero-surface home over a new column or table. | Deletes N-fold duplicate correlate scans. Measurable alone. |
| 3 | **RFC for the subscription work set.** | Gates the public surface; lands before any of slice 4. |
| 4 | **`pending` column + partial index + `subscribe({pending})`** across PG, SQLite, InMemory, with the `pending IS NULL` legacy arm and TCK cases. | Ships dark — no behavior change yet. |
| 5 | **Correlate becomes the universal producer** — resolves static resolvers, no longer early-returns, records `pending`. | The behavior change. Needs the static-app numbers. |
| 6 | **Delete the legacy probe arm** + opt-in reconciliation sweep. | The payoff: `claim` stops touching the event log. |
| 7 | *(demand-gated)* **Split the port.** | Judged then as "is a second port worth the deployment flexibility" — a much smaller question than this RFC opened with. |

### Benchmarks that decide it

On real adapters only (act-pg on docker :5431, act-sqlite); InMemory may
appear as a reference row, never as the primary number. PG claim-scale to
100k to pin the slope. SQLite claim-scale from 100 to 10k, which does not
exist today. The prototype across 1k/10k/100k streams × 1%/10%/100% hit rate,
with **claim time flat in stream count** as the success criterion. Always-on
correlate cost for a static-only app, the one place this can regress someone.
N-worker contention at 2/4/8 workers, covering aggregate claim throughput,
pending-index churn, and correlate write contention with and without the
leased checkpoint — the principal unknown. A commit-path regression check,
since the design does not touch `commit` and that should be visible in
numbers. And a re-run of `store-split-claim.bench.mjs` against the mark rather
than the joined baseline, so slice 7 is re-decided on new numbers.

**Modelling trap, restated because it was hit twice while producing the
numbers above:** assign event ids in randomized order so a stream's watermark
lands at a random point in the global sequence. Seeding version-by-version, or
modelling has-work as `at = -1`, sorts every pending stream to the front of
`ORDER BY at ASC` and understates the cost by orders of magnitude.

The original recommendation — land #1448, keep one port — was right for the
question as posed. The question was the wrong one.

## Public surface

None proposed by this RFC. The pending mark adds one optional field to
`Store.subscribe`, which is **additive** on a charter-covered surface and gets
its own RFC (`rfcs/NNNN-subscription-work-set.md`) before any code, per slice
3.

One charter consequence deserves calling out because a type diff will not
surface it: `claim`'s *semantics* change from "claimable iff the log holds an
event past the watermark" to "claimable iff the subscription store holds a
mark". That is a **semantic change on a charter-covered surface with no type
change**, exactly the category the charter exists to catch.

Recorded here so the question is not re-litigated from first principles. If it
is reopened, start from the measurements rather than from the intuition that a
join is obviously cheaper than N+1 — before #1448 it was not, by three orders
of magnitude.
