/**
 * Reaction dispatch — what runs inside the drain pipeline once `run_drain_cycle`
 * has fetched events for a leased stream. Two shapes:
 *
 * - per-event `handle`: walks payloads sequentially, running each handler
 *   inside the reaction scope so `action()` threads `reactingTo`
 * - bulk `handle_batch`: hands every event for a static-target projection to
 *   a single batch callback, enabling one-transaction replays
 *
 * Both finish through the drain's `finalize`, the one retry-or-block
 * decision for every per-stream failure. A handler steers its outcome by
 * throwing `DeferSignal` (hold until due) or {@link CloseSignal} (retire the
 * stream); dispatch turns either into a `HandleResult`.
 */

import type { ReactionScope } from "../scoped.js";
import { DeferSignal } from "../types/errors.js";
import type {
  Actor,
  BatchHandler,
  Committed,
  Lease,
  Logger,
  ReactionPayload,
  Schemas,
} from "../types/index.js";
import { resolve_defer_at } from "./defer-config.js";
import { finalize, type Handle, type HandleBatch } from "./drain-cycle.js";

/**
 * The control-flow signal a reaction handler throws to *close* a stream.
 * Like `DeferSignal` it rides the dispatcher's
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
   * Windowed close: prune events older than this cutoff behind
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

/**
 * What the dispatcher needs from the orchestrator: a logger for retry and
 * error breadcrumbs, and the scope a handler runs inside.
 */
export type ReactionDeps<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
> = {
  readonly logger: Logger;
  /**
   * What a handler runs inside — its `IAct` facade and its triggering-event
   * context — assembled by the orchestrator. How either half works is not
   * this module's business; it receives the scope whole and calls it.
   */
  readonly reaction_scope: ReactionScope<TEvents, TActions, TActor>;
};

/**
 * Builds the per-event reaction dispatcher passed to `run_drain_cycle`.
 *
 * The triggering event is installed as ambient context around each handler
 * call, so `action()` resolves it as `reactingTo`. Ambient
 * rather than bound to the `IAct` argument, so a handler that dispatches
 * through a captured `app` inherits the chain too.
 */
export function build_handle<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
>(deps: ReactionDeps<TEvents, TActions, TActor>): Handle<TEvents> {
  const { logger, reaction_scope } = deps;
  return async (lease, payloads) => {
    if (payloads.length === 0) return { lease, handled: 0, acked_at: lease.at };

    const stream = lease.stream;
    // One event fans out to one payload per matching reaction, and the
    // watermark may only advance past an event once EVERY reaction on it
    // has handled it — acking mid-group would silently drop the remaining
    // reactions on redelivery. Track the last payload index per
    // event id (payloads arrive in event order) so `at` advances exactly
    // when a group completes; `handled` counts completed events, not
    // payloads, so a mid-group failure with no completed events is a
    // no-progress result (no ack, retry counter advances toward
    // `blockOnError` instead of resetting on every partial pass).
    const last_index_of = new Map<number, number>();
    for (let i = 0; i < payloads.length; i++)
      last_index_of.set(payloads[i].event.id, i);
    let at = lease.at;
    let handled = 0;

    if (lease.retry > 0)
      logger.warn(
        `Retrying ${stream}@${payloads.at(0)!.event.id} (${lease.retry}).`
      );

    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i];
      const { event, handler } = payload;
      try {
        // Scoped per payload, not hoisted to the lease: the context has to
        // unwind with the handler so it never reaches the drain cycle, and
        // work a handler started without awaiting has to resume into its
        // own event's frame.
        await reaction_scope.run(event as Committed<Schemas, string>, () =>
          handler(event, stream, reaction_scope.app)
        );
        if (last_index_of.get(event.id) === i) {
          at = event.id;
          handled++;
        }
      } catch (error) {
        // A defer is not a failure: hold the triggering events pending
        // (exclude from ack via `defer`), don't bump `retry`, and re-visit
        // the stream at the carried due-time. `acked_at` is unused on
        // the defer path — drain never acks a deferred result.
        if (error instanceof DeferSignal)
          return {
            lease,
            handled,
            acked_at: at,
            defer: resolve_defer_at<TEvents>(error.when, event),
          };
        // A close request advances past the triggering event (so the
        // requesting reaction isn't counted as in-flight by the close-cycle
        // guard) and hands the target to the orchestrator's on_close.
        if (error instanceof CloseSignal)
          return {
            lease,
            handled: handled + 1,
            // Advance to the live head the handler evaluated against (when
            // provided) so the close-cycle guard sees this reaction caught up.
            acked_at: error.at ?? event.id,
            // Close the signalled stream (the autoclose reaction's aggregate,
            // which differs from its synthetic lease stream); a self-closing
            // user reaction omits it and closes its own lease stream. A
            // carried `before` makes it a windowed close (prune, not retire).
            close: {
              stream: error.stream ?? stream,
              archive: error.archive,
              before: error.before,
            },
          };
        return finalize(
          lease,
          handled,
          at,
          error as Error,
          payload.options,
          logger,
          event.id
        );
      }
    }
    return finalize(lease, handled, at, undefined, payloads[0].options, logger);
  };
}

/**
 * Builds the bulk reaction dispatcher passed to `run_drain_cycle`. All events
 * for a static-target projection are handed to a single callback so the
 * projection can do one transaction per drain (catch-up replays especially).
 */
export function build_handle_batch<TEvents extends Schemas>(
  logger: Logger
): HandleBatch<TEvents> {
  return async (
    lease: Lease,
    payloads: ReactionPayload<TEvents>[],
    batchHandler: BatchHandler<TEvents>
  ) => {
    const stream = lease.stream;
    // One payload per (event, reaction) pair: an event with several
    // reactions on this target arrives several times in a row. The batch
    // handler gets each event once, in order — handing it the duplicates
    // made a non-idempotent batch count every event once per reaction.
    // The per-event path groups by id for the same reason.
    const events: Committed<TEvents, keyof TEvents & string>[] = [];
    const seen = new Set<number>();
    for (const p of payloads) {
      if (seen.has(p.event.id)) continue;
      seen.add(p.event.id);
      events.push(p.event as Committed<TEvents, keyof TEvents & string>);
    }
    const options = payloads[0].options;

    if (lease.retry > 0)
      logger.warn(`Retrying batch ${stream}@${events[0].id} (${lease.retry}).`);

    try {
      await batchHandler(events, stream);
      return finalize(
        lease,
        events.length,
        events.at(-1)!.id,
        undefined,
        options,
        logger
      );
    } catch (error) {
      return finalize(lease, 0, lease.at, error as Error, options, logger);
    }
  };
}
