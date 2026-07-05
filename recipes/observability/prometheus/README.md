# Prometheus metrics with act-otel

You want a dashboard and a pager, not a printf. Act's core ships no metrics on purpose — the lifecycle events are the seam — and [`@rotorsoft/act-otel`](https://www.npmjs.com/package/@rotorsoft/act-otel) is the bridge that turns them into a Prometheus scrape. This recipe is the operator side: what to wire, what to alert on, and a runnable example that produces a real scrape including a poison stream landing on the gauge.

## Run it

```bash
npx tsx recipes/observability/prometheus/examples/instrumented-app.ts
```

The example places three orders, lets reactions fulfill two of them, and feeds one poison SKU whose reaction exhausts its retry budget and blocks. The scrape it prints ends like this:

```
act_events_committed_total{name="OrderPlaced"} 3
act_reactions_acked_total{lane="default"} 4
act_reactions_blocked_total{lane="default"} 1
act_streams_blocked 1
```

That last line is the one your pager cares about.

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
