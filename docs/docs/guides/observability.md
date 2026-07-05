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
| `settled` | `Drain` — `{ fetched, leased, acked, blocked }` | A settle pass completes |
| `closed` | `CloseResult` — `{ truncated, skipped }` | A close-the-books run finishes |
| `notified` | `StoreNotification` — `{ stream, events: [{ id, name }] }` | A **different process** commits to the same store |
| `forgotten` | `{ stream, at: Date, eventCount }` | `app.forget(stream)` wipes a stream's sensitive payloads |
| `error` | `{ error, circuit }` | A store operation fails during the drain loop (circuit-breaker state attached) |

Two things to know before wiring:

- **Listeners run synchronously on the emitter.** Keep them cheap — increment a counter, observe a histogram, return. Anything slow belongs in a reaction, not a lifecycle listener.
- **Label cardinality is your problem, not the framework's.** `Lease.stream` can be one stream per aggregate when you use dynamic reaction targets. Feeding raw stream names into a Prometheus label will blow up your time-series count. Label by `lane`, by a derived family (`stream.split("-")[0]`), or not at all.

## Or: install the bridge

Everything in the next two sections ships pre-wired as [`@rotorsoft/act-otel`](https://www.npmjs.com/package/@rotorsoft/act-otel):

```ts no-check
import { dispose } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";

dispose(instrument(app)); // canonical metric set, torn down with the app
root.get("/metrics", async (c) => c.text(await register.metrics()));
```

Same metric names, same cardinality guards, one call. The hand-wiring below remains the reference — read it to understand what the bridge does, or copy it when you need a shape the bridge doesn't cover (custom buckets, a different client, per-tenant registries).

## Lifecycle events → prom-client

The [production checklist](./production-checklist.md#8-observability) names three signals that cover most operational questions: `act.streams.blocked`, `act.commit.concurrency_error`, and `act.settle.duration_ms`. Prometheus metric names can't contain dots, so the canonical wiring spells them with underscores — same signals, Prometheus-legal names.

Define the instruments once at bootstrap:

```typescript no-check
// metrics.ts
import { Counter, Gauge, Histogram, Registry } from "prom-client";

export const registry = new Registry();

export const committedEvents = new Counter({
  name: "act_committed_events_total",
  help: "Events committed by this process",
  registers: [registry],
});

export const ackedStreams = new Counter({
  name: "act_acked_streams_total",
  help: "Reaction streams acknowledged by drain cycles",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const blockedStreams = new Counter({
  name: "act_blocked_streams_total",
  help: "Streams that exhausted their retry budget",
  labelNames: ["lane"] as const,
  registers: [registry],
});

export const settleDuration = new Histogram({
  name: "act_settle_duration_ms",
  help: "Commit-to-settled latency in milliseconds",
  buckets: [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000],
  registers: [registry],
});

export const forgottenEvents = new Counter({
  name: "act_forgotten_events_total",
  help: "Event payloads wiped by app.forget() (GDPR/CCPA audit trail)",
  registers: [registry],
});

export const concurrencyErrors = new Counter({
  name: "act_commit_concurrency_errors_total",
  help: "Commits rejected by optimistic concurrency",
  registers: [registry],
});
```

Then attach the listeners. This extends the bootstrap you already have from the checklist (`app.on("committed", () => app.settle())`) — the settle wiring and the metrics wiring live in the same place:

```typescript no-check
// bootstrap.ts
import {
  ackedStreams,
  blockedStreams,
  committedEvents,
  forgottenEvents,
  settleDuration,
} from "./metrics.js";

let commit_t0: number | undefined;

app.on("committed", (snapshots) => {
  committedEvents.inc(snapshots.length);
  commit_t0 ??= performance.now(); // first commit since last settled
  app.settle();
});

app.on("acked", (leases) => {
  for (const { lane } of leases) {
    ackedStreams.inc({ lane: lane ?? "default" });
  }
});

app.on("blocked", (blocked) => {
  for (const { stream, error, retry, lane } of blocked) {
    logger.error({ stream, error, retry }, "stream blocked");
    blockedStreams.inc({ lane: lane ?? "default" });
  }
});

app.on("settled", (drain) => {
  if (commit_t0 !== undefined) {
    settleDuration.observe(performance.now() - commit_t0);
    commit_t0 = undefined;
  }
  // drain.fetched is per-stream: sum event counts if you want throughput.
  // drain.acked / drain.blocked are the same leases the dedicated
  // listeners above already saw — don't double-count them here.
});

app.on("forgotten", ({ stream, eventCount }) => {
  forgottenEvents.inc(eventCount);
  logger.info({ stream, eventCount }, "sensitive data forgotten");
});
```

A note on the latency measurement: `settled` carries drain results, not timestamps, so the histogram above measures what an operator actually cares about — the wall-clock gap between "a commit landed" and "the framework went idle again." Because `settle()` is debounced and coalesces bursts, one observation can cover several commits; that's the correct semantic for end-to-end reaction lag, not a bug in the wiring.

### The blocked-streams gauge

The `blocked` counter above tells you *when* streams block. It doesn't tell you how many are blocked *right now* — a stream unblocked via `app.unblock()` never decrements a counter. For the level, poll `app.blocked_streams()` from a gauge's `collect` hook, which prom-client invokes on every scrape:

```typescript no-check
import { Gauge } from "prom-client";
import { registry } from "./metrics.js";

new Gauge({
  name: "act_streams_blocked",
  help: "Streams currently blocked (polled from the store)",
  registers: [registry],
  async collect() {
    const blocked = await app.blocked_streams({ limit: 1_000 });
    this.set(blocked.length);
  },
});
```

`blocked_streams()` is a thin wrapper over `store().query_streams({ blocked: true })` — one indexed query per scrape, cheap at any realistic scale. The default page size is 100; the explicit `limit` keeps the gauge honest if things go very wrong (and if you ever have a thousand blocked streams, the exact number is no longer the interesting part of the incident).

Expose the registry wherever your HTTP stack lives:

```typescript no-check
httpServer.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

### Concurrency errors

`ConcurrencyError` never reaches a lifecycle listener — it's thrown synchronously by `app.do()` when the `expectedVersion` check fails. Instrument it where you already catch it, at the API edge:

```typescript no-check
import { ConcurrencyError } from "@rotorsoft/act";
import { concurrencyErrors } from "./metrics.js";

try {
  await app.do("transfer", { stream, actor, expectedVersion }, payload);
} catch (err) {
  if (err instanceof ConcurrencyError) {
    concurrencyErrors.inc();
    // surface a 409 to the caller; retrying with a fresh load usually resolves it
  }
  throw err;
}
```

In a tRPC or Express app this lives in the error middleware, once, rather than around every call site.

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

The `act-inspector` workspace package is **incident forensics, not continuous monitoring**. It reads the same `query_streams` / `query` primitives your metrics poll, but through a UI built for a human mid-incident: which streams are blocked, what the last error was, how far a projection's watermark lags the head, what a specific stream's event history looks like. When the `act_streams_blocked` alert fires, the inspector is where you go to decide between `app.unblock()` and a code fix — pointed at the production store read-only, or at a snapshot copy. It is not a runtime dependency, it doesn't scrape, and nothing on this page replaces it or is replaced by it.

## What pages, what doesn't

| Signal | Severity | Rationale |
|---|---|---|
| `act_streams_blocked > 0` for more than a minute | **Page** | A blocked stream means a reaction has stopped making progress and will not self-heal — every minute widens the gap between the event log and its consumers. Recovery is a human decision (`unblock` vs fix-then-unblock). |
| `error` lifecycle event with `circuit: "open"` | **Page** | The drain loop's store is down and the orchestrator has backed off. Commits may still be failing at the edge too. |
| `act_commit_concurrency_errors_total` rate sustained above ~1% of commits | Dashboard, ticket | Occasional conflicts are optimistic concurrency working as designed. A sustained rate means contention on hot streams — an aggregate-boundary design question, not an outage. |
| `act_settle_duration_ms` p99 above your lag tolerance | Dashboard, ticket | Reactions are falling behind. Look at lane sizing and handler latency before anything else. |
| `acked` / `committed` throughput | Dashboard only | Capacity planning and anomaly spotting ("why did commits drop to zero at 3am?") — alert on the business symptom, not these numbers directly. |
| `forgotten` | Audit log only | A compliance trail, not a health signal. Ship it to whatever records your GDPR/CCPA processing. |

The blocked-stream page is the load-bearing one. Everything else degrades gracefully; a blocked stream does not — see [Error handling → Blocked streams](../concepts/error-handling.md) for the recovery playbook the page should link to.
