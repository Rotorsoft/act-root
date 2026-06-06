import { type ZodObject, type ZodRawShape, z } from "zod";
// Deep-path import (vs `../internal/index.js`) is deliberate — `_registry` is
// a side-effect-free leaf, and going through the internal barrel would pull
// tracing.ts → config.ts in at type-schema load time and crash on TDZ when a
// test imports a public schema before config is initialized.
import { _registry } from "../internal/sensitive.js";

/**
 * @packageDocumentation
 * @module act/types
 * @category Types
 * Zod schemas and helpers for the Act Framework.
 */

/**
 * An empty Zod schema (no properties).
 */
export const ZodEmpty = z.record(z.string(), z.never());

/**
 * Sentinel placed in `event.data[field]` when the caller isn't authorized to
 * see the sensitive field — either `.discloses(predicate)` returned `false`,
 * or no predicate was declared (framework default-deny). Recoverable: a
 * properly-authorized read returns the plaintext.
 *
 * Part of the sensitive-data foundation (#855 / epic #566).
 */
export { REDACTED, SHREDDED } from "../internal/sensitive.js";

/**
 * Mark a Zod schema as sensitive. Returns the same schema instance — the
 * marker is registered out-of-band so the static type is preserved and the
 * call site reads as a pure annotation.
 *
 * Idempotent: re-wrapping an already-sensitive schema is a no-op.
 *
 * The marker is what the orchestrator inspects to split event payloads into
 * `data` + `pii` on commit, gate reads via `.discloses`, and strip handler
 * payloads. Part of the sensitive-data foundation (#855 / epic #566).
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { state, sensitive } from "@rotorsoft/act";
 *
 * const UserRegistered = z.object({
 *   email: sensitive(z.string()),
 *   name: sensitive(z.string()),
 *   plan: z.enum(["free", "pro"]),  // not sensitive — stays in events.data
 * });
 * ```
 *
 * @param schema - The Zod schema to mark sensitive.
 * @returns The same schema instance, unmodified at the type level.
 */
export function sensitive<T extends z.ZodType>(schema: T): T {
  _registry.add(schema, { sensitive: true });
  return schema;
}

/**
 * Zod schema for an actor (user, system, etc.).
 */
export const ActorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .loose()
  .readonly();

/**
 * Zod schema for a target (stream and actor info).
 */
export const TargetSchema = z
  .object({
    stream: z.string(),
    actor: ActorSchema,
    expectedVersion: z.number().optional(),
  })
  .loose()
  .readonly();

/**
 * Zod schema for causation event metadata.
 */
export const CausationEventSchema = z.object({
  id: z.number(),
  name: z.string(),
  stream: z.string(),
});

/**
 * Zod schema for event metadata (correlation and causation).
 */
export const EventMetaSchema = z
  .object({
    correlation: z.string(),
    causation: z.object({
      action: TargetSchema.and(z.object({ name: z.string() })).optional(),
      event: CausationEventSchema.optional(),
    }),
  })
  .readonly();

/**
 * Zod schema for committed event metadata (id, stream, version, created, meta).
 */
export const CommittedMetaSchema = z
  .object({
    id: z.number(),
    stream: z.string(),
    version: z.number(),
    created: z.date(),
    meta: EventMetaSchema,
  })
  .readonly();

/**
 * Type representing the full state schema for a domain.
 * @property events - Map of event names to Zod schemas.
 * @property actions - Map of action names to Zod schemas.
 * @property state - Zod schema for the state object.
 */
export type StateSchema = Readonly<{
  events: Record<string, ZodObject<ZodRawShape> | typeof ZodEmpty>;
  actions: Record<string, ZodObject<ZodRawShape> | typeof ZodEmpty>;
  state: ZodObject<ZodRawShape>;
}>;

/**
 * Query options for event store queries.
 */
export const QuerySchema = z
  .object({
    stream: z.string().optional(),
    names: z.string().array().optional(),
    before: z.number().optional(),
    after: z.number().optional(),
    limit: z.number().optional(),
    created_before: z.date().optional(),
    created_after: z.date().optional(),
    backward: z.boolean().optional(),
    correlation: z.string().optional(),
    with_snaps: z.boolean().optional(),
    stream_exact: z.boolean().optional(),
  })
  .readonly();
