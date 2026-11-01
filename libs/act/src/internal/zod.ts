/**
 * The one place that reads Zod's internals.
 *
 * Several features look inside a field's schema: whether it was marked
 * `sensitive(...)`, whether its value is a string, whether it holds a date to
 * revive. They must agree on which wrappers they see through, so they all ask
 * this module rather than each walking the schema its own way.
 * `architecture.spec` keeps every other file away from `_zod`.
 */
import type { z } from "zod";

/** A Zod schema's definition, which every wrapper and marker lives on. */
type Def = Record<PropertyKey, any>;

/** The schema's definition (Zod 4 keeps it under `_zod.def`). */
export const def_of = (schema: unknown): Def | undefined =>
  (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;

/**
 * The schemas a wrapper holds, or none for anything that isn't one:
 * - `.optional()`, `.nullable()`, `.default()`, `.prefault()`,
 *   `.nonoptional()`, `.readonly()` and `.catch()` hold one inner schema;
 * - a pipe holds its input and its output: `.transform()`, `.pipe()` and
 *   `z.preprocess()` all build one;
 * - `z.lazy()` holds what its getter returns.
 */
export function wrapped(schema: unknown): z.ZodType[] {
  const def = def_of(schema);
  if (!def) return [];
  if (def.type === "pipe") return [def.in, def.out];
  if (def.type === "lazy") return [def.getter()];
  return def.innerType ? [def.innerType] : [];
}

/**
 * True when `test` holds for the schema or any schema it wraps, at any depth.
 * Each schema is visited once, so a lazy schema that returns itself ends.
 */
export function some_layer(
  schema: unknown,
  test: (def: Def) => boolean
): boolean {
  const seen = new Set<unknown>();
  const visit = (s: unknown): boolean => {
    if (seen.has(s)) return false;
    seen.add(s);
    const def = def_of(s);
    return !!def && (test(def) || wrapped(s).some(visit));
  };
  return visit(schema);
}

/**
 * The schema that describes the value a schema produces: through every
 * wrapper to its innermost schema, taking a pipe's output side. A transform's
 * output can't be known, so the walk stops at it.
 */
export function output_of(schema: unknown): unknown {
  const seen = new Set<unknown>();
  let cur = schema;
  while (!seen.has(cur)) {
    seen.add(cur);
    const def = def_of(cur);
    if (!def) return cur;
    if (def.type === "pipe") cur = def.out;
    else if (def.type === "lazy") cur = def.getter();
    else if (def.innerType) cur = def.innerType;
    else return cur;
  }
  return cur;
}
