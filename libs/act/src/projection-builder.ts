/**
 * @module projection-builder
 * @category Builders
 *
 * Fluent builder for composing projection handlers — read-model updaters
 * that react to events and update external state (databases, caches, etc.).
 *
 * Projections differ from slices: they don't contain states, don't dispatch
 * actions, and are pure side-effect handlers routed to a named stream.
 */
import type { ZodType } from "zod";
import { _this_, _void_ } from "./merge.js";
import type {
  Committed,
  EventRegister,
  Reaction,
  ReactionHandler,
  ReactionResolver,
  Schema,
  Schemas,
} from "./types/index.js";

/**
 * A self-contained projection grouping read-model update handlers.
 * Projections are composed into an Act orchestrator via `act().with(projection)`.
 *
 * @template E - Event schemas handled by this projection
 */
export type Projection<E extends Schemas> = {
  readonly _tag: "Projection";
  readonly events: EventRegister<E>;
};

/**
 * Type guard for distinguishing Projection from State and Slice objects.
 */
export function isProjection(x: any): x is Projection<any> {
  return x != null && x._tag === "Projection";
}

/** Helper: a single-key record mapping an event name to its Zod schema. */
type EventEntry<K extends string = string, D extends Schema = Schema> = {
  [P in K]: ZodType<D>;
};

/** Infer the handler-result type after registering one event. */
type DoResult<
  E extends Schemas,
  K extends string,
  D extends Schema,
> = ProjectionBuilder<E & { [P in K]: D }> & {
  to: (
    resolver: ReactionResolver<E & { [P in K]: D }, K> | string
  ) => ProjectionBuilder<E & { [P in K]: D }>;
  void: () => ProjectionBuilder<E & { [P in K]: D }>;
};

/**
 * Fluent builder interface for composing projections.
 *
 * Provides a chainable API for registering event handlers that update
 * read models. Unlike slices, projections have no `.with()` for states
 * and handlers do not receive a `Dispatcher`.
 *
 * When a default target is provided via `projection("target")`, all
 * handlers inherit that resolver. Per-handler `.to()` or `.void()` can
 * still override it.
 *
 * @template E - Event schemas
 */
export type ProjectionBuilder<E extends Schemas> = {
  /**
   * Begins defining a projection handler for a specific event.
   *
   * Pass a `{ EventName: schema }` record — use shorthand `{ EventName }`
   * when the variable name matches the event name. The key becomes the
   * event name, the value the Zod schema.
   */
  on: <K extends string, D extends Schema>(
    entry: EventEntry<K, D>
  ) => {
    do: (
      handler: (
        event: Committed<E & { [P in K]: D }, K>,
        stream: string
      ) => Promise<void>
    ) => DoResult<E, K, D>;
  };
  /**
   * Builds and returns the Projection data structure.
   */
  build: () => Projection<E>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<E>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type -- {} used as generic defaults */

/**
 * Creates a new projection builder for composing read-model update handlers.
 *
 * Projections enable separation of read-model concerns from command handling.
 * Each `.on({ Event }).do(handler)` call registers a handler that updates
 * a projection (database table, cache, etc.) in response to events.
 *
 * Pass a target stream name to `projection("target")` so every handler
 * inherits that resolver automatically. Omit it and use per-handler
 * `.to()` / `.void()` when handlers route to different streams.
 *
 * @param target - Optional default target stream for all handlers
 *
 * @example Default target (all handlers routed to "tickets")
 * ```typescript
 * const TicketProjection = projection("tickets")
 *   .on({ TicketOpened })
 *     .do(async ({ stream, data }) => {
 *       await db.insert(tickets).values({ id: stream, ...data });
 *     })
 *   .on({ TicketClosed })
 *     .do(async ({ stream, data }) => {
 *       await db.update(tickets).set(data).where(eq(tickets.id, stream));
 *     })
 *   .build();
 * ```
 *
 * @example Per-handler routing
 * ```typescript
 * const MultiProjection = projection()
 *   .on({ OrderPlaced })
 *     .do(async (event) => { ... })
 *     .to("orders")
 *   .on({ PaymentReceived })
 *     .do(async (event) => { ... })
 *     .to("payments")
 *   .build();
 * ```
 *
 * @see {@link ProjectionBuilder} for builder methods
 * @see {@link Projection} for the output type
 */
export function projection<E extends Schemas = {}>(
  target?: string,
  events: EventRegister<E> = {} as EventRegister<E>
): ProjectionBuilder<E> {
  const defaultResolver: { target: string } | undefined = target
    ? { target }
    : undefined;

  const builder: ProjectionBuilder<E> = {
    on: <K extends string, D extends Schema>(entry: EventEntry<K, D>) => {
      const keys = Object.keys(entry);
      if (keys.length !== 1) throw new Error(".on() requires exactly one key");
      const event = keys[0] as K;
      const schema = entry[event];

      // Register the event schema if not already present
      if (!(event in events)) {
        (events as Record<string, unknown>)[event] = {
          schema,
          reactions: new Map(),
        };
      }

      return {
        do: (
          handler: (
            event: Committed<E & { [P in K]: D }, K>,
            stream: string
          ) => Promise<void>
        ) => {
          const reaction: Reaction<E & { [P in K]: D }, K> = {
            handler: handler as ReactionHandler<E & { [P in K]: D }, K>,
            resolver: defaultResolver ?? _this_,
            options: {
              blockOnError: true,
              maxRetries: 3,
            },
          };
          const register = (events as Record<string, any>)[event];
          const name = handler.name || `${event}_${register.reactions.size}`;
          register.reactions.set(name, reaction);

          const nextBuilder = projection<E & { [P in K]: D }>(
            target,
            events as EventRegister<E & { [P in K]: D }>
          );
          return {
            ...nextBuilder,
            to(resolver: ReactionResolver<E & { [P in K]: D }, K> | string) {
              register.reactions.set(name, {
                ...reaction,
                resolver:
                  typeof resolver === "string"
                    ? { target: resolver }
                    : resolver,
              });
              return nextBuilder;
            },
            void() {
              register.reactions.set(name, {
                ...reaction,
                resolver: _void_,
              });
              return nextBuilder;
            },
          };
        },
      };
    },
    build: () => ({
      _tag: "Projection" as const,
      events,
    }),
    events,
  };
  return builder;
}
