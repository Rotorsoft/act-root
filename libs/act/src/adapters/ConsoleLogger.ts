/**
 * @module adapters/ConsoleLogger
 *
 * High-performance console logger inspired by pino's design:
 * - Numeric level comparison for O(1) gating
 * - stdout.write() in production for raw JSON lines (no console overhead)
 * - Colorized single-line output in development
 * - No-op method replacement when level is above threshold
 * - Child logger support with merged bindings
 */
import type { Logger } from "../types/index.js";

const LEVEL_VALUES: Record<string, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

const LEVEL_COLORS: Record<string, string> = {
  fatal: "\x1b[41m\x1b[37m", // white on red bg
  error: "\x1b[31m", // red
  warn: "\x1b[33m", // yellow
  info: "\x1b[32m", // green
  debug: "\x1b[36m", // cyan
  trace: "\x1b[90m", // gray
};

const RESET = "\x1b[0m";

const noop = () => {};

/**
 * Default console logger for the Act framework.
 *
 * Production mode emits newline-delimited JSON (compatible with GCP, AWS
 * CloudWatch, Datadog, and other structured log ingestion systems).
 *
 * Development mode emits colorized, human-readable output.
 */
export class ConsoleLogger implements Logger {
  level: string;
  private readonly _pretty: boolean;

  readonly fatal: Logger["fatal"];
  readonly error: Logger["error"];
  readonly warn: Logger["warn"];
  readonly info: Logger["info"];
  readonly debug: Logger["debug"];
  readonly trace: Logger["trace"];

  constructor(
    options: {
      level?: string;
      pretty?: boolean;
      bindings?: Record<string, unknown>;
    } = {}
  ) {
    const {
      level = "info",
      pretty = process.env.NODE_ENV !== "production",
      bindings,
    } = options;
    this._pretty = pretty;
    this.level = level;

    const threshold = LEVEL_VALUES[level] ?? 30;
    const write = pretty
      ? this._prettyWrite.bind(this, bindings)
      : this._jsonWrite.bind(this, bindings);

    // Assign methods — noop when level is gated (like pino's level-based replacement)
    this.fatal = write.bind(this, "fatal", 60); // fatal is always enabled
    this.error = threshold <= 50 ? write.bind(this, "error", 50) : noop;
    this.warn = threshold <= 40 ? write.bind(this, "warn", 40) : noop;
    this.info = threshold <= 30 ? write.bind(this, "info", 30) : noop;
    this.debug = threshold <= 20 ? write.bind(this, "debug", 20) : noop;
    this.trace = threshold <= 10 ? write.bind(this, "trace", 10) : noop;
  }

  async dispose(): Promise<void> {}

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({
      level: this.level,
      pretty: this._pretty,
      bindings,
    });
  }

  private _jsonWrite(
    bindings: Record<string, unknown> | undefined,
    level: string,
    _num: number,
    objOrMsg: unknown,
    msg?: string
  ): void {
    let obj: Record<string, unknown>;
    let message: string | undefined;

    if (typeof objOrMsg === "string") {
      message = objOrMsg;
      obj = {};
    } else if (objOrMsg !== null && typeof objOrMsg === "object") {
      message = msg;
      obj = Object.fromEntries(Object.entries(objOrMsg));
    } else {
      message = msg;
      obj = { value: objOrMsg };
    }

    const entry = Object.assign({ level, time: Date.now() }, bindings, obj);
    if (message) entry.msg = message;

    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  private _prettyWrite(
    bindings: Record<string, unknown> | undefined,
    level: string,
    _num: number,
    objOrMsg: unknown,
    msg?: string
  ): void {
    const color = LEVEL_COLORS[level];
    const tag = `${color}${level.toUpperCase().padEnd(5)}${RESET}`;
    const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS

    let message: string;
    let data: string | undefined;

    if (typeof objOrMsg === "string") {
      message = objOrMsg;
    } else {
      message = msg ?? "";
      if (objOrMsg !== undefined && objOrMsg !== null) {
        try {
          data = JSON.stringify(objOrMsg);
        } catch {
          data = "[unserializable]";
        }
      }
    }

    const bindStr =
      bindings && Object.keys(bindings).length
        ? ` ${JSON.stringify(bindings)}`
        : "";

    const parts = [ts, tag, message, data, bindStr].filter(Boolean);
    process.stdout.write(parts.join(" ") + "\n");
  }
}
