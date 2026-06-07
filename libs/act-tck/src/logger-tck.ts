import type { Logger } from "@rotorsoft/act/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Options for {@link run_logger_tck}.
 */
export type LoggerTckOptions = {
  /**
   * Display name for the implementation under test.
   */
  readonly name: string;
  /**
   * Factory invoked before each test. Must return a fresh logger
   * instance — tests do not assume any starting state.
   */
  readonly factory: () => Logger;
};

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

/**
 * Runs the Logger contract test compatibility kit against the
 * implementation produced by `options.factory`.
 *
 * The {@link Logger} contract is intentionally narrow: implementations
 * are pluggable wrappers around pino, winston, bunyan, console, etc.
 * The TCK verifies the **shape** of the contract, not the format of
 * the output (which is adapter-specific by design):
 * - every level method exists and is callable in both overload forms
 *   `(msg)` and `(obj, msg?)`
 * - `child(bindings)` returns something that satisfies the same
 *   contract and can itself spawn children
 * - `level` is a non-empty string
 * - `dispose` is awaitable and idempotent
 * - cyclic payloads must not throw (sinks may choose any fallback)
 *
 * Anything more (output format, level gating, color, file routing) is
 * adapter-specific and stays in the adapter's own test suite.
 *
 * @example
 * ```ts
 * import { run_logger_tck } from "@rotorsoft/act-tck";
 * import { ConsoleLogger } from "@rotorsoft/act";
 *
 * run_logger_tck({
 *   name: "ConsoleLogger",
 *   factory: () => new ConsoleLogger({ level: "trace" }),
 * });
 * ```
 */
export const run_logger_tck = (options: LoggerTckOptions): void => {
  describe(`TCK / Logger / ${options.name}`, () => {
    let logger: Logger;
    let original_stdout: typeof process.stdout.write;

    // Silence stdout during the TCK — we don't assert on output, and
    // chatty implementations would otherwise spam test runs. Loggers
    // that route elsewhere (stderr, files) won't appear in the test
    // report; checking their formatted output is the adapter's own
    // responsibility.
    beforeEach(() => {
      logger = options.factory();
      original_stdout = process.stdout.write.bind(process.stdout);
      process.stdout.write = (() => true) as typeof process.stdout.write;
    });

    afterEach(async () => {
      process.stdout.write = original_stdout;
      await logger.dispose();
    });

    it("exposes a non-empty `level` string", () => {
      expect(typeof logger.level).toBe("string");
      expect(logger.level.length).toBeGreaterThan(0);
    });

    for (const level of LEVELS) {
      it(`${level}(msg) does not throw`, () => {
        expect(() => logger[level]("hello")).not.toThrow();
      });

      it(`${level}(obj) does not throw`, () => {
        expect(() => logger[level]({ k: "v" })).not.toThrow();
      });

      it(`${level}(obj, msg) does not throw`, () => {
        expect(() => logger[level]({ k: "v" }, "context")).not.toThrow();
      });
    }

    it("accepts a null payload", () => {
      expect(() => logger.info(null, "null payload")).not.toThrow();
    });

    it("accepts a cyclic payload without throwing", () => {
      const cyclic: Record<string, unknown> = { name: "loop" };
      cyclic.self = cyclic;
      expect(() => logger.info(cyclic, "cycle")).not.toThrow();
    });

    it("child(bindings) returns a Logger satisfying the same contract", () => {
      const child = logger.child({ request_id: "abc" });
      expect(typeof child.level).toBe("string");
      for (const level of LEVELS) {
        expect(typeof child[level]).toBe("function");
      }
      expect(typeof child.child).toBe("function");
      expect(typeof child.dispose).toBe("function");
    });

    it("child loggers can themselves spawn children", () => {
      const c1 = logger.child({ a: 1 });
      const c2 = c1.child({ b: 2 });
      expect(() => c2.info("nested")).not.toThrow();
    });

    it("dispose is idempotent and awaitable", async () => {
      await expect(logger.dispose()).resolves.toBeUndefined();
      await expect(logger.dispose()).resolves.toBeUndefined();
    });
  });
};
