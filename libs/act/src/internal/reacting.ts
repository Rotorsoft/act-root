/**
 * @module reacting
 * @category Internal
 *
 * Ambient triggering-event context for reaction handlers (#1541).
 *
 * `build_handle` installs the event around each handler call; `action()`
 * resolves it as `reactingTo` when the caller didn't pass one, so a handler
 * that dispatches through a captured `app` still threads the chain.
 *
 * @internal
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Committed, Schemas } from "../types/index.js";

/** The event currently being reacted to. Internal — not re-exported. */
export const reacting = new AsyncLocalStorage<Committed<Schemas, string>>();
