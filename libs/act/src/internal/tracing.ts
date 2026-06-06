/**
 * @module tracing
 * @category Internal
 *
 * Centralized observability for the framework's internal pipelines.
 *
 * Trace decorators wrap a bare implementation with `logger.trace(...)` calls
 * at well-defined moments — entry points for {@link "event-sourcing"} (`load`,
 * `snap`, `action`) and exit points for the {@link "drain"} pipeline (`claim`,
 * `fetch`, `ack`, `block`, `subscribe`). `action` carries both an entry log
 * and a post-commit log to preserve the diagnostic value of the historical
 * mid-function trace points.
 *
 * Output styles:
 * - **Pretty mode** (`config().env !== "production"`) — event-sourcing logs
 *   show only the colored target body (color carries the operation/phase),
 *   drain logs keep a colored caption.
 * - **Plain mode** (production / log aggregators) — every log gets a textual
 *   prefix; event-sourcing uses `caption: body`, drain uses `caption body`.
 *
 * The two factories — {@link buildEs} and {@link buildDrain} — let the
 * orchestrator choose bare or traced variants once at `.build()` time based
 * on the configured log level. Outside this module, no other source file
 * imports tracing primitives.
 *
 * @internal
 */

import { config } from "../config.js";
import type { AsOf, Correlator, Logger, Schemas } from "../types/index.js";
import { defaultCorrelator } from "./correlator.js";
import type { DrainOps } from "./drain.js";
import * as drain from "./drain.js";
import type { EsOps } from "./event-sourcing.js";
import * as es from "./event-sourcing.js";

type AsyncFn = (...args: any[]) => Promise<any>;

const PRETTY = config().env !== "production";

// 256-color codes for distinctive, theme-friendly hues
const C_BLUE = "\x1b[38;5;39m"; // vivid sky blue (action)
const C_ORANGE = "\x1b[38;5;208m"; // true orange (committed)
const C_GREEN = "\x1b[38;5;42m"; // emerald (load)
const C_MAGENTA = "\x1b[38;5;165m"; // bright magenta (snap)
const C_DRAIN = "\x1b[38;5;244m"; // muted gray for all drain ops
// load-trace cache marker shades — distinguishable from C_GREEN body color
const C_HIT = "\x1b[38;5;82m"; // lime — fast path, blends visually
const C_MISS = "\x1b[38;5;220m"; // amber — non-trivial work happened
const C_RESET = "\x1b[0m";

/**
 * Format an event-sourcing trace line. Pretty mode renders just the colored
 * body (the color is the cue for which op/phase fired); plain mode prepends
 * `caption: ` so log aggregators stay readable without ANSI.
 */
const es_caption = (caption: string, color: string, body: string): string =>
  PRETTY ? `${color}${body}${C_RESET}` : `${caption}: ${body}`;

/**
 * Format a drain-pipeline caption. Drain logs keep a `>>` marker for easy
 * spotting in mixed log streams, plus a `caption` (past tense — every drain
 * trace fires on exit). All drain ops share one color (gray) so the pipeline
 * reads as a single channel; the caption disambiguates the phase. Lane
 * (ACT-1103) is appended in lilac, unwrapped, when set and non-default,
 * so the operator's eye lands on the lane name without parsing per-stream
 * detail. Per-stream `@at/retry` and fetched event lists are muted via
 * {@link dim} so the stream name itself reads loudest.
 */
const C_LANE = "\x1b[38;5;183m"; // lilac — distinct from gray drain + drain ops
const C_DIM = "\x1b[38;5;240m"; // dim gray — dimmer than C_DRAIN
const C_ERR = "\x1b[38;5;196m"; // bright red — block marker
const C_STREAM = "\x1b[38;5;226m"; // bright yellow — target stream names in drain/correlate traces

/** Wrap with the muted color when pretty mode is on. Plain in production. */
const dim = (text: string): string =>
  PRETTY ? `${C_DIM}${text}${C_RESET}` : text;

/** Wrap with a foreground color when pretty mode is on; bare in production. */
const hue = (color: string, text: string): string =>
  PRETTY ? `${color}${text}${C_RESET}` : text;

const drain_caption = (caption: string, lane?: string): string => {
  const showLane = lane && lane !== "default";
  if (PRETTY) {
    const tag = `${C_DRAIN}>> ${caption}${C_RESET}`;
    return showLane ? `${tag} ${C_LANE}${lane}${C_RESET}` : tag;
  }
  return showLane ? `>> ${caption} ${lane}` : `>> ${caption}`;
};

/**
 * Format the cache hit/miss marker for the load trace. In pretty mode the
 * word is colored (lime for hit, amber for miss) and the surrounding
 * `C_GREEN` body color is restored after — embedded ANSI inside `es_caption`'s
 * outer wrap. Plain mode returns the bare word.
 */
const cache_marker = (hit: boolean): string => {
  const word = hit ? "hit" : "miss";
  if (!PRETTY) return word;
  return `${hit ? C_HIT : C_MISS}${word}${C_RESET}${C_GREEN}`;
};

/**
 * Format the load stats (`v=N replayed=N snaps=N patches=N`) for the load
 * trace. Muted gray in pretty mode so the cache marker reads as the most
 * important cue; plain mode returns the bare text.
 *
 * - `v` — stream head version (the version of the last event applied)
 * - `replayed` — events processed by THIS load past the cache point
 * - `snaps` — cumulative snapshots taken on this stream
 * - `patches` — events since the last snap (snap-policy accumulator)
 */
const stats_marker = (
  version: number,
  replayed: number,
  snaps: number,
  patches: number
): string => {
  const text = `v=${version} replayed=${replayed} snaps=${snaps} patches=${patches}`;
  if (!PRETTY) return text;
  return `${C_DRAIN}${text}${C_RESET}${C_GREEN}`;
};

/**
 * Format the as-of marker for time-travel loads. Surfaces the active filter
 * fields (before id, created_before/after timestamps, limit) so an operator
 * can tell at a glance which slice was loaded. Empty `asOf` returns "" —
 * non-time-travel loads skip the marker entirely.
 */
const as_of_marker = (asOf: AsOf | undefined): string => {
  if (!asOf) return "";
  const parts: string[] = [];
  if (asOf.before !== undefined) parts.push(`before=${asOf.before}`);
  if (asOf.created_before !== undefined)
    parts.push(`created_before=${asOf.created_before.toISOString()}`);
  if (asOf.created_after !== undefined)
    parts.push(`created_after=${asOf.created_after.toISOString()}`);
  if (asOf.limit !== undefined) parts.push(`limit=${asOf.limit}`);
  return parts.length ? ` (as-of ${parts.join(" ")})` : " (as-of)";
};

/**
 * Wraps an async function with optional `exit` and `entry` callbacks. Each
 * callback fires at the corresponding phase; both receive the call args, and
 * `exit` additionally receives the resolved result. Used to layer
 * `logger.trace` calls onto bare ops without changing their signatures.
 *
 * @internal
 */
const traced = <F extends AsyncFn>(
  inner: F,
  exit?: (result: Awaited<ReturnType<F>>, ...args: Parameters<F>) => void,
  entry?: (...args: Parameters<F>) => void
): F =>
  (async (...args: Parameters<F>) => {
    entry?.(...args);
    const result = (await inner(...args)) as Awaited<ReturnType<F>>;
    exit?.(result, ...args);
    return result;
  }) as F;

/**
 * Selects bare or traced event-sourcing handlers. Called once by the
 * orchestrator constructor.
 *
 * @internal
 */
export function buildEs(
  logger: Logger,
  correlator: Correlator = defaultCorrelator
): EsOps {
  // `es.action` takes `correlator` as its last positional arg; bind it once
  // here so the orchestrator's `EsOps.action` keeps the original 6-arg
  // signature. The PII split (#855) moved off the action signature onto the
  // State's `_pii_split` decorator — buildEs no longer threads it.
  const bound_action: EsOps["action"] = (
    me,
    actionName,
    target,
    payload,
    reactingTo,
    skipValidation = false
  ) =>
    es.action(
      me,
      actionName,
      target,
      payload,
      reactingTo,
      skipValidation,
      correlator
    );
  if (logger.level !== "trace") {
    return {
      snap: es.snap,
      load: es.load,
      action: bound_action,
      tombstone: es.tombstone,
    };
  }
  return {
    snap: traced(es.snap, undefined, (snapshot) => {
      logger.trace(
        es_caption(
          "snap",
          C_MAGENTA,
          `${snapshot.event!.stream}@${snapshot.event!.version}`
        )
      );
    }),
    load: traced(es.load, (result, _me, stream, _cb, asOf) => {
      const stats = stats_marker(
        result.version,
        result.replayed,
        result.snaps,
        result.patches
      );
      logger.trace(
        es_caption(
          "load",
          C_GREEN,
          `${stream}${as_of_marker(asOf)} ${cache_marker(result.cache_hit)} ${stats}`
        )
      );
    }),
    action: traced(
      bound_action,
      (snapshots, _me, _action, target) => {
        const committed = snapshots.filter((s) => s.event);
        if (committed.length) {
          logger.trace(
            committed.map((s) => s.event!.data),
            es_caption(
              "committed",
              C_ORANGE,
              `${target.stream}.${committed.map((s) => s.event!.name).join(", ")}`
            )
          );
        }
      },
      (_me, action, target, payload) => {
        logger.trace(
          payload as object,
          es_caption("action", C_BLUE, `${target.stream}.${action}`)
        );
      }
    ),
    tombstone: traced(es.tombstone, (committed, stream) => {
      if (committed)
        logger.trace(
          es_caption("tombstoned", C_ORANGE, `${stream}@${committed.version}`)
        );
    }),
  };
}

/**
 * Selects bare or traced drain-pipeline ops. Called once by the orchestrator
 * constructor.
 *
 * @internal
 */
export function buildDrain<TEvents extends Schemas>(
  logger: Logger
): DrainOps<TEvents> {
  // Cycle-level tracing happens in `DrainController.drain()` via
  // {@link traceCycle} — claim/fetch/ack/block all flow into one log
  // line per cycle to give the operator a single atomic narrative.
  // `subscribe` stays decorated because it's driven from correlate-
  // cycle (not from runDrainCycle) and doesn't fit the cycle shape.
  return {
    claim: drain.claim,
    fetch: drain.fetch,
    ack: drain.ack,
    block: drain.block,
    subscribe:
      logger.level !== "trace"
        ? drain.subscribe
        : traced(drain.subscribe, (result, streams) => {
            if (!result.subscribed) return;
            // Caption mirrors `drained`: lane in the caption when the
            // whole batch shares a single non-default lane. Mixed-lane
            // batches (rare — different correlated targets resolving
            // to different lanes in one scan) fall back to per-stream
            // `[lane]` tags, default-lane streams stay bare either way.
            const lanes = new Set(streams.map((s) => s.lane ?? "default"));
            const uniformLane = lanes.size === 1 ? streams[0]?.lane : undefined;
            const data = streams
              .map(({ stream, lane }) =>
                uniformLane || !lane || lane === "default"
                  ? hue(C_STREAM, stream)
                  : `${hue(C_STREAM, stream)}${dim(`[${lane}]`)}`
              )
              .join(" ");
            logger.trace(`${drain_caption("correlated", uniformLane)} ${data}`);
          }),
  };
}

/**
 * Emit one cycle-level drain trace summarizing what happened in a
 * single `runDrainCycle` pass. Per-stream rendering shape — outcome +
 * post-state anchored on the right:
 *
 *   stream<-source [events] ✓ @<acked-at>                        — full success
 *   stream<-source [events] ✗ @<failed-at>/<retry> (error)       — total failure → blocked
 *   stream<-source [events] ⚠ @<failed-at>/<retry> (error)       — total failure → retrying
 *   stream<-source [events] ✓ @<acked-at> ✗ @<failed-at>/<retry> (error)  — partial then blocked
 *   stream<-source [events] ✓ @<acked-at> ⚠ @<failed-at>/<retry> (error)  — partial then retrying
 *   stream<-source ⊘ @<at>/<retry>                               — deferred (backoff)
 *
 * Partial-success-then-failure is the dual-outcome case: events
 * 1..K succeeded (watermark advanced to K), event K+1 threw. The
 * trace renders both the lime `✓ @K` and the red/amber `✗`/`⚠ @K+1`
 * on the same line so an operator sees "we made progress *and* then
 * something broke" at a glance.
 *
 * Lane prefixes the caption in lilac when non-default. The outcome
 * marker and its adjacent post-state share the marker's color so the
 * eye reads "outcome + where it landed" as one unit. Per-stream
 * `[events]` and `(error)` stay dim — secondary context.
 *
 * @internal
 */
export function traceCycle<TEvents extends Schemas>(
  logger: Logger,
  leased: ReadonlyArray<{
    readonly stream: string;
    readonly at: number;
    readonly retry: number;
    readonly lane?: string;
  }>,
  fetched: ReadonlyArray<{
    readonly stream: string;
    readonly source?: string;
    readonly events: ReadonlyArray<{
      readonly id: number;
      readonly name: keyof TEvents;
    }>;
  }>,
  handled: ReadonlyArray<{
    readonly lease: { readonly stream: string };
    readonly error?: string;
    readonly block?: boolean;
    readonly failed_at?: number;
  }>,
  acked: ReadonlyArray<{ readonly stream: string; readonly at: number }>,
  blocked: ReadonlyArray<{ readonly stream: string; readonly error: string }>
): void {
  if (logger.level !== "trace" || !leased.length) return;
  const lane = leased[0]?.lane;
  const fetchByStream = new Map(fetched.map((f) => [f.stream, f]));
  const ackedByStream = new Map(acked.map((a) => [a.stream, a.at]));
  const blockedByStream = new Map(blocked.map((b) => [b.stream, b.error]));
  // Handled-with-error stays a single index now: `block` discriminates
  // the marker (✗ vs ⚠); the failure exists independently of whether
  // ack happened.
  const failedByStream = new Map(
    handled.filter((h) => h.error).map((h) => [h.lease.stream, h] as const)
  );
  const detail = leased
    .map(({ stream, at, retry }) => {
      const f = fetchByStream.get(stream);
      // Target stream in yellow so the operator's eye lands on "which
      // stream did this happen on?" first; source (the events' origin)
      // stays dim — secondary info.
      const key = f?.source
        ? `${hue(C_STREAM, stream)}${dim(`<-${f.source}`)}`
        : hue(C_STREAM, stream);
      const events =
        f && f.events.length
          ? ` ${dim(
              `[${f.events.map(({ id, name }) => `#${id} ${String(name)}`).join(", ")}]`
            )}`
          : "";
      // Build ack + fail segments independently — both can fire for
      // the same stream in the partial-success-then-failure case.
      const ackedAt = ackedByStream.get(stream);
      const ackPart =
        ackedAt !== undefined
          ? hue(C_HIT, `✓ @${ackedAt}`) // ✓ + new at in lime
          : "";
      const failure = failedByStream.get(stream);
      let failPart = "";
      if (failure) {
        // Failed event id when known (per-event path), else falls back
        // to lease.at — the post-fetch watermark — for batch-mode
        // total failures where no single event is "the one."
        const failedAt = failure.failed_at ?? at;
        const blockedError = blockedByStream.get(stream);
        if (blockedError !== undefined) {
          failPart = `${hue(C_ERR, `✗ @${failedAt}/${retry}`)} ${dim(`(${blockedError})`)}`;
        } else {
          failPart = `${hue(C_MISS, `⚠ @${failedAt}/${retry}`)} ${dim(`(${failure.error})`)}`;
        }
      }
      let tail: string;
      if (ackPart && failPart) tail = ` ${ackPart} ${failPart}`;
      else if (ackPart) tail = ` ${ackPart}`;
      else if (failPart) tail = ` ${failPart}`;
      else tail = ` ${dim(`⊘ @${at}/${retry}`)}`; // nothing happened
      return `${key}${events}${tail}`;
    })
    .join(", ");
  logger.trace(`${drain_caption("drained", lane)} ${detail}`);
}
