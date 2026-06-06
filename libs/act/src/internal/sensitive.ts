/**
 * @module sensitive
 * @category Internal
 *
 * Internal mechanics for the sensitive-data foundation (#855 / epic #566).
 * The public surface (`sensitive(zodType)`) lives at `libs/act/src/sensitive.ts`
 * and re-exports `REDACTED` / `SHREDDED` from here; this module holds the
 * registry plus the helpers the orchestrator calls during commit, load, and
 * handler dispatch.
 *
 * - `_registry` — process-global `z.registry<{ sensitive: true }>()`. Public
 *   `sensitive()` adds to it; the helpers in this module read it.
 * - `pii_fields(schema)` — walk a Zod schema's top-level shape, return the
 *   keys marked via `sensitive(...)`.
 * - `merge_for_reducer(event, fields)` — produce the reducer view (pii merged
 *   into data; `[SHREDDED]` if pii column is null).
 * - `gate_external(event, fields, predicate, actor)` — produce the external
 *   view: plaintext when authorized, `[REDACTED]` when not, `[SHREDDED]`
 *   when the underlying pii column is null.
 * - `strip_for_handler(event, fields)` — remove sensitive keys entirely
 *   before invoking projection / reaction handlers.
 *
 * @internal
 */

import { z } from "zod";
import type { Actor, Committed, Schemas } from "../types/index.js";

/**
 * Sentinel placed in `event.data[field]` when the caller isn't authorized to
 * see the sensitive field — either `.discloses(predicate)` returned `false`,
 * or no predicate was declared (framework default-deny). Recoverable: a
 * properly-authorized read returns the plaintext.
 *
 * Re-exported from `libs/act/src/sensitive.ts` as part of the public surface.
 */
export const REDACTED = "[REDACTED]" as const;

/**
 * Sentinel placed in `event.data[field]` when the underlying PII payload has
 * been wiped via `Store.forget_pii(stream)` — the row's pii column is `NULL`
 * and the original plaintext is gone forever. Irrecoverable.
 *
 * Re-exported from `libs/act/src/sensitive.ts` as part of the public surface.
 */
export const SHREDDED = "[SHREDDED]" as const;

/**
 * Process-global registry holding every Zod schema marked sensitive. Backed
 * by a `WeakMap`, so wrapper-created instances (`.optional()`, `.nullable()`,
 * `.default()`) that chain off a marked schema produce *new* schema instances
 * the registry doesn't track; the field walker handles those via unwrap.
 *
 * Exported so the public `sensitive(zodType)` wrapper can call `_registry.add`.
 * Underscore prefix marks "framework-private, don't touch from user code."
 *
 * @internal
 */
export const _registry = z.registry<{ sensitive: true }>();

/**
 * True when the given schema was marked via `sensitive(...)`.
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
 * `sensitive(...)`. Returns an empty array for non-object schemas or events
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
 * Split an emitted event's `data` into `data` (non-sensitive) + `pii`
 * (sensitive) using the field list precomputed at build time. Used by the
 * State's `_split_emitted` decorator just before `Store.commit`.
 *
 * Single forward pass over `Object.keys(validated)` — same shape as the
 * spread-and-delete-free implementation in slice 3, just hoisted out of the
 * orchestrator hot path so it's only invoked when the State actually has a
 * sensitive event.
 *
 * @internal
 */
export function split_payload(
  emitted: { name: unknown; data: unknown },
  fields: readonly string[]
): { name: unknown; data: unknown; pii: Record<string, unknown> } {
  const rec = emitted.data as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  const pii: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    if (fields.includes(k)) pii[k] = rec[k];
    else clean[k] = rec[k];
  }
  return { name: emitted.name, data: clean, pii };
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
  // Contract: `fields` is non-empty. Callers (the State's `_merge_for_reducer`
  // decorator) filter on `fields_by_event.get(name)` before invocation, so the
  // empty-fields short-circuit lives at the caller, not here.
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
  // Contract: `fields` is non-empty. The State's `_gate_external` decorator
  // filters on `fields_by_event.get(name)` before invocation.
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

/**
 * Build the **handler view** — sensitive keys removed entirely from `data`
 * and the `pii` field dropped from the event. Used before invoking projection
 * handlers and reaction handlers, which never see PII by framework rule.
 *
 * Different from {@link gate_external} (which substitutes {@link REDACTED} or
 * {@link SHREDDED}) — projection tables and reaction sinks shouldn't even
 * structurally observe the keys, so a handler that mistakenly writes
 * `event.data.email` into a column would get `undefined`, not a sentinel
 * string that looks like real data. The strictness is deliberate.
 *
 * Reactions that genuinely need PII (e.g. a welcome-email reaction reading
 * `email`) opt back in by explicitly calling `app.load(stream, { actor:
 * systemActor })` inside the handler — pulling PII through the gate at the
 * call site makes the security-relevant path visible in code review.
 *
 * @internal
 */
export function strip_for_handler<
  TEvents extends Schemas,
  TKey extends keyof TEvents & string,
>(
  event: Committed<TEvents, TKey>,
  fields: readonly string[]
): Committed<TEvents, TKey> {
  // Contract: `fields` is non-empty. `buildHandle` / `buildHandleBatch`
  // filter on `fields.length > 0` before invocation.
  const data = event.data as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (!fields.includes(k)) stripped[k] = data[k];
  }
  const { pii: _drop_pii, ...rest } = event as Committed<TEvents, TKey> & {
    pii?: unknown;
  };
  return {
    ...rest,
    data: stripped as Committed<TEvents, TKey>["data"],
  } as Committed<TEvents, TKey>;
}
