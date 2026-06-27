---
id: writing-a-logger
title: Writing a custom Logger adapter
---

# Writing a custom Logger adapter

`Logger` is the observability port. The framework ships `ConsoleLogger` (default) and [`@rotorsoft/act-pino`](https://www.npmjs.com/package/@rotorsoft/act-pino). A custom adapter is a wrapper around your preferred logging library (winston, bunyan, an OpenTelemetry log exporter, etc.) that conforms to the Logger interface.

## The contract

From [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts):

```ts
interface Logger extends Disposable {
  level: string;
  fatal(obj: unknown, msg?: string): void;
  fatal(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
  // … warn, info, debug, trace — each with both overloads
  child(bindings: Record<string, unknown>): Logger;
}
```

Every level method takes either `(msg)` or `(obj, msg?)`. `child(bindings)` returns something satisfying the same contract — bindings are layered context (request id, tenant, correlation id, …).

The contract is intentionally narrow: the framework treats loggers as pluggable sinks. *Output format is not part of the contract* — pretty-printed dev output, NDJSON for production, OpenTelemetry log records — all are valid as long as the methods exist and behave.

## The TCK is the spec

```ts
// libs/act-winston/test/logger-tck.spec.ts
import { runLoggerTck } from "@rotorsoft/act-tck";
import { WinstonLogger } from "../src/index.js";

runLoggerTck({
  name: "WinstonLogger",
  factory: () => new WinstonLogger({ level: "trace" }),
});
```

The TCK is a structural smoke test:

- `level` is a non-empty string
- every level method exists and is callable in both overload forms
- `null` and cyclic payloads don't throw
- `child(bindings)` returns a Logger satisfying the same contract; child loggers can themselves spawn children
- `dispose` is idempotent and awaitable

It deliberately does **not** assert on what gets written — that's adapter-specific by design. Your own test suite is where you check that the right thing lands in the right sink.

## Scaffolding `@rotorsoft/act-winston` (sketch)

```
libs/act-winston/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── src/
│   ├── index.ts
│   └── winston-logger.ts     # implements Logger
├── test/
│   ├── logger-tck.spec.ts    # runLoggerTck({ factory: () => new WinstonLogger(…) })
│   └── transports.spec.ts    # adapter-specific transport/format assertions
└── README.md
```

The README's testing section:

````md
## Testing

```ts
import { runLoggerTck } from "@rotorsoft/act-tck";
import { WinstonLogger } from "@rotorsoft/act-winston";

runLoggerTck({
  name: "WinstonLogger",
  factory: () => new WinstonLogger({ level: "trace" }),
});
```
````

## When the Logger port changes

If the framework extends the Logger interface, matching cases land in `libs/act-tck/src/logger-tck.ts`. Because the contract is narrow, breaking changes are rare — the most likely evolution is a new structured method (`flush`, `withSpan`, …) added behind a capability flag.

## Cross-references

- Contract: [`libs/act/src/types/ports.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/types/ports.ts)
- Reference implementations:
  - [`ConsoleLogger`](https://github.com/Rotorsoft/act-root/blob/master/libs/act/src/adapters/console-logger.ts)
  - [`@rotorsoft/act-pino`](https://github.com/Rotorsoft/act-root/tree/master/libs/act-pino)
- TCK source: [`libs/act-tck/src/logger-tck.ts`](https://github.com/Rotorsoft/act-root/blob/master/libs/act-tck/src/logger-tck.ts)
