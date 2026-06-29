/**
 * @module close-signal
 * @category Internal
 *
 * The control-flow signal a reaction handler throws to *close* its stream
 * (#1090). Like {@link "defer-signal".DeferSignal} it rides the dispatcher's
 * `try/catch`, but where a defer holds the stream for later, a close asks the
 * orchestrator to retire it: `build_handle` turns the signal into a
 * `HandleResult.close` (a {@link CloseTarget}), `run_drain_cycle` **acks the
 * triggering event first** (so the closing reaction isn't counted as an
 * in-flight consumer by the close-cycle's safety guard) and collects the
 * target, and the `DrainController` hands it to the orchestrator's `on_close`
 * callback, which runs the same `run_close_cycle` machinery as `app.close`.
 *
 * Internal: the compiled autoclose reaction throws it. Closing stays an
 * orchestrator capability — reactions only *signal* the intent, so the public
 * reaction-scoped `IAct` gains no `close`. The signal carries an optional
 * archiver (from `.archives(...)`) threaded into the resulting
 * {@link CloseTarget}.
 *
 * @internal
 */
export class CloseSignal extends Error {
  /** Optional archive callback to run while the stream is guarded. */
  readonly archive?: () => Promise<void>;
  /**
   * Watermark to ack the requesting reaction to before the close runs.
   * The close-cycle safety guard skips a stream whose subscriptions lag
   * the head, so a handler that evaluated against the *live* head (not just
   * the triggering event) must advance its watermark to that head id —
   * otherwise it blocks its own close. Defaults to the triggering event id
   * when omitted.
   */
  readonly at?: number;

  constructor(archive?: () => Promise<void>, at?: number) {
    super("reaction requested close");
    this.name = "CloseSignal";
    this.archive = archive;
    this.at = at;
  }
}
