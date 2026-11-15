/**
 * The sensitive-data marker: the symbol `sensitive(zodType)` stamps on a
 * schema's definition, and the lookups that read it. The public
 * `sensitive()` and the two sentinels live in `types/schemas.ts`, which
 * re-exports `sensitiveFields` from here. The marker and its lookups live in
 * `internal/sensitive.ts`; the transforms that apply it at commit, load and
 * dispatch live in `internal/pii.ts`.
 */
import type { z } from "zod";
import { pii_schemas, SENSITIVE } from "./internal/sensitive.js";
import { def_of } from "./internal/zod.js";

/**
 * Stamp the def-level marker. Called by the public `sensitive()`. Throws on a
 * schema with no Zod 4 definition: marking nothing would store the field in
 * plain text.
 */
export function _mark_sensitive(schema: z.ZodType): void {
  const def = def_of(schema);
  if (!def) throw new Error("sensitive() takes a Zod 4 schema");
  def[SENSITIVE] = true;
}

/**
 * The top-level field names of a schema marked with `sensitive()`. Adapters
 * and tooling use it to reflect sensitivity on their own wire surface (the
 * act-http OpenAPI emitter marks these fields `writeOnly`). Returns `[]`
 * for a schema with no sensitive fields.
 */
export function sensitiveFields(schema: z.ZodType): readonly string[] {
  return Object.keys(pii_schemas(schema));
}

/**
 * @deprecated Use {@link sensitiveFields}. Removed in 3.0.
 */
export const pii_fields = sensitiveFields;
