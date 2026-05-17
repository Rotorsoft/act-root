# @rotorsoft/act-sse

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-sse.svg)](https://www.npmjs.com/package/@rotorsoft/act-sse)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-sse.svg)](https://www.npmjs.com/package/@rotorsoft/act-sse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Incremental state broadcast over Server-Sent Events for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) event-sourced apps._

> [!WARNING]
> **This package is being deprecated.** Its surface lives on as the `@rotorsoft/act-http/sse` subpath of the [@rotorsoft/act-http](https://www.npmjs.com/package/@rotorsoft/act-http) umbrella package, which consolidates webhook and SSE integrations under one install.
>
> New projects: install `@rotorsoft/act-http` and import from the `/sse` subpath. Existing projects: migration is a one-import change (see below). This package will receive bug fixes only and be removed in a future release.

## Migration to `@rotorsoft/act-http/sse`

`@rotorsoft/act-http/sse` is a verbatim copy of this package's surface — same classes, same functions, same wire format, same semantics. Migration is one import change per file:

```diff
- import { BroadcastChannel, applyPatchMessage } from "@rotorsoft/act-sse";
+ import { BroadcastChannel, applyPatchMessage } from "@rotorsoft/act-http/sse";
```

Then:

```bash
pnpm remove @rotorsoft/act-sse
pnpm add @rotorsoft/act-http
```

The umbrella package keeps SSE and `webhook` as independent subpath exports (`@rotorsoft/act-http/sse` and `@rotorsoft/act-http/webhook`) — nothing in one depends on the other, so the bundle cost is the same. Future HTTP-adjacent integrations (OAuth refresh, signed-webhook senders, gRPC-web) will land as additional subpaths rather than separate packages.

## What this package does (legacy)

Instead of sending full aggregate state after each action, `act-sse` forwards the domain patches that event handlers already compute — sending only what changed as version-keyed partials. The wire format, server surface (`BroadcastChannel`, `PresenceTracker`, `StateCache`, `publishOverlay`), and client patch applicator (`applyPatchMessage`) are all preserved unchanged in `@rotorsoft/act-http/sse`.

For the full reference (architecture diagram, wire format, server + client usage, version contract, bandwidth savings), see the [@rotorsoft/act-http README](https://github.com/Rotorsoft/act-root/blob/master/libs/act-http/README.md#sse--incremental-state-broadcast).

## Installation (legacy)

Still works. New projects should use `@rotorsoft/act-http` instead.

```bash
pnpm add @rotorsoft/act-sse
```

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md) — but this package is on the deprecation track. New work goes to `@rotorsoft/act-http/sse`.

## Related packages

- **[@rotorsoft/act-http](https://www.npmjs.com/package/@rotorsoft/act-http)** ← **migrate here.** The umbrella package that now owns SSE + webhook integrations.
- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — core framework.
- **[@rotorsoft/act-patch](https://www.npmjs.com/package/@rotorsoft/act-patch)** — immutable patch utility this package uses for state merging.

## Documentation

- **[Real-time with SSE](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/concepts/real-time.md)** — the concept guide; same content applies to `@rotorsoft/act-http/sse`.
- **[@rotorsoft/act-http README](https://github.com/Rotorsoft/act-root/blob/master/libs/act-http/README.md)** — full SSE reference at its new home.

## License

MIT
