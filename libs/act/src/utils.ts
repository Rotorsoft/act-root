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

/**
 * Matches an ISO-8601 timestamp, the shape `JSON.stringify` produces for a
 * `Date`.
 *
 * @internal
 */
const ISO_8601 =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.\d+)?(Z|[+-][0-2][0-9]:[0-5][0-9])?$/;

/**
 * `JSON.parse` reviver that turns ISO-8601 strings back into `Date`s.
 *
 * JSON has no date type, so a `Date` committed into an event's `data`,
 * `meta`, or `pii` serializes to a string. Reading it back as a string
 * would silently break reducers that call `.getTime()` — and would do so
 * on some adapters and not others. Every adapter therefore revives dates
 * on read, and this is the single definition they share, so the behavior
 * can't drift between them ([#1198](https://github.com/Rotorsoft/act-root/issues/1198)).
 *
 * Adapters must apply it to **every** JSON column they read, including
 * decrypted `pii` payloads — a value's runtime type must not depend on
 * which column it sits in or whether encryption is enabled
 * ([#1365](https://github.com/Rotorsoft/act-root/issues/1365),
 * [#1370](https://github.com/Rotorsoft/act-root/issues/1370)). Third-party
 * adapters need it to pass the store TCK's Date round-trip cases.
 *
 * The trade-off is deliberate: a string that happens to look like a
 * timestamp is revived into a `Date`. That is the price of dates surviving
 * a JSON round trip at all, and it is applied uniformly.
 *
 * @param _key - Unused; present to satisfy the `JSON.parse` reviver shape.
 * @param value - The parsed value.
 * @returns A `Date` when `value` is an ISO-8601 string, otherwise `value`.
 *
 * @example
 * ```typescript
 * JSON.parse('{"at":"2024-03-01T10:20:30.000Z"}', dateReviver);
 * // → { at: Date }
 * ```
 */
export const dateReviver = (_key: string, value: unknown): unknown =>
  typeof value === "string" && ISO_8601.test(value) ? new Date(value) : value;
