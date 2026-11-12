/**
 * @packageDocumentation
 * @module act/adapter
 *
 * The rules a `Store` implementation calls, so each one lives once in core and
 * a third-party store can't drift from it. Each is a pure function of its
 * arguments. Import them by name, or as
 * `import * as adapter from "@rotorsoft/act/adapter"`. Writing a store:
 * https://rotorsoft.github.io/act-root/docs/guides/writing-a-store
 */
import {
  ConcurrencyError,
  type EventMeta,
  type Message,
  type Schema,
  type Schemas,
  SNAP_EVENT,
  type StoreNotification,
  TOMBSTONE_EVENT,
} from "./types/index.js";

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
 * isStreamName("Board");    // → true  (exact lookup)
 * isStreamName("a+b");      // → true  (exact lookup)
 * isStreamName("^(A|B)$");  // → false (compile as RegExp)
 * ```
 */
export function isStreamName(source: string, target?: string): boolean {
  return (
    source === target || (!source.startsWith("^") && !source.endsWith("$"))
  );
}

/**
 * What every store refuses in a `commit`: an append with no events, and a
 * stream named twice. In core so each adapter calls the one rule.
 */
export function checkAppends(
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
 */
export function concurrencyError(
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
 */
export function checkVersion(
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
    throw concurrencyError(append, head);
}

/**
 * The event a full `truncate` seeds a stream with at version 0: a snapshot
 * of the given state, or a tombstone when there is none.
 */
export function seedEvent(
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
 */
export function fairSlots(lagging: number): number {
  return lagging >= 2 ? Math.max(1, Math.floor(lagging / 4)) : 0;
}

/**
 * The commit notification in a payload a store or broker received, or
 * `undefined` when there is none: `stream` must be a string, and only
 * `{ id: number, name: string }` events are kept, stripped of anything else.
 * A payload with no such event is not a notification. In core so every
 * listener reads a foreign or version-skewed payload the same way.
 */
export function parseNotification(raw: unknown): StoreNotification | undefined {
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
