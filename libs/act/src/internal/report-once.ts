/**
 * @module report-once
 * @category Internal
 *
 * One-shot reporting for a misdeclaration that a build-time guard could not
 * catch.
 *
 * The guards in `build_events` and `build-classify` can only inspect a static
 * `.to({...})` — a `.to(fn)` target, lane and priority are a function until an
 * event arrives. The pipelines that resolve them (correlate for lane and
 * target, drain for the payload) are therefore where the same rules have to be
 * applied, and where the operator has to be told.
 *
 * Reporting there has one hazard the build-time guards don't: a resolver fires
 * for *every* matching event, so a naive log turns one bad declaration into a
 * line per event on a busy stream. Reporting once per offending declaration is
 * what makes the message readable.
 *
 * Which makes the key the whole design. It may only be built from things the
 * *declaration* names — handler names, event names, lane names, a statically
 * declared target — and never from a value a resolver computed at runtime.
 * A resolved target is the trap: the documented per-aggregate shape is
 * `.to(e => ({target: e.stream}))`, so a target-keyed report dedups nothing
 * across aggregates and one typo scales into one line per aggregate — the
 * unbounded volume this module exists to prevent (#1584). Runtime values
 * still belong in the *message*, as the concrete example that turns "a
 * reaction misdeclared its lane" into something an operator can go look at.
 *
 * Never throws. A throw inside correlate pins the checkpoint for the whole app
 * (#1420); inside drain it reaches the circuit breaker as a store failure and
 * stalls every stream.
 *
 * @internal
 */

import { log } from "../ports.js";

/**
 * Report `message` the first time `key` is seen, and never again.
 *
 * `seen` belongs to the calling pipeline and is passed in, so a resolver
 * firing for every matching event still reports once without this module
 * remembering anything between calls — `internal/` holds no module state.
 *
 * @param seen - The caller's set of already-reported keys. Mutated.
 * @param key - Identifies the offending declaration, not the occurrence —
 *   declared identifiers only, never a runtime-resolved target.
 * @param message - Wrapped in an `Error` so the logger renders a stack.
 *
 * @internal
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
