/**
 * @module date-reviver
 * @category Internal
 *
 * Turning stored text back into `Date`s, driven by the declared schema.
 *
 * JSON has no date type, so a `Date` is stored as its ISO form and something
 * has to revive it on the way out. Which fields those are is a property of the
 * Zod schema, so working it out is a Zod concern rather than an event one —
 * this module knows nothing about events, states or PII. It takes a declared
 * schema and returns the schema that revives its dates, or `undefined` when
 * there are none to revive.
 *
 * Sits beside the other schema utilities rather than inside the event builder,
 * which composes it: `event_tags` asks for one reviver for an event's `data`
 * and another for the sensitive fields held in its `pii` sidecar. One function
 * is the whole interface — how a Zod schema is taken apart stays in here.
 *
 * The shape-based {@link dateReviver} in `utils.ts` is the predecessor this
 * replaced — it revived anything ISO-8601-looking, including fields declared
 * `z.string()` ([#1556](https://github.com/Rotorsoft/act-root/issues/1556)).
 *
 * @internal
 */

import { z } from "zod";

/** Zod exposes its shape under `_zod.def` in v4 and `def` in older builds. */
const def_of = (schema: unknown): Record<string, unknown> | undefined =>
  (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
  (schema as { def?: Record<string, unknown> }).def;

/**
 * Rebuild one union variant so it still recognises its own payloads.
 *
 * Same date coercion as everywhere else, but the variant keeps its other
 * fields — this is the one place the date paths alone are not enough. A
 * variant can only reject a sibling's payload if enough of its shape is left
 * to check, and which fields do that is not knowable: a literal discriminator
 * usually does it, but a union can just as well be told apart by the *type* of
 * an ordinary field. Narrowing to the dates, or relaxing the rest, makes the
 * first variant match everything, so the one that declared the date is never
 * tried and a sibling's payload is read under the wrong rules.
 *
 * Every key is optional, so the variant still matches when a `sensitive(...)`
 * field sits in the `pii` sidecar or when a stored payload predates a field
 * the declaration has since gained.
 *
 * Reports whether this variant declared a date, so a union with none anywhere
 * builds nothing at all.
 */
function variant_schema(schema: unknown): {
  schema: z.ZodType;
  dated: boolean;
} {
  const shape = def_of(schema)?.shape as Record<string, z.ZodType> | undefined;
  if (!shape) {
    const dates = date_reviver_schema(schema);
    return { schema: dates ?? (schema as z.ZodType), dated: !!dates };
  }
  const next: Record<string, z.ZodType> = {};
  let dated = false;
  for (const [key, field] of Object.entries(shape)) {
    const dates = date_reviver_schema(field);
    if (dates) dated = true;
    next[key] = (dates ?? field).optional();
  }
  return { schema: z.looseObject(next), dated };
}

/**
 * Build the schema that revives an event's dates, or `undefined` when it
 * declares none.
 *
 * JSON has no date type, so a stored `Date` comes back as text and something
 * has to turn it back. That is this function's only job, and the schema it
 * returns says only where the dates are: every other field is left out and
 * rides through the loose object untouched. The payload was validated when it
 * was committed, so re-checking it on the way out would be work already done.
 *
 * Naming only the dates is also what makes a read tolerant, without needing a
 * rule per exception. A `sensitive(...)` field lives in the `pii` sidecar
 * rather than in `data`; an event written against an older declaration
 * predates whatever was added since; a field dropped from the declaration is
 * still in the store. None of those are dates, so none of them are described
 * here, and a payload carrying any of them still reads. The dates themselves
 * are optional for the same reason — absent is not wrong.
 *
 * Zod does the walking, so nesting, arrays, records, unions and the wrappers
 * are handled by the engine rather than by a traversal of our own that would
 * drift as Zod grows constructs. A construct this doesn't recognise
 * contributes no date, which is the documented fallthrough.
 */
export function date_reviver_schema(schema: unknown): z.ZodType | undefined {
  const def = def_of(schema);
  if (!def) return undefined;
  const inner = () => date_reviver_schema(def.innerType);
  switch (def.type) {
    case "date":
      return z.coerce.date();
    case "object": {
      const shape = def.shape as Record<string, z.ZodType> | undefined;
      if (!shape) return undefined;
      const dated: Record<string, z.ZodType> = {};
      for (const [key, field] of Object.entries(shape)) {
        const dates = date_reviver_schema(field);
        if (dates) dated[key] = dates.optional();
      }
      return Object.keys(dated).length ? z.looseObject(dated) : undefined;
    }
    case "array": {
      const element = date_reviver_schema(def.element);
      return element && z.array(element);
    }
    case "tuple": {
      const items = (def.items as unknown[]).map((i) => date_reviver_schema(i));
      return items.some(Boolean)
        ? z.tuple(items.map((i) => i ?? z.unknown()) as never)
        : undefined;
    }
    case "record": {
      const value = date_reviver_schema(def.valueType);
      return value && z.record(z.string(), value);
    }
    case "union": {
      // A union is the one place the date paths are not enough. Zod picks a
      // variant by trying each until one matches, so an option reduced to its
      // dates matches almost anything and the first one wins — the variant
      // that actually declared the date never gets tried, and a sibling's
      // payload gets the wrong variant's rules. Every option therefore keeps
      // its fields; see {@link variant_schema}.
      const variants = (def.options as unknown[]).map(variant_schema);
      return variants.some((v) => v.dated)
        ? z.union(variants.map((v) => v.schema) as never)
        : undefined;
    }
    case "nullable":
      // Keep the null: coercing it would hand back the epoch.
      return inner()?.nullable();
    case "optional":
    case "nonoptional":
    case "readonly":
    case "default":
    case "prefault":
    case "catch":
      return inner();
    default:
      return undefined;
  }
}
