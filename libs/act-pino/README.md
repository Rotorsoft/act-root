# @rotorsoft/act-pino

Pino logger adapter for the [@rotorsoft/act](https://www.npmjs.com/package/@rotorsoft/act) event sourcing framework.

Replaces Act's built-in `ConsoleLogger` with [pino](https://getpino.io/) — structured JSON logging, log levels, transports, redaction, and pretty-printing in development.

## Install

```bash
pnpm add @rotorsoft/act-pino
```

## Quick Start

```typescript
import { log } from "@rotorsoft/act";
import { PinoLogger } from "@rotorsoft/act-pino";

// Replace the default logger — all framework logging now goes through pino
log(new PinoLogger());
```

## Configuration

`PinoLogger` accepts an options object:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `level` | `string` | `config().logLevel` | Log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `pretty` | `boolean` | `true` in non-production | Enable `pino-pretty` for human-readable output |
| `options` | `pino.LoggerOptions` | `{}` | Pass-through to pino (transports, serializers, redaction, etc.) |

### Examples

```typescript
// Custom log level
log(new PinoLogger({ level: "debug" }));

// Disable pretty-printing (structured JSON only)
log(new PinoLogger({ pretty: false }));

// Pino-native options (redaction, serializers, etc.)
log(new PinoLogger({
  options: {
    redact: ["password", "secret", "token"],
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
    },
  },
}));
```

## Logger Interface

`PinoLogger` implements the Act framework's `Logger` interface:

```typescript
interface Logger {
  level: string;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
  dispose(): Promise<void>;
}
```

### String and object messages

```typescript
const logger = new PinoLogger();

// String message
logger.info("Server started");

// Object with message
logger.info({ port: 4000 }, "Server started");

// Object only (no message)
logger.info({ event: "startup", port: 4000 });
```

### Child loggers

Create scoped loggers with inherited bindings:

```typescript
const parent = new PinoLogger();
const child = parent.child({ module: "payments" });

child.info("Processing payment"); // includes { module: "payments" }
```

### Cleanup

```typescript
await logger.dispose(); // flushes buffered logs
```

## Environment Integration

`PinoLogger` reads defaults from Act's `config()`:

- **`logLevel`** — controlled by `LOG_LEVEL` env var (default: `"info"`)
- **`logSingleLine`** — controlled by `LOG_SINGLE_LINE` env var (affects `pino-pretty` formatting)
- **`env`** — when `"production"`, pretty-printing is disabled by default (structured JSON output)

## License

MIT
