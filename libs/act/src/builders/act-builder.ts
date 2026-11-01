/**
 * @module act-builder
 * @category Builders
 *
 * Fluent builder for composing event-sourced applications.
 */
import { Act } from "../act.js";
import { synthesize_autoclose_reactions } from "../internal/autoclose-reaction.js";
import { resolveActConfig } from "../internal/config.js";
import {
  current_version_of,
  deprecated_event_names,
} from "../internal/event-versions.js";
import { type EventGate, IDENTITY_GATE } from "../internal/pii.js";
import {
  FOLD_RESET,
  make_fold_handler,
  type ResettableBatchHandler,
} from "../internal/projection-fold.js";
import { log } from "../ports.js";
import { current_autoclose_window } from "../scoped.js";
import type { ActBuilder, Projection } from "../types/builders.js";
import type {
  ActOptions,
  Actor,
  BatchHandler,
  LaneConfig,
  Registry,
  Schema,
  SchemaRegister,
  Schemas,
  State,
} from "../types/index.js";
import { reaction_on, register_lane } from "./builder-utils.js";
import { build_events } from "./event-builder.js";
import {
  merge_event_register,
  merge_projection,
  register_state,
} from "./merge.js";

/**
 * Registers a projection's batch handler against its target stream, throwing
 * if a different handler already serves it. Folds (`.of(...)`) have no
 * batch handler; their side of the check is in `build()`.
 */
function register_batch_handler(
  proj: Projection<any>,
  batch_handlers: Map<string, BatchHandler<any>>
): void {
  if (!proj.batchHandler || !proj.target) return;
  const existing = batch_handlers.get(proj.target);
  if (existing && existing !== proj.batchHandler) {
    throw new Error(
      `Duplicate projection target "${proj.target}" — a target is served by one batch handler or one state projection, never both`
    );
  }
  batch_handlers.set(proj.target, proj.batchHandler);
}

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
  // Caches behind the registry's derived lookups, populated on the first
  // `.build()`. Each event schema is walked once.
  const _sf = new Map<string, readonly string[]>();
  // Prebuilt handler readers — sensitive keys removed, payload typed. Absent
  // when the event needs neither.
  const _hr = new Map<string, EventGate>();
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
  /**
   * Reactions contributed by projections, recorded at registration. Only
   * these may target a projection's stream; anything else is a collision.
   */
  const projection_reactions = new Set<unknown>();
  const record_projection_reactions = (proj: Projection<any>) => {
    // Only a projection that SERVES its target (a batch handler or a fold)
    // owns it. A per-event projection naming the same target is just another
    // claimant: exempting it let it share a fold's or batch's target, where
    // its handler never ran and the fold wrote foreign rows.
    if (!proj.batchHandler && !proj.fold) return;
    for (const register of Object.values(
      proj.events as Record<string, { reactions: Map<string, unknown> }>
    ))
      for (const reaction of register.reactions.values())
        projection_reactions.add(reaction);
  };
  const fold_projections: Projection<any>[] = [];
  const batch_handlers = new Map<string, BatchHandler<any>>();
  const add_projection = (proj: Projection<any>) => {
    record_projection_reactions(proj);
    merge_projection(proj, registry.events as Record<string, any>);
    register_batch_handler(proj, batch_handlers);
    if (proj.fold) fold_projections.push(proj);
  };
  // Validated fold-projection ingredients, resolved once on the first
  // build. The HANDLERS themselves are built per `.build()` — see
  // `make_batch_handlers` — because a fold handler owns a mutable
  // per-stream cache that must never be shared across Acts.
  const fold_specs: {
    target: string;
    /** Identity of the registering projection, so a repeat registration of
     *  the same object is recognized as one claim rather than two. */
    projection: Projection<any>;
    merged: any;
    flush: any;
    config: any;
  }[] = [];
  const lanes: LaneConfig[] = [];

  // Set on the first `.build()` call. Lets the same builder produce
  // many Acts (multi-tenant / A-B testing patterns) without re-merging
  // projections or re-logging the deprecation advisory.
  let _built = false;

  /**
   * Wraps a batch handler so it receives events in handler form — payload
   * typed from the declared schema, sensitive keys removed — the same reader
   * `event-builder` gives per-event handlers. Resolved lazily at dispatch, by
   * when the events pass has populated it.
   */
  const read_wrap = (original: BatchHandler<any>): BatchHandler<any> => {
    const wrapped = async (events: readonly any[], stream: string) => {
      // The same prebuilt reader the per-event handlers get: typed payload,
      // sensitive keys removed. Absent → the event passes through untouched.
      const read = events.map((e) => _hr.get(e.name as string)?.(e) ?? e);
      return original(read as never, stream);
    };
    // Carry the fold's cache-reset handle through the wrapper. The
    // orchestrator only ever sees what this map holds, so a handle left on
    // the inner handler is a handle nobody can reach.
    const reset = (original as ResettableBatchHandler<any>)[FOLD_RESET];
    if (reset) Object.defineProperty(wrapped, FOLD_RESET, { value: reset });
    return wrapped;
  };

  /**
   * Per-Act batch-handler map. Stateless handlers are shared; fold
   * handlers own a per-stream cache, so each `.build()` gets fresh ones.
   */
  const make_batch_handlers = () => {
    const handlers = new Map(batch_handlers);
    for (const spec of fold_specs) {
      handlers.set(
        spec.target,
        read_wrap(
          make_fold_handler(
            spec.merged,
            spec.flush,
            spec.config,
            // Head loads strip sensitive keys like the warm path.
            registry.sensitive_fields
          )
        ) as never
      );
    }
    return handlers;
  };

  // Versioned events: per state, the highest `_v<n>` is current and lower
  // ones are deprecated (`registry.deprecated_events`). A static
  // `.emit("X")` of a deprecated event throws; a one-line advisory lists
  // the legacy events kept for replay.
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

  /**
   * Registration is closed once `build()` has classified the registry: every
   * mutating method throws a clear error after it. `build()` itself stays
   * callable repeatedly, since the multi-tenant pattern calls
   * `.build({scoped})` per tenant and registers nothing.
   */
  const closed = (method: string): never => {
    throw new Error(
      `act().${method}() was called after build(); the registry is already classified. Register everything before build() — build() itself may be called repeatedly (e.g. once per tenant with ActOptions.scoped).`
    );
  };

  // The `as` chain on `self` is the type fanout: each fluent method
  // mutates state and returns `self` cast to its post-call generic
  // signature. Internal-only — public types stay narrow.
  const builder: ActBuilder<TSchemaReg, TEvents, TActions, TStateMap, TActor> =
    {
      withState: (state) => {
        if (_built) closed("withState");
        register_state(state, states, registry.actions, registry.events);
        return builder as never;
      },
      withSlice: (input) => {
        if (_built) closed("withSlice");
        for (const s of input.states.values()) {
          register_state(s, states, registry.actions, registry.events);
        }
        merge_event_register(registry.events, input.events);
        pending_projections.push(...input.projections);
        for (const lane of input.lanes) register_lane(lane, lanes);
        return builder as never;
      },
      withProjection: (proj) => {
        if (_built) closed("withProjection");
        add_projection(proj as Projection<any>);
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
        if (_built) closed("withLane");
        register_lane(config, lanes);
        return builder as never;
      },
      on: <TKey extends keyof TEvents>(event: TKey) => {
        if (_built) closed("on");
        return reaction_on(event, registry.events, builder) as never;
      },
      build: (options?: ActOptions) => {
        // Validate the top-level scalar knobs at build (the nested autoclose /
        // circuitBreaker bags are validated by their own resolvers). A bad
        // maxSubscribedStreams / settleDebounceMs throws ZodError here.
        resolveActConfig(options);
        // Finalize once: repeated builds (per tenant) share the registry.
        if (!_built) {
          for (const proj of pending_projections) add_projection(proj);
          // State projections fold the registry-merged FULL state — the
          // builder only recorded intent. Resolve here, where every
          // partial has merged, and refuse silently-partial folds: the
          // projection's register must cover the state's whole register.
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
            // A target is claimed once, by a batch handler or a fold; two
            // different projections on one target throw. The same projection
            // registered twice is fine.
            const claimed = fold_specs.find((s) => s.target === proj.target);
            if (claimed?.projection === proj) continue;
            if (batch_handlers.has(proj.target!) || claimed)
              throw new Error(
                `Duplicate projection target "${proj.target}" — a target is served by one batch handler or one state projection, never both`
              );
            // Record the validated ingredients only. The handler is
            // constructed per `.build()` (see `make_batch_handlers`) — it
            // owns a mutable per-stream fold cache, so one shared instance
            // would leak folded rows between Acts built from this builder.
            fold_specs.push({
              target: proj.target!,
              projection: proj,
              merged,
              flush: fold.flush,
              config: fold.config,
            });
          }
          // An ordinary reaction on a projection's target would never run and
          // would feed the fold another aggregate, so `build_events` rejects
          // it (the projection's own reactions are exempt).
          //
          // One walk over the registered events: validate every static
          // reaction, resolve each schema once, and compose the per-surface
          // readers from it. See `event-builder.ts`.
          const built = build_events(registry, states, lanes, {
            batch_handlers,
            fold_targets: new Set(fold_specs.map((f) => f.target)),
            projection_reactions,
          });
          for (const [name, fields] of built.sensitive) _sf.set(name, fields);
          for (const [name, gate] of built.query_readers) _qg.set(name, gate);
          for (const [name, gate] of built.handler_readers) _hr.set(name, gate);
          finalize_deprecations();
          if (built.mistyped.size > 0)
            log().warn(
              `Act has ${built.mistyped.size} sensitive field(s) whose type isn't a string: ${[...built.mistyped].join(", ")}. ` +
                `A caller who may not see one reads "[REDACTED]" or "[SHREDDED]" there instead, ` +
                `which its type doesn't allow. Declare sensitive fields as strings. ` +
                `See docs/docs/guides/sensitive-data.md.`
            );

          for (const state of states.values()) {
            if (state.disclose) _dp.set(state.name, state.disclose);
            if (state.autoclose) _ac.set(state.name, state.autoclose);
            if (state.archive) _aa.set(state.name, state.archive);
          }
          for (const [target, original] of batch_handlers) {
            batch_handlers.set(target, read_wrap(original) as never);
          }
          // Synthesize the autoclose reactions last, once the registry is
          // fully merged — their dynamic resolvers must be present before
          // the orchestrator classifies the registry.
          //
          // Nothing per-Act is captured: repeat builds share these reactions,
          // and the off-hours window comes from the running Act's frame.
          synthesize_autoclose_reactions(
            registry,
            states,
            current_autoclose_window
          );
          // Freeze the registry shape; the `_built` latch on each method stops
          // later registration (freezing doesn't seal the reaction `Map`s).
          Object.freeze(registry.actions);
          Object.freeze(registry.events);
          Object.freeze(registry);
          _built = true;
        }

        return new Act<TSchemaReg, TEvents, TActions, TStateMap, TActor>(
          registry,
          states,
          make_batch_handlers(),
          options,
          lanes
        );
      },
      events: registry.events,
    };
  return builder;
}
