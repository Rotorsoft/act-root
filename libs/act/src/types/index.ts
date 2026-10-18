/**
 * @packageDocumentation
 * @module act/types
 * Barrel file for Act Framework core types.
 *
 * Re-exports all major type definitions for actions, errors, ports, reactions, registries, and schemas.
 * Also defines common environment and log level types/constants for configuration and logging.
 *
 * @remarks
 * Import from this module to access all core framework types in one place.
 */
export * from "./act.js";
export type * from "./action.js";
export type * from "./audit.js";
export type {
  ActBuilder,
  ActionBuilder,
  Projection,
  ProjectionBuilder,
  Slice,
  SliceBuilder,
  StateBuilder,
} from "./builders.js";
export * from "./errors.js";
export type * from "./ports.js";
export { SNAP_EVENT, TOMBSTONE_EVENT } from "./ports.js";
export type * from "./reaction.js";
export { DEFAULT_LANE } from "./reaction.js";
export type * from "./registry.js";
export * from "./schemas.js";

/**
 * Supported runtime environments for the framework.
 * - `development`: Local development
 * - `test`: Automated testing
 * - `staging`: Pre-production
 * - `production`: Live/production
 */
export const Environments = [
  "development",
  "test",
  "staging",
  "production",
] as const;

/**
 * Type representing a valid environment string.
 */
export type Environment = (typeof Environments)[number];

/**
 * Supported log levels for framework logging.
 * - `fatal`, `error`, `warn`, `info`, `debug`, `trace`
 */
export const LogLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

/**
 * Type representing a valid log level string.
 */
export type LogLevel = (typeof LogLevels)[number];

/**
 * List of exit codes for process termination, as passed to
 * {@link disposeAndExit} by the signal handlers and by callers that shut
 * down on their own.
 */
export const ExitCodes = ["ERROR", "EXIT"] as const;

/**
 * Type for allowed exit codes.
 *
 * - `"ERROR"` — abnormal termination (uncaught exception, unhandled rejection)
 * - `"EXIT"` — clean shutdown (SIGINT, SIGTERM, or manual trigger)
 */
export type ExitCode = (typeof ExitCodes)[number];

/**
 * The validated `package.json` metadata `config()` reads.
 */
export type Package = {
  name: string;
  version: string;
  description?: string;
  author?: { name: string; email?: string } | string;
  license?: string;
  dependencies?: Record<string, string>;
};

/** The validated Act Framework configuration `config()` returns. */
export type Config = Package & {
  env: Environment;
  logLevel: LogLevel;
  logSingleLine: boolean;
  sleepMs: number;
};
