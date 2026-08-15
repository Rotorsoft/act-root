# RFC 1449: a subscription-side work set, and the store split it enables

- **Status:** draft
- **Issue:** #1449
- **Author:** Rotorsoft
- **Created:** 2026-08-10

## Motivation

`Store` does two jobs with different physics:

| Event log | Subscription / lease bookkeeping |
|---|---|
| append-only, id-ordered, permanent, large, cold | mutable in place, hot, small, disposable |
| `commit`, `query`, `query_stats`, `scan`/`restore`, `forget_pii`, `notify` | `subscribe`, `claim`, `ack`, `block`, `unblock`, `defer`, `prioritize`, `reset`, `query_streams` |

One question welds them together, on the hottest path in the framework:

> **Which subscribed streams have unconsumed work?**

Today the subscription side *asks the event log*: `streams.at` is an id minted by the log, and `claim` probes the log per subscription row for anything past it. That join is why `claim` does not scale, and separately why the two halves cannot be separated.

**The proposal is to stop asking.** If the subscription side is *told* what has work, the join disappears, `claim` becomes O(lease budget), and the split becomes a packaging decision rather than a blocked one.

### The costs today

**Postgres — the probe count is O(eligible streams).** `available` is materialized with no `LIMIT` and referenced four times, so the `EXISTS` probe runs for every eligible row before `lag`/`lead` apply their limits. After #1448 fixed the per-probe cost, the residual slope is ~1.4 µs per subscribed stream, per claim, per worker:

| subscribed streams | before #1448 | after #1448 |
|---|---|---|
| 5,000 | 5,355 ms | 7.6 ms |
| 10,000 | 22,346 ms | 12.7 ms |
| 20,000 | did not complete | 26.4 ms |

Extrapolated: ~130 ms per claim at 100k streams, ~1.3 s at 1M. For the per-aggregate reaction shape (`.to(e => ({target: e.stream}))`), subscribed streams *equals* aggregate count.

**SQLite — an N+1 inside the writer lock, with no path to an index fix.** `claim` selects every eligible stream with no limit, then runs one `SELECT 1 FROM events … LIMIT 1` per candidate in a JavaScript loop, with no early exit. #1448's fix does not port: the probe is in JS, not SQL, so there is no planner to make sargable.

**The signal already exists and is discarded three times.** `commit` returns committed events with ids. `notify` delivers `{stream, events:[{id,name}]}` per commit and is used purely as a wakeup. `correlate` walks events forward and resolves each to its target streams — recording the target, discarding the id at which the work was found. `claim` then reconstructs, by brute force against the log, what the system computed microseconds earlier.

## Proposed architecture

### 1. A `correlated` mark on the subscription row

One nullable `bigint`, `streams.correlated`: *correlate has observed an event at id N that resolves to this target*. Eligibility becomes a pure subscription-table predicate:

```sql
WHERE blocked = false
  AND (leased_by IS NULL OR leased_until <= NOW())
  AND (deferred_at IS NULL OR deferred_at <= NOW())
  AND at < correlated
```

`at < correlated` is a valid partial-index predicate — immutable, single-row, no cross-row reference — so **the correlated set is an index**:

```sql
CREATE INDEX act_streams_correlated_ix
  ON <schema>.<table>_streams (lane, priority DESC, at)
  WHERE blocked = false AND at < correlated;
```

It contains only streams with work. `LIMIT` pushes into it. A stream leaves when `ack` advances `at` to `correlated`, and re-enters when correlate raises `correlated`. `claim` becomes an index scan of at most `lagging + leading` rows: **O(budget), independent of subscribed-stream count**, on both adapters. SQLite's probe loop and its writer-lock occupancy are deleted outright.

### 2. `correlate` is the producer

Correlate already walks events forward, already resolves each event to its targets, and already calls `subscribe` — an idempotent UPSERT — for what it finds. It records the frontier through that same call: `correlated = GREATEST(correlated, N)`.

It has to be correlate rather than `commit`, for a reason that is structural rather than performance-related: **the store cannot compute the target.** `reaction.resolver(event)` is arbitrary user code, so only the orchestrator can resolve one. And resolving orchestrator-side *at commit time* misses every event not written through this process's `app.do` — a remote writer, a direct `store().commit`, a `restore`, a replay. Correlate is the only component that sees every event regardless of who wrote it.

`notify` remains the trigger and never the producer: it is documented best-effort (payloads are capped, and the adapter falls back to polling when a commit does not fit), and a producer allowed to drop signals needs a pull backstop, which reinstates the join. The existing chain — `notify` → `settle.schedule()` → `correlate` → `drain` — already routes correctly, so **no orchestration changes are required**.

### 3. The split, once the join is gone

With `claim` reading only its own tables, `Store` divides cleanly:

- **`EventStore`** — `commit`, `query`, `query_stats`, `scan`/`restore`, `forget_pii`, `notify`
- **`SubscriptionStore`** — `subscribe`, `claim`, `ack`, `block`, `unblock`, `defer`, `prioritize`, `reset`, `query_streams`

`correlate` is the only component holding both, and it is a **pipeline, not a distributed transaction**: read from the event store at a checkpoint, write to the subscription store idempotently. `streams.at` and `correlated` stay event-store ids, but the subscription store only ever *compares* them — the opaque-monotonic-token property Kafka offsets and Axon tracking tokens have.

`truncate` remains the one genuinely cross-store operation and needs a resumable two-phase protocol. Tractable: close is low-cadence and #1389 already made an interrupted close resumable.

**Build this only on demand.** It buys a deployment option and no performance that step 1 has not already delivered, at the cost of a second port, a second TCK, and an untested adapter × adapter matrix.

### Prerequisite — shipped, with one half deferred

**The correlate checkpoint is now durable** ([#1493](https://github.com/Rotorsoft/act-root/pull/1493)). It was `private _checkpoint = -1` in process memory, recovered on cold start from the subscription watermark minus a 10k back-scan — a heuristic, and a resume point derived from precisely the coupling the split is meant to break. It now lives in its own single-row relation per scope, read from `subscribe`'s return and advanced by `ack`, so maintaining it costs no store round trip of its own.

**Single-writer was deliberately not built.** Mutual exclusion needs a step where exactly one correlator wins, which is a store call of its own — the opposite of riding operations the pipeline already performs. So N workers still scan the same range. This is better than the status quo it replaced (each worker had its *own* in-memory floor, arbitrarily far behind, so they scanned *different and larger* ranges), and worth revisiting only if a measurement shows duplicate correlate scans cost something. RFC 1449's own numbers put the win in `claim`, not correlate.

Two designs were built and rejected on evidence along the way — a reserved subscription row (it miscounts six operator surfaces; `prioritize` returned 2 where the answer was 1) and deriving the floor from `MAX(correlated)` (it livelocks past a reaction-less run longer than the scan's page limit). Both are recorded in [RFC 1484](./1484-correlate-checkpoint.md) so they are not re-proposed.

**Ruled out as a prerequisite (verified, #1483):** an earlier draft claimed a stale mark could stall a stream into blocking, because an all-empty cycle cannot advance the watermark and `claim` bumps `retry` on every re-acquisition. It cannot: the cycle still *acks* an empty-payload result, and a successful ack resets `retry`. The related watermark jump — an empty-fetch stream fast-forwarding to the cycle's window max, past its own unhandled events — is reproducible only by fault injection, because in both the pull model and the mark model an empty fetch means there is genuinely no work to skip. The `fetch_window_at` fallback stays load-bearing for settle convergence.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Commit-side dirty set (outbox) | The store cannot resolve user-code targets, and commit-time resolution misses every non-local writer. Also write amplification on the hottest path, and two commits resolving to one target serialize on one row. |
| `notify` carries the routing | A documented best-effort channel cannot be the sole producer without a pull backstop, which reinstates the join. |
| In-memory hot set fed by `notify` | Per-process, lost on restart, and the O(N) probe remains as the backstop — a mitigation, not a fix. |
| Bucket/partition the streams table | Constant-factor only, and requires static worker→bucket assignment, surrendering the assignment-free elasticity `SKIP LOCKED` provides. |
| Split the port first | Pays a second port, second TCK, and an adapter × adapter matrix for a deployment option, buying no performance the mark does not already deliver. |

## Steps

Each step ships independently and is valuable on its own.

| # | Step | Ships alone | Notes |
|---|---|---|---|
| 0 | **Benchmarks.** Extend `claim-scale.bench.mjs` to 50k/100k; write the missing act-sqlite equivalent. Record both in the respective `PERFORMANCE.md`. | scripts + docs | Establishes the bar; SQLite is expected to produce the headline number. |
| 1 | **Durable correlate checkpoint** — ✅ shipped in [#1493](https://github.com/Rotorsoft/act-root/pull/1493). Its own single-row relation per scope; read from `subscribe`'s return, advanced by `ack`, so it costs no round trip of its own. | restart resumes exactly | Single-writer was deliberately dropped — see below. |
| 2 | **RFC for the work set** — ✅ [`rfcs/1486-subscription-work-set.md`](./1486-subscription-work-set.md). | docs | Gates the public surface; settles the three open questions below. |
| 3 | **`correlated` column + partial index + `subscribe({correlated})`** on PG, SQLite, InMemory, with TCK cases and the `correlated IS NULL` legacy arm. | dark — no behavior change | The bulk of the work. |
| 4 | **Correlate becomes the universal producer** — resolves static targets too, no longer early-returns for static-only apps, records `correlated`. | behavior change | Needs the static-only-app cost numbers from step 0. |
| 5 | **Delete the legacy probe arm** + add an opt-in reconciliation sweep. | payoff | `claim` stops touching the event log on both adapters. |
| 6 | *(demand-gated)* **Split the port** — `EventStore` + `SubscriptionStore`, resumable two-phase `truncate`, second TCK. | | Judged then as "is a second port worth the deployment flexibility". |

### Migration

The column lands via the established `ADD COLUMN IF NOT EXISTS` pattern already used for `priority`, `lane`, and `deferred_at` — consistent with seed-sync being the schema story.

Bootstrapping existing rows is the real sub-decision. Backfilling `correlated = MAX(id)` makes every stream look pending at once and drains the whole table through empty fetches. A full correlate replay from `-1` is correct but unbounded at startup. The workable answer is **`correlated IS NULL` means "unknown — use the legacy probe"**: today's `EXISTS` arms stay as a gated branch, old rows behave exactly as they do now, and every row correlate touches migrates to the fast arm permanently. The legacy arm is deleted in step 5, once an opt-in reconciliation sweep has covered the tail.

### Acceptance criteria

Benchmarks run on real adapters only (act-pg on docker :5431, act-sqlite); InMemory may appear as a reference row, never as the primary number.

1. **Claim time flat in subscribed-stream count** across 1k/10k/100k streams × 1%/10%/100% hit rate, on both adapters. This is the headline criterion.
2. **No regression for a static-only app** from always-on correlate — the one place this design can cost someone.
3. **N-worker contention** at 2/4/8 workers: aggregate claim throughput, correlated-index churn under sustained commit load, and correlate write contention with and without step 1's leased checkpoint.
4. **Commit path flat** — the design does not touch `commit`; verify empirically.
5. `store-split-claim.bench.mjs` re-run against the mark rather than the joined baseline, so step 6 is decided on new numbers.

Benchmark construction: assign event ids in randomized order so a stream's watermark lands at a random point in the global sequence. Seeding version-by-version, or modelling has-work as `at = -1`, sorts every pending stream to the front of `ORDER BY at ASC` and understates the cost by orders of magnitude.

## Public surface added

One optional field on an existing port method:

```ts
Store.subscribe(streams: { stream, source?, priority?, lane?, correlated? }[])
```

No new port, no new method, no new table. `subscribe` is already the idempotent UPSERT called from the right place, which keeps "record the target" and "record its frontier" in one statement.

## Stability / charter impact

- **Additive, MINOR** — `Store.subscribe`'s input type gains an optional field. Existing adapters compile and pass unchanged.
- **Semantic change with no type diff** — `claim`'s rule moves from "claimable iff the log holds an event past the watermark" to "claimable iff the subscription store holds a mark". Exactly the category the charter exists to catch and a type diff will not surface. It also settles #1446 by making the rule definitional.
- **TCK, in the same PR as the port change** (per CLAUDE.md), against all three in-tree adapters: mark-then-claim; mark monotonicity (`GREATEST`, never regresses); a stream with no mark is not claimable; `ack` to `correlated` removes the stream from the claimable set and a later higher mark re-adds it; stale-mark self-heal (depends on step 1); `reset` / `unblock` / `defer` / `prioritize` interaction with the mark; the legacy `correlated IS NULL` arm while it exists.
- **Docs, same PR:** `concurrency-model.md`, `correlation-and-drain.md`, `extension-points.md` (method list *and* semantics), `priority-lanes.md` (ordering now applies over the correlated set), `guides/writing-a-store.md`, plus behavior-contract rows for every runtime claim added.
- **RFC required for step 3** — the public surface addition gets its own RFC per step 3.

## Open questions

1. Does `correlated` belong on the subscription row (step 1) or in its own relation from the start? A separate `streams_correlated(stream, at)` table is the same semantics with a physical seam, making step 6 a repackaging rather than a migration. It costs a join on the claim path today for flexibility that may never be exercised.
2. What is the reconciliation sweep's trigger in step 5 — operator-invoked, periodic, or on cold start only?
3. Should a stream with no mark ever be claimable? Making it definitionally not-claimable settles #1446, but forecloses "claim everything once at boot" as a recovery tool.
