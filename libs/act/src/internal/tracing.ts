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
 * (🔵) and a post-commit log (🔴) to preserve the diagnostic value of the
 * historical mid-function trace points.
 *
 * The two factories — {@link buildEs} and {@link buildDrain} — let the
 * orchestrator choose bare or traced variants once at `.build()` time based
 * on the configured log level. Outside this module, no other source file
 * imports tracing primitives.
 */

import type { Logger, Schemas } from "../types/index.js";
import * as drain from "./drain.js";
import { type DrainOps } from "./drain.js";
import * as es from "./event-sourcing.js";
import { type EsOps } from "./event-sourcing.js";

type AsyncFn = (...args: any[]) => Promise<any>;

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
        `🟠 snap ${snapshot.event!.stream}@${snapshot.event!.version}`
      );
    }),
    load: traced(es.load, undefined, (_me, stream, _cb, asOf) => {
      logger.trace(`🟢 load ${stream}${asOf ? " (as-of)" : ""}`);
    }),
    action: traced(
      es.action,
      (snapshots, _me, _action, target) => {
        const committed = snapshots.filter((s) => s.event);
        if (committed.length) {
          logger.trace(
            committed.map((s) => s.event!.data),
            `🔴 commit ${target.stream}.${committed
              .map((s) => s.event!.name)
              .join(", ")}`
          );
        }
      },
      (_me, action, target, payload) => {
        logger.trace(payload as object, `🔵 ${target.stream}.${action}`);
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
        logger.trace(data, ">> lease");
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
      logger.trace(data, ">> fetch");
    }),
    ack: traced(drain.ack, (acked) => {
      if (acked.length) {
        const data = Object.fromEntries(
          acked.map(({ stream, at, retry }) => [stream, { at, retry }])
        );
        logger.trace(data, ">> ack");
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
        logger.trace(data, ">> block");
      }
    }),
    subscribe: traced(drain.subscribe, (result, streams) => {
      if (result.subscribed) {
        const data = streams.map(({ stream }) => stream).join(" ");
        logger.trace(`>> correlate ${data}`);
      }
    }),
  };
}
