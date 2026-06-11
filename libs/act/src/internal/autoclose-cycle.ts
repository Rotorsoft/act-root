/**
 * @module autoclose-cycle
 * @category Internal
 *
 * The online close-the-books cycle (#837 / epic #802). Paginates the
 * store's streams, applies each state's `.autocloses(predicate)` to
 * the matching candidates, then hands the eligible streams to the
 * existing {@link run_close_cycle} so the tombstone-guard +
 * archive-while-guarded + atomic-truncate invariants carry over from
 * the explicit `app.close(targets)` path.
 *
 * Pure orchestration. The caller (the app-level controller in slice
 * 3) owns the cadence (`setInterval(...)`), the lifecycle events
 * (`emit("closed", ...)`), and the per-tick correlation id.
 *
 * Zero-cost when no state declares `.autocloses(...)` — the caller
 * never invokes this function in that case (the controller isn't
 * constructed).
 *
 * @internal
 */

import type { AutoCloseConfig } from "../act.js";
import { store, TOMBSTONE_EVENT } from "../ports.js";
import type {
  CloseResult,
  CloseTarget,
  Logger,
  State,
  TruncateResult,
} from "../types/index.js";
import { run_close_cycle } from "./close-cycle.js";
import type { EsOps } from "./event-sourcing.js";

/**
 * Dependencies the autoclose cycle needs. Decoupled from `Act` so
 * the cycle can be exercised from tests in isolation against an
 * `InMemoryStore` without spinning a full Act.
 *
 * @internal
 */
export type AutocloseCycleDeps = {
  /**
   * Lookup of `.autocloses(predicate)` per state name. The cycle
   * skips streams whose owning state returns `null` here, so opt-out
   * states pay zero per-stream cost beyond the `event_to_state`
   * lookup.
   */
  readonly autoclose_policy: (
    state_name: string
  ) => ((stream: string, head: any, count: number) => boolean) | null;
  /**
   * Lookup of `.archives(fn)` per state name. When present, the
   * cycle threads it into the corresponding {@link CloseTarget.archive}
   * so the existing close-cycle's archive-while-guarded invariant
   * applies — a thrown archiver leaves the stream guarded but
   * un-truncated, and the cycle re-evaluates the candidate next
   * tick.
   */
  readonly autoclose_archiver: (
    state_name: string
  ) => ((stream: string, head: any) => Promise<void>) | null;
  /** event-name → owning-state lookup (already computed at build). */
  readonly event_to_state: ReadonlyMap<string, State<any, any, any>>;
  /** Reactive-event count, forwarded to {@link run_close_cycle}. */
  readonly reactive_events_size: number;
  /** `EsOps.load`, forwarded to {@link run_close_cycle}. */
  readonly load: EsOps["load"];
  /** `EsOps.tombstone`, forwarded to {@link run_close_cycle}. */
  readonly tombstone: EsOps["tombstone"];
  readonly logger: Logger;
  readonly config: AutoCloseConfig;
  /**
   * Correlation id for this tick. The caller computes it via the
   * configured {@link Correlator}; every truncate the cycle stages
   * shares this id so close-cycle commits land under one correlation
   * key (matching the existing `app.close(targets)` behavior).
   */
  readonly correlation: string;
};

/**
 * Aggregated result of one autoclose tick. The caller forwards
 * `close_result` to the `closed` lifecycle event; `inspected` /
 * `evaluated` / `predicate_errors` feed observability sidecars.
 *
 * @internal
 */
export type AutocloseCycleResult = {
  /** Total streams the cycle paginated through this tick. */
  readonly inspected: number;
  /** Streams whose owning state had a policy and the predicate ran. */
  readonly evaluated: number;
  /** Predicate exceptions caught + classified per `closeOnError`. */
  readonly predicate_errors: number;
  /** Forwarded from {@link run_close_cycle} — truncated + skipped. */
  readonly close_result: CloseResult;
};

/**
 * Yield to the event loop for `ms` milliseconds (or one microtask
 * tick when `ms === 0`). The autoclose cycle inserts this between
 * truncate batches so SQLite operators can let the writer lock
 * release between rows — PG / InMemory don't serialize writers
 * globally and run with `ms = 0` (microtask yield only).
 *
 * @internal
 */
function yield_between_batches(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one autoclose tick against the configured store. Returns
 * after every stream has been paginated through and every eligible
 * batch handed to {@link run_close_cycle}.
 *
 * The cycle never throws — predicate exceptions are caught and
 * logged (counted in `predicate_errors`; `closeOnError` controls
 * whether they count as "close this stream"). Store errors during
 * pagination propagate to the caller (the controller logs them and
 * skips to the next tick).
 *
 * @internal
 */
export async function run_autoclose_cycle(
  deps: AutocloseCycleDeps
): Promise<AutocloseCycleResult> {
  const s = store();
  let inspected = 0;
  let evaluated = 0;
  let predicate_errors = 0;
  const truncated: TruncateResult = new Map();
  const skipped: string[] = [];

  // `query_stats` returns every event-stream in one map (no cursor
  // pagination — that's `query_streams` for subscription positions,
  // not events). The cycle iterates the map, applies each state's
  // predicate to the matching streams, and flushes truncate batches
  // when `batch_size` candidates accumulate. `closeYieldMs` paces
  // batches on adapters where the writer lock matters.
  const stats = await s.query_stats(
    {},
    { count: true, exclude: [TOMBSTONE_EVENT] }
  );

  const flush_batch = async (candidates: CloseTarget[]) => {
    if (candidates.length === 0) return;
    const result = await run_close_cycle(candidates, {
      reactive_events_size: deps.reactive_events_size,
      event_to_state: deps.event_to_state,
      load: deps.load,
      tombstone: deps.tombstone,
      logger: deps.logger,
      correlation: deps.correlation,
    });
    for (const [stream, entry] of result.truncated) {
      truncated.set(stream, entry);
    }
    for (const stream of result.skipped) skipped.push(stream);
    await yield_between_batches(deps.config.yield_ms);
  };

  let candidates: CloseTarget[] = [];

  for (const [stream, { head, count }] of stats) {
    inspected += 1;
    // `head` is non-optional on `StreamStats` — `query_stats` only
    // includes streams with at least one non-excluded event.
    const owner = deps.event_to_state.get(head.name);
    if (!owner) continue;
    const predicate = deps.autoclose_policy(owner.name);
    if (!predicate) continue;

    let close = false;
    try {
      close = predicate(stream, head, count ?? 0);
      evaluated += 1;
    } catch (err) {
      predicate_errors += 1;
      deps.logger.error(
        `Autoclose predicate for state "${owner.name}" threw on stream "${stream}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      close = deps.config.close_on_error;
    }

    if (!close) continue;

    const archiver = deps.autoclose_archiver(owner.name);
    const archive = archiver ? () => archiver(stream, head) : undefined;
    candidates.push({ stream, archive });

    if (candidates.length >= deps.config.batch_size) {
      await flush_batch(candidates);
      candidates = [];
    }
  }

  // Flush the trailing batch.
  await flush_batch(candidates);

  return {
    inspected,
    evaluated,
    predicate_errors,
    close_result: { truncated, skipped },
  };
}
