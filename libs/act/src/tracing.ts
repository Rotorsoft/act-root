/**
 * @module tracing
 * @category Internal
 *
 * Centralized observability for the framework's internal pipelines.
 *
 * Trace decorators are higher-order functions that wrap a bare implementation
 * with `logger.trace(...)` calls at well-defined moments — entry points for
 * {@link "event-sourcing"} (`load`, `snap`, `action`) and exit points for the
 * {@link "drain"} pipeline (`claim`, `fetch`, `ack`, `block`,
 * `subscribe`). `action` carries both an entry log (🔵) and a post-commit
 * log (🔴) to preserve the diagnostic value of the historical mid-function
 * trace points.
 *
 * The two factories — {@link buildEs} and {@link buildDrain} — let the
 * orchestrator choose bare or traced variants once at `.build()` time based
 * on the configured log level. Outside this module, no other source file
 * imports tracing primitives.
 */

import * as drain from "./drain.js";
import { type DrainOps } from "./drain.js";
import * as es from "./event-sourcing.js";
import { type EsOps } from "./event-sourcing.js";
import { log } from "./ports.js";
import type { Lease, Schemas } from "./types/index.js";

const logger = log();

// ---------------------------------------------------------------------------
// Event-sourcing decorators
// ---------------------------------------------------------------------------

const withSnapTrace =
  (inner: typeof es.snap): typeof es.snap =>
  async (snapshot) => {
    logger.trace(
      `🟠 snap ${snapshot.event!.stream}@${snapshot.event!.version}`
    );
    return inner(snapshot);
  };

const withLoadTrace =
  (inner: typeof es.load): typeof es.load =>
  async (me, stream, callback, asOf) => {
    logger.trace(`🟢 load ${stream}${asOf ? " (as-of)" : ""}`);
    return inner(me, stream, callback, asOf);
  };

const withActionTrace =
  (inner: typeof es.action): typeof es.action =>
  async (me, action, target, payload, reactingTo, skipValidation) => {
    logger.trace(payload as object, `🔵 ${target.stream}.${action as string}`);
    const snapshots = await inner(
      me,
      action,
      target,
      payload,
      reactingTo,
      skipValidation
    );
    const committed = snapshots.filter((s) => s.event);
    if (committed.length) {
      logger.trace(
        committed.map((s) => s.event!.data),
        `🔴 commit ${target.stream}.${committed
          .map((s) => s.event!.name as string)
          .join(", ")}`
      );
    }
    return snapshots;
  };

/**
 * Selects bare or traced event-sourcing handlers. Called once by the
 * orchestrator constructor.
 *
 * @internal
 */
export function buildEs(level: string): EsOps {
  if (level !== "trace") {
    return { snap: es.snap, load: es.load, action: es.action };
  }
  return {
    snap: withSnapTrace(es.snap),
    load: withLoadTrace(es.load),
    action: withActionTrace(es.action),
  };
}

// ---------------------------------------------------------------------------
// Drain-pipeline decorators
// ---------------------------------------------------------------------------

const withClaimTrace =
  <T extends Schemas>(inner: DrainOps<T>["claim"]): DrainOps<T>["claim"] =>
  async (lagging, leading, by, millis) => {
    const leased = await inner(lagging, leading, by, millis);
    if (leased.length) {
      const data = Object.fromEntries(
        leased.map(({ stream, at, retry }) => [stream, { at, retry }])
      );
      logger.trace(data, ">> lease");
    }
    return leased;
  };

const withFetchTrace =
  <T extends Schemas>(inner: DrainOps<T>["fetch"]): DrainOps<T>["fetch"] =>
  async (leased, eventLimit) => {
    const fetched = await inner(leased, eventLimit);
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
    return fetched;
  };

const withAckTrace =
  <T extends Schemas>(inner: DrainOps<T>["ack"]): DrainOps<T>["ack"] =>
  async (leases) => {
    const acked = await inner(leases);
    if (acked.length) {
      const data = Object.fromEntries(
        acked.map(({ stream, at, retry }) => [stream, { at, retry }])
      );
      logger.trace(data, ">> ack");
    }
    return acked;
  };

const withBlockTrace =
  <T extends Schemas>(inner: DrainOps<T>["block"]): DrainOps<T>["block"] =>
  async (leases: Array<Lease & { error: string }>) => {
    const blocked = await inner(leases);
    if (blocked.length) {
      const data = Object.fromEntries(
        blocked.map(({ stream, at, retry, error }) => [
          stream,
          { at, retry, error },
        ])
      );
      logger.trace(data, ">> block");
    }
    return blocked;
  };

const withSubscribeTrace =
  <T extends Schemas>(
    inner: DrainOps<T>["subscribe"]
  ): DrainOps<T>["subscribe"] =>
  async (streams) => {
    const result = await inner(streams);
    if (result.subscribed) {
      const data = streams.map(({ stream }) => stream).join(" ");
      logger.trace(`>> correlate ${data}`);
    }
    return result;
  };

/**
 * Selects bare or traced drain-pipeline ops. Called once by the orchestrator
 * constructor.
 *
 * @internal
 */
export function buildDrain<TEvents extends Schemas>(
  level: string
): DrainOps<TEvents> {
  if (level !== "trace") {
    return {
      claim: drain.claim,
      fetch: drain.fetch,
      ack: drain.ack,
      block: drain.block,
      subscribe: drain.subscribe,
    };
  }
  return {
    claim: withClaimTrace<TEvents>(drain.claim),
    fetch: withFetchTrace<TEvents>(drain.fetch),
    ack: withAckTrace<TEvents>(drain.ack),
    block: withBlockTrace<TEvents>(drain.block),
    subscribe: withSubscribeTrace<TEvents>(drain.subscribe),
  };
}
