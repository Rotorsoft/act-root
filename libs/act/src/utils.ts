import { prettifyError, ZodError, type ZodType } from "zod";
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

/**
 * Regex metacharacters that, when present in a reaction `source`, make it a
 * pattern rather than a literal stream name. A source containing none of
 * these is a bare stream name — the common case — and every claim/fetch
 * site matches it by string equality on the store's stream index. A source
 * containing any of them is compiled as a RegExp and matched against
 * candidate streams with the caller's own anchoring (e.g. `^(A|B)$`).
 */
const SOURCE_METACHARACTERS = /[\^$.*+?()[\]{}|\\]/;

/**
 * True when `source` is a **literal** stream name — it carries no regex
 * metacharacter, so every adapter treats it as an exact match. This is the
 * fast, index-friendly path and covers every autoclose/dynamic-resolver
 * source (bare stream names). A `false` return means the source is a
 * **pattern** (contains `^ $ . * + ? ( ) [ ] { } | \`) and must be compiled
 * as a RegExp before matching — the shape the calculator's static
 * `source: "^(A|B)$"` reaction relies on.
 *
 * The single source of truth for literal-vs-pattern classification across
 * the InMemory has-work probe, the drain fetch path, and the SQL adapters,
 * so all three agree on which sources take the exact path.
 *
 * @example
 * ```typescript
 * is_literal_source("Board");    // → true  (exact lookup)
 * is_literal_source("^(A|B)$");  // → false (compile as RegExp)
 * ```
 */
export function is_literal_source(source: string): boolean {
  return !SOURCE_METACHARACTERS.test(source);
}
