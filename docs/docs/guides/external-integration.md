---
id: external-integration
title: External integration patterns
---

# External integration patterns

Act apps that reach beyond their own process — webhooks, downstream services, message buses — face the same two questions every time: *what owns delivery* and *how do we keep at-least-once from becoming actual duplication*. This guide answers both, with two integration shapes and one safety contract that makes either of them work.

## TL;DR

| You need | Use |
|---|---|
| POST events to one receiver, fast and idempotent | **Inline delivery** — `webhook` directly in a reaction |
| Multiple downstream consumers, high fan-out, slow consumers | **Forwarded delivery** — reaction publishes to a bus, downstream owns delivery |
| At-least-once that doesn't double-charge customers | **Receiver-side idempotency** with `Idempotency-Key` — both shapes need this |
| To recover a blocked stream after fixing the bug | `app.blocked_streams()` → fix → `app.unblock(input)` (the [recovery loop](../concepts/error-handling.md#recovering-a-blocked-stream--appunblock)) |

The rest of this page expands each shape.

---

## 1. Inline delivery — drain *is* the pipeline

The simplest shape: a reaction calls `webhook(...)` (from [`@rotorsoft/act-http/webhook`](https://github.com/Rotorsoft/act-root/tree/master/libs/act-http)), drain owns ordering and retries, and the failure paths fall back onto the framework's existing primitives.

```ts
import { slice } from "@rotorsoft/act";
import { webhook } from "@rotorsoft/act-http/webhook";

export const OrderWebhooksSlice = slice()
  .withState(OrderOperations)
  .on("OrderConfirmed")
  .do(
    webhook({
      url: "https://api.example.com/webhooks/orders",
      headers: (event) => ({ Authorization: "Bearer " + token(event) }),
      body: (event) => ({ orderId: event.stream, total: event.data.total }),
      timeoutMs: 2_000,
    }),
    {
      maxRetries: 5,
      backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true },
    }
  )
  .to({ target: "order-webhooks-out" })
  .build();
```

This is the wolfdesk pattern verbatim — see [`packages/wolfdesk/src/ticket-webhooks.ts`](https://github.com/Rotorsoft/act-root/blob/master/packages/wolfdesk/src/ticket-webhooks.ts) for the running example.

### What the framework gives you, for free

Once you wire a reaction this way, drain provides:

- **Per-stream ordering.** Events for `order-42-webhooks-out` always dispatch in event-id order; concurrent claims on the same stream are prevented by `FOR UPDATE SKIP LOCKED` (or the in-memory equivalent).
- **At-least-once delivery.** A handler that throws gets re-claimed on the next drain cycle. The watermark only advances on successful ack.
- **Retry pacing.** `backoff` (since [ACT-601](https://github.com/Rotorsoft/act-root/issues/687)) holds the lease and skips dispatch until the configured delay elapses, so a flaky receiver gets paced instead of hammered.
- **Permanent-failure detection.** 4xx responses from `webhook` throw `NonRetryableWebhookError` (a `NonRetryableError` subclass), which the drain finalizer recognizes and blocks the stream on the first failed attempt — no wasted retries on a malformed payload. See [Non-retryable errors](../concepts/error-handling.md#non-retryable-errors).
- **Dead letter.** Streams blocked by `block()` (whether from `maxRetries` exhaustion or `NonRetryableError`) stay out of `claim()` until `app.unblock(input)` clears them. See [Recovering a blocked stream](../concepts/error-handling.md#recovering-a-blocked-stream--appunblock).
- **Cross-process competing consumers.** N workers running the same Act against the same store compete via `claim()`; only one wins per stream. No coordination work for the developer. See [cross-process reactions](../architecture/cross-process-reactions.md).

### When inline delivery is the right tool

| Property | Inline |
|---|---|
| Number of receivers | One per reaction; small fan-out |
| Receiver latency | Sub-second; well under `leaseMillis` |
| Volume | Modest — drain handles it cycle-by-cycle |
| Ownership | You control sender and receiver |
| Receiver behavior | Idempotent (handles `Idempotency-Key`) |

The constraint that catches teams: **`timeoutMs` must stay below `leaseMillis`** with a safety margin. The drain lease is what stops competing workers from re-dispatching while your handler is in flight. If `timeoutMs` approaches or exceeds the lease, a slow receiver can hold the lease through expiry, at which point another worker will claim the stream and POST the same event in parallel. The downstream `Idempotency-Key` then becomes load-bearing — if your receiver doesn't dedup, you'll deliver twice. The [webhook helper README](https://github.com/Rotorsoft/act-root/tree/master/libs/act-http#when-webhook-is-the-right-tool--and-when-it-isnt) covers this constraint in detail.

The default lease is around 5 seconds. A 2-second `timeoutMs` leaves headroom for retry. A 10-second `timeoutMs` does not.

### When inline is *not* the right tool

Three signals that say "stop, this needs a different shape":

1. **One reaction, many receivers.** Every new receiver means another reaction, another claim, another lease. Drain wasn't designed to coordinate ten parallel webhooks against the same event — that's the bus's job.
2. **Slow consumers.** A receiver that takes 30 seconds will exceed any reasonable lease. Bumping `leaseMillis` globally slows recovery for every reaction in the system. Wrong knob.
3. **Bursty fan-out.** A 10,000-receiver broadcast inside drain holds 10,000 leases at once. Drain is for ordered, paced delivery — bursts belong on a bus.

Each of those is a signal to read the next section.

---

## 2. Forwarded delivery — the bus *is* the pipeline

When inline doesn't fit, the pattern is to publish events to a real message bus (Kafka, SQS, Redpanda, NATS, RabbitMQ) and let downstream consumers own delivery semantics. Act keeps its drain semantics for the *publish step*; the bus takes over from there.

```ts
import { slice } from "@rotorsoft/act";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: "us-east-1" });
const QUEUE_URL = process.env.ORDERS_QUEUE_URL!;

export const OrderForwardingSlice = slice()
  .withState(OrderOperations)
  .on("OrderConfirmed")
  .do(
    async function forwardToSQS(event) {
      // SQS auto-dedups within a 5-minute window when MessageDeduplicationId
      // is supplied. event.id is the right key — stable, monotonic, unique.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_URL,
          MessageBody: JSON.stringify({
            orderId: event.stream,
            data: event.data,
            committedAt: event.created,
          }),
          MessageDeduplicationId: String(event.id),
          MessageGroupId: event.stream, // FIFO ordering per order
        })
      );
    },
    {
      maxRetries: 5,
      backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000, jitter: true },
    }
  )
  .to({ target: "order-forwarded" })
  .build();
```

This is ~20 lines. It's deliberately thin — Act keeps the lease only as long as the `sqs.send()` round-trip, which is bounded and fast. The actual delivery to consumers happens after Act's lease is released; the bus owns that timeline.

The same shape works for Kafka (`producer.send({ topic, key: event.stream, value })`), Redpanda, NATS (`nc.publish(subject, payload)`), or any RPC publisher. The framework doesn't care which — it only cares that the publish step is fast and idempotent.

### What you give up, and what you gain

| Property | Inline | Forwarded |
|---|---|---|
| Receivers per reaction | One | Many (bus distributes) |
| Receiver latency tolerance | Below `leaseMillis` | Unbounded (bus buffers) |
| Multi-consumer | Add reactions | Add subscribers — free |
| Downstream delivery semantics | Drain's | The bus's |
| Operational dependency | Receiver | Receiver + bus |

The trade is real: forwarded delivery adds a piece of infrastructure (the bus) that has to be operated, monitored, and budgeted. For one fast receiver, that's overkill. For five receivers that each have their own SLO, it's the right architecture.

### Drain's role after forwarding

After the publish step succeeds, drain acks the lease and the watermark advances. The bus now owns:

- **Multi-consumer fan-out.** Each subscriber reads from their own offset; one slow subscriber doesn't block others.
- **Durable subscription state.** A subscriber that crashes resumes from its last offset on restart.
- **Retry semantics for downstream receivers.** Kafka consumers handle their own retry budgets; SQS visibility timeouts give consumers room to fail and re-receive.

Drain stays in charge of one thing: **getting the event to the bus exactly as the event store has it**. Per-stream ordering is preserved on the publish side via the resolver target (`order-forwarded` in the example above — one drain stream per logical order grouping). Beyond that, the bus owns the world.

### Anti-patterns to avoid

- **Don't `await consumer.process()` inside the reaction.** If the reaction calls SQS+wait-for-consumer-ack, you've reintroduced the slow-consumer problem with extra infrastructure. The publish must be fire-and-forget at Act's level.
- **Don't skip `Idempotency-Key` / `MessageDeduplicationId`.** Drain's at-least-once semantics mean any handler can retry; the publish step is no exception. Without dedup at the bus level, a retried publish doubles the message.
- **Don't carry the entire event payload if the bus stores it.** Some buses cap message size aggressively (SQS at 256KB, Kafka by config). Either keep events small or pass an event-id and let consumers fetch the full event back from the Act store.

---

## 3. Receiver-side idempotency contract

At-least-once is the floor Act gives you. To make it safe, the receiver has to dedup. This section is the contract that makes "at-least-once + idempotency" equivalent to "exactly-once" *from the caller's perspective*.

### Why this matters

Two scenarios where the same event reaches the receiver twice without any bug in either Act or the receiver:

1. **Slow downstream.** Sender's `timeoutMs` expires before the response. Drain treats the request as failed, retries it. Receiver successfully processed both attempts.
2. **Lost ack.** Sender processes the response fine, but the network drops before drain commits the ack. Next drain cycle re-dispatches.

Both are normal — they're not bugs to fix in the sender. The fix is on the receiver, and it has exactly one shape: dedup by a stable key.

### Idempotency-Key derivation

`webhook` auto-derives `Idempotency-Key: <event.id>` for every request. `event.id` is the framework's per-event monotonic integer:

- **Stable.** The same event has the same id from commit forever; reading the same row back returns the same id.
- **Unique.** Across the entire store, no two events share an id.
- **Monotonic.** Higher id always means later commit. Useful for keeping a sliding-window dedup cache bounded.

For custom callers — non-`webhook` reactions, queue forwarders, anything — pass `String(event.id)` (or your bus's dedup key field) as the idempotency token. Don't derive from event content or hash the payload; collisions and changes both bite you.

### The `IdempotencyStore` port

The dedup contract is shipped as a port — `IdempotencyStore` — in [`@rotorsoft/act-ops`](https://www.npmjs.com/package/@rotorsoft/act-ops), the zero-`act`-dependency home for receiver-side primitives. One method, by design:

```ts
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";

export interface IdempotencyStore {
  claim(key: string, now?: number): boolean | Promise<boolean>;
}
```

`true` means the key was fresh (and is now recorded); `false` means it was already present and the caller should treat the request as a duplicate. The union return type lets sync (in-memory) and async (durable) adapters share the same call site. The middleware that consumes the port (`#744`) awaits unconditionally.

> **Not a Cache.** In this codebase `Cache` means "rebuildable from a source of truth" (snapshot cache). Dedup state is authoritative — losing it allows duplicate side effects, not just a rebuild. Hence `Store`. The naming distinction matters when you swap implementations: the durable adapter's *persistence* is the load-bearing property, not its hit rate.

`@rotorsoft/act-ops` ships with no peer dep on `@rotorsoft/act`, so a non-Act receiver (a Kafka consumer processing forwarded events, an Express endpoint behind a queue, …) can install the port without dragging the orchestrator along. Act apps and non-Act apps speak the same contract.

### Implementations

Three implementations of the dedup store, ordered by deployment complexity. The first ships in `@rotorsoft/act-ops`; the next two are sketches that follow the same `IdempotencyStore` contract — they're not packaged yet but slot in unchanged once you wire them.

#### `InMemoryIdempotencyStore` from `@rotorsoft/act-ops/idempotency`

```ts
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";

const dedup = new InMemoryIdempotencyStore({
  ttlMs: 24 * 60 * 60 * 1000,  // dedup window (default: 24h)
  maxEntries: 50_000,           // memory bound (default: 100_000)
});

const fresh = dedup.claim(key);
```

Bounded LRU + TTL. Sync return. Use when: receiver is single-process, dedup window is short (under a day), keys fit in RAM. The wolfdesk demo at [`packages/server/src/webhook-receiver.ts`](https://github.com/Rotorsoft/act-root/blob/master/packages/server/src/webhook-receiver.ts) uses this implementation end-to-end.

#### Redis `SET NX EX` (sketch — port not yet packaged)

```ts
class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisClient, private readonly ttlSeconds: number) {}

  async claim(key: string): Promise<boolean> {
    // SET ... NX EX is atomic: returns "OK" only when the key didn't exist.
    const result = await this.redis.set(`idem:${key}`, "1", "EX", this.ttlSeconds, "NX");
    return result === "OK";
  }
}
```

Use when: receiver is multi-process, dedup window is hours-to-days, Redis is already in the stack.

#### Postgres unique index (sketch — port not yet packaged)

```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_idempotency_seen_at ON idempotency_keys (seen_at);

-- Background job, runs hourly or daily:
DELETE FROM idempotency_keys WHERE seen_at < NOW() - INTERVAL '7 days';
```

```ts
class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}

  async claim(key: string): Promise<boolean> {
    try {
      await this.db.query(`INSERT INTO idempotency_keys(key) VALUES ($1)`, [key]);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}
```

Use when: receiver already has Postgres in its stack, dedup needs are durable (survive process restarts), TTL can be relaxed in favor of audit trail. A `PostgresIdempotencyStore` adapter is parked for milestone 1.2; until it ships, copy the shape above.

### TTL sizing

The dedup window has one hard floor: **it must be longer than the longest possible retry+backoff window from the sender**. Undersize it and a key expires before the sender finishes retrying, the duplicate request looks fresh to the receiver, and the side effect runs twice — silently. No error log. You see it in the data.

`@rotorsoft/act-ops` bakes the math into the store. Pass the sender's `{ maxRetries, backoff, timeoutMs }` as a `retryProfile` and the store sizes its window for you:

```ts
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";

const dedup = new InMemoryIdempotencyStore({
  retryProfile: {
    maxRetries: 5,
    backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 },
    timeoutMs: 2_000,
  },
});
```

The derived window is the bare envelope (per-retry backoff + per-attempt timeouts) multiplied by `safetyFactor` (default 4× — operators almost always want headroom over the bare math because slow networks, clock skew, and incident-window retries stretch the real-world maximum past the computed one). When the sender enables `jitter`, the store multiplies the backoff sum by 1.5 — the worst-case multiplier in `[0.5, 1.5)`. The derivation is also exported as `minSafeTtl` from the same subpath, so future durable adapters (`PostgresIdempotencyStore`, `RedisIdempotencyStore`) accept the same `retryProfile` option and call the same function — single source of truth for the math across every implementation.

If you'd rather skip the derivation and pick a generous round number, pass `ttlMs` directly — that's the "use 24h regardless" path most apps land on:

```ts
const dedup = new InMemoryIdempotencyStore({ ttlMs: 24 * 60 * 60 * 1000 });
```

When both `ttlMs` and `retryProfile` are supplied, `ttlMs` wins (explicit beats derived).

The by-hand math, kept as a teaching aid — work through it once so you trust the derived number:

| Attempt | Wait before |
|---|---|
| 0 | 0 |
| 1 | 200ms |
| 2 | 400ms |
| 3 | 800ms |
| 4 | 1.6s |
| 5 | 3.2s (then block) |

Backoff sum: 6.2s. Add the per-attempt `timeoutMs` × `(maxRetries + 1)` = 2s × 6 = 12s. Bare envelope: 18.2s. With `safetyFactor: 4`, the store sizes the window at 72.8s. Round up further if you want the cache to survive operator-driven retry during incident review — **most apps land at 24h regardless of what the math says**, and the derivation's job is to confirm 24h is generous enough, not to argue against it.

### End-to-end example — tRPC receiver

A small idempotent receiver, mirroring the `packages/server` tRPC setup. The middleware checks `Idempotency-Key` and short-circuits duplicates:

```ts
// packages/server/src/webhook-receiver.ts (excerpt)
import { extractIdempotencyKey } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { initTRPC, TRPCError } from "@trpc/server";

const dedup = new InMemoryIdempotencyStore();
const t = initTRPC.context<{ headers: Record<string, string | string[] | undefined> }>().create();

export const idempotent = t.procedure.use(({ ctx, next }) => {
  const key = extractIdempotencyKey(ctx.headers);
  if (!key) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Missing Idempotency-Key header",
    });
  }
  const fresh = dedup.claim(key);
  return next({ ctx: { ...ctx, key, deduped: !fresh } });
});
```

`extractIdempotencyKey` from `@rotorsoft/act-http/receiver` does the case-insensitive header lookup and returns `undefined` for the three cases where there's no usable key: missing header, array-valued header (ambiguous — Node's raw header bag allows it), or empty-string value (carries no idempotency information). One import line replaces the by-hand lookup every receiver was writing.

Swap `InMemoryIdempotencyStore` for the Redis or Postgres sketch above — the rest of the middleware doesn't change, because both adapters implement the same `IdempotencyStore` port. For an async adapter, mark the `.use(...)` callback `async` and `await dedup.claim(key)` — the call site shape stays identical otherwise.

A handler using the middleware returns success on both first-attempt and dedup-hit, distinguishing them only for telemetry:

```ts
export const webhookRouter = t.router({
  orderConfirmed: idempotent
    .input(OrderConfirmedSchema)
    .mutation(async ({ input, ctx }) => {
      if (ctx.deduped) {
        return { status: "dedup-skipped", key: ctx.key };
      }
      await processOrder(input);
      return { status: "processed", key: ctx.key };
    }),
});
```

A runnable version of this lives at [`packages/server/src/webhook-receiver.ts`](https://github.com/Rotorsoft/act-root/blob/master/packages/server/src/webhook-receiver.ts) — point the wolfdesk webhook sender at it (`WOLFDESK_ESCALATION_WEBHOOK=http://localhost:4001/escalations`) and watch dedup work end-to-end.

---

## 4. Operational checklist

The integration is in production. Here's the day-2 surface.

### Monitor blocked streams

Both inline and forwarded paths can end up at the same place — a stream blocked by `block()`. Wire the `"blocked"` lifecycle event into your alerting:

```ts
app.on("blocked", (blocked) => {
  blocked.forEach(({ stream, error, retry }) => {
    metrics.counter("act.streams.blocked").increment({ stream });
    logger.error({ stream, error, retry }, "stream blocked");
  });
});
```

`act.streams.blocked` should be a **zero-floor counter** — any non-zero is a paging condition.

### Discover what's blocked

`app.blocked_streams()` returns every currently-blocked stream position. The 90% case for "show me what's broken right now":

```ts
const blocked = await app.blocked_streams();
console.table(
  blocked.map(({ stream, retry, error, at }) => ({ stream, at, retry, error }))
);
```

For pagination or source filters, drop to `store().query_streams(callback, { blocked: true, ... })` directly.

### Recover after fixing the root cause

`app.unblock(input)` clears the blocked flag and resumes from where the stream stopped — **not** from event 0. Two forms:

```ts
// Single targeted recovery.
await app.unblock(["webhooks-out-customer-42"]);

// Bulk recovery — every blocked stream in a family.
await app.unblock({ stream: "^webhooks-out-" });

// Post-incident: unblock everything that's blocked.
await app.unblock({});
```

**Don't use `app.reset()` to recover.** `reset` rebuilds from event 0 and would re-fire every historical webhook. Use it only when you're rebuilding a projection from scratch. See [Recovering a blocked stream](../concepts/error-handling.md#recovering-a-blocked-stream--appunblock) for the comparison table.

### Distinguish error classes operationally

When `webhook` is in the picture, the `"blocked"` event carries an error string that includes the response status. Two distinct operational meanings:

| Error class | Status | Operator action |
|---|---|---|
| `WebhookError` (retryable) | 5xx, network, timeout | Receiver outage — usually self-resolving via backoff. If the same stream blocks repeatedly, escalate to receiver team. |
| `NonRetryableWebhookError` | 4xx | Sender bug or stale receiver contract — fix the request shape, then `app.unblock(stream)` |

Greppable distinguisher: `NonRetryableWebhookError` shows as `name: "NonRetryableWebhookError"` in logs; `WebhookError` shows as `name: "WebhookError"`.

### Idempotency cache hygiene

A cache that fills up indefinitely defeats its purpose. Three checks for the receiver-side cache:

1. **TTL exceeds the sender's retry+backoff window.** Recompute when you change `maxRetries` or `backoff.maxMs`.
2. **Cache size has a ceiling.** In-memory LRU caps entries; Redis is bounded by maxmemory policy; Postgres needs a periodic `DELETE WHERE seen_at < NOW() - INTERVAL '...'` job.
3. **Cache metrics surface hit rate.** A 0% hit rate means the cache is doing nothing (either dedup isn't needed or the key derivation is broken); a 100% hit rate means every request is a duplicate (sender is misconfigured).

### When to migrate from inline to forwarded

Three signals that say "this was inline; it shouldn't be anymore":

1. **"We keep adding receivers."** Every new receiver becomes another reaction. The reaction count is growing faster than the event count. The bus already exists conceptually — make it real.
2. **"Drain is always behind."** `act.streams.lagging` is consistently non-zero because reactions are slower than commits. Inline is the bottleneck; the bus would let downstream pace itself.
3. **"`leaseMillis` keeps creeping up."** A receiver that needed `timeoutMs: 1_000` last quarter now needs `5_000`. The pressure to bump the global lease is the framework asking you to move off inline.

The migration itself is cheap: replace the inline reaction's body with a `bus.publish(...)` call. The downstream gets re-implemented as a bus consumer. Per-stream ordering survives (use the stream id as the partition key); idempotency survives (use the event id as the dedup key).

---

## Related

- [Webhook helper](https://github.com/Rotorsoft/act-root/blob/master/libs/act-http/README.md) — the `@rotorsoft/act-http/webhook` package and its `timeoutMs`/`leaseMillis` constraint
- [Error handling](../concepts/error-handling.md) — backoff, non-retryable errors, blocked streams, `unblock`
- [Cross-process reactions](../architecture/cross-process-reactions.md) — `Store.notify`, competing consumers, topology shapes
- [Concurrency model](../architecture/concurrency-model.md) — lease lifecycle, `claim`/`ack`/`block`/timeout transitions
- [Real-time](../concepts/real-time.md) — SSE for state broadcast (the *other* HTTP-shaped integration)
