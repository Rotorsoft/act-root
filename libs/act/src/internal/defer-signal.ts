/**
 * @module defer-signal
 * @category Internal
 *
 * The control-flow signal a reaction handler throws to *defer* itself
 * (#1090, #1091). Unlike an error, a defer is not a failure: the dispatcher
 * ({@link "reactions".build_handle}) catches it and produces a
 * `HandleResult.defer` — the triggering events stay pending (watermark not
 * advanced), `retry` is not bumped, and the drain re-visits the stream at the
 * resolved due-time.
 *
 * `DeferSignal` is the **imperative escape hatch** and is re-exported from the
 * package root, so reaction code can throw it directly when a static
 * `.defer(when)` step isn't expressive enough (a deadline computed from loaded
 * state, say). It carries the *unresolved* {@link DeferWhen}; the dispatcher
 * resolves it against the triggering event it is already dispatching (via
 * `resolve_defer_at`), which is what anchors `{ after }` and the `at` function
 * form to that event and keeps the due-time derivable. Fully dynamic times go
 * through `{ at: someDate }`.
 *
 * Modeled as an `Error` subclass — like `NonRetryableError` — so it rides the
 * existing `try/catch` in the handler loop instead of needing a separate
 * return channel through every dispatcher signature. The compiled autoclose
 * reaction throws the same signal.
 */
import type { DeferWhen } from "../types/index.js";

export class DeferSignal extends Error {
  /**
   * The unresolved schedule. The dispatcher turns this into an absolute
   * due-time by resolving it against the triggering event.
   */
  readonly when: DeferWhen;

  constructor(when: DeferWhen) {
    super("reaction deferred");
    this.name = "DeferSignal";
    this.when = when;
  }
}
