import { ZodError, type ZodType, prettifyError } from "zod";
import { config } from "./config.js";
import { ValidationError } from "./types/index.js";

/**
 * @module utils
 * @category Utilities
 *
 * Small utilities used across the framework:
 * - {@link validate} — parse a payload against a Zod schema, throwing
 *   {@link ValidationError} on failure.
 * - {@link extend} — validate a source object and merge into defaults.
 * - {@link sleep} — async delay (default duration from `config().sleepMs`).
 */

/**
 * Parse `payload` against `schema`, returning the validated value or throwing
 * a {@link ValidationError} with prettified Zod details. When `schema` is
 * omitted, returns `payload` unchanged. The framework calls this for every
 * `app.do()` action, every emitted event, and every state init.
 *
 * @example
 * ```typescript
 * const UserSchema = z.object({ email: z.string().email() });
 * const user = validate("User", { email: "alice@example.com" }, UserSchema);
 * ```
 *
 * @see {@link ValidationError}
 */
export const validate = <S>(
  target: string,
  payload: Readonly<S>,
  schema?: ZodType<S>
): Readonly<S> => {
  try {
    return schema ? schema.parse(payload) : payload;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError(target, payload, prettifyError(error));
    }
    throw new ValidationError(target, payload, error);
  }
};

/**
 * Validate `source` against `schema` and return a new object that merges
 * `source` over the optional `target` defaults. Used by {@link config} for
 * env-var-overrides-defaults patterns; safe to call elsewhere — it never
 * mutates `target`.
 *
 * @example
 * ```typescript
 * const schema = z.object({ host: z.string(), port: z.number() });
 * const cfg = extend({ port: 8080 }, schema, { host: "localhost", port: 80 });
 * // → { host: "localhost", port: 8080 }
 * ```
 *
 * @throws {@link ValidationError} if `source` fails the schema.
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
  return { ...target, ...value } as Readonly<S & T>;
};

/**
 * Pause for `ms` milliseconds (or `config().sleepMs` when omitted — `100ms`
 * in dev, `0ms` in tests). Used by adapters to simulate async I/O.
 *
 * @example
 * ```typescript
 * await sleep();      // default delay from config
 * await sleep(500);   // explicit 500ms
 * ```
 */
export async function sleep(ms?: number) {
  return new Promise((resolve) => setTimeout(resolve, ms ?? config().sleepMs));
}
