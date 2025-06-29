/**
 * @module act/types
 * Barrel file for Act Framework core types.
 *
 * Re-exports all major type definitions for actions, errors, ports, reactions, registries, and schemas.
 * Also defines common environment and log level types/constants for configuration and logging.
 */
export type * from "./action.js";
export * from "./errors.js";
export type * from "./ports.js";
export type * from "./reaction.js";
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
