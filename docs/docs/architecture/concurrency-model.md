---
id: concurrency-model
title: Concurrency model
---

# Concurrency model

Two distinct concurrency primitives, used at different layers for different problems. Conflating them is the most common source of confusion when reading the framework's source.

## The two primitives

| | **Optimistic concurrency** | **Stream leasing** |
|---|---|---|
| **Where** | `Store.commit` (writes) | `Store.claim` (reads-for-reactions) |
| **What it protects** | Stream version integrity | Reaction processing exclusivity |
| **Mechanism** | `expectedVersion` parameter | `FOR UPDATE SKIP LOCKED` row lock |
| **Caller's job on conflict** | Reload + retry the action | Nothing — the loser is silently skipped |
| **Detected by** | `ConcurrencyError` thrown | Empty `claim()` return for that stream |

Same store, same DB, but they don't interact. A stream can have a held reaction lease *and* successful commits at the same time — those are different rows in different operations.

## Optimistic concurrency — the writer's safety net

Action commits are append-only and version-checked. Each event in a stream has a `version` (0-indexed, monotonic per stream). A commit asserts "the current head version is X; append after that."

```
caller                  framework                   store
  │  app.do(...)            │                          │
  │ ──────────────────────► │                          │
  │                         │  load() → snapshot.event │
  │                         │  expectedVersion = ev?   │
  │                         │  reduce → emit events    │
  │                         │  store.commit(           │
  │                         │    stream, msgs, meta,   │
  │                         │    expectedVersion ──────────►   tx BEGIN
  │                         │  )                       │      SELECT max(version)
  │                         │                          │      if version != expectedVersion:
  │                         │                          │          throw ConcurrencyError
  │                         │                          │      INSERT events
  │                         │                          │      tx COMMIT
  │                         │  ◄──────────────────────────── return Committed[]
  │  ◄───────────────────── │
```

If two callers race on the same stream, only one wins. The loser sees `ConcurrencyError` with `expectedVersion` and `lastVersion` (the actual head). The standard remedy is per-action retry policy — `state.on(entry, { maxRetries, backoff? })` — which lets the orchestrator absorb the conflict and re-run from `load()`. See [`ActionOptions` in Error Handling](../concepts/error-handling.md#retry-pattern--per-action-policy).

### Two failure modes the framework handles

**Predictable**: caller's `expectedVersion` doesn't match. Framework throws `ConcurrencyError` from the version check.

**Subtle**: both transactions read the same max version, both pass the `expectedVersion` check, both try to INSERT at the same `(stream, version)` pair. The unique index catches the second INSERT — without explicit handling, this surfaces as an adapter-specific error (PG SQLSTATE `23505`), not `ConcurrencyError`. Callers retrying on the framework signal would silently lose the commit.

**Resolution** (in `PostgresStore.commit`): catch the SQLSTATE `23505` from INSERT and re-throw as `ConcurrencyError`. After the catch, both failure modes look the same to the caller, and the retry path is consistent. Documented in `commit.error.spec.ts` and exercised by the `same-stream` scenario in the Postgres stress harness.

### Reactions skip optimistic concurrency by design

Inside `action()`, when `reactingTo` is resolved (i.e., the action was triggered by a reaction handler), the **inferred** guard is not enforced:

```ts no-check
// internal/event-sourcing.ts, action()
reactingTo ? expectedVersion : expected
```

The reasoning: reactions are inherently asynchronous catch-up. By the time a reaction processes event N, the stream has likely advanced past N. Forcing a version check would convert ordinary catch-up into spurious retries. Stream leasing already serializes concurrent reactions on the same stream, so the version race doesn't matter.

Two boundaries keep that from becoming a licence to write unguarded.

**An `expectedVersion` the caller passed explicitly is still honored.** Only the version *inferred* from the loaded snapshot is skipped — dropping a guard someone asked for by name is silent data loss ([#1543](https://github.com/Rotorsoft/act-root/issues/1543)).

**The reaction context applies while the handler runs, and not after.** `reactingTo` also resolves from the ambient context, so it covers every dispatch a handler makes and not only those routed through the injected `app` ([#1541](https://github.com/Rotorsoft/act-root/issues/1541)). But work a handler merely *starts* — a debounce timer, a memoised connection, an un-awaited `settle()` — keeps that async frame long after the handler returns, and is not a reaction. It does not inherit the triggering event, so it neither carries that causation nor skips the guard. Without the boundary, an ordinary read-modify-write dispatched from a batching flush commits unguarded and silently loses an update ([#1562](https://github.com/Rotorsoft/act-root/issues/1562)).

## Stream leasing — the reader's exclusivity primitive

The drain pipeline polls for streams that have new events past their last-processed watermark, claims them via `FOR UPDATE SKIP LOCKED`, processes their events, then acks (releases the lease and advances the watermark) or blocks (marks the stream failed after exceeding retry budget).

**How a stream is found to have work** moved from *asking* to *being told* ([#1485](https://github.com/Rotorsoft/act-root/issues/1485), completed in [#1488](https://github.com/Rotorsoft/act-root/issues/1488)). `claim` used to probe the event log once per eligible subscription (`EXISTS (SELECT 1 FROM events WHERE id > at ...)`), which cost O(subscribed streams) per claim per worker regardless of how much work was pending. A subscription row carries a **work mark**, `correlated_at`: the highest event id observed to resolve to that target. A stream is claimable exactly while `at < correlated_at`, answered from the subscription row with no reference to the event log at all — `claim` no longer queries the events table. Measured on act-pg: 180 ms per claim at 100k subscribed streams before, 2.3 ms after, and flat across 1k/10k/100k.

A row with **no mark is not claimable**, definitionally — `NULL` means correlate has not spoken for it, not "go and look". Installs that predate the column get a mark at seed time, set to the log's head: an over-estimate meaning "worth one look", which the first drain replaces with an honest position. `correlate` is the only component entitled to write a mark, because it is the only one that sees every event and can apply a reaction's resolver to it; the store cannot, and `notify` is best-effort. It marks for **every** app since [#1487](https://github.com/Rotorsoft/act-root/issues/1487) — static resolvers included — so the pairing correlate→drain is the pipeline: a bare `drain()` claims only what a correlate has already marked.

One consequence is worth internalizing, because it changes what a watermark *means*. A subscription's `at` now advances only over events that resolve to that target, so a reader of two of a state's ten event types sits below the stream's head for good, with nothing pending. "Behind the head" and "has work" are different questions, and only the mark answers the second one.

```
worker A                  store                     worker B
  │  claim(by="A")             │                          │
  │ ─────────────────────────► │                          │
  │                            │  tx BEGIN                │
  │                            │  SELECT * FROM streams   │
  │                            │   WHERE leased_until<NOW │
  │                            │   FOR UPDATE             │
  │                            │   SKIP LOCKED            │
  │                            │  UPDATE leased_by='A'    │
  │                            │  tx COMMIT               │
  │  ◄──────────────────────── │                          │
  │  [streams 1, 3, 5]         │                          │
  │                            │   ◄──────────────────────  claim(by="B")
  │                            │  tx BEGIN                │
  │                            │  SELECT ... SKIP LOCKED  │
  │                            │  → returns 2, 4 (1,3,5   │
  │                            │   locked by A; skipped)  │
  │                            │  ────────────────────────►
  │                            │                          │  [streams 2, 4]
  │  process events for 1,3,5  │                          │  process events for 2,4
  │  ack(by="A")               │                          │  ack(by="B")
  │ ─────────────────────────► │  ◄────────────────────── │
```

`SKIP LOCKED` is the key: workers never block each other waiting for a lock. If a stream is held by another worker, the polling worker just gets the next available stream. Zero contention, no thundering herd. The trade-off is no fairness guarantees — a worker can repeatedly pick up the "easier" streams and leave the leased ones to time out — but in practice this is desirable (active workers stay active).

### Lease lifecycle

```
                   ┌───────────────────────┐
                   │ leased_by=NULL        │
                   │ at=last_acked_pos     │  ← steady state
                   └──────────┬────────────┘
                              │  claim()
                              ▼
                   ┌───────────────────────┐
                   │ leased_by='worker-X'  │
                   │ leased_until=NOW+lease│
                   └──────────┬────────────┘
                              │
              ┌──────── ack() ┼ block() ─────┐
              │               │              │
              ▼               ▼              ▼
        leased_by=NULL  leased_by=NULL  blocked=true
        at=new position at=last position retry_count++
        retry_count=0   retry_count++
                              │
                              │ (if retry_count > maxRetries
                              │  AND blockOnError)
                              ▼
                       set blocked=true
                       (no further claims)
```

Three "exits" from a leased state:

- **`ack`** — handler succeeded; advance the watermark to the last processed event ID, clear the lease, reset retry count.
- **`block`** — handler failed past the retry budget (or threw `NonRetryableError`); set `blocked=true`. The stream stays out of `claim()` results until something explicitly unblocks it. Use `app.unblock(input)` to resume from where the stream stopped (the common case — operator fixed the underlying issue), or `app.reset(input)` to rebuild from event 0 (projection rebuild, rare). Both accept either a `string[]` of stream names or a `StreamFilter` (`{ stream?, source?, blocked? }`) for bulk operations — e.g., `app.unblock({ stream: "^webhooks-out-" })` to clear a whole family at once, or `app.unblock({})` for a post-incident "unblock everything blocked" sweep.
- **Timeout** — worker died or hung; `leased_until` passes; the next `claim()` from any worker can acquire the stream. The reclaim **counts against the retry budget**: every `claim()` increments the stream's retry counter and only `ack` resets it, so a stream whose workers keep dying marches toward `blockOnError` exactly like one whose handlers keep throwing. That is the safe default — repeated worker deaths on one stream are poison-adjacent (the events themselves may be what kills the worker), and quarantining beats an infinite crash loop. A claim the *store* ate — a cycle that threw before it could write anything back — is refunded instead, since no worker ever ran the handler (see [When the store, not the handler, spent the claim](#when-the-store-not-the-handler-spent-the-claim)). The timed-out worker may in fact have processed the events and only failed to ack; at-least-once delivery already requires handlers to tolerate that replay, and a successful re-run acks and resets the counter.

### Why a stream stays in `claim()` after a partial handler failure

If a reaction handler throws, the framework `block`s the lease *only if* `retry_count > maxRetries && blockOnError`. Otherwise it just releases without advancing the watermark. The next `claim()` cycle picks the stream up again — same events, fresh handler invocation, retry count incremented. Bounded retries with backoff are configured per-reaction via `ReactionOptions`.

## How the two interact

A common confusion: "If I commit while another worker holds a lease, does my commit fail?"

**No.** Stream leasing locks the row in the `streams` table (which tracks reaction watermarks). Commits write to the `events` table and check the `(stream, version)` index. Different rows, different locks. A commit and a reaction lease can be active on the same stream concurrently.

Real interaction surfaces in the close-the-books flow ([Close cycle](./close-cycle)), where the close operation must coordinate both: tombstone the stream (write a guard event via `commit`), then verify no leases are held (lease lifecycle).

## Commit visibility ordering — closing the id gap

Every watermark consumer — correlate's forward scan, which is what raises the work mark, fetch's `after`, and the correlate checkpoint — assumes that event ids become **visible in id order**. Postgres does not give you that for free: a serial `id` is assigned at INSERT time but the row appears at COMMIT time, so two concurrent commits to *different* streams can surface out of order. A reader that acks past the higher id would then permanently skip the lower one when it finally appears — the classic event-store "gap problem". Same-stream commits were never exposed (the `(stream, version)` unique index serializes them); source-less projections and multi-stream reactions were.

`PostgresStore` closes the gap on the append path (#1178): `commit()` and `truncate()` take a transaction-scoped `pg_advisory_xact_lock` keyed on the events table before assigning ids, released at COMMIT — id assignment and visibility are linearized, and the out-of-order interleaving is impossible by construction. The cost lands on concurrent cross-stream commit throughput (measured in `libs/act-pg/PERFORMANCE.md` § #1178); the ceiling stays well above the framework's realistic drain-inclusive pipeline rate, and correctness of the at-least-once guarantee is not a knob. InMemory is synchronous (no gap to close); SQLite is single-writer (same).

## Observability

Both primitives surface in the trace breadcrumb stream:

- Optimistic concurrency: `ConcurrencyError` thrown to caller; the framework logs nothing extra (caller decides what to log)
- Lease lifecycle: `>> claimed`, `>> acked`, `>> blocked` traces from `internal/drain-cycle.ts` decorators

- Dropped acks: when a worker's lease is taken mid-handler, `Store.ack` confirms fewer entries than were submitted — the guard is `WHERE leased_by = by`, which is what stops an evicted holder from regressing a watermark a competitor advanced. The drain logs the difference ([#1418](https://github.com/Rotorsoft/act-root/issues/1418)). The work itself is redelivered under the at-least-once contract, so an occasional line is benign; a persistent stream of them means `leaseMillis` is sized below the handler's real duration.

For a stuck stream, query `store.query_streams` directly — it returns the per-stream `at`, `retry`, `blocked`, and `leased_by/leased_until` without taking a lease. The act-inspector tool is built on this primitive.

### When every attempt loses its lease

The retry budget is an *error* budget: `blockOnError` is consulted on the failure path, so a handler that never throws never spends it. A handler that fails only by overrunning its lease does exactly that — it completes, submits an ack the store drops, and the next claim bumps `retry` again. Left alone, `retry` climbs without bound, the watermark never advances, and the side effect re-runs on every round, which is the one outcome `blockOnError` exists to prevent.

The drain therefore checks the budget once more where it can still act on it: at claim time, holding the lease, before dispatching. A stream that arrives with `retry` **strictly greater** than `maxRetries` is blocked without running the handler.

Strictly greater, not `>=`, and the difference matters. A stream legitimately reaches `retry === maxRetries` on its final attempt, and that attempt is entitled to run — it blocks only if it fails again. Arriving *past* the budget is only possible when no attempt ever produced an error, which means the lease was lost every single round. That is the stuck stream and nothing else. Recovery is the ordinary one: raise `leaseMillis` for that handler, then `app.unblock`.

Operators who set `blockOnError: false` chose "retry forever" and keep it here too.

### When the store, not the handler, spent the claim

The same counter has a second way to climb that has nothing to do with a handler. `claim` persists the increment before any handler runs, and only a confirmed write-back resets it, so a cycle that dies on a store op — a `fetch` that throws, an `ack` the database refuses — leaves the budget one claim poorer with no attempt behind it. On a single-writer store that is routine rather than exotic: a second connection holding a write transaction (a `tsx watch` restart overlap, a backup tool, an inspector on the file) is enough. Repeat it a few times and a self-healing condition turns into a permanent block, diagnosed as a lease-sizing problem that never happened.

So the drain keeps its own ledger. Every claim is provisionally charged to the store; a cycle that finalizes converts its claim into a handler attempt, and a cycle that throws leaves it charged. The next claim discounts what is still charged out of the `retry` the block decisions read, and logs a line naming the refund so the operator looks at the failing store op rather than at `leaseMillis`. The counter the budget sees is then the one `maxRetries` and `blockOnError` are documented to mean: handler failures only. The refund becomes durable the moment the store confirms anything for the stream — a backoff's due-marked `ack` writes the discounted `retry` back — and the ledger is process-local, so a restart forgets pending refunds and the stream falls back to the pre-#1592 accounting, never to anything worse.

Store degradation already has a home in the circuit breaker, which the same failure path feeds; this keeps the two from disagreeing about who spent the budget.

## Why no framework-level request deduplication

Optimistic concurrency catches *stream-version* conflicts. It does **not** catch the case where a client retries a network-failed `POST` and the same intent commits twice. That's request-level idempotency, and the framework deliberately leaves it to the API edge (see [Idempotency at the API edge](../guides/production-checklist#5-idempotency-at-the-api-edge)).

A "use the action's correlation id as a dedup key" hook was evaluated and rejected. Five reasons:

1. **TOCTOU races.** Two concurrent retries with the same key both pass the existence check before either commits. Either you add a distributed lock around the check (re-introducing the contention you were trying to avoid), or two events land. The API-edge cache sidesteps this by returning the *previous response* on duplicate keys without re-running the action.
2. **Semantic overloading.** `correlation` is a trace id that propagates through reactions. Reusing it as an idempotency key conflates two unrelated concerns — and means a downstream reaction that emits its own action with the same correlation id (the default) would be silently deduped against the original.
3. **Cross-action collisions.** A correlation id can drive multiple actions in a single workflow (`OpenTicket` → `AssignTicket`). If "saw this key before" gates the second action, the workflow stalls silently.
4. **State drift.** The natural dedup behaviour is "return current state on duplicate." But current state may have advanced past the original commit's view — clients consuming the response would see different state for the "same" request depending on retry timing.
5. **No TTL in an immutable log.** Correlation ids written to events live forever. A dedup table inside the event log can't expire entries without rewriting history. An external cache with a TTL is the natural fit, and that's what the API-edge pattern uses.

**Resolution:** keep the event log purely about *what happened*, and put "have I seen this request before?" in middleware where it can be cached, TTL'd, and shared across instances via Redis without touching the durable record. The production checklist shows the recommended tRPC middleware shape.

## Pointers

- `libs/act/src/internal/event-sourcing.ts` — `action()` and the `expectedVersion` check
- `libs/act-pg/src/PostgresStore.ts` — `commit()` (with the `PG_UNIQUE_VIOLATION` translation), `claim()` (with `FOR UPDATE SKIP LOCKED`)
- `libs/act/src/internal/drain-cycle.ts` — `runDrainCycle` orchestration and `DrainController` lifecycle
- `libs/act-pg/test/stress/` — multi-process exercise of both primitives under contention
