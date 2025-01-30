import * as dotenv from "dotenv";
import * as fs from "node:fs";
import { z } from "zod";
import { Environment, Environments, LogLevel, LogLevels } from "./types";
import { extend } from "./utils";

dotenv.config();

export type Package = {
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    email: string;
  };
  license: string;
  dependencies: Record<string, string>;
};

const getPackage = (): Package => {
  const pkg = fs.readFileSync("package.json");
  return JSON.parse(pkg.toString()) as Package;
};

const pkg = getPackage();
const parts = pkg.name.split("/");
const service = parts.at(-1) || "";

/**
 * Base configuration
 */
const Schema = z.object({
  env: z.enum(Environments),
  logLevel: z.enum(LogLevels),
  service: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: z.object({ name: z.string().min(1), email: z.string() }),
  license: z.string().min(1),
  dependencies: z.record(z.string())
});
export type Config = z.infer<typeof Schema>;

const { NODE_ENV, LOG_LEVEL } = process.env;

export const config = (): Config => {
  return extend(
    {
      env: (NODE_ENV as Environment) || "development",
      logLevel: (LOG_LEVEL as LogLevel) || "error",
      service,
      version: pkg.version,
      description: pkg.description,
      author: { name: pkg.author?.name, email: pkg.author?.email },
      license: pkg.license,
      dependencies: pkg.dependencies
    },
    Schema
  );
};
