/**
 * @module builder-core
 * @category Builders
 *
 * The builder members shared by `SliceBuilder` and `ActBuilder` whose return
 * type is the builder itself with the **same** generics (`Self`), factored out
 * via plain F-bounded polymorphism. Each builder passes its own concrete type
 * as `Self`, so error messages still resolve to `SliceBuilder<…>` /
 * `ActBuilder<…>` rather than an abstract base.
 *
 * `withState` and `withLane` are intentionally **not** here: they *widen* the
 * generics (return a different instantiation), which a shared signature could
 * only express with HKT emulation, and that degrades the public builder's hover
 * and error output. That trade isn't worth deduping two declarative signatures,
 * so they stay declared per-builder (#1110).
 */

import type { ReactionOn } from "../internal/index.js";
import type { Actor, EventRegister, Schemas } from "../types/index.js";
import type { Projection } from "./projection-builder.js";

/**
 * Builder members that return `Self` unchanged. Shared by both builders.
 *
 * @template Self - the concrete builder type returned for chaining
 * @template TEvents - event schemas
 * @template TActions - action schemas
 * @template TActor - actor type
 * @template TLanes - declared lane-name union
 */
export interface BuilderCore<
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
