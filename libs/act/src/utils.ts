import { prettifyError, ZodError, type ZodType } from "zod";
import { config } from "./config.js";
import {
  ConcurrencyError,
  type EventMeta,
  type Message,
  type Schema,
  type Schemas,
  SNAP_EVENT,
  type StoreNotification,
  TOMBSTONE_EVENT,
  ValidationError,
} from "./types/index.js";

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
 * True when `source` is a stream's **name**, matched exactly. Only an anchored
 * source, one that starts with `^` or ends with `$`, is a **pattern** and gets
 * compiled as a RegExp. A name can hold any other character, so
 * `user+tag@example.com` and `order(1)` are names, and a pattern always says
 * that it is one.
 *
 * Pass the subscription's `target` too when it's known: a target reading itself
 * holds a stream's name, whatever characters that name has.
 *
 * The single source of truth for this across correlate (which decides what a
 * source marks), the drain fetch path, the close check, and the adapters, so
 * they all agree.
 *
 * @example
 * ```typescript
 * is_literal_source("Board");    // → true  (exact lookup)
 * is_literal_source("a+b");      // → true  (exact lookup)
 * is_literal_source("^(A|B)$");  // → false (compile as RegExp)
 * ```
 */
export function is_literal_source(source: string, target?: string): boolean {
  return (
    source === target || (!source.startsWith("^") && !source.endsWith("$"))
  );
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
 * Revive ISO-8601-shaped strings into `Date`s during `JSON.parse`.
 *
 * For host applications that parse Act JSON themselves (an export file, a
 * message forwarded by a webhook) and have no event schema at hand. It turns
 * every timestamp-shaped string into a `Date`, including fields declared as
 * `z.string()`. The framework doesn't use it: it converts only the fields an
 * event's schema declares as `z.date()`.
 */
export const dateReviver = (_key: string, value: unknown): unknown =>
  typeof value === "string" && ISO_8601.test(value) ? new Date(value) : value;

/**
 * What every store refuses in a `commit`: an append with no events, and a
 * stream named twice. In core so each adapter calls the one rule.
 *
 * @internal
 */
export function check_appends(
  appends: readonly {
    readonly stream: string;
    readonly msgs: readonly unknown[];
  }[]
): void {
  const seen = new Set<string>();
  for (const { stream, msgs } of appends) {
    if (!msgs.length)
      throw new Error(`commit: the append to "${stream}" has no events`);
    if (seen.has(stream))
      throw new Error(`commit: stream "${stream}" is named twice`);
    seen.add(stream);
  }
}

/**
 * The error a stale append raises, given the head the store found. A writer
 * that named no `expectedVersion` reads as `-1`: only a race between the
 * version check and the insert gets one here.
 *
 * @internal
 */
export function concurrency_error(
  append: {
    readonly stream: string;
    readonly msgs: readonly unknown[];
    readonly expectedVersion?: number;
  },
  head: number
): ConcurrencyError {
  return new ConcurrencyError(
    append.stream,
    head,
    append.msgs as Message<Schemas, keyof Schemas>[],
    append.expectedVersion ?? -1
  );
}

/**
 * What every store refuses as a stale writer: an append whose
 * `expectedVersion` is not the stream's head. In core so each adapter calls
 * the one rule before it appends anything.
 *
 * @internal
 */
export function throw_if_stale(
  append: {
    readonly stream: string;
    readonly msgs: readonly unknown[];
    readonly expectedVersion?: number;
  },
  head: number
): void {
  if (
    typeof append.expectedVersion === "number" &&
    head !== append.expectedVersion
  )
    throw concurrency_error(append, head);
}

/**
 * The event a full `truncate` seeds a stream with at version 0: a snapshot
 * of the given state, or a tombstone when there is none.
 *
 * @internal
 */
export function seed_event(
  snapshot?: Schema,
  meta?: EventMeta
): { name: string; data: Schema; meta: EventMeta } {
  return {
    name: snapshot !== undefined ? SNAP_EVENT : TOMBSTONE_EVENT,
    data: snapshot ?? {},
    meta: meta ?? { correlation: "", causation: {} },
  };
}

/**
 * How many of `lagging` claim slots ignore priority, so sustained high-priority
 * load can't starve a low-priority stream forever. Each store's `claim` calls
 * it, and the rule stays out of the `claim` signature.
 *
 * @internal
 */
export function fair_slots(lagging: number): number {
  return lagging >= 2 ? Math.max(1, Math.floor(lagging / 4)) : 0;
}

/**
 * The commit notification in a payload a store or broker received, or
 * `undefined` when there is none: `stream` must be a string, and only
 * `{ id: number, name: string }` events are kept, stripped of anything else.
 * A payload with no such event is not a notification. In core so every
 * listener reads a foreign or version-skewed payload the same way.
 *
 * @internal
 */
export function notification_of(raw: unknown): StoreNotification | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { stream, events } = raw as { stream?: unknown; events?: unknown };
  if (typeof stream !== "string" || !Array.isArray(events)) return undefined;
  const kept = events.filter(
    (e): e is { id: number; name: string } =>
      !!e &&
      typeof e === "object" &&
      typeof (e as { id?: unknown }).id === "number" &&
      typeof (e as { name?: unknown }).name === "string"
  );
  return kept.length
    ? { stream, events: kept.map(({ id, name }) => ({ id, name })) }
    : undefined;
}

/**
 * How many positions `query_streams` returns when the caller gives no limit.
 *
 * @internal
 */
export const DEFAULT_QUERY_STREAMS_LIMIT = 100;
