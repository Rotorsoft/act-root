# @rotorsoft/act-otel

_Prometheus metrics for Act apps — one call, the canonical metric set, zero changes to your domain code._

## Why this package

Act deliberately ships no metrics in core: the lifecycle events plus the Logger port are the observability seam, and specialized tooling plugs in. The [observability guide](https://rotorsoft.github.io/act-root/docs/guides/observability) shows the canonical hand-wiring from those events to prom-client. This package is that wiring, shipped: `instrument(app)` subscribes to the lifecycle events and maintains the guide's metric set on a registry you own.

What it is not, on purpose: there are no spans and no trace propagation — this is metrics only. Log shipping to OpenTelemetry stays the pino adapter's job (`@rotorsoft/act-pino` with an OTel transport). If you prefer to wire metrics by hand, the guide remains the reference; this package saves you the sixty lines and keeps the names consistent.

## Installation

```bash
pnpm add @rotorsoft/act-otel prom-client
```

`prom-client` is a peer dependency by design — metrics land on **your** registry instance, so a bundled copy could never split `register.metrics()` output.

## Quick start

```typescript
import { act, dispose } from "@rotorsoft/act";
import { instrument } from "@rotorsoft/act-otel";
import { register } from "prom-client";

const app = act().withState(Task).build();

// Subscribe the bridge; register its disposer with Act's registry so
// Ctrl-C tears it down with everything else.
dispose(instrument(app));

// Serve the scrape endpoint on whatever HTTP surface you already have:
root.get("/metrics", async (c) => c.text(await register.metrics()));
```

The metric set, all prefixed `act_` (configurable via `prefix`):

| Metric | Type | Labels | Watch it because |
|---|---|---|---|
| `act_streams_blocked` | gauge | — | **Page on > 0** — poison messages are parked |
| `act_errors_total` | counter | `circuit` | **Page on `circuit="open"` growth** — the store is failing |
| `act_events_committed_total` | counter | `name` | Throughput per event type |
| `act_reactions_acked_total` | counter | `lane` | Reaction progress per lane |
| `act_reactions_blocked_total` | counter | `lane` | Quarantine rate per lane |
| `act_settled_total` | counter | — | Settle cadence |
| `act_streams_closed_total` | counter | — | Close-the-books activity |
| `act_events_forgotten_total` | counter | — | GDPR erasure audit trail |
| `act_notifications_total` | counter | — | Cross-process wakeups |

Label cardinality is bounded by design (event names come from the registry, lanes are declared at build). There is deliberately no per-stream label — stream ids are unbounded and would blow up a Prometheus instance. The blocked-streams gauge evaluates on each scrape via `app.blocked_streams()`, capped by `blockedStreamsLimit` (default 1000).

Options: `registry` (defaults to prom-client's global registry), `prefix` (default `act_`, validated Prometheus-legal at startup), `blockedStreamsLimit`. Out-of-range options throw a `ZodError` at `instrument(...)`, not on the first scrape.

## Related packages

- [`@rotorsoft/act`](https://www.npmjs.com/package/@rotorsoft/act) — the core framework whose lifecycle events this bridges
- [`@rotorsoft/act-pino`](https://www.npmjs.com/package/@rotorsoft/act-pino) — structured logs, including the OpenTelemetry transport path
- [`prom-client`](https://www.npmjs.com/package/prom-client) — the Prometheus client this registers on (peer)

## Documentation

- [Observability guide](https://rotorsoft.github.io/act-root/docs/guides/observability) — the seam, the hand-wiring this packages, and the page-vs-dashboard alerting split
- [Production checklist](https://rotorsoft.github.io/act-root/docs/guides/production-checklist)
- [API reference](https://rotorsoft.github.io/act-root/docs/api/act-otel/src)

## License

MIT
