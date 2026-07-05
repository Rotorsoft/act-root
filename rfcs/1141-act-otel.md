# RFC 1141: `@rotorsoft/act-otel` — Prometheus metrics bridge

- **Status:** accepted <!-- draft | accepted | rejected | superseded -->
- **Issue:** #1141
- **Author:** rotorsoft
- **Created:** 2026-07-05

## Motivation

The review-3 audit scored observability against the framework's stated
scope and settled the stance: core ships no metrics — lifecycle events
plus the Logger port are the seam. The observability guide (#1117) then
documented the canonical hand-wiring from those events to prom-client.
This RFC ships that wiring as a leaf package, per the standing rule that
integration helpers live in separate packages (precedent: act-pino,
act-crypto, act-http): an operator writes `dispose(instrument(app))` and
serves `register.metrics()` instead of copying sixty lines.

## Public surface added

All from the `@rotorsoft/act-otel` root entry point:

- `instrument(app, options?): Disposer` — subscribes to the lifecycle
  events (`committed`, `acked`, `blocked`, `settled`, `closed`,
  `forgotten`, `notified`, `error`) and maintains the guide's canonical
  metric set on a prom-client registry; the returned `Disposer` detaches
  the listeners and unregisters the metrics, and slots directly into
  Act's `dispose(...)` registry.
- `InstrumentOptions` — `{ registry?; prefix?; blockedStreamsLimit? }`,
  Zod-validated at the entry point per the config-validation convention
  (`InstrumentOptionsSchema` internal, `DEFAULT_*` constants).
- `DEFAULT_METRIC_PREFIX`, `DEFAULT_BLOCKED_STREAMS_LIMIT`.

The `app` parameter is a minimal structural type (the `ActSurface`
pattern from the act-http transports): `on`, `off`, `blocked_streams` —
no coupling to the orchestrator's generics.

`prom-client` and `zod` are **peer dependencies**. prom-client
especially must never be bundled or owned: metrics have to land on the
consumer's registry instance, or `register.metrics()` output splits —
the same single-instance class of bug as the vitest bundling fixed in
#1150.

## Alternatives considered

- **OpenTelemetry-metrics-first (`@opentelemetry/api`)** — rejected for
  v1: it pulls the OTel dependency graph into every consumer for a
  facade most will scrape with Prometheus anyway, and the guide's
  canonical wiring is prom-client. An `/otel` subpath can be added
  additively if demand appears; the package name keeps that door open.
- **Spans / trace propagation** — out of scope, stated in the README.
  Logs ship via act-pino's OTel transport; correlation ids remain the
  join key. A tracing story would be its own RFC.
- **Metrics in core (an `ActOptions.metrics` hook)** — rejected long
  ago and re-affirmed in review-3: core stays metrics-free; the
  lifecycle emitter is the contract.
- **Per-stream labels** — rejected: unbounded cardinality. The bridge
  exposes only bounded labels (event names, lanes, circuit states), and
  the blocked-streams gauge is a scrape-time count, not a per-stream
  series.

## Stability impact

Additive: a new leaf package; no core, port, or builder change. The
package opts into the stability snapshot like every sibling. Metric
*names* are part of the package's public contract from 0.1.0 — renames
after adoption are breaking for dashboards and will be treated as
majors.
