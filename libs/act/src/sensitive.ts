import { z } from "zod";
import type { Actor, Committed, Schemas } from "./types/index.js";

/**
 * Sentinel placed in `event.data[field]` when the caller isn't authorized to
 * see the sensitive field — either `.discloses(predicate)` returned `false`,
 * or no predicate was declared (framework default-deny). Recoverable: a
 * properly-authorized read returns the plaintext.
 */
export const REDACTED = "[REDACTED]" as const;

/**
 * Sentinel placed in `event.data[field]` when the underlying PII payload has
 * been wiped via `Store.forget_pii(stream)` — the row's pii column is `NULL`
 * and the original plaintext is gone forever. Irrecoverable.
 */
export const SHREDDED = "[SHREDDED]" as const;

/**
 * @packageDocumentation
 * @module act
 * @category Sensitive data
 *
 * Schema-level marking for sensitive (PII) event fields. The first piece of
 * the sensitive-data epic (#566) — colocates the security classification with
 * the type definition so there is one source of truth per field.
 *
 * Wrap a Zod field with `sensitive(...)` and the framework registers the
 * underlying schema in a process-global Zod registry. The wrapper is
 * type-transparent: `sensitive(z.string())` is still a `z.ZodString` from
 * TypeScript's perspective, so callers never need to know about the marker.
 *
 * @example
 * ```ts
 * import { state, sensitive } from "@rotorsoft/act";
 *
 * const UserRegistered = z.object({
 *   email: sensitive(z.string().email()),
 *   name: sensitive(z.string()),
 *   plan: z.enum(["free", "pro"]),  // not sensitive — stays in events.data
 * });
 * ```
 */

/**
 * Process-global registry holding every Zod schema marked sensitive. Backed
 * by a `WeakMap`, so wrapper-created instances (`.optional()`, `.nullable()`,
 * `.default()`) that chain off a marked schema produce *new* schema instances
 * the registry doesn't track; the field walker handles those via unwrap.
 */
const _registry = z.registry<{ sensitive: true }>();

/**
 * Mark a Zod schema as sensitive. Returns the same schema instance — the
 * marker is registered out-of-band so the static type is preserved and the
 * call site reads as a pure annotation.
 *
 * Idempotent: re-wrapping an already-sensitive schema is a no-op (the
 * registry entry already exists; `add()` overwrites with the same value).
 *
 * @param schema - The Zod schema to mark sensitive.
 * @returns The same schema instance, unmodified at the type level.
 */
export function sensitive<T extends z.ZodType>(schema: T): T {
  _registry.add(schema, { sensitive: true });
  return schema;
}

/**
 * Internal — true when the given schema was marked via {@link sensitive}.
 *
 * Walks through Zod wrapper layers (`.optional()`, `.nullable()`,
 * `.default()`, `.readonly()`) by following `_def.innerType` until it reaches
 * a non-wrapper schema, then checks the registry. Wrappers create new schema
 * instances; the marker lives on the *inner* schema the user wrapped, so we
 * test that one.
 *
 * @internal
 */
function is_pii(schema: z.ZodType): boolean {
  let cur: z.ZodType = schema;
  while (true) {
    if (_registry.has(cur)) return true;
    const inner = (cur as { _def?: { innerType?: z.ZodType } })._def?.innerType;
    if (!inner || inner === cur) return false;
    cur = inner;
  }
}

/**
 * Derive the list of sensitive field names from an event's Zod schema.
 *
 * Walks the top-level shape of a `z.object({...})` and returns the keys whose
 * schema (after unwrapping optional/nullable/default wrappers) was marked via
 * {@link sensitive}. Returns an empty array for non-object schemas or events
 * with no sensitive fields — the common-case zero-cost path.
 *
 * Only the top-level shape is walked. Sensitive fields nested inside a
 * `z.object` declared inside the event payload would require recursive
 * descent; that's deferred until a real callsite needs it.
 *
 * @internal — consumed by the registry's `sensitive_fields(eventName)` lookup.
 */
export function pii_fields(schema: z.ZodType): readonly string[] {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape || typeof shape !== "object") return [];
  const fields: string[] = [];
  for (const key of Object.keys(shape)) {
    if (is_pii(shape[key])) fields.push(key);
  }
  return fields;
}

/**
 * Build the **reducer view** of a committed event — sensitive fields merged
 * back into `data` so per-state reducers always see plaintext.
 *
 * - Event with no `pii` payload AND no schema-declared sensitive fields →
 *   return the event unchanged (zero-cost path).
 * - Event with a `pii` payload → merge into `data` (plaintext for the reducer).
 * - Event whose schema *declares* sensitive fields but `pii` is null/undefined
 *   (post-`forget_pii`) → substitute {@link SHREDDED} for each declared field.
 *
 * Used inside `load()` before invoking the reducer chain. Reducer-visible PII
 * is by design — the reducer is the source of truth for derived state. The
 * external view returned to callers is separately gated by {@link gate_external}.
 *
 * @internal
 */
export function merge_for_reducer<
  TEvents extends Schemas,
  TKey extends keyof TEvents & string,
>(
  event: Committed<TEvents, TKey>,
  fields: readonly string[]
): Committed<TEvents, TKey> {
  if (fields.length === 0) return event;
  const data = event.data as Record<string, unknown>;
  const pii = event.pii;
  if (pii != null) {
    return {
      ...event,
      data: { ...data, ...pii } as Committed<TEvents, TKey>["data"],
    };
  }
  // Schema declared sensitive fields but the pii payload is gone — shredded.
  const shredded: Record<string, unknown> = { ...data };
  for (const f of fields) shredded[f] = SHREDDED;
  return {
    ...event,
    data: shredded as Committed<TEvents, TKey>["data"],
  };
}

/**
 * Build the **external view** of a committed event — the form returned by
 * `load()`, `query()`, `query_array()`, and the snapshot in `do()`'s reply.
 *
 * - Event with no schema-declared sensitive fields → returned unchanged
 *   (zero-cost path).
 * - Event whose `pii` payload is null/undefined AND schema declares sensitive
 *   fields → substitute {@link SHREDDED} for each declared field. Irrecoverable,
 *   so no predicate check.
 * - Event with a `pii` payload, predicate returns `true` → merge `pii` into
 *   `data` (plaintext).
 * - Event with a `pii` payload, predicate returns `false` OR no predicate
 *   declared (framework default-deny) → substitute {@link REDACTED} for each
 *   declared field.
 *
 * @internal
 */
export function gate_external<
  TEvents extends Schemas,
  TKey extends keyof TEvents & string,
>(
  event: Committed<TEvents, TKey>,
  fields: readonly string[],
  predicate: ((event: any, actor: Actor) => boolean) | null,
  actor: Actor | undefined
): Committed<TEvents, TKey> {
  if (fields.length === 0) return event;
  const data = event.data as Record<string, unknown>;
  if (event.pii == null) {
    const shredded: Record<string, unknown> = { ...data };
    for (const f of fields) shredded[f] = SHREDDED;
    return {
      ...event,
      data: shredded as Committed<TEvents, TKey>["data"],
    };
  }
  // Plaintext path requires both an actor AND a predicate that allows. Missing
  // either → default-deny → REDACTED.
  const allowed = !!actor && !!predicate && predicate(event, actor);
  if (allowed) {
    return {
      ...event,
      data: {
        ...data,
        ...(event.pii as Record<string, unknown>),
      } as Committed<TEvents, TKey>["data"],
    };
  }
  const redacted: Record<string, unknown> = { ...data };
  for (const f of fields) redacted[f] = REDACTED;
  return {
    ...event,
    data: redacted as Committed<TEvents, TKey>["data"],
  };
}
