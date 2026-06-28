import { runLoggerDifferentialTck } from "@rotorsoft/act-tck";
import { ConsoleLogger } from "../src/adapters/console-logger.js";
import type { Logger } from "../src/types/index.js";

/**
 * A second, structurally independent {@link Logger} so the differential has
 * a genuine comparand: a no-op sink that swallows every call and returns
 * conforming children. It upholds the same robustness/structural contract
 * as `ConsoleLogger` without writing anything, so the two must produce
 * identical outcome vectors.
 */
class NoopLogger implements Logger {
  level: string;
  constructor(level = "trace") {
    this.level = level;
  }
  fatal() {}
  error() {}
  warn() {}
  info() {}
  debug() {}
  trace() {}
  child(): Logger {
    return new NoopLogger(this.level);
  }
  async dispose() {}
}

/**
 * A deliberately *strict* logger: it rejects `null` and cyclic payloads
 * (a legitimate stance for a sink that serializes eagerly). Two equally
 * strict loggers are still in parity — they throw on the same inputs — so
 * the differential passes while exercising its throw-detection path.
 */
class StrictLogger implements Logger {
  level: string;
  constructor(level = "trace") {
    this.level = level;
  }
  private guard(obj: unknown) {
    if (obj === null) throw new Error("null rejected");
    JSON.stringify(obj); // throws on cyclic structures
  }
  fatal(obj: unknown) {
    this.guard(obj);
  }
  error(obj: unknown) {
    this.guard(obj);
  }
  warn(obj: unknown) {
    this.guard(obj);
  }
  info(obj: unknown) {
    this.guard(obj);
  }
  debug(obj: unknown) {
    this.guard(obj);
  }
  trace(obj: unknown) {
    this.guard(obj);
  }
  child(): Logger {
    return new StrictLogger(this.level);
  }
  async dispose() {}
}

// Logger differential (#1057): drive the identical call surface (every
// level, both overloads, null + cyclic payloads, child spawning) against
// ConsoleLogger and a no-op reference, comparing robustness + structural
// parity.
runLoggerDifferentialTck({
  name: "ConsoleLogger vs NoopLogger",
  loggers: [
    {
      name: "ConsoleLogger",
      factory: () => new ConsoleLogger({ level: "trace", pretty: false }),
    },
    { name: "NoopLogger", factory: () => new NoopLogger() },
  ],
});

// Two equally-strict loggers agree on *what* they reject (null + cyclic
// payloads), so parity holds even though both throw — exercising the
// harness's throw-detection path.
runLoggerDifferentialTck({
  name: "StrictLogger parity",
  loggers: [
    { name: "StrictLogger A", factory: () => new StrictLogger() },
    { name: "StrictLogger B", factory: () => new StrictLogger() },
  ],
});
