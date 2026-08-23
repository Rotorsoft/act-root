/**
 * @module scoped
 * @category Internal
 *
 * Ambient execution context — every `AsyncLocalStorage` the framework owns
 * lives here and nowhere else.
 *
 * Two contexts, both installed by the orchestrator and read further down:
 *
 * - {@link scoped} carries the active Act's ports, so `store()` / `cache()`
 *   resolve per-Act rather than per-process (ACT-501).
 * - {@link reacting} carries the event a reaction handler is processing, so
 *   `action()` can thread `reactingTo` for any dispatch made from inside a
 *   handler, whichever `IAct` reference made the call (#1541).
 *
 * Keeping them together keeps ambient state out of `internal/`, whose modules
 * are stateless implementations, and out of `ports.ts`, which is about
 * adapters. A module that needs ambient context imports it from here; nothing
 * here imports back.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Cache, Committed, Schemas, Store } from "./types/index.js";

/** Per-Act ports bag (ACT-501). Both required together — a shared cache across stores would collide on stream keys. */
export type Scoped = {
  readonly store: Store;
  readonly cache: Cache;
};

/** AsyncLocalStorage carrying the active Act's ports. */
export const scoped = new AsyncLocalStorage<Scoped>();

/** The event currently being reacted to. Not re-exported from `index.ts`. */
export const reacting = new AsyncLocalStorage<Committed<Schemas, string>>();
