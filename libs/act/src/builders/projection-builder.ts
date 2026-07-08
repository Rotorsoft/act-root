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
import {
  _this_,
  type FoldConfig,
  resolveFoldConfig,
} from "../internal/index.js";
import type {
  BatchHandler,
  CacheEntry,
  Committed,
  EventRegister,
  FoldOptions,
  Reaction,
  ReactionResolver,
  Schema,
  Schemas,
  State,
} from "../types/index.js";

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
  /**
   * State-fold spec from `.of()`. The builder only records intent — the
   * orchestrator resolves the REGISTRY-MERGED full state at
   * `act().build()` and synthesizes the batch handler there, so the
   * fold always covers every reducer of the state, including partials
   * merged by slices the projection never saw.
   * @internal
   */
  readonly fold?: {
    readonly name: string;
    readonly flush: (rows: ReadonlyArray<CacheEntry<any>>) => Promise<void>;
    readonly config: FoldConfig;
  };
};

/**
 * The `.of()` continuation: state projections flush the cache layer
 * outward — the rows ARE the streams' {@link CacheEntry} values, one
 * per dirty stream per flush round. Must be an idempotent upsert keyed
 * on `stream` (guard with `event_id` for order safety when a rebuild
 * races a live worker).
 */
type FoldFlush<TState extends Schema, TE extends Schemas> = {
  flush: (
    handler: (rows: ReadonlyArray<CacheEntry<TState>>) => Promise<void>
  ) => {
    build: () => Projection<TE>;
  };
};

/**
 * `.of()` accepts the partials of ONE state (same name, enforced at the
 * type level via `TName`) purely for typing and event registration —
 * the fold itself always runs on the registry-merged full state,
 * resolved at `act().build()`. Passing every partial is required: the
 * orchestrator validates completeness at build and throws on missing
 * events.
 */
type OfSignatures = {
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1, TE1>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2, TE1 & TE2>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TS3 extends Schema,
    TE3 extends Schemas,
    TA3 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    s3: State<TS3, TE3, TA3, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2 & TS3, TE1 & TE2 & TE3>;
  <
    TS1 extends Schema,
    TE1 extends Schemas,
    TA1 extends Schemas,
    TS2 extends Schema,
    TE2 extends Schemas,
    TA2 extends Schemas,
    TS3 extends Schema,
    TE3 extends Schemas,
    TA3 extends Schemas,
    TS4 extends Schema,
    TE4 extends Schemas,
    TA4 extends Schemas,
    TN extends string,
  >(
    s1: State<TS1, TE1, TA1, TN>,
    s2: State<TS2, TE2, TA2, TN>,
    s3: State<TS3, TE3, TA3, TN>,
    s4: State<TS4, TE4, TA4, TN>,
    options?: FoldOptions
  ): FoldFlush<TS1 & TS2 & TS3 & TS4, TE1 & TE2 & TE3 & TE4>;
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
> = ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget, true> & {
  to: (
    resolver: ReactionResolver<TEvents & { [P in TKey]: TData }, TKey> | string
  ) => ProjectionBuilder<TEvents & { [P in TKey]: TData }, TTarget, true>;
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
  THasHandlers extends boolean = false,
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
    } & (THasHandlers extends false
      ? {
          /**
           * Declares a state projection: fold every event of the given
           * state through its own reducers and flush one row per stream —
           * the queryable list of the aggregates themselves.
           *
           * The state is the filter: the projection consumes exactly the
           * state's event register, so in a multi-state app only that
           * state's streams are folded — and every event of a folded
           * stream reaches the reducer. Write amplification tracks the
           * distinct stream count, not the event count; `app.reset`
           * rebuilds in O(streams) upserts.
           *
           * The fluent chain enforces the shape: `.of()` is only offered
           * before any `.on()` handler, and narrows to `.flush()` +
           * `.build()` — a projection either folds a state or declares
           * handlers, never both.
           */
          of: OfSignatures;
        }
      : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        {})
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
 * `.to()` when handlers route to different streams.
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
/**
 * @internal Build the core builder object (shared between overloads). One
 * mutable `events` register threaded through every fluent call; .on()
 * mutates and returns the same builder cast to its widened generic.
 */
function _projection<
  TEvents extends Schemas,
  TTarget extends string | undefined,
>(target: TTarget): ProjectionBuilder<TEvents, TTarget> {
  const events = {} as EventRegister<TEvents>;
  const default_resolver: { target: string } | undefined =
    typeof target === "string" ? { target } : undefined;

  // Mutable runtime bag — typed loosely; the public projection() return
  // type narrows back to the user-facing `ProjectionBuilder<TEvents, TTarget>`.

  const base: any = {
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
            handler,
            resolver: default_resolver ?? _this_,
            options: {
              blockOnError: true,
              maxRetries: 3,
            },
          };
          const register = (events as Record<string, any>)[event];
          if (!handler.name)
            throw new Error(
              `Projection handler for "${event}" must be a named function`
            );
          if (register.reactions.has(handler.name))
            throw new Error(
              `Duplicate projection handler "${handler.name}" for event "${event}". ` +
                `Projection handlers are keyed by function name; rename one of them.`
            );
          register.reactions.set(handler.name, reaction);

          // Same builder, widened generic — no recursive call.
          const widened = base as unknown as ProjectionBuilder<
            TEvents & { [P in TKey]: TData },
            TTarget
          >;
          return Object.assign(widened, {
            to(
              resolver:
                | ReactionResolver<TEvents & { [P in TKey]: TData }, TKey>
                | string
            ) {
              // Patch the same reaction in place — no second Map.set().
              reaction.resolver =
                typeof resolver === "string" ? { target: resolver } : resolver;
              return widened;
            },
          });
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

  // Add .batch() and .of() only for static-target projections
  if (typeof target === "string") {
    return Object.assign(base, {
      batch: (handler: BatchHandler<TEvents>) => ({
        build: () => ({
          _tag: "Projection" as const,
          events,
          target,
          batchHandler: handler,
        }),
      }),
      of: (...args: unknown[]) => {
        if (Object.keys(events).length > 0)
          throw new Error(
            `Projection "${target}" mixes .of() with .on() handlers — a projection either folds a state or declares handlers, never both`
          );
        // Trailing options bag is the only non-State argument.
        const is_state = (a: unknown): a is State<Schema, Schemas, Schemas> =>
          !!a &&
          typeof (a as State<Schema, Schemas, Schemas>).init === "function";
        const partials = args.filter(is_state);
        const options = (args.find((a) => !is_state(a)) ?? {}) as FoldOptions;
        if (partials.length === 0)
          throw new Error(`Projection "${target}" .of() requires a state`);
        const name = partials[0].name;
        for (const partial of partials)
          if (partial.name !== name)
            throw new Error(
              `Projection "${target}" .of() partials must share one state name — got "${name}" and "${partial.name}"`
            );
        // Misconfiguration surfaces here, at startup — not on first drain.
        const config = resolveFoldConfig(options);
        // The partials' own schema instances register the events, so the
        // same-name declarations in slices pass the identity check in
        // merge_event_register. The named no-op reaction routes fetches
        // to this target; dispatch always goes through the batch handler
        // the orchestrator synthesizes from the registry-merged state.
        const fold_events = {} as EventRegister<Schemas>;
        for (const partial of partials)
          for (const [event_name, schema] of Object.entries(partial.events)) {
            if (event_name in fold_events) continue;
            const noop = {
              [`${target}_fold`]: async () => {},
            }[`${target}_fold`] as (
              event: Committed<Schemas, string>,
              stream: string
            ) => Promise<void>;
            (fold_events as Record<string, unknown>)[event_name] = {
              schema,
              reactions: new Map([
                [
                  `${target}_fold`,
                  {
                    handler: noop,
                    resolver: { target },
                    options: { blockOnError: true, maxRetries: 3 },
                  },
                ],
              ]),
            };
          }
        return {
          flush: (
            handler: (rows: ReadonlyArray<CacheEntry<Schema>>) => Promise<void>
          ) => ({
            build: () => ({
              _tag: "Projection" as const,
              events: fold_events,
              target,
              fold: { name, flush: handler, config },
            }),
          }),
        };
      },
    }) as ProjectionBuilder<TEvents, TTarget>;
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
  target: string
): ProjectionBuilder<TEvents, string>;
/**
 * Creates a new projection builder without a default target.
 *
 * Use per-handler `.to()` to route events to different streams.
 */
export function projection<TEvents extends Schemas = {}>(
  target?: undefined
): ProjectionBuilder<TEvents, undefined>;
export function projection<TEvents extends Schemas = {}>(
  target?: string
): ProjectionBuilder<TEvents, string | undefined> {
  return _projection<TEvents, string | undefined>(target);
}
