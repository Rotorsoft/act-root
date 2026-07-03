/**
 * @module builder-base
 * @category Builders
 *
 * The builder types shared by `SliceBuilder` and `ActBuilder`: the `.on(...)`
 * reaction step ({@link ReactionOn}) and the base of members whose return type
 * is the builder itself with the **same** generics ({@link BuilderBase}). Both
 * are parameterized on the concrete builder (`TReturn` / `Self`) via plain
 * F-bounded polymorphism, so error messages resolve to `SliceBuilder<…>` /
 * `ActBuilder<…>` rather than an abstract base.
 *
 * These live in the builders layer (not `internal/`) because they reference
 * `Projection`, a builders-layer type; the runtime that fills them
 * (`reaction_on`, `register_lane`) stays in `internal/builder-utils.ts`.
 *
 * `withState` and `withLane` are intentionally **not** in `BuilderBase`: they
 * *widen* the generics (return a different instantiation), which a shared
 * signature could only express with HKT emulation, and that degrades the public
 * builder's hover and error output. That trade isn't worth deduping two
 * declarative signatures, so they stay declared per-builder (#1110).
 */

import type {
  Actor,
  Committed,
  DeferWhen,
  EventRegister,
  IAct,
  ReactionOptions,
  ReactionResolver,
  Schema,
  Schemas,
  Snapshot,
} from "../types/index.js";
import type { Projection } from "./projection-builder.js";

/**
 * The `.do(handler)` step, parameterized by the builder it returns (`TReturn`).
 * Identical for both builders modulo that return type.
 */
type ReactionDo<
  TReturn,
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor,
  TLanes extends string,
  TKey extends keyof TEvents,
> = (
  handler: (
    event: Committed<TEvents, TKey>,
    stream: string,
    app: IAct<TEvents, TActions, TActor>
  ) => Promise<Snapshot<Schema, TEvents> | void>,
  options?: Partial<ReactionOptions>
) => TReturn & {
  to: (resolver: ReactionResolver<TEvents, TKey, TLanes> | string) => TReturn;
};

/**
 * The object `.on(event)` returns: run immediately with `.do(...)`, or hold
 * with `.defer(when).do(...)`. Parameterized by the return builder so
 * `act()` and `slice()` share one shape.
 */
export type ReactionOn<
  TReturn,
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor,
  TLanes extends string,
  TKey extends keyof TEvents,
> = {
  do: ReactionDo<TReturn, TEvents, TActions, TActor, TLanes, TKey>;
  defer: (
    schedule: DeferWhen | ((event: Committed<TEvents, TKey>) => DeferWhen)
  ) => {
    do: ReactionDo<TReturn, TEvents, TActions, TActor, TLanes, TKey>;
  };
};

/**
 * Builder members that return `Self` unchanged — shared by both builders.
 *
 * @template Self - the concrete builder type returned for chaining
 * @template TEvents - event schemas
 * @template TActions - action schemas
 * @template TActor - actor type
 * @template TLanes - declared lane-name union
 */
export interface BuilderBase<
  Self,
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor,
  TLanes extends string,
> {
  /**
   * Registers a standalone projection. Its events must be a subset of events
   * already registered via `.withState()` (or `.withSlice()` on the Act
   * builder); handlers keep their `(event, stream)` signature.
   */
  withProjection: <TNewEvents extends Schemas>(
    projection: [Exclude<keyof TNewEvents, keyof TEvents>] extends [never]
      ? Projection<TNewEvents>
      : never
  ) => Self;
  /**
   * Begins defining a reaction. Chain `.do(...)` to run immediately, or
   * `.defer(when).do(...)` to hold the reaction until a schedule is due
   * (#1091). `.to(...)` follows `.do(...)` in both cases and, for a deferred
   * reaction, routes it onto its own target so the hold doesn't stall the
   * stream's other reactions.
   */
  on: <TKey extends keyof TEvents>(
    event: TKey
  ) => ReactionOn<Self, TEvents, TActions, TActor, TLanes, TKey>;
  /** The registered event schemas and their reaction maps. */
  readonly events: EventRegister<TEvents>;
}
