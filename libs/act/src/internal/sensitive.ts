// The sensitive-data marker `sensitive()` stamps on a schema, and the lookups
// that read it. The public `sensitive()` is in `../types/schemas.ts`; an app's
// sensitive fields are `registry.sensitive_fields`.
import type { z } from "zod";
import { some_layer } from "./zod.js";

/**
 * Marker key stamped onto a schema's own `def`. Zod clones a schema on every
 * refinement (`.min()`, `.email()`, `.trim()`, `.describe()`, `.refine()`,
 * …) via `{...def}`, which copies own symbol keys — so a marker on the def
 * survives the whole chain. Wrappers (`.optional()`, `.transform()`,
 * `z.preprocess()`, `z.lazy()`, …) build a new schema around the marked one;
 * `is_pii` looks through them.
 */
const SENSITIVE = Symbol.for("act.sensitive");

/**
 * True when the schema, or any schema it wraps, was marked via
 * `sensitive(...)`: behind every wrapper, on either side of a pipe, and
 * inside a lazy schema.
 */
const is_pii = (schema: z.ZodType): boolean =>
  some_layer(schema, (def) => def[SENSITIVE] === true);

/**
 * Derive an event's sensitive fields, as the declared schema of each.
 *
 * Walks the top-level shape of a `z.object({...})` and keeps the keys whose
 * schema was marked via `sensitive(...)`, behind any wrapper (see `is_pii`). Returns an empty object for non-object schemas or events
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
