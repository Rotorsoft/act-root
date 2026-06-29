/**
 * @module reactions
 * @category Internal
 *
 * Reaction dispatch — what runs inside the drain pipeline once `run_drain_cycle`
 * has fetched events for a leased stream. Two shapes:
 *
 * - per-event `handle`: walks payloads sequentially, builds a scoped `IAct`
 *   that auto-injects `reactingTo` so handlers don't have to thread it
 *   through manually
 * - bulk `handle_batch`: hands every event for a static-target projection to
 *   a single batch callback, enabling one-transaction replays
 *
 * Both share `_finalize`, which collapses the retry-vs-block decision and
 * the "report error only when nothing was handled" rule.
 *
 * @internal
 */

import {
  type Actor,
  type BatchHandler,
  type Committed,
  type DoOptions,
  type IAct,
  type Lease,
  type Logger,
  NonRetryableError,
  type ReactionOptions,
  type ReactionPayload,
  type Schemas,
  type Target,
} from "../types/index.js";
import { compute_backoff_delay } from "./backoff.js";
import { CloseSignal } from "./close-signal.js";
import { DeferSignal } from "./defer-signal.js";
import type { Handle, HandleBatch, HandleResult } from "./drain-cycle.js";

/**
 * Dependencies a reaction handler needs from the orchestrator: the logger
 * for retry/error breadcrumbs, plus the bound `IAct` methods that the scoped
 * proxy hands to user reaction code.
 *
 * @internal
 */
export type ReactionDeps<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
> = {
  readonly logger: Logger;
  readonly bound_do: IAct<TEvents, TActions, TActor>["do"];
  readonly bound_load: IAct<TEvents, TActions, TActor>["load"];
  readonly bound_query: IAct<TEvents, TActions, TActor>["query"];
  readonly bound_query_array: IAct<TEvents, TActions, TActor>["query_array"];
  readonly bound_forget: IAct<TEvents, TActions, TActor>["forget"];
};

/**
 * Shared finalization: log the error and decide retry vs. block. The
 * error string is *always* surfaced on the failure path — drain-cycle
 * uses `handled > 0` (not `error` presence) to decide whether to ack
 * the partial progress, so the message can travel for trace + blocked
 * record without affecting the ack/skip choice.
 */
function finalize(
  lease: Lease,
  handled: number,
  at: number,
  error: Error | undefined,
  options: ReactionOptions,
  logger: Logger,
  failed_at?: number
): HandleResult {
  if (!error) return { lease, handled, acked_at: at };
  logger.error(error);
  // A `NonRetryableError` from the handler short-circuits the retry
  // budget — block on first attempt when the operator has opted in via
  // `blockOnError`. When `blockOnError` is false, the operator has
  // explicitly chosen "retry forever," so we don't override that.
  const non_retryable = error instanceof NonRetryableError;
  const block =
    options.blockOnError &&
    (non_retryable || lease.retry >= options.maxRetries);
  if (block)
    logger.error(
      non_retryable
        ? `Blocking ${lease.stream} on non-retryable error.`
        : `Blocking ${lease.stream} after ${lease.retry} retries.`
    );
  // Backoff applies only on retry paths — successful handles and terminal
  // blocks never defer. `lease.retry` here is the just-failed attempt's
  // counter, so the delay paces the *next* attempt.
  const next_attempt_at =
    !block && options.backoff
      ? Date.now() + compute_backoff_delay(lease.retry, options.backoff)
      : undefined;
  return {
    lease,
    handled,
    acked_at: at,
    error: error.message,
    block,
    next_attempt_at,
    failed_at,
  };
}

/**
 * Builds the per-event reaction dispatcher passed to `run_drain_cycle`.
 *
 * The scoped `IAct` proxy auto-injects the triggering event as `reactingTo`
 * when handlers call `do()` without it (#587), keeping the correlation
 * chain by default. The non-do methods are reused across all dispatches —
 * only `do` rebinds per payload because it captures the triggering event.
 *
 * @internal
 */
export function build_handle<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
>(deps: ReactionDeps<TEvents, TActions, TActor>): Handle<TEvents> {
  const {
    logger,
    bound_do,
    bound_load,
    bound_query,
    bound_query_array,
    bound_forget,
  } = deps;
  return async (lease, payloads) => {
    if (payloads.length === 0) return { lease, handled: 0, acked_at: lease.at };

    const stream = lease.stream;
    let at = payloads.at(0)!.event.id;
    let handled = 0;

    if (lease.retry > 0)
      logger.warn(`Retrying ${stream}@${at} (${lease.retry}).`);

    const scoped_app: IAct<TEvents, TActions, TActor> = {
      do: bound_do,
      load: bound_load,
      query: bound_query,
      query_array: bound_query_array,
      forget: bound_forget,
    };

    for (const payload of payloads) {
      const { event, handler } = payload;
      scoped_app.do = <TKey extends keyof TActions & string>(
        action: TKey,
        target: Target<TActor>,
        action_payload: Readonly<TActions[TKey]>,
        options?: DoOptions<TEvents>
      ) =>
        bound_do(action, target, action_payload, {
          ...options,
          reactingTo:
            options?.reactingTo ?? (event as Committed<Schemas, string>),
        });
      try {
        await handler(event, stream, scoped_app);
        at = event.id;
        handled++;
      } catch (error) {
        // A defer is not a failure: hold the triggering events pending
        // (exclude from ack via `defer`), don't bump `retry`, and re-visit
        // the stream at the carried due-time (#1090). `acked_at` is unused on
        // the defer path — drain never acks a deferred result.
        if (error instanceof DeferSignal)
          return { lease, handled, acked_at: at, defer: error.defer_at };
        // A close request advances past the triggering event (so the
        // requesting reaction isn't counted as in-flight by the close-cycle
        // guard) and hands the target to the orchestrator's on_close (#1090).
        if (error instanceof CloseSignal)
          return {
            lease,
            handled: handled + 1,
            // Advance to the live head the handler evaluated against (when
            // provided) so the close-cycle guard sees this reaction caught up.
            acked_at: error.at ?? event.id,
            close: { stream, archive: error.archive },
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
 *
 * @internal
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
    const events = payloads.map(
      (p) => p.event as Committed<TEvents, keyof TEvents & string>
    );
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
