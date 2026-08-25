/**
 * @module event-reader
 * @category Internal
 *
 * How a stored event becomes the form a consumer sees.
 *
 * Two things happen to an event on the way out, and both are decided by its
 * declared schema:
 *
 * - **typing** — JSON has no date type, so a `Date` leaves as a string. An
 *   adapter cannot know which strings were dates and used to guess from shape,
 *   reviving anything ISO-8601-looking including fields declared `z.string()`.
 *   The schema is the authority, so the read parser is derived from it
 *   ([#1556](https://github.com/Rotorsoft/act-root/issues/1556)).
 * - **disclosure** — `sensitive(...)` fields are redacted for a reader that
 *   isn't authorized, or removed entirely before a handler sees them.
 *
 * They are resolved together, in one pass over the schema, and composed into a
 * single {@link EventGate}. Consumers ask for one reader and call it; nothing
 * outside this module opens an event to type it and then opens it again to
 * gate it.
 *
 * An event needing neither — the overwhelming majority — resolves to the
 * shared {@link IDENTITY_GATE}, so the common path is one `Map` miss and an
 * identity call with no allocation.
 *
 * The parser is Zod's own. Rather than hand-rolling a traversal that would
 * have to re-implement arrays, records, unions and every construct Zod grows,
 * the declared schema is transformed once at build time — `z.date()` becomes
 * coercing, objects become loose — and `parse` does the work. Objects are
 * loose deliberately: a strict Zod object strips keys it does not declare, and
 * an event store can hold payloads written against an older schema, so
 * dropping them on read would lose committed data.
 *
 * Only `z.date()` needs typing. Framework metadata carries no dates —
 * `EventMetaSchema` is a correlation string plus causation names and ids — and
 * `created` is a real column each adapter parses directly.
 *
 * @internal
 */

import { z } from "zod";
import type { Actor } from "../types/index.js";
import {
  type EventGate,
  IDENTITY_GATE,
  is_pii,
  make_gate,
  pii_strip,
} from "./sensitive.js";

/** What one pass over an event's schema resolves. @internal */
export type EventTags = {
  /** Keys marked `sensitive(...)`, top level (and across union variants). */
  readonly sensitive: readonly string[];
  /**
   * Types a stored payload against the declaration, or `undefined` when the
   * schema declares no dates.
   */
  readonly parse: ((data: unknown) => unknown) | undefined;
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
 * that variant ([#1417](https://github.com/Rotorsoft/act-root/issues/1417)).
 *
 * @internal
 */
export function event_tags(schema: z.ZodType): EventTags {
  const sensitive: string[] = [];

  const collect = (node: unknown): void => {
    const shape = def_of(node)?.shape as Record<string, z.ZodType> | undefined;
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
  return {
    sensitive: [...new Set(sensitive)],
    parse: found.date
      ? (data: unknown) => (read_schema as z.ZodType).parse(data)
      : undefined,
  };
}

/**
 * What the reader should do about sensitive fields.
 *
 * - `redact` — substitute `[REDACTED]` unless `disclose` authorizes the actor,
 *   and drop the `pii` sidecar. The read surfaces (`query`, `query_array`,
 *   `load`).
 * - `strip` — remove the keys entirely. Reaction and projection handlers,
 *   which never see PII by framework rule, and shouldn't structurally observe
 *   the keys either.
 *
 * @internal
 */
export type Disclosure = "redact" | "strip";

/**
 * Compose one event's typing and disclosure into a single gate.
 *
 * Returns `undefined` when the event needs neither, so the caller can fall
 * back to the shared {@link IDENTITY_GATE} and the common path allocates
 * nothing.
 *
 * @internal
 */
export function make_event_reader(
  tags: EventTags,
  disclosure: Disclosure,
  predicate: ((event: never, actor: Actor) => boolean) | null = null
): EventGate | undefined {
  const { sensitive, parse } = tags;
  if (!parse && sensitive.length === 0) return undefined;

  const gate: EventGate =
    sensitive.length === 0
      ? IDENTITY_GATE
      : disclosure === "strip"
        ? (((event) => pii_strip(event as never, sensitive)) as EventGate)
        : make_gate(sensitive, predicate as never);

  if (!parse) return gate;

  // Type before disclosing: the gate copies, so parsing afterwards would
  // leave the consumer's value a string.
  return ((event, actor) =>
    gate({ ...event, data: parse(event.data) } as never, actor)) as EventGate;
}
