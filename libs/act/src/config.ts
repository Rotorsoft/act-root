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
import {
  Environment,
  Environments,
  LogLevel,
  LogLevels,
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
});

/**
 * Type representing the validated package.json metadata.
 */
export type Package = z.infer<typeof PackageSchema>;

/**
 * Loads and parses the local package.json file as a Package object.
 * @returns The parsed and validated package metadata.
 * @internal
 */
const getPackage = (): Package => {
  const pkg = fs.readFileSync("package.json");
  return JSON.parse(pkg.toString()) as Package;
};

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
});

/**
 * Type representing the validated Act Framework configuration object.
 */
export type Config = z.infer<typeof BaseSchema>;

const { NODE_ENV, LOG_LEVEL, LOG_SINGLE_LINE, SLEEP_MS } = process.env;

const env = (NODE_ENV || "development") as Environment;
const logLevel = (LOG_LEVEL ||
  (NODE_ENV === "test"
    ? "error"
    : NODE_ENV === "production"
      ? "info"
      : "trace")) as LogLevel;
const logSingleLine = (LOG_SINGLE_LINE || "true") === "true";
const sleepMs = parseInt(NODE_ENV === "test" ? "0" : (SLEEP_MS ?? "100"));

const pkg = getPackage();

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
 * @example Environment-specific behavior
 * ```typescript
 * import { config } from "@rotorsoft/act";
 *
 * const cfg = config();
 *
 * if (cfg.env === "production") {
 *   // Use PostgreSQL in production
 *   store(new PostgresStore(prodConfig));
 * } else {
 *   // Use in-memory store for dev/test
 *   store(new InMemoryStore());
 * }
 * ```
 *
 * @example Adjusting log levels
 * ```typescript
 * // Set via environment variable:
 * // LOG_LEVEL=debug npm start
 *
 * // Or check in code:
 * const cfg = config();
 * if (cfg.logLevel === "trace") {
 *   logger.trace("Detailed debugging enabled");
 * }
 * ```
 *
 * @see {@link Config} for configuration type
 * @see {@link Package} for package.json metadata
 */
export const config = (): Config => {
  return extend({ ...pkg, env, logLevel, logSingleLine, sleepMs }, BaseSchema);
};
