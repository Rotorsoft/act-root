/**
 * One-shot reporting for a misdeclaration a build-time guard can't see: a
 * `.to(fn)` target, lane or priority is only known once an event arrives,
 * so correlate and drain apply those rules and report what breaks them.
 * A resolver fires for every matching event, so reporting once per
 * declaration is what keeps the log readable.
 *
 * The key is the whole design: build it only from what the declaration
 * names (handler, event, lane, a static target), never from a value a
 * resolver computed. A resolved target is the trap: the per-aggregate shape
 * `.to(e => ({ target: e.stream }))` would turn one typo into one line per
 * aggregate. Runtime values still belong in the message, as the example.
 *
 * Never throws: a throw in correlate pins the checkpoint for the whole app,
 * and in drain it reaches the breaker as a store failure.
 */

import { log } from "../ports.js";

/**
 * Report `message` the first time `key` is seen. `seen` belongs to the
 * caller, since `internal/` holds no module state.
 */
export function report_once(
  seen: Set<string>,
  key: string,
  message: string
): void {
  if (seen.has(key)) return;
  seen.add(key);
  log().error(new Error(message));
}
