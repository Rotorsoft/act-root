/**
 * Configuration utilities for Act Framework environment, logging, and package metadata.
 *
 * Provides type-safe configuration loading and validation using Zod schemas.
 *
 * @module config
 */
import * as fs from "node:fs";
import { z } from "zod/v4";
import {
  Environment,
  Environments,
  LogLevel,
  LogLevels,
} from "./types/index.js";
import { extend } from "./utils.js";

/**
 * Zod schema for validating package.json metadata.
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
 */
const getPackage = (): Package => {
  const pkg = fs.readFileSync("package.json");
  return JSON.parse(pkg.toString()) as Package;
};

/**
 * Zod schema for the full Act Framework configuration object.
 * Includes package metadata, environment, logging, and timing options.
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
    : LOG_LEVEL === "production"
      ? "info"
      : "trace")) as LogLevel;
const logSingleLine = (LOG_SINGLE_LINE || "true") === "true";
const sleepMs = parseInt(NODE_ENV === "test" ? "0" : (SLEEP_MS ?? "100"));

const pkg = getPackage();

/**
 * Returns the current Act Framework configuration, validated and type-safe.
 *
 * Merges package.json metadata with environment, logging, and timing options.
 * @returns The validated configuration object.
 * @example
 *   const cfg = config();
 *   console.log(cfg.env, cfg.logLevel);
 */
export const config = (): Config => {
  return extend({ ...pkg, env, logLevel, logSingleLine, sleepMs }, BaseSchema);
};
