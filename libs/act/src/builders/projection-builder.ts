import {
  DEFAULT_BLOCK_ON_ERROR,
  DEFAULT_MAX_RETRIES,
  resolveFoldConfig,
} from "../internal/config.js";
import type {
  EventEntry,
  Projection,
  ProjectionBuilder,
} from "../types/builders.js";
import type {
  BatchHandler,
  CacheEntry,
  Committed,
  EventRegister,
  FoldOptions,
  Schema,
  Schemas,
  State,
} from "../types/index.js";
import { add_reaction } from "./builder-utils.js";
import { _this_ } from "./merge.js";

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
 *     .do(async function openTicket({ stream, data }) {
 *       await db.insert(tickets).values({ id: stream, ...data });
 *     })
 *   .on({ TicketClosed })
 *     .do(async function closeTicket({ stream, data }) {
 *       await db.update(tickets).set(data).where(eq(tickets.id, stream));
 *     })
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
          // Same builder, widened generic — no recursive call.
          const widened = base as unknown as ProjectionBuilder<
            TEvents & { [P in TKey]: TData },
            TTarget
          >;
          return add_reaction(
            events as unknown as EventRegister<
              TEvents & { [P in TKey]: TData }
            >,
            event,
            handler.name,
            "Projection",
            () => ({
              handler,
              resolver: default_resolver ?? _this_,
              options: {
                blockOnError: DEFAULT_BLOCK_ON_ERROR,
                maxRetries: DEFAULT_MAX_RETRIES,
              },
            }),
            widened
          );
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
                    options: {
                      blockOnError: DEFAULT_BLOCK_ON_ERROR,
                      maxRetries: DEFAULT_MAX_RETRIES,
                    },
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
