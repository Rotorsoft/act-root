export type * from "./action";
export * from "./errors";
export type * from "./ports";
export type * from "./reaction";
export * from "./schemas";

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
