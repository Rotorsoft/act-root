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

If two callers race on the same stream, only one wins. The loser sees `ConcurrencyError` with `expectedVersion` and `lastVersion` (the actual head). Standard pattern is to reload state and retry.

### Two failure modes the framework handles

**Predictable**: caller's `expectedVersion` doesn't match. Framework throws `ConcurrencyError` from the version check.

**Subtle**: both transactions read the same max version, both pass the `expectedVersion` check, both try to INSERT at the same `(stream, version)` pair. The unique index catches the second INSERT — without explicit handling, this surfaces as an adapter-specific error (PG SQLSTATE `23505`), not `ConcurrencyError`. Callers retrying on the framework signal would silently lose the commit.

**Resolution** (in `PostgresStore.commit`): catch the SQLSTATE `23505` from INSERT and re-throw as `ConcurrencyError`. After the catch, both failure modes look the same to the caller, and the retry path is consistent. Documented in `commit.error.spec.ts` and exercised by the `same-stream` scenario in the Postgres stress harness.

### Reactions skip optimistic concurrency by design

Inside `action()`, when `reactingTo` is provided (i.e., the action was triggered by a reaction handler), `expectedVersion` is *not* enforced:

```ts
// internal/event-sourcing.ts, action()
reactingTo ? undefined : expected
```

The reasoning: reactions are inherently asynchronous catch-up. By the time a reaction processes event N, the stream has likely advanced past N. Forcing an `expectedVersion` check would convert ordinary catch-up into spurious retries. Stream leasing already serializes concurrent reactions on the same stream, so the version race doesn't matter.

## Stream leasing — the reader's exclusivity primitive

The drain pipeline polls for streams that have new events past their last-processed watermark, claims them via `FOR UPDATE SKIP LOCKED`, processes their events, then acks (releases the lease and advances the watermark) or blocks (marks the stream failed after exceeding retry budget).

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
- **`block`** — handler failed past the retry budget; set `blocked=true`. The stream stays out of `claim()` results until something explicitly unblocks it (e.g., `app.reset()`).
- **Timeout** — worker died or hung; `leased_until` passes; the next `claim()` from any worker can acquire the stream. Retry count is *not* incremented — the timed-out worker may have processed the events successfully but failed to ack.

### Why a stream stays in `claim()` after a partial handler failure

If a reaction handler throws, the framework `block`s the lease *only if* `retry_count > maxRetries && blockOnError`. Otherwise it just releases without advancing the watermark. The next `claim()` cycle picks the stream up again — same events, fresh handler invocation, retry count incremented. Bounded retries with backoff are configured per-reaction via `ReactionOptions`.

## How the two interact

A common confusion: "If I commit while another worker holds a lease, does my commit fail?"

**No.** Stream leasing locks the row in the `streams` table (which tracks reaction watermarks). Commits write to the `events` table and check the `(stream, version)` index. Different rows, different locks. A commit and a reaction lease can be active on the same stream concurrently.

Real interaction surfaces in the close-the-books flow ([Close cycle](./close-cycle)), where the close operation must coordinate both: tombstone the stream (write a guard event via `commit`), then verify no leases are held (lease lifecycle).

## Observability

Both primitives surface in the trace breadcrumb stream:

- Optimistic concurrency: `ConcurrencyError` thrown to caller; the framework logs nothing extra (caller decides what to log)
- Lease lifecycle: `>> claimed`, `>> acked`, `>> blocked` traces from `internal/drain-cycle.ts` decorators

For a stuck stream, query `store.query_streams` directly — it returns the per-stream `at`, `retry`, `blocked`, and `leased_by/leased_until` without taking a lease. The act-inspector tool is built on this primitive.

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
