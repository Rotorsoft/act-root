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
 * - **date paths** — the keys declared `z.date()`. JSON has no date type, so a
 *   `Date` leaves as a string and something must turn it back. An adapter can
 *   only guess from string shape, which revives any ISO-8601-looking string
 *   including one a schema declared `z.string()`. The schema is the authority
 *   and the framework holds it, so the paths are resolved here and the read
 *   path converts exactly those.
 *
 * Both are derived once at `act().build()`. Walking the shape twice for two
 * answers would be the same work done twice.
 *
 * Only `z.date()` needs reviving. Framework metadata carries no dates —
 * `EventMetaSchema` is a correlation string plus causation names and ids — and
 * `created` is a real column each adapter parses directly.
 *
 * @internal
 */

import type { z } from "zod";
import type { Schema } from "../types/index.js";
import { is_pii } from "./sensitive.js";

/** A `Date` path inside an event payload, as the segments to walk. */
export type DatePath = readonly string[];

/** What one pass over an event schema resolves. @internal */
export type EventTags = {
  /** Keys marked `sensitive(...)`, top level (and across union variants). */
  readonly sensitive: readonly string[];
  /** Paths declared `z.date()`. */
  readonly dates: readonly DatePath[];
};

/** Zod exposes its shape under `_zod.def` in v4 and `def` in older builds. */
const def_of = (schema: unknown): Record<string, unknown> | undefined =>
  (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
  (schema as { def?: Record<string, unknown> }).def;

/** Unwrap the wrappers that don't change the declared type. */
const unwrap = (schema: unknown): unknown => {
  let s = schema;
  for (;;) {
    const def = def_of(s);
    const t = def?.type;
    if (
      t === "optional" ||
      t === "nullable" ||
      t === "default" ||
      t === "readonly"
    )
      s = def?.innerType;
    else return s;
  }
};

/**
 * Resolve an event's schema in a single pass.
 *
 * Sensitive markers are read at the top level only — the documented carve-out
 * (`sensitive.ts`), since the write path splits whole top-level keys. Date
 * paths descend nested objects, because a `Date` is reconstructed in place
 * wherever it sits. Arrays and records are deliberately not descended: their
 * element paths are not statically enumerable, so a date inside one keeps the
 * value the adapter produced rather than paying a per-element walk on every
 * read.
 *
 * A union event has no top-level shape. Its variants are walked and unioned —
 * a key sensitive in any variant must be split, because the stored payload
 * could be that variant (#1417), and the same reasoning applies to dates.
 *
 * @internal
 */
export function event_tags(schema: z.ZodType): EventTags {
  const sensitive: string[] = [];
  const dates: DatePath[] = [];

  const walk = (node: unknown, prefix: DatePath, top: boolean): void => {
    const inner = unwrap(node);
    const def = def_of(inner);
    if (!def) return;

    if (def.type === "date") {
      dates.push(prefix);
      return;
    }

    const shape = def.shape as Record<string, z.ZodType> | undefined;
    if (shape && typeof shape === "object") {
      for (const key of Object.keys(shape)) {
        // Sensitivity is a top-level property; `is_pii` does its own
        // unwrapping, so it reads the declared field, not the unwrapped node.
        if (top && is_pii(shape[key])) sensitive.push(key);
        walk(shape[key], [...prefix, key], false);
      }
      return;
    }

    const options = (inner as { options?: unknown }).options;
    if (Array.isArray(options))
      for (const option of options) walk(option, prefix, top);
  };

  walk(schema, [], true);
  return { sensitive: [...new Set(sensitive)], dates };
}

/**
 * Build the reviver for one event's date paths, or `undefined` when it has
 * none — the overwhelming majority, so the read path skips the step and pays
 * nothing. Mirrors how `registry.query_gate` treats a non-sensitive event.
 *
 * The returned function mutates the payload it is handed. Callers own freshly
 * parsed store rows, never a cached object.
 *
 * @internal
 */
export function make_date_reviver(
  dates: readonly DatePath[]
): ((data: Schema) => void) | undefined {
  if (dates.length === 0) return undefined;
  return (data: Schema) => {
    for (const path of dates) {
      let target = data as Record<string, unknown>;
      for (let i = 0; i < path.length - 1 && target; i++)
        target = target[path[i]] as Record<string, unknown>;
      const key = path[path.length - 1];
      // Only a string needs converting: a `Date` already survived (InMemory
      // stores by reference), and null/undefined are the schema's business.
      if (target && typeof target[key] === "string")
        target[key] = new Date(target[key] as string);
    }
  };
}
