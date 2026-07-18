/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act, type ActOptions } from "../act.js";
import {
  bare_patch,
  current_version_of,
  deprecated_event_names,
  type EventGate,
  IDENTITY_GATE,
  make_fold_handler,
  make_gate,
  merge_event_register,
  merge_projection,
  type PatchFn,
  pii_fields,
  pii_split,
  pii_strip,
  reaction_on,
  register_lane,
  register_state,
  resolveActConfig,
  resolveAutocloseConfig,
  resolveLaneConfig,
  synthesize_autoclose_reactions,
  validating_patch,
} from "../internal/index.js";
import { DEFAULT_LANE, log } from "../ports.js";
import type {
  Actor,
  BatchHandler,
  LaneConfig,
  Reaction,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "../types/index.js";
import type { BuilderBase } from "./builder-base.js";
import type { Projection } from "./projection-builder.js";
import type { Slice } from "./slice-builder.js";

/**
 * Registers a projection's batch handler against its target stream, throwing
 * if a different handler is already registered for the same target. Two
 * projections silently overwriting each other's batch handlers used to be a
 * latent footgun.
 */
function register_batch_handler(
  proj: Projection<any>,
  batch_handlers: Map<string, BatchHandler<any>>
): void {
  if (!proj.batchHandler || !proj.target) return;
  const existing = batch_handlers.get(proj.target);
  if (existing && existing !== proj.batchHandler) {
    throw new Error(`Duplicate batch handler for target "${proj.target}"`);
  }
  batch_handlers.set(proj.target, proj.batchHandler);
}

/**
 * Runtime backstop for slice-declared lane references — rejects
 * static `.to({lane})` entries that aren't in the declared set.
 * Inline reactions are caught at compile time; this only fires for
 * slices built against older type definitions.
 */
function validate_lane_references(
  registry: Registry<any, any, any>,
  lanes: ReadonlyArray<LaneConfig>
): void {
  const declared = new Set<string>([DEFAULT_LANE, ...lanes.map((l) => l.name)]);
  for (const [event_name, def] of Object.entries(registry.events)) {
    const entry = def as { reactions: Map<string, Reaction<any, any>> };
    for (const [handlerName, reaction] of entry.reactions) {
      const resolver = reaction.resolver;
      if (typeof resolver === "function") continue;
      const lane = (resolver as { lane?: string }).lane;
      if (lane && !declared.has(lane)) {
        throw new Error(
          `Reaction "${handlerName}" on "${event_name}" targets undeclared lane "${lane}". ` +
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
export interface ActBuilder<
  TSchemaReg extends SchemaRegister<TActions>,
  TEvents extends Schemas,
  TActions extends Schemas,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TStateMap extends Record<string, Schema> = {},
  TActor extends Actor = Actor,
  TLanes extends string = typeof DEFAULT_LANE,
> extends BuilderBase<
    ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor, TLanes>,
    TEvents,
    TActions,
    TActor,
    TLanes
  > {
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
   * Declares a drain lane (ACT-1103). Lane name narrows `TLanes` so
   * `.to({lane})` and `ActOptions.onlyLanes` type-check against it.
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
}

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
  // Caches behind registry.sensitive_fields / registry.disclosure_predicate /
  // registry.deprecated_events / registry.autoclose_policy. Populated
  // on the first .build() call.
  const _sf = new Map<string, readonly string[]>();
  // Prebuilt default-deny read gates, one per sensitive event. Non-sensitive
  // events are absent → `query_gate` falls back to the shared IDENTITY_GATE.
  const _qg = new Map<string, EventGate>();
  const _dp = new Map<string, (event: any, actor: Actor) => boolean>();
  const _de = new Map<string, ReadonlySet<string>>();
  const _ac = new Map<
    string,
    (stream: string, head: any, count: number) => boolean
  >();
  const _aa = new Map<string, (stream: string, head: any) => Promise<void>>();
  const EMPTY_DEPRECATED: ReadonlySet<string> = new Set();
  const registry: Registry<TSchemaReg, TEvents, TActions> = {
    actions: {} as Registry<TSchemaReg, TEvents, TActions>["actions"],
    events: {} as Registry<TSchemaReg, TEvents, TActions>["events"],
    sensitive_fields: (event_name) => _sf.get(event_name) ?? [],
    query_gate: (event_name) => _qg.get(event_name) ?? IDENTITY_GATE,
    disclosure_predicate: (state_name) => _dp.get(state_name) ?? null,
    deprecated_events: (state_name) => _de.get(state_name) ?? EMPTY_DEPRECATED,
    autoclose_policy: (state_name) => _ac.get(state_name) ?? null,
    autoclose_archiver: (state_name) => _aa.get(state_name) ?? null,
  };
  const pending_projections: Projection<any>[] = [];
  const fold_projections: Projection<any>[] = [];
  const batch_handlers = new Map<string, BatchHandler<any>>();
  const lanes: LaneConfig[] = [];

  // Set on the first `.build()` call. Lets the same builder produce
  // many Acts (multi-tenant / A-B testing patterns) without re-merging
  // projections or re-logging the deprecation advisory.
  let _built = false;

  // ACT-403: auto-deprecation enforcement. Groups each state's events
  // by base name + `_v<digits>`; the highest version is current, all
  // lower ones are deprecated. Stashes the deprecation set on the
  // registry (`registry.deprecated_events(state_name)`) so the
  // orchestrator can warn post-commit when an action emits one.
  // Scans static `.emit("X")` markers across every state and throws
  // if any target a deprecated event — the only legitimate use of a
  // deprecated event is on the reduce path. Finally, surfaces a
  // one-line startup advisory so operators can see "your app has
  // legacy events kept for the read path, here's where they live."
  const finalize_deprecations = () => {
    const deprecation_summary: Array<{
      state_name: string;
      deprecated: string;
      current: string;
    }> = [];
    for (const state of states.values()) {
      const event_names = Object.keys(state.events);
      const deprecated = deprecated_event_names(event_names);
      if (deprecated.size === 0) continue;
      _de.set(state.name, deprecated);
      for (const name of deprecated) {
        // `current_version_of` is guaranteed non-undefined here — `name`
        // is in `deprecated`, which by construction means a higher-
        // versioned sibling exists in the same group.
        const current = current_version_of(name, event_names) as string;
        deprecation_summary.push({
          state_name: state.name,
          deprecated: name,
          current,
        });
      }
      for (const [action_name, handler] of Object.entries(state.on)) {
        const static_target = (handler as { _static_emit?: string } | undefined)
          ?._static_emit;
        if (static_target && deprecated.has(static_target)) {
          const current = current_version_of(static_target, event_names);
          throw new Error(
            `Action "${action_name}" in state "${state.name}" emits deprecated event "${static_target}". ` +
              `A newer version exists: "${current}". Update the .emit() call ` +
              `to target the current version. The reducer (.patch) for ` +
              `"${static_target}" stays as-is — historical events still need it.`
          );
        }
      }
    }
    if (deprecation_summary.length > 0) {
      const list = deprecation_summary
        .map(
          (d) =>
            `"${d.deprecated}" (current: "${d.current}", state: "${d.state_name}")`
        )
        .join(", ");
      log().info(
        `Act registered ${deprecation_summary.length} deprecated event(s): ${list}. ` +
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
        register_state(state, states, registry.actions, registry.events);
        return builder as never;
      },
      withSlice: (input) => {
        for (const s of input.states.values()) {
          register_state(s, states, registry.actions, registry.events);
        }
        merge_event_register(registry.events, input.events);
        pending_projections.push(...input.projections);
        for (const slice_lane of input.lanes) {
          const existing = lanes.find((l) => l.name === slice_lane.name);
          if (!existing) {
            lanes.push(slice_lane);
            continue;
          }
          if (
            existing.leaseMillis !== slice_lane.leaseMillis ||
            existing.streamLimit !== slice_lane.streamLimit ||
            existing.cycleMs !== slice_lane.cycleMs
          ) {
            throw new Error(
              `Lane "${slice_lane.name}" was already declared with a different config`
            );
          }
        }
        return builder as never;
      },
      withProjection: (proj) => {
        merge_projection(proj as Projection<any>, registry.events);
        register_batch_handler(proj as Projection<any>, batch_handlers);
        if ((proj as Projection<any>).fold)
          fold_projections.push(proj as Projection<any>);
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
        // Validate the lane bag at declaration (a bad leaseMillis/streamLimit
        // throws ZodError at build, not on the first cycle).
        register_lane(resolveLaneConfig(config), lanes);
        return builder as never;
      },
      on: <TKey extends keyof TEvents>(event: TKey) =>
        reaction_on(event, registry.events, builder) as never,
      build: (options?: ActOptions) => {
        // Validate the top-level scalar knobs at build (the nested autoclose /
        // circuitBreaker bags are validated by their own resolvers). A bad
        // maxSubscribedStreams / settleDebounceMs throws ZodError here.
        resolveActConfig(options);
        // ACT-1238: select the per-event patch step ONCE here — the
        // single selection site. `bare_patch` (the literal pre-#1238
        // `patch()` merge) when `validateFoldedState` is off, else
        // `validating_patch`. The same selected value feeds BOTH the
        // projection-fold handlers below and `build_es` (via the Act
        // constructor), so the command/load paths and the projection
        // path share one choice and neither branches per event.
        const patch_fn: PatchFn =
          options?.validateFoldedState === true ? validating_patch : bare_patch;
        // One-time finalize: merge pending projections and run the
        // deprecation scan + advisory log exactly once. Calling
        // `.build({scoped: ...})` repeatedly (e.g., per tenant) is
        // supported — see extension-points.md § Scoped ports. Without
        // this guard, `merge_projection` would re-add reactions to the
        // shared registry on every call (accumulating `_p`/`_p_p`
        // dedupe suffixes), and the deprecation advisory would log on
        // every tenant.
        if (!_built) {
          for (const proj of pending_projections) {
            merge_projection(proj, registry.events as Record<string, any>);
            register_batch_handler(proj, batch_handlers);
            if (proj.fold) fold_projections.push(proj);
          }
          // State projections fold the registry-merged FULL state — the
          // builder only recorded intent. Resolve here, where every
          // partial has merged, and refuse silently-partial folds: the
          // projection's register must cover the state's whole register.
          // The `patch_fn` selected once at the top of `build()` feeds the
          // fold handlers, matching the command/load paths (ACT-1238).
          for (const proj of fold_projections) {
            const fold = proj.fold!;
            const merged = states.get(fold.name);
            if (!merged)
              throw new Error(
                `State projection "${proj.target}" folds "${fold.name}", which is not registered — add it via withState/withSlice before build()`
              );
            const missing = Object.keys(merged.events).filter(
              (event_name) => !(event_name in proj.events)
            );
            if (missing.length > 0)
              throw new Error(
                `State projection "${proj.target}" of "${fold.name}" is missing events ${missing.join(", ")} — pass every partial of the state to .of()`
              );
            batch_handlers.set(
              proj.target!,
              make_fold_handler(merged, fold.flush, fold.config, patch_fn)
            );
          }
          finalize_deprecations();
          validate_lane_references(registry, lanes);
          // Precompute the sensitive-field lookup. Iterates each registered
          // event's Zod schema exactly once at build; later commit/load paths
          // hit the cache in O(1). Events with no sensitive fields don't get
          // Build the sensitive-data wiring in three passes (#855):
          //
          // - events pass: precompute the sensitive-field lookup `_sf` from
          //   each event's Zod schema; while we're already walking events,
          //   wrap their registered reaction handlers so `build_handle`
          //   stays PII-unaware.
          // - states pass: snapshot the disclosure predicates into `_dp`,
          //   reject `.snap()` on sensitive-bearing states, and build the
          //   per-state step delegates the orchestrator calls (`me.view`,
          //   `me.message`, wrapped `me.patch[name]`).
          // - batch_handlers pass: wrap each batch handler so the batch
          //   dispatcher stays PII-unaware.
          //
          // The orchestrator calls three step delegates per event:
          //   - `me.message(validated)` — produces the commit-bound shape
          //     (`{name, data, pii?}`) from a validated emit.
          //   - `me.patch[event_name](event, state)` — the reducer that
          //     derives the next state from the committed event.
          //   - `me.view(event, actor)` — produces the caller-visible form
          //     (snapshot.event).
          //
          // For PII-free states (the common case) `view` and `message` are
          // bound to identity in `state-builder.ts` and `patch` is the
          // user-declared reducer; the orchestrator's hot path is identical
          // to the pre-#855 code at runtime. For PII-aware states (≥1
          // `sensitive(...)` event), each delegate is rebound to fold the
          // gate / split / merge into the step itself.
          for (const [event_name, reg] of Object.entries(
            registry.events as Record<
              string,
              {
                schema: import("zod").ZodType;
                reactions: Map<string, { handler: any }>;
              }
            >
          )) {
            const fields = pii_fields(reg.schema);
            if (fields.length === 0) continue;
            _sf.set(event_name, fields);
            // Prebuild the default-deny read gate once, capturing `fields`.
            // The actor-less read surfaces (`query`/`query_array`) resolve it
            // by name; non-sensitive events never reach here, so they fall
            // back to the shared IDENTITY_GATE — zero per-event cost.
            _qg.set(event_name, make_gate(fields, null));
            // Strip PII from the event payload before reactions see it.
            for (const [name, reaction] of reg.reactions) {
              const inner = reaction.handler;
              const wrapped = (event: any, stream: string, app: any) =>
                inner(pii_strip(event, fields), stream, app);
              // Preserve handler.name — build_handle asserts on named functions.
              Object.defineProperty(wrapped, "name", { value: inner.name });
              reaction.handler = wrapped;
              reg.reactions.set(name, reaction as never);
            }
          }
          for (const state of states.values()) {
            if (state.disclose) _dp.set(state.name, state.disclose);
            if (state.autoclose) _ac.set(state.name, state.autoclose);
            if (state.archive) _aa.set(state.name, state.archive);
            const fields_by_event = new Map<string, readonly string[]>();
            for (const event_name of Object.keys(state.events)) {
              const fields = _sf.get(event_name);
              if (fields) fields_by_event.set(event_name, fields);
            }
            if (fields_by_event.size === 0) continue; // pure — keep state-builder defaults
            // Snapshots write derived state into `__snapshot__.data`, which
            // `forget_pii` cannot reach. Reject the combination at build so
            // the misconfiguration surfaces in dev/CI, not as a silent leak
            // past the GDPR boundary months later.
            if (state.snap) {
              const offending = [...fields_by_event.keys()];
              throw new Error(
                `State "${state.name}" cannot snapshot — events {${offending.join(", ")}} carry sensitive fields. ` +
                  "Snapshots write derived state into __snapshot__.data, which forget_pii cannot reach. " +
                  "Remove .snap() or remove sensitive(...) markers."
              );
            }
            const disclose = state.disclose ?? null;
            state.pii_aware = true;
            // Prebuild one actor-aware read gate per sensitive event, capturing
            // this state's disclosure predicate — the same `make_gate`
            // primitive the query path uses (predicate-less there). A pii-aware
            // state can still declare non-sensitive events; those aren't in
            // `view_gates`, so `state.view` falls back to the shared
            // IDENTITY_GATE — no per-event field lookup, no `?? []` allocation.
            const view_gates = new Map<string, EventGate>();
            for (const [event_name, fields] of fields_by_event) {
              view_gates.set(event_name, make_gate(fields, disclose));
            }
            state.view = (event, actor) =>
              (view_gates.get(event.name as string) ?? IDENTITY_GATE)(
                event,
                actor
              );
            state.message = (validated) => {
              const fields = fields_by_event.get(validated.name as string);
              return fields ? pii_split(validated, fields) : validated;
            };
          }
          for (const [target, original] of batch_handlers) {
            const wrapped = async (events: any[], stream: string) => {
              const stripped = events.map((e) => {
                const f = _sf.get(e.name as string);
                return f ? pii_strip(e, f) : e;
              });
              return original(stripped as never, stream);
            };
            batch_handlers.set(target, wrapped as never);
          }
          // Synthesize the autoclose reactions last, once the registry is
          // fully merged — their dynamic resolvers must be present before
          // the orchestrator classifies the registry. The window/cadence
          // knobs resolve from this first build() call's options; repeat
          // builds (per-tenant scoped Acts) share the registry and the
          // synthesized reaction with it.
          synthesize_autoclose_reactions(
            registry,
            states,
            resolveAutocloseConfig(options ?? {})
          );
          // The registry is complete: freeze the containers so any later
          // registration or orchestrator-side mutation throws instead of
          // silently diverging from what was classified. (Reaction maps
          // remain Map instances — the freeze guards the object shape,
          // convention guards the maps.)
          Object.freeze(registry.actions);
          Object.freeze(registry.events);
          Object.freeze(registry);
          _built = true;
        }

        return new Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>(
          registry,
          states,
          batch_handlers,
          options,
          lanes,
          patch_fn
        );
      },
      events: registry.events,
    };
  return builder;
}
