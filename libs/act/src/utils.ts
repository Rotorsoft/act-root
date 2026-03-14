import { type ZodError, type ZodType, prettifyError } from "zod";
import { config } from "./config.js";
import { ValidationError } from "./types/index.js";

export { patch } from "@rotorsoft/act-patch";

/**
 * @module utils
 * @category Utilities
 * Utility functions for patching state, validation, extending objects, and async helpers.
 *
 * - Use `patch()` to immutably update state with patches (re-exported from @rotorsoft/act-patch).
 * - Use `validate()` to validate payloads against Zod schemas.
 * - Use `extend()` to merge and validate configuration objects.
 * - Use `sleep()` for async delays.
 */

/**
 * Validates a payload against a Zod schema.
 *
 * This is the primary validation function used throughout the Act framework.
 * It parses the payload using the provided Zod schema and throws a
 * {@link ValidationError} with detailed error information if validation fails.
 *
 * When no schema is provided, the payload is returned as-is without validation.
 * This allows for optional validation in the framework.
 *
 * The framework automatically calls this function when:
 * - Actions are invoked via `app.do()`
 * - Events are emitted from action handlers
 * - States are initialized
 *
 * @param target - Name of the target being validated (used in error messages)
 * @param payload - The data to validate
 * @param schema - Optional Zod schema to validate against
 * @returns The validated and type-safe payload
 * @throws {@link ValidationError} if validation fails with detailed error info
 *
 * @example Basic validation
 * ```typescript
 * import { validate } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const UserSchema = z.object({
 *   email: z.string().email(),
 *   age: z.number().min(0)
 * });
 *
 * const user = validate("User", { email: "alice@example.com", age: 30 }, UserSchema);
 * // Returns: { email: "alice@example.com", age: 30 }
 * ```
 *
 * @example Handling validation errors
 * ```typescript
 * import { validate, ValidationError } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const schema = z.object({
 *   email: z.string().email(),
 *   age: z.number().min(18)
 * });
 *
 * try {
 *   validate("User", { email: "invalid", age: 15 }, schema);
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.error("Target:", error.target);  // "User"
 *     console.error("Payload:", error.payload);  // { email: "invalid", age: 15 }
 *     console.error("Details:", error.details);  // Prettified Zod errors
 *     // Details shows: email must be valid, age must be >= 18
 *   }
 * }
 * ```
 *
 * @example Optional validation
 * ```typescript
 * // When schema is undefined, payload is returned as-is
 * const data = validate("Data", { any: "value" });
 * // Returns: { any: "value" } without validation
 * ```
 *
 * @example In action definitions
 * ```typescript
 * import { state } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const Counter = state({ Counter: z.object({ count: z.number() }) })
 *   .init(() => ({ count: 0 }))
 *   .emits({ Incremented: z.object({ by: z.number().positive() }) })
 *   .on({ increment: z.object({ by: z.number() }) })
 *     .emit((action) => {
 *       // validate() is called automatically before this runs
 *       // action.by is guaranteed to be a number
 *       return ["Incremented", { by: action.by }];
 *     })
 *   .build();
 * ```
 *
 * @example Custom validation in application code
 * ```typescript
 * import { validate } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const ConfigSchema = z.object({
 *   apiKey: z.string().min(32),
 *   timeout: z.number().positive(),
 *   retries: z.number().int().min(0).max(10)
 * });
 *
 * function loadConfig(raw: unknown) {
 *   return validate("AppConfig", raw, ConfigSchema);
 * }
 * ```
 *
 * @see {@link ValidationError} for error handling
 * @see {@link https://zod.dev | Zod documentation} for schema definition
 */
export const validate = <S>(
  target: string,
  payload: Readonly<S>,
  schema?: ZodType<S>
): Readonly<S> => {
  try {
    return schema ? schema.parse(payload) : payload;
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      throw new ValidationError(
        target,
        payload,
        prettifyError(error as ZodError)
      );
    }
    throw new ValidationError(target, payload, error);
  }
};

/**
 * Validates and merges configuration objects.
 *
 * This function first validates the source object against a Zod schema using
 * {@link validate}, then merges it with an optional target object. The source
 * properties override target properties in the result.
 *
 * Primarily used for configuration management where you want to:
 * 1. Define default configuration values
 * 2. Load environment-specific overrides
 * 3. Validate the final configuration
 *
 * The framework uses this internally for the {@link config} function.
 *
 * @template S - Source object type (must be a record)
 * @template T - Target object type (must be a record)
 * @param source - The source object to validate and use as overrides
 * @param schema - Zod schema to validate the source against
 * @param target - Optional target object with default values
 * @returns Merged object with validated source overriding target
 * @throws {@link ValidationError} if source fails schema validation
 *
 * @example Basic configuration merging
 * ```typescript
 * import { extend } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const ConfigSchema = z.object({
 *   host: z.string(),
 *   port: z.number(),
 *   debug: z.boolean()
 * });
 *
 * const defaults = { host: "localhost", port: 3000, debug: false };
 * const overrides = { port: 8080, debug: true };
 *
 * const config = extend(overrides, ConfigSchema, defaults);
 * // Result: { host: "localhost", port: 8080, debug: true }
 * ```
 *
 * @example Environment-based configuration
 * ```typescript
 * import { extend } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const DbConfigSchema = z.object({
 *   host: z.string(),
 *   port: z.number(),
 *   database: z.string(),
 *   user: z.string(),
 *   password: z.string()
 * });
 *
 * const defaults = {
 *   host: "localhost",
 *   port: 5432,
 *   database: "myapp_dev",
 *   user: "postgres",
 *   password: "dev"
 * };
 *
 * const envConfig = {
 *   host: process.env.DB_HOST || "localhost",
 *   port: parseInt(process.env.DB_PORT || "5432"),
 *   database: process.env.DB_NAME || "myapp_dev",
 *   user: process.env.DB_USER || "postgres",
 *   password: process.env.DB_PASSWORD || "dev"
 * };
 *
 * // Validates environment config and merges with defaults
 * const dbConfig = extend(envConfig, DbConfigSchema, defaults);
 * ```
 *
 * @example Framework usage
 * ```typescript
 * // This is how Act's config() function uses extend internally:
 * import { extend } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const BaseSchema = z.object({
 *   env: z.enum(["development", "test", "staging", "production"]),
 *   logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
 *   sleepMs: z.number().int().min(0).max(5000)
 * });
 *
 * const packageData = { name: "my-app", version: "1.0.0" };
 * const runtimeConfig = { env: "production", logLevel: "info", sleepMs: 100 };
 *
 * const config = extend(
 *   { ...packageData, ...runtimeConfig },
 *   BaseSchema,
 *   packageData
 * );
 * ```
 *
 * @example With validation error handling
 * ```typescript
 * import { extend, ValidationError } from "@rotorsoft/act";
 * import { z } from "zod";
 *
 * const schema = z.object({
 *   apiKey: z.string().min(32),
 *   timeout: z.number().positive()
 * });
 *
 * try {
 *   const config = extend(
 *     { apiKey: "short", timeout: -1 },
 *     schema
 *   );
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.error("Invalid configuration:", error.details);
 *   }
 * }
 * ```
 *
 * @see {@link validate} for validation details
 * @see {@link config} for framework configuration
 * @see {@link ValidationError} for error handling
 */
export const extend = <
  S extends Record<string, unknown>,
  T extends Record<string, unknown>,
>(
  source: Readonly<S>,
  schema: ZodType<S>,
  target?: Readonly<T>
): Readonly<S & T> => {
  const value = validate("config", source, schema);
  return Object.assign(target || {}, value) as Readonly<S & T>;
};

/**
 * Pauses async execution for a specified duration.
 *
 * This is a simple async utility for adding delays in your code. When called
 * without arguments, it uses the configured sleep duration from `config().sleepMs`,
 * which defaults to 100ms in development and 0ms in test environments.
 *
 * The framework uses this internally in store adapters to simulate I/O delays
 * in the {@link InMemoryStore}.
 *
 * **Note:** In test environments (NODE_ENV=test), the default sleep duration is
 * 0ms to keep tests fast.
 *
 * @param ms - Optional duration in milliseconds (defaults to config().sleepMs)
 * @returns Promise that resolves after the specified delay
 *
 * @example Using default sleep duration
 * ```typescript
 * import { sleep } from "@rotorsoft/act";
 *
 * async function processWithDelay() {
 *   console.log("Starting...");
 *   await sleep();  // Uses config().sleepMs (100ms in dev, 0ms in test)
 *   console.log("Continued after delay");
 * }
 * ```
 *
 * @example Custom sleep duration
 * ```typescript
 * import { sleep } from "@rotorsoft/act";
 *
 * async function retryWithBackoff(fn: () => Promise<void>, retries = 3) {
 *   for (let i = 0; i < retries; i++) {
 *     try {
 *       await fn();
 *       return;
 *     } catch (error) {
 *       if (i < retries - 1) {
 *         const delay = Math.pow(2, i) * 1000;  // Exponential backoff
 *         console.log(`Retrying in ${delay}ms...`);
 *         await sleep(delay);
 *       } else {
 *         throw error;
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * @example Rate limiting
 * ```typescript
 * import { sleep } from "@rotorsoft/act";
 *
 * async function processItems(items: string[]) {
 *   for (const item of items) {
 *     await processItem(item);
 *     await sleep(500);  // 500ms between items
 *   }
 * }
 * ```
 *
 * @example Framework internal usage
 * ```typescript
 * // InMemoryStore uses sleep to simulate async I/O
 * class InMemoryStore implements Store {
 *   async query(...) {
 *     await sleep();  // Simulate database latency
 *     // ... query logic
 *   }
 *
 *   async commit(...) {
 *     await sleep();  // Simulate write latency
 *     // ... commit logic
 *   }
 * }
 * ```
 *
 * @example Configuring default sleep duration
 * ```bash
 * # Set custom default sleep duration via environment variable
 * SLEEP_MS=50 npm start
 *
 * # In tests, it's automatically 0
 * NODE_ENV=test npm test
 * ```
 *
 * @see {@link config} for sleep duration configuration
 */
export async function sleep(ms?: number) {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config().sleepMs));
}
