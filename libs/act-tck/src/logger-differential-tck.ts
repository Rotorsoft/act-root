import type { Logger } from "@rotorsoft/act/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * One {@link Logger} implementation to feed into
 * {@link runLoggerDifferentialTck}. The harness drives the identical call
 * sequence against all of them and compares the **portable** observable
 * contract — robustness (does a call throw?) and structural conformance
 * (is `level` a non-empty string, does `child()` satisfy the contract).
 */
export type DifferentialLogger = {
  /** Display name used in assertion messages and the describe block. */
  readonly name: string;
  /**
   * Produces the logger under test. Called before each test; the harness
   * owns its lifecycle (`dispose`).
   */
  readonly factory: () => Logger;
};

/**
 * Options for {@link runLoggerDifferentialTck}.
 */
export type LoggerDifferentialTckOptions = {
  /** Display name for the differential suite. */
  readonly name: string;
  /**
   * Two or more loggers to drive in lockstep and compare. The first entry
   * is the reference; every other logger must uphold the same portable
   * observable contract under the identical call sequence.
   */
  readonly loggers: ReadonlyArray<DifferentialLogger>;
};

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

/**
 * Drive a logger through the full call surface and return a vector of
 * **observable, portable** outcomes. A logger's formatted output is
 * adapter-specific by design (pino JSON vs console text vs a file sink),
 * so the only thing two implementations can be held to byte-for-byte is:
 *
 *   - whether each call **throws** (robustness parity — a logger that
 *     blows up on a cyclic or null payload the reference tolerates is a
 *     real divergence);
 *   - whether `level` is a non-empty string;
 *   - whether `child()` returns something that itself satisfies the
 *     contract (and can spawn a further child).
 *
 * The vector is order-stable, so a single `toEqual` pins any divergence to
 * the exact call that broke parity.
 */
const drive = (logger: Logger): boolean[] => {
  const out: boolean[] = [];
  const ok = (fn: () => void): void => {
    try {
      fn();
      out.push(true);
    } catch {
      out.push(false);
    }
  };

  out.push(typeof logger.level === "string" && logger.level.length > 0);
  for (const level of LEVELS) {
    ok(() => logger[level]("message"));
    ok(() => logger[level]({ k: "v", n: 1 }));
    ok(() => logger[level]({ k: "v" }, "context"));
  }
  ok(() => logger.info(null, "null payload"));
  ok(() => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    logger.info(cyclic, "cycle");
  });

  // Child conformance: a child must satisfy the same contract and be able
  // to spawn its own child — recorded as observable booleans, not asserted
  // here, so a non-conforming child surfaces as a vector divergence.
  const child = logger.child({ request_id: "abc" });
  out.push(typeof child.level === "string" && child.level.length > 0);
  out.push(LEVELS.every((level) => typeof child[level] === "function"));
  out.push(typeof child.child === "function");
  ok(() => child.child({ nested: true }).info("nested"));

  return out;
};

/**
 * Cross-implementation differential contract for the {@link Logger} port
 * (#1057).
 *
 * A logger has no portable return value to byte-compare — its output
 * format is adapter-specific by design, which is exactly why
 * {@link runLoggerTck} checks shape rather than bytes. The meaningful
 * differential is therefore **robustness and structural parity**: driven
 * through the identical call sequence (every level, both overloads, null
 * and cyclic payloads, child spawning), do two implementations agree on
 * what throws and what conforms? They must. A logger that throws on a
 * cyclic payload the reference tolerates, or returns a non-conforming
 * child, diverges from the reference vector.
 *
 * @example
 * ```ts
 * import { runLoggerDifferentialTck } from "@rotorsoft/act-tck";
 * import { ConsoleLogger } from "@rotorsoft/act";
 * import { PinoLogger } from "../src/index.js";
 *
 * runLoggerDifferentialTck({
 *   name: "Console vs Pino",
 *   loggers: [
 *     { name: "ConsoleLogger", factory: () => new ConsoleLogger({ level: "trace" }) },
 *     { name: "PinoLogger", factory: () => new PinoLogger({ level: "trace" }) },
 *   ],
 * });
 * ```
 */
export const runLoggerDifferentialTck = (
  options: LoggerDifferentialTckOptions
): void => {
  describe(`TCK / Logger differential / ${options.name}`, () => {
    let live: Array<{ name: string; logger: Logger }> = [];
    let original_stdout: typeof process.stdout.write;

    // Silence stdout while driving the loggers — we compare observable
    // outcomes, not formatted output, and chatty sinks would spam the run.
    beforeEach(() => {
      live = options.loggers.map((spec) => ({
        name: spec.name,
        logger: spec.factory(),
      }));
      original_stdout = process.stdout.write.bind(process.stdout);
      process.stdout.write = (() => true) as typeof process.stdout.write;
    });

    afterEach(async () => {
      process.stdout.write = original_stdout;
      for (const { logger } of live) await logger.dispose();
    });

    it("agrees on robustness and structural parity across the call surface", () => {
      const reference = drive(live[0].logger);
      for (let i = 1; i < live.length; i++) {
        const actual = drive(live[i].logger);
        expect(actual, `${live[i].name} diverged from ${live[0].name}`).toEqual(
          reference
        );
      }
    });
  });
};
