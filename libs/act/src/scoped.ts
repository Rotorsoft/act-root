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

/**
 * The reaction currently running, as a box the handler can empty.
 *
 * A frame captured by work the handler started and did not await outlives the
 * handler and can never be unbound. The *frame* is unreclaimable, but the
 * *box inside it* is not: clearing `event` as the handler settles turns every
 * later read through that frame into "no reaction", without anyone having to
 * ask a second question (#1562).
 *
 * Not reachable from `index.ts`.
 */
type Reacting = { event: Committed<Schemas, string> | undefined };

const reacting = new AsyncLocalStorage<Reacting>();

/**
 * Builds the runner an Act uses to enter its own port scope.
 *
 * Every Act gets a frame, including one built without `ActOptions.scoped` —
 * that one carries the singleton adapters (see `default_scope` in `ports.ts`).
 * Entering unconditionally is what makes an Act's ports its own: a runner that
 * collapsed to `fn()` for a singleton Act did not leave whatever frame it was
 * called from, so dispatching into a shared Act from inside a tenant's handler
 * resolved `store()` to that tenant and wrote the shared Act's events into the
 * tenant's log ([#1597](https://github.com/Rotorsoft/act-root/issues/1597)).
 *
 * @internal
 */
export function make_run_scoped(
  bag: Scoped
): <T>(fn: () => Promise<T>) => Promise<T> {
  return (fn) => scoped.run(bag, fn);
}

/**
 * The active Act's ports, or `undefined` outside any Act.
 *
 * Every Act runs in a frame, so this is `undefined` only for a call made
 * outside one — `store()` and `cache()` fall back to the singleton adapters
 * there, which is what a bare `store()` in application setup expects.
 *
 * @internal
 */
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
  const box: Reacting = { event };
  return reacting.run(box, async () => {
    try {
      return await fn();
    } finally {
      // Anything still running keeps this frame; from here it reads empty.
      box.event = undefined;
    }
  });
}

/**
 * The event being reacted to, or `undefined` outside a running handler —
 * including inside work that outlived one.
 *
 * @internal
 */
export function current_reacting(): Committed<Schemas, string> | undefined {
  return reacting.getStore()?.event;
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
