# Prometheus metrics with act-otel

You want a dashboard and a pager, not a printf. Act's core ships no metrics on purpose — the lifecycle events are the seam — and [`@rotorsoft/act-otel`](https://www.npmjs.com/package/@rotorsoft/act-otel) is the bridge that turns them into a Prometheus scrape. This recipe is the operator side: what to wire, what to alert on, and a runnable example that produces a real scrape including a poison stream landing on the gauge.

## Run it — terminal scrape in thirty seconds

```bash
npx tsx recipes/observability/prometheus/examples/instrumented-app.ts
```

The one-shot example places three orders, lets reactions fulfill two of them, and feeds one poison SKU whose reaction exhausts its retry budget and blocks. The scrape it prints ends like this:

```
act_events_committed_total{name="OrderPlaced"} 3
act_reactions_acked_total{lane="default"} 4
act_reactions_blocked_total{lane="default"} 1
act_streams_blocked 1
```

That last line is the one your pager cares about.

## Watch it live — the Prometheus UI

The live demo is a self-contained app that generates its own traffic: continuous orders, a fulfillment reaction on its own lane, a flaky notification reaction (own lane, exponential backoff) failing a fifth of its attempts, a poison SKU every tenth order that blocks — and an operator loop unblocking the quarantine every twenty seconds, so the blocked gauge saws instead of climbing.

```bash
pnpm dev:metrics
```

One command: starts Prometheus in docker, runs the demo, prints the UI link, and tears the container down on Ctrl-C. (Manual equivalent: `docker compose -f recipes/observability/prometheus/docker-compose.yml up -d` + `npx tsx recipes/observability/prometheus/examples/live-demo.ts`.) Then open:

**http://localhost:9090/graph?g0.expr=rate(act_events_committed_total[30s])&g0.tab=0&g1.expr=act_streams_blocked&g1.tab=0**

Prometheus scrapes the demo's `/metrics` on :4001 every two seconds. The panels worth watching:

| Expression | What you see |
|---|---|
| `rate(act_events_committed_total[30s])` | steady commit throughput, by event name |
| `act_streams_blocked` | the sawtooth: poison blocks, the operator loop unblocks |
| `rate(act_reactions_acked_total[30s])` | per-lane progress — notifications wobble from the flaky downstream |
| `rate(act_errors_total[1m])` | should stay flat; a rise means the store itself is failing |

Ctrl-C tears everything down: act's disposal closes the HTTP server, the traffic loops, and the bridge; the run script then stops the Prometheus container.

## The wiring

Three lines in your bootstrap, one route on whatever HTTP surface you already serve:

```ts no-check
import { dispose } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";

dispose(instrument(app)); // torn down with the app on SIGINT/SIGTERM
root.get("/metrics", async (c) => c.text(await register.metrics()));
```

`prom-client` is a peer dependency — metrics land on **your** registry, so the bridge's output serves alongside anything else you export.

## What to alert on

The split from the [observability guide](https://rotorsoft.github.io/act-root/docs/guides/observability) — pages first, dashboards second:

```yaml
# Page: poison messages are parked and waiting for a human.
- alert: ActStreamsBlocked
  expr: max(act_streams_blocked) > 0
  for: 5m

# Page: the store is failing and the breaker opened.
- alert: ActCircuitOpen
  expr: increase(act_errors_total{circuit="open"}[5m]) > 0
```

Dashboard material: `rate(act_events_committed_total[5m])` per event name for throughput, `rate(act_reactions_acked_total[5m])` per lane for reaction progress, `act_reactions_blocked_total` growth per lane for quarantine trends.

Recovery when the blocked page fires is the standard playbook: `app.blocked_streams()` to see what and why, fix the downstream, `app.unblock(...)` to resume — see [error handling](https://rotorsoft.github.io/act-root/docs/concepts/error-handling). The gauge drops on the next scrape after the unblock.

## Multi-worker note

Every counter is per-process — aggregate in PromQL (`sum by (lane)`), never in the app. The one exception that *looks* global is `act_streams_blocked`: every worker polls the same store, so all instances report the same value — use `max()` in the alert rule, as above.

## When not to use this

If you already run an OpenTelemetry collector and want OTLP metrics end to end, wire the lifecycle events to the OTel metrics API by hand (the guide's hand-wiring section is the template — swap prom-client for your meter). The bridge is deliberately prom-client-first; an OTLP surface would be its own addition.
