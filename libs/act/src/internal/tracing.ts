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
 */

import { config } from "../config.js";
import type { Logger, Schemas } from "../types/index.js";
import * as drain from "./drain.js";
import { type DrainOps } from "./drain.js";
import * as es from "./event-sourcing.js";
import { type EsOps } from "./event-sourcing.js";

type AsyncFn = (...args: any[]) => Promise<any>;

const PRETTY = config().env !== "production";

const C_BLUE = "\x1b[34m";
const C_GREEN = "\x1b[32m";
const C_YELLOW = "\x1b[33m";
const C_CYAN = "\x1b[36m";
const C_RED = "\x1b[31m";
const C_GRAY = "\x1b[90m";
const C_MAGENTA = "\x1b[35m";
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
 * trace fires on exit). Pretty mode colors the marker+caption block.
 */
const drain_caption = (caption: string, color: string): string => {
  const tag = `>> ${caption}`;
  return PRETTY ? `${color}${tag}${C_RESET}` : tag;
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
export function buildEs(logger: Logger): EsOps {
  if (logger.level !== "trace") {
    return { snap: es.snap, load: es.load, action: es.action };
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
    load: traced(es.load, undefined, (_me, stream, _cb, asOf) => {
      logger.trace(
        es_caption("load", C_GREEN, `${stream}${asOf ? " (as-of)" : ""}`)
      );
    }),
    action: traced(
      es.action,
      (snapshots, _me, _action, target) => {
        const committed = snapshots.filter((s) => s.event);
        if (committed.length) {
          logger.trace(
            committed.map((s) => s.event!.data),
            es_caption(
              "committed",
              C_YELLOW,
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
  if (logger.level !== "trace") {
    return {
      claim: drain.claim,
      fetch: drain.fetch,
      ack: drain.ack,
      block: drain.block,
      subscribe: drain.subscribe,
    };
  }
  return {
    claim: traced(drain.claim, (leased) => {
      if (leased.length) {
        const data = Object.fromEntries(
          leased.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, drain_caption("claimed", C_CYAN));
      }
    }),
    fetch: traced(drain.fetch<TEvents>, (fetched) => {
      const data = Object.fromEntries(
        fetched.map(({ stream, source, events }) => {
          const key = source ? `${stream}<-${source}` : stream;
          const value = Object.fromEntries(
            events.map(({ id, stream, name }) => [id, { [stream]: name }])
          );
          return [key, value];
        })
      );
      logger.trace(data, drain_caption("fetched", C_CYAN));
    }),
    ack: traced(drain.ack, (acked) => {
      if (acked.length) {
        const data = Object.fromEntries(
          acked.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, drain_caption("acked", C_GREEN));
      }
    }),
    block: traced(drain.block, (blocked) => {
      if (blocked.length) {
        const data = Object.fromEntries(
          blocked.map(({ stream, at, retry, error }) => [
            stream,
            { at, retry, error },
          ])
        );
        logger.trace(data, drain_caption("blocked", C_RED));
      }
    }),
    subscribe: traced(drain.subscribe, (result, streams) => {
      if (result.subscribed) {
        const data = streams.map(({ stream }) => stream).join(" ");
        logger.trace(`${drain_caption("correlated", C_GRAY)} ${data}`);
      }
    }),
  };
}
