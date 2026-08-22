/**
 * @module reacting
 * @category Internal
 *
 * Ambient triggering-event context for reaction handlers (#1541).
 *
 * `build_handle` installs the context around each lease; `action()` resolves
 * `event` as `reactingTo` when the caller didn't pass one, so a handler that
 * dispatches through a captured `app` still threads the chain.
 *
 * The context is entered once per lease and its `event` re-pointed per
 * payload, rather than entering once per payload: handlers are awaited in
 * sequence, so the field is stable for the whole of each handler's run, and
 * a lease of 50 events pays one context entry instead of fifty.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Committed, Schemas } from "../types/index.js";

/** Mutable holder — re-pointed per payload within a lease. @internal */
export type Reacting = { event: Committed<Schemas, string> };

/** The event currently being reacted to. Internal — not re-exported. */
export const reacting = new AsyncLocalStorage<Reacting>();
