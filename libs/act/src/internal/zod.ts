/**
 * The one place that reads Zod's internals.
 *
 * Several features look inside a field's schema: whether it was marked
 * `sensitive(...)`, whether its value is a string, whether it holds a date to
 * revive. They must agree on which wrappers they see through, so they all ask
 * this module rather than each walking the schema its own way. The date
 * reviver makes two exceptions on purpose, named where it makes them: it keeps
 * a nullable's null, and it doesn't follow `z.lazy()`.
 * `architecture.spec` keeps every other file away from `_zod`.
 */
import type { z } from "zod";

/** A Zod schema's definition, which every wrapper and marker lives on. */
type Def = Record<PropertyKey, any>;

/** The schema's definition (Zod 4 keeps it under `_zod.def`). */
export const def_of = (schema: unknown): Def | undefined =>
  (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;

/**
 * The wrappers that hold one inner schema and produce its value.
 * `z.success()` and `z.promise()` keep an `innerType` too, but their value is
 * a boolean or a promise, not the inner schema's.
 */
const SINGLE_INNER: readonly string[] = [
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
];

/** The inner schema of a wrapper in {@link SINGLE_INNER}, or `undefined`. */
export const inner_of = (def: Def): z.ZodType | undefined =>
  SINGLE_INNER.includes(def.type) ? def.innerType : undefined;

/**
 * The schemas a wrapper holds, or none for anything that isn't one:
 * - a single-inner wrapper ({@link inner_of}) holds its inner schema;
 * - a pipe holds its input and its output: `.transform()`, `.pipe()` and
 *   `z.preprocess()` all build one;
 * - `z.lazy()` holds what its getter returns.
 */
export function wrapped(schema: unknown): z.ZodType[] {
  const def = def_of(schema);
  if (!def) return [];
  if (def.type === "pipe") return [def.in, def.out];
  if (def.type === "lazy") return [def.getter()];
  const inner = inner_of(def);
  return inner ? [inner] : [];
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
    const next = def.type === "pipe" ? def.out : wrapped(cur)[0];
    if (!next) return cur;
    cur = next;
  }
  return cur;
}
