---
id: observability
title: Observability
description: Canonical wiring from lifecycle events to Prometheus metrics, and from the Logger port to OpenTelemetry log shipping.
---

# Observability

Observability is deliberately **not** a framework feature. Act doesn't bundle a metrics client, doesn't emit spans, and doesn't pick a vendor. What it gives you instead is a seam with two sides:

- **Lifecycle events** — the orchestrator emits a typed event for every operationally interesting moment (`committed`, `acked`, `blocked`, `settled`, `forgotten`, `closed`, `notified`, `error`). Everything a dashboard needs is in those payloads.
- **The Logger port** — every framework log line goes through one swappable interface. Point it at pino and you inherit pino's entire transport ecosystem, including OpenTelemetry log shipping.

This page is the canonical wiring for both sides, using [prom-client](https://github.com/siimon/prom-client) as the metrics example. The same shape works for StatsD, Datadog, or anything else with counters, gauges, and histograms — only the client calls change.

## The lifecycle events

Register listeners with `app.on(name, listener)`. The payloads below are the actual types from `ActLifecycleEvents` — not paraphrases:

| Event | Payload | Fires when |
|---|---|---|
| `committed` | `Snapshot[]` — each with `state`, `event`, `version`, `patches`, `snaps` | A local `app.do()` commits events |
| `acked` | `Lease[]` — `{ stream, source?, at, by, retry, lagging, lane? }` | A drain cycle acknowledges processed streams |
| `blocked` | `BlockedLease[]` — a `Lease` plus `error: string` | A stream exhausts its retry budget (or a handler throws `NonRetryableError`) |
| `settled` | `Drain` — `{ fetched, leased, acked, blocked }`, accumulated across every pass of the settle | A settle completes (reaches quiescence) |
| `closed` | `CloseResult` — `{ truncated, skipped }` | A close-the-books run finishes |
| `notified` | `StoreNotification` — `{ stream, events: [{ id, name }] }` | A **different process** commits to the same store |
| `forgotten` | `{ stream, at: Date, eventCount }` | `app.forget(stream)` wipes a stream's sensitive payloads |
| `error` | `{ error, circuit }` | A store operation fails during the drain loop (circuit-breaker state attached) |

Two things to know before wiring:

- **Listeners run synchronously on the emitter.** Keep them cheap — increment a counter, observe a histogram, return. Anything slow belongs in a reaction, not a lifecycle listener.
- **A throwing listener is contained, not fatal.** Containment lives in `Act.emit` and wraps **each listener individually**, so the framework logs the throw and carries on: the cycle still finalizes, every *other* listener on that event still fires, `drain()` still returns its result, and `do()` / `forget()` / `close()` still resolve — they emit after their durable work has landed, so failing them would report a completed operation as failed and invite a duplicate retry ([#1437](https://github.com/Rotorsoft/act-root/issues/1437)). Your metric is wrong for that event and nothing else is. This covers *observers* only: a real `ConcurrencyError` or `StoreError` from the operation itself still reaches you. Don't rely on containment to paper over a broken bridge — check your logs for `listener threw`.
- **Label cardinality is your problem, not the framework's.** `Lease.stream` can be one stream per aggregate when you use dynamic reaction targets. Feeding raw stream names into a Prometheus label will blow up your time-series count. Label by `lane`, by a derived family (`stream.split("-")[0]`), or not at all.

## Metrics: install the bridge

[`@rotorsoft/act-otel`](https://www.npmjs.com/package/@rotorsoft/act-otel) wires the lifecycle events to prom-client in one call, with the cardinality guards above built in:

```ts no-check
import { dispose } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";

dispose(instrument(app)); // metric set below, torn down with the app
root.get("/metrics", async (c) => c.text(await register.metrics()));
```

It maintains these series (prefix `act_` by default; see the [act-otel README](https://github.com/Rotorsoft/act-root/tree/master/libs/act-otel#readme) for options):

| Metric | Type | Labels | Use |
|---|---|---|---|
| `act_streams_blocked` | gauge | — | **Page on > 0**: poison messages are parked. Polled from `app.blocked_streams()` on each scrape. |
| `act_errors_total` | counter | `circuit` | **Page on `circuit="open"` growth**: the store is failing |
| `act_events_committed_total` | counter | `name` | Throughput per event type |
| `act_reactions_acked_total` | counter | `lane` | Reaction progress per lane |
| `act_reactions_blocked_total` | counter | `lane` | Quarantine rate per lane |
| `act_settled_total` | counter | — | Settle cadence |
| `act_streams_closed_total` | counter | — | Close-the-books activity |
| `act_events_forgotten_total` | counter | — | GDPR erasure audit trail |
| `act_notifications_total` | counter | — | Cross-process wakeups |

To wire something else (a different client, custom buckets, per-tenant registries), read [the bridge's source](https://github.com/Rotorsoft/act-root/blob/master/libs/act-otel/src/index.ts): it is a short list of `app.on(...)` listeners.

## Two signals the bridge doesn't cover

The [production checklist](./production-checklist.md#8-observability) also asks for settle latency and concurrency errors. Neither comes from a single lifecycle event, so wire them yourself; the names below are this guide's, not the bridge's.

**Settle latency.** `settled` carries drain results, not timestamps, so measure the gap between the first commit and the next `settled`. Because `settle()` coalesces bursts, one observation can cover several commits, which is the right meaning for end-to-end reaction lag:

```typescript no-check
import { Histogram } from "prom-client";

const settleDuration = new Histogram({
  name: "act_settle_duration_ms",
  help: "Commit-to-settled latency in milliseconds",
  buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
});

let commit_t0: number | undefined;
app.on("committed", () => {
  commit_t0 ??= performance.now(); // first commit since the last settle
  app.settle();
});
app.on("settled", () => {
  if (commit_t0 !== undefined) {
    settleDuration.observe(performance.now() - commit_t0);
    commit_t0 = undefined;
  }
});
```

**Concurrency errors.** `ConcurrencyError` never reaches a lifecycle listener: `app.do()` throws it when the `expectedVersion` check fails. Count it where you already catch it, at the API edge (once, in error middleware):

```typescript no-check
import { ConcurrencyError } from "@rotorsoft/act";
import { Counter } from "prom-client";

const concurrencyErrors = new Counter({
  name: "act_commit_concurrency_errors_total",
  help: "Commits rejected by optimistic concurrency",
});

try {
  await app.do("transfer", { stream, actor, expectedVersion }, payload);
} catch (err) {
  if (err instanceof ConcurrencyError) concurrencyErrors.inc(); // surface a 409
  throw err;
}
```

### Multi-process deployments

Every metric above is per-process — prom-client aggregates nothing across workers, and neither does Act. That's the right default: `sum()` and `max()` belong in PromQL, where you can slice by instance. The one metric that *looks* global is the `act_streams_blocked` gauge, because every worker polls the same store — expect identical values from every instance and `max()` over them in the alert rule.

## Logs → OpenTelemetry (via pino)

The [`@rotorsoft/act-pino`](https://www.npmjs.com/package/@rotorsoft/act-pino) adapter passes its `options` bag straight through to pino, which means any pino transport works — including [`pino-opentelemetry-transport`](https://github.com/pinojs/pino-opentelemetry-transport), which ships log records over OTLP to a collector:

```typescript no-check
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

log(new PinoLogger({
  pretty: false, // required: pretty mode overrides the transport option
  options: {
    transport: {
      target: "pino-opentelemetry-transport",
      // endpoint/protocol via standard OTEL_EXPORTER_OTLP_* env vars
    },
  },
}));
```

One caveat from the adapter's implementation: `pretty` defaults to `true` outside production and, when set, replaces `options.transport` with `pino-pretty`. Set `pretty: false` explicitly (or run with `NODE_ENV=production`) or the OTel transport silently never engages.

Be clear about what this buys you: **log shipping, not tracing.** Act does not create OpenTelemetry spans, does not propagate trace context into reaction handlers, and has no plans to — that's a scope decision, not a gap. The framework's join key is the **correlation id**: every committed event carries `meta.correlation`, originating actions get one from the (pluggable) `correlator`, and reactions inherit it from the event they're reacting to. Log it at your API edge and the whole causal chain — action, events, reactions, reactions-to-reactions — is greppable in your log backend without a tracing SDK in the hot path. If you want real distributed traces across your HTTP tier, instrument that tier with the OTel SDK directly and stuff the trace id into your correlator; Act will thread it through every downstream event for free.

## Where the inspector fits

> **Reading lag correctly.** A subscription's watermark advances only over events that *resolve to it*, so a reaction handling a subset of a state's events sits permanently below the stream's head with nothing pending. Distance to the head is therefore an upper bound, not a backlog — compare a subscription's `at` against its own `correlated_at` for the real answer ([#1521](https://github.com/Rotorsoft/act-root/issues/1521)). The inspector does this; anything you build on `query_streams` should too.

The `act-inspector` workspace package is **incident forensics, not continuous monitoring**. It reads the same `query_streams` / `query` primitives your metrics poll, but through a UI built for a human mid-incident: which streams are blocked, what the last error was, how much work a projection still has waiting, what a specific stream's event history looks like. When the `act_streams_blocked` alert fires, the inspector is where you go to decide between `app.unblock()` and a code fix — pointed at the production store read-only, or at a snapshot copy. It is not a runtime dependency, it doesn't scrape, and nothing on this page replaces it or is replaced by it.

## What pages, what doesn't

| Signal | Severity | Rationale |
|---|---|---|
| `act_streams_blocked > 0` for more than a minute | **Page** | A blocked stream means a reaction has stopped making progress and will not self-heal — every minute widens the gap between the event log and its consumers. Recovery is a human decision (`unblock` vs fix-then-unblock). |
| `act_errors_total{circuit="open"}` growing | **Page** | The drain loop's store is down and the orchestrator has backed off. Commits may still be failing at the edge too. |
| `act_commit_concurrency_errors_total` (hand-wired) rate sustained above ~1% of commits | Dashboard, ticket | Occasional conflicts are optimistic concurrency working as designed. A sustained rate means contention on hot streams — an aggregate-boundary design question, not an outage. |
| `act_settle_duration_ms` (hand-wired) p99 above your lag tolerance | Dashboard, ticket | Reactions are falling behind. Look at lane sizing and handler latency before anything else. |
| `act_reactions_acked_total` / `act_events_committed_total` throughput | Dashboard only | Capacity planning and anomaly spotting ("why did commits drop to zero at 3am?") — alert on the business symptom, not these numbers directly. |
| `act_events_forgotten_total` | Audit log only | A compliance trail, not a health signal. Ship it to whatever records your GDPR/CCPA processing. |

The blocked-stream page is the load-bearing one. Everything else degrades gracefully; a blocked stream does not — see [Error handling → Blocked streams](../concepts/error-handling.md) for the recovery playbook the page should link to.
