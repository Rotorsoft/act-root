import { z } from "zod";

export * from "./errors";
export * from "./stores";
export type * from "./types";

export const ZodEmpty = z.record(z.never());

export const Environments = [
  "development",
  "test",
  "staging",
  "production"
] as const;
export type Environment = (typeof Environments)[number];

export const LogLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace"
] as const;
export type LogLevel = (typeof LogLevels)[number];

export const ExitCodes = ["ERROR", "EXIT"] as const;
export type ExitCode = (typeof ExitCodes)[number];
