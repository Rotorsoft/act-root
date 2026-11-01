/**
 * The sensitive-data marker: the symbol `sensitive(zodType)` stamps on a
 * schema's definition, and the lookups that read it. The public
 * `sensitive()` and the two sentinels live in `types/schemas.ts`, which
 * re-exports `pii_fields` from here. The transforms that apply the marker at
 * commit, load and dispatch live in `internal/pii.ts`.
 */
import type { z } from "zod";
import { def_of, some_layer } from "./internal/zod.js";

/**
 * Marker key stamped onto a schema's own `def`. Zod clones a schema on every
 * refinement (`.min()`, `.email()`, `.trim()`, `.describe()`, `.refine()`,
 * …) via `{...def}`, which copies own symbol keys — so a marker on the def
 * survives the whole chain. Wrappers (`.optional()`, `.transform()`,
 * `z.preprocess()`, `z.lazy()`, …) build a new schema around the marked one;
 * `is_pii` looks through them.
 */
const _SENSITIVE = Symbol.for("act.sensitive");

/**
 * Stamp the def-level marker. Called by the public `sensitive()`. Throws on a
 * schema with no Zod 4 definition: marking nothing would store the field in
 * plain text.
 */
export function _mark_sensitive(schema: z.ZodType): void {
  const def = def_of(schema);
  if (!def) throw new Error("sensitive() takes a Zod 4 schema");
  def[_SENSITIVE] = true;
}

/**
 * True when the schema, or any schema it wraps, was marked via
 * `sensitive(...)`: behind every wrapper, on either side of a pipe, and
 * inside a lazy schema.
 */
const is_pii = (schema: z.ZodType): boolean =>
  some_layer(schema, (def) => def[_SENSITIVE] === true);

/**
 * Derive an event's sensitive fields, as the declared schema of each.
 *
 * Walks the top-level shape of a `z.object({...})` and keeps the keys whose
 * schema (after unwrapping optional/nullable/default wrappers) was marked via
 * `sensitive(...)`. Returns an empty object for non-object schemas or events
 * with no sensitive fields — the common-case zero-cost path.
 *
 * Only the top-level shape is walked. Sensitive fields nested inside a
 * `z.object` declared inside the event payload would require recursive
 * descent; that's deferred until a real callsite needs it.
 *
 * A union event has no top-level shape, so the options are walked and merged:
 * a key sensitive in any variant must be split, because the stored payload
 * could be that variant.
 * The first variant to declare a key wins, which only matters to a caller that
 * wants the schema rather than the name.
 *
 * Returning the schemas rather than just the names is what lets a caller do
 * something per field — the event builder asks each one whether it holds a
 * date, so the `pii` sidecar's dates can be revived like any other.
 */
export function pii_schemas(schema: z.ZodType): Record<string, z.ZodType> {
  const shape = (schema as { shape?: Record<string, z.ZodType> }).shape;
  if (shape && typeof shape === "object") {
    const fields: Record<string, z.ZodType> = {};
    for (const key of Object.keys(shape))
      if (is_pii(shape[key])) fields[key] = shape[key];
    return fields;
  }
  const options = (schema as { options?: unknown }).options;
  if (Array.isArray(options)) {
    const fields: Record<string, z.ZodType> = {};
    for (const option of options)
      for (const [key, field] of Object.entries(
        pii_schemas(option as z.ZodType)
      ))
        fields[key] ??= field;
    return fields;
  }
  return {};
}

/**
 * The top-level field names of a schema marked with `sensitive()`. Adapters
 * and tooling use it to reflect sensitivity on their own wire surface (the
 * act-http OpenAPI emitter marks these fields `writeOnly`). Returns `[]`
 * for a schema with no sensitive fields.
 */
export function pii_fields(schema: z.ZodType): readonly string[] {
  return Object.keys(pii_schemas(schema));
}
