/**
 * @packageDocumentation
 * Configuration utilities for Act Framework environment, logging, and package metadata.
 *
 * Provides type-safe configuration loading and validation using Zod schemas.
 *
 * @module config
 */
import * as fs from "node:fs";
import { z } from "zod";
import { resolveAutocloseConfig as resolve_autoclose } from "./internal/config.js";
import { log } from "./ports.js";
import {
  type ActOptions,
  type AutocloseConfig,
  type Config,
  type Environment,
  Environments,
  type LogLevel,
  LogLevels,
  type Package,
} from "./types/index.js";
import { extend } from "./utils.js";

/**
 * Zod schema for validating package.json metadata.
 * @internal
 */
export const PackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1).optional(),
  author: z
    .object({ name: z.string().min(1), email: z.string().optional() })
    .optional()
    .or(z.string().min(1))
    .optional(),
  license: z.string().min(1).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
}) satisfies z.ZodType<Package>;

/**
 * Fallback package metadata when `package.json` can't be read at module
 * load — happens when the framework is consumed from a CWD that doesn't
 * have one (bundled CLIs, Lambda layers, embedded scripts) or when the
 * file exists but is malformed. `name` and `version` also fall back one by
 * one when the file has no valid value for them.
 *
 * The values are deliberately synthetic so callers spot them immediately:
 * `config().name === "act-fallback"` is a runtime signal that the framework
 * couldn't load the host project's package.json.
 *
 * @internal
 */
const FALLBACK_PACKAGE: Package = {
  name: "act-fallback",
  version: "0.0.0-fallback",
  description: "Synthetic fallback — package.json could not be loaded",
};

/**
 * Loads the local package.json as a Package object, keeping each field only
 * when it is valid: `npm init -y` writes an empty `description` and
 * `author`, and a bare `{"type":"module"}` has no name or version. A
 * missing or invalid `name` / `version` falls back to
 * {@link FALLBACK_PACKAGE}. On a read or parse failure, falls back entirely
 * and stashes the error so {@link config} can surface it on first access —
 * we can't call `log()` here because the logger port memoizes on first
 * call and locking it at module load defeats user injection.
 *
 * @internal
 */
const get_package = (): Package => {
  try {
    const raw = JSON.parse(fs.readFileSync("package.json").toString());
    const pkg: Record<string, unknown> = {
      name: FALLBACK_PACKAGE.name,
      version: FALLBACK_PACKAGE.version,
    };
    for (const [key, schema] of Object.entries(PackageSchema.shape)) {
      const field = schema.safeParse(raw?.[key]);
      if (field.success && field.data !== undefined) pkg[key] = field.data;
    }
    return pkg as Package;
  } catch (err) {
    pkg_load_error = err;
    return FALLBACK_PACKAGE;
  }
};

/** Stashed read/parse error from {@link get_package}, surfaced by config(). */
let pkg_load_error: unknown;

/**
 * Zod schema for the full Act Framework configuration object.
 * Includes package metadata, environment, logging, and timing options.
 * @internal
 */
const BaseSchema = PackageSchema.extend({
  env: z.enum(Environments),
  logLevel: z.enum(LogLevels),
  logSingleLine: z.boolean(),
  sleepMs: z.number().int().min(0).max(5000),
}) satisfies z.ZodType<Config>;

const { NODE_ENV, LOG_LEVEL, LOG_SINGLE_LINE, SLEEP_MS } = process.env;

const env = (NODE_ENV || "development") as Environment;
const logLevel = (LOG_LEVEL ||
  (NODE_ENV === "test"
    ? "fatal"
    : NODE_ENV === "production"
      ? "info"
      : "trace")) as LogLevel;
const logSingleLine = (LOG_SINGLE_LINE || "true") === "true";
const sleepMs = parseInt(NODE_ENV === "test" ? "0" : (SLEEP_MS ?? "100"), 10);

const pkg = get_package();

// Lazily validated on first call. Cannot run extend() at module load
// because of a utils.ts <-> config.ts cycle (utils imports config for
// sleep()'s default). Inputs are frozen after import, so the cached
// result is stable for the life of the process.
let _validated: Config | undefined;

/**
 * Gets the current Act Framework configuration.
 *
 * Configuration is loaded from package.json and environment variables, providing
 * type-safe access to application metadata and runtime settings.
 *
 * **Environment Variables:**
 * - `NODE_ENV`: "development" | "test" | "staging" | "production" (default: "development")
 * - `LOG_LEVEL`: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
 * - `LOG_SINGLE_LINE`: "true" | "false" (default: "true")
 * - `SLEEP_MS`: Milliseconds for sleep utility (default: 100, 0 for tests)
 *
 * **Defaults by environment:**
 * - test: logLevel="error", sleepMs=0
 * - production: logLevel="info"
 * - development: logLevel="trace"
 *
 * @returns The validated configuration object
 *
 * @example Basic usage
 * ```typescript
 * import { config } from "@rotorsoft/act";
 *
 * const cfg = config();
 * console.log(`App: ${cfg.name} v${cfg.version}`);
 * console.log(`Environment: ${cfg.env}`);
 * console.log(`Log level: ${cfg.logLevel}`);
 * ```
 *
 * @see {@link Config} for configuration type
 */
export const config = (): Config => {
  if (!_validated) {
    _validated = extend(
      { ...pkg, env, logLevel, logSingleLine, sleepMs },
      BaseSchema
    );
    if (pkg_load_error) {
      // Surface the fallback once, after _validated is set so the
      // recursive log() → config() call short-circuits. log() resolves
      // through the port singleton — respects user injection and level.
      const msg =
        pkg_load_error instanceof Error
          ? pkg_load_error.message
          : typeof pkg_load_error === "string"
            ? pkg_load_error
            : "unknown error";
      log().warn(
        `[act] Could not read package.json (${msg}); using synthetic ` +
          `name="${FALLBACK_PACKAGE.name}" version="${FALLBACK_PACKAGE.version}".`
      );
      pkg_load_error = undefined;
    }
  }
  return _validated;
};

/**
 * Validates and defaults the autoclose knobs of `ActOptions`, the way
 * `act().build()` does. Throws `ZodError` on an out-of-range value.
 */
export function resolveAutocloseConfig(
  options: ActOptions | undefined
): AutocloseConfig {
  return resolve_autoclose(options);
}
