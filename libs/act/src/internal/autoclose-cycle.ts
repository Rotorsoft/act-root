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

import type { AutocloseConfig } from "../act.js";
import { store, TOMBSTONE_EVENT } from "../ports.js";
import type {
  Actor,
  CloseResult,
  CloseTarget,
  Correlator,
  Logger,
  State,
  TruncateResult,
} from "../types/index.js";
import { in_autoclose_window } from "./autoclose-config.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { run_close_cycle } from "./close-cycle.js";
import { close_correlation } from "./correlator.js";
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
  readonly config: AutocloseConfig;
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
 * Run one autoclose tick against the configured store. Each tick
 * fetches a single bounded page of streams — those sorting after
 * {@link AutocloseCycleDeps.after}, up to `closeBatchSize` — applies
 * each state's predicate, and hands that page's eligible candidates to
 * {@link run_close_cycle} as one batch (one safety probe per batch).
 * It pages through the whole store via the keyset cursor, yielding
 * `closeYieldMs` between batches, so a single run reaches every
 * eligible stream while bounding per-batch memory and write burst.
 *
 * The cycle never throws — predicate exceptions are caught and
 * logged (counted in `predicate_errors`; `closeOnError` controls
 * whether they count as "close this stream"). Store errors during
 * a page query propagate to the caller (the controller logs them and
 * skips to the next run).
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

  const page = deps.config.closeBatchSize;
  // Page through the whole store one `closeBatchSize` batch at a time,
  // closing each batch before fetching the next. Closed streams are
  // tombstoned (excluded here) and sit behind the cursor, so the
  // forward scan never revisits them.
  let after: string | undefined;
  for (;;) {
    const stats = await s.query_stats(
      {},
      { count: true, exclude: [TOMBSTONE_EVENT], after, limit: page }
    );
    if (stats.size === 0) break;
    inspected += stats.size;

    const candidates: CloseTarget[] = [];
    for (const [stream, { head, count }] of stats) {
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
        close = deps.config.closeOnError;
      }

      if (!close) continue;

      const archiver = deps.autoclose_archiver(owner.name);
      const archive = archiver ? () => archiver(stream, head) : undefined;
      candidates.push({ stream, archive });
    }

    // One batch → one safety probe. The page size bounds the count.
    if (candidates.length > 0) {
      const result = await run_close_cycle(candidates, {
        reactive_events_size: deps.reactive_events_size,
        event_to_state: deps.event_to_state,
        load: deps.load,
        tombstone: deps.tombstone,
        logger: deps.logger,
        correlation: deps.correlation,
      });
      for (const [stream, entry] of result.truncated)
        truncated.set(stream, entry);
      for (const stream of result.skipped) skipped.push(stream);
      await yield_between_batches(deps.config.closeYieldMs);
    }

    // Short page → end of the sweep.
    if (stats.size < page) break;
    after = [...stats.keys()].at(-1);
  }

  return {
    inspected,
    evaluated,
    predicate_errors,
    close_result: { truncated, skipped },
  };
}

/**
 * Dependencies the app-level autoclose controller needs. Same shape
 * as {@link AutocloseCycleDeps} minus `correlation` (the controller
 * computes one per tick from the supplied {@link Correlator}) and
 * plus the lifecycle-event sink (`on_closed`) and the actor sentinel
 * for the correlator (`close_actor`).
 *
 * @internal
 */
export type AutocloseControllerDeps = Omit<
  AutocloseCycleDeps,
  "correlation" | "after"
> & {
  /**
   * Correlator the controller invokes per tick to stamp the cycle's
   * truncate commits. Reuses the orchestrator's configured
   * correlator so close commits share the app's id scheme — same as
   * the existing `app.close(targets)` path.
   */
  readonly correlator: Correlator;
  /** Sentinel actor for the close correlation (matches `Act.close`). */
  readonly close_actor: Actor;
  /**
   * Fan-out for the per-tick result. The controller calls this once
   * per tick that closes at least one stream, with the cycle's
   * {@link CloseResult}. The Act orchestrator wires this to
   * `emit("closed", result)`.
   */
  readonly on_closed: (result: CloseResult) => void;
  /**
   * Shared orchestrator circuit breaker (ACT-984). The autoclose ticker is
   * a periodic store poller like the drain loop, so it consults the same
   * breaker: it skips a tick while the breaker is open and records the
   * outcome of each tick it runs (`failed(now, err)` also surfaces the
   * failure to the orchestrator's `error` lifecycle event).
   */
  readonly breaker: CircuitBreaker;
};

/**
 * App-level autoclose controller. Owns the ticker (`setInterval`),
 * the per-tick reentrancy guard (a slow tick doesn't pile on the
 * next interval), and the lifecycle-event fan-out. Tests invoke
 * {@link run_once} directly; the orchestrator's
 * `start_correlations()` / `stop_correlations()` lifecycle starts +
 * stops the ticker.
 *
 * @internal
 */
export class AutocloseController {
  public readonly deps: AutocloseControllerDeps;
  private _timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Reentrancy guard. The interval fires the next tick on cadence
   * regardless of how long the previous one took; this flag drops
   * overlapping ticks so the cycle stays sequential per controller.
   */
  private _running = false;

  constructor(deps: AutocloseControllerDeps) {
    this.deps = deps;
  }

  /**
   * Start the cycle ticker. Returns `false` if already running so
   * accidental double-start doesn't stack timers (matches
   * `_correlate.start_polling` semantics).
   */
  start(): boolean {
    if (this._timer) return false;
    // Fire-and-forget interval — swallow rejections so a thrown cycle
    // doesn't kill the timer. The error is already recorded on the shared
    // breaker (which logs it and surfaces the `error` lifecycle event) by
    // `run_once`, so there's nothing left to do here but keep ticking.
    this._timer = setInterval(() => {
      this.run_once().catch(() => {});
    }, this.deps.config.autocloseCycleMinutes * 60_000);
    // Don't let the interval keep the process alive — Node's
    // `setInterval` returns a `Timeout` with `unref()` (the package
    // targets Node ≥22, so the runtime guard is unnecessary).
    this._timer.unref();
    return true;
  }

  /**
   * Stop the cycle ticker. Idempotent.
   */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * Whether the ticker is currently running.
   */
  get is_running(): boolean {
    return this._timer !== undefined;
  }

  /**
   * Run one cycle synchronously. The controller's interval callback
   * delegates here; tests can invoke it directly to deterministically
   * exercise the cycle without spinning real timers.
   *
   * Overlapping invocations short-circuit: if a previous tick is
   * still running, this one drops and returns `null`. The orchestrator
   * never sees a queue of pending ticks regardless of how slow the
   * predicate / archive / truncate are.
   */
  async run_once(): Promise<AutocloseCycleResult | null> {
    if (this._running) return null;
    // Circuit open: the store is failing, skip this tick rather than pile
    // load on a down backend. The next tick after the cooldown retries.
    if (this.deps.breaker.state(Date.now()) === "open") return null;
    // Off-hours window: outside it, this tick does nothing. The ticker
    // keeps firing; only the sweep is gated.
    if (!in_autoclose_window(this.deps.config.autocloseWindow, new Date()))
      return null;
    this._running = true;
    try {
      const correlation = close_correlation(
        this.deps.correlator,
        this.deps.close_actor
      );
      const result = await run_autoclose_cycle({
        autoclose_policy: this.deps.autoclose_policy,
        autoclose_archiver: this.deps.autoclose_archiver,
        event_to_state: this.deps.event_to_state,
        reactive_events_size: this.deps.reactive_events_size,
        load: this.deps.load,
        tombstone: this.deps.tombstone,
        logger: this.deps.logger,
        config: this.deps.config,
        correlation,
      });
      // The store responded — reset the shared breaker.
      this.deps.breaker.passed();
      if (result.close_result.truncated.size > 0) {
        this.deps.on_closed(result.close_result);
      }
      return result;
    } catch (error) {
      // A store op failed mid-tick. Record on the shared breaker, which
      // logs it and surfaces the `error` lifecycle event, then rethrow so
      // the interval callback can swallow it and keep the timer alive.
      this.deps.breaker.failed(Date.now(), error);
      throw error;
    } finally {
      this._running = false;
    }
  }
}
