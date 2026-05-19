/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act, type ActOptions } from "../act.js";
import {
  _this_,
  currentVersionOf,
  deprecatedEventNames,
  mergeEventRegister,
  mergeProjection,
  registerState,
} from "../internal/index.js";
import { DEFAULT_LANE, log } from "../ports.js";
import type {
  Actor,
  BatchHandler,
  Committed,
  EventRegister,
  IAct,
  LaneConfig,
  Reaction,
  ReactionOptions,
  ReactionResolver,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  Snapshot,
  State,
} from "../types/index.js";
import type { Projection } from "./projection-builder.js";
import type { Slice } from "./slice-builder.js";

/**
 * Registers a projection's batch handler against its target stream, throwing
 * if a different handler is already registered for the same target. Two
 * projections silently overwriting each other's batch handlers used to be a
 * latent footgun.
 */
function registerBatchHandler(
  proj: Projection<any>,
  batchHandlers: Map<string, BatchHandler<any>>
): void {
  if (!proj.batchHandler || !proj.target) return;
  const existing = batchHandlers.get(proj.target);
  if (existing && existing !== proj.batchHandler) {
    throw new Error(`Duplicate batch handler for target "${proj.target}"`);
  }
  batchHandlers.set(proj.target, proj.batchHandler);
}

/**
 * Walks every registered reaction's static resolver and rejects
 * references to lanes that were never declared via `.withLane(...)`.
 *
 * Inline reactions on `ActBuilder` are statically narrowed via `TLanes`,
 * so this check only matters for slice-declared reactions (the slice
 * builder can't see the parent Act's lane set) and dynamic resolvers.
 * Dynamic resolvers carry no static lane — their return value isn't
 * inspectable until runtime — so they're skipped here; if they return
 * an unknown lane it surfaces at subscribe time in later slices.
 *
 * The implicit `"default"` lane is always permitted, even if the
 * application declares zero lanes.
 */
function validateLaneReferences(
  registry: Registry<any, any, any>,
  lanes: ReadonlyArray<LaneConfig>
): void {
  const declared = new Set<string>([DEFAULT_LANE, ...lanes.map((l) => l.name)]);
  for (const [eventName, def] of Object.entries(registry.events)) {
    const entry = def as { reactions: Map<string, Reaction<any, any>> };
    for (const [handlerName, reaction] of entry.reactions) {
      const resolver = reaction.resolver;
      if (typeof resolver === "function") continue;
      const lane = (resolver as { lane?: string }).lane;
      if (lane && !declared.has(lane)) {
        throw new Error(
          `Reaction "${handlerName}" on "${eventName}" targets undeclared lane "${lane}". ` +
            `Declared lanes: ${[...declared].map((l) => `"${l}"`).join(", ")}. ` +
            `Add \`.withLane({ name: "${lane}", ... })\` to act() or correct the .to() declaration.`
        );
      }
    }
  }
}

/**
 * Fluent builder interface for composing event-sourced applications.
 *
 * Provides a chainable API for:
 * - Registering states via `.withState()`
 * - Registering slices via `.withSlice()`
 * - Registering projections via `.withProjection()`
 * - Locking a custom actor type via `.withActor<TActor>()`
 * - Declaring drain lanes via `.withLane({name, ...})` (ACT-1103)
 * - Defining event reactions via `.on()` → `.do()` → `.to()`
 * - Building the orchestrator via `.build()`
 *
 * @template TSchemaReg - Schema register for states (maps action names to state schemas)
 * @template TEvents - Event schemas (maps event names to event data schemas)
 * @template TActions - Action schemas (maps action names to action payload schemas)
 * @template TStateMap - Map of state names to state schemas
 * @template TActor - Actor type extending base Actor
 * @template TLanes - Union of declared lane names (ACT-1103). Narrowed by
 *   `.withLane({name})` calls so `.to({lane})` and `ActOptions.onlyLanes`
 *   reject typos at compile time. Starts at `"default"`.
 *
 * @see {@link act} for usage examples
 * @see {@link Act} for the built orchestrator API
 */
export type ActBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> = {
  /**
   * Registers a state definition with the builder.
   *
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withState: <
    TNewState extends Schema,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewName extends string = string,
  >(
    state: State<TNewState, TNewEvents, TNewActions, TNewName>
  ) => ActBuilder<
    TSchemaReg & { [K in keyof TNewActions]: TNewState },
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & { [K in TNewName]: TNewState },
    TActor,
    TLanes
  >;
  /**
   * Registers a slice with the builder.
   *
   * Merges all the slice's states and reactions into the application.
   * State names, action names, and event names must be unique across the
   * application (partial states with the same name are merged automatically).
   *
   * @throws {Error} If duplicate action or event names are detected
   */
  withSlice: <
    TNewSchemaReg extends SchemaRegister<TNewActions>,
    TNewEvents extends Schemas,
    TNewActions extends Schemas,
    TNewMap extends Record<string, Schema>,
    TNewLanes extends string,
  >(
    slice: Slice<
      TNewSchemaReg,
      TNewEvents,
      TNewActions,
      TNewMap,
      Actor,
      TNewLanes
    >
  ) => ActBuilder<
    TSchemaReg & TNewSchemaReg,
    TEvents & TNewEvents,
    TActions & TNewActions,
    TStateMap & TNewMap,
    TActor,
    TLanes | TNewLanes
  >;
  /**
   * Registers a standalone projection with the builder.
   *
   * The projection's events must be a subset of events already registered
   * via `.withState()` or `.withSlice()`.
   */
  withProjection: <TNewEvents extends Schemas>(
    projection: [Exclude<keyof TNewEvents, keyof TEvents>] extends [never]
      ? Projection<TNewEvents>
      : never
  ) => ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>;
  /**
   * Locks a custom actor type for this application.
   *
   * This is a pure type-level method — it returns the same builder at
   * runtime but narrows the `TActor` generic so that `app.do()` and
   * reaction dispatchers require the richer actor shape.
   *
   * @template TNewActor - Custom actor type extending base Actor
   * @returns The same builder with `TActor` locked to `TNewActor`
   *
   * @example
   * ```typescript
   * type MyActor = { id: string; name: string; role: string; tenantId: string };
   *
   * const app = act()
   *   .withActor<MyActor>()
   *   .withState(Counter)
   *   .build();
   *
   * // Now app.do() requires MyActor in the target
   * await app.do("increment", {
   *   stream: "counter-1",
   *   actor: { id: "1", name: "Alice", role: "admin", tenantId: "t1" }
   * }, { by: 5 });
   * ```
   */
  withActor: <TNewActor extends Actor>() => ActBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TNewActor,
    TLanes
  >;
  /**
   * Declares a drain lane (ACT-1103).
   *
   * Each lane spawns its own `DrainController` at `build()` time with the
   * configured `leaseMillis` / `streamLimit` / `cycleMs`. Reactions whose
   * `.to({lane})` references the lane name land in that controller;
   * reactions without an explicit `.lane` land in the implicit
   * `"default"` lane.
   *
   * Lane names are tracked in the builder's `TLanes` type parameter — so
   * `.to({lane: "slow"})` only compiles after `.withLane({ name: "slow" })`
   * has been called, and `ActOptions.onlyLanes: ["typo"]` is rejected at
   * build sites.
   *
   * Declaring the same lane name twice throws. Omitting `withLane` entirely
   * preserves today's single-controller behavior — every reaction lands in
   * the implicit `"default"` lane.
   *
   * @example
   * ```typescript
   * const app = act()
   *   .withState(Counter)
   *   .withLane({ name: "slow", leaseMillis: 60_000, streamLimit: 5 })
   *   .on("OrderConfirmed")
   *     .do(deliverWebhook)
   *     .to({ target: "webhooks-out", lane: "slow" })
   *   .build();
   * ```
   */
  withLane: <const TConfig extends LaneConfig>(
    config: TConfig
  ) => ActBuilder<
    TSchemaReg,
    TEvents,
    TActions,
    TStateMap,
    TActor,
    TLanes | TConfig["name"]
  >;
  /**
   * Begins defining a reaction to a specific event.
   *
   * Reactions are event handlers that respond to state changes. They can trigger
   * additional actions, update external systems, or perform side effects. Reactions
   * are processed asynchronously during drain cycles.
   *
   * @template TKey - Event name (must be a registered event)
   * @param event - The event name to react to
   * @returns An object with `.do()` method to define the reaction handler
   */
  on: <TKey extends keyof TEvents>(
    event: TKey
  ) => {
    do: (
      handler: (
        event: Committed<TEvents, TKey>,
        stream: string,
        app: IAct<TEvents, TActions, TActor>
      ) => Promise<Snapshot<Schema, TEvents> | void>,
      options?: Partial<ReactionOptions>
    ) => ActBuilder<
      TSchemaReg,
      TEvents,
      TActions,
      TStateMap,
      TActor,
      TLanes
    > & {
      to: (
        resolver: ReactionResolver<TEvents, TKey, TLanes> | string
      ) => ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>;
    };
  };
  /**
   * Builds and returns the Act orchestrator instance.
   *
   * @param options - Optional runtime overrides (see {@link ActOptions}).
   *   `options.onlyLanes` is narrowed to the declared `TLanes` union, so
   *   `onlyLanes: ["typo"]` is a compile error when the lane wasn't
   *   declared via `.withLane(...)`.
   * @returns The Act orchestrator instance
   *
   * @see {@link Act} for available orchestrator methods
   */
  build: (
    options?: ActOptions<TLanes>
  ) => Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>;
  /**
   * The registered event schemas and their reaction maps.
   */
  readonly events: EventRegister<TEvents>;
};

/* eslint-disable @typescript-eslint/no-empty-object-type -- {} used as generic defaults */

/**
 * Creates a new Act orchestrator builder for composing event-sourced applications.
 *
 * @example Basic application with single state
 * ```typescript
 * const app = act()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example Application with custom actor type
 * ```typescript
 * type MyActor = { id: string; name: string; role: string };
 *
 * const app = act()
 *   .withActor<MyActor>()
 *   .withState(Counter)
 *   .build();
 * ```
 *
 * @example Application with slices (vertical slice architecture)
 * ```typescript
 * const CounterSlice = slice()
 *   .withState(Counter)
 *   .on("Incremented")
 *     .do(async (event) => { console.log("incremented!"); })
 *     .to("counter-target")
 *   .build();
 *
 * const app = act()
 *   .withSlice(CounterSlice)
 *   .build();
 * ```
 *
 *
 * @see {@link ActBuilder} for available builder methods
 * @see {@link Act} for orchestrator API methods
 * @see {@link state} for defining states
 * @see {@link slice} for defining slices
 */
export function act<
  // @ts-expect-error empty schema
  TSchemaReg extends SchemaRegister<TActions> = {},
  TEvents extends Schemas = {},
  TActions extends Schemas = {},
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
>(): ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> {
  // Mutable runtime state — one set of references shared across the entire
  // fluent chain. Each `with*` / `on` call mutates these and returns the
  // same builder cast to the widened generic; type fanout is preserved
  // through the public type signatures, runtime allocation is not.
  const states = new Map<string, State<any, any, any>>();
  const registry: Registry<TSchemaReg, TEvents, TActions> = {
    actions: {} as Registry<TSchemaReg, TEvents, TActions>["actions"],
    events: {} as Registry<TSchemaReg, TEvents, TActions>["events"],
  };
  const pendingProjections: Projection<any>[] = [];
  const batchHandlers = new Map<string, BatchHandler<any>>();
  // Declared drain lanes (ACT-1103). `withLane` appends here; the `Act`
  // constructor receives the array on `build()`. Slice 1 records the
  // configs but doesn't yet wire per-lane controllers — the single default
  // controller still drains everything. Later slices fan out.
  const lanes: LaneConfig[] = [];

  // Set on the first `.build()` call. Lets the same builder produce
  // many Acts (multi-tenant / A-B testing patterns) without re-merging
  // projections or re-logging the deprecation advisory.
  let _built = false;

  // ACT-403: auto-deprecation enforcement. Groups each state's events
  // by base name + `_v<digits>`; the highest version is current, all
  // lower ones are deprecated. Stashes the deprecation set on the
  // state so `event-sourcing.ts` can warn at runtime for dynamic
  // emits. Scans static `.emit("X")` markers across every state and
  // throws if any target a deprecated event — the only legitimate use
  // of a deprecated event is on the reduce path. Finally, surfaces a
  // one-line startup advisory so operators can see "your app has
  // legacy events kept for the read path, here's where they live."
  const finalizeDeprecations = () => {
    const deprecationSummary: Array<{
      stateName: string;
      deprecated: string;
      current: string;
    }> = [];
    for (const state of states.values()) {
      const eventNames = Object.keys(state.events);
      const deprecated = deprecatedEventNames(eventNames);
      if (deprecated.size === 0) continue;
      (state as { _deprecated?: Set<string> })._deprecated = deprecated;
      for (const name of deprecated) {
        // `currentVersionOf` is guaranteed non-undefined here — `name`
        // is in `deprecated`, which by construction means a higher-
        // versioned sibling exists in the same group.
        const current = currentVersionOf(name, eventNames) as string;
        deprecationSummary.push({
          stateName: state.name,
          deprecated: name,
          current,
        });
      }
      for (const [actionName, handler] of Object.entries(state.on)) {
        const staticTarget = (handler as { _staticEmit?: string } | undefined)
          ?._staticEmit;
        if (staticTarget && deprecated.has(staticTarget)) {
          const current = currentVersionOf(staticTarget, eventNames);
          throw new Error(
            `Action "${actionName}" in state "${state.name}" emits deprecated event "${staticTarget}". ` +
              `A newer version exists: "${current}". Update the .emit() call ` +
              `to target the current version. The reducer (.patch) for ` +
              `"${staticTarget}" stays as-is — historical events still need it.`
          );
        }
      }
    }
    if (deprecationSummary.length > 0) {
      const list = deprecationSummary
        .map(
          (d) =>
            `"${d.deprecated}" (current: "${d.current}", state: "${d.stateName}")`
        )
        .join(", ");
      log().info(
        `Act registered ${deprecationSummary.length} deprecated event(s): ${list}. ` +
          `These are legacy versions kept for the read path. Consider truncating ` +
          `closed streams via app.close() when feasible to reduce historical event load. ` +
          `See docs/docs/architecture/event-schema-evolution.md.`
      );
    }
  };

  // The `as` chain on `self` is the type fanout: each fluent method
  // mutates state and returns `self` cast to its post-call generic
  // signature. Internal-only — public types stay narrow.
  const builder: ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> =
    {
      withState: (state) => {
        registerState(state, states, registry.actions, registry.events);
        return builder as never;
      },
      withSlice: (input) => {
        for (const s of input.states.values()) {
          registerState(s, states, registry.actions, registry.events);
        }
        mergeEventRegister(registry.events, input.events);
        pendingProjections.push(...input.projections);
        // Merge slice-declared lanes into the Act's lane set (ACT-1103).
        // Conflicting configs (same name, different field values) are
        // rejected — the operator should pick one, not let a slice
        // silently shadow an Act-level declaration.
        for (const sliceLane of input.lanes) {
          const existing = lanes.find((l) => l.name === sliceLane.name);
          if (!existing) {
            lanes.push(sliceLane);
            continue;
          }
          if (
            existing.leaseMillis !== sliceLane.leaseMillis ||
            existing.streamLimit !== sliceLane.streamLimit ||
            existing.cycleMs !== sliceLane.cycleMs
          ) {
            throw new Error(
              `Lane "${sliceLane.name}" was already declared with a different config. ` +
                `Pick one declaration — slices and the Act must agree on lane timing.`
            );
          }
        }
        return builder as never;
      },
      withProjection: (proj) => {
        mergeProjection(proj as Projection<any>, registry.events);
        registerBatchHandler(proj as Projection<any>, batchHandlers);
        return builder;
      },
      withActor: <TNewActor extends Actor>() =>
        builder as unknown as ActBuilder<
          TSchemaReg,
          TEvents,
          TActions,
          TStateMap,
          TNewActor
        >,
      withLane: (config) => {
        // Reserve the literal `"default"` lane name for the implicit
        // controller and forbid duplicate declarations — the latter
        // would silently shadow the earlier config, hiding the typo.
        if (config.name === DEFAULT_LANE) {
          throw new Error(
            `Lane "${DEFAULT_LANE}" is reserved for the implicit lane and cannot be redeclared. ` +
              `Pick a different name, or omit \`withLane({name: "default"})\` and rely on the default.`
          );
        }
        if (lanes.some((l) => l.name === config.name)) {
          throw new Error(`Lane "${config.name}" was already declared`);
        }
        lanes.push(config);
        return builder as never;
      },
      on: <TKey extends keyof TEvents>(event: TKey) => ({
        do: (
          handler: (
            event: Committed<TEvents, TKey>,
            stream: string,
            app: IAct<TEvents, TActions, TActor>
          ) => Promise<Snapshot<Schema, TEvents> | void>,
          options?: Partial<ReactionOptions>
        ) => {
          const reaction: Reaction<TEvents, TKey, TActions, TActor> = {
            handler: handler,
            resolver: _this_,
            options: {
              blockOnError: options?.blockOnError ?? true,
              maxRetries: options?.maxRetries ?? 3,
              backoff: options?.backoff,
            },
          };
          if (!handler.name)
            throw new Error(
              `Reaction handler for "${String(event)}" must be a named function`
            );
          // Register once with the default _this_ resolver. If `.to()` is
          // chained next, it patches the same reaction's resolver in place
          // — no second Map.set() round-trip.
          registry.events[event].reactions.set(handler.name, reaction);
          return Object.assign(builder, {
            to(resolver: ReactionResolver<TEvents, TKey> | string) {
              reaction.resolver =
                typeof resolver === "string" ? { target: resolver } : resolver;
              return builder;
            },
          });
        },
      }),
      build: (options?: ActOptions) => {
        // One-time finalize: merge pending projections and run the
        // deprecation scan + advisory log exactly once. Calling
        // `.build({scoped: ...})` repeatedly (e.g., per tenant) is
        // supported — see extension-points.md § Scoped ports. Without
        // this guard, `mergeProjection` would re-add reactions to the
        // shared registry on every call (accumulating `_p`/`_p_p`
        // dedupe suffixes), and the deprecation advisory would log on
        // every tenant.
        if (!_built) {
          for (const proj of pendingProjections) {
            mergeProjection(proj, registry.events as Record<string, any>);
            registerBatchHandler(proj, batchHandlers);
          }
          finalizeDeprecations();
          validateLaneReferences(registry, lanes);
          _built = true;
        }

        return new Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>(
          registry,
          states,
          batchHandlers,
          options,
          lanes
        );
      },
      events: registry.events,
    };
  return builder;
}
