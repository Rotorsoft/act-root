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

import type {
  Actor,
  BatchHandler,
  Committed,
  IAct,
  Lease,
  Logger,
  ReactionOptions,
  ReactionPayload,
  Schemas,
  Target,
} from "../types/index.js";
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
};

/**
 * Shared finalization: log the error, decide retry vs. block, surface the
 * error string only when nothing was handled (in batch mode `handled` is
 * always 0 on failure, so the rule degenerates to "always reported").
 */
function finalize(
  lease: Lease,
  handled: number,
  at: number,
  error: Error | undefined,
  options: ReactionOptions,
  logger: Logger
): HandleResult {
  if (!error) return { lease, handled, at };
  logger.error(error);
  const block = lease.retry >= options.maxRetries && options.blockOnError;
  if (block)
    logger.error(`Blocking ${lease.stream} after ${lease.retry} retries.`);
  return {
    lease,
    handled,
    at,
    error: handled === 0 ? error.message : undefined,
    block,
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
  const { logger, boundDo, boundLoad, boundQuery, boundQueryArray } = deps;
  return async (lease, payloads) => {
    if (payloads.length === 0) return { lease, handled: 0, at: lease.at };

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
        await handler(event, stream, scopedApp);
        at = event.id;
        handled++;
      } catch (error) {
        return finalize(
          lease,
          handled,
          at,
          error as Error,
          payload.options,
          logger
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
  logger: Logger
): HandleBatch<TEvents> {
  return async (
    lease: Lease,
    payloads: ReactionPayload<TEvents>[],
    batchHandler: BatchHandler<TEvents>
  ) => {
    const stream = lease.stream;
    const events = payloads.map((p) => p.event);
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
