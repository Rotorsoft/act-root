/**
 * @module close-signal
 * @category Internal
 *
 * The control-flow signal a reaction handler throws to *close* a stream
 * (#1090). Like {@link "defer-signal".DeferSignal} it rides the dispatcher's
 * `try/catch`, but where a defer holds the stream for later, a close asks the
 * orchestrator to retire it: `build_handle` turns the signal into a
 * `HandleResult.close` (a {@link CloseTarget}), `run_drain_cycle` acks the
 * triggering event and collects the target, and the `DrainController` hands it
 * to the orchestrator's `on_close` callback, which runs the same
 * `run_close_cycle` machinery as `app.close`.
 *
 * Internal: the compiled autoclose reaction throws it. Closing stays an
 * orchestrator capability — reactions only *signal* the intent, so the public
 * reaction-scoped `IAct` gains no `close`.
 *
 * The autoclose reaction runs on a **synthetic stream** (`source` = the
 * aggregate, `target` = a per-aggregate `__autoclose__` key) so it never
 * shares a watermark with the aggregate's own reactions. That makes the close
 * *target* distinct from the reaction's lease stream, so the signal carries the
 * stream to close explicitly (`stream`); when omitted (a user reaction closing
 * its own stream) it defaults to the lease stream.
 *
 * @internal
 */
export class CloseSignal extends Error {
  /**
   * Stream to close. Omitted → the reaction's own lease stream (a self-close).
   * The synthesized autoclose reaction sets it to the aggregate stream, since
   * its lease runs on a synthetic `__autoclose__` target.
   */
  readonly stream?: string;
  /** Optional archive callback to run while the stream is guarded. */
  readonly archive?: () => Promise<void>;
  /**
   * Watermark to ack the requesting reaction to before the close runs. The
   * close-cycle safety guard skips a stream whose subscriptions (matched by
   * source) lag the head; the autoclose reaction's `source` is the aggregate,
   * so it must advance its own watermark to the live head id it evaluated
   * against — otherwise it blocks its own close. Defaults to the triggering
   * event id when omitted.
   */
  readonly at?: number;
  /**
   * Windowed close (#1011): prune events older than this cutoff behind
   * the closest safe snapshot instead of retiring the stream. Thrown by
   * the autoclose reaction of a `.autocloses({ keep })` state; flows
   * into {@link CloseTarget.before}. Omitted → a full close.
   */
  readonly before?: Date;

  constructor(opts?: {
    stream?: string;
    archive?: () => Promise<void>;
    at?: number;
    before?: Date;
  }) {
    super("reaction requested close");
    this.name = "CloseSignal";
    this.stream = opts?.stream;
    this.archive = opts?.archive;
    this.at = opts?.at;
    this.before = opts?.before;
  }
}
