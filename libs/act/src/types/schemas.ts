import { z, ZodObject, ZodRawShape } from "zod";

export const ZodEmpty = z.record(z.never());

export const ActorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .readonly();

export const TargetSchema = z
  .object({
    stream: z.string(),
    actor: ActorSchema,
    expectedVersion: z.number().optional(),
  })
  .readonly();

export const EventMetaSchema = z
  .object({
    correlation: z.string(),
    causation: z.object({
      action: TargetSchema.and(z.object({ name: z.string() })).optional(),
      event: z
        .object({
          id: z.number(),
          name: z.string(),
          stream: z.string(),
        })
        .optional(),
    }),
  })
  .readonly();

export const CommittedMetaSchema = z
  .object({
    id: z.number(),
    stream: z.string(),
    version: z.number(),
    created: z.date(),
    meta: EventMetaSchema,
  })
  .readonly();

export type StateSchema = Readonly<{
  events: Record<string, ZodObject<ZodRawShape> | typeof ZodEmpty>;
  actions: Record<string, ZodObject<ZodRawShape> | typeof ZodEmpty>;
  state: ZodObject<ZodRawShape>;
}>;

export function buildSnapshotSchema<S extends StateSchema>(s: S) {
  const events = Object.entries(s.events).map(([name, zod]) =>
    z.object({
      name: z.literal(name),
      data: zod,
      id: z.number(),
      stream: z.string(),
      version: z.number(),
      created: z.date(),
      meta: EventMetaSchema,
    })
  );
  return z.object({
    state: s.state.readonly(),
    event: z.union([events[0], events[1], ...events.slice(2)]).optional(),
    patches: z.number(),
    snaps: z.number(),
  });
}

/**
 * Options to query the all stream
 * - `stream?` filter by stream
 * - `names?` filter by event names
 * - `before?` filter events before this id
 * - `after?` filter events after this id
 * - `limit?` limit the number of events to return
 * - `created_before?` filter events created before this date/time
 * - `created_after?` filter events created after this date/time
 * - `backward?` order descending when true
 * - `correlation?` filter by correlation
 * - `actor?` filter by actor id (mainly used to reduce process managers)
 * - `loading?` flag when loading to optimize queries
 */
export const QuerySchema = z.object({
  stream: z.string().optional(),
  names: z.string().array().optional(),
  before: z.number().optional(),
  after: z.number().optional(),
  limit: z.number().optional(),
  created_before: z.date().optional(),
  created_after: z.date().optional(),
  backward: z.boolean().optional(),
  correlation: z.string().optional(),
  actor: z.string().optional(),
});
