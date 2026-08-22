/**
 * @module reacting
 * @category Internal
 *
 * Ambient triggering-event context for reaction handlers (#1541).
 *
 * `action()` resolves `reactingTo` from here when the caller didn't pass one,
 * so every dispatch reached from inside a handler threads the correlation
 * chain — whichever `IAct` reference made the call.
 *
 * Per-event dispatch only. Batch projection handlers receive no `IAct` and
 * span many events, so there is no single triggering event to inherit.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Committed, Schemas } from "../types/index.js";

const reacting = new AsyncLocalStorage<Committed<Schemas, string>>();

/** Runs `fn` with `event` installed as the ambient triggering event. @internal */
export function run_reacting<T>(
  event: Committed<Schemas, string>,
  fn: () => Promise<T>
): Promise<T> {
  return reacting.run(event, fn);
}

/** The ambient triggering event, or `undefined` outside a handler. @internal */
export function current_reacting_to(): Committed<Schemas, string> | undefined {
  return reacting.getStore();
}
