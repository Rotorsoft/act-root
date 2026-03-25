/**
 * @module PinoLogger
 *
 * Pino adapter for the Act framework Logger port.
 *
 * Wraps a pino instance to implement the Logger interface, preserving
 * pino's full feature set (transports, serializers, redaction, etc.)
 * while conforming to the framework's minimal logger contract.
 */
import type { Logger } from "@rotorsoft/act";
import { config } from "@rotorsoft/act";
import type { LoggerOptions, Logger as PinoInstance } from "pino";
import { pino } from "pino";

/**
 * Pino-backed Logger adapter for the Act framework.
 *
 * @example Basic usage
 * ```typescript
 * import { log } from "@rotorsoft/act";
 * import { PinoLogger } from "@rotorsoft/act-pino";
 *
 * log(new PinoLogger());
 * ```
 *
 * @example Custom options
 * ```typescript
 * log(new PinoLogger({
 *   level: "debug",
 *   pretty: true,
 *   options: { redact: ["password", "secret"] }
 * }));
 * ```
 */
export class PinoLogger implements Logger {
  private readonly _pino: PinoInstance;

  get level(): string {
    return this._pino.level;
  }
  set level(value: string) {
    this._pino.level = value;
  }

  constructor(
    opts: {
      level?: string;
      pretty?: boolean;
      options?: LoggerOptions;
    } = {}
  ) {
    const cfg = config();
    const {
      level = cfg.logLevel,
      pretty = cfg.env !== "production",
      options = {},
    } = opts;

    this._pino = pino({
      ...options,
      level,
      transport: pretty
        ? {
            target: "pino-pretty",
            options: {
              ignore: "pid,hostname",
              singleLine: cfg.logSingleLine,
              colorize: true,
            },
          }
        : options.transport,
    });
  }

  private _log(
    method: "fatal" | "error" | "warn" | "info" | "debug" | "trace",
    obj: unknown,
    msg?: string
  ): void {
    if (typeof obj === "string") {
      this._pino[method](obj);
    } else if (msg !== undefined) {
      this._pino[method](Object(obj), msg);
    } else {
      this._pino[method](Object(obj));
    }
  }

  fatal(obj: unknown, msg?: string): void {
    this._log("fatal", obj, msg);
  }

  error(obj: unknown, msg?: string): void {
    this._log("error", obj, msg);
  }

  warn(obj: unknown, msg?: string): void {
    this._log("warn", obj, msg);
  }

  info(obj: unknown, msg?: string): void {
    this._log("info", obj, msg);
  }

  debug(obj: unknown, msg?: string): void {
    this._log("debug", obj, msg);
  }

  trace(obj: unknown, msg?: string): void {
    this._log("trace", obj, msg);
  }

  dispose(): Promise<void> {
    this._pino.flush();
    return Promise.resolve();
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = new PinoLogger();
    Object.defineProperty(child, "_pino", {
      value: this._pino.child(bindings),
      writable: false,
    });
    return child;
  }
}
