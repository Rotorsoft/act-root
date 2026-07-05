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

The live demo is interactive and web-first — nothing moves until you do, and everything is driven from the app's own dashboard. `pnpm dev:metrics` brings up the stack and prints one link: **http://localhost:4001**. The page is the cockpit — a three-step guide, links to Grafana and Prometheus, buttons that fire order batches, a poison order whose fulfillment stream visibly retries then blocks (~15s), and the operator's fix-and-unblock button that ships the stuck order — with projection tiles and an event feed updating over SSE as events commit. Under the hood: fulfillment and notification reactions on their own lanes, the notifier flaky on purpose with exponential backoff, a projection counting orders.

```bash
pnpm dev:metrics
```

One command: starts Prometheus + a pre-provisioned Grafana in docker, runs the demo, and tears the containers down on Ctrl-C. Open the dashboard and keep Grafana beside it:

- **http://localhost:3001/d/act-demo** — the Grafana dashboard: a 2×2 grid that fits one screen (commit throughput, a blocked-streams stat that goes red, per-lane ack rate, blocks + errors), refreshing every 5s, no login.
- **http://localhost:4001/** — the app itself: projection tiles and an event feed updating over SSE as events commit, with the same action buttons the console keys drive.

Prometheus scrapes the demo's `/metrics` every two seconds — each action lands on the dashboard within a refresh. Raw PromQL, if you prefer it over Grafana (`http://localhost:9090`):

| Expression | What you see |
|---|---|
| `rate(act_events_committed_total[30s])` | steady commit throughput, by event name |
| `act_streams_blocked` | rises ~15s after poison, falls on fix & unblock |
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
