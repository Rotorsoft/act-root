import { z, ZodObject, ZodRawShape } from "zod";

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
 * Zod schema for an actor (user, system, etc.).
 */
export const ActorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
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
  })
  .readonly();
