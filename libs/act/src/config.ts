import * as dotenv from "dotenv";
import * as fs from "node:fs";
import { z } from "zod/v4";
import { Environment, Environments, LogLevel, LogLevels } from "./types";
import { extend } from "./utils";

dotenv.config();

export const PackageSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: z
    .object({ name: z.string().min(1), email: z.string().optional() })
    .or(z.string().min(1)),
  license: z.string().min(1),
  dependencies: z.record(z.string(), z.string()),
});
export type Package = z.infer<typeof PackageSchema>;

const getPackage = (): Package => {
  const pkg = fs.readFileSync("package.json");
  return JSON.parse(pkg.toString()) as Package;
};

const BaseSchema = PackageSchema.extend({
  env: z.enum(Environments),
  logLevel: z.enum(LogLevels),
  logSingleLine: z.boolean(),
  sleepMs: z.number().int().min(0).max(5000),
});
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

export const config = (): Config => {
  return extend({ ...pkg, env, logLevel, logSingleLine, sleepMs }, BaseSchema);
};
