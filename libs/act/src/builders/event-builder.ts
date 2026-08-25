/**
 * @module event-builder
 * @category Internal
 *
 * Everything `act().build()` derives from the registered events, in one place
 * and one walk.
 *
 * Two kinds of work happen per event, and both were previously spread across
 * `act-builder` as separate passes over the same structure:
 *
 * - **validation** — a reaction may not target a lane nobody declared, nor a
 *   target a projection already serves. Both walk events → reactions and both
 *   skip dynamic resolvers, because a `.to(fn)` target is unknowable until an
 *   event arrives.
 * - **wiring** — resolve each event's schema once into its {@link EventTags},
 *   compose the per-surface readers from it, and wrap reaction handlers so the
 *   dispatcher stays PII-unaware.
 *
 * Deliberately NOT here: deprecation. `Foo` is deprecated only because
 * `Foo_v2` exists beside it, so it is derived from event *names across a whole
 * state* rather than from one event's schema — and it governs *emitting* (a
 * static `.emit()` throws at build), not reading. Replay of a deprecated event
 * stays silent by design.
 *
 * @internal
 */

import {
  type EventGate,
  type EventTags,
  event_tags,
  make_event_reader,
} from "../internal/index.js";
import { DEFAULT_LANE } from "../ports.js";
import type { LaneConfig, Registry } from "../types/index.js";

/** What the events pass resolves, keyed by event name. @internal */
export type BuiltEvents = {
  /** One resolution of each event's schema — the source for everything below. */
  readonly tags: Map<string, EventTags>;
  /** Reader for the actor-less read surfaces (`query` / `query_array`). */
  readonly query_readers: Map<string, EventGate>;
  /** Reader for handlers — sensitive keys removed, payload typed. */
  readonly handler_readers: Map<string, EventGate>;
};

/** What validation needs to know about the projections already registered. */
export type TargetOwners = {
  readonly batch_handlers: ReadonlyMap<string, unknown>;
  readonly fold_targets: ReadonlySet<string>;
  /** A projection's own reactions legitimately target it — excluded by identity. */
  readonly projection_reactions: ReadonlySet<unknown>;
};

type EventEntry = {
  schema: import("zod").ZodType;
  reactions: Map<string, { handler: any; resolver: unknown }>;
};

/**
 * Validate every static reaction and wire every event, in a single walk.
 *
 * Ownership conflicts throw as they are found; lane violations are collected
 * and thrown afterwards. That ordering is deliberate — it preserves the
 * precedence the two separate passes had, where the ownership guard ran to
 * completion before lane references were checked, so a config violating both
 * reports the same error it always did.
 *
 * @internal
 */
export function build_events(
  registry: Registry<any, any, any>,
  lanes: ReadonlyArray<LaneConfig>,
  owners: TargetOwners
): BuiltEvents {
  const declared = new Set<string>([DEFAULT_LANE, ...lanes.map((l) => l.name)]);
  const lane_errors: string[] = [];

  const tags = new Map<string, EventTags>();
  const query_readers = new Map<string, EventGate>();
  const handler_readers = new Map<string, EventGate>();

  for (const [event_name, def] of Object.entries(
    registry.events as Record<string, EventEntry>
  )) {
    for (const [handler_name, reaction] of def.reactions) {
      // A build-time guard can only see a static target: a `.to(fn)` target
      // is unknowable until an event arrives.
      if (typeof reaction.resolver === "function") continue;
      const resolver = reaction.resolver as { target: string; lane?: string };

      const claimed =
        owners.batch_handlers.has(resolver.target) ||
        owners.fold_targets.has(resolver.target);
      if (claimed && !owners.projection_reactions.has(reaction))
        throw new Error(
          `Reaction on target "${resolver.target}" conflicts with the projection that already serves it — a target is served by one batch handler or one state projection, and a reaction to it would never run`
        );

      if (resolver.lane && !declared.has(resolver.lane))
        lane_errors.push(
          `Reaction "${handler_name}" on "${event_name}" targets undeclared lane "${resolver.lane}". ` +
            `Declared lanes: ${[...declared].map((l) => `"${l}"`).join(", ")}. ` +
            `Add \`.withLane({ name: "${resolver.lane}", ... })\` to act() or correct the .to() declaration.`
        );
    }

    // One resolution of the declared schema yields both facts a reader is
    // built from: which fields are sensitive, and how to type the payload.
    const event = event_tags(def.schema);
    tags.set(event_name, event);

    // An event needing neither typing nor redaction produces no reader and
    // falls back to the shared IDENTITY_GATE — zero per-event cost.
    const query_reader = make_event_reader(event, "redact", null);
    if (query_reader) query_readers.set(event_name, query_reader);

    // Handlers never see PII by framework rule, and shouldn't observe the
    // keys structurally either — so `strip`, not `redact`.
    const handler_reader = make_event_reader(event, "strip");
    if (handler_reader) {
      handler_readers.set(event_name, handler_reader);
      for (const [name, reaction] of def.reactions) {
        const inner = reaction.handler;
        const wrapped = (evt: any, stream: string, app: any) =>
          inner(handler_reader(evt), stream, app);
        // Preserve handler.name — build_handle asserts on named functions.
        Object.defineProperty(wrapped, "name", { value: inner.name });
        reaction.handler = wrapped;
        def.reactions.set(name, reaction as never);
      }
    }
  }

  if (lane_errors.length > 0) throw new Error(lane_errors[0]);
  return { tags, query_readers, handler_readers };
}
