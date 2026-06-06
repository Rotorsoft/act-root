import { z } from "zod";

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
const sensitiveRegistry = z.registry<{ sensitive: true }>();

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
  sensitiveRegistry.add(schema, { sensitive: true });
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
function isSensitiveSchema(schema: z.ZodType): boolean {
  let cur: z.ZodType = schema;
  while (true) {
    if (sensitiveRegistry.has(cur)) return true;
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
export function getSensitiveFields(schema: z.ZodType): readonly string[] {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape || typeof shape !== "object") return [];
  const fields: string[] = [];
  for (const key of Object.keys(shape)) {
    if (isSensitiveSchema(shape[key])) fields.push(key);
  }
  return fields;
}
