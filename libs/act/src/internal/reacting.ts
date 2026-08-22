/**
 * @module reacting
 * @category Internal
 *
 * Ambient triggering-event context for reaction handlers.
 *
 * `build_handle` hands each handler a scoped `IAct` whose `do()` threads the
 * triggering event as `reactingTo`. That only helps handlers that actually
 * call the injected reference — one closing over a module-level `app` (the
 * ordinary shape when the app is a module export) silently bypassed it and
 * committed with a fresh correlation id and no `causation.event`.
 *
 * Carrying the event in an `AsyncLocalStorage` around the handler makes the
 * injection ambient: every `do()` reached from inside a reaction inherits the
 * chain regardless of which `IAct` reference the handler reached for. The
 * scoped proxy stays, so an explicitly-passed `reactingTo` still wins.
 *
 * Per-event dispatch only. Batch projection handlers receive no `IAct` and
 * span many events, so there is no single triggering event to inherit.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Committed, Schemas } from "../types/index.js";

/** The event currently being reacted to, if any. Internal — not re-exported. */
const reacting = new AsyncLocalStorage<Committed<Schemas, string>>();

/**
 * Runs `fn` with `event` installed as the ambient triggering event.
 *
 * @internal
 */
export function run_reacting<T>(
  event: Committed<Schemas, string>,
  fn: () => Promise<T>
): Promise<T> {
  return reacting.run(event, fn);
}

/**
 * The ambient triggering event, or `undefined` outside a reaction handler.
 *
 * @internal
 */
export function current_reacting_to(): Committed<Schemas, string> | undefined {
  return reacting.getStore();
}
