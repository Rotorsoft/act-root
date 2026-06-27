---
id: error-handling
title: Error Handling
---

# Error Handling

Act defines four primary error types. Each signals a different class of problem with a distinct resolution strategy.

## ValidationError

Thrown when an action or event payload fails Zod schema validation.

```typescript no-check
import { ValidationError } from "@rotorsoft/act";

try {
  await app.do("createUser", target, { email: 123 }); // wrong type
} catch (error) {
  if (error instanceof ValidationError) {
    console.error("Invalid payload:", error.details);
  }
}
```

**Resolution:** Fix the payload to match the schema. This is always a caller error.

## InvariantError

Thrown when a business rule defined via `.given()` is violated before events are emitted.

```typescript no-check
import { InvariantError } from "@rotorsoft/act";

try {
  await app.do("CloseTicket", target, { reason: "Done" });
} catch (error) {
  if (error instanceof InvariantError) {
    console.error("Rule violated:", error.description);
    console.error("Current state:", error.snapshot.state);
  }
}
```

**Resolution:** Check preconditions before dispatching, or handle gracefully in the UI. The state was not modified.

## ConcurrencyError

Thrown when optimistic concurrency control detects a conflict — another process committed events to the same stream between your `load()` and `commit()`.

```typescript no-check
import { ConcurrencyError } from "@rotorsoft/act";

try {
  await app.do("increment", target, { by: 1 });
} catch (error) {
  if (error instanceof ConcurrencyError) {
    console.error(`Stream ${error.stream}: expected v${error.expectedVersion}, found v${error.version}`);
  }
}
```

**Resolution:** Retry with fresh state. The cache is invalidated automatically on concurrency errors.

### Retry Pattern — per-action policy

Declare the retry budget on the action itself. The orchestrator owns the loop: on `ConcurrencyError` it invalidates the cache, applies an optional `backoff`, and re-runs from `load()`. Any other error rethrows immediately and does not consume the budget.

```typescript no-check
import { state } from "@rotorsoft/act";
import { z } from "zod";

const BankAccount = state({ BankAccount: z.object({ balance: z.number() }) })
  .init(() => ({ balance: 0 }))
  .emits({ Transferred: z.object({ amount: z.number() }) })
  .on(
    { transfer: z.object({ amount: z.number() }) },
    {
      maxRetries: 5,
      backoff: { strategy: "exponential", baseMs: 10, maxMs: 200, jitter: true },
    },
  )
    .emit((action) => ["Transferred", { amount: action.amount }])
  .build();

// Caller is unchanged — the retry is invisible to them.
await app.do("transfer", target, { amount: 100 });
```

The action author knows whether the action contends for a hot stream; the caller shouldn't have to. The same call site works for low-contention actions (omit options, surface `ConcurrencyError` on first conflict) and hot-stream actions (declare a budget, retry transparently).

`maxRetries` defaults to `0` (single attempt, current behavior). When `backoff` is omitted, retries run immediately — fine at low contention. On hot streams, jittered exponential backoff avoids the thundering herd of N writers re-racing in lockstep.

#### When to wrap manually instead

If you need different retry behavior than what the action declares — for instance, a UI mutation that should fail fast and surface to the user even on a hot action — wrap the call:

```typescript no-check
async function withRetry(action, target, payload, maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await app.do(action, target, payload);
    } catch (error) {
      if (error instanceof ConcurrencyError && attempt < maxRetries) {
        continue;
      }
      throw error;
    }
  }
}
```

This is an escape hatch — the declarative form on the action is the primary mechanism.

## StreamClosedError

Thrown when an action targets a stream that has been permanently closed (its head event is a `__tombstone__`). See [Close cycle](../architecture/close-cycle) for how a stream gets tombstoned.

```typescript no-check
import { StreamClosedError } from "@rotorsoft/act";

try {
  await app.do("AddNote", target, { text: "..." });
} catch (error) {
  if (error instanceof StreamClosedError) {
    console.error(`Stream ${error.stream} is closed`);
  }
}
```

**Resolution:** Closed streams are terminal. To re-open one, call `app.close([{ stream, restart: true }])` — that seeds a fresh `__snapshot__` and the stream accepts actions again.

## StoreError

Thrown by a `Store` adapter when an **infrastructure** operation fails — a dropped connection, a transaction rollback, a query timeout. It's the typed boundary between "the store is unavailable/degraded" and the domain errors above (`ConcurrencyError`, `StreamClosedError`), which describe legitimate outcomes you branch on. The original driver error is preserved on `cause`, and the failed operation name on `operation`.

```typescript no-check
import { StoreError } from "@rotorsoft/act";

try {
  await app.do("AddNote", target, { text: "..." });
} catch (error) {
  if (error instanceof StoreError) {
    console.error(`store ${error.operation} failed`, error.cause);
  }
}
```

Adapters throw `StoreError` from `claim` / `ack` / `block` / `subscribe` (and the Postgres/SQLite adapters from their commit paths) instead of silently returning empty results — so a degraded backend can't be mistaken for "no work."

## Store failures and the circuit breaker

The drain, settle, and autoclose loops all hit the store. When it goes down, every attempt throws a `StoreError`. Rather than hammer a dead database, each `Act` owns a **circuit breaker** shared by those loops:

- **closed** → normal; consecutive failures are counted.
- **open** → after `failureThreshold` consecutive failures, any drain/settle/autoclose attempt *skips* the store while open, and the breaker schedules a **retry** `cooldownMs` out.
- **half-open** → the scheduled retry re-attempts a drain; a pass closes the breaker, a failure re-opens it and reschedules the retry.

Because the breaker schedules its own retry, recovery is **automatic** — you don't need a new commit, a periodic poller, or a manual `drain()`. While open, the loops simply skip the store; once the cooldown elapses the breaker re-trials it and closes as soon as the store is healthy again. (A thrown `StoreError` also keeps the drain controller armed, so the retry isn't mistaken for "caught up.")

If the store stays down, the breaker keeps probing — **one attempt per `cooldownMs`, indefinitely** (always exactly one pending timer, `unref()`'d so it never blocks process exit). It never gives up, so it recovers whenever the store returns; the trade-off is that each failed probe re-emits the `error` event (an outage heartbeat — raise `cooldownMs` or dedupe in your handler if that's too chatty). The timer is cleared on the first successful probe and on `dispose()`. Tune it via [`ActOptions.circuitBreaker`](./configuration#circuit-breaker) (defaults: threshold 5, cooldown 30s).

Subscribe to the **`error`** lifecycle event to alert on a degraded store — it fires on every failed store cycle with the error and the breaker state:

```typescript no-check
app.on("error", ({ error, circuit }) => {
  if (error instanceof StoreError)
    metrics.increment("act.store_error", { op: error.operation, circuit });
  // circuit === "open" means the loops have backed off and will retry after the cooldown
});
```

The framework logs the error regardless of listeners; the event is emitted only when a listener is registered (Node's `EventEmitter` rethrows an unhandled `"error"`).

## Error Constants

For string-based error matching (e.g., in tRPC error handlers):

```typescript
import { Errors } from "@rotorsoft/act";

// Errors.ValidationError    = "ERR_VALIDATION"
// Errors.InvariantError     = "ERR_INVARIANT"
// Errors.ConcurrencyError   = "ERR_CONCURRENCY"
// Errors.StreamClosedError  = "ERR_STREAM_CLOSED"
// Errors.NonRetryableError  = "ERR_NON_RETRYABLE"
// Errors.StoreError         = "ERR_STORE"
```

## Production Error Handling

```typescript no-check
import { Errors } from "@rotorsoft/act";

// tRPC mutation
CreateItem: authedProcedure
  .input(z.object({ name: z.string() }))
  .mutation(async ({ input, ctx }) => {
    try {
      const snaps = await app.do("CreateItem", { stream: id, actor: ctx.actor }, input);
      // settle runs automatically — wired at bootstrap via
      // app.on("committed", () => app.settle())
      return { success: true, id };
    } catch (error) {
      if (error.message === Errors.ValidationError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid input" });
      }
      if (error.message === Errors.InvariantError) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.description });
      }
      if (error.message === Errors.ConcurrencyError) {
        throw new TRPCError({ code: "CONFLICT", message: "Please retry" });
      }
      throw error;
    }
  }),
```

## Blocked Streams

Streams block on two paths:

1. A reaction handler fails repeatedly and `lease.retry` exceeds `maxRetries`. The lease is committed with `blocked = true` and stays out of `claim()` results.
2. A reaction handler throws `NonRetryableError` (or a subclass like `NonRetryableWebhookError`) — the drain finalizer blocks the stream on the first failed attempt without consuming the retry budget. See [Non-retryable errors](#non-retryable-errors).

Recovery uses `app.unblock(input)` (resume from where the stream stopped) or `app.reset(input)` (rebuild from event 0). Both accept either an explicit `string[]` or a `StreamFilter` for bulk operations. See [Recovering a blocked stream](#recovering-a-blocked-stream--appunblock) and [Discovering blocked streams](#discovering-blocked-streams--appblocked_streams).

Monitor blocked streams via the `"blocked"` lifecycle event:

```typescript no-check
app.on("blocked", (blocked) => {
  blocked.forEach(({ stream, error, retry }) => {
    console.error(`Stream ${stream} blocked after ${retry} retries: ${error}`);
    // Alert, log to monitoring, etc.
  });
});
```

## Debugging

When something doesn't behave as expected, three knobs cover most cases.

**Verbose logging.** Set `LOG_LEVEL=debug` (or `trace`) before starting the process. The `trace` level wires breadcrumb logs into the load/action/drain hot paths via the `tracing` module:

```bash
LOG_LEVEL=trace pnpm dev
```

**Lifecycle event subscriptions.** Every Act instance emits a fixed set of lifecycle events; subscribe in dev to see what the framework is doing:

```ts no-check
app.on("committed", (events) => console.log("committed", events.map(e => e.name)));
app.on("acked", (leases) => console.log("acked", leases));
app.on("blocked", (blocked) => console.error("blocked", blocked));
app.on("settled", (drain) => console.log("settled", drain));
app.on("closed", (result) => console.log("closed", result));
app.on("notified", (n) => console.log("cross-process commit", n));  // PostgresStore notify only
app.on("error", ({ error, circuit }) => console.error("store failure", error, circuit));
```

**Direct event inspection.** Bypass cache and reducers and look at what's actually in the store:

```ts no-check
// All events on a stream (regex match by default)
const events = await app.query_array({ stream: "order-123" });

// Exact-string stream match — what load() uses internally
const exact = await app.query_array({ stream: "order-123", stream_exact: true });

// Time-travel: state as of a specific event id (see Cache and snapshots)
const snap = await app.load(Order, "order-123", undefined, { before: 5000 });
```

For introspecting reaction watermarks (per-stream `at`, `retry`, `blocked`, `leased_by`/`leased_until`) without taking a lease, use `store().query_streams(...)`. The `act-inspector` tool is built on this primitive.

### Per-reaction options

Each reaction handler accepts options that control retry and blocking behaviour:

```typescript no-check
.on("OrderPlaced")
  .do(handler, {
    maxRetries: 5,
    blockOnError: true,
    backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true },
  })
  .to(resolver)
```

- **`maxRetries`** (default `3`) — how many times the framework re-claims a stream after a handler throws. Each failed cycle increments `retry_count`; the next `claim()` picks the stream up again with the same events.
- **`blockOnError`** (default `true`) — once `retry_count` exceeds `maxRetries`, the framework calls `block()` to set `blocked = true` on the stream. Set `false` if your handler is idempotent and you'd rather keep retrying forever.
- **`backoff`** (default omitted — retry as soon as the lease expires) — paces inter-attempt timing so flaky receivers aren't hammered.

Set `maxRetries: 0` for handlers that should never retry — typically those that already implement their own dead-letter strategy.

### Backoff

Without `backoff`, the framework re-claims a failed stream on the next drain cycle — typically within milliseconds. For handlers that talk to external systems (HTTP, queues, third-party APIs), that turns a 200ms transient outage into an exhausted retry budget. The `backoff` option paces the next attempt by deferring re-dispatch on this worker.

```typescript no-check
backoff: {
  strategy: "exponential",  // "fixed" | "linear" | "exponential"
  baseMs: 200,              // base delay
  maxMs: 30_000,            // cap (only used by exponential)
  jitter: true,             // multiply by random factor in [0.5, 1.5)
}
```

Delay computation, where `retry` is the lease's retry counter at the failed attempt (`0` is the first failure):

| Strategy | Delay |
|---|---|
| `fixed` | `baseMs` |
| `linear` | `baseMs * (retry + 1)` |
| `exponential` | `min(baseMs * 2^retry, maxMs)` |

With `jitter: true`, the final delay is multiplied by `0.5 + random()` (range `[0.5, 1.5)`) to avoid lockstep thundering herds.

#### Per-worker semantics

Backoff state lives in process memory on each worker's `DrainController`. With N competing workers (each running its own controller against a shared store):

- Each worker only paces *its own* re-attempts.
- The shared `retry_count` on the stream watermark climbs across workers — so the `blockOnError` threshold is hit up to N× faster than the configured strategy suggests.

This is intentional: transient per-worker faults (one bad DNS resolver, one network blip) recover faster, and genuine poison messages get quarantined sooner. If you need cross-worker pacing for very long backoffs, forward events to an external bus rather than holding drain leases for minutes — see [external integration](../guides/external-integration).

#### Interaction with `leaseMillis`

While a stream is in its backoff window, the controller claims its lease but skips dispatch — no `ack`, no `block`. The lease holds for `leaseMillis` via the existing claim mechanism, which prevents competing workers from re-attempting during the configured delay.

- If your `backoff` delay is **shorter** than `leaseMillis`, the lease still holds until `leaseMillis` expires. Effective backoff is `max(configured, leaseMillis)`.
- If your `backoff` delay is **longer** than `leaseMillis`, the lease expires partway through; subsequent claims (by this controller or competing workers) re-acquire the lease and re-skip until the delay elapses.

This means **`backoff` is always at-least-as-long-as configured**, never shorter. To tighten backoff floors, lower `leaseMillis` (with the trade-off that overlapping workers can race more aggressively).

## Webhook delivery — `@rotorsoft/act-http/webhook`

The 80% pattern for external integration is "POST this event to a URL." Every team writes the same `fetch` wrapper — timeout, idempotency key, status-coded errors, JSON serialization. The [`@rotorsoft/act-http`](https://github.com/rotorsoft/act-root/tree/master/libs/act-http) umbrella package ships that wrapper as `webhook()`, a reaction-handler factory that composes with the `maxRetries` / `backoff` options above:

```ts no-check
import { webhook } from "@rotorsoft/act-http/webhook";

.on("OrderConfirmed")
  .do(
    webhook({
      url: "https://api.example.com/webhooks/orders",
      headers: (event) => ({ Authorization: "Bearer " + token }),
      body: (event) => ({ orderId: event.stream, total: event.data.total }),
      timeoutMs: 2_000,
    }),
    {
      maxRetries: 5,
      backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true },
    }
  )
  .to(resolver)
```

Behavior:

- `POST` by default; method configurable.
- `Idempotency-Key` derived from `event.id` (overridable per call, or return `null` to skip).
- 5xx, network errors, and timeouts throw `WebhookError` → drain retries per `maxRetries` / `backoff`.
- 4xx throws `NonRetryableWebhookError` (a subclass of `NonRetryableError`) → the drain finalizer **blocks the stream on the first failed attempt** when `blockOnError` is true. No wasted retries on permanent client errors.
- `fetch` is injectable for tests.

The two-class split lets handlers signal recoverability through the type system. `NonRetryableError` (exported from `@rotorsoft/act`) is the general primitive — any handler can throw it to bypass the retry budget for known-permanent failures (validation errors, "user deleted" 404s, business-rule violations). See [Non-retryable errors](#non-retryable-errors) below.

### When `webhook` fits — and when it doesn't

`webhook` is built for **fire-and-forget delivery to a cooperative receiver**: short timeouts, retries paced by `backoff`, and idempotent endpoints that can absorb the occasional duplicate.

**Keep `timeoutMs` below `leaseMillis`.** The drain lease is what stops competing workers from re-dispatching while your handler is still in flight. If `timeoutMs` approaches or exceeds the lease, a slow receiver can hold the lease through expiry, at which point another worker will claim the stream and POST the same event in parallel. The downstream `Idempotency-Key` then becomes load-bearing — if your receiver doesn't dedup, you'll deliver twice. Rule of thumb: `timeoutMs ≤ leaseMillis - safety_margin`. If you need a longer window, bump `leaseMillis` globally on the Act options.

**For heavy or long-running delivery, don't use `webhook` directly.** Drain leases aren't free, and holding one for tens of seconds while a slow API churns is the wrong shape. The Act-native pattern is an outbox-style fan-out: emit a small "needs delivery" event (a cheap, local operation), and let a separate consumer — a downstream worker, a Kafka/SQS pipeline, an external scheduler — pick it up and do the long work at its own pace. Drain stays responsive; the slow path runs at its own schedule. See [external integration](../guides/external-integration) (forthcoming) for the outbox pattern in detail.

| Shape of work | Right tool |
|---|---|
| 1–2s POST to a fast, idempotent API | `webhook` directly |
| Flaky-but-fast third party | `webhook` + aggressive `backoff` |
| Multi-second / multi-minute API call | Emit an event, drain hands off to a bus; bus worker calls the API |
| Bulk fan-out (10k+ receivers) | Emit a "fanout" event, let a dedicated consumer enumerate receivers |
| Streaming / long-poll / large file transfer | Not `webhook` — write a dedicated worker |

## Non-retryable errors

The drain pipeline retries on any thrown error by default — `maxRetries` is a budget, not a classifier. For failures the handler *knows* won't recover on retry — a 4xx from a webhook, a `ZodError` on malformed input, a "user deleted" 404, a business-rule violation — throwing a generic `Error` wastes the budget and delays the operator signal.

`NonRetryableError` (exported from `@rotorsoft/act`) is the handler-side signal. The drain finalizer checks `error instanceof NonRetryableError` and forces `block = blockOnError` regardless of `lease.retry`. The stream blocks on the first failed attempt; no retries, no backoff window.

```ts no-check
import { NonRetryableError } from "@rotorsoft/act";

.on("PaymentReceived")
  .do(async (event) => {
    const parsed = PaymentSchema.safeParse(event.data);
    if (!parsed.success) {
      throw new NonRetryableError("payment payload failed validation", {
        cause: parsed.error,
      });
    }
    // ... handle the parsed payload
  })
```

Important: `NonRetryableError` does **not** override `blockOnError: false`. If the operator has explicitly chosen "never block, retry forever," the framework respects that — `NonRetryableError` becomes equivalent to any other error. The class signal only matters on the block-when-budget-exhausted path.

`@rotorsoft/act-http/webhook` exports `NonRetryableWebhookError` (a subclass) for 4xx responses. The split lets generic catch sites use `instanceof NonRetryableError` while webhook-aware code reads the HTTP-specific `status` / `url` / `responseBody` fields.

### Recovering a blocked stream — `app.unblock`

When a stream blocks — whether from `NonRetryableError` (first attempt) or from exhausting `maxRetries` — the operator's recovery path is `app.unblock(input)`. The input is either an explicit list of stream names or a `StreamFilter` for bulk recovery:

```ts no-check
// Single targeted recovery — by name.
await app.unblock(["webhooks-out-customer-42"]);

// Bulk recovery — by filter (all blocked streams matching a pattern).
await app.unblock({ stream: "^webhooks-out-" });

// Post-incident: unblock everything currently blocked.
await app.unblock({});
```

`unblock` clears the blocked flag, resets retry count, drops any stale lease, and arms the orchestrator's drain flag so a settled app picks up the now-free stream on the next cycle. The `at` watermark is **not touched** — the stream resumes from the next event after the last successful ack, not from the beginning.

The filter form always restricts to `blocked = true` regardless of what the caller passes — there's no use case for "unblock unblocked streams." Already-unblocked streams and unknown names are silently skipped; the return count reflects only streams that were actually flipped.

Contrast with `app.reset(input)`, which is for projection rebuilds. `reset` accepts the same `string[] | StreamFilter` shape but sets the watermark back to -1 and replays every event from the start:

| Use case | Method |
|---|---|
| Recovered from a poison message, resume normally | `app.unblock([stream])` or `app.unblock(filter)` |
| Bulk recovery across a family of streams | `app.unblock({ stream: "^proj-" })` |
| Deploy new projection logic, replay all events | `app.reset([stream])` |
| Rebuild every blocked stream from zero | `app.reset({ blocked: true })` |

### Discovering blocked streams — `app.blocked_streams()`

For the "show me what's broken" operational query, `app.blocked_streams()` returns every currently-blocked stream position. Convenience wrapper around `store().query_streams(cb, { blocked: true })`:

```ts no-check
const blocked = await app.blocked_streams();
console.table(
  blocked.map(({ stream, retry, error }) => ({ stream, retry, error }))
);

// Operator investigates, then bulk-unblocks the family:
await app.unblock({ stream: "^webhooks-out-" });
```

Results paginate by `limit` (default 100) with an `after` keyset cursor on the stream name. For richer queries — source filters, unblocked introspection, custom pagination — drop to `store().query_streams(...)` directly.
