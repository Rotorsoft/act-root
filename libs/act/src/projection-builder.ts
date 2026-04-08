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
  BatchHandler,
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
 * Projections are composed into an Act orchestrator via `act().withProjection(projection)`.
 *
 * @template TEvents - Event schemas handled by this projection
 */
export type Projection<TEvents extends Schemas> = {
  readonly _tag: "Projection";
  readonly events: EventRegister<TEvents>;
  readonly target?: string;
  readonly batchHandler?: BatchHandler<TEvents>;
};

/** Helper: a single-key record mapping an event name to its Zod schema. */
type EventEntry<TKey extends string = string, TData extends Schema = Schema> = {
  [P in TKey]: ZodType<TData>;
};

/** Infer the handler-result type after registering one event. */
type DoResult<
  TEvents extends Schemas,
  TKey extends string,
  TData extends Schema,
  TTarget extends string | undefined = undefined,
> = ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget> & {
  to: (
    resolver: ReactionResolver<TEvents & { [P in TKey]: TData }, TKey> | string
  ) => ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget>;
  void: () => ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget>;
};

/**
 * Fluent builder interface for composing projections.
 *
 * When a static target is provided via `projection("target")`, the builder
 * exposes a `.batch()` method for registering a batch handler that processes
 * all events in a single call.
 *
 * @template TEvents - Event schemas
 * @template TTarget - Static target string or undefined
 */
export type ProjectionBuilder<
  TEvents extends Schemas,
  TTarget extends string | undefined = undefined,
> = {
  /**
   * Begins defining a projection handler for a specific event.
   *
   * Pass a `{ EventName: schema }` record — use shorthand `{ EventName }`
   * when the variable name matches the event name. The key becomes the
   * event name, the value the Zod schema.
   */
  on: <TKey extends string, TData extends Schema>(
    entry: EventEntry<TKey, TData>
  ) => {
    do: (
      handler: (
        event: Committed<TEvents & { [P in TKey]: TData }, TKey>,
        stream: string
      ) => Promise<void>
    ) => DoResult<TEvents, TKey, TData, TTarget>;
  };
  /**
   * Builds and returns the Projection data structure.
   */
  build: () => Projection<TEvents>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<TEvents>;
} & (TTarget extends string
  ? {
      /**
       * Registers a batch handler that processes all events in a single call.
       *
       * Only available on projections with a static target (`projection("target")`).
       * The handler receives a discriminated union of all declared events,
       * enabling bulk DB operations in a single transaction.
       *
       * When defined, the batch handler is always called — even for a single event.
       * Individual `.do()` handlers serve as fallback for projections without `.batch()`.
       */
      batch: (handler: BatchHandler<TEvents>) => {
        build: () => Projection<TEvents>;
      };
    }
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {});

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
/** @internal Builds the core builder object (shared between overloads) */
function _projection<
  TEvents extends Schemas,
  TTarget extends string | undefined,
>(
  target: TTarget,
  events: EventRegister<TEvents>
): ProjectionBuilder<TEvents, TTarget> {
  const defaultResolver: { target: string } | undefined =
    typeof target === "string" ? { target } : undefined;

  const base = {
    on: <TKey extends string, TData extends Schema>(
      entry: EventEntry<TKey, TData>
    ) => {
      const keys = Object.keys(entry);
      if (keys.length !== 1) throw new Error(".on() requires exactly one key");
      const event = keys[0] as TKey;
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
            event: Committed<TEvents & { [P in TKey]: TData }, TKey>,
            stream: string
          ) => Promise<void>
        ) => {
          const reaction: Reaction<TEvents & { [P in TKey]: TData }, TKey> = {
            handler: handler as ReactionHandler<
              TEvents & { [P in TKey]: TData },
              TKey
            >,
            resolver: defaultResolver ?? _this_,
            options: {
              blockOnError: true,
              maxRetries: 3,
            },
          };
          const register = (events as Record<string, any>)[event];
          const name = handler.name || `${event}_${register.reactions.size}`;
          register.reactions.set(name, reaction);

          const nextBuilder = _projection<
            TEvents & { [P in TKey]: TData },
            TTarget
          >(target, events as EventRegister<TEvents & { [P in TKey]: TData }>);
          return {
            ...nextBuilder,
            to(
              resolver:
                | ReactionResolver<TEvents & { [P in TKey]: TData }, TKey>
                | string
            ) {
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
      ...(target !== undefined && { target }),
    }),
    events,
  };

  // Add .batch() only for static-target projections
  if (typeof target === "string") {
    return {
      ...base,
      batch: (handler: BatchHandler<TEvents>) => ({
        build: () => ({
          _tag: "Projection" as const,
          events,
          target,
          batchHandler: handler,
        }),
      }),
    } as ProjectionBuilder<TEvents, TTarget>;
  }

  return base as ProjectionBuilder<TEvents, TTarget>;
}

/**
 * Creates a new projection builder with a static target stream.
 *
 * All handlers inherit the target resolver automatically. Enables `.batch()`
 * for bulk event processing in a single transaction.
 *
 * @param target - Static target stream for all handlers
 */
export function projection<TEvents extends Schemas = {}>(
  target: string,
  events?: EventRegister<TEvents>
): ProjectionBuilder<TEvents, string>;
/**
 * Creates a new projection builder without a default target.
 *
 * Use per-handler `.to()` / `.void()` to route events.
 */
export function projection<TEvents extends Schemas = {}>(
  target?: undefined,
  events?: EventRegister<TEvents>
): ProjectionBuilder<TEvents, undefined>;
export function projection<TEvents extends Schemas = {}>(
  target?: string,
  events: EventRegister<TEvents> = {} as EventRegister<TEvents>
): ProjectionBuilder<TEvents, string | undefined> {
  return _projection(target, events);
}
