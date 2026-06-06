/**
 * @module reactions
 * @category Internal
 *
 * Reaction dispatch — what runs inside the drain pipeline once `runDrainCycle`
 * has fetched events for a leased stream. Two shapes:
 *
 * - per-event `handle`: walks payloads sequentially, builds a scoped `IAct`
 *   that auto-injects `reactingTo` so handlers don't have to thread it
 *   through manually
 * - bulk `handleBatch`: hands every event for a static-target projection to
 *   a single batch callback, enabling one-transaction replays
 *
 * Both share `_finalize`, which collapses the retry-vs-block decision and
 * the "report error only when nothing was handled" rule.
 *
 * @internal
 */

import { strip_for_handler } from "../sensitive.js";
import {
  type Actor,
  type BatchHandler,
  type Committed,
  type IAct,
  type Lease,
  type Logger,
  NonRetryableError,
  type ReactionOptions,
  type ReactionPayload,
  type Schemas,
  type Target,
} from "../types/index.js";
import { computeBackoffDelay } from "./backoff.js";
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
  readonly boundDo: IAct<TEvents, TActions, TActor>["do"];
  readonly boundLoad: IAct<TEvents, TActions, TActor>["load"];
  readonly boundQuery: IAct<TEvents, TActions, TActor>["query"];
  readonly boundQueryArray: IAct<TEvents, TActions, TActor>["query_array"];
  /**
   * Registry-backed lookup of sensitive field names per event. Reaction and
   * batch handlers receive the event with these keys stripped from
   * `data` and the `pii` field dropped (#855 slice 5).
   */
  readonly pii_fields: (eventName: string) => readonly string[];
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
  const nonRetryable = error instanceof NonRetryableError;
  const block =
    options.blockOnError && (nonRetryable || lease.retry >= options.maxRetries);
  if (block)
    logger.error(
      nonRetryable
        ? `Blocking ${lease.stream} on non-retryable error.`
        : `Blocking ${lease.stream} after ${lease.retry} retries.`
    );
  // Backoff applies only on retry paths — successful handles and terminal
  // blocks never defer. `lease.retry` here is the just-failed attempt's
  // counter, so the delay paces the *next* attempt.
  const nextAttemptAt =
    !block && options.backoff
      ? Date.now() + computeBackoffDelay(lease.retry, options.backoff)
      : undefined;
  return {
    lease,
    handled,
    acked_at: at,
    error: error.message,
    block,
    nextAttemptAt,
    failed_at,
  };
}

/**
 * Builds the per-event reaction dispatcher passed to `runDrainCycle`.
 *
 * The scoped `IAct` proxy auto-injects the triggering event as `reactingTo`
 * when handlers call `do()` without it (#587), keeping the correlation
 * chain by default. The non-do methods are reused across all dispatches —
 * only `do` rebinds per payload because it captures the triggering event.
 *
 * @internal
 */
export function buildHandle<
  TEvents extends Schemas,
  TActions extends Schemas,
  TActor extends Actor = Actor,
>(deps: ReactionDeps<TEvents, TActions, TActor>): Handle<TEvents> {
  const {
    logger,
    boundDo,
    boundLoad,
    boundQuery,
    boundQueryArray,
    pii_fields,
  } = deps;
  return async (lease, payloads) => {
    if (payloads.length === 0) return { lease, handled: 0, acked_at: lease.at };

    const stream = lease.stream;
    let at = payloads.at(0)!.event.id;
    let handled = 0;

    if (lease.retry > 0)
      logger.warn(`Retrying ${stream}@${at} (${lease.retry}).`);

    const scopedApp: IAct<TEvents, TActions, TActor> = {
      do: boundDo,
      load: boundLoad,
      query: boundQuery,
      query_array: boundQueryArray,
    };

    for (const payload of payloads) {
      const { event, handler } = payload;
      // Strip sensitive fields before the handler ever sees the event —
      // reactions that genuinely need PII opt back in via `app.load(stream,
      // { actor: systemActor })` inside the handler, making the
      // security-relevant path explicit at the call site.
      const handler_event = strip_for_handler(
        event as Committed<TEvents, keyof TEvents & string>,
        pii_fields(event.name as string)
      );
      scopedApp.do = <TKey extends keyof TActions & string>(
        action: TKey,
        target: Target<TActor>,
        actionPayload: Readonly<TActions[TKey]>,
        reactingTo?: Committed<Schemas, string>,
        skipValidation?: boolean
      ) =>
        boundDo(
          action,
          target,
          actionPayload,
          (reactingTo ?? event) as Committed<TEvents, string & keyof TEvents>,
          skipValidation
        );
      try {
        await handler(handler_event, stream, scopedApp);
        at = event.id;
        handled++;
      } catch (error) {
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
 * Builds the bulk reaction dispatcher passed to `runDrainCycle`. All events
 * for a static-target projection are handed to a single callback so the
 * projection can do one transaction per drain (catch-up replays especially).
 *
 * @internal
 */
export function buildHandleBatch<TEvents extends Schemas>(
  logger: Logger,
  pii_fields: (eventName: string) => readonly string[]
): HandleBatch<TEvents> {
  return async (
    lease: Lease,
    payloads: ReactionPayload<TEvents>[],
    batchHandler: BatchHandler<TEvents>
  ) => {
    const stream = lease.stream;
    // Same handler-stripping rule applies to batch handlers as to per-event
    // reactions: projections see events without sensitive keys.
    const events = payloads.map((p) =>
      strip_for_handler(
        p.event as Committed<TEvents, keyof TEvents & string>,
        pii_fields(p.event.name as string)
      )
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
