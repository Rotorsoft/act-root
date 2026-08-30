/**
 * @module event-builder
 * @category Internal
 *
 * Everything `act().build()` derives from the registered events.
 *
 * This is the build-time half of the event lifecycle. `internal/sensitive.ts`
 * owns the other two halves — the `sensitive(...)` marker itself, and the
 * runtime transforms (`pii_gate`, `pii_strip`, `pii_split`) that a reader is
 * composed from. Nothing here runs per event at runtime; everything here runs
 * once, at build, and hands the orchestrator a prebuilt function.
 *
 * Three things are derived, all in ONE walk over the registered events:
 *
 * - **validation** — a reaction may not target a lane nobody declared, nor a
 *   target a projection already serves. Both checks skip dynamic resolvers,
 *   because a `.to(fn)` target is unknowable until an event arrives.
 * - **resolution** — each event's schema is read once into {@link EventTags}:
 *   which fields are sensitive, and how to type the stored payload.
 * - **composition** — the per-surface readers, each a single {@link EventGate}
 *   that types the payload and applies disclosure in one call.
 *
 * Deliberately NOT here: deprecation. `Foo` is deprecated only because
 * `Foo_v2` exists beside it, so it is derived from event *names across a whole
 * state* rather than from one event's schema — and it governs *emitting* (a
 * static `.emit()` throws at build), not reading. Replay of a deprecated event
 * stays silent by design.
 *
 * @internal
 */

import { z } from "zod";
import {
  type EventGate,
  IDENTITY_GATE,
  is_pii,
  make_gate,
  pii_split,
  pii_strip,
} from "../internal/sensitive.js";
import { DEFAULT_LANE, SNAP_EVENT } from "../ports.js";
import type { Actor, LaneConfig, Registry } from "../types/index.js";

/** What one pass over an event's schema resolves. @internal */
export type EventTags = {
  /** Keys marked `sensitive(...)`, top level (and across union variants). */
  readonly sensitive: readonly string[];
  /**
   * Revives the dates in a stored `data` payload, or `undefined` when the
   * schema declares none.
   */
  readonly date_reviver: ((data: unknown) => unknown) | undefined;
  /**
   * Revives the dates in a stored `pii` sidecar, or `undefined` when no
   * sensitive field is a date.
   */
  readonly pii_date_reviver: ((pii: unknown) => unknown) | undefined;
};

/** Zod exposes its shape under `_zod.def` in v4 and `def` in older builds. */
const def_of = (schema: unknown): Record<string, unknown> | undefined =>
  (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
  (schema as { def?: Record<string, unknown> }).def;

/**
 * Build the schema that revives an event's dates, or `undefined` when it
 * declares none.
 *
 * JSON has no date type, so a stored `Date` comes back as text and something
 * has to turn it back. That is this function's only job, and the schema it
 * returns says only where the dates are: every other field is left out and
 * rides through the loose object untouched. The payload was validated when it
 * was committed, so re-checking it on the way out would be work already done.
 *
 * Naming only the dates is also what makes a read tolerant, without needing a
 * rule per exception. A `sensitive(...)` field lives in the `pii` sidecar
 * rather than in `data`; an event written against an older declaration
 * predates whatever was added since; a field dropped from the declaration is
 * still in the store. None of those are dates, so none of them are described
 * here, and a payload carrying any of them still reads. The dates themselves
 * are optional for the same reason — absent is not wrong.
 *
 * Zod does the walking, so nesting, arrays, records, unions and the wrappers
 * are handled by the engine rather than by a traversal of our own that would
 * drift as Zod grows constructs. A construct this doesn't recognise
 * contributes no date, which is the documented fallthrough.
 */
function date_reviver_schema(schema: unknown): z.ZodType | undefined {
  const def = def_of(schema);
  if (!def) return undefined;
  const inner = () => date_reviver_schema(def.innerType);
  switch (def.type) {
    case "date":
      return z.coerce.date();
    case "object": {
      const shape = def.shape as Record<string, z.ZodType> | undefined;
      if (!shape) return undefined;
      const dated: Record<string, z.ZodType> = {};
      for (const [key, field] of Object.entries(shape)) {
        const dates = date_reviver_schema(field);
        if (dates) dated[key] = dates.optional();
      }
      return Object.keys(dated).length ? z.looseObject(dated) : undefined;
    }
    case "array": {
      const element = date_reviver_schema(def.element);
      return element && z.array(element);
    }
    case "tuple": {
      const items = (def.items as unknown[]).map((i) => date_reviver_schema(i));
      return items.some(Boolean)
        ? z.tuple(items.map((i) => i ?? z.unknown()) as never)
        : undefined;
    }
    case "record": {
      const value = date_reviver_schema(def.valueType);
      return value && z.record(z.string(), value);
    }
    case "union": {
      const options = (def.options as unknown[]).map((o) =>
        date_reviver_schema(o)
      );
      return options.some(Boolean)
        ? z.union(options.map((o) => o ?? z.unknown()) as never)
        : undefined;
    }
    case "nullable":
      // Keep the null: coercing it would hand back the epoch.
      return inner()?.nullable();
    case "optional":
    case "nonoptional":
    case "readonly":
    case "default":
    case "prefault":
    case "catch":
      return inner();
    default:
      return undefined;
  }
}

/**
 * Resolve an event's schema in a single pass.
 *
 * Sensitive markers are read at the top level only — the documented carve-out
 * (`sensitive.ts`), since the write path splits whole top-level keys. A union
 * event has no top-level shape, so its variants are walked and unioned: a key
 * sensitive in any variant must be split, because the stored payload could be
 * that variant ([#1417](https://github.com/Rotorsoft/act-root/issues/1417)).
 *
 * @internal
 */
export function event_tags(schema: z.ZodType): EventTags {
  const sensitive: string[] = [];
  const pii_dates: Record<string, z.ZodType> = {};

  const collect = (node: unknown): void => {
    const shape = def_of(node)?.shape as Record<string, z.ZodType> | undefined;
    if (shape) {
      for (const key of Object.keys(shape))
        if (is_pii(shape[key])) {
          sensitive.push(key);
          const dates = date_reviver_schema(shape[key]);
          if (dates) pii_dates[key] ??= dates.optional();
        }
      return;
    }
    const options = (node as { options?: unknown }).options;
    if (Array.isArray(options)) for (const option of options) collect(option);
  };
  collect(schema);

  const unique = [...new Set(sensitive)];
  const data_reviver_schema = date_reviver_schema(schema);
  // The sidecar holds the split-out fields alone, so a date among them needs
  // its own pass — without it a disclosed `sensitive(z.date())` arrives as
  // text beside a plain sibling that is a Date.
  const has_pii_date = Object.keys(pii_dates).length > 0;
  // Reviving must never reject. A stored payload can disagree with the current
  // declaration in ways this schema deliberately does not describe, and handing
  // back what is stored beats refusing to read it.
  const revive = (schema: z.ZodType) => (data: unknown) => {
    const revived = schema.safeParse(data);
    return revived.success ? revived.data : data;
  };
  return {
    sensitive: unique,
    date_reviver: data_reviver_schema && revive(data_reviver_schema),
    pii_date_reviver: has_pii_date
      ? revive(z.looseObject(pii_dates))
      : undefined,
  };
}

/**
 * What the reader should do about sensitive fields.
 *
 * - `redact` — substitute `[REDACTED]` unless `disclose` authorizes the actor,
 *   and drop the `pii` sidecar. The read surfaces (`query`, `query_array`,
 *   `load`).
 * - `strip` — remove the keys entirely. Reaction and projection handlers,
 *   which never see PII by framework rule, and shouldn't structurally observe
 *   the keys either.
 *
 * @internal
 */
export type Disclosure = "redact" | "strip";

/**
 * Compose one event's typing and disclosure into a single gate.
 *
 * Returns `undefined` when the event needs neither, so the caller can fall
 * back to the shared {@link IDENTITY_GATE} and the common path allocates
 * nothing.
 *
 * @internal
 */
export function make_event_reader(
  tags: EventTags,
  disclosure: Disclosure,
  predicate: ((event: never, actor: Actor) => boolean) | null = null
): EventGate | undefined {
  const { sensitive, date_reviver, pii_date_reviver } = tags;
  if (!date_reviver && sensitive.length === 0) return undefined;

  const gate: EventGate =
    sensitive.length === 0
      ? IDENTITY_GATE
      : disclosure === "strip"
        ? (((event) => pii_strip(event as never, sensitive)) as EventGate)
        : make_gate(sensitive, predicate as never);

  if (!date_reviver) return gate;

  // Revive before disclosing: the gate copies, so reviving afterwards would
  // leave the consumer's value a string — and it substitutes REDACTED and
  // SHREDDED, which are not dates.
  return ((event, actor) => {
    const pii = (event as { pii?: unknown }).pii;
    return gate(
      {
        ...event,
        data: date_reviver(event.data),
        ...(pii_date_reviver && pii != null
          ? { pii: pii_date_reviver(pii) }
          : {}),
      } as never,
      actor
    );
  }) as EventGate;
}

/**
 * Exactly what the registry serves, keyed by event name — no intermediates.
 *
 * The per-state `view` is installed directly on each state rather than
 * returned: it is event-derived wiring like the rest, and handing it back for
 * the caller to install would put the composition back where it came from.
 *
 * @internal
 */
export type BuiltEvents = {
  /** Backs `registry.sensitive_fields`. */
  readonly sensitive: Map<string, readonly string[]>;
  /** Backs `registry.query_gate` — the actor-less read surfaces. */
  readonly query_readers: Map<string, EventGate>;
  /** Readers for handlers — sensitive keys removed, payload typed. */
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
  states: ReadonlyMap<string, any>,
  lanes: ReadonlyArray<LaneConfig>,
  owners: TargetOwners
): BuiltEvents {
  const declared = new Set<string>([DEFAULT_LANE, ...lanes.map((l) => l.name)]);
  const lane_errors: string[] = [];

  const tags = new Map<string, EventTags>();
  const sensitive = new Map<string, readonly string[]>();
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
    if (event.sensitive.length > 0) sensitive.set(event_name, event.sensitive);

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

  // Per-state wiring, all of it derived from the same event resolution: the
  // read view, the write split, and the guard that refuses to combine the two
  // things that cannot coexist.
  for (const state of states.values()) {
    const state_fields = new Map<string, readonly string[]>();
    for (const event_name of Object.keys(state.events)) {
      const fields = sensitive.get(event_name);
      if (fields) state_fields.set(event_name, fields);
    }

    if (state_fields.size > 0) {
      // Snapshots write derived state into `__snapshot__.data`, which
      // `forget_pii` cannot reach. Reject the combination at build so the
      // misconfiguration surfaces in dev/CI, not as a silent leak past the
      // GDPR boundary months later.
      if (state.snap)
        throw new Error(
          `State "${state.name}" cannot snapshot — events {${[...state_fields.keys()].join(", ")}} carry sensitive fields. ` +
            "Snapshots write derived state into __snapshot__.data, which forget_pii cannot reach. " +
            "Remove .snap() or remove sensitive(...) markers."
        );
      state.pii_aware = true;
      // The write half: split declared fields into the `pii` sidecar on the
      // way to `Store.commit`.
      state.message = (validated: { name: string }) => {
        const fields = state_fields.get(validated.name);
        return fields ? pii_split(validated as never, fields) : validated;
      };
    }

    // The read half. A state's disclosure predicate is an input to the
    // reader, not a second gate layered over it. A `__snapshot__` carries
    // folded STATE rather than event data, so its typing comes from the state
    // schema — without that a restart from a snapshot loses every `z.date()`
    // the state holds.
    const readers = new Map<string, EventGate>();
    for (const event_name of Object.keys(state.events)) {
      const event = tags.get(event_name);
      const reader =
        event && make_event_reader(event, "redact", state.disclose ?? null);
      if (reader) readers.set(event_name, reader);
    }
    const snap = make_event_reader(event_tags(state.state), "redact", null);
    if (snap) readers.set(SNAP_EVENT, snap);
    if (readers.size === 0) continue;
    state.view = (event: { name: string }, actor: Actor) =>
      (readers.get(event.name) ?? IDENTITY_GATE)(event as never, actor);
  }

  return { sensitive, query_readers, handler_readers };
}
