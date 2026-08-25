/**
 * @module event-tags
 * @category Internal
 *
 * One pass over an event's declared schema, yielding everything the framework
 * needs to know about that event's shape.
 *
 * Two facts come out of the same traversal:
 *
 * - **sensitive fields** — the keys marked with `sensitive(...)`, which the
 *   write path splits into the `pii` sidecar and the read gates redact.
 * - **a read parser** — how to type a stored payload. JSON has no date type,
 *   so a `Date` leaves as a string. An adapter cannot know which strings were
 *   dates and used to guess from shape, reviving anything ISO-8601-looking
 *   including fields declared `z.string()`. The schema is the authority, so
 *   the parser is derived from the declaration.
 *
 * The parser is Zod's own. Rather than hand-rolling a traversal that would
 * have to re-implement arrays, records, unions and every construct Zod grows,
 * the declared schema is transformed once at build time — `z.date()` becomes
 * coercing, objects become loose — and `parse` does the work. Anything Zod can
 * describe, this types correctly, and it stays correct as Zod evolves.
 *
 * Objects are made **loose** deliberately: a strict Zod object strips keys it
 * does not declare, and an event store can hold payloads carrying fields a
 * current schema no longer mentions. Silently dropping them on read would be
 * worse than the mistyping this fixes.
 *
 * Only `z.date()` needs any of this. Framework metadata carries no dates —
 * `EventMetaSchema` is a correlation string plus causation names and ids — and
 * `created` is a real column each adapter parses directly.
 *
 * @internal
 */

import { z } from "zod";
import { is_pii } from "./sensitive.js";

/** What one pass over an event schema resolves. @internal */
export type EventTags = {
  /** Keys marked `sensitive(...)`, top level (and across union variants). */
  readonly sensitive: readonly string[];
  /**
   * Types a stored payload against the declaration, or `undefined` when the
   * schema declares no dates — the overwhelming majority, so the read path
   * skips the step and pays nothing.
   */
  readonly read: ((data: unknown) => unknown) | undefined;
};

/** Zod exposes its shape under `_zod.def` in v4 and `def` in older builds. */
const def_of = (schema: unknown): Record<string, unknown> | undefined =>
  (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
  (schema as { def?: Record<string, unknown> }).def;

/**
 * Rebuild a schema for reading: dates coerce from their stored string, and
 * objects keep keys they don't declare.
 *
 * A construct this doesn't recognise is returned untouched, so an unfamiliar
 * schema still parses — it just won't coerce dates buried inside one. That
 * fallthrough is what keeps this small: it describes the shapes worth
 * rebuilding, not every shape that exists.
 */
function to_read_schema(schema: unknown, found: { date: boolean }): unknown {
  const def = def_of(schema);
  if (!def) return schema;
  switch (def.type) {
    case "date":
      found.date = true;
      return z.coerce.date();
    case "object": {
      const shape = def.shape as Record<string, z.ZodType> | undefined;
      if (!shape) return schema;
      const next: Record<string, z.ZodType> = {};
      for (const [key, inner] of Object.entries(shape))
        next[key] = to_read_schema(inner, found) as z.ZodType;
      // Loose: an event store can hold keys the current schema doesn't
      // declare, and dropping them on read would lose committed data.
      return z.looseObject(next);
    }
    case "array":
      return z.array(to_read_schema(def.element, found) as z.ZodType);
    case "record":
      return z.record(
        z.string(),
        to_read_schema(def.valueType, found) as z.ZodType
      );
    case "union":
      return z.union(
        (def.options as unknown[]).map(
          (o) => to_read_schema(o, found) as z.ZodType
        ) as never
      );
    case "optional":
      return (to_read_schema(def.innerType, found) as z.ZodType).optional();
    case "nullable":
      return (to_read_schema(def.innerType, found) as z.ZodType).nullable();
    default:
      return schema;
  }
}

/**
 * Resolve an event's schema in a single pass.
 *
 * Sensitive markers are read at the top level only — the documented carve-out
 * (`sensitive.ts`), since the write path splits whole top-level keys. A union
 * event has no top-level shape, so its variants are walked and unioned: a key
 * sensitive in any variant must be split, because the stored payload could be
 * that variant (#1417).
 *
 * @internal
 */
export function event_tags(schema: z.ZodType): EventTags {
  const sensitive: string[] = [];

  const collect = (node: unknown): void => {
    const def = def_of(node);
    const shape = def?.shape as Record<string, z.ZodType> | undefined;
    if (shape) {
      for (const key of Object.keys(shape))
        if (is_pii(shape[key])) sensitive.push(key);
      return;
    }
    const options = (node as { options?: unknown }).options;
    if (Array.isArray(options)) for (const option of options) collect(option);
  };
  collect(schema);

  const found = { date: false };
  const read_schema = to_read_schema(schema, found);
  const read = found.date
    ? (data: unknown) => (read_schema as z.ZodType).parse(data)
    : undefined;

  return { sensitive: [...new Set(sensitive)], read };
}
