# RFC 1196: bound the per-connection SSE pending buffer

- **Status:** draft
- **Issue:** #1196
- **Author:** Roger Torres
- **Created:** 2026-07-11

## Motivation

The auto-generated SSE transports (`trpc`, `hono`) share one subscription loop,
`runSseSubscription`, that fans a `BroadcastChannel`'s publications out to each
open connection. A connection that stalls — a slow client, a backgrounded
browser tab, a paused reader — can't drain frames as fast as a busy stream
publishes them. Today every publication is pushed onto an unbounded in-memory
`pending` array, so one wedged consumer on a hot stream grows process memory
without any backpressure. This is per-connection and distinct from the existing
connection-count cap (`maxConnections`): you can be well under the connection
cap and still OOM on a single slow reader.

Operators have no knob to bound this today. The fix gives them a validated one,
defaulted so the common case needs no tuning, and picks drop-oldest semantics
because each SSE frame carries a full version-keyed patch — a consumer that
misses intermediate versions still converges on current state on the next frame
it reads.

## Public surface added

All on the `@rotorsoft/act-http/api` subpath (the shared SSE-wiring seam):

- **Public type field** — `SseOptions.maxPendingPerConnection?: number`. Hard cap
  on the per-connection undelivered-frame backlog. Default `256`, validated range
  `[1, 100_000]`. At the bound the oldest frame is dropped (drop-oldest).
- **Public type field** — `SseConfig.maxPendingPerConnection: number` (the
  resolved, defaulted counterpart, `@internal`).
- **Export** — `const DEFAULT_SSE_MAX_PENDING_PER_CONNECTION = 256`, alongside the
  existing `DEFAULT_SSE_MAX_CONNECTIONS` / `DEFAULT_SSE_HEARTBEAT_MS`.
- **Export (type)** — `RunSseOptions = { on_cap_exceeded?: () => never; maxPending?: number }`,
  the options bag now passed as the fifth argument to `runSseSubscription`. This
  replaces the prior bare `on_cap_exceeded?: () => never` fifth positional
  parameter (see stability note below).

Naming follows [CLAUDE.md § Naming conventions](../CLAUDE.md#naming-conventions):
public camelCase field (`maxPendingPerConnection`), SCREAMING_SNAKE default
constant, PascalCase `RunSseOptions` type.

## Alternatives considered

- **Do nothing.** Rejected: the unbounded growth is a real memory-exhaustion
  path on any busy stream with a stalled reader, and there's no operator knob to
  mitigate it.
- **Disconnect a too-far-behind consumer instead of dropping frames.** Cleaner in
  theory (the client gets an explicit reconnect signal) but heavier: it needs a
  disconnect path threaded back through both transports and forces the client to
  re-establish and re-fetch cached state. Drop-oldest degrades gracefully with no
  client-side change — the reader simply skips versions and converges — so it's
  the smaller, lower-risk fix. A disconnect-on-overflow policy can be layered
  later as an additional option value if a caller needs it.
- **Coalesce to a single latest-full-state entry.** Would bound the buffer to 1,
  but the loop yields `PatchMessage`s (version-keyed patches), not full states;
  collapsing them would require the loop to know how to merge patches, which is
  app-specific. Drop-oldest keeps the loop payload-agnostic.
- **Keep the fifth positional `on_cap_exceeded` and add a sixth `maxPending`
  parameter.** Rejected: a growing positional tail is the exact anti-pattern the
  options-bag convention exists to prevent. Bundling both into `RunSseOptions`
  keeps future per-subscription knobs additive.

## Stability / charter impact

- Category: **public types** on the `@rotorsoft/act-http` package (governed by its
  own `stability.spec.ts` snapshot, not the core charter).
- `maxPendingPerConnection` on `SseOptions` / `SseConfig` and the new default
  constant are **additive**.
- The `runSseSubscription` fifth parameter changes shape from
  `on_cap_exceeded?: () => never` to `options?: RunSseOptions`. `runSseSubscription`
  is an exported seam, so this is technically a signature change — but it has no
  published external callers other than the two in-tree transports (both updated
  in this PR), so per the pre-adoption convention it ships as a MINOR, not a
  breaking change. The old `on_cap_exceeded` behavior is preserved verbatim as
  `RunSseOptions.on_cap_exceeded`.
- No port method added; no TCK impact.

## Open questions

None.
