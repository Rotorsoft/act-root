# @rotorsoft/act-pino

[![NPM Version](https://img.shields.io/npm/v/@rotorsoft/act-pino.svg)](https://www.npmjs.com/package/@rotorsoft/act-pino)
[![NPM Downloads](https://img.shields.io/npm/dm/@rotorsoft/act-pino.svg)](https://www.npmjs.com/package/@rotorsoft/act-pino)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

_Drop-in [pino](https://getpino.io/) logger adapter for [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)._

## Why this package

Act ships with a built-in `ConsoleLogger` that's adequate for development and small deployments — colorized human-readable output in dev, JSON lines in production. Pino is the right answer when you need anything more: file rotation, OpenTelemetry transport, async sinks, redaction of sensitive fields, request-id binding via child loggers, or any of pino's existing transport ecosystem.

`PinoLogger` implements Act's `Logger` port exactly (validated by the TCK), so swapping it in is a one-line change at bootstrap. No other framework code is affected.

## Installation

```bash
pnpm add @rotorsoft/act-pino
```

## Quick start

```typescript
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

// One line at bootstrap — every framework log call now goes through pino.
log(new PinoLogger());
```

That's the whole integration. Everything below is options and recipes.

## API

- **`PinoLogger`** — class implementing Act's `Logger` port. Construct once, pass to `log()`.
- **`PinoLoggerOptions`** — constructor options (level, pretty toggle, pass-through pino options).

Full type reference: [typedoc](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/api/act-pino/src/README.md).

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `level` | `string` | `config().logLevel` | Log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`) |
| `pretty` | `boolean` | `true` outside production | Enable `pino-pretty` for human-readable output |
| `options` | `pino.LoggerOptions` | `{}` | Pass-through to pino — transports, serializers, redaction, etc. |

```typescript
// Custom log level
log(new PinoLogger({ level: "debug" }));

// Force structured JSON in dev
log(new PinoLogger({ pretty: false }));

// Redaction + custom serializers
log(new PinoLogger({
  options: {
    redact: ["password", "secret", "token"],
    serializers: { req: (r) => ({ method: r.method, url: r.url }) },
  },
}));
```

### Environment integration

`PinoLogger` reads defaults from Act's `config()`, which in turn reads:

- `LOG_LEVEL` — overrides `level` (default `"info"`).
- `LOG_SINGLE_LINE` — affects `pino-pretty` formatting.
- `NODE_ENV=production` — disables pretty-printing by default (structured JSON output).

## Common patterns

### String and object messages

Both forms are supported, matching pino's signature:

```typescript
const logger = new PinoLogger();

logger.info("Server started");                       // string
logger.info({ port: 4000 }, "Server started");        // object + string
logger.info({ event: "startup", port: 4000 });        // object only
```

### Child loggers (inherited bindings)

```typescript
const root = new PinoLogger();
const payments = root.child({ module: "payments" });

payments.info("Processing payment"); // emits { module: "payments", ... }
```

### Graceful shutdown

```typescript
await logger.dispose(); // flushes buffered logs
```

Pair with `dispose()` from `@rotorsoft/act` to wire pino flush into the framework's signal-handler shutdown sequence.

## When to use this vs the default `ConsoleLogger`

| You want… | Use |
|---|---|
| Quick dev loop with colorized output | `ConsoleLogger` (default — no install needed) |
| File rotation, async sinks, OpenTelemetry export | `PinoLogger` |
| Redaction of sensitive fields | `PinoLogger` (`options.redact`) |
| Request-scoped child loggers | `PinoLogger` (`.child()`) |
| Pretty-printing in dev + JSON in prod | Either — both behave the same. `PinoLogger` adds transport options on top. |

## Compatibility

- **Node**: >=22.18.0
- **Peer**: `@rotorsoft/act` >=0.39.0
- **Bundled deps**: `pino` ^10.3.1, `pino-pretty` ^13.1.3
- **Module formats**: ESM (`import`) and CJS (`require`). No side effects.

## Stability

Public API governed by the [Act Stability Charter](../../STABILITY.md). Charter takes effect at 1.0 (gated on [milestone 1.0](https://github.com/Rotorsoft/act-root/milestone/1)).

## Related packages

- **[@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act)** — the event-sourcing framework this logger plugs into.
- **[@rotorsoft/act-tck](https://www.npmjs.com/package/@rotorsoft/act-tck)** — Logger / Store / Cache port conformance tests. `PinoLogger` ships through `runLoggerTck`.
- **[@rotorsoft/act-pg](https://www.npmjs.com/package/@rotorsoft/act-pg)** / **[@rotorsoft/act-sqlite](https://www.npmjs.com/package/@rotorsoft/act-sqlite)** — sibling adapters for the `Store` port (same drop-in pattern as this one).

## Documentation

- **[Production checklist § Logging](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/production-checklist.md)** — operator-facing guidance on log levels, environment, and the structured-vs-pretty trade-off.
- **[Writing a custom Logger adapter](https://github.com/Rotorsoft/act-root/blob/master/docs/docs/guides/writing-a-logger.md)** — for authors building their own `Logger` implementation against a different backend (the same recipe `PinoLogger` itself follows).

## License

MIT
