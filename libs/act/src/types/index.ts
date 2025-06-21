export type * from "./action.js";
export * from "./errors.js";
export type * from "./ports.js";
export type * from "./reaction.js";
export type * from "./registry.js";
export * from "./schemas.js";

export const Environments = [
  "development",
  "test",
  "staging",
  "production",
] as const;
export type Environment = (typeof Environments)[number];

export const LogLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;
export type LogLevel = (typeof LogLevels)[number];
