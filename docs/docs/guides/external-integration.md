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

```ts no-check
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

```ts no-check
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

The dedup contract is shipped as a port — `IdempotencyStore` — in [`@rotorsoft/act-ops`](https://www.npmjs.com/package/@rotorsoft/act-ops), the zero-`act`-dependency home for receiver-side primitives. Three methods, two-phase by design:

```ts no-check
import type { IdempotencyStore } from "@rotorsoft/act-ops/idempotency";

export interface IdempotencyStore {
  claim(key: string, now?: number): boolean | Promise<boolean>;
  commit(key: string, now?: number): void | Promise<void>;
  release(key: string): void | Promise<void>;
}
```

`claim` returns `true` when the key was fresh — but the claim it makes is
**tentative**. A tentative claim dedups a concurrent duplicate that arrives while
the handler is in flight (the second caller sees `false` and serializes behind the
first), yet it is not durable across the sender's own retries until the caller
confirms the outcome:

- `commit(key)` — the handler succeeded; promote the claim to a durable record so
  every later retry of the same key dedups.
- `release(key)` — the handler failed transiently; drop the tentative claim so the
  sender's retry re-processes instead of being deduped into a silent success.
  Releasing a key that was already committed is a no-op.

This two-phase shape is what stops a transient handler failure from permanently
dropping a delivery. A `claim`-and-commit-on-arrival contract records the key
before the handler runs, so a handler that throws still leaves the key claimed —
the sender's retry is then deduped and the delivery is lost. Splitting the commit
out of the claim closes that hole ([#1193](https://github.com/Rotorsoft/act-root/issues/1193)).
The union return types let sync (in-memory) and async (durable) adapters share the
same call site; the receiver adapters await unconditionally.

> **Not a Cache.** In this codebase `Cache` means "rebuildable from a source of truth" (snapshot cache). Dedup state is authoritative — losing it allows duplicate side effects, not just a rebuild. Hence `Store`. The naming distinction matters when you swap implementations: the durable adapter's *persistence* is the load-bearing property, not its hit rate.

`@rotorsoft/act-ops` ships with no peer dep on `@rotorsoft/act`, so a non-Act receiver (a Kafka consumer processing forwarded events, an Express endpoint behind a queue, …) can install the port without dragging the orchestrator along. Act apps and non-Act apps speak the same contract.

### Implementations

Three implementations of the dedup store, ordered by deployment complexity. The first ships in `@rotorsoft/act-ops`; the next two are sketches that follow the same `IdempotencyStore` contract — they're not packaged yet but slot in unchanged once you wire them.

#### `InMemoryIdempotencyStore` from `@rotorsoft/act-ops/idempotency`

```ts no-check
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";

const dedup = new InMemoryIdempotencyStore({
  ttlMs: 24 * 60 * 60 * 1000,  // dedup window (default: 24h)
  maxEntries: 50_000,           // memory bound (default: 100_000)
});

const fresh = dedup.claim(key);
```

Bounded LRU + TTL. Sync return. Use when: receiver is single-process, dedup window is short (under a day), keys fit in RAM. The wolfdesk demo at [`packages/server/src/webhook-receiver.ts`](https://github.com/Rotorsoft/act-root/blob/master/packages/server/src/webhook-receiver.ts) uses this implementation end-to-end.

#### Redis `SET NX EX` (sketch — port not yet packaged)

```ts no-check
class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisClient, private readonly ttlSeconds: number) {}

  async claim(key: string): Promise<boolean> {
    // SET ... NX EX is atomic: returns "OK" only when the key didn't exist.
    // "pending" marks the claim tentative until commit/release.
    const result = await this.redis.set(`idem:${key}`, "pending", "EX", this.ttlSeconds, "NX");
    return result === "OK";
  }

  async commit(key: string): Promise<void> {
    // Promote to durable: refresh the value + TTL so retries dedup.
    await this.redis.set(`idem:${key}`, "committed", "EX", this.ttlSeconds);
  }

  async release(key: string): Promise<void> {
    // Only drop a still-pending claim; a committed key must survive.
    // A small Lua CAS keeps this atomic against a concurrent commit.
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == 'pending' then return redis.call('DEL', KEYS[1]) end`,
      1,
      `idem:${key}`
    );
  }
}
```

Use when: receiver is multi-process, dedup window is hours-to-days, Redis is already in the stack.

#### Postgres unique index (sketch — port not yet packaged)

```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  committed BOOLEAN NOT NULL DEFAULT FALSE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_idempotency_seen_at ON idempotency_keys (seen_at);

-- Background job, runs hourly or daily:
DELETE FROM idempotency_keys WHERE seen_at < NOW() - INTERVAL '7 days';
```

```ts no-check
class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}

  async claim(key: string): Promise<boolean> {
    try {
      // Inserts a tentative (committed = FALSE) row.
      await this.db.query(`INSERT INTO idempotency_keys(key) VALUES ($1)`, [key]);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async commit(key: string): Promise<void> {
    // Idempotent upsert: commit even if the tentative row was lost to a crash.
    await this.db.query(
      `INSERT INTO idempotency_keys(key, committed) VALUES ($1, TRUE)
       ON CONFLICT (key) DO UPDATE SET committed = TRUE`,
      [key]
    );
  }

  async release(key: string): Promise<void> {
    // Only delete a still-tentative row; a committed key must survive.
    await this.db.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND committed = FALSE`,
      [key]
    );
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

```ts no-check
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

### End-to-end example — the high-level adapter (canonical path)

For most receivers, the `receiver` builder from `@rotorsoft/act-http/receiver` is the recommended path. Declare typed handlers fluently with Zod schemas, configure the store + optional secret, call `.build()` to freeze the builder into the `Receiver` runtime, then `.listen()` (long-running Node) or `.fetch(request)` (Lambda / edge). The builder uses Hono internally — one code path covers Node, AWS Lambda, Cloudflare Workers, Vercel Edge, Bun, and Deno.

```ts no-check
import { receiver } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { z } from "zod";

const OrderConfirmedSchema = z.object({
  orderId: z.string(),
  total: z.number(),
});

const escalations = receiver({
  port: 4001,
  store: new InMemoryIdempotencyStore(),
  secret: process.env.WEBHOOK_SECRET,
})
  .on("OrderConfirmed", OrderConfirmedSchema, async (event, ctx) => {
    // event.orderId and event.total are typed via Zod inference
    // ctx.key is the deduplicated Idempotency-Key
    await processOrder(event.orderId, event.total);
  })
  .on("OrderShipped", OrderShippedSchema, async (event, ctx) => {
    await processShipment(event);
  })
  .build();

await escalations.listen();
```

Naming convention: the type is `Receiver` (PascalCase), the factory is `receiver` (lowercase), matching Act's existing builder analogs (`act`, `state`, `slice`, `projection`). The builder mounts each handler at `POST /<eventName>`. Failure responses are uniform across deployment targets:

| Status | Body | When |
|---:|---|---|
| **204** | (empty) | Handler ran successfully, or dedup-skipped silently. Sender stops retrying. |
| **400** | `{ "error": "missing-key" }` | No `Idempotency-Key` header |
| **401** | `{ "error": "missing-signature" \| "missing-timestamp" \| "stale" \| "future" \| "bad-signature" }` | Signature/timestamp verification failed |
| **422** | `{ "error": "validation-failed", "detail": "..." }` | Schema rejected the body |
| **500** | `{ "error": "handler-failed", "detail": "..." }` | Handler threw — the claim is released, and the sender's retry re-processes |

Successful first-time processing and dedup-skipped re-sends both return 204 — the sender treats both as "accepted, stop retrying." The receiver's logs distinguish them. On a 500 the builder releases the tentative claim, so the sender's retry under the same `Idempotency-Key` re-runs the handler instead of being deduped into a silent success — a transient failure is never permanently lost.

A runnable version of this lives at [`packages/server/src/webhook-receiver.ts`](https://github.com/Rotorsoft/act-root/blob/master/packages/server/src/webhook-receiver.ts) — point the wolfdesk webhook sender at it (`WOLFDESK_ESCALATION_WEBHOOK=http://localhost:4001/escalations`) and watch verification + dedup work end-to-end.

### Deployment targets

The built `Receiver` is fetch-shaped under the hood — same code runs on every Hono-supported runtime:

**Long-running Node server** (the example above) — call `listen()`. `@hono/node-server` is lazy-loaded so other runtimes don't need it installed.

**AWS Lambda**:

```ts no-check
import { receiver } from "@rotorsoft/act-http/receiver";
import { InMemoryIdempotencyStore } from "@rotorsoft/act-ops/idempotency";
import { handle } from "hono/aws-lambda";

const built = receiver({ port: 0, store: new InMemoryIdempotencyStore() })
  .on("OrderConfirmed", OrderConfirmedSchema, async (event, ctx) => { /* … */ })
  .build();

export const handler = handle({ fetch: built.fetch });
```

**Cloudflare Workers**:

```ts no-check
import { receiver } from "@rotorsoft/act-http/receiver";

const built = receiver({ port: 0, store: new InMemoryIdempotencyStore() })
  .on("OrderConfirmed", OrderConfirmedSchema, async (event, ctx) => { /* … */ })
  .build();

export default { fetch: built.fetch };
```

**Vercel Edge Functions** (Next.js App Router):

```ts no-check
// app/api/webhooks/[name]/route.ts
export const POST = async (request: Request) => built.fetch(request);
```

**Bun / Deno** — same as Cloudflare Workers; export `{ fetch }`.

### Composing into an existing app — low-level middleware

When the receiver needs to compose with an existing HTTP stack (auth middleware, route-level rate limiting, an app already serving other routes), reach for the lower-level `webhookMiddleware` factory:

```ts no-check
import { webhookMiddleware } from "@rotorsoft/act-http/receiver/hono";

// In an existing Hono app — composes with your own routes
app.post(
  "/webhooks/orders",
  authMiddleware,
  webhookMiddleware({ store, secret }),
  async (c) => {
    const { key, deduped } = c.get("idempotency");
    const body = await c.req.json();
    // …
  }
);
```

Available for tRPC (`/receiver/trpc`), Express (`/receiver/express`), Fastify (`/receiver/fastify`), and Hono (`/receiver/hono`). Each exposes `webhookMiddleware(options)` that returns the framework's native middleware shape. Use these when the high-level `receiver` builder is too opinionated for your stack.

**Finalizing the claim.** The `claim` a middleware makes is tentative (see [the port](#the-idempotencystore-port)) — it must be committed on success or released on failure, or a transient error re-runs the double-drop it's meant to prevent. The adapters that wrap the downstream chain finalize automatically: **Hono** and **tRPC** commit when the handler resolves with a 2xx / non-error result and release when it throws (or, for tRPC, returns `{ ok: false }`). **Express** and **Fastify** middleware complete *before* the route handler runs, so they can't observe its outcome — the route handler must call `req.idempotency.commit()` on success or `req.idempotency.release()` on a transient failure:

```ts no-check
app.post("/webhooks/orders", webhookMiddleware({ store, secret }), async (req, res) => {
  const { key, deduped, commit, release } = req.idempotency;
  if (deduped) return res.status(204).end(); // already processed — ack, no side effect
  try {
    await processOrder(req.body);
    await commit();            // durable — later retries dedup
    res.status(204).end();
  } catch (err) {
    await release();           // transient — the sender's retry re-processes
    res.status(500).json({ error: "handler-failed" });
  }
});
```

Skipping both leaves the claim tentative: it still dedups a concurrent duplicate, but it expires on TTL, so the delivery is never permanently lost — it just isn't durably deduped either.

For receivers whose framework isn't in the adapter list (Koa, raw Node `http`, gRPC-over-HTTP) or with custom policy, the framework-agnostic core is also exported. `checkWebhook` claims tentatively; the caller owns commit/release:

```ts no-check
import { checkWebhook } from "@rotorsoft/act-http/receiver";

const result = await checkWebhook(req.headers, rawBody, { store, secret });
if (!result.ok) return reply(result.status, { error: result.reason });
if (result.deduped) return reply(204); // already processed
try {
  await handle({ key: result.key });
  await store.commit(result.key);       // success — dedup future retries
  reply(204);
} catch (err) {
  await store.release(result.key);      // transient — allow re-processing
  reply(500, { error: "handler-failed" });
}
```

Swap `InMemoryIdempotencyStore` for a Redis or Postgres adapter — every layer above stays the same, because every adapter implements the same `IdempotencyStore` port.

### Authenticated delivery — HMAC-SHA256 signing

Idempotency stops you from processing the same event twice. It doesn't stop a third party from sending events you never sent. For receivers that need to verify the request actually came from your Act app — or for any production deployment where the receiver lives on the public internet — pair `webhook({ secret })` on the sender with `verifyWebhook` on the receiver.

**Sender** — add a `secret` to the webhook config:

```ts no-check
import { webhook } from "@rotorsoft/act-http/webhook";

.on("OrderConfirmed")
  .do(
    webhook({
      url: "https://api.example.com/webhooks/orders",
      body: (e) => ({ orderId: e.stream, total: e.data.total }),
      secret: process.env.WEBHOOK_SECRET!,  // ← signs every request
      timeoutMs: 2_000,
    }),
    { maxRetries: 5, backoff: { strategy: "exponential", baseMs: 200, maxMs: 30_000 } }
  )
  .to(resolver)
```

The helper computes HMAC-SHA256 over `${timestamp}.${body}` (where `body` is the final serialized bytes) and attaches two headers:

- `X-Webhook-Signature: sha256=<64-char-hex>`
- `X-Webhook-Timestamp: <unix-seconds>`

The format mirrors the Stripe / GitHub / Slack convention modulo the `X-Webhook-*` prefix. When `secret` is omitted, the helper sends unsigned (back-compat with consumers that don't need signing).

**Receiver** — call `verifyWebhook` before processing:

```ts no-check
import { verifyWebhook } from "@rotorsoft/act-http/receiver";

const SECRET = process.env.WEBHOOK_SECRET!;

const rawBody = await readRawBody(req);  // raw bytes; framework-specific
const result = verifyWebhook(req.headers, rawBody, SECRET);
if (!result.ok) {
  log.warn({ reason: result.reason }, "webhook verification failed");
  return reply.status(401).send({ error: result.reason });
}
// signature + timestamp window are good — proceed to dedup + handle
```

The result is a discriminated union with five distinct failure reasons, each mapping to an operator-meaningful telemetry bucket:

| Reason | Meaning | Likely cause |
|---|---|---|
| `missing-signature` | `X-Webhook-Signature` header absent or unusable | Sender misconfigured (no `secret`), proxy stripped headers |
| `missing-timestamp` | `X-Webhook-Timestamp` header absent or not a parseable integer | Sender misconfigured, header rewrite |
| `stale` | Timestamp older than `maxAgeSeconds` (default 300) | Replay attempt, or client clock badly skewed backwards |
| `future` | Timestamp newer than `now + maxAgeSeconds` | Client clock badly skewed forwards |
| `bad-signature` | Recomputed HMAC didn't match | Wrong secret, tampered body, signature truncation |

Separating the reasons lets your dashboards distinguish "clients losing secrets" from "clients with broken clocks" from "active replay attacks." Constant-time comparison via `crypto.timingSafeEqual` defeats signature-equality timing attacks.

#### Why the receiver needs the raw body, not the parsed one

The signature is over the bytes the sender wrote. Pre-parse normalization on the receiver — JSON re-stringification, whitespace trimming, key reordering — produces a different byte sequence, so the recomputed HMAC won't match. Framework adapters in #744 (tRPC / Express / Fastify / Hono) will provide the raw body alongside the parsed one; until then, capture the raw body in your framework's first middleware (`req.rawBody` in most ecosystems) and pass it to `verifyWebhook` directly.

#### Timestamp window sizing

The default `maxAgeSeconds: 300` (±5 minutes) covers most use cases — it tolerates the worst case of NTP-synced clocks drifting plus normal network latency. Tighten via `verifyWebhook(headers, body, secret, { maxAgeSeconds: 60 })` for stricter replay protection; loosen for clients with worse clock sync. The bound is two-sided: requests too far in the future are rejected too, since a future-dated request smells like clock manipulation.

#### What signing does *not* give you

- **No replay protection beyond the timestamp window.** Two valid requests at the same timestamp are both accepted. Layer `IdempotencyStore.claim` from `@rotorsoft/act-ops/idempotency` on top to dedup at the application level.
- **No payload encryption.** The body is in plaintext; signing protects integrity and authenticity, not confidentiality. Use TLS (you should be doing this anyway).
- **No protection against compromised secrets.** If the secret leaks, the attacker can sign valid requests. Rotate by configuring both sender and receiver with a new secret simultaneously. Stripe-style multi-secret rotation (accept two valid signatures during overlap) is parked for a future ticket — out of scope today.

---

## 4. Operational checklist

The integration is in production. Here's the day-2 surface.

### Monitor blocked streams

Both inline and forwarded paths can end up at the same place — a stream blocked by `block()`. Wire the `"blocked"` lifecycle event into your alerting:

```ts no-check
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

```ts no-check
const blocked = await app.blocked_streams();
console.table(
  blocked.map(({ stream, retry, error, at }) => ({ stream, at, retry, error }))
);
```

For pagination or source filters, drop to `store().query_streams(callback, { blocked: true, ... })` directly.

### Recover after fixing the root cause

`app.unblock(input)` clears the blocked flag and resumes from where the stream stopped — **not** from event 0. Two forms:

```ts no-check
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
