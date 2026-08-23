/**
 * @module scoped
 * @category Internal
 *
 * Ambient execution context — every `AsyncLocalStorage` the framework owns
 * lives here, and so does every operation on one. No other module calls
 * `.run()` or `.getStore()`; they ask for a runner or a reader instead, so
 * this file is the single place to look at the abstraction.
 *
 * Two contexts:
 *
 * - **ports** — the active Act's store/cache bag, so `store()` / `cache()`
 *   resolve per-Act rather than per-process (ACT-501). Installed by the
 *   orchestrator via {@link make_run_scoped}, read by the port singletons
 *   via {@link current_ports}.
 * - **reaction** — the event a handler is processing, so a dispatch made
 *   anywhere inside that handler can thread `reactingTo` whichever `IAct`
 *   reference made the call (#1541). Installed via {@link run_reacting},
 *   read at the orchestrator boundary via {@link current_reacting}.
 *
 * Keeping the mechanics here keeps ambient state out of `internal/`, whose
 * modules are stateless implementations that receive what they need.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  Actor,
  Cache,
  Committed,
  IAct,
  Schemas,
  Store,
} from "./types/index.js";

/** Per-Act ports bag (ACT-501). Both required together — a shared cache across stores would collide on stream keys. */
export type Scoped = {
  readonly store: Store;
  readonly cache: Cache;
};

/**
 * AsyncLocalStorage carrying the active Act's ports.
 *
 * Exported for in-repo tooling that measures the context itself (the
 * scope-overhead bench). NOT public: `ports.ts` no longer re-exports it and
 * `index.ts` reaches this module only for the `Scoped` type, so it is not
 * importable from the package. Everything else uses the helpers below.
 */
export const scoped = new AsyncLocalStorage<Scoped>();

/** The event currently being reacted to. Not reachable from `index.ts`. */
const reacting = new AsyncLocalStorage<Committed<Schemas, string>>();

/**
 * Builds the runner an Act uses to enter its own port scope.
 *
 * A scoped Act wraps every entry point so `store()`/`cache()` resolve to its
 * bag; a singleton Act needs no frame at all, so the runner collapses to
 * calling `fn` — the non-scoped path pays nothing.
 *
 * @internal
 */
export function make_run_scoped(
  bag: Scoped | undefined
): <T>(fn: () => Promise<T>) => Promise<T> {
  return bag ? (fn) => scoped.run(bag, fn) : (fn) => fn();
}

/** The active Act's ports, or `undefined` on the singleton path. @internal */
export function current_ports(): Scoped | undefined {
  return scoped.getStore();
}

/**
 * Runs `fn` with `event` installed as the triggering-event context.
 *
 * Entered per payload rather than per lease: the context has to unwind with
 * the handler so it never reaches the drain cycle, and work a handler started
 * without awaiting has to resume into its own event's frame.
 *
 * @internal
 */
export function run_reacting<T>(
  event: Committed<Schemas, string>,
  fn: () => Promise<T>
): Promise<T> {
  return reacting.run(event, fn);
}

/** The event being reacted to, or `undefined` outside a handler. @internal */
export function current_reacting(): Committed<Schemas, string> | undefined {
  return reacting.getStore();
}

/**
 * Everything a reaction handler runs inside: the `IAct` facade it is handed
 * as its third argument, and the triggering-event context that every dispatch
 * made within it resolves — including one through a captured `app`.
 *
 * Built here rather than in the dispatcher so the dispatcher never has to
 * know how either half works; it receives this whole and calls it.
 *
 * @internal
 */
export type ReactionScope<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
> = {
  readonly app: IAct<TEvents, TActions, TActor>;
  readonly run: <T>(
    event: Committed<Schemas, string>,
    fn: () => Promise<T>
  ) => Promise<T>;
};

/**
 * Assembles the reaction scope from the orchestrator's bound `IAct` methods.
 *
 * @internal
 */
export function make_reaction_scope<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
>(
  app: IAct<TEvents, TActions, TActor>
): ReactionScope<TEvents, TActions, TActor> {
  return { app, run: run_reacting };
}
