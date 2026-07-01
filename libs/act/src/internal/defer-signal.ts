/**
 * @module defer-signal
 * @category Internal
 *
 * The control-flow signal a reaction handler throws to *defer* itself
 * (#1090). Unlike an error, a defer is not a failure: the dispatcher
 * ({@link "reactions".build_handle}) catches it and produces a
 * `HandleResult.defer` — the triggering events stay pending (watermark not
 * advanced), `retry` is not bumped, and the drain re-visits the stream at the
 * carried due-time.
 *
 * Internal for now: the compiled autoclose reaction throws it directly. The
 * public `app.defer(when)` surface (a later slice) will throw the same signal,
 * so the dispatcher needs to recognize only this one type either way.
 *
 * Modeled as an `Error` subclass — like `NonRetryableError` — so it rides the
 * existing `try/catch` in the handler loop instead of needing a separate
 * return channel through every dispatcher signature.
 *
 * @internal
 */
export class DeferSignal extends Error {
  /** Wall-clock time (ms since epoch) to re-visit the stream. */
  readonly defer_at: number;

  constructor(defer_at: number) {
    super("reaction deferred");
    this.name = "DeferSignal";
    this.defer_at = defer_at;
  }
}
