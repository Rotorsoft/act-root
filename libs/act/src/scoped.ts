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
 * A scoped Act wraps every entry point so `store()`/`cache()` resolve to its
 * bag; a singleton Act needs no frame at all, so the runner collapses to
 * calling `fn` — the non-scoped path pays nothing.
 *
 * @internal
 */
/**
 * How many live Acts of each kind this process holds.
 *
 * Counts, not references: an entry that held the Act would keep it alive and
 * re-introduce the retention [#1441](https://github.com/Rotorsoft/act-root/issues/1441)
 * removed from the disposers.
 *
 * @internal
 */
const live = { scoped: 0, singleton: 0 };

/**
 * Record a new Act, refusing to let both kinds be live at once.
 *
 * A scoped Act resolves its ports through an ambient frame and a singleton one
 * through the process-wide adapters. With both alive, which store a call
 * reaches depends on the frame it happens to be running in — a singleton Act
 * dispatched from inside a scoped handler writes to that tenant's store
 * ([#1597](https://github.com/Rotorsoft/act-root/issues/1597)). Rather than
 * make that resolve some particular way, the combination is refused: a process
 * either scopes its ports or it does not.
 *
 * Counts live Acts rather than built ones, so building, shutting down, and
 * then building the other kind is fine — it is only overlap that is ambiguous.
 *
 * @returns The function that gives the slot back. `shutdown()` memoizes its
 *   promise, so this runs exactly once per Act and needs no guard of its own.
 *   An Act abandoned without `shutdown()` holds its slot until the process
 *   tears its ports down — see {@link reset_acts}.
 * @internal
 */
/**
 * Forget every recorded Act, because the ports they resolved through are gone.
 *
 * Called by `disposeAndExit`. An Act that is abandoned rather than shut down
 * never gives its slot back — the count deliberately holds no reference to it,
 * so there is nothing to notice its collection — and without this a test file
 * that drops an Act would decide the port strategy for every file after it in
 * the same worker.
 *
 * @internal
 */
export function reset_acts(): void {
  live.scoped = 0;
  live.singleton = 0;
}

export function register_act(scoped: boolean): () => void {
  const kind = scoped ? "scoped" : "singleton";
  const other = scoped ? "singleton" : "scoped";
  if (live[other] > 0)
    throw new Error(
      `Cannot build a ${kind} Act while ${live[other]} ${other} Act(s) are live. ` +
        "A process either resolves its ports through ActOptions.scoped or through the " +
        "singleton adapters, not both: with both alive, which store a call reaches " +
        "depends on the frame it runs in. Give every Act in this process a `scoped` bag, " +
        "or none of them, and shut one down before building the other kind."
    );
  live[kind]++;
  return () => {
    live[kind]--;
  };
}

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
