# ACT-602 — `act-http`: a home for HTTP-shaped integrations

## The decision that drove the package layout

ACT-601 closed the last gap in Act's reaction pipeline: per-reaction backoff. Once that landed, the next obvious question came up: "what's the ergonomic way to POST an event to an external webhook?" Every team writes the same `fetch` wrapper — timeout, idempotency key, retry-vs-no-retry on status codes, JSON serialization — and every team gets at least one of those wrong.

The original ticket proposed putting a `httpDeliver` helper in core `@rotorsoft/act`. Two pieces of pushback reshaped that:

1. **The stability charter problem.** Core's surface is locked by [STABILITY.md](../STABILITY.md) at 1.0. Shipping an experimental helper there forces 1.0 stability guarantees on day one and pollutes core with HTTP concerns: status codes, headers, timeouts, auth. The repo's established pattern is one `@rotorsoft/act-*` package per adapter or integration shape — `act-pg`, `act-sqlite`, `act-sse`, `act-pino`, `act-patch`, `act-tck`. Webhook delivery is exactly that shape.
2. **But `act-sse` already exists, and it's HTTP too.** SSE rides on a long-lived `text/event-stream` HTTP response; webhooks ride on outbound POST. Naming a new package `act-webhook` would create the "two packages for HTTP-shaped things" problem; naming it `act-http` would clash with the existing SSE package.

The resolution: an umbrella package, `@rotorsoft/act-http`, with subpath exports. Precedent: `act-tck` is already an umbrella — one package, three TCKs (Store, Cache, Logger) under one roof. By the same principle, `act-http` consolidates webhook + SSE under one install, with subpath exports keeping the two concerns clearly separated internally:

```ts
import { webhook }             from "@rotorsoft/act-http/webhook";
import { broadcast, presence } from "@rotorsoft/act-http/sse";
// future: act-http/oauth, act-http/grpc-web, etc.
```

The standalone `@rotorsoft/act-sse` doesn't go away in this ticket — it stays published while the new package settles in, then becomes a deprecation shim in a follow-up. No breaking change for current consumers.

## What `webhook` actually adds

`webhook` is sugar on top of `.do(handler, { backoff })` from ACT-601. About 100 lines of code in a single file. Behavior:

- POST by default; method configurable.
- `Content-Type: application/json` auto-applied (caller can override case-insensitively).
- `Idempotency-Key` derived from `event.id` — the framework's immutable per-event monotonic integer, the right thing for downstream dedup. Caller can override or skip.
- AbortController-based timeout (default 5s).
- 5xx and network errors throw `WebhookError` with `retryable: true`; 4xx throws with `retryable: false`.
- The `fetch` implementation is injectable for tests.

The whole thing is a thin wrapper. There's no orchestration, no queue, no buffer — `webhook` is just the part of the user's reaction handler that talks to the network. Drain owns ordering, leases, retries, backoff. Webhook owns "given an event and config, make the HTTP call right."

## The two things `webhook` is for — and the one it isn't

The teachable surface of this work isn't the helper itself; it's *when to use it*. Two distinct use-shapes fit:

1. **Cooperative receiver, fast response (under a second or two)**: a webhook to a well-behaved third party, an internal microservice's REST endpoint, a known idempotent API. `webhook` directly. The full reaction cycle — claim, dispatch, ack — completes within the drain's lease window, the receiver does its work, everyone goes home.

2. **Flaky-but-fast receiver**: a third party that returns 5xx under load, a transient DNS issue, a network blip. `webhook` + ACT-601's `backoff` strategy. The drain pipeline holds the lease through the backoff window, paces the next attempt, and converges without operator intervention.

The shape `webhook` is **not** for is **heavy long-running work** — multi-second API calls, large file transfers, bulk fan-out to thousands of receivers. The cost: drain leases aren't free. Holding one for tens of seconds while a slow API churns means competing workers can't pick up other work on that stream, and the reaction's `timeoutMs` has to stay below `leaseMillis` (a few seconds by default) or you risk a parallel re-dispatch.

The Act-native answer for slow work isn't "extend the lease" — it's an **outbox-style fan-out**. The reaction emits a small "needs delivery" event (a cheap, local operation), and a downstream consumer — a separate worker, a Kafka/SQS pipeline, an external scheduler — picks it up and does the slow work at its own pace. Drain stays responsive; the slow path runs on its own schedule.

This is worth a sidebar in the book chapter on external integration: most teams reach for "make the drain wait longer," and the right answer is "don't make the drain wait at all." The framework has a hand-off primitive (the event store itself) — use it.

## The `leaseMillis` floor — and what it means for tuning

A constraint worth calling out explicitly. The drain lease is what guarantees competing workers don't re-dispatch the same event while a handler is in flight. For `webhook`, that creates a coupling: **`timeoutMs` must stay below `leaseMillis`** (with a safety margin) or a slow receiver can hold the lease through expiry, at which point another worker will claim the stream and POST the same event in parallel. The downstream `Idempotency-Key` then has to do the dedup work — a separate concern, and a fragile one if the receiver doesn't dedup correctly.

The pragmatic rule: keep `timeoutMs ≤ leaseMillis - safety_margin`. If you need a longer timeout window, bump `leaseMillis` globally on the Act options. If you need a really long window — say, "this API can take 30 seconds when busy" — you're outside the safe zone for `webhook` and should be on the outbox path.

ACT-602's ticket open question explored whether per-reaction `leaseMillis` could land without changing the `Store` port. Conclusion: a `DrainController` could pick `claim()`'s `leaseMillis` as the max across configured reactions, but the cleaner approach is to forward to an external bus. Per-reaction leases are a knob most apps shouldn't reach for.

## The 4xx-as-non-retryable limitation

A wrinkle worth honest documentation. The original ACT-602 ticket described 4xx responses as "blocking the stream after the first attempt." Implementing it surfaced a real constraint: the drain pipeline (since ACT-601) blocks based on the `retry_count` watermark, not on error type. There's no built-in "this error is non-retryable, skip to block" channel without a core change.

So the helper currently does the right thing semantically — it tags 4xx errors with `retryable: false` — but the drain pipeline doesn't differentiate. A 4xx will be retried up to `maxRetries` just like a 5xx. The pragmatic shape today: callers who want strict client-error behavior set `maxRetries: 0` on the reaction, and both classes block on the first attempt.

This is worth flagging as a follow-up: a `NonRetryableError` in core that drain recognizes and short-circuits would close the gap. It's not in this ticket because it's a core change and the helper has 95% of its value without it. The book chapter on schema-evolution-style "framework enforces what types can't" can mention this as another candidate: "the helper *knows* this is permanent, but the pipeline can't act on that knowledge yet."

## Why subpath exports

The package's two halves don't share code. `webhook` is a single async function plus a typed config; `sse` is a stateful broadcaster, an LRU cache, a presence tracker, and a client-side patch applicator. Combining them at the import level would force every webhook user to drag the SSE surface into their import graph and vice versa.

Subpath exports — `./webhook` and `./sse` — fix that. Tree-shaking still works. README sections stay focused. Future siblings (OAuth refresh, gRPC-web, signed-webhook senders) become additional subpaths rather than additional packages.

The risk: subpaths can drift into a kitchen-sink package if each new addition isn't disciplined about belonging in this umbrella. The principle to hold the line: a subpath belongs in `act-http` if it's about **Act interacting with the outside world over HTTP** — outbound delivery, inbound subscription, request-level auth flows. Anything that's not HTTP-shaped (a queue adapter, a metrics exporter) gets its own package.

## Scaffolding mechanics — the baseline tag

`semantic-release` defaults the first release to `1.0.0` unless told otherwise. For a 0.x experimental package that's the wrong default — once you publish `1.0.0` you've implicitly accepted the stability charter. The fix: tag a baseline `0.0.0` *before the first PR merges to master*, pointing at any commit on master. The first `feat(act-http):` commit then cuts `0.1.0` because conventional-commits' `feat` is a minor bump, and the comparison base is `0.0.0`.

```bash
git tag @rotorsoft/act-http-v0.0.0 <commit-on-master>
git push origin @rotorsoft/act-http-v0.0.0
```

This is a tiny operational detail with outsized consequences: skip it and you ship `1.0.0` without intending to. The contributing-new-package guide documents the full checklist (CI matrix, `.releaserc.json`, docs wiring, scaffold-act-app skill references).

## The named-function requirement

One implementation detail worth noting because it bit during integration: Act's `slice` builder rejects anonymous reaction handlers ("Reaction handler for X must be a named function"). The reason is lifecycle telemetry — the framework records the handler name so operators can attribute drain work to specific code. Closure-returned handlers, like `webhook()`, default to anonymous arrow functions and fail the check.

The fix: return a named function expression (`return async function webhookDeliver(event) { ... }`) instead of an arrow. The runtime cost is zero; the framework now has a name to log.

This is the kind of contract that's invisible until you write the second helper that returns a closure. Worth flagging in the integration / extension-points chapter: handler helpers must return named functions because the framework treats reaction names as first-class metadata.
